#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 120,
    [switch]$AllowSkip,
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[native-harness] $Message" -ForegroundColor Cyan
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
}

function Invoke-SelfTest {
    Test-ScriptSyntax
    Write-Host "[native-harness] Self-test passed." -ForegroundColor Green
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return }
    try {
        & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
    } catch {}
}

$spawnedProcess = $null

try {
    if ($SelfTest) {
        Invoke-SelfTest
        exit 0
    }

    Test-ScriptSyntax
    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $manifestPath = Join-Path $root "src-tauri\Cargo.toml"
    Assert-Condition (Test-Path -LiteralPath $manifestPath -PathType Leaf) "Cargo manifest not found: $manifestPath"

    # Check Windows OS
    $isWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    if (-not $isWindowsPlatform) {
        if ($AllowSkip) {
            Write-Host "[native-harness] SKIP: Platform is not Windows. Skipping native backend harness." -ForegroundColor Yellow
            exit 0
        } else {
            throw "Native backend harness requires Windows platform. Use -AllowSkip to bypass in non-Windows environments."
        }
    }

    # Discover cargo toolchain
    $cargoCmd = Get-Command "cargo" -ErrorAction SilentlyContinue
    $cargoPath = $null
    if ($cargoCmd) {
        $cargoPath = $cargoCmd.Source
    } else {
        $userCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
        if (Test-Path -LiteralPath $userCargo -PathType Leaf) {
            $cargoPath = $userCargo
        }
    }

    if (-not $cargoPath) {
        if ($AllowSkip) {
            Write-Host "[native-harness] SKIP: Native prerequisite missing (cargo executable not found in PATH). Skipping native backend harness." -ForegroundColor Yellow
            exit 0
        } else {
            throw "Native prerequisite missing (cargo executable not found in PATH). Failing quality gate in default mode. Pass -AllowSkip to bypass."
        }
    }

    Write-Step "Found cargo at $cargoPath"
    Write-Step "Executing native backend harness tests (native_harness)..."

    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $cargoPath
    $processInfo.Arguments = "test --manifest-path `"$manifestPath`" --lib native_harness"
    $processInfo.WorkingDirectory = Split-Path -Parent $manifestPath
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processInfo
    $spawnedProcess = $process

    [void]$process.Start()
    $stdOutTask = $process.StandardOutput.ReadToEndAsync()
    $stdErrTask = $process.StandardError.ReadToEndAsync()

    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        if ($process.Id -gt 0) {
            Stop-ProcessTree -ProcessId $process.Id
        }
        throw "cargo test timed out after $TimeoutSeconds seconds"
    }

    $stdOut = $stdOutTask.Result
    $stdErr = $stdErrTask.Result

    if ($stdOut) { Write-Host $stdOut }
    if ($stdErr) { Write-Host $stdErr -ForegroundColor Yellow }

    if ($process.ExitCode -ne 0) {
        throw "cargo test failed with exit code $($process.ExitCode)"
    }

    Write-Host "[native-harness] PASS: Native backend harness tests passed." -ForegroundColor Green
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($spawnedProcess) {
        try {
            $hasExited = $false
            try { $hasExited = $spawnedProcess.HasExited } catch {}
            if (-not $hasExited) {
                $pidToKill = 0
                try { $pidToKill = $spawnedProcess.Id } catch {}
                if ($pidToKill -gt 0) {
                    Stop-ProcessTree -ProcessId $pidToKill
                }
            }
        } catch {}
    }
}
