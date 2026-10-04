// MCP Events extension (webhook delivery) + the 2026-07-28 "modern" MCP request shape ChatGPT uses.
// Sources read 2026-10-04:
//   spec sketch  https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
//   ChatGPT      https://developers.openai.com/plugins/build/mcp-events
//   field report https://github.com/modelcontextprotocol/experimental-ext-triggers-events/issues/8
//   MCP 2026-07-28 https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { standardWebhooksSign } from "../src/crypto";
import { ingest, insertSubscription, octoberSnapshot, readMcp } from "./helpers";

const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
// 32 random bytes, base64. A valid Standard Webhooks symmetric secret.
const SECRET = "whsec_" + btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)));
const SECRET2 = "whsec_" + btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256)));
const CALLBACK = "https://connectors.example.com/mcp-events/callback_abc123";

// ---- independent Standard Webhooks verifier (not the code under test) ----

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function swSign(secret: string, id: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return "v1," + btoa(String.fromCharCode(...mac));
}

async function swVerify(secret: string, headers: Headers, body: string): Promise<boolean> {
  const id = headers.get("webhook-id")!;
  const ts = headers.get("webhook-timestamp")!;
  const expected = await swSign(secret, id, ts, body);
  return (headers.get("webhook-signature") ?? "").split(" ").includes(expected);
}

// Known vector from the Standard Webhooks reference library
// (standard-webhooks/libraries/python/tests/test_webhooks.py::test_sign_function).
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  ts: "1614265330",
  body: '{"test": 2432232314}',
  sig: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("Standard Webhooks signature", () => {
  it("the test's own verifier reproduces the reference vector and rejects a wrong key", async () => {
    expect(await swSign(VECTOR.secret, VECTOR.id, VECTOR.ts, VECTOR.body)).toBe(VECTOR.sig);
    expect(await swSign("whsec_" + btoa("x".repeat(24)), VECTOR.id, VECTOR.ts, VECTOR.body)).not.toBe(VECTOR.sig);
  });

  it("src signer matches the reference vector (secret is the base64-decoded bytes after whsec_)", async () => {
    expect(await standardWebhooksSign(VECTOR.secret, VECTOR.id, VECTOR.ts, VECTOR.body)).toBe(VECTOR.sig);
  });
});

// ---- MCP request helpers ----

function modern(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}, id = 1) {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
  };
  if (method === "tools/call") h["mcp-name"] = String(params.name);
  return exports.default.fetch("https://vb.example/mcp", {
    method: "POST",
    headers: { ...h, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
  });
}

function legacy(method: string, params?: unknown, id = 1) {
  return exports.default.fetch("https://vb.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
}

function subParams(over: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) {
  return {
    name: "bulletin.published",
    arguments: {},
    delivery: { mode: "webhook", url: CALLBACK, secret: SECRET, ...delivery },
    cursor: null,
    ...over,
  };
}

type Seen = { url: string; headers: Headers; body: string };

/** Fake receiver: checks nothing, echoes the challenge (or a configured reply) and records requests. */
function mockReceiver(reply: "echo" | "wrong" | number | "throw" = "echo"): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.text();
    seen.push({ url: req.url, headers: req.headers, body });
    if (reply === "throw") throw new Error("connection refused");
    if (typeof reply === "number") return new Response("nope", { status: reply });
    const parsed = JSON.parse(body);
    if (parsed.type === "verification") {
      return Response.json({ challenge: reply === "echo" ? parsed.challenge : "not-it" });
    }
    return new Response(null, { status: 200 });
  });
  return seen;
}

async function subscribe(over: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) {
  return readMcp(await modern("events/subscribe", subParams(over, delivery)));
}

beforeEach(() => {
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---- capability + modern protocol ----

describe("capability advertisement", () => {
  it("server/discover advertises events at top level (where ChatGPT reads it) with modern result fields", async () => {
    const res = await modern("server/discover");
    expect(res.status).toBe(200);
    const msg = await readMcp(res);
    expect(msg.result.resultType).toBe("complete");
    expect(msg.result.supportedVersions).toContain(MODERN);
    expect(msg.result.capabilities.events).toEqual({});
    expect(msg.result.capabilities.tools).toBeDefined();
    expect(msg.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("visa-bulletin-push");
    expect(msg.result.ttlMs).toBeGreaterThanOrEqual(0);
    expect(msg.result.cacheScope).toBe("public");
  });

  it("legacy initialize also advertises events", async () => {
    const msg = await readMcp(
      await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }),
    );
    expect(msg.result.capabilities.events).toEqual({});
    expect(msg.result.capabilities.tools).toBeDefined();
  });

  it("modern tools/list and tools/call carry resultType; tools/list carries cache hints", async () => {
    await ingest(octoberSnapshot());
    const list = await readMcp(await modern("tools/list"));
    expect(list.result.resultType).toBe("complete");
    expect(list.result.tools).toHaveLength(3);
    expect(list.result.cacheScope).toBe("public");
    expect(typeof list.result.ttlMs).toBe("number");
    const call = await readMcp(await modern("tools/call", { name: "get_latest_dates", arguments: { country: "CN" } }));
    expect(call.result.resultType).toBe("complete");
    expect(call.result.structuredContent.bulletin).toBe("2026-10");
  });

  it("modern requests: header/body mismatch -> 400 -32020; unsupported version -> 400 -32022; unknown method -> 404", async () => {
    const mismatch = await modern("tools/list", {}, { "mcp-method": "tools/call" });
    expect(mismatch.status).toBe(400);
    expect((await readMcp(mismatch)).error.code).toBe(-32020);

    const noVersionHeader = await exports.default.fetch("https://vb.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }),
    });
    expect(noVersionHeader.status).toBe(400);
    expect((await readMcp(noVersionHeader)).error.code).toBe(-32020);

    const nameMismatch = await modern("tools/call", { name: "get_latest_dates", arguments: {} }, { "mcp-name": "get_bulletin" });
    expect(nameMismatch.status).toBe(400);

    // Mcp-Name may use the =?base64?...?= sentinel; it is decoded before comparing.
    const encoded = await modern("tools/call", { name: "get_latest_dates", arguments: {} }, { "mcp-name": `=?base64?${btoa("get_latest_dates")}?=` });
    expect(encoded.status).toBe(200);

    const future = await exports.default.fetch("https://vb.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
      }),
    });
    expect(future.status).toBe(400);
    const fe = (await readMcp(future)).error;
    expect(fe.code).toBe(-32022);
    expect(fe.data.supported).toContain(MODERN);
    expect(fe.data.requested).toBe("2099-01-01");

    const ping = await modern("ping");
    expect(ping.status).toBe(404); // ping was removed in 2026-07-28
    expect((await readMcp(ping)).error.code).toBe(-32601);
  });
});

// ---- events/list ----

describe("events/list", () => {
  it("lists the three event types, webhook delivery only, no subscription arguments, snapshot payload", async () => {
    const msg = await readMcp(await modern("events/list"));
    expect(msg.result.resultType).toBe("complete");
    const evs = msg.result.events;
    expect(evs.map((e: any) => e.name)).toEqual(["bulletin.published", "bulletin.updated", "uscis.chart_decided"]);
    for (const e of evs) {
      expect(e.delivery).toEqual(["webhook"]);
      expect(typeof e.description).toBe("string");
      expect(e.description.length).toBeLessThan(300);
      expect(e.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(e.payloadSchema.type).toBe("object");
      expect(e.payloadSchema.required).toEqual(
        expect.arrayContaining(["message", "schema", "bulletin", "dates", "uscis", "source", "observed_at"]),
      );
      expect(e.payloadSchema.properties.dates).toBeDefined();
    }
    expect(msg.result.nextCursor).toBeUndefined();
  });

  it("also works on the legacy (initialize-based) path", async () => {
    const msg = await readMcp(await legacy("events/list"));
    expect(msg.result.events).toHaveLength(3);
  });
});

// ---- events/subscribe ----

describe("events/subscribe", () => {
  it("verifies the callback with a signed single-use challenge, then stores the subscription", async () => {
    const seen = mockReceiver("echo");
    const before = Date.now();
    const msg = await subscribe();
    expect(msg.error).toBeUndefined();
    const r = msg.result;
    expect(r.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(r.cursor).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.resultType).toBe("complete");
    // Default grant: 7 days.
    const granted = Date.parse(r.refreshBefore) - before;
    expect(granted).toBeGreaterThan(7 * 86400_000 - 60_000);
    expect(granted).toBeLessThanOrEqual(7 * 86400_000 + 60_000);

    expect(seen).toHaveLength(1);
    const v = seen[0]!;
    expect(v.url).toBe(CALLBACK);
    expect(v.headers.get("content-type")).toMatch(/^application\/json/);
    expect(v.headers.get("webhook-id")).toMatch(/^msg_verification_[0-9a-f]+$/);
    expect(v.headers.get("x-mcp-subscription-id")).toBe(r.id);
    expect(Math.abs(Number(v.headers.get("webhook-timestamp")) - Date.now() / 1000)).toBeLessThan(30);
    expect(await swVerify(SECRET, v.headers, v.body)).toBe(true);
    const body = JSON.parse(v.body);
    expect(Object.keys(body).sort()).toEqual(["challenge", "type"]);
    expect(body.type).toBe("verification");
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const row = await env.DB.prepare("SELECT * FROM mcp_subscriptions").first<any>();
    expect(row).toMatchObject({ id: r.id, event: "bulletin.published", url: CALLBACK, status: "active", arguments: "{}" });
    expect(JSON.stringify(row)).not.toContain(SECRET.slice(6)); // secret only stored encrypted
  });

  it("the challenge is fresh on every handshake", async () => {
    const seen = mockReceiver("echo");
    await subscribe();
    await subscribe({ name: "bulletin.updated" }, { secret: SECRET2 }); // new secret -> new handshake
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[0]!.body).challenge).not.toBe(JSON.parse(seen[1]!.body).challenge);
  });

  const failures: Array<[string, "wrong" | number | "throw", string]> = [
    ["wrong echo", "wrong", "challenge_failed"],
    ["HTTP 404", 404, "http_4xx"],
    ["HTTP 503", 503, "http_5xx"],
    ["network error", "throw", "connection_refused"],
  ];
  for (const [label, reply, reason] of failures) {
    it(`handshake failure (${label}) -> -32015 ${reason}, nothing stored`, async () => {
      mockReceiver(reply);
      const msg = await subscribe();
      expect(msg.error.code).toBe(-32015);
      expect(msg.error.data).toEqual({ reason });
      expect(JSON.stringify(msg.error)).not.toContain("nope"); // never echoes the endpoint's body
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_subscriptions").first<{ n: number }>();
      expect(n!.n).toBe(0);
    });
  }

  const badSecrets = [
    "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", // no prefix
    "whsec_" + btoa("x".repeat(16)), // 16 bytes < 24
    "whsec_" + btoa("x".repeat(65)), // 65 bytes > 64
    "whsec_not base64!!",
    undefined,
  ];
  for (const secret of badSecrets) {
    it(`rejects delivery.secret ${JSON.stringify(secret)} with -32602 before contacting the URL`, async () => {
      const seen = mockReceiver("echo");
      const msg = await subscribe({}, { secret });
      expect(msg.error.code).toBe(-32602);
      expect(seen).toHaveLength(0);
    });
  }

  const badUrls = [
    "http://connectors.example.com/hook",
    "https://10.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://svc.internal/hook",
    "https://example.com:8443/hook",
    "https://user:pass@example.com/hook",
    "not a url",
  ];
  for (const url of badUrls) {
    it(`rejects callback ${url} with -32602 and makes no request (same SSRF rules as /v1/webhooks)`, async () => {
      const seen = mockReceiver("echo");
      const msg = await subscribe({}, { url });
      expect(msg.error.code).toBe(-32602);
      expect(seen).toHaveLength(0);
    });
  }

  it("unknown event -> -32011 NotFound (kind event); other delivery mode -> -32014; arguments not accepted -> -32602", async () => {
    const seen = mockReceiver("echo");
    const unknown = await subscribe({ name: "bulletin.deleted" });
    expect(unknown.error.code).toBe(-32011);
    expect(unknown.error.data).toEqual({ kind: "event" });
    const push = await subscribe({}, { mode: "push" });
    expect(push.error.code).toBe(-32014);
    expect(push.error.data).toEqual({ feature: "deliveryMode", value: "push" });
    const args = await subscribe({ arguments: { country: "CN" } });
    expect(args.error.code).toBe(-32602);
    expect(seen).toHaveLength(0);
  });

  it("is idempotent: same key -> same id, one row, no second handshake; TTL re-granted", async () => {
    const seen = mockReceiver("echo");
    const a = (await subscribe()).result;
    const b = (await subscribe({ ttlMs: 2 * 3600_000 })).result;
    expect(b.id).toBe(a.id);
    expect(seen).toHaveLength(1);
    expect(Date.parse(b.refreshBefore)).toBeLessThan(Date.parse(a.refreshBefore));
    expect(b.deliveryStatus).toMatchObject({ active: true, lastError: null });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_subscriptions").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("a different event name to the same URL is a different subscription (verification cached per URL + secret)", async () => {
    const seen = mockReceiver("echo");
    const a = (await subscribe()).result;
    const b = (await subscribe({ name: "uscis.chart_decided" })).result;
    expect(b.id).not.toBe(a.id);
    expect(seen).toHaveLength(1);
  });

  it("TTL: suggestion honoured, clamped up to 1 hour, capped at 7 days, null answered with a finite grant", async () => {
    mockReceiver("echo");
    const cases: Array<[unknown, number]> = [
      [2 * 3600_000, 2 * 3600_000],
      [1000, 3600_000],
      [30 * 86400_000, 7 * 86400_000],
      [null, 7 * 86400_000],
    ];
    for (const [ttlMs, expected] of cases) {
      const t0 = Date.now();
      const r = (await subscribe({ ttlMs })).result;
      expect(r.refreshBefore).not.toBeNull();
      expect(Math.abs(Date.parse(r.refreshBefore) - t0 - expected)).toBeLessThan(60_000);
    }
  });

  it("a refresh reactivates a disabled subscription and reports its prior delivery status", async () => {
    mockReceiver("echo");
    await subscribe();
    await env.DB.prepare(
      "UPDATE mcp_subscriptions SET status = 'disabled', consecutive_failures = 20, last_error = 'http_5xx', failed_since = '2026-10-01T00:00:00Z'",
    ).run();
    const r = (await subscribe()).result;
    expect(r.deliveryStatus).toMatchObject({ active: false, lastError: "http_5xx", failedSince: "2026-10-01T00:00:00Z" });
    const row = await env.DB.prepare("SELECT status, consecutive_failures FROM mcp_subscriptions").first<any>();
    expect(row).toEqual({ status: "active", consecutive_failures: 0 });
  });

  it("rate-limits handshakes per callback URL per day (-32013) so the endpoint cannot be used to spray a URL", async () => {
    const seen = mockReceiver("wrong");
    for (let i = 0; i < 10; i++) expect((await subscribe()).error.code).toBe(-32015);
    const limited = await subscribe();
    expect(limited.error.code).toBe(-32013);
    expect(limited.error.data.limit).toBe("verifications");
    expect(seen).toHaveLength(10);
  });

  it("refuses new subscriptions past the global cap (-32013 subscriptions)", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO mcp_subscriptions (id, principal, event, arguments, url, secret_enc, secret_sha256, expires_at, created_at, updated_at)
       SELECT 'sub_fill' || i, 'anonymous', 'bulletin.published', '{}', 'https://x.example.com/' || i, 'x', 'x', '2999-01-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z' FROM n`,
    ).run();
    const seen = mockReceiver("echo");
    const msg = await subscribe();
    expect(msg.error.code).toBe(-32013);
    expect(msg.error.data).toMatchObject({ limit: "subscriptions", max: 5000 });
    expect(seen).toHaveLength(0);
  });
});

// ---- events/unsubscribe ----

describe("events/unsubscribe", () => {
  it("deletes the matching subscription and its pending deliveries; idempotent empty result", async () => {
    mockReceiver("echo");
    await subscribe();
    await ingest(octoberSnapshot());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_deliveries").first<any>()).n).toBe(1);
    const params = { name: "bulletin.published", arguments: {}, delivery: { mode: "webhook", url: CALLBACK } };
    const r1 = await readMcp(await modern("events/unsubscribe", params));
    expect(r1.result).toMatchObject({ resultType: "complete" });
    expect(Object.keys(r1.result).filter((k) => k !== "resultType" && k !== "_meta")).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_subscriptions").first<any>()).n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_deliveries").first<any>()).n).toBe(0);
    const r2 = await readMcp(await modern("events/unsubscribe", params));
    expect(r2.error).toBeUndefined();

    // No deliveries for a later bulletin.
    const nov = octoberSnapshot();
    nov.bulletin = "2026-11";
    nov.uscis = null;
    await ingest(nov);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM mcp_deliveries").first<any>()).n).toBe(0);
  });
});

// ---- delivery ----

async function runBatch(bodies: unknown[], attempts = 1) {
  const batch = createMessageBatch(
    "visa-bulletin-push-deliveries",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body })),
  );
  const spies = batch.messages.map((m) => vi.spyOn(m, "retry"));
  const ctx = createExecutionContext();
  await worker.queue(batch as any, env);
  const result = await getQueueResult(batch, ctx);
  return { ...result, retryDelays: spies.flatMap((s) => s.mock.calls.map((c) => c[0]?.delaySeconds)) };
}

async function mcpDeliveryIds(): Promise<string[]> {
  return (await env.DB.prepare("SELECT id FROM mcp_deliveries ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);
}

describe("delivery to MCP event subscriptions", () => {
  it("bulletin.published: one queue message per delivery, signed Standard Webhooks POST with the EventOccurrence body", async () => {
    mockReceiver("echo");
    const sub = (await subscribe()).result;
    vi.mocked(globalThis.fetch).mockClear();
    const sent: any[] = [];
    vi.mocked(env.DELIVERY_QUEUE.sendBatch).mockImplementation(async (msgs: Iterable<any>) => {
      sent.push(...msgs);
      return undefined as any;
    });
    const res = await ingest(octoberSnapshot()); // bulletin.published + uscis.chart_decided; sub wants only the first
    expect(((await res.json()) as any).enqueued).toBe(1);
    const ids = await mcpDeliveryIds();
    expect(ids).toHaveLength(1);
    expect(sent.map((m) => m.body)).toEqual([{ mcp_delivery_id: ids[0] }]);

    const seen = mockReceiver(200);
    const r = await runBatch([{ mcp_delivery_id: ids[0] }]);
    expect(r.explicitAcks).toEqual(["m0"]);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.url).toBe(CALLBACK);
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("x-mcp-subscription-id")).toBe(sub.id);
    const body = JSON.parse(req.body);
    expect(Object.keys(body)).toEqual(["eventId", "name", "timestamp", "data", "cursor"]);
    expect(req.headers.get("webhook-id")).toBe(body.eventId);
    expect(body.eventId).toMatch(/^ev_[0-9a-f]{24}$/);
    expect(body.name).toBe("bulletin.published");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(body.cursor).toBeNull();
    expect(body.data.message).toContain("CN EB3 A 2022-01-08 / B 2024-04-01");
    expect(body.data.dates.CN.EB3).toEqual({ A: "2022-01-08", B: "2024-04-01" });
    expect(body.data.bulletin).toBe("2026-10");
    expect(await swVerify(SECRET, req.headers, req.body)).toBe(true);
    expect(await swVerify(SECRET2, req.headers, req.body)).toBe(false);
    expect(new TextEncoder().encode(req.body).byteLength).toBeLessThan(256 * 1024);

    const d = await env.DB.prepare("SELECT status, attempts, last_status_code FROM mcp_deliveries").first<any>();
    expect(d).toEqual({ status: "succeeded", attempts: 1, last_status_code: 200 });
    const s = await env.DB.prepare("SELECT total_deliveries, last_delivery_at FROM mcp_subscriptions").first<any>();
    expect(s.total_deliveries).toBe(1);
    expect(s.last_delivery_at).toBeTruthy();
  });

  it("retries a 5xx with the existing backoff and keeps the same webhook-id; 410 is not retried", async () => {
    mockReceiver("echo");
    await subscribe();
    await ingest(octoberSnapshot());
    const [id] = await mcpDeliveryIds();

    const s1 = mockReceiver(503);
    const r1 = await runBatch([{ mcp_delivery_id: id }], 1);
    expect(r1.retryMessages).toEqual([{ msgId: "m0" }]);
    expect(r1.retryDelays).toEqual([60]);
    const firstId = s1[0]!.headers.get("webhook-id");
    vi.restoreAllMocks();
    const s2 = mockReceiver(503);
    await runBatch([{ mcp_delivery_id: id }], 2);
    expect(s2[0]!.headers.get("webhook-id")).toBe(firstId);
    expect(await env.DB.prepare("SELECT last_error FROM mcp_subscriptions").first<any>()).toEqual({ last_error: "http_5xx" });

    vi.restoreAllMocks();
    mockReceiver(410);
    const r3 = await runBatch([{ mcp_delivery_id: id }], 3);
    expect(r3.explicitAcks).toEqual(["m0"]);
    expect(r3.retryMessages).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM mcp_deliveries").first<any>()).toEqual({ status: "failed" });
    expect((await env.DB.prepare("SELECT status FROM mcp_subscriptions").first<any>()).status).toBe("active");
  });

  it("disables after 20 consecutive failed deliveries (same rule as /v1/webhooks)", async () => {
    mockReceiver("echo");
    await subscribe();
    await env.DB.prepare("UPDATE mcp_subscriptions SET consecutive_failures = 19").run();
    await ingest(octoberSnapshot());
    const [id] = await mcpDeliveryIds();
    mockReceiver(500);
    await runBatch([{ mcp_delivery_id: id }], 5);
    const s = await env.DB.prepare("SELECT status, consecutive_failures, disabled_at FROM mcp_subscriptions").first<any>();
    expect(s.status).toBe("disabled");
    expect(s.consecutive_failures).toBe(20);
    expect(s.disabled_at).toBeTruthy();
  });

  it("an expired subscription gets no new deliveries, and a queued one is skipped", async () => {
    mockReceiver("echo");
    await subscribe();
    await ingest(octoberSnapshot());
    const [id] = await mcpDeliveryIds();
    await env.DB.prepare("UPDATE mcp_subscriptions SET expires_at = '2020-01-01T00:00:00Z'").run();
    const seen = mockReceiver(200);
    const r = await runBatch([{ mcp_delivery_id: id }]);
    expect(r.explicitAcks).toEqual(["m0"]);
    expect(seen).toHaveLength(0);
    expect((await env.DB.prepare("SELECT status FROM mcp_deliveries").first<any>()).status).toBe("skipped");

    const nov = octoberSnapshot();
    nov.bulletin = "2026-11";
    nov.uscis = null;
    await ingest(nov);
    expect(await mcpDeliveryIds()).toHaveLength(1);
  });

  it("dual-signs with the old and new secret after a rotation", async () => {
    mockReceiver("echo");
    await subscribe();
    await subscribe({}, { secret: SECRET2 }); // rotation: handshake with the new secret
    await ingest(octoberSnapshot());
    const [id] = await mcpDeliveryIds();
    const seen = mockReceiver(200);
    await runBatch([{ mcp_delivery_id: id }]);
    const sig = seen[0]!.headers.get("webhook-signature")!;
    expect(sig.split(" ")).toHaveLength(2);
    expect(await swVerify(SECRET, seen[0]!.headers, seen[0]!.body)).toBe(true);
    expect(await swVerify(SECRET2, seen[0]!.headers, seen[0]!.body)).toBe(true);
  });

  it("handles a batch mixing /v1/webhooks deliveries and MCP deliveries", async () => {
    mockReceiver("echo");
    await subscribe();
    await insertSubscription("wh_000000000000000000000001", { events: ["bulletin.published"] });
    await ingest(octoberSnapshot());
    const [mcpId] = await mcpDeliveryIds();
    const wh = await env.DB.prepare("SELECT id FROM deliveries").first<{ id: string }>();
    const seen = mockReceiver(200);
    const r = await runBatch([{ delivery_id: wh!.id }, { mcp_delivery_id: mcpId }]);
    expect(r.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(seen.map((s) => s.url).sort()).toEqual([CALLBACK, "https://hooks.example.com/wh_000000000000000000000001"]);
    expect(seen.find((s) => s.url === CALLBACK)!.headers.get("x-vb-signature")).toBeNull();
  });
});

// ---- operator test event (POST /v1/admin/mcp-test) ----

async function signedAdmin(path: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INGEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return exports.default.fetch(`https://vb.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vb-timestamp": ts, "x-vb-signature": `sha256=${hex}` },
    body,
  });
}

describe("operator test event", () => {
  it("refuses an unsigned request", async () => {
    const res = await exports.default.fetch("https://vb.example/v1/admin/mcp-test", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("sends one signed TEST event with the marker to bulletin.published subscribers only, and stores nothing", async () => {
    await ingest(octoberSnapshot());
    const seen = mockReceiver("echo");
    expect((await subscribe()).result).toBeDefined();
    expect((await subscribe({ name: "uscis.chart_decided" })).result).toBeDefined();
    seen.length = 0;
    const body = JSON.stringify({ marker: "KOALA-7" });
    const res = await signedAdmin("/v1/admin/mcp-test", body);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const sent = JSON.parse(seen[0]!.body);
    expect(sent.name).toBe("bulletin.published");
    expect(sent.eventId).toMatch(/^evt_test_/);
    expect(sent.data.message).toContain("TEST KOALA-7");
    expect(sent.data.dates.CN.EB3).toEqual({ A: "2022-01-08", B: "2024-04-01" });
    expect(await swVerify(SECRET, seen[0]!.headers, seen[0]!.body)).toBe(true);
    const events = await env.DB.prepare("SELECT count(*) AS n FROM events").first<{ n: number }>();
    expect(events?.n).toBe(2); // only the two from ingest: the test event is not stored or shown in the feed
  });
});
