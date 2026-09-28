---
name: gws-auth-seam-audit
description: Audit google-workspace-mcp auth code for seam consistency, token scope enforcement, and identity-switch validation. Use when reviewing changes to auth/provider.ts, tokenProvider.ts, token minting or checking routes, account resolution logic, identity switches (as_user parameters), or any auth refactoring. Catches account-ref namespace mismatches, token scope enforcement gaps, unchecked identity switches, and call-site assumption breakage.
---

Auth logic in google-workspace-mcp routes through multiple seams — `auth/provider.ts`, `tokenProvider.ts`, MCP tools, copilot routes. When seams disagree on how they resolve identifiers or enforce scope, privilege escalation and bypass become possible.

**Account-ref namespace agreement.** All code paths that resolve account identifiers must use the same namespace and accept/reject the same inputs. If `tokenProvider.getAccessToken` strips legacy `dwd:` prefixes but `auth/provider.resolveAccount` treats them as literal emails, one path breaks silently or resolves to the wrong account. Check: grep for every place that accepts account names or references; ensure they all normalize and validate identically.

**Token minting ↔ usage boundary.** Token created with scope (`{account, fileId, hostType}` in KV) must be checked at use time. Don't let request bodies override minted context — take account, fileId, hostType from token storage, not from the request. Mismatch turns a scoped token into a privilege escalation vector.

**Identity switches need permission validation.** `as_user` parameters are unchecked impersonation if there's no allow-list or permission check. The caller (sub) must have explicit permission to act as the target user. A helper like `acct(sub, a)` that accepts `as_user` freely is a privilege escalation waiting for a call-site to hold the wrong token.

**Auth refactors break call-site assumptions.** Migrating from DWD/service account to OAuth changes namespace semantics (numeric `sub` vs. email, `dwd:` prefix handling). Audit every caller of changed functions: does the numeric `sub` resolve correctly in the new system? Do calls that expect `dwd:` prefixes still work? Do calls that pass `as_user` still validate correctly?

**Credential placement matters.** Tokens in URL query strings live in browser history, CF request logs, and referrer headers. Keep tokens short-lived (≤5 min TTL), make them single-use (delete from KV after first `/chat` call), or swap them to sessionStorage on page load so the URL never contains the secret.

See: src/backend/auth/provider.ts (resolveAccount), src/backend/mcp/tokenProvider.ts (getAccessToken), src/backend/api/routes/copilot.ts (token/chat endpoints).
