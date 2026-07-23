#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Scheduled", "CheckOnly", "UpdateNow")]
    [string]$Action,
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
$dataMarkerName = ".paperlens-mineru-data"
$dataMarkerValue = "paperlens-mineru-data-v1"
$failureCode = "UPDATE_FAILED"
$stage = $null
$lockPath = $null
$lockStream = $null
$ownsLock = $false
$updatesRoot = $null

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

function Invoke-LauncherJson {
    param(
        [Parameter(Mandatory = $true)][string]$Launcher,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $output = (& $Launcher @Arguments | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "本地更新命令失败。"
    }
    try {
        return $output | ConvertFrom-Json
    }
    catch {
        throw "本地更新命令返回无效状态。"
    }
}

function Write-SafeJson {
    param([Parameter(Mandatory = $true)][hashtable]$Value)

    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
}

function Write-UpdateState {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Code,
        [string]$LatestVersion
    )

    $state = @{
        schemaVersion = 1
        attemptedAt = [DateTime]::UtcNow.ToString("o")
        code = $Code
        latestVersion = $LatestVersion
    } | ConvertTo-Json -Compress
    $stateNext = Join-Path $Root ".update-state.$([Guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllText(
        $stateNext,
        $state,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Move-Item -LiteralPath $stateNext -Destination (Join-Path $Root "update-state.json") -Force
}

function Get-SafeInstallStage {
    param([Parameter(Mandatory = $true)][string]$Output)

    $stages = [ordered]@{
        "准备安装" = "PREPARE"
        "创建候选运行时" = "CREATE_CANDIDATE"
        "验证候选运行时" = "VALIDATE_CANDIDATE"
        "准备维护入口" = "STAGE_MAINTENANCE"
        "确认服务未运行" = "CHECK_NOT_RUNNING"
        "停止旧服务" = "STOP_SERVICE"
        "验证服务端口" = "CHECK_PORT"
        "切换当前运行时" = "SWITCH_RUNTIME"
        "注册登录任务" = "REGISTER_TASK"
    }
    foreach ($label in $stages.Keys) {
        if ($Output.Contains("安装失败（$label）")) {
            return [string]$stages[$label]
        }
    }
    return "UNKNOWN"
}

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        $failureCode = "PLATFORM_UNSUPPORTED"
        throw "更新入口仅支持 Windows。"
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
    $installer = Join-Path $install "maintenance\install-windows.ps1"
    if (
        -not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim() -cne $runtimeMarkerValue
    ) {
        $failureCode = "RUNTIME_UNTRUSTED"
        throw "运行时标记无效。"
    }
    if (
        -not (Test-Path -LiteralPath $launcher -PathType Leaf) -or
        -not (Test-Path -LiteralPath $installer -PathType Leaf) -or
        -not (Test-Path -LiteralPath $config -PathType Leaf)
    ) {
        $failureCode = "RUNTIME_INCOMPLETE"
        throw "运行时、安装器或配置不完整。"
    }

    $status = Invoke-LauncherJson $launcher @("status", "--config", $config)
    if (
        [int]$status.schemaVersion -ne 1 -or
        $null -eq $status.running -or
        $status.running -isnot [bool]
    ) {
        $failureCode = "SERVICE_STATUS_INVALID"
        throw "服务状态格式无效。"
    }
    if ([bool]$status.running -and $Action -ne "CheckOnly") {
        Write-SafeJson @{
            schemaVersion = 1
            code = "UPDATE_SKIPPED_SERVICE_RUNNING"
        }
        exit 0
    }

    $lifecycle = Invoke-LauncherJson $launcher @("lifecycle-info", "--config", $config)
    $dataRoot = Resolve-UncreatedPath ([string]$lifecycle.dataRoot)
    $dataMarker = Join-Path $dataRoot $dataMarkerName
    if (
        -not [bool]$lifecycle.dataMarkerValid -or
        -not (Test-Path -LiteralPath $dataMarker -PathType Leaf) -or
        (Get-Content -LiteralPath $dataMarker -Raw -Encoding UTF8).Trim() -cne $dataMarkerValue -or
        $dataRoot -eq $install -or
        (Test-PathInside $dataRoot $install)
    ) {
        $failureCode = "DATA_ROOT_UNTRUSTED"
        throw "数据目录标记或边界无效。"
    }
    $updatesRoot = Join-Path $dataRoot "updates"
    New-Item -ItemType Directory -Path $updatesRoot -Force | Out-Null
    $lockPath = Join-Path $updatesRoot ".paperlens-mineru-update.lock"
    try {
        $lockStream = New-Object System.IO.FileStream(
            $lockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $ownsLock = $true
    }
    catch [System.IO.IOException] {
        try {
            # 文件存在但没有进程持有独占句柄时视为崩溃遗留，可安全接管。
            $lockStream = New-Object System.IO.FileStream(
                $lockPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
            $lockStream.SetLength(0)
            $ownsLock = $true
        }
        catch [System.IO.IOException] {
            Write-SafeJson @{
                schemaVersion = 1
                code = "UPDATE_SKIPPED_BUSY"
            }
            exit 0
        }
    }
    if (-not $ownsLock) {
        Write-SafeJson @{
            schemaVersion = 1
            code = "UPDATE_SKIPPED_BUSY"
        }
        exit 0
    }

    if ($Action -eq "CheckOnly") {
        $failureCode = "UPDATE_CHECK_FAILED"
        $result = Invoke-LauncherJson $launcher @("update-check", "--config", $config)
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
        exit 0
    }

    $stage = Join-Path $updatesRoot "staging_$([Guid]::NewGuid().ToString('N'))"
    $prepareArguments = @(
        "update-prepare",
        "--destination", $stage,
        "--config", $config
    )
    if ($Action -eq "Scheduled") {
        $prepareArguments += "--scheduled"
    }
    $failureCode = "UPDATE_PREPARE_FAILED"
    $prepared = Invoke-LauncherJson $launcher $prepareArguments
    if ($prepared.code -in @("UPDATE_INTERVAL_SKIPPED", "UPDATE_CURRENT")) {
        [Console]::Out.WriteLine(($prepared | ConvertTo-Json -Compress))
        exit 0
    }
    if (
        $prepared.code -cne "UPDATE_PREPARED" -or
        -not ($prepared.latestVersion -is [string])
    ) {
        $failureCode = "UPDATE_PREPARE_INVALID"
        throw "更新准备结果不符合冻结契约。"
    }
    $source = Join-Path $stage "paperlens-mineru"
    if (-not (Test-Path -LiteralPath (Join-Path $source "pyproject.toml") -PathType Leaf)) {
        $failureCode = "UPDATE_PACKAGE_INVALID"
        throw "更新暂存包结构无效。"
    }

    # 下载期间可能有用户手动启动服务；安装前再次只读确认，运行中绝不停止。
    $status = Invoke-LauncherJson $launcher @("status", "--config", $config)
    if ([bool]$status.running) {
        Write-SafeJson @{
            schemaVersion = 1
            code = "UPDATE_SKIPPED_SERVICE_RUNNING"
        }
        exit 0
    }

    $failureCode = "UPDATE_INSTALL_FAILED"
    $powershell = Join-Path $PSHOME "powershell.exe"
    $previousErrorPreference = $ErrorActionPreference
    try {
        # uv 的正常进度会写 stderr；这里只捕获并丢弃，最终仍严格按子进程退出码裁决。
        $ErrorActionPreference = "Continue"
        $installOutput = (& $powershell `
            "-NoProfile" `
            "-ExecutionPolicy" "Bypass" `
            "-File" $installer `
            "-SourceRoot" $source `
            "-InstallRoot" $install `
            "-ConfigPath" $config `
            "-SkipStartupTask" `
            "-RefuseRunningService" 2>&1 | Out-String)
        $installExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorPreference
    }
    if ($installExitCode -ne 0) {
        $installStage = Get-SafeInstallStage $installOutput
        Write-UpdateState $updatesRoot "UPDATE_INSTALL_FAILED" ([string]$prepared.latestVersion)
        [Console]::Error.WriteLine(
            "UPDATE_INSTALL_FAILED: stage=$installStage; 候选更新失败，旧运行时保持可用。"
        )
        exit 2
    }

    $version = Invoke-LauncherJson $launcher @("version")
    if ([string]$version.serviceVersion -cne [string]$prepared.latestVersion) {
        $failureCode = "UPDATE_VERSION_MISMATCH"
        throw "切换后的服务版本与稳定 Release 不一致。"
    }
    Write-UpdateState $updatesRoot "UPDATE_APPLIED" ([string]$prepared.latestVersion)
    Write-SafeJson @{
        schemaVersion = 1
        code = "UPDATE_APPLIED"
        serviceVersion = [string]$version.serviceVersion
    }
}
catch {
    [Console]::Error.WriteLine("${failureCode}: 自动更新失败，旧运行时保持不变。")
    exit 2
}
finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
    if ($ownsLock -and $lockPath -and (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
    if ($stage -and (Test-Path -LiteralPath $stage -PathType Container)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
