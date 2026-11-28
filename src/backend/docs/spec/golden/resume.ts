/**
 * @fileoverview Golden spec: the 1-page, 2-column resume template built by
 * hand through `documents.batchUpdate` on 2026-10-08 (the plan's reference).
 *
 * Every value is copied from that document (`documents.get`, read-only):
 * navy header band (1x1), three metric cards (1x3, 4 pt white borders as the
 * gap), and a 178/362 pt sidebar/main layout table (1x2) with section rules,
 * skill bars, tag chips and bulleted experience. `docs_build_from_spec` must
 * reproduce its structure (same paragraphs and table/cell positions, see
 * `docs/__fixtures__/reference-resume.structure.json`) and render on 1 page.
 *
 * It doubles as a working recipe in `docs_schema` (Epic F).
 *
 * @example
 * ```typescript
 * import { resumeSpec } from "@/backend/docs/spec/golden/resume";
 * await tools.docs_build_from_spec({ documentId, mode: "create", spec: resumeSpec });
 * ```
 */
import type { LayoutSpecInput } from "@/backend/docs/spec/schema";

/** A skill bar: `filled` accent squares then grey squares, 10 in all. */
function bar(filled: number) {
  return {
    type: "paragraph" as const,
    style: "bar",
    runs: [
      { text: "■".repeat(filled), color: "accent" },
      { text: "■".repeat(10 - filled), color: "rule" },
    ],
  };
}

/** One skill: name line + bar. */
function skill(name: string, level: number) {
  return [{ type: "paragraph" as const, style: "skillName", text: name }, bar(level)];
}

/** Job meta line: company (accent, bold) | place | dates. */
function jobMeta(place: string, dates: string) {
  return {
    type: "paragraph" as const,
    style: "jobMeta",
    runs: [
      { text: "Company Name", bold: true, color: "accent" },
      { text: "   |   ", color: "rule" },
      { text: place },
      { text: "   |   ", color: "rule" },
      { text: dates },
    ],
  };
}

/** Tech-stack chips separated by two spaces. */
function tags(names: string[]) {
  const runs: { text: string; style?: string }[] = [];
  names.forEach((n, i) => {
    if (i) runs.push({ text: "  " });
    runs.push({ text: ` ${n} `, style: "tag" });
  });
  return { type: "paragraph" as const, size: 8.5, color: "text", lineSpacing: 160, runs };
}

export const resumeSpec: LayoutSpecInput = {
  document: {
    pageMode: "PAGES",
    pageSize: "LETTER",
    margins: { top: 24, bottom: 24, left: 36, right: 36 },
    bodyFont: "body",
    lineSpacing: 110,
    maxPages: 1,
    trailingGap: 5,
  },
  theme: {
    colors: {
      ink: "#16253b",
      accent: "#0f8b7d",
      accentBright: "#6fe0cf",
      onInk: "#c7d2e0",
      text: "#3a4556",
      subtle: "#718096",
      rule: "#cbd5e1",
      sidebar: "#f1f5f8",
      card: "#e6f4f1",
      tagBg: "#d5eeea",
      tagInk: "#0b5f55",
      white: "#ffffff",
    },
    fonts: { heading: "Montserrat", body: "Lato" },
  },
  styles: {
    sectionTitle: {
      font: "heading",
      size: 10,
      bold: true,
      color: "accent",
      spaceAbove: 9,
      spaceBelow: 5,
      keepWithNext: true,
      borderBottom: { width: 1, color: "accent", padding: 3 },
    },
    skillName: { size: 9, bold: true, color: "ink", spaceAbove: 3, spaceBelow: 1 },
    bar: { size: 8 },
    tag: { bold: true, size: 8.5, color: "tagInk", highlight: "tagBg" },
    body: { size: 9.5, color: "text" },
    detail: { size: 8.5, color: "subtle" },
    jobTitle: { font: "heading", size: 11, bold: true, color: "ink", spaceAbove: 7, keepWithNext: true },
    jobMeta: { size: 9, color: "subtle", spaceAbove: 2, spaceBelow: 3, keepWithNext: true },
    projectTitle: { font: "heading", size: 10, bold: true, color: "ink", spaceBelow: 2, keepWithNext: true },
    bullet: { size: 9.5, color: "text", lineSpacing: 108, spaceBelow: 2, indentStart: 13, indentFirstLine: 2 },
  },
  blocks: [
    // Header band: navy, no borders.
    {
      type: "table",
      columns: 1,
      cell: { background: "ink", padding: { top: 14, bottom: 14, left: 22, right: 22 }, borders: "none" },
      rows: [
        {
          cells: [
            {
              blocks: [
                { type: "paragraph", text: "YOUR NAME", font: "heading", size: 26, bold: true, color: "white", spaceBelow: 2 },
                { type: "paragraph", text: "Full-Stack Developer", font: "heading", size: 12, color: "accentBright", spaceBelow: 10 },
                {
                  type: "paragraph",
                  size: 9,
                  color: "onInk",
                  runs: [
                    { text: "San Francisco, CA" },
                    { text: "   •   ", color: "accentBright" },
                    { text: "you@email.com" },
                    { text: "   •   ", color: "accentBright" },
                    { text: "(555) 123-4567" },
                    { text: "   •   ", color: "accentBright" },
                    { text: "linkedin.com/in/yourname" },
                    { text: "   •   ", color: "accentBright" },
                    { text: "github.com/yourname" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // Metric cards: 4 pt white borders make the gaps between cards.
    {
      type: "table",
      columns: 3,
      gapBefore: 5,
      cell: {
        background: "card",
        padding: { top: 7, bottom: 7, left: 8, right: 8 },
        borders: { width: 4, color: "white" },
        valign: "middle",
      },
      rows: [
        {
          cells: [
            ["40%", "faster page loads after moving to Next.js"],
            ["2M+", "API requests served per day"],
            ["8", "engineers onboarded and mentored"],
          ].map(([num, caption]) => ({
            blocks: [
              { type: "paragraph" as const, text: num, font: "heading", size: 20, bold: true, color: "accent", align: "CENTER" as const, spaceBelow: 2 },
              { type: "paragraph" as const, text: caption, size: 8.5, color: "text", align: "CENTER" as const },
            ],
          })),
        },
      ],
    },
    // Sidebar / main.
    {
      type: "table",
      columns: [{ width: 178 }, { width: 362 }],
      gapBefore: 5,
      cell: { borders: "none" },
      rows: [
        {
          cells: [
            {
              background: "sidebar",
              padding: { top: 12, bottom: 10, left: 14, right: 14 },
              blocks: [
                { type: "paragraph", style: "sectionTitle", text: "SKILLS", spaceAbove: 0 },
                ...skill("TypeScript & React", 9),
                ...skill("Node.js & Express", 9),
                ...skill("PostgreSQL & Redis", 8),
                ...skill("System Design", 8),
                ...skill("Python & FastAPI", 7),
                ...skill("AWS & Docker", 7),
                { type: "paragraph", style: "sectionTitle", text: "TECH STACK" },
                tags(["Next.js", "GraphQL", "Tailwind", "Prisma", "Jest", "Playwright", "Kubernetes", "Terraform", "GitHub Actions"]),
                { type: "paragraph", style: "sectionTitle", text: "EDUCATION" },
                { type: "paragraph", text: "B.S. Computer Science", size: 9.5, bold: true, color: "ink" },
                { type: "paragraph", text: "University Name", size: 9, color: "text", spaceAbove: 1 },
                { type: "paragraph", style: "detail", text: "2013 – 2017", spaceAbove: 1 },
                { type: "paragraph", style: "sectionTitle", text: "CERTIFICATIONS" },
                { type: "paragraph", text: "AWS Certified Developer", size: 9, bold: true, color: "ink" },
                { type: "paragraph", style: "detail", text: "Associate, 2023", spaceAbove: 1, spaceBelow: 5 },
                { type: "paragraph", text: "Kubernetes Developer (CKAD)", size: 9, bold: true, color: "ink" },
                { type: "paragraph", style: "detail", text: "2022", spaceAbove: 1 },
                { type: "paragraph", style: "sectionTitle", text: "LANGUAGES" },
                {
                  type: "paragraph",
                  spaceBelow: 2,
                  runs: [
                    { text: "English", size: 9, bold: true, color: "ink" },
                    { text: "  native", style: "detail" },
                  ],
                },
                {
                  type: "paragraph",
                  runs: [
                    { text: "Spanish", size: 9, bold: true, color: "ink" },
                    { text: "  conversational", style: "detail" },
                  ],
                },
              ],
            },
            {
              background: "white",
              padding: { top: 12, bottom: 8, left: 20, right: 4 },
              blocks: [
                { type: "paragraph", style: "sectionTitle", text: "PROFILE", color: "ink", spaceAbove: 0 },
                {
                  type: "paragraph",
                  style: "body",
                  lineSpacing: 112,
                  text: "Full-stack developer with 8+ years of experience building web products from the database schema to the finished UI. I work mostly in TypeScript, React and Node.js on AWS, and I focus on fast pages, clear APIs and code the next engineer can pick up quickly.",
                },
                { type: "paragraph", style: "sectionTitle", text: "EXPERIENCE", color: "ink" },
                { type: "paragraph", style: "jobTitle", text: "Senior Full-Stack Engineer", spaceAbove: 2 },
                jobMeta("San Francisco, CA", "2022 – Present"),
                {
                  type: "list",
                  style: "bullet",
                  items: [
                    "Led the migration of the customer dashboard from a legacy SPA to Next.js, cutting median page load from 3.1s to 1.8s.",
                    "Designed a GraphQL gateway over 14 internal services that now serves 2M+ requests per day at 99.95% uptime.",
                    "Added preview environments to every pull request, so QA review went from two days to the same day.",
                  ],
                },
                { type: "paragraph", style: "jobTitle", text: "Full-Stack Developer" },
                jobMeta("Remote", "2019 – 2022"),
                {
                  type: "list",
                  style: "bullet",
                  items: [
                    "Built a billing and invoicing module in Node.js and PostgreSQL that processes $4M in payments each month.",
                    "Replaced a nightly batch job with an event-driven pipeline on AWS Lambda and SQS, so reports update within minutes.",
                    "Mentored 8 junior engineers through code review, pairing and a weekly frontend study group.",
                  ],
                },
                { type: "paragraph", style: "jobTitle", text: "Software Engineer" },
                jobMeta("Oakland, CA", "2017 – 2019"),
                {
                  type: "list",
                  style: "bullet",
                  items: [
                    "Shipped the first React Native release of the mobile app, which reached 50k installs in its first quarter.",
                    "Wrote the Playwright end-to-end suite that runs before every weekly release.",
                  ],
                },
                { type: "paragraph", style: "sectionTitle", text: "SELECTED PROJECTS", color: "ink" },
                {
                  type: "paragraph",
                  style: "projectTitle",
                  runs: [{ text: "API Starter CLI" }, { text: "   TypeScript  ·  Node.js", font: "body", size: 8.5, bold: false, color: "accent" }],
                },
                {
                  type: "paragraph",
                  style: "body",
                  lineSpacing: 108,
                  text: "An open-source tool that scaffolds API services with auth, logging and tests built in. 1.2k stars on GitHub.",
                },
                {
                  type: "paragraph",
                  style: "projectTitle",
                  spaceAbove: 6,
                  runs: [{ text: "Live Whiteboard" }, { text: "   Next.js  ·  WebSockets  ·  Redis", font: "body", size: 8.5, bold: false, color: "accent" }],
                },
                {
                  type: "paragraph",
                  style: "body",
                  lineSpacing: 108,
                  text: "A shared whiteboard with live cursors and presence for up to 50 users per room.",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
