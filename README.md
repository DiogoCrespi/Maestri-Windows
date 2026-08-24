# open-maestri Windows

Native Windows scaffold for the GPL-3.0-only open-maestri desktop application.
The existing frontend and `package.json` are intentionally left untouched.

## Scope

This directory uses Tauri 2 for the desktop shell and Rust for native process
and IPC integration. The current native scaffold provides:

- A Windows Tauri application entry point and MSI/NSIS bundling configuration.
- A managed PTY registry backed by `portable-pty` and the existing
  `src-tauri/src/terminal.rs` module.
- Tauri commands: `terminal_create`, `terminal_write`, `terminal_resize`,
  `terminal_stop`, and `terminal_list`.
- A loopback HTTP IPC server and `src-cli` companion for the initial
  `omaestri list`, `check`, and `ask` flow.
- Events: `app://ready`, `terminal://output`, and `terminal://exited`.
- Shutdown cleanup through the terminal registry lifecycle and Tauri process exit.

The PTY implementation lives in `src-tauri/src/terminal.rs`, bounded HTTP in
`ipc.rs`, and composition/lifecycle in `lib.rs`.

## Prerequisites

Install the following on Windows:

1. Node.js LTS and npm.
2. Rust stable through rustup, including Cargo.
3. Visual Studio 2022 Build Tools with **Desktop development with C++**,
   MSVC, and a Windows 10/11 SDK.
4. Microsoft Edge WebView2 Runtime.
5. Tauri CLI, supplied by the existing frontend dev dependency.

Example checks:

```powershell
node --version
npm --version
rustc --version
cargo --version
npm exec tauri -- --version
where.exe cl
where.exe link
where.exe rc
```

If the Tauri CLI is not available from `node_modules`, install dependencies
from this directory first:

```powershell
npm install
```

## Development and verification

Run these commands from `Maestri-Windows`:

```powershell
npm run typecheck
npm run build
npm test
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
npm run tauri dev
```

The release build produces unsigned MSI and NSIS artifacts. The supported
wrapper builds `omaestri.exe`, stages it before bundling, and verifies both
installer targets:

```powershell
.\scripts\Build-MaestriRelease.ps1
Get-ChildItem src-tauri\target\release\bundle -Recurse
Get-FileHash src-tauri\target\release\bundle\msi\*.msi -Algorithm SHA256
Get-FileHash src-tauri\target\release\bundle\nsis\*.exe -Algorithm SHA256
```

The Tauri resource map packages `src-tauri\target\release\omaestri.exe` as
`omaestri.exe` in the application resources for both MSI and NSIS. Validate
that mapping without compiling or opening the application:

```powershell
.\scripts\Build-MaestriRelease.ps1 -ValidateOnly
```

## CLI build and installation

Build and stage the Windows CLI with PowerShell:

```powershell
pwsh -NoProfile -File .\scripts\Build-Omaestri.ps1
pwsh -NoProfile -File .\scripts\Install-Omaestri.ps1
```

The release binary is built at `src-cli\target\release\omaestri.exe` and is
copied by default to `src-tauri\target\release\omaestri.exe`, alongside the
native app release target. An explicit destination can be supplied without
removing anything:

```powershell
pwsh -NoProfile -File .\scripts\Install-Omaestri.ps1 `
  -DestinationDirectory 'C:\Apps\OpenMaestri'
```

The scripts create missing directories and overwrite only the destination
`omaestri.exe`; they do not clean or delete directories. Run PowerShell from
the project root or pass `-ProjectRoot` explicitly. No administrator rights
are required unless the selected destination is protected by Windows.

To use the staged CLI in the current PowerShell session, add its directory to
`PATH`:

```powershell
$cliDirectory = (Resolve-Path .\src-tauri\target\release).Path
$env:Path = "$cliDirectory;$env:Path"
omaestri.exe --help
```

For a persistent PATH entry, add the same directory through Windows User
Environment Variables. Existing terminal processes keep their old PATH, so
open a new terminal after changing it. The app can also launch the binary by
absolute path from this staged directory.

## Native routines + ConPTY smoke

The native smoke creates a disposable workspace, starts the release app,
opens the fixture through Windows UI Automation, runs a persisted command
routine, and verifies `.maestri\routines.json` execution persistence plus
`preRunScript` and command markers written through the Manager ConPTY.

The syntax and fixture checks are GUI-free:

```powershell
.\scripts\Invoke-MaestroRoutineConptySmoke.ps1 -SelfTest
```

Run the interactive native flow:

```powershell
.\scripts\Invoke-MaestroRoutineConptySmoke.ps1 `
  -Configuration Release `
  -TimeoutSeconds 120
```

It requires an interactive Windows desktop, WebView2, and UI Automation
access. The app has no command-line workspace-open contract, so the real flow
uses its native **Abrir…** dialog; `-SelfTest` never starts the app or opens a
GUI. The script only terminates the process tree it started. Use
`-KeepArtifacts` for post-failure inspection.

## IPC contract

Commands are invoked through Tauri's `invoke` API:

| Command | Arguments | Purpose |
|---|---|---|
| `terminal_create` | `id`, `cols`, `rows`, optional `cwd`, `shell` | Starts a session using the requested shell |
| `terminal_write` | `id`, `data` | Writes UTF-8 input to the PTY |
| `terminal_resize` | `id`, `cols`, `rows` | Resizes the terminal |
| `terminal_stop` | `id` | Kills and removes a session |
| `terminal_list` | none | Lists native PTY sessions |

Events are emitted to the Tauri event bus:

- `app://ready`: `{ "version": "...", "platform": "windows" }`
- `terminal://output`: `{ "terminalId": "...", "data": "..." }`
- `terminal://exited`: `{ "terminalId": "...", "code": 0, "signal": null }`

The event listeners must be registered before starting a session. A session
is stopped when the Tauri runtime releases its managed terminal registry at
process exit.

## Security and packaging notes

The shell starts `powershell.exe` by default. A
caller-provided command is executed with the current user privileges, so the
frontend must treat command, arguments, working directory, and environment as
trusted local input. The agent CLI server binds only to `127.0.0.1` on an
ephemeral port. Source terminal validation exists in this first slice; an
instance token and canvas-edge authorization remain hardening work.

The Tauri capability file grants only `core:default`. Add narrower explicit
permissions if future frontend features require filesystem, shell, dialog, or
updater access. Code signing, SmartScreen reputation, installer signing, and
update signing are release responsibilities and are not enabled by this
scaffold.

The release scripts do not sign, publish, upload, or modify PATH. Final release
work still requires a Windows signing certificate, MSI/NSIS signing policy,
SmartScreen reputation work, and a human installation test on a clean machine
with WebView2.

## License

The application is distributed under GPL-3.0-only. See
`THIRD_PARTY_NOTICES.md` for the native scaffold dependency inventory.
