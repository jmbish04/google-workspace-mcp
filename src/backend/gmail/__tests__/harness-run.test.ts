/**
 * @fileoverview `runGmailHarness` end to end against an in-memory Gmail.
 *
 * The fake composes with the REAL `composeBody`, and its `updateDraft` follows
 * the contract (docs/gmail-draft-attachment-transport-contract.md §2): unwrap,
 * append, re-compose with the SAME uuid. So these tests also pin the contract
 * — revert the c2b15af fix in compose.ts and the round-trip goes red.
 *
 * The broken `updateDraft` variants are the mistakes the contract warns about;
 * each must flip its named check and fail the verdict.
 */
import { marked } from "marked";
import { describe, expect, it } from "vitest";

import { composeBody } from "@/backend/gmail/compose";
import type { DraftSnapshot, SnapshotPart } from "@/backend/gmail/harness/checks";
import { FIXTURE_CC } from "@/backend/gmail/harness/fixture";
import { DRAFT_EDIT_TASK, runGmailHarness, type HarnessGmail } from "@/backend/gmail/harness/run";

type UpdateBug = "none" | "new_uuid" | "drop_attachments" | "ignore_cc" | "string_append";

/** An in-memory Gmail whose drafts are built by the production composeBody. */
function fakeGmail(opts: { edit?: boolean; update?: UpdateBug; failCreate?: boolean; failDelete?: boolean } = {}) {
  const drafts = new Map<string, DraftSnapshot & { uuid: string }>();
  const deleted: string[] = [];
  const gmail: HarnessGmail = {
    async createDraft(to, subject, rich) {
      if (opts.failCreate) throw new Error("Google API 403: insufficient scopes");
      const uuid = crypto.randomUUID();
      const { html, text } = composeBody({ markdown: rich.markdown }, { uuid });
      const parts: SnapshotPart[] = (rich.attachments ?? []).map((a) => ({
        mimeType: "mimeType" in a && a.mimeType ? a.mimeType : "application/octet-stream",
        ...("filename" in a ? { filename: a.filename } : {}),
        ...(a.as === "inline" ? { contentId: a.contentId, disposition: "inline" } : { disposition: "attachment" }),
      }));
      drafts.set("d1", { html, text, uuid, headers: { from: '"Justin Bishop" <me@example.com>', to, subject }, parts, threadId: "thr-1" });
      return { id: "d1", uuid };
    },
    async fetchDraft(id) {
      const d = drafts.get(id);
      if (!d) throw new Error("Google API 404");
      return structuredClone(d);
    },
    async deleteDraft(id) {
      if (opts.failDelete) throw new Error("Google API 500");
      deleted.push(id);
      drafts.delete(id);
    },
  };
  if (opts.edit) {
    gmail.getDraft = async (id) => {
      const d = drafts.get(id)!;
      return { draftId: id, uuid: d.uuid, refCount: (d.html.match(/ref:[0-9a-f-]{36}/gi) ?? []).length };
    };
    gmail.updateDraft = async (id, u) => {
      const d = drafts.get(id)!;
      const bug = opts.update ?? "none";
      const inner = d.html.replace(/^<div dir="ltr"[^>]*>/, "").replace(/<\/div>$/, "");
      const body = u.body as { mode: string; markdown: string };
      expect(body.mode).toBe("append");
      const fragment = marked.parse(body.markdown, { async: false, gfm: true, breaks: true }) as string;
      const uuid = bug === "new_uuid" ? crypto.randomUUID() : d.uuid;
      const source = bug === "string_append" ? d.html + fragment : inner + fragment;
      const { html, text } = composeBody({ html: source }, { uuid });
      drafts.set(id, {
        ...d,
        html,
        text,
        uuid,
        headers: bug === "ignore_cc" ? d.headers : { ...d.headers, cc: (u.addCc as string[]).join(", ") },
        parts: bug === "drop_attachments" ? [] : d.parts,
      });
      return { draftId: id, uuid };
    };
  }
  return { gmail, deleted };
}

const ACCOUNT = "me@example.com";
const byName = (r: Awaited<ReturnType<typeof runGmailHarness>>, name: string) => r.checks.find((c) => c.name === name);

describe("runGmailHarness — before task 86981006082e is deployed", () => {
  it("passes the standard but reports the round-trip as declared-skipped, so the verdict is incomplete", async () => {
    const { gmail, deleted } = fakeGmail();
    const r = await runGmailHarness(gmail, { account: ACCOUNT });
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    const skipped = r.checks.filter((c) => c.status === "skipped");
    expect(skipped.map((c) => c.name)).toEqual([
      "draft_get_roundtrip",
      "draft_update_cc_and_threading",
      "draft_update_attachments_retained",
      "draft_update_single_ref",
    ]);
    for (const s of skipped) expect(s.message).toContain(DRAFT_EDIT_TASK);
    expect(r.verdict).toBe("incomplete");
    expect(deleted).toEqual(["d1"]);
    expect(byName(r, "draft_cleanup")?.status).toBe("pass");
  });
});

describe("runGmailHarness — with a contract-correct getDraft/updateDraft", () => {
  it("passes every check, including the standard re-checked after the edit", async () => {
    const { gmail } = fakeGmail({ edit: true });
    const r = await runGmailHarness(gmail, { account: ACCOUNT });
    expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(r.checks.some((c) => c.name === "after_update.single_ref_marker")).toBe(true);
    expect(r.verdict).toBe("pass");
    expect(r.summary).toEqual({ pass: r.checks.length, fail: 0, skipped: 0 });
  });

  it("a planted regression fails the run on the same path the live route takes", async () => {
    const { gmail } = fakeGmail({ edit: true });
    const r = await runGmailHarness(gmail, { account: ACCOUNT, plant: "visible_ref" });
    expect(r.planted).toBe("visible_ref");
    expect(byName(r, "single_ref_marker")?.status).toBe("fail");
    expect(r.verdict).toBe("fail");
  });
});

describe("runGmailHarness — the update mistakes the contract warns about", () => {
  const cases: Array<[UpdateBug, string]> = [
    ["new_uuid", "draft_update_single_ref"],
    ["drop_attachments", "draft_update_attachments_retained"],
    ["ignore_cc", "draft_update_cc_and_threading"],
    // The old wrapper collapses into an empty leading <p>: a blank 16px gap above the body.
    ["string_append", "after_update.paragraph_spacing_16px"],
  ];
  for (const [bug, check] of cases) {
    it(`${bug} → ${check} fails and the verdict is fail`, async () => {
      const { gmail } = fakeGmail({ edit: true, update: bug });
      const r = await runGmailHarness(gmail, { account: ACCOUNT });
      expect(byName(r, check)?.status).toBe("fail");
      expect(r.verdict).toBe("fail");
    });
  }

  it("the cc the round-trip adds is the reserved example.com address", () => {
    expect(FIXTURE_CC.endsWith("@example.com")).toBe(true);
  });
});

describe("runGmailHarness — infrastructure failures change the verdict, never throw", () => {
  it("a create failure is a failed critical check", async () => {
    const { gmail } = fakeGmail({ failCreate: true });
    const r = await runGmailHarness(gmail, { account: ACCOUNT });
    expect(byName(r, "draft_create")).toMatchObject({ severity: "critical", status: "fail" });
    expect(r.verdict).toBe("fail");
    expect(r.draftId).toBeNull();
  });

  it("a cleanup failure degrades a passing run and names the leftover draft", async () => {
    const { gmail } = fakeGmail({ edit: true, failDelete: true });
    const r = await runGmailHarness(gmail, { account: ACCOUNT });
    expect(byName(r, "draft_cleanup")).toMatchObject({ severity: "minor", status: "fail" });
    expect(byName(r, "draft_cleanup")?.message).toContain("d1");
    expect(r.verdict).toBe("degraded");
  });

  it("keepDraft leaves the draft and records no cleanup", async () => {
    const { gmail, deleted } = fakeGmail({ edit: true });
    const r = await runGmailHarness(gmail, { account: ACCOUNT, keepDraft: true });
    expect(deleted).toEqual([]);
    expect(byName(r, "draft_cleanup")).toBeUndefined();
    expect(r.verdict).toBe("pass");
  });
});
