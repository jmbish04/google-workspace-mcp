/**
 * @fileoverview Tiny typed fetch client for the template's REST API.
 *
 * All feature pages call the Hono API under `/api/*` through these helpers so
 * error handling, query-string building, and JSON parsing stay consistent.
 * Errors throw `ApiError` (carrying status + parsed body) so islands can route
 * them through the global ErrorLogger / show inline error states.
 *
 * Every request uses `credentials: "include"` so the non-HttpOnly
 * `gsuite_session` cookie reaches cookie-gated routes (`agentAuthMiddleware`).
 * When `getSessionToken()` can read that cookie, it is also sent as
 * `Authorization: Bearer` — the same pair `threads-api.ts` and AuthGate use.
 */

import { getSessionToken } from "@/lib/session";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Build a query string from a params object, skipping null/undefined/"" . */
export function qs(params?: Record<string, string | number | boolean | null | undefined>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data && String((data as any).error)) ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

/**
 * Same-origin fetch init for `/api/*`: always send cookies (`credentials` is
 * set after `extra` so callers cannot override it) and, when present, the
 * signed session token as Bearer. Headers are merged via `Headers` so a
 * `Headers` instance or tuple list from `extra` is not dropped.
 */
function apiInit(extra?: RequestInit): RequestInit {
  const { token } = getSessionToken();
  const headers = new Headers(extra?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return {
    ...extra,
    credentials: "include",
    headers,
  };
}

/** GET `/api/<path>` with optional query params. */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): Promise<T> {
  const res = await fetch(`/api/${path.replace(/^\//, "")}${qs(params)}`, apiInit());
  return parse<T>(res);
}

/** POST/PATCH/PUT/DELETE `/api/<path>` with an optional JSON body. */
export async function apiSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(
    `/api/${path.replace(/^\//, "")}`,
    apiInit({
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return parse<T>(res);
}
