#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$WorkRoot,
    [string]$RepositoryRoot,
    [int]$HealthTimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

if (-not $RepositoryRoot) {
    $RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
}
if (-not $WorkRoot) {
    $WorkRoot = Join-Path $RepositoryRoot "local-artifacts\mineru-c2-lifecycle"
}
$work = [System.IO.Path]::GetFullPath($WorkRoot)
$repository = (Resolve-Path -LiteralPath $RepositoryRoot).Path
if (Test-Path -LiteralPath $work) {
    throw "生命周期验收目录必须从不存在的空路径开始。"
}
if (-not $work.StartsWith(
    ([System.IO.Path]::GetFullPath($repository).TrimEnd('\') + '\'),
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "生命周期验收目录必须位于仓库内。"
}

$source = Join-Path $repository "services\mineru"
$installer = Join-Path $source "scripts\install-windows.ps1"
$uninstaller = Join-Path $source "scripts\uninstall-windows.ps1"
$runtime = Join-Path $work "runtime"
$data = Join-Path $work "data"
$config = Join-Path $data "paperlens-mineru.toml"
$stdoutLog = Join-Path $work "service.stdout.log"
$stderrLog = Join-Path $work "service.stderr.log"
$service = $null

function Repair-DuplicatePathEnvironment {
    # Codex/IDE 进程可能同时注入 Path 与 PATH；PowerShell 5.1 的 Start-Process 会因此失败。
    $pathValue = [System.Environment]::GetEnvironmentVariable(
        "PATH",
        [System.EnvironmentVariableTarget]::Process
    )
    [System.Environment]::SetEnvironmentVariable("Path", $null, [System.EnvironmentVariableTarget]::Process)
    [System.Environment]::SetEnvironmentVariable("PATH", $null, [System.EnvironmentVariableTarget]::Process)
    [System.Environment]::SetEnvironmentVariable("PATH", $pathValue, [System.EnvironmentVariableTarget]::Process)
}

function Invoke-CheckedCaptured {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $captured = (& $FilePath @Arguments 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw $FailureMessage
    }
    return $captured
}

function Get-ServicePython {
    $generation = (Get-Content -LiteralPath (Join-Path $runtime "current.txt") -Raw -Encoding UTF8).Trim()
    if ($generation -notmatch '^generation_[0-9a-f]{32}$') {
        throw "当前运行时标识无效。"
    }
    return Join-Path $runtime "versions\$generation\Scripts\python.exe"
}

function Start-MineruService {
    Repair-DuplicatePathEnvironment
    $python = Get-ServicePython
    $arguments = '-m paperlens_mineru.cli serve --config "' + $config + '"'
    return Start-Process -FilePath $python -ArgumentList $arguments `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -WindowStyle Hidden -PassThru
}

function Wait-ServiceReady {
    param([Parameter(Mandatory = $true)]$Process)

    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            throw "生命周期验收服务在 ready 前退出。"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:17860/v1/health" -TimeoutSec 3
            if ($health.status -eq "ready" -and $health.schemaVersion -eq 1) {
                return
            }
        }
        catch {
            # 依赖导入期间继续等待，不打印可能含本机路径的底层异常。
        }
        Start-Sleep -Seconds 1
    }
    throw "生命周期验收服务未在时限内 ready。"
}

function Assert-PortReleased {
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        $listener = New-Object System.Net.Sockets.TcpListener(
            [System.Net.IPAddress]::Loopback,
            17860
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
    throw "生命周期验收后服务端口未释放。"
}

New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    $installArguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installer,
        "-SourceRoot", $source, "-InstallRoot", $runtime, "-ConfigPath", $config
    )
    $null = Invoke-CheckedCaptured "powershell.exe" $installArguments "真实首次安装失败。"
    $configHash = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    $firstGeneration = (Get-Content -LiteralPath (Join-Path $runtime "current.txt") -Raw).Trim()

    $service = Start-MineruService
    Wait-ServiceReady $service
    $null = Invoke-CheckedCaptured "powershell.exe" $installArguments "真实同版本修复失败。"
    $service.WaitForExit(15000) | Out-Null
    if (-not $service.HasExited) {
        throw "同版本修复没有停止旧服务。"
    }
    Assert-PortReleased
    $secondGeneration = (Get-Content -LiteralPath (Join-Path $runtime "current.txt") -Raw).Trim()
    if ($firstGeneration -eq $secondGeneration) {
        throw "同版本修复没有切换到新运行时 generation。"
    }
    if ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ne $configHash) {
        throw "同版本修复覆盖了用户配置。"
    }

    New-Item -ItemType Directory -Path (Join-Path $data "tasks"), (Join-Path $data "models") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $data "tasks\preserved.txt") -Value "task" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $data "models\preserved.txt") -Value "model" -Encoding ASCII
    $service = Start-MineruService
    Wait-ServiceReady $service
    $preserveArguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $uninstaller,
        "-InstallRoot", $runtime, "-ConfigPath", $config
    )
    $null = Invoke-CheckedCaptured "powershell.exe" $preserveArguments "真实保留数据卸载失败。"
    $service.WaitForExit(15000) | Out-Null
    Assert-PortReleased
    if ((Test-Path -LiteralPath $runtime) -or
        -not (Test-Path -LiteralPath $config -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $data "tasks\preserved.txt") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $data "models\preserved.txt") -PathType Leaf)) {
        throw "默认卸载没有严格保留配置、任务或模型缓存。"
    }

    $null = Invoke-CheckedCaptured "powershell.exe" $installArguments "保留数据卸载后的重装失败。"
    if ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -ne $configHash) {
        throw "卸载后重装没有保留原 token/config。"
    }
    $service = Start-MineruService
    Wait-ServiceReady $service
    $purgeArguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $uninstaller,
        "-InstallRoot", $runtime, "-ConfigPath", $config,
        "-PurgeData", "-ConfirmPurge", "DELETE PAPERLENS MINERU DATA"
    )
    $null = Invoke-CheckedCaptured "powershell.exe" $purgeArguments "真实完整清理失败。"
    $service.WaitForExit(15000) | Out-Null
    Assert-PortReleased
    if ((Test-Path -LiteralPath $runtime) -or (Test-Path -LiteralPath $data)) {
        throw "完整清理后仍残留 PaperLens MinerU 运行时或数据。"
    }

    Write-Output "C2 Windows 生命周期关键路径通过：修复、保留卸载、重装恢复、双确认完整清理。"
}
finally {
    if ($service -and -not $service.HasExited) {
        $service.Kill()
        $service.WaitForExit(10000) | Out-Null
    }
    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
}
