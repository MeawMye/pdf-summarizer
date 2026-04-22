Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$runtimeDir = Join-Path $scriptDir '.runtime'
$processFile = Join-Path $runtimeDir 'processes.json'

if (-not (Test-Path $runtimeDir)) {
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}

. (Join-Path $scriptDir 'set-local-llm-env.ps1')

if (-not $env:EMBEDDING_MODEL) {
  $env:EMBEDDING_MODEL = 'bge-m3'
}
if (-not $env:EMBEDDING_HOST) {
  $env:EMBEDDING_HOST = '127.0.0.1'
}
if (-not $env:EMBEDDING_PORT) {
  $env:EMBEDDING_PORT = '5003'
}

$llamaServerExe = if ($env:LLAMA_SERVER_EXE) {
  $env:LLAMA_SERVER_EXE
} else {
  Join-Path $env:LOCAL_MODEL_ROOT '..\bin\llama-server.exe'
}

if (-not (Test-Path $llamaServerExe)) {
  throw "llama-server executable not found: $llamaServerExe"
}

$pythonCmd = (Get-Command python -ErrorAction Stop).Source
$nodeCmd = (Get-Command node -ErrorAction Stop).Source

$extractorModelPath = Join-Path $env:LOCAL_MODEL_ROOT 'extractor\qwen2.5-3b-instruct\qwen2.5-3b-instruct-q4_k_m.gguf'
$plannerModelPath = Join-Path $env:LOCAL_MODEL_ROOT 'planner\qwen2.5-7b-instruct\qwen2.5-7b-instruct-q4_k_m.gguf'

if (-not (Test-Path $extractorModelPath)) {
  throw "Extractor model not found: $extractorModelPath"
}
if (-not (Test-Path $plannerModelPath)) {
  throw "Planner model not found: $plannerModelPath"
}

function Test-PortListening {
  param([int]$Port)
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $listener
}

function Start-ManagedProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [int]$Port
  )

  if (Test-PortListening -Port $Port) {
    Write-Warning "$Name skipped: port $Port is already in use"
    return [pscustomobject]@{
      name = $Name
      pid = $null
      port = $Port
      status = 'skipped-port-in-use'
      command = "$FilePath $($ArgumentList -join ' ')"
    }
  }

  $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -PassThru
  Write-Host "$Name started (PID: $($proc.Id), Port: $Port)" -ForegroundColor Green

  return [pscustomobject]@{
    name = $Name
    pid = $proc.Id
    port = $Port
    status = 'started'
    command = "$FilePath $($ArgumentList -join ' ')"
  }
}

$processes = @()

$processes += Start-ManagedProcess `
  -Name 'extractor' `
  -FilePath $llamaServerExe `
  -ArgumentList @('-m', $extractorModelPath, '--host', '127.0.0.1', '--port', '5001', '-c', '4096') `
  -WorkingDirectory $projectRoot `
  -Port 5001

$processes += Start-ManagedProcess `
  -Name 'planner' `
  -FilePath $llamaServerExe `
  -ArgumentList @('-m', $plannerModelPath, '--host', '127.0.0.1', '--port', '5002', '-c', '4096') `
  -WorkingDirectory $projectRoot `
  -Port 5002

$processes += Start-ManagedProcess `
  -Name 'embedding' `
  -FilePath $pythonCmd `
  -ArgumentList @((Join-Path $scriptDir 'embedding_api.py')) `
  -WorkingDirectory $projectRoot `
  -Port 5003

$processes += Start-ManagedProcess `
  -Name 'node-api' `
  -FilePath $nodeCmd `
  -ArgumentList @('server.js') `
  -WorkingDirectory $projectRoot `
  -Port 3001

$payload = [pscustomobject]@{
  startedAt = (Get-Date).ToString('o')
  projectRoot = $projectRoot
  env = [pscustomobject]@{
    STORAGE_ROOT = $env:STORAGE_ROOT
    LOCAL_MODEL_ROOT = $env:LOCAL_MODEL_ROOT
    EXTRACTOR_LLM_API_URL = $env:EXTRACTOR_LLM_API_URL
    PLANNER_LLM_API_URL = $env:PLANNER_LLM_API_URL
    EMBEDDING_API_URL = $env:EMBEDDING_API_URL
    EMBEDDING_MODEL = $env:EMBEDDING_MODEL
  }
  processes = $processes
}

$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $processFile -Encoding UTF8

Write-Host ""
Write-Host 'All start attempts finished.' -ForegroundColor Cyan
Write-Host "Process record: $processFile"
Write-Host 'Health check: curl.exe -s http://127.0.0.1:3001/health'
