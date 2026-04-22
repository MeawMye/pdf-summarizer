import os
import time
from typing import List, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


MODEL_NAME = os.getenv("EMBEDDING_MODEL", "bge-m3")
HOST = os.getenv("EMBEDDING_HOST", "127.0.0.1")
PORT = int(os.getenv("EMBEDDING_PORT", "5003"))

app = FastAPI(title="Local Embedding API", version="1.0")

embedder = None
embed_backend = ""
tokenizer = None
torch = None


def _load_embedder():
    """Load embedder once at startup and fail fast if model is unavailable."""
    global embedder, embed_backend

    model_lower = MODEL_NAME.lower()
    if model_lower in {"bge-m3", "baai/bge-m3"}:
        # BGE-M3 path via transformers+torch (avoids sentence-transformers native deps).
        global tokenizer, torch
        from transformers import AutoModel, AutoTokenizer
        import torch as _torch

        tokenizer = AutoTokenizer.from_pretrained("BAAI/bge-m3")
        embedder = AutoModel.from_pretrained("BAAI/bge-m3")
        embedder.eval()
        torch = _torch
        embed_backend = "transformers-bge-m3"
        return

    # Generic fallback path for fastembed-supported models.
    from fastembed import TextEmbedding

    embedder = TextEmbedding(model_name=MODEL_NAME)
    embed_backend = "fastembed"


_load_embedder()


def _mean_pooling(last_hidden_state, attention_mask):
    mask = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
    summed = (last_hidden_state * mask).sum(dim=1)
    counts = mask.sum(dim=1).clamp(min=1e-9)
    return summed / counts


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
        if embed_backend == "transformers-bge-m3":
            encoded = tokenizer(
                inputs,
                padding=True,
                truncation=True,
                max_length=1024,
                return_tensors="pt",
            )
            with torch.no_grad():
                outputs = embedder(**encoded)
            pooled = _mean_pooling(outputs.last_hidden_state, encoded["attention_mask"])
            normalized = torch.nn.functional.normalize(pooled, p=2, dim=1)
            vectors = normalized.cpu().numpy()
        else:
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
                "embedding": vec.tolist() if hasattr(vec, "tolist") else list(vec),
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