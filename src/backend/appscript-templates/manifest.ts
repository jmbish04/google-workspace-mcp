/**
 * @file appscript-templates/manifest.ts
 * @description Builder for the `appsscript.json` manifest file. Bakes in the
 * OAuth scopes and advanced services each template needs so the end user never
 * has to add them by hand — notably the Docs advanced service, which the
 * questions sidebar uses to create document tabs via `Docs.Documents.batchUpdate`.
 */

import type { ScriptFile } from "./types";

/** Options controlling which capabilities the manifest declares. */
export interface ManifestOptions {
  /**
   * Enable the Docs advanced service (`Docs.Documents.batchUpdate`), required
   * for creating and writing document tabs.
   */
  docsAdvancedService?: boolean;
  /** Declare a web-app entry point (needed for `doGet` deployments). */
  webapp?: boolean;
  /** Extra OAuth scopes to merge in. */
  extraScopes?: string[];
}

/** Scopes every host-editor template needs (Docs/Sheets/Slides + sidebar UI). */
const BASE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/script.container.ui",
];

/**
 * Build the `appsscript` manifest file for a template.
 *
 * @param opts - Capability toggles
 * @returns The manifest as a JSON {@link ScriptFile}
 */
export function buildManifest(opts: ManifestOptions = {}): ScriptFile {
  const manifest: Record<string, unknown> = {
    timeZone: "America/Los_Angeles",
    exceptionLogging: "STACKDRIVER",
    runtimeVersion: "V8",
    oauthScopes: [...new Set([...BASE_SCOPES, ...(opts.extraScopes ?? [])])],
  };

  if (opts.docsAdvancedService) {
    manifest.dependencies = {
      enabledAdvancedServices: [
        { userSymbol: "Docs", version: "v1", serviceId: "docs" },
      ],
    };
  }

  if (opts.webapp) {
    manifest.webapp = { executeAs: "USER_DEPLOYING", access: "MYSELF" };
  }

  return {
    name: "appsscript",
    type: "JSON",
    source: JSON.stringify(manifest, null, 2),
  };
}
