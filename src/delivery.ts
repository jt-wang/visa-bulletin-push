import { decryptString } from "./crypto";
import { nowIso } from "./http";
import type { DeliveryMessage } from "./ingest";
import { MAX_EVENT_BODY_BYTES, eventBody, postMcpWebhook, sendWelcome, subscriptionSecrets } from "./mcp-events";
import { type OutboundResult, postEvent } from "./outbound";
import { validateWebhookUrl } from "./webhooks";

export const MAX_ATTEMPTS = 5;
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 20;
const DELIVERY_TIMEOUT_MS = 10_000;

/** Delay before the next attempt after `attempts` failed ones: 1 min, 4 min, 16 min, 64 min. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 4 ** (attempts - 1), 43_200);
}

interface Row {
  id: string;
  delivery_status: string;
  type: string;
  message: string;
  data: string;
  sub_id: string;
  url: string;
  sub_status: string;
  signing_secret_enc: string;
  bearer_token_enc: string | null;
}

type Msg = Message<DeliveryMessage>;
type Outcome = { msg: Msg; action: "ack" } | { msg: Msg; action: "retry"; delay: number };

/**
 * Queue consumer. Each message names one delivery row (a /v1/webhooks delivery or an MCP event
 * delivery); the batch holds at most max_batch_size (10) messages, so one invocation makes at most
 * 10 external subrequests.
 */
export async function handleQueue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
  const webhook: Array<{ msg: Msg; id: string }> = [];
  const mcp: Array<{ msg: Msg; id: string }> = [];
  const welcomes: Array<{ msg: Msg; id: string }> = [];
  for (const m of batch.messages) {
    const b = m.body as Record<string, unknown> | undefined;
    if (typeof b?.delivery_id === "string") webhook.push({ msg: m, id: b.delivery_id });
    else if (typeof b?.mcp_delivery_id === "string") mcp.push({ msg: m, id: b.mcp_delivery_id });
    else if (typeof b?.mcp_welcome === "string") welcomes.push({ msg: m, id: b.mcp_welcome });
    else m.ack(); // malformed, nothing to do
  }
  // Welcome TEST events: one attempt each, acknowledged whatever the outcome.
  await Promise.all(
    welcomes.map(async ({ msg, id }) => {
      try {
        await sendWelcome(env, id);
      } catch (e) {
        console.error(JSON.stringify({ msg: "welcome_failed", error: String(e) }));
      }
      msg.ack();
    }),
  );
  if (!webhook.length && !mcp.length) return;

  const outcomes = [...(await handleWebhookMessages(webhook, env)), ...(await handleMcpMessages(mcp, env))];
  for (const o of outcomes) {
    if (o.action === "ack") o.msg.ack();
    else o.msg.retry({ delaySeconds: o.delay });
  }
  console.log(
    JSON.stringify({
      msg: "delivery_batch",
      size: batch.messages.length,
      mcp: mcp.length,
      acked: outcomes.filter((o) => o.action === "ack").length,
      retried: outcomes.filter((o) => o.action === "retry").length,
    }),
  );
}

async function handleWebhookMessages(messages: Array<{ msg: Msg; id: string }>, env: Env): Promise<Outcome[]> {
  if (!messages.length) return [];
  const ids = messages.map((m) => m.id);
  const rows = await env.DB.prepare(
    `SELECT d.id, d.status AS delivery_status, e.type, e.message, e.data,
            s.id AS sub_id, s.url, s.status AS sub_status, s.signing_secret_enc, s.bearer_token_enc
     FROM deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN subscriptions s ON s.id = d.subscription_id
     WHERE d.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<Row>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];

  const outcomes = await Promise.all(
    messages.map(async ({ msg, id }): Promise<Outcome> => {
      const row = byId.get(id);
      if (!row || row.delivery_status !== "pending") return { msg, action: "ack" }; // gone or already settled
      if (row.sub_status !== "active") {
        stmts.push(
          env.DB.prepare("UPDATE deliveries SET status = 'skipped', updated_at = ? WHERE id = ?").bind(now, row.id),
        );
        return { msg, action: "ack" };
      }

      let result: OutboundResult;
      try {
        result = await postEvent({
          url: row.url,
          signingSecret: await decryptString(env.TOKEN_ENC_KEY, row.signing_secret_enc),
          bearerToken: row.bearer_token_enc ? await decryptString(env.TOKEN_ENC_KEY, row.bearer_token_enc) : null,
          event: row.type,
          deliveryId: row.id,
          message: row.message,
          data: JSON.parse(row.data) as unknown,
          timeoutMs: DELIVERY_TIMEOUT_MS,
        });
      } catch {
        // Stored secrets unreadable (e.g. TOKEN_ENC_KEY rotated): retrying cannot help.
        result = { ok: false, status: null, error: "decrypt_failed" };
        stmts.push(...finalFailure(env, row, msg.attempts, result, now));
        return { msg, action: "ack" };
      }

      if (result.ok) {
        stmts.push(
          env.DB.prepare(
            `UPDATE deliveries SET status = 'succeeded', attempts = ?, last_status_code = ?, last_error = NULL, updated_at = ?
             WHERE id = ?`,
          ).bind(msg.attempts, result.status, now, row.id),
          env.DB.prepare(
            `UPDATE subscriptions SET consecutive_failures = 0, total_deliveries = total_deliveries + 1,
               last_delivery_id = ?, last_success_at = ? WHERE id = ?`,
          ).bind(row.id, now, row.sub_id),
        );
        return { msg, action: "ack" };
      }

      if (msg.attempts >= MAX_ATTEMPTS) {
        stmts.push(...finalFailure(env, row, msg.attempts, result, now));
        return { msg, action: "ack" };
      }
      stmts.push(
        env.DB.prepare(
          "UPDATE deliveries SET attempts = ?, last_status_code = ?, last_error = ?, updated_at = ? WHERE id = ?",
        ).bind(msg.attempts, result.status, result.error, now, row.id),
        env.DB.prepare("UPDATE subscriptions SET last_delivery_id = ? WHERE id = ?").bind(row.id, row.sub_id),
      );
      return { msg, action: "retry", delay: backoffSeconds(msg.attempts) };
    }),
  );

  if (stmts.length) await env.DB.batch(stmts);
  return outcomes;
}

function finalFailure(
  env: Env,
  row: Row,
  attempts: number,
  result: Extract<OutboundResult, { ok: false }>,
  now: string,
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `UPDATE deliveries SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(attempts, result.status, result.error, now, row.id),
    // SQLite evaluates every right-hand side against the old row, so consecutive_failures + 1 is the new count.
    env.DB.prepare(
      `UPDATE subscriptions SET
         consecutive_failures = consecutive_failures + 1,
         total_deliveries = total_deliveries + 1,
         total_failures = total_failures + 1,
         last_delivery_id = ?1,
         status = CASE WHEN consecutive_failures + 1 >= ?2 THEN 'disabled' ELSE status END,
         disabled_at = CASE WHEN consecutive_failures + 1 >= ?2 AND disabled_at IS NULL THEN ?3 ELSE disabled_at END
       WHERE id = ?4`,
    ).bind(row.id, DISABLE_AFTER_CONSECUTIVE_FAILURES, now, row.sub_id),
  ];
}

// ---- MCP event subscriptions (src/mcp-events.ts) ----

interface McpRow {
  id: string;
  delivery_status: string;
  event_id: string;
  type: string;
  message: string;
  data: string;
  occurred_at: string;
  sub_id: string;
  url: string;
  sub_status: string;
  expires_at: string;
  secret_enc: string;
  old_secret_enc: string | null;
  old_secret_until: string | null;
}

/**
 * Same attempt cap, backoff and disable rule as /v1/webhooks. Differences required by the MCP Events
 * sources (https://developers.openai.com/plugins/build/mcp-events, read 2026-10-04): 410 and 413 are
 * never retried, and the subscription stores only a failure category, never the endpoint's response.
 */
async function handleMcpMessages(messages: Array<{ msg: Msg; id: string }>, env: Env): Promise<Outcome[]> {
  if (!messages.length) return [];
  const ids = messages.map((m) => m.id);
  const rows = await env.DB.prepare(
    `SELECT d.id, d.status AS delivery_status, e.id AS event_id, e.type, e.message, e.data, e.created_at AS occurred_at,
            s.id AS sub_id, s.url, s.status AS sub_status, s.expires_at, s.secret_enc, s.old_secret_enc, s.old_secret_until
     FROM mcp_deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN mcp_subscriptions s ON s.id = d.subscription_id
     WHERE d.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<McpRow>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];

  const final = (row: McpRow, attempts: number, status: number | null, error: string, category: string) => {
    stmts.push(
      env.DB.prepare(
        `UPDATE mcp_deliveries SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      ).bind(attempts, status, error, now, row.id),
      env.DB.prepare(
        `UPDATE mcp_subscriptions SET
           consecutive_failures = consecutive_failures + 1,
           total_deliveries = total_deliveries + 1,
           total_failures = total_failures + 1,
           last_error = ?1,
           failed_since = COALESCE(failed_since, ?3),
           status = CASE WHEN consecutive_failures + 1 >= ?2 THEN 'disabled' ELSE status END,
           disabled_at = CASE WHEN consecutive_failures + 1 >= ?2 AND disabled_at IS NULL THEN ?3 ELSE disabled_at END
         WHERE id = ?4`,
      ).bind(category, DISABLE_AFTER_CONSECUTIVE_FAILURES, now, row.sub_id),
    );
  };

  const outcomes = await Promise.all(
    messages.map(async ({ msg, id }): Promise<Outcome> => {
      const row = byId.get(id);
      if (!row || row.delivery_status !== "pending") return { msg, action: "ack" };
      // Lapsed, disabled, or a URL that no longer passes the rules (checked again at delivery time).
      if (row.sub_status !== "active" || row.expires_at <= now || !validateWebhookUrl(row.url).ok) {
        stmts.push(env.DB.prepare("UPDATE mcp_deliveries SET status = 'skipped', updated_at = ? WHERE id = ?").bind(now, row.id));
        return { msg, action: "ack" };
      }
      let secrets: string[];
      try {
        secrets = await subscriptionSecrets(env, row);
      } catch {
        final(row, msg.attempts, null, "decrypt_failed", "connection_refused");
        return { msg, action: "ack" };
      }
      const body = eventBody(row.event_id, row.type, row.occurred_at, row.message, row.data);
      if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BODY_BYTES) {
        final(row, msg.attempts, null, "too_large", "http_4xx");
        return { msg, action: "ack" };
      }
      const r = await postMcpWebhook({
        url: row.url,
        secrets,
        msgId: row.event_id, // webhook-id = eventId, unchanged across retries
        subscriptionId: row.sub_id,
        body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
      });

      if (!r.category) {
        stmts.push(
          env.DB.prepare(
            `UPDATE mcp_deliveries SET status = 'succeeded', attempts = ?, last_status_code = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
          ).bind(msg.attempts, r.status, now, row.id),
          env.DB.prepare(
            `UPDATE mcp_subscriptions SET consecutive_failures = 0, total_deliveries = total_deliveries + 1,
               last_delivery_at = ?, last_error = NULL, failed_since = NULL WHERE id = ?`,
          ).bind(now, row.sub_id),
        );
        return { msg, action: "ack" };
      }
      if (r.status === 410 || r.status === 413 || msg.attempts >= MAX_ATTEMPTS) {
        final(row, msg.attempts, r.status, r.category, r.category);
        return { msg, action: "ack" };
      }
      stmts.push(
        env.DB.prepare(
          "UPDATE mcp_deliveries SET attempts = ?, last_status_code = ?, last_error = ?, updated_at = ? WHERE id = ?",
        ).bind(msg.attempts, r.status, r.category, now, row.id),
        env.DB.prepare("UPDATE mcp_subscriptions SET last_error = ?, failed_since = COALESCE(failed_since, ?) WHERE id = ?").bind(
          r.category,
          now,
          row.sub_id,
        ),
      );
      return { msg, action: "retry", delay: backoffSeconds(msg.attempts) };
    }),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return outcomes;
}
