/**
 * @file shared/plate-html.ts
 * @description Isomorphic conversion between the PlateJS editor value and
 * plain HTML, both directions, with no DOM and no React.
 *
 * Why not PlateJS's own serializers: `serializeHtml` renders the editor's React
 * components, so it emits the editor's Tailwind classes into what becomes an
 * email body, and `deserializeHtml` needs a browser DOM. The draft studio needs
 * conversion on the Worker (to normalise a human edit before it is sent) as
 * well as in the browser, and it needs clean semantic tags that
 * `gmail/compose.ts` can restyle. So this module maps the small node set the
 * notes plugin stack registers — paragraphs, H1–H3, blockquote, code blocks,
 * bold/italic/underline, links, and the indent-based lists — and nothing else.
 *
 * Lists are Plate's indent model: a list item is an ordinary block carrying
 * `listStyleType` ("disc" | "decimal") and a 1-based `indent`, not a nested
 * node. `plateToHtml` groups runs of those back into real `<ul>`/`<ol>`, and
 * `htmlToPlate` flattens real lists back into indented blocks.
 */
import { parse, type HTMLElement, type Node } from "node-html-parser";

export interface PlateText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  /** Slate allows arbitrary marks; keeps the type assignable to Plate's own. */
  [mark: string]: unknown;
}

export interface PlateElement {
  type: string;
  children: PlateNode[];
  url?: string;
  indent?: number;
  listStyleType?: string;
  [prop: string]: unknown;
}

export type PlateNode = PlateElement | PlateText;
export type PlateValue = PlateElement[];

const BLOCK_TAG: Record<string, string> = {
  p: "p",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  blockquote: "blockquote",
  code_block: "pre",
};

function isElement(n: PlateNode): n is PlateElement {
  return typeof (n as PlateElement).type === "string" && Array.isArray((n as PlateElement).children);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------ serialize --- */

function inlineToHtml(nodes: PlateNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (isElement(node)) {
      const inner = inlineToHtml(node.children);
      if (node.type === "a" && node.url) out += `<a href="${escapeHtml(String(node.url))}">${inner}</a>`;
      else out += inner;
      continue;
    }
    let t = escapeHtml(node.text ?? "");
    if (!t) continue;
    if (node.code) t = `<code>${t}</code>`;
    if (node.bold) t = `<strong>${t}</strong>`;
    if (node.italic) t = `<em>${t}</em>`;
    if (node.underline) t = `<u>${t}</u>`;
    out += t;
  }
  return out;
}

/** Plate value → clean semantic HTML, ready for `gmail/compose.ts` to restyle. */
export function plateToHtml(value: PlateValue): string {
  const out: string[] = [];
  /** Open list tags, innermost last — one entry per indent level. */
  const open: string[] = [];

  const closeTo = (depth: number) => {
    while (open.length > depth) out.push(`</${open.pop()}>`);
  };

  for (const block of value ?? []) {
    if (!isElement(block)) continue;
    const listTag = block.listStyleType === "decimal" ? "ol" : block.listStyleType ? "ul" : undefined;

    if (listTag) {
      const depth = Math.max(1, Number(block.indent) || 1);
      // A different marker at the same depth starts a new list.
      if (open.length === depth && open[depth - 1] !== listTag) closeTo(depth - 1);
      closeTo(depth);
      while (open.length < depth) {
        out.push(`<${listTag}>`);
        open.push(listTag);
      }
      out.push(`<li>${inlineToHtml(block.children)}</li>`);
      continue;
    }

    closeTo(0);
    if (block.type === "code_block") {
      const lines = block.children
        .filter(isElement)
        .map((line) => escapeHtml(plainTextOf(line)))
        .join("\n");
      out.push(`<pre><code>${lines}</code></pre>`);
      continue;
    }
    const tag = BLOCK_TAG[block.type] ?? "p";
    const inner = inlineToHtml(block.children);
    out.push(inner ? `<${tag}>${inner}</${tag}>` : `<${tag}><br></${tag}>`);
  }
  closeTo(0);
  return out.join("");
}

/** All text under a node, marks ignored. */
export function plainTextOf(node: PlateNode): string {
  if (!isElement(node)) return node.text ?? "";
  return node.children.map(plainTextOf).join("");
}

/* ---------------------------------------------------------- deserialize --- */

type Marks = Pick<PlateText, "bold" | "italic" | "underline" | "code">;

const MARK_BY_TAG: Record<string, keyof Marks> = {
  strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline", ins: "underline", code: "code",
};

function isHtmlElement(n: Node): n is HTMLElement {
  return n.nodeType === 1;
}

function inlineFromHtml(node: Node, marks: Marks, out: PlateNode[]): void {
  if (!isHtmlElement(node)) {
    const text = node.textContent;
    if (text) out.push({ text, ...marks });
    return;
  }
  const tag = node.tagName?.toLowerCase() ?? "";
  if (tag === "br") {
    out.push({ text: "\n", ...marks });
    return;
  }
  if (tag === "a") {
    const children: PlateNode[] = [];
    for (const child of node.childNodes) inlineFromHtml(child, marks, children);
    out.push({ type: "a", url: node.getAttribute("href") ?? "", children: children.length ? children : [{ text: "" }] });
    return;
  }
  const mark = MARK_BY_TAG[tag];
  const next = mark ? { ...marks, [mark]: true } : marks;
  for (const child of node.childNodes) inlineFromHtml(child, next, out);
}

function childrenOf(el: HTMLElement): PlateNode[] {
  const out: PlateNode[] = [];
  for (const child of el.childNodes) inlineFromHtml(child, {}, out);
  return out.length ? out : [{ text: "" }];
}

function listItems(el: HTMLElement, depth: number, out: PlateValue): void {
  const listStyleType = el.tagName.toLowerCase() === "ol" ? "decimal" : "disc";
  for (const li of el.childNodes) {
    if (!isHtmlElement(li) || li.tagName?.toLowerCase() !== "li") continue;
    const nested = li.querySelectorAll("ul,ol").filter((n) => n.parentNode === li);
    for (const n of nested) n.remove();
    out.push({ type: "p", indent: depth, listStyleType, children: childrenOf(li) });
    for (const n of nested) listItems(n, depth + 1, out);
  }
}

const PLATE_TYPE_BY_TAG: Record<string, string> = {
  h1: "h1", h2: "h2", h3: "h3", h4: "h3", h5: "h3", h6: "h3", blockquote: "blockquote",
};

/**
 * HTML → Plate value. Accepts the Gmail-native bodies this worker produces
 * (a `<div dir="ltr">` wrapper of `<div>` paragraphs) as well as ordinary
 * `<p>`-based HTML. Hidden machine markers (`data-plaintext="omit"`) are
 * dropped: they are regenerated on send and must never become editable text.
 */
export function htmlToPlate(html: string): PlateValue {
  const parsed = parse(html ?? "", { comment: false });
  parsed.querySelectorAll('[data-plaintext="omit"]').forEach((n) => n.remove());
  parsed.querySelectorAll("style,script").forEach((n) => n.remove());

  // Unwrap the Gmail compose wrapper so its paragraphs become the top level.
  const kids = parsed.childNodes.filter((n) => isHtmlElement(n) || n.textContent.trim());
  const only = kids.length === 1 && isHtmlElement(kids[0]) ? (kids[0] as HTMLElement) : undefined;
  const root = only && only.tagName?.toLowerCase() === "div" && only.getAttribute("dir") === "ltr" ? only : parsed;

  const out: PlateValue = [];
  let loose: PlateNode[] = [];
  const flushLoose = () => {
    if (loose.some((n) => (isElement(n) ? plainTextOf(n) : n.text).trim())) out.push({ type: "p", children: loose });
    loose = [];
  };

  for (const node of root.childNodes) {
    if (!isHtmlElement(node)) {
      if (node.textContent.trim()) loose.push({ text: node.textContent });
      continue;
    }
    const tag = node.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      flushLoose();
      listItems(node, 1, out);
      continue;
    }
    if (tag === "pre") {
      flushLoose();
      const code = node.textContent.replace(/\n$/, "");
      out.push({
        type: "code_block",
        children: code.split("\n").map((line) => ({ type: "code_line", children: [{ text: line }] })),
      });
      continue;
    }
    if (tag === "div" || tag === "p" || PLATE_TYPE_BY_TAG[tag]) {
      flushLoose();
      // A blank spacer div is Gmail's paragraph gap, not an empty paragraph the
      // writer typed — the gap is re-created on serialize.
      if (tag === "div" && !node.textContent.trim() && !node.querySelector("img")) continue;
      out.push({ type: PLATE_TYPE_BY_TAG[tag] ?? "p", children: childrenOf(node) });
      continue;
    }
    if (tag === "hr") {
      flushLoose();
      continue;
    }
    inlineFromHtml(node, {}, loose);
  }
  flushLoose();
  return out.length ? out : [{ type: "p", children: [{ text: "" }] }];
}
