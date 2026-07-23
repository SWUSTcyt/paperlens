#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$InstallRoot,
    [string]$ConfigPath,
    [string]$PythonVersion = "3.12",
    [switch]$SkipStartupTask,
    [switch]$RefuseRunningService
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
$generationPattern = '^generation_[0-9a-f]{32}$'
$maintenanceNames = @(
    "install-windows.ps1",
    "uninstall-windows.ps1",
    "manage-windows-task.ps1",
    "startup-windows.ps1",
    "update-windows.ps1"
)
$failureStage = "准备安装"

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "外部命令执行失败。"
    }
}

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

function Get-DirectoryBytes {
    param([Parameter(Mandatory = $true)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return [int64]0
    }
    $measurement = Get-ChildItem -LiteralPath $Root -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    if ($null -eq $measurement.Sum) {
        return [int64]0
    }
    return [int64]$measurement.Sum
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
    throw "配置端口仍被占用；拒绝替换运行时。"
}

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw "C1 安装入口仅支持 Windows。"
    }
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA 不可用。"
    }
    if (-not $SourceRoot) {
        $SourceRoot = Split-Path -Parent $PSScriptRoot
    }
    if (-not $InstallRoot) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA "PaperLens\MinerU\runtime"
    }
    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $env:LOCALAPPDATA "PaperLens\MinerU\paperlens-mineru.toml"
    }

    $source = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath (Join-Path $source "pyproject.toml") -PathType Leaf)) {
        throw "安装源缺少 pyproject.toml。"
    }
    foreach ($maintenanceName in $maintenanceNames) {
        if (-not (Test-Path -LiteralPath (Join-Path $source "scripts\$maintenanceName") -PathType Leaf)) {
            throw "安装源缺少 Windows 维护入口。"
        }
    }
    $install = Resolve-UncreatedPath $InstallRoot
    $config = Resolve-UncreatedPath $ConfigPath
    $installParent = Split-Path -Parent $install
    if (-not $installParent -or $install -eq [System.IO.Path]::GetPathRoot($install)) {
        throw "安装目录不能是文件系统根目录。"
    }
    if ($source -eq $install -or (Test-PathInside $source $install) -or (Test-PathInside $install $source)) {
        throw "安装目录必须与源码目录分离。"
    }
    if ($config -eq $install -or (Test-PathInside $config $install)) {
        throw "配置文件不能位于可替换的运行时目录内。"
    }

    $marker = Join-Path $install $runtimeMarkerName
    $createdInstallRoot = -not (Test-Path -LiteralPath $install)
    if (-not $createdInstallRoot) {
        if (-not (Test-Path -LiteralPath $install -PathType Container)) {
            throw "安装目标不是目录。"
        }
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
            (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim() -ne $runtimeMarkerValue) {
            throw "拒绝覆盖没有 PaperLens 标记的目录。"
        }
    }

    $uvCommand = Get-Command "uv.exe" -ErrorAction SilentlyContinue
    if (-not $uvCommand) {
        $uvCommand = Get-Command "uv" -ErrorAction SilentlyContinue
    }
    if (-not $uvCommand) {
        throw "未找到 uv，请先安装 uv。"
    }

    New-Item -ItemType Directory -Path $install -Force | Out-Null
    if ($createdInstallRoot) {
        Set-Content -LiteralPath $marker -Value $runtimeMarkerValue -Encoding UTF8 -NoNewline
    }
    $versionsRoot = Join-Path $install "versions"
    New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
    $generation = "generation_$([Guid]::NewGuid().ToString('N'))"
    $candidate = Join-Path $versionsRoot $generation
    $currentFile = Join-Path $install "current.txt"
    $previousGeneration = $null
    if (Test-Path -LiteralPath $currentFile -PathType Leaf) {
        $previousGeneration = (Get-Content -LiteralPath $currentFile -Raw -Encoding UTF8).Trim()
        if ($previousGeneration -notmatch $generationPattern) {
            throw "当前运行时标识无效。"
        }
    }
    $maintenance = Join-Path $install "maintenance"
    $maintenanceStage = Join-Path $install "maintenance.next.$([Guid]::NewGuid().ToString('N'))"
    $maintenanceBackup = Join-Path $install "maintenance.backup.$([Guid]::NewGuid().ToString('N'))"
    $maintenanceReplaced = $false
    $currentSwitched = $false
    $taskExisted = $false
    $taskRegistrationAttempted = $false

    $started = Get-Date
    try {
        $failureStage = "创建候选运行时"
        Invoke-NativeChecked $uvCommand.Source @("venv", $candidate, "--python", $PythonVersion)
        $python = Join-Path $candidate "Scripts\python.exe"
        if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
            throw "uv 未创建 Python 3.12 运行时。"
        }
        Invoke-NativeChecked $uvCommand.Source @(
            "pip", "install", "--python", $python, "--link-mode=copy", $source
        )
        $failureStage = "验证候选运行时"
        $candidateCli = Join-Path $candidate "Scripts\paperlens-mineru.exe"
        if (-not (Test-Path -LiteralPath $candidateCli -PathType Leaf)) {
            throw "安装后缺少 paperlens-mineru 命令。"
        }
        Invoke-NativeChecked $candidateCli @("init", "--config", $config)
        Invoke-NativeChecked $candidateCli @("check-config", "--config", $config)
        Invoke-NativeChecked $candidateCli @("doctor", "--config", $config)

        $failureStage = "准备维护入口"
        New-Item -ItemType Directory -Path $maintenanceStage -Force | Out-Null
        foreach ($maintenanceName in $maintenanceNames) {
            Copy-Item `
                -LiteralPath (Join-Path $source "scripts\$maintenanceName") `
                -Destination (Join-Path $maintenanceStage $maintenanceName)
        }

        # 候选版本已完整验证后，才允许停止旧服务并切换 current；候选失败时旧服务不受影响。
        if ($RefuseRunningService) {
            $failureStage = "确认服务未运行"
            $statusJson = (& $candidateCli "status" "--config" $config | Out-String)
            if ($LASTEXITCODE -ne 0) {
                throw "无法读取服务状态。"
            }
            $status = $statusJson | ConvertFrom-Json
            if (
                [int]$status.schemaVersion -ne 1 -or
                $null -eq $status.running -or
                $status.running -isnot [bool]
            ) {
                throw "服务状态格式无效。"
            }
            if ([bool]$status.running) {
                throw "服务正在运行；自动更新拒绝中断现有任务。"
            }
        }
        else {
            $failureStage = "停止旧服务"
            Invoke-NativeChecked $candidateCli @("stop", "--config", $config)
        }
        $failureStage = "验证服务端口"
        $lifecycleJson = (& $candidateCli "lifecycle-info" "--config" $config | Out-String)
        if ($LASTEXITCODE -ne 0) {
            throw "无法读取生命周期信息。"
        }
        $lifecycle = $lifecycleJson | ConvertFrom-Json
        $dataRoot = Resolve-UncreatedPath ([string]$lifecycle.dataRoot)
        if ($dataRoot -eq $install -or (Test-PathInside $dataRoot $install)) {
            throw "数据目录不能位于可替换的运行时目录内。"
        }
        Assert-LoopbackPortReleased ([int]$lifecycle.port)

        $failureStage = "切换当前运行时"
        $launcher = Join-Path $install "paperlens-mineru.cmd"
        $launcherNext = Join-Path $install "paperlens-mineru.cmd.next"
$launcherContent = @'
@echo off
setlocal
chcp 65001>nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set /p PL_MINERU_GENERATION=<"%~dp0current.txt"
"%~dp0versions\%PL_MINERU_GENERATION%\Scripts\paperlens-mineru.exe" %*
'@
        Set-Content -LiteralPath $launcherNext -Value $launcherContent -Encoding ASCII -NoNewline
        Move-Item -LiteralPath $launcherNext -Destination $launcher -Force

        if (Test-Path -LiteralPath $maintenance -PathType Container) {
            Move-Item -LiteralPath $maintenance -Destination $maintenanceBackup
        }
        Move-Item -LiteralPath $maintenanceStage -Destination $maintenance
        $maintenanceReplaced = $true

        $currentNext = Join-Path $install "current.txt.next"
        Set-Content -LiteralPath $currentNext -Value $generation -Encoding ASCII -NoNewline
        Move-Item -LiteralPath $currentNext -Destination $currentFile -Force
        $currentSwitched = $true

        if (-not $SkipStartupTask) {
            $failureStage = "注册登录任务"
            $manager = Join-Path $maintenance "manage-windows-task.ps1"
            $powershell = Join-Path $PSHOME "powershell.exe"
            & $powershell `
                "-NoProfile" `
                "-ExecutionPolicy" "Bypass" `
                "-File" $manager `
                "-Action" "Status" `
                "-InstallRoot" $install `
                "-ConfigPath" $config | Out-Null
            $taskStatusExit = $LASTEXITCODE
            if ($taskStatusExit -eq 0) {
                $taskExisted = $true
            }
            elseif ($taskStatusExit -eq 3) {
                $taskExisted = $false
            }
            else {
                $taskExisted = $true
                throw "现有登录任务不受信任或配置漂移。"
            }
            $taskRegistrationAttempted = $true
            Invoke-NativeChecked $powershell @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", $manager,
                "-Action", "Register",
                "-InstallRoot", $install,
                "-ConfigPath", $config
            )
        }
    }
    catch {
        if ($taskRegistrationAttempted -and -not $taskExisted) {
            $rollbackManager = Join-Path $maintenance "manage-windows-task.ps1"
            if (Test-Path -LiteralPath $rollbackManager -PathType Leaf) {
                $powershell = Join-Path $PSHOME "powershell.exe"
                & $powershell `
                    "-NoProfile" `
                    "-ExecutionPolicy" "Bypass" `
                    "-File" $rollbackManager `
                    "-Action" "Unregister" `
                    "-InstallRoot" $install `
                    "-ConfigPath" $config 2>$null | Out-Null
            }
        }
        if ($currentSwitched) {
            if ($previousGeneration) {
                $currentRollback = Join-Path $install "current.txt.rollback"
                Set-Content -LiteralPath $currentRollback -Value $previousGeneration -Encoding ASCII -NoNewline
                Move-Item -LiteralPath $currentRollback -Destination $currentFile -Force
            }
            else {
                Remove-Item -LiteralPath $currentFile -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath (Join-Path $install "paperlens-mineru.cmd") -Force -ErrorAction SilentlyContinue
            }
        }
        if (Test-Path -LiteralPath $maintenanceStage -PathType Container) {
            Remove-Item -LiteralPath $maintenanceStage -Recurse -Force
        }
        if ($maintenanceReplaced) {
            if (Test-Path -LiteralPath $maintenance -PathType Container) {
                Remove-Item -LiteralPath $maintenance -Recurse -Force
            }
            if (Test-Path -LiteralPath $maintenanceBackup -PathType Container) {
                Move-Item -LiteralPath $maintenanceBackup -Destination $maintenance
            }
        }
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
        if ($createdInstallRoot -and -not (Test-Path -LiteralPath $currentFile -PathType Leaf)) {
            Remove-Item -LiteralPath $install -Recurse -Force
        }
        throw
    }

    if (Test-Path -LiteralPath $maintenanceBackup -PathType Container) {
        Remove-Item -LiteralPath $maintenanceBackup -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($previousGeneration -and $previousGeneration -ne $generation) {
        $previous = Join-Path $versionsRoot $previousGeneration
        if ((Test-PathInside $previous $versionsRoot) -and (Test-Path -LiteralPath $previous -PathType Container)) {
            Remove-Item -LiteralPath $previous -Recurse -Force
        }
    }

    $elapsed = [Math]::Round(((Get-Date) - $started).TotalSeconds, 2)
    $runtimeBytes = Get-DirectoryBytes $install
    Write-Output "PaperLens MinerU Windows 安装完成。"
    Write-Output "launcher=$install\paperlens-mineru.cmd"
    Write-Output $(if ($SkipStartupTask) { "startupTask=skipped" } else { "startupTask=registered" })
    Write-Output "installSeconds=$elapsed"
    Write-Output "runtimeBytes=$runtimeBytes"
}
catch {
    Write-Error "安装失败（$failureStage）；旧运行时和用户配置未被覆盖。"
    exit 1
}
