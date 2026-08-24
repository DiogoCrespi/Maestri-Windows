//! Local inter-agent HTTP IPC with ephemeral token authorization.
//!
//! Protocol:
//! POST /cli HTTP/1.0
//! X-Terminal-ID: <terminal id>
//! Authorization: Bearer <ephemeral token>
//! Content-Type: application/json
//! {"args":["list"]}

use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::maestro::{
    new_request_id, MaestroCommand, MaestroConnectPayload, MaestroDismissPayload,
    MaestroRecruitPayload, MaestroRolePayload,
};

pub const MAX_HEADER_BYTES: usize = 32 * 1024;
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Seam interface for Tauri backend.
pub trait IpcBackend: Send + Sync + 'static {
    fn authenticate(&self, terminal_id: &str, credential: &str) -> Result<(), String>;
    fn list(&self, terminal_id: &str) -> String;
    fn check(&self, terminal_id: &str, agent: &str, lines: usize) -> String;
    fn ask(&self, terminal_id: &str, agent: &str, prompt: &str) -> String;
    fn note_read(&self, terminal_id: &str, note_name: &str) -> String;
    fn note_write(&self, terminal_id: &str, note_name: &str, content: &str) -> String;
    fn portal_inspect(&self, terminal_id: &str, portal_name: &str) -> String;
    fn portal_click(&self, terminal_id: &str, portal_name: &str, selector: &str) -> String;
    fn portal_fill(
        &self,
        terminal_id: &str,
        portal_name: &str,
        selector: &str,
        text: &str,
    ) -> String;
    fn portal_eval(&self, terminal_id: &str, portal_name: &str, script: &str) -> String;
    fn portal_navigate(&self, terminal_id: &str, portal_name: &str, url: &str) -> String;
    fn portal_screenshot(
        &self,
        _terminal_id: &str,
        _portal_name: &str,
        _output: Option<&str>,
    ) -> String {
        "error: portal screenshot is unavailable".to_string()
    }
    fn maestro(&self, _terminal_id: &str, _command: MaestroCommand) -> String {
        "error: Maestro Mode is unavailable".to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliRequest {
    pub args: Vec<String>,
    pub terminal_id: Option<String>,
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliResponse {
    pub status: u16,
    pub body: String,
}

impl CliResponse {
    pub fn ok(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            body: body.into(),
        }
    }
    pub fn error(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }
}

pub struct IpcServer {
    listener: TcpListener,
    address: SocketAddr,
    backend: Arc<dyn IpcBackend>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl IpcServer {
    /// Binds the local IPC endpoint. Authentication is delegated to the
    /// backend so credentials can be checked against the current terminal
    /// session rather than a process-wide token.
    pub fn bind_loopback(backend: Arc<dyn IpcBackend>) -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))?;
        let address = listener.local_addr()?;
        Ok(Self {
            listener,
            address,
            backend,
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    pub fn start(mut self) -> io::Result<Self> {
        self.listener.set_nonblocking(true)?;
        let listener = self.listener.try_clone()?;
        listener.set_nonblocking(true)?;
        let backend = Arc::clone(&self.backend);
        let stop = Arc::clone(&self.stop);
        self.worker = Some(thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let backend = Arc::clone(&backend);
                        thread::spawn(move || handle_connection(stream, backend));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        }));
        Ok(self)
    }

    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn handle_connection(mut stream: TcpStream, backend: Arc<dyn IpcBackend>) {
    let _ = stream.set_nonblocking(false);
    let response = match read_request(&mut stream) {
        Ok(request) => {
            if let Err(auth_err) = validate_auth(&request, &*backend) {
                auth_err
            } else {
                match route(request, &*backend) {
                    Ok(res) => res,
                    Err(err) => CliResponse::error(err.status, err.message),
                }
            }
        }
        Err(error) => CliResponse::error(error.status, error.message),
    };
    let _ = write_response(&mut stream, response);
}

fn validate_auth(request: &CliRequest, backend: &dyn IpcBackend) -> Result<(), CliResponse> {
    let terminal_id = request
        .terminal_id
        .as_deref()
        .ok_or_else(|| CliResponse::error(401, "error: missing terminal ID"))?;
    let credential = request
        .auth_token
        .as_deref()
        .ok_or_else(|| CliResponse::error(401, "error: missing authorization token"))?;
    backend
        .authenticate(terminal_id, credential)
        .map_err(|_| CliResponse::error(401, "error: invalid terminal credentials"))
}

#[derive(Debug)]
struct ProtocolError {
    status: u16,
    message: String,
}

impl ProtocolError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<CliRequest, ProtocolError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| ProtocolError::new(408, format!("error: read timeout setup failed: {e}")))?;
    let mut raw = Vec::with_capacity(4096);
    let header_end = loop {
        let mut chunk = [0u8; 8192];
        let count = stream
            .read(&mut chunk)
            .map_err(|e| ProtocolError::new(400, format!("error: read failed: {e}")))?;
        if count == 0 {
            return Err(ProtocolError::new(400, "error: incomplete HTTP request"));
        }
        raw.extend_from_slice(&chunk[..count]);
        if raw.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
            return Err(ProtocolError::new(
                413,
                "error: request exceeds 1 MiB limit",
            ));
        }
        if let Some(index) = find_bytes(&raw, b"\r\n\r\n") {
            if index + 4 > MAX_HEADER_BYTES {
                return Err(ProtocolError::new(
                    431,
                    "error: HTTP headers exceed 32 KiB limit",
                ));
            }
            break index;
        }
        if raw.len() > MAX_HEADER_BYTES {
            return Err(ProtocolError::new(
                431,
                "error: HTTP headers exceed 32 KiB limit",
            ));
        }
    };

    let header_text = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| ProtocolError::new(400, "error: HTTP headers are not UTF-8"))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();
    let version = request_parts.next().unwrap_or_default();
    if method != "POST" {
        return Err(ProtocolError::new(405, "error: only POST is supported"));
    }
    if path != "/cli" {
        return Err(ProtocolError::new(404, "error: route not found"));
    }
    if version != "HTTP/1.0" && version != "HTTP/1.1" {
        return Err(ProtocolError::new(400, "error: unsupported HTTP version"));
    }

    let mut content_length = None;
    let mut terminal_id = None;
    let mut auth_token = None;

    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name_trim = name.trim();
            let value_trim = value.trim();
            if name_trim.eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value_trim
                        .parse::<usize>()
                        .map_err(|_| ProtocolError::new(400, "error: invalid Content-Length"))?,
                );
            } else if name_trim.eq_ignore_ascii_case("x-terminal-id") {
                if !value_trim.is_empty() {
                    terminal_id = Some(value_trim.to_owned());
                }
            } else if name_trim.eq_ignore_ascii_case("authorization") {
                if let Some(token) = value_trim.strip_prefix("Bearer ") {
                    let token = token.trim();
                    if !token.is_empty() {
                        auth_token = Some(token.to_owned());
                    }
                }
            }
        }
    }
    let content_length =
        content_length.ok_or_else(|| ProtocolError::new(400, "error: missing Content-Length"))?;
    if content_length > MAX_BODY_BYTES {
        return Err(ProtocolError::new(
            413,
            "error: request body exceeds 1 MiB limit",
        ));
    }
    let body_start = header_end + 4;
    while raw.len() - body_start < content_length {
        let needed = content_length - (raw.len() - body_start);
        let mut chunk = vec![0u8; needed.min(8192)];
        let count = stream
            .read(&mut chunk)
            .map_err(|e| ProtocolError::new(400, format!("error: body read failed: {e}")))?;
        if count == 0 {
            return Err(ProtocolError::new(400, "error: incomplete request body"));
        }
        raw.extend_from_slice(&chunk[..count]);
    }
    let args = parse_args_json(&raw[body_start..body_start + content_length])
        .map_err(|message| ProtocolError::new(400, message))?;
    Ok(CliRequest {
        args,
        terminal_id,
        auth_token,
    })
}

fn route(request: CliRequest, backend: &dyn IpcBackend) -> Result<CliResponse, ProtocolError> {
    let command = request
        .args
        .first()
        .map(String::as_str)
        .ok_or_else(|| ProtocolError::new(200, "error: empty command"))?;
    if !matches!(
        command,
        "list" | "check" | "ask" | "note" | "portal" | "recruit" | "dismiss" | "connect" | "role"
    ) {
        return Ok(CliResponse::ok(format!(
            "error: unknown command '{command}'. Try 'omaestri list' for available commands."
        )));
    }
    let terminal_id = request
        .terminal_id
        .as_deref()
        .ok_or_else(|| ProtocolError::new(200, "error: missing terminal ID"))?;
    let body = match command {
        "list" => backend.list(terminal_id),
        "check" if request.args.len() >= 2 => {
            let lines = request
                .args
                .get(2)
                .and_then(|value| value.parse().ok())
                .unwrap_or(20);
            backend.check(terminal_id, &request.args[1], lines)
        }
        "ask" if request.args.len() >= 3 => {
            backend.ask(terminal_id, &request.args[1], &request.args[2])
        }
        "note" if request.args.len() >= 3 && request.args[1] == "read" => {
            backend.note_read(terminal_id, &request.args[2])
        }
        "note" if request.args.len() >= 4 && request.args[1] == "write" => {
            backend.note_write(terminal_id, &request.args[2], &request.args[3])
        }
        "portal" if request.args.len() >= 3 && request.args[1] == "inspect" => {
            backend.portal_inspect(terminal_id, &request.args[2])
        }
        "portal" if request.args.len() >= 4 && request.args[1] == "click" => {
            backend.portal_click(terminal_id, &request.args[2], &request.args[3])
        }
        "portal" if request.args.len() >= 5 && request.args[1] == "fill" => {
            backend.portal_fill(
                terminal_id,
                &request.args[2],
                &request.args[3],
                &request.args[4],
            )
        }
        "portal" if request.args.len() >= 4 && request.args[1] == "eval" => {
            backend.portal_eval(terminal_id, &request.args[2], &request.args[3])
        }
        "portal" if request.args.len() >= 4 && request.args[1] == "navigate" => {
            backend.portal_navigate(terminal_id, &request.args[2], &request.args[3])
        }
        "portal"
            if (request.args.len() == 3 || request.args.len() == 4)
                && request.args[1] == "screenshot" =>
        {
            backend.portal_screenshot(
                terminal_id,
                &request.args[2],
                request.args.get(3).map(String::as_str),
            )
        }
        "recruit" | "dismiss" | "connect" | "role" => {
            match parse_maestro_command(&request.args, terminal_id) {
                Ok(command) => backend.maestro(terminal_id, command),
                Err(error) => error,
            }
        }
        "check" => "error: usage: omaestri check \"Agent Name\" [lines]".to_owned(),
        "ask" => "error: usage: omaestri ask \"Agent Name\" \"prompt\"".to_owned(),
        "note" => "error: usage: omaestri note read \"Note Name\" OR omaestri note write \"Note Name\" \"content\"".to_owned(),
        "portal" => "error: usage: omaestri portal <inspect|click|fill|eval|navigate|screenshot> \"Portal Name\" [output.png|args...]".to_owned(),
        _ => unreachable!(),
    };
    Ok(CliResponse::ok(body))
}

fn parse_maestro_command(
    args: &[String],
    source_terminal_id: &str,
) -> Result<MaestroCommand, String> {
    let request_id = new_request_id();
    match args.first().map(String::as_str) {
        Some("recruit") => {
            let name = args.get(1).ok_or_else(|| {
                "error: usage: omaestri recruit NAME [--preset PRESET] [--role ROLE] [--command CMD] [--dir DIR]".to_string()
            })?.clone();
            let mut payload = MaestroRecruitPayload {
                request_id,
                source_terminal_id: source_terminal_id.to_owned(),
                name,
                role: None,
                agent_type: None,
                command: None,
                working_directory: None,
                shell_path: None,
                color: None,
                icon: None,
            };
            let mut index = 2;
            while index < args.len() {
                let option = args[index].as_str();
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("error: option '{option}' requires a value"))?
                    .clone();
                match option {
                    "--preset" => payload.agent_type = Some(value),
                    "--role" => payload.role = Some(value),
                    "--command" => payload.command = Some(value),
                    "--dir" => payload.working_directory = Some(value),
                    _ => return Err(format!("error: unknown recruit option '{option}'")),
                }
                index += 2;
            }
            Ok(MaestroCommand::Recruit(payload))
        }
        Some("dismiss") if args.len() == 2 => Ok(MaestroCommand::Dismiss(MaestroDismissPayload {
            request_id,
            source_terminal_id: source_terminal_id.to_owned(),
            target_terminal_id: args[1].clone(),
        })),
        Some("connect") if args.len() == 3 => Ok(MaestroCommand::Connect(MaestroConnectPayload {
            request_id,
            actor_terminal_id: source_terminal_id.to_owned(),
            source_id: args[1].clone(),
            target_id: args[2].clone(),
            connection_type: None,
        })),
        Some("role") if args.len() == 4 && args[1] == "assign" => {
            Ok(MaestroCommand::Role(MaestroRolePayload {
                request_id,
                source_terminal_id: source_terminal_id.to_owned(),
                target_terminal_id: args[2].clone(),
                role: args[3].clone(),
                instructions: None,
                color: None,
            }))
        }
        Some("dismiss") => Err("error: usage: omaestri dismiss TARGET".to_string()),
        Some("connect") => Err("error: usage: omaestri connect FROM TO".to_string()),
        Some("role") => Err("error: usage: omaestri role assign TARGET ROLE".to_string()),
        _ => Err("error: invalid Maestro command".to_string()),
    }
}

fn write_response(stream: &mut TcpStream, response: CliResponse) -> io::Result<()> {
    let mut body = response.body.into_bytes();
    if body.len() > MAX_RESPONSE_BYTES {
        body = b"error: response exceeds 4 MiB limit".to_vec();
    }
    let reason = match response.status {
        200 => "OK",
        401 => "Unauthorized",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };
    let header = format!("HTTP/1.0 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, reason, body.len());
    stream.write_all(header.as_bytes())?;
    stream.write_all(&body)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_args_json(input: &[u8]) -> Result<Vec<String>, String> {
    let mut parser = JsonParser { input, position: 0 };
    parser.whitespace();
    parser.expect(b'{')?;
    parser.whitespace();
    parser.expect_string_key("args")?;
    parser.whitespace();
    parser.expect(b':')?;
    parser.whitespace();
    let args = parser.string_array()?;
    parser.whitespace();
    parser.expect(b'}')?;
    parser.whitespace();
    if parser.position != input.len() {
        return Err("error: invalid JSON body".into());
    }
    Ok(args)
}

struct JsonParser<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn whitespace(&mut self) {
        while self.position < self.input.len() && self.input[self.position].is_ascii_whitespace() {
            self.position += 1;
        }
    }
    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.input.get(self.position) == Some(&byte) {
            self.position += 1;
            Ok(())
        } else {
            Err("error: invalid JSON body".into())
        }
    }
    fn expect_string_key(&mut self, expected: &str) -> Result<(), String> {
        if self.string()? == expected {
            Ok(())
        } else {
            Err("error: JSON body must contain args".into())
        }
    }
    fn string_array(&mut self) -> Result<Vec<String>, String> {
        self.expect(b'[')?;
        let mut values = Vec::new();
        self.whitespace();
        if self.input.get(self.position) == Some(&b']') {
            self.position += 1;
            return Ok(values);
        }
        loop {
            self.whitespace();
            values.push(self.string()?);
            self.whitespace();
            match self.input.get(self.position) {
                Some(b',') => self.position += 1,
                Some(b']') => {
                    self.position += 1;
                    break;
                }
                _ => return Err("error: args must be an array of strings".into()),
            }
        }
        Ok(values)
    }
    fn string(&mut self) -> Result<String, String> {
        self.expect(b'\"')?;
        let mut value = String::new();
        while self.position < self.input.len() {
            let byte = self.input[self.position];
            self.position += 1;
            match byte {
                b'\"' => return Ok(value),
                b'\\' => {
                    let escaped = *self
                        .input
                        .get(self.position)
                        .ok_or_else(|| "error: invalid JSON string".to_owned())?;
                    self.position += 1;
                    match escaped {
                        b'\"' => value.push('\"'),
                        b'\\' => value.push('\\'),
                        b'/' => value.push('/'),
                        b'b' => value.push('\u{0008}'),
                        b'f' => value.push('\u{000c}'),
                        b'n' => value.push('\n'),
                        b'r' => value.push('\r'),
                        b't' => value.push('\t'),
                        b'u' => {
                            let code = self.hex4()?;
                            value.push(
                                char::from_u32(code as u32)
                                    .ok_or_else(|| "error: invalid Unicode escape".to_owned())?,
                            );
                        }
                        _ => return Err("error: invalid JSON escape".into()),
                    }
                }
                0..=0x1f => return Err("error: control character in JSON string".into()),
                byte if byte < 0x80 => value.push(byte as char),
                byte => {
                    let width = if byte & 0xe0 == 0xc0 {
                        2
                    } else if byte & 0xf0 == 0xe0 {
                        3
                    } else if byte & 0xf8 == 0xf0 {
                        4
                    } else {
                        return Err("error: invalid UTF-8 in JSON string".into());
                    };
                    let start = self.position - 1;
                    let end = start + width;
                    let text = std::str::from_utf8(
                        self.input
                            .get(start..end)
                            .ok_or_else(|| "error: invalid UTF-8 in JSON string".to_owned())?,
                    )
                    .map_err(|_| "error: invalid UTF-8 in JSON string".to_owned())?;
                    value.push_str(text);
                    self.position = end;
                }
            }
        }
        Err("error: unterminated JSON string".into())
    }
    fn hex4(&mut self) -> Result<u16, String> {
        let mut code = 0u16;
        for _ in 0..4 {
            let byte = *self
                .input
                .get(self.position)
                .ok_or_else(|| "error: invalid Unicode escape".to_owned())?;
            self.position += 1;
            code = code
                .checked_mul(16)
                .and_then(|n| n.checked_add((byte as char).to_digit(16)? as u16))
                .ok_or_else(|| "error: invalid Unicode escape".to_owned())?;
        }
        Ok(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Shutdown;

    struct FakeBackend;
    impl IpcBackend for FakeBackend {
        fn authenticate(&self, terminal_id: &str, credential: &str) -> Result<(), String> {
            let valid_pair = matches!(
                (terminal_id, credential),
                ("terminal-1", "secret_token_123")
                    | ("t", "my_token")
                    | ("terminal-uuid", "my_token")
                    | ("manager-1", "my_token")
                    | ("worker-1", "worker-token")
                    | ("term_abc", "secret_cli_token_999")
            );
            if valid_pair {
                Ok(())
            } else {
                Err("invalid test credentials".to_string())
            }
        }

        fn list(&self, terminal_id: &str) -> String {
            format!("list:{terminal_id}")
        }
        fn check(&self, terminal_id: &str, agent: &str, lines: usize) -> String {
            format!("check:{terminal_id}:{agent}:{lines}")
        }
        fn ask(&self, terminal_id: &str, agent: &str, prompt: &str) -> String {
            format!("ask:{terminal_id}:{agent}:{prompt}")
        }
        fn note_read(&self, terminal_id: &str, note_name: &str) -> String {
            format!("note_read:{terminal_id}:{note_name}")
        }
        fn note_write(&self, terminal_id: &str, note_name: &str, content: &str) -> String {
            format!("note_write:{terminal_id}:{note_name}:{content}")
        }
        fn portal_inspect(&self, terminal_id: &str, portal_name: &str) -> String {
            format!("portal_inspect:{terminal_id}:{portal_name}")
        }
        fn portal_click(&self, terminal_id: &str, portal_name: &str, selector: &str) -> String {
            format!("portal_click:{terminal_id}:{portal_name}:{selector}")
        }
        fn portal_fill(
            &self,
            terminal_id: &str,
            portal_name: &str,
            selector: &str,
            text: &str,
        ) -> String {
            format!("portal_fill:{terminal_id}:{portal_name}:{selector}:{text}")
        }
        fn portal_eval(&self, terminal_id: &str, portal_name: &str, script: &str) -> String {
            format!("portal_eval:{terminal_id}:{portal_name}:{script}")
        }
        fn portal_navigate(&self, terminal_id: &str, portal_name: &str, url: &str) -> String {
            format!("portal_navigate:{terminal_id}:{portal_name}:{url}")
        }
        fn portal_screenshot(
            &self,
            terminal_id: &str,
            portal_name: &str,
            output: Option<&str>,
        ) -> String {
            format!(
                "portal_screenshot:{terminal_id}:{portal_name}:{}",
                output.unwrap_or("<temp>")
            )
        }
        fn maestro(&self, terminal_id: &str, command: MaestroCommand) -> String {
            format!("maestro:{terminal_id}:{}", command.request_id())
        }
    }

    fn request_with_auth(
        address: SocketAddr,
        body: &str,
        terminal: Option<&str>,
        auth_token: Option<&str>,
    ) -> String {
        let mut stream = TcpStream::connect(address).unwrap();
        let term_header = terminal
            .map(|id| format!("X-Terminal-ID: {id}\r\n"))
            .unwrap_or_default();
        let auth_header = auth_token
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();

        write!(
            stream,
            "POST /cli HTTP/1.0\r\nHost: maestri\r\n{term_header}{auth_header}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.as_bytes().len()
        )
        .unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).unwrap();
        output
    }

    #[test]
    fn binds_to_loopback_and_routes_list_with_valid_token() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        assert_eq!(server.local_addr().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        let response = request_with_auth(
            server.local_addr(),
            r#"{"args":["list"]}"#,
            Some("terminal-1"),
            Some("secret_token_123"),
        );
        assert!(response.starts_with("HTTP/1.0 200 OK"));
        assert!(response.ends_with("list:terminal-1"));
        server.shutdown();
    }

    #[test]
    fn rejects_missing_and_invalid_auth_token() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        // 1. Missing Token
        let no_token_resp = request_with_auth(
            server.local_addr(),
            r#"{"args":["list"]}"#,
            Some("terminal-1"),
            None,
        );
        assert!(no_token_resp.starts_with("HTTP/1.0 401 Unauthorized"));
        assert!(no_token_resp.contains("error: missing authorization token"));

        // 2. Incorrect Token
        let wrong_token_resp = request_with_auth(
            server.local_addr(),
            r#"{"args":["list"]}"#,
            Some("terminal-1"),
            Some("wrong_token_xyz"),
        );
        assert!(wrong_token_resp.starts_with("HTTP/1.0 401 Unauthorized"));
        assert!(wrong_token_resp.contains("error: invalid terminal credentials"));

        let spoofed_identity_resp = request_with_auth(
            server.local_addr(),
            r#"{"args":["list"]}"#,
            Some("manager-1"),
            Some("worker-token"),
        );
        assert!(spoofed_identity_resp.starts_with("HTTP/1.0 401 Unauthorized"));
        assert!(spoofed_identity_resp.contains("error: invalid terminal credentials"));

        server.shutdown();
    }

    #[test]
    fn routes_check_and_ask_and_preserves_unicode() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        let check = request_with_auth(
            server.local_addr(),
            r#"{"args":["check","Agent","7"]}"#,
            Some("t"),
            Some("my_token"),
        );
        let ask = request_with_auth(
            server.local_addr(),
            r#"{"args":["ask","Agent","olá"]}"#,
            Some("t"),
            Some("my_token"),
        );
        assert!(check.ends_with("check:t:Agent:7"));
        assert!(ask.ends_with("ask:t:Agent:olá"));
        server.shutdown();
    }

    #[test]
    fn routes_note_read_and_write_without_changing_cli_contract() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        let read = request_with_auth(
            server.local_addr(),
            r#"{"args":["note","read","Design"]}"#,
            Some("terminal-uuid"),
            Some("my_token"),
        );
        let write = request_with_auth(
            server.local_addr(),
            r##"{"args":["note","write","Design","# Heading"]}"##,
            Some("terminal-uuid"),
            Some("my_token"),
        );
        assert!(read.ends_with("note_read:terminal-uuid:Design"));
        assert!(write.ends_with("note_write:terminal-uuid:Design:# Heading"));
        server.shutdown();
    }

    #[test]
    fn routes_portal_automation_commands() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        let click = request_with_auth(
            server.local_addr(),
            r#"{"args":["portal","click","Docs","button#run"]}"#,
            Some("terminal-uuid"),
            Some("my_token"),
        );
        let fill = request_with_auth(
            server.local_addr(),
            r#"{"args":["portal","fill","Docs","input[name=\"q\"]","olá"]}"#,
            Some("terminal-uuid"),
            Some("my_token"),
        );
        assert!(click.ends_with("portal_click:terminal-uuid:Docs:button#run"));
        assert!(fill.ends_with("portal_fill:terminal-uuid:Docs:input[name=\"q\"]:olá"));
        server.shutdown();
    }

    #[test]
    fn routes_portal_screenshot_with_optional_output() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        let temporary = request_with_auth(
            server.local_addr(),
            r#"{"args":["portal","screenshot","Docs"]}"#,
            Some("terminal-uuid"),
            Some("my_token"),
        );
        let explicit = request_with_auth(
            server.local_addr(),
            r#"{"args":["portal","screenshot","Docs","capture.png"]}"#,
            Some("terminal-uuid"),
            Some("my_token"),
        );
        assert!(temporary.ends_with("portal_screenshot:terminal-uuid:Docs:<temp>"));
        assert!(explicit.ends_with("portal_screenshot:terminal-uuid:Docs:capture.png"));
        server.shutdown();
    }

    #[test]
    fn parses_maestro_cli_commands_and_rejects_source_mismatch_shape() {
        let recruit = parse_maestro_command(
            &[
                "recruit".into(),
                "Worker".into(),
                "--preset".into(),
                "claude_code".into(),
                "--role".into(),
                "builder".into(),
                "--command".into(),
                "claude".into(),
                "--dir".into(),
                r#"C:\work"#.into(),
            ],
            "manager-id",
        )
        .unwrap();
        assert!(recruit.validate().is_ok());
        match recruit {
            MaestroCommand::Recruit(payload) => {
                assert_eq!(payload.source_terminal_id, "manager-id");
                assert_eq!(payload.command.as_deref(), Some("claude"));
            }
            _ => panic!("expected recruit"),
        }
        let connect = parse_maestro_command(
            &["connect".into(), "Alpha".into(), "Beta".into()],
            "manager-id",
        )
        .unwrap();
        match connect {
            MaestroCommand::Connect(payload) => {
                assert_eq!(payload.actor_terminal_id, "manager-id");
                assert_eq!(payload.source_id, "Alpha");
                assert_eq!(payload.target_id, "Beta");
            }
            _ => panic!("expected connect"),
        }
        assert!(parse_maestro_command(&["connect".into(), "from".into()], "manager-id").is_err());
    }

    #[test]
    fn routes_maestro_command_through_backend() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();
        let response = request_with_auth(
            server.local_addr(),
            r#"{"args":["dismiss","worker-1"]}"#,
            Some("manager-1"),
            Some("my_token"),
        );
        assert!(response.starts_with("HTTP/1.0 200 OK"));
        assert!(response.contains("maestro:manager-1:"));
        server.shutdown();
    }

    #[test]
    fn rejects_missing_terminal_and_oversized_body() {
        let server = IpcServer::bind_loopback(Arc::new(FakeBackend))
            .unwrap()
            .start()
            .unwrap();

        let missing = request_with_auth(
            server.local_addr(),
            r#"{"args":["list"]}"#,
            None,
            Some("my_token"),
        );
        assert!(missing.contains("error: missing terminal ID"));

        let mut stream = TcpStream::connect(server.local_addr()).unwrap();
        write!(
            stream,
            "POST /cli HTTP/1.0\r\nX-Terminal-ID: t\r\nAuthorization: Bearer my_token\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        )
        .unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.0 413"));
        server.shutdown();
    }

    #[test]
    fn parses_json_escapes() {
        assert_eq!(
            parse_args_json(br#"{"args":["a\"b","line\n2"]}"#).unwrap(),
            vec!["a\"b", "line\n2"]
        );
    }
}
