// Share card: the 1200x630 image link previews show (og:image), with the latest bulletin's dates.
// Rendered once per bulletin month and USCIS chart by Browser Run (Workers Free: 10 browser
// minutes a day; one card takes a few seconds), stored in D1, served from /og/{key}.png.
// The page points og:image at the latest key, so a new month or chart is a new URL and link
// previews that cached the old image pick up the new one.

import { describeMove, moveClass, moveText } from "./site";
import { CATEGORIES, COUNTRIES, type Cell, type Snapshot } from "./snapshot";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const COUNTRY_NAME: Record<string, string> = { CN: "China mainland", IN: "India" };
/** After a failed render, wait this long before asking Browser Run again. */
const RETRY_MS = 30 * 60 * 1000;

/** What the card binding needs; the real binding is env.BROWSER (Browser Run). */
export interface CardBrowser {
  quickAction(action: "screenshot", options: Record<string, unknown>): Promise<unknown>;
}

export function cardKey(s: Snapshot): string {
  const chart = s.uscis && s.uscis.bulletin === s.bulletin ? s.uscis.employment_chart : null;
  return `${s.bulletin}-${chart ?? "x"}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function cellText(c: Cell): string {
  if (c === "C") return "Current";
  if (c === "U") return "Unavailable";
  const [y, m, d] = c.split("-");
  return `${d} ${MON3[Number(m) - 1]} ${y}`;
}

/** Font files (public/fonts) the card embeds. */
export const CARD_FONTS = {
  "IBMPlexSans-600.woff2": ["IBM Plex Sans", 600],
  "IBMPlexSans-700.woff2": ["IBM Plex Sans", 700],
  "IBMPlexMono-500.woff2": ["IBM Plex Mono", 500],
  "IBMPlexMono-600.woff2": ["IBM Plex Mono", 600],
} as const;

/**
 * `fonts` maps a CARD_FONTS file name to its base64 bytes. They are embedded as data URIs: the
 * card is rendered from an HTML string, a page with no origin, so the browser blocks fonts from
 * any other origin unless they send CORS headers (measured with headless Chrome 2026-10-04).
 */
const CHART_LABEL = { A: "final action date", B: "dates for filing" } as const;

/** "+2 yr 3 mo", "+1 yr", "+5 mo", "+7 d" */
function spanText(months: number, days: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [y ? `${y} yr` : "", m ? `${m} mo` : "", !y && !m && days ? `${days} d` : ""].filter(Boolean);
  return `+${parts.join(" ")}`;
}

/** The single largest forward move against last month, across both countries, categories and charts. */
export function biggestMove(s: Snapshot, previous: Snapshot | null): string | null {
  if (!previous) return null;
  let best: { score: number; text: string } | null = null;
  for (const c of COUNTRIES) {
    for (const cat of CATEGORIES) {
      for (const ch of ["A", "B"] as const) {
        const m = describeMove(previous.dates[c]?.[cat]?.[ch], s.dates[c][cat][ch]);
        if (m.kind !== "forward") continue;
        const score = m.months * 31 + m.days;
        if (!best || score > best.score) {
          best = { score, text: `${COUNTRY_NAME[c]} ${cat.replace("EB", "EB-")} ${CHART_LABEL[ch]} ${spanText(m.months, m.days)}` };
        }
      }
    }
  }
  return best ? `Biggest move: ${best.text}` : null;
}

export function renderCardHtml(
  s: Snapshot,
  previous: Snapshot | null,
  origin: string,
  fonts: Record<string, string> = {},
  /** The maker's X handle (AUTHOR_X); printed on the card so it travels with every share. */
  handle: string | null = null,
): string {
  const host = origin ? new URL(origin).host : "";
  const fontFaces = Object.entries(CARD_FONTS)
    .filter(([file]) => fonts[file])
    .map(([file, [family, weight]]) => `@font-face{font-family:"${family}";font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${fonts[file]}) format("woff2")}`)
    .join("");
  const [y, m] = s.bulletin.split("-");
  const month = `${MONTHS[Number(m) - 1]} ${y}`;
  const chart = s.uscis && s.uscis.bulletin === s.bulletin ? s.uscis.employment_chart : null;
  const uscis = chart
    ? `USCIS: file I-485 with chart ${chart} (${chart === "A" ? "final action" : "dates for filing"}) this month`
    : "USCIS has not picked a chart yet";

  const rows = COUNTRIES.map((c) => {
    const cells = CATEGORIES.map((cat) => {
      const cur = s.dates[c][cat];
      const move = describeMove(previous?.dates[c]?.[cat]?.A, cur.A);
      const mv = moveText(move, "en");
      return `<td><div class="a">${esc(cellText(cur.A))}</div>${
        mv ? `<div class="m"><span class="mv ${moveClass(move)}">${esc(mv)}</span></div>` : ""
      }<div class="b">Filing ${esc(cellText(cur.B))}</div></td>`;
    }).join("");
    return `<tr><th>${COUNTRY_NAME[c]}</th>${cells}</tr>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${fontFaces}
html,body{margin:0;width:1200px;height:630px;background:#fff;font-family:"IBM Plex Sans",sans-serif;color:#0b0c0e}
.wrap{box-sizing:border-box;width:1200px;height:630px;padding:44px 72px 40px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(180deg,#f2f3fc 0%,#fff 70%);border-bottom:10px solid #4f58c9}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:12px;font-size:26px;font-weight:600}
.logo{width:34px;height:34px}
h1{font-size:50px;line-height:1.05;letter-spacing:-1.5px;margin:0;font-weight:700}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;vertical-align:top;padding:10px 0}
thead th{font-size:22px;color:#4f58c9;font-weight:600;padding:0 0 4px}
tbody th{font-size:24px;font-weight:600;width:250px;padding-top:18px}
tbody tr+tr th,tbody tr+tr td{border-top:1px solid #dee0f6}
.a{font-family:"IBM Plex Mono",monospace;font-size:34px;font-weight:600;letter-spacing:-.5px}
.b{font-family:"IBM Plex Mono",monospace;font-size:18px;color:#6b6f76;margin-top:6px}
.m{margin-top:6px}
.mv{font-family:"IBM Plex Sans",sans-serif;font-weight:600;font-size:17px;padding:1px 8px;border-radius:5px;white-space:nowrap}
.mv.up{color:#0a7d3b;background:#e6f6ec}.mv.down{color:#c4281c;background:#fdecea}.mv.flat{color:#6b6f76;background:#f1f2f4}
.bottom{display:flex;align-items:center;justify-content:space-between}
.chip{background:#4f58c9;color:#fff;font-size:24px;font-weight:600;padding:8px 18px;border-radius:9px}
.host{font-family:"IBM Plex Mono",monospace;font-size:24px;font-weight:600}
.big{margin-top:8px;font-size:26px;font-weight:600;color:#3f47b0}
.handle{font-size:24px;font-weight:600;color:#0b0c0e}
</style></head><body><div class="wrap">
<div class="top"><div class="brand"><svg class="logo" viewBox="0 0 24 24"><rect x="1" y="10" width="22" height="7" rx="1.5" fill="#4F58C9"/><rect x="2" y="5" width="13" height="2.4" rx="1.2" fill="#000"/><rect x="2" y="12.3" width="17" height="2.4" rx="1.2" fill="#000"/></svg>Visa Bulletin Push</div><div class="host">${esc(host)}</div></div>
<div><h1>${esc(month)} Visa Bulletin</h1>${(() => {
    const big = biggestMove(s, previous);
    return big ? `<div class="big">${esc(big)}</div>` : "";
  })()}</div>
<table><thead><tr><th>Final action date</th><th>EB-1</th><th>EB-2</th><th>EB-3</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bottom"><div class="chip">${esc(uscis)}</div>${handle ? `<div class="handle">@${esc(handle)} on X</div>` : ""}</div>
</div></body></html>`;
}

/** Base64 of each CARD_FONTS file, read through the static-assets binding (no network request). */
async function loadFonts(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!env.ASSETS) return out;
  await Promise.all(
    Object.keys(CARD_FONTS).map(async (file) => {
      const r = await env.ASSETS!.fetch(new Request(`https://assets.invalid/fonts/${file}`));
      if (!r.ok) return;
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out[file] = btoa(bin);
    }),
  );
  return out;
}

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

async function toBytes(x: unknown): Promise<Uint8Array> {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  // Response or Blob (possibly from another realm, so no instanceof): both have arrayBuffer().
  if (x && typeof (x as { arrayBuffer?: unknown }).arrayBuffer === "function") return new Uint8Array(await (x as Blob).arrayBuffer());
  if (x instanceof ReadableStream) return new Uint8Array(await new Response(x).arrayBuffer());
  throw new Error(`unexpected screenshot result: ${Object.prototype.toString.call(x)}`);
}

export type CardOutcome = "created" | "exists" | "waiting" | "failed" | "no_bulletin" | "no_browser";

/** Make sure the latest bulletin has a card. Cheap when it does: one D1 read. */
export async function ensureCard(env: Env, browser: CardBrowser | undefined, now: Date = new Date()): Promise<CardOutcome> {
  const rows = await env.DB.prepare("SELECT snapshot FROM bulletins ORDER BY month DESC LIMIT 2").all<{ snapshot: string }>();
  const [latestRow, prevRow] = rows.results;
  if (!latestRow) return "no_bulletin";
  const latest = JSON.parse(latestRow.snapshot) as Snapshot;
  const key = cardKey(latest);
  const [have, attempt] = await env.DB.batch([
    env.DB.prepare("SELECT 1 AS ok FROM cards WHERE key = ?").bind(key),
    env.DB.prepare("SELECT value FROM poll_state WHERE key = 'card_attempt'"),
  ]);
  if (have?.results.length) return "exists";
  if (!browser) return "no_browser";
  const last = attempt?.results[0] ? (JSON.parse((attempt.results[0] as { value: string }).value) as { key: string; at: string }) : null;
  if (last && last.key === key && now.getTime() - Date.parse(last.at) < RETRY_MS) return "waiting";
  await env.DB.prepare(
    "INSERT INTO poll_state (key, value, updated_at) VALUES ('card_attempt', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2",
  )
    .bind(JSON.stringify({ key, at: now.toISOString() }), now.toISOString())
    .run();

  const html = renderCardHtml(latest, prevRow ? (JSON.parse(prevRow.snapshot) as Snapshot) : null, env.PUBLIC_URL ?? "", await loadFonts(env), env.AUTHOR_X ?? null);
  try {
    const png = await toBytes(
      await browser.quickAction("screenshot", {
        html,
        viewport: { width: 1200, height: 630 },
        gotoOptions: { waitUntil: "networkidle0", timeout: 30_000 },
      }),
    );
    if (!isPng(png)) throw new Error(`not a PNG (${png.length} bytes)`);
    await env.DB.prepare("INSERT OR REPLACE INTO cards (key, png, created_at) VALUES (?, ?, ?)").bind(key, png, now.toISOString()).run();
    console.log(JSON.stringify({ msg: "card_created", key, bytes: png.length }));
    return "created";
  } catch (e) {
    console.error(JSON.stringify({ msg: "card_failed", key, error: String(e) }));
    return "failed";
  }
}

const CARD_PATH = /^\/og\/(\d{4}-(?:0[1-9]|1[0-2])-[ABx])\.png$/;

/** GET /og/{key}.png; null when the path is not a card path. */
export async function handleCard(env: Env, pathname: string): Promise<Response | null> {
  const m = CARD_PATH.exec(pathname);
  if (!m) return null;
  const row = await env.DB.prepare("SELECT png FROM cards WHERE key = ?").bind(m[1]).first<{ png: ArrayBuffer | number[] }>();
  if (!row) return new Response(null, { status: 302, headers: { location: "/og.png", "cache-control": "no-store" } });
  const bytes = row.png instanceof ArrayBuffer ? new Uint8Array(row.png) : Uint8Array.from(row.png);
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}
