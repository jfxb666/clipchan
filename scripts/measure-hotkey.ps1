$ErrorActionPreference='Continue'
Get-Process Clipchan,clipchan-helper -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Add-Type -Namespace Q -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
function Get-Visible($pids) {
  $found = New-Object System.Collections.ArrayList
  $cb = [Q.W+EnumProc]{ param($h,$l)
    $pp = 0; [void][Q.W]::GetWindowThreadProcessId($h, [ref]$pp)
    if ($pids -contains [int]$pp -and [Q.W]::IsWindowVisible($h) -and [Q.W]::GetWindowTextLength($h) -gt 0) { [void]$found.Add($h) }
    return $true }
  [void][Q.W]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}
$env:ELECTRON_RUN_AS_NODE=$null
$sw=[Diagnostics.Stopwatch]::StartNew()
Start-Process 'release\Clipchan.exe' -ArgumentList '--remote-debugging-port=9222'
$pids=@(); $vis=@()
for ($i=0; $i -lt 900; $i++) {
  Start-Sleep -Milliseconds 10
  if ($pids.Count -eq 0) { $pids = @(Get-Process Clipchan -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
  if ($pids.Count -gt 0) { $vis = Get-Visible $pids; if ($vis.Count -gt 0) { break } }
}
Write-Output ("COLD_START_VISIBLE_MS=" + $sw.ElapsedMilliseconds + " visibleWindows=" + $vis.Count)
Start-Sleep -Seconds 5
$js = "window.clipchan.app.hide()"
$cdp = Join-Path $env:TEMP 'clipchan-expr-hide.js'
Set-Content -Path $cdp -Value $js -Encoding UTF8
& node scripts/cdp.mjs read $cdp | Out-Null
Start-Sleep -Milliseconds 800
$pids = @(Get-Process Clipchan -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$hidden = (Get-Visible $pids).Count
Write-Output ("AFTER_HIDE_VISIBLE=" + $hidden)
$sw2=[Diagnostics.Stopwatch]::StartNew()
[Q.W]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[Q.W]::keybd_event(0xC0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[Q.W]::keybd_event(0xC0,0,2,[UIntPtr]::Zero)
[Q.W]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
$vis2=@()
for ($i=0; $i -lt 400; $i++) {
  Start-Sleep -Milliseconds 5
  $vis2 = Get-Visible $pids
  if ($vis2.Count -gt 0) { break }
}
Write-Output ("HOTKEY_SUMMON_MS=" + $sw2.ElapsedMilliseconds + " visibleWindows=" + $vis2.Count)