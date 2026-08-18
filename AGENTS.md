# AGENTS

- At the start of every turn, use the `cloudflare-docs` MCP server to verify Cloudflare assumptions, architecture, and deprecations before writing or changing code.
- Review and apply the best practices in `.agents/skills/` and `.github/skills/` before implementing changes.
- Build new views as React islands on top of the existing Astro + Shadcn foundation, using the dark/moody theme system and subtle contrast instead of heavy borders.
- Enforce Zod validation on backend endpoints, expose OpenAPI v3.1.0 at `/openapi.json`, `/swagger`, and `/scalar`, and keep endpoints strongly typed.
- Every new service or view must expose `/health` and emit structured logs/metrics into the mirrored D1 logging layer.
# Agent Workspace Overview

Welcome to the `core-template-cfw-assets-astro-shadcn` template. This is a unified full-stack template combining Cloudflare Workers (Backend & Assets) with Astro and React + Shadcn/ui (Frontend).

## Core Architecture

- **Backend:** Cloudflare Workers, Hono (Routing), D1 (Database with Drizzle ORM).
- **Frontend:** Astro (SSR/Static Hybrid), React (Interactive Islands), Tailwind CSS, Shadcn/ui.
- **Deployment:** Deployed using Cloudflare Workers Assets via `wrangler.jsonc`.

## Mandatory Agent Directives

This repository relies heavily on AI agents for rapid prototyping and feature generation. If you are an AI agent, you must strictly follow these directives:

1. **Read Startup Rules:** Immediately review `.agent/rules/startup.md` before writing any code. It contains critical instructions for your first steps.
2. **Clean State Execution:** The template's default UI has been deliberately wiped clean and replaced with a temporary template-routing warning. Build the user's requested frontend directly from `src/frontend/pages/index.astro` or the route structure you introduce, and keep the shared header available on every page.
3. **Environment Strictness:** We use `worker-configuration.d.ts` for Cloudflare types. Never manually define `interface Bindings`. Always use `Bindings: Env` on Hono applications.
4. **Runtime Baseline:** Use Node.js 22+ when working with Wrangler or regenerating `worker-configuration.d.ts`.
5. **Package Management:** Default to `pnpm` for package installation and script execution.
6. **Authentication Rule:** Use the Secrets Store binding `WORKER_API_KEY` for protected API authentication and session creation. Do not add a `users` table back into this template.
7. **Schema Layout:** Keep Drizzle tables under `db/schemas/${useCase}/${tableName}.ts` and use Drizzle-Zod for API typing where table schemas are involved.
8. **Modularization:** Keep new code modular. Split helpers, components, routes, and persistence code by concern instead of adding large multipurpose files.
9. **Template Replacement Prompt:** If the user gives you the landing-page replacement prompt, replace the starter frontend, preserve the shared header, and keep the dynamic docs pointers to `/openapi.json`, `/swagger`, and `/scaler`.
10. **Frontend Errors:** Never use Chrome/browser alerts. Route every frontend error through the centralized frontend error handling utility and keep the copy-to-clipboard success/error feedback within shadcn components.
11. **Dependency Hygiene:** Follow `.agent/rules/dependency-maintenance.md` whenever dependencies, Wrangler, or generated Cloudflare types may be stale.
12. **Architecture Rules:** Follow `.agent/rules/architecture.md` and `.agent/rules/frontend-error-handling.md` for auth, modularization, and frontend error UX conventions.
13. **CI Ownership:** If GitHub Actions or Cloudflare PR deployment checks fail because of frozen lockfiles, outdated dependencies, or stale Wrangler types, fix them in the same turn by refreshing pnpm dependencies and re-running validation before handing work back.
14. **Import Path Aliases:** ALWAYS use tsconfig path aliases (`@/backend/*`, `@/backend/db/*`, `@/backend/ai/*`, etc.) for all backend imports. Never use relative imports (`../../foo`). Run `node scripts/migrate-imports.mjs` to convert existing relative imports. See `.agent/rules/import-paths.md` for details.
15. **Comprehensive Documentation:** Every backend TypeScript file must have a file-level JSDoc comment explaining its purpose, key features, and usage. Every exported function/class must have JSDoc with `@param`, `@returns`, `@throws`, and `@example` tags where applicable. See `.agent/rules/docstrings.md` for standards.
16. **Agent Meta-Maintenance:** Update `AGENTS.md` and `.agent/rules` files when you add/modify features that future agents should know about. Keep rules concise (<12,000 chars per file), avoid duplication, and resolve conflicts. See `.agent/rules/meta-maintenance.md` for guidelines.
17. **Production Deploys:** Deploys are **not** automatic. When a deploy is needed — especially after a merge to `main` — trigger the manual **Deploy** workflow (`.github/workflows/deploy.yml`) via GitHub Actions → Deploy → *Run workflow*, or `gh workflow run deploy.yml`. It runs `pnpm run deploy` (astro build → remote D1 migrations → `wrangler deploy`). Requires the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets. Nothing reaches production until this runs.
    - **Migrate-only:** if only the D1 schema changed and the Worker doesn't need redeploying, run the **Migrate D1** workflow (`.github/workflows/migrate.yml`, `gh workflow run migrate.yml`) — it applies remote migrations (`pnpm run migrate:remote`) without a full deploy.
    - **Inspecting failures:** to debug a failed run, `gh run list --workflow=deploy.yml` (or `ci.yml` / `migrate.yml`) to find the run id, then `gh run view <id> --log-failed` for just the failing step's log (full log: `gh run view <id> --log`). Fix, then re-trigger the workflow.
18. **Drive IDs, never URLs:** Google APIs key off the bare Drive **id**, not the url. Whenever a tool/utility accepts Drive ids as params — especially arrays — normalize every element first: use `extractGoogleId(input)` (single) or `parseDriveRefs(input: string | string[])` (array → `{ requested, id }[]`, deduped, blanks dropped) from `@/backend/google/core/ids`. This means a caller can pass a full Docs/Sheets/Drive **url** in any element and it still resolves. `sheet-export.ts` and `doc-export.ts` are the reference consumers. Never pass a raw url straight to a Google API call.
19. **Shared Data Toolkit:** This template ships an isomorphic data/array/object utility toolkit built on [Remeda](https://github.com/remeda/remeda). Reach for it before hand-rolling array/object plumbing. Import from `@/backend/utils/data` on the Worker side and `@/lib/data` on the frontend — both re-export the same isomorphic core at `@/shared/data-utils`. It exposes curated Remeda re-exports (`pipe`, `groupBy`, `unique`, `sortBy`, `pick`, `difference`, …), the full Remeda surface as `R`, and template helpers Remeda doesn't ship (`diffArrays`, `findWhere`, `toggleInArray`, `moveItem`, `keyBy`, `compact`, `ensureArray`, `deal`, `truncate`, `tryParseJson`). Add genuinely-shared helpers to the shared core (never duplicate per-surface). Live demo + docs at `/showcase/utilities`. See `.agent/rules/data-utilities.md`.

## Google Workspace MCP — Feature Map (this worker's real surface)

The `/mcp` surface is **code-mode-only** (Cloudflare search+execute pattern) to keep
the client tool-catalog under ~1k tokens. Only two tools are advertised; the full
`TOOLS` catalog stays internal.

- **Code-mode surface** (`mcp/server.ts` + `mcp/tools.ts#MCP_EXPOSED_TOOLS`): only
  `code_mode_search` (writes JS filtering `codemode.tools()` **inside the sandbox**,
  returns just the subset — never dumps the catalog) and `code_mode_run` (`await
  tools.<name>(args)`) are exposed; both carry an `outputSchema`. Sandbox in
  `mcp/code-mode.ts`. Add new tools to `TOOLS`; they're reachable in-sandbox, not
  advertised. Never remove the two from `MCP_EXPOSED_TOOLS`.
- **Central tool-runner** (`mcp/tool-runner.ts`): every tool call (server + code-mode)
  routes through `runTool` → **input sanitization** (`mcp/text-sanitize.ts`: mojibake
  + HTML-entity repair on content-key fields; `code` is deliberately NOT a content key)
  + **mandatory cross-account shadow search** for read-only tools in `SHADOW_TOOLS`.
- **Gmail compose** (`backend/gmail/`): `gmail_send`/`gmail_create_draft`/
  `gmail_create_reply_draft` accept `html`/`markdown` (sanitized + `juice`-inlined for
  Gmail — `compose.ts`) and a unified `attachments[]` (`{driveFileId}` | `{blob,filename,
  mimeType}` | `{driveFileId, as:"link"}`, `outgoing-attachments.ts`): cumulative encoded
  25 MiB budget, per-item Drive-link overflow (anyone-with-link) + per-attachment report.
  MIME in `mime.ts`; orchestration in `build-outgoing.ts`.
- **Scheduled email** (`backend/gmail/scheduled-email.ts`, table `scheduled_emails`):
  `schedule_email(send_at ISO-8601 UTC)` persists the full spec — Gmail has NO native
  scheduled-send API. Sweep runs on the `*/5` cron, claims each due row **atomically**
  (`scheduled/error → sending` conditional update → no double-send), sends via the
  gmail_send path, marks sent/error (retryable). `list_scheduled_emails` /
  `cancel_scheduled_email`. (Older draft+cron `gmail_schedule_send` → `scheduled_sends`,
  hourly cron, still present.)
- **Email preview + templates**: `email_preview_host` renders a draft and stores it
  (`email_previews`) for a sandboxed-iframe preview at `/gws/email-preview/<id>`.
  `email_templates_list/get/add` + built-in Gmail-safe templates (`backend/gmail/
  email-templates.ts`, table `email_templates`, seeded idempotently) + `/gws/email-templates`
  gallery.
- **Exports**: `sheets_export_json` (`google/sheet-export.ts`, table `sheet_export_jobs`)
  and `docs_export` (`google/doc-export.ts`, table `doc_export_jobs`) — array of id/urls
  (via `parseDriveRefs`), cross-account fallback, per-element error items, D1 tracking
  with `requestId` + content hash + source `modifiedTime`. Docs support tab scope
  (single-tab is markdown-only).
- **Accounts**: consumer `@gmail.com`/`@googlemail.com` are OAuth-only (never DWD) —
  `mcp/tokenProvider.ts#isConsumerGoogleAccount`; a missing token → actionable "log in"
  error, not a confusing DWD failure.
- **New frontend pages** (nav in `frontend/lib/config.ts`): `/gws/scheduled-sends`
  (cancel via shadcn AlertDialog), `/gws/email-templates` (marketplace + add),
  `/gws/email-preview/[id]` (sandboxed iframe).

## Template App Surface (reference implementation)

This template ships a real, running app so new projects inherit working patterns
(extend or delete the pieces you don't need). All of it is wired to D1 via Hono;
no mock data.

- **CRITICAL — Agents SDK islands must mount `client:only="react"`, never `client:load`.**
  Any React island using `useAgent`/`useAgentChat`/assistant-ui (the
  agents/PartySocket stack) is browser-only. `client:load` server-renders it
  first, and `useAgent`'s `useMemo` hits a null React dispatcher in the SSR
  worker → `Cannot read properties of null (reading 'useMemo')`, which fails the
  whole route. This was the original "chat not working" bug. Plain fetch-based
  islands (inbox, dashboard, tasks) may use `client:load`. Note: the `ai` binding
  is remote-only, so `wrangler.jsonc` sets `"ai": { "binding": "AI", "remote": true }`.
- **Pages** (Astro SSR + React islands, Monolith dark theme):
  - `/dashboard` — admin dashboard: radial-gauge KPIs + grouped-bar, interactive
    donut, and polished time-series recharts (all OKLCH palette via `ui/chart.tsx`)
    with search + range + status filters. Components under `components/dashboard/`.
  - `/projects`, `/tasks/board` (kanban), `/tasks` (table with **faceted
    multi-select chip filters** — `components/tasks/FacetFilter.tsx`), `/tasks/[id]`.
    Task/kanban/project cards open preview modals. Components under `components/tasks/`.
  - `/notes` — **PlateJS** rich-text editor (`components/notes/`); bodies persist as
    a versioned `{v,format:"plate",value}` JSON envelope in the team-notes `body`
    column, with legacy plain-text fallback.
  - `/inbox` — two-pane inbox backed by Cloudflare **Email Routing**: the Worker
    `email()` handler (`backend/email/inbound.ts`) stores inbound mail in the
    `email_messages` D1 table; UI under `components/inbox/`, API at `/api/inbox`.
  - `/chat` + `/showcase/{code-mode,browser-hitl,multi-agent,workflows,artifacts,
    mcp,thinking,skills,features}` — every Agents page mounts a LIVE interactive
    island (`components/showcase/`) wired to its Durable Object, not a static doc.
  - `/docs` (docs home, bound to `/api/docs/*`) + `/playbook` — documentation using
    the Shiki-backed `ui/code-block.tsx` (kibo-ui-style, base-ui, copy + tabs).
  - `/settings/{preferences,notifications,webhooks,activity,advanced}` (shared
    sub-nav) and `/notifications` (realtime). Components under `components/settings/`.
- **Schemas** live in `db/schemas/{projects,tasks,stats,settings,notifications}/`
  (drizzle-zod + `*_TABLE_DESCRIPTION`/`*_COLUMN_DESCRIPTIONS` for `/docs`).
- **APIs**: `/api/{projects,tasks,team-notes,settings,webhooks,activity,
  notifications,dashboard}` — CRUD + `?q=` search + filters + pagination. The
  dashboard exposes `/stats`, `/charts`, `/insights` (Workers AI via
  `ai/providers/ai-sdk.ts#getChatModel`).
- **Agents (Durable Objects, all bound + functional)**: `ChatBroker` (assistant-ui
  chat), `OrchestratorAgent` + `ResearcherAgent` + `CoderAgent` (real `getAgentByName`
  RPC delegation), `CodeModeAgent` (executes via `WORKER_LOADERS`), `WorkflowsAgent`
  (live progress via `setState`), `BrowserHitlAgent` (`MYBROWSER`; HITL approval gate),
  `McpAgent` (tool catalog + `callTool`), `ThinkingAgent` (streams reasoning then text),
  `SkillsAgent` (skills registry), `ArtifactAgent` (SQLite versioning), `NotificationsAgent`.
  Invoke via RPC (`getAgentByName`) or `@callable` + client `agent.call` — NEVER
  `stub.fetch`. Migrations are additive (v1→v3); never rewrite a shipped tag.
- **Realtime**: the `NotificationsAgent` Durable Object (`NOTIFICATIONS_AGENT`,
  instance `"global"`) syncs notification state over WebSocket. The client island
  is `components/NotificationsFeed.tsx` (`useAgent` + `onStateUpdate`); REST
  mutations proxy to it via `getAgentByName` (never `stub.fetch`).
- **Shared frontend helpers**: `lib/api.ts` (`apiGet`/`apiSend`/`ApiError`) and
  `lib/format.ts` (`relativeTime`/`shortDate`/`compactNumber`). Charts use the
  shadcn `ui/chart.tsx` wrapper + the OKLCH `--chart-1..5` palette in `global.css`.
- **Shared data toolkit** (isomorphic, Remeda-backed): one core at
  `shared/data-utils.ts`, re-exported by `lib/data.ts` (frontend, `@/lib/data`)
  and `backend/utils/data.ts` (`@/backend/utils/data`). Curated Remeda re-exports
  + full `R` namespace + template helpers (`diffArrays`, `findWhere`,
  `toggleInArray`, `moveItem`, `keyBy`, `compact`, `ensureArray`, `deal`,
  `truncate`, `tryParseJson`). Live demo: `/showcase/utilities`.
- **Seed demo data**: `POST /api/seed` (idempotent). Locally:
  `pnpm run migrate:local` then `curl -X POST http://localhost:8787/api/seed`.
- **SSR note**: `src/_worker.ts` exports `start(manifest)` + `createExports()`;
  page requests are rendered via `@astrojs/cloudflare/handler#handle`. Do NOT
  revert this to a bare `env.ASSETS.fetch()` fallback — that 404s every SSR page.
- **Auth**: signed session cookie only (no `users`/`sessions` table). Auth gates
  `/api/admin/*`; the feature APIs are intentionally open so the template runs
  out of the box. Tighten before production.
