import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSnapshot } from "../src/snapshot";
import { countRows, ingest, insertSubscription, octoberSnapshot } from "./helpers";

let sent: Array<{ body: unknown }>;

beforeEach(() => {
  sent = [];
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockImplementation(async (msgs: Iterable<any>) => {
    for (const m of msgs) sent.push(m);
    return undefined as any;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingest auth", () => {
  it("accepts a correctly signed, fresh request", async () => {
    const res = await ingest(octoberSnapshot());
    expect(res.status).toBe(200);
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    const res = await ingest(octoberSnapshot(), { secret: "wrong-secret" });
    expect(res.status).toBe(401);
    expect(await countRows("bulletins")).toBe(0);
  });

  it("rejects a signature that is not sha256=<hex>", async () => {
    const res = await ingest(octoberSnapshot(), { signature: "deadbeef" });
    expect(res.status).toBe(401);
  });

  it("rejects a timestamp older than 300 seconds even if correctly signed", async () => {
    const res = await ingest(octoberSnapshot(), { timestamp: Math.floor(Date.now() / 1000) - 330 });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "stale_timestamp" });
  });

  it("rejects a timestamp more than 300 seconds in the future", async () => {
    const res = await ingest(octoberSnapshot(), { timestamp: Math.floor(Date.now() / 1000) + 330 });
    expect(res.status).toBe(401);
  });

  it("signature covers the raw body: re-serialised JSON with the same content fails", async () => {
    const snap = octoberSnapshot();
    const raw = JSON.stringify(snap);
    const ts = Math.floor(Date.now() / 1000);
    const { hmacHex } = await import("./helpers");
    const sig = "sha256=" + (await hmacHex(env.INGEST_SECRET, `${ts}.${raw}`));
    const res = await ingest(null, { raw: JSON.stringify(snap, null, 2), timestamp: ts, signature: sig });
    expect(res.status).toBe(401);
  });
});

describe("snapshot schema", () => {
  it("accepts the October 2026 snapshot", () => {
    expect(validateSnapshot(octoberSnapshot()).ok).toBe(true);
  });

  it("accepts C and U cells and uscis: null", () => {
    const s = octoberSnapshot();
    s.dates.CN.EB1.A = "C";
    s.dates.IN.EB3.B = "U";
    s.uscis = null;
    expect(validateSnapshot(s).ok).toBe(true);
  });

  const bad: Array<[string, (s: any) => void]> = [
    ["wrong schema", (s) => (s.schema = "visa-bulletin-push/v2")],
    ["bad bulletin month", (s) => (s.bulletin = "2026-13")],
    ["bulletin not YYYY-MM", (s) => (s.bulletin = "Oct 2026")],
    ["missing a country", (s) => delete s.dates.IN],
    ["extra country", (s) => (s.dates.MX = s.dates.CN)],
    ["missing a category", (s) => delete s.dates.CN.EB2],
    ["missing chart B", (s) => delete s.dates.CN.EB3.B],
    ["bulletin-style date", (s) => (s.dates.CN.EB3.A = "08JAN22")],
    ["impossible date", (s) => (s.dates.CN.EB3.A = "2022-02-30")],
    ["lowercase c", (s) => (s.dates.CN.EB3.A = "c")],
    ["uscis chart C", (s) => (s.uscis.employment_chart = "C")],
    ["uscis bulletin malformed", (s) => (s.uscis.bulletin = "2026-1")],
    ["uscis missing key", (s) => delete s.uscis],
    ["unknown top-level key", (s) => (s.extra = 1)],
    ["missing observed_at", (s) => delete s.observed_at],
  ];
  for (const [name, mutate] of bad) {
    it(`rejects: ${name}`, () => {
      const s = octoberSnapshot();
      mutate(s);
      expect(validateSnapshot(s).ok).toBe(false);
    });
  }

  it("endpoint returns 400 with errors for an invalid but correctly signed snapshot", async () => {
    const s = octoberSnapshot();
    s.dates.CN.EB3.A = "08JAN22";
    const res = await ingest(s);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe("invalid_snapshot");
    expect(body.details.join(" ")).toContain("CN.EB3.A");
  });

  it("endpoint returns 413 for a body over 64 KB", async () => {
    const res = await ingest(null, { raw: "x".repeat(64 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  it("endpoint returns 400 for non-JSON body", async () => {
    const res = await ingest(null, { raw: "not json" });
    expect(res.status).toBe(400);
  });
});

describe("event typing", () => {
  const types = async (res: Response) => ((await res.json()) as any).events.map((e: any) => e.type);

  it("first ingest of a month with a USCIS chart yields published + chart_decided", async () => {
    expect(await types(await ingest(octoberSnapshot()))).toEqual(["bulletin.published", "uscis.chart_decided"]);
    expect(await countRows("events")).toBe(2);
  });

  it("first ingest without USCIS chart yields only published", async () => {
    const s = octoberSnapshot();
    s.uscis = null;
    expect(await types(await ingest(s))).toEqual(["bulletin.published"]);
  });

  it("USCIS chart for a different month does not count as decided for this month", async () => {
    const s = octoberSnapshot();
    s.uscis.bulletin = "2026-09";
    expect(await types(await ingest(s))).toEqual(["bulletin.published"]);
  });

  it("identical snapshot is idempotent (no events), even with a new observed_at", async () => {
    await ingest(octoberSnapshot());
    const again = octoberSnapshot();
    again.observed_at = "2026-10-04T02:05:00Z";
    const res = await ingest(again);
    expect(res.status).toBe(200);
    expect(await types(res)).toEqual([]);
    expect(await countRows("events")).toBe(2);
  });

  it("same month with a changed cell yields bulletin.updated", async () => {
    await ingest(octoberSnapshot());
    const s = octoberSnapshot();
    s.dates.CN.EB3.A = "2022-02-01";
    expect(await types(await ingest(s))).toEqual(["bulletin.updated"]);
  });

  it("chart decided later in the month yields uscis.chart_decided only", async () => {
    const s = octoberSnapshot();
    s.uscis = null;
    await ingest(s);
    expect(await types(await ingest(octoberSnapshot()))).toEqual(["uscis.chart_decided"]);
  });

  it("chart changed A -> B yields uscis.chart_decided", async () => {
    const s = octoberSnapshot();
    s.uscis.employment_chart = "A";
    await ingest(s);
    expect(await types(await ingest(octoberSnapshot()))).toEqual(["uscis.chart_decided"]);
  });

  it("uscis: null after a known chart keeps the chart and emits nothing", async () => {
    await ingest(octoberSnapshot());
    const s = octoberSnapshot();
    s.uscis = null;
    expect(await types(await ingest(s))).toEqual([]);
    const row = await env.DB.prepare("SELECT uscis_chart FROM bulletins WHERE month = '2026-10'").first<any>();
    expect(row.uscis_chart).toBe("B");
  });

  it("cell change plus chart change in one ingest yields updated + chart_decided", async () => {
    const s0 = octoberSnapshot();
    s0.uscis = null;
    await ingest(s0);
    const s = octoberSnapshot();
    s.dates.IN.EB2.A = "2014-01-01";
    expect(await types(await ingest(s))).toEqual(["bulletin.updated", "uscis.chart_decided"]);
  });

  it("a newer month yields bulletin.published; an older month backfill yields nothing", async () => {
    await ingest(octoberSnapshot());
    const nov = octoberSnapshot();
    nov.bulletin = "2026-11";
    nov.uscis = null;
    expect(await types(await ingest(nov))).toEqual(["bulletin.published"]);
    const sep = octoberSnapshot();
    sep.bulletin = "2026-09";
    sep.uscis = null;
    expect(await types(await ingest(sep))).toEqual([]);
    expect(await countRows("bulletins")).toBe(3);
  });

  it("event message is a one-line English + Chinese summary", async () => {
    await ingest(octoberSnapshot());
    const row = await env.DB.prepare("SELECT message FROM events WHERE type = 'bulletin.published'").first<any>();
    expect(row.message).not.toContain("\n");
    expect(row.message).toContain("Oct 2026");
    expect(row.message).toContain("CN EB3 A 2022-01-08 / B 2024-04-01");
    expect(row.message).toContain("USCIS: use chart B");
    expect(row.message).toContain("2026年10月");
  });
});

describe("fan-out", () => {
  it("enqueues one message per (event, active subscription that wants the event)", async () => {
    await insertSubscription("wh_all");
    await insertSubscription("wh_pub", { events: ["bulletin.published"] });
    await insertSubscription("wh_chart", { events: ["uscis.chart_decided"] });
    await insertSubscription("wh_off", { status: "disabled" });

    const res = await ingest(octoberSnapshot());
    const body: any = await res.json();
    expect(body.enqueued).toBe(4); // published -> all, pub ; chart_decided -> all, chart
    expect(sent).toHaveLength(4);
    for (const m of sent) expect(Object.keys(m.body as object)).toEqual(["delivery_id"]);

    const rows = await env.DB.prepare(
      "SELECT d.subscription_id AS s, e.type AS t, d.enqueued FROM deliveries d JOIN events e ON e.id = d.event_id ORDER BY s, t",
    ).all<any>();
    expect(rows.results.map((r) => `${r.s}:${r.t}:${r.enqueued}`)).toEqual([
      "wh_all:bulletin.published:1",
      "wh_all:uscis.chart_decided:1",
      "wh_chart:uscis.chart_decided:1",
      "wh_pub:bulletin.published:1",
    ]);
  });

  it("idempotent re-ingest enqueues deliveries left un-enqueued by a failed sendBatch", async () => {
    await insertSubscription("wh_all");
    vi.mocked(env.DELIVERY_QUEUE.sendBatch).mockRejectedValueOnce(new Error("queue down"));
    const first = await ingest(octoberSnapshot());
    expect(first.status).toBe(503);
    expect(sent).toHaveLength(0);

    const retry = await ingest(octoberSnapshot());
    expect(retry.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(await countRows("events")).toBe(2);
  });
});
