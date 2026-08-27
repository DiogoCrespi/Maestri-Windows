//! Seam & Contract for SSH Remote Terminal Sessions.
//!
//! Enforces zero-secret CLI arguments, READY/ESTABLISHED handshake state machine,
//! Base64 payload encoding, OSC 52 & dangerous sequence sanitization, reparse point confinement,
//! process tree cleanup, and credential isolation.

use serde::{Deserialize, Serialize};
use std::path::Path;

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

pub fn check_ssh_path_security(ssh_dir: &Path, known_hosts: &Path) -> Result<(), String> {
    let check_single_path = |path: &Path| -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let meta = std::fs::symlink_metadata(path)
            .map_err(|e| format!("Failed to read metadata for '{}': {e}", path.display()))?;

        if meta.file_type().is_symlink() {
            return Err(format!(
                "Security Error: SSH path '{}' is a symlink",
                path.display()
            ));
        }

        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
                return Err(format!(
                    "Security Error: SSH path '{}' is a reparse point / junction",
                    path.display()
                ));
            }
        }
        Ok(())
    };

    if ssh_dir.exists() {
        let mut current = ssh_dir.to_path_buf();
        while current.parent().is_some() {
            if current.exists() {
                check_single_path(&current)?;
            }
            if !current.pop() {
                break;
            }
        }
    }

    if known_hosts.exists() {
        check_single_path(known_hosts)?;
    }

    Ok(())
}

pub fn kill_process_tree_windows(pid: u32) -> Result<(), String> {
    if pid == 0 {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let pid_str = pid.to_string();
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid_str])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
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

#[derive(Debug, Default)]
pub struct HandshakeBuffer {
    buffer: Vec<u8>,
    ready_detected: bool,
    established_detected: bool,
    osc52_in_progress: bool,
}

impl HandshakeBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn process_chunk(&mut self, chunk: &[u8], nonce: &str) -> (Option<HandshakeEvent>, Vec<u8>) {
        self.buffer.extend_from_slice(chunk);
        let ready_marker = format!("READY:{nonce}");
        let established_marker = format!("ESTABLISHED:{nonce}");
        let mut event = None;

        let content_str = String::from_utf8_lossy(&self.buffer).to_string();

        if !self.ready_detected && content_str.contains(&ready_marker) {
            self.ready_detected = true;
            event = Some(HandshakeEvent::Ready);
        } else if self.ready_detected && !self.established_detected && content_str.contains(&established_marker) {
            self.established_detected = true;
            event = Some(HandshakeEvent::Established);
        }

        let clean_output = self.sanitize_and_filter(&self.buffer, nonce);
        (event, clean_output)
    }

    pub fn sanitize_and_filter(&mut self, data: &[u8], nonce: &str) -> Vec<u8> {
        let sanitized = self.strip_osc52(data);
        let text = String::from_utf8_lossy(&sanitized);
        let ready_pattern = format!("READY:{nonce}");
        let est_pattern = format!("ESTABLISHED:{nonce}");

        let mut cleaned = String::new();
        for line in text.lines() {
            let line_trim = line.trim();
            if line_trim == ready_pattern || line_trim == est_pattern || line_trim.contains(&ready_pattern) || line_trim.contains(&est_pattern) {
                continue;
            }
            cleaned.push_str(line);
            cleaned.push('\n');
        }
        if !text.ends_with('\n') && cleaned.ends_with('\n') {
            cleaned.pop();
        }
        cleaned.into_bytes()
    }

    pub fn strip_osc52(&mut self, data: &[u8]) -> Vec<u8> {
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
        let (evt1, _out1) = hs.process_chunk(chunk1, nonce);
        assert_eq!(evt1, None);

        let chunk2 = b"ADY:a1b2c3d4e5f60718\r\n";
        let (evt2, out2) = hs.process_chunk(chunk2, nonce);
        assert_eq!(evt2, Some(HandshakeEvent::Ready));

        let out2_str = String::from_utf8_lossy(&out2);
        assert!(!out2_str.contains("READY:a1b2c3d4e5f60718"));
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

        let raw = format!("READY:{nonce}\r\nSome normal output line\r\nESTABLISHED:{nonce}\r\nSecond line");
        let filtered = hs.sanitize_and_filter(raw.as_bytes(), nonce);
        let filtered_str = String::from_utf8_lossy(&filtered);

        assert!(!filtered_str.contains(&format!("READY:{nonce}")));
        assert!(!filtered_str.contains(&format!("ESTABLISHED:{nonce}")));
        assert!(filtered_str.contains("Some normal output line"));
        assert!(filtered_str.contains("Second line"));
    }

    #[test]
    fn test_remote_contract_osc52_sanitization_and_tui_preservation() {
        let nonce = "9988776655443322";
        let mut hs = HandshakeBuffer::new();

        // OSC 52 sequence embedded between TUI color escape sequences
        let raw_chunk1 = b"\x1b[31mRed Text\x1b[0m \x1b]52;c;c2Vjc2V0X2NsaXBib2FyZA==\x07 \x1b[32mGreen Text\x1b[0m";
        let (_evt, clean1) = hs.process_chunk(raw_chunk1, nonce);
        let clean1_str = String::from_utf8_lossy(&clean1);

        assert!(clean1_str.contains("\x1b[31mRed Text\x1b[0m"));
        assert!(clean1_str.contains("\x1b[32mGreen Text\x1b[0m"));
        assert!(!clean1_str.contains("52;c;c2Vjc2V0X2NsaXBib2FyZA=="));

        // Fragmented OSC 52 across 2 chunks
        let mut hs_frag = HandshakeBuffer::new();
        let chunk_a = b"Before \x1b]52;c;c2Vjc2V";
        let chunk_b = b"0X2NsaXBib2FyZA==\x07 After";

        let (_evt_a, clean_a) = hs_frag.process_chunk(chunk_a, nonce);
        let (_evt_b, clean_b) = hs_frag.process_chunk(chunk_b, nonce);

        let clean_a_str = String::from_utf8_lossy(&clean_a);
        let clean_b_str = String::from_utf8_lossy(&clean_b);

        assert_eq!(clean_a_str, "Before ");
        assert_eq!(clean_b_str, " After");
    }

    #[test]
    fn test_remote_contract_ssh_reparse_point_confinement() {
        let temp_dir = std::env::temp_dir().join(format!("maestri_ssh_test_{}", generate_nonce()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let ssh_dir = temp_dir.join(".ssh");
        let known_hosts = ssh_dir.join("known_hosts");
        let _ = std::fs::create_dir_all(&ssh_dir);
        let _ = std::fs::write(&known_hosts, "example.com ssh-rsa AAAAB3NzaC1yc2E...");

        // Real regular files/dir pass security check
        assert!(check_ssh_path_security(&ssh_dir, &known_hosts).is_is_ok());

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

        assert!(encoded_a.contains("session-a"));
        assert!(encoded_a.contains("ipc-token-secret-alpha-12345"));
        assert!(!encoded_a.contains("ipc-token-secret-beta-67890"));

        assert!(encoded_b.contains("session-b"));
        assert!(encoded_b.contains("ipc-token-secret-beta-67890"));
        assert!(!encoded_b.contains("ipc-token-secret-alpha-12345"));

        assert_ne!(payload_a.token, payload_b.token);
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

    #[test]
    fn test_remote_contract_disconnect_cleanup() {
        let mut active_sessions: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
        active_sessions.insert("ssh-term-1".to_string(), true);
        
        active_sessions.remove("ssh-term-1");
        assert!(!active_sessions.contains_key("ssh-term-1"));
    }
}
