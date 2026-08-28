# Open Maestri for Windows

Open Maestri is a local-first Windows workspace for coordinating AI agents,
interactive shells, notes, files, web portals, routines, Git worktrees, and
remote SSH sessions on a spatial canvas.

This Windows implementation uses Tauri 2, React, TypeScript, Rust, WebView2,
and ConPTY. It is GPL-3.0-only and does not require login, mandatory telemetry,
or a hosted Maestri service.

## Project status

The main product workflow and the advanced Windows parity features are
implemented:

- Persistent spatial canvas with pan, zoom, selection, drag, resize, snapping,
  duplication, minimap, edges, and editable text, shape, and freehand content.
- Real PowerShell, Windows PowerShell, `cmd.exe`, WSL, and custom shell sessions
  through ConPTY, including input, incremental output, resize, lifecycle,
  persisted scrollback, command, arguments, environment, and working directory.
- macOS-compatible `workspace.json` schema v2 with atomic saves, autosave,
  last-workspace restoration, unknown-field preservation, and deterministic
  legacy-ID migration.
- Markdown notes backed by files, a local file tree with list/grid modes, file
  preview/editing, and drag-to-terminal paths.
- Native WebView2 portal nodes with navigation, isolated sessions, DOM
  inspection, click, fill, JavaScript evaluation, and PNG screenshots.
- Graph-authorized `omaestri.exe` communication between connected terminals,
  notes, and portals.
- Maestro Mode with recruit, connect, dismiss, role assignment, presets, and
  correlated acknowledgements.
- Workspace-scoped routines with once/every/daily/weekly schedules, IANA
  timezones, limits, pre-run scripts, manual execution, and persisted state.
- Floors backed by safely confined Git worktrees, including setup/run/teardown
  hooks and guarded landing.
- Remote SSH preferences, secure wrapper installation, reverse loopback tunnel,
  interactive remote terminal sessions through System32 OpenSSH, real
  connection-state tracking, and controlled shutdown.
- Remote-terminal hardening with a zero-secret stdin handshake, fail-closed
  `known_hosts` reparse-point checks, process-tree cleanup, and streaming OSC 52
  filtering that preserves normal ANSI/TUI output.
- Unsigned MSI and NSIS release packaging with the companion CLI included.

The remaining release work is primarily full native regression testing on a
clean Windows machine, installer signing/SmartScreen reputation, and enabling
shared Portal sessions derived from Portal-to-Portal connections. Portal
sessions are currently isolated by default.

## Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop | Tauri 2 | Native window, IPC, lifecycle, dialogs, and packaging |
| Frontend | React + TypeScript | Canvas, nodes, project manager, preferences, and workflows |
| Canvas | `@xyflow/react` | Infinite viewport, nodes, handles, and connections |
| Terminal | `@xterm/xterm` | VT/ANSI terminal rendering and input |
| Native backend | Rust | ConPTY, persistence, access graph, routines, portals, Floors, and SSH |
| Agent CLI | Rust | `omaestri.exe` commands over authenticated loopback HTTP |

The frontend talks to native services through a `DesktopBridge`, keeping the
canvas testable in a browser preview. Native IPC listens only on loopback. Each
ConPTY session receives its own CNG-generated credential, and every CLI request
is checked against both the terminal identity and the current canvas access
graph.

## Requirements

- Windows 10 version 1903 or later, or Windows 11.
- Node.js and npm.
- Rust 1.88 or later through rustup, including Cargo.
- Visual Studio 2022 Build Tools with **Desktop development with C++**, MSVC,
  and a Windows 10/11 SDK.
- Microsoft Edge WebView2 Runtime.
- Windows OpenSSH Client for Remote SSH features.

Check the local toolchain:

```powershell
node --version
npm --version
rustc --version
cargo --version
npm exec tauri -- --version
where.exe cl
where.exe link
where.exe rc
where.exe ssh
```

## Development

From the repository root:

```powershell
npm install
npm run tauri dev
```

Run the web preview without native services:

```powershell
npm run dev
```

The browser preview provides deterministic fallbacks for UI development. Real
ConPTY, WebView2, filesystem, Floors, routines, and SSH behavior requires the
Tauri application.

## Verification

Frontend checks:

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Rust checks:

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml --check
cargo check --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-cli\Cargo.toml
```

Dedicated native gates:

```powershell
.\scripts\Invoke-NativeBackendHarness.ps1
.\scripts\Invoke-FloorBackendHarness.ps1
.\scripts\Invoke-SshBackendHarness.ps1
.\scripts\Invoke-RemoteTerminalHarness.ps1
.\scripts\Invoke-MaestroRoutineConptySmoke.ps1 -SelfTest
```

The native gate scripts fail when Windows or Rust prerequisites are missing.
Skipping requires an explicit `-AllowSkip` where supported, so CI cannot report
a false green accidentally.

## Workspace format and local state

Open Maestri reads and writes schema-v2 `workspace.json` files compatible with
the macOS application. Workspace-specific runtime state is stored under the
project directory:

```text
workspace.json
notes\
.maestri\routines.json
.maestri\scrollback\
```

Global presets, roles, recent projects, and SSH preferences are stored outside
the workspace. SSH credentials are not persisted in `workspace.json` or in the
remote wrapper.

## `omaestri` CLI

The app injects `MAESTRI_SOCKET`, `MAESTRI_TERMINAL_ID`, and a per-session
`MAESTRI_TOKEN` into managed terminal processes. The companion CLI uses those
values automatically:

```powershell
omaestri list
omaestri check "Worker" 100
omaestri ask "Worker" "Run the tests and summarize failures"
omaestri reply "<request-id>" "Tests passed; summary returned to the requester"
omaestri note read "Plan"
omaestri note write "Plan" "Updated status"
omaestri portal inspect "Docs"
omaestri portal click "Docs" "button[type=submit]"
omaestri portal fill "Docs" "input[name=q]" "Tauri"
omaestri portal navigate "Docs" "https://tauri.app"
omaestri portal screenshot "Docs" ".\docs.png"
omaestri recruit "Reviewer" --preset "Codex" --role "Review the implementation"
omaestri connect "Reviewer" "Plan"
omaestri role assign "Reviewer" "Security Auditor"
omaestri dismiss "Reviewer"
```

Targets may be addressed by unambiguous name or UUID. Commands are limited to
nodes directly authorized by canvas connections; unknown, ambiguous,
disconnected, stale, or spoofed identities are rejected.

`omaestri ask` is a request-response operation. It injects a correlated request
into the target terminal and waits for that target to complete it with
`omaestri reply REQUEST_ID "response"`. The response is returned directly to
the requesting terminal; workspace files are not used as the reply channel.
Only the requested target terminal can complete the pending request, and an
unanswered request times out after ten minutes.

## Release build

Build the CLI, frontend, Tauri application, MSI, NSIS installer, and portable
ZIP:

```powershell
.\scripts\Build-MaestriRelease.ps1
Get-ChildItem release
```

The `release` directory contains three end-user options:

- `Open-Maestri-Windows-v0.1.0-Setup.exe`: recommended per-user installer.
- `Open-Maestri-Windows-v0.1.0.msi`: alternative Windows Installer package.
- `Open-Maestri-Windows-v0.1.0-portable.zip`: extract and double-click
  `Open Maestri.exe`; keep the bundled `omaestri.exe` beside it.

`SHA256SUMS.txt` contains the SHA-256 digest for every distributable artifact.

Validate the resource and bundle configuration without compiling:

```powershell
.\scripts\Build-MaestriRelease.ps1 -ValidateOnly
```

Build or install only the CLI:

```powershell
.\scripts\Build-Omaestri.ps1
.\scripts\Install-Omaestri.ps1
```

The release scripts do not publish artifacts, modify the user's persistent
`PATH`, or sign binaries. Production distribution still requires a Windows
code-signing certificate and installation testing on a clean machine.

## Security boundaries

- HTTP IPC binds to `127.0.0.1` on an ephemeral port.
- Credentials are generated per terminal session and revoked on stop, exit,
  restart, or replacement.
- Canvas connections define which terminals, notes, and portals a caller can
  access.
- Note paths are confined to the workspace `notes` directory and reject
  traversal, UNC/device paths, ADS, symlinks, junctions, and hardlinks.
- Floor worktrees are confined to their expected root and validate repository,
  branch, and dirty state before landing.
- SSH uses `%WINDIR%\System32\OpenSSH\ssh.exe` directly with batch mode,
  strict host-key handling, loopback-only reverse forwarding, and no shell
  interpolation of connection parameters.
- Portal automation enforces timeouts and payload limits; sensitive input
  metadata is redacted.

Commands and hooks intentionally run with the current user's privileges. Treat
workspace files, shell commands, hook scripts, imported preferences, and remote
hosts as trusted local input.

## License

Open Maestri for Windows is distributed under GPL-3.0-only. Dependency notices
are listed in `THIRD_PARTY_NOTICES.md`.
