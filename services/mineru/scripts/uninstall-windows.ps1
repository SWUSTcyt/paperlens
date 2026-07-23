#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$ConfigPath,
    [switch]$PurgeData,
    [string]$ConfirmPurge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$runtimeMarkerName = ".paperlens-mineru-runtime"
$runtimeMarkerValue = "paperlens-mineru-runtime-v1"
$dataMarkerName = ".paperlens-mineru-data"
$dataMarkerValue = "paperlens-mineru-data-v1"
$purgePhrase = "DELETE PAPERLENS MINERU DATA"
$failureStage = "验证卸载参数"

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

function Assert-SafeDirectory {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $root = [System.IO.Path]::GetPathRoot($Directory)
    $profile = [System.IO.Path]::GetFullPath([System.Environment]::GetFolderPath("UserProfile"))
    $local = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
    if ($Directory -eq $root -or $Directory -eq $profile -or $Directory -eq $local) {
        throw "拒绝删除过宽的数据目录。"
    }
}

function Assert-LoopbackPortReleased {
    param([Parameter(Mandatory = $true)][int]$Port)

    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
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
    throw "服务端口仍被占用；卸载已中止。"
}

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw "C2 卸载入口仅支持 Windows。"
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
    if ($PurgeData -and $ConfirmPurge -cne $purgePhrase) {
        throw "完整清理需要 -PurgeData 与精确确认短语。"
    }
    if (-not $PurgeData -and $ConfirmPurge) {
        throw "ConfirmPurge 只能与 PurgeData 同时使用。"
    }

    $failureStage = "验证运行时与配置"
    $install = Resolve-UncreatedPath $InstallRoot
    $config = Resolve-UncreatedPath $ConfigPath
    $marker = Join-Path $install $runtimeMarkerName
    $launcher = Join-Path $install "paperlens-mineru.cmd"
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim() -ne $runtimeMarkerValue) {
        throw "拒绝卸载没有 PaperLens 标记的运行时目录。"
    }
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "运行时缺少 PaperLens MinerU 启动器。"
    }
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
        throw "未找到 PaperLens MinerU 配置。"
    }

    $failureStage = "移除登录任务"
    $taskManager = Join-Path $install "maintenance\manage-windows-task.ps1"
    if (Test-Path -LiteralPath $taskManager -PathType Leaf) {
        $powershell = Join-Path $PSHOME "powershell.exe"
        & $powershell `
            "-NoProfile" `
            "-ExecutionPolicy" "Bypass" `
            "-File" $taskManager `
            "-Action" "Unregister" `
            "-InstallRoot" $install `
            "-ConfigPath" $config | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "无法安全移除 PaperLens MinerU 登录任务。"
        }
    }
    elseif ($null -ne (Get-ScheduledTask -TaskName "PaperLens MinerU" -TaskPath "\" -ErrorAction SilentlyContinue)) {
        throw "运行时缺少任务管理入口，拒绝留下无法验证的登录任务。"
    }

    $failureStage = "验证数据目录"
    $lifecycleJson = (& $launcher "lifecycle-info" "--config" $config | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取生命周期信息。"
    }
    $lifecycle = $lifecycleJson | ConvertFrom-Json
    $dataRoot = Resolve-UncreatedPath ([string]$lifecycle.dataRoot)
    if ($dataRoot -eq $install -or (Test-PathInside $dataRoot $install)) {
        throw "数据目录位于运行时目录内，拒绝执行可能删除用户数据的卸载。"
    }
    if ($PurgeData) {
        Assert-SafeDirectory $dataRoot
        $dataMarker = Join-Path $dataRoot $dataMarkerName
        if (-not [bool]$lifecycle.dataMarkerValid -or
            -not (Test-Path -LiteralPath $dataMarker -PathType Leaf) -or
            (Get-Content -LiteralPath $dataMarker -Raw -Encoding UTF8).Trim() -ne $dataMarkerValue) {
            throw "拒绝清理没有 PaperLens 标记的数据目录。"
        }
    }

    $failureStage = "停止服务"
    & $launcher "stop" "--config" $config
    if ($LASTEXITCODE -ne 0) {
        throw "PaperLens MinerU 服务未能安全停止。"
    }
    Assert-LoopbackPortReleased ([int]$lifecycle.port)

    $failureStage = if ($PurgeData) { "完整清理" } else { "删除运行时" }
    if ($PurgeData) {
        if ($install -ne $dataRoot -and -not (Test-PathInside $install $dataRoot)) {
            Remove-Item -LiteralPath $install -Recurse -Force
        }
        if (Test-Path -LiteralPath $dataRoot) {
            Remove-Item -LiteralPath $dataRoot -Recurse -Force
        }
        if ((Test-Path -LiteralPath $config) -and -not (Test-PathInside $config $dataRoot)) {
            Remove-Item -LiteralPath $config -Force
        }
        Write-Output "PaperLens MinerU 运行时、配置、任务与专用模型缓存已完整清理。"
    }
    else {
        Remove-Item -LiteralPath $install -Recurse -Force
        Write-Output "PaperLens MinerU 运行时已卸载；配置、任务与专用模型缓存已保留。"
    }
}
catch {
    Write-Error "卸载失败（$failureStage）；未执行未经确认的数据清理。请检查确认参数、配置，或先运行安装器修复后重试。"
    exit 1
}
