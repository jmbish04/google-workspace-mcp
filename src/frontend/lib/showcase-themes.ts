/**
 * @file frontend/lib/showcase-themes.ts
 * @description Curated "design packages" demoed on `/gws/themes` — each defines a
 * heading/body type pairing and a colour system the agent can apply when
 * generating Docs / Slides / Sheets, shown Figma-style (type specimens + palette
 * swatches + a sample block). Web-safe font stacks only (email/Docs-portable).
 */

export interface ThemePackage {
  id: string;
  name: string;
  description: string;
  mode: "light" | "dark";
  headingFont: string;
  bodyFont: string;
  /** Display label for the heading stack (short). */
  headingLabel: string;
  bodyLabel: string;
  colors: {
    bg: string;
    surface: string;
    text: string;
    muted: string;
    heading: string;
    accent: string;
    accentText: string;
    border: string;
  };
  /** Ordered palette swatches (hex). */
  palette: string[];
}

export const THEME_PACKAGES: ThemePackage[] = [
  {
    id: "monolith",
    name: "Monolith",
    description: "Dark, quiet, high-contrast. Blue accent, borderless surfaces. Good for dashboards and technical decks.",
    mode: "dark",
    headingFont: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    bodyFont: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    headingLabel: "Inter / system-ui, 700",
    bodyLabel: "Inter / system-ui, 400",
    colors: {
      bg: "#0f1115",
      surface: "#181b21",
      text: "#e6e8eb",
      muted: "#9aa1ab",
      heading: "#ffffff",
      accent: "#4c8dff",
      accentText: "#ffffff",
      border: "#262b33",
    },
    palette: ["#0f1115", "#181b21", "#4c8dff", "#e6e8eb", "#9aa1ab", "#22c55e", "#f59e0b", "#ef4444"],
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "Serif headings over a warm paper ground. Classic long-form document / report look.",
    mode: "light",
    headingFont: "Georgia,'Times New Roman',Times,serif",
    bodyFont: "Georgia,'Times New Roman',Times,serif",
    headingLabel: "Georgia serif, 700",
    bodyLabel: "Georgia serif, 400",
    colors: {
      bg: "#faf7f2",
      surface: "#ffffff",
      text: "#2b2622",
      muted: "#7a7069",
      heading: "#1a1613",
      accent: "#9c3d2e",
      accentText: "#ffffff",
      border: "#e7ded3",
    },
    palette: ["#faf7f2", "#ffffff", "#9c3d2e", "#1a1613", "#7a7069", "#4b6b4a", "#c99a2e", "#2b2622"],
  },
  {
    id: "corporate",
    name: "Corporate Blue",
    description: "Crisp sans, navy headings, blue accents on white. Safe, professional business documents.",
    mode: "light",
    headingFont: "'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    bodyFont: "'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    headingLabel: "Segoe UI / Roboto, 700",
    bodyLabel: "Segoe UI / Roboto, 400",
    colors: {
      bg: "#f4f6f9",
      surface: "#ffffff",
      text: "#26303b",
      muted: "#66727f",
      heading: "#0f3a5f",
      accent: "#1a73e8",
      accentText: "#ffffff",
      border: "#dfe5ec",
    },
    palette: ["#f4f6f9", "#ffffff", "#1a73e8", "#0f3a5f", "#66727f", "#0f9d58", "#f4b400", "#db4437"],
  },
  {
    id: "warm-minimal",
    name: "Warm Minimal",
    description: "Soft neutrals, terracotta accent, generous space. Friendly, modern brand / marketing feel.",
    mode: "light",
    headingFont: "'Trebuchet MS',Verdana,Geneva,sans-serif",
    bodyFont: "Verdana,Geneva,sans-serif",
    headingLabel: "Trebuchet MS, 700",
    bodyLabel: "Verdana, 400",
    colors: {
      bg: "#fbfaf8",
      surface: "#ffffff",
      text: "#3a352f",
      muted: "#8b8378",
      heading: "#2a2620",
      accent: "#d2694a",
      accentText: "#ffffff",
      border: "#ece7df",
    },
    palette: ["#fbfaf8", "#ffffff", "#d2694a", "#2a2620", "#8b8378", "#6b8f71", "#e0b352", "#3a352f"],
  },
];
