<# Strict native gate for the Windows Remote Terminal PTY/SSH backend and security contract. #>
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
    if ($processId -le 0) { throw "$Label process returned invalid PID $processId" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $winDir = $env:WINDIR
            if (-not $winDir) { $winDir = "C:\Windows" }
            $taskkillBin = Join-Path $winDir "System32\taskkill.exe"
            if (Test-Path -LiteralPath $taskkillBin -PathType Leaf) {
                & $taskkillBin /PID $processId /T /F 2>&1 | Out-Null
            } else {
                try { $process.Kill() } catch {}
            }
            throw "$Label process timed out after $TimeoutSeconds seconds (fail-closed timeout gate)"
        }
    } catch {
        if (-not $process.HasExited) {
            try { $process.Kill() } catch {}
        }
        throw
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

$contractPath = Join-Path $ProjectRoot "src-tauri/src/remote_terminal_contract.rs"

$requiredTests = @(
    "test_remote_contract_args_no_secrets_or_cwd",
    "test_remote_contract_fragmented_marker_parsing",
    "test_remote_contract_fragmented_established_marker_and_output",
    "test_remote_contract_payload_sent_only_after_ready",
    "test_remote_contract_token_never_in_sanitized_output",
    "test_remote_contract_osc52_sanitization_and_tui_preservation",
    "test_remote_contract_reparse_attribute_decision_helper",
    "test_remote_contract_ssh_reparse_point_confinement",
    "test_remote_contract_session_credential_isolation",
    "test_remote_contract_missing_home_fails_closed",
    "test_remote_contract_timeout_and_failure_handling",
    "test_remote_contract_distinct_sessions_distinct_nonces",
    "test_remote_contract_unknown_location_type_fails"
)

if ($SelfTest) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        foreach ($parseError in $parseErrors) {
            Write-Host "[ERROR] $($parseError.Message) at line $($parseError.Extent.StartLineNumber)"
        }
        Exit-WithCode -Code 1
    }

    $scriptContent = Get-Content -LiteralPath $PSCommandPath -Raw

    if ($scriptContent -match "rustcCommand\.Source[^\r\n]*--test") {
        Write-Host "[ERROR] Self-test failed: harness contains forbidden raw rustc test compilation"
        Exit-WithCode -Code 1
    }

    if ($scriptContent -notmatch '\$cargoTestArguments\s*=\s*"test\s+--manifest-path[^\r\n]*remote_terminal_contract::tests') {
        Write-Host "[ERROR] Self-test failed: \$cargoTestArguments assignment missing or invalid"
        Exit-WithCode -Code 1
    }

    if ($scriptContent -notmatch 'Invoke-GatedProcess\s+-Executable\s+\$cargoCommand\.Source\s+-Arguments\s+\$cargoTestArguments') {
        Write-Host "[ERROR] Self-test failed: Invoke-GatedProcess not called with \$cargoTestArguments"
        Exit-WithCode -Code 1
    }

    if ($scriptContent -notmatch "src-tauri/src/remote_terminal_contract\.rs") {
        Write-Host "[ERROR] Self-test failed: contract path src-tauri/src/remote_terminal_contract.rs reference missing"
        Exit-WithCode -Code 1
    }

    # Verify each required test is present in the requiredTests array definition
    $mustContainTests = @(
        'test_remote_contract_args_no_secrets_or_cwd',
        'test_remote_contract_fragmented_marker_parsing',
        'test_remote_contract_fragmented_established_marker_and_output',
        'test_remote_contract_payload_sent_only_after_ready',
        'test_remote_contract_token_never_in_sanitized_output',
        'test_remote_contract_osc52_sanitization_and_tui_preservation',
        'test_remote_contract_reparse_attribute_decision_helper',
        'test_remote_contract_ssh_reparse_point_confinement',
        'test_remote_contract_session_credential_isolation',
        'test_remote_contract_missing_home_fails_closed',
        'test_remote_contract_timeout_and_failure_handling',
        'test_remote_contract_distinct_sessions_distinct_nonces',
        'test_remote_contract_unknown_location_type_fails'
    )

    $arrayDefMatch = [regex]::Match($scriptContent, '\$requiredTests\s*=\s*@\(([\s\S]*?)\)')
    if (-not $arrayDefMatch.Success) {
        Write-Host "[ERROR] Self-test failed: \$requiredTests array definition not found"
        Exit-WithCode -Code 1
    }
    $arrayDefText = $arrayDefMatch.Groups[1].Value

    foreach ($testName in $mustContainTests) {
        if ($arrayDefText -notmatch [regex]::Escape($testName)) {
            Write-Host "[ERROR] Self-test failed: required test name '$testName' missing from \$requiredTests array definition"
            Exit-WithCode -Code 1
        }
    }

    Write-Host "[SELF-TEST] Remote terminal harness AST, cargo test execution wiring, and contract test matrix verified (0 errors)."
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

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cliManifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
    if ($AllowSkip) {
        Write-Host "[SKIP] Remote terminal native contract sources missing (-AllowSkip was explicit)."
        Exit-WithCode -Code 0
    }
    Write-Host "[ERROR] Remote terminal native contract sources are missing: $contractPath"
    Exit-WithCode -Code 1
}

try {
    $cliArguments = "build --manifest-path `"$cliManifestPath`" --release --target-dir `"$cliTargetPath`""
    [void](Invoke-GatedProcess -Executable $cargoCommand.Source -Arguments $cliArguments -Label "omaestri-cli-release")
    if (-not (Test-Path -LiteralPath $cliExecutablePath -PathType Leaf)) {
        throw "CLI build succeeded without producing $cliExecutablePath"
    }

    $cargoCheckArguments = "check --manifest-path `"$manifestPath`" --lib"
    [void](Invoke-GatedProcess -Executable $cargoCommand.Source -Arguments $cargoCheckArguments -Label "cargo-check")

    $cargoTestArguments = "test --manifest-path `"$manifestPath`" --lib remote_terminal_contract::tests -- --nocapture"
    $testResult = Invoke-GatedProcess -Executable $cargoCommand.Source -Arguments $cargoTestArguments -Label "remote-terminal-contract-tests"

    foreach ($testName in $requiredTests) {
        if ($testResult.Stdout -notmatch [regex]::Escape($testName)) {
            throw "Required Remote Terminal test missing from execution output: $testName"
        }
    }
    if ($testResult.Stdout -notmatch "test result:\s+ok\.") {
        throw "Native Remote Terminal test summary is missing or incomplete"
    }
} catch {
    Write-Host "[ERROR] $_"
    Exit-WithCode -Code 1
}

Write-Host "[SUCCESS] Native Remote Terminal PTY/SSH backend and security contract gate passed."
Exit-WithCode -Code 0
