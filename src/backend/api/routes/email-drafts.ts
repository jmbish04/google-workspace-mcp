/**
 * @fileoverview `/api/email-drafts` — the draft studio's REST + WebSocket
 * surface, backing `/gws/draft-studio`.
 *
 * The page reads a draft with its full revision history and comments, pushes a
 * human edit as a new revision, leaves comments on a highlighted passage, and
 * finally promotes the draft to Gmail or sends it. `GET /:id/ws` upgrades to
 * the draft's Durable Object room so an agent-pushed revision appears without
 * a refresh.
 *
 * Auth: the whole router is gated in `api/index.ts` by `agentAuthMiddleware`
 * (the `gsuite_session` cookie OR `Authorization: Bearer`), the same credential
 * the frontend and every other feature surface uses — a draft body is private
 * mail, not public template content. (It previously gated on the unrelated
 * `cr_session` admin cookie, which no browser session ever carried, so every
 * call 401'd and the "New draft" button did nothing.)
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import {
  addComment,
  addRevision,
  createStudioDraft,
  getStudioDraft,
  listStudioDrafts,
  promoteStudioDraft,
  resolveComments,
  sendStudioDraft,
  setDraftStatus,
  updateDraftFields,
} from "@/backend/gmail/draft-studio";
import { suggestDraftRevision } from "@/backend/gmail/draft-suggest";
import { EMAIL_DRAFT_STATUSES } from "@db/schemas";

import type { AppBindings } from "../index";

export const emailDraftsRouter = new OpenAPIHono<AppBindings>();

const bodySchema = z.object({
  markdown: z.string().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  // A Tiptap document (ProseMirror JSON) from the draft-studio editor.
  doc: z
    .object({
      type: z.literal("doc"),
      content: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
});

const envelopeSchema = z.object({
  account: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  replyToMessageId: z.string().optional(),
  threadId: z.string().optional(),
});

/** GET / — drafts, newest-updated first. `?status=drafting,in_gmail` filters. */
emailDraftsRouter.get("/", async (c) => {
  const raw = c.req.query("status");
  const status = raw
    ? raw.split(",").filter((s): s is (typeof EMAIL_DRAFT_STATUSES)[number] =>
        (EMAIL_DRAFT_STATUSES as readonly string[]).includes(s),
      )
    : undefined;
  const limit = Number(c.req.query("limit")) || undefined;
  return c.json({ drafts: await listStudioDrafts(c.env, { status, limit }) });
});

/** POST / — start a draft (an initial body is optional). */
emailDraftsRouter.post("/", async (c) => {
  const parsed = envelopeSchema.merge(bodySchema).extend({ note: z.string().optional() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  const draft = await createStudioDraft(c.env, parsed.data as never);
  return c.json(draft, 201);
});

/** GET /:id — the draft with its revisions and comments. */
emailDraftsRouter.get("/:id", async (c) => {
  const draft = await getStudioDraft(c.env, c.req.param("id"));
  return draft ? c.json(draft) : c.json({ error: "Not found" }, 404);
});

/** PATCH /:id — recipients / subject, without creating a revision. */
emailDraftsRouter.patch("/:id", async (c) => {
  const parsed = envelopeSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  const d = parsed.data;
  await updateDraftFields(c.env, c.req.param("id"), {
    account: d.account,
    toAddr: d.to,
    ccAddr: d.cc,
    bccAddr: d.bcc,
    subject: d.subject,
  });
  return c.json(await getStudioDraft(c.env, c.req.param("id")));
});

/** POST /:id/revisions — the human's edit from the Tiptap editor. */
emailDraftsRouter.post("/:id/revisions", async (c) => {
  const parsed = bodySchema.extend({ note: z.string().optional() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  try {
    const out = await addRevision(c.env, c.req.param("id"), parsed.data as never, {
      source: "human",
      note: parsed.data.note ?? "Edited on the page",
    });
    return c.json(out, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * POST /:id/suggest — ask Core Guardian for a revised body and return it as a
 * SUGGESTION (nothing is written). The page shows an accept/reject diff; accept
 * posts the markdown back through POST /:id/revisions.
 */
emailDraftsRouter.post("/:id/suggest", async (c) => {
  const parsed = z.object({ instruction: z.string().min(1) }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  try {
    return c.json(await suggestDraftRevision(c.env, c.req.param("id"), parsed.data.instruction));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

/** POST /:id/comments — a note for the agent, optionally on a highlight. */
emailDraftsRouter.post("/:id/comments", async (c) => {
  const parsed = z
    .object({ body: z.string().min(1), quote: z.string().nullish(), revision: z.number().int().optional() })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  try {
    return c.json(await addComment(c.env, c.req.param("id"), parsed.data), 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

/** POST /:id/comments/resolve — mark comments handled (all, or the given ids). */
emailDraftsRouter.post("/:id/comments/resolve", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray((body as { commentIds?: unknown }).commentIds)
    ? ((body as { commentIds: string[] }).commentIds)
    : undefined;
  return c.json({ resolved: await resolveComments(c.env, c.req.param("id"), ids) });
});

/** POST /:id/gmail-draft — hand the current revision to Gmail as a real draft. */
emailDraftsRouter.post("/:id/gmail-draft", async (c) => {
  try {
    return c.json(await promoteStudioDraft(c.env, c.req.param("id")));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /:id/send — send the current revision. */
emailDraftsRouter.post("/:id/send", async (c) => {
  try {
    return c.json(await sendStudioDraft(c.env, c.req.param("id")));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** POST /:id/discard — take the draft out of the active list. */
emailDraftsRouter.post("/:id/discard", async (c) => {
  await setDraftStatus(c.env, c.req.param("id"), "discarded");
  return c.json({ ok: true });
});

/**
 * GET /:id/ws — live updates for an open studio page. The socket only carries
 * "something changed" hints; the page always re-reads the draft over REST.
 */
emailDraftsRouter.get("/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "Expected WebSocket" }, 400);
  const id = c.req.param("id");
  if (!(await getStudioDraft(c.env, id))) return c.json({ error: "Not found" }, 404);
  const ns = c.env.EMAIL_DRAFT_ROOM;
  return ns.get(ns.idFromName(id)).fetch(c.req.raw);
});
