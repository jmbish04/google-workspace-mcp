/**
 * @fileoverview The on-demand Gmail verification harness: exercise the
 * DEPLOYED worker end to end and return per-check pass/fail plus a verdict.
 *
 * Why it exists: task-email-formatting-enforcement bounced because the live
 * worker sent mail that did not match what the passing test suite asserted.
 * Tests prove the code; this proves the deployment. It:
 *
 *   1. creates a real Gmail draft through `GmailService.createDraft` — the same
 *      path `gmail_create_draft` uses — from a known markdown body with an
 *      inline `cid:` image and a file attachment;
 *   2. reads the draft BACK FROM GMAIL (`drafts.get?format=full`) and checks
 *      the stored html/text/headers/parts against the standard (checks.ts);
 *   3. round-trips it through `getDraft` → `updateDraft` (append text + add a
 *      cc) and re-checks: cc present, threadId unchanged, attachments and the
 *      cid binding retained, still exactly one hidden ref marker;
 *   4. deletes the draft.
 *
 * Step 3 needs task 86981006082e. Until `GmailService.getDraft/updateDraft`
 * exist, those checks report `skipped` with that declared reason and the
 * verdict is `incomplete` — never `pass`.
 *
 * `plant` mutates the harness's in-memory copy only (plant.ts), so a reviewer
 * can watch a check go red on the live worker without breaking anything.
 *
 * @example
 * ```typescript
 * import { runGmailHarness, liveHarnessGmail } from "@/backend/gmail/harness/run";
 * const report = await runGmailHarness(liveHarnessGmail(env, account), { account });
 * ```
 */
import { parse } from "node-html-parser";

import { googleFetch, googleJson } from "@/backend/mcp/googleClient";
import { GmailService, type RichContent } from "@/backend/mcp/services/gmail";
import { aggregateVerdict, checkStandard, refMarkers, type DraftSnapshot, type HarnessCheck, type Severity, type Verdict } from "@/backend/gmail/harness/checks";
import {
  FIXTURE_APPEND_MARKDOWN,
  FIXTURE_CC,
  FIXTURE_CID,
  FIXTURE_EXPECT,
  FIXTURE_MARKDOWN,
  FIXTURE_PIXEL_PNG_B64,
} from "@/backend/gmail/harness/fixture";
import { plantRegression, type PlantName } from "@/backend/gmail/harness/plant";
import { snapshotFromGmail, type GmailDraftResource } from "@/backend/gmail/harness/snapshot";

/** The task that ships `GmailService.getDraft/updateDraft` (contract §1–§2). */
export const DRAFT_EDIT_TASK = "86981006082e";

/** Filename of the regular (non-inline) attachment the fixture draft carries. */
export const FIXTURE_FILE = "gmail-harness.txt";

/** `getDraft` result fields the harness reads (contract §1). */
export interface DraftViewLike {
  draftId?: string;
  uuid?: string | null;
  refCount?: number;
}

/** The Gmail operations the harness performs; injectable so the runner is unit-tested. */
export interface HarnessGmail {
  /** Create a draft through the production compose path. */
  createDraft(to: string, subject: string, opts: RichContent): Promise<{ id: string; uuid: string }>;
  /** Read a draft back from Gmail as stored. */
  fetchDraft(draftId: string): Promise<DraftSnapshot>;
  /** Delete a draft (cleanup). */
  deleteDraft(draftId: string): Promise<void>;
  /** Present only once task 86981006082e is deployed. */
  getDraft?: (draftId: string) => Promise<DraftViewLike>;
  /** Present only once task 86981006082e is deployed. */
  updateDraft?: (draftId: string, opts: Record<string, unknown>) => Promise<unknown>;
}

/** Options for one harness run. */
export interface HarnessOptions {
  /** The Gmail account to draft in (also the draft's `to`). */
  account: string;
  /** Plant one known regression into the checked copy. */
  plant?: PlantName;
  /** Keep the draft instead of deleting it (to inspect it in Gmail). */
  keepDraft?: boolean;
}

/** The harness result returned by the route. */
export interface HarnessReport {
  runId: string;
  verdict: Verdict;
  account: string;
  draftId: string | null;
  uuid: string | null;
  planted: PlantName | null;
  durationMs: number;
  /** Count of checks by status. */
  summary: { pass: number; fail: number; skipped: number };
  checks: HarnessCheck[];
}

/** Gmail REST base for the signed-in account. */
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * The production implementation of {@link HarnessGmail} for one account.
 *
 * @param env - Worker env
 * @param account - account email (token ref)
 * @returns live Gmail operations; `getDraft/updateDraft` only when deployed
 */
export function liveHarnessGmail(env: Env, account: string): HarnessGmail {
  const svc = new GmailService(env, account);
  const edit = svc as unknown as {
    getDraft?: (id: string) => Promise<DraftViewLike>;
    updateDraft?: (id: string, o: Record<string, unknown>) => Promise<unknown>;
  };
  return {
    createDraft: (to, subject, opts) => svc.createDraft(to, subject, "", opts),
    fetchDraft: async (id) => snapshotFromGmail(await googleJson<GmailDraftResource>(env, account, `${BASE}/drafts/${id}?format=full`)),
    deleteDraft: async (id) => {
      await googleFetch(env, account, `${BASE}/drafts/${id}`, { method: "DELETE" });
    },
    getDraft: typeof edit.getDraft === "function" ? edit.getDraft.bind(svc) : undefined,
    updateDraft: typeof edit.updateDraft === "function" ? edit.updateDraft.bind(svc) : undefined,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function check(name: string, severity: Severity, problems: string[], ok: string): HarnessCheck {
  return problems.length ? { name, severity, status: "fail", message: problems.join("; ") } : { name, severity, status: "pass", message: ok };
}

/** The ref ids in a stored html part. */
function refIds(html: string): string[] {
  return refMarkers(parse(html, { comment: false })).map((el) => el.text.trim().slice(4).toLowerCase());
}

/** Mutable state one run accumulates. */
interface RunState {
  checks: HarnessCheck[];
  draftId: string | null;
  uuid: string | null;
}

/**
 * Run the harness once.
 *
 * Never throws: a failing step becomes a failed check, and the checks that
 * depended on it become failed (critical path) or skipped (declared). The draft
 * is always deleted afterwards unless `keepDraft`; a failed delete is a failed
 * minor check, so it degrades the verdict instead of hiding.
 *
 * @param gmail - Gmail operations (live, or a test double)
 * @param opts - account, optional plant, keepDraft
 * @returns per-check results and the verdict
 */
export async function runGmailHarness(gmail: HarnessGmail, opts: HarnessOptions): Promise<HarnessReport> {
  const started = Date.now();
  const runId = crypto.randomUUID();
  const state: RunState = { checks: [], draftId: null, uuid: null };

  await exercise(gmail, opts, runId, state);

  if (state.draftId && !opts.keepDraft) {
    try {
      await gmail.deleteDraft(state.draftId);
      state.checks.push({ name: "draft_cleanup", severity: "minor", status: "pass", message: `deleted ${state.draftId}` });
    } catch (e) {
      state.checks.push({ name: "draft_cleanup", severity: "minor", status: "fail", message: `draft ${state.draftId} left behind: ${errorText(e)}` });
    }
  }

  const { checks } = state;
  return {
    runId,
    verdict: aggregateVerdict(checks),
    account: opts.account,
    draftId: state.draftId,
    uuid: state.uuid,
    planted: opts.plant ?? null,
    durationMs: Date.now() - started,
    summary: {
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      skipped: checks.filter((c) => c.status === "skipped").length,
    },
    checks,
  };
}

/** Steps 1–3; pushes into `ctx.checks` and returns early when a later step cannot run. */
async function exercise(gmail: HarnessGmail, opts: HarnessOptions, runId: string, ctx: RunState): Promise<void> {
  const checks = ctx.checks;
  const plant = (s: DraftSnapshot) => (opts.plant ? plantRegression(s, opts.plant) : s);
  // 1. create through the production compose path
  try {
    const created = await gmail.createDraft(opts.account, `[gmail-harness] ${runId}`, {
      markdown: FIXTURE_MARKDOWN,
      attachments: [
        { blob: FIXTURE_PIXEL_PNG_B64, filename: "pixel.png", mimeType: "image/png", as: "inline", contentId: FIXTURE_CID },
        { blob: btoa(`gmail-harness ${runId}\n`), filename: FIXTURE_FILE, mimeType: "text/plain" },
      ],
    });
    ctx.draftId = created.id;
    ctx.uuid = created.uuid;
    checks.push({ name: "draft_create", severity: "critical", status: "pass", message: `draft ${created.id}` });
  } catch (e) {
    checks.push({ name: "draft_create", severity: "critical", status: "fail", message: errorText(e) });
    return;
  }
  const draftId = ctx.draftId;
  const uuid = ctx.uuid;

  // 2. read it back from Gmail and check the standard
  let before: DraftSnapshot;
  try {
    before = plant(await gmail.fetchDraft(draftId));
  } catch (e) {
    checks.push({ name: "draft_fetch", severity: "critical", status: "fail", message: errorText(e) });
    return;
  }
  checks.push({ name: "draft_fetch", severity: "critical", status: "pass", message: `read back ${before.html.length} bytes of html from Gmail` });
  checks.push(...checkStandard(before, { uuid, expect: FIXTURE_EXPECT }));
  checks.push(
    check(
      "file_attachment_present",
      "major",
      before.parts.some((p) => p.filename === FIXTURE_FILE && !p.contentId) ? [] : [`no ${FIXTURE_FILE} attachment part`],
      `${FIXTURE_FILE} attached`,
    ),
  );

  // 3. round-trip get → update (task 86981006082e)
  if (!gmail.getDraft || !gmail.updateDraft) {
    const message = `declared pending: GmailService.getDraft/updateDraft ship in task ${DRAFT_EDIT_TASK}; not deployed on this worker`;
    for (const name of ["draft_get_roundtrip", "draft_update_cc_and_threading", "draft_update_attachments_retained", "draft_update_single_ref"]) {
      checks.push({ name, severity: "major", status: "skipped", message });
    }
    return;
  }

  try {
    const view = await gmail.getDraft(draftId);
    checks.push(
      check(
        "draft_get_roundtrip",
        "major",
        [
          ...(view.uuid?.toLowerCase() === uuid.toLowerCase() ? [] : [`getDraft uuid=${view.uuid} (want ${uuid})`]),
          ...(view.refCount === 1 ? [] : [`getDraft refCount=${view.refCount} (want 1)`]),
        ],
        `getDraft returned uuid ${uuid}, refCount 1`,
      ),
    );
  } catch (e) {
    checks.push({ name: "draft_get_roundtrip", severity: "major", status: "fail", message: errorText(e) });
  }

  let after: DraftSnapshot;
  try {
    // addCc is the user-reported bug path: add a cc to an existing draft in one call.
    await gmail.updateDraft(draftId, { body: { mode: "append", markdown: FIXTURE_APPEND_MARKDOWN }, addCc: [FIXTURE_CC] });
    after = plant(await gmail.fetchDraft(draftId));
  } catch (e) {
    for (const name of ["draft_update_cc_and_threading", "draft_update_attachments_retained", "draft_update_single_ref"]) {
      checks.push({ name, severity: "major", status: "fail", message: `updateDraft failed: ${errorText(e)}` });
    }
    return;
  }

  checks.push(
    check(
      "draft_update_cc_and_threading",
      "major",
      [
        ...((after.headers.cc ?? "").toLowerCase().includes(FIXTURE_CC) ? [] : [`cc header is "${after.headers.cc ?? ""}"`]),
        ...(after.threadId === before.threadId ? [] : [`threadId changed ${before.threadId} → ${after.threadId}`]),
        ...(after.headers.subject === before.headers.subject ? [] : ["subject changed"]),
        ...(after.text.includes("P.S. gmail-harness") ? [] : ["appended text missing"]),
        ...(after.html.indexOf("Hello harness") > -1 ? [] : ["original body lost"]),
      ],
      "cc added; threadId, subject and original body kept; edit appended",
    ),
  );
  checks.push(
    check(
      "draft_update_attachments_retained",
      "major",
      [
        ...(after.parts.some((p) => p.filename === FIXTURE_FILE && !p.contentId) ? [] : [`${FIXTURE_FILE} dropped`]),
        ...(after.parts.some((p) => p.contentId === FIXTURE_CID) ? [] : [`inline part <${FIXTURE_CID}> dropped`]),
        ...(after.html.includes(`cid:${FIXTURE_CID}`) ? [] : [`html lost cid:${FIXTURE_CID}`]),
      ],
      "file attachment and inline cid image retained",
    ),
  );
  const ids = refIds(after.html);
  checks.push(
    check(
      "draft_update_single_ref",
      "major",
      ids.length === 1 && ids[0] === uuid.toLowerCase() ? [] : [`ref ids after update: ${JSON.stringify(ids)} (want ["${uuid}"])`],
      "exactly one ref marker, same uuid",
    ),
  );
  // The edited body must still meet the standard, not just the original.
  for (const c of checkStandard(after, { uuid, expect: FIXTURE_EXPECT })) {
    checks.push({ ...c, name: `after_update.${c.name}` });
  }
  return;
}
