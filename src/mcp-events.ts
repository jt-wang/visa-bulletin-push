// MCP Events extension, webhook delivery mode: events/list, events/subscribe, events/unsubscribe,
// and the signed POSTs that wake a subscriber (ChatGPT "MCP Events", a dot, or any client).
//
// Sources, all read 2026-10-04:
//   [SPEC]   https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
//   [OPENAI] https://developers.openai.com/plugins/build/mcp-events  (what ChatGPT implements)
//   [FIELD]  https://github.com/modelcontextprotocol/experimental-ext-triggers-events/issues/8
//            (ChatGPT delivered end to end on 2026-10-02 against the server below)
//   [REF]    https://github.com/s1980amber-commits/mcp-webhook-events (commit c25c620)
//   [SW]     https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
//
// Flow, step by step:
//   1. Client POSTs events/subscribe {name, arguments: {}, delivery: {mode: "webhook", url, secret}} to /mcp.
//   2. handleSubscribe validates the name, the empty arguments, the whsec_ secret and the URL
//      (same SSRF rules as /v1/webhooks), then derives id = sha256(principal, url, name, arguments).
//   3. Unless this (principal, url) was verified in the last 24 h with the same secret, it POSTs
//      {"type":"verification","challenge":<nonce>} to the URL, signed with the client's secret, and
//      requires a 2xx whose JSON body echoes the nonce (constant-time compare). Otherwise -32015.
//   4. The subscription is stored in D1 (secret AES-GCM encrypted) with expires_at = refreshBefore.
//   5. applySnapshot (src/ingest.ts) inserts one mcp_deliveries row per event x active, unexpired
//      subscription to that event and sends one Queue message {mcp_delivery_id} per row.
//   6. The Queue consumer (src/delivery.ts) POSTs the EventOccurrence body below, signed per [SW],
//      retrying with the /v1/webhooks backoff; 410 and 413 are final.
//
// Not confirmed here: how ChatGPT's receiver treats our verification POST and deliveries (only
// [FIELD] reports it working, against another server); whether ChatGPT accepts an unauthenticated
// MCP endpoint for events (see PRINCIPAL below).

import {
  decodeWhsec,
  decryptString,
  encryptString,
  randomToken,
  sha256Hex,
  standardWebhooksSign,
  timingSafeEqualStr,
  toHex,
} from "./crypto";
import { EVENT_TYPES, type EventType, formatMessage, messageFooter } from "./events";
import { nowIso } from "./http";
import { USER_AGENT } from "./outbound";
import type { Snapshot } from "./snapshot";
import { takeTestSend, validateWebhookUrl } from "./webhooks";

/**
 * [SPEC] "Subscription Identity": webhook mode MUST have an authenticated principal and servers MUST
 * reject unauthenticated calls with -32012. This MCP endpoint has no accounts (design: no accounts in
 * v1), so every caller is the same principal. Choice (2026-10-04): follow [REF]'s default
 * (`principal = "anonymous"`), with which ChatGPT subscribed in [FIELD]; [OPENAI] asks for an
 * "authenticated MCP endpoint" but does not say ChatGPT refuses an unauthenticated one.
 * Consequence: anyone who knows a callback URL can unsubscribe it. Rotating its secret is not
 * possible without passing a new handshake signed with that secret (see needsVerification).
 */
export const PRINCIPAL = "anonymous";

/** [REF]: default lifetime 7 days, minimum 1 hour; ChatGPT accepted these grants in [FIELD]. */
export const MAX_TTL_MS = 7 * 86_400_000;
export const MIN_TTL_MS = 3_600_000;
export const VERIFY_CACHE_MS = 86_400_000;
/** [SPEC] secret rotation: dual-sign for "a short grace window"; [REF] uses 24 h. */
export const ROTATION_WINDOW_MS = 86_400_000;
export const MAX_MCP_SUBSCRIPTIONS = 5000;
export const MAX_VERIFICATIONS_PER_URL_PER_DAY = 10;
export const VERIFY_TIMEOUT_MS = 8000;
/** [OPENAI]/[SPEC]: one event per request, body at most 256 KiB. */
export const MAX_EVENT_BODY_BYTES = 256 * 1024;

// [SPEC] error codes table.
export const INVALID_PARAMS = -32602;
export const NOT_FOUND = -32011;
export const RESOURCE_EXHAUSTED = -32013;
export const UNSUPPORTED = -32014;
export const CALLBACK_ENDPOINT_ERROR = -32015;

/** [SPEC] "Webhook Delivery Status": lastError / data.reason categories. */
export type FailureCategory = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export type RpcOutcome =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } };

const err = (code: number, message: string, data?: unknown): RpcOutcome => ({
  error: data === undefined ? { code, message } : { code, message, data },
});

// ---- events/list ----

const CELL = { type: "string", pattern: "^(\\d{4}-\\d{2}-\\d{2}|C|U)$", description: "YYYY-MM-DD cutoff, C = current, U = unavailable" };
const PAIR = {
  type: "object",
  properties: { A: { ...CELL, description: "Final Action Date" }, B: { ...CELL, description: "Date for Filing" } },
  required: ["A", "B"],
};
const COUNTRY_DATES = { type: "object", properties: { EB1: PAIR, EB2: PAIR, EB3: PAIR }, required: ["EB1", "EB2", "EB3"] };

/** `data` of every delivered event: the public snapshot (/v1/latest.json shape) plus a one-line `message`. */
export const PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "One-line summary, English then Simplified Chinese" },
    schema: { type: "string", const: "visa-bulletin-push/v1" },
    bulletin: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "Bulletin month YYYY-MM" },
    dates: {
      type: "object",
      description: "Employment-based cutoffs. CN = China mainland-born, IN = India",
      properties: { CN: COUNTRY_DATES, IN: COUNTRY_DATES },
      required: ["CN", "IN"],
    },
    raw: { type: "object", description: "Cells as spelled in the bulletin (e.g. 01JAN22)" },
    uscis: {
      type: ["object", "null"],
      description: "Which chart USCIS accepts for employment-based I-485; null when not announced",
      properties: {
        bulletin: { type: "string" },
        employment_chart: { type: "string", enum: ["A", "B"] },
        source_url: { type: "string" },
      },
    },
    source: {
      type: "object",
      properties: { pdf_url: { type: "string" }, pdf_last_modified: { type: ["string", "null"] } },
      required: ["pdf_url"],
    },
    observed_at: { type: "string", format: "date-time" },
  },
  required: ["message", "schema", "bulletin", "dates", "uscis", "source", "observed_at"],
};

const DESCRIPTIONS: Record<EventType, string> = {
  "bulletin.published":
    "A new monthly US Visa Bulletin was published: employment-based cutoff dates (EB1, EB2 and EB3, China mainland-born and India, Final Action A and Dates for Filing B). About once a month.",
  "bulletin.updated":
    "The State Department corrected cutoff dates in the current bulletin. data is the corrected snapshot; message lists the changed cells.",
  "uscis.chart_decided":
    "USCIS announced (or changed) which chart, A or B, employment-based I-485 filers must use this month.",
};

/** No filters: every event is about one public document. New optional filters can be added later ([SPEC] "Schema evolution"). */
const INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export function listEvents(): RpcOutcome {
  return {
    result: {
      events: EVENT_TYPES.map((name) => ({
        name,
        description: DESCRIPTIONS[name],
        delivery: ["webhook"],
        inputSchema: INPUT_SCHEMA,
        payloadSchema: PAYLOAD_SCHEMA,
      })),
    },
  };
}

// ---- helpers ----

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** [SPEC]/[OPENAI]: deterministic over (principal, delivery.url, name, arguments); [REF] uses the same hash. */
export async function subscriptionId(principal: string, url: string, name: string, args: unknown): Promise<string> {
  return "sub_" + (await sha256Hex(canonicalJson([principal, url, name, args]))).slice(0, 32);
}

function isoPlus(ms: number, now = Date.now()): string {
  return nowIso(new Date(now + ms));
}

/**
 * [SPEC] "Subscription TTL": the grant SHOULD be <= the suggestion, except a floor clamp; there is
 * no rejection path for TTL values. `ttlMs: null` asks for no expiry; a server unwilling to grant it
 * returns a finite refreshBefore. Choice: [REF]'s 7-day cap / 1-hour floor, null -> 7 days.
 * A non-numeric ttlMs is treated as omitted.
 */
export function grantTtlMs(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return MAX_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(Math.floor(ttlMs), MAX_TTL_MS));
}

type Parsed = { name: EventType; args: Record<string, never>; delivery: Record<string, unknown>; url: string };

function parseCommon(params: Record<string, unknown>): Parsed | RpcOutcome {
  const name = params.name;
  if (typeof name !== "string") return err(INVALID_PARAMS, "name must be a string");
  if (!(EVENT_TYPES as readonly string[]).includes(name)) return err(NOT_FOUND, `Unknown event: ${name}`, { kind: "event" });
  const args = params.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args) || args === null || Object.keys(args).length > 0) {
    return err(INVALID_PARAMS, "arguments must be an empty object (these events take no filters)");
  }
  const delivery = params.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return err(INVALID_PARAMS, "delivery is required");
  const d = delivery as Record<string, unknown>;
  // [SPEC]/[OPENAI] examples always send mode "webhook"; an absent mode is read as webhook,
  // since events/subscribe exists only for webhook delivery ([SPEC] "Subscribing").
  if (d.mode !== undefined && d.mode !== "webhook") {
    return err(UNSUPPORTED, "Only webhook delivery is supported", { feature: "deliveryMode", value: d.mode });
  }
  const urlCheck = validateWebhookUrl(d.url);
  if (!urlCheck.ok) return err(INVALID_PARAMS, `delivery.url: ${urlCheck.error}`);
  return { name: name as EventType, args: {} as Record<string, never>, delivery: d, url: urlCheck.url };
}

// ---- outbound ----

export interface McpPost {
  url: string;
  /** Current secret first; during rotation also the previous one ([SW] space-delimited signatures). */
  secrets: string[];
  msgId: string;
  subscriptionId: string;
  body: string;
  timeoutMs: number;
  readBody?: boolean;
}

export type McpPostResult = { status: number | null; category: FailureCategory | null; text: string };

export function categorize(status: number): FailureCategory | null {
  if (status >= 200 && status < 300) return null;
  // 3xx (redirects are not followed) has no category of its own in [SPEC]; it is reported as http_4xx.
  return status >= 500 ? "http_5xx" : "http_4xx";
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return "";
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * One signed POST ([SW] headers + X-MCP-Subscription-Id). Timestamp and signature are generated per
 * attempt. Redirects are not followed.
 *
 * [SPEC] "SSRF prevention" also requires resolving the hostname and connecting to the validated IP.
 * Workers fetch() offers no way to pin the address it connects to, so that part is not implemented:
 * the URL rules of validateWebhookUrl are applied at subscribe time and again before every delivery.
 */
export async function postMcpWebhook(p: McpPost): Promise<McpPostResult> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sigs = await Promise.all(p.secrets.map((s) => standardWebhooksSign(s, p.msgId, ts, p.body)));
  try {
    const res = await fetch(p.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "webhook-id": p.msgId,
        "webhook-timestamp": ts,
        "webhook-signature": sigs.join(" "),
        "x-mcp-subscription-id": p.subscriptionId,
      },
      body: p.body,
      redirect: "manual",
      signal: AbortSignal.timeout(p.timeoutMs),
    });
    let text = "";
    if (p.readBody && res.status >= 200 && res.status < 300) text = await readLimited(res, 4096);
    else await res.body?.cancel();
    return { status: res.status, category: categorize(res.status), text };
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    // Workers fetch does not tell refused connections from TLS failures; both map to connection_refused.
    return { status: null, category: name === "TimeoutError" ? "timeout" : "connection_refused", text: "" };
  }
}

/** [SPEC] "Endpoint verification" (a) / [OPENAI] "Verify the callback". */
async function verifyCallback(url: string, secret: string, subId: string): Promise<FailureCategory | null> {
  const challenge = randomToken("", 32);
  const body = JSON.stringify({ type: "verification", challenge });
  const r = await postMcpWebhook({
    url,
    secrets: [secret],
    msgId: "msg_verification_" + toHex(crypto.getRandomValues(new Uint8Array(12))),
    subscriptionId: subId,
    body,
    timeoutMs: VERIFY_TIMEOUT_MS,
    readBody: true,
  });
  if (r.category) return r.category;
  let echoed: unknown;
  try {
    echoed = (JSON.parse(r.text) as { challenge?: unknown })?.challenge;
  } catch {
    return "challenge_failed";
  }
  return typeof echoed === "string" && timingSafeEqualStr(echoed, challenge) ? null : "challenge_failed";
}

// ---- events/subscribe ----

interface SubRow {
  id: string;
  secret_enc: string;
  secret_sha256: string;
  old_secret_enc: string | null;
  old_secret_until: string | null;
  status: string;
  last_delivery_at: string | null;
  last_error: string | null;
  failed_since: string | null;
}

export async function handleSubscribe(env: Env, params: Record<string, unknown>): Promise<RpcOutcome> {
  const parsed = parseCommon(params);
  if ("error" in parsed || "result" in parsed) return parsed;
  const secret = parsed.delivery.secret;
  if (!decodeWhsec(secret)) {
    return err(INVALID_PARAMS, "delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes");
  }
  const { name, args, url } = parsed;
  const id = await subscriptionId(PRINCIPAL, url, name, args);
  const nowMs = Date.now();
  const now = nowIso(new Date(nowMs));
  const today = now.slice(0, 10);
  const secretHash = await sha256Hex(secret as string);
  const urlHash = await sha256Hex(url);

  const [, , , , existingRes, verifiedRes, countRes, attemptsRes] = await env.DB.batch([
    // Forget what is no longer needed: lapsed subscriptions (with their URL and secret), old handshakes.
    env.DB.prepare(
      "DELETE FROM mcp_deliveries WHERE subscription_id IN (SELECT id FROM mcp_subscriptions WHERE expires_at <= ?)",
    ).bind(now),
    env.DB.prepare("DELETE FROM mcp_subscriptions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM mcp_verified_callbacks WHERE verified_at <= ?").bind(isoPlus(-VERIFY_CACHE_MS, nowMs)),
    env.DB.prepare("DELETE FROM mcp_verification_attempts WHERE day < ?").bind(today),
    env.DB.prepare(
      `SELECT id, secret_enc, secret_sha256, old_secret_enc, old_secret_until, status, last_delivery_at, last_error, failed_since
       FROM mcp_subscriptions WHERE id = ?`,
    ).bind(id),
    env.DB.prepare("SELECT secret_sha256 FROM mcp_verified_callbacks WHERE principal = ? AND url = ?").bind(PRINCIPAL, url),
    env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_subscriptions WHERE expires_at > ?").bind(now),
    env.DB.prepare("SELECT attempts FROM mcp_verification_attempts WHERE url_sha256 = ? AND day = ?").bind(urlHash, today),
  ]);
  const existing = existingRes?.results[0] as SubRow | undefined;
  const verified = verifiedRes?.results[0] as { secret_sha256: string } | undefined;
  const active = (countRes?.results[0] as { n: number } | undefined)?.n ?? 0;
  const attempts = (attemptsRes?.results[0] as { attempts: number } | undefined)?.attempts ?? 0;

  if (!existing && active >= MAX_MCP_SUBSCRIPTIONS) {
    return err(RESOURCE_EXHAUSTED, "Subscription limit reached", { limit: "subscriptions", max: MAX_MCP_SUBSCRIPTIONS });
  }

  // [SPEC]/[OPENAI]: verification is cached per (principal, url). Because every caller shares one
  // principal here, the cache is also bound to the secret: a new secret (rotation, or another
  // client pointing at a verified URL) needs a fresh handshake signed with that secret.
  const needsVerification = !verified || verified.secret_sha256 !== secretHash;
  if (needsVerification) {
    // [SPEC]: the verification POST "SHOULD be rate-limited per destination host". Every ChatGPT
    // callback shares one host (connectors.api.openai.com per [FIELD]), so the limit is per URL.
    if (attempts >= MAX_VERIFICATIONS_PER_URL_PER_DAY) {
      return err(RESOURCE_EXHAUSTED, "Too many verification attempts for this URL today (UTC)", {
        limit: "verifications",
        max: MAX_VERIFICATIONS_PER_URL_PER_DAY,
      });
    }
    await env.DB.prepare(
      `INSERT INTO mcp_verification_attempts (url_sha256, day, attempts) VALUES (?, ?, 1)
       ON CONFLICT (url_sha256, day) DO UPDATE SET attempts = attempts + 1`,
    )
      .bind(urlHash, today)
      .run();
    const failure = await verifyCallback(url, secret as string, id);
    if (failure) return err(CALLBACK_ENDPOINT_ERROR, "Callback endpoint error", { reason: failure });
  }

  const expiresAt = isoPlus(grantTtlMs(params.ttlMs), nowMs);
  const stmts: D1PreparedStatement[] = [];
  if (needsVerification) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mcp_verified_callbacks (principal, url, secret_sha256, verified_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (principal, url) DO UPDATE SET secret_sha256 = ?3, verified_at = ?4`,
      ).bind(PRINCIPAL, url, secretHash, now),
    );
  }
  if (existing) {
    const rotating = existing.secret_sha256 !== secretHash;
    stmts.push(
      // [SPEC] "Subscription Identity" table: secret replaced (dual-signed for a grace window), TTL
      // re-granted, active set to true (a refresh reactivates suspended delivery).
      env.DB.prepare(
        `UPDATE mcp_subscriptions SET secret_enc = ?, secret_sha256 = ?, old_secret_enc = ?, old_secret_until = ?,
           expires_at = ?, status = 'active', consecutive_failures = 0, disabled_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).bind(
        rotating ? await encryptString(env.TOKEN_ENC_KEY, secret as string) : existing.secret_enc,
        secretHash,
        rotating ? existing.secret_enc : existing.old_secret_enc,
        rotating ? isoPlus(ROTATION_WINDOW_MS, nowMs) : existing.old_secret_until,
        expiresAt,
        now,
        id,
      ),
    );
  } else {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mcp_subscriptions (id, principal, event, arguments, url, secret_enc, secret_sha256, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(
        id,
        PRINCIPAL,
        name,
        canonicalJson(args),
        url,
        await encryptString(env.TOKEN_ENC_KEY, secret as string),
        secretHash,
        expiresAt,
        now,
      ),
    );
  }
  await env.DB.batch(stmts);
  if (!existing && name === "bulletin.published") {
    // The welcome TEST event (sendWelcome) gives a new subscriber a real alert right away. Delayed so
    // the client has stored the subscription before the first event reaches it. Best effort.
    try {
      await env.DELIVERY_QUEUE.send({ mcp_welcome: id }, { delaySeconds: WELCOME_DELAY_SECONDS });
    } catch (e) {
      console.error(JSON.stringify({ msg: "welcome_enqueue_failed", error: String(e) }));
    }
  }

  const result: Record<string, unknown> = {
    id,
    refreshBefore: expiresAt,
    // [OPENAI]: "Return cursor: null for event types that do not support replay." Ours do not:
    // events are emitted when a poll sees a change, there is no addressable history per subscriber.
    cursor: null,
    truncated: false,
  };
  if (existing) {
    // [SPEC] "Webhook Delivery Status" (optional, refresh only): the status before this refresh.
    result.deliveryStatus = {
      active: existing.status === "active",
      lastDeliveryAt: existing.last_delivery_at,
      lastError: existing.last_error,
      ...(existing.failed_since ? { failedSince: existing.failed_since } : {}),
    };
  }
  return { result };
}

// ---- events/unsubscribe ----

/**
 * [SPEC] says an unknown subscription is -32011 NotFound; [OPENAI] says "Make unsubscribe idempotent"
 * and return an empty result. Choice (2026-10-04): follow [OPENAI], since ChatGPT is the client.
 */
export async function handleUnsubscribe(env: Env, params: Record<string, unknown>): Promise<RpcOutcome> {
  const parsed = parseCommon(params);
  if ("error" in parsed) {
    // A URL that could never have been subscribed matches nothing: still an empty result.
    return parsed.error.code === INVALID_PARAMS && String(parsed.error.message).startsWith("delivery.url")
      ? { result: {} }
      : parsed;
  }
  if ("result" in parsed) return parsed;
  const id = await subscriptionId(PRINCIPAL, parsed.url, parsed.name, parsed.args);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_deliveries WHERE subscription_id = ?").bind(id),
    env.DB.prepare("DELETE FROM mcp_subscriptions WHERE id = ? AND principal = ?").bind(id, PRINCIPAL),
  ]);
  return { result: {} };
}

// ---- event fan-out and body ----

/** One mcp_deliveries row per active, unexpired subscription to this event type. */
export function mcpDeliveryInsert(env: Env, eventId: string, type: EventType, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO mcp_deliveries (id, event_id, subscription_id, created_at, updated_at)
     SELECT 'md_' || lower(hex(randomblob(12))), ?1, s.id, ?2, ?2
     FROM mcp_subscriptions s
     WHERE s.status = 'active' AND s.event = ?3 AND s.expires_at > ?2`,
  ).bind(eventId, now, type);
}

/**
 * [SPEC] EventOccurrence / [OPENAI] "Send an event": {eventId, name, timestamp, data, cursor}.
 * data = the stored snapshot (the public /v1/latest.json shape) with `message` added; [OPENAI] says
 * application fields belong inside data. eventId is our events.id, the same for every subscriber.
 */
export function eventBody(eventId: string, type: string, occurredAt: string, message: string, snapshotJson: string): string {
  const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
  return JSON.stringify({ eventId, name: type, timestamp: occurredAt, data: { message, ...snapshot }, cursor: null });
}

export async function subscriptionSecrets(env: Env, row: { secret_enc: string; old_secret_enc: string | null; old_secret_until: string | null }): Promise<string[]> {
  const out = [await decryptString(env.TOKEN_ENC_KEY, row.secret_enc)];
  if (row.old_secret_enc && row.old_secret_until && row.old_secret_until > nowIso()) {
    out.push(await decryptString(env.TOKEN_ENC_KEY, row.old_secret_enc));
  }
  return out;
}

/**
 * Operator check: send one clearly labelled TEST event to every active `bulletin.published`
 * subscription, synchronously, without storing an event (so it never reaches the Atom feed or
 * /v1/webhooks subscribers). Used to see what a subscribed agent actually receives.
 */
export const WELCOME_DELAY_SECONDS = 30;

/**
 * One TEST event with the current bulletin to a new bulletin.published subscription (queued by
 * handleSubscribe). One attempt, never retried, not stored, not counted in the delivery stats.
 */
export async function sendWelcome(env: Env, subId: string): Promise<void> {
  const now = nowIso();
  const [subRes, latestRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, url, secret_enc, old_secret_enc, old_secret_until FROM mcp_subscriptions
       WHERE id = ? AND status = 'active' AND expires_at > ?`,
    ).bind(subId, now),
    env.DB.prepare("SELECT snapshot FROM bulletins ORDER BY month DESC LIMIT 1"),
  ]);
  const sub = subRes?.results[0] as
    | { id: string; url: string; secret_enc: string; old_secret_enc: string | null; old_secret_until: string | null }
    | undefined;
  const latest = latestRes?.results[0] as { snapshot: string } | undefined;
  if (!sub || !latest || !validateWebhookUrl(sub.url).ok) return;
  if (!(await takeTestSend(env, sub.id))) return;
  const eventId = `evt_test_${randomToken("", 9)}`;
  const message = formatMessage("test", JSON.parse(latest.snapshot) as Snapshot) + messageFooter(env);
  const r = await postMcpWebhook({
    url: sub.url,
    secrets: await subscriptionSecrets(env, sub),
    msgId: eventId,
    subscriptionId: sub.id,
    body: eventBody(eventId, "bulletin.published", now, message, latest.snapshot),
    timeoutMs: 10_000,
  });
  console.log(JSON.stringify({ msg: "welcome_sent", status: r.status, category: r.category }));
}

export async function sendTestEvent(env: Env, marker: string): Promise<Array<{ subscription: string; status: number | null; category: string | null }>> {
  const latest = await env.DB.prepare("SELECT snapshot FROM bulletins ORDER BY month DESC LIMIT 1").first<{ snapshot: string }>();
  if (!latest) return [];
  const now = nowIso();
  const subs = await env.DB.prepare(
    `SELECT id, url, secret_enc, old_secret_enc, old_secret_until FROM mcp_subscriptions
     WHERE event = 'bulletin.published' AND status = 'active' AND expires_at > ? LIMIT 40`,
  )
    .bind(now)
    .all<{ id: string; url: string; secret_enc: string; old_secret_enc: string | null; old_secret_until: string | null }>();
  const message = `TEST ${marker}: test event from ${env.PUBLIC_URL ?? "this server"}. Nothing changed in the Visa Bulletin.`;
  const eventId = `evt_test_${randomToken("", 9)}`;
  return Promise.all(
    subs.results.map(async (s) => {
      const r = await postMcpWebhook({
        url: s.url,
        secrets: await subscriptionSecrets(env, s),
        msgId: eventId,
        subscriptionId: s.id,
        body: eventBody(eventId, "bulletin.published", now, message, latest.snapshot),
        timeoutMs: 10_000,
      });
      return { subscription: s.id, status: r.status, category: r.category };
    }),
  );
}
