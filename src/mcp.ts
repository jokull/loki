// Loki's merged MCP endpoint (/mcp).
//
// Stateless streamable-HTTP MCP server (same stack agent-cms uses for Code
// Mode: @modelcontextprotocol/sdk + agents/mcp createMcpHandler). It exposes
// Loki's site tools PLUS agent-cms's tools (fetched in-process). Destructive
// schema ops pass the migration guard before being forwarded.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import { callCmsTool, listCmsTools } from "./cms-bridge";
import { GUARDED_TOOLS, guardSchemaOp } from "./guard";
import { SITE_TOOLS, type SiteTool } from "./site/tools";
import { getSiteByApiKey } from "./tenants";
import { DEFAULT_SITE_ID } from "./site/store";

/**
 * Site tools that read the SHARED agent-cms (content/schema). v1 defers
 * per-tenant CMS, so tenant sites don't get these (they'd see the default
 * site's content). The legacy default site keeps the full toolset.
 */
const CMS_BACKED_SITE_TOOLS = new Set(["graphql_query", "schema_types"]);

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
 * Build the MCP server for a resolved site. `includeCms` gates the shared
 * agent-cms toolset + CMS-backed site tools (only the legacy default site).
 */
function buildServer(
  env: Env,
  ctx: ExecutionContext,
  siteId: string,
  includeCms: boolean,
): Server {
  const server = new Server(
    { name: "loftur", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const availableSiteTools = SITE_TOOLS.filter(
    (t) => includeCms || !CMS_BACKED_SITE_TOOLS.has(t.name),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const siteToolDefs = availableSiteTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: shapeToJsonSchema(t.inputSchema) as any,
    }));
    let cmsTools: any[] = [];
    if (includeCms) {
      try {
        cmsTools = await listCmsTools(env);
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
    }
    return { tools: [...siteToolDefs, ...cmsTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    const siteTool: SiteTool | undefined = availableSiteTools.find(
      (t) => t.name === name,
    );
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

    // Non-site tools are all CMS-backed; reject them on tenant sites.
    if (!includeCms) {
      return {
        content: [
          {
            type: "text",
            text: `Tool "${name}" is not available on this site.`,
          },
        ],
        isError: true,
      };
    }

    // Destructive CMS schema ops pass the migration guard first. CMS runs only
    // for the default site (includeCms), so `siteId` here is the default site.
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

    // Forward everything else to agent-cms verbatim.
    const cmsResult = await callCmsTool(env, name, args);
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

  // Resolve which site this key drives:
  //  - the legacy admin WRITE_KEY -> the default site, with the full CMS toolset;
  //  - a tenant API key -> that tenant's site, site tools only (no shared CMS).
  let siteId: string;
  let includeCms: boolean;
  if (env.WRITE_KEY && token === env.WRITE_KEY) {
    siteId = DEFAULT_SITE_ID;
    includeCms = true;
  } else {
    const site = await getSiteByApiKey(env, token);
    if (!site) return unauthorized();
    siteId = site.id;
    includeCms = false;
  }

  const server = buildServer(env, ctx, siteId, includeCms);
  const handler = createMcpHandler(server, {
    route: "/mcp",
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  return handler(request, env, ctx);
}
