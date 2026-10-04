// Small Web Crypto helpers. Everything here runs on native crypto.subtle, which keeps
// CPU time well inside the free plan's 10 ms per invocation.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** `sha256=hex(HMAC-SHA256(secret, timestamp + "." + body))` */
export async function signatureHeader(secret: string, timestamp: string, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

/** Constant-time string comparison (lengths are compared first; that leaks only the length). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

export function randomToken(prefix: string, bytes = 32): string {
  return prefix + toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(prefix: string): string {
  return prefix + toHex(crypto.getRandomValues(new Uint8Array(12)));
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyB64);
  if (raw.byteLength !== 32) throw new Error("TOKEN_ENC_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM; returns base64(iv(12) || ciphertext+tag). */
export async function encryptString(keyB64: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), enc.encode(plaintext)));
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return toBase64(out);
}

export async function decryptString(keyB64: string, payload: string): Promise<string> {
  const buf = fromBase64(payload);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf.slice(0, 12) },
    await aesKey(keyB64),
    buf.slice(12),
  );
  return dec.decode(pt);
}

/**
 * Decode a Standard Webhooks symmetric secret: `whsec_` + base64 of 24-64 random bytes.
 * Returns null for anything else. https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */
export function decodeWhsec(secret: unknown): Uint8Array | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const b64 = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch {
    return null;
  }
  return bytes.byteLength >= 24 && bytes.byteLength <= 64 ? bytes : null;
}

/**
 * Standard Webhooks `v1` signature: "v1," + base64(HMAC-SHA256(key, id + "." + timestamp + "." + body)),
 * where key is the base64-decoded bytes after `whsec_`. Checked against the reference library's
 * vector in test/mcp-events.test.ts.
 */
export async function standardWebhooksSign(secret: string, msgId: string, timestamp: string, body: string): Promise<string> {
  const raw = decodeWhsec(secret);
  if (!raw) throw new Error("invalid whsec_ secret");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${msgId}.${timestamp}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}
