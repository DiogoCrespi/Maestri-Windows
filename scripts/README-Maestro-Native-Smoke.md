# Maestro Mode: native Windows smoke

This smoke is intentionally non-destructive. It only creates or replaces the
fixture path explicitly supplied to the script, starts short-lived CLI probe
processes, and stops only those probe processes. It does not start or stop an
existing Maestri/Tauri instance.

## 1. Preconditions

- Windows PowerShell 5.1 or newer.
- Node/npm and Rust/cargo available, or cargo installed by rustup under the
  standard `%USERPROFILE%\.cargo\bin` location.
- WebView2 runtime available for the native app.
- The working tree is the `Maestri-Windows` project.

The script builds the frontend bundle, the release CLI, and the release Tauri
application. It does not modify source files, Cargo manifests, or the existing
workspace.

## 2. Run the automated preparation

First validate PowerShell parsing only:

```powershell
.\scripts\Invoke-MaestroNativeSmoke.ps1 -SelfTest
```

Then build, verify, probe IPC, and create a fixture. Use a path in `%TEMP%` to
keep generated artifacts outside the repository:

```powershell
$fixture = Join-Path $env:TEMP "open-maestri-maestro-native-smoke.json"
.\scripts\Invoke-MaestroNativeSmoke.ps1 `
  -FixturePath $fixture `
  -ForceFixture `
  -Configuration Release `
  -TimeoutSeconds 30
```

The automated probes perform all of the following:

1. Run `npm run build`.
2. Run release `cargo build` for `src-cli` and `src-tauri`.
3. Verify `omaestri.exe` and `open-maestri-windows.exe` exist.
4. Start a loopback-only HTTP listener and verify a valid Bearer token.
5. Return HTTP 401 for a wrong token and verify the CLI rejects it.
6. Verify the CLI rejects a non-loopback endpoint before connecting.
7. Write and re-read a schemaVersion 2 workspace containing one Manager
   terminal with ID `11111111-1111-4111-8111-111111111111`.

To reuse already-built release binaries:

```powershell
.\scripts\Invoke-MaestroNativeSmoke.ps1 `
  -SkipBuild `
  -FixturePath $fixture `
  -ForceFixture
```

Do not pass `-ForceFixture` unless replacing the named fixture is intended.
The script has a timeout for every child-process/probe operation and cleans up
only the CLI processes it started.

## 3. Open the fixture in the native app

The app currently has no command-line argument contract for opening a specific
workspace, so this one step is deliberately manual:

1. Start the verified `open-maestri-windows.exe` shown by the script.
2. Use **Abrir…** and select the generated fixture JSON.
3. Wait for the `Smoke Manager` terminal to appear and for its ConPTY prompt
   to become interactive.

The fixture's Manager terminal uses `powershell.exe`, the fixture directory as
its working directory, and `isManager: true`. Its UUID is the value printed by
the script. The app supplies `MAESTRI_SOCKET`, `MAESTRI_TOKEN`, and
`MAESTRI_TERMINAL_ID` to that ConPTY.

## 4. Exercise recruit/connect/role/dismiss with two ConPTYs

Run these commands inside the Manager ConPTY. They use only the CLI protocol;
the second ConPTY is created by the recruit action.

### Recruit

```powershell
$recruitJson = omaestri recruit "Smoke Worker" `
  --preset shell `
  --role builder `
  --command "Write-Output worker-ready" `
  --dir "$pwd"
$recruit = $recruitJson | ConvertFrom-Json
$managerId = $env:MAESTRI_TERMINAL_ID
$workerId = $recruit.targetId
if (-not $workerId) { throw "Recruit did not return targetId: $recruitJson" }
```

Expected result: the canvas adds `Smoke Worker`, starts its second ConPTY,
assigns role `builder`, and creates a Manager-to-worker edge. The initial
worker command is `Write-Output worker-ready`; `powershell.exe` remains the
shell executable and is not copied into the command field.

### Connect

Recruit already creates the direct edge. Running connect verifies the
idempotent connect path without creating a duplicate edge:

```powershell
omaestri connect $managerId $workerId
omaestri list
```

The response should be successful and `list` should show the directly
connected worker. To test a new edge instead, create an independent terminal
from the canvas first, capture its UUID, and run `omaestri connect
$managerId $otherTerminalId`; that scenario uses a third ConPTY.

### Role

```powershell
omaestri role assign $workerId reviewer
```

Expected result: the worker remains present and its assigned role changes from
`builder` to `reviewer`. The source is taken from the Manager's
`MAESTRI_TERMINAL_ID`; no source ID is accepted from an unrelated terminal.

### Dismiss

```powershell
omaestri dismiss $workerId
omaestri list
```

Expected result: the worker node and its edge disappear, its ConPTY exits, and
the Manager ConPTY remains active. Confirm that the Manager prompt still
accepts `omaestri list`.

## 5. Failure handling and cleanup

If the script fails, it attempts to stop only the CLI processes recorded from
its own `ProcessStartInfo` objects. It does not call `Stop-Process` by name,
does not terminate the Tauri app, and leaves the fixture for inspection. A
fixture can be removed manually after verifying its exact path, for example:

```powershell
Remove-Item -LiteralPath $fixture
```

The native app and ConPTYs are outside the automated script lifecycle. Close
the app normally after the manual flow; dismiss the worker before closing if
you want to verify the worker lifecycle explicitly.
