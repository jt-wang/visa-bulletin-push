import { randomId, sha256Hex, signatureHeader, timingSafeEqualStr } from "./crypto";
import { type StoredBulletin, decideEvents, formatMessage } from "./events";
import { errorJson, json, nowIso, readBodyLimited } from "./http";
import { mcpDeliveryInsert } from "./mcp-events";
import { type Snapshot, chartForMonth, signalString, validateSnapshot } from "./snapshot";

export const MAX_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;
/** Queues sendBatch accepts at most 100 messages; D1 accepts at most 100 bound parameters. */
const CHUNK = 100;
/** Bounds the work one ingest does (subrequests to Cloudflare services are capped at 1,000). */
const MAX_ENQUEUE_PER_INGEST = 2000;

/** One Queue message per delivery: a /v1/webhooks delivery row or an MCP event delivery row. */
export type DeliveryMessage = { delivery_id: string } | { mcp_delivery_id: string } | { mcp_welcome: string };

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const tsHeader = request.headers.get("x-vb-timestamp") ?? "";
  const sigHeader = request.headers.get("x-vb-signature") ?? "";
  const raw = await readBodyLimited(request, MAX_BODY_BYTES);
  if (raw === null) return errorJson(413, "body_too_large");

  if (!/^\d{1,12}$/.test(tsHeader) || !/^sha256=[0-9a-f]{64}$/.test(sigHeader)) {
    return errorJson(401, "bad_signature");
  }
  const expected = await signatureHeader(env.INGEST_SECRET, tsHeader, raw);
  if (!timingSafeEqualStr(expected, sigHeader)) return errorJson(401, "bad_signature");
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(tsHeader)) > MAX_SKEW_SECONDS) {
    return errorJson(401, "stale_timestamp");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorJson(400, "invalid_json");
  }
  const v = validateSnapshot(parsed);
  if (!v.ok) return errorJson(400, "invalid_snapshot", { details: v.errors });
  const r = await applySnapshot(env, v.snapshot);
  if (!r.ok) return errorJson(503, "enqueue_failed", { bulletin: r.bulletin, events: r.events });
  return json({ ok: true, bulletin: r.bulletin, fingerprint: r.fingerprint, events: r.events, enqueued: r.enqueued });
}

export interface ApplyResult {
  ok: boolean;
  bulletin: string;
  fingerprint: string;
  events: Array<{ id: string; type: string }>;
  enqueued: number;
}

/** Store a validated snapshot, emit events, and enqueue deliveries. Shared by the HTTP ingest and the scheduled poll. */
export async function applySnapshot(env: Env, incoming: Snapshot): Promise<ApplyResult> {

  const [storedRes, latestRes] = await env.DB.batch([
    env.DB.prepare("SELECT snapshot, uscis_chart FROM bulletins WHERE month = ?").bind(incoming.bulletin),
    env.DB.prepare("SELECT month FROM bulletins ORDER BY month DESC LIMIT 1"),
  ]);
  const storedRow = storedRes?.results[0] as { snapshot: string; uscis_chart: "A" | "B" | null } | undefined;
  const stored: StoredBulletin | null = storedRow
    ? { snapshot: JSON.parse(storedRow.snapshot) as Snapshot, uscis_chart: storedRow.uscis_chart }
    : null;
  const latestMonth = (latestRes?.results[0] as { month: string } | undefined)?.month ?? null;

  const { events, merged, changes } = decideEvents(stored, latestMonth, incoming);
  const now = nowIso();
  const fingerprint = await sha256Hex(signalString(merged));
  const mergedJson = JSON.stringify(merged);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO bulletins (month, snapshot, fingerprint, uscis_chart, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (month) DO UPDATE SET snapshot = ?2, fingerprint = ?3, uscis_chart = ?4,
         updated_at = CASE WHEN bulletins.fingerprint = ?3 THEN bulletins.updated_at ELSE ?5 END`,
    ).bind(merged.bulletin, mergedJson, fingerprint, chartForMonth(merged), now),
  ];
  const created: Array<{ id: string; type: string }> = [];
  for (const type of events) {
    const id = randomId("ev_");
    created.push({ id, type });
    stmts.push(
      env.DB.prepare(
        "INSERT INTO events (id, type, month, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, type, merged.bulletin, formatMessage(type, merged, changes), mergedJson, now),
      // One delivery row per active subscription that wants this event type.
      env.DB.prepare(
        `INSERT INTO deliveries (id, event_id, subscription_id, created_at, updated_at)
         SELECT 'dl_' || lower(hex(randomblob(12))), ?1, s.id, ?2, ?2
         FROM subscriptions s
         WHERE s.status = 'active' AND EXISTS (SELECT 1 FROM json_each(s.events) WHERE json_each.value = ?3)`,
      ).bind(id, now, type),
      // And one per active MCP event subscription (events/subscribe, src/mcp-events.ts).
      mcpDeliveryInsert(env, id, type, now),
    );
  }
  await env.DB.batch(stmts);

  // Enqueue every delivery not yet handed to the queue. This also picks up deliveries left
  // behind when a previous ingest stored its events but failed to enqueue (the publisher retries).
  let enqueued = 0;
  try {
    enqueued = await enqueuePending(env);
  } catch (err) {
    console.error(JSON.stringify({ msg: "enqueue_failed", error: String(err) }));
    return { ok: false, bulletin: merged.bulletin, fingerprint, events: created, enqueued: 0 };
  }

  return { ok: true, bulletin: merged.bulletin, fingerprint, events: created, enqueued };
}

async function enqueuePending(env: Env): Promise<number> {
  const tables = [
    { table: "deliveries", body: (id: string): DeliveryMessage => ({ delivery_id: id }) },
    { table: "mcp_deliveries", body: (id: string): DeliveryMessage => ({ mcp_delivery_id: id }) },
  ];
  let total = 0;
  for (const { table, body } of tables) {
    const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE enqueued = 0 ORDER BY created_at LIMIT ?`)
      .bind(MAX_ENQUEUE_PER_INGEST)
      .all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await env.DELIVERY_QUEUE.sendBatch(chunk.map((id) => ({ body: body(id) })));
      await env.DB.prepare(`UPDATE ${table} SET enqueued = 1 WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .run();
    }
    total += ids.length;
  }
  return total;
}
