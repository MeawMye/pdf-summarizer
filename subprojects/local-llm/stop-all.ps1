Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$processFile = Join-Path (Join-Path $scriptDir '.runtime') 'processes.json'

if (-not (Test-Path $processFile)) {
  Write-Warning "Process record not found: $processFile"
  Write-Host 'Nothing to stop from record.'
  return
}

$data = Get-Content -Path $processFile -Raw | ConvertFrom-Json

foreach ($proc in $data.processes) {
  if (-not $proc.pid) {
    Write-Host "Skipping $($proc.name): no PID recorded"
    continue
  }

  $existing = Get-Process -Id $proc.pid -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Host "Already stopped: $($proc.name) (PID: $($proc.pid))"
    continue
  }

  Stop-Process -Id $proc.pid -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped: $($proc.name) (PID: $($proc.pid))" -ForegroundColor Yellow
}

Remove-Item -Path $processFile -Force
Write-Host 'stop-all completed and process record removed.' -ForegroundColor Green
