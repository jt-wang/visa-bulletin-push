import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateWebhookUrl } from "../src/webhooks";
import { countRows, hmacHex } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

function register(body: unknown, ip = "203.0.113.7"): Promise<Response> {
  return exports.default.fetch("https://vb.example/v1/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

type Seen = { url: string; method: string; headers: Headers; body: string };

function mockSubscriber(status = 200): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
    return new Response(status === 204 ? null : "ok", { status });
  });
  return seen;
}

describe("webhook URL validation", () => {
  const good = [
    "https://hooks.example.com/visa",
    "https://example.com",
    "https://example.com:443/x?y=1",
    "https://api.x.ai/v1/webhooks/abc",
  ];
  for (const u of good) it(`accepts ${u}`, () => expect(validateWebhookUrl(u).ok).toBe(true));

  const bad = [
    "http://example.com/hook",
    "https://10.0.0.1/hook",
    "https://192.168.1.10/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/hook",
    "https://0x7f000001/hook", // hex IPv4, normalised by the URL parser
    "https://2130706433/hook", // decimal IPv4
    "https://[::1]/hook",
    "https://[fe80::1]/hook",
    "https://localhost/hook",
    "https://foo.localhost/hook",
    "https://printer.local/hook",
    "https://svc.internal/hook",
    "https://example.com:8443/hook",
    "https://user:pass@example.com/hook",
    "https://intranet/hook",
    "ftp://example.com/hook",
    "not a url",
  ];
  for (const u of bad) it(`rejects ${u}`, () => expect(validateWebhookUrl(u).ok).toBe(false));
});

describe("POST /v1/webhooks", () => {
  it("creates a subscription only after a 2xx ping, and returns secrets once", async () => {
    const seen = mockSubscriber(204);
    const res = await register({ url: "https://hooks.example.com/visa" });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.id).toMatch(/^wh_[0-9a-f]{24}$/);
    expect(body.signing_secret).toMatch(/^whsec_/);
    expect(body.manage_token).toMatch(/^vbm_/);
    expect(body.events).toEqual(["bulletin.published", "bulletin.updated", "uscis.chart_decided"]);
    expect(seen).toHaveLength(1);
    expect(await countRows("subscriptions")).toBe(1);

    // Only hashes / ciphertext are stored.
    const row = await env.DB.prepare("SELECT * FROM subscriptions").first<any>();
    expect(JSON.stringify(row)).not.toContain(body.manage_token);
    expect(JSON.stringify(row)).not.toContain(body.signing_secret);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
  });

  it("does not create a subscription when the ping gets a non-2xx", async () => {
    mockSubscriber(500);
    const res = await register({ url: "https://hooks.example.com/visa" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "ping_failed", status: 500 });
    expect(await countRows("subscriptions")).toBe(0);
  });

  it("does not follow redirects on the ping (3xx is a failure)", async () => {
    mockSubscriber(302);
    const res = await register({ url: "https://hooks.example.com/visa" });
    expect(res.status).toBe(422);
  });

  it("treats a network error on the ping as a failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await register({ url: "https://hooks.example.com/visa" });
    expect(res.status).toBe(422);
    expect(await countRows("subscriptions")).toBe(0);
  });

  it("signs the ping as sha256=HMAC(signing_secret, timestamp + '.' + body) and sends the bearer token", async () => {
    const seen = mockSubscriber(200);
    const res = await register({ url: "https://hooks.example.com/visa", bearer_token: "grok-token-123" });
    const { signing_secret } = (await res.json()) as any;
    const req = seen[0]!;
    const raw = req.body;
    const ts = req.headers.get("x-vb-timestamp")!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://hooks.example.com/visa");
    expect(req.headers.get("x-vb-event")).toBe("ping");
    expect(req.headers.get("x-vb-delivery")).toBeTruthy();
    expect(req.headers.get("user-agent")).toBe("visa-bulletin-push/1.0");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("authorization")).toBe("Bearer grok-token-123");
    expect(req.headers.get("x-vb-signature")).toBe("sha256=" + (await hmacHex(signing_secret, `${ts}.${raw}`)));
    const body = JSON.parse(raw);
    expect(Object.keys(body)).toEqual(["source", "event", "message", "sent_at", "data"]);
    expect(body.source).toBe("visa-bulletin-push");
    expect(body.event).toBe("ping");

    const row = await env.DB.prepare("SELECT bearer_token_enc FROM subscriptions").first<any>();
    expect(row.bearer_token_enc).toBeTruthy();
    expect(row.bearer_token_enc).not.toContain("grok-token-123");
  });

  it("accepts an events filter and rejects unknown event names", async () => {
    mockSubscriber(200);
    const ok = await register({ url: "https://hooks.example.com/a", events: ["uscis.chart_decided"] });
    expect(((await ok.json()) as any).events).toEqual(["uscis.chart_decided"]);
    const bad = await register({ url: "https://hooks.example.com/b", events: ["bulletin.deleted"] });
    expect(bad.status).toBe(400);
  });

  it("rejects a bad URL with 400 without making any request", async () => {
    const seen = mockSubscriber(200);
    const res = await register({ url: "https://10.0.0.1/hook" });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("rejects a bearer token with control characters", async () => {
    mockSubscriber(200);
    const res = await register({ url: "https://hooks.example.com/a", bearer_token: "abc\r\nX-Evil: 1" });
    expect(res.status).toBe(400);
  });

  it("allows at most 10 new subscriptions per IP per UTC day", async () => {
    mockSubscriber(200);
    for (let i = 0; i < 10; i++) {
      expect((await register({ url: `https://hooks.example.com/${i}` })).status).toBe(201);
    }
    const res = await register({ url: "https://hooks.example.com/eleven" });
    expect(res.status).toBe(429);
    expect((await register({ url: "https://hooks.example.com/other" }, "198.51.100.9")).status).toBe(201);
  });
});

describe("GET / DELETE /v1/webhooks/:id", () => {
  async function create(): Promise<{ id: string; manage_token: string }> {
    mockSubscriber(200);
    return (await (await register({ url: "https://hooks.example.com/visa" })).json()) as any;
  }

  it("shows status with the manage token, 404 with a wrong one, 401 without", async () => {
    const { id, manage_token } = await create();
    const ok = await exports.default.fetch(`https://vb.example/v1/webhooks/${id}`, {
      headers: { authorization: `Bearer ${manage_token}` },
    });
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body).toMatchObject({ id, url: "https://hooks.example.com/visa", status: "active", consecutive_failures: 0 });
    expect(body.last_delivery).toBeNull();
    expect(JSON.stringify(body)).not.toContain("secret");

    const wrong = await exports.default.fetch(`https://vb.example/v1/webhooks/${id}`, {
      headers: { authorization: "Bearer vbm_wrong" },
    });
    expect(wrong.status).toBe(404);
    const none = await exports.default.fetch(`https://vb.example/v1/webhooks/${id}`);
    expect(none.status).toBe(401);
  });

  it("deletes with the manage token", async () => {
    const { id, manage_token } = await create();
    const del = await exports.default.fetch(`https://vb.example/v1/webhooks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${manage_token}` },
    });
    expect(del.status).toBe(204);
    expect(await countRows("subscriptions")).toBe(0);
  });

  it("refuses to delete with a wrong token", async () => {
    const { id } = await create();
    const del = await exports.default.fetch(`https://vb.example/v1/webhooks/${id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer vbm_wrong" },
    });
    expect(del.status).toBe(404);
    expect(await countRows("subscriptions")).toBe(1);
  });
});
