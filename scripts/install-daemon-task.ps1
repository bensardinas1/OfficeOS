<#
install-daemon-task.ps1 — register (or remove) the "OfficeOS Daemon" Scheduled Task.
Run from any location; the repo root is derived from this script's path.

  pwsh scripts/install-daemon-task.ps1            # install/replace the task
  pwsh scripts/install-daemon-task.ps1 -Start     # install and start now
  pwsh scripts/install-daemon-task.ps1 -Uninstall # remove the task

The task runs the daemon at your logon, in your user session (OneDrive paths,
Graph token caches, and toasts all work), and restarts it every minute on
failure. The daemon's EADDRINUSE singleton guard makes restart loops safe
(a second instance exits 0 immediately).

The daemon is launched through scripts\start-daemon-hidden.vbs (wscript.exe)
so it gets NO console window: a visible console invites closing it, which
SIGINTs the daemon — a clean exit the restart policy deliberately ignores.
The wrapper waits on node and exits with node's code, so crashes still
trigger the restart policy. To stop the daemon on purpose:
  Stop-ScheduledTask -TaskName "OfficeOS Daemon"
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
$wrapper = Join-Path $PSScriptRoot "start-daemon-hidden.vbs"
if (-not (Test-Path $wrapper)) { throw "missing $wrapper" }

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$wrapper`" `"$repo`" `"$node`"" -WorkingDirectory $repo
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "Registered scheduled task '$TaskName' (at logon, restart every 1 min on failure)."
Write-Output "Working directory: $repo"

if ($Start) { Start-ScheduledTask -TaskName $TaskName; Write-Output "Started." }
