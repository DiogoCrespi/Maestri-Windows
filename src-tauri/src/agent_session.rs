//! Workspace-scoped agent conversation persistence.
//!
//! Provider session identifiers are captured by `omaestri.exe` from the
//! environment of the running agent and stored per terminal UUID. Keeping this
//! metadata outside terminal scrollback avoids treating rendered text as model
//! context and prevents two same-named agents from resuming each other's chat.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

use crate::scrollback::validate_no_reparse_or_symlink;

const STORE_VERSION: u32 = 1;
const STORE_FILE_NAME: &str = "agent-sessions.json";
const MAX_STORE_BYTES: usize = 1024 * 1024;
const MAX_AGENT_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_TERMINAL_ID_LEN: usize = 128;
const MAX_SESSION_ID_LEN: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub provider: String,
    pub session_id: String,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLaunchContext {
    pub session: Option<AgentSession>,
    pub agent_log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionDocument {
    version: u32,
    sessions: BTreeMap<String, AgentSession>,
}

impl Default for AgentSessionDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Default)]
pub struct AgentSessionRegistry {
    lock: Arc<Mutex<()>>,
}

impl AgentSessionRegistry {
    pub fn get(
        &self,
        workspace_path: &str,
        terminal_id: &str,
    ) -> Result<Option<AgentSession>, String> {
        validate_terminal_id(terminal_id)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "agent session registry lock is unavailable".to_string())?;
        let store_path = resolve_store_path(workspace_path, false)?;
        let document = read_document(&store_path)?;
        Ok(document.sessions.get(terminal_id).cloned())
    }

    pub fn register(
        &self,
        workspace_path: &str,
        terminal_id: &str,
        provider: &str,
        session_id: &str,
    ) -> Result<AgentSession, String> {
        validate_terminal_id(terminal_id)?;
        let provider = normalize_provider(provider)?;
        let session_id = validate_session_id(session_id)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "agent session registry lock is unavailable".to_string())?;
        let store_path = resolve_store_path(workspace_path, true)?;
        let mut document = read_document(&store_path)?;
        let session = AgentSession {
            provider,
            session_id,
            captured_at: timestamp_string(),
        };
        document
            .sessions
            .insert(terminal_id.to_owned(), session.clone());
        write_document(&store_path, &document)?;
        Ok(session)
    }

    pub fn launch_context(
        &self,
        workspace_path: &str,
        terminal_id: &str,
        provider: &str,
    ) -> Result<AgentSessionLaunchContext, String> {
        validate_terminal_id(terminal_id)?;
        let provider = normalize_provider(provider)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "agent session registry lock is unavailable".to_string())?;
        let store_path = resolve_store_path(workspace_path, true)?;
        let mut document = read_document(&store_path)?;

        let agent_log_path = if provider == "antGravity" {
            Some(resolve_agent_log_path(&store_path, terminal_id)?)
        } else {
            None
        };

        if let Some(log_path) = agent_log_path.as_ref() {
            if let Some(session_id) = recover_antigravity_session(log_path)? {
                let recovered = AgentSession {
                    provider: provider.clone(),
                    session_id,
                    captured_at: timestamp_string(),
                };
                let changed = document.sessions.get(terminal_id).is_none_or(|current| {
                    current.provider != recovered.provider
                        || current.session_id != recovered.session_id
                });
                if changed {
                    document.sessions.insert(terminal_id.to_owned(), recovered);
                    write_document(&store_path, &document)?;
                }
            }
        }

        let session = document
            .sessions
            .get(terminal_id)
            .filter(|session| session.provider == provider)
            .cloned();
        Ok(AgentSessionLaunchContext {
            session,
            agent_log_path: agent_log_path.map(|path| path.to_string_lossy().into_owned()),
        })
    }
}

#[tauri::command]
pub fn agent_session_get(
    registry: tauri::State<'_, AgentSessionRegistry>,
    workspace_path: String,
    id: String,
) -> Result<Option<AgentSession>, String> {
    registry.get(&workspace_path, &id)
}

#[tauri::command]
pub fn agent_session_launch_context(
    registry: tauri::State<'_, AgentSessionRegistry>,
    workspace_path: String,
    id: String,
    provider: String,
) -> Result<AgentSessionLaunchContext, String> {
    registry.launch_context(&workspace_path, &id, &provider)
}

fn resolve_agent_log_path(store_path: &Path, terminal_id: &str) -> Result<PathBuf, String> {
    let maestri_dir = store_path
        .parent()
        .ok_or_else(|| "agent session store has no parent directory".to_string())?;
    let log_dir = maestri_dir.join("agent-logs");
    if !log_dir.exists() {
        fs::create_dir(&log_dir)
            .map_err(|error| format!("cannot create agent log directory: {error}"))?;
    }
    validate_no_reparse_or_symlink(&log_dir)?;
    let log_path = log_dir.join(format!("{terminal_id}.log"));
    if log_path.exists() {
        validate_no_reparse_or_symlink(&log_path)?;
    }
    Ok(log_path)
}

fn recover_antigravity_session(log_path: &Path) -> Result<Option<String>, String> {
    if !log_path.exists() {
        return Ok(None);
    }
    let mut file = File::open(log_path)
        .map_err(|error| format!("cannot open Antigravity agent log: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("cannot inspect Antigravity agent log: {error}"))?
        .len();
    let start = length.saturating_sub(MAX_AGENT_LOG_BYTES as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("cannot seek Antigravity agent log: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_AGENT_LOG_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read Antigravity agent log: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    const MARKERS: [&str; 5] = [
        "Created conversation ",
        "Resuming conversation ",
        "Streaming conversation ",
        "Forwarding user message to conversation ",
        "GetConversationDetail: found conversation ",
    ];
    for line in text.lines().rev() {
        for marker in MARKERS {
            let Some((_, suffix)) = line.rsplit_once(marker) else {
                continue;
            };
            let candidate = suffix
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '-'
                });
            if validate_session_id(candidate).is_ok() {
                return Ok(Some(candidate.to_string()));
            }
        }
    }
    Ok(None)
}

fn resolve_store_path(workspace_path: &str, create: bool) -> Result<PathBuf, String> {
    if workspace_path.trim().is_empty() || workspace_path.chars().any(char::is_control) {
        return Err("workspace path is invalid".to_string());
    }
    let supplied = PathBuf::from(workspace_path.trim());
    if !supplied.is_absolute() {
        return Err("workspace path must be absolute".to_string());
    }
    let root = if supplied.is_file()
        || supplied.file_name().and_then(|name| name.to_str()) == Some("workspace.json")
    {
        supplied
            .parent()
            .ok_or_else(|| "workspace path has no parent directory".to_string())?
            .to_path_buf()
    } else {
        supplied
    };
    if !root.is_dir() {
        return Err(format!(
            "workspace directory does not exist: {}",
            root.display()
        ));
    }
    validate_no_reparse_or_symlink(&root)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("cannot canonicalize workspace directory: {error}"))?;
    let maestri_dir = canonical_root.join(".maestri");
    if !maestri_dir.exists() {
        if !create {
            return Ok(maestri_dir.join(STORE_FILE_NAME));
        }
        fs::create_dir(&maestri_dir)
            .map_err(|error| format!("cannot create .maestri directory: {error}"))?;
    }
    validate_no_reparse_or_symlink(&maestri_dir)?;
    let store_path = maestri_dir.join(STORE_FILE_NAME);
    if store_path.exists() {
        validate_no_reparse_or_symlink(&store_path)?;
    }
    Ok(store_path)
}

fn read_document(path: &Path) -> Result<AgentSessionDocument, String> {
    if !path.exists() {
        return Ok(AgentSessionDocument::default());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot inspect agent session store: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES as u64 {
        return Err("agent session store is invalid or too large".to_string());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| format!("cannot open agent session store: {error}"))?
        .take((MAX_STORE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read agent session store: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("agent session store exceeds size limit".to_string());
    }
    let document: AgentSessionDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("agent session store JSON is invalid: {error}"))?;
    if document.version != STORE_VERSION {
        return Err(format!(
            "unsupported agent session store version {}",
            document.version
        ));
    }
    Ok(document)
}

fn write_document(path: &Path, document: &AgentSessionDocument) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("cannot serialize agent session store: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("agent session store exceeds size limit".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "agent session store has no parent directory".to_string())?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| format!("cannot create temporary agent session store: {error}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.flush())
        .map_err(|error| format!("cannot write temporary agent session store: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("cannot replace agent session store atomically: {error}"))?;
    Ok(())
}

fn validate_terminal_id(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_TERMINAL_ID_LEN
        || value.contains("..")
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("terminal ID is invalid".to_string());
    }
    Ok(())
}

fn normalize_provider(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "codex" => Ok("codex".to_string()),
        "antgravity" | "ant_gravity" => Ok("antGravity".to_string()),
        "claude" | "claudecode" | "claude_code" => Ok("claudeCode".to_string()),
        _ => Err("unsupported agent session provider".to_string()),
    }
}

fn validate_session_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_SESSION_ID_LEN
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err("agent session ID is invalid".to_string());
    }
    Ok(value.to_string())
}

fn timestamp_string() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_sessions_per_terminal_without_name_based_collisions() {
        let workspace = tempfile::tempdir().unwrap();
        let registry = AgentSessionRegistry::default();
        registry
            .register(
                workspace.path().to_str().unwrap(),
                "terminal-a",
                "codex",
                "11111111-1111-1111-1111-111111111111",
            )
            .unwrap();
        registry
            .register(
                workspace.path().to_str().unwrap(),
                "terminal-b",
                "antGravity",
                "22222222-2222-2222-2222-222222222222",
            )
            .unwrap();

        assert_eq!(
            registry
                .get(workspace.path().to_str().unwrap(), "terminal-a")
                .unwrap()
                .unwrap()
                .provider,
            "codex"
        );
        assert_eq!(
            registry
                .get(workspace.path().to_str().unwrap(), "terminal-b")
                .unwrap()
                .unwrap()
                .session_id,
            "22222222-2222-2222-2222-222222222222"
        );
    }

    #[test]
    fn rejects_untrusted_identifiers_and_relative_workspaces() {
        let registry = AgentSessionRegistry::default();
        assert!(registry
            .register("relative", "terminal-a", "codex", "session-1")
            .is_err());
        let workspace = tempfile::tempdir().unwrap();
        assert!(registry
            .register(
                workspace.path().to_str().unwrap(),
                "../terminal",
                "codex",
                "session-1"
            )
            .is_err());
        assert!(registry
            .register(
                workspace.path().to_str().unwrap(),
                "terminal-a",
                "codex",
                "bad session;id"
            )
            .is_err());
    }

    #[test]
    fn recovers_the_latest_antigravity_conversation_from_a_terminal_log() {
        let workspace = tempfile::tempdir().unwrap();
        let registry = AgentSessionRegistry::default();
        let initial = registry
            .launch_context(
                workspace.path().to_str().unwrap(),
                "terminal-a",
                "antGravity",
            )
            .unwrap();
        assert!(initial.session.is_none());
        let log_path = initial.agent_log_path.unwrap();
        fs::write(
            &log_path,
            "Created conversation 11111111-1111-1111-1111-111111111111\nForwarding user message to conversation 22222222-2222-2222-2222-222222222222 (items=1)\n",
        )
        .unwrap();

        let recovered = registry
            .launch_context(
                workspace.path().to_str().unwrap(),
                "terminal-a",
                "antGravity",
            )
            .unwrap()
            .session
            .unwrap();
        assert_eq!(recovered.session_id, "22222222-2222-2222-2222-222222222222");
    }
}
