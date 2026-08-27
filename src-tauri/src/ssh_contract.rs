#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshContractConfig {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub script_path: String,
    pub tunnel_port: u16,
    pub add_to_path: bool,
}

pub fn validate_config(config: &SshContractConfig) -> Result<(), String> {
    let host = config.host.trim();
    if host.is_empty() || host.len() > 253 {
        return Err("SSH host must contain between 1 and 253 characters".to_owned());
    }
    if host.starts_with('-')
        || host.contains('@')
        || host.chars().any(|c| c.is_control() || c.is_whitespace())
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '%'))
    {
        return Err("SSH host contains unsupported characters".to_owned());
    }

    let user = config.user.trim();
    if user.is_empty()
        || user.len() > 64
        || user.starts_with('-')
        || !user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err("SSH user contains unsupported characters".to_owned());
    }
    if config.port == 0 || config.tunnel_port == 0 {
        return Err("SSH ports must be between 1 and 65535".to_owned());
    }

    let script_path = config.script_path.trim();
    if script_path.is_empty()
        || script_path.len() > 4096
        || !(script_path.starts_with("~/") || script_path.starts_with('/'))
        || script_path.chars().any(|c| {
            c.is_control() || matches!(c, ';' | '|' | '&' | '`' | '$' | '<' | '>' | '\'' | '"')
        })
    {
        return Err(
            "SSH script path must be an absolute POSIX path without shell metacharacters"
                .to_owned(),
        );
    }
    Ok(())
}

pub fn tunnel_arguments(config: &SshContractConfig, local_port: u16) -> Vec<String> {
    vec![
        "-v".to_owned(),
        "-N".to_owned(),
        "-T".to_owned(),
        "-o".to_owned(),
        "StrictHostKeyChecking=accept-new".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ExitOnForwardFailure=yes".to_owned(),
        "-o".to_owned(),
        "GatewayPorts=no".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=10".to_owned(),
        "-R".to_owned(),
        format!("127.0.0.1:{}:127.0.0.1:{local_port}", config.tunnel_port),
        "-p".to_owned(),
        config.port.to_string(),
        format!("{}@{}", config.user.trim(), config.host.trim()),
    ]
}

pub fn is_tunnel_ready_line(line: &str) -> bool {
    line.contains("remote forward success for:")
}

pub fn remote_wrapper(tunnel_port: u16) -> String {
    format!(
        r#"#!/bin/sh
set -eu
: "${{MAESTRI_TERMINAL_ID:?MAESTRI_TERMINAL_ID is required}}"
: "${{MAESTRI_TOKEN:?MAESTRI_TOKEN is required}}"
json_array() {{
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$@" | jq -R . | jq -s .
    return
  fi
  printf '['
  first=1
  for argument do
    if [ "$first" -eq 0 ]; then printf ','; fi
    first=0
    escaped=$(printf '%s' "$argument" | sed \
      -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
      -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g' \
      -e 's/\t/\\t/g' -e 's/\r/\\r/g')
    printf '"%s"' "$escaped"
  done
  printf ']'
}}
payload=$(printf '{{"args":'; json_array "$@"; printf '}}')
exec curl --fail-with-body --silent --show-error --max-time 30 --http1.1 \
  -H 'Content-Type: application/json' \
  -H "X-Terminal-ID: $MAESTRI_TERMINAL_ID" \
  -H "Authorization: Bearer $MAESTRI_TOKEN" \
  --data-binary "$payload" \
  'http://127.0.0.1:{tunnel_port}/cli'
"#
    )
}

pub fn installer_script(config: &SshContractConfig) -> String {
    let wrapper = remote_wrapper(config.tunnel_port);
    format!(
        r##"set -eu
target=$1
add_to_path=$2
case "$target" in
  '~/'*) target="$HOME/${{target#\~/}}" ;;
esac
case "$target" in
  /*) ;;
  *) printf '%s\n' 'script path must resolve to an absolute path' >&2; exit 64 ;;
esac
directory=${{target%/*}}
mkdir -p -- "$directory"
temporary=$(mktemp "${{target}}.tmp.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
cat > "$temporary" <<'OPEN_MAESTRI_WRAPPER'
{wrapper}OPEN_MAESTRI_WRAPPER
chmod 700 -- "$temporary"
mv -f -- "$temporary" "$target"
trap - EXIT HUP INT TERM
if [ "$add_to_path" = 1 ]; then
  marker="# open-maestri managed PATH: $directory"
  profile="$HOME/.profile"
  if ! grep -Fqx "$marker" "$profile" 2>/dev/null; then
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$directory" >> "$profile"
  fi
fi
"##
    )
}

pub fn install_arguments(config: &SshContractConfig) -> Vec<String> {
    vec![
        "-T".to_owned(),
        "-o".to_owned(),
        "StrictHostKeyChecking=accept-new".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=10".to_owned(),
        "-p".to_owned(),
        config.port.to_string(),
        format!("{}@{}", config.user.trim(), config.host.trim()),
        format!(
            "sh -s -- '{}' '{}'",
            config.script_path,
            if config.add_to_path { "1" } else { "0" }
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SshContractConfig {
        SshContractConfig {
            host: "example.test".to_owned(),
            user: "maestri".to_owned(),
            port: 22,
            script_path: "~/.local/bin/omaestri".to_owned(),
            tunnel_port: 7433,
            add_to_path: true,
        }
    }

    #[test]
    fn tunnel_is_loopback_only_and_fails_if_forwarding_cannot_start() {
        let args = tunnel_arguments(&config(), 49152);
        assert_eq!(args.first().map(String::as_str), Some("-v"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "GatewayPorts=no"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-R", "127.0.0.1:7433:127.0.0.1:49152"]));
        assert!(!args.iter().any(|arg| arg.contains("0.0.0.0")));
    }

    #[test]
    fn rejects_option_and_shell_injection_inputs() {
        for host in ["-proxy", "host name", "host;touch /tmp/pwn", "user@host"] {
            let mut value = config();
            value.host = host.to_owned();
            assert!(validate_config(&value).is_err(), "accepted host {host:?}");
        }
        for path in ["relative/omaestri", "~/.local/bin/x;whoami", "~/x$(id)"] {
            let mut value = config();
            value.script_path = path.to_owned();
            assert!(validate_config(&value).is_err(), "accepted path {path:?}");
        }
    }

    #[test]
    fn readiness_requires_open_ssh_forward_success_evidence() {
        assert!(is_tunnel_ready_line(
            "debug1: remote forward success for: listen 127.0.0.1:7433, connect 127.0.0.1:49152"
        ));
        assert!(!is_tunnel_ready_line("debug1: Entering interactive session."));
        assert!(!is_tunnel_ready_line("Warning: remote port forwarding failed for listen port 7433"));
    }

    #[test]
    fn remote_wrapper_requires_session_identity_and_never_embeds_secrets() {
        let wrapper = remote_wrapper(7433);
        assert!(wrapper.contains("MAESTRI_TERMINAL_ID is required"));
        assert!(wrapper.contains("MAESTRI_TOKEN is required"));
        assert!(wrapper.contains("X-Terminal-ID: $MAESTRI_TERMINAL_ID"));
        assert!(wrapper.contains("Authorization: Bearer $MAESTRI_TOKEN"));
        assert!(wrapper.contains("command -v jq"));
        assert!(wrapper.contains("for argument do"));
        assert!(!wrapper.contains("requires jq"));
        assert!(!wrapper.contains("0.0.0.0"));
    }

    #[test]
    fn installer_is_atomic_and_profile_update_is_idempotent() {
        let script = installer_script(&config());
        assert!(script.contains("mktemp"));
        assert!(script.contains("chmod 700"));
        assert!(script.contains("mv -f"));
        assert!(script.contains("grep -Fqx"));
        assert!(script.contains("# open-maestri managed PATH"));
    }
}
