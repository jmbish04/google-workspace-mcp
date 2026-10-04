/**
 * @fileoverview OpenAPI REST routes for documents, suggestions, and comments.
 *
 * All request bodies are derived from the Postgres Drizzle tables with
 * drizzle-zod. The routes use Hyperdrive, emit structured telemetry mirrored
 * to D1, and expose a service-specific health endpoint.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AppBindings } from "@/backend/api";

import {
  insertCommentSchema,
  insertDocumentSchema,
  insertSuggestionSchema,
  selectCommentSchema,
  selectDocumentSchema,
  selectSuggestionSchema,
  updateCommentSchema,
  updateDocumentSchema,
  updateSuggestionSchema,
} from "@/backend/db/schemas/documents";
import { DocumentStore } from "@/backend/documents/store";
import { recordDocumentOperation } from "@/backend/documents/telemetry";

const idParam = z.object({ id: z.string().uuid() });
const docIdParam = z.object({ docId: z.string().uuid() });
const notFound = z.object({ error: z.string() });
const deleted = z.object({ ok: z.literal(true) });
const jsonObject = z.record(z.string(), z.unknown());

const createDocument = insertDocumentSchema
  .omit({ id: true, revision: true, createdAt: true, updatedAt: true })
  .extend({ owner: z.string().min(1), title: z.string().min(1), content: jsonObject });
const patchDocument = updateDocumentSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ content: jsonObject.optional(), revision: z.number().int().positive().optional() });
const createSuggestion = insertSuggestionSchema
  .omit({ id: true, docId: true, status: true, createdAt: true, updatedAt: true })
  .extend({ author: z.string().min(1), anchor: jsonObject, proposedChange: jsonObject });
const patchSuggestion = updateSuggestionSchema
  .omit({ id: true, docId: true, createdAt: true, updatedAt: true })
  .extend({
    anchor: jsonObject.optional(),
    proposedChange: jsonObject.optional(),
    status: z.enum(["pending", "accepted", "rejected"]).optional(),
  });
const createComment = insertCommentSchema
  .omit({ id: true, docId: true, threadId: true, createdAt: true, updatedAt: true })
  .extend({
    author: z.string().min(1),
    anchor: jsonObject,
    body: z.string().min(1),
    threadId: z.string().uuid().optional(),
    parentId: z.string().uuid().nullable().optional(),
  });
const patchComment = updateCommentSchema
  .omit({ id: true, docId: true, createdAt: true, updatedAt: true })
  .extend({
    anchor: jsonObject.optional(),
    body: z.string().min(1).optional(),
    threadId: z.string().uuid().optional(),
    parentId: z.string().uuid().nullable().optional(),
    resolved: z.boolean().optional(),
  });

const documentList = z.object({ data: z.array(selectDocumentSchema) });
const suggestionList = z.object({ data: z.array(selectSuggestionSchema) });
const commentList = z.object({ data: z.array(selectCommentSchema) });

type Store = DocumentStore;
type StoreFactory = (env: Env) => Store;

/**
 * Create the document router, optionally with a test store factory.
 * @param makeStore - Constructs a persistence facade for the request.
 * @returns An OpenAPI Hono router.
 * @example `app.route('/api/documents', createDocumentsRouter())`
 */
export function createDocumentsRouter(makeStore: StoreFactory = (env) => new DocumentStore(env)) {
  const router = new OpenAPIHono<AppBindings>();
  router.use("*", async (c, next) => {
    const start = Date.now();
    let success = false;
    try {
      await next();
      success = c.res.status < 500;
    } finally {
      recordDocumentOperation(
        c.env,
        c.executionCtx,
        `${c.req.method.toLowerCase()} ${c.req.path}`,
        success,
        Date.now() - start,
        { status: c.res.status },
      );
    }
  });
  const responses = (schema: z.ZodType) =>
    ({
      200: { description: "Success.", content: { "application/json": { schema } } },
      404: { description: "Not found.", content: { "application/json": { schema: notFound } } },
    }) as const;

  router.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags: ["Documents"],
      summary: "Document persistence health",
      operationId: "documentsHealth",
      responses: {
        200: {
          description: "Postgres reachable.",
          content: {
            "application/json": {
              schema: z.object({
                status: z.literal("ok"),
                service: z.literal("document-persistence"),
              }),
            },
          },
        },
        503: {
          description: "Postgres unavailable.",
          content: {
            "application/json": {
              schema: z.object({
                status: z.literal("error"),
                service: z.literal("document-persistence"),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const start = Date.now();
      try {
        await makeStore(c.env).health();
        recordDocumentOperation(c.env, c.executionCtx, "health", true, Date.now() - start);
        return c.json({ status: "ok" as const, service: "document-persistence" as const }, 200);
      } catch {
        recordDocumentOperation(c.env, c.executionCtx, "health", false, Date.now() - start);
        return c.json({ status: "error" as const, service: "document-persistence" as const }, 503);
      }
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["Documents"],
      summary: "List documents",
      operationId: "documentsList",
      request: { query: z.object({ owner: z.string().optional() }) },
      responses: {
        200: {
          description: "Documents.",
          content: { "application/json": { schema: documentList } },
        },
      },
    }),
    async (c) =>
      c.json({ data: await makeStore(c.env).listDocuments(c.req.valid("query").owner) }, 200),
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["Documents"],
      summary: "Create document",
      operationId: "documentsCreate",
      request: { body: { content: { "application/json": { schema: createDocument } } } },
      responses: {
        201: {
          description: "Created.",
          content: { "application/json": { schema: selectDocumentSchema } },
        },
      },
    }),
    async (c) => c.json(await makeStore(c.env).createDocument(c.req.valid("json")), 201),
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["Documents"],
      summary: "Get document",
      operationId: "documentsGet",
      request: { params: idParam },
      responses: responses(selectDocumentSchema),
    }),
    async (c) => {
      const row = await makeStore(c.env).getDocument(c.req.valid("param").id);
      return row ? c.json(row, 200) : c.json({ error: "Document not found." }, 404);
    },
  );
  router.openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: ["Documents"],
      summary: "Update document",
      operationId: "documentsUpdate",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: patchDocument } } },
      },
      responses: responses(selectDocumentSchema),
    }),
    async (c) => {
      const row = await makeStore(c.env).updateDocument(
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return row ? c.json(row, 200) : c.json({ error: "Document not found." }, 404);
    },
  );
  router.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["Documents"],
      summary: "Delete document",
      operationId: "documentsDelete",
      request: { params: idParam },
      responses: {
        200: { description: "Deleted.", content: { "application/json": { schema: deleted } } },
        404: { description: "Not found.", content: { "application/json": { schema: notFound } } },
      },
    }),
    async (c) =>
      (await makeStore(c.env).deleteDocument(c.req.valid("param").id))
        ? c.json({ ok: true as const }, 200)
        : c.json({ error: "Document not found." }, 404),
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/{docId}/suggestions",
      tags: ["Document suggestions"],
      summary: "List suggestions",
      operationId: "suggestionsList",
      request: {
        params: docIdParam,
        query: z.object({ status: z.enum(["pending", "accepted", "rejected"]).optional() }),
      },
      responses: {
        200: {
          description: "Suggestions.",
          content: { "application/json": { schema: suggestionList } },
        },
      },
    }),
    async (c) => {
      const { docId } = c.req.valid("param");
      return c.json(
        { data: await makeStore(c.env).listSuggestions(docId, c.req.valid("query").status) },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/{docId}/suggestions",
      tags: ["Document suggestions"],
      summary: "Create suggestion",
      operationId: "suggestionsCreate",
      request: {
        params: docIdParam,
        body: { content: { "application/json": { schema: createSuggestion } } },
      },
      responses: {
        201: {
          description: "Created.",
          content: { "application/json": { schema: selectSuggestionSchema } },
        },
      },
    }),
    async (c) =>
      c.json(
        await makeStore(c.env).createSuggestion({
          ...c.req.valid("json"),
          docId: c.req.valid("param").docId,
        }),
        201,
      ),
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/suggestions/{id}",
      tags: ["Document suggestions"],
      summary: "Get suggestion",
      operationId: "suggestionsGet",
      request: { params: idParam },
      responses: responses(selectSuggestionSchema),
    }),
    async (c) => {
      const row = await makeStore(c.env).getSuggestion(c.req.valid("param").id);
      return row ? c.json(row, 200) : c.json({ error: "Suggestion not found." }, 404);
    },
  );
  router.openapi(
    createRoute({
      method: "patch",
      path: "/suggestions/{id}",
      tags: ["Document suggestions"],
      summary: "Update suggestion",
      operationId: "suggestionsUpdate",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: patchSuggestion } } },
      },
      responses: responses(selectSuggestionSchema),
    }),
    async (c) => {
      const row = await makeStore(c.env).updateSuggestion(
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return row ? c.json(row, 200) : c.json({ error: "Suggestion not found." }, 404);
    },
  );
  router.openapi(
    createRoute({
      method: "delete",
      path: "/suggestions/{id}",
      tags: ["Document suggestions"],
      summary: "Delete suggestion",
      operationId: "suggestionsDelete",
      request: { params: idParam },
      responses: {
        200: { description: "Deleted.", content: { "application/json": { schema: deleted } } },
        404: { description: "Not found.", content: { "application/json": { schema: notFound } } },
      },
    }),
    async (c) =>
      (await makeStore(c.env).deleteSuggestion(c.req.valid("param").id))
        ? c.json({ ok: true as const }, 200)
        : c.json({ error: "Suggestion not found." }, 404),
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/{docId}/comments",
      tags: ["Document comments"],
      summary: "List comments",
      operationId: "documentCommentsList",
      request: {
        params: docIdParam,
        query: z.object({ resolved: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        200: { description: "Comments.", content: { "application/json": { schema: commentList } } },
      },
    }),
    async (c) => {
      const { docId } = c.req.valid("param");
      const value = c.req.valid("query").resolved;
      return c.json(
        {
          data: await makeStore(c.env).listComments(
            docId,
            value === undefined ? undefined : value === "true",
          ),
        },
        200,
      );
    },
  );
  router.openapi(
    createRoute({
      method: "post",
      path: "/{docId}/comments",
      tags: ["Document comments"],
      summary: "Create comment",
      operationId: "documentCommentsCreate",
      request: {
        params: docIdParam,
        body: { content: { "application/json": { schema: createComment } } },
      },
      responses: {
        201: {
          description: "Created.",
          content: { "application/json": { schema: selectCommentSchema } },
        },
      },
    }),
    async (c) =>
      c.json(
        await makeStore(c.env).createComment({
          ...c.req.valid("json"),
          docId: c.req.valid("param").docId,
        }),
        201,
      ),
  );
  router.openapi(
    createRoute({
      method: "get",
      path: "/comments/{id}",
      tags: ["Document comments"],
      summary: "Get comment",
      operationId: "documentCommentsGet",
      request: { params: idParam },
      responses: responses(selectCommentSchema),
    }),
    async (c) => {
      const row = await makeStore(c.env).getComment(c.req.valid("param").id);
      return row ? c.json(row, 200) : c.json({ error: "Comment not found." }, 404);
    },
  );
  router.openapi(
    createRoute({
      method: "patch",
      path: "/comments/{id}",
      tags: ["Document comments"],
      summary: "Update comment",
      operationId: "documentCommentsUpdate",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: patchComment } } },
      },
      responses: responses(selectCommentSchema),
    }),
    async (c) => {
      const row = await makeStore(c.env).updateComment(
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return row ? c.json(row, 200) : c.json({ error: "Comment not found." }, 404);
    },
  );
  router.openapi(
    createRoute({
      method: "delete",
      path: "/comments/{id}",
      tags: ["Document comments"],
      summary: "Delete comment",
      operationId: "documentCommentsDelete",
      request: { params: idParam },
      responses: {
        200: { description: "Deleted.", content: { "application/json": { schema: deleted } } },
        404: { description: "Not found.", content: { "application/json": { schema: notFound } } },
      },
    }),
    async (c) =>
      (await makeStore(c.env).deleteComment(c.req.valid("param").id))
        ? c.json({ ok: true as const }, 200)
        : c.json({ error: "Comment not found." }, 404),
  );
  return router;
}

/** Default production document router. */
export const documentsRouter = createDocumentsRouter();
