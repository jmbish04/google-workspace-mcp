# Gmail HTML standard

The authority is the colby-maestro plan **"Gmail HTML standard + draft studio"**
(`fc8124b830f8`, project `google-workspace-mcp`). This file is the working copy
for agents with no control-plane access. If the two disagree, the plan wins —
fix this file, do not argue from it.

`src/backend/gmail/compose.ts` is the single place these rules are applied.

## The rules

1. **HTML is the only body format.** A plain-text body loses bullets,
   numbering, links, bold and paragraph spacing. Every send and draft ships an
   HTML part; the text/plain alternative is DERIVED from it, never authored
   separately, and keeps the blank line between paragraphs.
2. **Strict inline CSS.** Every styled tag carries `style="..."`. Gmail does
   support `<style>` with class/element/ID selectors and media queries
   (<https://developers.google.com/workspace/gmail/design/css>), but a `<style>`
   block does not survive quoting, forwarding or another client — so static
   rules are inlined with `juice` and only media queries are left in `<style>`.
3. **Safe typography**: `Arial, Helvetica, sans-serif` / `14px` / `1.5` /
   `#222222`. Web-safe stacks only; Outlook substitutes anything else.
4. **Element specs**

   | Element | Inline style |
   | --- | --- |
   | `<p>` | `margin: 0 0 16px 0;` + typography |
   | `<strong>` / `<b>` | `font-weight: 700; color: #222222;` |
   | `<em>` / `<i>` | `font-style: italic;` |
   | `.highlight-red` | `color: #c5221f; font-weight: 600;` |
   | `<a>` | `color: #1155cc; text-decoration: underline;` |
   | `<ul>` / `<ol>` | `margin: 0 0 16px 0; padding-left: 24px;` + typography |
   | `<li>` | `margin-bottom: 6px;` |
   | `<blockquote>` | `margin: 12px 0 16px 16px; padding-left: 12px; border-left: 2px solid #dadce0; color: #5f6368; font-style: italic;` |
   | `.signature` | `margin-top: 24px;` + typography, after `-- <br>` |

5. **Paragraph spacing IS the 16px margin.** Never an empty paragraph, never
   stacked `<br>`. Blank spacer divs in a body copied out of Gmail are dropped.
6. **Container**: `max-width: 650px; width: 100%; text-align: left;
   background-color: transparent;` — NOT a centered boxed card on `#f4f4f4`.
   This is personal mail, not a newsletter.
7. **One hidden reference id per message.** `ref:<uuid>`, white and collapsed,
   `data-plaintext="omit"`. Ids and authorship watermarks from an EARLIER draft
   are stripped — revising a draft must not stack up a second and third id.
8. **The sender always has a name.** `From: "Justin Bishop" <…>` on sends AND
   drafts. A bare address in someone's inbox is a defect.
9. **Reject what cannot be repaired.** A body that sanitizes to nothing throws
   `GmailBodyError`; everything removed is reported back in `body`.
10. **Sanitize, never trust.** `script`, `iframe`, `form`, `svg`, `on*` and
    `javascript:` urls never reach a recipient.

## What this means when you write a tool call

Send `markdown` (easiest) or semantic `html`. **Do not hand-write inline CSS** —
the worker applies the table above, and your inline style would override it and
drift from the standard. Flex and grid are not on Gmail's supported-property
list: layout stays divs and tables.
