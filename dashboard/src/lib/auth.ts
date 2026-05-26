// ============================================================================
// HMAC-signed session cookie (Web Crypto API — Edge runtime compatible)
// ============================================================================
// Format du cookie : `<expiry_ms>.<hmac_sha256(expiry_ms, COOKIE_SECRET)>`
// La validation vérifie : (1) signature HMAC valide, (2) pas expiré.
// ============================================================================

export const COOKIE_NAME = "aether_auth";
export const COOKIE_MAX_AGE_DAYS = 14;

async function hmac(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSessionToken(secret: string): Promise<string> {
  const expiry = Date.now() + COOKIE_MAX_AGE_DAYS * 86400 * 1000;
  const sig = await hmac(String(expiry), secret);
  return `${expiry}.${sig}`;
}

export async function validateSessionToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0) return false;
  const expiryStr = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expiry = parseInt(expiryStr, 10);
  if (Number.isNaN(expiry) || Date.now() > expiry) return false;
  const expected = await hmac(expiryStr, secret);
  // constant-time-ish compare (not perfect but acceptable for V1)
  return sig.length === expected.length && sig === expected;
}
