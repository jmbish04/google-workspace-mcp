/**
 * @fileoverview `@colby-app` comment-collaboration engine for Google Docs.
 *
 * A user highlights text, drops a comment tagging the agent call sign
 * (`@colby-app` by default, configurable via `AGENT_CALL_SIGN`), and writes a
 * natural-language request. This module scans docs for those threads, pulls the
 * highlighted text plus the surrounding document context, asks a Workers AI
 * model what to do, and replies in the comment thread — carrying a back-and-forth
 * conversation until the user approves, at which point it applies the change as a
 * native Google Docs **suggestion** (`batchUpdate` `writeMode: SUGGEST`) that the
 * user still accepts/rejects in the editor.
 *
 * Three intents, chosen by the model (or forced by `mode`):
 *   - `COMMENT`  — post review notes only, no edit ("review and leave comments").
 *   - `PROPOSE`  — reply describing a proposed edit and ask for approval.
 *   - `APPLY`    — user approved (or `mode: "suggest"`): apply as a suggestion.
 *
 * Coordination with external MCP tools: if any reply on a thread contains the
 * standby marker (`<callSign> standby, mcp tool handling`), the worker agent
 * backs off that thread entirely, so an outside model can own the conversation
 * via the plain `comments_*` MCP tools. See `comments_claim`.
 *
 * The whole engine is billing-cheap by design: the Drive/Docs REST calls (list
 * files, list comments) always run but are not Cloudflare-billed — they only
 * count against Google API quota. The Workers AI model (the billed resource) is
 * invoked solely for a thread that is genuinely actionable, so a sweep that
 * finds no tagged, open, awaiting-agent threads spends zero AI calls.
 */

import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { GoogleDocsClient, GoogleDriveClient, type DriveComment } from "@/backend/google";
import { listAuthorizedAccounts } from "@/backend/auth/provider";

/** How the engine treats each actionable thread. */
export type ReviewMode = "auto" | "comment" | "suggest";

/** Prefix every worker-authored reply carries, so we never answer ourselves. */
export const AGENT_REPLY_MARKER = "Colby Agent Update:";

/** Chars of surrounding document context handed to the model on each side. */
const CONTEXT_CHARS = 400;

/** Model action for one thread turn (the only values `parseDecision` accepts). */
type AgentAction = "COMMENT" | "PROPOSE" | "APPLY";

/** Config knobs, all with env-var / default fallbacks. */
export interface CollabConfig {
  /** The tag users mention, matched case-insensitively. */
  callSign: string;
  /** Full standby marker an MCP tool posts to claim a thread. */
  standbyMarker: string;
  /** How far back (minutes) the sweep looks for modified docs. */
  windowMinutes: number;
  /** Workers AI chat model id. */
  model: string;
}

/** Resolve config from env, applying defaults. */
export function collabConfig(env: Env): CollabConfig {
  const e = env as unknown as Record<string, string | undefined>;
  const callSign = (e.AGENT_CALL_SIGN || "@colby-app").trim();
  return {
    callSign,
    standbyMarker: `${callSign} standby, mcp tool handling`,
    windowMinutes: Number(e.COMMENT_SWEEP_WINDOW_MIN) || 30,
    model: e.MODEL_CHAT || "@cf/openai/gpt-oss-120b",
  };
}

// ---------------------------------------------------------------------------
// Pure thread selection (unit-tested — no I/O)
// ---------------------------------------------------------------------------

/** A comment the worker agent should act on this turn. */
export interface ActionableThread {
  comment: DriveComment;
  /** The highlighted document text the comment is anchored to. */
  quoted: string;
}

/** Does any reply (or the comment) contain the standby marker? */
function isMcpClaimed(comment: DriveComment, standbyMarker: string): boolean {
  const needle = standbyMarker.toLowerCase();
  if (comment.content?.toLowerCase().includes(needle)) return true;
  return (comment.replies ?? []).some((r) => r.content?.toLowerCase().includes(needle));
}

/** True if the last reply on the thread was written by the worker agent. */
function lastReplyIsAgent(comment: DriveComment): boolean {
  const replies = comment.replies ?? [];
  const last = replies.at(-1);
  return Boolean(last?.content?.startsWith(AGENT_REPLY_MARKER));
}

/**
 * Select the comments a sweep should act on, given the call sign + standby
 * marker. A thread is actionable when it is:
 *   - unresolved,
 *   - mentions the call sign (in the comment or any reply),
 *   - not claimed by an MCP tool, and
 *   - not already waiting on the human (i.e. the agent did not write the last
 *     reply) — this is the idempotency guard that stops the 5-minute cron from
 *     re-replying to a thread it already answered.
 *
 * Pure: no I/O, so the branching is unit-tested in isolation.
 */
export function selectActionableThreads(
  comments: DriveComment[],
  callSign: string,
  standbyMarker: string,
): ActionableThread[] {
  const tag = callSign.toLowerCase();
  const out: ActionableThread[] = [];
  for (const comment of comments) {
    if (comment.resolved) continue;
    const mentioned =
      comment.content?.toLowerCase().includes(tag) ||
      (comment.replies ?? []).some((r) => r.content?.toLowerCase().includes(tag));
    if (!mentioned) continue;
    if (isMcpClaimed(comment, standbyMarker)) continue;
    if (lastReplyIsAgent(comment)) continue; // waiting on the human
    out.push({ comment, quoted: comment.quotedFileContent?.value ?? "" });
  }
  return out;
}

/** Render a thread (comment + replies) as a plain transcript for the model. */
export function renderThread(comment: DriveComment): string {
  const lines = [`USER: ${comment.content ?? ""}`];
  for (const r of comment.replies ?? []) {
    const who = r.content?.startsWith(AGENT_REPLY_MARKER) ? "AGENT" : "USER";
    lines.push(`${who}: ${r.content ?? ""}`);
  }
  return lines.join("\n");
}

/**
 * Slice ~`CONTEXT_CHARS` of document text on each side of the highlighted span.
 * `docText` is the doc rendered as plain text/Markdown; `quoted` is the comment
 * highlight. Returns empty strings if the highlight is not found.
 */
export function sliceContext(
  docText: string,
  quoted: string,
): { before: string; after: string } {
  if (!quoted) return { before: "", after: "" };
  const at = docText.indexOf(quoted);
  if (at === -1) return { before: "", after: "" };
  return {
    before: docText.slice(Math.max(0, at - CONTEXT_CHARS), at),
    after: docText.slice(at + quoted.length, at + quoted.length + CONTEXT_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

/** Parsed model decision for one thread turn. */
interface Decision {
  type: AgentAction;
  replyMessage: string;
  replacementText: string;
}

function buildPrompt(args: {
  mode: ReviewMode;
  callSign: string;
  thread: string;
  quoted: string;
  before: string;
  after: string;
}): string {
  const modeRule =
    args.mode === "comment"
      ? `The user asked for REVIEW NOTES ONLY. Always use type "COMMENT" — never edit.`
      : args.mode === "suggest"
        ? `The user asked you to LEAVE SUGGESTIONS. Use type "APPLY" with the exact replacement text.`
        : `Decide the intent from the conversation:
      - Discussion / question / not yet approved → "COMMENT" (just reply).
      - User wants an edit but has not approved a concrete version → "PROPOSE": describe the change and ask them to reply "approved".
      - The latest USER message approves a change you proposed (e.g. "approved", "go ahead", "lgtm", "do it") → "APPLY" with the exact replacement text.`;

  return `You are "${args.callSign}", a collaborative Google Docs editor replying inside a comment thread.
${modeRule}

Conversation so far (oldest first):
${args.thread}

Highlighted text the thread is anchored to:
"""${args.quoted}"""

Document context BEFORE the highlight:
"""${args.before}"""

Document context AFTER the highlight:
"""${args.after}"""

Respond with ONE JSON object and nothing else:
{
  "type": "COMMENT" | "PROPOSE" | "APPLY",
  "replyMessage": "your reply to post in the thread",
  "replacementText": "for APPLY/PROPOSE: the exact new text that replaces the highlighted text; else \\"\\""
}`;
}

/** Extract the first JSON object from a model response. */
export function parseDecision(raw: string): Decision | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Partial<Decision>;
    const type = obj.type;
    if (type !== "COMMENT" && type !== "PROPOSE" && type !== "APPLY") return null;
    return {
      type,
      replyMessage: String(obj.replyMessage ?? ""),
      replacementText: String(obj.replacementText ?? ""),
    };
  } catch {
    return null;
  }
}

async function decide(env: Env, cfg: CollabConfig, prompt: string): Promise<Decision | null> {
  const gatewayId = (env as unknown as { AI_GATEWAY_ID?: string }).AI_GATEWAY_ID || "default-gateway";
  const workersai = createWorkersAI({ binding: env.AI, gateway: { id: gatewayId } });
  const { text } = await generateText({ model: workersai.chat(cfg.model), prompt });
  return parseDecision(text);
}

// ---------------------------------------------------------------------------
// Apply as a native suggestion
// ---------------------------------------------------------------------------

/** Outcome of trying to apply an approved edit. */
export type ApplyOutcome =
  /** Landed as a native Google Docs suggestion (accept/reject in the editor). */
  | "suggestion"
  /** SUGGEST unavailable on this account — proposal written to a review tab. */
  | "tab"
  /** The highlighted text could not be located to edit. */
  | "notfound";

/** Title of the tab the fallback writes proposed edits into (per doc, reused). */
export const PROPOSALS_TAB_TITLE = "@colby-app proposed edits";

/** True when a client error is Google rejecting the request with HTTP 400. */
function is400(err: unknown): boolean {
  return err instanceof Error && /failed:\s*400\b/.test(err.message);
}

/**
 * Find (or create) the per-doc "proposed edits" tab and return its `tabId`.
 * Reuses an existing tab with {@link PROPOSALS_TAB_TITLE} so approvals stack in
 * one place instead of spawning a tab per edit.
 */
async function ensureProposalsTab(docs: GoogleDocsClient, docId: string): Promise<string | null> {
  const existing = (await docs.listTabs(docId)).find((t) => t.title === PROPOSALS_TAB_TITLE);
  if (existing) return existing.tabId;
  await docs.batchUpdate(docId, [{ addDocumentTab: { tabProperties: { title: PROPOSALS_TAB_TITLE } } }]);
  // Re-read to get the created tab's id (the batchUpdate reply shape is unstable).
  const created = (await docs.listTabs(docId)).find((t) => t.title === PROPOSALS_TAB_TITLE);
  return created?.tabId ?? null;
}

/**
 * Apply an approved edit. Preferred path is a native tracked suggestion
 * (`writeMode: SUGGEST`). When that surface is unavailable — accounts outside
 * the Google Workspace Developer Preview get an HTTP 400 — we fall back to
 * writing the proposal into a dedicated review tab (`addDocumentTab`), leaving
 * the main text untouched for the user to apply by hand.
 */
export async function applySuggestion(
  docs: GoogleDocsClient,
  docId: string,
  quoted: string,
  replacement: string,
  callSign = "@colby-app",
): Promise<ApplyOutcome> {
  const range = await docs.findElement(docId, quoted);
  if (!range) return "notfound";
  try {
    await docs.batchUpdate(
      docId,
      [
        { deleteContentRange: { range: { startIndex: range.startIndex, endIndex: range.endIndex } } },
        { insertText: { location: { index: range.startIndex }, text: replacement } },
      ],
      "SUGGEST",
    );
    return "suggestion";
  } catch (err) {
    if (!is400(err)) throw err;
    const tabId = await ensureProposalsTab(docs, docId);
    if (!tabId) throw err; // couldn't create the tab — surface the original 400
    const block =
      `${callSign} proposed edit (Suggesting mode unavailable — apply by hand):\n` +
      `• Original: "${quoted}"\n` +
      `• Proposed: "${replacement}"\n\n`;
    // Target the review tab explicitly; index 1 is the start of the tab body.
    await docs.batchUpdate(docId, [
      { insertText: { location: { tabId, index: 1 }, text: block } },
    ]);
    return "tab";
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Per-doc outcome of a review pass. */
export interface DocReviewResult {
  docId: string;
  scanned: number;
  actioned: number;
  commented: number;
  proposed: number;
  /** Edits landed as native tracked suggestions. */
  applied: number;
  /** Edits written to the review tab (SUGGEST unavailable). */
  tab: number;
  skipped: number;
}

/**
 * Run one review pass over a single document: scan its comments, and for every
 * actionable `@colby-app` thread, ask the model what to do and act on it. Only
 * calls the model for actionable threads.
 */
export async function reviewDoc(
  env: Env,
  docs: GoogleDocsClient,
  docId: string,
  opts: { mode?: ReviewMode; cfg?: CollabConfig } = {},
): Promise<DocReviewResult> {
  const cfg = opts.cfg ?? collabConfig(env);
  const mode = opts.mode ?? "auto";
  const comments = await docs.listComments(docId);
  const actionable = selectActionableThreads(comments, cfg.callSign, cfg.standbyMarker);

  const result: DocReviewResult = {
    docId,
    scanned: comments.length,
    actioned: 0,
    commented: 0,
    proposed: 0,
    applied: 0,
    tab: 0,
    skipped: 0,
  };
  if (actionable.length === 0) return result; // zero AI calls

  // Read the doc once as text for context slicing across all threads.
  const docText = await docs.read(docId).catch(() => "");

  for (const { comment, quoted } of actionable) {
    const { before, after } = sliceContext(docText, quoted);
    const decision = await decide(
      env,
      cfg,
      buildPrompt({ mode, callSign: cfg.callSign, thread: renderThread(comment), quoted, before, after }),
    );
    if (!decision) {
      result.skipped++;
      continue;
    }
    result.actioned++;

    // Always post the model's reply first so the user sees the reasoning.
    const reply = `${AGENT_REPLY_MARKER} ${decision.replyMessage}`.trim();
    await docs.replyToComment(docId, comment.id, reply);

    if (decision.type === "APPLY" && quoted && decision.replacementText) {
      const outcome = await applySuggestion(docs, docId, quoted, decision.replacementText, cfg.callSign);
      if (outcome === "suggestion") {
        result.applied++;
        await docs.replyToComment(
          docId,
          comment.id,
          `${AGENT_REPLY_MARKER} Applied as a suggested edit — accept or reject it in the doc's Suggesting view.`,
        );
      } else if (outcome === "tab") {
        result.tab++;
        await docs.replyToComment(
          docId,
          comment.id,
          `${AGENT_REPLY_MARKER} Suggesting mode isn't available on this account, so I wrote the proposed edit into the "${PROPOSALS_TAB_TITLE}" tab for you to apply.`,
        );
      } else {
        result.skipped++;
        await docs.replyToComment(
          docId,
          comment.id,
          `${AGENT_REPLY_MARKER} Couldn't locate the highlighted text to edit — it may have changed since the comment.`,
        );
      }
    } else if (decision.type === "PROPOSE") {
      result.proposed++;
    } else {
      result.commented++;
    }
  }
  return result;
}

/** Map an authorized-account summary to the account ref the clients expect. */
function accountRef(a: { email: string; kind: string }): string {
  if (a.email === "workspace") return "workspace";
  return a.kind === "workspace_dwd" ? `dwd:${a.email}` : a.email;
}

/**
 * Sweep every authorized account for recently-modified Google Docs that carry
 * an open `@colby-app` comment, and run a review pass on each. This is the
 * 5-minute cron entry point. Winds down with zero AI spend when nothing matches.
 *
 * @returns Per-doc results across all accounts (empty when nothing was found).
 */
export async function sweepComments(
  env: Env,
  opts: { mode?: ReviewMode } = {},
): Promise<DocReviewResult[]> {
  const cfg = collabConfig(env);
  const since = new Date(Date.now() - cfg.windowMinutes * 60_000).toISOString();
  const query =
    `mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${since}'`;

  const accounts = await listAuthorizedAccounts(env);
  const results: DocReviewResult[] = [];
  for (const acct of accounts) {
    if (acct.status !== "active") continue;
    const ref = accountRef(acct);
    const drive = new GoogleDriveClient(env, ref);
    const docs = new GoogleDocsClient(env, ref);
    let files;
    try {
      files = await drive.listFiles(query);
    } catch {
      continue; // an account without Drive scope shouldn't kill the sweep
    }
    for (const f of files) {
      try {
        const r = await reviewDoc(env, docs, f.id, { mode: opts.mode, cfg });
        // Only surface docs that actually had a tagged thread.
        if (r.actioned > 0) results.push(r);
      } catch {
        // one bad doc must not abort the whole sweep
      }
    }
  }
  return results;
}
