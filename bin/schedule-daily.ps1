<#
.SYNOPSIS
  Plans (or installs) a Windows scheduled task that runs `aura-guard daily` on weekdays.

.DESCRIPTION
  Without -Install this only prints what it would create. With -Install it
  registers a per-user task (no admin needed, runs only while you are signed in).
  The repo path comes from this script's own location; nothing is hard-coded.
  The daily routine only refreshes Guard's own index and adds proposed notes to
  its vault; it never writes to other repos. Index waits while builds are running
  (see "Resource guard" in ARCHITECTURE.md).

.PARAMETER Time
  Local time of day, HH:mm. Default 18:00.

.PARAMETER NoModel
  Skip steps that call the model (the diary).

.PARAMETER Remove
  Remove the task.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File bin\schedule-daily.ps1            # show the plan
  powershell -ExecutionPolicy Bypass -File bin\schedule-daily.ps1 -Install   # create it
#>
param(
  [string]$Time = "18:00",
  [switch]$Install,
  [switch]$Remove,
  [switch]$NoModel
)

$ErrorActionPreference = "Stop"
$TaskName = "SPIL AURA QA Bot daily"
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$Launcher = Join-Path $Root "bin\aura-guard.mjs"
$Args = "`"$Launcher`" daily" + $(if ($NoModel) { " --no-model" } else { "" })

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'."
  exit 0
}

Write-Host "Task:      $TaskName"
Write-Host "Runs:      Monday to Friday at $Time (only while you are signed in)"
Write-Host "Command:   `"$Node`" $Args"
Write-Host "Start in:  $Root"

if (-not $Install) {
  Write-Host ""
  Write-Host "Nothing was created. Add -Install to create it, -Remove to delete it."
  exit 0
}

$action = New-ScheduledTaskAction -Execute $Node -Argument $Args -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "SPIL AURA QA Bot end-of-day routine" -Force | Out-Null
Write-Host "Created task '$TaskName'. Run it now with: Start-ScheduledTask -TaskName '$TaskName'"
