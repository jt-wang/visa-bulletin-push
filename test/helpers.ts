import { env, exports } from "cloudflare:workers";

/** October 2026 snapshot, values from the design spec (Visa Bulletin for October 2026). */
export function octoberSnapshot(): any {
  return {
    schema: "visa-bulletin-push/v1",
    bulletin: "2026-10",
    dates: {
      CN: {
        EB1: { A: "2023-07-01", B: "2024-07-01" },
        EB2: { A: "2021-10-01", B: "2023-01-01" },
        EB3: { A: "2022-01-08", B: "2024-04-01" },
      },
      IN: {
        EB1: { A: "2023-02-01", B: "2024-07-01" },
        EB2: { A: "2013-11-01", B: "2015-01-15" },
        EB3: { A: "2014-01-01", B: "2015-01-15" },
      },
    },
    raw: { CN: { EB1: { A: "01JUL23", B: "01JUL24" } } },
    uscis: {
      bulletin: "2026-10",
      employment_chart: "B",
      source_url:
        "https://www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-priority-dates/adjustment-of-status-filing-charts-from-the-visa-bulletin",
    },
    source: {
      pdf_url: "https://travel.state.gov/content/dam/visas/Bulletins/visabulletin_October2026.pdf",
      pdf_last_modified: "2026-09-29T11:47:04Z",
    },
    observed_at: "2026-10-04T02:00:00Z",
  };
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ingest(
  body: unknown,
  opts: { secret?: string; timestamp?: number; signature?: string; raw?: string } = {},
): Promise<Response> {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = opts.signature ?? "sha256=" + (await hmacHex(opts.secret ?? env.INGEST_SECRET, `${ts}.${raw}`));
  return exports.default.fetch("https://vb.example/v1/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vb-timestamp": ts, "x-vb-signature": sig },
    body: raw,
  });
}

export async function insertSubscription(
  id: string,
  opts: { events?: string[]; status?: string; consecutive_failures?: number; url?: string } = {},
): Promise<void> {
  const { encryptString } = await import("../src/crypto");
  const secretEnc = await encryptString(env.TOKEN_ENC_KEY, `whsec_${id}`);
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, url, events, signing_secret_enc, bearer_token_enc, manage_token_sha256, ip_hash, status, consecutive_failures, created_at)
     VALUES (?, ?, ?, ?, NULL, 'x', 'iphash', ?, ?, '2026-10-01T00:00:00Z')`,
  )
    .bind(
      id,
      opts.url ?? `https://hooks.example.com/${id}`,
      JSON.stringify(opts.events ?? ["bulletin.published", "bulletin.updated", "uscis.chart_decided"]),
      secretEnc,
      opts.status ?? "active",
      opts.consecutive_failures ?? 0,
    )
    .run();
}

export async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Parse a Streamable-HTTP MCP response (JSON or a single SSE `data:` message). */
export async function readMcp(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line!.slice(5));
  }
  return JSON.parse(text);
}
