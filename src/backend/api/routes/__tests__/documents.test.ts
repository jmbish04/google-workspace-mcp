/**
 * @fileoverview Behavioral tests for the collaborative-document REST API.
 *
 * Uses a recording store to prove validated handlers call exactly the intended
 * persistence operation and do not mutate neighboring first-class objects.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import type { DocumentStore } from "@/backend/documents/store";

import { createDocumentsRouter } from "@/backend/api/routes/documents";

const docId = "11111111-1111-4111-8111-111111111111";
const suggestionId = "22222222-2222-4222-8222-222222222222";

function context() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

describe("document API write boundaries", () => {
  it("creates a suggestion with the route doc id and performs no other write", async () => {
    const created = {
      id: suggestionId,
      docId,
      author: "agent",
      anchor: { from: 1, to: 2 },
      proposedChange: { insert: "x" },
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as const;
    const store = {
      createSuggestion: vi.fn().mockResolvedValue(created),
      createDocument: vi.fn(),
      updateDocument: vi.fn(),
      deleteDocument: vi.fn(),
      updateSuggestion: vi.fn(),
      deleteSuggestion: vi.fn(),
      createComment: vi.fn(),
      updateComment: vi.fn(),
      deleteComment: vi.fn(),
    };
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.route(
      "/api/documents",
      createDocumentsRouter(() => store as unknown as DocumentStore),
    );
    const response = await app.fetch(
      new Request(`http://test/api/documents/${docId}/suggestions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: "agent",
          anchor: { from: 1, to: 2 },
          proposedChange: { insert: "x" },
        }),
      }),
      {} as Env,
      context(),
    );
    expect(response.status).toBe(201);
    expect(store.createSuggestion).toHaveBeenCalledOnce();
    expect(store.createSuggestion).toHaveBeenCalledWith({
      docId,
      author: "agent",
      anchor: { from: 1, to: 2 },
      proposedChange: { insert: "x" },
    });
    for (const [name, fn] of Object.entries(store))
      if (name !== "createSuggestion") expect(fn).not.toHaveBeenCalled();
  });

  it("rejects an invalid suggestion before the persistence handler runs", async () => {
    const store = { createSuggestion: vi.fn() };
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.route(
      "/api/documents",
      createDocumentsRouter(() => store as unknown as DocumentStore),
    );
    const response = await app.fetch(
      new Request(`http://test/api/documents/${docId}/suggestions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: "", anchor: {}, proposedChange: {} }),
      }),
      {} as Env,
      context(),
    );
    expect(response.status).toBe(400);
    expect(store.createSuggestion).not.toHaveBeenCalled();
  });
});
