# 重启 DSH 并让独立守护脚本在重启后自我验证。
#
# 三步：
#   1. 以“分离进程”启动 verify-after-restart.mjs（不随本次 pwsh 结束而结束）
#   2. 结束当前 DSH 进程
#   3. 重新启动 DSH
#
# 守护脚本会自己等应用起来、比对激活标记、把结论写进 restart-report.json。

$ErrorActionPreference = 'Stop'
$exe  = if ($env:DSH_APP_EXE) { $env:DSH_APP_EXE } else {
  Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
}
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$work = Split-Path -Parent $PSScriptRoot

Write-Host "[1/3] 启动分离的验证守护进程（180 秒窗口）..."
$verifier = Start-Process -FilePath $node `
  -ArgumentList @("$work\tools\verify-after-restart.mjs", "180") `
  -WorkingDirectory $work -WindowStyle Hidden -PassThru
Write-Host "      守护进程 PID = $($verifier.Id)"

Write-Host "[2/3] 结束 DSH 主进程..."
$procs = Get-Process | Where-Object { $_.Path -eq $exe }
Write-Host "      找到 $($procs.Count) 个进程: $(($procs.Id) -join ', ')"
Start-Sleep -Seconds 1
$procs | Stop-Process -Force
Start-Sleep -Seconds 8

$left = @(Get-Process | Where-Object { $_.Path -eq $exe })
Write-Host "      剩余进程: $($left.Count)"

Write-Host "[3/3] 重新启动 DSH..."
Start-Process -FilePath $exe
Write-Host "      已启动。守护进程会在应用起来后写报告。"

Write-Host "`n等待守护进程完成（最多 180 秒）..."
if (-not $verifier.WaitForExit(190000)) {
  Write-Host "守护进程超时"
} else {
  $report = "$env:USERPROFILE\.dsh\storages\dsh-memory\state\restart-report.json"
  if (Test-Path $report) {
    Write-Host "`n===== 重启后验证报告 ====="
    Get-Content $report
  } else {
    Write-Host "报告未生成"
  }
}
