/**
 * @fileoverview Deliberate regressions the harness can plant into a stored
 * message BEFORE checking it — proof, on the deployed worker, that each check
 * is able to go red.
 *
 * A plant mutates only the harness's in-memory {@link DraftSnapshot}; nothing
 * is written back to Gmail and nothing in the compose path changes. Every plant
 * names the check it must turn red ({@link PLANT_TARGETS}); the unit tests
 * assert that, and a reviewer can repeat it against the live route with
 * `{"plant":"<name>"}`.
 *
 * @example
 * ```typescript
 * import { plantRegression } from "@/backend/gmail/harness/plant";
 * const broken = plantRegression(snapshot, "visible_ref");
 * ```
 */
import type { DraftSnapshot } from "@/backend/gmail/harness/checks";

/** Every regression the harness knows how to plant. */
export const PLANTS = [
  "wrong_font",
  "boxed_container",
  "nested_wrapper",
  "no_paragraph_margin",
  "fake_bullets",
  "stacked_ref",
  "visible_ref",
  "unstyled_link",
  "bare_from",
  "drop_cid",
  "no_text_part",
] as const;

/** One plantable regression. */
export type PlantName = (typeof PLANTS)[number];

/** The check each plant must turn red. */
export const PLANT_TARGETS: Record<PlantName, string> = {
  wrong_font: "typography_arial_14_1_5_222222",
  boxed_container: "container_650",
  nested_wrapper: "container_650",
  no_paragraph_margin: "paragraph_spacing_16px",
  fake_bullets: "real_lists",
  stacked_ref: "single_ref_marker",
  visible_ref: "single_ref_marker",
  unstyled_link: "links_1155cc",
  bare_from: "sender_display_name",
  drop_cid: "inline_cid_binding",
  no_text_part: "text_plain_alternative",
};

const FOREIGN_REF = "00000000-0000-4000-8000-00000000dead";

/**
 * Return a copy of `snap` with one known defect planted.
 *
 * @param snap - the stored message
 * @param plant - which regression to plant
 * @returns a mutated copy; `snap` is not modified
 */
export function plantRegression(snap: DraftSnapshot, plant: PlantName): DraftSnapshot {
  const s: DraftSnapshot = { ...snap, headers: { ...snap.headers }, parts: snap.parts.map((p) => ({ ...p })) };
  switch (plant) {
    case "wrong_font":
      s.html = s.html.replace(/font-size:\s*14px/g, "font-size:13px");
      break;
    case "boxed_container":
      s.html = s.html.replace(/max-width:\s*650px/, "max-width:600px").replace(/background-color:\s*transparent/, "background-color:#f4f4f4");
      break;
    case "nested_wrapper":
      s.html = s.html.replace(/^(<div dir="ltr" style="[^"]*">)/, "$1$1") + "</div>";
      break;
    case "no_paragraph_margin":
      s.html = s.html.replace(/(<p\b[^>]*style="[^"]*?)margin:\s*0 0 16px 0;?/g, "$1");
      break;
    case "fake_bullets":
      s.html = s.html.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/, (_m, items: string) =>
        items.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/g, "<p>• $1</p>").replace(/\n/g, ""),
      );
      break;
    case "stacked_ref":
      s.html = s.html.replace(/<\/div>\s*$/, `<div data-plaintext="omit" style="color:#ffffff;font-size:1px">ref:${FOREIGN_REF}</div></div>`);
      break;
    case "visible_ref":
      // The defect fixed in compose.ts on 2026-10-23: the hidden marker retagged as a body paragraph.
      s.html = s.html.replace(
        /<div data-plaintext="omit" style="[^"]*">(ref:[0-9a-f-]{36})<\/div>/i,
        '<p data-plaintext="omit" style="margin: 0 0 16px 0; font-family: Arial,Helvetica,sans-serif; font-size: 14px; line-height: 1.5; color: #222222;">$1</p>',
      );
      break;
    case "unstyled_link":
      s.html = s.html.replace(/(<a\b[^>]*?)\sstyle="[^"]*"/g, "$1");
      break;
    case "bare_from":
      s.headers.from = (/<([^>]+)>/.exec(s.headers.from ?? "")?.[1] ?? s.headers.from ?? "").trim();
      break;
    case "drop_cid":
      s.parts = s.parts.filter((p) => !p.contentId);
      break;
    case "no_text_part":
      s.text = "";
      break;
  }
  return s;
}
