#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Describe", "Register", "Status", "Run", "Unregister")]
    [string]$Action,
    [string]$InstallRoot,
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$runtimeMarkerName = ".paperlens-mineru-runtime"
$runtimeMarkerValue = "paperlens-mineru-runtime-v1"
$taskName = "PaperLens MinerU"
$taskPath = "\"
$taskDescription = "PaperLens MinerU current-user logon service v1"
$failureCode = "TASK_OPERATION_FAILED"

function Resolve-UncreatedPath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return [System.IO.Path]::GetFullPath(
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
    )
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $parentWithSeparator = $Parent.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    return $Candidate.StartsWith($parentWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"')) {
        throw "任务参数含有不支持的引号。"
    }
    return '"' + $Value + '"'
}

function Resolve-IdentitySid {
    param([Parameter(Mandatory = $true)][string]$Identity)

    try {
        if ($Identity.StartsWith("S-1-", [System.StringComparison]::OrdinalIgnoreCase)) {
            return (New-Object System.Security.Principal.SecurityIdentifier($Identity)).Value
        }
        $account = New-Object System.Security.Principal.NTAccount($Identity)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    catch {
        return ""
    }
}

function Write-Json {
    param([Parameter(Mandatory = $true)][hashtable]$Value)

    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
}

function Exit-WithError {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$ExitCode = 1
    )

    [Console]::Error.WriteLine("${Code}: $Message")
    exit $ExitCode
}

function Get-OwnedTask {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if ($null -ne $task -and [string]$task.Description -cne $taskDescription) {
        Exit-WithError "TASK_UNTRUSTED" "同名任务不是受信任的 PaperLens MinerU 任务，拒绝修改。" 4
    }
    return $task
}

function Get-TaskDriftCodes {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$Arguments,
        [Parameter(Mandatory = $true)][string]$CurrentUserSid
    )

    $actions = @($Task.Actions)
    $triggers = @($Task.Triggers)
    $drift = @()
    if ($actions.Count -ne 1) {
        $drift += "ACTION_COUNT"
    }
    if ($triggers.Count -ne 1) {
        $drift += "TRIGGER_COUNT"
    }
    if ($actions.Count -ne 1 -or $triggers.Count -ne 1) {
        return $drift
    }
    $triggerClass = [string]$triggers[0].CimClass.CimClassName
    if ([string]$Task.Description -cne $taskDescription) { $drift += "DESCRIPTION" }
    if ([string]$actions[0].Execute -ine $PowerShellPath) { $drift += "ACTION_EXECUTABLE" }
    if ([string]$actions[0].Arguments -cne $Arguments) { $drift += "ACTION_ARGUMENTS" }
    if ($triggerClass -cne "MSFT_TaskLogonTrigger") { $drift += "TRIGGER_TYPE" }
    if ((Resolve-IdentitySid ([string]$triggers[0].UserId)) -ine $CurrentUserSid) {
        $drift += "TRIGGER_USER"
    }
    if ((Resolve-IdentitySid ([string]$Task.Principal.UserId)) -ine $CurrentUserSid) {
        $drift += "PRINCIPAL_USER"
    }
    if ([string]$Task.Principal.LogonType -cne "Interactive") { $drift += "LOGON_TYPE" }
    if ([string]$Task.Principal.RunLevel -cne "Limited") { $drift += "RUN_LEVEL" }
    if (-not [bool]$Task.Settings.Hidden) { $drift += "HIDDEN" }
    if ([string]$Task.Settings.MultipleInstances -cne "IgnoreNew") { $drift += "MULTIPLE_INSTANCES" }
    if ([string]$Task.Settings.ExecutionTimeLimit -cne "PT0S") { $drift += "EXECUTION_TIME_LIMIT" }
    return $drift
}

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        $failureCode = "PLATFORM_UNSUPPORTED"
        throw "任务计划入口仅支持 Windows。"
    }
    if (-not $env:LOCALAPPDATA) {
        $failureCode = "LOCALAPPDATA_UNAVAILABLE"
        throw "LOCALAPPDATA 不可用。"
    }
    if (-not $InstallRoot) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA "PaperLens\MinerU\runtime"
    }
    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $env:LOCALAPPDATA "PaperLens\MinerU\paperlens-mineru.toml"
    }

    $install = Resolve-UncreatedPath $InstallRoot
    $config = Resolve-UncreatedPath $ConfigPath
    $marker = Join-Path $install $runtimeMarkerName
    $launcher = Join-Path $install "paperlens-mineru.cmd"
    $startup = Join-Path $install "maintenance\startup-windows.ps1"
    $powershell = Join-Path $PSHOME "powershell.exe"
    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle Hidden",
        "-ExecutionPolicy Bypass",
        "-File $(Quote-TaskArgument $startup)",
        "-InstallRoot $(Quote-TaskArgument $install)",
        "-ConfigPath $(Quote-TaskArgument $config)"
    ) -join " "

    if ($Action -ne "Unregister") {
        if (
            -not (Test-Path -LiteralPath $marker -PathType Leaf) -or
            (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim() -cne $runtimeMarkerValue
        ) {
            $failureCode = "RUNTIME_UNTRUSTED"
            throw "运行时缺少受信任的 PaperLens 标记。"
        }
        if (
            -not (Test-Path -LiteralPath $launcher -PathType Leaf) -or
            -not (Test-Path -LiteralPath $startup -PathType Leaf) -or
            -not (Test-Path -LiteralPath $config -PathType Leaf) -or
            $config -eq $install -or
            (Test-PathInside $config $install)
        ) {
            $failureCode = "RUNTIME_INCOMPLETE"
            throw "运行时、维护入口或配置不完整。"
        }
    }

    if ($Action -eq "Describe") {
        Write-Json @{
            schemaVersion = 1
            taskName = $taskName
            trigger = "Logon"
            logonType = "Interactive"
            runLevel = "Limited"
            currentUserOnly = $true
            hidden = $true
            multipleInstances = "IgnoreNew"
            executionTimeLimitSeconds = 0
        }
        exit 0
    }

    $existing = Get-OwnedTask
    if ($Action -eq "Unregister") {
        if ($null -ne $existing) {
            Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
        }
        Write-Json @{
            schemaVersion = 1
            code = "TASK_REMOVED"
            configured = $false
        }
        exit 0
    }

    if ($Action -eq "Register") {
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUserSid
        $principal = New-ScheduledTaskPrincipal `
            -UserId $currentUserSid `
            -LogonType Interactive `
            -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -Hidden `
            -MultipleInstances IgnoreNew `
            -StartWhenAvailable
        $definition = New-ScheduledTask `
            -Action $taskAction `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -Description $taskDescription
        Register-ScheduledTask `
            -TaskName $taskName `
            -TaskPath $taskPath `
            -InputObject $definition `
            -Force | Out-Null
        $existing = Get-OwnedTask
        $drift = @(Get-TaskDriftCodes $existing $powershell $arguments $currentUserSid)
        if ($drift.Count -gt 0) {
            Exit-WithError "TASK_CONFIG_DRIFT" "任务注册后配置不符合冻结契约：$($drift -join ',')。" 4
        }
        Write-Json @{
            schemaVersion = 1
            code = "TASK_REGISTERED"
            configured = $true
        }
        exit 0
    }

    if ($null -eq $existing) {
        Write-Json @{
            schemaVersion = 1
            code = "TASK_MISSING"
            configured = $false
            state = "Missing"
        }
        exit 3
    }
    $drift = @(Get-TaskDriftCodes $existing $powershell $arguments $currentUserSid)
    if ($drift.Count -gt 0) {
        Write-Json @{
            schemaVersion = 1
            code = "TASK_CONFIG_DRIFT"
            configured = $false
            state = [string]$existing.State
            drift = $drift
        }
        exit 4
    }
    if ($Action -eq "Run") {
        Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
        Write-Json @{
            schemaVersion = 1
            code = "TASK_STARTED"
            configured = $true
        }
        exit 0
    }
    Write-Json @{
        schemaVersion = 1
        code = "TASK_READY"
        configured = $true
        state = [string]$existing.State
    }
}
catch {
    [Console]::Error.WriteLine("${failureCode}: 任务计划操作失败。")
    exit 1
}
