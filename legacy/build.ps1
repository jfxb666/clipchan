# Clipchan 构建脚本
# 用系统自带的 csc.exe 编译，无需安装任何 SDK。
[CmdletBinding()]
param(
    [switch]$NoIcon
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir  = Join-Path $root 'src'
$outDir  = Join-Path $root 'dist'
$exe     = Join-Path $outDir 'Clipchan.exe'
$icon    = Join-Path $outDir 'app.ico'

function Find-Csc {
    $cands = @(
        "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
    foreach ($c in $cands) { if (Test-Path $c) { return $c } }
    throw "找不到 csc.exe。请确认已安装 .NET Framework 4.x。"
}

$csc = Find-Csc
Write-Host "编译器: $csc" -ForegroundColor DarkGray

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$sources = Get-ChildItem -Path $srcDir -Filter *.cs | ForEach-Object { $_.FullName }
if ($sources.Count -eq 0) { throw "src 目录下没有找到 .cs 文件" }

# ---- 图标：优先使用 assets/icon.ico（由 tools 生成）----
$iconArgs = @()
if (-not $NoIcon) {
    $prebuilt = Join-Path $root 'assets\icon.ico'
    if (Test-Path $prebuilt) {
        Copy-Item $prebuilt $icon -Force
        $iconArgs = @("/win32icon:$icon")
        Write-Host "使用图标: $prebuilt" -ForegroundColor DarkGray
    } else {
        Write-Warning "未找到 assets\icon.ico，将使用默认图标"
    }
}

# ---- 内嵌资源（可选）----
$resArgs = @()
$assetDir = Join-Path $root 'assets'
if (Test-Path $assetDir) {
    Get-ChildItem $assetDir -Include *.png,*.jpg -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        $resArgs += "/resource:$($_.FullName),$($_.Name)"
    }
}

$refs = @(
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll'
)

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/utf8output',
    "/out:$exe"
) + $refs + $iconArgs + $resArgs + $sources

Write-Host "编译中..." -ForegroundColor Cyan
& $csc @cscArgs
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host "编译失败 (exit $code)" -ForegroundColor Red
    exit $code
}

if (-not (Test-Path $exe)) {
    Write-Host "编译返回 0 但没有产出 exe" -ForegroundColor Red
    exit 1
}

$size = (Get-Item $exe).Length
Write-Host ("编译成功 -> {0}  ({1:N0} 字节)" -f $exe, $size) -ForegroundColor Green
exit 0
