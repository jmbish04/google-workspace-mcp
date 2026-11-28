# Frontends — ReUI is the default, everywhere

> Part of the workstation briefing. **`~/AGENTS.md` is the parent — read it first**;
> it carries the rules that apply everywhere (secrets, backups, how to write to
> Justin, when to flag). This file adds the rules for **any user interface**. If
> the UI ships on a Worker, also load `~/AGENTS-cloudflare-workers.md` — it owns
> the MCP, icon, and deploy rules this file defers to.

---

# The frontend standard — non-negotiable UI rules

**The standard is a repository: `jmbish04/core-template-cf-reui`.** It is pinned in
colby-ecosystem as the submodule `templates/frontend`, and **every new frontend repo
is created from it** — Colby Maestro provisions the new repo (Worker, CI/CD, synced
briefings). `~/.colby-ecosystem/frontend` on Justin's Mac is a symlink to a local
clone of it. When this file and the template disagree about *how*, read the template;
when they disagree about a *rule*, this file wins and the template gets fixed.

These rules are decided. Every one has been corrected by hand more than once:

1. **Every page sits in the ReUI app shell**, through the shared layout. A page
   that renders its own `<html>` is outside the shell.
2. **ReUI's default theme, dark by default, a light toggle in the header.** No
   custom palette, ever — never pick a brand colour. Measured failures: a teal
   console, and an orange one nobody asked for. Colour comes from the design
   tokens (`bg-primary`, `text-muted-foreground`, `var(--chart-1)`), never from a
   hex literal or a Tailwind palette utility like `text-gray-500`.
3. **A table is always the ReUI Data Grid, with grouping and the advanced filter
   builder.** Never a plain `<table>`, and never group headers bolted onto one.
4. **No pie or doughnut charts.** A horizontal bar, a stacked bar, or a number
   with a trend reads better.
5. **Bars are horizontal unless the x-axis is time.** (Recharts names it
   backwards: `layout="vertical"` *is* the horizontal bar.)
6. **Chart text, axes, gridlines and series are high-contrast on BOTH themes.**
   Use the tokens; never a library's default black — black on a dark chart is
   invisible, and it ships that way because the author only looked in one theme.
7. **A chart turns data into information** — a trend, a comparison, a rate, an
   anomaly, a forecast. A bar per status showing a count of rows is a table that
   went to art school; show what changed, or how fast, or what is unusual.
8. **The primitive layer is Base UI, not Radix, and the variant is `nova`.**
   `components.json` declares `"style": "base-nova"` — ReUI's own documented
   default. The style is `{library}-{variant}`; the library must be `base`
   (`radix-*` and `new-york-*` are Radix), and one variant across the fleet is
   what keeps two apps from looking like two products. See the section below —
   this is the one rule with a migration attached.
9. **Selects render labels through a shared wrapper, never a raw
   `<SelectValue>`.** Both libraries paint the wrong thing without one, and only
   on first paint. Same section.
10. **Dark is the DEFAULT, not the only theme — every surface renders in both.**
   A theme file puts the LIGHT values in `:root` and the dark ones in a `.dark`
   block, both defining `--background`, `--foreground` and `--card`; an HTML
   entry ships `class="dark"` only where something toggles the `dark` class on
   `documentElement` at runtime, so it paints dark before the first frame
   without pinning itself there. Measured on colby-chrome-ext before PR #13:
   eleven entries pinned to `class="dark"`, the dark values sitting in `:root`,
   and a trailing `.dark` block holding nine overrides — there was no light
   theme to switch to, and nothing said so.
11. **No font size below 12px (`text-xs`) in code we own.** Not
   `text-[11px]`, not `text-[0.6875rem]`, not a CSS `font-size` under the floor.
   212 arbitrary sizes were converted by hand across four PRs on three Chrome
   extensions. This is a HOUSE rule, not ReUI's — ReUI's own `kit/badge.tsx`
   ships `text-[0.6rem]` for `size="xs"` — so registry-installed source is
   exempt, because `shadcn add` reverts an edit to it. The hand-edited
   single-file primitives sitting flat in `components/ui/` and
   `components/reui/` are **ours** and are checked.

**`scripts/ui-guard.mjs` enforces the checkable subset — once a repo wires it
into `pnpm run build`.** Measured 2026-10-04: not one repo under
`/Volumes/Projects/workers` does, so today it only runs when somebody runs it.
A guard a briefing says is running, and which is not, is worse than no guard:
it reads as covered. Adding `node scripts/ui-guard.mjs &&` to a repo's `build`
is the step that makes any of this binding, and a repo with pre-existing
violations switches the failing rules off in `.ui-guard.json` with a
`migration` entry rather than leaving the guard unwired.

It is a deterministic scan, not a review: `no-table`, `no-pie-chart`,
`no-vertical-bar`, `no-raw-color`, `no-custom-palette` (a tinted `--primary` /
`--ring` in the theme CSS — where the teal actually lived), `dark-default`,
`app-shell`, `base-ui-style`, `no-radix`, `select-wrapper`, `light-theme`,
`font-size-floor`. `pull-agents` ships it to every
frontend repo with the briefings. A genuine exception is suppressed on that one
line, with a reason that a reviewer can disagree with:

```tsx
{/* ui-guard-allow no-vertical-bar: x-axis is a daily time series */}
```

A whole rule can be switched off in `.ui-guard.json`, and that needs a
`migration` entry naming what ends the exemption — a task id, a PR, a dated
decision. An opt-out nobody can attribute is the rule being deleted:

```json
{ "rules": { "base-ui-style": "off" },
  "migration": { "base-ui-style": "maestro task 5dc4f5e5b6b3" } }
```

Rules 6 and 7 are not checkable by a regex; they are yours to hold.

**The guard now says what it read, because a clean verdict about an unread tree is
the same defect as a rule that cannot fail.** Every run prints its resolved scan
roots and each one's file count — `scanned src/ (654) · no .ui-guard.json, roots
defaulted to src, web` — and two cases that used to pass in silence now exit **2**,
the usage-error code, alongside scanning nothing:

- a root **written down** in `include` that is not on disk. A defaulted root is not
  one: the default `["src", "web"]` is a union of the two layouts in this fleet, and
  no repo has both.
- a subtree that **declares itself a frontend** (its own `components.json`) and sits
  outside every scan root. Measured on cloudflare-api-mcp: `chrome-extension/` carries
  one, so a root run reported 23 violations in 70 files with zero of them under that
  path, while a run rooted at the subtree reported 8 in 19. Two disjoint trees, two
  plausible verdicts, and nothing in either output saying half the repo went unread.
  `"unscanned": ["chrome-extension"]` acknowledges one deliberately — a declaration
  with a name on it, which is the only kind of skip allowed, never an off-switch.

A file count alone could not close this: `70 files` reads as short only to someone who
already knows the repo's real count. **A guard against the empty case is not a guard
against the partial one.**

`components.json` is the right trigger for exit 2 and an incomplete detector. Measured
across this machine, 68 directories hold 3+ `.tsx` under `src/components`, sit outside
every scan root, and carry no `components.json` — one of them the same hole with the
declaration absent (`sgd-hbd-advisor`'s `frontend/`, 53 components, whose repo ROOT holds
the `components.json`), the rest component libraries that have none by design. So a
tsx-dense directory outside the roots is **printed and never fatal**: precision earns the
right to fail a build, a heuristic earns the right to be seen. The search depth is printed
with it and raisable with `uiTreeDepth`, since an unstated limit is this rule used against
itself — depth 3 reaches 398 of the 403 in-repo `components.json` files here.


**`light-theme` and `font-size-floor` do not share the other rules' exemption set,
and that is deliberate.** `components/ui/` and `components/reui/` hold both kinds of
file side by side: the single-file primitives flat in them are hand-edited and shared
verbatim across three extensions, while the multi-file blocks `shadcn add` writes into
their SUBdirectories (`reui/kit/`, `reui/data-grid/`, …) are not ours. A flat file can
still be theirs — `ui/questionnaire.tsx` imports `@shadcn/react/questionnaire` — so the
third test is the registry import in the file rather than its path. Anything else that
breaks the floor is flagged, and `ui-guard-allow font-size-floor: <why>` on the line is
the answer when it is genuinely one of theirs.

**Client-side navigation is an architecture decision, not a look-and-feel rule** —
before adding `<ClientRouter />`, read "Client-side navigation replaces the `<body>`
ELEMENT" below. The default swap destroys an iframe, a WebGL canvas or live media.

---

# Base UI is the primitive layer. Radix is the thing being migrated off.

**Decided 2026-10-04. Every new frontend uses Base UI primitives; `components.json`
says `"style": "base-nova"`.** Radix is not forbidden retroactively — it is what
most repos have — but it is no longer a default anyone picks on purpose, and
`ui-guard` says so.

## Why, with the measurements behind it

- **shadcn/ui made Base UI its default on 2026-07-03.** The style name is
  `{library}-{theme}`, and ReUI's agent skill states the rule: "the base library
  is the segment before the first `-`". Measured 2026-10-04, all four styles
  exist in both the shadcn and ReUI registries — `base-nova`, `base-vega`,
  `radix-nova`, `radix-vega` — and `/r/styles/base-nova/select.json` imports
  `@base-ui/react/select` while `radix-*` and shadcn's own `new-york-v4` import
  `radix-ui`. **`new-york-v4` does not exist in ReUI's registry at all**, which
  is why Pro installs 404 on a repo still pinned to it. Radix stays supported
  with no deprecation date, and the shadcn team still runs it — this is a choice
  about where new work goes, not a fire.

  The style is `{library}-{variant}`: the library picks the primitive API, the
  variant picks the look, and **every pairing is served**. ReUI's registry docs
  list eight variants and name one default:

  | variant | look |
  |---|---|
  | **`nova`** | reduced padding and margins — **the default, and what this ecosystem uses** |
  | `vega` | clean, neutral, familiar |
  | `maia` | rounded, generous spacing |
  | `lyra` | boxy and sharp, for mono fonts |
  | `mira` | compact interfaces |
  | `luma` | fluid, luminous, soft |
  | `sera` | editorial and typographic |
  | `rhea` | Luma, compact |

  So `base-nova` is the standard here because it is ReUI's own default, not
  because someone liked it. `ui-guard` checks only the library, because a
  variant is a look and a library is an API — but one variant per fleet is the
  convention, and `base-nova` is it. A `{style}` outside those lists is not
  served at all and the install fails as not found.
- **ReUI's blocks are already Base UI.** Its registry redirects
  `/r/new-york/{name}.json` to `/r/styles/base-nova/…`, and the ReUI components
  on disk import `@base-ui/react` directly — measured in colby-maestro: 15 of its
  `components/reui/` files already do, against 29 radix files all confined to
  `components/ui/`. Half the primitive layer migrated itself while nobody was
  looking.
- **The mismatch does not fail loudly, which is the real argument.** A Base UI
  block dropped onto Radix wrappers passes `render` to a trigger and
  `delay`/`closeDelay`/`timeout` to a tooltip provider. Radix does not know those
  props, so it **ignores them silently**: the trigger renders and does nothing.
  Measured 2026-10-03 on `@reui/solution-crm-7` — 33 type errors, every one
  inside the two primitives it pulled in, and the runtime behaviour would have
  shipped looking fine. A library that throws is a better neighbour than one that
  shrugs.
- **It gives the select trigger a declarative way to show a label** — but read the
  next section before believing it fixes anything on its own.

## The select trigger shows the wrong thing in BOTH libraries

This is the bug that started the conversation, and switching library does **not**
fix it. Measured both ways:

| Library | What the trigger paints | Why |
|---|---|---|
| Radix | nothing during SSR, then the label after hydration; the usual workaround `<SelectValue>{value}</SelectValue>` paints the raw id | it resolves the trigger's text from the *mounted* item, which does not exist server-side |
| Base UI | the **raw value** — a filter shows `__all__`, an assignee shows `asg-01H9X…` | `Select.Value` renders the value unless `Select.Root` is given `items`, or `Select.Value` is given a function child |

Both were hit in production here: `__all__` in every filter of
core-template-cfw-assets-astro-shadcn (Justin reported it as "select menus should
not be `_all_` on load"), and a raw assignee id in colby-maestro. Neither
type-errors, and both only show on **first paint**, before anyone interacts —
which is why they survive a whole build.

**So the rule is about the wrapper, not the library.** Never write a raw
`<Select>` + `<SelectValue>` on this stack. Go through one shared wrapper that
resolves the option's label, and give Base UI's `Select.Root` its `items` map so
the label renders server-side. Both halves of the ecosystem already have that
wrapper — colby-maestro's `components/shared/select-field.tsx`, and ReUI's own
`option-select.tsx` inside `solution-files-1`, which composes
`items={options}` with `<SelectValue>{selected?.label ?? value}</SelectValue>`.
Promote one of those rather than writing a third.

`ui-guard`'s `select-wrapper` rule is what stops a call site going round it. The
wrapper itself is the one legitimate `<SelectValue>`, and it says so on the line:

```tsx
{/* ui-guard-allow select-wrapper: this IS the shared wrapper */}
```

**Check the trigger's text on first paint, before interacting.** That is the only
moment either bug is visible.

## What this means for a repo

| Situation | Do |
|---|---|
| **New repo** | `"style": "base-nova"`. `core-template-cf-reui` is Base UI already but ships the `vega` variant, so align it to `nova` on the way past. |
| **Existing repo, no frontend work planned** | Leave it. Switch `base-ui-style` and `no-radix` off in `.ui-guard.json` with a `migration` entry naming the task. |
| **Existing repo you are already touching** | Migrate the primitives in their own PR, ahead of the feature work. Mixing the two makes a 2,000-line primitive diff look like part of a feature. |

## Migrating one repo — the shape of the work, measured on colby-maestro

Radix is confined to the wrappers; application code only ever sees them. In
colby-maestro: **29 files** import Radix and **all of them** are in
`web/components/ui/`, which is ~5,800 lines of generated wrapper. Application
code's exposure is the API surface, not the library:

| Thing to change | Count here | Character |
|---|---|---|
| Primitive wrappers | 29 files | re-install from `base-nova`, do not hand-port |
| `asChild` → `render` | 113 sites, 70 outside the wrappers | mechanical, one pass |
| `onOpenChange` signature | 172 sites to read | `(open)` becomes `(open, details)` |
| `<SelectValue>` call sites | 22 | most become an `items` map on the Root |
| Portal/Content → Portal/Positioner/Popup | every overlay | structural, per primitive |

So: **half a day to a day for a repo this size**, as one PR per primitive group
(overlays, menus, form controls), not one big bang. The number that makes it cheap
is 29-of-29 confinement — check that first in any repo before quoting an estimate,
because a repo that imports Radix from feature code is a different job.

Two installer side effects to expect, both already known: `shadcn add` writes
`import { cn } from "cn"` (this stack uses `@/lib/utils`), and the `base-nova`
registry output currently leaks an `@/app/(create)/components/icon-placeholder`
import that does not exist outside shadcn's own repo. Strip both.

**Ecosystem scale, so nobody promises a weekend:** 2,198 `.tsx` files across 148
directories under `/Volumes/Projects/workers` import Radix today (measured
2026-10-04, excluding `node_modules`). That is why this is a standard for new work
plus migrate-when-you-touch-it, and not a campaign.

---

# One frontend, three runtimes, zero porting

There is exactly **one** frontend stack, and it is deliberately portable so the
same UI runs on **any** backend without rewriting the frontend:

| | Backend runtime | Frontend |
|---|---|---|
| **Cloudflare Workers** | Hono + zod-openapi + Drizzle/D1 | Astro + React + **ReUI** |
| **Python FastAPI** | FastAPI + Pydantic + SQLite | Astro + React + **ReUI** (same `src/`) |
| **Python Flask** | Flask + SQLite | Astro + React + **ReUI** (same `src/`) |

The **frontend does not care** what serves `/api`. Only the backend half differs.
This is why "port this to a Worker" must be a backend change, never a frontend
rewrite — the shell, the blocks, the theme, and the components travel as-is.

Never start a UI from scratch; never re-decide the stack per project. A new repo
is **created from the template** (`jmbish04/core-template-cf-reui` — GitHub's
"Use this template", then Colby Maestro provisions it). For an existing repo, copy
what you need from the template — `components.json`, the theme CSS, the layouts —
rather than re-deriving it. Locally the template is at `~/.colby-ecosystem/frontend`
(a symlink to `/Volumes/Projects/workers/core-template-cf-reui`).

Stack, locked:
- **Astro + React islands** — SSR + only ship JS that must be interactive
- **ReUI** (`@reui`, Pro) — the design system and block library
- **shadcn/ui** primitives, on the **`base-nova`** style — which means **Base UI**
  underneath, not Radix. ReUI's blocks are built on Base UI; see "Base UI is the
  primitive layer" above.
- **Tailwind CSS v4** + `tw-animate-css`
- **mcpcn** (`@mcpcn`, public, no key) — MCP App UI blocks, for tool results a
  person reads. Both registries ship in the template's `components.json`; copy the
  `@mcpcn` entry into an existing one. See "MCP servers" in
  `~/AGENTS-cloudflare-workers.md`.
- **PNPM is the default package manager.** Use `pnpm` for installs, `pnpm dlx
  shadcn@latest add`, `pnpm run <script>`, `pnpm run test`. Never `npm`/`yarn`/`bun`.

---

# Client-side navigation replaces the `<body>` ELEMENT — list what must survive it first

**Astro's `<ClientRouter />` turns a nav into a client-side swap, and its default
swap calls `oldBody.replaceWith(newBody)`.** Reparenting an iframe reloads its
document. A WebGL canvas loses its context. Live `<video>` or `<audio>` loses its
state. So a page element that **is** doing the work — not merely showing it — is
destroyed by the navigation that was meant to preserve the page.

**The rule.** Before you add `<ClientRouter />`, list what in the page must keep its
NODE IDENTITY across a navigation: an iframe, live `<video>`/`<audio>`, a WebGL
canvas, anything holding a device, a socket or a media session. An empty list means
the default swap is fine. If anything is on it, keep `document.body` and swap its
children. Do not reach for `transition:persist`, and never claim it covers this
without naming the browser you measured.

**`transition:persist` is NOT the fix, and this is the half an agent gets wrong.**
Read on 2026-11-01 in `node_modules/astro/dist/transitions/swap-functions.js`, astro
7.3.8: `swapBodyElement` lifts every persisted element to `<html>` before the body
swap. It uses `moveBefore()` where available — Chrome 133+ — and falls back to
`docEl.appendChild(el)` everywhere else. `appendChild` is a move, so the iframe
reloads on Safari and Firefox. Astro's own comment in that function names the
detachment, for the canvas case. Read the file again before you repeat any of this,
and write down the version you read.

## Where it was hit

core-spotify, PR jmbish04/core-spotify#32, merged as 50fed19. The console plays music
in the tab: the Spotify Web Playback SDK makes the tab a Connect device by appending
a 0x0 iframe to `document.body`. `setupPlayerEnv(window)` hardcodes that parent, and
no SDK option moves it. The bug report was "start a playlist from the mixes page,
click another page, the music stops". Every full page load destroyed the iframe, so
the device disappeared and Spotify stopped the track.

## The fix that works on every browser

Keep `document.body` as the SAME NODE and replace only its children and attributes,
so the element never moves. Everything outside the body stays Astro's own
`swapFunctions` — `deselectScripts`, `swapRootAttributes`, `swapHeadElements`,
`saveFocus` — wired in an `astro:before-swap` handler that sets `event.swap`.

**Read `src/frontend/lib/nav-swap.ts` in core-spotify rather than reinventing it.**
It is 90 lines, 50 of them code. The predicate for which child survives sits in
`src/shared/nav-swap.ts`, so a test can pin it without a DOM.

Two details that cost time:

1. **`swapRootAttributes` copies the incoming root attributes wholesale, and the
   server HTML always ships `class="dark"`.** A light-theme choice is therefore
   undone on every navigation, unless the swap re-reads the stored choice
   afterwards. That is the same read as the inline theme script in the layout.
2. **`body.append(...nodeList)` does not typecheck (TS2556).** Move the children
   through a `DocumentFragment` instead. It is also one insertion rather than one
   per child, which is what `replaceWith` was.

**The template does not ship this, deliberately.** `jmbish04/core-template-cf-reui`
renders no `<ClientRouter />` and holds nothing that needs node identity — grepped
2026-11-01. A repo adds the swap when its own list above is not empty.

## How to prove it in a repo

"It navigated and it looked fine" is not evidence. Measure both directions, the way
core-spotify did, against the built Worker in a browser:

1. Hold a reference to the element, and attach a `load` listener to it.
2. Navigate, then assert ZERO load events and that `document.body` is the identical node.
3. Plant a body-replacing swap, navigate again, and confirm the element leaves the document.

Step 3 is the control, and it is not optional. Without it the test stays green when
the swap is deleted — see "a test that cannot fail is not a test" in `~/AGENTS.md`.

---

# ReUI is the default design system — and it is non-negotiable

**The style is ALWAYS the default ReUI theme with dark enabled. Never deviate
from it.** No custom palettes, no restyled blocks, no light-mode override, no
hand-rolled "brand" theme. ReUI's default theme *is* the brand.

- `<html lang="en" class="dark">` — dark is the default and the only default.
- The header ships the theme toggle, but the app **starts dark** and stays dark
  unless a user flips it in the shell. Never force light, never add a light-first
  layout.
- **Do not restyle what ReUI already provides.** The ReUI workflow is
  *reuse-first*: wire real data and the existing theme into a block. Adapt by
  *reuse*, never by hand-rolling or recoloring a component to "fit" the project.
- **Surface `frame`** — locked project-wide. Pass `surface: "frame"` on **every**
  ReUI MCP search so blocks stay visually consistent. Never mix `frame` and
  `card` blocks on one screen.

**Better Design and ReUI are two jobs, not two options.** `~/.claude/CLAUDE.md`
carries a tool-injected block telling agents to reach for the Better Design MCP on
any UI work. That stands — with the boundary stated here:

| Better Design MCP owns | ReUI + the design system own |
|---|---|
| product discovery: what this screen is for, who reads it, what decision it supports | the component vocabulary — every control, grid, chart and shell |
| the user journey and information architecture: what belongs on a page, in what order, what is a separate route | tokens, theme, density, radius, spacing |
| turning data into *information*: is this intake or display, what does the reader do next | how a value is rendered (see "Data to interface" in the design system) |
| UX review after the fact (`get-review-rules`, `get-ux-principle`) | which block implements the thing Better Design described |

**`find-design-system` and `create-design-system` never run.** The design system
exists, it is bought and paid for, and a second one is the drift this whole file
prevents. When Better Design proposes a layout, translate it into ReUI blocks —
name them from the catalogue and install them; do not let it generate a kit, a
palette or a component set.

Feed it the vocabulary. A journey described against "a dashboard" comes back
generic; a journey described against *the ReUI catalogue* — the 8 dashboards, 15
stats panels, 30 chart cards, 37 Data Grid blocks — comes back as something
installable, and those blocks are themselves well-designed user journeys worth
borrowing from.

**Why this boundary is drawn so hard.** The failures that made ReUI necessary were
never "the agent had no design opinion" — they were: currency rendered as
`8232563.021`, storage in bytes because D1 stored bytes, a stat card overflowing
with an eleven-digit number, "grouping" hand-rolled onto a plain table when the
Data Grid ships it, a filter strip of badges scrolling off an iPhone instead of the
Filters builder that was asked for, tags collected as a comma-separated string
against a schema that had a `tags` table, black axis labels on a dark chart, and
two screens in one app at different densities. Every one of those is a
*component-and-data* failure, which is the ReUI half. **The design system's "Data
to interface" section is the fix, and it is mandatory reading before building any
screen backed by a table.**

**Two more layers sit under those two — code quality and the phone.** Neither one
picks a component or a colour; both carry a "house overrides" block at the top
that maps them onto this stack, so read that block before the upstream text.

| Skill | Owns | Does not own |
|---|---|---|
| `react-best-practices` | how island code is written: no request waterfalls, small bundles (import by path, `client:visible`/`client:idle` before `client:load`), no wasted re-renders | components, layout, theme — and its Next.js/RSC rules, which are translated to Astro + Worker in its overrides |
| `mobile-design` | the phone surface's reasoning: thumb zone, 44pt / 48dp targets, loading / error-with-retry / offline on every screen; and the whole job for a native RN / Flutter / SwiftUI app | palette, type and shell on web — ReUI tokens win; and its "ask the platform first" step, which does not apply to web work |
| `kill-ai-slop` | the machine-default look and copy: indigo→violet gradients, glows, emoji, decorative pills, "not just X — it's Y". 35 tells, a read-only scanner (`node scripts/scan.mjs <root>`), triage, then fix | ReUI components and blocks (always `--exclude=.claude/,components/ui,components/reui,components/blocks`), status `Badge`s, the dark theme and the theme's fonts — its overrides say which tells yield |

The order on any UI change: Better Design (what and why) → ReUI (which blocks) →
`react-best-practices` (the island code) → `mobile-design` + `mobile-native` (the
phone) → review (`review-animations`, `better-interface`,
`design:accessibility-review`, `kill-ai-slop`) → `scripts/ui-guard.mjs`.

**The app shell is a ReUI block — which one is a decision you make per app.**
There is no default shell, and there never should be: pick the shell that fits
what this app actually is, from the app-shell block page. What is fixed is that
it *comes from ReUI*. A hand-rolled shell is the single most common way an agent
ends up rebuilding what ReUI already ships, and then asking about ReUI later as
though the shell were a separate question. It is not — the shell is the first
ReUI decision, not an exception to it.

- Read `https://reui.io/blocks/application/app-shell` **before** choosing. Every
  shell there has a live preview, its constituent components, and a one-line
  description in the page's end-of-page summary. Read those descriptions; that is
  what they are for.
- Match the topology to the product: an icon rail with per-section secondary nav
  suits a broad app with many sections; a three-region resizable layout suits an
  ops workbench; an inset or floating shell suits a focused single-purpose tool.
- **Strip what the app has no use for**, whichever shell you picked — the
  workspace/project selector and the user avatar menu are the usual two (these
  apps have no users; the theme toggle moves to the header).

---

# The design system — read it before the first component

ReUI is the registry. **"ReUI Astro React" is the design system built on top of
it**, and it is where the decisions that are NOT in the ReUI docs live: the token
set in both themes, the shell contract, the per-page responsive strategy, the
documentation and Mermaid rules, the chart doctrine, and the `AGENTS.md` a repo
gets at its root.

**https://claude.ai/artifact/74kf88M44NMA7Xh769vJge**

Read it with the Artifact tool — `action: "read"`, `path: "project/README.md"`
first, which indexes everything else. Never web-fetch it. Never re-derive what it
already decided.

What it carries, and when you need it:

| Section | Read it when |
|---|---|
| `project/tokens.json` | any colour, spacing, radius or type decision — 39 colours in light + dark, shadcn base plus ReUI's nine extended tokens, each with a usage note |
| Setting up ReUI | a new repo: React 19, Tailwind v4, `components.json`, token install order |
| The registry, and the licence key | the tokens-CLI and Secret-Store paths (the same two this file describes) |
| Surface mode and consistency | the drift audit to run after every block install |
| Responsive strategy | **every page** — the per-platform plan that replaces the default stack |
| Charts | before any visualization: no pies, horizontal bars, the three dashboard layers |
| Pro blocks · the block catalogue · AI, agent and Data Grid blocks | picking blocks — all 543 by install name, with what each family actually solves |
| Agent instructions | the `AGENTS.md` template that goes at a repo root |
| The bundle (`window.ReUIAstro`) | `AppShell`, `MetricStrip`, `DataGridFrame`, `Surface`, `Alert`, `Badge`, `Button`, `StatTile`, `StatusDot` — the connective tissue between installed blocks |

Where it and this file agree, they agree on purpose: surface `frame`, dark
default, pnpm, the key from the tokens CLI or the Secret Store. **Where a project
question is not answered here, the design system answers it** — and if the two
ever disagree, this file wins and the design system gets corrected in the same
session.

---

# Adopting a repo — new, and not-yet-adopted

## A new repo: configure it correctly, first commit

1. Create it from `jmbish04/core-template-cf-reui` — stack, `components.json`,
   both registries, the theme, the shell layout, and `scripts/ui-guard.mjs` already
   wired into the build. Colby Maestro provisions the rest.
2. Compile the design system's tokens into the project's `tokens.css` / theme
   layer **before installing any component**. Installing first means retokening
   every file by hand afterwards.
3. Drop the design system's `AGENTS.md` at the repo root (its "Agent instructions"
   section is the template) and fill in the project-specific lines.
4. Pick the app shell from the block catalogue; strip what the app has no use for.
5. Wire `/docs`, `/openapi.json`, `/scalar`, `/swagger` into the nav — these are
   already in "What every app ships"; the shell contract is what enforces them.
   `/docs` is a Nimbus site (`pnpm exec nimbus-docs init`, `base: "/docs"`).

## An existing repo that has not adopted it — ask once, then respect the answer

A repo qualifies as **not yet adopted** when any of these is true: no `@reui`
entry in `components.json`; hand-rolled `<table>`s where a Data Grid belongs; raw
hex or Tailwind palette utilities (`text-gray-500`, `bg-slate-800`) in components;
no root `AGENTS.md`; a light-first or custom theme.

**On the first session where you touch that repo's frontend, ask Justin — once:**

> This repo hasn't adopted the ReUI design system. Want me to run a full frontend
> audit and build a retrofit plan (epics + tasks recorded on colby-maestro)?
> 1. **Yes — audit and plan** (recommended): I inventory every page, component
>    and token, then file the plan. Nothing is changed until you approve it.
> 2. **No** — I record the decision in the repo's `AGENTS.md` so no agent asks
>    again; ask me explicitly if you want it later.
> 3. **Not now, ask me next time** — I leave it open.
>
> If you say nothing, I continue the task you asked for and leave the repo as it is.

Ask as plain text in the conversation.

### If YES — the audit, then the plan, both recorded

**Audit** (read-only; no edits during this phase):

| Dimension | What you record |
|---|---|
| Inventory | every route/page, every component file, which are hand-rolled vs installed |
| Tokens | every raw hex, `rgb()`, and Tailwind palette utility, by file and line |
| Components | hand-rolled tables, selects, modals, steppers, date pickers — each mapped to the ReUI component or block that replaces it |
| Shell | what the current nav is, whether `/docs`, `/openapi.json`, `/scalar`, `/swagger` exist and are linked |
| Responsive | which pages have a real per-platform strategy and which just stack |
| Charts | every pie and vertical bar (both are replacements under the standing preferences) |
| Theme | whether dark is the default and whether both themes actually render |
| Accessibility | suppressed focus rings, colour-only status, unlabelled controls |

**Plan** — one epic per dimension above that has findings, tasks under it sized to
one page or one component family each, ordered so tokens land first (everything
else depends on them), then the shell, then page-by-page. Each task names the
block or component that replaces what is there, from the design system's catalogue.

**Record it on colby-maestro** — the plan lives there, not in a chat transcript.
Use the session's `mcp__colby-maestro__*` tools (pre-approved; no need to ask):
the repo slug as `project_key`, an epic as a parent task, each retrofit item as a
child, `task_type`, `priority`, `severity` and `estimate` on every one, tagged `reui,retrofit`. The audit
findings go in the epic's worklog so the evidence travels with the plan. If the
MCP is not in this session, fall back to the Worker's REST API — both shapes are
in `~/AGENTS-maestro.md`. Then tell Justin what you filed, and stop: the retrofit
executes only when he says so.

### If NO — record it so nobody asks again

Write the decision into the repo's root `AGENTS.md` (create it if absent) so every
future session reads it instead of re-asking:

```markdown
## ReUI design system

**Retrofit: declined by Justin on <YYYY-MM-DD>.** This repo's frontend predates the
ReUI Astro React design system (https://claude.ai/artifact/74kf88M44NMA7Xh769vJge)
and is not being migrated. Do not offer an audit or a retrofit plan again — Justin
will ask explicitly if he wants one.

New code added to this repo still follows the design system where it does not
require touching existing screens: tokens over raw colour, ReUI components over
hand-rolled ones, no pie charts, horizontal bars.
```

That block is the whole point of asking once: a declined offer that keeps
returning every session is the same as not having asked. "Not now" gets nothing
written — that is what leaves it open.

---

# The ReUI license key — one name, two places

`REUI_LICENSE_KEY` (Pro) is the single credential that authenticates ReUI. It
lives in the tokens CLI locally **and** in the Cloudflare Secret Store under the
**same name** — resolve the name once, use it on both sides.

## Local: tokens CLI

Resolve at install time — never paste the key into a repo file, never a `.env`,
never hardcode it:

```bash
tokens find REUI_LICENSE_KEY                       # verify it exists (names only)
export REUI_LICENSE_KEY="$(tokens show REUI_LICENSE_KEY --value-only)"
```

`components.json` authenticates the `@reui` registry with it. **Two separate
things make a Pro block 401, and fixing only one leaves you stuck.**

**1. No header.** `shadcn registry add @reui` writes the bare URL with no
Authorization header.

**2. The redirect — and this is the one that looks like a bad licence key.**
`https://reui.io/r/{style}/{name}.json` answers **307** to
`/r/styles/{style}/{name}.json?v=<deployment>`, and **the shadcn CLI drops the
Authorization header across that redirect**. Every install then fails with *"You
are not authorized to access the item"* while `curl -L` with the same key returns
200. The fix is to write the **already-redirected, versioned** URL:

```jsonc
{
  "registries": {
    "@reui": {
      "url": "https://reui.io/r/styles/{style}/{name}.json?v=dpl_...",
      "headers": { "Authorization": "Bearer ${REUI_LICENSE_KEY}" }
    }
  }
}
```

Do not write that `v` by hand. **`reui-registry`** (`~/.local/bin/reui-registry`)
resolves the current deployment id off the redirect and writes it for you. The
`shadcn()` wrapper in `.zshrc` runs it after `init`/`create`; the agent
SessionStart hook runs it **read-only** (`--check --quiet`) and only tells you
when a repo needs pinning — it never rewrites `components.json` behind you:

```bash
reui-registry .            # pin this repo
reui-registry . --check    # report only; exit 1 if it needs patching
```

`v` is ReUI's deployment id, so it changes whenever they ship. **When an install
starts 401ing again, ReUI has redeployed — re-run `reui-registry`.** If it cannot
reach reui.io it leaves an existing pin alone rather than reverting it, and says
`UNPINNED` when it had to fall back to the bare URL.

For scripts, unit tests, and `.mjs` tooling, use the first-party SDK instead of
shelling out to `tokens show`:

```bash
tokens agent-onboarding --scaffold-mjs    scripts/tokens.mjs
tokens agent-onboarding --scaffold-python utils/tokens.py
```

```js
import { requireSecret } from "./tokens.mjs";
const reuiKey = requireSecret("REUI_LICENSE_KEY");
```

**Use the Pro MCP server.** `mcp__reui__*` is the licensed one;
`mcp__claude_ai_reui__*` is the free tier and will not see Pro blocks. If a
session has both, prefer `mcp__reui__*`.

The ReUI MCP reads the key from `.env.local` for premium installs (blocks need
Pro or Ultimate; icons and templates need Ultimate). Free items — the 22
components and all `c-*` examples — install with **no license at all**.

## Cloudflare Worker: Secret Store binding

The frontend of a Worker authenticates with ReUI via a **Secret Store binding**
of the same name. Declare it in `wrangler.jsonc`:

```jsonc
{
  "secrets_store_secrets": [
    {
      "binding": "REUI_LICENSE_KEY",
      "store_id": "8c42fa70938644e0a8a109744467375f",
      "secret_name": "REUI_LICENSE_KEY"
    }
  ]
}
```

A Secret Store binding is an **object**, not a string — read it through the
scaffolded helper, never `=== env.REUI_LICENSE_KEY`:

```bash
tokens agent-onboarding --scaffold-worker src/backend/utils/secrets.ts
wrangler types
```

```typescript
import { requireSecret, getSecret } from "@/backend/utils/secrets";

// In a route / handler that needs to auth a ReUI call on the backend:
const reuiKey = await requireSecret(env, "REUI_LICENSE_KEY"); // throws if unresolvable
```

> **The trap (same as `WORKER_API_KEY`):** `apiKey === env.REUI_LICENSE_KEY` is
> `string === object`, so it is **always false**, and
> `sha256Hex(env.REUI_LICENSE_KEY)` hashes `"[object Object]"`. Go through
> `utils/secrets.ts`, which also falls back to a plain env var so the same call
> site works in `wrangler dev` and in production.

Live examples of the binding-in-practice live across `/Volumes/Projects/workers`
— `colby-maestro/wrangler.jsonc` binds `REUI_LICENSE_KEY` from the Secret Store,
and `core-bridge` ships ReUI blocks (`Frame`, `FramePanel`, `Badge`, `DataGrid`)
from `@/components/reui/` on a single Worker.

---

# Consult the ReUI MCP — always, and before writing code

The **ReUI MCP** (`mcp__reui__*`) is the consultation layer for every ReUI
decision. Do not guess a component API, do not invent a block name, do not
hand-roll a prop from memory. The workflow is:

```
search ──▶ get_component (read the real API BEFORE writing props)
     ──▶ get_install_command (exact pnpm/shadcn CLI command)
     ──▶ adapt by REUSE (wire real data + theme; never restyle)
     ──▶ validate_usage (catch invented props/names before code)
     ──▶ get_audit_checklist (production-quality checks)
```

The tools, in the order they are used:

| Tool | When |
|---|---|
| `search` | Every ReUI/shadcn request. Pass `surface: "frame"`. Returns ranked items with `installCommand`, `docsUrl`, live `previewUrl`, `componentsUsed`, `dependencies`, `free`/`requiredPlan`, and a score. **Share `previewUrl` with the user so they can SEE a block before it is installed.** |
| `get_component` | Read one or more components' inline API (props + usage). Pass an **array** of names to read several APIs in one call. Never write props before this. |
| `get_examples` | Copy a free `c-*` worked example's exact composition — the fastest correct path. |
| `get_install_command` | The exact `shadcn` CLI command for the project's package manager (**pnpm**). Validates the item exists (did-you-mean on a wrong name). |
| `compose_page` | **Before building any full page** — returns an ordered plan of page sections, each filled with the best-matching premium blocks (top pick + alternates). Pass `surface: "frame"`. |
| `validate_usage` | Deterministically check planned component names + props against the indexed docs **before** writing code. A `notDocumented` prop is a strong signal you are about to invent an API. |
| `get_audit_checklist` | ReUI-specific production-quality checks after installing/adapting an item. |
| `list_block_categories` / `list_components` / `get_block` | Inventory: block categories with counts, the 22 free components, one block's full metadata. |
| `get_project_context` | The `components.json` registry config + license-key setup so `shadcn add @reui/...` works. |

---

# Design every page out of blocks — not just the shell

**The app shell is only the nav and the structure.** It gives you the rail, the
secondary nav, the toolbar — and nothing about what goes *inside* a page. Every
page is its own design problem, solved the same way: **go shopping across the
block catalog, then compose.**

- **All blocks:** `https://reui.io/blocks` — split by surface (application,
  data-grid, solutions, ecommerce, marketing).
- **Every block page walks its samples one at a time and then summarises all of
  them at the bottom, one line each.** Read that summary. It is the fastest way
  to see the whole shelf, and it is why "I looked at the first preview" is not
  looking.

Counts and contents drift — re-read the pages, never trust a number written here:

| Group | What it covers |
|---|---|
| **Application** | app shell, dashboard, settings, sheet, list, profile, navbar, charts, chat, steps |
| **Data Grid** | admin tables, kanban, **grouping**, filtering, sorting, pagination |
| **Solutions** | analytics, CRM, AI ops, event calendar, gantt, ops workbenches |
| **eCommerce** | checkout, billing, product card/detail/grid |
| **Marketing** | heroes, pricing, onboarding, feature pages |

## The per-page workflow

For **each page the app needs**, in order:

1. **Start at the page-shaped block.** A dashboard page starts at the dashboard
   blocks — they are near-complete pages in themselves, with metrics, charts and
   tables already laid out.
2. **Then check every part of it against its own specialist page.** A dashboard
   block's charts are *that block's* charts; they are rarely the right charts for
   this app. Go to the **charts** blocks and pick the visualization that actually
   fits the data. Its table is *that block's* table; go to **Data Grid** and take
   a table that does grouping and filtering properly.
3. **Look across categories, not just the obvious one.** The best graph for a
   dashboard is often in **analytics**, **CRM**, or **AI ops** — those pages carry
   some of the strongest visualizations in the library, and nothing says a chart
   found under "CRM" cannot serve an ops dashboard.
4. **Retrofit and compose.** Take the layout from one, the chart from another,
   the table from a third; wire real data; keep the theme and the surface. The
   result is a block unique to this app, assembled entirely from ReUI parts.
5. **Name what you took** — which blocks, which parts, why — in the worklog or
   PR, so the next agent can follow the seams instead of re-deriving them.

**This is reuse, not deviation.** A page assembled from three blocks' components
is ReUI. A page hand-rolled because no single block matched is not — and "no
block fits" is a claim that needs the same evidence as any other: show what you
searched across which categories before writing anything custom.

## Justin's standing visualization preferences

These are decided. Do not re-litigate them per project, and do not let a block's
stock example override them:

Rules 3–7 of "The frontend standard" at the top of this file: no pies, horizontal
bars unless the x-axis is time (horizontal survives long category labels, which is
what most of these charts carry), the Data Grid with grouping for every table,
high contrast on both themes, information rather than counts. They hold even when a
block's stock example breaks them — and `ui-guard` will say so.

When a block's stock chart violates one of these, that is expected — retrofit it.
That is what the charts page is for.

## Mermaid renders through Pele, not mermaid.js

**Every diagram on every frontend goes through [Pele](https://pele.run/)
(`npm install pele`, MIT, zero dependencies).** Keep authoring in Mermaid syntax;
change what turns that syntax into SVG. `mermaid.js` is not to be added to a new
frontend, and the two repos still carrying it are to be migrated.

```ts
import { render } from "pele";
const { svg } = render(source, { maxWidth: 720 });
```

`render()` is **synchronous**, so a diagram can be drawn at build time and the page
ships SVG with no client JavaScript at all. That is the point, and it is what
neither repo can do today.

### Why, with the numbers behind it

|  | Pele | mermaid.js |
|---|---|---|
| Bundle, gzip | 267 kB | 1.6 MB |
| Render time | 0.05–0.3 ms | 6–82 ms |
| Direct dependencies | 0 | 23 |
| Narrow screens | adapts the layout | scales the diagram down |
| Theming | CSS variables, no re-render | `themeVariables` config, re-render |

Measured on this machine 2026-11-20, against `colby-maestro.hacolby.workers.dev`:
a docs page's diagram took **6 seconds** to appear from a cold load, and its own
source comment names the cause — a static `import mermaid` pulled mermaid plus
elk (~1.5 MB), cytoscape, katex and dagre into the entry chunk, **~2.8 MB of
JavaScript parsed before the page became interactive**. `core-guardian` carries
the same library behind a `client:visible` island.

So the report that "the charts never render" is half right, and the half that is
wrong matters: they do render, late. A reader who scrolls past in under six
seconds sees nothing, and a reader whose network is slower sees the raw
`flowchart TB …` source until the library lands.

### What this does NOT fix

**Reading the diagram source back out of the DOM is still broken, and Pele does
not change that.** A ```` ```mermaid ```` fence goes to Shiki, which emits one
`<span>` per line with no newline characters, so `el.textContent` returns the
whole graph on one line and no parser can read it. Pele's own CDN snippet reads
`el.textContent`, so it inherits the same defect.

Two consequences, both load-bearing:

1. Where a repo renders in the browser, **keep the `<pre class="mermaid">`
   convention** that bypasses Shiki. It is not a drop-in swap. `mermaid.run()`
   takes a node list and reads each diagram's source from the DOM; `mount()` is
   a named import taking `(element, source, options)`, so the page has to hand
   it the source. Pass it from wherever the page already holds it — the markdown
   string, a `data-` attribute, a JSON island — and never from `el.textContent`,
   for the reason above:

   ```ts
   import { mount } from "pele";
   for (const el of document.querySelectorAll<HTMLElement>("pre.mermaid")) {
     mount(el, el.dataset.source!, { maxWidth: el.clientWidth });
   }
   ```
2. Better: render at **build time** from the markdown source string, through a
   rehype plugin or the page's own frontmatter, and the fence works, the
   workaround goes away, and the page ships no diagram JavaScript.

### Theming

Pele takes CSS variables, so the hand-tuned `themeVariables` object each repo
currently carries is deleted, not ported. Set the seven variables from the app's
own design tokens, and a theme toggle needs no re-render:

```css
.pele {
  --pele-bg: var(--background);
  --pele-fg: var(--foreground);
  --pele-muted: var(--muted-foreground);
  --pele-line: var(--border);
  --pele-surface: var(--card);
  --pele-surface-alt: var(--muted);
  --pele-border: var(--border);
}
```

### Options worth knowing before you guess one

- `idPrefix` — declared in `RenderOptions` and **inert in 1.13.0**. Measured
  across the 33 diagram types that ship: 25 render, 1 of those (sankey) honours
  it, and the other 24 emit a byte-identical SVG with it and without it. The
  hazard it reads like a fix for is real — 23 of those 25 emit ids that collide
  between two renders (`id="A"`, `id="L_A_B_0"`) — so give each diagram its own
  root element and scope any CSS and script to that root. Do not pass this and
  assume two diagrams on one page are safe.
- `maxWidth` — pass the container's width; Pele wraps labels and re-spaces rather
  than shrinking the text. This replaces `flowchart: { useMaxWidth: false }` plus a
  horizontal scroll container.
- `autoDirection` (on by default, `directionBreakpoint` 640 px) — a supported
  diagram turns vertical on a phone instead of becoming unreadable.
- `responsive: false` — a fixed pixel size when you want one.
- Entry points: `pele` is everything; `pele/core` + `register()` ships only the
  diagram types a repo actually uses; `pele/lazy` gives `renderAsync()`.

Pin the exact version (`npm info pele version`), never a range: a renderer that
changes under a docs page changes every diagram on it at once.

### Errors

`render()` throws `PeleError`, and **the message contains the diagram source**.
Write it with `textContent`, never `innerHTML`:

```ts
import { render, PeleError } from "pele";

try {
  container.innerHTML = render(source).svg;
} catch (error) {
  if (!(error instanceof PeleError)) throw error;
  container.textContent = error.message;
}
```

For a diagram whose source did not come from this repo, read
<https://pele.run/security> first: `linkSchemes`, `imageSchemes`, `links`,
`images` and `icons` are the knobs, and the defaults already refuse a
`javascript:` href.

## The obvious surfaces, as a starting point

Most apps need some of these. **Start** here, then keep shopping — the list is
where the search begins, not where it ends:

**app shell** (nav + structure only) · **dashboard** · **charts** · **data grid /
tables with grouping** · **chat** · **AI ops** · **agent ops** · **analytics** ·
**CRM** · **settings** · **steps**

Never assume a block exists and never invent one: verify against the page or the
ReUI MCP before installing.

---

# Lessons learned: file to colby-maestro, and consult them back

ReUI implementation knowledge compounds. **Every change the user requests to how
ReUI is implemented is a lesson learned** — file it, then consult past lessons the
next time you pick blocks.

## File it — every time Justin asks for a change to a ReUI page

**Any time Justin comes back and asks you to modify something you built out of
ReUI, that request is a lesson learned.** A different chart, a different block, a
layout that should have been grouped, a shell that buried the thing he actually
needed — he is telling you what this file should have said. File it, so the next
agent gets it as a rule instead of costing him the same correction again.

That makes it **two proposals at the end of such a session**, not one:

| Proposal | Carries |
|---|---|
| the ordinary `agents-md` lesson | anything about how agents work — traps, tooling, process |
| **a `reui` frontend lesson** | the block/chart/layout decision he corrected, so it becomes a rule in *this* file |

Both go to colby-maestro (the control plane; full rules in
`~/AGENTS-maestro.md`):

```js
async () => codemode.request({ method: "POST", path: "/api/issues", body: {
  project_key: "colby-ecosystem", repo_path: "/Users/126colby/.colby-ecosystem",
  title: "PROPOSAL: ReUI ops workbench wants a three-region resizable shell, not a mini rail",
  description: "The mini-rail shell buried the queue; the resizable three-region shell put queue, detail and log side by side. Hit on core-tail.",
  status: "backlog", priority: "p2", severity: "s3", task_type: "chore",   // rate both yourself
  tags: ["proposal", "agents-md", "reui"],
  plan_id: "95b7c398ea52", section_ids: ["6268f2184107"],
  estimate: { total_tokens: N, confidence: "medium" },   // N: your own figure, a whole number > 0
}})
```

It lands for review under the `colby-ecosystem` project. The **`reui`** tag is how the
frontend ones are found as a set.

The lesson names the change, why the original choice was wrong, and where it was
hit — never "we should be careful with ReUI". A correction Justin has made twice
is a rule this file is missing; say so in the proposal.

## Consult them back — before picking blocks

**When you consult the blocks pages and the ReUI MCP, also consult the accumulated
frontend ReUI lessons learned** (the `reui`-tagged proposals/lessons in
colby-maestro). A past session already paid for the mistake you are about to
repeat. Check the queue before you select a block, the same way you check before
filing (see `~/AGENTS-maestro.md` for the queue query).

---

# What every app ships

Carried forward — these are still non-negotiable on every UI:

- **Passcode** in front of it (see "Authentication" below)
- **Landing page** (`/`) — what this is, links to everything
- **`/health`** — real checks against live dependencies, polled. Never `{ok:true}`
- **`/openapi.json` + `/swagger` + `/scalar`** — generated, linked from the header.
  `/openapi.json` is built at request time from the Hono routes with
  `@hono/zod-openapi` and Zod. `/scalar` and `/swagger` render that live document.
  Never a hand-written or committed spec file.
- **`/docs`** overview + `/docs/{page}` subpages — **built with
  [Nimbus](https://github.com/cloudflare/nimbus), always** (see below)

### `/docs` is a Nimbus site. No exceptions. (Justin, 2026-10-21)

Technical docs under `/docs` are built with `cloudflare/nimbus`. Do not hand-roll
docs pages in the app's own Astro routes, and do not use Starlight, Docusaurus,
VitePress or MkDocs.

- **New docs:** `npx @cloudflare/create-nimbus-docs@latest`. **An existing Astro
  app:** `pnpm exec nimbus-docs init` adopts it in place.
- **Serve under `/docs`:** set Astro `base: "/docs"`. With the Cloudflare adapter,
  Nimbus places the agent discovery files for you. The app's other routes stay where
  they are.
- **Mermaid** (required on data, schema and integration pages, see the repo-root
  `AGENTS.md`) and **API reference** pages come from the Nimbus registry:
  `pnpm dlx @cloudflare/nimbus-docs add mermaid` / `add api-reference`. Point the API
  reference at the app's live `/openapi.json`, not a copy.
- **Pin the version.** Nimbus is pre-1.0 and its own README says the public surface
  changes between minor releases. Read the changelog before you upgrade.
- Nimbus ships `/llms.txt`, `/llms-full.txt` and a Markdown copy of each page by
  default. Do not remove them; agents read the docs through them.
- **Settings** (`/settings`) — persisted to D1 or SQLite, never localStorage
- **Tags** (`/settings/tags`) — a real `tags` + `tag_mappings` vocabulary, never a
  comma-separated column: it cannot be indexed, coloured, or deduped
- **Favicon + logo that depict the project** — `node scripts/make-favicon.mjs
  --search "…"` then `--icon <lucide-name>`; never initials. Full rule in
  `~/AGENTS-cloudflare-workers.md`
- **A layout that works at 375px** — responsive is a requirement

**Selects show labels, never ids** — use `select-field.tsx`; `<SelectValue />`
takes no children; every select gets a placeholder.

Consult the **impeccable** skill before building anything visual, preloaded with
what is already decided (shell, surface, theme, pages above). Full detail:
the template's own `README.md` / `AGENTS.md` and
`~/.colby-ecosystem/reference/frontends.md`.

---

# Authentication (end users) — a passcode, by default

**Every app with a UI is behind a passcode unless the user says otherwise.** Not
Clerk, not Cloudflare Access, not "no auth". These are personal tools; a
passcode is the right weight for almost all of them, and it is the same
credential the MCP server and the API already accept.

## How it works

- **The page says "Passcode".** On the backend it is checked against
  **`WORKER_API_KEY`** — but nothing a user can see names it: not the label, not
  the placeholder, not an error message, not the `/docs` page, not a 401 body.
  Naming the secret tells a stranger which credential they are guessing.
- **Validate with a constant-time compare** against
  `await requireSecret(env, "WORKER_API_KEY")` (Secret Store binding, via
  `utils/secrets.ts`). Never `===` on a secret, and never `=== env.WORKER_API_KEY`
  — the binding is an object, so that is always false (see "Secrets &
  credentials" in `~/AGENTS.md`).
- **On success, set a session cookie that lasts as long as a browser allows:
  400 days.** `Max-Age=34560000; HttpOnly; Secure; SameSite=Lax; Path=/`. 400
  days is the ceiling (RFC 6265bis; Chrome clamps anything longer), so asking
  for more buys nothing. The user signs in once per device and effectively
  never again.
- **The cookie holds a signed token, never the key.** An HMAC over its own
  expiry, keyed by `WORKER_API_KEY`. Stateless — no session table — and rotating
  the key signs everyone out at once, which is exactly what a rotation should do.
- **Never log the submitted passcode**, not even on failure.

**Do not write this.** Copy the template, which already does all of the above
and is covered by a 19-assertion check:

```bash
cp ~/.colby-ecosystem/workers/utils/auth.ts   src/backend/auth.ts
cp ~/.colby-ecosystem/workers/routes/oauth.ts src/backend/routes/oauth.ts
bash ~/.colby-ecosystem/workers/devOps/auth-check/run.sh   # after any edit to either
```

`/login` renders the passcode page; `POST /auth/login` sets the cookie;
`requireAuth` accepts the cookie, `Bearer <WORKER_API_KEY>`, or an OAuth token,
so the dashboard, scripts, and MCP clients share one gate. Exempt `/login`, the
icons, `/.well-known/*`, and `/oauth/*` from it. The same files give an MCP
server its OAuth — see "MCP servers" in `~/AGENTS-cloudflare-workers.md`.

## Tests and local scripts use the same key

`WORKER_API_KEY` lives in the tokens CLI under the same name as the Secret Store
binding. A unit test, a smoke test against the deployed URL, or a local script
calling the Worker gets it from the tokens SDK — never a hardcoded string, never
a `.env`:

```bash
tokens agent-onboarding --scaffold-mjs    scripts/tokens.mjs    # Node
tokens agent-onboarding --scaffold-python utils/secrets.py      # Python
```

```js
import { requireSecret } from "./tokens.mjs";
const key = requireSecret("WORKER_API_KEY");
await fetch(`${BASE}/api/whatever`, { headers: { Authorization: `Bearer ${key}` } });
```

`tokens agent-onboarding --print-rule` shows the rest of the SDK.

## When something stronger is warranted

Use Clerk (or Cloudflare Access) only when **the user asks for it**, or when **you
judge a shared passcode genuinely too weak for the data** — several distinct
people who need separate access or revocation, regulated or third-party personal
data, anything where one leaked passcode is a real incident.

If you think that, **say so once**, with the specific reason, and let the user
decide. If they say keep the passcode, keep the passcode. Do not re-raise it,
do not quietly add Clerk "as well", and do not weaken the passcode build to make
a point.

### If Clerk it is

No hand-rolled sessions, no bespoke JWT layer. **Restrict logins to the GitHub
user `jmbish04` unless told otherwise** — an open sign-up page on a personal tool
is a bug. Use the tooling, not hand-written config:

- **`clerk` CLI** — installed (`clerk --version` → 3.2.0). Login, app and
  instance setup, keys, feature toggles, user and org management, local webhook
  testing, arbitrary Clerk API calls.
- **Clerk MCP tools** — if configured in the session.
- **Clerk skills** — `clerk` (router, start here), `clerk-setup`, `clerk-cli`,
  `clerk-astro-patterns` (the default stack), `clerk-react-patterns`,
  `clerk-custom-ui`, `clerk-orgs`, `clerk-webhooks`, `clerk-testing`,
  `clerk-backend-api`.

`CLERK_SECRET_KEY` and `CLERK_PUBLIC_KEY` are in the tokens CLI (`tokens find
clerk`). Secret Store binding in a Worker, tokens SDK in a script.

Service-to-service auth is a separate question and is always `WORKER_API_KEY`.