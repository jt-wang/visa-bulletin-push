// Parse the official State Department Visa Bulletin (PDF or HTML) into the
// China / India EB-1..EB-3 cells for both charts.
//
// PDF: measured 2026-10-04 on the October and September 2026 bulletins. The
// table text sits in plain literal strings inside Flate-compressed content
// streams, in reading order, split into kerned fragments ("(01)5(O)-3(CT21)").
// Joining every literal and dropping whitespace gives runs like
// "…CHINA-mainlandbornINDIAMEXICOPHILIPPINES1stC01JUL2301FEB23CC2nd…", so one
// anchored pattern per chart reads the rows. No PDF library and no layout
// reconstruction, which keeps CPU inside the free plan's 10 ms.

import { CATEGORIES, type Category, type Cell, type Chart, type Country, type Dates } from "../snapshot";

export interface ParsedBulletin {
  bulletin: string; // YYYY-MM
  dates: Dates;
  raw: Record<Country, Record<Category, Record<Chart, string>>>;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const CELL = "(C|U|\\d{2}[A-Z]{3}\\d{2})";
const LOOSE = "([0-9A-Z]{0,16}?)"; // Mexico + Philippines columns: counted, not validated
const ROWS = new RegExp(
  `^1st${CELL}${CELL}${CELL}${LOOSE}2nd${CELL}${CELL}${CELL}${LOOSE}3rd${CELL}${CELL}${CELL}`,
);
const LABEL: Record<Category, number> = { EB1: 0, EB2: 1, EB3: 2 };

function monthKey(name: string, year: string): string {
  const i = MONTHS.indexOf(name.toLowerCase());
  if (i < 0) throw new Error(`unrecognized bulletin month ${name}`);
  return `${year}-${String(i + 1).padStart(2, "0")}`;
}

/** "01OCT21" -> "2021-10-01"; "C" and "U" pass through. */
export function bulletinDateToIso(token: string): Cell {
  if (token === "C" || token === "U") return token;
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(token);
  const mon = m ? MON3.indexOf(m[2]!) : -1;
  if (!m || mon < 0) throw new Error(`bad bulletin date ${token}`);
  const yy = Number(m[3]);
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  const day = Number(m[1]);
  const iso = `${year}-${String(mon + 1).padStart(2, "0")}-${m[1]}`;
  const d = new Date(Date.UTC(year, mon, day));
  if (d.getUTCMonth() !== mon || d.getUTCDate() !== day) throw new Error(`bad bulletin date ${token}`);
  return iso;
}

function assemble(bulletin: string, cells: Record<Chart, Record<Category, [string, string]>>): ParsedBulletin {
  const raw = { CN: {}, IN: {} } as ParsedBulletin["raw"];
  const dates = { CN: {}, IN: {} } as Dates;
  for (const cat of CATEGORIES) {
    for (const [ci, country] of (["CN", "IN"] as const).entries()) {
      const a = cells.A[cat][ci]!.toUpperCase().replace(/\s+/g, "");
      const b = cells.B[cat][ci]!.toUpperCase().replace(/\s+/g, "");
      raw[country][cat] = { A: a, B: b };
      dates[country][cat] = { A: bulletinDateToIso(a), B: bulletinDateToIso(b) };
    }
  }
  return { bulletin, dates, raw };
}

// ---------------------------------------------------------------------------
// PDF

// Native decoding: String.fromCharCode over a 230 KB PDF cost ~5 ms per call (measured in Node, 2026-10-04).
const LATIN1 = new TextDecoder("latin1");

function latin1(bytes: Uint8Array): string {
  return LATIN1.decode(bytes);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ESC: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

function unescapeLiteral(s: string): string {
  return s.replace(/\\([0-7]{1,3}|.)/gs, (_, c: string) =>
    /^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8) & 255) : (ESC[c] ?? c),
  );
}

/** Every literal string from the PDF's text content streams, joined, whitespace removed. */
export async function pdfFlatText(bytes: Uint8Array): Promise<string> {
  const doc = latin1(bytes);
  if (!doc.startsWith("%PDF")) throw new Error("not a PDF");
  const parts: string[] = [];
  const streamRe = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(doc))) {
    const dictStart = doc.lastIndexOf("<<", m.index);
    const dict = doc.slice(dictStart, m.index);
    // Content streams only: skip fonts (/Length1), images and other typed objects.
    if (!dict.includes("/FlateDecode") || /\/Length1|\/Subtype|\/Type/.test(dict)) continue;
    const start = m.index + m[0].length;
    const endKw = doc.indexOf("endstream", start);
    if (endKw < 0) break;
    streamRe.lastIndex = endKw + 9;
    // Prefer the declared /Length; otherwise drop the EOL before "endstream" (inflate rejects trailing bytes).
    const declared = /\/Length (\d+)(?!\s+\d+\s+R)/.exec(dict);
    let end = declared ? Math.min(start + Number(declared[1]), endKw) : endKw;
    if (!declared) {
      if (doc.charCodeAt(end - 1) === 10) end--;
      if (doc.charCodeAt(end - 1) === 13) end--;
    }
    let text: string;
    try {
      text = latin1(await inflate(bytes.subarray(start, end)));
    } catch {
      continue; // trailing EOL bytes or a stream we do not need
    }
    if (!text.includes("BT")) continue;
    // Drop strings that are dictionary values (/Lang (en-US), /ActualText (...)), not shown text.
    // The September 2026 PDF tags table cells with /Lang, which would otherwise land in the rows.
    const shown = text.replace(/\/[A-Za-z]+\s*\((?:[^()\\]|\\.)*\)/gs, "");
    const lits = shown.match(/\((?:[^()\\]|\\.)*\)/gs);
    if (lits) for (const l of lits) parts.push(unescapeLiteral(l.slice(1, -1)));
  }
  return parts.join("").replace(/\s+/g, "");
}

function chartCells(flat: string, sectionRe: RegExp, which: Chart): Record<Category, [string, string]> {
  const s = flat.search(sectionRe);
  if (s < 0) throw new Error(`chart ${which}: section heading not found`);
  const head = flat.indexOf("Employment-BasedAllChargeability", s);
  const first = head < 0 ? -1 : flat.indexOf("1st", head);
  if (head < 0 || first < 0 || first - head > 400) throw new Error(`chart ${which}: table not found`);
  const header = flat.slice(head, first).toUpperCase();
  const pos = ["CHINA", "INDIA", "MEXICO", "PHILIPPINES"].map((c) => header.indexOf(c));
  if (pos.some((p) => p < 0) || pos.some((p, i) => i > 0 && p < pos[i - 1]!)) {
    throw new Error(`chart ${which}: column order is not CHINA, INDIA, MEXICO, PHILIPPINES`);
  }
  const r = ROWS.exec(flat.slice(first, first + 200));
  if (!r) throw new Error(`chart ${which}: could not read the 1st/2nd/3rd rows`);
  // Groups per row: all, CN, IN, (MX+PH loose)
  const row = (i: number): [string, string] => [r[i * 4 + 2]!, r[i * 4 + 3]!];
  return { EB1: row(LABEL.EB1), EB2: row(LABEL.EB2), EB3: row(LABEL.EB3) };
}

export function parseBulletinFlat(flat: string): ParsedBulletin {
  const t = /(?:ImmigrantNumbersfor|VisaBulletinFor)([A-Za-z]+)(\d{4})/i.exec(flat);
  if (!t) throw new Error("not a visa bulletin (no recognizable title)");
  const bulletin = monthKey(t[1]!, t[2]!);
  return assemble(bulletin, {
    A: chartCells(flat, /FinalActionDatesforEmployment/i, "A"),
    B: chartCells(flat, /DatesforFilingofEmployment/i, "B"),
  });
}

export async function parseBulletinPdf(bytes: Uint8Array): Promise<ParsedBulletin> {
  return parseBulletinFlat(await pdfFlatText(bytes));
}

// ---------------------------------------------------------------------------
// HTML (cross-check and fallback)

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlText(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (e, n: string) => {
      if (n[0] === "#") {
        const code = n[1] === "x" || n[1] === "X" ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
        return code === 160 ? " " : String.fromCharCode(code);
      }
      return ENTITIES[n.toLowerCase()] ?? e;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => htmlText(c[1]!));
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

export function parseBulletinHtml(page: string): ParsedBulletin {
  const t = /<title>\s*Visa Bulletin For\s+([A-Za-z]+)\s+(\d{4})/i.exec(page);
  if (!t) throw new Error("not a visa bulletin page (no recognizable title)");
  const bulletin = monthKey(t[1]!, t[2]!);
  const charts: Partial<Record<Chart, Record<Category, [string, string]>>> = {};
  for (const tm of page.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)) {
    const rows = tableRows(tm[0]);
    if (!rows.length) continue;
    const head = rows[0]!.map((h) => h.toUpperCase());
    if (!head.join(" ").includes("EMPLOYMENT") || !head.join(" ").includes("CHINA")) continue;
    const pre = htmlText(page.slice(Math.max(0, tm.index! - 1500), tm.index)).toUpperCase();
    const which: Chart = pre.lastIndexOf("FINAL ACTION") > pre.lastIndexOf("DATES FOR FILING") ? "A" : "B";
    if (charts[which]) continue;
    const ci = head.findIndex((h) => h.includes("CHINA"));
    const ii = head.findIndex((h) => h.includes("INDIA"));
    if (ci < 0 || ii < 0) throw new Error(`chart ${which}: CHINA/INDIA columns not found`);
    const out: Partial<Record<Category, [string, string]>> = {};
    for (const r of rows.slice(1)) {
      const label = (r[0] ?? "").trim().toLowerCase();
      const cat = label === "1st" ? "EB1" : label === "2nd" ? "EB2" : label === "3rd" ? "EB3" : null;
      if (!cat || out[cat]) continue;
      if (Math.max(ci, ii) >= r.length) throw new Error(`chart ${which} row ${label}: short row`);
      out[cat] = [r[ci]!, r[ii]!];
    }
    if (!out.EB1 || !out.EB2 || !out.EB3) throw new Error(`chart ${which}: missing 1st/2nd/3rd rows`);
    charts[which] = out as Record<Category, [string, string]>;
  }
  if (!charts.A || !charts.B) throw new Error("could not locate both employment tables");
  return assemble(bulletin, { A: charts.A, B: charts.B });
}
