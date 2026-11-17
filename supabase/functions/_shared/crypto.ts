// Webhook signature checks (Web Crypto only; runs in Deno and Node >= 20).

const enc = new TextEncoder();

async function hmac(algo: "SHA-1" | "SHA-256", secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: algo }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Twilio: base64(HMAC-SHA1(authToken, url + each POST key+value, keys sorted)). */
export async function twilioSignature(authToken: string, url: string, params: URLSearchParams): Promise<string> {
  let data = url;
  const keys = [...new Set([...params.keys()])].sort();
  for (const k of keys) for (const v of params.getAll(k).sort()) data += k + v;
  return toBase64(await hmac("SHA-1", authToken, data));
}

export async function validTwilioSignature(
  authToken: string | undefined, url: string, params: URLSearchParams, header: string | null,
): Promise<boolean> {
  if (!authToken || !header) return false;
  return safeEqual(await twilioSignature(authToken, url, params), header);
}

/** Cal.com: hex(HMAC-SHA256(secret, rawBody)) in X-Cal-Signature-256. */
export async function calSignature(secret: string, rawBody: string): Promise<string> {
  return toHex(await hmac("SHA-256", secret, rawBody));
}

export async function validCalSignature(secret: string | undefined, rawBody: string, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  const got = header.trim().toLowerCase().replace(/^sha256=/, "");
  return safeEqual(await calSignature(secret, rawBody), got);
}
