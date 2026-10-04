/**
 * @fileoverview Health endpoint for the Yjs collaboration provider.
 *
 * WebSocket upgrades are proxied in the Worker entrypoint because the generic
 * Agents SDK upgrade router otherwise captures them. This OpenAPI route probes
 * the Durable Object binding itself and emits mirrored operational telemetry.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AppBindings } from "@/backend/api";
import type { DocumentCollaborationRoom } from "@/backend/documents/collaboration-room";

import { recordDocumentOperation } from "@/backend/documents/telemetry";

/** OpenAPI router for collaboration service health. */
export const collaborationRouter = new OpenAPIHono<AppBindings>();

collaborationRouter.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["Document collaboration"],
    summary: "Yjs collaboration provider health",
    operationId: "collaborationHealth",
    responses: {
      200: {
        description: "Provider ready.",
        content: {
          "application/json": {
            schema: z.object({
              status: z.literal("ok"),
              protocol: z.literal("y-websocket"),
              connections: z.number(),
              updates: z.number(),
            }),
          },
        },
      },
      503: {
        description: "Provider unavailable.",
        content: { "application/json": { schema: z.object({ status: z.literal("error") }) } },
      },
    },
  }),
  async (c) => {
    const start = Date.now();
    try {
      const room = c.env.DOCUMENT_COLLABORATION.getByName(
        "__health__",
      ) as DurableObjectStub<DocumentCollaborationRoom>;
      const result = await room.health();
      recordDocumentOperation(
        c.env,
        c.executionCtx,
        "collaboration_health",
        true,
        Date.now() - start,
      );
      return c.json({ ...result, protocol: "y-websocket" as const }, 200);
    } catch {
      recordDocumentOperation(
        c.env,
        c.executionCtx,
        "collaboration_health",
        false,
        Date.now() - start,
      );
      return c.json({ status: "error" as const }, 503);
    }
  },
);
