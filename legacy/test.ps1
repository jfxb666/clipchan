# Clipchan 端到端验收测试
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$exe = "C:\Users\<user>\Desktop\剪贴板\dist\Clipchan.exe"
$fail = 0
function Ok($m)   { Write-Host ("  [PASS] " + $m) }
function Bad($m)  { Write-Host ("  [FAIL] " + $m); $script:fail++ }

Remove-Item -Recurse -Force "$env:APPDATA\Clipchan" -ErrorAction SilentlyContinue

Write-Host "=== 1. 启动 GUI（应无控制台窗口）==="
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 3
$proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if ($proc) { Ok ("alive pid=" + $proc.Id) } else { Bad "process died"; exit 1 }

Write-Host "=== 2. 剪贴板捕获（含中文/引号/多行）==="
$samples = @(
  "alpha-first",
  "https://example.com/anime",
  ("CJK: " + [char]0x4F60 + [char]0x597D + " " + [char]0x3053 + [char]0x3093 + [char]0x306B + [char]0x3061 + [char]0x306F),
  ("quotes: " + [char]34 + "double" + [char]34 + " backslash C:" + [char]92 + "path"),
  ("multiline" + [char]13 + [char]10 + "second line" + [char]9 + "tabbed")
)
foreach ($s in $samples) { Set-Clipboard -Value $s; Start-Sleep -Milliseconds 800 }
Start-Sleep -Milliseconds 1200

Write-Host "=== 3. 持久化验证 ==="
$hf = "$env:APPDATA\Clipchan\history.json"
if (-not (Test-Path $hf)) { Bad "history.json missing"; exit 1 }
$o = Get-Content $hf -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ("  items=" + $o.items.Count + " version=" + $o.version)
$texts = @($o.items | ForEach-Object { $_.text })
foreach ($s in $samples) {
  if ($texts -contains $s) { Ok ("recorded: " + $s.Substring(0, [Math]::Min(26, $s.Length))) }
  else { Bad ("missing: " + $s.Substring(0, [Math]::Min(26, $s.Length))) }
}

Write-Host "=== 4. 最新在前排序 ==="
if ($o.items[0].text -eq $samples[$samples.Count - 1]) { Ok "newest first" } else { Bad ("ordering wrong, first=" + $o.items[0].text) }

Write-Host "=== 5. 去重（重复复制同一内容）==="
$before = $o.items.Count
Set-Clipboard -Value "alpha-first"
Start-Sleep -Milliseconds 1200
$o2 = Get-Content $hf -Raw -Encoding UTF8 | ConvertFrom-Json
if ($o2.items.Count -eq $before) { Ok ("no duplicate (still " + $before + ")") } else { Bad ("count changed " + $before + " -> " + $o2.items.Count) }
if ($o2.items[0].text -eq "alpha-first") { Ok "re-copied item moved to front" } else { Bad "re-copied item did not move to front" }

Write-Host "=== 6. 单实例 ==="
$p2 = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 2
$count = @(Get-Process Clipchan -ErrorAction SilentlyContinue).Count
if ($count -eq 1) { Ok "single instance enforced" } else { Bad ("process count = " + $count) }

Write-Host "=== 7. 关闭后数据仍可解析 ==="
Stop-Process -Name Clipchan -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1000
$u = Get-Process Clipchan -ErrorAction SilentlyContinue
if (-not $u) { Ok "process stopped" } else { Bad "process still running" }
$final = Get-Content $hf -Raw -Encoding UTF8 | ConvertFrom-Json
if ($final.items.Count -ge $samples.Count) { Ok ("history intact, " + $final.items.Count + " items") } else { Bad "history lost items" }

Write-Host ""
if ($fail -eq 0) { Write-Host "E2E ALL PASS" -ForegroundColor Green; exit 0 }
else { Write-Host ("E2E FAILED (" + $fail + ")") -ForegroundColor Red; exit 1 }
