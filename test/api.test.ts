import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingest, octoberSnapshot } from "./helpers";

const get = (path: string, init?: RequestInit) => exports.default.fetch(`https://vb.example${path}`, init);

beforeEach(() => {
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("read API when empty", () => {
  it("latest.json is a 404 JSON", async () => {
    const res = await get("/v1/latest.json");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("bulletins.json is a 404 JSON", async () => {
    expect((await get("/v1/bulletins.json")).status).toBe(404);
  });

  it("the home page still renders", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Visa Bulletin Push");
  });
});

describe("read API with data", () => {
  beforeEach(async () => {
    await ingest(octoberSnapshot());
  });

  it("latest.json returns the snapshot contract with CORS and caching headers", async () => {
    const res = await get("/v1/latest.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body: any = await res.json();
    expect(body).toEqual(octoberSnapshot());
  });

  it("latest.json is the newest month", async () => {
    const nov = octoberSnapshot();
    nov.bulletin = "2026-11";
    nov.uscis = null;
    await ingest(nov);
    expect(((await (await get("/v1/latest.json")).json()) as any).bulletin).toBe("2026-11");
  });

  it("bulletins.json lists months newest first", async () => {
    const res = await get("/v1/bulletins.json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body: any = await res.json();
    expect(body.bulletins).toEqual([
      { bulletin: "2026-10", url: "/v1/bulletins/2026-10.json", uscis_employment_chart: "B", updated_at: expect.any(String) },
    ]);
  });

  it("bulletins/{month}.json returns that month, 404 for an unknown month, 400 for a bad one", async () => {
    expect(((await (await get("/v1/bulletins/2026-10.json")).json()) as any).bulletin).toBe("2026-10");
    const missing = await get("/v1/bulletins/2026-09.json");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    expect((await get("/v1/bulletins/2026-13.json")).status).toBe(404);
  });

  it("answers CORS preflight", async () => {
    const res = await get("/v1/latest.json", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("feed.atom has one entry per event", async () => {
    const res = await get("/feed.atom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\s*<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
    expect(xml.match(/<entry>/g)).toHaveLength(2);
    expect(xml).toContain("<category term=\"bulletin.published\"/>");
    expect(xml).toContain("<category term=\"uscis.chart_decided\"/>");
    expect(xml).toContain('<link rel="self" href="https://vb.example/feed.atom"/>');
    expect(xml).toContain("CN EB3 A 2022-01-08 / B 2024-04-01");
    expect(xml).not.toMatch(/<[^>]*&(?!amp;|lt;|gt;|quot;|#)/); // no bare ampersands
  });

  it("home page shows the 12 cells, the USCIS chart, sources and the disclaimer", async () => {
    const res = await get("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await res.text();
    for (const d of ["2023-07-01", "2021-10-01", "2022-01-08", "2024-04-01", "2013-11-01", "2015-01-15", "2014-01-01"]) {
      expect(html).toContain(d);
    }
    expect(html).toContain("Dates for Filing");
    const zh = await (await get("/?lang=zh")).text();
    expect(zh).toContain("表A");
    expect(zh).toContain("表B");
    expect(zh).toContain("非官方整理，非法律意见");
    expect(html).toContain("https://travel.state.gov/content/dam/visas/Bulletins/visabulletin_October2026.pdf");
    expect(html).toContain("uscis.gov");
    expect(html).toContain("Unofficial. Not legal advice.");
    expect(html).toContain("https://vb.example/mcp");
    expect(html).toContain("curl https://vb.example/v1/latest.json");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script[^>]+src=/); // no third-party scripts / trackers
  });

  it("unknown paths are a 404 JSON", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("status endpoint", () => {
  it("says when the bulletin was last checked and how stale it is", async () => {
    await env.DB.prepare("INSERT INTO poll_state (key, value, updated_at) VALUES ('health', ?, ?)")
      .bind(JSON.stringify({ checked_at: new Date(Date.now() - 60_000).toISOString(), outcome: "unchanged", bulletin: "2026-10" }), new Date().toISOString())
      .run();
    const res = await get("/v1/status");
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.last_check.outcome).toBe("unchanged");
    expect(j.last_check.bulletin).toBe("2026-10");
    expect(j.healthy).toBe(true);
    expect(j.cadence_seconds).toEqual({ while_due: 180, otherwise: 3600 });
  });

  it("reports unhealthy when no check happened for two and a half hours", async () => {
    await env.DB.prepare("INSERT INTO poll_state (key, value, updated_at) VALUES ('health', ?, ?)")
      .bind(JSON.stringify({ checked_at: new Date(Date.now() - 151 * 60_000).toISOString(), outcome: "unchanged" }), new Date().toISOString())
      .run();
    expect(((await (await get("/v1/status")).json()) as any).healthy).toBe(false);
  });
});

