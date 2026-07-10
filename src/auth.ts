// Passwordless (magic-link) end-user auth for tenant sites.
//
// Design (locked): STATELESS signed cookies. A session is a compact HMAC token
// (see crypto.signToken) in the HttpOnly `loki_session` cookie — no per-request
// DB read. The HMAC key is per-site and lives ONLY in the supervisor (derived
// from SECRETS_KEY), so the site isolate can never mint or forge a session; it
// only ever receives the already-verified `user` via a trusted request header
// the supervisor injects (see serve.ts). Users are recorded in the tenant's
// feature DB (`_auth_users`) so a site can list members / attach profile rows,
// but the session itself needs no lookup.
//
// Flow:
//   1. site login form -> serverFn -> env.AUTH.requestMagicLink(email, redirectTo)
//   2. supervisor signs a short-lived magic token, emails a {origin}/__auth/verify
//      link via Cloudflare Email Service (env.EMAIL)
//   3. user clicks -> supervisor verifies the token, upserts the user, sets the
//      session cookie, redirects to redirectTo
//   4. every later request: supervisor verifies the cookie and injects
//      `x-loki-user` so loaders/serverFns see `user`

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { signToken, verifyToken } from "shared/crypto";
import { siteOrigin, getSiteById, DEFAULT_SITE_ID } from "./tenants";

export const SESSION_COOKIE = "loki_session";
const MAGIC_TTL_MS = 15 * 60 * 1000; // magic links expire fast
const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const FALLBACK_ORIGIN = "https://loftur.app";
const FROM_ADDRESS = "login@loftur.app"; // loftur.app is onboarded for Email Sending

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

interface SessionPayload {
  sub: string;
  email: string;
  role: string;
  exp: number;
}
interface MagicPayload {
  email: string;
  redirectTo: string;
  exp: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

/** Keep redirects same-origin (path-only) to avoid an open-redirect. */
function safeRedirect(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// ---- session cookie ---------------------------------------------------------

async function mintSessionCookie(env: Env, siteId: string, user: AuthUser): Promise<string> {
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Date.now() + SESSION_TTL_SEC * 1000,
  };
  const token = await signToken(
    env.SECRETS_KEY,
    siteId,
    "session",
    payload as unknown as Record<string, unknown>,
  );
  return (
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; Path=/; ` +
    `SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`
  );
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

/**
 * Resolve the signed-in user from the request's session cookie, or null. Called
 * supervisor-side per request; the result is injected into the isolate as a
 * trusted header (see serve.ts) so site code never verifies signatures itself.
 */
export async function resolveUser(
  env: Env,
  siteId: string,
  request: Request,
): Promise<AuthUser | null> {
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  const payload = await verifyToken<SessionPayload>(env.SECRETS_KEY, siteId, "session", cookie);
  if (!payload?.sub || !payload.email) return null;
  return { id: payload.sub, email: payload.email, role: payload.role ?? "member" };
}

// ---- magic links ------------------------------------------------------------

async function siteHost(env: Env, siteId: string): Promise<string> {
  if (siteId === DEFAULT_SITE_ID) return "loftur.app";
  const site = await getSiteById(env, siteId);
  return site ? `${site.subdomain}.loftur.app` : "loftur.app";
}

/** Sign a magic-link token and build the absolute verify URL for a site. */
export async function buildMagicLink(
  env: Env,
  siteId: string,
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
    siteId,
    "magic",
    payload as unknown as Record<string, unknown>,
  );
  const origin = await siteOrigin(env, siteId, FALLBACK_ORIGIN);
  return `${origin}/__auth/verify?token=${encodeURIComponent(token)}`;
}

async function sendMagicEmail(env: Env, host: string, to: string, link: string): Promise<boolean> {
  if (!env.EMAIL) return false;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:28rem;margin:0 auto;padding:24px;color:#12161d">` +
    `<h1 style="font-size:1.25rem;margin:0 0 8px">Sign in to ${host}</h1>` +
    `<p style="color:#4a5261;margin:0 0 20px">Click the button below to sign in. This link expires in 15 minutes.</p>` +
    `<p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#cf551d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Sign in</a></p>` +
    `<p style="color:#7e8896;font-size:.85rem;margin:0">If you didn't request this, you can ignore this email.</p>` +
    `</div>`;
  const text =
    `Sign in to ${host}\n\nOpen this link to sign in (expires in 15 minutes):\n${link}\n\n` +
    `If you didn't request this, ignore this email.`;
  await env.EMAIL.send({
    to,
    from: { email: FROM_ADDRESS, name: host },
    subject: `Sign in to ${host}`,
    html,
    text,
  });
  return true;
}

export interface RequestMagicLinkResult {
  ok: boolean;
  sent: boolean;
  error?: string;
  /** Present only in development (env.ENVIRONMENT !== "production"). */
  devLink?: string;
}

/**
 * Core magic-link issuance, shared by the AUTH capability and the admin test
 * route. Validates the email, signs a link, and emails it. Returns `sent:false`
 * (not an error) when EMAIL is unconfigured, so local/dev works via `devLink`.
 */
export async function issueMagicLink(
  env: Env,
  siteId: string,
  emailRaw: unknown,
  redirectToRaw: unknown,
): Promise<RequestMagicLinkResult> {
  const email = normalizeEmail(emailRaw);
  if (!email) return { ok: false, sent: false, error: "Enter a valid email address." };
  const host = await siteHost(env, siteId);
  const link = await buildMagicLink(env, siteId, email, safeRedirect(redirectToRaw));
  let sent = false;
  try {
    sent = await sendMagicEmail(env, host, email, link);
  } catch (err) {
    console.error(`[auth ${siteId}] email send failed:`, err);
    return {
      ok: false,
      sent: false,
      error: "Could not send the sign-in email. Try again shortly.",
    };
  }
  const dev = env.ENVIRONMENT !== "production";
  return { ok: true, sent, devLink: dev || !sent ? link : undefined };
}

// ---- supervisor routes: /__auth/verify, /__auth/logout ----------------------

function htmlError(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Sign-in</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#12161d">` +
      `<h1 style="font-size:1.25rem">Sign-in link problem</h1><p style="color:#4a5261">${message}</p>` +
      `<p><a href="/" style="color:#cf551d">Back to the site →</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Handle `/__auth/*` (supervisor-side, before the isolate). Returns null for any
 * other path so serveSite falls through to normal serving.
 */
export async function handleAuthRoute(
  env: Env,
  request: Request,
  siteId: string,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/__auth/verify") {
    const token = url.searchParams.get("token") ?? "";
    const payload = await verifyToken<MagicPayload>(env.SECRETS_KEY, siteId, "magic", token);
    if (!payload?.email) {
      return htmlError("This sign-in link is invalid or has expired. Request a new one.", 403);
    }
    const user = await upsertUser(env, siteId, payload.email);
    const cookie = await mintSessionCookie(env, siteId, user);
    const headers = new Headers({ Location: safeRedirect(payload.redirectTo) });
    headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === "/__auth/logout") {
    const headers = new Headers({
      Location: safeRedirect(url.searchParams.get("redirect")),
    });
    headers.append("Set-Cookie", clearSessionCookie());
    return new Response(null, { status: 302, headers });
  }

  return null;
}

/** Upsert an email into the tenant's feature DB `_auth_users`, returning the id. */
async function upsertUser(env: Env, siteId: string, email: string): Promise<AuthUser> {
  const id = crypto.randomUUID();
  const stub = env.TENANT_FEATURE_DB.get(env.TENANT_FEATURE_DB.idFromName(siteId));
  const { id: resolvedId, role } = await stub.authUpsertUser(email, id);
  return { id: resolvedId, email, role };
}

// ---- capability handed to the site isolate as env.AUTH ----------------------

export class AuthEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  /**
   * Email the caller a magic sign-in link. `redirectTo` is where the user lands
   * after clicking (same-origin path; defaults to "/"). Returns { ok, sent }.
   */
  async requestMagicLink(email: string, redirectTo?: string): Promise<RequestMagicLinkResult> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    return issueMagicLink(this.env, siteId, email, redirectTo);
  }
}
