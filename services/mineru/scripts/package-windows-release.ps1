#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$SourceRoot,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$temporary = $null

function Resolve-UncreatedPath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return [System.IO.Path]::GetFullPath(
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
    )
}

try {
    if (-not $SourceRoot) {
        $SourceRoot = Split-Path -Parent $PSScriptRoot
    }
    $source = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path
    $output = Resolve-UncreatedPath $OutputDirectory
    $pyproject = Join-Path $source "pyproject.toml"
    if (-not (Test-Path -LiteralPath $pyproject -PathType Leaf)) {
        throw "源码缺少 pyproject.toml。"
    }
    $metadata = Get-Content -LiteralPath $pyproject -Raw -Encoding UTF8
    $versionMatch = [regex]::Match(
        $metadata,
        '(?m)^version = "(?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))"\r?$'
    )
    if (-not $versionMatch.Success) {
        throw "服务版本不是稳定 SemVer。"
    }
    $version = $versionMatch.Groups["version"].Value
    $archiveName = "paperlens-mineru-windows-$version.zip"
    $checksumName = "$archiveName.sha256"
    $archivePath = Join-Path $output $archiveName
    $checksumPath = Join-Path $output $checksumName
    if (-not $Force -and (
        (Test-Path -LiteralPath $archivePath) -or
        (Test-Path -LiteralPath $checksumPath)
    )) {
        throw "Release 资产已存在；如需覆盖请显式使用 -Force。"
    }

    New-Item -ItemType Directory -Path $output -Force | Out-Null
    if ($Force) {
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $checksumPath -Force -ErrorAction SilentlyContinue
    }

    $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $temporary = Join-Path $temporaryBase "paperlens-mineru-release-$([Guid]::NewGuid().ToString('N'))"
    $temporary = [System.IO.Path]::GetFullPath($temporary)
    if (-not $temporary.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "临时目录边界无效。"
    }
    $package = Join-Path $temporary "paperlens-mineru"
    New-Item -ItemType Directory -Path $package -Force | Out-Null
    Copy-Item -LiteralPath $pyproject -Destination (Join-Path $package "pyproject.toml")
    Copy-Item -LiteralPath (Join-Path $source "README.md") -Destination (Join-Path $package "README.md")
    Copy-Item -LiteralPath (Join-Path $source "src") -Destination (Join-Path $package "src") -Recurse
    Copy-Item -LiteralPath (Join-Path $source "schemas") -Destination (Join-Path $package "schemas") -Recurse
    $packageFull = [System.IO.Path]::GetFullPath($package)
    $packagePrefix = $packageFull.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    foreach ($cache in Get-ChildItem -LiteralPath $package -Directory -Filter "__pycache__" -Recurse -Force) {
        $cacheFull = [System.IO.Path]::GetFullPath($cache.FullName)
        if (-not $cacheFull.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "缓存清理目标越出临时包目录。"
        }
        Remove-Item -LiteralPath $cacheFull -Recurse -Force
    }
    foreach ($compiled in Get-ChildItem -LiteralPath $package -File -Recurse -Force) {
        if ($compiled.Extension -in @(".pyc", ".pyo")) {
            $compiledFull = [System.IO.Path]::GetFullPath($compiled.FullName)
            if (-not $compiledFull.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "缓存清理目标越出临时包目录。"
            }
            Remove-Item -LiteralPath $compiledFull -Force
        }
    }
    $scripts = Join-Path $package "scripts"
    New-Item -ItemType Directory -Path $scripts -Force | Out-Null
    foreach ($name in @(
        "install-windows.ps1",
        "uninstall-windows.ps1",
        "manage-windows-task.ps1",
        "startup-windows.ps1",
        "update-windows.ps1"
    )) {
        Copy-Item -LiteralPath (Join-Path $source "scripts\$name") -Destination (Join-Path $scripts $name)
    }

    Compress-Archive -LiteralPath $package -DestinationPath $archivePath -CompressionLevel Optimal
    $digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        $checksumPath,
        "$digest  $archiveName`n",
        [System.Text.Encoding]::ASCII
    )
    [Console]::Out.WriteLine("archive=$archiveName")
    [Console]::Out.WriteLine("checksum=$checksumName")
}
catch {
    [Console]::Error.WriteLine("RELEASE_PACKAGE_FAILED: Windows 更新资产打包失败。")
    exit 1
}
finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary -PathType Container)) {
        $temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $resolvedTemporary = [System.IO.Path]::GetFullPath($temporary)
        if ($resolvedTemporary.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
