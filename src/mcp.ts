// MCP server at POST /mcp: stateless streamable HTTP, JSON responses only.
//
// Free plan allows 10 ms CPU per request (https://developers.cloudflare.com/workers/platform/limits/#cpu-time).
// Measured 2026-10-04 with `wrangler tail` on the deployed Worker: the first version, built on
// `createMcpHandler` (agents) + MCP SDK v2 + zod with a fresh server per request, used 10-30 ms CPU
// per tools/call. This is a plain JSON-RPC switch with static tool schemas instead. The streamable
// HTTP transport lets a server answer a POST with application/json and no session
// (https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
//
// Nothing a client sends is stored: the tools only read the bulletins table.

import { getBulletin, getLatest } from "./api";
import { type RpcOutcome, handleSubscribe, handleUnsubscribe, listEvents } from "./mcp-events";
import {
  CATEGORIES,
  type Category,
  type Cell,
  type Chart,
  COUNTRIES,
  type Country,
  type Snapshot,
  chartForMonth,
  isIsoDate,
} from "./snapshot";

const NOTE =
  "Unofficial data, not legal advice. Check the State Department bulletin and the USCIS filing-charts page. 非官方整理，非法律意见，以美国国务院与 USCIS 原文为准。";

/** True when the priority date is earlier than the cutoff; "C" is always current, "U" never. */
function isCurrent(cell: Cell, priorityDate: string): boolean {
  if (cell === "C") return true;
  if (cell === "U") return false;
  return priorityDate < cell; // ISO dates compare lexicographically
}

export interface PriorityDateCheck {
  bulletin: string;
  country: Country;
  category: Category;
  priority_date: string;
  final_action_date: Cell;
  dates_for_filing_date: Cell;
  final_action_current: boolean;
  dates_for_filing_current: boolean;
  uscis_employment_chart: Chart | null;
  can_file_i485_this_month: boolean | null;
  note: string;
}

export function checkPriorityDate(s: Snapshot, country: Country, category: Category, priorityDate: string): PriorityDateCheck {
  const cells = s.dates[country][category];
  const finalAction = isCurrent(cells.A, priorityDate);
  const filing = isCurrent(cells.B, priorityDate);
  const chart = chartForMonth(s);
  return {
    bulletin: s.bulletin,
    country,
    category,
    priority_date: priorityDate,
    final_action_date: cells.A,
    dates_for_filing_date: cells.B,
    final_action_current: finalAction,
    dates_for_filing_current: filing,
    uscis_employment_chart: chart,
    can_file_i485_this_month: chart === "A" ? finalAction : chart === "B" ? filing : null,
    note: NOTE,
  };
}

const NO_DATA = "No bulletin has been ingested yet. 暂无数据。";
const SERVER_INFO = { name: "visa-bulletin-push", version: "1.0.0" };
/** Legacy (initialize-based) versions. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/**
 * Modern versions: no initialize, version and client info in every request's `_meta`.
 * ChatGPT's MCP Events need 2026-07-28 ("MCP Events in ChatGPT requires MCP 2.0 (protocol version
 * 2026-07-28)", https://developers.openai.com/plugins/build/mcp-events, read 2026-10-04).
 */
const MODERN_VERSIONS = ["2026-07-28"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
/** tools/list and server/discover cache hint (2026-07-28 "Caching"): the tool set changes only on deploy. */
const LIST_TTL_MS = 3_600_000;
/**
 * Events capability: top-level `capabilities.events`, an empty object.
 * Ambiguity: the spec sketch's example shows `{"listChanged": true}`; ChatGPT's page shows `{}` and
 * the field report says ChatGPT reads the top-level key (a move under `capabilities.extensions` was
 * proposed in PR #7 and closed unmerged). We send no list_changed notifications, so `{}`.
 * Sources (2026-10-04): https://developers.openai.com/plugins/build/mcp-events,
 * https://github.com/modelcontextprotocol/experimental-ext-triggers-events/issues/8
 */
const EVENTS_CAPABILITY = {};
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const COUNTRY_SCHEMA = { type: "string", enum: [...COUNTRIES], description: "CN = China mainland-born, IN = India" };
const CATEGORY_SCHEMA = { type: "string", enum: [...CATEGORIES] };

const TOOLS = [
  {
    name: "get_latest_dates",
    description:
      "Latest US Visa Bulletin employment-based cutoff dates for China (mainland-born) and India. A = Final Action Dates, B = Dates for Filing; values are YYYY-MM-DD, 'C' (current) or 'U' (unavailable). Also returns which chart USCIS accepts for I-485 this month.",
    inputSchema: { type: "object", properties: { country: COUNTRY_SCHEMA, category: CATEGORY_SCHEMA }, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "get_bulletin",
    description: "The full stored snapshot for one bulletin month (YYYY-MM), China and India EB1-EB3, both charts.",
    inputSchema: {
      type: "object",
      properties: { month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "YYYY-MM, e.g. 2026-10" } },
      required: ["month"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "check_priority_date",
    description:
      "Check a priority date against the latest bulletin: whether it is current on Final Action (A) and Dates for Filing (B), and whether an employment-based I-485 can be filed this month using the chart USCIS picked (null when USCIS has not said). Computed on the fly; nothing is stored.",
    inputSchema: {
      type: "object",
      properties: {
        country: COUNTRY_SCHEMA,
        category: CATEGORY_SCHEMA,
        priority_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD" },
      },
      required: ["country", "category", "priority_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function fail(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const isCountry = (v: unknown): v is Country => (COUNTRIES as readonly unknown[]).includes(v);
const isCategory = (v: unknown): v is Category => (CATEGORIES as readonly unknown[]).includes(v);

async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  if (name === "get_latest_dates") {
    const { country, category } = args;
    if (country !== undefined && !isCountry(country)) return fail("country must be CN or IN.");
    if (category !== undefined && !isCategory(category)) return fail("category must be EB1, EB2 or EB3.");
    const latest = await getLatest(env);
    if (!latest) return fail(NO_DATA);
    const s = latest.snapshot;
    const dates: Record<string, Record<string, unknown>> = {};
    for (const c of country ? [country] : COUNTRIES) {
      dates[c] = {};
      for (const cat of category ? [category] : CATEGORIES) dates[c]![cat] = s.dates[c][cat];
    }
    return ok({
      bulletin: s.bulletin,
      dates,
      uscis_employment_chart: chartForMonth(s),
      updated_at: latest.updated_at,
      source_pdf: s.source.pdf_url,
      note: NOTE,
    });
  }
  if (name === "get_bulletin") {
    const month = args.month;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail("month must be YYYY-MM.");
    const s = await getBulletin(env, month);
    if (!s) return fail(`No bulletin stored for ${month}.`);
    return ok({ ...s, note: NOTE } as unknown as Record<string, unknown>);
  }
  if (name === "check_priority_date") {
    const { country, category, priority_date } = args;
    if (!isCountry(country)) return fail("country must be CN or IN.");
    if (!isCategory(category)) return fail("category must be EB1, EB2 or EB3.");
    if (typeof priority_date !== "string" || !isIsoDate(priority_date))
      return fail("priority_date must be a real calendar date, YYYY-MM-DD.");
    const latest = await getLatest(env);
    if (!latest) return fail(NO_DATA);
    return ok({ ...checkPriorityDate(latest.snapshot, country, category, priority_date) });
  }
  return null;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function rpcResult(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: JSON_HEADERS });
}

function rpcError(id: unknown, code: number, message: string, status = 200, data?: unknown): Response {
  const error = data === undefined ? { code, message } : { code, message, data };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error }), { status, headers: JSON_HEADERS });
}

/** Decode the `=?base64?...?=` sentinel used by Mcp-Name / Mcp-Param-* headers. */
function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * 2026-07-28 Streamable HTTP "Server Validation": MCP-Protocol-Version and Mcp-Method are required
 * and must match the body (Mcp-Name too for tools/call), else 400 + -32020 HeaderMismatch; an
 * unsupported version is 400 + -32022.
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (read 2026-10-04)
 */
function checkModernRequest(request: Request, msg: any, params: any): Response | null {
  const metaVersion = params._meta?.[META_VERSION];
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (!headerVersion) return rpcError(msg.id, -32020, "Header mismatch: MCP-Protocol-Version header is required", 400);
  if (metaVersion !== undefined && metaVersion !== headerVersion) {
    return rpcError(msg.id, -32020, "Header mismatch: MCP-Protocol-Version does not match _meta", 400);
  }
  if (!MODERN_VERSIONS.includes(headerVersion)) {
    return rpcError(msg.id, -32022, "Unsupported protocol version", 400, {
      supported: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS],
      requested: headerVersion,
    });
  }
  if (request.headers.get("mcp-method") !== msg.method) {
    return rpcError(msg.id, -32020, "Header mismatch: Mcp-Method does not match the body method", 400);
  }
  if (msg.method === "tools/call") {
    const name = request.headers.get("mcp-name");
    if (name === null || decodeHeaderValue(name) !== params.name) {
      return rpcError(msg.id, -32020, "Header mismatch: Mcp-Name does not match params.name", 400);
    }
  }
  return null;
}

function outcome(id: unknown, o: RpcOutcome, wrap: (r: Record<string, unknown>) => unknown): Response {
  if ("error" in o) return rpcError(id, o.error.code, o.error.message, 200, o.error.data);
  return rpcResult(id, wrap(o.result));
}

export async function handleMcp(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  let msg: any;
  try {
    msg = JSON.parse(await request.text());
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request", 400);
  }
  // Notifications (no id) and client responses get 202 Accepted with no body.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  // Dual-era server: a request carrying the per-request protocol version in _meta (or the modern-only
  // server/discover) is served by the 2026-07-28 rules; anything else by the initialize-based rules.
  const modern = typeof params._meta?.[META_VERSION] === "string" || msg.method === "server/discover";
  if (modern) {
    const bad = checkModernRequest(request, msg, params);
    if (bad) return bad;
  }
  // Every modern result carries resultType and identifies the server in _meta.
  const wrap = (r: Record<string, unknown>): Record<string, unknown> =>
    modern ? { resultType: "complete", ...r, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } : r;

  switch (msg.method) {
    case "server/discover":
      return rpcResult(
        msg.id,
        wrap({
          supportedVersions: [...MODERN_VERSIONS, ...PROTOCOL_VERSIONS],
          capabilities: { tools: {}, events: EVENTS_CAPABILITY },
          instructions: NOTE,
          ttlMs: LIST_TTL_MS,
          cacheScope: "public",
        }),
      );
    case "tools/list":
      return rpcResult(msg.id, wrap(modern ? { tools: TOOLS, ttlMs: LIST_TTL_MS, cacheScope: "public" } : { tools: TOOLS }));
    case "tools/call": {
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const result = await callTool(env, String(params.name), args);
      if (!result) return rpcError(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
      return rpcResult(msg.id, wrap(result as unknown as Record<string, unknown>));
    }
    case "events/list":
      return outcome(msg.id, listEvents(), wrap);
    case "events/subscribe":
      return outcome(msg.id, await handleSubscribe(env, params), wrap);
    case "events/unsubscribe":
      return outcome(msg.id, await handleUnsubscribe(env, params), wrap);
  }
  if (!modern) {
    // Legacy-only methods (2026-07-28 removed initialize and ping).
    if (msg.method === "initialize") {
      const asked = params.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, events: EVENTS_CAPABILITY },
        serverInfo: SERVER_INFO,
      });
    }
    if (msg.method === "ping") return rpcResult(msg.id, {});
  }
  // 2026-07-28: an unknown method is HTTP 404 with -32601; legacy keeps 200.
  return rpcError(msg.id, -32601, `Method not found: ${msg.method}`, modern ? 404 : 200);
}
