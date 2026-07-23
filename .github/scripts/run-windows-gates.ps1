[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$GateJson,
  [ValidateRange(1, 2)]
  [int]$MaxParallelGates = 2
)

# Native stderr is diagnostic output, not a gate failure. GitHub sets Stop by
# default, so receive it silently and use the native process exit code instead.
$ErrorActionPreference = 'Continue'
$Gate = @($GateJson | ConvertFrom-Json)
$running = @()
$results = @{}
$logs = @{}
$names = @()

function Start-Gate([string]$definition) {
  $parts = $definition -split '\|\|\|'
  if ($parts.Count -lt 3 -or [string]::IsNullOrWhiteSpace($parts[0])) {
    throw "Invalid gate definition: $definition"
  }
  $name = $parts[0]
  $script:running += Start-ThreadJob -Name $name -ArgumentList $definition -ScriptBlock {
    param($gateDefinition)
    $ErrorActionPreference = 'Continue'
    $gateParts = $gateDefinition -split '\|\|\|'
    $gateName = $gateParts[0]
    & $gateParts[1] @($gateParts | Select-Object -Skip 2)
    $nativeExitCode = $LASTEXITCODE
    Write-Output "__POSTMAN_GATE_RESULT__${gateName}:$nativeExitCode"
  }
}

function Complete-One {
  $completed = Wait-Job -Job $script:running -Any
  $output = @(Receive-Job -Job $completed -ErrorAction Continue 2>&1)
  $payload = @($output |
    Where-Object { $_ -is [string] -and $_ -like "__POSTMAN_GATE_RESULT__$($completed.Name):*" } |
    Select-Object -Last 1)
  $exitCode = if ($payload.Count -eq 1) { [int](($payload[0] -split ':')[-1]) } else { 1 }
  $script:results[$completed.Name] = $exitCode
  $script:logs[$completed.Name] = @($output | Where-Object {
    $_ -isnot [string] -or $_ -notlike "__POSTMAN_GATE_RESULT__$($completed.Name):*"
  })
  Remove-Job -Job $completed -Force
  $script:running = @($script:running | Where-Object Id -ne $completed.Id)
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
