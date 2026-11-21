# gws-ingest

Polls Gmail (through the Worker), applies routing rules, and embeds the mail it routes into Postgres schema `gws`. Plan: `docs/gmail-postgres-plan.md`.

- Runs on LXC 156 (`192.168.1.234:8765`), systemd unit `gws-ingest`, code in `/opt/gws-ingest`, secrets in `/etc/gws-ingest.env` (mode 0600).
- Reads Gmail by calling the Worker's `/mcp` with `WORKER_API_KEY`; the Worker holds the Google grants and writes the thread/message rows itself.
- Embeds with `@cf/baai/bge-m3` (1,024 dims) through Core Guardian. Nothing embeds until an enabled rule says so (`ingest_rule_upsert` tool).
- `GET /health` checks Postgres, Guardian embeddings and the Worker. `POST /search`, `GET/POST /rules` need `Authorization: Bearer <WORKER_API_KEY>`.

Deploy a change: `tar` this directory to the node, `pct push 156 ...`, extract over `/opt/gws-ingest`, `uv sync`, `systemctl restart gws-ingest`.

Tests: `GWS_TEST_PG_DSN=... uv run --with pytest pytest` (database tests skip without the DSN).
