#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$ConfigPath,
    [switch]$RemoveTaskAfter
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

function Invoke-Manager {
    param(
        [Parameter(Mandatory = $true)][string]$Manager,
        [Parameter(Mandatory = $true)][string]$TaskAction,
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$Config
    )

    $powershell = Join-Path $PSHOME "powershell.exe"
    $output = (& $powershell `
        "-NoProfile" `
        "-ExecutionPolicy" "Bypass" `
        "-File" $Manager `
        "-Action" $TaskAction `
        "-InstallRoot" $Runtime `
        "-ConfigPath" $Config | Out-String)
    return @{
        ExitCode = $LASTEXITCODE
        Output = $output
    }
}

function Assert-PortReleased {
    param([Parameter(Mandatory = $true)][int]$Port)

    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        $listener = New-Object System.Net.Sockets.TcpListener(
            [System.Net.IPAddress]::Loopback,
            $Port
        )
        $listener.Server.ExclusiveAddressUse = $true
        try {
            $listener.Start()
            $listener.Stop()
            return
        }
        catch {
            $listener.Stop()
            Start-Sleep -Milliseconds 250
        }
    }
    throw "服务端口未释放。"
}

if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA 不可用。"
}
if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "PaperLens\MinerU\runtime"
}
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $env:LOCALAPPDATA "PaperLens\MinerU\paperlens-mineru.toml"
}

$runtime = [System.IO.Path]::GetFullPath(
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallRoot)
)
$config = [System.IO.Path]::GetFullPath(
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ConfigPath)
)
$launcher = Join-Path $runtime "paperlens-mineru.cmd"
$manager = Join-Path $runtime "maintenance\manage-windows-task.ps1"
$taskExisted = $false
$serviceStarted = $false
$port = 0

try {
    $before = Invoke-Manager $manager "Status" $runtime $config
    if ($before.ExitCode -eq 0) {
        $taskExisted = $true
    }
    elseif ($before.ExitCode -ne 3) {
        throw "无法确认测试前的任务状态。"
    }

    $registered = Invoke-Manager $manager "Register" $runtime $config
    if ($registered.ExitCode -ne 0) {
        throw "登录任务注册失败。"
    }
    $registeredAgain = Invoke-Manager $manager "Register" $runtime $config
    if ($registeredAgain.ExitCode -ne 0) {
        throw "登录任务重复注册失败。"
    }
    $status = Invoke-Manager $manager "Status" $runtime $config
    if ($status.ExitCode -ne 0 -or -not ($status.Output | ConvertFrom-Json).configured) {
        throw "登录任务状态不符合冻结契约。"
    }

    $lifecycle = (& $launcher "lifecycle-info" "--config" $config | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取服务生命周期信息。"
    }
    $port = [int]$lifecycle.port
    $statePath = Join-Path ([string]$lifecycle.dataRoot) ".paperlens-mineru-service.json"

    $started = Invoke-Manager $manager "Run" $runtime $config
    if ($started.ExitCode -ne 0) {
        throw "登录任务立即运行失败。"
    }
    $serviceStarted = $true
    $health = $null
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
        try {
            $health = Invoke-RestMethod `
                -Uri "http://127.0.0.1:$port/v1/health" `
                -TimeoutSec 2 `
                -UseBasicParsing
            if ($health.status -eq "ready") {
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if ($null -eq $health -or $health.status -ne "ready") {
        throw "计划任务启动后 health 未进入 ready。"
    }
    $firstState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json

    $runAgain = Invoke-Manager $manager "Run" $runtime $config
    if ($runAgain.ExitCode -ne 0) {
        throw "运行中任务的重复启动请求失败。"
    }
    Start-Sleep -Seconds 2
    $secondState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$firstState.pid -ne [int]$secondState.pid) {
        throw "重复运行创建了新的服务进程。"
    }

    Write-Output "taskContract=ready"
    Write-Output "health=ready"
    Write-Output "duplicateStart=same-process"
}
finally {
    if ($serviceStarted -and (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        & $launcher "stop" "--config" $config | Out-Null
    }
    if ($port -gt 0) {
        Assert-PortReleased $port
    }
    if ($RemoveTaskAfter -or -not $taskExisted) {
        $removed = Invoke-Manager $manager "Unregister" $runtime $config
        if ($removed.ExitCode -ne 0) {
            throw "测试结束后任务移除失败。"
        }
    }
}
