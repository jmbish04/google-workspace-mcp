/**
 * @file appscript-templates/types.ts
 * @description Shared types for the container-bound Apps Script template
 * library. Templates are assembled worker-side from these config objects into
 * an Apps Script `files[]` array, then pushed to a bound project over the Apps
 * Script REST API (`projects.updateContent`).
 */

/** Apps Script file kinds accepted by `projects.updateContent`. */
export type ScriptFileType = "SERVER_JS" | "HTML" | "JSON";

/** A single Apps Script project file (code, HTML, or manifest). */
export interface ScriptFile {
  name: string;
  type: ScriptFileType;
  source: string;
}

/** A custom-menu entry: a label wired to a global Apps Script function name. */
export interface MenuItem {
  label: string;
  fn: string;
}

/** Custom-menu config rendered by `onOpen` from `AGENT_CONFIG.menu`. */
export interface MenuConfig {
  /** Menu title (defaults to "Agent"). */
  name?: string;
  items: MenuItem[];
}

/** One question rendered by the sidebar form. */
export interface QuestionField {
  /** Stable key used in the submitted answers object. */
  id: string;
  /** Human-readable prompt shown in the form. */
  label: string;
  /** Control type. `single`/`multi` require `options`. */
  type: "text" | "textarea" | "single" | "multi";
  /** Choices for `single` (radio) / `multi` (checkbox) fields. */
  options?: string[];
}

/** Questions-sidebar config: the form definition + where answers land. */
export interface QuestionsConfig {
  /** Sidebar + default output title. */
  title: string;
  /** Optional blurb shown above the form. */
  intro?: string;
  /** Title used for the output tab/slide (defaults to `title`). */
  outputTitle?: string;
  fields: QuestionField[];
}

/** Web-app template config. */
export interface WebAppConfig {
  title?: string;
}

/**
 * Per-doc config injected into a bound project as `Config.gs`. This is the
 * "project.json dict" an agent supplies when binding a script to a document.
 */
export interface BindConfig {
  /** Apps Script project title. */
  title: string;
  menu?: MenuConfig;
  questions?: QuestionsConfig;
  webapp?: WebAppConfig;
  /** Extra keys are preserved verbatim in `AGENT_CONFIG`. */
  [key: string]: unknown;
}
