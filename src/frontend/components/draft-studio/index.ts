/**
 * @fileoverview Barrel for the draft studio.
 *
 * - `DraftStudio` — the per-draft page island. Mount `client:only="react"`
 *   (PlateJS is browser-only and throws during Astro SSR).
 * - `DraftList`   — the index listing. Plain fetch, safe with `client:load`.
 */
export { DraftStudio, type DraftStudioProps } from "./DraftStudio";
export { DraftList } from "./DraftList";
export * from "./types";
