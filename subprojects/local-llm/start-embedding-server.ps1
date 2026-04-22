$env:EMBEDDING_MODEL = if ($env:EMBEDDING_MODEL) { $env:EMBEDDING_MODEL } else { 'bge-m3' }
$env:EMBEDDING_HOST = if ($env:EMBEDDING_HOST) { $env:EMBEDDING_HOST } else { '127.0.0.1' }
$env:EMBEDDING_PORT = if ($env:EMBEDDING_PORT) { $env:EMBEDDING_PORT } else { '5003' }

python .\embedding_api.py