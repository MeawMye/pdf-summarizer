$ErrorActionPreference = 'Stop'

$root = 'D:\local-llm'
$extractorDir = Join-Path $root 'models\extractor\qwen2.5-3b-instruct'
$plannerDir = Join-Path $root 'models\planner\qwen2.5-7b-instruct'
$embeddingDir = Join-Path $root 'models\embedding\bge-m3'

New-Item -ItemType Directory -Force -Path $extractorDir | Out-Null
New-Item -ItemType Directory -Force -Path $plannerDir | Out-Null
New-Item -ItemType Directory -Force -Path $embeddingDir | Out-Null

python -m pip install -U huggingface_hub

if (-not (Get-Command hf -ErrorAction SilentlyContinue)) {
	throw "hf command not found. Reopen terminal and run: python -m pip install -U huggingface_hub"
}

hf download Qwen/Qwen2.5-3B-Instruct-GGUF qwen2.5-3b-instruct-q4_k_m.gguf --local-dir $extractorDir
hf download Qwen/Qwen2.5-7B-Instruct-GGUF --include "qwen2.5-7b-instruct-q4_k_m*.gguf" --local-dir $plannerDir
hf download BAAI/bge-m3 --local-dir $embeddingDir

Write-Host "Downloads completed under $root" -ForegroundColor Green