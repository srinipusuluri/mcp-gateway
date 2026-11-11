/** WebCrypto helpers (work in Workers and Node >= 20). */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(prefix = "id", bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}_${toBase64Url(b)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toBase64Url(new Uint8Array(digest));
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64Url(base64Key);
  if (raw.length !== 32) throw new Error("Encryption key must be 32 bytes (base64url). Generate: openssl rand -base64 32");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Normalise standard base64 (openssl) to base64url so either form is accepted. */
function normalizeKey(k: string): string {
  return k.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** AES-256-GCM encrypt a JSON value. Output: base64url(iv || ciphertext). */
export async function encryptJson(value: unknown, base64Key: string): Promise<string> {
  const key = await importKey(normalizeKey(base64Key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

export async function decryptJson<T = unknown>(blob: string, base64Key: string): Promise<T> {
  const key = await importKey(normalizeKey(base64Key));
  const raw = fromBase64Url(blob);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(dec.decode(pt)) as T;
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
