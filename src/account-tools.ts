// Account-level MCP tools. These are exposed ONLY when the /mcp bearer is an
// account PAT (lftr_pat_…). A PAT authenticates as an account (email), so these
// tools operate across ALL of that account's sites: claim new subdomains, list
// sites, rotate keys, mint editor tokens. Combined with the per-site build tools
// (re-exposed with a `site` selector in mcp.ts), one PAT lets an agent both spin
// up and build sites — the "developer's hands" model.

import { z } from "zod";
import type { Env } from "./env";
import {
  createSite,
  getSitesByEmail,
  getSiteById,
  getSiteBySubdomain,
  rotateOwnerKey,
  createSiteToken,
  getAccountQuota,
  accountSlotSites,
  recordQuotaRequest,
  deleteSite,
  restoreSite,
  unpublishSite,
  republishSite,
  deletedAgeMs,
  RECOVERY_WINDOW_DAYS,
  PURGE_LOCK_HOURS,
  type Site,
} from "shared/data";
import { purgeSite } from "./lifecycle";

const APEX = "loftur.app";
const siteUrl = (s: string) => `https://${s}.${APEX}`;
const mcpUrl = (s: string) => `https://${s}.${APEX}/mcp`;
/** Coerce untrusted tool input to a string; non-strings (incl. objects) → "". */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type AccountToolCtx = { env: Env; email: string };

export interface AccountTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    ctx: AccountToolCtx,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Resolve a `site` reference (subdomain OR id) to a site owned by this account. */
export async function resolveOwnedSite(
  env: Env,
  email: string,
  ref: string,
): Promise<{ site: Site } | { error: string }> {
  const r = (ref || "").trim().toLowerCase();
  if (!r) return { error: "Missing `site` — pass a subdomain or id (see list_sites)." };
  const site = (await getSiteBySubdomain(env, r)) ?? (await getSiteById(env, ref));
  if (!site) return { error: `No site "${ref}" found in your account.` };
  if ((site.email ?? "").trim().toLowerCase() !== email.trim().toLowerCase()) {
    return { error: `Site "${ref}" is not owned by your account.` };
  }
  return { site };
}

export const ACCOUNT_TOOLS: AccountTool[] = [
  {
    name: "whoami",
    description:
      "Show the signed-in account (email) and its sites. Call this first to orient: it returns every {subdomain}.loftur.app you own and how to address them in the build tools (via the `site` argument).",
    inputSchema: {},
    handler: async (_args, { env, email }) => {
      const sites = await getSitesByEmail(env, email);
      const quota = await getAccountQuota(env, email);
      const slots = await accountSlotSites(env, email);
      return ok({
        email,
        quota: quota === -1 ? "unlimited" : quota,
        sitesUsed: slots.length,
        sites: sites.map((s) => ({
          subdomain: s.subdomain,
          url: siteUrl(s.subdomain),
          id: s.id,
          status: s.status,
        })),
        howToBuild:
          'Pass `site: "<subdomain>"` to any build tool (site_write, preview_site, publish_site, graphql_query, …). Use claim_site to make a new one. Lifecycle: delete_site/restore_site, unpublish_site/republish_site.',
      });
    },
  },
  {
    name: "list_sites",
    description: "List all sites in this account (newest first) with their lifecycle status.",
    inputSchema: {},
    handler: async (_args, { env, email }) => {
      const sites = await getSitesByEmail(env, email);
      return ok(
        sites.map((s) => ({
          subdomain: s.subdomain,
          url: siteUrl(s.subdomain),
          id: s.id,
          status: s.status,
          createdAt: s.created_at,
        })),
      );
    },
  },
  {
    name: "claim_site",
    description:
      'Claim a new {subdomain}.loftur.app under this account and provision its backend. Returns the live URL plus the site\'s one-time OWNER key. After claiming, build it immediately by passing `site: "<subdomain>"` to the build tools — no reconnect needed.',
    inputSchema: {
      subdomain: z
        .string()
        .describe(
          'The subdomain to claim, e.g. "hermes" → hermes.loftur.app (lowercase, a–z0–9-).',
        ),
    },
    handler: async (args, { env, email }) => {
      const subdomain = str(args.subdomain).trim().toLowerCase();

      // If the name is held by THIS account's own deleted site, guide to restore/purge.
      const held = await getSiteBySubdomain(env, subdomain);
      if (
        held &&
        held.status === "deleted" &&
        (held.email ?? "").toLowerCase() === email.toLowerCase()
      ) {
        return err(
          `"${subdomain}" is your own deleted site (recoverable). restore_site({ site: "${subdomain}" }) to bring it back, or purge_site to free the name.`,
        );
      }

      // Free-site quota (per normalized email). -1 = unlimited.
      const quota = await getAccountQuota(env, email);
      if (quota !== -1) {
        const slots = await accountSlotSites(env, email);
        if (slots.length >= quota) {
          await recordQuotaRequest(env, email, subdomain);
          const deleted = slots.filter((x) => x.status === "deleted");
          const hint = deleted.length
            ? " Free a slot now by purging a deleted site: " +
              deleted
                .map((x) => {
                  const reap = x.deleted_at
                    ? new Date(new Date(x.deleted_at).getTime() + RECOVERY_WINDOW_DAYS * 86400000)
                        .toISOString()
                        .slice(0, 10)
                    : "?";
                  return `${x.subdomain} (reaps ${reap})`;
                })
                .join(", ") +
              "."
            : "";
          return err(
            `You've used all ${quota} of your free {sub}.loftur.app sites.${hint} Want more? Reply to the Loftur team to raise your limit.`,
          );
        }
      }

      const result = await createSite(env, subdomain, email);
      if (!result.ok) return err(result.error);
      const s = result.site;
      return ok({
        ok: true,
        subdomain: s.subdomain,
        url: siteUrl(s.subdomain),
        ownerKey: result.apiKey,
        ownerKeyNote:
          "Shown once. Store it if you want to connect a dedicated per-site MCP later; for building now, just use `site` on this connection.",
        mcpUrl: mcpUrl(s.subdomain),
        nextStep: `Build it: site_write({ site: "${s.subdomain}", path: "routes/index.tsx", source: "…" }), then preview_site({ site: "${s.subdomain}" }) and publish_site({ site: "${s.subdomain}", message: "v1" }). Call site_help for the full authoring guide.`,
      });
    },
  },
  {
    name: "rotate_site_key",
    description:
      "Rotate (regenerate) a site's owner key. The old key stops working immediately. Use for recovery or to provision a dedicated per-site MCP token.",
    inputSchema: {
      site: z.string().describe("Subdomain or id of the site (see list_sites)."),
    },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const key = await rotateOwnerKey(env, found.site.id);
      if (!key) return err("Could not rotate the key — site not found.");
      return ok({
        subdomain: found.site.subdomain,
        ownerKey: key,
        mcpUrl: mcpUrl(found.site.subdomain),
      });
    },
  },
  {
    name: "mint_editor_token",
    description:
      "Mint a scoped EDITOR token for a site — content + image tools only, no schema or code. Hand it to a content editor so they connect their own MCP client. Returns the token once.",
    inputSchema: {
      site: z.string().describe("Subdomain or id of the site (see list_sites)."),
      label: z.string().optional().describe("Optional label, e.g. the editor's name."),
    },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const label = typeof args.label === "string" ? args.label : null;
      const { token } = await createSiteToken(env, found.site.id, label, "editor");
      return ok({
        subdomain: found.site.subdomain,
        editorToken: token,
        role: "editor",
        mcpUrl: mcpUrl(found.site.subdomain),
      });
    },
  },
  {
    name: "delete_site",
    description:
      "Delete a site: take it offline and archive it, RECOVERABLE by you for 7 days (restore_site), after which it's permanently reaped. The subdomain stays reserved to you during the window. Safe default — reversible, no confirmation needed.",
    inputSchema: { site: z.string().describe("Subdomain or id of the site to delete.") },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const r = await deleteSite(env, found.site);
      if (!r.ok) return err(r.error);
      const reap = new Date(Date.now() + RECOVERY_WINDOW_DAYS * 86400000)
        .toISOString()
        .slice(0, 10);
      return ok({
        subdomain: found.site.subdomain,
        status: "deleted",
        recoverableUntil: reap,
        note: `Offline and archived. restore_site({ site: "${found.site.subdomain}" }) any time before ${reap} brings it back byte-for-byte (including end-user logins). purge_site frees the name now (allowed 24h after delete).`,
      });
    },
  },
  {
    name: "restore_site",
    description:
      "Restore a deleted site within its 7-day recovery window — back to active, byte-for-byte (content, feature DB, end-user logins).",
    inputSchema: { site: z.string().describe("Subdomain or id of the deleted site.") },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const r = await restoreSite(env, found.site);
      if (!r.ok) return err(r.error);
      return ok({
        subdomain: found.site.subdomain,
        status: "active",
        url: siteUrl(found.site.subdomain),
      });
    },
  },
  {
    name: "unpublish_site",
    description:
      "Take a live site OFFLINE indefinitely (a pause) without deleting — data stays intact, no recovery countdown. republish_site brings it back. Use this to pause a site rather than delete it.",
    inputSchema: { site: z.string().describe("Subdomain or id of the site to pause.") },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const r = await unpublishSite(env, found.site);
      if (!r.ok) return err(r.error);
      return ok({
        subdomain: found.site.subdomain,
        status: "unpublished",
        note: "Offline (visitors see a 503). Data intact. republish_site to resume.",
      });
    },
  },
  {
    name: "republish_site",
    description: "Resume a paused (unpublished) site — back online.",
    inputSchema: { site: z.string().describe("Subdomain or id of the unpublished site.") },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const r = await republishSite(env, found.site);
      if (!r.ok) return err(r.error);
      return ok({
        subdomain: found.site.subdomain,
        status: "active",
        url: siteUrl(found.site.subdomain),
      });
    },
  },
  {
    name: "purge_site",
    description:
      "PERMANENTLY destroy a deleted site NOW and free its subdomain — IRREVERSIBLE (content, feature DB, end-user logins, uploads all gone). Only works on a site you've already deleted (status=deleted) that's been deleted for 24h+ — a guaranteed recovery window even a leaked token can't skip. Otherwise just let it reap after 7 days.",
    inputSchema: { site: z.string().describe("Subdomain or id of a deleted site.") },
    handler: async (args, { env, email }) => {
      const found = await resolveOwnedSite(env, email, str(args.site));
      if ("error" in found) return err(found.error);
      const site = found.site;
      if (site.status !== "deleted") {
        return err(
          `purge_site only works on a DELETED site (status: "${site.status}"). delete_site first — it stays recoverable for 7 days.`,
        );
      }
      const ageMs = deletedAgeMs(site) ?? 0;
      const lockMs = PURGE_LOCK_HOURS * 3600000;
      if (ageMs < lockMs && site.deleted_at) {
        const unlock = new Date(new Date(site.deleted_at).getTime() + lockMs).toISOString();
        return err(
          `Purge is time-locked for ${PURGE_LOCK_HOURS}h after delete (a recovery window even a leaked token can't skip). "${site.subdomain}" can be purged after ${unlock}, or it reaps automatically at 7 days. restore_site to keep it.`,
        );
      }
      await purgeSite(env, site.id);
      return ok({
        subdomain: site.subdomain,
        purged: true,
        note: `Permanently deleted. "${site.subdomain}.loftur.app" is now free to claim again.`,
      });
    },
  },
];

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));
