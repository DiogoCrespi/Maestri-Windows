use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;

/// Maximum markdown note size, in bytes.
pub const MAX_NOTE_SIZE_BYTES: usize = 10 * 1024 * 1024;
const NOTES_DIRECTORY: &str = "notes";

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Resolves a note resource below `<workspace_root>/notes`.
///
/// `resource_path` may be a relative path below `notes` or an absolute path
/// already below that directory. The returned path must not be cached across
/// filesystem mutations.
pub fn resolve_scoped_note_path(
    workspace_root: &str,
    resource_path: &str,
    for_write: bool,
) -> Result<PathBuf, String> {
    let root_input = validate_path_text(workspace_root, "workspace root", true)?;
    if !root_input.is_absolute() {
        return Err("workspace root must be an absolute path".to_string());
    }
    reject_reparse_components(&root_input)?;
    let root = fs::canonicalize(&root_input).map_err(|error| {
        format!(
            "cannot canonicalize workspace root '{}': {error}",
            root_input.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "workspace root is not a directory: {}",
            root.display()
        ));
    }
    reject_reparse_components(&root)?;

    let notes = root.join(NOTES_DIRECTORY);
    if !path_exists(&notes)? {
        if !for_write {
            return Err(format!(
                "notes directory does not exist: {}",
                notes.display()
            ));
        }
        fs::create_dir(&notes).map_err(|error| {
            format!(
                "cannot create notes directory '{}': {error}",
                notes.display()
            )
        })?;
    }
    reject_reparse_components(&notes)?;
    if !notes.is_dir() {
        return Err(format!(
            "notes path is not a directory: {}",
            notes.display()
        ));
    }
    let notes = fs::canonicalize(&notes).map_err(|error| {
        format!(
            "cannot canonicalize notes directory '{}': {error}",
            notes.display()
        )
    })?;
    if !path_is_within(&root, &notes) || notes == root {
        return Err("notes directory escapes the workspace root".to_string());
    }

    let resource = validate_resource_path(resource_path)?;
    let relative_resource = if let Ok(stripped) = resource.strip_prefix(NOTES_DIRECTORY) {
        stripped.to_path_buf()
    } else {
        resource.clone()
    };
    let candidate = if resource.is_absolute() {
        resource
    } else {
        notes.join(relative_resource)
    };
    // Do this lexical containment check before any directory creation. An
    // absolute path outside notes must never cause create_dir_all to touch it.
    if !path_is_within(&notes, &candidate) {
        return Err("note resource escapes the workspace notes directory".to_string());
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "note resource must name a file".to_string())?
        .to_path_buf();

    reject_reparse_components(&parent)?;
    if for_write && !path_exists(&parent)? {
        // This is intentionally performed only after lexical validation and
        // only below the canonical notes directory.
        fs::create_dir_all(&parent).map_err(|error| {
            format!(
                "cannot create note directory '{}': {error}",
                parent.display()
            )
        })?;
    }
    reject_reparse_components(&parent)?;
    let canonical_parent = fs::canonicalize(&parent).map_err(|error| {
        format!(
            "cannot canonicalize note directory '{}': {error}",
            parent.display()
        )
    })?;
    if !canonical_parent.is_dir() || !path_is_within(&notes, &canonical_parent) {
        return Err("note parent escapes the workspace notes directory".to_string());
    }

    let file_name = candidate
        .file_name()
        .ok_or_else(|| "note resource must name a file".to_string())?;
    let target = canonical_parent.join(file_name);
    if path_exists(&target)? {
        reject_reparse(&target)?;
        let metadata = fs::metadata(&target)
            .map_err(|error| format!("cannot inspect note '{}': {error}", target.display()))?;
        if !metadata.is_file() {
            return Err(format!("note path is not a file: {}", target.display()));
        }
        reject_hard_link(&target, &metadata)?;
        let canonical_target = fs::canonicalize(&target)
            .map_err(|error| format!("cannot canonicalize note '{}': {error}", target.display()))?;
        if !path_is_within(&notes, &canonical_target) {
            return Err("note target escapes the workspace notes directory".to_string());
        }
    } else if !for_write {
        return Err(format!("note file does not exist: {}", target.display()));
    }

    Ok(target)
}

/// Reads a note after enforcing the workspace-scoped filesystem policy.
#[tauri::command]
pub fn note_read_scoped(workspace_root: &str, resource_path: &str) -> Result<String, String> {
    let path = resolve_scoped_note_path(workspace_root, resource_path, false)?;
    let file = open_regular_file(&path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot inspect note '{}': {error}", path.display()))?;
    if metadata.len() > MAX_NOTE_SIZE_BYTES as u64 {
        return Err(format!(
            "note file size ({}) exceeds maximum limit of {} bytes",
            metadata.len(),
            MAX_NOTE_SIZE_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_NOTE_SIZE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read note '{}': {error}", path.display()))?;
    if bytes.len() > MAX_NOTE_SIZE_BYTES {
        return Err(format!(
            "note file exceeds maximum limit of {} bytes",
            MAX_NOTE_SIZE_BYTES
        ));
    }
    String::from_utf8(bytes).map_err(|error| format!("note file is not valid UTF-8: {error}"))
}

/// Atomically writes a note after enforcing the workspace-scoped filesystem policy.
#[tauri::command]
pub fn note_save_scoped(
    workspace_root: &str,
    resource_path: &str,
    content: &str,
) -> Result<(), String> {
    if content.len() > MAX_NOTE_SIZE_BYTES {
        return Err(format!(
            "content size ({}) exceeds maximum limit of {} bytes",
            content.len(),
            MAX_NOTE_SIZE_BYTES
        ));
    }
    let path = resolve_scoped_note_path(workspace_root, resource_path, true)?;
    let parent = path
        .parent()
        .ok_or_else(|| "note resource must name a file".to_string())?;

    // Re-check immediately before creating the temporary file. The old file
    // remains untouched if validation, write, sync, or replacement fails.
    reject_reparse_components(parent)?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        format!(
            "cannot canonicalize note directory '{}': {error}",
            parent.display()
        )
    })?;
    let root = canonical_workspace_root(workspace_root)?;
    let notes = canonical_notes_directory(&root, false)?;
    if !path_is_within(&notes, &canonical_parent) {
        return Err("note parent escapes the workspace notes directory".to_string());
    }
    if path_exists(&path)? {
        reject_reparse(&path)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("cannot inspect note '{}': {error}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("note path is not a file: {}", path.display()));
        }
        reject_hard_link(&path, &metadata)?;
    }

    let mut temporary = NamedTempFile::new_in(&canonical_parent)
        .map_err(|error| format!("cannot create note temporary file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("failed to write note temporary file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync note temporary file: {error}"))?;

    // Revalidate the destination after writing. `persist` is the only step
    // that replaces the destination, and tempfile cleans up on failure.
    if path_exists(&path)? {
        reject_reparse(&path)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("cannot inspect note '{}': {error}", path.display()))?;
        reject_hard_link(&path, &metadata)?;
    }
    temporary.persist(&path).map_err(|error| {
        format!(
            "failed to atomically save note '{}': {error}",
            path.display()
        )
    })?;
    Ok(())
}

fn canonical_workspace_root(workspace_root: &str) -> Result<PathBuf, String> {
    let input = validate_path_text(workspace_root, "workspace root", true)?;
    if !input.is_absolute() {
        return Err("workspace root must be an absolute path".to_string());
    }
    reject_reparse_components(&input)?;
    let root = fs::canonicalize(&input).map_err(|error| {
        format!(
            "cannot canonicalize workspace root '{}': {error}",
            input.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "workspace root is not a directory: {}",
            root.display()
        ));
    }
    reject_reparse_components(&root)?;
    Ok(root)
}

fn canonical_notes_directory(root: &Path, create: bool) -> Result<PathBuf, String> {
    let notes = root.join(NOTES_DIRECTORY);
    if !path_exists(&notes)? {
        if !create {
            return Err(format!(
                "notes directory does not exist: {}",
                notes.display()
            ));
        }
        fs::create_dir(&notes).map_err(|error| {
            format!(
                "cannot create notes directory '{}': {error}",
                notes.display()
            )
        })?;
    }
    reject_reparse_components(&notes)?;
    if !notes.is_dir() {
        return Err(format!(
            "notes path is not a directory: {}",
            notes.display()
        ));
    }
    let canonical = fs::canonicalize(&notes).map_err(|error| {
        format!(
            "cannot canonicalize notes directory '{}': {error}",
            notes.display()
        )
    })?;
    if !path_is_within(root, &canonical) || canonical == root {
        return Err("notes directory escapes the workspace root".to_string());
    }
    Ok(canonical)
}

fn validate_resource_path(resource_path: &str) -> Result<PathBuf, String> {
    validate_path_text(resource_path, "note resource path", false)
}

fn validate_path_text(value: &str, field: &str, allow_absolute: bool) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{field} contains NUL/control characters"));
    }
    let slash_normalized = trimmed.replace('\\', "/");
    let lower = slash_normalized.to_ascii_lowercase();
    if slash_normalized.starts_with("//")
        || lower.starts_with("//?/")
        || lower.starts_with("//./")
        || lower.starts_with("/??/")
        || lower.starts_with("globalroot/")
    {
        return Err(format!("{field} cannot be UNC/device path"));
    }

    let path = PathBuf::from(trimmed);
    if !allow_absolute && path.has_root() && !path.is_absolute() {
        return Err(format!("{field} cannot use a rooted path"));
    }
    for (index, segment) in slash_normalized.split('/').enumerate() {
        if segment == ".." {
            return Err(format!("{field} cannot contain '..'"));
        }
        if segment.is_empty() || (index == 0 && is_drive_prefix(segment)) {
            continue;
        }
        if segment.contains(':') {
            return Err(format!("{field} cannot contain an alternate data stream"));
        }
        if segment.trim_end_matches([' ', '.']) != segment {
            return Err(format!("{field} cannot contain trailing dots/spaces"));
        }
        if is_reserved_device_name(segment) {
            return Err(format!("{field} cannot contain a device name"));
        }
    }
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(format!("{field} cannot contain '..'"));
        }
    }
    Ok(path)
}

fn is_drive_prefix(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_reserved_device_name(segment: &str) -> bool {
    let base = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .to_ascii_uppercase();
    matches!(
        base.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CLOCK$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("cannot inspect path '{}': {error}", path.display())),
    }
}

fn reject_reparse(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect path '{}': {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "symlink is not allowed in note path: {}",
            path.display()
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "reparse point/junction is not allowed in note path: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn reject_reparse_components(path: &Path) -> Result<(), String> {
    let mut current = path.to_path_buf();
    loop {
        match fs::symlink_metadata(&current) {
            Ok(_) => reject_reparse(&current)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "cannot inspect path '{}': {error}",
                    current.display()
                ))
            }
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    Ok(())
}

fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root = path_key(root);
    let candidate = path_key(candidate);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|remainder| remainder.starts_with('\\'))
}

fn path_key(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    while value.ends_with('\\') && value.len() > 3 {
        value.pop();
    }
    #[cfg(windows)]
    {
        value.make_ascii_lowercase();
    }
    value
}

fn reject_hard_link(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    let _ = metadata;
    #[cfg(windows)]
    {
        if windows_has_multiple_links(path)? {
            return Err(format!(
                "hard-linked note is not allowed: {}",
                path.display()
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(format!(
                "hard-linked note is not allowed: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_has_multiple_links(path: &Path) -> Result<bool, String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    type Handle = *mut c_void;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn GetFileInformationByHandle(handle: Handle, info: *mut ByHandleFileInformation) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "cannot inspect hardlink count '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let mut info = ByHandleFileInformation {
        attributes: 0,
        creation_time: FileTime { low: 0, high: 0 },
        last_access_time: FileTime { low: 0, high: 0 },
        last_write_time: FileTime { low: 0, high: 0 },
        volume_serial_number: 0,
        file_size_high: 0,
        file_size_low: 0,
        number_of_links: 0,
        file_index_high: 0,
        file_index_low: 0,
    };
    let success = unsafe { GetFileInformationByHandle(handle, &mut info) != 0 };
    unsafe {
        CloseHandle(handle);
    }
    if !success {
        return Err(format!(
            "cannot inspect hardlink count '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(info.number_of_links > 1)
}

fn open_regular_file(path: &Path) -> Result<File, String> {
    reject_reparse(path)?;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot inspect note '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("note path is not a file: {}", path.display()));
    }
    reject_hard_link(path, &metadata)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    options
        .open(path)
        .map_err(|error| format!("cannot open note '{}': {error}", path.display()))
}

// Legacy unscoped helpers are retained only while lib.rs is migrated. They
// permit arbitrary filesystem paths and must not be used for untrusted notes.
#[deprecated(note = "use note_read_scoped(workspace_root, resource_path)")]
#[tauri::command]
pub fn note_read(path: String) -> Result<String, String> {
    let valid_path = validate_legacy_path(&path)?;
    read_legacy_file(&valid_path)
}

#[deprecated(note = "use note_save_scoped(workspace_root, resource_path, content)")]
#[tauri::command]
pub fn note_save(path: String, content: String) -> Result<(), String> {
    let valid_path = validate_legacy_path(&path)?;
    save_legacy_file_atomically(&valid_path, &content)
}

fn validate_legacy_path(path_str: &str) -> Result<PathBuf, String> {
    let trimmed = path_str.trim();
    if trimmed.is_empty() {
        return Err("file path cannot be empty".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("file path contains invalid control characters".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn save_legacy_file_atomically(path: &Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_NOTE_SIZE_BYTES {
        return Err(format!(
            "content size ({}) exceeds maximum limit of {} bytes",
            content.len(),
            MAX_NOTE_SIZE_BYTES
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid file path (no parent directory): {path:?}"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create directories for {path:?}: {error}"))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create temporary file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("failed to write temporary file: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("failed to atomically save note {path:?}: {error}"))?;
    Ok(())
}

fn read_legacy_file(path: &Path) -> Result<String, String> {
    let file =
        File::open(path).map_err(|error| format!("failed to open note {path:?}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("failed to inspect note {path:?}: {error}"))?;
    if metadata.len() > MAX_NOTE_SIZE_BYTES as u64 {
        return Err(format!(
            "note file exceeds maximum limit of {} bytes",
            MAX_NOTE_SIZE_BYTES
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_NOTE_SIZE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read note {path:?}: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("note file is not valid UTF-8: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn workspace() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(NOTES_DIRECTORY)).unwrap();
        dir
    }

    #[test]
    fn scoped_valid_note_round_trips_atomically() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        note_save_scoped(&root, "project.md", "# Hello").unwrap();
        assert_eq!(note_read_scoped(&root, "project.md").unwrap(), "# Hello");
        note_save_scoped(&root, "project.md", "# Updated").unwrap();
        assert_eq!(note_read_scoped(&root, "project.md").unwrap(), "# Updated");
        assert!(dir
            .path()
            .join(NOTES_DIRECTORY)
            .join("project.md")
            .is_file());
    }

    #[test]
    fn scoped_rejects_traversal_and_windows_path_forms() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        for path in [
            "..\\outside.md",
            "nested/../../outside.md",
            "\\\\server\\share\\outside.md",
            "\\\\.\\pipe\\outside",
            "notes\\safe.md:stream",
            "NUL.txt",
            "safe\0.md",
            "safe\n.md",
        ] {
            assert!(
                note_save_scoped(&root, path, "blocked").is_err(),
                "accepted {path:?}"
            );
        }
    }

    #[test]
    fn scoped_rejects_external_absolute_path() {
        let dir = workspace();
        let outside = dir.path().join("outside").join("nested").join("outside.md");
        let root = dir.path().to_string_lossy().to_string();
        let outside_path = outside.to_string_lossy().to_string();
        assert!(note_save_scoped(&root, &outside_path, "blocked").is_err());
        assert!(!outside.exists());
        assert!(!outside.parent().unwrap().exists());
    }

    #[test]
    fn scoped_rejects_existing_symlink_when_supported() {
        let dir = workspace();
        let outside = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let link = dir.path().join(NOTES_DIRECTORY).join("link.md");
        let target = outside.path().join("outside.md");
        fs::write(&target, "outside").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();

        assert!(note_read_scoped(&root, "link.md").is_err());
        assert!(note_save_scoped(&root, "link.md", "blocked").is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "outside");
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_junction_notes_directory() {
        use std::os::windows::fs::symlink_dir;

        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let notes = dir.path().join(NOTES_DIRECTORY);
        symlink_dir(outside.path(), &notes).unwrap();
        let root = dir.path().to_string_lossy().to_string();
        assert!(note_save_scoped(&root, "escape.md", "blocked").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_hard_link_target() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        let original = dir.path().join("original.md");
        let linked = dir.path().join(NOTES_DIRECTORY).join("linked.md");
        fs::write(&original, "outside").unwrap();
        std::fs::hard_link(&original, &linked).unwrap();
        assert!(note_read_scoped(&root, "linked.md").is_err());
        assert!(note_save_scoped(&root, "linked.md", "blocked").is_err());
        assert_eq!(fs::read_to_string(original).unwrap(), "outside");
    }

    #[test]
    fn scoped_rejects_oversized_content_and_preserves_existing_file() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        note_save_scoped(&root, "stable.md", "original").unwrap();
        let oversized = "x".repeat(MAX_NOTE_SIZE_BYTES + 1);
        assert!(note_save_scoped(&root, "stable.md", &oversized).is_err());
        assert_eq!(note_read_scoped(&root, "stable.md").unwrap(), "original");
    }

    #[allow(deprecated)]
    #[test]
    fn legacy_wrappers_remain_available_for_compilation_only() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("legacy.md").to_string_lossy().to_string();
        note_save(path.clone(), "legacy".to_string()).unwrap();
        assert_eq!(note_read(path).unwrap(), "legacy");
    }
}
