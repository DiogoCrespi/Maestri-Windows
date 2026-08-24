//! Native workspace persistence for Tauri 2.
//!
//! The wire type is intentionally `serde_json::Value`: the workspace schema
//! is shared with the web client and can evolve without coupling this module
//! to every canvas node variant.  The persistence boundary still enforces the
//! schema identity and version before reading or writing any document.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

const WORKSPACE_SCHEMA_VERSION: u64 = 2;
const WORKSPACE_TYPE: &str = "workspace";
const MAX_WORKSPACE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_TEMP_ATTEMPTS: usize = 32;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn validate_path(raw_path: &str) -> Result<PathBuf, String> {
    if raw_path.trim().is_empty() {
        return Err("workspace path must not be empty".to_string());
    }
    if raw_path.len() > MAX_PATH_BYTES {
        return Err(format!("workspace path exceeds {MAX_PATH_BYTES} bytes"));
    }
    if raw_path.chars().any(char::is_control) {
        return Err("workspace path must not contain control characters".to_string());
    }

    let path = PathBuf::from(raw_path);
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err("workspace path must name a file".to_string());
    }
    Ok(path)
}

fn validate_document(document: &Value) -> Result<(), String> {
    let object = document
        .as_object()
        .ok_or_else(|| "workspace document must be a JSON object".to_string())?;

    let schema_version = match object.get("schemaVersion") {
        Some(Value::Number(number)) if number.is_u64() => number.as_u64(),
        _ => None,
    };
    if schema_version != Some(WORKSPACE_SCHEMA_VERSION) {
        return Err(format!(
            "unsupported workspace schemaVersion; expected {WORKSPACE_SCHEMA_VERSION}"
        ));
    }

    match object.get("type").and_then(Value::as_str) {
        Some(WORKSPACE_TYPE) => Ok(()),
        Some(value) => Err(format!("unsupported workspace type '{value}'")),
        None => Err("workspace document is missing string field 'type'".to_string()),
    }
}

fn serialize_document(document: &Value) -> Result<Vec<u8>, String> {
    validate_document(document)?;
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("workspace serialization failed: {error}"))?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err(format!(
            "workspace document exceeds {MAX_WORKSPACE_BYTES} bytes"
        ));
    }
    Ok(bytes)
}

fn read_document(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot stat workspace '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("workspace path is not a file: {}", path.display()));
    }
    if metadata.len() > MAX_WORKSPACE_BYTES as u64 {
        return Err(format!(
            "workspace file exceeds {MAX_WORKSPACE_BYTES} bytes"
        ));
    }

    let file = File::open(path)
        .map_err(|error| format!("cannot open workspace '{}': {error}", path.display()))?;
    let mut bytes = Vec::new();
    let limit = u64::try_from(MAX_WORKSPACE_BYTES)
        .map_err(|_| "workspace size limit is invalid".to_string())?
        .saturating_add(1);
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read workspace '{}': {error}", path.display()))?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err(format!(
            "workspace file exceeds {MAX_WORKSPACE_BYTES} bytes"
        ));
    }

    let document: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("workspace JSON is invalid: {error}"))?;
    validate_document(&document)?;
    Ok(document)
}

fn temporary_path(destination: &Path, attempt: usize) -> Result<PathBuf, String> {
    let parent = match destination.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let file_name = destination
        .file_name()
        .ok_or_else(|| "workspace path must name a file".to_string())?
        .to_string_lossy();
    let pid = std::process::id();
    let timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos(),
        Err(_) => 0,
    };
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{file_name}.maestri-{pid}-{timestamp}-{sequence}-{attempt}.tmp"
    )))
}

fn replace_atomically(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(
                existing_file_name: *const u16,
                new_file_name: *const u16,
                flags: u32,
            ) -> i32;
        }

        let source_wide: Vec<u16> = source
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let destination_wide: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // The temporary file is in the destination directory, so this is a
        // same-volume replacement. WRITE_THROUGH asks Windows to flush the
        // move metadata before returning.
        let result = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let parent = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        let directory = File::open(parent)?;
        directory.sync_all()
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn write_document(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(format!(
            "workspace parent is not a directory: {}",
            parent.display()
        ));
    }
    if path.is_dir() {
        return Err(format!("workspace path is a directory: {}", path.display()));
    }

    let mut last_error = None;
    for attempt in 0..MAX_TEMP_ATTEMPTS {
        let temporary = temporary_path(path, attempt)?;
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "cannot create workspace temporary file '{}': {error}",
                    temporary.display()
                ));
            }
        };

        let write_result = (|| -> std::io::Result<()> {
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            replace_atomically(&temporary, path)?;
            sync_parent_directory(path)
        })();

        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("cannot atomically save workspace: {error}"));
        }
        return Ok(());
    }

    let reason = match last_error {
        Some(error) => error.to_string(),
        None => "temporary file name allocation exhausted".to_string(),
    };
    Err(format!(
        "cannot allocate workspace temporary file: {reason}"
    ))
}

/// Loads and validates a schemaVersion 2 workspace document.
#[tauri::command]
pub fn workspace_load(path: String) -> Result<Value, String> {
    let path = validate_path(&path)?;
    read_document(&path)
}

/// Checks whether a workspace target already exists without reading or
/// validating its contents. Project creation uses this to avoid overwriting a
/// valid or corrupt workspace merely because parsing failed.
#[tauri::command]
pub fn workspace_path_exists(path: String) -> Result<bool, String> {
    let path = validate_path(&path)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "cannot inspect workspace '{}': {error}",
            path.display()
        )),
    }
}

/// Validates and atomically saves a schemaVersion 2 workspace document.
#[tauri::command]
pub fn workspace_save(path: String, document: Value) -> Result<(), String> {
    let path = validate_path(&path)?;
    let bytes = serialize_document(&document)?;
    write_document(&path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_document(name: &str) -> Value {
        serde_json::json!({
            "schemaVersion": 2,
            "type": "workspace",
            "payload": {
                "name": name,
                "nodes": [],
                "connections": []
            }
        })
    }

    fn test_directory() -> Result<PathBuf, String> {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "open-maestri-workspace-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory)
            .map_err(|error| format!("cannot create test directory: {error}"))?;
        Ok(directory)
    }

    fn cleanup(directory: &Path) {
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn validates_schema_identity() {
        assert!(validate_document(&valid_document("ok")).is_ok());
        assert!(validate_document(&serde_json::json!({
            "schemaVersion": 1,
            "type": "workspace"
        }))
        .is_err());
        assert!(validate_document(&serde_json::json!({
            "schemaVersion": 2,
            "type": "other"
        }))
        .is_err());
        assert!(validate_document(&serde_json::json!([])).is_err());
    }

    #[test]
    fn saves_and_loads_round_trip() -> Result<(), String> {
        let directory = test_directory()?;
        let path = directory.join("workspace.json");
        let expected = valid_document("round-trip");

        let result = workspace_save(path.to_string_lossy().into_owned(), expected.clone());
        assert!(result.is_ok());
        let actual = workspace_load(path.to_string_lossy().into_owned())?;
        assert_eq!(actual, expected);

        cleanup(&directory);
        Ok(())
    }

    #[test]
    fn replaces_existing_document_without_leaving_temp_files() -> Result<(), String> {
        let directory = test_directory()?;
        let path = directory.join("workspace.json");
        workspace_save(path.to_string_lossy().into_owned(), valid_document("first"))?;
        workspace_save(
            path.to_string_lossy().into_owned(),
            valid_document("second"),
        )?;

        let actual = workspace_load(path.to_string_lossy().into_owned())?;
        assert_eq!(actual["payload"]["name"], "second");
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("cannot inspect test directory: {error}"))?;
        let temporary_count = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_count, 0);

        cleanup(&directory);
        Ok(())
    }

    #[test]
    fn rejects_oversized_documents() {
        let oversized = serde_json::json!({
            "schemaVersion": 2,
            "type": "workspace",
            "payload": "x".repeat(MAX_WORKSPACE_BYTES + 1)
        });
        assert!(serialize_document(&oversized).is_err());
    }

    #[test]
    fn rejects_invalid_paths() {
        assert!(validate_path("").is_err());
        assert!(validate_path("\0workspace.json").is_err());
        assert!(validate_path(&"x".repeat(MAX_PATH_BYTES + 1)).is_err());
    }

    #[test]
    fn load_rejects_invalid_json_and_schema() -> Result<(), String> {
        let directory = test_directory()?;
        let invalid_json = directory.join("invalid.json");
        fs::write(&invalid_json, b"not-json")
            .map_err(|error| format!("cannot write test file: {error}"))?;
        assert!(workspace_load(invalid_json.to_string_lossy().into_owned()).is_err());

        let invalid_schema = directory.join("invalid-schema.json");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 3,
            "type": "workspace"
        }))
        .map_err(|error| format!("cannot serialize test document: {error}"))?;
        fs::write(&invalid_schema, bytes)
            .map_err(|error| format!("cannot write test file: {error}"))?;
        assert!(workspace_load(invalid_schema.to_string_lossy().into_owned()).is_err());

        cleanup(&directory);
        Ok(())
    }

    #[test]
    fn path_exists_distinguishes_missing_and_existing_invalid_workspace() -> Result<(), String> {
        let directory = test_directory()?;
        let path = directory.join("workspace.json");
        assert!(!workspace_path_exists(path.to_string_lossy().into_owned())?);
        fs::write(&path, b"corrupt")
            .map_err(|error| format!("cannot create corrupt workspace: {error}"))?;
        assert!(workspace_path_exists(path.to_string_lossy().into_owned())?);
        cleanup(&directory);
        Ok(())
    }
}
