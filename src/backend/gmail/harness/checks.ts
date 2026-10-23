/**
 * @fileoverview The Gmail HTML standard as assertions, plus the verdict rule.
 *
 * Pure functions over a {@link DraftSnapshot} — the html, text/plain, headers
 * and MIME parts of a message AS GMAIL STORED IT. The live harness
 * (`gmail/harness/run.ts`) feeds these a draft it just created on the deployed
 * worker; the unit tests feed them `composeBody` output and planted regressions.
 *
 * Each check carries a stated {@link Severity}, and {@link aggregateVerdict}
 * turns a failed critical/major check into `fail`. A check that records a
 * defect without changing the verdict is worse than no check, so there is no
 * "informational" severity.
 *
 * The rules mirror `.agent/rules/gmail-html-standard.md` (authority: Maestro
 * plan `fc8124b830f8`). They are restated here as literals ON PURPOSE: importing
 * the constants from `compose.ts` would make a regression there invisible.
 *
 * @example
 * ```typescript
 * import { checkStandard, aggregateVerdict } from "@/backend/gmail/harness/checks";
 * const checks = checkStandard(snapshot, { uuid, expect: FIXTURE_EXPECT });
 * const verdict = aggregateVerdict(checks); // "pass" | "degraded" | "incomplete" | "fail"
 * ```
 */
import { parse, type HTMLElement } from "node-html-parser";

/** How much a failed check matters. critical/major fail the run; minor degrades it. */
export type Severity = "critical" | "major" | "minor";

/** Outcome of one check. `skipped` must carry a declared reason in `message`. */
export type CheckStatus = "pass" | "fail" | "skipped";

/** One assertion's result, as returned by the harness route. */
export interface HarnessCheck {
  /** Stable id, e.g. `container_650`. */
  name: string;
  severity: Severity;
  status: CheckStatus;
  /** What was wrong (fail), why it did not run (skipped), or what was seen (pass). */
  message: string;
}

/** Overall result. Precedence: fail > incomplete > degraded > pass. */
export type Verdict = "pass" | "degraded" | "incomplete" | "fail";

/** One MIME leaf of the stored message. */
export interface SnapshotPart {
  mimeType: string;
  filename?: string;
  /** Content-ID without angle brackets (inline parts). */
  contentId?: string;
  disposition?: string;
}

/** A Gmail message as stored: what the recipient's client will be handed. */
export interface DraftSnapshot {
  html: string;
  text: string;
  /** Header name (lower-cased) → value. */
  headers: Record<string, string>;
  parts: SnapshotPart[];
  threadId?: string;
}

/** What the known body must contain once rendered. */
export interface StandardExpectations {
  /** Bulleted items, in order. */
  bullets: string[];
  /** Numbered items, in order. */
  steps: string[];
  /** Minimum count of visible `<p>` paragraphs. */
  minParagraphs: number;
  /** A `cid:` reference the html must carry, backed by an inline MIME part. */
  inlineContentId?: string;
}

const FONT_FAMILY = "arial,helvetica,sans-serif";
const TYPOGRAPHY: Record<string, string> = {
  "font-family": FONT_FAMILY,
  "font-size": "14px",
  "line-height": "1.5",
  color: "#222222",
};
const CONTAINER: Record<string, string> = {
  "max-width": "650px",
  width: "100%",
  "text-align": "left",
  "background-color": "transparent",
};
const REF_RE = /^ref:([0-9a-f-]{36})$/i;
const PSEUDO_BULLET_RE = /^\s*(?:[•·▪◦‣●*-]|\d{1,2}[.)])\s+/;

/**
 * Parse an inline `style` attribute into a normalised map: lower-cased,
 * whitespace collapsed, no space after commas (`Arial, Helvetica` ≡ `Arial,Helvetica`).
 *
 * @param el - element whose `style` to read
 * @returns property → value
 */
export function styleOf(el: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (el.getAttribute("style") ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const key = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!important$/, "")
      .replace(/\s*,\s*/g, ",")
      .replace(/\s+/g, " ")
      .replace(/["']/g, "");
    if (key) out[key] = value;
  }
  return out;
}

/** Properties of `want` that `el`'s inline style lacks or contradicts. */
function mismatches(el: HTMLElement, want: Record<string, string>): string[] {
  const got = styleOf(el);
  return Object.entries(want)
    .filter(([k, v]) => got[k] !== v)
    .map(([k, v]) => `${k}=${got[k] ?? "∅"} (want ${v})`);
}

function describe(el: HTMLElement): string {
  return `<${el.tagName.toLowerCase()}> "${el.text.trim().slice(0, 40)}"`;
}

function result(name: string, severity: Severity, problems: string[], okMessage: string): HarnessCheck {
  return problems.length
    ? { name, severity, status: "fail", message: problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` (+${problems.length - 5} more)` : "") }
    : { name, severity, status: "pass", message: okMessage };
}

/** Leaf elements whose whole text is a `ref:<uuid>` marker. */
export function refMarkers(root: HTMLElement): HTMLElement[] {
  return root.querySelectorAll("*").filter((el) => !el.childNodes.some((n) => n.nodeType === 1) && REF_RE.test(el.text.trim()));
}

/** The body wrapper: the first element, which must be `<div dir="ltr">`. */
function container(root: HTMLElement): HTMLElement | undefined {
  const first = root.childNodes.find((n) => n.nodeType === 1) as HTMLElement | undefined;
  return first && first.tagName?.toLowerCase() === "div" ? first : undefined;
}

/**
 * Run every Gmail-HTML-standard check against a stored message.
 *
 * @param snap - the message as Gmail stored it
 * @param opts.uuid - the reference id the worker reported for this message
 * @param opts.expect - what the known body must render to
 * @returns one {@link HarnessCheck} per rule, in a stable order
 */
export function checkStandard(snap: DraftSnapshot, opts: { uuid: string; expect: StandardExpectations }): HarnessCheck[] {
  const root = parse(snap.html, { comment: false });
  const wrap = container(root);
  const checks: HarnessCheck[] = [];

  // --- container_650 (critical)
  checks.push(
    result(
      "container_650",
      "critical",
      !wrap ? ["no <div> wrapper as the first element"] : [
        ...(wrap.getAttribute("dir") === "ltr" ? [] : ['wrapper lacks dir="ltr"']),
        ...mismatches(wrap, CONTAINER),
        // A second wrapper means an edit concatenated a wrapped body instead of re-composing it.
        ...(root.querySelectorAll("div").filter((d) => d.getAttribute("dir") === "ltr" && styleOf(d)["max-width"]).length > 1
          ? ["nested body wrapper (a wrapped body was concatenated, not re-composed)"]
          : []),
      ],
      "650px left-aligned transparent container",
    ),
  );

  // --- typography (critical): wrapper + every block that carries text
  const blocks = root.querySelectorAll("p, ul, ol").filter((el) => !el.hasAttribute("data-plaintext"));
  checks.push(
    result(
      "typography_arial_14_1_5_222222",
      "critical",
      [wrap, ...blocks].filter(Boolean).flatMap((el) => mismatches(el!, TYPOGRAPHY).map((m) => `${describe(el!)}: ${m}`)),
      `Arial 14px/1.5 #222222 on the wrapper and ${blocks.length} blocks`,
    ),
  );

  // --- paragraph_spacing (major): <p> margin 0 0 16px 0, no empty/stacked-br spacing
  const paras = root.querySelectorAll("p").filter((p) => !p.hasAttribute("data-plaintext"));
  const spacing: string[] = [];
  if (paras.length < opts.expect.minParagraphs) spacing.push(`${paras.length} <p> paragraphs (want ≥ ${opts.expect.minParagraphs})`);
  for (const p of paras) {
    if (styleOf(p).margin !== "0 0 16px 0") spacing.push(`${describe(p)}: margin=${styleOf(p).margin ?? "∅"}`);
    if (!p.text.trim() && !p.querySelector("img")) spacing.push("empty <p> used as a spacer");
  }
  if (/<br\s*\/?>\s*<br\s*\/?>/i.test(snap.html)) spacing.push("stacked <br><br> used as a spacer");
  checks.push(result("paragraph_spacing_16px", "major", spacing, `${paras.length} paragraphs, 16px bottom margin each`));

  // --- real_lists (major): <ul>/<ol> with <li>, indented 24px, 6px apart; no faked bullets
  const lists: string[] = [];
  const listCheck = (tag: "ul" | "ol", want: string[]) => {
    const el = root.querySelectorAll(tag).find((l) => want.every((w) => l.text.includes(w)));
    if (!el) return lists.push(`no <${tag}> holding ${JSON.stringify(want)}`);
    const items = el.querySelectorAll("li").map((li) => li.text.trim());
    if (JSON.stringify(items) !== JSON.stringify(want)) lists.push(`<${tag}> items ${JSON.stringify(items)}`);
    if (styleOf(el)["padding-left"] !== "24px") lists.push(`<${tag}> padding-left=${styleOf(el)["padding-left"] ?? "∅"}`);
    for (const li of el.querySelectorAll("li")) if (styleOf(li)["margin-bottom"] !== "6px") lists.push(`<li> "${li.text.trim()}" margin-bottom=${styleOf(li)["margin-bottom"] ?? "∅"}`);
  };
  listCheck("ul", opts.expect.bullets);
  listCheck("ol", opts.expect.steps);
  for (const p of paras) if (PSEUDO_BULLET_RE.test(p.text)) lists.push(`faked bullet in ${describe(p)}`);
  checks.push(result("real_lists", "major", lists, "real <ul>/<ol> lists, 24px indent, 6px item gap"));

  // --- single_ref_marker (critical): exactly one, ours, hidden, out of text/plain
  const refs = refMarkers(root);
  const refProblems: string[] = [];
  if (refs.length !== 1) refProblems.push(`${refs.length} ref markers (want exactly 1)`);
  for (const r of refs) {
    const id = REF_RE.exec(r.text.trim())![1].toLowerCase();
    if (id !== opts.uuid.toLowerCase()) refProblems.push(`foreign ref ${id}`);
    if (styleOf(r).color !== "#ffffff") refProblems.push(`marker is visible: <${r.tagName.toLowerCase()}> color=${styleOf(r).color ?? "∅"}`);
    if (r.getAttribute("data-plaintext") !== "omit") refProblems.push('marker lacks data-plaintext="omit"');
  }
  if (/ref:[0-9a-f-]{36}/i.test(snap.text)) refProblems.push("ref marker leaked into text/plain");
  checks.push(result("single_ref_marker", "critical", refProblems, `one hidden ref:${opts.uuid}`));

  // --- links (minor)
  const anchors = root.querySelectorAll("a");
  checks.push(
    result(
      "links_1155cc",
      "minor",
      anchors.length ? anchors.flatMap((a) => mismatches(a, { color: "#1155cc", "text-decoration": "underline" })) : ["no <a> in the body"],
      `${anchors.length} link(s) #1155cc underlined`,
    ),
  );

  // --- no_static_style_block (minor): only media queries may stay in <style>
  const statics = root.querySelectorAll("style").filter((s) => s.text.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "").trim());
  checks.push(result("styles_inlined", "minor", statics.map(() => "<style> block with static rules"), "every static rule inlined"));

  // --- text_alternative (major): derived, paragraphed, carries the lists
  const textProblems: string[] = [];
  if (!snap.text.trim()) textProblems.push("no text/plain part");
  else {
    if (!/\n\s*\n/.test(snap.text)) textProblems.push("text/plain has no blank line between paragraphs");
    for (const w of [...opts.expect.bullets, ...opts.expect.steps]) if (!snap.text.includes(w)) textProblems.push(`text/plain lacks "${w}"`);
  }
  checks.push(result("text_plain_alternative", "major", textProblems, "text/plain derived with paragraph breaks"));

  // --- sender_name (major): From carries a display name
  const from = snap.headers.from ?? "";
  checks.push(
    result(
      "sender_display_name",
      "major",
      /^\s*(?:"[^"]+"|=\?[^?]+\?[bq]\?[^?]+\?=|[^<"]+)\s*<[^>]+>/i.test(from) ? [] : [`From is a bare address: "${from}"`],
      `From: ${from}`,
    ),
  );

  // --- inline_cid_binding (major): <img src="cid:X"> backed by a Content-ID part
  if (opts.expect.inlineContentId) {
    const cid = opts.expect.inlineContentId;
    const cidProblems: string[] = [];
    if (!root.querySelectorAll("img").some((i) => i.getAttribute("src") === `cid:${cid}`)) cidProblems.push(`html has no <img src="cid:${cid}">`);
    if (!snap.parts.some((p) => p.contentId === cid)) cidProblems.push(`no MIME part with Content-ID <${cid}>`);
    checks.push(result("inline_cid_binding", "major", cidProblems, `cid:${cid} resolves to an inline part`));
  }
  return checks;
}

/**
 * Collapse checks into one verdict. Any failed critical/major check → `fail`;
 * otherwise any skipped check → `incomplete` (an unrun check is never a pass);
 * otherwise any failed minor check → `degraded`; else `pass`.
 *
 * @param checks - every check from the run
 * @returns the overall verdict
 */
export function aggregateVerdict(checks: HarnessCheck[]): Verdict {
  if (checks.some((c) => c.status === "fail" && c.severity !== "minor")) return "fail";
  if (checks.length === 0 || checks.some((c) => c.status === "skipped")) return "incomplete";
  if (checks.some((c) => c.status === "fail")) return "degraded";
  return "pass";
}
