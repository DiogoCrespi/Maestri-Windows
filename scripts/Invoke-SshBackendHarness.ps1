<# Strict native gate for the Windows SSH backend and pure security contract. #>
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [switch]$SelfTest,
    [switch]$AllowSkip,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Exit-WithCode {
    param([int]$Code)
    if ($Host.Name -eq "ConsoleHost") { exit $Code }
    $host.SetShouldExit($Code)
    exit $Code
}

function Invoke-GatedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $Executable
    $processInfo.Arguments = $Arguments
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processInfo
    if (-not $process.Start()) { throw "$Label process failed to start" }
    $processId = $process.Id
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            throw "$Label exceeded the $TimeoutSeconds second timeout"
        }
    } finally {
        if (-not $process.HasExited) { & taskkill.exe /PID $processId /T /F | Out-Null }
    }
    $result = [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdoutTask.Result
        Stderr = $stderrTask.Result
    }
    Write-Host "=== $Label STDOUT ==="
    Write-Host $result.Stdout
    if ($result.Stderr) {
        Write-Host "=== $Label STDERR ==="
        Write-Host $result.Stderr
    }
    if ($result.ExitCode -ne 0) { throw "$Label returned exit code $($result.ExitCode)" }
    return $result
}

if (-not $ProjectRoot) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
} else {
    $ProjectRoot = (Resolve-Path $ProjectRoot).ProviderPath
}

if ($SelfTest) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        foreach ($parseError in $parseErrors) {
            Write-Host "[ERROR] $($parseError.Message) at line $($parseError.Extent.StartLineNumber)"
        }
        Exit-WithCode -Code 1
    }
    Write-Host "[SELF-TEST] SSH harness syntax verified (0 errors)."
    Exit-WithCode -Code 0
}

$isWindowsOS = $env:OS -like "*Windows*" -or $IsWindows
$cargoCommand = Get-Command "cargo" -ErrorAction SilentlyContinue
$rustcCommand = Get-Command "rustc" -ErrorAction SilentlyContinue
if (-not $isWindowsOS -or -not $cargoCommand -or -not $rustcCommand) {
    if ($AllowSkip) {
        Write-Host "[SKIP] Windows, Cargo, or rustc unavailable (-AllowSkip was explicit)."
        Exit-WithCode -Code 0
    }
    Write-Host "[ERROR] Windows, Cargo, and rustc are required; refusing a false green without -AllowSkip."
    Exit-WithCode -Code 1
}

$manifestPath = Join-Path $ProjectRoot "src-tauri/Cargo.toml"
$cliManifestPath = Join-Path $ProjectRoot "src-cli/Cargo.toml"
$cliTargetPath = Join-Path $ProjectRoot "src-tauri/target"
$cliExecutablePath = Join-Path $cliTargetPath "release/omaestri.exe"
$contractPath = Join-Path $ProjectRoot "src-tauri/src/ssh_contract.rs"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cliManifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
    Write-Host "[ERROR] SSH native sources are incomplete."
    Exit-WithCode -Code 1
}

$temporaryRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$testExecutable = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "open-maestri-ssh-contract-$PID.exe"))
if (-not $testExecutable.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "[ERROR] Refusing unsafe temporary executable path: $testExecutable"
    Exit-WithCode -Code 1
}

try {
    $cliArguments = "build --manifest-path `"$cliManifestPath`" --release --target-dir `"$cliTargetPath`""
    [void](Invoke-GatedProcess -Executable $cargoCommand.Source -Arguments $cliArguments -Label "omaestri-cli-release")
    if (-not (Test-Path -LiteralPath $cliExecutablePath -PathType Leaf)) {
        throw "CLI build succeeded without producing $cliExecutablePath"
    }

    $cargoArguments = "check --manifest-path `"$manifestPath`" --lib"
    [void](Invoke-GatedProcess -Executable $cargoCommand.Source -Arguments $cargoArguments -Label "cargo-check")

    $rustcArguments = "--edition=2021 --test `"$contractPath`" -o `"$testExecutable`""
    [void](Invoke-GatedProcess -Executable $rustcCommand.Source -Arguments $rustcArguments -Label "ssh-contract-compile")
    $testResult = Invoke-GatedProcess -Executable $testExecutable -Arguments "--nocapture" -Label "ssh-contract-tests"

    $requiredTests = @(
        "tunnel_is_loopback_only_and_fails_if_forwarding_cannot_start",
        "rejects_option_and_shell_injection_inputs",
        "readiness_requires_open_ssh_forward_success_evidence",
        "remote_wrapper_requires_session_identity_and_never_embeds_secrets",
        "installer_is_atomic_and_profile_update_is_idempotent"
    )
    foreach ($testName in $requiredTests) {
        if ($testResult.Stdout -notmatch [regex]::Escape($testName)) {
            throw "Required SSH test missing: $testName"
        }
    }
    if ($testResult.Stdout -notmatch "test result:\s+ok\.\s+5 passed;") {
        throw "Native SSH test summary is missing or incomplete"
    }
} catch {
    Write-Host "[ERROR] $_"
    Exit-WithCode -Code 1
} finally {
    if (Test-Path -LiteralPath $testExecutable -PathType Leaf) {
        Remove-Item -LiteralPath $testExecutable -Force
    }
}

Write-Host "[SUCCESS] Native SSH backend and security contract gate passed."
Exit-WithCode -Code 0
