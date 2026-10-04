import { CORS_HEADERS, PUBLIC_CACHE, publicJson } from "./http";
import type { Snapshot } from "./snapshot";

export async function getLatest(env: Env): Promise<{ snapshot: Snapshot; updated_at: string } | null> {
  const row = await env.DB.prepare("SELECT snapshot, updated_at FROM bulletins ORDER BY month DESC LIMIT 1").first<{
    snapshot: string;
    updated_at: string;
  }>();
  return row ? { snapshot: JSON.parse(row.snapshot) as Snapshot, updated_at: row.updated_at } : null;
}

export async function getBulletin(env: Env, month: string): Promise<Snapshot | null> {
  const row = await env.DB.prepare("SELECT snapshot FROM bulletins WHERE month = ?").bind(month).first<{ snapshot: string }>();
  return row ? (JSON.parse(row.snapshot) as Snapshot) : null;
}

/** The newest stored bulletin before `month`, for month-over-month moves. */
export async function getPrevious(env: Env, month: string): Promise<Snapshot | null> {
  const row = await env.DB.prepare("SELECT snapshot FROM bulletins WHERE month < ? ORDER BY month DESC LIMIT 1")
    .bind(month)
    .first<{ snapshot: string }>();
  return row ? (JSON.parse(row.snapshot) as Snapshot) : null;
}

const notFound = () => publicJson({ error: "not_found" }, 404);

export async function handleLatest(env: Env): Promise<Response> {
  const latest = await getLatest(env);
  return latest ? publicJson(latest.snapshot) : notFound();
}

export async function handleBulletinIndex(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT month, uscis_chart, updated_at FROM bulletins ORDER BY month DESC LIMIT 240",
  ).all<{ month: string; uscis_chart: string | null; updated_at: string }>();
  if (!rows.results.length) return notFound();
  return publicJson({
    bulletins: rows.results.map((r) => ({
      bulletin: r.month,
      url: `/v1/bulletins/${r.month}.json`,
      uscis_employment_chart: r.uscis_chart,
      updated_at: r.updated_at,
    })),
  });
}

export async function handleBulletin(env: Env, month: string): Promise<Response> {
  const s = await getBulletin(env, month);
  return s ? publicJson(s) : notFound();
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function handleFeed(env: Env, origin: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, type, month, message, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT 50",
  ).all<{ id: string; type: string; month: string; message: string; created_at: string }>();
  const updated = rows.results[0]?.created_at ?? "1970-01-01T00:00:00Z";
  const entries = rows.results
    .map(
      (e) => `  <entry>
    <id>urn:visa-bulletin-push:event:${xmlEscape(e.id)}</id>
    <title>${xmlEscape(e.message.split(" | ")[0] ?? e.message)}</title>
    <updated>${xmlEscape(e.created_at)}</updated>
    <category term="${xmlEscape(e.type)}"/>
    <link href="${xmlEscape(`${origin}/v1/bulletins/${e.month}.json`)}"/>
    <content type="text">${xmlEscape(e.message)}</content>
  </entry>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xmlEscape(`${origin}/feed.atom`)}</id>
  <title>Visa Bulletin Push · 签证排期推送</title>
  <subtitle>Unofficial China/India employment-based Visa Bulletin changes. Not legal advice.</subtitle>
  <updated>${xmlEscape(updated)}</updated>
  <author><name>visa-bulletin-push</name></author>
  <link rel="self" href="${xmlEscape(`${origin}/feed.atom`)}"/>
  <link rel="alternate" href="${xmlEscape(`${origin}/`)}"/>
${entries}
</feed>
`;
  return new Response(xml, {
    headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": PUBLIC_CACHE, ...CORS_HEADERS },
  });
}

/** Checks run hourly at the slowest; no check for 2.5 hours means the cron stopped. */
const STALE_MS = 150 * 60 * 1000;

export async function getHealth(env: Env): Promise<{ checked_at: string; outcome: string; bulletin?: string | null } | null> {
  const row = await env.DB.prepare("SELECT value FROM poll_state WHERE key = 'health'").first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

export async function handleStatus(env: Env): Promise<Response> {
  const [health, latest] = await Promise.all([getHealth(env), getLatest(env)]);
  const healthy = !!health && Date.now() - Date.parse(health.checked_at) < STALE_MS;
  return new Response(
    JSON.stringify({
      healthy,
      last_check: health,
      cadence_seconds: { while_due: 180, otherwise: 3600 },
      latest_bulletin: latest?.snapshot.bulletin ?? null,
      latest_updated_at: latest?.updated_at ?? null,
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS } },
  );
}
