/**
 * @file gmail/draft-suggest.ts
 * @description Core Guardian–backed revision *suggestions* for the draft studio.
 *
 * The agent never overwrites the email. `suggestDraftRevision` takes the current
 * body plus a human instruction (free text, or a colby email-skill prompt),
 * asks a chat model through {@link guardianRun} for a rewritten body, and returns
 * it as a SUGGESTION — nothing is written to D1. The page shows it as an
 * accept/reject diff; accepting posts it through the existing
 * `POST /:id/revisions` path, so `compose.ts` still owns the wire format (the
 * Gmail HTML standard) and the change lands as an ordinary numbered revision.
 *
 * The model is asked for Markdown (the body form `compose.ts` renders best), and
 * we compose it here too so the preview and diff are the exact bytes acceptance
 * would store. Guardian failures degrade to a thrown error the route turns into
 * a clean 502 — never a silent half-suggestion.
 */
import { guardianRun, extractChatText } from "@/backend/lib/guardian-ai";
import { getSecret } from "@/backend/utils/secrets";
import { getStudioDraft, renderStudioBody } from "@/backend/gmail/draft-studio";

/** Default chat model for revisions. Override with the `DRAFT_SUGGEST_MODEL` / `DRAFT_SUGGEST_PROVIDER` secrets. */
const DEFAULT_MODEL = "glm-5.3";
const DEFAULT_PROVIDER = "ollama";

export interface DraftSuggestion {
  instruction: string;
  /** Plain text of the current body, for the before-side of the diff. */
  originalText: string;
  /** The model's proposed body, as Markdown — what acceptance would POST. */
  suggestedMarkdown: string;
  /** Composed preview of the suggestion (Gmail-ready HTML) and its plain text. */
  suggestedHtml: string;
  suggestedText: string;
  model: string;
}

const SYSTEM_PROMPT = [
  "You revise the body of an email. You are given the current body and an instruction.",
  "Return ONLY the full revised email body as GitHub-Flavored Markdown — no preamble,",
  "no explanation, no code fences, no subject line, no signature unless the current body",
  "already had one. Preserve the sender's voice and any facts; change only what the",
  "instruction asks. If the current body is empty, write a first draft from the instruction.",
].join(" ");

/** Strip a leading/trailing ```…``` fence a model sometimes wraps output in. */
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
  return (m ? m[1] : t).trim();
}

/**
 * Ask Core Guardian for a revised body. Pure — writes nothing. Throws on an
 * unreachable model or an empty suggestion so the caller returns a real error.
 *
 * @param env - Worker env (Guardian auth + model-override secrets).
 * @param draftId - The studio draft to revise.
 * @param instruction - What to change (free text or a skill prompt).
 * @returns The suggestion, including a composed preview of what acceptance stores.
 * @throws If the draft is missing, the model is unreachable, or it returns nothing.
 */
export async function suggestDraftRevision(env: Env, draftId: string, instruction: string): Promise<DraftSuggestion> {
  const draft = await getStudioDraft(env, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  if (draft.status === "sent") throw new Error(`Draft ${draftId} has already been sent; it can no longer be revised.`);

  const originalText = draft.current?.text ?? "";
  const model = (await getSecret(env, "DRAFT_SUGGEST_MODEL")) ?? DEFAULT_MODEL;
  const provider = (await getSecret(env, "DRAFT_SUGGEST_PROVIDER")) ?? DEFAULT_PROVIDER;

  const result = await guardianRun(env, {
    provider,
    model,
    importance: "medium",
    mode: "openai-compat",
    input: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Instruction:\n${instruction}\n\nCurrent email body:\n${originalText || "(empty)"}`,
        },
      ],
    },
  });
  if (!result) throw new Error("The revision model is unavailable right now. Try again shortly.");

  const suggestedMarkdown = stripFences(extractChatText(result.body));
  if (!suggestedMarkdown) throw new Error("The model returned an empty revision.");

  // Compose exactly as acceptance would, so the preview/diff is the real bytes.
  const rendered = renderStudioBody({ markdown: suggestedMarkdown }, draft.uuid ?? crypto.randomUUID());
  return {
    instruction,
    originalText,
    suggestedMarkdown,
    suggestedHtml: rendered.html,
    suggestedText: rendered.text,
    model,
  };
}
