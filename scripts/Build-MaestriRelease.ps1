#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [string]$OutputDirectory = "",
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
$releaseConfigPath = Join-Path $tauriRoot "tauri.release.conf.json"
$cliBinary = Join-Path $cliRoot "target\release\omaestri.exe"
$stagedCli = Join-Path $tauriRoot "target\release\omaestri.exe"
$appBinary = Join-Path $tauriRoot "target\release\open-maestri-windows.exe"
$bundleRoot = Join-Path $tauriRoot "target\release\bundle"
$noticesPath = Join-Path $root "THIRD_PARTY_NOTICES.md"
$licensePath = Join-Path $root "LICENSE"
$releaseNotesPath = Join-Path $root "RELEASE_NOTES_0.1.0.md"

try {
    Test-ScriptSyntax
    Assert-Condition (Test-Path -LiteralPath $configPath -PathType Leaf) "Tauri config not found: $configPath"
    Assert-Condition (Test-Path -LiteralPath $releaseConfigPath -PathType Leaf) "Tauri release override not found: $releaseConfigPath"
    Assert-Condition (Test-Path -LiteralPath (Join-Path $cliRoot "Cargo.toml") -PathType Leaf) "CLI manifest not found."
    Assert-Condition (Test-Path -LiteralPath (Join-Path $tauriRoot "Cargo.toml") -PathType Leaf) "Tauri manifest not found."
    Assert-Condition (Test-Path -LiteralPath $licensePath -PathType Leaf) "GPL license file not found: $licensePath"
    Assert-Condition (Test-Path -LiteralPath $releaseNotesPath -PathType Leaf) "Release notes not found: $releaseNotesPath"

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $version = [string]$config.version
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($version)) "Tauri config version is required."
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
        $tauriArguments += @("--config", $releaseConfigPath)
    }
    Invoke-Checked -FilePath $npm -Arguments $tauriArguments -Description "Building unsigned MSI and NSIS bundles"
    Assert-Condition (Test-Path -LiteralPath $bundleRoot -PathType Container) "Tauri bundle directory was not produced: $bundleRoot"
    Assert-Condition (Test-Path -LiteralPath $appBinary -PathType Leaf) "Application release binary missing: $appBinary"

    $msi = @(Get-ChildItem -LiteralPath (Join-Path $bundleRoot "msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue)
    $nsis = @(Get-ChildItem -LiteralPath (Join-Path $bundleRoot "nsis") -Filter "*.exe" -File -ErrorAction SilentlyContinue)
    Assert-Condition ($msi.Count -gt 0) "MSI bundle was not produced."
    Assert-Condition ($nsis.Count -gt 0) "NSIS bundle was not produced."
    $latestMsi = $msi | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $latestNsis = $nsis | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $releaseRoot = Join-Path $root "release"
    } elseif ([IO.Path]::IsPathRooted($OutputDirectory)) {
        $releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)
    } else {
        $releaseRoot = [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
    }

    $portableName = "Open-Maestri-Windows-v$version-portable"
    $portableRoot = Join-Path $releaseRoot $portableName
    $portableApp = Join-Path $portableRoot "Open Maestri.exe"
    $portableCli = Join-Path $portableRoot "omaestri.exe"
    $portableReadme = Join-Path $portableRoot "LEIA-ME.txt"
    $portableZip = Join-Path $releaseRoot "$portableName.zip"
    $setupRelease = Join-Path $releaseRoot "Open-Maestri-Windows-v$version-Setup.exe"
    $msiRelease = Join-Path $releaseRoot "Open-Maestri-Windows-v$version.msi"
    $hashesPath = Join-Path $releaseRoot "SHA256SUMS.txt"
    $publishedReleaseNotes = Join-Path $releaseRoot "RELEASE_NOTES.md"

    New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null
    Copy-Item -LiteralPath $appBinary -Destination $portableApp -Force
    Copy-Item -LiteralPath $cliBinary -Destination $portableCli -Force
    if (Test-Path -LiteralPath $noticesPath -PathType Leaf) {
        Copy-Item -LiteralPath $noticesPath -Destination (Join-Path $portableRoot "THIRD_PARTY_NOTICES.md") -Force
    }
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $portableRoot "LICENSE") -Force

    $portableInstructions = @"
OPEN MAESTRI $version - VERSAO PORTATIL PARA WINDOWS

COMO ABRIR
1. Extraia todo o conteudo deste ZIP para uma pasta.
2. De dois cliques em "Open Maestri.exe".
3. Mantenha "omaestri.exe" na mesma pasta; ele permite a comunicacao entre agentes.

REQUISITOS
- Windows 10 versao 1903 ou mais recente, ou Windows 11.
- Microsoft Edge WebView2 Runtime (normalmente ja instalado no Windows 10/11).
- Os CLIs de IA que voce pretende usar, como Codex, Claude ou Antigravity.

Se o Windows SmartScreen exibir um alerta, isso ocorre porque este primeiro release
ainda nao possui assinatura digital. Confira o SHA-256 publicado antes de executar.

Projeto e codigo-fonte: https://github.com/DiogoCrespi/Maestri-Windows
Licenca: GPL-3.0-only
"@
    [IO.File]::WriteAllText($portableReadme, $portableInstructions, [Text.UTF8Encoding]::new($false))

    Copy-Item -LiteralPath $latestNsis.FullName -Destination $setupRelease -Force
    Copy-Item -LiteralPath $latestMsi.FullName -Destination $msiRelease -Force
    Compress-Archive -LiteralPath $portableRoot -DestinationPath $portableZip -CompressionLevel Optimal -Force
    Copy-Item -LiteralPath $releaseNotesPath -Destination $publishedReleaseNotes -Force

    $publishedFiles = @($setupRelease, $msiRelease, $portableZip)
    $hashLines = $publishedFiles | ForEach-Object {
        $hash = Get-FileHash -LiteralPath $_ -Algorithm SHA256
        "$($hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
    }
    [IO.File]::WriteAllLines($hashesPath, $hashLines, [Text.UTF8Encoding]::new($false))

    Write-Host "[release] Release artifacts:" -ForegroundColor Green
    $publishedFiles | ForEach-Object { Write-Host "  $_" }
    Write-Host "  $hashesPath"
    Write-Host "  $publishedReleaseNotes"
    Write-Host "[release] Portable directory:" -ForegroundColor Green
    Write-Host "  $portableRoot"
    Write-Host "[release] Installers and portable binaries are unsigned." -ForegroundColor Yellow
} catch {
    Write-Error $_
    exit 1
}
