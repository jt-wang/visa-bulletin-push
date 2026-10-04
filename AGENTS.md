# AGENTS.md

Instructions for coding agents (Claude Code, Codex and similar) working with this repository. What the project is and why: [README.md](README.md). Every technical detail: [docs/REFERENCE.md](docs/REFERENCE.md).

## Deploy a copy to your user's Cloudflare account

This creates resources on your user's account, so tell them what you are about to do and get a yes first. Never print secrets; pipe them straight into `wrangler secret put`.

Needs Node 20+ and a Cloudflare account (the Free plan is enough).

1. Install: `npm ci`
2. Log in: `npx wrangler login`. Your user finishes this in their browser. With `CLOUDFLARE_API_TOKEN` set, skip it.
3. Create the database and the queue:
   ```sh
   npx wrangler d1 create visa-bulletin-push
   npx wrangler queues create visa-bulletin-push-deliveries
   ```
   Put the printed `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`.
4. Set the secrets:
   ```sh
   openssl rand -hex 32    | npx wrangler secret put INGEST_SECRET
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY
   openssl rand -hex 16    | npx wrangler secret put IP_HASH_SALT
   ```
5. Deploy: `npm run deploy`. It applies the D1 migrations, then deploys, and prints the `*.workers.dev` URL.
6. Check it. The Cron Trigger runs every minute; the first run reads the current bulletin.
   - Within about 3 minutes, `curl https://<worker>/v1/status` shows `"healthy": true` and `curl https://<worker>/v1/latest.json` returns this month's bulletin.
   - `https://<worker>/` shows the dates.
   - A minute later, `https://<worker>/og/<YYYY-MM>-<A|B|x>.png` (the name is in the page's `og:image`) returns the share card.
   - If `/v1/status` stays unhealthy, run `npx wrangler tail` and read the `poll` log lines.
7. Tell your user the URL and which of the checks above passed.

Optional, all in [Deploy your own](docs/REFERENCE.md#deploy-your-own): a custom domain, `PUBLIC_URL` (identifies the deployment to the State Department and USCIS), an author section, a GitHub button (`SOURCE_URL`), and Telegram failure alerts.

## Changing the code

- Run `npm test` and `npm run typecheck`. For a behavior change, write the failing test first and watch it fail.
- The Workers Free plan allows 10 ms of CPU per request. Don't add frameworks or SDKs to request paths; measure with `npx wrangler tail` after deploying. The reference lists measured numbers.
- Tests never reach real services: mock `fetch`, and use the fixtures in `test/fixtures` (real official pages and PDFs).
- Sources: read only the hosts listed in [Sources and access](docs/REFERENCE.md#sources-and-access). Never contact `travel.state.gov`, never solve or work around a challenge or CAPTCHA, and keep the request rate where it is.
- Every failure path in the poller must send an alert or show in `/v1/status`; never fail silently.
- Store nothing new about users without updating the privacy answer on the page and the Privacy section of the reference.
- Maintainers publishing from this repository run `npm run privacy-check` before each commit (see the reference).
