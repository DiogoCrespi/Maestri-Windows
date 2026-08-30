use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(crate) fn build_child_path(
    cli_dir: Option<&Path>,
    current_path: Option<&OsStr>,
    system_root: Option<&OsStr>,
) -> Option<OsString> {
    let mut candidates = Vec::new();
    if let Some(cli_dir) = cli_dir {
        candidates.push(cli_dir.to_path_buf());
    }

    #[cfg(windows)]
    if let Some(system_root) = system_root {
        let root = PathBuf::from(system_root);
        candidates.push(root.join("System32"));
        candidates.push(root.join("System32").join("WindowsPowerShell").join("v1.0"));
        candidates.push(root.join("System32").join("Wbem"));
        candidates.push(root);
    }

    #[cfg(not(windows))]
    let _ = system_root;

    if let Some(current_path) = current_path {
        candidates.extend(std::env::split_paths(current_path));
    }

    let mut entries: Vec<PathBuf> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if !entries.iter().any(|entry| same_path(entry, &candidate)) {
            entries.push(candidate);
        }
    }
    std::env::join_paths(entries).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_path_is_child_only_and_preserves_process_path() {
        let original_path = std::env::var_os("PATH");
        let child_path =
            build_child_path(Some(Path::new("cli")), Some(OsStr::new("existing")), None)
                .expect("PATH should be joinable");
        let child_entries: Vec<_> = std::env::split_paths(&child_path).collect();

        assert_eq!(child_entries.first(), Some(&PathBuf::from("cli")));
        assert_eq!(std::env::var_os("PATH"), original_path);
    }

    #[cfg(windows)]
    #[test]
    fn adds_concrete_windows_powershell_directory() {
        let child_path = build_child_path(
            Some(Path::new(r"C:\Program Files\Maestri\resources\cli")),
            Some(OsStr::new(
                r"%SYSTEMROOT%\System32\WindowsPowerShell\v1.0;C:\tools",
            )),
            Some(OsStr::new(r"C:\Windows")),
        )
        .expect("PATH should be joinable");
        let entries: Vec<_> = std::env::split_paths(&child_path).collect();

        assert_eq!(
            entries.first(),
            Some(&PathBuf::from(r"C:\Program Files\Maestri\resources\cli"))
        );
        assert!(entries.contains(&PathBuf::from(r"C:\Windows\System32")));
        assert!(entries.contains(&PathBuf::from(
            r"C:\Windows\System32\WindowsPowerShell\v1.0"
        )));
        assert!(entries.contains(&PathBuf::from(r"C:\Windows\System32\Wbem")));
    }

    #[cfg(windows)]
    #[test]
    fn resolves_the_installed_windows_powershell_executable() {
        let system_root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("WINDIR"))
            .expect("Windows must publish its system root");
        let child_path = build_child_path(None, None, Some(&system_root))
            .expect("system PATH should be joinable");
        let resolves =
            std::env::split_paths(&child_path).any(|entry| entry.join("powershell.exe").is_file());

        assert!(
            resolves,
            "the concrete child PATH must resolve powershell.exe"
        );
    }
}
