#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$ConfigPath,
    [string]$RepositoryRoot,
    [int]$HealthTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "关键路径命令执行失败。"
    }
}

function Repair-DuplicatePathEnvironment {
    # Codex/IDE 进程可能同时注入 Path 与 PATH；PowerShell 5.1 甚至无法枚举 Env:。
    $pathValue = [System.Environment]::GetEnvironmentVariable(
        "PATH",
        [System.EnvironmentVariableTarget]::Process
    )
    [System.Environment]::SetEnvironmentVariable("Path", $null, [System.EnvironmentVariableTarget]::Process)
    [System.Environment]::SetEnvironmentVariable("PATH", $null, [System.EnvironmentVariableTarget]::Process)
    [System.Environment]::SetEnvironmentVariable("PATH", $pathValue, [System.EnvironmentVariableTarget]::Process)
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
if (-not $RepositoryRoot) {
    $RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
}

$launcher = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) "paperlens-mineru.cmd"
$currentFile = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) "current.txt"
$config = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "未找到已安装的 paperlens-mineru 启动器。"
}
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw "未找到 PaperLens MinerU 配置。"
}
$generation = (Get-Content -LiteralPath $currentFile -Raw -Encoding UTF8).Trim()
if ($generation -notmatch '^generation_[0-9a-f]{32}$') {
    throw "当前运行时标识无效。"
}
$servicePython = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) "versions\$generation\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $servicePython -PathType Leaf)) {
    throw "当前 Python 运行时不存在。"
}
$configText = Get-Content -LiteralPath $config -Raw -Encoding UTF8
$portMatch = [regex]::Match($configText, '(?m)^port\s*=\s*(\d+)\s*$')
if (-not $portMatch.Success) {
    throw "配置缺少合法端口。"
}
$port = [int]$portMatch.Groups[1].Value
$stdoutLog = [System.IO.Path]::GetTempFileName()
$stderrLog = [System.IO.Path]::GetTempFileName()
$service = $null

try {
    Repair-DuplicatePathEnvironment
    $serviceArguments = '-m paperlens_mineru.cli serve --config "' + $config + '"'
    $service = Start-Process -FilePath $servicePython `
        -ArgumentList $serviceArguments `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -WindowStyle Hidden `
        -PassThru

    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($service.HasExited) {
            throw "服务在 health ready 前退出。"
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/health" -TimeoutSec 3
            if ($health.status -eq "ready" -and
                $health.schemaVersion -eq 1 -and
                $health.engine.version -eq "3.4.4" -and
                $health.engine.backend -eq "pipeline") {
                $ready = $true
                break
            }
        }
        catch {
            # 服务导入依赖期间继续等待；不回显可能含本机路径的底层异常。
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        throw "服务 health 在时限内未 ready。"
    }

    Invoke-NativeChecked $launcher @("doctor", "--config", $config, "--health")
    $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if (-not $node) {
        $node = Get-Command "node" -ErrorAction SilentlyContinue
    }
    if (-not $node) {
        throw "未找到 Node.js，无法验证扩展 MinerU client。"
    }
    $clientSmoke = Join-Path $RepositoryRoot "tests\helpers\mineruClientSmoke.mjs"
    Invoke-NativeChecked $node.Source @($clientSmoke, "--config=$config")
    Write-Output "C1 Windows 安装关键路径通过：health ready + 扩展连接成功。"
}
finally {
    if ($service -and -not $service.HasExited) {
        try {
            $service.Kill()
            $service.WaitForExit(10000) | Out-Null
        }
        catch {
            # 继续用端口事实检查是否已清理，不回显底层进程异常。
        }
    }
    $portReleased = $false
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            $probe = New-Object System.Net.Sockets.TcpClient
            $probe.Connect("127.0.0.1", $port)
            $probe.Dispose()
        }
        catch {
            $portReleased = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
    if (-not $portReleased) {
        throw "验收服务未释放本机端口。"
    }
}
