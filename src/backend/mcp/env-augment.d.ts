/**
 * Ambient augmentation of the generated `Env` (worker-configuration.d.ts) with
 * bindings that `wrangler types` doesn't emit a precise shape for.
 *
 * `SELF_RPC` is this Worker's own `services` self-binding to the `GsuiteService`
 * WorkerEntrypoint (wrangler.jsonc → services). Typed as the class so code mode
 * gets `SELF_RPC.callTool(...)`; over a service binding each method returns a
 * Promise, which `callTool` already does.
 */
import type { GsuiteService } from "@/backend/rpc";

declare global {
  interface Env {
    SELF_RPC?: GsuiteService;
    /** Comma-separated emails forced to OAuth (never DWD). Optional var. */
    GOOGLE_OAUTH_ONLY_ACCOUNTS?: string;
  }
}

export {};
