# Visa Bulletin Push

Unofficial US Visa Bulletin employment-based cutoff dates for **China (mainland-born)** and **India**, EB-1, EB-2 and EB-3, served from one Cloudflare Worker as:

- a web page (`/`)
- a JSON API (`/v1/latest.json`, `/v1/bulletins.json`, `/v1/bulletins/{YYYY-MM}.json`)
- an Atom feed (`/feed.atom`)
- signed webhooks (`POST /v1/webhooks`), with a test alert on demand (`POST /v1/webhooks/{id}/test`)
- a stateless MCP server (`POST /mcp`) with MCP Events push for ChatGPT
- `/setup.md`: instructions an AI agent follows to set itself up from one sentence; `/stop#id=…&token=…` to stop alerts
- `/v1/status`: last check and health
- `/og/{YYYY-MM}-{A|B|x}.png`: the share card link previews show, with the latest bulletin's dates

**Unofficial. Not legal advice.** Always check the [State Department Visa Bulletin](https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html) and the [USCIS filing-charts page](https://www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-priority-dates/adjustment-of-status-filing-charts-from-the-visa-bulletin).

It runs on the Workers **Free** plan: D1 for storage, a Queue for webhook fan-out, no Durable Objects.

## How data gets in

A Cron Trigger (`src/poll.ts`; fires every minute, checks every 3 minutes while a new bulletin is due and hourly otherwise, one poll at a time via a D1 lease) does the whole pipeline inside the Worker: it HEADs the official bulletin PDF on the State Department DAM mirror (`adoptions.state.gov`; `travel.state.gov` itself answers automation with a Cloudflare challenge, which is never solved), parses new PDFs in the Worker, cross-checks them against the official HTML page, reads the USCIS filing-charts page, then stores the snapshot, decides which events it produces and queues one delivery per matching webhook subscription. Failures send at most one alert per kind per UTC day to Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. `POST /v1/ingest` (signed with `INGEST_SECRET`) stays available for manual corrections, and `POST /v1/admin/poll` (same signature over an empty body) runs one poll on demand.

### Snapshot contract (`visa-bulletin-push/v1`)

This is both the ingest body and the public `latest.json`.

```json
{
  "schema": "visa-bulletin-push/v1",
  "bulletin": "2026-10",
  "dates": {
    "CN": {"EB1": {"A": "2023-07-01", "B": "2024-07-01"},
           "EB2": {"A": "2021-10-01", "B": "2023-01-01"},
           "EB3": {"A": "2022-01-08", "B": "2024-04-01"}},
    "IN": {"EB1": {"A": "2023-02-01", "B": "2024-07-01"},
           "EB2": {"A": "2013-11-01", "B": "2015-01-15"},
           "EB3": {"A": "2014-01-01", "B": "2015-01-15"}}
  },
  "raw": {"CN": {"EB1": {"A": "01JUL23", "B": "01JUL24"}}},
  "uscis": {"bulletin": "2026-10", "employment_chart": "B", "source_url": "https://www.uscis.gov/..."},
  "source": {"pdf_url": "https://travel.state.gov/content/dam/visas/Bulletins/visabulletin_October2026.pdf",
             "pdf_last_modified": "2026-09-29T11:47:04Z"},
  "observed_at": "2026-10-04T02:00:00Z"
}
```

- `A` = Final Action Dates, `B` = Dates for Filing.
- Each of the 12 cells is an ISO date, `"C"` (current) or `"U"` (unavailable).
- `uscis` is `null` when unknown; otherwise it names the chart USCIS accepts for employment-based I-485 and for which bulletin month.
- Validation is strict: unknown keys, missing cells, impossible dates and bulletin-style spellings (`08JAN22`) are rejected with `400`.

### Ingest signature

```
X-VB-Timestamp: <unix seconds>            (must be within ±300 s)
X-VB-Signature: sha256=<hex(HMAC-SHA256(INGEST_SECRET, timestamp + "." + rawBody))>
```

```sh
ts=$(date +%s)
body=$(cat snapshot.json)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$INGEST_SECRET" -hex | sed 's/^.* //')
curl -X POST "https://<your-worker>/v1/ingest" \
  -H 'content-type: application/json' \
  -H "x-vb-timestamp: $ts" -H "x-vb-signature: sha256=$sig" \
  --data-binary "$body"
```

### Events

| Event | When |
|---|---|
| `bulletin.published` | first snapshot of a month newer than every stored month |
| `bulletin.updated` | same month, at least one of the 12 cells changed |
| `uscis.chart_decided` | the USCIS chart for that month is seen for the first time, or changes |

One ingest can produce two events (for example `published` + `chart_decided`). Re-sending an identical snapshot produces none. A later snapshot with `uscis: null` keeps the chart already known for that month. An older month sent after a newer one is stored without events.

## Webhooks

```sh
curl -X POST https://<your-worker>/v1/webhooks \
  -H 'content-type: application/json' \
  -d '{"url":"https://your-server.example.com/visa-hook","events":["bulletin.published","uscis.chart_decided"],"bearer_token":"optional"}'
# 201 {"id":"wh_…","signing_secret":"whsec_…","manage_token":"vbm_…", ...}   shown once

curl https://<your-worker>/v1/webhooks/wh_… -H 'authorization: Bearer vbm_…'            # status + last delivery
curl -X POST https://<your-worker>/v1/webhooks/wh_…/test -H 'authorization: Bearer vbm_…'  # send a test alert now
curl -X DELETE https://<your-worker>/v1/webhooks/wh_… -H 'authorization: Bearer vbm_…'  # delete
```

- The Worker sends a signed `ping` to the URL first. Only a `2xx` answer creates the subscription (`422 ping_failed` otherwise). Redirects are not followed.
- `events` defaults to all three. `bearer_token` (optional) is sent back as `Authorization: Bearer …` on every delivery.
- URL rules: `https` only; port 443 or none; no IP literals (this rejects private, loopback and link-local ranges); no `localhost`, `*.local`, `*.internal` and similar non-public suffixes; no credentials in the URL.
- At most 10 new subscriptions (and 30 registration attempts) per client IP per UTC day.
- `POST /v1/webhooks/{id}/test` sends event `test` with the current snapshot right away and answers `{"delivered": true, "status": 200}` or `{"delivered": false, "status": …, "error": …}`. Not stored, not counted against the subscription; at most 10 per subscription per UTC day. A new MCP `bulletin.published` subscription gets one such test (its `data.message` starts with `TEST`) about 30 seconds after it subscribes.

### Delivery

```
POST <your url>
Content-Type: application/json
User-Agent: visa-bulletin-push/1.0
X-VB-Event: bulletin.published
X-VB-Delivery: dl_…                       (stable across retries; use it to de-duplicate)
X-VB-Timestamp: <unix seconds>
X-VB-Signature: sha256=<hex(HMAC-SHA256(signing_secret, timestamp + "." + body))>
Authorization: Bearer <bearer_token>       (only if you gave one)

{"source":"visa-bulletin-push","event":"bulletin.published","message":"Oct 2026 Visa Bulletin: CN EB1 A 2023-07-01 / B 2024-07-01, … USCIS: use chart B | 2026年10月签证排期已发布…","sent_at":"2026-10-04T02:00:05Z","data":{…snapshot…}}
```

- Non-2xx, timeout (10 s) or network error → retried with backoff 1 min, 4 min, 16 min, 64 min; after the 5th failed attempt the delivery is marked failed.
- After 20 consecutive failed deliveries the subscription is disabled.

Verify in Node:

```js
import crypto from "node:crypto";

export function verify(rawBody, headers, signingSecret) {
  const ts = headers["x-vb-timestamp"];
  const given = headers["x-vb-signature"] ?? "";
  const expected = "sha256=" +
    crypto.createHmac("sha256", signingSecret).update(`${ts}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && given.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

## Read API

| Path | Body |
|---|---|
| `GET /v1/latest.json` | newest snapshot (contract above) |
| `GET /v1/bulletins.json` | `{"bulletins":[{"bulletin","url","uscis_employment_chart","updated_at"}]}`, newest first |
| `GET /v1/bulletins/{YYYY-MM}.json` | that month's snapshot |
| `GET /feed.atom` | one entry per event, newest 50 |

All are CORS `*` with `Cache-Control: public, max-age=60`. Empty or unknown → `404 {"error":"not_found"}`.

## MCP

`https://<your-worker>/mcp`, Streamable HTTP, no auth, nothing stored.

| Tool | Input | Output |
|---|---|---|
| `get_latest_dates` | `country?: "CN"\|"IN"`, `category?: "EB1"\|"EB2"\|"EB3"` | cells for the latest bulletin + USCIS chart |
| `get_bulletin` | `month: "YYYY-MM"` | that month's snapshot |
| `check_priority_date` | `country`, `category`, `priority_date: "YYYY-MM-DD"` | `final_action_current`, `dates_for_filing_current`, `uscis_employment_chart`, `can_file_i485_this_month` (`null` if USCIS has not said), bulletin month, not-legal-advice note |

A date is current when the priority date is earlier than the cutoff; `C` is always current, `U` never.

The server is a small hand-written JSON-RPC handler (`src/mcp.ts`): stateless streamable HTTP, `application/json` responses, no session, no SDK. An SDK-based first version used 10–30 ms CPU per call on the deployed Worker (free plan limit: 10 ms); this one stays within it.

```json
{ "mcpServers": { "visa-bulletin": { "type": "http", "url": "https://<your-worker>/mcp" } } }
```

## Deploy your own

Requires a Cloudflare account (Free plan is enough) and Node 20+.

```sh
npm ci
npx wrangler login
npx wrangler d1 create visa-bulletin-push           # put the printed database_id into wrangler.jsonc
npx wrangler queues create visa-bulletin-push-deliveries
npx wrangler d1 migrations apply visa-bulletin-push --remote
openssl rand -hex 32    | npx wrangler secret put INGEST_SECRET   # signs /v1/ingest and /v1/admin/poll
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY   # AES-GCM key for stored webhook secrets
openssl rand -hex 16    | npx wrangler secret put IP_HASH_SALT    # optional, recommended
npx wrangler secret put TELEGRAM_BOT_TOKEN                        # optional: failure alerts
npx wrangler secret put TELEGRAM_CHAT_ID                          # optional
npm run deploy
```

`wrangler.jsonc` deploys to `*.workers.dev`. For a custom domain, copy it to a private file (for example `wrangler.production.jsonc`, already in `.gitignore`), add `routes`, and deploy with `npx wrangler deploy -c wrangler.production.jsonc`.

Optional `vars` in that private config:

| Var | Effect |
|---|---|
| `PUBLIC_URL` | Your site URL; added to the User-Agent sent to the State Department and USCIS so they can reach you |
| `AUTHOR_NAME`, `AUTHOR_X`, `AUTHOR_SITE` | Show an author section and a follow button. Without `AUTHOR_NAME` the page has neither |
| `AUTHOR_BIO_EN`, `AUTHOR_BIO_ZH` | Short author bio in each language |

`npm run privacy-check` fails if any file git would commit contains a term from `.privacy-denylist` (one term per line, git-ignored), including spaced, base64 and compressed forms, or if the commit identity or timezone would reveal one. `npm run privacy-hook` installs it as a pre-commit hook; commit with `TZ=UTC git commit`. `.privacy-allow-identity` (git-ignored) lists the exact name and email you publish under. `npm run privacy-check:test` tests the check itself.

**Share card.** When a new bulletin or USCIS chart appears, the Cron Trigger renders a 1200x630 card with the dates through Browser Run (`browser` binding; a few seconds of the Free plan's 10 browser minutes a day), stores it in D1 and points `og:image` at `/og/{month}-{chart}.png`. Until it exists, that URL redirects to the static `public/og.png`. The card embeds IBM Plex from `public/fonts` (SIL Open Font License, `public/fonts/OFL.txt`) through the `ASSETS` binding. If your private config serves another assets directory, copy `public/fonts` into it.

Rotating `TOKEN_ENC_KEY` makes existing subscriptions undeliverable (their stored secrets can no longer be decrypted); they would need to re-register.

## Develop

```sh
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply visa-bulletin-push --local
npm run dev
npm test          # vitest inside workerd via @cloudflare/vitest-pool-workers
npm run typecheck
```

`npm run dev` and the tests run with `compatibility_date` 2026-08-15 (see `package.json` and `vitest.config.ts`) because the local workerd refuses dates newer than its own build (`ERR_FUTURE_COMPATIBILITY_DATE`); `wrangler deploy` uses the date in `wrangler.jsonc`. Drop the override once the installed wrangler supports that date.

## Free-plan budget

| Limit (Workers Free) | How this Worker stays inside it |
|---|---|
| 10 ms CPU per request / invocation | No framework; HMAC, AES-GCM and SHA-256 use native `crypto.subtle`; the page is one template string. Measured with `wrangler tail`: unchanged cron tick 3–7 ms, MCP 0–4 ms; a full PDF read (23–29 ms) happens about once a day and once per new bulletin |
| 50 external subrequests per invocation | Fan-out goes through the Queue; the consumer gets at most 10 messages per batch, so at most 10 outbound `fetch`es |
| 1,000 Cloudflare-service subrequests | Ingest enqueues with `sendBatch` in chunks of 100 |
| Queues: 10,000 operations/day, 24 h retention | About 3 operations per delivered message plus 1 per retry: roughly 3,000 deliveries per day. All retries finish within ~1.5 h |
| D1 daily row limits | One delivery row per (event, subscription); MCP and read API only read |

### Sources and access

- **Content.** The Visa Bulletin and the USCIS filing-charts page are US Government works and public domain ([17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105)); the Bureau of Consular Affairs [copyright notice](https://travel.state.gov/content/travel/en/copyright-disclaimer.html) says its information "may be copied and distributed without permission". This project republishes the dates with a link to the official source, and says it is unofficial.
- **Hosts.** The Worker reads only public pages that need no login: the bulletin PDF and HTML on `adoptions.state.gov` (`adoption.state.gov` only if that fails), and the USCIS filing-charts page. `travel.state.gov` answers automated clients with a Cloudflare challenge, so the Worker never contacts it and reads the same official files from `adoptions.state.gov`, which serves them openly. It never solves or spoofs a challenge or CAPTCHA, and never changes its identity or address to get past a block.
- **robots.txt** (checked 2026-10-04): `adoptions.state.gov` has none (404). `www.uscis.gov` allows the filing-charts path with `Crawl-delay: 10`; the Worker asks at most every 15 minutes while the chart is unknown, every 6 hours after.
- **Load.** One `HEAD` every 3 minutes from the 5th of the month until the next bulletin appears, hourly otherwise; the PDF is downloaded when its size changes and once a day. Every request names the project in its `User-Agent`, with the deployment's URL when `PUBLIC_URL` is set.
- If a source asks us to stop or changes its terms, the poller is turned off and the operator publishes through `POST /v1/ingest` instead.

## Privacy

Stored per subscription: URL, event list, signing secret and optional bearer token (both AES-GCM encrypted with `TOKEN_ENC_KEY`), SHA-256 of the manage token, SHA-256 of the client IP with a salt, delivery counters. No emails, names or priority dates. MCP calls store nothing. Tokens and secrets are never logged.

## 中文说明

美国国务院签证排期（Visa Bulletin）中国大陆出生、印度职业移民 EB-1、EB-2、EB-3 的非官方整理。表A = 最终行动日期（Final Action Dates），表B = 递交申请日期（Dates for Filing）；同时给出 USCIS 本月职业移民 I-485 用哪张表。

- 网页：`/`
- JSON：`/v1/latest.json`、`/v1/bulletins.json`、`/v1/bulletins/YYYY-MM.json`
- Atom 订阅：`/feed.atom`
- Webhook：`POST /v1/webhooks`，先发签名的 `ping`，对方返回 2xx 才创建订阅；事件有新排期发布、排期更正、USCIS 公布用哪张表
- 测试推送：`POST /v1/webhooks/{id}/test` 立刻发一条带当前排期的 `test` 事件；ChatGPT 订阅后约 30 秒自动收到一条以 `TEST` 开头的测试事件
- MCP：`/mcp`，工具 `get_latest_dates`、`get_bulletin`、`check_priority_date`（输入优先日，判断表A/表B 是否排到、本月能否递交 I-485），不保存任何输入

非官方整理，非法律意见，以美国国务院与 USCIS 原文为准。

数据来源：签证公告和 USCIS 页面是美国政府作品，属于公有领域。Worker 只读不需要登录的公开页面（`adoptions.state.gov` 上的官方 PDF 和网页、USCIS 页面），`travel.state.gov` 对自动访问弹 Cloudflare 验证，所以 Worker 不访问它，改从 `adoptions.state.gov` 读同一份官方文件（那里公开提供）；从不破解或伪造验证码和人机验证，也不换身份、换地址去绕开封锁；请求频率见上文 Sources and access。

## License

MIT
