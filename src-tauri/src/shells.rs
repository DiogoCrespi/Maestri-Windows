use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

pub trait PathChecker {
    fn exists(&self, path: &Path) -> bool;
}

pub struct RealPathChecker;

impl PathChecker for RealPathChecker {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
}

pub fn discover_shells<P: PathChecker>(path_checker: &P) -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    let mut default_assigned = false;

    // 1. PowerShell 7+ (pwsh)
    if let Some(path) =
        find_in_path("pwsh.exe", path_checker).or_else(|| check_common_pwsh_paths(path_checker))
    {
        shells.push(ShellInfo {
            id: "pwsh".to_string(),
            name: "PowerShell 7+".to_string(),
            path: path.to_string_lossy().to_string(),
            is_default: true,
        });
        default_assigned = true;
    }

    // 2. Windows PowerShell (powershell.exe)
    if let Some(path) = find_in_path("powershell.exe", path_checker)
        .or_else(|| check_system32_powershell(path_checker))
    {
        let is_def = !default_assigned;
        if is_def {
            default_assigned = true;
        }
        shells.push(ShellInfo {
            id: "powershell".to_string(),
            name: "Windows PowerShell".to_string(),
            path: path.to_string_lossy().to_string(),
            is_default: is_def,
        });
    }

    // 3. Command Prompt (cmd.exe)
    if let Some(path) =
        find_in_path("cmd.exe", path_checker).or_else(|| check_system32_cmd(path_checker))
    {
        let is_def = !default_assigned;
        if is_def {
            default_assigned = true;
        }
        shells.push(ShellInfo {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            path: path.to_string_lossy().to_string(),
            is_default: is_def,
        });
    }

    // 4. WSL (wsl.exe)
    if let Some(path) =
        find_in_path("wsl.exe", path_checker).or_else(|| check_system32_wsl(path_checker))
    {
        let is_def = !default_assigned;
        shells.push(ShellInfo {
            id: "wsl".to_string(),
            name: "WSL (Bash)".to_string(),
            path: path.to_string_lossy().to_string(),
            is_default: is_def,
        });
    }

    shells
}

fn find_in_path<P: PathChecker>(binary_name: &str, path_checker: &P) -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(binary_name);
            if path_checker.exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn check_common_pwsh_paths<P: PathChecker>(path_checker: &P) -> Option<PathBuf> {
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let p7 = PathBuf::from(program_files)
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe");
        if path_checker.exists(&p7) {
            return Some(p7);
        }
    }
    None
}

fn check_system32_powershell<P: PathChecker>(path_checker: &P) -> Option<PathBuf> {
    if let Ok(system_root) = std::env::var("SystemRoot") {
        let ps = PathBuf::from(system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if path_checker.exists(&ps) {
            return Some(ps);
        }
    }
    None
}

fn check_system32_cmd<P: PathChecker>(path_checker: &P) -> Option<PathBuf> {
    if let Ok(system_root) = std::env::var("SystemRoot") {
        let cmd = PathBuf::from(system_root).join("System32").join("cmd.exe");
        if path_checker.exists(&cmd) {
            return Some(cmd);
        }
    }
    None
}

fn check_system32_wsl<P: PathChecker>(path_checker: &P) -> Option<PathBuf> {
    if let Ok(system_root) = std::env::var("SystemRoot") {
        let wsl = PathBuf::from(system_root).join("System32").join("wsl.exe");
        if path_checker.exists(&wsl) {
            return Some(wsl);
        }
    }
    None
}

#[tauri::command]
pub fn shell_list() -> Result<Vec<ShellInfo>, String> {
    let checker = RealPathChecker;
    Ok(discover_shells(&checker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    struct MockPathChecker {
        existing_paths: HashSet<PathBuf>,
    }

    impl PathChecker for MockPathChecker {
        fn exists(&self, path: &Path) -> bool {
            self.existing_paths.contains(path)
        }
    }

    #[test]
    fn test_discover_shells_prioritizes_pwsh_as_default() {
        let mut mock = MockPathChecker {
            existing_paths: HashSet::new(),
        };
        mock.existing_paths
            .insert(PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"));
        mock.existing_paths
            .insert(PathBuf::from(r"C:\Windows\System32\cmd.exe"));

        std::env::set_var("ProgramFiles", r"C:\Program Files");
        std::env::set_var("SystemRoot", r"C:\Windows");

        let shells = discover_shells(&mock);
        assert_eq!(shells.len(), 2);
        assert_eq!(shells[0].id, "pwsh");
        assert!(shells[0].is_default);
        assert_eq!(shells[1].id, "cmd");
        assert!(!shells[1].is_default);
    }

    #[test]
    fn test_discover_shells_fallback_default_to_powershell() {
        let mut mock = MockPathChecker {
            existing_paths: HashSet::new(),
        };
        mock.existing_paths.insert(PathBuf::from(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        ));
        mock.existing_paths
            .insert(PathBuf::from(r"C:\Windows\System32\cmd.exe"));

        std::env::set_var("ProgramFiles", r"C:\Program Files");
        std::env::set_var("SystemRoot", r"C:\Windows");

        let shells = discover_shells(&mock);
        assert_eq!(shells.len(), 2);
        assert_eq!(shells[0].id, "powershell");
        assert!(shells[0].is_default);
        assert_eq!(shells[1].id, "cmd");
        assert!(!shells[1].is_default);
    }

    #[test]
    fn test_shell_info_serde_camel_case() {
        let info = ShellInfo {
            id: "pwsh".to_string(),
            name: "PowerShell 7+".to_string(),
            path: r"C:\Program Files\PowerShell\7\pwsh.exe".to_string(),
            is_default: true,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""isDefault":true"#));
        assert!(json.contains(r#""id":"pwsh""#));
        assert!(json.contains(r#""name":"PowerShell 7+""#));
    }
}
