export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

export const PUBLIC_CACHE = "public, max-age=60";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function publicJson(data: unknown, status = 200): Response {
  return json(data, status, { ...CORS_HEADERS, "cache-control": PUBLIC_CACHE });
}

export function errorJson(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

/** Read a request body as text, refusing anything larger than `limit` bytes. */
export async function readBodyLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
