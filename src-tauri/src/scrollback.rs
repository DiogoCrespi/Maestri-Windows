//! Secure persistent scrollback engine for Windows terminals.
//!
//! Provides ring-buffered, atomic, file-backed scrollback persistence per terminal
//! and workspace. Guards against path traversal, symlink hijacking, and reparse points.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::NamedTempFile;

pub const DEFAULT_MAX_LINES: usize = 10_000;
pub const DEFAULT_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB limit
pub const MAX_TERMINAL_ID_LEN: usize = 128;

#[derive(Debug, Clone)]
pub struct ScrollbackConfig {
    pub max_lines: usize,
    pub max_bytes: usize,
}

impl Default for ScrollbackConfig {
    fn default() -> Self {
        Self {
            max_lines: DEFAULT_MAX_LINES,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

use std::sync::atomic::{AtomicU64, Ordering};

static STORE_GENERATION_COUNTER: AtomicU64 = AtomicU64::new(1);

pub struct ScrollbackStore {
    workspace_dir: PathBuf,
    config: ScrollbackConfig,
    generation: u64,
    lock: Mutex<()>,
}

impl ScrollbackStore {
    pub fn new<P: AsRef<Path>>(
        workspace_dir: P,
        config: Option<ScrollbackConfig>,
    ) -> Result<Self, String> {
        let raw_path = workspace_dir.as_ref();
        if raw_path.as_os_str().is_empty() {
            return Err("Workspace path cannot be empty".to_string());
        }

        if !raw_path.is_absolute() {
            return Err(format!(
                "Workspace path '{}' must be an absolute path",
                raw_path.display()
            ));
        }

        if !raw_path.exists() {
            return Err(format!(
                "Workspace directory '{}' does not exist",
                raw_path.display()
            ));
        }

        let generation = STORE_GENERATION_COUNTER.fetch_add(1, Ordering::Relaxed);

        // Validate workspace_dir and parents for symlinks / reparse points
        validate_no_reparse_or_symlink(raw_path)?;

        let canonical_workspace = raw_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize workspace path: {e}"))?;

        let config = config.unwrap_or_default();

        Ok(Self {
            workspace_dir: canonical_workspace,
            config,
            generation,
            lock: Mutex::new(()),
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Incremental resolution: creates .maestri and .maestri/scrollback securely step-by-step
    pub fn resolve_scrollback_path(&self, terminal_id: &str) -> Result<PathBuf, String> {
        let clean_id = terminal_id.trim();
        if clean_id.is_empty() || clean_id.len() > MAX_TERMINAL_ID_LEN {
            return Err("Terminal ID is invalid or too long".to_string());
        }

        if !clean_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return Err(format!(
                "Terminal ID '{clean_id}' contains illegal characters"
            ));
        }
        if clean_id.contains("..") {
            return Err("Path traversal attempt detected in terminal ID".to_string());
        }

        // Step 1: validate workspace dir
        validate_no_reparse_or_symlink(&self.workspace_dir)?;

        // Step 2: create .maestri securely
        let maestri_dir = self.workspace_dir.join(".maestri");
        if !maestri_dir.exists() {
            fs::create_dir(&maestri_dir)
                .map_err(|e| format!("Failed to create .maestri dir: {e}"))?;
        }
        validate_no_reparse_or_symlink(&maestri_dir)?;

        // Step 3: create .maestri/scrollback securely
        let scrollback_dir = maestri_dir.join("scrollback");
        if !scrollback_dir.exists() {
            fs::create_dir(&scrollback_dir)
                .map_err(|e| format!("Failed to create scrollback dir: {e}"))?;
        }
        validate_no_reparse_or_symlink(&scrollback_dir)?;

        let target_path = scrollback_dir.join(format!("{clean_id}.log"));
        if target_path.exists() {
            validate_no_reparse_or_symlink(&target_path)?;
        }

        Ok(target_path)
    }

    /// Appends raw VT/ANSI output data securely, applying ring-buffer bounds preserving MOST RECENT data.
    pub fn append(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }

        let _guard = self
            .lock
            .lock()
            .map_err(|_| "ScrollbackStore lock poisoned".to_string())?;
        let path = self.resolve_scrollback_path(terminal_id)?;

        {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("Failed to open scrollback file for append: {e}"))?;

            file.write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write scrollback data: {e}"))?;
            file.flush()
                .map_err(|e| format!("Failed to flush scrollback file: {e}"))?;
        }

        self.enforce_ring_buffer_bounds(&path)?;
        Ok(())
    }

    /// Loads scrollback output as raw string preserving VT/ANSI codes and exact line delimiters.
    pub fn load_text(&self, terminal_id: &str) -> Result<String, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "ScrollbackStore lock poisoned".to_string())?;
        let path = self.resolve_scrollback_path(terminal_id)?;

        if !path.exists() {
            return Ok(String::new());
        }

        let mut file =
            File::open(&path).map_err(|e| format!("Failed to open scrollback file: {e}"))?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read scrollback file: {e}"))?;

        // Lossy UTF-8 conversion preserves VT/ANSI byte sequences and valid string content without panicking
        Ok(String::from_utf8_lossy(&buffer).into_owned())
    }

    /// Loads scrollback output as lines up to requested max_lines (or config.max_lines).
    pub fn load(
        &self,
        terminal_id: &str,
        requested_lines: Option<usize>,
    ) -> Result<Vec<String>, String> {
        let raw_text = self.load_text(terminal_id)?;
        if raw_text.is_empty() {
            return Ok(Vec::new());
        }

        let mut lines: Vec<String> = raw_text.lines().map(String::from).collect();
        let max = requested_lines
            .unwrap_or(self.config.max_lines)
            .min(self.config.max_lines);

        if lines.len() > max {
            let drain_count = lines.len() - max;
            lines.drain(0..drain_count);
        }

        Ok(lines)
    }

    /// Clears scrollback log for specified terminal.
    pub fn clear(&self, terminal_id: &str) -> Result<bool, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "ScrollbackStore lock poisoned".to_string())?;
        let path = self.resolve_scrollback_path(terminal_id)?;

        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("Failed to remove scrollback file: {e}"))?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Internal helper: Enforces ring buffer line and byte limits, preserving the MOST RECENT bytes/lines.
    fn enforce_ring_buffer_bounds(&self, path: &Path) -> Result<(), String> {
        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => return Ok(()),
        };

        let file_len = metadata.len() as usize;
        if file_len <= self.config.max_bytes {
            // Check line count quickly
            let raw_text = fs::read_to_string(path).unwrap_or_default();
            let line_count = raw_text.lines().count();
            if line_count <= self.config.max_lines {
                return Ok(());
            }
        }

        // Read full binary contents to preserve exact VT/ANSI and UTF-8 multibytes
        let mut file = File::open(path)
            .map_err(|e| format!("Failed to open file for ring buffer check: {e}"))?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read scrollback file: {e}"))?;

        // 1. Truncate by byte limit PRESERVING THE END (MOST RECENT bytes)
        let mut truncated_buffer = if buffer.len() > self.config.max_bytes {
            let start = buffer.len() - self.config.max_bytes;
            // Align start to valid UTF-8 char boundary or newline to prevent corrupting multibyte sequences
            let mut valid_start = start;
            while valid_start < buffer.len() && (buffer[valid_start] & 0xC0) == 0x80 {
                valid_start += 1;
            }
            buffer[valid_start..].to_vec()
        } else {
            buffer
        };

        // 2. Truncate by line limit PRESERVING THE END (MOST RECENT lines)
        let text_view = String::from_utf8_lossy(&truncated_buffer);
        let line_count = text_view.lines().count();
        if line_count > self.config.max_lines {
            let drop_lines = line_count - self.config.max_lines;
            let mut lines_seen = 0;
            let mut byte_offset = 0;

            for (idx, b) in truncated_buffer.iter().enumerate() {
                if *b == b'\n' {
                    lines_seen += 1;
                    if lines_seen == drop_lines {
                        byte_offset = idx + 1;
                        break;
                    }
                }
            }
            if byte_offset < truncated_buffer.len() {
                truncated_buffer = truncated_buffer[byte_offset..].to_vec();
            }
        }

        // Atomic overwrite using tempfile in target parent directory
        let parent = path
            .parent()
            .ok_or_else(|| "Invalid parent path".to_string())?;
        let mut temp_file = NamedTempFile::new_in(parent)
            .map_err(|e| format!("Failed to create tempfile for scrollback replace: {e}"))?;

        temp_file
            .write_all(&truncated_buffer)
            .map_err(|e| format!("Failed to write to tempfile: {e}"))?;
        temp_file
            .flush()
            .map_err(|e| format!("Failed to flush tempfile: {e}"))?;

        // Explicitly drop file handle before persist to avoid Windows Access Denied (error 5)
        drop(file);

        // Persist / Replace atomically on Windows
        temp_file
            .persist(path)
            .map_err(|e| format!("Failed atomic scrollback replacement: {e}"))?;

        Ok(())
    }
}

/// Helper function to reject symlinks and reparse points on Windows
fn validate_no_reparse_or_symlink(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let metadata = fs::symlink_metadata(path).map_err(|e| {
        format!(
            "Failed to inspect path metadata for '{}': {e}",
            path.display()
        )
    })?;

    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(format!(
            "Path '{}' is rejected: it is a symlink",
            path.display()
        ));
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(format!(
                "Path '{}' is rejected: it is a reparse point / junction",
                path.display()
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use tempfile::tempdir;

    #[test]
    fn test_scrollback_append_load_clear() {
        let dir = tempdir().unwrap();
        let store = ScrollbackStore::new(dir.path(), None).unwrap();

        let term_id = "term-test-1";
        store.append(term_id, "Line 1\nLine 2\n").unwrap();
        store.append(term_id, "Line 3\n").unwrap();

        let loaded = store.load(term_id, None).unwrap();
        assert_eq!(loaded, vec!["Line 1", "Line 2", "Line 3"]);

        let raw = store.load_text(term_id).unwrap();
        assert_eq!(raw, "Line 1\nLine 2\nLine 3\n");

        let cleared = store.clear(term_id).unwrap();
        assert!(cleared);
        assert_eq!(store.load(term_id, None).unwrap().len(), 0);
    }

    #[test]
    fn test_non_existent_or_relative_root_rejection() {
        assert!(ScrollbackStore::new("relative/path", None).is_err());
        assert!(ScrollbackStore::new(Path::new("C:\\NonExistentDirectory12345"), None).is_err());
    }

    #[test]
    fn test_byte_limit_retains_most_recent_end() {
        let dir = tempdir().unwrap();
        let config = ScrollbackConfig {
            max_lines: 100,
            max_bytes: 30, // Small byte limit
        };
        let store = ScrollbackStore::new(dir.path(), Some(config)).unwrap();

        let term_id = "term-byte-limit";
        store.append(term_id, "OLD_DATA_1234567890\n").unwrap();
        store.append(term_id, "NEW_DATA_9876543210\n").unwrap();

        let raw = store.load_text(term_id).unwrap();
        assert!(!raw.contains("OLD_DATA"));
        assert!(raw.contains("NEW_DATA_9876543210"));
    }

    #[test]
    fn test_ansi_escape_and_crlf_roundtrip() {
        let dir = tempdir().unwrap();
        let store = ScrollbackStore::new(dir.path(), None).unwrap();

        let term_id = "term-ansi";
        let ansi_string = "\x1b[31mRed Text\x1b[0m\r\nLine2\r\n";
        store.append(term_id, ansi_string).unwrap();

        let loaded_text = store.load_text(term_id).unwrap();
        assert_eq!(loaded_text, ansi_string);
    }

    #[test]
    fn test_path_traversal_and_invalid_chars_rejection() {
        let dir = tempdir().unwrap();
        let store = ScrollbackStore::new(dir.path(), None).unwrap();

        assert!(store.resolve_scrollback_path("../etc/passwd").is_err());
        assert!(store.resolve_scrollback_path("term/slash").is_err());
        assert!(store.resolve_scrollback_path("term\\backslash").is_err());
        assert!(store.resolve_scrollback_path("term;cmd").is_err());
    }

    #[test]
    fn test_volume_truncation_and_ring_buffer_bounds() {
        let dir = tempdir().unwrap();
        let config = ScrollbackConfig {
            max_lines: 5,
            max_bytes: 1024,
        };
        let store = ScrollbackStore::new(dir.path(), Some(config)).unwrap();

        let term_id = "term-volume";
        for i in 1..=10 {
            store
                .append(term_id, &format!("Output Line {i}\n"))
                .unwrap();
        }

        let loaded = store.load(term_id, None).unwrap();
        assert_eq!(loaded.len(), 5);
        assert_eq!(loaded[0], "Output Line 6");
        assert_eq!(loaded[4], "Output Line 10");
    }

    #[test]
    fn test_concurrent_multithreaded_appends() {
        let dir = tempdir().unwrap();
        let store = Arc::new(ScrollbackStore::new(dir.path(), None).unwrap());

        let term_id = "term-concurrent";
        let mut handles = Vec::new();

        for thread_idx in 0..5 {
            let store_clone = Arc::clone(&store);
            let id = term_id.to_string();
            let handle = thread::spawn(move || {
                for line_idx in 0..10 {
                    store_clone
                        .append(&id, &format!("Thread {thread_idx} Msg {line_idx}\n"))
                        .unwrap();
                }
            });
            handles.push(handle);
        }

        for h in handles {
            h.join().unwrap();
        }

        let loaded = store.load(term_id, Some(100)).unwrap();
        assert_eq!(loaded.len(), 50);
    }
}
