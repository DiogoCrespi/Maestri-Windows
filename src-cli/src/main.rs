use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process;
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const RESPONSE_READ_TIMEOUT: Duration = Duration::from_secs(30);
const ASK_RESPONSE_READ_TIMEOUT: Duration = Duration::from_secs(11 * 60);

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    if matches!(command, "help" | "-h" | "--help") {
        print_help();
        return Ok(());
    }
    validate_args(&args)?;
    let mut args = args;
    absolutize_screenshot_output(&mut args)?;
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "list" => {}
        "check" | "ask" | "reply" | "note" | "portal" | "recruit" | "dismiss" | "connect" | "role" => {}
        _ => unreachable!(),
    }
    let socket = env::var("MAESTRI_SOCKET").map_err(|_| {
        "only available inside open-maestri terminals (MAESTRI_SOCKET not set).".to_owned()
    })?;
    let terminal_id = env::var("MAESTRI_TERMINAL_ID").map_err(|_| {
        "only available inside open-maestri terminals (MAESTRI_TERMINAL_ID not set).".to_owned()
    })?;
    let token = env::var("MAESTRI_TOKEN").map_err(|_| {
        "only available inside open-maestri terminals (MAESTRI_TOKEN not set).".to_owned()
    })?;
    let response = send(&args, &socket, &terminal_id, &token)?;
    print!("{response}");
    if !response.ends_with('\n') {
        println!();
    }
    Ok(())
}

fn absolutize_screenshot_output(args: &mut [String]) -> Result<(), String> {
    if args.len() != 4 || args[0] != "portal" || args[1] != "screenshot" {
        return Ok(());
    }
    let output = PathBuf::from(&args[3]);
    if output.is_relative() {
        let cwd = env::current_dir().map_err(|error| {
            format!("error: cannot resolve terminal working directory: {error}")
        })?;
        args[3] = cwd.join(output).to_string_lossy().into_owned();
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err("error: empty command".into());
    };
    match command {
        // Keep the historical list behavior: extra arguments are ignored by
        // the server, so parsing remains backwards compatible.
        "list" => Ok(()),
        "check" if args.len() >= 2 => Ok(()),
        "ask" if args.len() >= 3 => Ok(()),
        "reply" if args.len() >= 3 => Ok(()),
        "note" if args.len() >= 3 && args[1] == "read" => Ok(()),
        "note" if args.len() >= 4 && args[1] == "write" => Ok(()),
        "portal" if args.len() >= 3 && args[1] == "inspect" => Ok(()),
        "portal" if args.len() >= 4 && args[1] == "click" => Ok(()),
        "portal" if args.len() >= 5 && args[1] == "fill" => Ok(()),
        "portal" if args.len() >= 4 && args[1] == "eval" => Ok(()),
        "portal" if args.len() >= 4 && args[1] == "navigate" => Ok(()),
        "portal"
            if (args.len() == 3 || args.len() == 4) && args[1] == "screenshot" =>
        {
            Ok(())
        }
        "recruit" if args.len() >= 2 => validate_recruit_args(args),
        "dismiss" if args.len() == 2 => Ok(()),
        "connect" if args.len() == 3 => Ok(()),
        "role" if args.len() == 4 && args[1] == "assign" => Ok(()),
        "check" => Err("error: usage: omaestri check \"Agent Name\" [lines]".into()),
        "ask" => Err("error: usage: omaestri ask \"Agent Name\" \"prompt\"".into()),
        "reply" => Err("error: usage: omaestri reply REQUEST_ID \"response\"".into()),
        "note" => Err("error: usage: omaestri note read \"Note Name\" OR omaestri note write \"Note Name\" \"content\"".into()),
        "portal" => Err("error: usage: omaestri portal <inspect|click|fill|eval|navigate|screenshot> \"Portal Name\" [output.png|args...]".into()),
        "recruit" => Err("error: usage: omaestri recruit NAME [--preset PRESET] [--role ROLE] [--command CMD] [--dir DIR]".into()),
        "dismiss" => Err("error: usage: omaestri dismiss TARGET".into()),
        "connect" => Err("error: usage: omaestri connect FROM TO".into()),
        "role" => Err("error: usage: omaestri role assign TARGET ROLE".into()),
        other => Err(format!(
            "error: unknown command '{other}'. Try 'omaestri list' for available commands."
        )),
    }
}

fn validate_recruit_args(args: &[String]) -> Result<(), String> {
    if args.len() < 2 {
        return Err("error: usage: omaestri recruit NAME [--preset PRESET] [--role ROLE] [--command CMD] [--dir DIR]".into());
    }
    if args[1].trim().is_empty() {
        return Err("error: recruit NAME must not be empty".into());
    }
    let mut index = 2;
    while index < args.len() {
        if !matches!(
            args[index].as_str(),
            "--preset" | "--role" | "--command" | "--dir"
        ) {
            return Err(format!("error: unknown recruit option '{}'", args[index]));
        }
        if args.get(index + 1).is_none() {
            return Err(format!("error: option '{}' requires a value", args[index]));
        }
        index += 2;
    }
    Ok(())
}

fn print_help() {
    println!("Maestro: recruit NAME [--preset PRESET] [--role ROLE] [--command CMD] [--dir DIR] | dismiss TARGET | connect FROM TO | role assign TARGET ROLE");
    println!("Maestro connect uses FROM and TO as graph endpoints; the authorized actor is MAESTRI_TERMINAL_ID.");
    println!("omaestri — open-maestri inter-agent CLI\n\nUsage: omaestri <command> [args...]\n\nCommands:\n  list                         List connected agents, notes, portals\n  check \"Agent\" [lines]       View agent recent output\n  ask \"Agent\" \"prompt\"       Send request and wait for the agent reply\n  reply REQUEST_ID \"response\" Complete a pending inter-agent request\n  note read \"Note Name\"       Read content of a connected note\n  note write \"Note\" \"content\" Save content to a connected note\n  portal inspect \"Portal\"     Inspect URL, title, DOM text and inputs\n  portal click \"Portal\" \"sel\"  Click element matching selector\n  portal fill \"P\" \"sel\" \"val\" Fill input matching selector\n  portal eval \"Portal\" \"js\"   Evaluate JavaScript in portal WebView\n  portal navigate \"P\" \"url\"   Navigate portal to new URL\n  portal screenshot \"P\" [output.png]\n                               Capture a PNG of the connected portal WebView\n\nEnvironment:\n  MAESTRI_SOCKET               127.0.0.1:<port>\n  MAESTRI_TERMINAL_ID         Terminal identity sent as X-Terminal-ID\n  MAESTRI_TOKEN               Ephemeral Bearer authentication token");
}

fn send(args: &[String], endpoint: &str, terminal_id: &str, token: &str) -> Result<String, String> {
    let timeout = if args.first().is_some_and(|command| command == "ask") {
        ASK_RESPONSE_READ_TIMEOUT
    } else {
        RESPONSE_READ_TIMEOUT
    };
    send_with_timeout(args, endpoint, terminal_id, token, timeout)
}

fn send_with_timeout(
    args: &[String],
    endpoint: &str,
    terminal_id: &str,
    token: &str,
    read_timeout: Duration,
) -> Result<String, String> {
    let address = parse_endpoint(endpoint)?;
    let body = format!(
        "{{\"args\":[{}]}}",
        args.iter()
            .map(|arg| json_string(arg))
            .collect::<Vec<_>>()
            .join(",")
    );
    if body.as_bytes().len() > MAX_REQUEST_BYTES {
        return Err("error: request exceeds 1 MiB limit".into());
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|e| format!("error: connection failed: {e}\nIs open-maestri running?"))?;
    stream
        .set_read_timeout(Some(read_timeout))
        .map_err(|e| format!("error: socket setup failed: {e}"))?;

    let auth_header = format!("Authorization: Bearer {token}\r\n");

    let header = format!("POST /cli HTTP/1.0\r\nHost: maestri\r\nX-Terminal-ID: {terminal_id}\r\n{auth_header}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.as_bytes().len());
    stream
        .write_all(header.as_bytes())
        .map_err(|e| format!("error: send failed: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .map_err(|e| format!("error: send body failed: {e}"))?;
    let mut raw = Vec::new();
    stream
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| format!("error: receive failed: {e}"))?;
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err("error: response exceeds 4 MiB limit".into());
    }
    parse_response(&raw)
}

fn parse_endpoint(value: &str) -> Result<SocketAddr, String> {
    let value = value.strip_prefix("tcp://").unwrap_or(value);
    let address: SocketAddr = value
        .parse()
        .map_err(|_| "error: MAESTRI_SOCKET must be 127.0.0.1:<port>".to_owned())?;
    if !address.ip().is_loopback() {
        return Err("error: MAESTRI_SOCKET must use loopback (127.0.0.1 or ::1)".into());
    }
    Ok(address)
}

fn parse_response(raw: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(raw).map_err(|_| "error: invalid UTF-8 response".to_owned())?;
    let separator = text
        .find("\r\n\r\n")
        .ok_or_else(|| "error: invalid HTTP response".to_owned())?;
    let headers = &text[..separator];
    let status_line = headers.lines().next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "error: invalid HTTP status".to_owned())?;
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim())
    });
    if let Some(value) = content_length {
        let length = value
            .parse::<usize>()
            .map_err(|_| "error: invalid response Content-Length".to_owned())?;
        if length > MAX_RESPONSE_BYTES {
            return Err("error: response Content-Length exceeds 4 MiB limit".to_owned());
        }
    }

    let body = &text[separator + 4..];
    if body.as_bytes().len() > MAX_RESPONSE_BYTES {
        return Err("error: response body exceeds 4 MiB limit".to_owned());
    }
    if let Some(value) = content_length {
        let length = value
            .parse::<usize>()
            .map_err(|_| "error: invalid response Content-Length".to_owned())?;
        if length != body.as_bytes().len() {
            return Err("error: response body length does not match Content-Length".to_owned());
        }
    }
    if status >= 400 {
        return Err(format!(
            "Request failed (status {status}): {}",
            body.trim_end()
        ));
    }
    if body.trim_start().starts_with("error:") {
        return Err(body.trim_end().to_owned());
    }
    Ok(body.to_owned())
}

fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character < '\u{20}' => {
                output.push_str(&format!("\\u{:04x}", character as u32))
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escapes_arguments() {
        assert_eq!(json_string("a\"\nb"), "\"a\\\"\\nb\"");
    }

    #[test]
    fn validates_note_read_and_write_usage() {
        let read = vec!["note".into(), "read".into(), "Design".into()];
        let write = vec![
            "note".into(),
            "write".into(),
            "Design".into(),
            "# Heading".into(),
        ];
        assert!(validate_args(&read).is_ok());
        assert!(validate_args(&write).is_ok());
        assert!(validate_args(&["note".into(), "read".into()]).is_err());
        assert!(validate_args(&["note".into(), "write".into(), "Design".into()]).is_err());
    }

    #[test]
    fn validates_legacy_terminal_commands_and_rejects_unknown_commands() {
        assert!(validate_args(&["list".into()]).is_ok());
        assert!(validate_args(&["check".into(), "Agent".into()]).is_ok());
        assert!(validate_args(&["ask".into(), "Agent".into(), "hello".into()]).is_ok());
        assert!(validate_args(&["reply".into(), "request-1".into(), "done".into()]).is_ok());
        assert!(validate_args(&["reply".into(), "request-1".into()]).is_err());
        assert!(validate_args(&["wat".into()])
            .unwrap_err()
            .contains("unknown command"));
    }

    #[test]
    fn validates_maestro_command_shapes_and_recruit_options() {
        assert!(validate_args(&["recruit".into(), "Worker".into()]).is_ok());
        assert!(validate_args(&[
            "recruit".into(),
            "Worker".into(),
            "--preset".into(),
            "claude_code".into(),
            "--role".into(),
            "builder".into(),
        ])
        .is_ok());
        assert!(validate_args(&["recruit".into(), "Worker".into(), "--role".into()]).is_err());
        assert!(validate_args(&["dismiss".into(), "Worker".into()]).is_ok());
        assert!(validate_args(&["connect".into(), "From".into(), "To".into()]).is_ok());
        assert!(validate_args(&[
            "role".into(),
            "assign".into(),
            "Worker".into(),
            "builder".into(),
        ])
        .is_ok());
    }

    #[test]
    fn validates_portal_command_shapes() {
        assert!(validate_args(&["portal".into(), "inspect".into(), "Docs".into()]).is_ok());
        assert!(validate_args(&[
            "portal".into(),
            "click".into(),
            "Docs".into(),
            "button#run".into(),
        ])
        .is_ok());
        assert!(validate_args(&[
            "portal".into(),
            "fill".into(),
            "Docs".into(),
            "input".into(),
            "olá".into(),
        ])
        .is_ok());
        assert!(validate_args(&["portal".into(), "click".into(), "Docs".into()]).is_err());
        assert!(validate_args(&["portal".into(), "unknown".into(), "Docs".into()]).is_err());
    }

    #[test]
    fn validates_portal_screenshot_with_optional_output() {
        assert!(validate_args(&["portal".into(), "screenshot".into(), "Docs".into()]).is_ok());
        assert!(validate_args(&[
            "portal".into(),
            "screenshot".into(),
            "Docs".into(),
            "capture.png".into(),
        ])
        .is_ok());
        assert!(validate_args(&[
            "portal".into(),
            "screenshot".into(),
            "Docs".into(),
            "capture.png".into(),
            "extra".into(),
        ])
        .is_err());
        assert!(validate_args(&["portal".into(), "screenshot".into()]).is_err());
    }

    #[test]
    fn absolutizes_relative_portal_screenshot_output_from_terminal_cwd() {
        let mut args = vec![
            "portal".to_owned(),
            "screenshot".to_owned(),
            "Docs".to_owned(),
            "capture.png".to_owned(),
        ];
        absolutize_screenshot_output(&mut args).unwrap();
        assert!(std::path::Path::new(&args[3]).is_absolute());
        assert!(args[3].ends_with("capture.png"));
    }

    #[test]
    fn endpoint_must_be_loopback() {
        assert!(parse_endpoint("127.0.0.1:1234").is_ok());
        assert!(parse_endpoint("tcp://[::1]:1234").is_ok());
        assert!(parse_endpoint("192.168.1.2:1234").is_err());
    }

    #[test]
    fn response_parser_returns_only_body() {
        let response = b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok";
        assert_eq!(parse_response(response).unwrap(), "ok");
        assert!(parse_response(b"HTTP/1.0 500 Error\r\n\r\nno").is_err());
    }

    #[test]
    fn response_parser_rejects_error_bodies_and_oversized_content_length() {
        assert!(parse_response(b"HTTP/1.0 200 OK\r\n\r\nerror: denied").is_err());
        assert!(parse_response(
            b"HTTP/1.0 400 Bad Request\r\nContent-Length: 13\r\n\r\nerror: denied"
        )
        .is_err());
        assert!(parse_response(b"HTTP/1.0 200 OK\r\nContent-Length: 4194305\r\n\r\n").is_err());
    }

    #[test]
    fn send_has_finite_read_timeout() {
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(150));
        });

        let error = send_with_timeout(
            &["list".to_owned()],
            &address.to_string(),
            "term_abc",
            "secret_cli_token_999",
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert!(error.starts_with("error: receive failed:"));
        handle.join().unwrap();
    }

    #[test]
    fn send_includes_bearer_auth_token_header_when_provided() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut headers = String::new();
            let mut content_len = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" {
                    break;
                }
                if line.to_lowercase().starts_with("content-length:") {
                    if let Some(val) = line.split(':').nth(1) {
                        content_len = val.trim().parse::<usize>().unwrap_or(0);
                    }
                }
                headers.push_str(&line);
            }
            if content_len > 0 {
                let mut body = vec![0u8; content_len];
                let _ = reader.read_exact(&mut body);
            }
            assert!(headers.contains("Authorization: Bearer secret_cli_token_999\r\n"));
            assert!(headers.contains("X-Terminal-ID: term_abc\r\n"));

            let resp = "HTTP/1.0 200 OK\r\nContent-Length: 7\r\n\r\nsuccess";
            let mut stream = reader.into_inner();
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        });

        let args = vec!["list".to_string()];
        let res = send(&args, &addr.to_string(), "term_abc", "secret_cli_token_999");
        assert_eq!(res.unwrap(), "success");

        handle.join().unwrap();
    }
}
