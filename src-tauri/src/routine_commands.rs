//! Tauri IPC commands for scheduled routines.

use crate::routine_runtime::RoutineRuntime;
use crate::routines::Routine;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOperationResult {
    pub success: bool,
    pub routine_id: Option<String>,
    pub message: Option<String>,
}

use crate::scrollback::ScrollbackStore;
use crate::terminal::TerminalRegistry;

#[tauri::command]
pub fn routine_set_workspace(
    runtime: State<'_, Arc<RoutineRuntime>>,
    registry: State<'_, TerminalRegistry>,
    workspace_path: Option<String>,
) -> Result<usize, String> {
    let path = workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    // 1. Prepare and validate new ScrollbackStore BEFORE switching if path is provided
    let new_store = match path.as_deref() {
        Some(p) => {
            let base_dir = if p.is_file()
                || p.file_name().and_then(|n| n.to_str()) == Some("workspace.json")
            {
                p.parent().unwrap_or(p)
            } else {
                p
            };

            let canonical_root = base_dir
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize workspace path: {e}"))?;

            let store = ScrollbackStore::new(&canonical_root, None)?;
            Some(Arc::new(store))
        }
        None => None,
    };

    // 2. Perform routine workspace switch (saves previous routines safely)
    let count = runtime.set_workspace(path.as_deref())?;

    // 3. Publish new ScrollbackStore ONLY after routine switch succeeds
    registry.set_scrollback_store(new_store);

    Ok(count)
}

#[tauri::command]
pub fn routine_list(runtime: State<'_, Arc<RoutineRuntime>>) -> Result<Vec<Routine>, String> {
    Ok(runtime.list_routines())
}

#[tauri::command]
pub fn routine_upsert(
    runtime: State<'_, Arc<RoutineRuntime>>,
    routine: Routine,
) -> Result<RoutineOperationResult, String> {
    let id = routine.id.clone();
    runtime.upsert_routine(routine)?;
    Ok(RoutineOperationResult {
        success: true,
        routine_id: Some(id),
        message: None,
    })
}

#[tauri::command]
pub fn routine_remove(runtime: State<'_, Arc<RoutineRuntime>>, id: String) -> Result<bool, String> {
    runtime.remove_routine(&id)
}

#[tauri::command]
pub fn routine_set_enabled(
    runtime: State<'_, Arc<RoutineRuntime>>,
    id: String,
    enabled: bool,
) -> Result<bool, String> {
    runtime.set_enabled(&id, enabled)
}

#[tauri::command]
pub fn routine_run_now(
    runtime: State<'_, Arc<RoutineRuntime>>,
    id: String,
) -> Result<bool, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let dispatched = runtime.execute_routine_id(&id, now_ms, true);
    Ok(dispatched)
}
