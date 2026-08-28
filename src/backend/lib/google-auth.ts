/**
 * @fileoverview Canonical Google API OAuth scopes used across every Workspace
 * surface (the ported `google/*` client layer).
 *
 * Auth itself is OAuth-ONLY now — access tokens come from `auth/provider.ts`
 * (`getGoogleAccessToken`) and `mcp/tokenProvider.ts` (`getAccessToken`), each
 * resolving a stored per-account OAuth refresh token. Domain-Wide Delegation and
 * the service account were removed; this file no longer mints SA tokens.
 */

/**
 * Canonical Google API OAuth scopes used across every Workspace surface. The
 * OAuth consent screen requests this set for each authorized account.
 */
export const GoogleScope = {
  Docs: "https://www.googleapis.com/auth/documents",
  Sheets: "https://www.googleapis.com/auth/spreadsheets",
  Slides: "https://www.googleapis.com/auth/presentations",
  Drive: "https://www.googleapis.com/auth/drive",
  Gmail: "https://www.googleapis.com/auth/gmail.modify",
  GmailSend: "https://www.googleapis.com/auth/gmail.send",
  GmailSettings: "https://www.googleapis.com/auth/gmail.settings.basic",
  Calendar: "https://www.googleapis.com/auth/calendar",
  ScriptProjects: "https://www.googleapis.com/auth/script.projects",
  ScriptDeployments: "https://www.googleapis.com/auth/script.deployments",
  UserinfoEmail: "https://www.googleapis.com/auth/userinfo.email",
} as const;

/** Every scope — used for the broadest token / one-time OAuth consent. */
export const ALL_GOOGLE_SCOPES: string[] = Object.values(GoogleScope);
