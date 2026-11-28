"""Job handlers: embed a message body, extract an attachment, embed extracted document text."""
from __future__ import annotations

from typing import Any, Callable

import psycopg

from . import store
from .chunking import chunk_text
from .config import Settings
from .guardian import embed, vec_literal
from .worker_client import WorkerClient


def _message(conn: psycopg.Connection, pk: int) -> dict[str, Any] | None:
    return conn.execute(
        "select m.id, m.gmail_message_id, m.subject, m.body_text, a.email::text as account "
        "from gws.gmail_messages m join gws.accounts a on a.id = m.account_id where m.id=%s",
        (pk,),
    ).fetchone()


def embed_message(conn: psycopg.Connection, s: Settings, job: dict[str, Any], **_: Any) -> None:
    m = _message(conn, job["message_id"])
    if not m:
        return
    text = f"{m['subject'] or ''}\n\n{m['body_text'] or ''}".strip()
    chunks = chunk_text(text)
    vecs = [vec_literal(v) for v in embed(s, chunks)] if chunks else []
    store.replace_message_chunks(conn, m["id"], chunks, vecs, s.embed_model)


def extract_attachment(conn: psycopg.Connection, s: Settings, job: dict[str, Any], worker: WorkerClient | None = None, **_: Any) -> None:
    """Have the Worker stage the message's attachments to Drive and extract text (OCR, Office -> Markdown).
    The Worker writes file_contents/gmail_attachments; this then queues embedding of any new text."""
    a = conn.execute(
        "select a.id, a.is_junk, m.gmail_message_id, acc.email::text as account "
        "from gws.gmail_attachments a join gws.gmail_messages m on m.id=a.message_id "
        "join gws.accounts acc on acc.id=m.account_id where a.id=%s",
        (job["attachment_id"],),
    ).fetchone()
    if not a or a["is_junk"]:
        return
    w = worker or WorkerClient(s)
    w.tool("gmail_get_message", {"id": a["gmail_message_id"], "includeAttachmentText": True, "as_user": a["account"]})
    row = conn.execute("select content_id from gws.gmail_attachments where id=%s", (a["id"],)).fetchone()
    if row and row["content_id"]:
        conn.execute(
            "insert into gws.ingest_jobs (kind, attachment_id) select 'embed_content', %s where not exists "
            "(select 1 from gws.ingest_jobs where kind='embed_content' and attachment_id=%s and status in ('queued','running'))",
            (a["id"], a["id"]),
        )


def embed_content(conn: psycopg.Connection, s: Settings, job: dict[str, Any], **_: Any) -> None:
    r = conn.execute(
        "select fc.id, fc.extracted_text from gws.gmail_attachments a join gws.file_contents fc on fc.id=a.content_id where a.id=%s",
        (job["attachment_id"],),
    ).fetchone()
    if not r:
        return
    # Dedupe: identical bytes already embedded under this model -> reuse, never re-embed.
    have = conn.execute("select 1 from gws.content_chunks where content_id=%s and model=%s limit 1", (r["id"], s.embed_model)).fetchone()
    if not have:
        chunks = chunk_text(r["extracted_text"] or "")
        vecs = [vec_literal(v) for v in embed(s, chunks)] if chunks else []
        store.replace_content_chunks(conn, r["id"], chunks, vecs, s.embed_model)
    conn.execute("update gws.gmail_attachments set status='embedded' where id=%s", (job["attachment_id"],))


HANDLERS: dict[str, Callable[..., None]] = {
    "embed_message": embed_message,
    "extract_attachment": extract_attachment,
    "embed_content": embed_content,
}


def run_job(conn: psycopg.Connection, s: Settings, job: dict[str, Any], worker: WorkerClient | None = None) -> None:
    h = HANDLERS.get(job["kind"])
    if h is None:
        raise RuntimeError(f"no handler for job kind {job['kind']}")
    h(conn, s, job, worker=worker)
