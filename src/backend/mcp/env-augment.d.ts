/**
 * Ambient augmentation of the generated `Env` (worker-configuration.d.ts) with
 * bindings/vars that `wrangler types` does not emit.
 *
 * Keep this in sync with what `wrangler types` generates: a member declared
 * here that `wrangler types` ALSO emits collides on the global `interface Env`
 * (declaration merging with a different type), which makes `Env` fail the
 * `agents` package's `Agent<Env extends Cloudflare.Env>` constraint and breaks
 * the whole agent/RPC layer's types. That is exactly what happened when the
 * draft-studio integration regenerated `worker-configuration.d.ts`: it now
 * emits precise shapes for `SELF_RPC` (the `services` self-binding →
 * `Service<typeof GsuiteService>`, which already exposes `callTool` as a
 * Promise) and `WORKSPACE_EVENTS_ACCOUNT` (a `vars` entry), so both were
 * removed from here. Only vars `wrangler types` cannot know about stay.
 */

declare global {
  interface Env {
    /** Comma-separated emails forced to OAuth (never DWD). Optional var. */
    GOOGLE_OAUTH_ONLY_ACCOUNTS?: string;
  }
}

export {};
