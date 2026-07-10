// Shared WebCrypto primitives for the per-tenant secret store and passwordless
// auth. Everything is derived from ONE worker secret (SECRETS_KEY) via HKDF with
// a purpose+siteId label, so:
//   - each site gets an isolated encryption key and isolated signing keys;
//   - rotating SECRETS_KEY rotates everything;
//   - the raw master secret never leaves the supervisor (site isolates only ever
//     see the narrow SECRETS / AUTH capability stubs, never the key material).
//
// These run supervisor-side (MCP tools, capability entrypoints, `/__auth/*`
// routes). The site isolate never imports this module.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Master key material is missing — a hard misconfiguration, surfaced loudly. */
function requireMaster(master: string | undefined): string {
  if (!master) {
    throw new Error(
      "SECRETS_KEY is not configured. Run `wrangler secret put SECRETS_KEY` " +
        "(a long random string) — the per-site secret store and auth signing " +
        "keys derive from it.",
    );
  }
  return master;
}

/** HKDF-SHA256 raw bytes from the master secret, bound to a purpose+site label. */
async function hkdf(master: string, info: string, bytes = 32): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey("raw", enc.encode(master), "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("loftur:v1"),
      info: enc.encode(info),
    },
    material,
    bytes * 8,
  );
}

/** Per-site AES-GCM key for the secret store. */
async function aesKey(master: string, siteId: string): Promise<CryptoKey> {
  const raw = await hkdf(requireMaster(master), `secrets:${siteId}`);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Per-site, per-purpose HMAC key (session cookies, magic-link tokens). */
async function hmacKey(master: string, purpose: string, siteId: string): Promise<CryptoKey> {
  const raw = await hkdf(requireMaster(master), `${purpose}:${siteId}`);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

// ---- base64url (no padding) -------------------------------------------------

export function b64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---- secret encryption (AES-GCM) --------------------------------------------

export interface SealedSecret {
  iv: string;
  ciphertext: string;
}

/** Encrypt a plaintext secret value for a site. */
export async function sealSecret(
  master: string | undefined,
  siteId: string,
  plaintext: string,
): Promise<SealedSecret> {
  const key = await aesKey(requireMaster(master), siteId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { iv: b64urlEncode(iv), ciphertext: b64urlEncode(ct) };
}

/** Decrypt a sealed secret. Throws if the key/ciphertext don't match. */
export async function openSecret(
  master: string | undefined,
  siteId: string,
  sealed: SealedSecret,
): Promise<string> {
  const key = await aesKey(requireMaster(master), siteId);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(sealed.iv) },
    key,
    b64urlDecode(sealed.ciphertext),
  );
  return dec.decode(pt);
}

// ---- signed tokens (HMAC): session cookies + magic links --------------------

/**
 * Sign a JSON payload into a compact `<body>.<sig>` token, HMAC'd with the
 * site+purpose key. `purpose` namespaces the key so a session token can never be
 * replayed as a magic-link token (and vice versa).
 */
export async function signToken(
  master: string | undefined,
  siteId: string,
  purpose: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const key = await hmacKey(requireMaster(master), purpose, siteId);
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

/**
 * Verify a signed token and return its payload, or null if the signature is bad
 * or the token has an `exp` in the past. Constant-time via crypto.subtle.verify.
 */
export async function verifyToken<T = Record<string, unknown>>(
  master: string | undefined,
  siteId: string,
  purpose: string,
  token: string,
): Promise<T | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let ok: boolean;
  try {
    const key = await hmacKey(requireMaster(master), purpose, siteId);
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: any;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (typeof payload?.exp === "number" && Date.now() > payload.exp) return null;
  return payload as T;
}
