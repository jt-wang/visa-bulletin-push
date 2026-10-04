import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLatest } from "../src/api";
import { runPoll } from "../src/poll";
import { countRows } from "./helpers";
import { OCT_2026_HTML, USCIS_OCT_2026_HTML } from "./fixtures/pages";
import { OCT_2026_PDF_B64 } from "./fixtures/pdfs";

const OCT_PDF = "https://adoptions.state.gov/content/dam/visas/Bulletins/visabulletin_October2026.pdf";
const NOV_PDF = "https://adoptions.state.gov/content/dam/visas/Bulletins/visabulletin_November2026.pdf";
const OCT_HTML_URL =
  "https://adoptions.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/2027/visa-bulletin-for-october-2026.html";
const USCIS =
  "https://www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-priority-dates/adjustment-of-status-filing-charts-from-the-visa-bulletin";
const NOW = new Date("2026-10-04T03:00:00Z");
const pdfBytes = Uint8Array.from(atob(OCT_2026_PDF_B64), (c) => c.charCodeAt(0));

type Route = (req: Request) => Response | Promise<Response>;

/** A fake fetch that serves canned responses by "METHOD url" and records every call. */
function fakeNet(overrides: Record<string, Route> = {}) {
  const calls: Array<{ method: string; url: string; headers: Headers; body?: string }> = [];
  const routes: Record<string, Route> = {
    [`HEAD ${NOV_PDF}`]: () => new Response(null, { status: 404 }),
    [`HEAD ${NOV_PDF.replace("adoptions", "adoption")}`]: () => new Response(null, { status: 404 }),
    [`HEAD ${OCT_PDF}`]: () =>
      new Response(null, {
        headers: { etag: `"38cdd-${Math.random()}"`, "content-length": "232669", "content-type": "application/pdf", "last-modified": "Tue, 29 Sep 2026 11:47:04 GMT" },
      }),
    [`GET ${OCT_PDF}`]: () => new Response(pdfBytes, { headers: { "content-type": "application/pdf" } }),
    [`GET ${OCT_HTML_URL}`]: () => new Response(OCT_2026_HTML, { headers: { "content-type": "text/html" } }),
    [`GET ${USCIS}`]: () => new Response(USCIS_OCT_2026_HTML, { headers: { etag: '"uscis-1"', "content-type": "text/html" } }),
    ["POST https://api.telegram.org/botTEST_TOKEN/sendMessage"]: () => Response.json({ ok: true }),
    ...overrides,
  };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = req.method === "POST" ? await req.clone().text() : undefined;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const route = routes[`${req.method} ${req.url}`];
    return route ? route(req) : new Response("not found", { status: 404 });
  };
  return {
    fetcher: fetcher as typeof fetch,
    calls,
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    alerts: () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/")).map((c) => JSON.parse(c.body!).text as string),
  };
}

const alertEnv = () => ({ ...env, TELEGRAM_BOT_TOKEN: "TEST_TOKEN", TELEGRAM_CHAT_ID: "42" }) as Env;

beforeEach(() => {
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled poll", () => {
  it("finds the newest published PDF, reads it and USCIS, and publishes on its own", async () => {
    const net = fakeNet();
    const r = await runPoll(alertEnv(), NOW, net.fetcher);
    expect(r.outcome).toBe("published");
    const latest = await getLatest(env);
    expect(latest?.snapshot.bulletin).toBe("2026-10");
    expect(latest?.snapshot.dates.CN.EB3).toEqual({ A: "2022-01-08", B: "2024-04-01" });
    expect(latest?.snapshot.uscis?.employment_chart).toBe("B");
    expect(latest?.snapshot.source.pdf_url).toBe(
      "https://travel.state.gov/content/dam/visas/Bulletins/visabulletin_October2026.pdf",
    );
    const types = (await env.DB.prepare("SELECT type FROM events ORDER BY type").all<{ type: string }>()).results.map((e) => e.type);
    expect(types).toEqual(["bulletin.published", "uscis.chart_decided"]);
    expect(net.alerts()).toEqual([]);
    // Polite: identified User-Agent on every request to government sites.
    for (const c of net.calls.filter((c) => !c.url.startsWith("https://api.telegram.org/"))) {
      expect(c.headers.get("user-agent")).toMatch(/visa-bulletin-push/);
    }
  });

  it("checks politely: skips when not due, every 3 minutes while the next bulletin is due, hourly otherwise", async () => {
    await runPoll(alertEnv(), NOW, fakeNet().fetcher); // 2026-10-04 03:00, October known, November due (day >= 5? no: Oct 4)
    // Oct 4 is before the window (day 5), so the next check is an hour later.
    const early = fakeNet();
    expect((await runPoll(alertEnv(), new Date("2026-10-04T03:30:00Z"), early.fetcher)).outcome).toBe("skipped");
    expect(early.calls).toHaveLength(0);
    // Inside the window (Oct 9) a check is due 3 minutes after the last one, and asks only for November.
    await runPoll(alertEnv(), new Date("2026-10-09T12:00:00Z"), fakeNet().fetcher);
    const soon = fakeNet();
    expect((await runPoll(alertEnv(), new Date("2026-10-09T12:02:00Z"), soon.fetcher)).outcome).toBe("skipped");
    const due = fakeNet();
    await runPoll(alertEnv(), new Date("2026-10-09T12:03:00Z"), due.fetcher);
    expect(due.calls.filter((c) => c.method === "HEAD").map((c) => c.url)).toEqual([NOV_PDF]);
  });

  it("does not ask the alias host when the main mirror answers 404", async () => {
    const net = fakeNet();
    await runPoll(alertEnv(), NOW, net.fetcher);
    expect(net.count("HEAD", NOV_PDF.replace("adoptions", "adoption"))).toBe(0);
  });

  it("never publishes twice when two polls run at the same time", async () => {
    const [a, b] = await Promise.all([runPoll(alertEnv(), NOW, fakeNet().fetcher), runPoll(alertEnv(), NOW, fakeNet().fetcher)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["busy", "published"]);
    expect(await countRows("events")).toBe(2);
  });

  it("records when it last checked, for the status endpoint", async () => {
    await runPoll(alertEnv(), NOW, fakeNet().fetcher);
    const row = await env.DB.prepare("SELECT value FROM poll_state WHERE key = 'health'").first<{ value: string }>();
    expect(JSON.parse(row!.value)).toMatchObject({ checked_at: "2026-10-04T03:00:00.000Z", outcome: "published", bulletin: "2026-10" });
  });

  it("does nothing on the next tick when the PDF has not changed", async () => {
    await runPoll(alertEnv(), NOW, fakeNet().fetcher);
    const net = fakeNet();
    const r = await runPoll(alertEnv(), new Date("2026-10-04T04:05:00Z"), net.fetcher); // next hourly check
    expect(r.outcome).toBe("unchanged");
    expect(net.count("GET", OCT_PDF)).toBe(0);
    expect(net.count("GET", USCIS)).toBe(0);
    expect(await countRows("events")).toBe(2);
  });

  it("treats the PDF as unchanged when only the mirror's ETag differs, and re-reads it once a day", async () => {
    // Measured 2026-10-04: eight HEADs to the same PDF returned eight different ETags and
    // Last-Modified values (one per mirror server) but the same 232,669-byte length.
    await runPoll(alertEnv(), NOW, fakeNet().fetcher);
    const soon = fakeNet();
    await runPoll(alertEnv(), new Date("2026-10-04T05:00:00Z"), soon.fetcher);
    expect(soon.count("GET", OCT_PDF)).toBe(0);
    const sameDay = fakeNet();
    await runPoll(alertEnv(), new Date("2026-10-04T23:00:00Z"), sameDay.fetcher);
    expect(sameDay.count("GET", OCT_PDF)).toBe(0);
    const nextDay = fakeNet();
    await runPoll(alertEnv(), new Date("2026-10-05T03:01:00Z"), nextDay.fetcher);
    expect(nextDay.count("GET", OCT_PDF)).toBe(1);
  });

  it("skips the USCIS page while this month's chart is known and was checked within six hours", async () => {
    await runPoll(alertEnv(), NOW, fakeNet().fetcher);
    const soon = fakeNet();
    await runPoll(alertEnv(), new Date("2026-10-04T05:00:00Z"), soon.fetcher);
    expect(soon.count("GET", USCIS)).toBe(0);
    const later = fakeNet({ [`GET ${USCIS}`]: () => new Response(null, { status: 304 }) });
    expect((await runPoll(alertEnv(), new Date("2026-10-04T09:01:00Z"), later.fetcher)).outcome).toBe("unchanged");
    expect(later.calls.find((c) => c.url === USCIS)?.headers.get("if-none-match")).toBe('"uscis-1"');
  });

  it("publishes from the official HTML when the PDF cannot be read", async () => {
    const net = fakeNet({ [`GET ${OCT_PDF}`]: () => new Response("%PDF-1.7 broken", { headers: { "content-type": "application/pdf" } }) });
    const r = await runPoll(alertEnv(), NOW, net.fetcher);
    expect(r.outcome).toBe("published");
    expect((await getLatest(env))?.snapshot.dates.IN.EB2).toEqual({ A: "2013-11-01", B: "2015-01-15" });
  });

  it("does not publish when the PDF and the HTML disagree, and alerts once", async () => {
    const tampered = OCT_2026_HTML.replace("01OCT21", "01NOV21");
    const net = fakeNet({ [`GET ${OCT_HTML_URL}`]: () => new Response(tampered) });
    const r = await runPoll(alertEnv(), NOW, net.fetcher);
    expect(r.outcome).toBe("mismatch");
    expect(await countRows("bulletins")).toBe(0);
    expect(net.alerts()).toHaveLength(1);
    expect(net.alerts()[0]).toMatch(/CN EB2 A/);
  });

  it("still publishes the dates when USCIS cannot be read", async () => {
    const net = fakeNet({ [`GET ${USCIS}`]: () => new Response("Access Denied", { status: 403 }) });
    const r = await runPoll(alertEnv(), NOW, net.fetcher);
    expect(r.outcome).toBe("published");
    expect((await getLatest(env))?.snapshot.uscis).toBeNull();
    expect(net.alerts()).toHaveLength(1);
    expect(net.alerts()[0]).toMatch(/USCIS/);
  });

  it("alerts at most once per UTC day when no bulletin PDF can be found", async () => {
    const gone: Route = () => new Response(null, { status: 404 });
    const overrides = {
      [`HEAD ${OCT_PDF}`]: gone,
      [`HEAD ${OCT_PDF.replace("adoptions", "adoption")}`]: gone,
    };
    const first = fakeNet(overrides);
    expect((await runPoll(alertEnv(), NOW, first.fetcher)).outcome).toBe("failed");
    expect(first.alerts()).toHaveLength(1);
    const second = fakeNet(overrides);
    await runPoll(alertEnv(), new Date("2026-10-04T09:00:00Z"), second.fetcher);
    expect(second.alerts()).toHaveLength(0);
    const nextDay = fakeNet(overrides);
    await runPoll(alertEnv(), new Date("2026-10-05T00:05:00Z"), nextDay.fetcher);
    expect(nextDay.alerts()).toHaveLength(1);
  });

  it("runs without alert credentials (logs instead of failing)", async () => {
    const gone: Route = () => new Response(null, { status: 404 });
    const net = fakeNet({ [`HEAD ${OCT_PDF}`]: gone, [`HEAD ${OCT_PDF.replace("adoptions", "adoption")}`]: gone });
    const r = await runPoll(env, NOW, net.fetcher);
    expect(r.outcome).toBe("failed");
    expect(net.alerts()).toEqual([]);
  });
});
