#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$SourceRoot,
    [string]$InstallRoot,
    [string]$ConfigPath,
    [string]$PythonVersion = "3.12"
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

        # 候选版本已完整验证后，才允许停止旧服务并切换 current；候选失败时旧服务不受影响。
        $failureStage = "停止旧服务"
        Invoke-NativeChecked $candidateCli @("stop", "--config", $config)
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

        $currentNext = Join-Path $install "current.txt.next"
        Set-Content -LiteralPath $currentNext -Value $generation -Encoding ASCII -NoNewline
        Move-Item -LiteralPath $currentNext -Destination $currentFile -Force
    }
    catch {
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
        if ($createdInstallRoot -and -not (Test-Path -LiteralPath $currentFile -PathType Leaf)) {
            Remove-Item -LiteralPath $install -Recurse -Force
        }
        throw
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
    Write-Output "installSeconds=$elapsed"
    Write-Output "runtimeBytes=$runtimeBytes"
}
catch {
    Write-Error "安装失败（$failureStage）；旧运行时和用户配置未被覆盖。"
    exit 1
}
