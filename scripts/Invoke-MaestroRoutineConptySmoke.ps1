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

function Read-ElementName {
    param([Parameter(Mandatory = $true)]$Element)
    try { return [string]$Element.Current.Name } catch { return "" }
}

function Find-UiElement {
    param(
        [Parameter(Mandatory = $true)]$Root,
        [string]$Name = "",
        [string]$NameContains = "",
        [Parameter(Mandatory = $true)][System.Windows.Automation.ControlType]$ControlType
    )
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        $ControlType
    )
    $elements = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($element in $elements) {
        $elementName = Read-ElementName -Element $element
        if ($Name -and $elementName -eq $Name) { return $element }
        if ($NameContains -and $elementName.IndexOf($NameContains, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $element }
    }
    return $null
}

function Wait-UiElement {
    param(
        [Parameter(Mandatory = $true)]$Root,
        [string]$Name = "",
        [string]$NameContains = "",
        [Parameter(Mandatory = $true)][System.Windows.Automation.ControlType]$ControlType,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $found = Find-UiElement -Root $Root -Name $Name -NameContains $NameContains -ControlType $ControlType
        if ($found) { return $found }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "UI element not found: type=$ControlType name='$Name' contains='$NameContains'"
}

function Invoke-UiButton {
    param(
        [Parameter(Mandatory = $true)]$Root,
        [string]$Name = "",
        [string]$NameContains = "",
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $button = Wait-UiElement -Root $Root -Name $Name -NameContains $NameContains -ControlType ([System.Windows.Automation.ControlType]::Button) -TimeoutSeconds $TimeoutSeconds
    $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
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

function Open-WorkspaceThroughUi {
    param(
        [Parameter(Mandatory = $true)]$Window,
        [Parameter(Mandatory = $true)][string]$Workspace,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    Add-Type -AssemblyName System.Windows.Forms
    Invoke-UiButton -Root $Window -NameContains "Abrir" -TimeoutSeconds $TimeoutSeconds
    # Tauri's native file picker is a separate provider/window. On Windows
    # PowerShell 5.1 its UIA tree can disappear between FindAll calls, so use
    # the focused file-name field instead of traversing that transient tree.
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait($Workspace)
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Seconds 2
}

function Stop-StartedApp {
    if (-not $script:startedApp) { return }
    try {
        if (-not $script:startedApp.HasExited) {
            [void]$script:startedApp.CloseMainWindow()
            [void]$script:startedApp.WaitForExit(10000)
        }
    } catch { }
    try {
        if (-not $script:startedApp.HasExited) {
            & taskkill.exe /PID $script:startedApp.Id /T /F | Out-Null
        }
    } catch { }
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
    $appPath = Join-Path $root ("src-tauri\target\" + $Configuration.ToLowerInvariant() + "\open-maestri-windows.exe")
    if (-not $SkipBuild) {
        $buildScript = Join-Path $scriptDirectory "Build-MaestriRelease.ps1"
        $buildArgs = @{ ProjectRoot = $root }
        if ($Configuration -ne "Release") {
            throw "The native routine smoke requires -Configuration Release; use -SkipBuild with a debug binary if needed."
        }
        & $buildScript @buildArgs
    }
    Assert-Condition (Test-Path -LiteralPath $appPath -PathType Leaf) "Native app binary not found: $appPath"

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
    Write-Step "Starting native app; UI Automation will open the fixture."

    $startedApp = New-Object System.Diagnostics.Process
    $startedApp.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startedApp.StartInfo.FileName = $appPath
    $startedApp.StartInfo.WorkingDirectory = Split-Path -Parent $appPath
    $startedApp.StartInfo.UseShellExecute = $true
    [void]$startedApp.Start()
    $script:startedApp = $startedApp
    Start-Sleep -Seconds 3
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $window = Wait-UiElement -Root ([System.Windows.Automation.AutomationElement]::RootElement) -Name "open-maestri" -ControlType ([System.Windows.Automation.ControlType]::Window) -TimeoutSeconds $TimeoutSeconds
    Open-WorkspaceThroughUi -Window $window -Workspace $fixture.WorkspacePath -TimeoutSeconds $TimeoutSeconds
    Wait-UiElement -Root $window -Name "Routine Smoke Manager" -ControlType ([System.Windows.Automation.ControlType]::Text) -TimeoutSeconds $TimeoutSeconds | Out-Null

    Invoke-UiButton -Root $window -Name "Rotinas" -TimeoutSeconds $TimeoutSeconds
    # Reacquire the window after the overlay is mounted; Chromium/Tauri can
    # invalidate the previous AutomationElement tree during this update.
    $window = Wait-UiElement -Root ([System.Windows.Automation.AutomationElement]::RootElement) -Name "open-maestri" -ControlType ([System.Windows.Automation.ControlType]::Window) -TimeoutSeconds $TimeoutSeconds
    Invoke-UiButton -Root $window -NameContains "Run" -TimeoutSeconds $TimeoutSeconds
    Wait-FileText -Path $fixture.PreMarker -Expected "pre-run" -TimeoutSeconds $TimeoutSeconds
    Wait-FileText -Path $fixture.CommandMarker -Expected "command" -TimeoutSeconds $TimeoutSeconds
    $completed = Wait-RoutineExecution -Path $fixture.RoutinesPath -TimeoutSeconds $TimeoutSeconds
    Assert-Condition ([int]$completed.executionCount -ge 1) "Scheduler did not persist executionCount."
    Write-Step "Verified persisted scheduler state, preRunScript, command, and ConPTY output."
    Stop-StartedApp
    Assert-Condition $startedApp.HasExited "Native app did not exit during cleanup."
    Write-Host "[routine-smoke] PASS" -ForegroundColor Green
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-StartedApp
    if ($fixtureOwned -and -not $KeepArtifacts -and $fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
        Remove-OwnedSmokeDirectory -Path $fixtureRoot
    } elseif ($fixtureRoot) {
        Write-Host "[routine-smoke] Artifacts kept at $fixtureRoot" -ForegroundColor Yellow
    }
}
