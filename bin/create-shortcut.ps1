<#
  Creates a desktop shortcut "AURA Guard.lnk" that starts the chat window:
      node bin\aura-guard.mjs ui
  The repository path comes from this script's own location, so nothing is hard-coded.
  The shortcut runs minimized, so the console sits in the taskbar instead of on screen.
  Closing the chat window stops the server.

  Usage:  powershell -ExecutionPolicy Bypass -File bin\create-shortcut.ps1 [-OutDir <folder>]
  -OutDir defaults to your Desktop; tests pass a temporary folder.
#>
param([string]$OutDir = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'bin\aura-guard.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$lnk = Join-Path $OutDir 'AURA Guard.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $node
$s.Arguments = '"' + $launcher + '" ui'
$s.WorkingDirectory = $repo
$s.WindowStyle = 7   # minimized
$s.Description = 'AURA Guard chat'
$s.Save()
Write-Output $lnk
