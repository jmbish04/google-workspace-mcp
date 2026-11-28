#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["psycopg[binary]>=3.2"]
# ///
"""Copy a D1 export (loaded into a local SQLite file) into Postgres schema `d1_import`.

Lossless landing copy: every table, every row, same names. SQLite declared types map to
bigint / double precision / text / bytea, so epoch-second integers and JSON text arrive
byte-identical. Source D1 is never touched. Re-runnable: the target schema is dropped and
rebuilt each run. Verifies row counts AND a per-table row hash on both sides, and exits
non-zero on any mismatch.

Usage: PGPASSWORD=... d1-to-postgres.py <d1.db> [--skip table,table]
"""
import hashlib, os, sqlite3, sys
import psycopg

SKIP_ALWAYS = {"d1_migrations", "_cf_KV"}
TYPE_MAP = {"INT": "bigint", "REAL": "double precision", "FLOA": "double precision", "DOUB": "double precision", "BLOB": "bytea"}

def pg_type(decl: str) -> str:
    d = (decl or "").upper()
    for k, v in TYPE_MAP.items():
        if k in d:
            return v
    return "text"  # TEXT, VARCHAR, JSON, TIMESTAMP, untyped: sqlite keeps them as text/int; see cast below

def norm(v, t):
    if v is None:
        return None
    if t == "bytea":
        return bytes(v)
    if t == "bigint":
        return int(v)
    if t == "double precision":
        return float(v)
    return v if isinstance(v, str) else str(v)

def rowhash(rows) -> str:
    h = hashlib.sha256()
    # Sorted in Python: SQLite and Postgres collate text keys differently, so ORDER BY differs.
    for r in sorted(repr(r) for r in rows):
        h.update(r.encode())
    return h.hexdigest()

def main():
    src = sys.argv[1]
    skip = set(SKIP_ALWAYS)
    if "--skip" in sys.argv:
        skip |= set(sys.argv[sys.argv.index("--skip") + 1].split(","))
    sq = sqlite3.connect(src)
    sq.text_factory = lambda b: b.decode("utf-8", "surrogateescape")
    tables = [r[0] for r in sq.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name") if r[0] not in skip]
    conn = psycopg.connect(host="192.168.1.50", port=5432, user="postgres", dbname="google_workspace_mcp", sslmode="require", password=os.environ["PGPASSWORD"], autocommit=False)
    cur = conn.cursor()
    cur.execute("DROP SCHEMA IF EXISTS d1_import CASCADE; CREATE SCHEMA d1_import")
    bad = []
    report = []
    for t in tables:
        cols = list(sq.execute(f'pragma table_info("{t}")'))
        types = [pg_type(c[2]) for c in cols]
        pks = [c[1] for c in sorted((c for c in cols if c[5]), key=lambda c: c[5])]
        ddl = ", ".join(f'"{c[1]}" {ty}' + (" NOT NULL" if c[3] and not c[5] else "") for c, ty in zip(cols, types))
        if pks:
            ddl += ", PRIMARY KEY (" + ", ".join(f'"{p}"' for p in pks) + ")"
        cur.execute(f'CREATE TABLE d1_import."{t}" ({ddl})')
        names = ", ".join(f'"{c[1]}"' for c in cols)
        order = ", ".join(f'"{p}"' for p in pks) or "rowid"
        rows = [tuple(norm(v, ty) for v, ty in zip(r, types)) for r in sq.execute(f'select {names} from "{t}" order by {order}')]
        if rows:
            with cur.copy(f'COPY d1_import."{t}" ({names}) FROM STDIN') as cp:
                for r in rows:
                    cp.write_row(r)
        cur.execute(f'select {names} from d1_import."{t}" order by {order}')
        back = [tuple(r) for r in cur.fetchall()]
        ok = len(rows) == len(back) and rowhash(rows) == rowhash(back)
        report.append((t, len(rows), len(back), "OK" if ok else "MISMATCH"))
        if not ok:
            bad.append(t)
    if bad:
        conn.rollback()
    else:
        cur.execute("GRANT USAGE ON SCHEMA d1_import TO gws_app; GRANT SELECT ON ALL TABLES IN SCHEMA d1_import TO gws_app")
        conn.commit()
    for t, a, b, s in report:
        print(f"{t:32} sqlite={a:>8,} postgres={b:>8,} {s}")
    total = sum(r[1] for r in report)
    print(f"{len(report)} tables, {total:,} rows, {'FAILED: ' + ','.join(bad) if bad else 'all verified'}")
    sys.exit(1 if bad else 0)

main()
