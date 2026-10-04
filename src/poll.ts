// Scheduled poll: the whole pipeline runs on Cloudflare (Cron Trigger, every 5 minutes).
//
// 1. HEAD the official bulletin PDF for next month, then this month, on the State
//    Department DAM mirrors (travel.state.gov itself answers automation with a
//    Cloudflare challenge; we never solve it). A 404 means "not published yet".
//    Measured from Cloudflare egress 2026-10-04: October 200, November 404.
// 2. Only when the PDF's ETag changes: download and parse it, then cross-check
//    against the official HTML page (or fall back to the HTML if the PDF can't be read).
// 3. Read the USCIS filing-charts page (If-None-Match) for this month's chart.
// 4. Store + emit events + enqueue webhooks through the same path as /v1/ingest.
// Every failure path sends at most one private alert per kind per UTC day.

import { applySnapshot } from "./ingest";
import { type ParsedBulletin, parseBulletinHtml, parseBulletinPdf } from "./sources/bulletin";
import { USCIS_CHARTS_URL, type UscisChart, parseUscisCharts } from "./sources/uscis";
import { CATEGORIES, CHARTS, COUNTRIES, SCHEMA, type Snapshot, signalString, validateSnapshot } from "./snapshot";

/** Identifies us to the State Department and USCIS; PUBLIC_URL (deployment config) gives them a way to reach the operator. */
export function userAgent(env: Env): string {
  return env.PUBLIC_URL ? `visa-bulletin-push/1.0 (+${env.PUBLIC_URL})` : "visa-bulletin-push/1.0";
}
const MIRRORS = ["adoptions.state.gov", "adoption.state.gov"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export type PollOutcome = "published" | "unchanged" | "mismatch" | "failed" | "busy" | "skipped";
export interface PollResult {
  outcome: PollOutcome;
  bulletin?: string;
  detail?: string;
  source?: "pdf" | "html" | "cache";
}

type Fetcher = typeof fetch;

interface PdfState {
  bulletin: string;
  length: string | null;
  last_modified: string | null;
  parsed: ParsedBulletin;
  parsed_at?: string;
}
/**
 * The DAM mirrors sit behind several servers: measured 2026-10-04, eight HEADs to the same PDF
 * returned eight different ETag / Last-Modified values and one Content-Length (232,669). So
 * "unchanged" means same month + same length, and the PDF is re-read once a day anyway (a full read costs ~25 ms CPU; the free plan allows 10 ms with rare overruns).
 */
const PDF_REREAD_MS = 24 * 60 * 60 * 1000;
interface UscisState {
  etag: string | null;
  entries: UscisChart[];
  checked_at?: string;
  attempted_at?: string;
}
/** While this month's chart is unknown, ask USCIS at most every 15 minutes. */
const USCIS_RETRY_MS = 15 * 60 * 1000;
/** USCIS states the chart once a month; re-check at most every six hours once this month's chart is known. */
const USCIS_RECHECK_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// State

async function getState<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM poll_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

async function setState(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO poll_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
  )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

/** One private alert per kind per UTC day; the date is only recorded after a successful send. */
async function alertOnce(env: Env, fetcher: Fetcher, kind: string, text: string, today: string): Promise<boolean> {
  console.error(JSON.stringify({ msg: "poll_alert", kind, text }));
  if ((await getState<string>(env, `alert:${kind}`)) === today) return false;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const r = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `⚠️ Visa Bulletin Push: ${text}`, disable_web_page_preview: true }),
    });
    if (!r.ok) return false;
  } catch {
    return false;
  }
  await setState(env, `alert:${kind}`, today);
  return true;
}

// ---------------------------------------------------------------------------
// Sources

function candidateMonths(now: Date): Array<[number, number]> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return [m === 12 ? [y + 1, 1] : [y, m + 1], [y, m]];
}

/**
 * Polite cadence. Cron fires every minute but a check only goes out when due:
 * every 3 minutes from the 5th of the month until the next bulletin appears (they have come out
 * between the 8th and the 29th in 2026), hourly otherwise. About 300-500 light requests a day.
 */
const FAST_MS = 3 * 60 * 1000;
const SLOW_MS = 60 * 60 * 1000;
const JITTER_MS = 20 * 1000;

function splitMonth(k: string): [number, number] {
  return [Number(k.slice(0, 4)), Number(k.slice(5, 7))];
}

function nextMonth([y, m]: [number, number]): [number, number] {
  return m === 12 ? [y + 1, 1] : [y, m + 1];
}

export function inFastWindow(now: Date, known: string | null): boolean {
  if (!known) return true;
  const [y, m] = splitMonth(known);
  return now.getTime() >= Date.UTC(y, m - 1, 5);
}

export function isDue(now: Date, known: string | null, lastCheckMs: number | null): boolean {
  if (lastCheckMs === null) return true;
  return now.getTime() - lastCheckMs >= (inFastWindow(now, known) ? FAST_MS : SLOW_MS) - JITTER_MS;
}

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const pdfName = (y: number, m: number) => `visabulletin_${MONTHS[m - 1]![0]!.toUpperCase()}${MONTHS[m - 1]!.slice(1)}${y}.pdf`;
const htmlPath = (y: number, m: number) =>
  `/content/travel/en/legal/visa-law0/visa-bulletin/${m >= 10 ? y + 1 : y}/visa-bulletin-for-${MONTHS[m - 1]}-${y}.html`;

function httpDateToIso(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function findPdf(fetcher: Fetcher, months: Array<[number, number]>, ua: string) {
  const tried: string[] = [];
  for (const [y, m] of months) {
    // The alias host is only a fallback for errors; a 404 on the main mirror means "not published".
    for (const host of MIRRORS) {
      const url = `https://${host}/content/dam/visas/Bulletins/${pdfName(y, m)}`;
      try {
        const r = await fetcher(url, { method: "HEAD", headers: { "user-agent": ua } });
        const ct = (r.headers.get("content-type") ?? "").toLowerCase();
        if (r.status === 200 && (!ct || ct.includes("pdf"))) {
          return { y, m, url, length: r.headers.get("content-length"), lastModified: r.headers.get("last-modified"), tried };
        }
        tried.push(`${host} ${pdfName(y, m)}: HTTP ${r.status}${ct ? ` ${ct}` : ""}`);
        if (r.status < 500) break;
      } catch (e) {
        tried.push(`${host} ${pdfName(y, m)}: ${String(e)}`);
      }
    }
  }
  return { tried };
}

async function readPdf(fetcher: Fetcher, url: string, bulletin: string, ua: string): Promise<ParsedBulletin> {
  const r = await fetcher(url, { headers: { "user-agent": ua } });
  if (r.status !== 200) throw new Error(`PDF GET HTTP ${r.status}`);
  const parsed = await parseBulletinPdf(new Uint8Array(await r.arrayBuffer()));
  if (parsed.bulletin !== bulletin) throw new Error(`PDF title is ${parsed.bulletin}, expected ${bulletin}`);
  return parsed;
}

async function readHtml(fetcher: Fetcher, y: number, m: number, ua: string): Promise<ParsedBulletin | null> {
  for (const host of MIRRORS) {
    try {
      const r = await fetcher(`https://${host}${htmlPath(y, m)}`, { headers: { "user-agent": ua } });
      if (r.status !== 200) continue;
      const parsed = parseBulletinHtml(await r.text());
      if (parsed.bulletin === monthKey(y, m)) return parsed;
    } catch {
      // try the next host; the cross-check is best effort
    }
  }
  return null;
}

function diffDates(a: ParsedBulletin, b: ParsedBulletin): string[] {
  const out: string[] = [];
  for (const c of COUNTRIES)
    for (const cat of CATEGORIES)
      for (const ch of CHARTS) {
        const x = a.dates[c][cat][ch];
        const y = b.dates[c][cat][ch];
        if (x !== y) out.push(`${c} ${cat} ${ch}: PDF ${x}, HTML ${y}`);
      }
  return out;
}

// ---------------------------------------------------------------------------
// Poll

/**
 * One poll at a time. The cron tick and a manual /v1/admin/poll can overlap; without this both
 * would see "new bulletin" and emit the events twice. A lease (not a hard lock) so a crashed run
 * frees itself after LOCK_MS.
 */
const LOCK_MS = 90_000;

async function acquireLock(env: Env, now: Date, token: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `INSERT INTO poll_state (key, value, updated_at) VALUES ('lock', ?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2
     WHERE json_extract(poll_state.value, '$.until') < ?3`,
  )
    .bind(JSON.stringify({ until: new Date(now.getTime() + LOCK_MS).toISOString(), token }), now.toISOString(), now.toISOString())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

async function releaseLock(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM poll_state WHERE key = 'lock' AND json_extract(value, '$.token') = ?").bind(token).run();
}

export async function runPoll(env: Env, now: Date = new Date(), fetcher: Fetcher = fetch): Promise<PollResult> {
  const [health, pdf] = await Promise.all([getState<{ checked_at: string }>(env, "health"), getState<PdfState>(env, "pdf")]);
  if (!isDue(now, pdf?.bulletin ?? null, health ? Date.parse(health.checked_at) : null)) return { outcome: "skipped" };
  const token = crypto.randomUUID();
  if (!(await acquireLock(env, now, token))) return { outcome: "busy" };
  let result: PollResult = { outcome: "failed", detail: "exception" };
  try {
    result = await pollOnce(env, now, fetcher);
    return result;
  } finally {
    await setState(env, "health", { checked_at: now.toISOString(), outcome: result.outcome, bulletin: result.bulletin ?? null });
    await releaseLock(env, token);
  }
}

async function pollOnce(env: Env, now: Date, fetcher: Fetcher): Promise<PollResult> {
  const today = now.toISOString().slice(0, 10);

  const prev = await getState<PdfState>(env, "pdf");
  const recent = !!prev?.parsed_at && now.getTime() - Date.parse(prev.parsed_at) < PDF_REREAD_MS;
  // Which months to ask about: only the expected next one while it is due, plus the known one hourly
  // (or when its daily re-read is due) to catch corrections.
  let months: Array<[number, number]>;
  if (!prev) months = candidateMonths(now);
  else {
    const known = splitMonth(prev.bulletin);
    months = inFastWindow(now, prev.bulletin) && recent ? [nextMonth(known)] : [nextMonth(known), known];
  }
  const hit = await findPdf(fetcher, months, userAgent(env));
  if (!("url" in hit) || !hit.url) {
    if (!prev) {
      await alertOnce(env, fetcher, "fetch", `no bulletin PDF found on the State Department mirrors.\n${hit.tried.join("\n")}`, today);
      return { outcome: "failed", detail: hit.tried.join("; ") };
    }
  }
  const found =
    "url" in hit && hit.url
      ? hit
      : (() => {
          const [ky, km] = splitMonth(prev!.bulletin);
          return {
            y: ky,
            m: km,
            url: `https://${MIRRORS[0]}/content/dam/visas/Bulletins/${pdfName(ky, km)}`,
            length: prev!.length,
            lastModified: prev!.last_modified,
            tried: hit.tried,
          };
        })();
  const { y, m } = found;
  const bulletin = monthKey(y, m);

  // Bulletin dates: reuse the last parse while the PDF is unchanged.
  let parsed: ParsedBulletin | null = null;
  let source: PollResult["source"] = "cache";
  if (prev && found.length && prev.length === found.length && prev.bulletin === bulletin && recent) {
    parsed = prev.parsed;
  } else {
    let pdfErr = "";
    try {
      parsed = await readPdf(fetcher, found.url, bulletin, userAgent(env));
      source = "pdf";
    } catch (e) {
      pdfErr = String(e);
    }
    const html = await readHtml(fetcher, y, m, userAgent(env));
    if (!parsed) {
      if (!html) {
        await alertOnce(
          env,
          fetcher,
          "parse",
          `the ${bulletin} bulletin is out but could not be read (layout change?). Nothing was published.\n${found.url}\n${pdfErr}`,
          today,
        );
        return { outcome: "failed", bulletin, detail: pdfErr };
      }
      parsed = html;
      source = "html";
    } else if (html) {
      const diff = diffDates(parsed, html);
      if (diff.length) {
        await alertOnce(env, fetcher, "crosscheck", `${bulletin} PDF and official web page disagree. Nothing was published.\n${diff.join("\n")}`, today);
        return { outcome: "mismatch", bulletin, detail: diff.join("; ") };
      }
    }
  }

  // USCIS chart for this month (non-fatal).
  const uscisPrev = await getState<UscisState>(env, "uscis");
  let entries: UscisChart[] = uscisPrev?.entries ?? [];
  const knownThisMonth = entries.some((e) => e.bulletin === bulletin);
  const fresh = uscisPrev?.checked_at && now.getTime() - Date.parse(uscisPrev.checked_at) < USCIS_RECHECK_MS;
  const triedRecently = uscisPrev?.attempted_at && now.getTime() - Date.parse(uscisPrev.attempted_at) < USCIS_RETRY_MS;
  if (!(knownThisMonth && fresh) && !triedRecently) try {
    await setState(env, "uscis", { ...(uscisPrev ?? { etag: null, entries: [] }), attempted_at: now.toISOString() } satisfies UscisState);
    const headers: Record<string, string> = { "user-agent": userAgent(env) };
    if (uscisPrev?.etag) headers["if-none-match"] = uscisPrev.etag;
    const r = await fetcher(USCIS_CHARTS_URL, { headers });
    if (r.status === 200) {
      const read = parseUscisCharts(await r.text());
      if (read.length) {
        entries = read;
        await setState(env, "uscis", { etag: r.headers.get("etag"), entries, checked_at: now.toISOString(), attempted_at: now.toISOString() } satisfies UscisState);
      } else {
        await alertOnce(env, fetcher, "uscis", `USCIS filing-charts page has no employment-based sentence (wording changed?).\n${USCIS_CHARTS_URL}`, today);
      }
    } else if (r.status === 304 && uscisPrev) {
      await setState(env, "uscis", { ...uscisPrev, checked_at: now.toISOString(), attempted_at: now.toISOString() } satisfies UscisState);
    } else if (r.status !== 304) {
      await alertOnce(env, fetcher, "uscis", `USCIS filing-charts page returned HTTP ${r.status}. Dates still publish.\n${USCIS_CHARTS_URL}`, today);
    }
  } catch (e) {
    await alertOnce(env, fetcher, "uscis", `USCIS filing-charts page failed: ${String(e)}`, today);
  }
  const uscis = entries.find((e) => e.bulletin === bulletin) ?? null;

  const snapshot: Snapshot = {
    schema: SCHEMA,
    bulletin,
    dates: parsed.dates,
    raw: parsed.raw,
    uscis: uscis ? { bulletin, employment_chart: uscis.employment_chart, source_url: USCIS_CHARTS_URL } : null,
    source: {
      pdf_url: `https://travel.state.gov/content/dam/visas/Bulletins/${pdfName(y, m)}`,
      pdf_last_modified: httpDateToIso(found.lastModified),
    },
    observed_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const v = validateSnapshot(snapshot);
  if (!v.ok) {
    await alertOnce(env, fetcher, "parse", `${bulletin} snapshot failed validation: ${v.errors.join(", ")}`, today);
    return { outcome: "failed", bulletin, detail: v.errors.join("; ") };
  }

  const parsedAt = source === "cache" ? prev?.parsed_at : now.toISOString();
  await setState(env, "pdf", { bulletin, length: found.length, last_modified: found.lastModified, parsed, parsed_at: parsedAt } satisfies PdfState);

  const signal = signalString(v.snapshot);
  if ((await getState<string>(env, "applied")) === signal) return { outcome: "unchanged", bulletin, source };

  const r = await applySnapshot(env, v.snapshot);
  if (!r.ok) {
    await alertOnce(env, fetcher, "enqueue", `${bulletin} stored but webhook deliveries could not be queued; the next tick retries.`, today);
    return { outcome: "failed", bulletin, detail: "enqueue_failed" };
  }
  await setState(env, "applied", signal);
  return { outcome: "published", bulletin, source, detail: r.events.map((e) => e.type).join(",") };
}
