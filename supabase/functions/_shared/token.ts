const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(secret: string, ttlSeconds = 7200): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(enc.encode(JSON.stringify({ exp })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifyToken(secret: string, token: string): Promise<boolean> {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return false;
    const ok = await crypto.subtle.verify("HMAC", await key(secret), b64urlBytes(sig), enc.encode(payload));
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlBytes(payload)));
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}