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
 * Build the MCP server for a resolved site. EVERY site gets the full toolset;
 * content tools are routed to that site's CMS (default → shared agent-cms;
 * tenant → its own agent-cms in its TenantDB). The CMS tool DEFINITIONS are
 * identical across sites, so tools/list reads them from the default site's CMS
 * (avoids booting a tenant DO just to enumerate tools); calls route per-site.
 */
function buildServer(env: Env, ctx: ExecutionContext, siteId: string): Server {
  const server = new Server(
    { name: "loftur", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const siteToolDefs = SITE_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: shapeToJsonSchema(t.inputSchema) as any,
    }));
    let cmsTools: any[] = [];
    try {
      cmsTools = await listCmsTools(env, DEFAULT_SITE_ID);
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

    const siteTool: SiteTool | undefined = SITE_TOOLS.find(
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

  // Resolve which site this key drives:
  //  - the legacy admin WRITE_KEY -> the default site (shared agent-cms);
  //  - a tenant API key -> that tenant's site (its own agent-cms in its TenantDB).
  // Both get the full toolset; content tools route to the resolved site's CMS.
  let siteId: string;
  if (env.WRITE_KEY && token === env.WRITE_KEY) {
    siteId = DEFAULT_SITE_ID;
  } else {
    const site = await getSiteByApiKey(env, token);
    if (!site) return unauthorized();
    siteId = site.id;
  }

  const server = buildServer(env, ctx, siteId);
  const handler = createMcpHandler(server, {
    route: "/mcp",
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  return handler(request, env, ctx);
}
