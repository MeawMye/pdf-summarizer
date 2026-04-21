$env:EMBEDDING_MODEL = if ($env:EMBEDDING_MODEL) { $env:EMBEDDING_MODEL } else { 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2' }
$env:EMBEDDING_HOST = if ($env:EMBEDDING_HOST) { $env:EMBEDDING_HOST } else { '127.0.0.1' }
$env:EMBEDDING_PORT = if ($env:EMBEDDING_PORT) { $env:EMBEDDING_PORT } else { '5003' }

python .\scripts\embedding_api.py