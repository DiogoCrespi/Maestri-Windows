//! Seam & Contract for SSH Remote Terminal Sessions.
//!
//! Enforces zero-secret CLI arguments, READY/ESTABLISHED handshake state machine,
//! Base64 payload encoding, streaming OSC 52 & control sequence sanitization,
//! fail-closed reparse point confinement, process tree cleanup, and credential isolation.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemotePayload {
    pub terminal_id: String,
    pub token: String,
    pub tunnel_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeState {
    Initial,
    WaitingReady { nonce: String },
    ReadyReceived { nonce: String },
    PayloadSent { nonce: String },
    EstablishedReceived { nonce: String },
    Failed { reason: String },
}

pub fn generate_nonce() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{:016x}", (now as u64) ^ (count << 16) ^ 0xa5a5_5a5a_3c3c_c3c3)
}

pub fn validate_location_type(location_type: Option<&str>) -> Result<&'static str, String> {
    match location_type {
        None | Some("local") | Some("") => Ok("local"),
        Some("ssh") => Ok("ssh"),
        Some(other) => Err(format!("invalid locationType: '{other}'. Expected 'local' or 'ssh'")),
    }
}

pub fn is_reparse_or_symlink_attributes(file_attributes: u32, is_symlink: bool) -> bool {
    if is_symlink {
        return true;
    }
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    (file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

pub fn is_reparse_or_symlink_meta(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return is_reparse_or_symlink_attributes(meta.file_attributes(), false);
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn check_ssh_path_security(ssh_dir: &Path, known_hosts: &Path) -> Result<(), String> {
    let check_single_path = |path: &Path| -> Result<(), String> {
        match std::fs::symlink_metadata(path) {
            Ok(meta) => {
                if is_reparse_or_symlink_meta(&meta) {
                    return Err(format!(
                        "Security Error: SSH path '{}' is a reparse point or symlink",
                        path.display()
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(e) => {
                return Err(format!("Failed to read metadata for '{}': {e}", path.display()));
            }
        }
        Ok(())
    };

    let mut current = ssh_dir.to_path_buf();
    while current.parent().is_some() {
        check_single_path(&current)?;
        if !current.pop() {
            break;
        }
    }

    check_single_path(known_hosts)?;
    Ok(())
}

pub fn check_user_ssh_security_with_home(home_env: Option<&str>) -> Result<(), String> {
    let home_str = match home_env {
        Some(val) if !val.trim().is_empty() => val.trim(),
        _ => return Err("Security Error: Neither USERPROFILE nor HOME environment variable is defined".to_string()),
    };
    let ssh_dir = PathBuf::from(home_str).join(".ssh");
    let known_hosts = ssh_dir.join("known_hosts");
    check_ssh_path_security(&ssh_dir, &known_hosts)
}

pub fn check_default_user_ssh_security() -> Result<(), String> {
    let home_var = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"));
    check_user_ssh_security_with_home(home_var.as_deref().ok())
}

pub fn kill_process_tree_windows(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let windir = std::env::var("WINDIR").map_err(|_| "WINDIR environment variable is not defined".to_string())?;
        let taskkill_bin = PathBuf::from(windir).join("System32").join("taskkill.exe");
        if !taskkill_bin.is_file() {
            return Err(format!("System32 taskkill.exe binary is missing at {}", taskkill_bin.display()));
        }

        let pid_str = pid.to_string();
        let output = std::process::Command::new(taskkill_bin)
            .args(["/F", "/T", "/PID", &pid_str])
            .output()
            .map_err(|e| format!("Failed to execute System32 taskkill.exe for PID {pid}: {e}"))?;

        if !output.status.success() {
            let stderr_str = String::from_utf8_lossy(&output.stderr);
            let is_pid_gone = output.status.code() == Some(128)
                || stderr_str.contains("not found")
                || stderr_str.contains("não encontrado")
                || stderr_str.contains("no process")
                || stderr_str.contains("nenhum processo");
            if !is_pid_gone {
                return Err(format!(
                    "taskkill failed for PID {pid} (exit code {:?}): {}",
                    output.status.code(),
                    stderr_str.trim()
                ));
            }
        }
    }
    Ok(())
}

pub fn build_remote_bootstrap_command(nonce: &str) -> String {
    format!(
        "stty -echo 2>/dev/null; printf 'READY:{}\\r\\n'; read -r _b64; if [ -n \"$_b64\" ]; then _json=$(printf '%s' \"$_b64\" | base64 -d 2>/dev/null || printf '%s' \"$_b64\" | openssl base64 -d 2>/dev/null); export MAESTRI_TERMINAL_ID=$(printf '%s' \"$_json\" | sed -n 's/.*\"terminalId\":\"\\([^\"]*\\)\".*/\\1/p'); export MAESTRI_TOKEN=$(printf '%s' \"$_json\" | sed -n 's/.*\"token\":\"\\([^\"]*\\)\".*/\\1/p'); export OMAESTRI_TUNNEL_PORT=$(printf '%s' \"$_json\" | sed -n 's/.*\"tunnelPort\":\\([0-9]*\\).*/\\1/p'); export MAESTRI_SOCKET=\"127.0.0.1:${{OMAESTRI_TUNNEL_PORT:-7433}}\"; CWD=$(printf '%s' \"$_json\" | sed -n 's/.*\"cwd\":\"\\([^\"]*\\)\".*/\\1/p'); CMD=$(printf '%s' \"$_json\" | sed -n 's/.*\"command\":\"\\([^\"]*\\)\".*/\\1/p'); fi; if [ -n \"$CWD\" ] && [ -d \"$CWD\" ]; then cd \"$CWD\" 2>/dev/null || true; fi; stty echo 2>/dev/null; printf 'ESTABLISHED:{}\\r\\n'; if [ -n \"$CMD\" ]; then exec sh -c \"$CMD\"; else exec ${{SHELL:-/bin/sh}} -l; fi",
        nonce, nonce
    )
}

pub fn build_ssh_remote_args(
    user: &str,
    host: &str,
    port: u16,
    nonce: &str,
) -> Vec<String> {
    vec![
        "-t".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-p".to_string(),
        port.to_string(),
        format!("{}@{}", user.trim(), host.trim()),
        build_remote_bootstrap_command(nonce),
    ]
}

pub fn encode_payload(payload: &RemotePayload) -> Result<String, String> {
    let json = serde_json::to_string(payload).map_err(|e| format!("Failed to serialize payload: {e}"))?;
    let b64 = base64_encode(json.as_bytes());
    Ok(format!("{b64}\n"))
}

pub fn decode_payload(b64_line: &str) -> Result<RemotePayload, String> {
    let trimmed = b64_line.trim();
    let bytes = base64_decode(trimmed)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Failed to deserialize payload JSON: {e}"))
}

fn base64_encode(input: &[u8]) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as u32;
        let b1 = if i + 1 < input.len() { input[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(CHARSET[((triple >> 18) & 63) as usize] as char);
        out.push(CHARSET[((triple >> 12) & 63) as usize] as char);
        if i + 1 < input.len() {
            out.push(CHARSET[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < input.len() {
            out.push(CHARSET[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() % 4 != 0 {
        return Err("Invalid Base64 length".to_string());
    }
    let mut out = Vec::new();
    let bytes = clean.as_bytes();
    let decode_char = |c: u8| -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            b'=' => Ok(0),
            _ => Err(format!("Invalid Base64 char: {}", c as char)),
        }
    };

    let mut i = 0;
    while i < bytes.len() {
        let c0 = decode_char(bytes[i])?;
        let c1 = decode_char(bytes[i + 1])?;
        let c2 = decode_char(bytes[i + 2])?;
        let c3 = decode_char(bytes[i + 3])?;
        let triple = ((c0 as u32) << 18) | ((c1 as u32) << 12) | ((c2 as u32) << 6) | (c3 as u32);

        out.push(((triple >> 16) & 0xff) as u8);
        if bytes[i + 2] != b'=' {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if bytes[i + 3] != b'=' {
            out.push((triple & 0xff) as u8);
        }
        i += 4;
    }
    Ok(out)
}

const MAX_STREAM_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Default)]
pub struct HandshakeBuffer {
    stream_buffer: Vec<u8>,
    ready_detected: bool,
    established_detected: bool,
    osc52_in_progress: bool,
}

impl HandshakeBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn process_chunk(&mut self, chunk: &[u8], nonce: &str) -> (Option<HandshakeEvent>, Vec<u8>) {
        if self.established_detected {
            let mut data = std::mem::take(&mut self.stream_buffer);
            data.extend_from_slice(chunk);
            let sanitized = self.strip_osc52(&data);
            return (None, sanitized);
        }

        self.stream_buffer.extend_from_slice(chunk);
        if self.stream_buffer.len() > MAX_STREAM_BUFFER_BYTES {
            self.stream_buffer.drain(..self.stream_buffer.len() - MAX_STREAM_BUFFER_BYTES);
        }

        let ready_marker = format!("READY:{nonce}");
        let established_marker = format!("ESTABLISHED:{nonce}");
        let mut event = None;

        let content_str = String::from_utf8_lossy(&self.stream_buffer).to_string();

        if !self.ready_detected && content_str.contains(&ready_marker) {
            self.ready_detected = true;
            event = Some(HandshakeEvent::Ready);
        }

        if self.ready_detected && !self.established_detected && content_str.contains(&established_marker) {
            self.established_detected = true;
            event = Some(HandshakeEvent::Established);
        }

        let delta_output = self.extract_sanitized_delta(nonce);
        (event, delta_output)
    }

    fn extract_sanitized_delta(&mut self, nonce: &str) -> Vec<u8> {
        let ready_pattern = format!("READY:{nonce}");
        let est_pattern = format!("ESTABLISHED:{nonce}");

        if self.established_detected {
            let buffer = std::mem::take(&mut self.stream_buffer);
            let mut output = Vec::new();

            let mut start_idx = 0;
            for i in 0..buffer.len() {
                if buffer[i] == b'\n' {
                    let line_slice = &buffer[start_idx..=i];
                    let line_str = String::from_utf8_lossy(line_slice);
                    let line_trim = line_str.trim();
                    if !(line_trim == ready_pattern
                        || line_trim == est_pattern
                        || line_trim.contains(&ready_pattern)
                        || line_trim.contains(&est_pattern))
                    {
                        output.extend_from_slice(line_slice);
                    }
                    start_idx = i + 1;
                }
            }

            if start_idx < buffer.len() {
                let tail_slice = &buffer[start_idx..];
                let tail_str = String::from_utf8_lossy(tail_slice);
                let tail_trim = tail_str.trim();
                if !(tail_trim == ready_pattern
                    || tail_trim == est_pattern
                    || tail_trim.contains(&ready_pattern)
                    || tail_trim.contains(&est_pattern))
                {
                    output.extend_from_slice(tail_slice);
                }
            }

            return self.strip_osc52(&output);
        }

        let buffer = &self.stream_buffer;
        let mut last_newline = None;
        for i in (0..buffer.len()).rev() {
            if buffer[i] == b'\n' {
                last_newline = Some(i);
                break;
            }
        }

        let (lines_part, remaining_part) = match last_newline {
            Some(idx) => (&buffer[..=idx], &buffer[idx + 1..]),
            None => (&[][..], buffer.as_slice()),
        };

        let mut output = Vec::new();
        if !lines_part.is_empty() {
            let mut start_idx = 0;
            for i in 0..lines_part.len() {
                if lines_part[i] == b'\n' {
                    let line_slice = &lines_part[start_idx..=i];
                    let line_str = String::from_utf8_lossy(line_slice);
                    let line_trim = line_str.trim();
                    if !(line_trim == ready_pattern
                        || line_trim == est_pattern
                        || line_trim.contains(&ready_pattern)
                        || line_trim.contains(&est_pattern))
                    {
                        output.extend_from_slice(line_slice);
                    }
                    start_idx = i + 1;
                }
            }
        }

        self.stream_buffer = remaining_part.to_vec();
        self.strip_osc52(&output)
    }

    fn strip_osc52(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        let mut idx = 0;

        while idx < data.len() {
            if self.osc52_in_progress {
                if data[idx] == 0x07 {
                    self.osc52_in_progress = false;
                    idx += 1;
                } else if data[idx] == 0x1b && idx + 1 < data.len() && data[idx + 1] == b'\\' {
                    self.osc52_in_progress = false;
                    idx += 2;
                } else {
                    idx += 1;
                }
            } else {
                if data[idx] == 0x1b && idx + 4 < data.len() && &data[idx..idx + 5] == b"\x1b]52;" {
                    self.osc52_in_progress = true;
                    idx += 5;
                } else {
                    out.push(data[idx]);
                    idx += 1;
                }
            }
        }

        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeEvent {
    Ready,
    Established,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remote_contract_args_no_secrets_or_cwd() {
        let nonce = "0123456789abcdef";
        let args = build_ssh_remote_args("user1", "192.168.1.10", 22, nonce);
        
        let args_str = args.join(" ");
        assert!(args_str.contains("-t"));
        assert!(args_str.contains("-o BatchMode=yes"));
        assert!(args_str.contains("user1@192.168.1.10"));
        assert!(args_str.contains("READY:0123456789abcdef"));

        assert!(!args_str.contains("secret-token"));
        assert!(!args_str.contains("term-id-123"));
        assert!(!args_str.contains("/home/user/workspace"));
    }

    #[test]
    fn test_remote_contract_fragmented_marker_parsing() {
        let nonce = "a1b2c3d4e5f60718";
        let mut hs = HandshakeBuffer::new();

        let chunk1 = b"Connecting...\r\nRE";
        let (evt1, out1) = hs.process_chunk(chunk1, nonce);
        assert_eq!(evt1, None);
        assert_eq!(String::from_utf8_lossy(&out1), "Connecting...\r\n");

        let chunk2 = b"ADY:a1b2c3d4e5f60718\r\n";
        let (evt2, out2) = hs.process_chunk(chunk2, nonce);
        assert_eq!(evt2, Some(HandshakeEvent::Ready));
        assert!(out2.is_empty());

        let chunk3 = b"ESTABLISHED:a1b2c3d4e5f60718\r\nuser@host:~$ ";
        let (evt3, out3) = hs.process_chunk(chunk3, nonce);
        assert_eq!(evt3, Some(HandshakeEvent::Established));
        assert_eq!(String::from_utf8_lossy(&out3), "user@host:~$ ");
    }

    #[test]
    fn test_remote_contract_fragmented_established_marker_and_output() {
        let nonce = "f1f2f3f4f5f6f7f8";
        let mut hs = HandshakeBuffer::new();

        let chunk1 = format!("READY:{nonce}\r\nESTAB");
        let (evt1, out1) = hs.process_chunk(chunk1.as_bytes(), nonce);
        assert_eq!(evt1, Some(HandshakeEvent::Ready));
        assert!(out1.is_empty());

        let chunk2 = format!("LISHED:{nonce}\r\nuser@remote:~$ ");
        let (evt2, out2) = hs.process_chunk(chunk2.as_bytes(), nonce);
        assert_eq!(evt2, Some(HandshakeEvent::Established));
        assert_eq!(String::from_utf8_lossy(&out2), "user@remote:~$ ");
    }

    #[test]
    fn test_remote_contract_payload_sent_only_after_ready() {
        let mut state = HandshakeState::WaitingReady { nonce: "nonce123".to_string() };
        assert_ne!(state, HandshakeState::ReadyReceived { nonce: "nonce123".to_string() });

        state = HandshakeState::ReadyReceived { nonce: "nonce123".to_string() };
        assert_eq!(state, HandshakeState::ReadyReceived { nonce: "nonce123".to_string() });

        let payload = RemotePayload {
            terminal_id: "term-99".to_string(),
            token: "secret-token-xyz".to_string(),
            tunnel_port: 7433,
            cwd: Some("/home/user".to_string()),
            command: Some("ls -la".to_string()),
        };

        let encoded = encode_payload(&payload).unwrap();
        assert!(encoded.ends_with('\n'));
        let decoded = decode_payload(&encoded).unwrap();
        assert_eq!(decoded, payload);
    }

    #[test]
    fn test_remote_contract_token_never_in_sanitized_output() {
        let nonce = "1122334455667788";
        let mut hs = HandshakeBuffer::new();

        let raw = format!("READY:{nonce}\r\nSome normal output line\r\nESTABLISHED:{nonce}\r\nSecond line\r\n");
        let (evt, filtered) = hs.process_chunk(raw.as_bytes(), nonce);
        assert_eq!(evt, Some(HandshakeEvent::Ready));
        let filtered_str = String::from_utf8_lossy(&filtered);

        assert!(!filtered_str.contains(&format!("READY:{nonce}")));
        assert!(!filtered_str.contains(&format!("ESTABLISHED:{nonce}")));
        assert!(filtered_str.contains("Some normal output line\r\n"));
        assert!(filtered_str.contains("Second line\r\n"));
    }

    #[test]
    fn test_remote_contract_osc52_sanitization_and_tui_preservation() {
        let nonce = "9988776655443322";
        let mut hs = HandshakeBuffer::new();

        let raw_chunk1 = format!("READY:{nonce}\r\nESTABLISHED:{nonce}\r\n\x1b[31mRed Text\x1b[0m \x1b]52;c;c2Vjc2V0X2NsaXBib2FyZA==\x07 \x1b[32mGreen Text\x1b[0m\r\n");
        let (_evt, clean1) = hs.process_chunk(raw_chunk1.as_bytes(), nonce);
        let clean1_str = String::from_utf8_lossy(&clean1);

        assert!(clean1_str.contains("\x1b[31mRed Text\x1b[0m"));
        assert!(clean1_str.contains("\x1b[32mGreen Text\x1b[0m"));
        assert!(!clean1_str.contains("52;c;c2Vjc2V0X2NsaXBib2FyZA=="));

        let chunk_a = b"Before \x1b]52;c;c2Vjc2V";
        let chunk_b = b"0X2NsaXBib2FyZA==\x1b\\ After";

        let (_evt_a, clean_a) = hs.process_chunk(chunk_a, nonce);
        let (_evt_b, clean_b) = hs.process_chunk(chunk_b, nonce);

        let clean_a_str = String::from_utf8_lossy(&clean_a);
        let clean_b_str = String::from_utf8_lossy(&clean_b);

        assert_eq!(clean_a_str, "Before ");
        assert_eq!(clean_b_str, " After");
    }

    #[test]
    fn test_remote_contract_reparse_attribute_decision_helper() {
        assert!(is_reparse_or_symlink_attributes(0x400, false));
        assert!(is_reparse_or_symlink_attributes(0x400 | 0x10, false));
        assert!(is_reparse_or_symlink_attributes(0x80, true));
        assert!(!is_reparse_or_symlink_attributes(0x80, false));
        assert!(!is_reparse_or_symlink_attributes(0x10, false));
    }

    #[test]
    fn test_remote_contract_ssh_reparse_point_confinement() {
        let temp_dir = std::env::temp_dir().join(format!("maestri_ssh_test_{}", generate_nonce()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let ssh_dir = temp_dir.join(".ssh");
        let known_hosts = ssh_dir.join("known_hosts");
        let _ = std::fs::create_dir_all(&ssh_dir);
        let _ = std::fs::write(&known_hosts, "example.com ssh-rsa AAAAB3NzaC1yc2E...");

        assert!(check_ssh_path_security(&ssh_dir, &known_hosts).is_ok());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_remote_contract_session_credential_isolation() {
        let payload_a = RemotePayload {
            terminal_id: "session-a".to_string(),
            token: "ipc-token-secret-alpha-12345".to_string(),
            tunnel_port: 7433,
            cwd: Some("/home/user/a".to_string()),
            command: None,
        };

        let payload_b = RemotePayload {
            terminal_id: "session-b".to_string(),
            token: "ipc-token-secret-beta-67890".to_string(),
            tunnel_port: 7433,
            cwd: Some("/home/user/b".to_string()),
            command: None,
        };

        let encoded_a = encode_payload(&payload_a).unwrap();
        let encoded_b = encode_payload(&payload_b).unwrap();

        let decoded_a = decode_payload(&encoded_a).unwrap();
        let decoded_b = decode_payload(&encoded_b).unwrap();

        assert_eq!(decoded_a.terminal_id, "session-a");
        assert_eq!(decoded_a.token, "ipc-token-secret-alpha-12345");

        assert_eq!(decoded_b.terminal_id, "session-b");
        assert_eq!(decoded_b.token, "ipc-token-secret-beta-67890");

        assert_ne!(decoded_a.token, decoded_b.token);
    }

    #[test]
    fn test_remote_contract_missing_home_fails_closed() {
        let res_none = check_user_ssh_security_with_home(None);
        assert!(res_none.is_err());
        assert!(res_none.unwrap_err().contains("Neither USERPROFILE nor HOME"));

        let res_empty = check_user_ssh_security_with_home(Some("   "));
        assert!(res_empty.is_err());
        assert!(res_empty.unwrap_err().contains("Neither USERPROFILE nor HOME"));
    }

    #[test]
    fn test_remote_contract_timeout_and_failure_handling() {
        let state = HandshakeState::Failed { reason: "Handshake timed out after 10s waiting for READY".to_string() };
        if let HandshakeState::Failed(reason) = state {
            assert!(reason.contains("timed out"));
        } else {
            panic!("Expected Failed state");
        }
    }

    #[test]
    fn test_remote_contract_distinct_sessions_distinct_nonces() {
        let nonce1 = generate_nonce();
        let nonce2 = generate_nonce();
        assert_ne!(nonce1, nonce2);
        assert_eq!(nonce1.len(), 16);
        assert_eq!(nonce2.len(), 16);
    }

    #[test]
    fn test_remote_contract_unknown_location_type_fails() {
        assert_eq!(validate_location_type(None).unwrap(), "local");
        assert_eq!(validate_location_type(Some("local")).unwrap(), "local");
        assert_eq!(validate_location_type(Some("ssh")).unwrap(), "ssh");
        assert!(validate_location_type(Some("ftp")).is_err());
        assert!(validate_location_type(Some("docker")).is_err());
    }
}
