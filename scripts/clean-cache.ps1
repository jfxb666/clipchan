# 清理剪贴板酱留下的缓存
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\clean-cache.ps1            # 只报告，不删
#   powershell -ExecutionPolicy Bypass -File scripts\clean-cache.ps1 -Apply     # 真的删
#
# 只删两处，别的一律不碰：
#   1. %TEMP% 下由免安装版自解压出来的目录（判据：目录里有 Clipchan.exe 与 resources\app.asar）
#   2. %LOCALAPPDATA%\@clipchandesktop-updater\installer.exe（自动更新下载好的安装包）
# 数据目录 %APPDATA%\Clipchan 不在这里删 —— 那是历史记录与设置，删了就没了。

param(
  [switch]$Apply
)

$ErrorActionPreference = 'SilentlyContinue'

function Format-Size([double]$bytes) {
  if ($bytes -ge 1GB) { return ([math]::Round($bytes / 1GB, 2)).ToString() + ' GB' }
  if ($bytes -ge 1MB) { return ([math]::Round($bytes / 1MB, 1)).ToString() + ' MB' }
  return ([math]::Round($bytes / 1KB, 1)).ToString() + ' KB'
}

function Get-DirSize([string]$path) {
  $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return 0 }
  return [double]$sum
}

# 正在运行的 Clipchan 会锁住自己的解压目录，先记下来，这些跳过不删。
$running = @{}
foreach ($p in (Get-Process -Name 'Clipchan', 'clipchan-helper')) {
  if ($p.Path) { $running[(Split-Path -Parent $p.Path)] = $p.Id }
}

Write-Host ''
Write-Host '== 免安装版解压残留 ==' -ForegroundColor Cyan
$tempDirs = Get-ChildItem -LiteralPath $env:TEMP -Directory -Force |
  Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName 'Clipchan.exe')) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'resources\app.asar')) }

$dirBytes = 0
$dirCount = 0
$dirKept = 0
foreach ($d in $tempDirs) {
  if ($running.ContainsKey($d.FullName)) {
    Write-Host ('  [跳过] ' + $d.Name + ' —— 正在使用中') -ForegroundColor Yellow
    $dirKept++
    continue
  }
  $size = Get-DirSize $d.FullName
  $dirBytes += $size
  $dirCount++
  if ($Apply) {
    Remove-Item -LiteralPath $d.FullName -Recurse -Force
    if (Test-Path -LiteralPath $d.FullName) {
      Write-Host ('  [失败] ' + $d.Name + ' ' + (Format-Size $size)) -ForegroundColor Red
    } else {
      Write-Host ('  [已删] ' + $d.Name + ' ' + (Format-Size $size))
    }
  } else {
    Write-Host ('  ' + $d.Name + '  ' + (Format-Size $size) + '  ' + $d.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
  }
}
if ($dirCount -eq 0) { Write-Host '  没有残留' -ForegroundColor Green }

Write-Host ''
Write-Host '== 自动更新下载的安装包 ==' -ForegroundColor Cyan
$updaterFile = Join-Path $env:LOCALAPPDATA '@clipchandesktop-updater\installer.exe'
$updaterBytes = 0
if (Test-Path -LiteralPath $updaterFile) {
  $updaterBytes = (Get-Item -LiteralPath $updaterFile).Length
  if ($Apply) {
    Remove-Item -LiteralPath $updaterFile -Force
    if (Test-Path -LiteralPath $updaterFile) {
      Write-Host ('  [失败] installer.exe ' + (Format-Size $updaterBytes)) -ForegroundColor Red
      $updaterBytes = 0
    } else {
      Write-Host ('  [已删] installer.exe ' + (Format-Size $updaterBytes))
    }
  } else {
    Write-Host ('  installer.exe  ' + (Format-Size $updaterBytes))
  }
} else {
  Write-Host '  没有残留' -ForegroundColor Green
}

Write-Host ''
$total = $dirBytes + $updaterBytes
if ($Apply) {
  Write-Host ('共清理 ' + $dirCount + ' 个解压目录 + 更新包，释放约 ' + (Format-Size $total)) -ForegroundColor Green
} else {
  Write-Host ('可释放约 ' + (Format-Size $total) + '（' + $dirCount + ' 个解压目录）') -ForegroundColor Green
  if ($total -gt 0) { Write-Host '这只是预演。加 -Apply 才会真的删。' -ForegroundColor Yellow }
}
if ($dirKept -gt 0) { Write-Host ('有 ' + $dirKept + ' 个目录正在使用中，退出剪贴板酱后重跑可一并清理。') -ForegroundColor Yellow }
Write-Host ''