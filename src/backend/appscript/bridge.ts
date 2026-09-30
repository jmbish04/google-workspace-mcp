/**
 * @file appscript/bridge.ts
 * @description Client for the `workspace-bridge` Apps Script project
 * (source: gas/projects/workspace-bridge in core-template-gas). The Worker runs
 * it through the Execution API — `scripts.run { function: "runBridge",
 * parameters: [action, params] }` — with the account's own OAuth token, the same
 * transport `gmail_to_pdf via:"appscript"` uses.
 *
 * The script answers with an envelope, never a throw:
 *   { ok: true, action, result } | { ok: false, code, error }
 * so a bad parameter comes back as a readable error instead of an opaque
 * scripts.run failure. This client turns both failure shapes (a scripts.run
 * `error`, or `ok:false`) into one thrown Error that names the cause.
 *
 * @example
 *   const draft = await runBridgeAction(env, ref, "justin@126colby.com",
 *     "gmail.createDraft", { to, subject, html, text });
 */
import { resolveGasScript } from "@/backend/appscript/gas-projects";
import { AppsScriptService } from "@/backend/mcp/services/appsscript";

type BridgeEnvelope = { ok: true; action: string; result: unknown } | { ok: false; code: string; error: string };

/** Actions runBridge understands (see gas/projects/workspace-bridge/src/server/main.ts). */
export type BridgeAction =
  | "health"
  | "gmail.createDraft"
  | "gmail.updateDraft"
  | "gmail.getDraft"
  | "gmail.listDrafts"
  | "docs.hygiene";

/**
 * Run one workspace-bridge action for an account.
 *
 * @param env Worker env (D1 for the scriptId registry, Google auth).
 * @param ref Account reference the OAuth token is resolved for (`acct(sub, a)`).
 * @param accountEmail Bare email of that account — keys the per-account scriptId.
 * @param action Bridge action name.
 * @param params Action parameters (plain JSON).
 * @returns The action's `result`.
 * @throws When the bridge is not registered for the account, scripts.run fails,
 *   or the script returns `ok:false`.
 */
export async function runBridgeAction<T = unknown>(
  env: Env,
  ref: string,
  accountEmail: string,
  action: BridgeAction,
  params: Record<string, unknown>,
): Promise<T> {
  const email = accountEmail.toLowerCase();
  const gas = await resolveGasScript(env, "workspace-bridge", email);
  if (!gas) {
    throw new Error(
      `workspace-bridge Apps Script is not registered for ${email}. Create/deploy it from core-template-gas (gas/projects/workspace-bridge), then set_gas_script({ project: "workspace-bridge", account: "${email}", scriptId }).`,
    );
  }
  // devMode:false → the API-executable deployment (a versioned, deployed build).
  const r = (await new AppsScriptService(env, ref).run(gas.scriptId, gas.entry, [action, params], false)) as {
    error?: { message?: string; details?: unknown };
    response?: { result?: BridgeEnvelope };
  };
  if (r?.error) {
    throw new Error(`workspace-bridge ${action} failed in Apps Script: ${JSON.stringify(r.error.details ?? r.error)}`);
  }
  const env0 = r?.response?.result;
  if (!env0 || typeof env0 !== "object" || !("ok" in env0)) {
    throw new Error(
      `workspace-bridge ${action} returned no envelope — is the project deployed as an API Executable, and has ${email} authorized it once in the editor?`,
    );
  }
  if (!env0.ok) throw new Error(`workspace-bridge ${action}: ${env0.code}: ${env0.error}`);
  return env0.result as T;
}
