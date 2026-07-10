// Control-plane (ACCOUNT) passwordless auth — for Loftur site OWNERS signing in to
// the dashboard. Distinct identity space from the per-tenant end-user auth in
// loki/src/auth.ts: identity = the email that owns sites (sites.email), signed
// with a fixed `__account__` scope, carried in the `loftur_account` cookie.
// Stateless HMAC (crypto.signToken), same as the tenant model. Used by loftur-web.

import { signToken, verifyToken } from "./crypto";

export const ACCOUNT_COOKIE = "loftur_account";
const ACCOUNT_SCOPE = "__account__";
const MAGIC_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const FROM_ADDRESS = "login@loftur.app";

export interface AccountEnv {
  SECRETS_KEY?: string;
  ENVIRONMENT?: "production" | "development";
  EMAIL?: {
    send(message: {
      to: string;
      from: string | { email: string; name?: string };
      subject: string;
      html?: string;
      text?: string;
    }): Promise<{ messageId?: string }>;
  };
}

export interface Account {
  email: string;
}

interface MagicPayload {
  email: string;
  redirectTo: string;
  exp: number;
}
interface SessionPayload {
  email: string;
  exp: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

function safeRedirect(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
    ? raw
    : "/dashboard";
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// ---- session cookie ---------------------------------------------------------

export async function mintAccountCookie(env: AccountEnv, email: string): Promise<string> {
  const payload: SessionPayload = { email, exp: Date.now() + SESSION_TTL_SEC * 1000 };
  const token = await signToken(
    env.SECRETS_KEY,
    ACCOUNT_SCOPE,
    "session",
    payload as unknown as Record<string, unknown>,
  );
  return (
    `${ACCOUNT_COOKIE}=${token}; HttpOnly; Secure; Path=/; ` +
    `SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`
  );
}

export function clearAccountCookie(): string {
  return `${ACCOUNT_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

/** Cookie Max-Age (seconds) for framework `setCookie(name, value, opts)` callers. */
export const ACCOUNT_MAXAGE_SEC = SESSION_TTL_SEC;

/** Sign just the session token value (for setCookie(name, value, opts)). */
export async function signAccountSessionToken(env: AccountEnv, email: string): Promise<string> {
  const payload: SessionPayload = { email, exp: Date.now() + SESSION_TTL_SEC * 1000 };
  return signToken(
    env.SECRETS_KEY,
    ACCOUNT_SCOPE,
    "session",
    payload as unknown as Record<string, unknown>,
  );
}

/** Resolve the signed-in account from a Cookie header (or null). */
export async function resolveAccount(
  env: AccountEnv,
  cookieHeader: string | null,
): Promise<Account | null> {
  const cookie = getCookie(cookieHeader, ACCOUNT_COOKIE);
  if (!cookie) return null;
  const payload = await verifyToken<SessionPayload>(
    env.SECRETS_KEY,
    ACCOUNT_SCOPE,
    "session",
    cookie,
  );
  return payload?.email ? { email: payload.email } : null;
}

// ---- magic links ------------------------------------------------------------

/** Sign an account magic token and build the absolute verify URL. */
export async function buildAccountMagicLink(
  env: AccountEnv,
  origin: string,
  email: string,
  redirectTo: string,
): Promise<string> {
  const payload: MagicPayload = {
    email,
    redirectTo: safeRedirect(redirectTo),
    exp: Date.now() + MAGIC_TTL_MS,
  };
  const token = await signToken(
    env.SECRETS_KEY,
    ACCOUNT_SCOPE,
    "magic",
    payload as unknown as Record<string, unknown>,
  );
  return `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
}

export async function verifyAccountMagic(
  env: AccountEnv,
  token: string,
): Promise<MagicPayload | null> {
  return verifyToken<MagicPayload>(env.SECRETS_KEY, ACCOUNT_SCOPE, "magic", token);
}

export interface MagicResult {
  ok: boolean;
  sent: boolean;
  error?: string;
  devLink?: string;
}

/** Issue + email an account sign-in link. `origin` is loftur-web's own origin. */
export async function requestAccountMagicLink(
  env: AccountEnv,
  origin: string,
  emailRaw: unknown,
  redirectTo?: string,
): Promise<MagicResult> {
  const email = normalizeEmail(emailRaw);
  if (!email) return { ok: false, sent: false, error: "Enter a valid email address." };
  const link = await buildAccountMagicLink(env, origin, email, safeRedirect(redirectTo));
  let sent = false;
  try {
    if (env.EMAIL) {
      const html =
        `<div style="font-family:system-ui,sans-serif;max-width:28rem;margin:0 auto;padding:24px;color:#12161d">` +
        `<h1 style="font-size:1.25rem;margin:0 0 8px">Sign in to Loftur</h1>` +
        `<p style="color:#4a5261;margin:0 0 20px">Click below to sign in to your dashboard. This link expires in 15 minutes.</p>` +
        `<p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#cf551d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Sign in to Loftur</a></p>` +
        `<p style="color:#7e8896;font-size:.85rem;margin:0">If you didn't request this, ignore this email.</p></div>`;
      await env.EMAIL.send({
        to: email,
        from: { email: FROM_ADDRESS, name: "Loftur" },
        subject: "Sign in to Loftur",
        html,
        text: `Sign in to Loftur\n\nOpen this link (expires in 15 min):\n${link}`,
      });
      sent = true;
    }
  } catch (err) {
    console.error("[account auth] email send failed:", err);
    return {
      ok: false,
      sent: false,
      error: "Could not send the sign-in email. Try again shortly.",
    };
  }
  const dev = env.ENVIRONMENT !== "production";
  return { ok: true, sent, devLink: dev || !sent ? link : undefined };
}

export { safeRedirect as safeAccountRedirect };
