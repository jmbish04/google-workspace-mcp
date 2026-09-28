/**
 * @fileoverview Canonical Google API OAuth scopes used across every Workspace
 * surface (the ported `google/*` client layer).
 *
 * Auth itself is OAuth-ONLY now — access tokens come from `auth/provider.ts`
 * (`getGoogleAccessToken`) and `mcp/tokenProvider.ts` (`getAccessToken`), each
 * resolving a stored per-account OAuth refresh token. Domain-Wide Delegation and
 * the service account were removed; this file no longer mints SA tokens.
 *
 * ## Why NO Google Cloud scopes appear here (load-bearing — do not add them)
 *
 * A Workspace admin can set a **Google Cloud session length**
 * (Admin console → Security → Access and data control → Google Cloud session
 * control). Google's own docs say that policy applies to the Cloud Console, the
 * gcloud CLI, "and any third party OAuth application that requires the Cloud
 * Platform scope". When it applies, a refresh token that carries
 * `.../auth/cloud-platform` stops refreshing at the end of each session window
 * with:
 *
 *     400 invalid_grant / "reauth related error (invalid_rapt)"
 *
 * even though the refresh token itself is perfectly valid and un-revoked. That
 * is exactly what was killing `justin@126colby.com` (a managed Workspace
 * account) while `jmbish04@gmail.com` (consumer, no admin policy) kept working
 * for weeks — measured 2026-09-28.
 *
 * A refresh token WITHOUT Cloud scopes is not subject to that policy and lives
 * indefinitely (it dies only on explicit revoke, ~6 months of total disuse, or
 * a consumer-account password change). So: this worker calls Gmail, Drive,
 * Docs, Sheets, Slides, Calendar, People, Forms, Apps Script and Workspace
 * Events — none of which need `cloud-platform` or `service.management`. Keep it
 * that way, and keep {@link buildConsentUrl}'s `include_granted_scopes=false`,
 * which is what stops a previously-granted Cloud scope from being silently
 * merged back into a fresh consent.
 */

/**
 * Canonical Google API OAuth scopes used across every Workspace surface. The
 * OAuth consent screen requests this set for each authorized account.
 *
 * This is the full set the worker needs, spelled out rather than relying on
 * incremental authorization to accumulate it — see the file header.
 */
export const GoogleScope = {
  // --- Identity -----------------------------------------------------------
  OpenId: "openid",
  UserinfoEmail: "https://www.googleapis.com/auth/userinfo.email",
  UserinfoProfile: "https://www.googleapis.com/auth/userinfo.profile",

  // --- Gmail --------------------------------------------------------------
  // `https://mail.google.com/` is the superset of every `gmail.*` scope, so
  // read/modify/send/settings all resolve to it. The three names are kept
  // because callers (google/gmail.ts) ask for the capability, not the URL;
  // ALL_GOOGLE_SCOPES de-duplicates them.
  Gmail: "https://mail.google.com/",
  GmailSend: "https://mail.google.com/",
  GmailSettings: "https://mail.google.com/",

  // --- Drive / editors ----------------------------------------------------
  Drive: "https://www.googleapis.com/auth/drive",
  Docs: "https://www.googleapis.com/auth/documents",
  Sheets: "https://www.googleapis.com/auth/spreadsheets",
  Slides: "https://www.googleapis.com/auth/presentations",

  // --- Calendar -----------------------------------------------------------
  Calendar: "https://www.googleapis.com/auth/calendar",

  // --- People (contacts + domain directory search) ------------------------
  Contacts: "https://www.googleapis.com/auth/contacts",
  DirectoryReadonly: "https://www.googleapis.com/auth/directory.readonly",

  // --- Forms --------------------------------------------------------------
  FormsBody: "https://www.googleapis.com/auth/forms.body",
  FormsResponses: "https://www.googleapis.com/auth/forms.responses.readonly",

  // --- Apps Script API (projects + scripts.run, e.g. email-to-pdf) --------
  ScriptProjects: "https://www.googleapis.com/auth/script.projects",
  ScriptDeployments: "https://www.googleapis.com/auth/script.deployments",
  ScriptProcesses: "https://www.googleapis.com/auth/script.processes",
  ScriptExternalRequest: "https://www.googleapis.com/auth/script.external_request",
  ScriptScriptApp: "https://www.googleapis.com/auth/script.scriptapp",
  ScriptStorage: "https://www.googleapis.com/auth/script.storage",
} as const;

/** Every scope — used for the broadest token / one-time OAuth consent. */
export const ALL_GOOGLE_SCOPES: string[] = [...new Set<string>(Object.values(GoogleScope))];

/**
 * Scope prefixes that put a refresh token under Google Cloud session control
 * (see the file header). Never request one of these on a Workspace account.
 */
export const REAUTH_TRIGGERING_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/service.management",
];

/**
 * Whether a granted scope set contains a Google Cloud scope, i.e. whether the
 * token is subject to the Workspace reauthentication policy that produces
 * `invalid_grant` / `invalid_rapt`.
 *
 * @param scopes - Granted OAuth scopes for an account
 * @returns True when at least one Cloud scope is present
 * @example
 * isReauthExposed(["https://www.googleapis.com/auth/drive"]) // false
 */
export function isReauthExposed(scopes: readonly string[] | null | undefined): boolean {
  if (!scopes?.length) return false;
  return scopes.some((s) => REAUTH_TRIGGERING_SCOPES.some((bad) => s.startsWith(bad)));
}
