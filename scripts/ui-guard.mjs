#!/usr/bin/env node
// colby-ecosystem: managed script — edit it in jmbish04/colby-ecosystem/templates/scripts/,
// never here. `pull-agents` overwrites this file.
//
// scripts/ui-guard.mjs — the checkable subset of the frontend standard, enforced by a
// deterministic scan instead of by somebody noticing in review.
//
// Every rule here is one Justin has had to correct by hand, more than once:
//
//   no-table         a plain <table>. Tables are the ReUI Data Grid, with grouping and the
//                    advanced filter builder.
//   no-pie-chart     pie / doughnut charts, in any library.
//   no-vertical-bar  a recharts <BarChart> without layout="vertical". Recharts names it
//                    backwards: layout="vertical" IS the horizontal bar. A genuine time
//                    series on the x-axis is the exception — suppress it with a reason.
//   no-raw-color     hex / rgb() / hsl() literals in colour props and style objects,
//                    Tailwind arbitrary colours (bg-[#0f766e]), and palette utilities
//                    (text-gray-500, bg-teal-600). Use the design tokens: bg-primary,
//                    text-muted-foreground, var(--chart-1). This is how a console ends up
//                    teal, or orange, when nobody asked for a brand colour.
//   no-custom-palette  a .css theme that tints --primary / --secondary / --accent / --ring
//                    (or their -foreground). ReUI's default theme keeps those achromatic;
//                    a hue there IS the custom brand palette — measured: a teal console
//                    (--primary: 191 91% 33%) and an orange one nobody asked for. Chart,
//                    destructive and sidebar-primary tokens are coloured by default and are
//                    not checked.
//   dark-default     the root <html> in a layout (or an .astro page) without `dark` in its
//                    class. Dark is the default; the header toggle offers light.
//   app-shell        a page under pages/ that renders <html> itself instead of going
//                    through the shared layout. What this CANNOT see: whether that layout is
//                    actually built on a ReUI app-shell block. It only proves that every page
//                    goes through *a* layout, which is the part a regex can measure.
//   base-ui-style    components.json declares a style whose LIBRARY is not Base UI. The style
//                    is {library}-{theme} (base-nova, base-vega, radix-nova, radix-vega) and
//                    only the `base` library is Base UI; the theme is a look, not an API. Base UI is
//                    the standard primitive layer (shadcn made it the default on 2026-07-03;
//                    ReUI's blocks are built on it). A repo on new-york-v4 gets radix
//                    primitives, and a Base UI block dropped onto radix primitives does not
//                    fail loudly - radix ignores `render`, `delay`, `closeDelay` and friends,
//                    so the trigger renders and does nothing.
//   no-radix         an import of `@radix-ui/*` or `radix-ui`, anywhere including the
//                    vendored components/ui/ wrappers - this is the one rule that looks
//                    inside them, because that is where the primitive layer lives and the
//                    whole point is which library it is.
//   select-wrapper   a raw <SelectValue> outside the vendored wrappers. NEITHER library
//                    renders the selected item's LABEL on its own: radix resolves the
//                    trigger's text from the mounted item (absent during SSR), and Base UI
//                    renders the raw value unless Select.Root is given `items`. Measured
//                    both ways - a trigger that paints `__all__` on first load, and one
//                    that paints an assignee id. The fix is one shared wrapper that
//                    resolves the label; this rule is what stops a call site going round it.
//   light-theme      a theme .css whose `:root` IS the dark theme (its --background darker
//                    than its --foreground), or that defines --background/--foreground/--card
//                    in `:root` with no counterpart in a dark block; and an HTML entry that
//                    hardcodes `class="dark"` on <html> in a repo where nothing toggles the
//                    `dark` class on documentElement at runtime. Dark is the DEFAULT, not the
//                    only theme: every surface must render in both. Measured on
//                    colby-chrome-ext before PR #13 - eleven entries pinned to `class="dark"`,
//                    the dark values sitting in `:root`, and a trailing `.dark` block holding
//                    nine overrides, so there was no light theme to switch to.
//   font-size-floor  a font size below 12px in code the repo owns: `text-[11px]`,
//                    `text-[0.6875rem]`, or a CSS `font-size` under the floor. 12px is
//                    text-xs and it is a HOUSE rule, not ReUI's - ReUI's own kit/badge.tsx
//                    ships text-[0.6rem] for size="xs" - so registry-installed source is
//                    exempt (see REGISTRY below), because `shadcn add` reverts an edit to it.
//   off-reason       a rule switched off in .ui-guard.json with no migration reference. An
//                    opt-out has to name the task that ends it, or it is permanent and
//                    nobody can tell.
//
//   node scripts/ui-guard.mjs              scan src/ and web/; exit 1 on any violation
//   node scripts/ui-guard.mjs --warn       same output, always exit 0
//   node scripts/ui-guard.mjs --json       a JSON array instead of lines
//   node scripts/ui-guard.mjs <dir>        scan another repo root (read-only)
//
// Suppress ONE line with a comment on that line or the line above it:
//   // ui-guard-allow no-vertical-bar: x-axis is a daily time series
// The reason is required. An allow without one is itself a violation (allow-reason).
//
// Optional .ui-guard.json at the repo root:
//   { "include": ["src", "web"], "exclude": ["src/backend/**"],
//     "rules": { "no-table": "off" },
//     "migration": { "no-table": "maestro task 5dc4f5e5b6b3" } }
//
// Switching a rule off needs a `migration` entry naming what ends the exemption - a task
// id, a PR, a dated decision. Without one the repo gets an `off-reason` violation
// instead, because an opt-out nobody can attribute is just the rule being deleted.
//
// Skipped always: node_modules, dist, .astro, and the vendored component directories
// components/ui/, components/reui/, components/blocks/ — ReUI and shadcn source is not ours
// to lint — plus any backend/ directory (server code, HTML email). `no-radix` is the one
// exception and runs inside the vendored directories too: which primitive library the
// wrappers wrap is exactly the thing being checked. Zero dependencies, Node 22.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const RULES = {
  "no-table": "plain <table> — use the ReUI Data Grid (with grouping and the filter builder)",
  "no-pie-chart": "pie/doughnut chart — use a horizontal bar, a stacked bar, or a number with a trend",
  "no-vertical-bar":
    'vertical <BarChart> — bars are horizontal (recharts layout="vertical") unless the x-axis is a time series; suppress with ui-guard-allow when it genuinely is',
  "no-raw-color": "raw colour — use a design token (bg-primary, text-muted-foreground, var(--chart-1)), never a literal or a palette utility",
  "no-custom-palette": "tinted theme token — ReUI's default theme keeps primary/secondary/accent/ring achromatic; never pick a brand colour",
  "dark-default": 'root <html> lacks class="dark" — dark is the default theme, light is the header toggle',
  "app-shell": "page renders <html> itself — go through the shared layout built on the ReUI app shell",
  "base-ui-style":
    'components.json style is not on the Base UI library — the style is {library}-{theme} and the library must be `base` (base-nova, base-vega), not radix-* or new-york-*. A Base UI block on radix primitives silently ignores render/delay/closeDelay rather than failing',
  "no-radix":
    "radix import — primitives come from Base UI (shadcn's base-nova style). Radix ignores the props Base UI blocks pass, so the mismatch ships working-looking and dead",
  "select-wrapper":
    "raw <SelectValue> — go through the shared select wrapper that resolves the option's label; on their own radix paints nothing during SSR and Base UI paints the raw value",
  "light-theme":
    'single-theme CSS or a hardcoded dark entry - every surface renders in BOTH themes. A theme file puts the LIGHT values in `:root` and the dark ones in a dark block, both defining --background/--foreground/--card. Any of these counts as that dark block: a `.dark` class anywhere in the selector (`.dark`, `html.dark`, `:root.dark`), a `[data-*="dark"]` attribute (`[data-theme="dark"]`, `:root[data-theme="dark"]`), or a `:root` nested in `@media (prefers-color-scheme: dark)`. An HTML entry may ship class="dark" only where something toggles the `dark` class on documentElement at runtime',
  "font-size-floor":
    "font size below 12px (text-xs) in code we own - the floor is a house rule, not ReUI's, so registry-installed source is exempt but this file is not",
  "allow-reason": "ui-guard-allow needs a known rule id and a reason: `ui-guard-allow <rule-id>: <why>`",
  "off-reason":
    'a rule is "off" in .ui-guard.json with no `migration` entry naming what ends the exemption (a task id, a PR, a dated decision)',
};

/**
 * Which primitive library a shadcn style installs.
 *
 * The style is `{library}-{theme}`, and ReUI's agent skill states the rule:
 * "the base library is the segment before the first `-` (base-nova -> base,
 * radix-nova -> radix)". Measured 2026-10-04, all four exist in both the shadcn
 * and ReUI registries - `base-nova`, `base-vega`, `radix-nova`, `radix-vega` -
 * and `/r/styles/base-nova/select.json` imports `@base-ui/react/select` while
 * `/r/styles/radix-nova/...` and shadcn's own `new-york-v4` import `radix-ui`.
 *
 * So the check is on the LIBRARY, not on a list of style names. An earlier
 * version of this pinned the single name `base-nova` and would have flagged
 * core-template-cf-reui, which is on `base-vega` - Base UI with a different
 * theme, and the repo every new frontend is created from. A theme is a look; a
 * library is an API.
 *
 * This is not a substring match: `new-york-v4` yields `new`, not `base`.
 */
export const BASE_UI_LIBRARY = "base";

export const styleLibrary = (style) =>
  typeof style === "string" && style.includes("-") ? style.slice(0, style.indexOf("-")) : "";

const EXTS = [".astro", ".tsx", ".jsx", ".ts", ".mdx", ".css", ".html"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", ".git", ".wrangler"]);
const VENDORED = ["components/ui/", "components/reui/", "components/blocks/"];

/**
 * Registry-installed source, for `font-size-floor` only.
 *
 * VENDORED is deliberately NOT this set, and that is the whole reason this one exists.
 * Measured on colby-chrome-ext 2026-11-01: `components/reui/` and `components/ui/` hold
 * BOTH kinds of file side by side. The seven single-file primitives sitting flat in them -
 * reui/{badge,frame,tag-input}.tsx, ui/{button,input,number-field,switch}.tsx - are
 * hand-edited and shared verbatim across three extensions, so they are ours and the floor
 * applies. The multi-file blocks `shadcn add` writes into SUBdirectories of the same
 * parents - reui/{kit,code-block,data-grid,event-calendar,filters}/ - are not.
 *
 * A flat file can still be registry-installed: ui/questionnaire.tsx (322 lines) imports
 * `@shadcn/react/questionnaire` and ships `text-[0.625rem]`. So the third test is the fact
 * in the file rather than its path - an import from a registry primitive namespace is what
 * `shadcn add` writes and what it will revert. ui/calendar.tsx has no such import and is
 * not exempted by any of the three; it passes on VALUE (its smallest size is 0.8rem =
 * 12.8px, above the floor), which is the honest reason and not an exemption.
 *
 * Nothing else is exempt. A new registry install flat in `components/ui/` that carries no
 * such import and breaks the floor is FLAGGED, which asks a human instead of guessing - and
 * `ui-guard-allow font-size-floor: <why>` on the line is the answer when it is genuinely
 * one of theirs.
 */
const REGISTRY_TREE = /(^|\/)components\/blocks\//;
const REGISTRY_SUBDIR = /(^|\/)components\/(?:ui|reui)\/[^/]+\//;
const REGISTRY_PARENT = /(^|\/)components\/(?:ui|reui)\//;
const REGISTRY_IMPORT = /\bfrom\s+["'](?:@shadcn\/react|@base-ui\/react|@radix-ui\/|@reui\/)/;

export const isRegistryInstalled = (rel, text) =>
  REGISTRY_TREE.test(rel) ||
  REGISTRY_SUBDIR.test(rel) ||
  (REGISTRY_PARENT.test(rel) && REGISTRY_IMPORT.test(text));

// 12px is text-xs. Below it is the floor. `em` is relative and its px size is not
// statically knowable, so it is not judged - no site measured on this machine uses it.
export const FLOOR_PX = 12;
const TW_SIZE_RE = /\btext-\[(\d*\.?\d+)(px|rem)\]/g;
const CSS_SIZE_RE = /font-size\s*:\s*(\d*\.?\d+)(px|rem)\b/g;
const toPx = (n, unit) => (unit === "px" ? n : n * 16);

/**
 * Blank out comments, keeping every line and column so reported line numbers still land.
 *
 * The line rules skip a whole line that LOOKS like a comment, which is enough for them but
 * not here: a size can sit in a `/* ... *\/` block spanning lines, or after code on the
 * same line. Measured before this existed: `// const old = "text-[10px]"` and
 * `/* font-size: 11px; *\/` were both reported, which is a rule crying wolf about code
 * somebody already removed.
 *
 * A `//` only counts when it is not preceded by `:`, so `url(http://x)` survives.
 */
function blankComments(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      i--;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/" && text[i - 1] !== ":") {
      while (i < text.length && text[i] !== "\n") { out += " "; i++; }
      out += i < text.length ? "\n" : "";
      continue;
    }
    out += text[i];
  }
  return out;
}

// Every file type carries font sizes: a Tailwind class in .tsx or .astro, the same class
// inside an @apply, a `class=` on an HTML entry, a plain `font-size` in a stylesheet. The
// measured gap this closes: src/newtab/widgets/forecast.css ships `font-size: 0.6875rem`
// (11px) in page code, which a Tailwind-only scan declares clean.
function sizeViolations(text) {
  const out = [];
  blankComments(text).split("\n").forEach((line, i) => {
    for (const re of [TW_SIZE_RE, CSS_SIZE_RE])
      for (const m of line.matchAll(re))
        if (toPx(Number(m[1]), m[2]) < FLOOR_PX) out.push({ line: i + 1, rule: "font-size-floor" });
  });
  return out;
}
// Server code renders no app UI. HTML email legitimately needs tables and literal colours,
// and seed rows (a project's label colour) are data, not styling.
const SERVER = /(^|\/)backend\//;

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PALETTE_RE = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*-?[a-z]+(?:-[a-z]+)*-(?:${PALETTE})-(?:50|[1-9]00|950)(?:\\/\\d+)?(?![\\w-])`, "g");
const ARBITRARY_RE = /-\[(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\((?!var\())/g;
const COLOR_PROPS =
  "fill|stroke|color|stopColor|floodColor|lightingColor|background|backgroundColor|borderColor|outlineColor|textDecorationColor|caretColor|accentColor";
const COLOR_LITERAL_RE = new RegExp(
  `\\b(?:${COLOR_PROPS})\\s*[:=]\\s*\\{?\\s*["'\`](?:#[0-9a-fA-F]{3,8}\\b|(?:rgba?|hsla?|oklch|oklab)\\((?!\\s*var\\())`,
  "g",
);
const ALLOW_RE = /ui-guard-allow\s+([\w-]+)(?:\s*:\s*(\S.*?))?\s*(?:\*\/|-->|\}|$)/;

const isComment = (line) => /^\s*(\/\/|\/\*|\*|\{\/\*|<!--)/.test(line);
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

// The opening tag starting at `start` ("<Name ..."), tracking quotes and {} so that
// `=>` inside an attribute expression does not end it.
function openingTag(text, start) {
  let depth = 0, quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth <= 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

function* tags(text, nameRe) {
  const re = new RegExp(`<(?:\\w+\\.)?(?:${nameRe})(?![\\w.-])`, "g");
  for (const m of text.matchAll(re)) yield { index: m.index, tag: openingTag(text, m.index) };
}

// Chroma of a CSS colour value, normalised so that > 0.03 means "visibly tinted".
// null = cannot judge (var(), a keyword) -> not flagged.
export function chroma(value) {
  const v = value.trim().toLowerCase();
  let m;
  if ((m = v.match(/^oklch\(\s*[\d.]+%?\s+([\d.]+)/))) return Number(m[1]);
  if ((m = v.match(/^(?:hsla?\()?\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/))) {
    const s = Number(m[1]) / 100, l = Number(m[2]) / 100;
    return s * (1 - Math.abs(2 * l - 1)) * 0.4; // HSL chroma, scaled to oklch's rough range
  }
  if ((m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})\b/))) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return (Math.max(...rgb) - Math.min(...rgb)) * 0.4;
  }
  return null;
}

const TOKEN_RE = /^\s*--(primary|secondary|accent|ring)(?:-foreground)?\s*:\s*([^;]+);/;

/**
 * Perceived lightness of a CSS colour, 0 (black) to 1 (white).
 * null = cannot judge (a var(), a keyword) -> no claim either way.
 *
 * Separate from chroma() above because they answer different questions: chroma asks
 * "is this tinted", this asks "is this the light value or the dark one".
 */
export function lightness(value) {
  const v = value.trim().toLowerCase();
  let m;
  if ((m = v.match(/^oklch\(\s*([\d.]+)(%?)/))) return Number(m[1]) / (m[2] ? 100 : 1);
  if ((m = v.match(/^(?:hsla?\()?\s*[\d.]+(?:deg)?[\s,]+[\d.]+%[\s,]+([\d.]+)%/))) return Number(m[1]) / 100;
  if ((m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})\b/))) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return (Math.max(...rgb) + Math.min(...rgb)) / 2;
  }
  return null;
}

const ROOT_SEL = /(?:^|,)\s*:root\b/;
/**
 * Does this selector mark the dark theme?
 *
 * Containment, with no leading-boundary requirement, and that is the fix for four measured
 * FALSE POSITIVES on correct code. An earlier version required the marker to sit at the
 * start of the selector or after whitespace or a combinator, so it saw `.dark` and
 * `[data-theme="dark"]` but NOT a COMPOUND selector with the marker attached directly:
 * `:root[data-theme="dark"]`, `html[data-theme="dark"]`, `:root.dark` and `[data-mode=
 * "dark"]` were each told their correctly-paired theme was single-theme. The first of those
 * is the convention this ecosystem's own artifact guidance prescribes, and the third is the
 * shape the old pattern's comment claimed to handle.
 *
 * That direction of error is the expensive one. A false negative fails toward silence; a
 * false positive on correct code spends the credibility the rule needs, and earns itself an
 * `off` in .ui-guard.json from someone who is right to distrust it.
 *
 * The CLASS branch requires the name to be exactly `dark`, and `(?![\w-])` is doing two
 * jobs there. `.darkroom` was never a problem - `k` to `r` is no boundary - but `\b` ALONE
 * let `.dark-panel` through, because a word boundary sits between `k` and `-`. That is a
 * false negative in the pairing check rather than a false positive: a `dark-`prefixed
 * COMPONENT class supplying all three core tokens satisfies the pair, so a single-theme
 * file passes. Measured, 0 violations before this:
 *
 *     :root       { --background: oklch(1 0 0);   --foreground: oklch(0.141 0 0); ... }
 *     .dark-panel { --background: oklch(0.3 0 0); --foreground: oklch(0.9 0 0);   ... }
 *
 * `:root` is genuinely light so the lightness test passes, and `.dark-panel` completes the
 * pair, so neither check fires - two checks do not save you when one class satisfies both.
 * `.dark-overlay`, `.dark-scrim` and especially `.dark-mode-only` are ordinary class names,
 * and whether one of them happens to set those three tokens is luck, not design.
 *
 * The ATTRIBUTE branch deliberately keeps `\b`, because a VALUE is not a name:
 * `[data-theme="dark-high-contrast"]` genuinely IS a dark theme and must keep matching,
 * while `[data-theme="darkless"]` must not.
 */
const DARK_SEL = /\.dark(?![\w-])|\[data-[\w-]*\s*=\s*["']?dark\b/;
// The three tokens that MUST differ between the themes. A --background or --card that is
// the same in both is a surface that does not change, which is the bug this catches.
// --border is left out on purpose: a shared border value is defensible.
const THEME_CORE = ["background", "foreground", "card"];
const DECL_RE = /^\s*--([\w-]+)\s*:\s*([^;]+);/;

/**
 * Every CSS block as { selector, chain, decls: [{ n, text }] }, from one character walk.
 *
 * This replaced a line-based version that counted braces per line, and the two bugs it had
 * are both worth naming because each produced a PLAUSIBLE ZERO - the shape this whole rule
 * exists to prevent:
 *
 *  - Several blocks on one line were missed. `:root { ...dark values... }` written compactly
 *    reported CLEAN, because the opening and closing brace landed on the same line and the
 *    next block never became current. A minified or hand-compacted theme file silently
 *    passed the very check written to catch it.
 *  - A nested block folded into its parent, so `@media (prefers-color-scheme: dark) { :root
 *    { ... } }` - the other standard way to ship a dark theme - was not seen as a dark block
 *    at all, and a correctly paired file was flagged three times.
 *
 * `chain` is the ancestor selectors joined, which is what makes the @media form visible.
 * Comments are skipped, and a final declaration with no `;` before `}` is still flushed.
 */
function cssBlocks(text) {
  const blocks = [];
  const open = [];                 // the blocks currently enclosing us, outermost first
  let buf = "";
  let bufLine = 1;
  let line = 1;
  const flush = () => {
    const d = buf.trim();
    if (d && d.includes(":") && open.length) {
      open[open.length - 1].decls.push({ n: bufLine, text: d.endsWith(";") ? d : d + ";" });
    }
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] === "\n") line++;
      i--;
      continue;
    }
    if (c === "\n") { line++; buf += " "; continue; }
    if (c === "{") {
      const selector = buf.trim();
      const chain = [...open.map((b) => b.selector), selector].join(" ");
      const block = { selector, chain, decls: [] };
      blocks.push(block);
      open.push(block);
      buf = "";
      continue;
    }
    if (c === "}") { flush(); open.pop(); buf = ""; continue; }
    if (c === ";") { flush(); continue; }
    if (!buf.trim() && c.trim()) bufLine = line;
    buf += c;
  }
  return blocks;
}

// `@media (prefers-color-scheme: dark)` is the other standard way to ship a dark theme, and
// a `:root` inside one is a DARK root, not a second light one.
const MEDIA_DARK = /@media[^{]*prefers-color-scheme\s*:\s*dark/;

const customProps = (blocks) => {
  const m = new Map();
  for (const b of blocks)
    for (const d of b.decls) {
      const dm = d.text.match(DECL_RE);
      if (dm) m.set(dm[1], { line: d.n, value: dm[2] });
    }
  return m;
};

/**
 * `light-theme`, the CSS half: a theme file has to carry BOTH themes.
 *
 * Two checks, because either alone passes a file that has no light theme:
 *
 *  1. `:root` must BE the light theme. Its --background lighter than its --foreground.
 *     colby-chrome-ext before PR #13 had `:root { --background: oklch(0.145 0 0);
 *     --foreground: oklch(0.985 0 0) }` - near-black on near-white, which is the dark
 *     theme wearing the default selector, so switching to light had nowhere to go.
 *  2. Each core token in `:root` needs its counterpart in a dark block. That same file's
 *     trailing `.dark` held nine overrides and none of these three, so a pairing check
 *     catches it even without the lightness test - and the lightness test catches the
 *     opposite shape, a file that defines the dark values in both places.
 *
 * A file whose `:root` carries no theme token at all is not a theme file and gets no
 * claim either way. Suppressing this one is `.ui-guard.json` with a `migration` entry,
 * not a line comment: the .css scan has never read allow comments.
 */
function scanThemeCss(text) {
  const blocks = cssBlocks(text);
  const isDark = (b) => DARK_SEL.test(b.selector) || MEDIA_DARK.test(b.chain);
  const root = customProps(blocks.filter((b) => ROOT_SEL.test(b.selector) && !isDark(b)));
  if (!THEME_CORE.some((t) => root.has(t))) return [];
  const dark = customProps(blocks.filter(isDark));
  const out = [];
  const bg = root.get("background");
  const fg = root.get("foreground");
  const lb = bg && lightness(bg.value);
  const lf = fg && lightness(fg.value);
  if (lb != null && lf != null && lb < lf) out.push({ line: bg.line, rule: "light-theme" });
  for (const t of THEME_CORE)
    if (root.has(t) && !dark.has(t)) out.push({ line: root.get(t).line, rule: "light-theme" });
  return out;
}

function scanCss(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(TOKEN_RE);
    const c = m && chroma(m[2]);
    if (c !== null && c > 0.03) out.push({ line: i + 1, rule: "no-custom-palette" });
  });
  out.push(...scanThemeCss(text), ...sizeViolations(text));
  // Both halves of `light-theme` can name the same --background line, and one line can
  // carry two sizes. One line plus one rule is one violation.
  const seen = new Set();
  return out
    .filter(({ line, rule }) => !seen.has(`${line}:${rule}`) && seen.add(`${line}:${rule}`))
    .sort((a, b) => a.line - b.line);
}

// One file -> [{ line, rule }]. `rel` is the repo-relative path with forward slashes.
export function scan(rel, text) {
  const out = [];
  const add = (line, rule) => out.push({ line, rule });
  const lines = text.split("\n");
  if (rel.endsWith(".css")) return scanCss(text);
  out.push(...sizeViolations(text));

  // An HTML entry (a Vite MPA surface, an extension popup) is not a component: the only
  // thing read out of it is the root <html> tag. Running the component line rules over it
  // would judge markup nothing here owns.
  if (rel.endsWith(".html")) {
    out.push(...scanHtmlEntry(text));
    return suppressed(lines, out);
  }

  lines.forEach((line, i) => {
    if (isComment(line) && !/ui-guard-allow/.test(line)) return;
    const n = i + 1;
    if (/<table[\s>/]/.test(line)) add(n, "no-table");
    if (/\bfrom\s+["']@radix-ui\/[^"']+["']|\bfrom\s+["']radix-ui["']|\brequire\(\s*["'](?:@radix-ui\/[^"']+|radix-ui)["']/.test(line)) add(n, "no-radix");
    if (/<SelectValue[\s>/]/.test(line)) add(n, "select-wrapper");
    if (/\btype\s*[:=]\s*\{?\s*["'](?:pie|doughnut)["']/.test(line) || /from\s+["']@nivo\/pie["']/.test(line)) add(n, "no-pie-chart");
    if (line.match(PALETTE_RE) || line.match(ARBITRARY_RE) || line.match(COLOR_LITERAL_RE)) add(n, "no-raw-color");
    const allow = line.match(ALLOW_RE);
    if (allow && (!allow[2] || !RULES[allow[1]] || allow[1] === "allow-reason")) add(n, "allow-reason");
  });

  for (const { index } of tags(text, "PieChart|Pie")) add(lineAt(text, index), "no-pie-chart");
  for (const { index, tag } of tags(text, "BarChart")) {
    // ponytail: a dynamic layout={expr} cannot be judged statically, so it is not flagged.
    if (/\blayout\s*=\s*\{(?!\s*["'])/.test(tag)) continue;
    if (!/\blayout\s*=\s*\{?\s*["']vertical["']/.test(tag)) add(lineAt(text, index), "no-vertical-bar");
  }

  const inPages = /(^|\/)pages\//.test(rel);
  const isLayout = /(^|\/)layouts\//.test(rel);
  for (const { index, tag } of tags(text, "html")) {
    const n = lineAt(text, index);
    if (isLayout || (inPages && rel.endsWith(".astro"))) {
      const cls = tag.match(/\b(?:class|className|class:list)\s*=\s*("[^"]*"|'[^']*'|\{[\s\S]*?\})/);
      if (!cls || !/\bdark\b/.test(cls[1])) add(n, "dark-default");
    }
    if (inPages) add(n, "app-shell");
  }

  return suppressed(lines, out);
}

/**
 * `light-theme`, the HTML half: an entry pinned to the dark theme.
 *
 * Reported here and cleared in run(), because whether it is a violation is a REPO fact,
 * not a line fact - `class="dark"` is correct when something switches it at runtime and
 * wrong when nothing does. Dark is the default; the class is how a surface paints dark
 * before the first frame without a flash.
 */
export function scanHtmlEntry(text) {
  const out = [];
  for (const { index, tag } of tags(text, "html")) {
    const cls = tag.match(/\bclass\s*=\s*("[^"]*"|'[^']*')/);
    if (cls && /\bdark\b/.test(cls[1])) out.push({ line: lineAt(text, index), rule: "light-theme" });
  }
  return out;
}

/**
 * Something changes the `dark` class on the root element at runtime.
 *
 * A MUTATOR only. Measured: colby-chrome-ext before PR #13 had
 * `document.documentElement.classList.contains("dark")` in a vendored block, which READS
 * the theme and cannot switch it - counting that would have cleared all eleven pinned
 * entries and reported the repo as having a light theme it did not have.
 */
export const TOGGLES_DARK_CLASS =
  /documentElement\.classList\.(?:toggle|add|remove|replace)\(\s*["'`]dark["'`]/;

// Suppression: an allow for this rule, with a reason, on the line or the line above.
function suppressed(lines, out) {
  const allowed = (n, rule) =>
    [lines[n - 1], lines[n - 2]].some((l) => {
      const m = l?.match(ALLOW_RE);
      return m && m[1] === rule && m[2];
    });
  const seen = new Set();
  return out
    .filter(({ line, rule }) => rule === "allow-reason" || !allowed(line, rule))
    .filter(({ line, rule }) => !seen.has(`${line}:${rule}`) && seen.add(`${line}:${rule}`))
    .sort((a, b) => a.line - b.line);
}

const globRe = (g) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}`);

function* walk(root, dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(root, full);
    else if (EXTS.some((x) => e.name.endsWith(x)) && !e.name.endsWith(".d.ts")) yield full;
  }
}

// Depth 3 covers 398 of the 403 in-repo components.json files in this fleet (histogram by
// depth: 0:302, 1:45, 2:40, 3:11, 4:3, 7:1, 9:1). The five it misses are vendored samples
// and generated output. The bound is PRINTED on every run and raisable with `uiTreeDepth`,
// because an unstated limit is this file's own argument used against it - a first count of
// that histogram with `find -maxdepth 6` returned 229 of 425 and read like a measurement.
export const UI_TREE_DEPTH = 3;

/**
 * Every directory holding its own `components.json`, to a bounded depth.
 *
 * `components.json` is a DECLARATION that a subtree is a shadcn/ReUI frontend, which is why
 * this looks for it rather than guessing from file extensions. A subtree that declares
 * itself a frontend and sits outside every scan root is the partial-scan hole: the walk
 * never descends into it, and the verdict says `0 violations` about a tree it never opened.
 *
 * Measured on cloudflare-api-mcp: `chrome-extension/` carries its own components.json and 23
 * source files, `include` defaults to ["src", "web"], and the repo has no .ui-guard.json. A
 * root run reported 23 violations in 70 files with ZERO of them under that path, while a run
 * rooted at the subtree reported 8 in 19. Two disjoint trees, two plausible verdicts, and
 * nothing in either output saying half the repo was never read. `tests/` in the same repo
 * holds 23 source files and no components.json, and is correctly not a frontend root.
 */
export function findUiTrees(root, depth = UI_TREE_DEPTH) {
  const out = [];
  const visit = (dir, rel, left) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.isFile() && e.name === "components.json")) out.push(rel);
    if (left === 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      visit(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, left - 1);
    }
  };
  visit(root, "", depth);
  return out;
}


/**
 * A directory outside every scan root that LOOKS like a frontend without declaring one.
 *
 * `components.json` is the right trigger for exit 2 and an incomplete detector, measured
 * across this fleet: 68 directories hold 3+ tsx under `src/components`, sit outside the scan
 * roots, and carry no components.json. One of them is this exact hole with the declaration
 * absent - `sgd-hbd-advisor :: frontend`, 53 tsx, whose REPO ROOT has a components.json: the
 * root declares a frontend, the walk reads `src/`, and `frontend/` is never opened. The rest
 * are component libraries, which have none by design because they are not shadcn install
 * targets (`uitripled :: packages/components/react-shadcn`, 211 tsx).
 *
 * So this is a guess, and a guess may not fail anybody's build - it prints and nothing more.
 * Precision earns the right to exit non-zero; a heuristic earns the right to be seen. The
 * `src/components` criterion is also what keeps a `tests/` directory out on its own merits.
 */
export function findDenseTrees(root, depth = UI_TREE_DEPTH, minTsx = 3) {
  const out = [];
  const countTsx = (dir) => {
    let n = 0;
    const walkDir = (d) => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walkDir(join(d, e.name));
        } else if (e.name.endsWith(".tsx")) n++;
      }
    };
    walkDir(dir);
    return n;
  };
  const visit = (dir, rel, left) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && existsSync(join(dir, "src", "components"))) {
      const n = countTsx(join(dir, "src", "components"));
      if (n >= minTsx) {
        out.push({ dir: rel, tsx: n });
        return;
      }
    }
    if (left === 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      visit(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, left - 1);
    }
  };
  visit(root, "", depth);
  return out;
}

/**
 * The repo's primitive layer: which shadcn style `components.json` declares.
 *
 * Repo-level rather than per-line, because the mistake is one line in one file
 * and it decides what every later `shadcn add` installs. Returns [] when there
 * is no components.json - a repo with no shadcn config is not a frontend repo
 * this rule has anything to say about, and inventing a violation for an absent
 * file is concluding something from an absence.
 */
export function scanComponentsJson(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    // Malformed JSON is shadcn's problem to report, not this scan's to guess at.
    return [];
  }
  if (styleLibrary(cfg.style) === BASE_UI_LIBRARY) return [];
  const line = text.split("\n").findIndex((l) => /"style"\s*:/.test(l));
  return [{ line: line >= 0 ? line + 1 : 1, rule: "base-ui-style" }];
}

/**
 * The violations alone. `runWithStats` is the same walk and also reports how many files it
 * read, which the CLI needs to tell a clean repo from a scan that read nothing.
 */
export function run(root = ".") {
  return runWithStats(root).violations;
}

export function runWithStats(root = ".") {
  root = resolve(root);
  const cfgPath = join(root, ".ui-guard.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const include = cfg.include ?? ["src", "web"];
  // Two different facts, and conflating them made the CLI say "no .ui-guard.json" about a
  // repo that has one. Measured on harness-insights, whose config excludes two directories
  // and sets no `include`: the run printed "no .ui-guard.json, roots defaulted to src, web"
  // while that very file was the reason a flagged-looking site was not scanned. A reader
  // checking why a file was skipped was told the config did not exist.
  const hasConfig = existsSync(cfgPath);
  const declaredDefault = cfg.include === undefined;
  const acknowledged = new Set(cfg.unscanned ?? []);
  const uiTreeDepth = cfg.uiTreeDepth ?? UI_TREE_DEPTH;
  const exclude = (cfg.exclude ?? []).map(globRe);
  const off = new Set(Object.entries(cfg.rules ?? {}).filter(([, v]) => v === "off").map(([k]) => k));
  const migration = cfg.migration ?? {};
  const violations = [];
  const push = (file, v) => {
    if (!off.has(v.rule)) violations.push({ file, line: v.line, rule: v.rule, message: RULES[v.rule] });
  };

  // `light-theme`'s HTML half is a repo question, so the pinned entries are collected and
  // judged after the walk - a toggle in ANY of our files clears every one of them.
  const pinnedDark = [];
  let togglesDark = false;
  let scanned = 0;

  const roots = [];
  const missingRoots = [];
  for (const dir of include) {
    if (!existsSync(join(root, dir))) {
      missingRoots.push(dir);
      continue;
    }
    const before = scanned;
    for (const file of walk(root, join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      const vendored = VENDORED.some((v) => rel.includes(v));
      if (SERVER.test(rel) || exclude.some((re) => re.test(rel))) continue;
      const text = readFileSync(file, "utf8");
      scanned++;
      // A toggle inside a vendored block is that block's own theme switch, not the app's.
      if (!vendored && TOGGLES_DARK_CLASS.test(text)) togglesDark = true;
      const registry = isRegistryInstalled(rel, text);
      // The vendored directories are skipped for every rule but `no-radix` and
      // `font-size-floor`: which primitive library the wrappers wrap is the thing being
      // checked, and the hand-edited single-file primitives living in those same
      // directories are ours (see REGISTRY above), so both scans look inside them.
      for (const v of scan(rel, text)) {
        if (vendored && v.rule !== "no-radix" && v.rule !== "font-size-floor") continue;
        if (v.rule === "font-size-floor" && registry) continue;
        if (v.rule === "light-theme" && rel.endsWith(".html")) {
          pinnedDark.push([rel, v]);
          continue;
        }
        push(rel, v);
      }
    }
    roots.push({ dir, files: scanned - before });
  }

  if (!togglesDark) for (const [rel, v] of pinnedDark) push(rel, v);

  const componentsJson = join(root, "components.json");
  if (existsSync(componentsJson)) {
    for (const v of scanComponentsJson(readFileSync(componentsJson, "utf8"))) push("components.json", v);
  }

  // An opt-out has to name what ends it. This one is reported even when
  // `off-reason` is itself switched off - a rule that can disable its own
  // enforcement is an instrument that cannot fail.
  for (const rule of off) {
    if (rule === "off-reason") continue;
    if (!migration[rule]) {
      violations.push({ file: ".ui-guard.json", line: 1, rule: "off-reason", message: RULES["off-reason"] });
    }
  }

  // A declared UI tree that no scan root covers. `unscanned` in .ui-guard.json acknowledges
  // one deliberately - a declaration with a name on it, never an off-switch, because the
  // rule the briefings state is that a check may skip what it has DECLARED it does not
  // need, and may never skip something merely because it could not find it.
  const covered = (t) => include.some((d) => t === d || t.startsWith(`${d}/`));
  const unscannedUiTrees = findUiTrees(root, uiTreeDepth).filter(
    (t) => !covered(t) && !acknowledged.has(t),
  );
  // A guess, so it prints and never fails a build. See findDenseTrees.
  const denseTrees = findDenseTrees(root, uiTreeDepth).filter(
    (t) => !covered(t.dir) && !acknowledged.has(t.dir) && !unscannedUiTrees.includes(t.dir),
  );

  // `0 violations` from scanning NOTHING is byte-identical to `0 violations` from a clean
  // repo, and it exits 0 either way - a typo in the path, an `include` pointing at a
  // directory that moved, or a tree that was never checked out all read as a pass. That is
  // the instrument that cannot fail, so the count travels with the verdict and the CLI
  // refuses to call it clean. Measured in the PR that added this: `ui-guard.mjs
  // /path/that/does/not/exist` printed `0 violation(s)` and exited 0.
  //
  // Two neighbouring holes the file count does NOT close, both found after that change
  // shipped: a declared root absent from disk is skipped in silence, and a subtree that
  // declares itself a frontend outside every root is never opened. Both report clean, and
  // `70 files` only reads as short to someone who already knows the repo's real count. So
  // the roots travel with the verdict too, and both join the usage-error exit.
  return {
    violations, scanned, roots, missingRoots, unscannedUiTrees, denseTrees,
    declaredDefault, hasConfig, uiTreeDepth,
    excluded: cfg.exclude ?? [],
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ui-guard.mjs")) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--")) ?? ".";
  const {
    violations, scanned, roots, missingRoots, unscannedUiTrees, denseTrees,
    declaredDefault, hasConfig, uiTreeDepth, excluded,
  } = runWithStats(root);
  if (args.includes("--json")) console.log(JSON.stringify(violations, null, 2));
  else for (const v of violations) console.log(`${v.file}:${v.line}: ${v.rule}: ${v.message}`);
  if (!args.includes("--json")) {
    const where = roots.length
      ? roots.map((r) => `${r.dir}/ (${r.files})`).join(", ")
      : "nothing";
    console.error(
      `ui-guard: ${violations.length} violation(s) in ${scanned} file(s) — scanned ${where}` +
        `${
          !hasConfig
            ? " · no .ui-guard.json, roots defaulted to src, web"
            : declaredDefault
              ? " · .ui-guard.json sets no `include`, roots defaulted to src, web"
              : " · roots from .ui-guard.json"
        }` +
        `${excluded.length ? ` · excluding ${excluded.join(", ")}` : ""}` +
        ` · looked ${uiTreeDepth} deep for other frontends`,
    );
    // A guess prints and nothing more - it may not fail anybody's build.
    for (const t of denseTrees) {
      console.error(
        `ui-guard: note — "${t.dir}/" holds ${t.tsx} .tsx under src/components, sits outside ` +
          `every scan root, and declares no components.json. Not read. If it is a frontend, ` +
          `add it to \`include\`; if not, \`unscanned\` silences this note.`,
      );
    }
  }
  // Only a root somebody WROTE DOWN can be missing. The default is ["src", "web"] - a union
  // of the two layouts in this fleet, not a claim that both exist - and no repo in it has
  // both, so failing on a defaulted root fires on every repo at once. Measured while
  // writing this: the first version did exactly that, on all four trees.
  if (missingRoots.length && !declaredDefault) {
    console.error(
      `ui-guard: scan root(s) ${missingRoots.map((d) => `"${d}"`).join(", ")} do not exist ` +
        `under "${root}" and were skipped in silence, so this verdict covers less than it ` +
        `claims. Fix the \`include\` in .ui-guard.json, or check out the missing tree.`,
    );
    process.exit(2);
  }
  if (unscannedUiTrees.length) {
    console.error(
      `ui-guard: ${unscannedUiTrees.map((t) => `"${t}/"`).join(", ")} declare(s) a frontend ` +
        `(its own components.json) and sits outside every scan root, so none of it was read. ` +
        `Add it to \`include\` in .ui-guard.json, or acknowledge it in \`unscanned\` if it ` +
        `is guarded separately.`,
    );
    process.exit(2);
  }
  if (!scanned) {
    console.error(
      `ui-guard: scanned 0 files under "${root}" — nothing was checked, so this is not a ` +
        `pass. Check the path, and the \`include\` in .ui-guard.json (default: src, web).`,
    );
    process.exit(2);
  }
  process.exit(violations.length && !args.includes("--warn") ? 1 : 0);
}