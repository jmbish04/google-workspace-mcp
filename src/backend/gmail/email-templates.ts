/**
 * @file gmail/email-templates.ts
 * @description Built-in Gmail-safe HTML email templates + idempotent seeding.
 * Each template follows email best practices: a 100%-width outer table wrapping a
 * fixed ~600px centered inner table, INLINE styles only (Gmail ignores <style>),
 * web-safe font stacks, and {{placeholders}} for the model to fill. These give
 * the model a solid, tested core instead of hand-rolling fragile HTML.
 */
import { getDb } from "@/backend/db";
import { emailTemplates } from "@db/schemas";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Wrap inner content in the standard responsive-centered email shell. */
function shell(inner: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f4f5f7;margin:0;padding:0;">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:${FONT};color:#202124;">` +
    inner +
    `</table></td></tr></table>`
  );
}

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  html: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: "builtin:announcement",
    name: "Announcement",
    description: "Single-column announcement with a headline, body, and a call-to-action button.",
    category: "notification",
    html: shell(
      `<tr><td style="padding:32px 40px 8px;font-size:22px;font-weight:700;line-height:1.3;">{{headline}}</td></tr>` +
        `<tr><td style="padding:8px 40px;font-size:15px;line-height:1.6;color:#3c4043;">{{body}}</td></tr>` +
        `<tr><td style="padding:16px 40px 32px;"><a href="{{cta_url}}" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">{{cta_label}}</a></td></tr>`,
    ),
  },
  {
    id: "builtin:newsletter",
    name: "Newsletter",
    description: "Header bar, intro paragraph, and a stacked list of story blocks.",
    category: "marketing",
    html: shell(
      `<tr><td style="background:#202124;color:#ffffff;padding:20px 40px;font-size:18px;font-weight:700;">{{title}}</td></tr>` +
        `<tr><td style="padding:24px 40px 8px;font-size:15px;line-height:1.6;color:#3c4043;">{{intro}}</td></tr>` +
        `<tr><td style="padding:8px 40px 32px;font-size:15px;line-height:1.6;color:#3c4043;">{{stories}}</td></tr>`,
    ),
  },
  {
    id: "builtin:receipt",
    name: "Receipt",
    description: "Transactional receipt with an itemized table and total.",
    category: "transactional",
    html: shell(
      `<tr><td style="padding:28px 40px 4px;font-size:20px;font-weight:700;">Receipt</td></tr>` +
        `<tr><td style="padding:0 40px 8px;font-size:13px;color:#5f6368;">{{order_ref}} · {{date}}</td></tr>` +
        `<tr><td style="padding:12px 40px 28px;"><table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px;">{{line_items}}` +
        `<tr><td style="padding:10px 0;border-top:2px solid #202124;font-weight:700;">Total</td><td align="right" style="padding:10px 0;border-top:2px solid #202124;font-weight:700;">{{total}}</td></tr></table></td></tr>`,
    ),
  },
  {
    id: "builtin:plain-professional",
    name: "Plain Professional",
    description: "Minimal, letter-style layout for a clean personal or business note.",
    category: "personal",
    html: shell(
      `<tr><td style="padding:36px 44px;font-size:15px;line-height:1.7;color:#202124;">{{body}}` +
        `<div style="margin-top:24px;color:#5f6368;">{{signature}}</div></td></tr>`,
    ),
  },
];

/** Seed the built-in templates once (idempotent — skips ids that already exist). */
export async function seedBuiltinTemplates(env: Env): Promise<void> {
  const db = getDb(env);
  const now = new Date();
  for (const t of BUILTIN_TEMPLATES) {
    await db
      .insert(emailTemplates)
      .values({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        html: t.html,
        isBuiltin: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}
