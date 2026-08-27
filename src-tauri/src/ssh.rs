use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

use crate::ssh_contract::{self, SshContractConfig};

const CONNECT_READY_TIMEOUT: Duration = Duration::from_secs(12);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub script_path: String,
    pub tunnel_port: u16,
    pub add_to_path: bool,
}

impl SshConfig {
    fn contract(&self) -> SshContractConfig {
        SshContractConfig {
            host: self.host.clone(),
            user: self.user.clone(),
            port: self.port,
            script_path: self.script_path.clone(),
            tunnel_port: self.tunnel_port,
            add_to_path: self.add_to_path,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshStatus {
    pub state: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub tunnel_port: Option<u16>,
    pub message: Option<String>,
}

impl SshStatus {
    fn disconnected(message: Option<String>) -> Self {
        Self {
            state: "disconnected".to_owned(),
            host: None,
            port: None,
            tunnel_port: None,
            message,
        }
    }
}

struct ActiveTunnel {
    child: Child,
    config: SshConfig,
}

#[derive(Default)]
pub struct SshManager {
    active: Mutex<Option<ActiveTunnel>>,
}

impl SshManager {
    pub fn disconnect(&self) -> Result<(), String> {
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "SSH tunnel state is unavailable".to_owned())?;
        if let Some(mut active) = guard.take() {
            let _ = active.child.kill();
            let _ = active.child.wait();
        }
        Ok(())
    }

    fn status(&self) -> Result<SshStatus, String> {
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "SSH tunnel state is unavailable".to_owned())?;
        let Some(active) = guard.as_mut() else {
            return Ok(SshStatus::disconnected(None));
        };
        match active.child.try_wait() {
            Ok(None) => Ok(SshStatus {
                state: "connected".to_owned(),
                host: Some(active.config.host.clone()),
                port: Some(active.config.port),
                tunnel_port: Some(active.config.tunnel_port),
                message: None,
            }),
            Ok(Some(exit)) => {
                let config = active.config.clone();
                *guard = None;
                Ok(SshStatus {
                    state: "disconnected".to_owned(),
                    host: Some(config.host),
                    port: Some(config.port),
                    tunnel_port: Some(config.tunnel_port),
                    message: Some(format!("SSH tunnel exited with {exit}")),
                })
            }
            Err(error) => Err(format!("cannot inspect SSH tunnel: {error}")),
        }
    }
}

fn resolve_ssh_executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let windows_dir = env::var_os("WINDIR")
            .ok_or_else(|| "WINDIR is unavailable; cannot locate Windows OpenSSH".to_owned())?;
        let candidate = PathBuf::from(windows_dir)
            .join("System32")
            .join("OpenSSH")
            .join("ssh.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
        Err(format!(
            "Windows OpenSSH client was not found at {}",
            candidate.display()
        ))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("ssh"))
    }
}

fn local_ipc_port() -> Result<u16, String> {
    let endpoint = env::var("MAESTRI_SOCKET")
        .map_err(|_| "local Maestri IPC endpoint is unavailable".to_owned())?;
    let (host, port) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| "local Maestri IPC endpoint is invalid".to_owned())?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err("local Maestri IPC endpoint is not loopback-only".to_owned());
    }
    port.parse::<u16>()
        .map_err(|_| "local Maestri IPC port is invalid".to_owned())
}

fn wait_with_timeout(
    child: &mut Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "SSH operation timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cannot wait for SSH process: {error}"));
            }
        }
    }
}

fn await_tunnel_ready(child: &mut Child) -> Result<(), String> {
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "cannot observe SSH tunnel readiness".to_owned())?;
    let (sender, receiver) = mpsc::channel::<String>();
    if let Err(error) = thread::Builder::new()
        .name("maestri-ssh-stderr".to_owned())
        .spawn(move || {
            let mut reporting = true;
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if reporting && sender.send(line).is_err() {
                    reporting = false;
                }
            }
        })
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("cannot start SSH readiness monitor: {error}"));
    }

    let started = Instant::now();
    let mut diagnostics = Vec::new();
    while started.elapsed() < CONNECT_READY_TIMEOUT {
        let exit = match child.try_wait() {
            Ok(exit) => exit,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("cannot inspect SSH tunnel startup: {error}"));
            }
        };
        if let Some(exit) = exit {
            for line in receiver.try_iter() {
                if diagnostics.len() == 12 {
                    diagnostics.remove(0);
                }
                diagnostics.push(line);
            }
            let detail = diagnostics.join(" | ");
            return Err(if detail.is_empty() {
                format!("SSH tunnel exited during startup with {exit}")
            } else {
                format!("SSH tunnel failed: {detail}")
            });
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                if ssh_contract::is_tunnel_ready_line(&line) {
                    return Ok(());
                }
                if diagnostics.len() == 12 {
                    diagnostics.remove(0);
                }
                diagnostics.push(line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    let detail = diagnostics.join(" | ");
    Err(if detail.is_empty() {
        "SSH tunnel did not report forwarding readiness within 12 seconds".to_owned()
    } else {
        format!("SSH tunnel readiness timed out: {detail}")
    })
}

#[tauri::command]
pub fn ssh_probe() -> Result<String, String> {
    resolve_ssh_executable().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ssh_install(config: SshConfig) -> Result<(), String> {
    let contract = config.contract();
    ssh_contract::validate_config(&contract)?;
    let executable = resolve_ssh_executable()?;
    let mut child = Command::new(executable)
        .args(ssh_contract::install_arguments(&contract))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start SSH installer: {error}"))?;
    let script = ssh_contract::installer_script(&contract);
    let send_result = match child.stdin.take() {
        Some(mut input) => input
            .write_all(script.as_bytes())
            .map_err(|error| format!("cannot send SSH installer: {error}")),
        None => Err("cannot open SSH installer input".to_owned()),
    };
    if let Err(error) = send_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let status = wait_with_timeout(&mut child, INSTALL_TIMEOUT)?;
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if !status.success() {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("remote SSH installer exited with {status}")
        } else {
            format!("remote SSH installer failed: {detail}")
        });
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_connect(manager: State<'_, SshManager>, config: SshConfig) -> Result<SshStatus, String> {
    let contract = config.contract();
    ssh_contract::validate_config(&contract)?;
    let local_port = local_ipc_port()?;
    let executable = resolve_ssh_executable()?;
    let mut guard = manager
        .active
        .lock()
        .map_err(|_| "SSH tunnel state is unavailable".to_owned())?;
    if let Some(active) = guard.as_mut() {
        if active
            .child
            .try_wait()
            .map_err(|e| format!("cannot inspect SSH tunnel: {e}"))?
            .is_none()
        {
            return Err("an SSH tunnel is already connected; disconnect it first".to_owned());
        }
        *guard = None;
    }

    let mut child = Command::new(executable)
        .args(ssh_contract::tunnel_arguments(&contract, local_port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start SSH tunnel: {error}"))?;
    await_tunnel_ready(&mut child)?;
    let status = SshStatus {
        state: "connected".to_owned(),
        host: Some(config.host.clone()),
        port: Some(config.port),
        tunnel_port: Some(config.tunnel_port),
        message: None,
    };
    *guard = Some(ActiveTunnel { child, config });
    Ok(status)
}

#[tauri::command]
pub fn ssh_disconnect(manager: State<'_, SshManager>) -> Result<SshStatus, String> {
    manager.disconnect()?;
    Ok(SshStatus::disconnected(None))
}

#[tauri::command]
pub fn ssh_status(manager: State<'_, SshManager>) -> Result<SshStatus, String> {
    manager.status()
}
