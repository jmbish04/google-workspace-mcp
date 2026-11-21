"""Runs against the real Postgres (GWS_TEST_PG_DSN, schema gws applied). Skipped otherwise."""
import json
import os
import threading

import pytest

from gws_ingest import jobs, poller, store
from gws_ingest.config import Settings

DSN = os.environ.get("GWS_TEST_PG_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="GWS_TEST_PG_DSN not set")

EMAIL = "svc-test@mailbox.test"


class FakeWorker:
    """Stands in for the Worker: 'indexes' a thread by writing the rows the Worker would write."""

    def __init__(self, conn, acc):
        self.conn, self.acc, self.calls = conn, acc, []

    def list_recent_thread_ids(self, since, account=None, limit=100):
        return ["TT1"]

    def index_thread(self, t, account=None, attachments=False):
        self.calls.append(("thread", t))
        th = self.conn.execute("insert into gws.gmail_threads (account_id, gmail_thread_id, subject) values (%s,%s,'COI') "
                               "on conflict (account_id, gmail_thread_id) do update set subject='COI' returning id", (self.acc, t)).fetchone()["id"]
        for mid, body in (("a1", "Please send the certificate of insurance"), ("a2", "unrelated lunch plans")):
            self.conn.execute(
                "insert into gws.gmail_messages (thread_id, account_id, gmail_thread_id, gmail_message_id, subject, body_text, headers, label_ids) "
                "values (%s,%s,%s,%s,'COI',%s,%s::jsonb, array['INBOX']) on conflict (account_id, gmail_message_id) do nothing",
                (th, self.acc, t, mid, body, json.dumps({"from": "Eloisa <e@iproofing.test>" if mid == "a1" else "Pal <p@friends.test>"})),
            )
        mpk = self.conn.execute("select id from gws.gmail_messages where account_id=%s and gmail_message_id='a1'", (self.acc,)).fetchone()["id"]
        self.conn.execute("insert into gws.gmail_attachments (message_id, gmail_part_id, filename, mime_type) values (%s,'1','coi.pdf','application/pdf') "
                          "on conflict do nothing", (mpk,))

    def tool(self, name, args):
        self.calls.append((name, args))
        return {}


@pytest.fixture()
def conn():
    c = store.connect(DSN)
    yield c
    acc = c.execute("select id from gws.accounts where email=%s", (EMAIL,)).fetchone()
    if acc:
        c.execute("delete from gws.ingest_jobs where message_id in (select id from gws.gmail_messages where account_id=%s)", (acc["id"],))
        c.execute("delete from gws.ingest_jobs where attachment_id in (select a.id from gws.gmail_attachments a join gws.gmail_messages m on m.id=a.message_id where m.account_id=%s)", (acc["id"],))
        c.execute("delete from gws.ingest_rule_hits where rule_id in (select id from gws.ingest_rules where name like 'svc-test%%')")
        c.execute("delete from gws.ingest_rules where name like 'svc-test%%'")
        c.execute("delete from gws.gmail_threads where account_id=%s", (acc["id"],))
        c.execute("delete from gws.sync_cursors where account_id=%s", (acc["id"],))
        c.execute("delete from gws.accounts where id=%s", (acc["id"],))
    c.execute("delete from app.projects where key='svc-test-proj'")
    c.close()


def settings():
    return Settings(DSN, "http://x", "k", "http://x", "t", "p", "m", 1024, (EMAIL,), 300, "k")


def test_poll_applies_rules_queues_dedupes_and_advances_cursor(conn):
    acc = store.account_id(conn, EMAIL)
    conn.execute("insert into app.projects (key, name) values ('svc-test-proj','T')")
    conn.execute("insert into gws.ingest_rules (name, target, conditions, actions) values ('svc-test', 'gmail', %s::jsonb, %s::jsonb)",
                 (json.dumps({"from": ["iproofing.test"]}), json.dumps({"embed": True, "extractAttachments": True, "projectKey": "svc-test-proj"})))
    w = FakeWorker(conn, acc)
    out = poller.poll_account(conn, settings(), w, EMAIL)
    assert out["threads"] == 1 and out["embed_message"] == 1 and out["extract_attachment"] == 1 and out["errors"] == 0
    # only the matching message is routed; the lunch message is stored but not embedded
    kinds = conn.execute("select kind::text k, count(*) n from gws.ingest_jobs j join gws.gmail_messages m on m.id=j.message_id "
                         "where m.account_id=%s group by 1", (acc,)).fetchall()
    assert [(r["k"], r["n"]) for r in kinds] == [("embed_message", 1)]
    assert conn.execute("select count(*) n from gws.ingest_rule_hits").fetchone()["n"] >= 1
    assert conn.execute("select count(*) n from app.project_threads pt join app.projects p on p.id=pt.project_id where p.key='svc-test-proj'").fetchone()["n"] == 1
    assert store.get_cursor(conn, acc) is not None
    # second poll: identical jobs are not queued twice
    again = poller.poll_account(conn, settings(), w, EMAIL)
    assert again["embed_message"] == 0 and again["extract_attachment"] == 0


def test_failed_thread_keeps_cursor_for_retry(conn):
    acc = store.account_id(conn, EMAIL)
    store.set_cursor(conn, acc)
    before = store.get_cursor(conn, acc)

    class Boom(FakeWorker):
        def index_thread(self, *a, **k):
            raise RuntimeError("gmail 500")

    out = poller.poll_account(conn, settings(), Boom(conn, acc), EMAIL)
    assert out["errors"] == 1
    assert store.get_cursor(conn, acc) == before
    assert conn.execute("select status from gws.sync_cursors where account_id=%s", (acc,)).fetchone()["status"] == "partial"


def test_queue_claims_each_job_once_under_contention_and_retries_with_backoff(conn):
    acc = store.account_id(conn, EMAIL)
    th = conn.execute("insert into gws.gmail_threads (account_id, gmail_thread_id) values (%s,'TQ') returning id", (acc,)).fetchone()["id"]
    ids = []
    for i in range(6):
        mid = conn.execute("insert into gws.gmail_messages (thread_id, account_id, gmail_thread_id, gmail_message_id) values (%s,%s,'TQ',%s) returning id", (th, acc, f"q{i}")).fetchone()["id"]
        store.enqueue(conn, "embed_message", message_id=mid)
    claimed: list[int] = []
    lock = threading.Lock()

    def grab(name):
        c = store.connect(DSN)
        for j in store.claim(c, name, limit=3):
            with lock:
                claimed.append(j["id"])
        c.close()

    ts = [threading.Thread(target=grab, args=(f"w{i}",)) for i in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(claimed) == 6 and len(set(claimed)) == 6  # no job handed to two workers
    job = conn.execute("select id, attempts from gws.ingest_jobs where id=%s", (claimed[0],)).fetchone()
    store.finish(conn, job["id"], "boom", attempts=job["attempts"])
    r = conn.execute("select status::text s, run_after > now() as later from gws.ingest_jobs where id=%s", (job["id"],)).fetchone()
    assert r["s"] == "queued" and r["later"]
    store.finish(conn, job["id"], "boom", attempts=4)
    assert conn.execute("select status::text s from gws.ingest_jobs where id=%s", (job["id"],)).fetchone()["s"] == "error"


def test_embed_message_and_search_roundtrip_with_fake_vectors(conn, monkeypatch):
    acc = store.account_id(conn, EMAIL)
    th = conn.execute("insert into gws.gmail_threads (account_id, gmail_thread_id) values (%s,'TE') returning id", (acc,)).fetchone()["id"]
    mpk = conn.execute("insert into gws.gmail_messages (thread_id, account_id, gmail_thread_id, gmail_message_id, subject, body_text) "
                       "values (%s,%s,'TE','e1','Roof COI','certificate of insurance lists the wrong insured') returning id", (th, acc)).fetchone()["id"]

    def fake_embed(s, texts, client=None):
        return [[1.0 if "insur" in t.lower() else 0.0] + [0.0] * 1023 for t in texts]

    monkeypatch.setattr(jobs, "embed", fake_embed)
    jobs.embed_message(conn, settings(), {"message_id": mpk})
    row = conn.execute("select count(*) n, bool_and(tsv is not null) t, bool_and(embedding is not null) e from gws.content_chunks where message_id=%s", (mpk,)).fetchone()
    assert row["n"] == 1 and row["t"] and row["e"]
    from gws_ingest.guardian import vec_literal

    hits = store.search(conn, vec_literal(fake_embed(None, ["insurance"])[0]), "insured", 5)
    assert hits and hits[0]["gmail_message_id"] == "e1"
    assert store.search(conn, vec_literal(fake_embed(None, ["insurance"])[0]), "zzzznomatch", 5)[0]["gmail_message_id"] == "e1"  # semantic-only still finds it
