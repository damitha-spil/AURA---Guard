param(
  [Parameter(Mandatory=$true)][ValidateSet("list-windows","inspect-tree","click","type","screenshot")][string]$Action,
  [int]$TargetPid = 0,
  [string]$TargetName = "",
  [string]$Text = "",
  [string]$OutPath = "",
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

function Find-WindowByPid([int]$procId) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
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
      }
    } catch {}
  }
  ConvertTo-Json -InputObject $out -Depth 4 -Compress
  exit 0
}

$win = Find-WindowByPid $TargetPid
if (-not $win) {
  Write-Error "Window for PID $TargetPid not found."
  exit 1
}

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

function Find-ControlByName($rootEl, [string]$query) {
  $q = $query.ToLower()
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($rootEl)
  $seen = 0
  while ($queue.Count -gt 0 -and $seen -lt $MaxNodes) {
    $cur = $queue.Dequeue()
    $seen++
    try {
      $c = $cur.Current
      $nm = ([string]$c.Name).ToLower()
      $aid = ([string]$c.AutomationId).ToLower()
      if ($c.IsEnabled -and ($nm -eq $q -or $aid -eq $q -or $nm.Contains($q))) {
        return $cur
      }
      $child = $walker.GetFirstChild($cur)
      while ($child -ne $null) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }
  return $null
}

if ($Action -eq "click") {
  $target = Find-ControlByName $win $TargetName
  if (-not $target) { Write-Error "Control '$TargetName' not found."; exit 1 }
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
  if (-not $target) { Write-Error "Input '$TargetName' not found."; exit 1 }
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
