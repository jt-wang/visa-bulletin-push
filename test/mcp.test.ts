import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPriorityDate } from "../src/mcp";
import { countRows, ingest, octoberSnapshot, readMcp } from "./helpers";

const PROTOCOL = "2025-06-18";

function rpc(method: string, params?: unknown, id = 1): Promise<Response> {
  return exports.default.fetch("https://vb.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await rpc("tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return (await readMcp(res)).result;
}

describe("checkPriorityDate (pure)", () => {
  const oct = octoberSnapshot();

  it("CN EB3 2021-12-01: both charts current; USCIS chart B -> can file", () => {
    expect(checkPriorityDate(oct, "CN", "EB3", "2021-12-01")).toMatchObject({
      bulletin: "2026-10",
      final_action_date: "2022-01-08",
      dates_for_filing_date: "2024-04-01",
      final_action_current: true,
      dates_for_filing_current: true,
      uscis_employment_chart: "B",
      can_file_i485_this_month: true,
    });
  });

  it("CN EB3 2023-01-01: only chart B current; chart B -> can file, chart A -> cannot", () => {
    expect(checkPriorityDate(oct, "CN", "EB3", "2023-01-01")).toMatchObject({
      final_action_current: false,
      dates_for_filing_current: true,
      can_file_i485_this_month: true,
    });
    const chartA = octoberSnapshot();
    chartA.uscis.employment_chart = "A";
    expect(checkPriorityDate(chartA, "CN", "EB3", "2023-01-01").can_file_i485_this_month).toBe(false);
  });

  it("a priority date equal to the cutoff is not current (must be earlier)", () => {
    expect(checkPriorityDate(oct, "CN", "EB3", "2022-01-08").final_action_current).toBe(false);
  });

  it("C is always current, U never", () => {
    const s = octoberSnapshot();
    s.dates.IN.EB1.A = "C";
    s.dates.IN.EB1.B = "U";
    const r = checkPriorityDate(s, "IN", "EB1", "2026-09-30");
    expect(r.final_action_current).toBe(true);
    expect(r.dates_for_filing_current).toBe(false);
  });

  it("unknown USCIS chart -> can_file_i485_this_month is null", () => {
    const s = octoberSnapshot();
    s.uscis = null;
    expect(checkPriorityDate(s, "CN", "EB2", "2020-01-01").can_file_i485_this_month).toBeNull();
    const other = octoberSnapshot();
    other.uscis.bulletin = "2026-09";
    expect(checkPriorityDate(other, "CN", "EB2", "2020-01-01").uscis_employment_chart).toBeNull();
  });

  it("always carries a not-legal-advice note", () => {
    expect(checkPriorityDate(oct, "IN", "EB2", "2013-01-01").note).toMatch(/not legal advice/i);
  });
});

describe("MCP endpoint (stateless streamable HTTP)", () => {
  beforeEach(async () => {
    vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
    await ingest(octoberSnapshot());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initialize returns server info and the tools capability", async () => {
    const res = await rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    expect(res.status).toBe(200);
    const msg = await readMcp(res);
    expect(msg.result.serverInfo.name).toBe("visa-bulletin-push");
    expect(msg.result.capabilities.tools).toBeDefined();
    expect(res.headers.get("mcp-session-id")).toBeNull(); // stateless: no protocol session
  });

  it("tools/list lists the three tools with input schemas", async () => {
    const msg = await readMcp(await rpc("tools/list"));
    const tools = msg.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(["check_priority_date", "get_bulletin", "get_latest_dates"]);
    const check = tools.find((t: any) => t.name === "check_priority_date");
    expect(check.inputSchema.required.sort()).toEqual(["category", "country", "priority_date"]);
    expect(check.inputSchema.properties.country.enum).toEqual(["CN", "IN"]);
  });

  it("get_latest_dates filters by country and category", async () => {
    const r = await call("get_latest_dates", { country: "CN", category: "EB3" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      bulletin: "2026-10",
      uscis_employment_chart: "B",
      dates: { CN: { EB3: { A: "2022-01-08", B: "2024-04-01" } } },
    });
    expect(Object.keys(r.structuredContent.dates)).toEqual(["CN"]);
    expect(Object.keys(r.structuredContent.dates.CN)).toEqual(["EB3"]);
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  });

  it("get_latest_dates with no arguments returns all 12 cells", async () => {
    const r = await call("get_latest_dates", {});
    expect(r.structuredContent.dates).toEqual(octoberSnapshot().dates);
  });

  it("get_bulletin returns a stored month and an error for an unknown one", async () => {
    const ok = await call("get_bulletin", { month: "2026-10" });
    expect(ok.structuredContent.bulletin).toBe("2026-10");
    const missing = await call("get_bulletin", { month: "2020-01" });
    expect(missing.isError).toBe(true);
  });

  it("check_priority_date computes against the latest bulletin", async () => {
    const r = await call("check_priority_date", { country: "CN", category: "EB3", priority_date: "2023-01-01" });
    expect(r.structuredContent).toMatchObject({
      bulletin: "2026-10",
      final_action_current: false,
      dates_for_filing_current: true,
      uscis_employment_chart: "B",
      can_file_i485_this_month: true,
    });
  });

  it("check_priority_date rejects an impossible date", async () => {
    const r = await call("check_priority_date", { country: "CN", category: "EB3", priority_date: "2023-02-30" });
    expect(r.isError).toBe(true);
  });

  // Free plan allows 10 ms CPU per request. Measured 2026-10-04 with `wrangler tail`
  // on the deployed Worker: the SDK-based handler (fresh McpServer + zod per request)
  // used 10-30 ms per tools/call. The handler is a plain JSON-RPC switch that answers
  // with application/json, which the streamable HTTP transport allows.
  it("answers with plain JSON, not an SSE stream", async () => {
    const res = await rpc("tools/list");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await exports.default.fetch("https://vb.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers ping with an empty result", async () => {
    expect((await readMcp(await rpc("ping"))).result).toEqual({});
  });

  it("returns JSON-RPC errors for unknown methods, bad JSON, unknown tools and bad arguments", async () => {
    expect((await readMcp(await rpc("resources/list"))).error.code).toBe(-32601);
    const bad = await exports.default.fetch("https://vb.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await readMcp(bad)).error.code).toBe(-32700);
    expect((await readMcp(await rpc("tools/call", { name: "nope", arguments: {} }))).error.code).toBe(-32602);
    const badArgs = await call("check_priority_date", { country: "MX", category: "EB3", priority_date: "2023-01-01" });
    expect(badArgs.isError).toBe(true);
  });

  it("rejects GET (no server-initiated stream)", async () => {
    const res = await exports.default.fetch("https://vb.example/mcp", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("stores nothing for MCP calls", async () => {
    const tables = ["bulletins", "events", "subscriptions", "deliveries", "registration_limits"];
    const before = await Promise.all(tables.map(countRows));
    await call("check_priority_date", { country: "IN", category: "EB2", priority_date: "2013-01-01" });
    await call("get_latest_dates", {});
    expect(await Promise.all(tables.map(countRows))).toEqual(before);
  });
});
