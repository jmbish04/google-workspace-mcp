"""Poll Gmail (through the Worker) per account, store new threads, apply rules, queue work."""
from __future__ import annotations

import logging
import time

import psycopg

from . import store
from .config import Settings
from .rules import Decision, decide
from .worker_client import WorkerClient

log = logging.getLogger("gws_ingest.poller")
FIRST_RUN_LOOKBACK_S = 7 * 86400
OVERLAP_S = 600  # re-scan a little behind the cursor so a slow delivery is never missed


def route_thread(conn: psycopg.Connection, acc: int, gmail_thread_id: str, rules: list[dict]) -> dict[str, int]:
    """Apply rules to the stored messages of one thread and enqueue the resulting jobs."""
    queued = {"embed_message": 0, "extract_attachment": 0, "hits": 0}
    for m in store.thread_messages(conn, acc, gmail_thread_id):
        d: Decision = decide(rules, store.facts_of(m))
        if not d.matched_rule_ids:
            continue
        for rid in d.matched_rule_ids:
            store.record_hit(conn, rid, m["id"])
            queued["hits"] += 1
        if d.embed and store.enqueue(conn, "embed_message", message_id=m["id"]):
            queued["embed_message"] += 1
        if d.extract_attachments:
            for a in conn.execute("select id from gws.gmail_attachments where message_id=%s and not is_junk and content_id is null", (m["id"],)).fetchall():
                if store.enqueue(conn, "extract_attachment", attachment_id=a["id"]):
                    queued["extract_attachment"] += 1
        if d.project_key:
            conn.execute(
                "insert into app.project_threads (project_id, thread_id) "
                "select p.id, m.thread_id from app.projects p, gws.gmail_messages m where p.key=%s and m.id=%s "
                "on conflict do nothing",
                (d.project_key, m["id"]),
            )
    return queued


def poll_account(conn: psycopg.Connection, s: Settings, worker: WorkerClient, email: str) -> dict:
    acc = store.account_id(conn, email)
    since = (store.get_cursor(conn, acc) or int(time.time()) - FIRST_RUN_LOOKBACK_S) - OVERLAP_S
    store.set_cursor(conn, acc, status="polling", advance=False)
    started = int(time.time())
    try:
        threads = worker.list_recent_thread_ids(since, account=email)
        rules = store.load_rules(conn)
        out = {"threads": len(threads), "embed_message": 0, "extract_attachment": 0, "errors": 0}
        for t in threads:
            try:
                worker.index_thread(t, account=email, attachments=False)
                q = route_thread(conn, acc, t, rules)
                out["embed_message"] += q["embed_message"]
                out["extract_attachment"] += q["extract_attachment"]
            except Exception as e:  # one bad thread must not stall the mailbox
                out["errors"] += 1
                log.warning("thread %s failed: %s", t, e)
        # Only advance the cursor to when this poll STARTED, and only if nothing failed,
        # so a failed thread is retried on the next pass.
        store.set_cursor(conn, acc, status="idle" if not out["errors"] else "partial", error=None, advance=out["errors"] == 0)
        if out["errors"] == 0:
            conn.execute("update gws.sync_cursors set last_polled_at = to_timestamp(%s) where account_id=%s", (started, acc))
        return out
    except Exception as e:
        store.set_cursor(conn, acc, status="error", error=str(e)[:500], advance=False)
        raise
