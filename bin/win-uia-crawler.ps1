param(
  [Parameter(Mandatory=$true)][ValidateSet("list-windows","inspect-tree","click","type","screenshot")][string]$Action,
  [int]$TargetPid = 0,
  [string]$TargetName = "",
  [string]$Text = "",
  [string]$OutPath = "",
  [string]$WindowHandle = "",
  [string]$ExpectedProcess = "",
  [int]$MaxNodes = 1200
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement

function Get-ProcName([int]$procId) {
  try { return ((Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName + ".exe").ToLower() }
  catch { return "unknown.exe" }
}

# Elevation: $true, $false, or "unknown" when Windows will not say. REO refuses anything but $false.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ReoElevation {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int ret);
  // 1 elevated, 0 not, -1 not known.
  public static int Check(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return -1;
    try {
      IntPtr t;
      if (!OpenProcessToken(p, 0x0008, out t)) return -1;
      try {
        int info; int ret;
        if (!GetTokenInformation(t, 20, out info, 4, out ret)) return -1;
        return info != 0 ? 1 : 0;
      } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }
}
"@

function Get-Elevation([int]$procId) {
  try {
    $r = [ReoElevation]::Check($procId)
    if ($r -eq 0) { return $false }
    if ($r -eq 1) { return $true }
  } catch {}
  return "unknown"
}

if ($Action -eq "list-windows") {
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $out = @()
  foreach ($w in $wins) {
    try {
      $c = $w.Current
      if (-not $c.Name -or $c.IsOffscreen) { continue }
      $out += @{
        pid = [int]$c.ProcessId
        windowId = [string]$c.NativeWindowHandle
        title = [string]$c.Name
        processName = Get-ProcName $c.ProcessId
        elevated = Get-Elevation $c.ProcessId
      }
    } catch {}
  }
  ConvertTo-Json -InputObject $out -Depth 4 -Compress
  exit 0
}

# Every other action names the window and program REO judged. Check again here, and fail closed.
if (-not $WindowHandle -or -not $ExpectedProcess) { Write-Error "WindowHandle and ExpectedProcess are required."; exit 1 }
$actual = Get-ProcName $TargetPid
if ($actual -ne $ExpectedProcess.ToLower()) { Write-Error "The program behind PID $TargetPid changed."; exit 1 }
$blockedNames = @("cmd","powershell","powershell_ise","pwsh","wt","windowsterminal","openconsole","conhost","bash","sh","wsl","mintty","wscript","cscript","mshta","mmc","explorer","regedit","taskmgr","ssms","code","devenv","cursor","spil-reo-desktop")
if ($blockedNames -contains ($actual -replace '\.exe$', '')) { Write-Error "REO never controls shells, terminals, admin tools or itself."; exit 1 }
if ((Get-Elevation $TargetPid) -ne $false) { Write-Error "The target runs as administrator, or this could not be checked."; exit 1 }

# The exact window, not just any window of the process.
$win = $null
$ofPid = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $ofPid)) {
  if ([string]$w.Current.NativeWindowHandle -eq $WindowHandle) { $win = $w; break }
}
if (-not $win) {
  Write-Error "The judged window of PID $TargetPid was not found."
  exit 1
}
if ([string]$win.Current.Name -match '\bSPIL[\s_-]*REO\b') { Write-Error "REO never controls its own window."; exit 1 }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Collect-Nodes($el, [int]$max) {
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($el)
  $nodes = @()
  $idx = 0
  while ($queue.Count -gt 0 -and $nodes.Count -lt $max) {
    $cur = $queue.Dequeue()
    try {
      $c = $cur.Current
      $r = $c.BoundingRectangle
      $role = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '').ToLower()
      $nodes += @{
        token = "uia:$($TargetPid):$idx"
        role = $role
        name = [string]$c.Name
        automationId = [string]$c.AutomationId
        enabled = [bool]$c.IsEnabled
        offscreen = [bool]$c.IsOffscreen
        bounds = @{
          x = if ([double]::IsInfinity($r.X)) { 0 } else { [int]$r.X }
          y = if ([double]::IsInfinity($r.Y)) { 0 } else { [int]$r.Y }
          width = if ([double]::IsInfinity($r.Width)) { 0 } else { [int]$r.Width }
          height = if ([double]::IsInfinity($r.Height)) { 0 } else { [int]$r.Height }
        }
      }
      $idx++
      $child = $walker.GetFirstChild($cur)
      while ($child -ne $null -and $nodes.Count + $queue.Count -lt $max) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }
  return $nodes
}

if ($Action -eq "inspect-tree") {
  $nodes = Collect-Nodes $win $MaxNodes
  ConvertTo-Json -InputObject @{ pid = $TargetPid; nodes = $nodes } -Depth 5 -Compress
  exit 0
}

# Exactly one enabled control with this name. A partial or ambiguous match could act on another
# control than the one REO judged (asking for "Orders" must never reach "Delete Orders").
function Find-ControlByName($rootEl, [string]$query) {
  $q = $query.ToLower()
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($rootEl)
  $seen = 0
  $hits = @()
  while ($queue.Count -gt 0 -and $seen -lt $MaxNodes) {
    $cur = $queue.Dequeue()
    $seen++
    try {
      $c = $cur.Current
      if ($c.IsEnabled -and ([string]$c.Name).ToLower() -eq $q) { $hits += $cur }
      $child = $walker.GetFirstChild($cur)
      while ($child -ne $null) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }
  # Anything left unread could hold a second match.
  if ($queue.Count -eq 0 -and $hits.Count -eq 1) { return $hits[0] }
  return $null
}

if ($Action -eq "click") {
  $target = Find-ControlByName $win $TargetName
  if (-not $target) { Write-Error "Control '$TargetName' was not found exactly once."; exit 1 }
  $pat = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
    $pat.Invoke()
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
    $pat.Select()
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
    $pat.Toggle()
  } elseif ($target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
    $pat.Expand()
  } else {
    Write-Error "Control '$TargetName' does not expose a clickable UIA pattern."
    exit 1
  }
  ConvertTo-Json -InputObject @{ ok = $true; action = "click"; target = $TargetName } -Compress
  exit 0
}

if ($Action -eq "type") {
  $target = Find-ControlByName $win $TargetName
  if (-not $target) { Write-Error "Input '$TargetName' was not found exactly once."; exit 1 }
  $pat = $null
  if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
    $pat.SetValue($Text)
  } else {
    Write-Error "Input '$TargetName' does not expose UIA ValuePattern."
    exit 1
  }
  ConvertTo-Json -InputObject @{ ok = $true; action = "type"; target = $TargetName } -Compress
  exit 0
}

if ($Action -eq "screenshot") {
  if (-not $OutPath) { Write-Error "OutPath required."; exit 1 }
  Add-Type -AssemblyName System.Drawing
  $r = $win.Current.BoundingRectangle
  $w = [Math]::Max(1, [int]$r.Width)
  $h = [Math]::Max(1, [int]$r.Height)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  ConvertTo-Json -InputObject @{ ok = $true; path = $OutPath } -Compress
  exit 0
}
