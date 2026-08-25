use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Resposta ou item retornado pela listagem de diretório
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub total_entries: usize,
    pub is_truncated: bool,
}

const DEFAULT_MAX_ENTRIES: usize = 1000;

#[tauri::command]
pub fn list_directory(
    path: String,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
) -> Result<DirectoryListing, String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    let target_path = PathBuf::from(trimmed_path);
    if !target_path.exists() {
        return Err(format!("Path does not exist: {}", target_path.display()));
    }

    if !target_path.is_dir() {
        return Err(format!(
            "Path is not a directory: {}",
            target_path.display()
        ));
    }

    let limit = max_entries.unwrap_or(DEFAULT_MAX_ENTRIES).clamp(1, 5000);
    let show_hidden = include_hidden.unwrap_or(false);

    let read_dir = fs::read_dir(&target_path).map_err(|err| {
        format!(
            "Failed to read directory '{}': {}",
            target_path.display(),
            err
        )
    })?;

    let mut entries = Vec::new();
    let mut is_truncated = false;

    for item in read_dir {
        let entry = match item {
            Ok(e) => e,
            Err(_) => continue,
        };

        let file_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if !show_hidden && is_hidden_file(&name, &file_path) {
            continue;
        }

        if entries.len() >= limit {
            is_truncated = true;
            break;
        }

        let metadata = entry.metadata().ok();
        let file_type = metadata.as_ref().map(|m| m.file_type());

        let is_dir = file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false);
        let is_file = file_type.as_ref().map(|t| t.is_file()).unwrap_or(false);
        let is_symlink = file_type.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

        let modified_at_ms = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        entries.push(FileEntry {
            name,
            path: file_path.to_string_lossy().to_string(),
            is_dir,
            is_file,
            is_symlink,
            size,
            modified_at_ms,
        });
    }

    // Ordenar diretórios primeiro, depois arquivos alfabeticamente (ordenação determinística)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    let total_entries = entries.len();

    Ok(DirectoryListing {
        path: target_path.to_string_lossy().to_string(),
        entries,
        total_entries,
        is_truncated,
    })
}

fn is_hidden_file(name: &str, _path: &std::path::Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if let Ok(metadata) = _path.metadata() {
            // FILE_ATTRIBUTE_HIDDEN = 0x2
            if (metadata.file_attributes() & 0x2) != 0 {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_list_directory_empty_path_error() {
        let res = list_directory("".to_string(), None, None);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "Path cannot be empty");

        let res_whitespace = list_directory("   ".to_string(), None, None);
        assert!(res_whitespace.is_err());
        assert_eq!(res_whitespace.unwrap_err(), "Path cannot be empty");
    }

    #[test]
    fn test_list_directory_non_existent_path() {
        let res = list_directory("C:\\non_existent_path_xyz_12345".to_string(), None, None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Path does not exist"));
    }

    #[test]
    fn test_list_directory_success() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test_file.txt");
        let sub_dir_path = dir.path().join("sub_folder");

        File::create(&file_path).unwrap();
        fs::create_dir(&sub_dir_path).unwrap();

        let listing = list_directory(dir.path().to_string_lossy().to_string(), None, None).unwrap();

        assert_eq!(listing.total_entries, 2);
        assert!(!listing.is_truncated);

        // Subdiretório deve vir primeiro devido à ordenação
        assert_eq!(listing.entries[0].name, "sub_folder");
        assert!(listing.entries[0].is_dir);

        assert_eq!(listing.entries[1].name, "test_file.txt");
        assert!(listing.entries[1].is_file);
    }

    #[test]
    fn test_list_directory_limit() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            File::create(dir.path().join(format!("file_{}.txt", i))).unwrap();
        }

        let listing = list_directory(dir.path().to_string_lossy().to_string(), Some(5), None).unwrap();

        assert_eq!(listing.entries.len(), 5);
        assert!(listing.is_truncated);
    }

    #[test]
    fn test_list_directory_hidden_files_filtering() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join(".hidden_file")).unwrap();
        File::create(dir.path().join("visible_file.txt")).unwrap();

        let default_listing = list_directory(dir.path().to_string_lossy().to_string(), None, None).unwrap();
        assert_eq!(default_listing.entries.len(), 1);
        assert_eq!(default_listing.entries[0].name, "visible_file.txt");

        let hidden_listing = list_directory(dir.path().to_string_lossy().to_string(), None, Some(true)).unwrap();
        assert_eq!(hidden_listing.entries.len(), 2);
    }

    #[test]
    fn test_list_directory_deterministic_sorting() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("b.txt")).unwrap();
        File::create(dir.path().join("a.txt")).unwrap();
        fs::create_dir(dir.path().join("Z_folder")).unwrap();
        fs::create_dir(dir.path().join("a_folder")).unwrap();

        let listing = list_directory(dir.path().to_string_lossy().to_string(), None, None).unwrap();
        let names: Vec<String> = listing.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["a_folder", "Z_folder", "a.txt", "b.txt"]);
    }
}
