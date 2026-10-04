import { getHealth, getLatest, getPrevious, handleBulletin, handleStatus, handleBulletinIndex, handleFeed, handleLatest } from "./api";
import { handleQueue } from "./delivery";
import { CORS_HEADERS, PUBLIC_CACHE, errorJson, publicJson } from "./http";
import { type DeliveryMessage, handleIngest } from "./ingest";
import { handleMcp } from "./mcp";
import { sendTestEvent } from "./mcp-events";
import { runPoll } from "./poll";
import { ensureCard, handleCard } from "./card";
import { signatureHeader, timingSafeEqualStr } from "./crypto";
import { MAX_SKEW_SECONDS } from "./ingest";
import { type Author, type Lang, renderHome } from "./site";
import { renderSetup, renderStop } from "./setup";
import { renderSkill } from "./skill";
import { handleCreateWebhook, handleDeleteWebhook, handleGetWebhook, handleTestWebhook } from "./webhooks";

const MONTH_PATH = /^\/v1\/bulletins\/(\d{4}-(?:0[1-9]|1[0-2]))\.json$/;
const WEBHOOK_PATH = /^\/v1\/webhooks\/(wh_[0-9a-f]{24})$/;
const WEBHOOK_TEST_PATH = /^\/v1\/webhooks\/(wh_[0-9a-f]{24})\/test$/;

function authorFrom(env: Env): Author {
  if (!env.AUTHOR_NAME) return null;
  return { name: env.AUTHOR_NAME, x: env.AUTHOR_X, site: env.AUTHOR_SITE, bioEn: env.AUTHOR_BIO_EN, bioZh: env.AUTHOR_BIO_ZH };
}

/** ?lang= wins; otherwise the browser's first preferred language. */
function pickLang(url: URL, request: Request): Lang {
  const q = url.searchParams.get("lang");
  if (q === "zh" || q === "en") return q;
  const first = (request.headers.get("accept-language") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("zh") ? "zh" : "en";
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const isRead = method === "GET" || method === "HEAD";

  if (pathname === "/v1/ingest") {
    return method === "POST" ? handleIngest(request, env) : errorJson(405, "method_not_allowed");
  }
  if (pathname === "/v1/admin/poll" || pathname === "/v1/admin/mcp-test") {
    if (method !== "POST") return errorJson(405, "method_not_allowed");
    // Same signature scheme as /v1/ingest: lets the operator run one poll, or send a TEST event to MCP subscribers.
    const ts = request.headers.get("x-vb-timestamp") ?? "";
    const sig = request.headers.get("x-vb-signature") ?? "";
    const raw = await request.text();
    if (!/^\d{1,12}$/.test(ts) || !/^sha256=[0-9a-f]{64}$/.test(sig)) return errorJson(401, "bad_signature");
    if (!timingSafeEqualStr(await signatureHeader(env.INGEST_SECRET, ts, raw), sig)) return errorJson(401, "bad_signature");
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > MAX_SKEW_SECONDS) return errorJson(401, "stale_timestamp");
    if (pathname === "/v1/admin/poll") return Response.json(await runPoll(env));
    let marker = "";
    try {
      marker = String((JSON.parse(raw || "{}") as { marker?: unknown }).marker ?? "").slice(0, 40);
    } catch {
      return errorJson(400, "invalid_json");
    }
    return Response.json({ sent: await sendTestEvent(env, marker || "CHECK") });
  }
  if (pathname === "/v1/webhooks") {
    return method === "POST" ? handleCreateWebhook(request, env) : errorJson(405, "method_not_allowed");
  }
  const wh = WEBHOOK_PATH.exec(pathname);
  if (wh) {
    if (method === "GET") return handleGetWebhook(request, env, wh[1]!);
    if (method === "DELETE") return handleDeleteWebhook(request, env, wh[1]!);
    return errorJson(405, "method_not_allowed");
  }
  const whTest = WEBHOOK_TEST_PATH.exec(pathname);
  if (whTest) return method === "POST" ? handleTestWebhook(request, env, whTest[1]!) : errorJson(405, "method_not_allowed");
  if (isRead && pathname.startsWith("/og/")) {
    return (await handleCard(env, pathname)) ?? publicJson({ error: "not_found" }, 404);
  }
  if (pathname === "/mcp") {
    return handleMcp(request, env, ctx);
  }

  const isPublicRead = pathname === "/" || pathname === "/skill.md" || pathname === "/setup.md" || pathname === "/stop" || pathname === "/feed.atom" || pathname.startsWith("/v1/");
  if (method === "OPTIONS" && isPublicRead) return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!isRead) return errorJson(405, "method_not_allowed");

  if (pathname === "/") {
    const latest = await getLatest(env);
    const [previous, health] = await Promise.all([latest ? getPrevious(env, latest.snapshot.bulletin) : null, getHealth(env)]);
    return new Response(renderHome(url.origin, latest, previous, pickLang(url, request), health?.checked_at ?? null, authorFrom(env)), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": PUBLIC_CACHE, vary: "Accept-Language" },
    });
  }
  if (pathname === "/setup.md") {
    return new Response(renderSetup(url.origin), {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": PUBLIC_CACHE, ...CORS_HEADERS },
    });
  }
  if (pathname === "/stop") {
    return new Response(renderStop(url.host), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": PUBLIC_CACHE, "referrer-policy": "no-referrer" },
    });
  }
  if (pathname === "/skill.md") {
    return new Response(renderSkill(url.origin), {
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": PUBLIC_CACHE, ...CORS_HEADERS },
    });
  }
  if (pathname === "/v1/latest.json") return handleLatest(env);
  if (pathname === "/v1/status") return handleStatus(env);
  if (pathname === "/v1/bulletins.json") return handleBulletinIndex(env);
  const month = MONTH_PATH.exec(pathname);
  if (month) return handleBulletin(env, month[1]!);
  if (pathname === "/feed.atom") return handleFeed(env, url.origin);
  return publicJson({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(JSON.stringify({ msg: "unhandled", path: new URL(request.url).pathname, error: String(err) }));
      return errorJson(500, "internal_error");
    }
  },

  async scheduled(controller, env): Promise<void> {
    const r = await runPoll(env, new Date(controller.scheduledTime));
    console.log(JSON.stringify({ msg: "poll", ...r }));
    // The share card follows the latest bulletin; one D1 read when it is already there.
    await ensureCard(env, env.BROWSER, new Date(controller.scheduledTime));
  },

  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, DeliveryMessage>;
