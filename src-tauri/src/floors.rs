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
    let output = Command::new("git.exe")
        .args(args)
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

fn is_git_repository(root_path: &Path) -> bool {
    run_git_cmd(root_path, &["rev-parse", "--is-inside-work-tree"])
        .map(|out| out == "true")
        .unwrap_or(false)
}

fn validate_floor_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Floor name cannot be empty".to_string());
    }
    if trimmed.contains("..") || trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains(':') {
        return Err(format!("Invalid floor name '{}': directory traversal or illegal characters prohibited", name));
    }
    Ok(())
}

fn get_floors_dir(root_path: &Path) -> Result<PathBuf, String> {
    if !root_path.is_absolute() {
        return Err(format!("Root path must be absolute: {}", root_path.display()));
    }
    if !is_git_repository(root_path) {
        return Err(format!("Root path is not a valid Git repository: {}", root_path.display()));
    }
    let floors_dir = root_path.join(".open-maestri").join("floors");
    Ok(floors_dir)
}

fn get_confined_worktree_path(root_path: &Path, name: &str) -> Result<PathBuf, String> {
    validate_floor_name(name)?;
    let floors_dir = get_floors_dir(root_path)?;
    let worktree_path = floors_dir.join(name.trim());

    if !worktree_path.starts_with(&floors_dir) {
        return Err(format!("Worktree path '{}' escaped confinement outside '.open-maestri/floors'", worktree_path.display()));
    }

    Ok(worktree_path)
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
    if !is_git_repository(&root) {
        return Err(format!("Not a Git repository: {root_path}"));
    }
    run_git_cmd(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
}

#[tauri::command]
pub fn floor_create(
    root_path: String,
    name: String,
    branch_name: String,
    hooks: Option<FloorHooks>,
) -> Result<FloorInfo, String> {
    let root = PathBuf::from(&root_path);
    let worktree_pathbuf = get_confined_worktree_path(&root, &name)?;
    let worktree_path_str = worktree_pathbuf.to_string_lossy().to_string();

    let floors_dir = worktree_pathbuf.parent().unwrap();
    if let Err(e) = fs::create_dir_all(floors_dir) {
        return Err(format!("Failed to create floors container directory: {e}"));
    }

    let branch = branch_name.trim();
    if branch.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

    let branch_exists = check_branch_exists(&root, branch);
    if branch_exists {
        run_git_cmd(&root, &["worktree", "add", &worktree_path_str, branch])?;
    } else {
        run_git_cmd(&root, &["worktree", "add", "-b", branch, &worktree_path_str])?;
    }

    let resolved_hooks = hooks.unwrap_or_default();
    let created_at = chrono::Utc::now().to_rfc3339();

    let floor_info = FloorInfo {
        name: name.trim().to_string(),
        branch_name: branch.to_string(),
        worktree_path: worktree_path_str,
        hooks: resolved_hooks,
        created_at,
    };

    if floor_info.hooks.auto_run_setup && !floor_info.hooks.setup.is_empty() {
        floor_run_hooks(
            root_path,
            floor_info.clone(),
            "setup".to_string(),
        )?;
    }

    Ok(floor_info)
}

#[tauri::command]
pub fn floor_remove(
    root_path: String,
    floor: FloorInfo,
    delete_branch: bool,
) -> Result<(), String> {
    let root = PathBuf::from(&root_path);
    let worktree_pathbuf = get_confined_worktree_path(&root, &floor.name)?;
    let worktree_path_str = worktree_pathbuf.to_string_lossy().to_string();

    if !floor.hooks.teardown.is_empty() {
        let _ = floor_run_hooks(root_path.clone(), floor.clone(), "teardown".to_string());
    }

    run_git_cmd(&root, &["worktree", "remove", "--force", &worktree_path_str])?;

    if delete_branch && !floor.branch_name.trim().is_empty() {
        let _ = run_git_cmd(&root, &["branch", "-D", &floor.branch_name]);
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
    let worktree_path = PathBuf::from(&floor.worktree_path);

    if !worktree_path.exists() {
        return Err(format!("Floor worktree directory does not exist: {}", floor.worktree_path));
    }

    let project_name = root
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
            .current_dir(&worktree_path)
            .env("OMAESTRI_FLOOR_NAME", &floor.name)
            .env("OMAESTRI_BRANCH_NAME", &floor.branch_name)
            .env("OMAESTRI_FLOOR_PATH", &floor.worktree_path)
            .env("OMAESTRI_ROOT_PATH", &root_path)
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
    let floor_wt = PathBuf::from(&floor.worktree_path);

    if !is_worktree_clean(&floor_wt)? {
        return Err(format!("Floor '{}' has uncommitted changes. Clean working tree required before landing.", floor.name));
    }
    if !is_worktree_clean(&root)? {
        return Err("Ground workspace root has uncommitted changes. Clean working tree required before landing.".to_string());
    }

    let current_ground_branch = floor_current_branch(root_path.clone())?;
    if current_ground_branch != target_branch {
        return Err(format!(
            "Target branch '{}' does not match currently checked out Ground branch '{}'. Switch Ground branch first.",
            target_branch, current_ground_branch
        ));
    }

    let diff_stat = run_git_cmd(&root, &["diff", "--stat", &format!("{}..{}", target_branch, floor.branch_name)])
        .unwrap_or_else(|_| "No diff stat available".to_string());

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
    let floor_wt = PathBuf::from(&floor.worktree_path);

    if !is_worktree_clean(&floor_wt)? {
        return Err(format!("Floor '{}' has uncommitted changes. Clean working tree required before landing.", floor.name));
    }
    if !is_worktree_clean(&root)? {
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
    run_git_cmd(&root, &["merge", &floor.branch_name, "--no-ff", "-m", &merge_msg])?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn init_temp_git_repo() -> (TempDir, PathBuf) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let repo_path = temp_dir.path().to_path_buf();

        run_git_cmd(&repo_path, &["init", "-b", "main"]).unwrap_or_else(|_| {
            run_git_cmd(&repo_path, &["init"]).expect("Failed to init git repo");
            run_git_cmd(&repo_path, &["checkout", "-b", "main"]).expect("Failed to set main branch");
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
    fn test_floor_create_new_branch_real_git() {
        let (_guard, root_path) = init_temp_git_repo();
        let root_str = root_path.to_string_lossy().to_string();

        let current = floor_current_branch(root_str.clone()).unwrap();
        assert_eq!(current, "main");

        let floor = floor_create(
            root_str.clone(),
            "feature-floor-1".to_string(),
            "feat/new-feature".to_string(),
            None,
        )
        .expect("Failed to create floor with new branch");

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

        floor_land(root_str.clone(), floor.clone(), "main".to_string())
            .expect("Failed to land floor");

        let main_file = root_path.join("feature.txt");
        assert!(main_file.exists());
        assert_eq!(fs::read_to_string(main_file).unwrap(), "New feature work\n");

        assert!(floor_land(root_str.clone(), floor.clone(), "other-target").is_err());

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
            auto_run_setup: true,
        };

        let floor = floor_create(
            root_str.clone(),
            "hook-floor".to_string(),
            "feat/hook-test".to_string(),
            Some(hooks),
        )
        .expect("Failed to create floor with hooks");

        assert!(out_file.exists());
        let env_content = fs::read_to_string(&out_file).unwrap();
        assert!(env_content.contains("hook-floor"));
        assert!(env_content.contains("feat/hook-test"));

        floor_run_hooks(root_str.clone(), floor.clone(), "run".to_string()).expect("Run hooks failed");

        let teardown_res = floor_run_hooks(root_str.clone(), floor, "teardown".to_string());
        assert!(teardown_res.is_err());
    }
}
