use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FloorHooks {
    #[serde(default)]
    pub setup: Vec<String>,
    #[serde(default)]
    pub run: Vec<String>,
    #[serde(default)]
    pub teardown: Vec<String>,
    #[serde(default)]
    pub auto_run_setup: bool,
}

impl Default for FloorHooks {
    fn default() -> Self {
        Self {
            setup: Vec::new(),
            run: Vec::new(),
            teardown: Vec::new(),
            auto_run_setup: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FloorInfo {
    pub id: String,
    pub name: String,
    pub branch_name: String,
    pub worktree_path: String,
    pub hooks: FloorHooks,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandPreview {
    pub floor_name: String,
    pub floor_branch: String,
    pub target_branch: String,
    pub diff_stat: String,
}

fn run_git_cmd(working_dir: &Path, args: &[&str]) -> Result<String, String> {
    let dir_str = working_dir.to_string_lossy().replace('\\', "/");
    let safe_dir_arg = format!("safe.directory={dir_str}");

    let mut full_args = vec!["-c", safe_dir_arg.as_str()];
    full_args.extend_from_slice(args);

    let output = Command::new("git.exe")
        .args(&full_args)
        .current_dir(working_dir)
        .output()
        .map_err(|e| format!("Failed to execute git.exe {:?}: {}", args, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let err_msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(format!("git {:?} failed: {}", args, err_msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn get_git_toplevel(root_path: &Path) -> Result<PathBuf, String> {
    if !root_path.exists() {
        return Err(format!("Root path does not exist: {}", root_path.display()));
    }
    let toplevel_str = run_git_cmd(root_path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("Root path is not inside a valid Git repository: {}", root_path.display()))?;

    let toplevel_path = PathBuf::from(toplevel_str);
    let canonical_root = root_path.canonicalize().map_err(|e| format!("Failed to canonicalize root_path: {e}"))?;
    let canonical_toplevel = toplevel_path.canonicalize().map_err(|e| format!("Failed to canonicalize git toplevel: {e}"))?;

    if canonical_root != canonical_toplevel {
        return Err(format!(
            "root_path '{}' is a subdirectory. Top-level Git repository root required: '{}'",
            root_path.display(),
            canonical_toplevel.display()
        ));
    }

    Ok(canonical_toplevel)
}

fn is_reparse_point_or_symlink(path: &Path) -> Result<bool, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to read symlink_metadata for '{}': {e}", path.display()))?;

    if meta.file_type().is_symlink() {
        return Ok(true);
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Ok(true);
        }
    }

    Ok(false)
}

fn check_ancestors_for_reparse_points(root: &Path, target: &Path) -> Result<(), String> {
    let mut current = target.to_path_buf();
    while current.starts_with(root) {
        if current.exists() {
            if is_reparse_point_or_symlink(&current)? {
                return Err(format!(
                    "Reparse point or symlink detected in ancestor path component: '{}'",
                    current.display()
                ));
            }
        }
        if current == root {
            break;
        }
        if !current.pop() {
            break;
        }
    }
    Ok(())
}

fn validate_floor_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Floor name cannot be empty".to_string());
    }
    if trimmed.starts_with('-') {
        return Err(format!("Invalid floor name '{name}': option-like floor names starting with '-' are prohibited"));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(format!("Invalid floor name '{name}': control characters are prohibited"));
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err(format!("Invalid floor name '{name}': trailing dots or spaces are prohibited on Windows"));
    }
    if name.contains("..") {
        return Err(format!("Invalid floor name '{name}': directory traversal is prohibited"));
    }

    let illegal_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if name.chars().any(|c| illegal_chars.contains(&c)) {
        return Err(format!("Invalid floor name '{name}': contains illegal path characters (<>:\"/\\|?*)"));
    }

    let stem = trimmed.split('.').next().unwrap_or(trimmed).to_ascii_uppercase();
    let reserved_names = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ];
    if reserved_names.contains(&stem.as_str()) {
        return Err(format!("Invalid floor name '{name}': '{stem}' is a Windows reserved device name"));
    }

    Ok(())
}

fn validate_branch_name(root_path: &Path, branch_name: &str) -> Result<(), String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if trimmed.starts_with('-') {
        return Err(format!("Invalid branch name '{branch_name}': option-like branch names starting with '-' are prohibited"));
    }
    if branch_name.chars().any(|c| c.is_control()) {
        return Err(format!("Invalid branch name '{branch_name}': control characters are prohibited"));
    }

    run_git_cmd(root_path, &["check-ref-format", "--branch", trimmed])
        .map_err(|e| format!("Invalid git branch name '{trimmed}': failed git check-ref-format check ({e})"))?;

    Ok(())
}

fn derive_and_validate_worktree_path(root_path: &Path, floor_name: &str) -> Result<PathBuf, String> {
    validate_floor_name(floor_name)?;
    let canonical_root = get_git_toplevel(root_path)?;
    let floors_container = canonical_root.join(".open-maestri").join("floors");
    let expected_path = floors_container.join(floor_name.trim());

    if !expected_path.starts_with(&floors_container) {
        return Err(format!(
            "Worktree path for floor '{}' escaped confinement outside '.open-maestri/floors'",
            floor_name
        ));
    }

    Ok(expected_path)
}

fn verify_registered_git_worktree(root_path: &Path, expected_path: &Path, expected_branch: &str) -> Result<(), String> {
    let porcelain = run_git_cmd(root_path, &["worktree", "list", "--porcelain"])?;

    let canonical_expected = if expected_path.exists() {
        expected_path.canonicalize().unwrap_or_else(|_| expected_path.to_path_buf())
    } else {
        expected_path.to_path_buf()
    };

    let mut current_wt: Option<PathBuf> = None;
    let mut _current_branch: Option<String> = None;
    let mut registered = false;

    for line in porcelain.lines() {
        if line.starts_with("worktree ") {
            let wt_str = line.trim_start_matches("worktree ").trim();
            let wt_path = PathBuf::from(wt_str);
            current_wt = Some(wt_path.canonicalize().unwrap_or(wt_path));
            _current_branch = None;
        } else if line.starts_with("branch ") {
            let branch_ref = line.trim_start_matches("branch ").trim();
            let branch_name = branch_ref.trim_start_matches("refs/heads/");
            _current_branch = Some(branch_name.to_string());

            if let Some(ref wt) = current_wt {
                if wt == &canonical_expected {
                    if branch_name == expected_branch {
                        registered = true;
                        break;
                    } else {
                        return Err(format!(
                            "Worktree at '{}' is registered to branch '{}', expected '{}'",
                            wt.display(),
                            branch_name,
                            expected_branch
                        ));
                    }
                }
            }
        }
    }

    if !registered {
        return Err(format!(
            "Worktree at '{}' is not registered in Git for floor branch '{}'",
            expected_path.display(),
            expected_branch
        ));
    }

    Ok(())
}

fn check_branch_exists(root_path: &Path, branch_name: &str) -> bool {
    let refs_arg = format!("refs/heads/{branch_name}");
    run_git_cmd(root_path, &["show-ref", "--verify", "--quiet", &refs_arg]).is_ok()
}

fn is_worktree_clean(dir: &Path) -> Result<bool, String> {
    let status = run_git_cmd(dir, &["status", "--porcelain"])?;
    Ok(status.trim().is_empty())
}

#[tauri::command]
pub fn floor_current_branch(root_path: String) -> Result<String, String> {
    let root = PathBuf::from(&root_path);
    let canonical_root = get_git_toplevel(&root)?;
    run_git_cmd(&canonical_root, &["rev-parse", "--abbrev-ref", "HEAD"])
}

#[tauri::command]
pub fn floor_create(
    root_path: String,
    name: String,
    branch_name: String,
    use_existing_branch: bool,
    hooks: Option<FloorHooks>,
) -> Result<FloorInfo, String> {
    let root = PathBuf::from(&root_path);
    let canonical_root = get_git_toplevel(&root)?;
    let expected_worktree_path = derive_and_validate_worktree_path(&canonical_root, &name)?;
    let worktree_path_str = expected_worktree_path.to_string_lossy().to_string();

    let branch = branch_name.trim();
    validate_branch_name(&canonical_root, branch)?;

    let floors_container = expected_worktree_path.parent().unwrap();

    check_ancestors_for_reparse_points(&canonical_root, floors_container)?;

    if let Err(e) = fs::create_dir_all(floors_container) {
        return Err(format!("Failed to create floors container directory: {e}"));
    }

    let canonical_container = floors_container
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize floors container: {e}"))?;

    if !canonical_container.starts_with(&canonical_root) {
        return Err(format!(
            "Floors container '{}' escaped confinement outside root '{}'",
            canonical_container.display(),
            canonical_root.display()
        ));
    }

    let branch_exists = check_branch_exists(&canonical_root, branch);
    if !use_existing_branch && branch_exists {
        return Err(format!("Branch '{branch}' already exists. Set useExistingBranch to true to checkout existing branch."));
    }
    if use_existing_branch && !branch_exists {
        return Err(format!("Branch '{branch}' does not exist. Cannot checkout non-existent branch."));
    }

    if use_existing_branch {
        run_git_cmd(&canonical_root, &["worktree", "add", &worktree_path_str, branch])?;
    } else {
        run_git_cmd(&canonical_root, &["worktree", "add", "-b", branch, &worktree_path_str])?;
    }

    let confinement_check: Result<(), String> = (|| {
        if is_reparse_point_or_symlink(&expected_worktree_path)? {
            return Err(format!(
                "Newly created worktree path '{}' is a reparse point or symlink",
                expected_worktree_path.display()
            ));
        }
        let canonical_worktree = expected_worktree_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize created worktree: {e}"))?;
        if !canonical_worktree.starts_with(&canonical_container) {
            return Err(format!(
                "Canonical worktree '{}' escaped confinement outside container '{}'",
                canonical_worktree.display(),
                canonical_container.display()
            ));
        }
        Ok(())
    })();

    if let Err(confinement_err) = confinement_check {
        let cleanup_res = run_git_cmd(&canonical_root, &["worktree", "remove", "--force", &worktree_path_str]);
        let cleanup_msg = match cleanup_res {
            Ok(_) => "Cleaned up unconfined worktree via git worktree remove --force.".to_string(),
            Err(e) => format!("Failed cleanup via git worktree remove --force: {e}"),
        };
        return Err(format!(
            "Post-creation confinement check failed: {confinement_err}. Cleanup status: {cleanup_msg}"
        ));
    }

    let resolved_hooks = hooks.unwrap_or_default();
    let created_at = chrono::Utc::now().to_rfc3339();
    let floor_id = crate::maestro::new_request_id();

    Ok(FloorInfo {
        id: floor_id,
        name: name.trim().to_string(),
        branch_name: branch.to_string(),
        worktree_path: worktree_path_str,
        hooks: resolved_hooks,
        created_at,
    })
}

#[tauri::command]
pub fn floor_remove(
    root_path: String,
    floor: FloorInfo,
    delete_branch: bool,
) -> Result<(), String> {
    let root = PathBuf::from(&root_path);
    let canonical_root = get_git_toplevel(&root)?;
    let expected_worktree_path = derive_and_validate_worktree_path(&canonical_root, &floor.name)?;

    let caller_path = PathBuf::from(&floor.worktree_path);
    let caller_canonical = caller_path.canonicalize().unwrap_or_else(|_| caller_path.clone());
    let expected_canonical = expected_worktree_path.canonicalize().unwrap_or_else(|_| expected_worktree_path.clone());

    if caller_canonical != expected_canonical {
        return Err(format!(
            "Tampered worktreePath detected! Caller path '{}' does not match derived confined path '{}'",
            floor.worktree_path,
            expected_worktree_path.display()
        ));
    }

    verify_registered_git_worktree(&canonical_root, &expected_worktree_path, &floor.branch_name)?;

    if !is_worktree_clean(&expected_worktree_path)? {
        return Err(format!(
            "Floor '{}' has uncommitted changes. Refusing to remove dirty worktree without explicit cleanup.",
            floor.name
        ));
    }

    if !floor.hooks.teardown.is_empty() {
        floor_run_hooks(root_path.clone(), floor.clone(), "teardown".to_string())?;
    }

    if !is_worktree_clean(&expected_worktree_path)? {
        return Err(format!(
            "Floor '{}' became dirty after teardown hooks execution. Refusing to remove dirty worktree.",
            floor.name
        ));
    }

    let worktree_path_str = expected_worktree_path.to_string_lossy().to_string();
    run_git_cmd(&canonical_root, &["worktree", "remove", &worktree_path_str])?;

    if delete_branch && !floor.branch_name.trim().is_empty() {
        run_git_cmd(&canonical_root, &["branch", "-D", &floor.branch_name])?;
    }

    Ok(())
}

#[tauri::command]
pub fn floor_run_hooks(
    root_path: String,
    floor: FloorInfo,
    hook_type: String,
) -> Result<(), String> {
    let root = PathBuf::from(&root_path);
    let canonical_root = get_git_toplevel(&root)?;
    let expected_worktree_path = derive_and_validate_worktree_path(&canonical_root, &floor.name)?;

    let caller_path = PathBuf::from(&floor.worktree_path);
    let caller_canonical = caller_path.canonicalize().unwrap_or_else(|_| caller_path.clone());
    let expected_canonical = expected_worktree_path.canonicalize().unwrap_or_else(|_| expected_worktree_path.clone());

    if caller_canonical != expected_canonical {
        return Err(format!(
            "Tampered worktreePath detected! Caller path '{}' does not match derived confined path '{}'",
            floor.worktree_path,
            expected_worktree_path.display()
        ));
    }

    if !expected_worktree_path.exists() {
        return Err(format!("Floor worktree directory does not exist: {}", expected_worktree_path.display()));
    }

    verify_registered_git_worktree(&canonical_root, &expected_worktree_path, &floor.branch_name)?;

    let project_name = canonical_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let commands_to_run = match hook_type.as_str() {
        "setup" => &floor.hooks.setup,
        "run" => &floor.hooks.run,
        "teardown" => &floor.hooks.teardown,
        other => return Err(format!("Unknown hook type: {other}. Expected setup, run, or teardown")),
    };

    for cmd_str in commands_to_run {
        let trimmed_cmd = cmd_str.trim();
        if trimmed_cmd.is_empty() {
            continue;
        }

        let output = Command::new("powershell.exe")
            .args(&["-NoProfile", "-NonInteractive", "-Command", trimmed_cmd])
            .current_dir(&expected_worktree_path)
            .env("OMAESTRI_FLOOR_NAME", &floor.name)
            .env("OMAESTRI_BRANCH_NAME", &floor.branch_name)
            .env("OMAESTRI_FLOOR_PATH", expected_worktree_path.to_string_lossy().as_ref())
            .env("OMAESTRI_ROOT_PATH", canonical_root.to_string_lossy().as_ref())
            .env("OMAESTRI_PROJECT_NAME", &project_name)
            .output()
            .map_err(|e| format!("Failed to launch PowerShell hook process: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let err_detail = if !stderr.trim().is_empty() { stderr.trim() } else { stdout.trim() };
            return Err(format!(
                "Hook command '{}' failed with exit code {:?}: {}",
                trimmed_cmd,
                output.status.code(),
                err_detail
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn floor_preview_land(
    root_path: String,
    floor: FloorInfo,
    target_branch: String,
) -> Result<LandPreview, String> {
    let root = PathBuf::from(&root_path);
    let canonical_root = get_git_toplevel(&root)?;
    let expected_worktree_path = derive_and_validate_worktree_path(&canonical_root, &floor.name)?;

    let caller_path = PathBuf::from(&floor.worktree_path);
    let caller_canonical = caller_path.canonicalize().unwrap_or_else(|_| caller_path.clone());
    let expected_canonical = expected_worktree_path.canonicalize().unwrap_or_else(|_| expected_worktree_path.clone());

    if caller_canonical != expected_canonical {
        return Err(format!(
            "Tampered worktreePath detected! Caller path '{}' does not match derived confined path '{}'",
            floor.worktree_path,
            expected_worktree_path.display()
        ));
    }

    verify_registered_git_worktree(&canonical_root, &expected_worktree_path, &floor.branch_name)?;

    if !is_worktree_clean(&expected_worktree_path)? {
        return Err(format!("Floor '{}' has uncommitted changes. Clean working tree required before landing.", floor.name));
    }
    if !is_worktree_clean(&canonical_root)? {
        return Err("Ground workspace root has uncommitted changes. Clean working tree required before landing.".to_string());
    }

    let current_ground_branch = floor_current_branch(root_path.clone())?;
    if current_ground_branch != target_branch {
        return Err(format!(
            "Target branch '{}' does not match currently checked out Ground branch '{}'. Switch Ground branch first.",
            target_branch, current_ground_branch
        ));
    }

    let diff_range = format!("{}..{}", target_branch, floor.branch_name);
    let diff_stat = run_git_cmd(&canonical_root, &["diff", "--stat", &diff_range])
        .map_err(|e| format!("Failed to generate diff stat for landing preview: {e}"))?;

    Ok(LandPreview {
        floor_name: floor.name,
        floor_branch: floor.branch_name,
        target_branch,
        diff_stat,
    })
}

#[tauri::command]
pub fn floor_land(
    root_path: String,
    floor: FloorInfo,
    target_branch: String,
) -> Result<(), String> {
    let root = PathBuf::from(&root_path);
    let canonical_root = get_git_toplevel(&root)?;
    let expected_worktree_path = derive_and_validate_worktree_path(&canonical_root, &floor.name)?;

    let caller_path = PathBuf::from(&floor.worktree_path);
    let caller_canonical = caller_path.canonicalize().unwrap_or_else(|_| caller_path.clone());
    let expected_canonical = expected_worktree_path.canonicalize().unwrap_or_else(|_| expected_worktree_path.clone());

    if caller_canonical != expected_canonical {
        return Err(format!(
            "Tampered worktreePath detected! Caller path '{}' does not match derived confined path '{}'",
            floor.worktree_path,
            expected_worktree_path.display()
        ));
    }

    verify_registered_git_worktree(&canonical_root, &expected_worktree_path, &floor.branch_name)?;

    if !is_worktree_clean(&expected_worktree_path)? {
        return Err(format!("Floor '{}' has uncommitted changes. Clean working tree required before landing.", floor.name));
    }
    if !is_worktree_clean(&canonical_root)? {
        return Err("Ground workspace root has uncommitted changes. Clean working tree required before landing.".to_string());
    }

    let current_ground_branch = floor_current_branch(root_path.clone())?;
    if current_ground_branch != target_branch {
        return Err(format!(
            "Target branch '{}' does not match currently checked out Ground branch '{}'. Switch Ground branch first.",
            target_branch, current_ground_branch
        ));
    }

    let merge_msg = format!("Landing: {}", floor.name);
    run_git_cmd(&canonical_root, &["merge", &floor.branch_name, "--no-ff", "-m", &merge_msg])?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::collections::HashSet;

    fn init_temp_git_repo() -> (TempDir, PathBuf) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let repo_path = temp_dir.path().canonicalize().expect("Failed to canonicalize temp dir");

        run_git_cmd(&repo_path, &["init", "-b", "main"]).unwrap_or_else(|_| {
            run_git_cmd(&repo_path, &["init"]).expect("Failed to init git repo");
            run_git_cmd(&repo_path, &["checkout", "-b", "main"])
                .expect("Failed to set main branch")
        });

        run_git_cmd(&repo_path, &["config", "user.name", "Test User"]).unwrap();
        run_git_cmd(&repo_path, &["config", "user.email", "test@example.com"]).unwrap();

        let readme = repo_path.join("README.md");
        fs::write(&readme, "# Test Repo\n").unwrap();
        run_git_cmd(&repo_path, &["add", "README.md"]).unwrap();
        run_git_cmd(&repo_path, &["commit", "-m", "Initial commit"]).unwrap();

        (temp_dir, repo_path)
    }

    #[test]
    fn test_floor_reparse_point_ancestor_fail_closed() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let maestri_dir = root_path.join(".open-maestri");
        fs::create_dir_all(&maestri_dir).unwrap();
        let link_dir = maestri_dir.join("floors");

        let target_dir = std::env::temp_dir().join("external_floors_target");
        let _ = fs::create_dir_all(&target_dir);

        #[cfg(windows)]
        {
            let res = Command::new("cmd.exe")
                .args(&["/C", "mklink", "/J", link_dir.to_string_lossy().as_ref(), target_dir.to_string_lossy().as_ref()])
                .output();
            if let Ok(out) = res {
                if out.status.success() {
                    let err = floor_create(
                        root_str,
                        "junction-floor".to_string(),
                        "feat/junction".to_string(),
                        false,
                        None,
                    );
                    assert!(err.is_err(), "floor_create must fail closed if ancestor is a junction/reparse point");
                    let err_msg = err.unwrap_err();
                    assert!(err_msg.contains("Reparse point") || err_msg.contains("symlink") || err_msg.contains("escaped"));
                }
            }
        }
        let _ = fs::remove_dir_all(&target_dir);
    }

    #[test]
    fn test_floor_remove_initial_dirty_prevents_teardown() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let hook_file = root_path.join("teardown_ran.txt");
        let hook_file_str = hook_file.to_string_lossy().replace('\\', "/");

        let hooks = FloorHooks {
            teardown: vec![format!("Set-Content -Path '{hook_file_str}' -Value 'executed'")],
            ..Default::default()
        };

        let floor = floor_create(
            root_str.clone(),
            "initial-dirty-floor".to_string(),
            "feat/dirty-initial".to_string(),
            false,
            Some(hooks),
        )
        .expect("Failed to create floor");

        let wt_path = PathBuf::from(&floor.worktree_path);
        let uncommitted_file = wt_path.join("uncommitted.txt");
        fs::write(&uncommitted_file, "dirty worktree content").unwrap();

        let res = floor_remove(root_str, floor, false);
        assert!(res.is_err(), "floor_remove must fail if worktree is dirty initially");
        assert!(!hook_file.exists(), "Teardown hook MUST NOT execute if worktree is dirty initially");
        assert!(wt_path.exists(), "Worktree directory must remain intact");
    }

    #[test]
    fn test_floor_uuid_format_and_uniqueness() {
        let mut set = HashSet::new();
        for _ in 0..100 {
            let id = crate::maestro::new_request_id();
            assert_eq!(id.len(), 36, "UUID length must be 36 chars");
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(parts.len(), 5, "UUID must have 5 hyphens-separated parts");
            assert_eq!(parts[0].len(), 8);
            assert_eq!(parts[1].len(), 4);
            assert_eq!(parts[2].len(), 4);
            assert_eq!(parts[3].len(), 4);
            assert_eq!(parts[4].len(), 12);
            assert!(set.insert(id), "UUID must be unique");
        }
    }

    #[test]
    fn test_floor_name_validation_windows_reserved_and_illegal_chars() {
        assert!(validate_floor_name("").is_err());
        assert!(validate_floor_name("   ").is_err());
        assert!(validate_floor_name("-invalid-option").is_err());
        assert!(validate_floor_name("floor\0name").is_err());
        assert!(validate_floor_name("floor_name.").is_err());
        assert!(validate_floor_name("floor_name ").is_err());
        assert!(validate_floor_name("../escaped").is_err());
        assert!(validate_floor_name("sub/dir").is_err());
        assert!(validate_floor_name("sub\\dir").is_err());
        assert!(validate_floor_name("floor:name").is_err());
        assert!(validate_floor_name("floor?name").is_err());
        assert!(validate_floor_name("floor*name").is_err());
        assert!(validate_floor_name("<floor>").is_err());
        assert!(validate_floor_name("floor|name").is_err());
        assert!(validate_floor_name("CON").is_err());
        assert!(validate_floor_name("con.txt").is_err());
        assert!(validate_floor_name("NUL").is_err());
        assert!(validate_floor_name("COM1").is_err());
        assert!(validate_floor_name("LPT9").is_err());
        assert!(validate_floor_name("valid-floor-name_123").is_ok());
    }

    #[test]
    fn test_branch_name_validation_git_check_ref_format() {
        let (_guard, root_path) = init_temp_git_repo();
        assert!(validate_branch_name(&root_path, "").is_err());
        assert!(validate_branch_name(&root_path, "-b").is_err());
        assert!(validate_branch_name(&root_path, "--help").is_err());
        assert!(validate_branch_name(&root_path, "branch\0name").is_err());
        assert!(validate_branch_name(&root_path, "head..tail").is_err());
        assert!(validate_branch_name(&root_path, "branch@{1}").is_err());
        assert!(validate_branch_name(&root_path, "branch?name").is_err());
        assert!(validate_branch_name(&root_path, "feat/valid-branch").is_ok());
    }

    #[test]
    fn test_floor_create_does_not_run_setup_automatically() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let out_file = root_path.join("setup_should_not_run.txt");
        let out_file_str = out_file.to_string_lossy().replace('\\', "/");

        let hooks = FloorHooks {
            setup: vec![format!("Set-Content -Path '{out_file_str}' -Value 'executed'")],
            auto_run_setup: true,
            ..Default::default()
        };

        let floor = floor_create(
            root_str,
            "no-auto-setup-floor".to_string(),
            "feat/no-auto-setup".to_string(),
            false,
            Some(hooks),
        )
        .expect("floor_create must succeed without running setup internal hooks");

        assert!(!out_file.exists(), "floor_create must NOT execute setup hooks internally");
        assert_eq!(floor.hooks.setup.len(), 1);
        assert!(floor.hooks.auto_run_setup);
    }

    #[test]
    fn test_floor_create_new_branch_real_git() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let current = floor_current_branch(root_str.clone()).unwrap();
        assert_eq!(current, "main");

        let floor = floor_create(
            root_str.clone(),
            "feature-floor-1".to_string(),
            "feat/new-feature".to_string(),
            false,
            None,
        )
        .expect("Failed to create floor with new branch");

        assert!(!floor.id.is_empty());
        assert_eq!(floor.name, "feature-floor-1");
        assert_eq!(floor.branch_name, "feat/new-feature");
        assert!(Path::new(&floor.worktree_path).exists());
        assert!(floor.worktree_path.contains(".open-maestri"));
        assert!(floor.worktree_path.contains("floors"));

        let wt_branch = floor_current_branch(floor.worktree_path.clone()).unwrap();
        assert_eq!(wt_branch, "feat/new-feature");
    }

    #[test]
    fn test_floor_remove_confined_real_git() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let floor = floor_create(
            root_str.clone(),
            "temp-floor".to_string(),
            "feat/to-be-removed".to_string(),
            false,
            None,
        )
        .expect("Failed to create floor");

        let wt_path = PathBuf::from(&floor.worktree_path);
        assert!(wt_path.exists());

        floor_remove(root_str.clone(), floor.clone(), true).expect("Failed to remove floor");

        assert!(!wt_path.exists());
        assert!(!check_branch_exists(&root_path, "feat/to-be-removed"));

        assert!(floor_create(
            root_str.clone(),
            "../illegal-floor".to_string(),
            "feat/illegal".to_string(),
            false,
            None,
        )
        .is_err());
    }

    #[test]
    fn test_floor_land_requires_clean_and_current_target() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let floor = floor_create(
            root_str.clone(),
            "land-floor".to_string(),
            "feat/land-feature".to_string(),
            false,
            None,
        )
        .expect("Failed to create floor");

        let floor_wt = PathBuf::from(&floor.worktree_path);
        let new_file = floor_wt.join("feature.txt");
        fs::write(&new_file, "New feature work\n").unwrap();
        run_git_cmd(&floor_wt, &["add", "feature.txt"]).unwrap();
        run_git_cmd(&floor_wt, &["commit", "-m", "Add feature"]).unwrap();

        let preview = floor_preview_land(root_str.clone(), floor.clone(), "main".to_string())
            .expect("Failed preview land");
        assert_eq!(preview.target_branch, "main");
        assert_eq!(preview.floor_branch, "feat/land-feature");
        assert!(preview.diff_stat.contains("feature.txt"));

        floor_land(root_str.clone(), floor.clone(), "main".to_string())
            .expect("Failed to land floor");

        let main_file = root_path.join("feature.txt");
        assert!(main_file.exists());
        assert_eq!(fs::read_to_string(main_file).unwrap(), "New feature work\n");

        assert!(floor_land(root_str.clone(), floor.clone(), "other-target".to_string()).is_err());

        let dirty_file = floor_wt.join("dirty.txt");
        fs::write(&dirty_file, "uncommitted change").unwrap();
        assert!(floor_land(root_str.clone(), floor.clone(), "main".to_string()).is_err());
    }

    #[test]
    fn test_floor_hooks_env_and_failure() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let out_file = root_path.join("hook_env_output.txt");
        let out_file_str = out_file.to_string_lossy().replace('\\', "/");

        let hooks = FloorHooks {
            setup: vec![format!("Set-Content -Path '{out_file_str}' -Value \"$env:OMAESTRI_FLOOR_NAME|$env:OMAESTRI_BRANCH_NAME|$env:OMAESTRI_PROJECT_NAME\"")],
            run: vec!["Write-Output 'Success'".to_string()],
            teardown: vec!["exit 1".to_string()],
            auto_run_setup: false,
        };

        let floor = floor_create(
            root_str.clone(),
            "hook-floor".to_string(),
            "feat/hook-test".to_string(),
            false,
            Some(hooks),
        )
        .expect("Failed to create floor with hooks");

        floor_run_hooks(root_str.clone(), floor.clone(), "setup".to_string()).expect("Setup hooks failed");

        assert!(out_file.exists());
        let env_content = fs::read_to_string(&out_file).unwrap();
        assert!(env_content.contains("hook-floor"));
        assert!(env_content.contains("feat/hook-test"));

        floor_run_hooks(root_str.clone(), floor.clone(), "run".to_string()).expect("Run hooks failed");

        let teardown_res = floor_run_hooks(root_str.clone(), floor, "teardown".to_string());
        assert!(teardown_res.is_err());
    }

    #[test]
    fn test_floor_tamper_worktree_path_fail_closed() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let mut floor = floor_create(
            root_str.clone(),
            "tamper-floor".to_string(),
            "feat/tamper-test".to_string(),
            false,
            None,
        )
        .expect("Failed to create floor");

        let fake_path = std::env::temp_dir().join("escaped_path").to_string_lossy().to_string();
        floor.worktree_path = fake_path;

        assert!(floor_run_hooks(root_str.clone(), floor.clone(), "run".to_string()).is_err());
        assert!(floor_remove(root_str.clone(), floor.clone(), false).is_err());
        assert!(floor_preview_land(root_str.clone(), floor.clone(), "main".to_string()).is_err());
        assert!(floor_land(root_str.clone(), floor.clone(), "main".to_string()).is_err());
    }

    #[test]
    fn test_floor_create_use_existing_branch_matrix() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        run_git_cmd(&root_path, &["branch", "existing-branch"]).expect("Failed to create existing branch");

        let err1 = floor_create(
            root_str.clone(),
            "floor-ex-1".to_string(),
            "existing-branch".to_string(),
            false,
            None,
        );
        assert!(err1.is_err(), "use_existing_branch=false with existing branch must fail");

        let err2 = floor_create(
            root_str.clone(),
            "floor-ex-2".to_string(),
            "non-existent-branch".to_string(),
            true,
            None,
        );
        assert!(err2.is_err(), "use_existing_branch=true with missing branch must fail");

        let ok1 = floor_create(
            root_str.clone(),
            "floor-ok-1".to_string(),
            "existing-branch".to_string(),
            true,
            None,
        );
        assert!(ok1.is_ok(), "use_existing_branch=true with existing branch must succeed");

        let ok2 = floor_create(
            root_str.clone(),
            "floor-ok-2".to_string(),
            "new-branch-xyz".to_string(),
            false,
            None,
        );
        assert!(ok2.is_ok(), "use_existing_branch=false with new branch must succeed");
    }

    #[test]
    fn test_floor_remove_teardown_failure_aborts() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let hooks = FloorHooks {
            teardown: vec!["exit 1".to_string()],
            ..Default::default()
        };

        let floor = floor_create(
            root_str.clone(),
            "teardown-fail-floor".to_string(),
            "feat/td-fail".to_string(),
            false,
            Some(hooks),
        )
        .expect("Failed to create floor");

        let wt_path = PathBuf::from(&floor.worktree_path);
        assert!(wt_path.exists());

        let res = floor_remove(root_str.clone(), floor, false);
        assert!(res.is_err(), "floor_remove must fail if teardown hook fails");

        assert!(wt_path.exists(), "Worktree must NOT be deleted if teardown hook aborts");
    }

    #[test]
    fn test_floor_remove_delete_branch_failure_returns_err() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let mut floor = floor_create(
            root_str.clone(),
            "del-br-floor".to_string(),
            "feat/del-br".to_string(),
            false,
            None,
        )
        .expect("Failed to create floor");

        floor.branch_name = "invalid/non-existent-branch".to_string();

        let res = floor_remove(root_str.clone(), floor, true);
        assert!(res.is_err(), "floor_remove must fail if delete_branch fails");
    }
}
