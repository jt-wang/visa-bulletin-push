import { signatureHeader } from "./crypto";
import { nowIso } from "./http";

export const USER_AGENT = "visa-bulletin-push/1.0";

export interface OutboundEvent {
  url: string;
  signingSecret: string;
  bearerToken: string | null;
  event: string;
  deliveryId: string;
  message: string;
  data: unknown;
  timeoutMs: number;
}

export type OutboundResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };

/** Delivery body; key order matches the Grok Bot webhook shape (source, event, message, sent_at) plus data. */
export function deliveryBody(event: string, message: string, data: unknown, sentAt: string): string {
  return JSON.stringify({ source: "visa-bulletin-push", event, message, sent_at: sentAt, data });
}

/**
 * POST one signed event. Redirects are not followed (a 3xx counts as failure) so a subscriber
 * URL that passed validation cannot bounce the request somewhere else.
 * Never logs the URL's secrets, the bearer token or the signing secret.
 */
export async function postEvent(o: OutboundEvent): Promise<OutboundResult> {
  const sentAt = nowIso();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = deliveryBody(o.event, o.message, o.data, sentAt);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-vb-event": o.event,
    "x-vb-delivery": o.deliveryId,
    "x-vb-timestamp": timestamp,
    "x-vb-signature": await signatureHeader(o.signingSecret, timestamp, body),
  };
  if (o.bearerToken) headers.authorization = `Bearer ${o.bearerToken}`;
  try {
    const res = await fetch(o.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    // Release the connection without buffering an unbounded response body.
    await res.body?.cancel();
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, status: null, error: name === "TimeoutError" ? "timeout" : "network_error" };
  }
}
