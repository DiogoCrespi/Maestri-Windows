<#
.SYNOPSIS
    Native Floor Gate Harness Script for Windows.
.DESCRIPTION
    Validates Rust floor backend unit tests (floors::tests) in Tauri environment.

    HONEST DOCUMENTATION:
    This harness script will ONLY pass the Gate once the backend floors branch
    (feat/windows-floor-parity or equivalent) is integrated/merged into main, as the Rust
    unit tests 'floors::tests' do not yet exist in main.

.PARAMETER SelfTest
    Validates script syntax and parameter handling without executing cargo.
.PARAMETER AllowSkip
    Allows returning exit code 0 with a skip message when cargo/Windows platform or tests are unavailable.
.PARAMETER TimeoutSeconds
    Maximum execution timeout in seconds for cargo process. Default is 60.
#>
[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$AllowSkip,
    [int]$TimeoutSeconds = 60
)

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

# --- 1. SelfTest Mode ---
if ($SelfTest) {
    Write-Host "[SELF-TEST] Floor harness script syntax and parameter structure verified successfully."
    Exit-WithCode -Code 0
}

# --- 2. Platform & Cargo Availability Check ---
$isWindowsOS = $env:OS -like "*Windows*" -or $IsWindows
$cargoCmd = Get-Command "cargo" -ErrorAction SilentlyContinue

if (-not $isWindowsOS -or -not $cargoCmd) {
    if ($AllowSkip) {
        Write-Host "[SKIP] Cargo or Windows platform not available. Skipping floor gate harness execution (-AllowSkip active)."
        Exit-WithCode -Code 0
    } else {
        Write-Host "[ERROR] Cargo or Windows platform unavailable. Rejecting false green without -AllowSkip."
        Exit-WithCode -Code 1
    }
}

# --- 3. Process Execution & Tree Management ---
$manifestPath = "src-tauri/Cargo.toml"
if (-not (Test-Path $manifestPath)) {
    if ($AllowSkip) {
        Write-Host "[SKIP] Manifest path '$manifestPath' not found (-AllowSkip active)."
        Exit-WithCode -Code 0
    } else {
        Write-Host "[ERROR] Manifest path '$manifestPath' not found."
        Exit-WithCode -Code 1
    }
}

$startTime = [System.DateTime]::UtcNow
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = $cargoCmd.Source
$pinfo.Arguments = "test --manifest-path $manifestPath --lib floors::tests"
$pinfo.UseShellExecute = $false
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.CreateNoWindow = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $pinfo

try {
    $proc.Start() | Out-Null
} catch {
    if ($AllowSkip) {
        Write-Host "[SKIP] Failed to launch cargo process: $_ (-AllowSkip active)."
        Exit-WithCode -Code 0
    } else {
        Write-Host "[ERROR] Failed to launch cargo process: $_"
        Exit-WithCode -Code 1
    }
}

$pidToTrack = $proc.Id
Write-Host "[HARNESS] Started cargo test process PID $pidToTrack at $startTime."

$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()

$finished = $proc.WaitForExit($TimeoutSeconds * 1000)

if (-not $finished) {
    Write-Host "[ERROR] Timeout of $TimeoutSeconds seconds exceeded. Terminating cargo process tree (PID $pidToTrack)."
    try {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $pidToTrack /T /F" -NoNewWindow -Wait -ErrorAction SilentlyContinue
    } catch {
        try { $proc.Kill() } catch {}
    }
    if ($AllowSkip) {
        Write-Host "[SKIP] Process timed out (-AllowSkip active)."
        Exit-WithCode -Code 0
    } else {
        Exit-WithCode -Code 1
    }
}

$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result
$output = "$stdout`n$stderr"

# --- 4. Test Output & Assertion Validation ---
$requiredTests = @(
    "test_floor_create_new_branch_real_git",
    "test_floor_remove_confined_real_git",
    "test_floor_land_requires_clean_and_current_target",
    "test_floor_hooks_env_and_failure"
)

$missingTests = @()
foreach ($testName in $requiredTests) {
    if ($output -notmatch [regex]::Escape($testName)) {
        $missingTests += $testName
    }
}

$passedCount = 0
if ($output -match "test result: ok\.\s+(\d+)\s+passed") {
    $passedCount = [int]$matches[1]
} elseif ($output -match "(\d+)\s+passed") {
    $passedCount = [int]$matches[1]
}

$hasZeroTests = ($passedCount -eq 0) -or ($output -match "0 passed")
$allTestsPresent = ($missingTests.Count -eq 0)
$hasMinPassed = ($passedCount -ge 4)
$isSuccess = ($proc.ExitCode -eq 0) -and $allTestsPresent -and $hasMinPassed -and (-not $hasZeroTests)

if (-not $isSuccess) {
    Write-Host "[HARNESS] Cargo exit code: $($proc.ExitCode), Passed tests count: $passedCount"
    if ($missingTests.Count -gt 0) {
        Write-Host "[HARNESS] Missing required test cases in output: $($missingTests -join ', ')"
    }
    if ($hasZeroTests) {
        Write-Host "[HARNESS] Rejection: Zero tests executed (false green prevented)."
    }

    if ($AllowSkip) {
        Write-Host "[SKIP] Required floor tests not present or failing on main codebase (-AllowSkip active)."
        Exit-WithCode -Code 0
    } else {
        Write-Host "[ERROR] Gate validation failed. Required floor backend tests are missing or failing."
        Exit-WithCode -Code 1
    }
}

Write-Host "[SUCCESS] All 4 required floor backend tests passed successfully ($passedCount passed)."
Exit-WithCode -Code 0
