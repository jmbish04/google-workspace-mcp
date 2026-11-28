"""The Worker as Gmail gateway. The Worker holds the working Google grants, so the service
reads Gmail by calling its MCP `code_mode_run` with WORKER_API_KEY (callback over HTTPS).
Reading a thread this way also stores it in Postgres (the Worker's cache writes gws.*)."""
from __future__ import annotations

import json

import httpx

from .config import Settings


class WorkerError(RuntimeError):
    pass


class WorkerClient:
    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self.s = settings
        self.c = client or httpx.Client(timeout=300)
        self._id = 0

    def tool(self, name: str, args: dict) -> dict:
        self._id += 1
        code = f"return await tools.{name}({json.dumps(args)});"
        r = self.c.post(
            f"{self.s.worker_url}/mcp",
            headers={"Authorization": f"Bearer {self.s.worker_api_key}", "accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": self._id, "method": "tools/call", "params": {"name": "code_mode_run", "arguments": {"code": code}}},
        )
        if r.status_code != 200:
            raise WorkerError(f"worker {r.status_code}: {r.text[:300]}")
        body = r.json()
        if "error" in body:
            raise WorkerError(str(body["error"])[:300])
        res = body["result"]
        payload = res.get("structuredContent") or json.loads(res["content"][0]["text"])
        if res.get("isError") or payload.get("ok") is False:
            raise WorkerError(str(payload.get("error") or payload)[:300])
        return payload.get("result", payload)

    def list_recent_thread_ids(self, after_epoch: int, account: str | None = None, limit: int = 100) -> list[str]:
        args: dict = {"query": f"after:{after_epoch}", "maxResults": limit}
        if account:
            args["as_user"] = account
        res = self.tool("gmail_list", args)
        seen: list[str] = []
        for m in res.get("messages", []):
            t = m.get("threadId")
            if t and t not in seen:
                seen.append(t)
        return seen

    def index_thread(self, thread_id: str, account: str | None = None, attachments: bool = False) -> dict:
        args: dict = {"threadId": thread_id, "includeAttachments": attachments}
        if account:
            args["as_user"] = account
        return self.tool("gmail_get_thread", args)
