// Snapshot contract "visa-bulletin-push/v1" (publisher -> Worker, also the public latest.json).

export const SCHEMA = "visa-bulletin-push/v1";
export const COUNTRIES = ["CN", "IN"] as const;
export const CATEGORIES = ["EB1", "EB2", "EB3"] as const;
export const CHARTS = ["A", "B"] as const;

export type Country = (typeof COUNTRIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Chart = (typeof CHARTS)[number];
/** ISO date (YYYY-MM-DD), "C" (current) or "U" (unavailable). */
export type Cell = string;
export type Dates = Record<Country, Record<Category, Record<Chart, Cell>>>;

export interface Snapshot {
  schema: typeof SCHEMA;
  bulletin: string; // YYYY-MM
  dates: Dates;
  raw?: Record<string, unknown>;
  uscis: { bulletin: string; employment_chart: Chart; source_url?: string } | null;
  source: { pdf_url: string; pdf_last_modified?: string | null };
  observed_at: string;
}

export type ValidationResult = { ok: true; snapshot: Snapshot } | { ok: false; errors: string[] };

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TOP_KEYS = new Set(["schema", "bulletin", "dates", "raw", "uscis", "source", "observed_at"]);

export function isMonth(s: unknown): s is string {
  return typeof s === "string" && MONTH_RE.test(s);
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isCell(s: unknown): s is Cell {
  return s === "C" || s === "U" || isIsoDate(s);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isHttpsUrl(x: unknown): boolean {
  if (typeof x !== "string" || x.length > 2048) return false;
  try {
    return new URL(x).protocol === "https:";
  } catch {
    return false;
  }
}

function exactKeys(obj: Record<string, unknown>, keys: readonly string[], path: string, errors: string[]): void {
  for (const k of keys) if (!(k in obj)) errors.push(`${path}.${k}: missing`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${path}.${k}: unexpected key`);
}

export function validateSnapshot(x: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(x)) return { ok: false, errors: ["snapshot: must be an object"] };

  for (const k of Object.keys(x)) if (!TOP_KEYS.has(k)) errors.push(`${k}: unexpected key`);
  if (x.schema !== SCHEMA) errors.push(`schema: must be "${SCHEMA}"`);
  if (!isMonth(x.bulletin)) errors.push("bulletin: must be YYYY-MM");

  if (!isObject(x.dates)) {
    errors.push("dates: must be an object");
  } else {
    exactKeys(x.dates, COUNTRIES, "dates", errors);
    for (const c of COUNTRIES) {
      const byCat = x.dates[c];
      if (byCat === undefined) continue;
      if (!isObject(byCat)) {
        errors.push(`${c}: must be an object`);
        continue;
      }
      exactKeys(byCat, CATEGORIES, c, errors);
      for (const cat of CATEGORIES) {
        const cells = byCat[cat];
        if (cells === undefined) continue;
        if (!isObject(cells)) {
          errors.push(`${c}.${cat}: must be an object`);
          continue;
        }
        exactKeys(cells, CHARTS, `${c}.${cat}`, errors);
        for (const ch of CHARTS) {
          if (ch in cells && !isCell(cells[ch])) errors.push(`${c}.${cat}.${ch}: must be YYYY-MM-DD, "C" or "U"`);
        }
      }
    }
  }

  if (!("uscis" in x)) {
    errors.push("uscis: missing (use null when unknown)");
  } else if (x.uscis !== null) {
    const u = x.uscis;
    if (!isObject(u)) {
      errors.push("uscis: must be null or an object");
    } else {
      if (!isMonth(u.bulletin)) errors.push("uscis.bulletin: must be YYYY-MM");
      if (u.employment_chart !== "A" && u.employment_chart !== "B") errors.push('uscis.employment_chart: must be "A" or "B"');
      if (u.source_url !== undefined && !isHttpsUrl(u.source_url)) errors.push("uscis.source_url: must be an https URL");
      for (const k of Object.keys(u)) {
        if (!["bulletin", "employment_chart", "source_url"].includes(k)) errors.push(`uscis.${k}: unexpected key`);
      }
    }
  }

  if (!isObject(x.source)) {
    errors.push("source: must be an object");
  } else {
    if (!isHttpsUrl(x.source.pdf_url)) errors.push("source.pdf_url: must be an https URL");
    const lm = x.source.pdf_last_modified;
    if (lm !== undefined && lm !== null && !(typeof lm === "string" && DATETIME_RE.test(lm))) {
      errors.push("source.pdf_last_modified: must be an ISO date-time or null");
    }
    for (const k of Object.keys(x.source)) {
      if (!["pdf_url", "pdf_last_modified"].includes(k)) errors.push(`source.${k}: unexpected key`);
    }
  }

  if (!(typeof x.observed_at === "string" && DATETIME_RE.test(x.observed_at))) {
    errors.push("observed_at: must be an ISO date-time");
  }

  if (x.raw !== undefined && (!isObject(x.raw) || JSON.stringify(x.raw).length > 4096)) {
    errors.push("raw: must be an object under 4 KB");
  }

  return errors.length ? { ok: false, errors } : { ok: true, snapshot: x as unknown as Snapshot };
}

/** The chart USCIS picked for this snapshot's own bulletin month, or null. */
export function chartForMonth(s: Snapshot): Chart | null {
  return s.uscis && s.uscis.bulletin === s.bulletin ? s.uscis.employment_chart : null;
}

export interface CellChange {
  country: Country;
  category: Category;
  chart: Chart;
  from: Cell;
  to: Cell;
}

export function diffCells(a: Dates, b: Dates): CellChange[] {
  const out: CellChange[] = [];
  for (const country of COUNTRIES)
    for (const category of CATEGORIES)
      for (const chart of CHARTS) {
        const from = a[country][category][chart];
        const to = b[country][category][chart];
        if (from !== to) out.push({ country, category, chart, from, to });
      }
  return out;
}

/** Canonical string of the signal fields only (cells + USCIS chart for this month). */
export function signalString(s: Snapshot): string {
  const cells: string[] = [];
  for (const c of COUNTRIES) for (const cat of CATEGORIES) for (const ch of CHARTS) cells.push(s.dates[c][cat][ch]);
  return `${s.bulletin}|${cells.join(",")}|${chartForMonth(s) ?? "-"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10" -> "Oct 2026" */
export function monthLabelEn(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** "2026-10" -> "2026年10月" */
export function monthLabelZh(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}
