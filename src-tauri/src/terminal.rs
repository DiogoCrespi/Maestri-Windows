//! Tauri 2 terminal backend for Windows.
//!
//! The module deliberately owns no UI state. A terminal is a portable-pty
//! session, its reader and waiter run on dedicated threads, and all public
//! operations go through the thread-safe registry below.

use std::collections::{HashMap, VecDeque};
use std::ffi::{c_void, OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

const DEFAULT_SHELL: &str = "powershell.exe";
const MAX_ID_BYTES: usize = 256;
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_COLS: u16 = 1_000;
const MAX_ROWS: u16 = 500;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_SCROLLBACK_CHUNKS: usize = 512;

static SESSION_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);
const IPC_CREDENTIAL_BYTES: usize = 32;

#[cfg(windows)]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub session_token: u64,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    pub data: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalExitedEvent {
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum Lifecycle {
    Running,
    Stopping,
    Exited,
}

impl Lifecycle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Exited => "exited",
        }
    }
}

use crate::scrollback::ScrollbackStore;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};

pub const SCROLLBACK_QUEUE_CAPACITY: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackLoadPayload {
    pub data: String,
    pub scrollback_file: Option<String>,
    pub scrollback_line_count: usize,
}

enum ScrollbackWorkItem {
    Append {
        store: Arc<ScrollbackStore>,
        generation: u64,
        data: String,
    },
    Stop(mpsc::Sender<()>),
}

/// Dedicated async non-blocking worker queue for scrollback I/O.
struct ScrollbackWorker {
    sender: SyncSender<ScrollbackWorkItem>,
    handle: Option<thread::JoinHandle<()>>,
    stopped: bool,
}

impl ScrollbackWorker {
    fn spawn(terminal_id: String) -> Self {
        let (sender, receiver): (SyncSender<ScrollbackWorkItem>, Receiver<ScrollbackWorkItem>) =
            mpsc::sync_channel(SCROLLBACK_QUEUE_CAPACITY);
        let handle = thread::Builder::new()
            .name(format!("scrollback-writer-{terminal_id}"))
            .spawn(move || {
                while let Ok(item) = receiver.recv() {
                    match item {
                        ScrollbackWorkItem::Append {
                            store,
                            generation,
                            data,
                        } => {
                            if store.generation() == generation {
                                let _ = store.append(&terminal_id, &data);
                            }
                        }
                        ScrollbackWorkItem::Stop(ack) => {
                            let _ = ack.send(());
                            break;
                        }
                    }
                }
            })
            .ok();

        Self {
            sender,
            handle,
            stopped: false,
        }
    }

    /// Non-blocking try_send enqueue. If full, drops chunk safely without blocking ConPTY reader thread.
    fn try_enqueue(&self, store: Arc<ScrollbackStore>, generation: u64, data: String) -> bool {
        if self.stopped {
            return false;
        }
        match self.sender.try_send(ScrollbackWorkItem::Append {
            store,
            generation,
            data,
        }) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
        }
    }

    /// Idempotent flush & join worker thread.
    fn stop_and_join(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;

        let (ack_tx, ack_rx) = mpsc::channel();
        // Shutdown is allowed to wait for queue capacity. Using `try_send`
        // here could leave the worker alive forever when the bounded queue is
        // full, because `join` would then wait on a receiver that never gets a
        // Stop item while this struct still owns a sender.
        if self.sender.send(ScrollbackWorkItem::Stop(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(std::time::Duration::from_millis(1000));
        }

        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub(crate) struct TerminalSession {
    id: String,
    session_token: u64,
    ipc_credential: String,
    pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    state: Mutex<Lifecycle>,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    stop_requested: AtomicBool,
    exit_emitted: AtomicBool,
    sequence: AtomicU64,
    recent_output: Mutex<VecDeque<String>>,
    scrollback_worker: Mutex<ScrollbackWorker>,
    registry_store: Arc<RwLock<Option<Arc<ScrollbackStore>>>>,
    is_remote: bool,
}

impl TerminalSession {
    fn info(&self) -> Result<TerminalInfo, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "terminal state lock poisoned".to_string())?;
        let cols = *self
            .cols
            .lock()
            .map_err(|_| "terminal size lock poisoned".to_string())?;
        let rows = *self
            .rows
            .lock()
            .map_err(|_| "terminal size lock poisoned".to_string())?;

        Ok(TerminalInfo {
            id: self.id.clone(),
            session_token: self.session_token,
            pid: self.pid,
            cols,
            rows,
            state: state.as_str().to_string(),
        })
    }

    fn write_input(&self, data: &str) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        if data.len() > MAX_INPUT_BYTES {
            return Err(format!("terminal input exceeds {MAX_INPUT_BYTES} bytes"));
        }

        let state = self
            .state
            .lock()
            .map_err(|_| "terminal state lock poisoned".to_string())?;
        if !matches!(*state, Lifecycle::Running) {
            return Err("terminal is not running".to_string());
        }
        drop(state);

        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "terminal writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("terminal write failed: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("terminal flush failed: {error}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;

        let state = self
            .state
            .lock()
            .map_err(|_| "terminal state lock poisoned".to_string())?;
        if !matches!(*state, Lifecycle::Running) {
            return Err("terminal is not running".to_string());
        }
        drop(state);

        let master = self
            .master
            .lock()
            .map_err(|_| "terminal master lock poisoned".to_string())?;
        master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("terminal resize failed: {error}"))?;
        drop(master);

        *self
            .cols
            .lock()
            .map_err(|_| "terminal size lock poisoned".to_string())? = cols;
        *self
            .rows
            .lock()
            .map_err(|_| "terminal size lock poisoned".to_string())? = rows;
        Ok(())
    }

    fn request_stop(&self) -> Result<(), String> {
        if self.stop_requested.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        if let Ok(mut state) = self.state.lock() {
            if !matches!(*state, Lifecycle::Exited) {
                *state = Lifecycle::Stopping;
            }
        }

        if let Ok(mut worker) = self.scrollback_worker.lock() {
            worker.stop_and_join();
        }

        let mut remote_tree_err = None;
        if self.is_remote {
            if let Some(pid) = self.pid {
                if let Err(e) = crate::remote_terminal_contract::kill_process_tree_windows(pid) {
                    remote_tree_err = Some(e);
                }
            }
        }

        let mut killer = self
            .killer
            .lock()
            .map_err(|_| "terminal killer lock poisoned".to_string())?;
        let kill_res = killer
            .kill()
            .map_err(|error| format!("terminal stop failed: {error}"));

        match (remote_tree_err, kill_res) {
            (Some(tree_err), Ok(())) => Err(format!("process tree cleanup error: {tree_err}")),
            (Some(tree_err), Err(kill_err)) => Err(format!("process tree cleanup error: {tree_err}; kill error: {kill_err}")),
            (None, Err(kill_err)) => Err(kill_err),
            (None, Ok(())) => Ok(()),
        }
    }

    fn transition_exited(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = Lifecycle::Exited;
        }
    }
}

/// Tauri-managed registry. The inner lock is the only mutable
/// collection shared by command calls and process lifecycle threads.
#[derive(Clone, Default)]
pub struct TerminalRegistry {
    sessions: Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
    scrollback_store: Arc<RwLock<Option<Arc<ScrollbackStore>>>>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_scrollback_store(&self, store: Option<Arc<ScrollbackStore>>) {
        if let Ok(mut lock) = self.scrollback_store.write() {
            *lock = store;
        }
    }

    pub fn get_scrollback_store(&self) -> Option<Arc<ScrollbackStore>> {
        self.scrollback_store.read().ok()?.clone()
    }

    fn insert(&self, session: Arc<TerminalSession>) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| "terminal registry lock poisoned".to_string())?;
        if sessions.contains_key(&session.id) {
            return Err(format!("terminal '{}' already exists", session.id));
        }
        sessions.insert(session.id.clone(), session);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Arc<TerminalSession>, String> {
        let sessions = self
            .sessions
            .read()
            .map_err(|_| "terminal registry lock poisoned".to_string())?;
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal '{id}' not found"))
    }

    fn remove(&self, id: &str) -> Result<Option<Arc<TerminalSession>>, String> {
        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| "terminal registry lock poisoned".to_string())?;
        Ok(sessions.remove(id))
    }

    /// Removes a session only if its `session_token` matches the stored session.
    fn remove_exact(&self, id: &str, token: u64) -> Result<bool, String> {
        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| "terminal registry lock poisoned".to_string())?;
        if let Some(session) = sessions.get(id) {
            if session.session_token == token {
                sessions.remove(id);
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn list(&self) -> Result<Vec<TerminalInfo>, String> {
        let sessions = self
            .sessions
            .read()
            .map_err(|_| "terminal registry lock poisoned".to_string())?;
        sessions.values().map(|session| session.info()).collect()
    }

    pub fn stop_all(&self) {
        let sessions = match self.sessions.read() {
            Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            let token = session.session_token;
            let _ = session.request_stop();
            let _ = self.remove_exact(&session.id, token);
        }
    }

    pub fn stop_remote_all(&self) {
        let sessions = match self.sessions.read() {
            Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            if session.is_remote {
                let token = session.session_token;
                let _ = session.request_stop();
                let _ = self.remove_exact(&session.id, token);
            }
        }
    }

    pub fn write_to(&self, id: &str, data: &str) -> Result<(), String> {
        validate_id(id)?;
        self.get(id)?.write_input(data)
    }

    pub fn recent_output(&self, id: &str) -> Result<String, String> {
        let session = self.get(id)?;
        let chunks = session
            .recent_output
            .lock()
            .map_err(|_| "terminal output lock poisoned".to_string())?;
        Ok(chunks.iter().cloned().collect())
    }

    /// Atomically validates the terminal identity and its per-ConPTY secret.
    /// The same read lock covers lookup, lifecycle state, and credential
    /// comparison, so a removed/restarted session cannot authenticate with a
    /// stale credential.
    pub fn validate_ipc_credentials(&self, id: &str, credential: &str) -> Result<(), String> {
        validate_id(id)?;
        if credential.trim().is_empty() {
            return Err("error: invalid terminal credentials".to_string());
        }
        let sessions = self
            .sessions
            .read()
            .map_err(|_| "terminal registry lock poisoned".to_string())?;
        let session = sessions
            .get(id)
            .ok_or_else(|| "error: invalid terminal credentials".to_string())?;
        let state = session
            .state
            .lock()
            .map_err(|_| "terminal state lock poisoned".to_string())?;
        if !matches!(*state, Lifecycle::Running)
            || !constant_time_eq(session.ipc_credential.as_bytes(), credential.as_bytes())
        {
            return Err("error: invalid terminal credentials".to_string());
        }
        Ok(())
    }
}

impl Drop for TerminalRegistry {
    fn drop(&mut self) {
        // Only the final registry clone should initiate application shutdown.
        if Arc::strong_count(&self.sessions) == 1 {
            self.stop_all();
        }
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("terminal id must not be empty".to_string());
    }
    if id.len() > MAX_ID_BYTES {
        return Err(format!("terminal id exceeds {MAX_ID_BYTES} bytes"));
    }
    if id.chars().any(char::is_control) {
        return Err("terminal id must not contain control characters".to_string());
    }
    Ok(())
}

fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || cols > MAX_COLS {
        return Err(format!("cols must be between 1 and {MAX_COLS}"));
    }
    if rows == 0 || rows > MAX_ROWS {
        return Err(format!("rows must be between 1 and {MAX_ROWS}"));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = (left.len() ^ right.len()) as u64;
    for index in 0..left.len().max(right.len()) {
        difference |= u64::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn generate_ipc_credential() -> Result<String, String> {
    let mut bytes = [0u8; IPC_CREDENTIAL_BYTES];

    #[cfg(windows)]
    {
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(format!(
                "cannot generate terminal credential (NTSTATUS 0x{status:08x})"
            ));
        }
    }

    #[cfg(not(windows))]
    {
        return Err("per-session terminal credentials require Windows CNG".to_string());
    }

    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn resolve_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let path = match cwd {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => std::env::current_dir()
            .map_err(|error| format!("cannot resolve current directory: {error}"))?,
    };
    if !path.is_dir() {
        return Err(format!(
            "working directory is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MaestriEnvironment {
    terminal_id: String,
    socket: Option<String>,
    token: Option<String>,
}

impl MaestriEnvironment {
    fn from_process(terminal_id: &str, ipc_credential: &str) -> Self {
        Self::from_lookup(terminal_id, ipc_credential, |key| std::env::var(key).ok())
    }

    fn from_lookup<F>(terminal_id: &str, ipc_credential: &str, mut lookup: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let non_empty = |value: Option<String>| value.filter(|value| !value.trim().is_empty());
        Self {
            terminal_id: terminal_id.to_owned(),
            socket: non_empty(lookup("MAESTRI_SOCKET")),
            token: Some(ipc_credential.to_owned()),
        }
    }

    fn apply_to(&self, command: &mut CommandBuilder) {
        command.env("MAESTRI_TERMINAL_ID", &self.terminal_id);
        if let Some(socket) = &self.socket {
            command.env("MAESTRI_SOCKET", socket);
        }
        if let Some(token) = &self.token {
            command.env("MAESTRI_TOKEN", token);
        }
    }
}

fn is_protected_env_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_uppercase();
    normalized == "PATH"
        || normalized == "TERM"
        || normalized == "COLORTERM"
        || normalized.starts_with("MAESTRI_")
}

fn has_explicit_command_mode(args: &[String], basename: Option<&str>) -> bool {
    args.iter().any(|arg| {
        let normalized = arg.to_ascii_lowercase();
        match basename {
            Some("cmd.exe") | Some("cmd") => matches!(normalized.as_str(), "/c" | "/k"),
            Some("powershell.exe") | Some("powershell") | Some("pwsh.exe") | Some("pwsh") => {
                matches!(
                    normalized.as_str(),
                    "-command" | "-c" | "-encodedcommand" | "-e" | "-ec"
                )
            }
            Some("bash") | Some("zsh") | Some("sh") => {
                matches!(normalized.as_str(), "-c" | "--command")
            }
            Some("wsl.exe") | Some("wsl") => {
                matches!(normalized.as_str(), "-c" | "-e" | "--exec")
            }
            _ => false,
        }
    })
}

fn build_command(
    shell: Option<String>,
    args: Option<Vec<String>>,
    custom_env: Option<HashMap<String, String>>,
    initial_command: Option<String>,
    cwd: &PathBuf,
    id: &str,
    ipc_credential: &str,
) -> Result<CommandBuilder, String> {
    let raw_shell = match shell {
        Some(value) => value.replace('\0', "").trim().to_owned(),
        None => String::new(),
    };

    let mut parsed_args = args.unwrap_or_default();
    let mut executable = if raw_shell.is_empty() {
        DEFAULT_SHELL.to_string()
    } else {
        raw_shell
    };

    // If shell contains spaces (e.g. "powershell.exe -NoLogo -NoProfile"), separate executable from default args
    if executable.contains(' ') || executable.contains('\t') {
        let parts: Vec<String> = executable
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        if !parts.is_empty() {
            executable = parts[0].clone();
            let mut new_args = parts[1..].to_vec();
            new_args.extend(parsed_args);
            parsed_args = new_args;
        }
    }

    if executable.chars().any(char::is_control) {
        return Err("shell path must not contain control characters".to_string());
    }

    let mut command = CommandBuilder::new(executable.clone());
    command.cwd(cwd);

    // Apply custom user env FIRST (ignoring protected variables)
    if let Some(user_env) = custom_env {
        for (key, value) in user_env {
            if is_protected_env_key(&key) {
                continue; // Protected from user overwrite
            }
            if key.chars().any(char::is_control) || value.chars().any(char::is_control) {
                continue;
            }
            command.env(key, value);
        }
    }

    // Always enforce protected MAESTRI_* variables and TERM
    MaestriEnvironment::from_process(id, ipc_credential).apply_to(&mut command);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    // Discover omaestri.exe and prepend to PATH + export MAESTRI_CLI path
    let current_exe = std::env::current_exe().ok();
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(cli_dir) =
        discover_omaestri_dir(current_exe.as_deref(), manifest_dir, |candidate| {
            candidate.is_file()
        })
    {
        if let Some(child_path) = prepend_path_entry(&cli_dir, std::env::var_os("PATH").as_deref())
        {
            command.env("PATH", child_path);
        }
        let exe_name = if cli_dir.join("maestri.exe").is_file() { "maestri.exe" } else { "omaestri.exe" };
        let full_cli_path = cli_dir.join(exe_name);
        command.env("MAESTRI_CLI", full_cli_path.to_string_lossy().as_ref());
    }

    let basename = PathBuf::from(&executable)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase());

    let explicit_command_mode = has_explicit_command_mode(&parsed_args, basename.as_deref());

    // If explicit args are provided, pass them directly. Otherwise, apply default flags.
    if !parsed_args.is_empty() {
        for arg in parsed_args {
            let clean_arg = arg.replace('\0', "");
            if clean_arg.chars().any(char::is_control) {
                return Err("command arguments must not contain control characters".to_string());
            }
            command.arg(clean_arg);
        }
    } else {
        match basename.as_deref() {
            Some("cmd.exe") | Some("cmd") => {
                command.arg("/Q");
            }
            Some("powershell.exe") | Some("powershell") | Some("pwsh.exe") | Some("pwsh") => {
                command.arg("-NoLogo");
                command.arg("-NoProfile");
            }
            _ => {}
        }
    }

    // If explicit args already select a command mode, they are authoritative.
    // Do not append another -Command/-c//K and accidentally execute twice.
    if !explicit_command_mode {
        if let Some(cmd_str) = initial_command {
            if !cmd_str.trim().is_empty() {
                if cmd_str.chars().any(char::is_control) {
                    return Err("initial command must not contain control characters".to_string());
                }
                match basename.as_deref() {
                    Some("cmd.exe") | Some("cmd") => {
                        command.arg("/K");
                        command.arg(cmd_str);
                    }
                    Some("powershell.exe")
                    | Some("powershell")
                    | Some("pwsh.exe")
                    | Some("pwsh") => {
                        command.arg("-NoExit");
                        command.arg("-Command");
                        command.arg(cmd_str);
                    }
                    Some("bash") | Some("zsh") | Some("sh") | Some("wsl.exe") | Some("wsl") => {
                        command.arg("-i");
                        command.arg("-c");
                        command.arg(format!("{cmd_str}; exec \"$0\" -i"));
                    }
                    _ => {
                        command.arg(cmd_str);
                    }
                }
            }
        }
    }

    Ok(command)
}

fn omaestri_candidates(current_exe: Option<&Path>, manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(app_dir) = current_exe.and_then(Path::parent) {
        candidates.push(app_dir.join("omaestri.exe"));
        candidates.push(app_dir.join("maestri.exe"));
    }

    let cli_target = manifest_dir.join("..").join("src-cli").join("target");
    candidates.push(cli_target.join("release").join("omaestri.exe"));
    candidates.push(cli_target.join("debug").join("omaestri.exe"));
    candidates.push(cli_target.join("release").join("maestri.exe"));
    candidates.push(cli_target.join("debug").join("maestri.exe"));

    // System-wide install candidates (e.g. %LOCALAPPDATA%\Programs\Maestri or Cargo bin)
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(user_profile);
        candidates.push(home.join(".cargo").join("bin").join("maestri.exe"));
        candidates.push(home.join(".cargo").join("bin").join("omaestri.exe"));
        candidates.push(home.join("AppData").join("Local").join("Programs").join("Maestri").join("maestri.exe"));
        candidates.push(home.join("AppData").join("Local").join("Programs").join("Maestri").join("omaestri.exe"));
    }
    candidates
}

fn discover_omaestri_dir<F>(
    current_exe: Option<&Path>,
    manifest_dir: &Path,
    mut is_file: F,
) -> Option<PathBuf>
where
    F: FnMut(&Path) -> bool,
{
    omaestri_candidates(current_exe, manifest_dir)
        .into_iter()
        .find(|candidate| is_file(candidate))
        .and_then(|candidate| candidate.parent().map(Path::to_path_buf))
}

fn prepend_path_entry(entry: &Path, current_path: Option<&OsStr>) -> Option<OsString> {
    let mut entries = vec![entry.to_path_buf()];
    if let Some(current_path) = current_path {
        entries.extend(std::env::split_paths(current_path));
    }
    std::env::join_paths(entries).ok()
}

fn start_threads<R: Runtime>(
    app: AppHandle<R>,
    registry: Weak<RwLock<HashMap<String, Arc<TerminalSession>>>>,
    session: Arc<TerminalSession>,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), String> {
    let waiter_session = Arc::clone(&session);
    let reader_app = app.clone();
    let waiter_app = app;
    let waiter_id = session.id.clone();
    let waiter_token = session.session_token;

    let waiter_registry = registry.clone();
    let reader_registry = registry;
    thread::Builder::new()
        .name(format!(
            "maestri-terminal-waiter-{waiter_id}-{waiter_token}"
        ))
        .spawn(move || {
            let status = waiter_session
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok());

            if let Ok(mut state) = waiter_session.state.lock() {
                *state = Lifecycle::Exited;
            }

            if let Ok(mut worker) = waiter_session.scrollback_worker.lock() {
                worker.stop_and_join();
            }

            if waiter_session.exit_emitted.swap(true, Ordering::AcqRel) {
                return;
            }

            let (code, signal) = match status {
                Some(status) => {
                    let signal = status.signal().map(ToOwned::to_owned);
                    let code = i32::try_from(status.exit_code()).ok();
                    (code, signal)
                }
                None => (None, None),
            };
            let event = TerminalExitedEvent {
                terminal_id: waiter_id.clone(),
                exit_code: code,
                signal,
            };
            let _ = waiter_app.emit("terminal://exited", event);

            // Token-checked removal: remove only if the registry entry still matches this exact session token.
            if let Some(sessions) = waiter_registry.upgrade() {
                if let Ok(mut sessions) = sessions.write() {
                    if let Some(current) = sessions.get(&waiter_id) {
                        if current.session_token == waiter_token {
                            sessions.remove(&waiter_id);
                        }
                    }
                }
            }
        })
        .map_err(|error| format!("cannot start terminal waiter: {error}"))?;

    // Start the waiter first: if the reader thread cannot be created, the
    // waiter still observes process termination and publishes terminal://exited.
    let reader_session = Arc::clone(&session);
    let reader_id = session.id.clone();
    let reader_token = session.session_token;
    thread::Builder::new()
        .name(format!(
            "maestri-terminal-reader-{reader_id}-{reader_token}"
        ))
        .spawn(move || {
            let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = String::from_utf8_lossy(&buffer[..size]).into_owned();
                        if let Ok(mut chunks) = reader_session.recent_output.lock() {
                            chunks.push_back(data.clone());
                            while chunks.len() > MAX_SCROLLBACK_CHUNKS {
                                chunks.pop_front();
                            }
                        }

                        // Non-blocking async queue dispatch to ScrollbackWorker with generation tagging
                        if let Some(registry_ref) = reader_registry.upgrade() {
                            let reg = TerminalRegistry {
                                sessions: registry_ref,
                                scrollback_store: Arc::clone(&reader_session.registry_store),
                            };
                            if let Some(store) = reg.get_scrollback_store() {
                                let gen = store.generation();
                                if let Ok(worker) = reader_session.scrollback_worker.lock() {
                                    let _ = worker.try_enqueue(store, gen, data.clone());
                                }
                            }
                        }
                        // ConPTY/PowerShell can ask for the cursor position
                        // before the WebView has completed its async event
                        // subscription. Answer the initial DSR defensively so
                        // the shell prompt cannot deadlock during startup.
                        if data.contains("\u{1b}[6n") {
                            let _ = reader_session.write_input("\u{1b}[1;1R");
                        }
                        let sequence = reader_session.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                        let event = TerminalOutputEvent {
                            terminal_id: reader_id.clone(),
                            data,
                            sequence,
                        };
                        let _ = reader_app.emit("terminal://output", event);
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| format!("cannot start terminal reader: {error}"))?;

    Ok(())
}

fn terminal_create_with_registry<R: Runtime>(
    app: AppHandle<R>,
    registry: &TerminalRegistry,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    command: Option<String>,
) -> Result<TerminalInfo, String> {
    validate_id(&id)?;
    validate_size(cols, rows)?;

    // If an active running PTY session with this ID already exists in the Rust daemon registry,
    // preserve and reuse it without stopping or restarting the underlying process.
    if let Ok(existing) = registry.get(&id) {
        if let Ok(info) = existing.info() {
            if info.state == "running" {
                let _ = existing.resize(cols, rows);
                return Ok(info);
            }
        }
        let _ = existing.request_stop();
        let _ = registry.remove_exact(&id, existing.session_token)?;
    }

    let ipc_credential = generate_ipc_credential()?;
    let cwd = resolve_cwd(cwd)?;
    let pty_command = build_command(shell, args, env, command, &cwd, &id, &ipc_credential)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("cannot create pseudo-terminal: {error}"))?;

    let child = pair
        .slave
        .spawn_command(pty_command)
        .map_err(|error| format!("cannot spawn terminal shell: {error}"))?;
    let pid = child.process_id();
    let mut setup_killer = child.clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = setup_killer.kill();
            return Err(format!("cannot open terminal reader: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = setup_killer.kill();
            return Err(format!("cannot open terminal writer: {error}"));
        }
    };
    let killer = child.clone_killer();
    let session_token = SESSION_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);

    let session = Arc::new(TerminalSession {
        id: id.clone(),
        session_token,
        ipc_credential,
        pid,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        killer: Mutex::new(killer),
        state: Mutex::new(Lifecycle::Running),
        cols: Mutex::new(cols),
        rows: Mutex::new(rows),
        stop_requested: AtomicBool::new(false),
        exit_emitted: AtomicBool::new(false),
        sequence: AtomicU64::new(0),
        recent_output: Mutex::new(VecDeque::new()),
        scrollback_worker: Mutex::new(ScrollbackWorker::spawn(id.clone())),
        registry_store: Arc::clone(&registry.scrollback_store),
        is_remote: false,
    });

    if let Err(error) = registry.insert(Arc::clone(&session)) {
        let _ = session.request_stop();
        return Err(error);
    }
    let registry_weak = Arc::downgrade(&registry.sessions);
    if let Err(error) = start_threads(app, registry_weak, Arc::clone(&session), reader) {
        let _ = session.request_stop();
        let _ = registry.remove_exact(&id, session_token);
        return Err(error);
    }

    session.info()
}

fn start_ssh_threads<R: Runtime>(
    app: AppHandle<R>,
    registry_weak: Weak<RwLock<HashMap<String, Arc<TerminalSession>>>>,
    session: Arc<TerminalSession>,
    mut reader: Box<dyn Read + Send>,
    nonce: String,
    tunnel_port: u16,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<(), String> {
    let waiter_registry = registry_weak.clone();
    let waiter_id = session.id.clone();
    let waiter_token = session.session_token;
    let waiter_child = Arc::clone(&session);
    let waiter_app = app.clone();

    thread::Builder::new()
        .name(format!("maestri-terminal-waiter-{waiter_id}-{waiter_token}"))
        .spawn(move || {
            let code = match waiter_child.child.lock() {
                Ok(mut child) => child.wait().ok().map(|exit| exit.exit_code() as i32),
                Err(_) => None,
            };

            let _ = waiter_child.transition_exited();

            let signal = if code.is_none() {
                Some("SIGKILL".to_string())
            } else {
                None
            };
            let event = TerminalExitedEvent {
                terminal_id: waiter_id.clone(),
                exit_code: code,
                signal,
            };
            let _ = waiter_app.emit("terminal://exited", event);

            if let Some(sessions) = waiter_registry.upgrade() {
                if let Ok(mut sessions) = sessions.write() {
                    if let Some(current) = sessions.get(&waiter_id) {
                        if current.session_token == waiter_token {
                            sessions.remove(&waiter_id);
                        }
                    }
                }
            }
        })
        .map_err(|error| format!("cannot start SSH terminal waiter: {error}"))?;

    let reader_session = Arc::clone(&session);
    let reader_id = session.id.clone();
    let reader_token = session.session_token;
    let reader_app = app;
    let reader_registry = registry_weak;

    let handshake_done = Arc::new(AtomicBool::new(false));
    let watchdog_session = Arc::clone(&session);
    let watchdog_done = Arc::clone(&handshake_done);
    thread::Builder::new()
        .name(format!("maestri-ssh-handshake-watchdog-{reader_id}"))
        .spawn(move || {
            let timeout = Duration::from_secs(10);
            let start = Instant::now();
            while start.elapsed() < timeout {
                if watchdog_done.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            if !watchdog_done.load(Ordering::Acquire) {
                let _ = watchdog_session.request_stop();
            }
        })
        .map_err(|error| format!("cannot start SSH handshake watchdog: {error}"))?;

    thread::Builder::new()
        .name(format!("maestri-ssh-terminal-reader-{reader_id}-{reader_token}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
            let mut hs_buffer = crate::remote_terminal_contract::HandshakeBuffer::new();
            let mut payload_sent = false;

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let chunk = &buffer[..size];
                        let (event, clean_bytes) = hs_buffer.process_chunk(chunk, &nonce);

                        if let Some(crate::remote_terminal_contract::HandshakeEvent::Ready) = event {
                            if !payload_sent {
                                payload_sent = true;
                                let payload = crate::remote_terminal_contract::RemotePayload {
                                    terminal_id: reader_session.id.clone(),
                                    token: reader_session.ipc_credential.clone(),
                                    tunnel_port,
                                    cwd: cwd.clone(),
                                    command: command.clone(),
                                };
                                if let Ok(payload_str) = crate::remote_terminal_contract::encode_payload(&payload) {
                                    let _ = reader_session.write_input(&payload_str);
                                }
                            }
                        } else if let Some(crate::remote_terminal_contract::HandshakeEvent::Established) = event {
                            handshake_done.store(true, Ordering::Release);
                        }

                        if clean_bytes.is_empty() {
                            continue;
                        }

                        let data = String::from_utf8_lossy(&clean_bytes).into_owned();
                        if let Ok(mut chunks) = reader_session.recent_output.lock() {
                            chunks.push_back(data.clone());
                            while chunks.len() > MAX_SCROLLBACK_CHUNKS {
                                chunks.pop_front();
                            }
                        }

                        if let Some(registry_ref) = reader_registry.upgrade() {
                            let reg = TerminalRegistry {
                                sessions: registry_ref,
                                scrollback_store: Arc::clone(&reader_session.registry_store),
                            };
                            if let Some(store) = reg.get_scrollback_store() {
                                let gen = store.generation();
                                if let Ok(worker) = reader_session.scrollback_worker.lock() {
                                    let _ = worker.try_enqueue(store, gen, data.clone());
                                }
                            }
                        }

                        let sequence = reader_session.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                        let event = TerminalOutputEvent {
                            terminal_id: reader_id.clone(),
                            data,
                            sequence,
                        };
                        let _ = reader_app.emit("terminal://output", event);
                    }
                    Err(_) => break,
                }
            }
            handshake_done.store(true, Ordering::Release);
        })
        .map_err(|error| format!("cannot start SSH terminal reader: {error}"))?;

    Ok(())
}

fn terminal_create_ssh_with_registry<R: Runtime>(
    app: AppHandle<R>,
    registry: &TerminalRegistry,
    ssh_manager: &crate::ssh::SshManager,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<TerminalInfo, String> {
    validate_id(&id)?;
    validate_size(cols, rows)?;

    crate::remote_terminal_contract::check_default_user_ssh_security()?;

    let active_config = ssh_manager
        .active_config()
        .ok_or_else(|| "SSH tunnel is not active. Connect SSH tunnel before creating remote terminal".to_string())?;

    let executable = crate::ssh::resolve_ssh_executable()?;
    let nonce = crate::remote_terminal_contract::generate_nonce();
    let ssh_args = crate::remote_terminal_contract::build_ssh_remote_args(
        &active_config.user,
        &active_config.host,
        active_config.port,
        &nonce,
    );

    if let Ok(existing) = registry.get(&id) {
        if let Ok(info) = existing.info() {
            if info.state == "running" {
                let _ = existing.resize(cols, rows);
                return Ok(info);
            }
        }
        let _ = existing.request_stop();
        let _ = registry.remove_exact(&id, existing.session_token)?;
    }

    let ipc_credential = generate_ipc_credential()?;
    let mut pty_command = CommandBuilder::new(executable);
    pty_command.args(ssh_args);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("cannot create pseudo-terminal: {error}"))?;

    let child = pair
        .slave
        .spawn_command(pty_command)
        .map_err(|error| format!("cannot spawn SSH remote terminal: {error}"))?;
    let pid = child.process_id();
    let mut setup_killer = child.clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = setup_killer.kill();
            return Err(format!("cannot open terminal reader: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = setup_killer.kill();
            return Err(format!("cannot open terminal writer: {error}"));
        }
    };
    let killer = child.clone_killer();
    let session_token = SESSION_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);

    let session = Arc::new(TerminalSession {
        id: id.clone(),
        session_token,
        ipc_credential: ipc_credential.clone(),
        pid,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        killer: Mutex::new(killer),
        state: Mutex::new(Lifecycle::Running),
        cols: Mutex::new(cols),
        rows: Mutex::new(rows),
        stop_requested: AtomicBool::new(false),
        exit_emitted: AtomicBool::new(false),
        sequence: AtomicU64::new(0),
        recent_output: Mutex::new(VecDeque::new()),
        scrollback_worker: Mutex::new(ScrollbackWorker::spawn(id.clone())),
        registry_store: Arc::clone(&registry.scrollback_store),
        is_remote: true,
    });

    if let Err(error) = registry.insert(Arc::clone(&session)) {
        let _ = session.request_stop();
        return Err(error);
    }

    let registry_weak = Arc::downgrade(&registry.sessions);
    if let Err(error) = start_ssh_threads(
        app,
        registry_weak,
        Arc::clone(&session),
        reader,
        nonce,
        active_config.tunnel_port,
        cwd,
        command,
    ) {
        let _ = session.request_stop();
        let _ = registry.remove_exact(&id, session_token);
        return Err(error);
    }

    session.info()
}

/// Creates and starts a ConPTY-backed session.
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    registry: State<'_, TerminalRegistry>,
    ssh_manager: State<'_, crate::ssh::SshManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    command: Option<String>,
    location_type: Option<String>,
) -> Result<TerminalInfo, String> {
    let loc = crate::remote_terminal_contract::validate_location_type(location_type.as_deref())?;
    if loc == "ssh" {
        terminal_create_ssh_with_registry(
            app,
            &registry,
            &ssh_manager,
            id,
            cols,
            rows,
            cwd,
            command,
        )
    } else {
        terminal_create_with_registry(
            app,
            &registry,
            id,
            cols,
            rows,
            cwd,
            shell,
            args,
            env,
            command,
        )
    }
}

#[cfg(test)]
pub(crate) fn terminal_create_for_test<R: Runtime>(
    app: AppHandle<R>,
    registry: &TerminalRegistry,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    command: Option<String>,
) -> Result<TerminalInfo, String> {
    terminal_create_with_registry(
        app, registry, id, cols, rows, cwd, shell, args, env, command,
    )
}

#[tauri::command]
pub fn terminal_write(
    registry: State<'_, TerminalRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    validate_id(&id)?;
    registry.get(&id)?.write_input(&data)
}

#[tauri::command]
pub fn terminal_resize(
    registry: State<'_, TerminalRegistry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    validate_id(&id)?;
    let session = registry.get(&id)?;
    session.resize(cols, rows)?;
    session.info()
}

#[cfg(test)]
pub(crate) fn terminal_resize_for_test(
    registry: &TerminalRegistry,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    validate_id(&id)?;
    let session = registry.get(&id)?;
    session.resize(cols, rows)?;
    session.info()
}

#[tauri::command]
pub fn terminal_stop(
    registry: State<'_, TerminalRegistry>,
    id: String,
    expected_session_token: Option<u64>,
) -> Result<(), String> {
    validate_id(&id)?;
    match registry.get(&id) {
        Ok(session) => {
            if expected_session_token.is_some_and(|token| token != session.session_token) {
                return Ok(());
            }
            session.request_stop()?;
            let _ = registry.remove_exact(&id, session.session_token)?;
        }
        Err(error) if error == format!("terminal '{id}' not found") => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_list(registry: State<'_, TerminalRegistry>) -> Result<Vec<TerminalInfo>, String> {
    registry.list()
}

#[tauri::command]
pub fn terminal_load_scrollback(
    registry: State<'_, TerminalRegistry>,
    id: String,
    max_lines: Option<usize>,
) -> Result<ScrollbackLoadPayload, String> {
    validate_id(&id)?;

    let store = registry
        .get_scrollback_store()
        .ok_or_else(|| "No active workspace or scrollback store available".to_string())?;

    // Persist a workspace-relative reference in workspace.json so moving a
    // project between machines does not bake in an unusable absolute path.
    let _ = store.resolve_scrollback_path(&id)?;
    let scrollback_file = Some(format!(".maestri/scrollback/{id}.log"));

    let raw_text = store.load_text(&id)?;
    if raw_text.is_empty() {
        return Ok(ScrollbackLoadPayload {
            data: String::new(),
            scrollback_file,
            scrollback_line_count: 0,
        });
    }

    let (data, total_lines) = tail_lines_preserving_delimiters(&raw_text, max_lines);

    Ok(ScrollbackLoadPayload {
        data,
        scrollback_file,
        scrollback_line_count: total_lines,
    })
}

/// Returns the newest logical lines without normalizing CRLF, CR or LF.
/// A trailing delimiter does not create an extra logical line.
fn tail_lines_preserving_delimiters(text: &str, max_lines: Option<usize>) -> (String, usize) {
    if text.is_empty() {
        return (String::new(), 0);
    }

    let bytes = text.as_bytes();
    let mut starts = vec![0usize];
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                index += 1;
                if index < bytes.len() && bytes[index] == b'\n' {
                    index += 1;
                }
                starts.push(index);
            }
            b'\n' => {
                index += 1;
                starts.push(index);
            }
            _ => index += 1,
        }
    }
    if starts.last() == Some(&text.len()) {
        starts.pop();
    }

    let total_lines = starts.len();
    let limit = max_lines.unwrap_or(total_lines).min(total_lines);
    if limit == 0 {
        return (String::new(), total_lines);
    }
    let start = starts[total_lines - limit];
    (text[start..].to_string(), total_lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maestri_environment_carries_session_context_into_conpty() {
        let environment =
            MaestriEnvironment::from_lookup("terminal-test-42", "ephemeral-test-token", |key| {
                match key {
                    "MAESTRI_SOCKET" => Some("127.0.0.1:45678".to_owned()),
                    _ => None,
                }
            });

        let mut command = CommandBuilder::new("cmd.exe");
        environment.apply_to(&mut command);

        assert_eq!(
            command.get_env("MAESTRI_TERMINAL_ID"),
            Some(std::ffi::OsStr::new("terminal-test-42"))
        );
        assert_eq!(
            command.get_env("MAESTRI_SOCKET"),
            Some(std::ffi::OsStr::new("127.0.0.1:45678"))
        );
        assert_eq!(
            command.get_env("MAESTRI_TOKEN"),
            Some(std::ffi::OsStr::new("ephemeral-test-token"))
        );
    }

    #[test]
    fn test_scrollback_fail_closed_without_workspace() {
        let registry = TerminalRegistry::new();
        assert!(registry.get_scrollback_store().is_none());
    }

    #[test]
    fn test_scrollback_workspace_switch_a_to_b_and_isolation() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();

        let registry = TerminalRegistry::new();

        // Switch to Workspace A
        let store_a = Arc::new(ScrollbackStore::new(dir_a.path(), None).unwrap());
        registry.set_scrollback_store(Some(Arc::clone(&store_a)));

        store_a.append("term-1", "Output WS A\n").unwrap();
        assert_eq!(store_a.load("term-1", None).unwrap(), vec!["Output WS A"]);

        // Switch to Workspace B
        let store_b = Arc::new(ScrollbackStore::new(dir_b.path(), None).unwrap());
        registry.set_scrollback_store(Some(Arc::clone(&store_b)));

        assert_eq!(store_b.load("term-1", None).unwrap().len(), 0);
        store_b.append("term-1", "Output WS B\n").unwrap();
        assert_eq!(store_b.load("term-1", None).unwrap(), vec!["Output WS B"]);

        // Store A remains isolated
        assert_eq!(store_a.load("term-1", None).unwrap(), vec!["Output WS A"]);
    }

    #[test]
    fn test_scrollback_queue_overflow_policy() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(ScrollbackStore::new(dir.path(), None).unwrap());
        let gen = store.generation();

        let worker = ScrollbackWorker::spawn("term-overflow".to_string());

        // Fill capacity (SCROLLBACK_QUEUE_CAPACITY = 100)
        for i in 0..SCROLLBACK_QUEUE_CAPACITY {
            assert!(worker.try_enqueue(Arc::clone(&store), gen, format!("Line {i}\n")));
        }

        // 101st enqueue must fail gracefully (try_send Full) without blocking
        let overflow_sent =
            worker.try_enqueue(Arc::clone(&store), gen, "OVERFLOW_LINE\n".to_string());
        assert!(
            !overflow_sent,
            "Worker queue overflow must drop chunk non-blockingly"
        );
    }

    #[test]
    fn test_scrollback_generation_mismatch_prevents_stale_writes_to_workspace_a() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();

        let store_a = Arc::new(ScrollbackStore::new(dir_a.path(), None).unwrap());
        let gen_a = store_a.generation();

        let store_b = Arc::new(ScrollbackStore::new(dir_b.path(), None).unwrap());
        let gen_b = store_b.generation();

        assert_ne!(gen_a, gen_b);

        let mut worker = ScrollbackWorker::spawn("term-gen".to_string());

        // Enqueue item intended for Store A with Store A's generation
        assert!(worker.try_enqueue(
            Arc::clone(&store_a),
            gen_a,
            "Valid Store A line\n".to_string()
        ));

        // Enqueue item for Store A BUT with mismatched generation (simulating stale queue after switch to B)
        assert!(worker.try_enqueue(
            Arc::clone(&store_a),
            gen_b,
            "Stale Store A line\n".to_string()
        ));

        worker.stop_and_join();

        let text_a = store_a.load_text("term-gen").unwrap();
        assert!(text_a.contains("Valid Store A line"));
        assert!(
            !text_a.contains("Stale Store A line"),
            "Stale generation write to Store A must be rejected"
        );
    }

    #[test]
    fn test_scrollback_worker_stop_and_join_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(ScrollbackStore::new(dir.path(), None).unwrap());
        let gen = store.generation();

        let mut worker = ScrollbackWorker::spawn("term-join".to_string());
        assert!(worker.try_enqueue(
            Arc::clone(&store),
            gen,
            "Line 1\r\n\x1b[32mLine 2\x1b[0m\r\n".to_string()
        ));

        worker.stop_and_join();
        // Second call must be idempotent without panicking
        worker.stop_and_join();

        let loaded_text = store.load_text("term-join").unwrap();
        assert_eq!(loaded_text, "Line 1\r\n\x1b[32mLine 2\x1b[0m\r\n");
    }

    #[test]
    fn scrollback_tail_preserves_mixed_line_delimiters_and_ansi() {
        let raw = "old\r\n\x1b[31mred\x1b[0m\rnew\nlast\r\n";
        let (tail, count) = tail_lines_preserving_delimiters(raw, Some(3));
        assert_eq!(count, 4);
        assert_eq!(tail, "\x1b[31mred\x1b[0m\rnew\nlast\r\n");

        let (empty, count) = tail_lines_preserving_delimiters(raw, Some(0));
        assert_eq!(count, 4);
        assert!(empty.is_empty());
    }

    #[test]
    fn build_command_configures_windows_defaults_and_env() {
        let cwd = std::env::current_dir().unwrap();
        let command = build_command(
            Some("powershell.exe".to_string()),
            None,
            None,
            None,
            &cwd,
            "term-test-env",
            "credential-term-test-env",
        )
        .unwrap();
        assert_eq!(
            command.get_env("MAESTRI_TERMINAL_ID"),
            Some(std::ffi::OsStr::new("term-test-env"))
        );
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
    }

    #[test]
    fn build_command_applies_custom_env_and_protects_maestri_and_path() {
        let cwd = std::env::current_dir().unwrap();
        let mut custom_env = HashMap::new();
        custom_env.insert("FOO".to_string(), "bar".to_string());
        custom_env.insert("MAESTRI_SOCKET".to_string(), "malicious_socket".to_string());
        custom_env.insert("PATH".to_string(), "malicious_path".to_string());
        custom_env.insert("TERM".to_string(), "malicious_term".to_string());
        custom_env.insert("COLORTERM".to_string(), "malicious_color".to_string());

        let command = build_command(
            Some("pwsh.exe".to_string()),
            None,
            Some(custom_env),
            None,
            &cwd,
            "term-sec-test",
            "credential-term-sec-test",
        )
        .unwrap();

        assert_eq!(command.get_env("FOO"), Some(std::ffi::OsStr::new("bar")));
        // MAESTRI_SOCKET and PATH should NOT be overwritten by custom_env
        assert_ne!(
            command.get_env("MAESTRI_SOCKET"),
            Some(std::ffi::OsStr::new("malicious_socket"))
        );
        assert_ne!(
            command.get_env("PATH"),
            Some(std::ffi::OsStr::new("malicious_path"))
        );
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
    }

    #[test]
    fn build_command_handles_explicit_args_and_initial_command() {
        let cwd = std::env::current_dir().unwrap();
        // 1. Custom args
        let command_args = build_command(
            Some("pwsh.exe".to_string()),
            Some(vec![
                "-NoLogo".to_string(),
                "-Command".to_string(),
                "Get-Location".to_string(),
            ]),
            None,
            None,
            &cwd,
            "term-args",
            "credential-term-args",
        )
        .unwrap();
        assert_eq!(
            command_args.get_env("MAESTRI_TERMINAL_ID"),
            Some(std::ffi::OsStr::new("term-args"))
        );

        // 2. Initial agent command flag generation
        let command_agent = build_command(
            Some("powershell.exe".to_string()),
            None,
            None,
            Some("claude --version".to_string()),
            &cwd,
            "term-agent",
            "credential-term-agent",
        )
        .unwrap();
        assert_eq!(
            command_agent.get_env("MAESTRI_TERMINAL_ID"),
            Some(std::ffi::OsStr::new("term-agent"))
        );
    }

    #[test]
    fn explicit_command_args_are_authoritative_and_not_duplicated() {
        let cwd = std::env::current_dir().unwrap();
        let command = build_command(
            Some("pwsh.exe".to_string()),
            Some(vec![
                "-NoLogo".to_string(),
                "-Command".to_string(),
                "Write-Output explicit".to_string(),
            ]),
            None,
            Some("Write-Output initial".to_string()),
            &cwd,
            "term-command-mode",
            "credential-term-command-mode",
        )
        .unwrap();

        let argv: Vec<String> = command
            .get_argv()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            argv,
            vec!["pwsh.exe", "-NoLogo", "-Command", "Write-Output explicit"]
        );
        assert!(!argv.iter().any(|value| value == "Write-Output initial"));
    }

    #[test]
    fn posix_initial_command_keeps_interactive_shell_alive() {
        let cwd = std::env::current_dir().unwrap();
        let command = build_command(
            Some("bash".to_string()),
            None,
            None,
            Some("printf ready".to_string()),
            &cwd,
            "term-posix-command",
            "credential-term-posix-command",
        )
        .unwrap();

        let argv: Vec<String> = command
            .get_argv()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert!(argv.contains(&"-i".to_string()));
        assert!(argv.iter().any(|value| value.contains("exec \"$0\" -i")));
    }

    #[test]
    fn cli_discovery_prefers_release_binary_next_to_app() {
        let app = Path::new("bundle/open-maestri-windows.exe");
        let manifest = Path::new("workspace/src-tauri");
        let sibling = Path::new("bundle/omaestri.exe");
        let found = discover_omaestri_dir(Some(app), manifest, |candidate| candidate == sibling);
        assert_eq!(found, Some(PathBuf::from("bundle")));
    }

    #[test]
    fn cli_discovery_uses_real_src_cli_release_then_debug_targets() {
        let app = Path::new("workspace/src-tauri/target/debug/open-maestri-windows.exe");
        let manifest = Path::new("workspace/src-tauri");
        let found = discover_omaestri_dir(Some(app), manifest, |candidate| {
            candidate
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("src-cli/target/release/omaestri.exe")
        });
        assert!(found
            .expect("release CLI candidate should be discovered")
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("src-cli/target/release"));

        let debug_found = discover_omaestri_dir(Some(app), manifest, |candidate| {
            candidate
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("src-cli/target/debug/omaestri.exe")
        });
        assert!(debug_found
            .expect("debug CLI candidate should be discovered")
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("src-cli/target/debug"));
    }

    #[test]
    fn cli_path_prepend_is_child_only_and_preserves_process_path() {
        let original_path = std::env::var_os("PATH");
        let child_path = prepend_path_entry(Path::new("cli"), Some(OsStr::new("existing")))
            .expect("PATH should be joinable");
        let child_entries: Vec<_> = std::env::split_paths(&child_path).collect();
        assert_eq!(child_entries.first(), Some(&PathBuf::from("cli")));
        assert_eq!(std::env::var_os("PATH"), original_path);
    }

    #[test]
    fn maestri_environment_does_not_publish_blank_ipc_credentials() {
        let environment =
            MaestriEnvironment::from_lookup("terminal-test-43", "session-credential-43", |key| {
                match key {
                    "MAESTRI_SOCKET" => Some("  ".to_owned()),
                    "MAESTRI_TOKEN" => Some("global-token-must-be-ignored".to_owned()),
                    _ => None,
                }
            });

        assert_eq!(environment.terminal_id, "terminal-test-43");
        assert_eq!(environment.socket, None);
        assert_eq!(environment.token, Some("session-credential-43".to_owned()));
    }

    #[test]
    fn test_token_checked_session_isolation() {
        let registry = TerminalRegistry::new();

        let pty_system = native_pty_system();
        let pair1 = pty_system
            .openpty(PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let writer1 = pair1.master.take_writer().unwrap();

        let child1 = pair1
            .slave
            .spawn_command(CommandBuilder::new("powershell.exe"))
            .unwrap();
        let killer1 = child1.clone_killer();

        // Session 1 (token = 100)
        let session1 = Arc::new(TerminalSession {
            id: "term-1".to_string(),
            session_token: 100,
            ipc_credential: "credential-term-1-100".to_string(),
            pid: child1.process_id(),
            master: Mutex::new(pair1.master),
            writer: Mutex::new(writer1),
            child: Mutex::new(child1),
            killer: Mutex::new(killer1),
            state: Mutex::new(Lifecycle::Running),
            cols: Mutex::new(80),
            rows: Mutex::new(24),
            stop_requested: AtomicBool::new(false),
            exit_emitted: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            recent_output: Mutex::new(VecDeque::new()),
            scrollback_worker: Mutex::new(ScrollbackWorker::spawn("term-1".to_string())),
            registry_store: Arc::clone(&registry.scrollback_store),
            is_remote: false,
        });

        assert!(registry.insert(Arc::clone(&session1)).is_ok());
        assert_eq!(registry.get("term-1").unwrap().session_token, 100);
        assert!(registry
            .validate_ipc_credentials("term-1", "credential-term-1-100")
            .is_ok());
        assert!(registry
            .validate_ipc_credentials("term-1", "credential-term-1-200")
            .is_err());
        assert!(registry
            .validate_ipc_credentials("manager-uuid", "credential-term-1-100")
            .is_err());

        let pair2 = pty_system
            .openpty(PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let writer2 = pair2.master.take_writer().unwrap();

        let child2 = pair2
            .slave
            .spawn_command(CommandBuilder::new("powershell.exe"))
            .unwrap();
        let killer2 = child2.clone_killer();

        // Session 2 (token = 200) for same id "term-1"
        let session2 = Arc::new(TerminalSession {
            id: "term-1".to_string(),
            session_token: 200,
            ipc_credential: "credential-term-1-200".to_string(),
            pid: child2.process_id(),
            master: Mutex::new(pair2.master),
            writer: Mutex::new(writer2),
            child: Mutex::new(child2),
            killer: Mutex::new(killer2),
            state: Mutex::new(Lifecycle::Running),
            cols: Mutex::new(80),
            rows: Mutex::new(24),
            stop_requested: AtomicBool::new(false),
            exit_emitted: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            recent_output: Mutex::new(VecDeque::new()),
            scrollback_worker: Mutex::new(ScrollbackWorker::spawn("term-1".to_string())),
            registry_store: Arc::clone(&registry.scrollback_store),
            is_remote: false,
        });

        // Simulate session replacement
        assert!(registry.remove_exact("term-1", 100).unwrap());
        assert!(registry.insert(Arc::clone(&session2)).is_ok());

        // Stale waiter from session 1 attempts to remove_exact with old token 100
        let removed_stale = registry.remove_exact("term-1", 100).unwrap();
        assert!(!removed_stale, "Stale cleanup must NOT remove new session");

        // Verify active session is still session 2 (token = 200)
        assert_eq!(registry.get("term-1").unwrap().session_token, 200);
        assert!(registry
            .validate_ipc_credentials("term-1", "credential-term-1-100")
            .is_err());
        assert!(registry
            .validate_ipc_credentials("term-1", "credential-term-1-200")
            .is_ok());

        // Cleanup session 2 with correct token
        let _ = session1.request_stop();
        let _ = session2.request_stop();
        let removed_current = registry.remove_exact("term-1", 200).unwrap();
        assert!(removed_current);
        assert!(registry.get("term-1").is_err());
        assert!(registry
            .validate_ipc_credentials("term-1", "credential-term-1-200")
            .is_err());
    }

    #[test]
    fn test_stress_repeated_id_replacement() {
        let registry = TerminalRegistry::new();
        let pty_system = native_pty_system();

        for i in 1..=10 {
            let pair = pty_system
                .openpty(PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let writer = pair.master.take_writer().unwrap();
            let child = pair
                .slave
                .spawn_command(CommandBuilder::new("cmd.exe"))
                .unwrap();
            let killer = child.clone_killer();

            let session_token = i as u64;
            let session = Arc::new(TerminalSession {
                id: "repeat-id".to_string(),
                session_token,
                ipc_credential: format!("credential-repeat-id-{session_token}"),
                pid: child.process_id(),
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                killer: Mutex::new(killer),
                state: Mutex::new(Lifecycle::Running),
                cols: Mutex::new(80),
                rows: Mutex::new(24),
                stop_requested: AtomicBool::new(false),
                exit_emitted: AtomicBool::new(false),
                sequence: AtomicU64::new(0),
                recent_output: Mutex::new(VecDeque::new()),
                scrollback_worker: Mutex::new(ScrollbackWorker::spawn("repeat-id".to_string())),
                registry_store: Arc::clone(&registry.scrollback_store),
                is_remote: false,
            });

            if let Ok(existing) = registry.get("repeat-id") {
                let _ = existing.request_stop();
                let _ = registry.remove_exact("repeat-id", existing.session_token);
            }

            assert!(registry.insert(Arc::clone(&session)).is_ok());
            assert_eq!(
                registry.get("repeat-id").unwrap().session_token,
                session_token
            );
        }

        if let Ok(final_session) = registry.get("repeat-id") {
            let _ = final_session.request_stop();
            assert!(registry
                .remove_exact("repeat-id", final_session.session_token)
                .unwrap());
        }
    }

    #[test]
    fn test_stress_stale_stop_token_and_removal() {
        let registry = TerminalRegistry::new();
        let pty_system = native_pty_system();

        let create_dummy_session = |id: &str, token: u64| {
            let pair = pty_system
                .openpty(PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let writer = pair.master.take_writer().unwrap();
            let child = pair
                .slave
                .spawn_command(CommandBuilder::new("cmd.exe"))
                .unwrap();
            let killer = child.clone_killer();

            Arc::new(TerminalSession {
                id: id.to_string(),
                session_token: token,
                ipc_credential: format!("credential-{id}-{token}"),
                pid: child.process_id(),
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                killer: Mutex::new(killer),
                state: Mutex::new(Lifecycle::Running),
                cols: Mutex::new(80),
                rows: Mutex::new(24),
                stop_requested: AtomicBool::new(false),
                exit_emitted: AtomicBool::new(false),
                sequence: AtomicU64::new(0),
                recent_output: Mutex::new(VecDeque::new()),
                scrollback_worker: Mutex::new(ScrollbackWorker::spawn(id.to_string())),
                registry_store: Arc::clone(&registry.scrollback_store),
                is_remote: false,
            })
        };

        let session1 = create_dummy_session("stale-test", 1000);
        assert!(registry.insert(Arc::clone(&session1)).is_ok());

        let session2 = create_dummy_session("stale-test", 2000);
        let _ = session1.request_stop();
        assert!(registry.remove_exact("stale-test", 1000).unwrap());
        assert!(registry.insert(Arc::clone(&session2)).is_ok());

        // Stale remove_exact attempt with token 1000
        let stale_removed = registry.remove_exact("stale-test", 1000).unwrap();
        assert!(
            !stale_removed,
            "Stale token must not remove current session"
        );

        // Active session is still session 2
        assert_eq!(registry.get("stale-test").unwrap().session_token, 2000);

        let _ = session2.request_stop();
        assert!(registry.remove_exact("stale-test", 2000).unwrap());
    }

    #[test]
    fn test_stress_five_concurrent_sessions_and_stop_all() {
        let registry = TerminalRegistry::new();
        let pty_system = native_pty_system();
        let mut active_sessions = Vec::new();

        for i in 1..=5 {
            let id = format!("simultaneous-term-{i}");
            let pair = pty_system
                .openpty(PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let writer = pair.master.take_writer().unwrap();
            let child = pair
                .slave
                .spawn_command(CommandBuilder::new("cmd.exe"))
                .unwrap();
            let killer = child.clone_killer();

            let session = Arc::new(TerminalSession {
                id: id.clone(),
                session_token: i as u64,
                ipc_credential: format!("credential-{id}-{}", i),
                pid: child.process_id(),
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                killer: Mutex::new(killer),
                state: Mutex::new(Lifecycle::Running),
                cols: Mutex::new(80),
                rows: Mutex::new(24),
                stop_requested: AtomicBool::new(false),
                exit_emitted: AtomicBool::new(false),
                sequence: AtomicU64::new(0),
                recent_output: Mutex::new(VecDeque::new()),
                scrollback_worker: Mutex::new(ScrollbackWorker::spawn(id.clone())),
                registry_store: Arc::clone(&registry.scrollback_store),
                is_remote: false,
            });

            assert!(registry.insert(Arc::clone(&session)).is_ok());
            active_sessions.push(session);
        }

        assert_eq!(registry.list().unwrap().len(), 5);

        // Test stop_all behavior
        registry.stop_all();

        for session in active_sessions {
            assert!(session.stop_requested.load(Ordering::Acquire));
            assert!(registry
                .validate_ipc_credentials(&session.id, &session.ipc_credential)
                .is_err());
        }
        assert!(registry.list().unwrap().is_empty());
    }
}
