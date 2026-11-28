"""Postgres access for the ingest service. Plain SQL against schema `gws`."""
from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row

from .rules import MailFacts


def connect(dsn: str) -> psycopg.Connection:
    return psycopg.connect(dsn, row_factory=dict_row, autocommit=True)


def load_rules(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return conn.execute(
        "select id, name, project_id, target::text as target, priority, enabled, conditions, actions "
        "from gws.ingest_rules where enabled order by priority, id"
    ).fetchall()


def account_id(conn: psycopg.Connection, email: str) -> int:
    kind = "consumer" if email.lower().endswith(("@gmail.com", "@googlemail.com")) else "workspace"
    return conn.execute(
        "insert into gws.accounts (email, kind) values (%s, %s::gws.account_kind) "
        "on conflict (email) do update set email = excluded.email returning id",
        (email, kind),
    ).fetchone()["id"]


def get_cursor(conn: psycopg.Connection, acc: int) -> int | None:
    r = conn.execute("select extract(epoch from last_polled_at)::bigint as t from gws.sync_cursors where account_id=%s", (acc,)).fetchone()
    return r["t"] if r and r["t"] else None


def set_cursor(conn: psycopg.Connection, acc: int, status: str = "idle", error: str | None = None, advance: bool = True) -> None:
    conn.execute(
        "insert into gws.sync_cursors (account_id, last_polled_at, status, error) values (%s, now(), %s, %s) "
        "on conflict (account_id) do update set status=excluded.status, error=excluded.error, "
        "last_polled_at = case when %s then now() else gws.sync_cursors.last_polled_at end",
        (acc, status, error, advance),
    )


def thread_messages(conn: psycopg.Connection, acc: int, gmail_thread_id: str) -> list[dict[str, Any]]:
    return conn.execute(
        "select id, gmail_message_id, subject, to_jsonb(label_ids) as labels, headers, body_text "
        "from gws.gmail_messages where account_id=%s and gmail_thread_id=%s and gone_at is null order by internal_date, id",
        (acc, gmail_thread_id),
    ).fetchall()


def facts_of(row: dict[str, Any]) -> MailFacts:
    h = row["headers"] or {}
    return MailFacts(
        sender=str(h.get("from", "")),
        to=" ".join(str(h.get(k, "")) for k in ("to", "cc")),
        subject=str(row["subject"] or h.get("subject", "")),
        body=row["body_text"] or "",
        labels=list(row["labels"] or []),
    )


def enqueue(conn: psycopg.Connection, kind: str, message_id: int | None = None, attachment_id: int | None = None) -> bool:
    """Queue a job unless an identical queued/running one exists. Returns whether one was added."""
    r = conn.execute(
        "insert into gws.ingest_jobs (kind, message_id, attachment_id) "
        "select %s::gws.job_kind, %s, %s where not exists ("
        "  select 1 from gws.ingest_jobs where kind=%s::gws.job_kind and status in ('queued','running') "
        "  and message_id is not distinct from %s and attachment_id is not distinct from %s) returning id",
        (kind, message_id, attachment_id, kind, message_id, attachment_id),
    ).fetchone()
    return r is not None


def record_hit(conn: psycopg.Connection, rule_id: int, message_id: int) -> None:
    conn.execute(
        "insert into gws.ingest_rule_hits (rule_id, message_id) select %s, %s "
        "where not exists (select 1 from gws.ingest_rule_hits where rule_id=%s and message_id=%s)",
        (rule_id, message_id, rule_id, message_id),
    )


def claim(conn: psycopg.Connection, worker: str, limit: int = 5, stale_minutes: int = 15) -> list[dict[str, Any]]:
    """Take queued jobs (and ones a dead worker left running) with FOR UPDATE SKIP LOCKED."""
    return conn.execute(
        "update gws.ingest_jobs j set status='running', locked_by=%s, locked_at=now(), attempts=attempts+1 "
        "where j.id in (select id from gws.ingest_jobs where "
        "  (status='queued' and run_after <= now()) or (status='running' and locked_at < now() - make_interval(mins => %s)) "
        "  order by run_after, id limit %s for update skip locked) "
        "returning j.id, j.kind::text as kind, j.message_id, j.attachment_id, j.attempts",
        (worker, stale_minutes, limit),
    ).fetchall()


def finish(conn: psycopg.Connection, job_id: int, error: str | None, max_attempts: int = 4, attempts: int = 1) -> None:
    if error is None:
        conn.execute("update gws.ingest_jobs set status='done', error=null, locked_by=null where id=%s", (job_id,))
    elif attempts >= max_attempts:
        conn.execute("update gws.ingest_jobs set status='error', error=%s, locked_by=null where id=%s", (error[:1000], job_id))
    else:  # retry with backoff 1, 4, 9 minutes
        conn.execute(
            "update gws.ingest_jobs set status='queued', error=%s, locked_by=null, run_after=now() + make_interval(mins => %s) where id=%s",
            (error[:1000], attempts * attempts, job_id),
        )


def replace_message_chunks(conn: psycopg.Connection, message_pk: int, chunks: list[str], vecs: list[str], model: str) -> None:
    with conn.transaction():
        conn.execute("delete from gws.content_chunks where message_id=%s", (message_pk,))
        for i, (t, v) in enumerate(zip(chunks, vecs)):
            conn.execute(
                "insert into gws.content_chunks (message_id, chunk_index, text, embedding, model) values (%s,%s,%s,%s::vector,%s)",
                (message_pk, i, t, v, model),
            )


def replace_content_chunks(conn: psycopg.Connection, content_pk: int, chunks: list[str], vecs: list[str], model: str) -> None:
    with conn.transaction():
        conn.execute("delete from gws.content_chunks where content_id=%s", (content_pk,))
        for i, (t, v) in enumerate(zip(chunks, vecs)):
            conn.execute(
                "insert into gws.content_chunks (content_id, chunk_index, text, embedding, model) values (%s,%s,%s,%s::vector,%s)",
                (content_pk, i, t, v, model),
            )


def search(conn: psycopg.Connection, vec: str, query: str, limit: int = 10, project_key: str | None = None) -> list[dict[str, Any]]:
    """Hybrid: reciprocal-rank fusion of cosine similarity and full-text rank, over message and document chunks."""
    return conn.execute(
        """
        with sem as (
          select id, row_number() over (order by embedding <=> %(v)s::vector) as r
          from gws.content_chunks where embedding is not null order by embedding <=> %(v)s::vector limit 50),
        fts as (
          select id, row_number() over (order by ts_rank(tsv, plainto_tsquery('english', %(q)s)) desc) as r
          from gws.content_chunks where tsv @@ plainto_tsquery('english', %(q)s) order by 2 limit 50),
        fused as (
          select coalesce(sem.id, fts.id) as id,
                 coalesce(1.0/(60+sem.r),0) + coalesce(1.0/(60+fts.r),0) as score
          from sem full join fts on sem.id = fts.id)
        select c.id as chunk_id, f.score, c.text,
               m.gmail_message_id, m.gmail_thread_id, m.subject,
               fc.sha256, (select a.filename from gws.gmail_attachments a where a.content_id = fc.id order by a.id limit 1) as filename
        from fused f
        join gws.content_chunks c on c.id = f.id
        left join gws.gmail_messages m on m.id = c.message_id
        left join gws.file_contents fc on fc.id = c.content_id
        where (%(p)s::text is null or exists (
          select 1 from app.project_threads pt join app.projects pr on pr.id = pt.project_id
          join gws.gmail_threads t on t.id = pt.thread_id
          where pr.key = %(p)s and (t.id = m.thread_id or t.id in (
            select m2.thread_id from gws.gmail_attachments a2 join gws.gmail_messages m2 on m2.id = a2.message_id where a2.content_id = c.content_id))))
        order by f.score desc limit %(l)s
        """,
        {"v": vec, "q": query, "l": limit, "p": project_key},
    ).fetchall()
