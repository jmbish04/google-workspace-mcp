import { describe, it, expect } from "vitest";

import { auditSharing, isAnyoneWithLink } from "../sharing-audit";
import { FOLDER_MIME, type DriveNode } from "@/backend/mcp/services/drive";

const file = (id: string, perms: DriveNode["permissions"] = []): DriveNode => ({
  id,
  name: `file-${id}`,
  mimeType: "application/pdf",
  permissions: perms,
});
const folder = (id: string, perms: DriveNode["permissions"] = []): DriveNode => ({
  id,
  name: `folder-${id}`,
  mimeType: FOLDER_MIME,
  permissions: perms,
});

describe("isAnyoneWithLink", () => {
  it("is true only for type=anyone", () => {
    expect(isAnyoneWithLink({ id: "p", type: "anyone", role: "reader" })).toBe(true);
    expect(isAnyoneWithLink({ id: "p", type: "user", role: "reader", emailAddress: "a@b.com" })).toBe(false);
  });
});

describe("auditSharing", () => {
  it("counts files vs folders", () => {
    const r = auditSharing("root", [file("1"), file("2"), folder("3")], false);
    expect(r.scannedFiles).toBe(2);
    expect(r.scannedFolders).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("counts anyone-with-link shared vs not", () => {
    const nodes = [
      file("1", [{ id: "p1", type: "anyone", role: "reader", allowFileDiscovery: false }]),
      file("2", [{ id: "p2", type: "user", role: "writer", emailAddress: "x@y.com" }]),
      folder("3", [{ id: "p3", type: "anyone", role: "commenter" }]),
    ];
    const r = auditSharing("root", nodes, false);
    expect(r.anyoneWithLink.sharedCount).toBe(2);
    expect(r.anyoneWithLink.notSharedCount).toBe(1);
    expect(r.anyoneWithLink.sample[0]).toMatchObject({ id: "1", role: "reader", discoverable: false });
  });

  it("reports per-account shared/not-shared (case-insensitive)", () => {
    const nodes = [
      file("1", [{ id: "p1", type: "user", role: "reader", emailAddress: "Justin@126colby.com" }]),
      file("2", [{ id: "p2", type: "user", role: "reader", emailAddress: "other@x.com" }]),
      file("3", []),
    ];
    const r = auditSharing("root", nodes, false, ["justin@126colby.com"]);
    const stat = r.accounts.find((a) => a.email === "justin@126colby.com");
    expect(stat).toBeDefined();
    expect(stat?.sharedCount).toBe(1);
    expect(stat?.notSharedCount).toBe(2);
    expect(stat?.sharedSample).toEqual(["1"]);
  });

  it("returns no account stats when auditEmails omitted", () => {
    const r = auditSharing("root", [file("1")], false);
    expect(r.accounts).toEqual([]);
  });

  it("propagates the truncated flag", () => {
    const r = auditSharing("root", [file("1")], true);
    expect(r.truncated).toBe(true);
  });
});
