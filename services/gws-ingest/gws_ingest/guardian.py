"""Embeddings through Core Guardian (metered). Never a direct provider call."""
from __future__ import annotations

import httpx

from .config import Settings

BATCH = 32


class EmbedError(RuntimeError):
    pass


def embed(settings: Settings, texts: list[str], client: httpx.Client | None = None) -> list[list[float]]:
    """Return one vector per text, in order. Raises EmbedError on any non-200 or shape mismatch,
    so a job fails visibly instead of storing zero vectors."""
    own = client is None
    c = client or httpx.Client(timeout=120)
    out: list[list[float]] = []
    try:
        for i in range(0, len(texts), BATCH):
            batch = texts[i : i + BATCH]
            r = c.post(
                f"{settings.guardian_url}/v1/embeddings",
                headers={"Authorization": f"Bearer {settings.guardian_token}", "x-guardian-project": settings.guardian_project},
                json={"model": settings.embed_model, "input": batch, "dimensions": settings.embed_dims},
            )
            if r.status_code != 200:
                raise EmbedError(f"guardian embeddings {r.status_code}: {r.text[:300]}")
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            vecs = [d["embedding"] for d in data]
            if len(vecs) != len(batch) or any(len(v) != settings.embed_dims for v in vecs):
                raise EmbedError(f"guardian returned {len(vecs)} vectors / dims {{{','.join(str(len(v)) for v in vecs[:3])}}}, wanted {len(batch)} x {settings.embed_dims}")
            out.extend(vecs)
    finally:
        if own:
            c.close()
    return out


def vec_literal(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"
