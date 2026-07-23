#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$ConfigPath
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
$failureCode = "STARTUP_FAILED"

function Resolve-UncreatedPath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return [System.IO.Path]::GetFullPath(
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
    )
}

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        $failureCode = "PLATFORM_UNSUPPORTED"
        throw "登录启动入口仅支持 Windows。"
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
    if (
        -not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim() -cne $runtimeMarkerValue
    ) {
        $failureCode = "RUNTIME_UNTRUSTED"
        throw "运行时标记无效。"
    }
    if (
        -not (Test-Path -LiteralPath $launcher -PathType Leaf) -or
        -not (Test-Path -LiteralPath $config -PathType Leaf)
    ) {
        $failureCode = "RUNTIME_INCOMPLETE"
        throw "运行时或配置不完整。"
    }

    $statusJson = (& $launcher "status" "--config" $config | Out-String)
    if ($LASTEXITCODE -ne 0) {
        $failureCode = "SERVICE_STATUS_FAILED"
        throw "无法读取服务状态。"
    }
    $status = $statusJson | ConvertFrom-Json
    if (
        [int]$status.schemaVersion -ne 1 -or
        $null -eq $status.running -or
        $status.running -isnot [bool]
    ) {
        $failureCode = "SERVICE_STATUS_INVALID"
        throw "服务状态格式无效。"
    }
    if ([bool]$status.running) {
        [Console]::Out.WriteLine("SERVICE_ALREADY_RUNNING")
        exit 0
    }

    $updater = Join-Path $install "maintenance\update-windows.ps1"
    if (Test-Path -LiteralPath $updater -PathType Leaf) {
        $powershell = Join-Path $PSHOME "powershell.exe"
        & $powershell `
            "-NoProfile" `
            "-NonInteractive" `
            "-ExecutionPolicy" "Bypass" `
            "-File" $updater `
            "-Action" "Scheduled" `
            "-InstallRoot" $install `
            "-ConfigPath" $config
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine("UPDATE_FAILED_CONTINUING: 自动更新失败，继续启动现有服务。")
        }
    }

    & $launcher "serve" "--config" $config
    if ($LASTEXITCODE -ne 0) {
        $failureCode = "SERVICE_START_FAILED"
        throw "服务启动失败。"
    }
}
catch {
    [Console]::Error.WriteLine("${failureCode}: 登录启动失败。")
    exit 1
}
