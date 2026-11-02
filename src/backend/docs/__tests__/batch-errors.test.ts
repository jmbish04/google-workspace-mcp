import { describe, expect, it } from "vitest";

import { classifyBatchError } from "@/backend/docs/batch-errors";
import { GoogleApiError } from "@/backend/mcp/googleClient";

/** Build the GoogleApiError that googleFetch throws for a non-2xx batchUpdate. */
function googleError(status: number, error: { status?: string; message: string }): GoogleApiError {
  return new GoogleApiError(status, JSON.stringify({ error: { code: status, ...error } }));
}

describe("classifyBatchError", () => {
  it("maps a stale requiredRevisionId (FAILED_PRECONDITION) to REVISION_CONFLICT", () => {
    const err = googleError(400, {
      status: "FAILED_PRECONDITION",
      message: "The required revision ID 'ALm37BW' does not match the latest revision.",
    });
    const out = classifyBatchError(err, { requestCount: 3 })!;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("REVISION_CONFLICT");
    expect(out.message).toBe("The document changed after your read. Read it again and rebuild the requests.");
    expect(out.googleMessage).toContain("does not match the latest revision");
    expect(out.requestIndex).toBeUndefined();
  });

  it("keeps Google's text and the failing request index for an invalid index", () => {
    const err = googleError(400, {
      status: "INVALID_ARGUMENT",
      message: "Invalid requests[7].insertText: Index 50 must be less than the end index of the referenced segment, 12.",
    });
    const out = classifyBatchError(err, { requestCount: 9 })!;
    expect(out.code).toBe("INVALID_REQUEST");
    expect(out.requestIndex).toBe(7);
    expect(out.requestType).toBe("insertText");
    expect(out.googleMessage).toBe(
      "Invalid requests[7].insertText: Index 50 must be less than the end index of the referenced segment, 12.",
    );
    expect(out.message).toContain("requests[7]");
    expect(out.message).toContain("Index 50 must be less than");
  });

  it("names an unknown request type and keeps its index", () => {
    const err = googleError(400, {
      status: "INVALID_ARGUMENT",
      message: "Invalid JSON payload received. Unknown name \"insertBanana\" at 'requests[2]': Cannot find field.",
    });
    const out = classifyBatchError(err, { requestCount: 4 })!;
    expect(out.code).toBe("UNKNOWN_REQUEST_TYPE");
    expect(out.requestIndex).toBe(2);
    expect(out.requestType).toBe("insertBanana");
    expect(out.googleMessage).toContain("Unknown name \"insertBanana\"");
  });

  it("reports a refused writeMode instead of a generic error", () => {
    const err = googleError(400, {
      status: "INVALID_ARGUMENT",
      message: "Invalid value at 'write_control.write_mode' (type.googleapis.com/google.apps.docs.v1.WriteControl.WriteMode), \"SUGGEST\"",
    });
    const out = classifyBatchError(err, { requestCount: 1, writeMode: "SUGGEST" })!;
    expect(out.code).toBe("WRITE_MODE_REFUSED");
    expect(out.message).toMatch(/writeMode SUGGEST/);
    expect(out.googleMessage).toContain("write_control.write_mode");
  });

  it("adds a writeMode hint to any other failure of a SUGGEST batch", () => {
    const err = googleError(403, { status: "PERMISSION_DENIED", message: "The caller does not have permission" });
    const out = classifyBatchError(err, { requestCount: 1, writeMode: "SUGGEST" })!;
    expect(out.code).toBe("GOOGLE_ERROR");
    expect(out.hint).toMatch(/Developer Preview/);
    expect(out.googleMessage).toBe("The caller does not have permission");
  });

  it("keeps the raw body text when Google's body is not JSON", () => {
    const out = classifyBatchError(new GoogleApiError(502, "<html>Bad Gateway</html>"), { requestCount: 1 })!;
    expect(out.code).toBe("GOOGLE_ERROR");
    expect(out.status).toBe(502);
    expect(out.googleMessage).toBe("<html>Bad Gateway</html>");
  });

  it("returns null for an error that did not come from Google", () => {
    expect(classifyBatchError(new Error("network down"), { requestCount: 1 })).toBeNull();
  });
});
