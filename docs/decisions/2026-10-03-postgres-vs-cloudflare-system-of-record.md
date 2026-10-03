# Postgres on Proxmox, or the Cloudflare stores already running?

- **Date:** 2026-10-03
- **Status:** Decided 2026-10-03 — option 2, full migration to Postgres
- **Raised by:** Claude (Opus 5), while starting Phase 1 of the V7 roadmap
- **Maestro:** plan `425423745986`, tasks `task-wrangler-setup`, `task-pg-schema-ddl`, `epic-lxc-python`

## What happened

The V7 roadmap puts the system of record on **PostgreSQL + pgvector on a
Proxmox LXC**, reached from the Worker over **Hyperdrive**, with a **FastAPI +
rclone** daemon beside it. I claimed the first Phase 1 task and measured what
exists before writing anything.

Measured 2026-10-03, in the repo and on the account:

| Roadmap expects | Actually there |
| --- | --- |
| Hyperdrive binding to Proxmox Postgres | no `hyperdrive` block in `wrangler.jsonc`; no Postgres in `~/AGENTS-proxmox.md` or anywhere in this repo |
| VPC Service Binding to the LXC host | no `vpc_services` block; no LXC service exists to bind to |
| Postgres as the relational store | **D1 is live** (`google-workspace-mcp`, 30+ tables, 29 migrations) |
| pgvector for RAG | **Vectorize is live** — 3 indexes already provisioned and bound |
| R2 `drive-staging` with TTL lifecycles | not created (other R2 buckets exist) — *doable today, no LXC needed* |
| D1 for sent-email UUID tracking | **already done** (`email_records`) |

## Why it matters to you

This is not "add a database". Postgres + pgvector **replaces two stores that
are already running and already hold data**. Doing it means a migration, a
period of two sources of truth, and a Worker that is down whenever the Proxmox
box is — where today it has no such dependency.

It is not an unreasonable direction. On invoice IN-79888512, **D1 storage is
$3.00/month — one of only two usage line items on the whole account that are
not zero** (the other is Workers AI at $7.37). Moving bulk rows off D1 to a box
you already pay for is the single biggest lever on that bill. Vectorize, by
contrast, costs **$0.05**, so moving RAG to pgvector saves nothing and gives up
a managed service.

Meanwhile roughly half of Phase 1 needs none of this resolved, so work is not
stopped either way.

## The question

Does Postgres on Proxmox become the system of record, and if so does RAG move
off Vectorize with it?

## Options

1. **Split it — Postgres for bulk relational, keep Vectorize for RAG.** *(recommended)*
   Moves the $3.00/month line and the unbounded growth (email bodies, ACRE
   chunks) onto hardware you already own, while RAG stays on a managed service
   that costs five cents and needs no Hyperdrive round trip on every query. D1
   keeps the small hot tables the Worker needs when Proxmox is unreachable.
2. **Full migration as the roadmap is written.** Postgres + pgvector for
   everything, D1 reduced to sent-email UUID tracking. One store to reason
   about; gives up a managed vector service for no saving, and puts RAG behind
   the home connection.
3. **Stay Cloudflare-native; drop the LXC from the roadmap.** Cheapest to
   build, no new failure domain — but leaves D1 storage as a growing bill and
   throws away the Phase 1/2 design.

## What I will do if you say nothing

Carry on with the half of Phase 1 that does not depend on the answer — the R2
`drive-staging` bucket with its TTL lifecycles, and the `DriveBridgeRPC`
surface (`searchDrive`, `searchGmail`, `stageForRead`, `stageForWrite`,
`generateDocument`) built on the services already here. I will not create a
Hyperdrive config, a VPC binding, or any Postgres schema until you answer,
because those are the parts that are expensive to undo.

## Decision

**2026-10-03 — Justin: "I want everything on Postgres. Postgres is free running
on my local machine." Option 2, in full: Postgres becomes the system of record,
and RAG moves to pgvector with it.**

### What I had wrong when I raised this

I wrote that no Postgres was documented. That was a fact about the docs, not
about the machine, and I should not have let it stand as the second. Measured
2026-10-03 after the decision:

- **PostgreSQL 17.5** is live on **LXC 109, `192.168.1.50:5432`**, hostssl
  scram, reachable over the LAN, already carrying nine databases including
  `maestro` (65 MB) and `homeassistant` (7.9 GB).
- A **Cloudflare Tunnel already exists for it** — `postgres-db.hacolby.app`,
  tunnel `f291dfcb-8a41-459e-99f4-fca8d481370f`
  (`CLOUDFLARED_POSTGRES_LXC109_TUNNEL_TOKEN`).
- Credentials are already in the tokens CLI
  (`POSTGRES_LXC109_SUPERUSER_PASSWORD`), and `gh_tools` is an existing
  precedent for a project owning a database on this box.

So the infrastructure half of Phase 1 was never missing — it was undocumented.
`~/AGENTS-proxmox.md` says nothing about Postgres, which is worth fixing.

### The one gap, and the one caveat

- **pgvector is NOT installed.** `pg_available_extensions` on LXC 109 offers
  `pg_trgm`, `pgcrypto` and `uuid-ossp` only. "Everything on Postgres" includes
  RAG, so `postgresql-17-pgvector` has to go on the box before the Vectorize
  indexes can move.
- **Stated once, not an argument:** the Worker currently has no dependency on
  the house being up. After this it does — if LXC 109 is down, the Worker's
  database is down. Hyperdrive caches reads, which softens it, but writes fail.
  That is the trade being made deliberately in exchange for free storage and
  one store to reason about.

### How it gets connected

Cloudflare's current recommended path for a private database (changelog
2026-04-29) is a **Workers VPC service** over the existing tunnel, with
**Hyperdrive** on top — which collapses two of `task-wrangler-setup`'s four
requirements into one flow:

    npx wrangler hyperdrive create <name> \
      --service-id <VPC_SERVICE_ID> --database <db> \
      --user <user> --password <pw> --scheme postgresql
