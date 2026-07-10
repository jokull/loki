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
  type Site,
} from "shared/data";

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
      return ok({
        email,
        siteCount: sites.length,
        sites: sites.map((s) => ({ subdomain: s.subdomain, url: siteUrl(s.subdomain), id: s.id })),
        howToBuild:
          'Pass `site: "<subdomain>"` to any build tool (site_write, preview_site, publish_site, graphql_query, …). Use claim_site to make a new one.',
      });
    },
  },
  {
    name: "list_sites",
    description: "List all sites in this account, newest first.",
    inputSchema: {},
    handler: async (_args, { env, email }) => {
      const sites = await getSitesByEmail(env, email);
      return ok(
        sites.map((s) => ({
          subdomain: s.subdomain,
          url: siteUrl(s.subdomain),
          id: s.id,
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
];

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));
