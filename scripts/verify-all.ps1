$ErrorActionPreference = 'Continue'
# 五条验证命令串行执行，完整输出归档到 docs/superpowers/evidence/task12-commands.txt（UTF-8）。
$log = "docs/superpowers/evidence/task12-commands.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Run($title, $cmd) {
  $lines.Add("")
  $lines.Add("=== " + $title + " ===")
  $lines.Add("$ " + $cmd)
  $out = & powershell -NoProfile -Command $cmd 2>&1 | Out-String
  $code = $LASTEXITCODE
  $lines.Add($out.TrimEnd())
  $lines.Add("EXIT=" + $code)
  Write-Host ($title + " EXIT=" + $code)
}
$lines.Add("# 五条验证命令归档  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Run "1/5 pnpm typecheck" "pnpm typecheck"
Run "2/5 pnpm vitest run" "pnpm vitest run"
Run "3/5 node scripts/build-helper.mjs" "node scripts/build-helper.mjs"
Run "4/5 node scripts/smoke-main.mjs" "node scripts/smoke-main.mjs"
Run "5/5 node scripts/package-win.mjs" "node scripts/package-win.mjs"
[System.IO.File]::WriteAllLines((Resolve-Path -LiteralPath ".").Path + "\" + $log, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "ALL DONE -> $log"
