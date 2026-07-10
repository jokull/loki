// Loki's merged MCP endpoint (/mcp).
//
// Stateless streamable-HTTP MCP server (same stack agent-cms uses for Code
// Mode: @modelcontextprotocol/sdk + agents/mcp createMcpHandler). It exposes
// Loki's site tools PLUS agent-cms's tools (fetched in-process). Destructive
// schema ops pass the migration guard before being forwarded.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import { callCmsTool, listCmsTools } from "./cms-bridge";
import { GUARDED_TOOLS, guardSchemaOp } from "./guard";
import { SITE_TOOLS, type SiteTool } from "./site/tools";
import { getSiteByApiKey, getSiteToken } from "./tenants";
import { DEFAULT_SITE_ID } from "./site/store";

/**
 * EDITOR role toolset: maintain CONTENT + upload images, but NO schema changes
 * and NO code. Loftur read tools (query/introspect) + agent-cms content & asset
 * tools; everything schema/code/site-config is owner-only. New tools default to
 * owner-only (allowlist, not denylist).
 */
const EDITOR_SITE_TOOLS = new Set(["graphql_query", "schema_types"]);
const EDITOR_CMS_TOOLS = new Set([
  "schema_info",
  "create_record",
  "update_record",
  "delete_record",
  "get_record",
  "query_records",
  "bulk_create_records",
  "patch_blocks",
  "remove_block",
  "set_publish_status",
  "schedule",
  "record_versions",
  "reorder_records",
  "create_asset_upload_url",
  "upload_asset",
  "import_asset_from_url",
  "list_assets",
  "replace_asset",
  "search_content",
  "get_preview_url",
  "get_site_settings",
]);
function editorAllows(name: string): boolean {
  return EDITOR_SITE_TOOLS.has(name) || EDITOR_CMS_TOOLS.has(name);
}

/** Extract the bearer token from an Authorization header (Bearer or bare). */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return (m ? m[1] : header).trim();
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized. Provide Authorization: Bearer <WRITE_KEY>." }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** Minimal Zod-shape -> JSON Schema for the (simple) site tool inputs. */
function shapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    let inner: z.ZodTypeAny = schema;
    let optional = false;
    const def = (inner as any)._def;
    if (def?.typeName === "ZodOptional") {
      optional = true;
      inner = def.innerType;
    }
    const tn = (inner as any)._def?.typeName;
    const prop: Record<string, unknown> =
      tn === "ZodNumber"
        ? { type: "number" }
        : tn === "ZodBoolean"
          ? { type: "boolean" }
          : tn === "ZodArray"
            ? { type: "array", items: {} }
            : tn === "ZodRecord" || tn === "ZodObject"
              ? { type: "object", additionalProperties: true }
              : { type: "string" };
    const description = (schema as any).description ?? (inner as any).description;
    if (description) prop.description = description;
    properties[key] = prop;
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function siteToolResultToMcp(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}) {
  return { content: result.content, isError: result.isError ?? false };
}

/**
 * Build the MCP server for a resolved site. EVERY site gets the full toolset;
 * content tools are routed to that site's CMS (default → shared agent-cms;
 * tenant → its own agent-cms in its TenantDB). The CMS tool DEFINITIONS are
 * identical across sites, so tools/list reads them from the default site's CMS
 * (avoids booting a tenant DO just to enumerate tools); calls route per-site.
 */
function buildServer(
  env: Env,
  ctx: ExecutionContext,
  siteId: string,
  role: "owner" | "editor",
): Server {
  const server = new Server({ name: "loftur", version: "0.1.0" }, { capabilities: { tools: {} } });
  const isEditor = role === "editor";

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const siteToolDefs = SITE_TOOLS.filter((t) => !isEditor || EDITOR_SITE_TOOLS.has(t.name)).map(
      (t) => ({
        name: t.name,
        description: t.description,
        inputSchema: shapeToJsonSchema(t.inputSchema) as any,
      }),
    );
    let cmsTools: any[] = [];
    try {
      const all = await listCmsTools(env, DEFAULT_SITE_ID);
      cmsTools = isEditor ? all.filter((t) => EDITOR_CMS_TOOLS.has(t.name)) : all;
    } catch (err) {
      // Surface CMS bridge failure as a pseudo-tool so tools/list still returns
      // Loki's own tools rather than 500-ing the whole endpoint.
      cmsTools = [
        {
          name: "__cms_unavailable",
          description:
            "agent-cms tool list could not be fetched: " +
            (err instanceof Error ? err.message : String(err)),
          inputSchema: { type: "object", properties: {} },
        },
      ];
    }
    return { tools: [...siteToolDefs, ...cmsTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (isEditor && !editorAllows(name)) {
      return {
        content: [
          {
            type: "text",
            text: `Tool "${name}" is not available to an editor token — editors can maintain content and upload images, but not change the schema or code. Ask the site owner.`,
          },
        ],
        isError: true,
      };
    }

    const siteTool: SiteTool | undefined = SITE_TOOLS.find((t) => t.name === name);
    if (siteTool) {
      const parsed = z.object(siteTool.inputSchema).safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid arguments for ${name}: ${parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")}`,
            },
          ],
          isError: true,
        };
      }
      const result = await siteTool.handler(parsed.data, { env, ctx, siteId });
      return siteToolResultToMcp(result);
    }

    // Destructive CMS schema ops pass the migration guard first (per-site: the
    // guard checks THIS site's published footprint).
    if (GUARDED_TOOLS.has(name)) {
      const verdict = await guardSchemaOp(name, args, env, siteId);
      if (!verdict.allowed) {
        return {
          content: [
            {
              type: "text",
              text: `Blocked by Loki migration guard: ${verdict.reason}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Forward everything else to this site's agent-cms.
    const cmsResult = await callCmsTool(env, siteId, name, args);
    return cmsResult as any;
  });

  return server;
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return unauthorized();

  // Resolve which site + ROLE this token drives:
  //  - legacy admin WRITE_KEY -> the default site, owner;
  //  - a site OWNER key -> that site, full toolset (schema + content + code);
  //  - a scoped editor token -> that site, editor toolset (content + images only).
  let siteId: string;
  let role: "owner" | "editor" = "owner";
  if (env.WRITE_KEY && token === env.WRITE_KEY) {
    siteId = DEFAULT_SITE_ID;
  } else {
    const site = await getSiteByApiKey(env, token);
    if (site) {
      siteId = site.id;
    } else {
      const scoped = await getSiteToken(env, token);
      if (!scoped) return unauthorized();
      siteId = scoped.site_id;
      role = scoped.role === "owner" ? "owner" : "editor";
    }
  }

  const server = buildServer(env, ctx, siteId, role);
  const handler = createMcpHandler(server, {
    route: "/mcp",
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  return handler(request, env, ctx);
}
