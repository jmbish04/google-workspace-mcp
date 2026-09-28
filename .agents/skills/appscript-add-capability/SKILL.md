---
name: appscript-add-capability
description: Build and install a new reusable capability into the account's standing API-executable Apps Script. Use when adding a new function callable by the worker via scripts.run, bundling external libraries into the standing script, or extending the gmail-to-pdf or similar execute-mode features.
---

When adding a new function to the standing Apps Script (e.g. email-to-PDF, email-to-sheet): (1) vendor external code safely if it contains regex/backticks using base64 encoding; (2) template the capability in `/appscript-templates/[feature]/index.ts` with exports for `FEATURE_ENTRY`, `FEATURE_SCOPES`, and `buildFeatureFiles()`; (3) build an install helper that union-merges OAuth scopes and calls `deployMergedVersion()`; (4) register an `appsscript_install_[feature]` tool in MCP.

**Backtick hazard when vendoring**: Code with regex patterns containing backticks (e.g. email validation regex) fights TypeScript template-literal escaping. Encode the entire source as base64 — decode once at module load with `atob()` + `TextDecoder` — to eliminate escaping and hand-copy errors. See `references/vendor-base64-pattern.md` for technique and verification.

**Scope union (critical gotcha)**: When updating the manifest during install, always merge new scopes with existing scopes and deduplicate with `Set` — never overwrite. Other capabilities have already added their scopes; silently dropping them will break features you don't own.

**Capability template** (`/appscript-templates/[feature]/index.ts`): Export the entry function name, scope array, and a builder that returns `ScriptFile[]` of all files to merge (vendors + entry).

**Install helper** (`/appscript/[feature]-install.ts`): Fetch the current manifest, union-merge scopes, call `deployMergedVersion()` with the merged manifest and files from the builder.

**Tool registration** (`src/backend/mcp/tools.ts`): Wire `appsscript_install_[feature]` to resolve the standing script for the account, call the install helper, and return the deployment.

See `references/gmail-pdf-worked-example.md` for a complete worked example showing all four components (vendor, template, install, tool) from the gmail-to-pdf feature.