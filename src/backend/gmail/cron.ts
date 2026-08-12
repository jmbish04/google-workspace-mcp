/**
 * @file gmail/cron.ts
 * @description Tiny 5-field cron parser/matcher (minute hour day-of-month month
 * day-of-week) for scheduled sends. Evaluated in UTC — Cloudflare cron triggers
 * fire in UTC, so scheduled-send crons are UTC too. Supports `*`, lists (`a,b`),
 * ranges (`a-b`), and steps (`*​/n`, `a-b/n`). No seconds, no `@macros`, no names.
 */

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 or 7 = Sunday)
];

/** Expand one cron field into the set of matching numbers, or null if malformed. */
function expandField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a;
      hi = b;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      lo = n;
      hi = n;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Whether day-of-month / day-of-week were restricted (affects OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a 5-field cron string, or null if invalid. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => expandField(f, RANGES[i][0], RANGES[i][1]));
  if (sets.some((s) => s === null)) return null;
  const [minute, hour, dom, month, dow] = sets as Set<number>[];
  // Normalize Sunday: allow both 0 and 7.
  if (dow.has(7)) dow.add(0);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/** Does `date` (evaluated in UTC) match the cron? */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minute.has(date.getUTCMinutes())) return false;
  if (!cron.hour.has(date.getUTCHours())) return false;
  if (!cron.month.has(date.getUTCMonth() + 1)) return false;

  const domOk = cron.dom.has(date.getUTCDate());
  const dowOk = cron.dow.has(date.getUTCDay());
  // Vixie cron: when BOTH day fields are restricted, match if EITHER matches.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * True if the cron matched any whole minute in `(sinceMs, nowMs]`. Used by the
 * hourly sweep to fire a due send even if the exact minute's tick was missed.
 * The scan window is capped (default 31 days) so a long-dormant row stays cheap.
 */
export function cronDueSince(expr: string, sinceMs: number, nowMs: number, maxMinutes = 44_640): boolean {
  const cron = parseCron(expr);
  if (!cron) return false;
  const MINUTE = 60_000;
  let start = Math.floor(sinceMs / MINUTE) * MINUTE + MINUTE; // first minute after `since`
  const capStart = nowMs - maxMinutes * MINUTE;
  if (start < capStart) start = Math.floor(capStart / MINUTE) * MINUTE;
  for (let t = start; t <= nowMs; t += MINUTE) {
    if (cronMatches(cron, new Date(t))) return true;
  }
  return false;
}
