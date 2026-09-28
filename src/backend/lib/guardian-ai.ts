/**
 * @file lib/guardian-ai.ts
 * @description Self-contained client for core-guardian's metered AI router
 * (https://core-guardian.hacolby.workers.dev). One job: take a provider + model +
 * OpenAI-compatible `input` and POST it to `/api/ai-router/run`, returning the
 * provider's response. Auth is the Secret Store binding WORKER_API_KEY; identity
 * (project / base URL) comes from the optional `GUARDIAN` env var.
 *
 * Every call is best-effort: token read, config parse, fetch, and JSON parse are
 * all guarded, so this NEVER throws — it returns null on any failure and the
 * caller degrades gracefully. This is the ONLY place that knows how to reach
 * Guardian; feature modules (e.g. vision-critique) import `guardianRun` and stay
 * free of transport/auth details.
 */
import { getWorkerApiKey } from "@/backend/utils/secrets";

const DEFAULT_BASE_URL = "https://core-guardian.hacolby.workers.dev";
const DEFAULT_PROJECT = "google-workspace-mcp";

export type Importance = "low" | "medium" | "high";

export interface GuardianRunInput {
  provider: string;
  model: string;
  /** Provider payload — OpenAI-compatible, e.g. `{ messages: [...] }`. */
  input: unknown;
  importance?: Importance;
  mode?: "gateway" | "gateway-custom" | "provider-sdk-gateway" | "openai-compat" | "native" | "gemini-native";
}

/** core-guardian `/api/ai-router/run` result. `body` is the raw provider response. */
export interface GuardianRunResult {
  request_uuid?: string;
  status?: number;
  provider?: string;
  model?: string;
  cost_usd?: number;
  body?: unknown;
}

interface GuardianConfig {
  project?: string;
  baseUrl?: string;
}

function guardianConfig(env: Env): GuardianConfig {
  const raw = (env as unknown as Record<string, unknown>).GUARDIAN;
  if (!raw) return {};
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as GuardianConfig;
  } catch {
    return {};
  }
}

/**
 * Route one AI call through core-guardian. Returns the parsed result, or null if
 * Guardian is unreachable / unauthenticated / the call fails. Never throws.
 */
export async function guardianRun(env: Env, run: GuardianRunInput): Promise<GuardianRunResult | null> {
  try {
    const token = await getWorkerApiKey(env);
    if (!token) return null;
    const cfg = guardianConfig(env);
    const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

    const res = await fetch(`${baseUrl}/api/ai-router/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        project: cfg.project ?? DEFAULT_PROJECT,
        importance: run.importance ?? "low",
        provider: run.provider,
        model: run.model,
        mode: run.mode,
        stream: false,
        input: run.input,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as GuardianRunResult;
  } catch {
    return null;
  }
}

/** Pull assistant text out of an OpenAI-compat OR native-Ollama chat response body. */
export function extractChatText(body: unknown): string {
  const b = body as any;
  return (
    b?.choices?.[0]?.message?.content ?? // openai-compat
    b?.message?.content ?? // native ollama /api/chat
    b?.response ?? // native ollama /api/generate
    (typeof b === "string" ? b : "")
  );
}
