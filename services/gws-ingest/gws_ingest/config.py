"""Environment-driven settings. Missing required values raise at start, never at first use."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _req(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        raise RuntimeError(f"{name} is required")
    return v


@dataclass(frozen=True)
class Settings:
    pg_dsn: str
    worker_url: str
    worker_api_key: str
    guardian_url: str
    guardian_token: str
    guardian_project: str
    embed_model: str
    embed_dims: int
    accounts: tuple[str, ...]
    poll_seconds: int
    api_key: str

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            pg_dsn=_req("GWS_INGEST_PG_DSN"),
            worker_url=os.environ.get("GWS_WORKER_URL", "https://google-workspace-mcp.hacolby.workers.dev").rstrip("/"),
            worker_api_key=_req("WORKER_API_KEY"),
            guardian_url=os.environ.get("GUARDIAN_URL", "https://core-guardian.hacolby.workers.dev").rstrip("/"),
            guardian_token=_req("CLOUDFLARE_AI_GATEWAY_TOKEN"),
            guardian_project=os.environ.get("GUARDIAN_PROJECT", "google-workspace-mcp"),
            embed_model=os.environ.get("GWS_EMBED_MODEL", "@cf/baai/bge-m3"),
            embed_dims=int(os.environ.get("GWS_EMBED_DIMS", "1024")),
            accounts=tuple(a for a in os.environ.get("GWS_ACCOUNTS", "").split(",") if a),
            poll_seconds=int(os.environ.get("GWS_POLL_SECONDS", "300")),
            api_key=os.environ.get("GWS_INGEST_API_KEY") or _req("WORKER_API_KEY"),
        )
