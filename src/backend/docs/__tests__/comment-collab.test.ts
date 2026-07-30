import { describe, expect, it } from "vitest";

import type { DriveComment } from "@/backend/google";
import {
  AGENT_REPLY_MARKER,
  parseDecision,
  renderThread,
  selectActionableThreads,
  sliceContext,
} from "@/backend/docs/comment-collab";

const CALL = "@colby-app";
const STANDBY = "@colby-app standby, mcp tool handling";

function comment(over: Partial<DriveComment>): DriveComment {
  return { id: "c1", content: "", ...over };
}

describe("selectActionableThreads", () => {
  it("selects an unanswered tagged open thread", () => {
    const out = selectActionableThreads(
      [comment({ content: "@colby-app tighten this", quotedFileContent: { value: "the text" } })],
      CALL,
      STANDBY,
    );
    expect(out).toHaveLength(1);
    expect(out[0].quoted).toBe("the text");
  });

  it("ignores comments without the call sign", () => {
    expect(selectActionableThreads([comment({ content: "just a note" })], CALL, STANDBY)).toHaveLength(0);
  });

  it("ignores resolved threads", () => {
    expect(
      selectActionableThreads([comment({ content: "@colby-app fix", resolved: true })], CALL, STANDBY),
    ).toHaveLength(0);
  });

  it("backs off when an MCP tool has claimed the thread", () => {
    const c = comment({
      content: "@colby-app fix",
      replies: [{ id: "r1", content: STANDBY }],
    });
    expect(selectActionableThreads([c], CALL, STANDBY)).toHaveLength(0);
  });

  it("skips a thread whose last reply is the agent (waiting on human)", () => {
    const c = comment({
      content: "@colby-app fix",
      replies: [{ id: "r1", content: `${AGENT_REPLY_MARKER} here are notes` }],
    });
    expect(selectActionableThreads([c], CALL, STANDBY)).toHaveLength(0);
  });

  it("re-engages once the human replies after the agent", () => {
    const c = comment({
      content: "@colby-app fix",
      replies: [
        { id: "r1", content: `${AGENT_REPLY_MARKER} propose X` },
        { id: "r2", content: "approved, go ahead" },
      ],
    });
    expect(selectActionableThreads([c], CALL, STANDBY)).toHaveLength(1);
  });

  it("matches the call sign case-insensitively", () => {
    const c = comment({ content: "@Colby-App please review" });
    expect(selectActionableThreads([c], CALL, STANDBY)).toHaveLength(1);
  });
});

describe("sliceContext", () => {
  it("returns surrounding text around the highlight", () => {
    const doc = "AAA highlight BBB";
    const { before, after } = sliceContext(doc, "highlight");
    expect(before).toBe("AAA ");
    expect(after).toBe(" BBB");
  });

  it("returns empty strings when the highlight is missing", () => {
    expect(sliceContext("nothing here", "absent")).toEqual({ before: "", after: "" });
  });
});

describe("parseDecision", () => {
  it("parses a fenced JSON object", () => {
    const d = parseDecision('```json\n{"type":"APPLY","replyMessage":"done","replacementText":"new"}\n```');
    expect(d).toEqual({ type: "APPLY", replyMessage: "done", replacementText: "new" });
  });

  it("rejects an unknown type", () => {
    expect(parseDecision('{"type":"NOPE","replyMessage":"x"}')).toBeNull();
  });

  it("returns null on non-JSON", () => {
    expect(parseDecision("I could not decide.")).toBeNull();
  });
});

describe("renderThread", () => {
  it("labels agent vs user turns", () => {
    const c = comment({
      content: "@colby-app fix",
      replies: [{ id: "r1", content: `${AGENT_REPLY_MARKER} ok` }],
    });
    expect(renderThread(c)).toBe(`USER: @colby-app fix\nAGENT: ${AGENT_REPLY_MARKER} ok`);
  });
});
