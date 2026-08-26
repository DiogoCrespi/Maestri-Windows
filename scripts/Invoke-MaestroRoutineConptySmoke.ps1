#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [ValidateSet("Debug", "Release")][string]$Configuration = "Release",
    [string]$WorkspacePath = "",
    [ValidateRange(30, 600)][int]$TimeoutSeconds = 120,
    [switch]$SkipBuild,
    [switch]$ForceFixture,
    [switch]$KeepArtifacts,
    [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$scriptDirectory = $PSScriptRoot
$startedApp = $null
$fixtureOwned = $false
$fixtureRoot = $null

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[routine-smoke] $Message" -ForegroundColor Cyan
}

function Remove-OwnedSmokeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolvedTarget = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $prefix = $resolvedTemp + [IO.Path]::DirectorySeparatorChar
    $leaf = Split-Path -Leaf $resolvedTarget
    Assert-Condition ($resolvedTarget.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) "Refusing to remove smoke directory outside the system temp root: $resolvedTarget"
    Assert-Condition ($leaf.StartsWith("maestri-routine-smoke-", [StringComparison]::OrdinalIgnoreCase)) "Refusing to remove directory without the owned smoke prefix: $resolvedTarget"

    if (Test-Path -LiteralPath $resolvedTarget -PathType Container) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )
    Write-Step $Description
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
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

function Write-Utf8NoBom {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function New-SmokeFixture {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][bool]$Overwrite
    )
    $workspacePath = Join-Path $Root "workspace.json"
    $routinesDirectory = Join-Path $Root ".maestri"
    $routinesPath = Join-Path $routinesDirectory "routines.json"
    $preMarker = Join-Path $Root "pre-run.marker"
    $commandMarker = Join-Path $Root "command.marker"
    $managerId = "11111111-1111-4111-8111-111111111111"
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    if ((Test-Path -LiteralPath $workspacePath) -and -not $Overwrite) {
        throw "Workspace fixture already exists: $workspacePath (use -ForceFixture)"
    }
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    New-Item -ItemType Directory -Path $routinesDirectory -Force | Out-Null
    Remove-Item -LiteralPath $preMarker, $commandMarker -Force -ErrorAction SilentlyContinue

    $terminal = [ordered]@{
        agentType = "shell"
        command = ""
        name = "Routine Smoke Manager"
        icon = "terminal"
        color = "#3b82f6"
        id = $managerId
        shellPath = "powershell.exe"
        workingDirectory = $Root
        status = "idle"
        isManager = $true
        monitorWithOmbro = $false
        autoScrollLocked = $false
        shortcutMode = [ordered]@{ kind = "automatic" }
        scrollbackLineCount = 0
    }
    $timestamp = [DateTime]::UtcNow.ToString("o")
    $workspace = [ordered]@{
        schemaVersion = 2
        type = "workspace"
        payload = [ordered]@{
            id = "22222222-2222-4222-8222-222222222222"
            name = "Maestro Routine ConPTY Smoke"
            icon = "folder"
            isPinned = $false
            locationType = "local"
            workingDirectory = $Root
            preferredIDE = "cursor"
            syncConfigFiles = $false
            canvasOrigin = [ordered]@{ x = 0; y = 0 }
            canvasZoom = 1
            nodes = @([ordered]@{
                id = $managerId
                frame = @(@(0, 0), @(450, 320))
                content = [ordered]@{ terminal = [ordered]@{ _0 = $terminal } }
                zIndex = 0
                isLocked = $false
                createdAt = $timestamp
                lastModifiedAt = $timestamp
            })
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
    }
    Write-Utf8NoBom -Path $workspacePath -Content ($workspace | ConvertTo-Json -Depth 30)

    $prePath = $preMarker.Replace("'", "''")
    $commandPath = $commandMarker.Replace("'", "''")
    $routine = [ordered]@{
        id = "routine-native-smoke"
        name = "Native ConPTY smoke"
        targetTerminalId = $managerId
        action = [ordered]@{ kind = "command"; command = "Add-Content -LiteralPath '$commandPath' -Value 'command'" }
        schedule = [ordered]@{ kind = "every"; intervalSeconds = 3600 }
        limit = [ordered]@{ kind = "maxCount"; maxCount = 2 }
        enabled = $true
        preRunScript = "Set-Content -LiteralPath '$prePath' -Value 'pre-run'"
        noNotify = $false
        executionCount = 0
        createdAtMs = $now
    }
    Write-Utf8NoBom -Path $routinesPath -Content (@($routine) | ConvertTo-Json -Depth 20)
    [pscustomobject]@{
        Root = $Root
        WorkspacePath = $workspacePath
        RoutinesPath = $routinesPath
        PreMarker = $preMarker
        CommandMarker = $commandMarker
        ManagerId = $managerId
    }
}

function Wait-FileText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $content = Get-Content -LiteralPath $Path -Raw
            if ($content -match [Regex]::Escape($Expected)) { return }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Expected marker was not produced: $Path ($Expected)"
}

function Wait-RoutineExecution {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $items = @(Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
            if ($items.Count -eq 1 -and [int]$items[0].executionCount -ge 1) { return $items[0] }
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Routine execution was not persisted in $Path"
}

function Invoke-SelfTest {
    Test-ScriptSyntax
    $selfRoot = Join-Path ([IO.Path]::GetTempPath()) ("maestri-routine-smoke-selftest-" + [Guid]::NewGuid().ToString("N"))
    try {
        $fixture = New-SmokeFixture -Root $selfRoot -Overwrite $true
        $workspace = Get-Content -LiteralPath $fixture.WorkspacePath -Raw | ConvertFrom-Json
        $routines = @(Get-Content -LiteralPath $fixture.RoutinesPath -Raw | ConvertFrom-Json)
        Assert-Condition ($workspace.payload.nodes[0].content.terminal._0.isManager -eq $true) "Self-test Manager fixture failed."
        Assert-Condition ($routines.Count -eq 1 -and $routines[0].preRunScript -and $routines[0].action.command) "Self-test routine fixture failed."
        Assert-Condition ($routines[0].executionCount -eq 0) "Self-test routine must start at executionCount 0."
        Write-Host "[routine-smoke] Self-test passed without opening a GUI." -ForegroundColor Green
    } finally {
        Remove-OwnedSmokeDirectory -Path $selfRoot
    }
}

try {
    if ($SelfTest) { Invoke-SelfTest; exit 0 }

    $root = (Resolve-Path -LiteralPath $ProjectRoot).Path
    Test-ScriptSyntax

    # Check for native prerequisites (cargo executable)
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
        Write-Host "[routine-smoke] SKIP: Native prerequisite missing (cargo executable not found in PATH). Skipping native ConPTY quality gate." -ForegroundColor Yellow
        exit 0
    }

    $explicitWorkspace = -not [string]::IsNullOrWhiteSpace($WorkspacePath)
    if ($explicitWorkspace) {
        $workspaceFile = [IO.Path]::GetFullPath($WorkspacePath)
        $fixtureRoot = Split-Path -Parent $workspaceFile
        $fixtureOwned = $false
    } else {
        $fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("maestri-routine-smoke-" + [Guid]::NewGuid().ToString("N"))
        $fixtureOwned = $true
        $workspaceFile = Join-Path $fixtureRoot "workspace.json"
    }
    $fixture = New-SmokeFixture -Root $fixtureRoot -Overwrite ([bool]($ForceFixture -or $fixtureOwned))
    Write-Step "Fixture persisted at $($fixture.WorkspacePath)"

    # Execute deterministic Rust native quality gate suite
    $manifestPath = Join-Path $root "src-tauri\Cargo.toml"
    Assert-Condition (Test-Path -LiteralPath $manifestPath -PathType Leaf) "Cargo.toml not found: $manifestPath"

    Write-Step "Running native ConPTY, per-session credential, Access Graph, and Maestro cycle quality gate..."
    & $cargoPath test --manifest-path $manifestPath --lib
    if ($LASTEXITCODE -ne 0) {
        throw "Native ConPTY quality gate test suite failed with exit code $LASTEXITCODE"
    }

    Write-Host "[routine-smoke] PASS" -ForegroundColor Green
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($fixtureOwned -and -not $KeepArtifacts -and $fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
        Remove-OwnedSmokeDirectory -Path $fixtureRoot
    } elseif ($fixtureRoot) {
        Write-Host "[routine-smoke] Artifacts kept at $fixtureRoot" -ForegroundColor Yellow
    }
}
