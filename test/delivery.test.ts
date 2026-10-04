import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { backoffSeconds } from "../src/delivery";
import { encryptString } from "../src/crypto";
import { hmacHex, ingest, insertSubscription, octoberSnapshot } from "./helpers";

type Seen = { url: string; headers: Headers; body: string };
let seen: Seen[];

function mockSubscriber(status: number | "throw"): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: req.headers, body: await req.text() });
    if (status === "throw") throw new Error("connection reset");
    return new Response("ok", { status });
  });
}

beforeEach(() => {
  seen = [];
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Ingest October with one subscriber that only wants bulletin.published; return its delivery id. */
async function setupOneDelivery(subOpts: { consecutive_failures?: number } = {}): Promise<string> {
  await insertSubscription("wh_000000000000000000000001", { events: ["bulletin.published"], ...subOpts });
  await ingest(octoberSnapshot());
  const row = await env.DB.prepare("SELECT id FROM deliveries").first<{ id: string }>();
  return row!.id;
}

async function runBatch(deliveryId: string, attempts: number) {
  const batch = createMessageBatch("visa-bulletin-push-deliveries", [
    { id: "msg-1", timestamp: new Date(), attempts, body: { delivery_id: deliveryId } },
  ]);
  // getQueueResult() records which messages were retried but not the delay, so spy on retry().
  const retrySpy = vi.spyOn(batch.messages[0]!, "retry");
  const ctx = createExecutionContext();
  await worker.queue(batch as any, env);
  const result = await getQueueResult(batch, ctx);
  return { ...result, retryDelays: retrySpy.mock.calls.map((c) => c[0]?.delaySeconds) };
}

async function delivery(id: string) {
  return env.DB.prepare("SELECT * FROM deliveries WHERE id = ?").bind(id).first<any>();
}
async function subscription() {
  return env.DB.prepare("SELECT * FROM subscriptions").first<any>();
}

describe("backoff", () => {
  it("is exponential: 1, 4, 16, 64 minutes", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([60, 240, 960, 3840]);
  });
});

describe("queue consumer", () => {
  it("delivers a signed event and acks on 2xx", async () => {
    const id = await setupOneDelivery({ consecutive_failures: 3 });
    mockSubscriber(200);
    const result = await runBatch(id, 1);

    expect(result.explicitAcks).toEqual(["msg-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.url).toBe("https://hooks.example.com/wh_000000000000000000000001");
    expect(req.headers.get("x-vb-event")).toBe("bulletin.published");
    expect(req.headers.get("x-vb-delivery")).toBe(id);
    expect(req.headers.get("user-agent")).toBe("visa-bulletin-push/1.0");
    expect(req.headers.get("authorization")).toBeNull();
    const ts = req.headers.get("x-vb-timestamp")!;
    expect(req.headers.get("x-vb-signature")).toBe(
      "sha256=" + (await hmacHex("whsec_wh_000000000000000000000001", `${ts}.${req.body}`)),
    );
    const body = JSON.parse(req.body);
    expect(Object.keys(body)).toEqual(["source", "event", "message", "sent_at", "data"]);
    expect(body).toMatchObject({ source: "visa-bulletin-push", event: "bulletin.published" });
    expect(body.message).toContain("CN EB3 A 2022-01-08 / B 2024-04-01");
    expect(body.data.dates.CN.EB3).toEqual({ A: "2022-01-08", B: "2024-04-01" });

    expect(await delivery(id)).toMatchObject({ status: "succeeded", attempts: 1, last_status_code: 200 });
    expect(await subscription()).toMatchObject({ consecutive_failures: 0, total_deliveries: 1, last_delivery_id: id });
  });

  it("sends the decrypted bearer token when the subscription has one", async () => {
    const id = await setupOneDelivery();
    await env.DB.prepare("UPDATE subscriptions SET bearer_token_enc = ?")
      .bind(await encryptString(env.TOKEN_ENC_KEY, "grok-token-xyz"))
      .run();
    mockSubscriber(200);
    await runBatch(id, 1);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer grok-token-xyz");
  });

  it("retries a non-2xx with exponential backoff and keeps the delivery pending", async () => {
    const id = await setupOneDelivery();
    mockSubscriber(500);
    const r1 = await runBatch(id, 1);
    expect(r1.explicitAcks).toEqual([]);
    expect(r1.retryMessages).toEqual([{ msgId: "msg-1" }]);
    expect(r1.retryDelays).toEqual([60]);
    expect(await delivery(id)).toMatchObject({ status: "pending", attempts: 1, last_status_code: 500 });

    const r3 = await runBatch(id, 3);
    expect(r3.retryDelays).toEqual([960]);
    expect((await subscription()).consecutive_failures).toBe(0);
  });

  it("retries a network error too", async () => {
    const id = await setupOneDelivery();
    mockSubscriber("throw");
    const r = await runBatch(id, 2);
    expect(r.retryMessages).toEqual([{ msgId: "msg-1" }]);
    expect(r.retryDelays).toEqual([240]);
    expect(await delivery(id)).toMatchObject({ attempts: 2, last_status_code: null, last_error: "network_error" });
  });

  it("marks the delivery failed and acks after the 5th failed attempt", async () => {
    const id = await setupOneDelivery({ consecutive_failures: 2 });
    mockSubscriber(404);
    const r = await runBatch(id, 5);
    expect(r.explicitAcks).toEqual(["msg-1"]);
    expect(r.retryMessages).toEqual([]);
    expect(await delivery(id)).toMatchObject({ status: "failed", attempts: 5, last_status_code: 404 });
    expect(await subscription()).toMatchObject({ status: "active", consecutive_failures: 3, total_failures: 1 });
  });

  it("disables the subscription after 20 consecutive failed deliveries", async () => {
    const id = await setupOneDelivery({ consecutive_failures: 19 });
    mockSubscriber(500);
    await runBatch(id, 5);
    const sub = await subscription();
    expect(sub.status).toBe("disabled");
    expect(sub.consecutive_failures).toBe(20);
    expect(sub.disabled_at).toBeTruthy();
  });

  it("skips (acks without sending) when the subscription is disabled", async () => {
    const id = await setupOneDelivery();
    await env.DB.prepare("UPDATE subscriptions SET status = 'disabled'").run();
    mockSubscriber(200);
    const r = await runBatch(id, 1);
    expect(r.explicitAcks).toEqual(["msg-1"]);
    expect(seen).toHaveLength(0);
    expect((await delivery(id)).status).toBe("skipped");
  });

  it("acks a message whose delivery no longer exists (subscription deleted)", async () => {
    mockSubscriber(200);
    const r = await runBatch("dl_doesnotexist", 1);
    expect(r.explicitAcks).toEqual(["msg-1"]);
    expect(seen).toHaveLength(0);
  });

  it("handles a batch of several deliveries independently", async () => {
    await insertSubscription("wh_000000000000000000000001");
    await insertSubscription("wh_000000000000000000000002");
    await ingest(octoberSnapshot()); // 2 events x 2 subs = 4 deliveries
    const ids = (await env.DB.prepare("SELECT id FROM deliveries ORDER BY id").all<{ id: string }>()).results.map(
      (r) => r.id,
    );
    expect(ids).toHaveLength(4);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = new Request(input).url;
      return new Response("x", { status: url.endsWith("0002") ? 503 : 200 });
    });
    const batch = createMessageBatch(
      "visa-bulletin-push-deliveries",
      ids.map((id, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body: { delivery_id: id } })),
    );
    const ctx = createExecutionContext();
    await worker.queue(batch as any, env);
    const r = await getQueueResult(batch, ctx);
    expect(r.explicitAcks).toHaveLength(2);
    expect(r.retryMessages).toHaveLength(2);
  });
});
