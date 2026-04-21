import os
import time
from typing import List, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastembed import TextEmbedding


MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
HOST = os.getenv("EMBEDDING_HOST", "127.0.0.1")
PORT = int(os.getenv("EMBEDDING_PORT", "5003"))

app = FastAPI(title="Local Embedding API", version="1.0")

# Load once at startup to avoid first-request surprises.
embedder = TextEmbedding(model_name=MODEL_NAME)


class EmbeddingRequest(BaseModel):
    model: str
    input: Union[str, List[str]]


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "host": HOST,
        "port": PORT,
    }


@app.post("/v1/embeddings")
def create_embeddings(req: EmbeddingRequest):
    try:
        inputs = req.input if isinstance(req.input, list) else [req.input]
        vectors = list(embedder.embed(inputs))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Embedding failure: {exc}") from exc

    data = []
    total_tokens = 0
    for i, (text, vec) in enumerate(zip(inputs, vectors)):
        token_estimate = max(1, len(text.split()))
        total_tokens += token_estimate
        data.append(
            {
                "object": "embedding",
                "index": i,
                "embedding": vec.tolist(),
            }
        )

    return {
        "object": "list",
        "data": data,
        "model": req.model or MODEL_NAME,
        "usage": {
            "prompt_tokens": total_tokens,
            "total_tokens": total_tokens,
        },
        "created": int(time.time()),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("embedding_api:app", host=HOST, port=PORT, reload=False)