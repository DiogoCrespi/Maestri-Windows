#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [switch]$ValidateOnly,
    [switch]$SkipFrontendBuild
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

function Resolve-Tool {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Fallbacks = @()
    )
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
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
    Write-Host "[release] $Description" -ForegroundColor Cyan
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
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
}

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$tauriRoot = Join-Path $root "src-tauri"
$cliRoot = Join-Path $root "src-cli"
$configPath = Join-Path $tauriRoot "tauri.conf.json"
$cliBinary = Join-Path $cliRoot "target\release\omaestri.exe"
$stagedCli = Join-Path $tauriRoot "target\release\omaestri.exe"
$bundleRoot = Join-Path $tauriRoot "target\release\bundle"

try {
    Test-ScriptSyntax
    Assert-Condition (Test-Path -LiteralPath $configPath -PathType Leaf) "Tauri config not found: $configPath"
    Assert-Condition (Test-Path -LiteralPath (Join-Path $cliRoot "Cargo.toml") -PathType Leaf) "CLI manifest not found."
    Assert-Condition (Test-Path -LiteralPath (Join-Path $tauriRoot "Cargo.toml") -PathType Leaf) "Tauri manifest not found."

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $resource = $config.bundle.resources.'target/release/omaestri.exe'
    Assert-Condition ($resource -eq "omaestri.exe") "Tauri resources must map target/release/omaestri.exe to omaestri.exe."

    if ($ValidateOnly) {
        Write-Host "[release] Bundle configuration validation passed." -ForegroundColor Green
        exit 0
    }

    $cargoFallbacks = @()
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        $cargoFallbacks += (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")
    }
    $cargo = Resolve-Tool -Name "cargo.exe" -Fallbacks $cargoFallbacks
    $npm = Resolve-Tool -Name "npm.cmd"
    $cargoDirectory = Split-Path -Parent $cargo
    if (($env:Path -split [IO.Path]::PathSeparator) -notcontains $cargoDirectory) {
        $env:Path = "$cargoDirectory$([IO.Path]::PathSeparator)$env:Path"
    }

    if ($SkipFrontendBuild) {
        Assert-Condition (Test-Path -LiteralPath (Join-Path $root "dist\index.html") -PathType Leaf) "dist/index.html is required with -SkipFrontendBuild."
        Write-Host "[release] Reusing existing frontend dist (SkipFrontendBuild)." -ForegroundColor Yellow
    } else {
        Invoke-Checked -FilePath $npm -Arguments @("run", "build") -Description "Building frontend"
    }
    Invoke-Checked -FilePath $cargo -Arguments @(
        "build", "--release", "--manifest-path", (Join-Path $cliRoot "Cargo.toml"),
        "--target-dir", (Join-Path $cliRoot "target")
    ) -Description "Building omaestri.exe"
    Assert-Condition (Test-Path -LiteralPath $cliBinary -PathType Leaf) "CLI release binary missing: $cliBinary"

    New-Item -ItemType Directory -Path (Split-Path -Parent $stagedCli) -Force | Out-Null
    Copy-Item -LiteralPath $cliBinary -Destination $stagedCli -Force
    Assert-Condition (Test-Path -LiteralPath $stagedCli -PathType Leaf) "Failed to stage CLI resource: $stagedCli"

    $tauriArguments = @("run", "tauri", "--", "build", "--ci", "--no-sign")
    if ($SkipFrontendBuild) {
        $tauriArguments += @("--config", '{"build":{"beforeBuildCommand":""}}')
    }
    Invoke-Checked -FilePath $npm -Arguments $tauriArguments -Description "Building unsigned MSI and NSIS bundles"
    Assert-Condition (Test-Path -LiteralPath $bundleRoot -PathType Container) "Tauri bundle directory was not produced: $bundleRoot"

    $msi = @(Get-ChildItem -LiteralPath (Join-Path $bundleRoot "msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue)
    $nsis = @(Get-ChildItem -LiteralPath (Join-Path $bundleRoot "nsis") -Filter "*.exe" -File -ErrorAction SilentlyContinue)
    Assert-Condition ($msi.Count -gt 0) "MSI bundle was not produced."
    Assert-Condition ($nsis.Count -gt 0) "NSIS bundle was not produced."

    Write-Host "[release] MSI:" -ForegroundColor Green
    $msi | ForEach-Object { Write-Host "  $($_.FullName)" }
    Write-Host "[release] NSIS:" -ForegroundColor Green
    $nsis | ForEach-Object { Write-Host "  $($_.FullName)" }
    Write-Host "[release] omaestri.exe is staged as an application resource; installers are unsigned." -ForegroundColor Yellow
} catch {
    Write-Error $_
    exit 1
}
