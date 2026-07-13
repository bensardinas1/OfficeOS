<#
install-daemon-task.ps1 — register (or remove) the "OfficeOS Daemon" Scheduled Task.
Run from any location; the repo root is derived from this script's path.

  pwsh scripts/install-daemon-task.ps1            # install/replace the task
  pwsh scripts/install-daemon-task.ps1 -Start     # install and start now
  pwsh scripts/install-daemon-task.ps1 -Uninstall # remove the task

The task runs `node daemon\daemon.js` at your logon, in your user session
(OneDrive paths, Graph token caches, and toasts all work), and restarts it
every minute on failure. The daemon's EADDRINUSE singleton guard makes
restart loops safe (a second instance exits 0 immediately).
#>
param([switch]$Uninstall, [switch]$Start)

$TaskName = "OfficeOS Daemon"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Output "Removed scheduled task '$TaskName'."
  exit 0
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction Stop).Source

$action   = New-ScheduledTaskAction -Execute $node -Argument "daemon\daemon.js" -WorkingDirectory $repo
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' (at logon, restart every 1 min on failure)."
Write-Output "Working directory: $repo"

if ($Start) { Start-ScheduledTask -TaskName $TaskName; Write-Output "Started." }
