# AI operations

> Part of the workstation briefing. **`~/AGENTS.md` is the parent — read it first**;
> it carries the rules that apply everywhere (secrets, backups, how to write to
> Justin, when to flag). This file adds the rules for **every AI or LLM call**, in any language, runtime, or script. There are no exceptions to this file.

---

# AI operations

**Every AI inference call — every project, every script, every language, every
runtime — goes through core-guardian. No exceptions.** Not "most calls." Not
"production calls." Not "except this one throwaway script." A one-off `curl` to
`api.openai.com`, a Python notebook, a `env.AI.run` in a Worker, a test harness,
a cron job: all of it routes through the guardian or it does not run.

This is not a style preference. A direct provider call is **invisible** to the
budget: it is not metered, it does not count against the cap, it cannot be
attributed to a project, and the kill switch cannot stop it. One unmetered
script is enough to blow the monthly cap silently. If you are about to write a
provider base URL or an SDK client pointed at a provider, stop — you are doing
it wrong.

- **Base:** `https://core-guardian.hacolby.workers.dev`
- **Contract:** [`/openapi.json`](https://core-guardian.hacolby.workers.dev/openapi.json)
  — the live source of truth. Read it rather than trusting this section.
- **Architecture & plan:** [`/docs/architecture`](https://core-guardian.hacolby.workers.dev/docs/architecture)
  — what is real, what was verified against the live Cloudflare API, and which
  assumptions turned out false. Read it before designing anything spend-related.
- **Source:** `/Volumes/Projects/workers/core-guardian`

## From a Worker: the service binding and the standard module — never HTTPS

**A Worker calls core-guardian over a service binding, through the standard
module `src/backend/ai/guardian/` from
[`jmbish04/core-template-cf-reui`](https://github.com/jmbish04/core-template-cf-reui).**
Every Worker made from that template already has both. Anything else, copy the
folder and add the binding:

```jsonc
"services": [{ "binding": "CORE_GUARDIAN", "service": "core-guardian",
               "entrypoint": "GuardianRpc", "remote": true }]
```

(Some older Workers name it `GUARDIAN`; the entrypoint is what matters.) Plus
`vars.GUARDIAN_PROJECT` equal to the Worker's `name` — it is what guardian
bills to, and the module throws rather than guess it.

**Why not HTTPS:** a Worker fetching another Worker's `workers.dev` hostname on
the same account is refused with **Cloudflare error 1042** (measured from
colby-maestro, 2026-09-29). The binding needs no API key — it is itself the
trust boundary — and runs the same validation, routing, breakers and metering
as the HTTP door.

What the module covers — one wrapper per `GuardianRpc` method, all imported
from `@/backend/ai/guardian`:

| Need | Call |
|---|---|
| A completion | `guardianChat` — routing hints or a sentinel `model` (`auto`/`best`/`budget`/`cheapest`), never a pinned model unless you must |
| Tool calling | `guardianChat({ tools })` → `toolCalls`; sending tools declares `capabilities: ["tools"]` for you |
| Streaming | `guardianStream` + `readGuardianStream` |
| Embeddings / any Workers AI model | `embed` (bge-small, 100 per call) + `cosineSimilarity`; `guardianWorkersAi` |
| Preview a route, no spend | `routeGuardian`, `guardianUseCases` |
| Jules, Stitch, orchestrations | `guardianToolkits` + `guardianTool`; raw `guardianJules` / `guardianStitch` / `guardianOrchestration` |

**Copy from [`examples.ts`](https://github.com/jmbish04/core-template-cf-reui/blob/main/src/backend/ai/guardian/examples.ts)**
— one worked sample per row, compiled by the template's typecheck so it cannot
drift. Never an `ai` binding: `env.AI.run` bills the card unattributed.

## Everything that is not a Worker: the HTTPS door

Scripts, Python, CLIs, a local agent — anything with no binding to be trusted
by — call `https://core-guardian.hacolby.workers.dev` with a bearer. The
endpoints and credentials below are for them.

### Auth — two doors, two different credentials

| Door | Routes | Credential |
|---|---|---|
| **Inference** | `POST /api/ai-router/run` | `Authorization: Bearer <CLOUDFLARE_AI_GATEWAY_TOKEN>` |
| **Admin / management** | `/api/ai/*`, `/api/ai-router/circuits`, `/kill-switch`, `/usage`, `/requests`, `/ollama`, `/recommendations` | `Authorization: Bearer <WORKER_API_KEY>` (guardianAuth; a signed session cookie also works) |

Do not cross the wires — the inference door does an exact compare against
`CLOUDFLARE_AI_GATEWAY_TOKEN` only, and `WORKER_API_KEY` will 401 there.

**Resolve `CLOUDFLARE_AI_GATEWAY_TOKEN` the way you resolve every other secret**
(see "Secrets & credentials" above) — never inline it:

- **In a local script:** `requireSecret("CLOUDFLARE_AI_GATEWAY_TOKEN")` /
  `require_secret("CLOUDFLARE_AI_GATEWAY_TOKEN")` from the scaffolded SDK.
- Verify it first: `tokens find CLOUDFLARE_AI_GATEWAY_TOKEN`.

### Which endpoint

| You are doing | Endpoint |
|---|---|
| **Any inference — default to this** | `POST /api/ai-router/run`. Routes through AI Gateway, metered, circuit-breaker gated. Body: `project`, `importance` (`low`\|`medium`\|`high`), `provider` (now **optional** — omit to route across all providers; still required when a concrete `model` is given), `model`, `input`, optional `task`, `use_case`, `complexity` (`low`\|`medium`\|`high`, **caller-authoritative** — supply it to skip the classifier), `reasoning` (`low`\|`medium`\|`high`), `budgetRange` (`{minUsd?,maxUsd?}`, supersedes the older single `budgetUsd`), `mode` / `stream` / `capabilities` / `repo`. Returns `request_uuid`, `status`, `provider`, `model`, `mode`, `gateway`, `tokens_in`, `tokens_out`, `cost_usd`, `body`, `routing` — or, when routing (no concrete `model`) can't find a candidate inside `budgetRange`, a `422 {status:"no_model_in_budget", lowestAvailable:{provider,model,estCostUsd}, reason}` and nothing runs. |
| Preview a routing decision without spending | `POST /api/ai-router/route`. Same body as `/run` minus execution — dry-run, `Authorization: Bearer <WORKER_API_KEY>` (guardianAuth), no metering. Returns the full `RoutingDecision`: `status`, `provider`, `model`, `tier`, `complexity`, `complexitySource`, `estCostUsd`, `reason[]`, `quotaState[]`, `excluded[]`, optional `lowestAvailable`. |
| Discover routable use cases / models | `GET /api/ai-router/use-cases`. `Authorization: Bearer <WORKER_API_KEY>` (guardianAuth). Returns the curated `use_case` catalog joined to the live model catalog + quota state: `{useCases:[{key,description,capabilityFloor,tags,matchingModels[]}]}`. Docs + live playground at `/docs/ai-router-routing`. |
| A raw provider call with your own key | `POST /api/ai/{provider}/{model}` (`openai` \| `anthropic` \| `google`), key in the `X-Provider-Key` header — never stored. Returns `{ body, cost, spent }`, 429s when the monthly cap is blown. |
| Workers AI | `POST /api/ai/workers-ai/{model}` with a required `origin` (`WORKER_API_KEY`). A Worker uses `embed` / `guardianWorkersAi` over the binding instead (above). |
| Checking / setting the cap, or stopping everything | `GET`/`PUT /api/ai/budget`, `POST /api/ai/budget/break-glass`, `GET /api/ai-router/circuits`, `POST /api/ai-router/kill-switch` |

### Vendoring the client

`GET /api/integration/instructions` returns the current pull command, `vars` stub,
and required secrets for your language. The Python client is already written:
`python/utils/ai.py`. `~/.colby-ecosystem/workers/utils/ai.ts` is the HTTPS client
— from a Worker, use the template's `src/backend/ai/guardian/` instead.

### Searching what you embedded: check the index against an exact scan

An approximate vector index can return the wrong neighbours while every check
stays green. Measured 2026-10-21 on colby-maestro's pgvector `diskann` index,
right after a backfill of 4,162 vectors: every query returned the same unrelated
rows at about 0.6, while an exact scan of the same table found the right row at
0.919. Tests ran on a handful of rows, where an approximate index is exact.

After any large embedding backfill, run one query twice: through the index, and
with `SET enable_indexscan=off`. If they differ, rebuild the index
(`REINDEX INDEX CONCURRENTLY ...`). Procedure: Maestro playbook
`vector-search-returns-wrong-neighbours`.

---
### The rule above is now scanned for, not trusted: `scripts/ai-guard.mjs`

**Every rule in this file held only where somebody happened to read it, and the
measurement says that was nowhere.** On 2026-11-02, for the whole 2026-10-19
billing cycle, core-guardian's AI router saw **0.0%** of the paid account's
Workers AI neurons. All 40,547 of them went around the governor. So the armed
monthly spend cap could not see them, the circuit breakers could not stop them,
and Cloudflare's own analytics break neurons down by **model, not by Worker** —
nobody could even say which project spent them.

The cause was countable. **94 of 272** wrangler configs on this machine declared
a top-level `ai` binding, which is a direct, unmetered line to Workers AI.

So the AI chapter now ships a scanner, the way the frontend chapter ships
`ui-guard.mjs`. The briefing sync drops `scripts/ai-guard.mjs` into every repo
that gets this file.

| Rule | What it catches |
|---|---|
| `ai-binding` | a wrangler config with a top-level `ai` binding |
| `direct-ai-call` | `env.AI.run` / `.models` / `.toMarkdown` / `.autorag` |
| `provider-sdk` | importing an OpenAI, Anthropic, Google, Mistral or Cohere SDK |
| `provider-fetch` | fetching a provider base URL directly |
| `allow-reason` | an `ai-guard-allow` with no reason, or naming no real rule |

```bash
node scripts/ai-guard.mjs .                   # the scan
node scripts/ai-guard.mjs . --self-check      # prove its own checks can fail
node scripts/ai-guard.mjs . --update-baseline # re-record after a burn-down
```

**It is a ratchet, not a cliff**, because 47 repos violate it today and a guard
that fails all of them on arrival is a guard somebody disables. `.ai-guard.json`
records the per-file counts a repo already has. A new violating file fails. More
call sites in a known file fails. Fewer passes, and says so. `--update-baseline`
**refuses to raise a count** without `--force`: a baseline that can go up is not
a ratchet.

Two exemptions, both explicit. `core-guardian` itself sets
`"allowAiBinding": true` — it is the governor, so it is the one Worker that may
hold the binding. A single line takes
`// ai-guard-allow direct-ai-call: <why>`, and the reason is required.

**Count calls, not mentions.** Writing this guard corrected a number in this
file's own first draft. A grep for `env\.AI\.run` reported 153 call sites in
core-remodel; 5 of those "sites" were prose — a comment reading
`` ~130 `env.AI.run` sites stay untouched ``, a changelog string, and a
health-check remediation message. The guard requires the opening paren, and
measured **74** real calls in 45 files. One search form is not a search, and a
pattern without the paren is not a call site.