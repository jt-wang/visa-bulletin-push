import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardKey, ensureCard, renderCardHtml } from "../src/card";
import { ingest, octoberSnapshot } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function september(): any {
  const s = octoberSnapshot();
  s.bulletin = "2026-09";
  s.dates.CN.EB2 = { A: "2021-09-01", B: "2022-01-01" };
  s.dates.IN.EB1 = { A: "U", B: "2023-12-01" };
  s.uscis = null;
  return s;
}

function fakeBrowser(result: unknown = PNG) {
  return { quickAction: vi.fn(async () => result) };
}

beforeEach(() => {
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
});
afterEach(() => vi.restoreAllMocks());

describe("share card content", () => {
  it("shows the month, all twelve cells, moves against last month, the USCIS chart and the host", () => {
    const html = renderCardHtml(octoberSnapshot(), september(), "https://vb.example");
    expect(html).toContain("October 2026 Visa Bulletin");
    for (const d of ["01 JUL 2023", "01 OCT 2021", "08 JAN 2022", "01 FEB 2023", "01 NOV 2013", "01 JAN 2014"]) expect(html).toContain(d);
    for (const d of ["01 JUL 2024", "01 JAN 2023", "01 APR 2024", "15 JAN 2015"]) expect(html).toContain(d);
    expect(html).toContain("+1 mo"); // CN EB-2 final action moved Sep -> Oct 2021
    expect(html).toContain("Reopened"); // IN EB-1 was unavailable last month
    expect(html).toMatch(/USCIS[^<]*chart B/);
    expect(html).toContain("vb.example");
    // The biggest move goes first, so a shared card says what changed.
    expect(html).toContain("Biggest move: China mainland EB-2 dates for filing +1 yr");
    // Without a handle there is no follow line; with one, the card carries it.
    expect(html).not.toContain("@");
    expect(renderCardHtml(octoberSnapshot(), september(), "https://vb.example", {}, "ada_example")).toContain("@ada_example on X");
    expect(html).toContain('width:1200px');
    // No fonts passed: no @font-face, and never a third-party font host.
    expect(html).not.toContain("@font-face");
    expect(html).not.toContain("fonts.googleapis.com");
    // Fonts passed: embedded as data URIs (a card page has no origin, so cross-origin fonts are
    // blocked by CORS; measured with headless Chrome 2026-10-04).
    const withFonts = renderCardHtml(octoberSnapshot(), null, "https://vb.example", { "IBMPlexMono-600.woff2": "AAAA" });
    expect(withFonts).toContain('src:url(data:font/woff2;base64,AAAA) format("woff2")');
    expect(withFonts).not.toContain("https://vb.example/fonts/");
  });

  it("says when USCIS has not picked a chart yet, and shows C and U as words", () => {
    const s = octoberSnapshot();
    s.uscis = null;
    s.dates.IN.EB3 = { A: "C", B: "U" };
    const html = renderCardHtml(s, null, "https://vb.example");
    expect(html).toContain("USCIS has not picked a chart yet");
    expect(html).toContain("Current");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain('class="mv'); // no previous month, no moves
    expect(html).not.toContain("Biggest move");
  });

  it("keys the card by month and USCIS chart, so a new chart makes a new image", () => {
    const s = octoberSnapshot();
    expect(cardKey(s)).toBe("2026-10-B");
    s.uscis = null;
    expect(cardKey(s)).toBe("2026-10-x");
  });
});

describe("ensureCard", () => {
  it("renders the latest bulletin once through Browser Run and stores the PNG", async () => {
    await ingest(september());
    await ingest(octoberSnapshot());
    const browser = fakeBrowser();
    expect(await ensureCard(env, browser)).toBe("created");
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
    const [action, opts] = browser.quickAction.mock.calls[0] as any;
    expect(action).toBe("screenshot");
    expect(opts.viewport).toEqual({ width: 1200, height: 630 });
    expect(opts.html).toContain("October 2026 Visa Bulletin");
    expect(opts.html).toContain("+1 mo");
    expect(opts.html).toContain("data:font/woff2;base64,d09GMg"); // the real IBM Plex files ("wOF2"), via the ASSETS binding
    const row = await env.DB.prepare("SELECT key, length(png) AS n FROM cards").first<any>();
    expect(row).toEqual({ key: "2026-10-B", n: PNG.length });

    expect(await ensureCard(env, browser)).toBe("exists");
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
  });

  it("accepts a Response from the binding", async () => {
    await ingest(octoberSnapshot());
    expect(await ensureCard(env, fakeBrowser(new Response(PNG)))).toBe("created");
    expect((await env.DB.prepare("SELECT length(png) AS n FROM cards").first<any>()).n).toBe(PNG.length);
  });

  it("does nothing without a bulletin or without the binding", async () => {
    expect(await ensureCard(env, fakeBrowser())).toBe("no_bulletin");
    await ingest(octoberSnapshot());
    expect(await ensureCard(env, undefined)).toBe("no_browser");
  });

  it("after a failure waits 30 minutes before trying again, and rejects a non-PNG answer", async () => {
    await ingest(octoberSnapshot());
    const broken = { quickAction: vi.fn(async () => { throw new Error("429 Browser time limit exceeded"); }) };
    const t0 = new Date("2026-10-04T10:00:00Z");
    expect(await ensureCard(env, broken, t0)).toBe("failed");
    expect(await ensureCard(env, broken, new Date("2026-10-04T10:20:00Z"))).toBe("waiting");
    expect(broken.quickAction).toHaveBeenCalledTimes(1);
    expect(await ensureCard(env, fakeBrowser(new Uint8Array([1, 2, 3])), new Date("2026-10-04T10:31:00Z"))).toBe("failed");
    expect(await ensureCard(env, fakeBrowser(), new Date("2026-10-04T11:02:00Z"))).toBe("created");
  });
});

describe("serving the card", () => {
  it("serves a stored card as an immutable PNG, and sends unknown months to the static card", async () => {
    await env.DB.prepare("INSERT INTO cards (key, png, created_at) VALUES (?, ?, ?)").bind("2026-10-B", PNG, "2026-10-04T00:00:00Z").run();
    const res = await exports.default.fetch("https://vb.example/og/2026-10-B.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const missing = await exports.default.fetch("https://vb.example/og/2026-11-x.png", { redirect: "manual" });
    expect(missing.status).toBe(302);
    expect(missing.headers.get("location")).toBe("/og.png");
    expect((await exports.default.fetch("https://vb.example/og/../x.png")).status).toBe(404);
  });

  it("the page points og:image at the latest card", async () => {
    await ingest(octoberSnapshot());
    const html = await (await exports.default.fetch("https://vb.example/")).text();
    expect(html).toContain('<meta property="og:image" content="https://vb.example/og/2026-10-B.png">');
    expect(html).toContain('<meta name="twitter:image" content="https://vb.example/og/2026-10-B.png">');
  });
});
