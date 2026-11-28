"""Entry point: `python -m gws_ingest.main serve` (API + poller + job loop) or `once`."""
from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time

import uvicorn

from . import jobs, store
from .api import build_app
from .config import Settings
from .poller import poll_account
from .worker_client import WorkerClient

log = logging.getLogger("gws_ingest")
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


def drain(conn, s: Settings, w: WorkerClient, max_rounds: int = 1000) -> dict[str, int]:
    done = failed = 0
    for _ in range(max_rounds):
        batch = store.claim(conn, WORKER_ID)
        if not batch:
            break
        for job in batch:
            try:
                jobs.run_job(conn, s, job, worker=w)
                store.finish(conn, job["id"], None)
                done += 1
            except Exception as e:
                log.warning("job %s (%s) failed: %s", job["id"], job["kind"], e)
                store.finish(conn, job["id"], f"{type(e).__name__}: {e}", attempts=job["attempts"])
                failed += 1
    return {"done": done, "failed": failed}


def poll_all(s: Settings, w: WorkerClient) -> list[dict]:
    conn = store.connect(s.pg_dsn)
    try:
        return [{"account": a, **poll_account(conn, s, w, a)} for a in s.accounts]
    finally:
        conn.close()


def loop(s: Settings) -> None:
    w = WorkerClient(s)
    while True:
        try:
            poll_all(s, w)
            conn = store.connect(s.pg_dsn)
            try:
                drain(conn, s, w)
            finally:
                conn.close()
        except Exception:
            log.exception("loop pass failed")
        time.sleep(s.poll_seconds)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    s = Settings.from_env()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "once":
        w = WorkerClient(s)
        print(poll_all(s, w))
        conn = store.connect(s.pg_dsn)
        print(drain(conn, s, w))
    else:
        threading.Thread(target=loop, args=(s,), daemon=True).start()
        uvicorn.run(build_app(s), host=os.environ.get("GWS_BIND", "127.0.0.1"), port=int(os.environ.get("GWS_PORT", "8765")))


if __name__ == "__main__":
    main()
