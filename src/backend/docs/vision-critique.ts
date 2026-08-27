/**
 * @file docs/vision-critique.ts
 * @description Ask an Ollama Cloud vision model to critique a rendered document
 * page's FORMATTING and visual presentation — is it professional / fun /
 * creative, is the hierarchy clear, is spacing/alignment clean, does the style
 * fit the content. Owns only the critique concern (prompt, image encoding,
 * response parsing); the Guardian transport/auth lives in {@link guardianRun}.
 *
 * Best-effort: returns null when the route is unavailable or the call fails, so
 * a preview still returns its images without the critique.
 */
import { guardianRun, extractChatText } from "@/backend/lib/guardian-ai";
import { getSecret } from "@/backend/utils/secrets";

const DEFAULT_MODEL = "qwen3.5"; // Ollama Cloud vision model; override via OLLAMA_VISION_MODEL or the call arg.

const CRITIQUE_PROMPT =
  "You are a document design reviewer. This image is one rendered page of a document. " +
  "Critique its FORMATTING and visual presentation only (not the writing). Judge: overall style " +
  "and tone (professional, fun, creative, formal, playful, corporate, minimal), visual hierarchy, " +
  "typography, spacing and whitespace, alignment, and whether the styling fits the apparent purpose. " +
  "Call out concrete problems (crowding, misalignment, inconsistent headings, awkward wrapping, weak " +
  "hierarchy) and what to change. If it looks clean and well-presented, say so and name the style. Be terse.";

function pngToDataUrl(png: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < png.length; i += chunk) s += String.fromCharCode(...png.subarray(i, i + chunk));
  return `data:image/png;base64,${btoa(s)}`;
}

/**
 * Critique one page image (`png` = raw PNG bytes for the page). Returns the
 * model's notes, or null if the vision route is unavailable / the call fails.
 * Never throws.
 */
export async function critiquePageImage(env: Env, png: Uint8Array, model?: string): Promise<string | null> {
  try {
    const visionModel = model ?? (await getSecret(env, "OLLAMA_VISION_MODEL")) ?? DEFAULT_MODEL;
    const result = await guardianRun(env, {
      provider: "ollama",
      model: visionModel,
      importance: "low",
      mode: "openai-compat",
      input: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: CRITIQUE_PROMPT },
              { type: "image_url", image_url: { url: pngToDataUrl(png) } },
            ],
          },
        ],
      },
    });
    if (!result) return null;
    const text = extractChatText(result.body).trim();
    return text || null;
  } catch {
    return null;
  }
}
