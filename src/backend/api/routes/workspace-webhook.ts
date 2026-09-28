/**
 * @fileoverview Pub/Sub push receiver for Google Workspace Events.
 *
 * Cloud Pub/Sub POSTs `{ message: { data: <base64 CloudEvent>, messageId, attributes } }`
 * to `/api/webhooks/workspace?token=<WORKER_API_KEY>`. The handler:
 *   1. Authenticates with a constant-time compare of the query token
 *   2. Decodes the CloudEvent (structured `data` or `ce-*` attributes)
 *   3. Claims a `drive_notifications` row by CloudEvent / message id
 *      (`onConflictDoNothing` — Pub/Sub retries must not duplicate)
 *   4. Invalidates cached Drive/Docs/Sheets/Slides/Apps Script rows for the file
 *
 * Always returns 2xx quickly so Pub/Sub does not retry a successfully claimed
 * event. D1 insert failures return 500 so Pub/Sub retries.
 *
 * @see {@link decodePubSubPush} for envelope decoding
 * @example
 * POST /api/webhooks/workspace?token=…  → 202
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  googleDocuments,
  driveFolders,
  googleSheets,
  googleSlides,
  appscriptProjects,
  driveNotifications,
} from "@db/schemas";
import type { AppBindings } from "../index";
import { constantTimeEqual } from "@/backend/lib/crypto";
import { getWorkerApiKey } from "@/backend/utils/secrets";
import {
  decodePubSubPush,
  extractDriveResourceId,
  extractEventType,
  notificationIdFor,
} from "@/backend/workspace-events/parse";

export const workspaceWebhookRouter = new OpenAPIHono<AppBindings>();

workspaceWebhookRouter.post("/", async (c) => {
  const expectedKey = await getWorkerApiKey(c.env);
  if (!expectedKey) {
    return c.body("WORKER_API_KEY not configured", 500);
  }
  const token = c.req.query("token") ?? "";
  if (!constantTimeEqual(token, expectedKey)) {
    return c.body("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.body("Bad Request", 400);
  }

  const { event, messageId, attributes, subscription } = decodePubSubPush(body);
  const resourceId = extractDriveResourceId(event, attributes);
  const eventType = extractEventType(event, attributes);
  const id = notificationIdFor(event, messageId, crypto.randomUUID());

  console.log(
    JSON.stringify({
      event: "workspace_webhook_received",
      notificationId: id,
      resourceId,
      type: eventType,
      messageId,
      subscription,
    }),
  );

  const db = getDb(c.env);
  try {
    await db
      .insert(driveNotifications)
      .values({
        id,
        source: "events",
        channelId: subscription ?? null,
        resourceId,
        resourceState: eventType,
        resourceUri: typeof event.subject === "string" ? event.subject : attributes?.["ce-subject"] ?? null,
        messageNumber: messageId ?? null,
        payload: event,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "workspace_webhook_persist_failed",
        notificationId: id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.body("persist failed", 500);
  }

  if (resourceId) {
    try {
      await Promise.allSettled([
        db.delete(googleDocuments).where(eq(googleDocuments.id, resourceId)),
        db.delete(driveFolders).where(eq(driveFolders.id, resourceId)),
        db.delete(googleSheets).where(eq(googleSheets.id, resourceId)),
        db.delete(googleSlides).where(eq(googleSlides.id, resourceId)),
        db.delete(appscriptProjects).where(eq(appscriptProjects.id, resourceId)),
      ]);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "workspace_webhook_cache_invalidate_failed",
          resourceId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return c.body(null, 202);
});
