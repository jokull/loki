// All server-side logic for loftur-web. Every function here is a TanStack Start
// server function (createServerFn) — guaranteed server-only, so it's the only
// place that touches `cloudflare:workers` env + the shared control-plane helpers.
// Route loaders/components call these over RPC; they never import env directly.

import { createServerFn } from "@tanstack/react-start";
import { getRequest, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { env as cfEnv } from "cloudflare:workers";
import type { DataEnv, Site } from "shared/data";
import {
  getSitesByEmail,
  getSiteById,
  rotateOwnerKey,
  createSite,
  createSiteToken,
  listSiteTokens,
  revokeSiteToken,
  setSecret,
  listSecretNames,
  deleteSecret,
  validateSecretName,
} from "shared/data";
import type { AccountEnv } from "shared/account";
import {
  ACCOUNT_COOKIE,
  ACCOUNT_MAXAGE_SEC,
  requestAccountMagicLink,
  resolveAccount,
  verifyAccountMagic,
  signAccountSessionToken,
  normalizeEmail,
  safeAccountRedirect,
} from "shared/account";

const env = cfEnv as unknown as DataEnv & AccountEnv;

/** Coerce untrusted RPC input to a string; non-strings (incl. objects) → "". */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function cookieHeader(): string | null {
  return getRequest().headers.get("cookie");
}
function origin(): string {
  return new URL(getRequest().url).origin;
}

const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  path: "/",
  sameSite: "lax",
  maxAge: ACCOUNT_MAXAGE_SEC,
} as const;

/** Resolve the signed-in account or throw a redirect to /login. */
async function requireAccount(): Promise<{ email: string }> {
  const account = await resolveAccount(env, cookieHeader());
  if (!account) throw redirect({ to: "/login" });
  return account;
}

/** Require that the signed-in account owns `siteId`; return the site. */
async function requireOwnedSite(siteId: string): Promise<Site> {
  const account = await requireAccount();
  const site = await getSiteById(env, siteId);
  if (!site || (site.email ?? "").toLowerCase() !== account.email.toLowerCase()) {
    throw new Error("Not found or not yours.");
  }
  return site;
}

// ---- auth -------------------------------------------------------------------

export const loginFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const email = (input as { email?: unknown })?.email;
    return { email: typeof email === "string" ? email : "" };
  })
  .handler(async ({ data }) => {
    const r = await requestAccountMagicLink(env, origin(), data.email, "/dashboard");
    return { ok: r.ok, sent: r.sent, error: r.error, devLink: r.devLink };
  });

export const verifyFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const token = (input as { token?: unknown })?.token;
    return { token: typeof token === "string" ? token : "" };
  })
  .handler(async ({ data }) => {
    const payload = await verifyAccountMagic(env, data.token);
    if (!payload?.email) return { ok: false as const };
    const token = await signAccountSessionToken(env, payload.email);
    setCookie(ACCOUNT_COOKIE, token, COOKIE_OPTS);
    return { ok: true as const, redirectTo: safeAccountRedirect(payload.redirectTo) };
  });

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(ACCOUNT_COOKIE, { path: "/" });
  return { ok: true };
});

export const currentAccountFn = createServerFn().handler(async () => {
  return resolveAccount(env, cookieHeader());
});

// ---- sites ------------------------------------------------------------------

export const mySitesFn = createServerFn().handler(async () => {
  const account = await requireAccount();
  const sites = await getSitesByEmail(env, account.email);
  // Never leak the key hash to the client.
  return {
    email: account.email,
    sites: sites.map((s) => ({
      id: s.id,
      subdomain: s.subdomain,
      created_at: s.created_at,
    })),
  };
});

export const claimSiteFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    subdomain: str((input as { subdomain?: unknown })?.subdomain),
  }))
  .handler(async ({ data }) => {
    const account = await requireAccount();
    const result = await createSite(env, data.subdomain, account.email);
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      subdomain: result.site.subdomain,
      siteId: result.site.id,
      apiKey: result.apiKey,
    };
  });

export const rotateKeyFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    siteId: str((input as { siteId?: unknown })?.siteId),
  }))
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    const apiKey = await rotateOwnerKey(env, data.siteId);
    if (!apiKey) return { ok: false as const, error: "Site not found." };
    return { ok: true as const, apiKey };
  });

// ---- editor tokens ----------------------------------------------------------

export const listTokensFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    siteId: str((input as { siteId?: unknown })?.siteId),
  }))
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    return { tokens: await listSiteTokens(env, data.siteId) };
  });

export const mintTokenFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const i = input as { siteId?: unknown; label?: unknown };
    return { siteId: str(i?.siteId), label: str(i?.label) || null };
  })
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    const { id, token } = await createSiteToken(env, data.siteId, data.label, "editor");
    return { id, token };
  });

export const revokeTokenFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const i = input as { siteId?: unknown; id?: unknown };
    return { siteId: str(i?.siteId), id: str(i?.id) };
  })
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    return { ok: await revokeSiteToken(env, data.siteId, data.id) };
  });

// ---- secrets ----------------------------------------------------------------

export const listSecretsFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    siteId: str((input as { siteId?: unknown })?.siteId),
  }))
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    return { secrets: await listSecretNames(env, data.siteId) };
  });

export const setSecretFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const i = input as { siteId?: unknown; name?: unknown; value?: unknown };
    return { siteId: str(i?.siteId), name: str(i?.name), value: str(i?.value) };
  })
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    const nameErr = validateSecretName(data.name);
    if (nameErr) return { ok: false as const, error: nameErr };
    if (!data.value) return { ok: false as const, error: "Value is required." };
    await setSecret(env, data.siteId, data.name, data.value);
    return { ok: true as const };
  });

export const deleteSecretFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const i = input as { siteId?: unknown; name?: unknown };
    return { siteId: str(i?.siteId), name: str(i?.name) };
  })
  .handler(async ({ data }) => {
    await requireOwnedSite(data.siteId);
    return { ok: await deleteSecret(env, data.siteId, data.name) };
  });

export { normalizeEmail };
