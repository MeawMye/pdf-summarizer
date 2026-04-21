$env:STORAGE_ROOT = 'D:\local-llm\data'
$env:LOCAL_MODEL_ROOT = 'D:\local-llm\models'

$env:EXTRACTOR_LLM_API_URL = 'http://127.0.0.1:5001/v1/chat/completions'
$env:PLANNER_LLM_API_URL = 'http://127.0.0.1:5002/v1/chat/completions'
$env:EMBEDDING_API_URL = 'http://127.0.0.1:5003/v1/embeddings'

$env:EXTRACTOR_LLM_MODEL = 'qwen2.5-3b-instruct-q4_k_m'
$env:PLANNER_LLM_MODEL = 'qwen2.5-7b-instruct-q4_k_m'
$env:EMBEDDING_MODEL = 'bge-m3'

$env:AI_TIMEOUT_MS = '180000'

Write-Host 'Local LLM environment variables are set for D:\local-llm' -ForegroundColor Green