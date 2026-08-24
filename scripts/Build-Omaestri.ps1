[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DestinationDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-FullPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$BasePath
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path -Path $BasePath -ChildPath $Path))
}

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$manifestPath = Join-Path -Path $root -ChildPath "src-cli\Cargo.toml"
$cliTargetDirectory = Join-Path -Path $root -ChildPath "src-cli\target"
$binaryPath = Join-Path -Path $cliTargetDirectory -ChildPath "release\omaestri.exe"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "CLI manifest not found: $manifestPath"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Cargo was not found on PATH. Install Rust through rustup and reopen PowerShell."
}

Write-Host "Building omaestri CLI (release)..."
& cargo build --release --manifest-path $manifestPath --target-dir $cliTargetDirectory
if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "Release binary was not produced: $binaryPath"
}

if ([string]::IsNullOrWhiteSpace($DestinationDirectory)) {
    $destination = Join-Path -Path $root -ChildPath "src-tauri\target\release"
} else {
    $destination = Get-FullPath -Path $DestinationDirectory -BasePath $root
}

if (Test-Path -LiteralPath $destination -PathType Leaf) {
    throw "Destination is a file, not a directory: $destination"
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$installedPath = Join-Path -Path $destination -ChildPath "omaestri.exe"
Copy-Item -LiteralPath $binaryPath -Destination $installedPath -Force

Write-Host "Built:     $binaryPath"
Write-Host "Installed: $installedPath"
Write-Output $installedPath
