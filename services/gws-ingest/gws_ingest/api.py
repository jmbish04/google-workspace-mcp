"""HTTP surface: /health (checks every dependency), /sync, /search, /rules."""
from __future__ import annotations

import hmac
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import store
from .config import Settings
from .guardian import embed, vec_literal


class RuleIn(BaseModel):
    name: str
    target: str = Field(pattern="^(gmail|drive)$")
    priority: int = 100
    enabled: bool = True
    project_key: str | None = None
    conditions: dict[str, Any] = {}
    actions: dict[str, Any] = {}


class SearchIn(BaseModel):
    query: str
    limit: int = Field(10, ge=1, le=50)
    project_key: str | None = None


def build_app(s: Settings) -> FastAPI:
    app = FastAPI(title="gws-ingest")

    def auth(authorization: str = Header("")) -> None:
        tok = authorization.removeprefix("Bearer ").strip()
        if not tok or not hmac.compare_digest(tok, s.api_key):
            raise HTTPException(401, "unauthorized")

    @app.get("/health")
    def health() -> dict[str, Any]:
        """Each check does real work; a failed critical check turns the verdict to fail (HTTP 503)."""
        checks: dict[str, dict[str, Any]] = {}
        try:
            c = store.connect(s.pg_dsn)
            r = c.execute("select (select count(*) from gws.gmail_messages) as messages, (select count(*) from gws.content_chunks) as chunks, "
                          "(select count(*) from gws.ingest_jobs where status in ('queued','running')) as backlog, "
                          "(select count(*) from gws.ingest_jobs where status='error') as errored").fetchone()
            c.close()
            checks["postgres"] = {"ok": True, **r}
        except Exception as e:
            checks["postgres"] = {"ok": False, "error": str(e)[:200]}
        try:
            v = embed(s, ["health"])
            checks["guardian_embeddings"] = {"ok": len(v[0]) == s.embed_dims, "model": s.embed_model, "dims": len(v[0])}
        except Exception as e:
            checks["guardian_embeddings"] = {"ok": False, "error": str(e)[:200]}
        try:
            r2 = httpx.get(f"{s.worker_url}/health", timeout=20)
            checks["worker"] = {"ok": r2.status_code == 200, "status": r2.status_code}
        except Exception as e:
            checks["worker"] = {"ok": False, "error": str(e)[:200]}
        ok = all(c["ok"] for c in checks.values())
        from fastapi.responses import JSONResponse

        return JSONResponse({"status": "ok" if ok else "fail", "checks": checks}, status_code=200 if ok else 503)

    @app.post("/search", dependencies=[Depends(auth)])
    def search(body: SearchIn) -> dict[str, Any]:
        vec = vec_literal(embed(s, [body.query])[0])
        c = store.connect(s.pg_dsn)
        try:
            return {"results": store.search(c, vec, body.query, body.limit, body.project_key)}
        finally:
            c.close()

    @app.get("/rules", dependencies=[Depends(auth)])
    def list_rules() -> dict[str, Any]:
        c = store.connect(s.pg_dsn)
        try:
            return {"rules": c.execute("select * from gws.ingest_rules order by priority, id").fetchall()}
        finally:
            c.close()

    @app.post("/rules", dependencies=[Depends(auth)])
    def upsert_rule(r: RuleIn) -> dict[str, Any]:
        import json

        c = store.connect(s.pg_dsn)
        try:
            pid = None
            if r.project_key:
                row = c.execute("select id from app.projects where key=%s", (r.project_key,)).fetchone()
                if not row:
                    raise HTTPException(422, f"unknown project_key {r.project_key}")
                pid = row["id"]
            return c.execute(
                "insert into gws.ingest_rules (name, project_id, target, priority, enabled, conditions, actions) "
                "values (%s,%s,%s::gws.rule_target,%s,%s,%s::jsonb,%s::jsonb) returning *",
                (r.name, pid, r.target, r.priority, r.enabled, json.dumps(r.conditions), json.dumps(r.actions)),
            ).fetchone()
        finally:
            c.close()

    return app
