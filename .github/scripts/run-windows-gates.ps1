[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$GateJson,
  [ValidateRange(1, 2)]
  [int]$MaxParallelGates = 2,
  [ValidateRange(1, 3600)]
  [int]$GateTimeoutSeconds = 1200
)

# Native stderr is diagnostic output, not a gate failure. Collect it for the
# gate's log group and use the native process exit code as the result.
$ErrorActionPreference = 'Continue'
$Gate = @($GateJson | ConvertFrom-Json)
$running = @()
$results = @{}
$logs = @{}
$names = @()

function Start-Gate([string]$definition) {
  $parts = $definition -split '\|\|\|'
  if ($parts.Count -lt 3 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
    throw "Invalid gate definition: $definition"
  }
  $name = $parts[0]

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $parts[1]
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @($parts | Select-Object -Skip 2)) {
    $null = $startInfo.ArgumentList.Add([string]$argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Unable to start gate: $name" }

  # Begin both readers before admitting another gate so a verbose native process
  # cannot block on a redirected pipe.
  $script:running += [pscustomobject]@{
    Name = $name
    Process = $process
    StdoutTask = $process.StandardOutput.ReadToEndAsync()
    StderrTask = $process.StandardError.ReadToEndAsync()
    Deadline = [datetime]::UtcNow.AddSeconds($GateTimeoutSeconds)
  }
}

function Complete-One {
  $completed = $null
  $timedOut = $false
  while ($null -eq $completed) {
    $now = [datetime]::UtcNow
    foreach ($gate in $script:running) {
      if ($gate.Process.HasExited) {
        $completed = $gate
        break
      }
      if ($now -ge $gate.Deadline) {
        $completed = $gate
        $timedOut = $true
        break
      }
    }
    if ($null -eq $completed) { Start-Sleep -Milliseconds 100 }
  }

  if ($timedOut) {
    try { $completed.Process.Kill($true) } catch { }
  }

  # Each wait is bounded; killing the full tree above ensures descendants cannot
  # retain a pipe and keep this queue alive indefinitely.
  $null = $completed.StdoutTask.Wait(250)
  $null = $completed.StderrTask.Wait(250)
  $stdout = if ($completed.StdoutTask.IsCompletedSuccessfully) { $completed.StdoutTask.Result } else { '' }
  $stderr = if ($completed.StderrTask.IsCompletedSuccessfully) { $completed.StderrTask.Result } else { '' }
  $exitCode = if ($timedOut) { 1 } else { $completed.Process.ExitCode }
  $script:results[$completed.Name] = $exitCode
  $script:logs[$completed.Name] = @(
    $stdout
    $stderr
    if ($timedOut) { "gate:$($completed.Name) timed out after $GateTimeoutSeconds seconds" }
  )
  $completedProcessId = $completed.Process.Id
  $script:running = @($script:running | Where-Object { $_.Process.Id -ne $completedProcessId })
  $completed.Process.Dispose()
}

foreach ($definition in $Gate) {
  $name = ($definition -split '\|\|\|', 2)[0]
  if ($names -contains $name) { throw "Duplicate gate name: $name" }
  $names += $name
  while ($running.Count -ge $MaxParallelGates) { Complete-One }
  Start-Gate $definition
}
while ($running.Count -gt 0) { Complete-One }

$failed = $false
foreach ($name in $names) {
  Write-Output "::group::$name"
  $logs[$name] | Write-Output
  Write-Output '::endgroup::'
  if ($results[$name] -eq 0) {
    Write-Output "gate:$name=pass"
  } else {
    Write-Output "gate:$name=fail"
    $failed = $true
  }
}
if ($failed) { exit 1 }
