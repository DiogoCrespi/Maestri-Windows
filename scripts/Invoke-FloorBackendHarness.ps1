<#
.SYNOPSIS
    Native Floor Gate Harness Script for Windows.
.DESCRIPTION
    Validates Rust floor backend unit tests (floors::tests) in Tauri environment.

    HONEST DOCUMENTATION:
    This harness script target is branch 'feat/windows-floors-backend' on base commit '8391225'.
    This script will ONLY pass the Gate once the backend floors branch 'feat/windows-floors-backend'
    is integrated/merged into main, as the Rust unit tests 'floors::tests' do not yet exist in main.

.PARAMETER ProjectRoot
    Root directory of the project. Defaults to parent of script directory ($PSScriptRoot/..).
.PARAMETER SelfTest
    Validates script syntax using System.Management.Automation.Language.Parser without executing cargo.
.PARAMETER AllowSkip
    Allows returning exit code 0 ONLY when platform prerequisites (Windows / cargo executable) are missing.
.PARAMETER TimeoutSeconds
    Maximum execution timeout in seconds for cargo process. Default is 60. Range 1 to 86400.
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [switch]$SelfTest,
    [switch]$AllowSkip,
    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 60
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

function Exit-WithCode {
    param([int]$Code)
    if ($Host.Name -eq "ConsoleHost") {
        exit $Code
    } else {
        $host.SetShouldExit($Code)
        exit $Code
    }
}

# --- 1. Path Resolution ---
if (-not $ProjectRoot) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
} else {
    $ProjectRoot = (Resolve-Path $ProjectRoot).ProviderPath
}

# --- 2. SelfTest Mode ---
if ($SelfTest) {
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) {
        $scriptPath = Join-Path $PSScriptRoot "Invoke-FloorBackendHarness.ps1"
    }

    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)

    if ($parseErrors -and $parseErrors.Count -gt 0) {
        Write-Host "[ERROR] SelfTest syntax parsing failed with $($parseErrors.Count) error(s):"
        foreach ($err in $parseErrors) {
            Write-Host "  - $($err.Message) (Line $($err.Extent.StartLineNumber), Col $($err.Extent.StartColumnNumber))"
        }
        Exit-WithCode -Code 1
    }

    Write-Host "[SELF-TEST] Floor harness script syntax verified with System.Management.Automation.Language.Parser (0 errors)."
    Exit-WithCode -Code 0
}

# --- 3. Platform & Cargo Availability Check (Prerequisites) ---
$isWindowsOS = $env:OS -like "*Windows*" -or $IsWindows
$cargoCmd = Get-Command "cargo" -ErrorAction SilentlyContinue

if (-not $isWindowsOS -or -not $cargoCmd) {
    if ($AllowSkip) {
        Write-Host "[SKIP] Missing prerequisite: Cargo executable or Windows platform unavailable (-AllowSkip active)."
        Exit-WithCode -Code 0
    } else {
        Write-Host "[ERROR] Missing prerequisite: Cargo executable or Windows platform unavailable. Rejecting false green without -AllowSkip."
        Exit-WithCode -Code 1
    }
}

# --- 4. Manifest Path Resolution ---
$manifestPath = Join-Path $ProjectRoot "src-tauri/Cargo.toml"
if (-not (Test-Path $manifestPath)) {
    Write-Host "[ERROR] Cargo manifest path '$manifestPath' not found."
    Exit-WithCode -Code 1
}

# --- 5. Process Execution & Safe Tree Termination ---
$startTime = [System.DateTime]::UtcNow
$cargoExe = $cargoCmd.Source

$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = $cargoExe
$pinfo.Arguments = "test --manifest-path `"$manifestPath`" --lib floors::tests"
$pinfo.UseShellExecute = $false
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.CreateNoWindow = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $pinfo

$started = $false
$pidToTrack = 0

try {
    $started = $proc.Start()
    if ($started) {
        $pidToTrack = $proc.Id
        Write-Host "[HARNESS] Started cargo test process PID $pidToTrack at $startTime."
    }
} catch {
    Write-Host "[ERROR] Failed to start cargo process: $_"
    Exit-WithCode -Code 1
}

if (-not $started -or $pidToTrack -eq 0) {
    Write-Host "[ERROR] Cargo process failed to start."
    Exit-WithCode -Code 1
}

$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()
$timedOut = $false

try {
    $finished = $proc.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) {
        $timedOut = $true
        Write-Host "[ERROR] Timeout of $TimeoutSeconds seconds exceeded while running cargo test."
    }
} finally {
    if ($pidToTrack -gt 0) {
        try {
            if (-not $proc.HasExited) {
                Write-Host "[HARNESS] Terminating process tree for PID $pidToTrack via taskkill.exe /PID $pidToTrack /T /F..."
                & taskkill.exe /PID $pidToTrack /T /F | Out-Null
            }
        } catch {
            # Ignore cleanup errors in finally block
        }
    }
}

if ($timedOut) {
    Exit-WithCode -Code 1
}

$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result

# --- 6. Diagnostic Logging & Output Matching ---
Write-Host "=== STDOUT ==="
if ($stdout) { Write-Host $stdout } else { Write-Host "(empty)" }
Write-Host "=== STDERR ==="
if ($stderr) { Write-Host $stderr } else { Write-Host "(empty)" }
Write-Host "==============="

$exitCode = $proc.ExitCode
Write-Host "[HARNESS] Cargo process exit code: $exitCode"

if ($exitCode -ne 0) {
    Write-Host "[ERROR] Cargo test execution returned non-zero exit code ($exitCode)."
    Exit-WithCode -Code 1
}

# --- 7. Strict Test Result Assertions ---
$requiredTests = @(
    "test_floor_create_new_branch_real_git",
    "test_floor_remove_confined_real_git",
    "test_floor_land_requires_clean_and_current_target",
    "test_floor_hooks_env_and_failure"
)

$missingTests = @()
foreach ($testName in $requiredTests) {
    if ($stdout -notmatch [regex]::Escape($testName)) {
        $missingTests += $testName
    }
}

# Strict match for test result line: "test result: ok. X passed;"
$passedCount = 0
if ($stdout -match "test result:\s+ok\.\s+(\d+)\s+passed;") {
    $passedCount = [int]$matches[1]
}

if ($missingTests.Count -gt 0) {
    Write-Host "[ERROR] Required test cases missing from stdout output: $($missingTests -join ', ')"
    Exit-WithCode -Code 1
}

if ($passedCount -lt 4) {
    Write-Host "[ERROR] Insufficient passed tests count: $passedCount (expected >= 4)."
    Exit-WithCode -Code 1
}

Write-Host "[SUCCESS] Gate validation passed cleanly: All 4 required floor backend tests executed and passed ($passedCount passed)."
Exit-WithCode -Code 0
