#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [string]$FixturePath = "",
    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 30,
    [switch]$SkipBuild,
    [switch]$ForceFixture,
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$scriptDirectory = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}

$startedProcesses = New-Object System.Collections.ArrayList
$fixtureWasCreated = $false

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[maestro-smoke] $Message" -ForegroundColor Cyan
}

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Test-ScriptSyntax {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $PSCommandPath,
        [ref]$tokens,
        [ref]$parseErrors
    ) | Out-Null
    Assert-Condition ($parseErrors.Count -eq 0) "PowerShell syntax errors: $($parseErrors | Out-String)"
    Write-Step "PowerShell syntax validation passed."
}

function Resolve-Executable {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Fallbacks = @()
    )
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        return $command.Source
    }
    foreach ($candidate in $Fallbacks) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "Executable not found: $Name"
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )
    Write-Step $Description
    & $FilePath @Arguments | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Get-Tooling {
    $cargoFallback = @()
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $cargoFallback += (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")
    }
    [pscustomobject]@{
        Cargo = Resolve-Executable -Name "cargo.exe" -Fallbacks $cargoFallback
        Npm = Resolve-Executable -Name "npm.cmd" -Fallbacks @()
    }
}

function Invoke-BuildAndVerify {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$BuildConfiguration,
        [Parameter(Mandatory = $true)]$Tools
    )
    $release = $BuildConfiguration -eq "Release"
    $cargoMode = if ($release) { @("--release") } else { @() }
    $targetName = $BuildConfiguration.ToLowerInvariant()

    Invoke-Checked -FilePath $Tools.Npm -Arguments @("run", "build") -Description "Building frontend production bundle"
    Invoke-Checked -FilePath $Tools.Cargo -Arguments (@("build", "--manifest-path", (Join-Path $Root "src-cli\Cargo.toml"), "--target-dir", (Join-Path $Root "src-cli\target")) + $cargoMode) -Description "Building omaestri CLI ($BuildConfiguration)"
    Invoke-Checked -FilePath $Tools.Cargo -Arguments (@("build", "--manifest-path", (Join-Path $Root "src-tauri\Cargo.toml"), "--target-dir", (Join-Path $Root "src-tauri\target")) + $cargoMode) -Description "Building native Tauri app ($BuildConfiguration)"

    $cliPath = Join-Path $Root "src-cli\target\$targetName\omaestri.exe"
    $appPath = Join-Path $Root "src-tauri\target\$targetName\open-maestri-windows.exe"
    Assert-Condition (Test-Path -LiteralPath $cliPath -PathType Leaf) "CLI binary was not produced: $cliPath"
    Assert-Condition (Test-Path -LiteralPath $appPath -PathType Leaf) "App binary was not produced: $appPath"
    Write-Step "Verified CLI: $cliPath"
    Write-Step "Verified app: $appPath"
    return [pscustomobject]@{ CliPath = $cliPath; AppPath = $appPath }
}

function New-WorkspaceFixture {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][bool]$Overwrite
    )
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $resolvedPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if ((Test-Path -LiteralPath $resolvedPath) -and -not $Overwrite) {
        throw "Fixture already exists; pass -ForceFixture to replace only this file: $resolvedPath"
    }

    $managerId = "11111111-1111-4111-8111-111111111111"
    $workspaceId = "22222222-2222-4222-8222-222222222222"
    $timestamp = [DateTime]::UtcNow.ToString("o")
    $terminalContent = [ordered]@{
        agentType = "shell"
        command = ""
        name = "Smoke Manager"
        icon = "terminal"
        color = "#3b82f6"
        id = $managerId
        shellPath = "powershell.exe"
        workingDirectory = $WorkingDirectory
        status = "idle"
        isManager = $true
        monitorWithOmbro = $false
        autoScrollLocked = $false
        shortcutMode = [ordered]@{ kind = "automatic" }
        scrollbackLineCount = 0
    }
    $node = [ordered]@{
        id = $managerId
        frame = @(@(0, 0), @(450, 320))
        content = [ordered]@{ terminal = [ordered]@{ _0 = $terminalContent } }
        zIndex = 0
        isLocked = $false
        createdAt = $timestamp
        lastModifiedAt = $timestamp
    }
    $payload = [ordered]@{
        id = $workspaceId
        name = "Maestro Native Smoke"
        icon = "folder"
        isPinned = $false
        locationType = "local"
        workingDirectory = $WorkingDirectory
        preferredIDE = "cursor"
        syncConfigFiles = $false
        canvasOrigin = [ordered]@{ x = 0; y = 0 }
        canvasZoom = 1
        nodes = @($node)
        connections = @()
        noteConnections = @()
        portalConnections = @()
        portalToPortalConnections = @()
        noteToNoteConnections = @()
        crossFloorConnections = @()
        floors = @()
        drawings = @()
        createdAt = $timestamp
        lastModifiedAt = $timestamp
    }
    $document = [ordered]@{ schemaVersion = 2; type = "workspace"; payload = $payload }
    $json = $document | ConvertTo-Json -Depth 30
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($resolvedPath, $json, $utf8NoBom)
    $script:fixtureWasCreated = $true

    $parsed = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
    Assert-Condition ($parsed.schemaVersion -eq 2 -and $parsed.type -eq "workspace") "Fixture schema identity is invalid."
    Assert-Condition ($parsed.payload.nodes.Count -eq 1) "Fixture must contain exactly one Manager terminal."
    Assert-Condition ($parsed.payload.nodes[0].content.terminal._0.isManager -eq $true) "Fixture terminal is not marked as Manager."
    Assert-Condition ($parsed.payload.nodes[0].content.terminal._0.id -eq $managerId) "Fixture Manager ID is inconsistent."
    Write-Step "Prepared fixture: $resolvedPath"
    Write-Step "Manager terminal ID: $managerId"
    return [pscustomobject]@{ Path = $resolvedPath; ManagerId = $managerId }
}

function Read-IpcRequest {
    param([Parameter(Mandatory = $true)][System.Net.Sockets.NetworkStream]$Stream)
    $reader = New-Object System.IO.StreamReader($Stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)
    $requestLine = $reader.ReadLine()
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($requestLine)) "IPC probe received no request line."
    $headers = @{}
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line.Length -eq 0) { break }
        $separator = $line.IndexOf(":")
        if ($separator -gt 0) {
            $headers[$line.Substring(0, $separator).Trim().ToLowerInvariant()] = $line.Substring($separator + 1).Trim()
        }
    }
    $length = 0
    if ($headers.ContainsKey("content-length")) {
        $length = [int]$headers["content-length"]
    }
    Assert-Condition ($length -ge 0 -and $length -le (1024 * 1024)) "IPC probe received an invalid body size."
    $chars = New-Object char[] $length
    $offset = 0
    while ($offset -lt $length) {
        $read = $reader.Read($chars, $offset, $length - $offset)
        if ($read -le 0) { throw "IPC probe received an incomplete body." }
        $offset += $read
    }
    [pscustomobject]@{
        RequestLine = $requestLine
        Headers = $headers
        Body = [string]::new($chars)
    }
}

function Invoke-CliTokenProbe {
    param(
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$SuppliedToken,
        [Parameter(Mandatory = $true)][string]$ExpectedToken,
        [Parameter(Mandatory = $true)][bool]$ExpectSuccess,
        [Parameter(Mandatory = $true)][int]$Timeout
    )
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $client = $null
    $process = $null
    try {
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $acceptTask = $listener.AcceptTcpClientAsync()
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $CliPath
        $psi.Arguments = "list"
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.EnvironmentVariables["MAESTRI_SOCKET"] = "127.0.0.1:$port"
        $psi.EnvironmentVariables["MAESTRI_TERMINAL_ID"] = "11111111-1111-4111-8111-111111111111"
        $psi.EnvironmentVariables["MAESTRI_TOKEN"] = $SuppliedToken
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $psi
        [void]$process.Start()
        [void]$startedProcesses.Add($process)

        Assert-Condition $acceptTask.Wait($Timeout * 1000) "CLI did not connect to the loopback IPC probe within ${Timeout}s."
        $client = $acceptTask.Result
        $stream = $client.GetStream()
        $stream.ReadTimeout = $Timeout * 1000
        $request = Read-IpcRequest -Stream $stream
        Assert-Condition ($request.RequestLine -eq "POST /cli HTTP/1.0") "CLI IPC request line was unexpected: $($request.RequestLine)"
        Assert-Condition ($request.Headers["x-terminal-id"] -eq "11111111-1111-4111-8111-111111111111") "CLI did not send the expected terminal ID."
        Assert-Condition ($request.Body -match '"args"\s*:\s*\[\s*"list"\s*\]') "CLI IPC body did not contain the list command."
        $authorized = $request.Headers["authorization"] -eq "Bearer $ExpectedToken"
        $status = if ($authorized) { 200 } else { 401 }
        $reason = if ($authorized) { "OK" } else { "Unauthorized" }
        $responseBody = if ($authorized) { "smoke-ok" } else { "error: invalid authorization token" }
        $response = "HTTP/1.0 $status $reason`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($responseBody))`r`nConnection: close`r`n`r`n$responseBody"
        $responseBytes = [Text.Encoding]::UTF8.GetBytes($response)
        $stream.Write($responseBytes, 0, $responseBytes.Length)
        $stream.Flush()
        # The CLI reads until EOF; close the probe connection after the full
        # HTTP response so the child can finish deterministically.
        $client.Close()
        $client = $null

        Assert-Condition ($process.WaitForExit($Timeout * 1000)) "CLI did not exit after the IPC probe response."
        $stderr = $process.StandardError.ReadToEnd()
        if ($ExpectSuccess) {
            Assert-Condition ($process.ExitCode -eq 0) "Valid-token CLI probe failed: $stderr"
            Assert-Condition ($process.StandardOutput.ReadToEnd().Trim() -eq "smoke-ok") "Valid-token CLI response was unexpected."
        } else {
            Assert-Condition ($process.ExitCode -ne 0) "Invalid-token CLI probe unexpectedly succeeded."
            Assert-Condition ($stderr -match "status 401") "Invalid-token CLI error did not report HTTP 401: $stderr"
        }
    } finally {
        if ($client) { $client.Close() }
        $listener.Stop()
        if ($process) {
            try {
                if (-not $process.HasExited) { $process.Kill() }
            } catch { }
        }
    }
}

function Invoke-LoopbackRejectionProbe {
    param(
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][int]$Timeout
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $CliPath
    $psi.Arguments = "list"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables["MAESTRI_SOCKET"] = "192.0.2.1:6553"
    $psi.EnvironmentVariables["MAESTRI_TERMINAL_ID"] = "11111111-1111-4111-8111-111111111111"
    $psi.EnvironmentVariables["MAESTRI_TOKEN"] = "smoke-token"
    $process = New-Object System.Diagnostics.Process
    try {
        $process.StartInfo = $psi
        [void]$process.Start()
        [void]$startedProcesses.Add($process)
        Assert-Condition ($process.WaitForExit($Timeout * 1000)) "Loopback rejection probe timed out."
        $stderr = $process.StandardError.ReadToEnd()
        Assert-Condition ($process.ExitCode -ne 0 -and $stderr -match "loopback") "CLI accepted a non-loopback endpoint: $stderr"
    } finally {
        try {
            if (-not $process.HasExited) { $process.Kill() }
        } catch { }
    }
}

function Stop-StartedProcesses {
    foreach ($process in @($startedProcesses)) {
        try {
            if ($process -and -not $process.HasExited) { $process.Kill() }
        } catch { }
    }
}

try {
    Test-ScriptSyntax
    if ($SelfTest) { return }

    if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
        $ProjectRoot = Split-Path -Parent $scriptDirectory
    }
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
    Assert-Condition (Test-Path -LiteralPath (Join-Path $root "src-tauri\Cargo.toml") -PathType Leaf) "Tauri manifest not found under $root"
    Assert-Condition (Test-Path -LiteralPath (Join-Path $root "src-cli\Cargo.toml") -PathType Leaf) "CLI manifest not found under $root"
    $tools = Get-Tooling
    $target = if ($FixturePath.Trim()) { $FixturePath } else { Join-Path $root "scripts\artifacts\maestro-native-smoke\workspace-manager.json" }
    $workingDirectory = $root

    if (-not $SkipBuild) {
        $binaries = Invoke-BuildAndVerify -Root $root -BuildConfiguration $Configuration -Tools $tools
    } else {
        $targetName = $Configuration.ToLowerInvariant()
        $binaries = [pscustomobject]@{
            CliPath = Join-Path $root "src-cli\target\$targetName\omaestri.exe"
            AppPath = Join-Path $root "src-tauri\target\$targetName\open-maestri-windows.exe"
        }
        Assert-Condition (Test-Path -LiteralPath $binaries.CliPath -PathType Leaf) "CLI binary missing with -SkipBuild: $($binaries.CliPath)"
        Assert-Condition (Test-Path -LiteralPath $binaries.AppPath -PathType Leaf) "App binary missing with -SkipBuild: $($binaries.AppPath)"
    }

    $fixture = New-WorkspaceFixture -Path $target -WorkingDirectory $workingDirectory -Overwrite ([bool]$ForceFixture)
    $token = "smoke-" + [Guid]::NewGuid().ToString("N")
    $wrongToken = "wrong-" + [Guid]::NewGuid().ToString("N")
    Write-Step "Validating loopback IPC with a valid token."
    Invoke-CliTokenProbe -CliPath $binaries.CliPath -SuppliedToken $token -ExpectedToken $token -ExpectSuccess $true -Timeout $TimeoutSeconds
    Write-Step "Validating token rejection with HTTP 401."
    Invoke-CliTokenProbe -CliPath $binaries.CliPath -SuppliedToken $wrongToken -ExpectedToken $token -ExpectSuccess $false -Timeout $TimeoutSeconds
    Write-Step "Validating non-loopback endpoint rejection."
    Invoke-LoopbackRejectionProbe -CliPath $binaries.CliPath -Timeout $TimeoutSeconds
    Write-Step "Smoke preparation completed successfully."
    Write-Host "Fixture: $($fixture.Path)" -ForegroundColor Green
    Write-Host "App:     $($binaries.AppPath)" -ForegroundColor Green
    Write-Host "CLI:     $($binaries.CliPath)" -ForegroundColor Green
    Write-Host "Next: read scripts/README-Maestro-Native-Smoke.md for the two-ConPTY flow." -ForegroundColor Yellow
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-StartedProcesses
}
