[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DestinationDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$buildScript = Join-Path -Path $PSScriptRoot -ChildPath "Build-Omaestri.ps1"
if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) {
    throw "Build script not found: $buildScript"
}

try {
    & $buildScript -ProjectRoot $ProjectRoot -DestinationDirectory $DestinationDirectory
} catch {
    throw "CLI build/install failed: $($_.Exception.Message)"
}
