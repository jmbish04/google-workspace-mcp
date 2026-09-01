import { describe, expect, it } from "vitest";
import {
  classifyEventFamily,
  decodePubSubPush,
  extractDriveResourceId,
  extractEventType,
  notificationIdFor,
} from "../parse";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

describe("decodePubSubPush", () => {
  it("decodes a structured CloudEvent from message.data", () => {
    const event = {
      id: "ce-1",
      type: "google.workspace.drive.file.v3.contentChanged",
      subject: "files/FILE123",
    };
    const out = decodePubSubPush({
      message: { data: b64(event), messageId: "m-1" },
      subscription: "projects/p/subscriptions/s",
    });
    expect(out.event).toEqual(event);
    expect(out.messageId).toBe("m-1");
    expect(out.subscription).toBe("projects/p/subscriptions/s");
  });

  it("passes through a raw CloudEvent body", () => {
    const event = { id: "ce-2", type: "google.workspace.drive.comment.v3.created", subject: "files/X" };
    const out = decodePubSubPush(event);
    expect(out.event).toEqual(event);
    expect(out.messageId).toBeUndefined();
  });

  it("returns empty event for null/non-object bodies", () => {
    expect(decodePubSubPush(null).event).toEqual({});
    expect(decodePubSubPush("nope").event).toEqual({});
  });
});

describe("extractDriveResourceId", () => {
  it("parses files/ID subjects", () => {
    expect(extractDriveResourceId({ subject: "files/abc123" })).toBe("abc123");
  });

  it("parses full Drive resource URIs", () => {
    expect(extractDriveResourceId({ subject: "//drive.googleapis.com/files/abc123" })).toBe("abc123");
  });

  it("falls back to data.id", () => {
    expect(extractDriveResourceId({ data: { id: "from-data" } })).toBe("from-data");
  });

  it("reads comment.file_id from Drive comment payloads", () => {
    expect(
      extractDriveResourceId({
        type: "google.workspace.drive.comment.v3.created",
        data: { comment: { id: "c1", file_id: "doc-from-comment" } },
      }),
    ).toBe("doc-from-comment");
  });

  it("reads ce-subject attributes", () => {
    expect(extractDriveResourceId({}, { "ce-subject": "files/attr-id" })).toBe("attr-id");
  });
});

describe("extractEventType + classifyEventFamily", () => {
  it("prefers payload type then ce-type", () => {
    expect(extractEventType({ type: "google.workspace.drive.file.v3.created" })).toContain("created");
    expect(extractEventType({}, { "ce-type": "google.workspace.drive.comment.v3.created" })).toContain("comment");
  });

  it("classifies create / change / comment / delete families", () => {
    expect(classifyEventFamily("google.workspace.drive.file.v3.created")).toBe("create");
    expect(classifyEventFamily("google.workspace.drive.file.v3.added")).toBe("create");
    expect(classifyEventFamily("google.workspace.drive.file.v3.contentChanged")).toBe("change");
    expect(classifyEventFamily("google.workspace.drive.file.v3.renamed")).toBe("change");
    expect(classifyEventFamily("google.workspace.drive.comment.v3.created")).toBe("comment");
    expect(classifyEventFamily("google.workspace.drive.file.v3.trashed")).toBe("delete");
    expect(classifyEventFamily("google.workspace.drive.file.v3.deleted")).toBe("delete");
    expect(classifyEventFamily("something.else")).toBe("other");
  });
});

describe("notificationIdFor", () => {
  it("prefers CloudEvent id, then messageId, then fallback", () => {
    expect(notificationIdFor({ id: "ce" }, "msg", "fb")).toBe("ce");
    expect(notificationIdFor({}, "msg", "fb")).toBe("msg");
    expect(notificationIdFor({}, undefined, "fb")).toBe("fb");
  });
});
