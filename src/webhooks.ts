import { decryptString, encryptString, randomId, randomToken, sha256Hex, timingSafeEqualStr } from "./crypto";
import { EVENT_TYPES, type EventType, formatMessage } from "./events";
import { errorJson, json, nowIso, readBodyLimited } from "./http";
import { postEvent } from "./outbound";
import type { Snapshot } from "./snapshot";

export const MAX_NEW_SUBSCRIPTIONS_PER_IP_PER_DAY = 10;
/** Ping attempts (each one is an outbound request) are capped separately so failed pings cannot be used to spray requests. */
export const MAX_REGISTRATION_ATTEMPTS_PER_IP_PER_DAY = 30;
const PING_TIMEOUT_MS = 8000;
export const MAX_TESTS_PER_TARGET_PER_DAY = 10;

const BLOCKED_HOSTS = new Set(["localhost"]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Subscriber URLs must be public https endpoints on the default port.
 * IP literals are rejected outright (this covers private, loopback and link-local ranges);
 * the WHATWG URL parser normalises hex/decimal IPv4 forms first, so they are caught too.
 */
export function validateWebhookUrl(input: unknown): UrlCheck {
  if (typeof input !== "string" || input.length > 2048) return { ok: false, error: "url must be a string under 2048 chars" };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "url is not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "url must use https" };
  if (u.port !== "" && u.port !== "443") return { ok: false, error: "url must use port 443" };
  if (u.username || u.password) return { ok: false, error: "url must not contain credentials" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || /^[0-9a-f:]+$/.test(host)) {
    return { ok: false, error: "url must use a hostname, not an IP address" };
  }
  if (!host.includes(".")) return { ok: false, error: "url must use a public hostname" };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, error: "url must use a public hostname" };
  }
  return { ok: true, url: u.toString() };
}

function parseEvents(x: unknown): EventType[] | null {
  if (x === undefined) return [...EVENT_TYPES];
  if (!Array.isArray(x) || x.length === 0) return null;
  const out: EventType[] = [];
  for (const e of x) {
    if (!(EVENT_TYPES as readonly unknown[]).includes(e)) return null;
    if (!out.includes(e as EventType)) out.push(e as EventType);
  }
  return out;
}

function validBearer(x: unknown): x is string {
  return typeof x === "string" && /^[\x21-\x7e]{1,1024}$/.test(x);
}

async function clientIpHash(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return sha256Hex(`${env.IP_HASH_SALT ?? ""}:${ip}`);
}

export async function handleCreateWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await readBodyLimited(request, 8 * 1024);
  if (raw === null) return errorJson(413, "body_too_large");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return errorJson(400, "invalid_json");
  }

  const urlCheck = validateWebhookUrl(body.url);
  if (!urlCheck.ok) return errorJson(400, "invalid_url", { detail: urlCheck.error });
  const events = parseEvents(body.events);
  if (!events) return errorJson(400, "invalid_events", { allowed: EVENT_TYPES });
  const bearer = body.bearer_token;
  if (bearer !== undefined && bearer !== null && !validBearer(bearer)) {
    return errorJson(400, "invalid_bearer_token", { detail: "1-1024 visible ASCII characters" });
  }

  const ipHash = await clientIpHash(request, env);
  const day = nowIso().slice(0, 10);
  const limits = await env.DB.prepare("SELECT attempts, created FROM registration_limits WHERE ip_hash = ? AND day = ?")
    .bind(ipHash, day)
    .first<{ attempts: number; created: number }>();
  if (
    limits &&
    (limits.created >= MAX_NEW_SUBSCRIPTIONS_PER_IP_PER_DAY || limits.attempts >= MAX_REGISTRATION_ATTEMPTS_PER_IP_PER_DAY)
  ) {
    return errorJson(429, "rate_limited", { detail: "too many new webhooks from this network today (UTC)" });
  }
  await env.DB.prepare(
    `INSERT INTO registration_limits (ip_hash, day, attempts, created) VALUES (?, ?, 1, 0)
     ON CONFLICT (ip_hash, day) DO UPDATE SET attempts = attempts + 1`,
  )
    .bind(ipHash, day)
    .run();

  const id = randomId("wh_");
  const signingSecret = randomToken("whsec_");
  const manageToken = randomToken("vbm_");
  const latest = await env.DB.prepare("SELECT snapshot FROM bulletins ORDER BY month DESC LIMIT 1").first<{
    snapshot: string;
  }>();

  const ping = await postEvent({
    url: urlCheck.url,
    signingSecret,
    bearerToken: typeof bearer === "string" ? bearer : null,
    event: "ping",
    deliveryId: randomId("dl_"),
    message: formatMessage("ping", null),
    data: { subscription_id: id, events, latest: latest ? (JSON.parse(latest.snapshot) as Snapshot) : null },
    timeoutMs: PING_TIMEOUT_MS,
  });
  if (!ping.ok) {
    return errorJson(422, "ping_failed", {
      status: ping.status,
      detail: `${ping.error}; the endpoint must answer the signed ping with a 2xx`,
    });
  }

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (id, url, events, signing_secret_enc, bearer_token_enc, manage_token_sha256, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      urlCheck.url,
      JSON.stringify(events),
      await encryptString(env.TOKEN_ENC_KEY, signingSecret),
      typeof bearer === "string" ? await encryptString(env.TOKEN_ENC_KEY, bearer) : null,
      await sha256Hex(manageToken),
      ipHash,
      now,
    ),
    env.DB.prepare("UPDATE registration_limits SET created = created + 1 WHERE ip_hash = ? AND day = ?").bind(ipHash, day),
  ]);

  return json(
    {
      id,
      url: urlCheck.url,
      events,
      signing_secret: signingSecret,
      manage_token: manageToken,
      note: "signing_secret and manage_token are shown only once. 只显示一次，请保存。",
    },
    201,
  );
}

interface SubscriptionRow {
  id: string;
  url: string;
  events: string;
  manage_token_sha256: string;
  status: string;
  consecutive_failures: number;
  total_deliveries: number;
  total_failures: number;
  last_success_at: string | null;
  disabled_at: string | null;
  created_at: string;
}

/** Returns the row when the bearer manage token matches, a Response otherwise. */
async function authorize(request: Request, env: Env, id: string): Promise<SubscriptionRow | Response> {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer (\S+)$/.exec(auth);
  if (!m) return errorJson(401, "manage_token_required");
  const row = await env.DB.prepare(
    `SELECT id, url, events, manage_token_sha256, status, consecutive_failures, total_deliveries, total_failures,
            last_success_at, disabled_at, created_at
     FROM subscriptions WHERE id = ?`,
  )
    .bind(id)
    .first<SubscriptionRow>();
  const presented = await sha256Hex(m[1]!);
  if (!row || !timingSafeEqualStr(presented, row.manage_token_sha256)) return errorJson(404, "not_found");
  return row;
}

export async function handleGetWebhook(request: Request, env: Env, id: string): Promise<Response> {
  const row = await authorize(request, env, id);
  if (row instanceof Response) return row;
  const last = await env.DB.prepare(
    `SELECT d.id, e.type AS event, d.status, d.attempts, d.last_status_code, d.last_error, d.updated_at
     FROM deliveries d JOIN events e ON e.id = d.event_id
     WHERE d.subscription_id = ? ORDER BY d.updated_at DESC LIMIT 1`,
  )
    .bind(id)
    .first();
  return json({
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    status: row.status,
    created_at: row.created_at,
    consecutive_failures: row.consecutive_failures,
    total_deliveries: row.total_deliveries,
    total_failures: row.total_failures,
    last_success_at: row.last_success_at,
    disabled_at: row.disabled_at,
    last_delivery: last ?? null,
  });
}

export async function handleDeleteWebhook(request: Request, env: Env, id: string): Promise<Response> {
  const row = await authorize(request, env, id);
  if (row instanceof Response) return row;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries WHERE subscription_id = ?").bind(id),
    env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(id),
  ]);
  return new Response(null, { status: 204 });
}

/**
 * Counts one test send for `target` today and says whether it is within the daily cap.
 * Shared with the MCP welcome event (src/mcp-events.ts).
 */
export async function takeTestSend(env: Env, target: string): Promise<boolean> {
  const day = nowIso().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO test_sends (target, day, count) VALUES (?, ?, 1)
     ON CONFLICT (target, day) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(target, day)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= MAX_TESTS_PER_TARGET_PER_DAY;
}

/**
 * POST /v1/webhooks/:id/test: send one `test` event with the current bulletin, now, and report what
 * the endpoint answered. Lets a new subscriber see a real alert without waiting for the next bulletin.
 * Not stored as an event and not counted in the delivery stats.
 */
export async function handleTestWebhook(request: Request, env: Env, id: string): Promise<Response> {
  const row = await authorize(request, env, id);
  if (row instanceof Response) return row;
  const latest = await env.DB.prepare("SELECT snapshot FROM bulletins ORDER BY month DESC LIMIT 1").first<{ snapshot: string }>();
  if (!latest) return errorJson(503, "no_bulletin_yet");
  if (!(await takeTestSend(env, id))) {
    return errorJson(429, "rate_limited", { detail: `at most ${MAX_TESTS_PER_TARGET_PER_DAY} tests per subscription per day (UTC)` });
  }
  const secrets = await env.DB.prepare("SELECT signing_secret_enc, bearer_token_enc FROM subscriptions WHERE id = ?")
    .bind(id)
    .first<{ signing_secret_enc: string; bearer_token_enc: string | null }>();
  const snapshot = JSON.parse(latest.snapshot) as Snapshot;
  const r = await postEvent({
    url: row.url,
    signingSecret: await decryptString(env.TOKEN_ENC_KEY, secrets!.signing_secret_enc),
    bearerToken: secrets!.bearer_token_enc ? await decryptString(env.TOKEN_ENC_KEY, secrets!.bearer_token_enc) : null,
    event: "test",
    deliveryId: randomId("dl_test_"),
    message: formatMessage("test", snapshot),
    data: snapshot,
    timeoutMs: PING_TIMEOUT_MS,
  });
  return json(r.ok ? { delivered: true, status: r.status } : { delivered: false, status: r.status, error: r.error });
}
