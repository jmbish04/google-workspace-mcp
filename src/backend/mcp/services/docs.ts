import { googleJson } from "../googleClient";
import { extractGoogleId } from "@/backend/google/core/ids";

export type GoogleDoc = { documentId: string; title: string };

/**
 * `writeControl` of a batchUpdate. Google accepts at most one of
 * `requiredRevisionId` / `targetRevisionId`. `writeMode: "SUGGEST"` applies the
 * batch as suggestions (Google Developer Preview).
 */
export type DocsWriteControl = {
  requiredRevisionId?: string;
  targetRevisionId?: string;
  writeMode?: "EDIT" | "SUGGEST";
};

/** The batchUpdate response fields the engine reads. */
export type BatchUpdateResponse = {
  documentId?: string;
  replies?: unknown[];
  writeControl?: { requiredRevisionId?: string; targetRevisionId?: string };
};

const BASE = "https://docs.googleapis.com/v1/documents";

export class DocsService {
  constructor(private env: Env, private sub: string) {}

  async get(documentId: string): Promise<GoogleDoc> {
    return googleJson<GoogleDoc>(this.env, this.sub, `${BASE}/${extractGoogleId(documentId)}`);
  }

  /**
   * Fetch the full raw Docs JSON ("braille"), tab-aware. Hardcodes
   * `includeTabsContent=true` so every tab is visible — otherwise the API
   * returns only the first tab in the legacy root `body`. Accepts a bare doc ID
   * or any Docs URL (normalized via {@link extractGoogleId}).
   */
  async getRaw<T = unknown>(documentId: string): Promise<T> {
    return googleJson<T>(this.env, this.sub, `${BASE}/${extractGoogleId(documentId)}?includeTabsContent=true`);
  }

  /**
   * Run an arbitrary array of Docs API requests atomically (the full grammar).
   *
   * @param documentId - bare doc ID or any Docs URL
   * @param requests - Docs API request objects, applied in order
   * @param writeControl - optional optimistic-concurrency guard. Pass the
   *   `revisionId` read from {@link getRaw} as `requiredRevisionId` and the API
   *   rejects the batch if the document changed in between, instead of applying
   *   indices computed against content that has since moved. `targetRevisionId`
   *   and `writeMode` are passed through as given. Omit it (or pass an object
   *   with no fields set) and the body stays a bare `{ requests }`.
   * @returns the batchUpdate response
   */
  async batchUpdate<T = unknown>(
    documentId: string,
    requests: unknown[],
    writeControl?: DocsWriteControl,
  ): Promise<T> {
    const wc = writeControl
      ? Object.fromEntries(Object.entries(writeControl).filter(([, v]) => v !== undefined && v !== ""))
      : {};
    return googleJson<T>(this.env, this.sub, `${BASE}/${extractGoogleId(documentId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify(Object.keys(wc).length ? { requests, writeControl: wc } : { requests }),
    });
  }

  async create(title: string): Promise<GoogleDoc> {
    return googleJson<GoogleDoc>(this.env, this.sub, BASE, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  async insertText(documentId: string, text: string, index = 1): Promise<void> {
    await googleJson(this.env, this.sub, `${BASE}/${extractGoogleId(documentId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ insertText: { location: { index }, text } }],
      }),
    });
  }

  async replaceText(documentId: string, find: string, replace: string, matchCase = false): Promise<void> {
    await googleJson(this.env, this.sub, `${BASE}/${extractGoogleId(documentId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } }],
      }),
    });
  }

  async insertImage(documentId: string, uri: string, index = 1): Promise<void> {
    await googleJson(this.env, this.sub, `${BASE}/${extractGoogleId(documentId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ insertInlineImage: { uri, location: { index } } }],
      }),
    });
  }
}
