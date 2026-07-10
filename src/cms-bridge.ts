// In-process JSON-RPC bridge to agent-cms's own /mcp endpoint.
//
// agent-cms serves MCP over the Effect RPC HTTP transport with JSON-RPC
// serialization (content-type application/json, no framing). tools/list and
// tools/call do NOT require a prior `initialize` handshake (verified in the
// @effect/ai McpServer source — those handlers don't check initializedClients),
// so we can POST a single JSON-RPC request and read the response directly.
//
// We call `cms.fetch(new Request("http://internal/mcp", ...))` in-process with
// the WRITE_KEY bearer; the CMS tool list is cached per isolate.

import { cmsFetchFor } from "./cms-dispatch";
import type { Env } from "./env";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  [k: string]: unknown;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

let cachedTools: McpTool[] | null = null;

let rpcId = 0;

async function cmsRpc(env: Env, siteId: string, method: string, params: unknown): Promise<unknown> {
  const id = ++rpcId;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const request = new Request("http://internal/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${env.WRITE_KEY ?? ""}`,
    },
    body,
  });
  const res = await cmsFetchFor(env, siteId, request);
  const text = await res.text();
  if (!res.ok && !text) {
    throw new Error(`CMS /mcp returned HTTP ${res.status}`);
  }
  const message = parseRpcResponse(text, res.headers.get("content-type") ?? "");
  if (message == null) {
    throw new Error(
      `CMS /mcp returned an unparseable ${method} response (HTTP ${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (message.error) {
    throw new Error(
      `CMS ${method} error: ${message.error.message ?? JSON.stringify(message.error)}`,
    );
  }
  return message.result;
}

interface RpcMessage {
  id?: unknown;
  result?: any;
  error?: { message?: string; [k: string]: unknown };
}

/** Parse a JSON or SSE MCP response into a single JSON-RPC message. */
function parseRpcResponse(text: string, contentType: string): RpcMessage | null {
  let payload = text;
  if (contentType.includes("text/event-stream")) {
    // Collect `data:` lines from the SSE stream.
    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return null;
    payload = dataLines.join("");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  // Effect's JSON-RPC HTTP transport returns an array of responses.
  if (Array.isArray(parsed)) {
    const withResult = parsed.find((m) => m && (m.result !== undefined || m.error !== undefined));
    return (withResult as RpcMessage) ?? null;
  }
  return parsed as RpcMessage;
}

export async function listCmsTools(env: Env, siteId: string): Promise<McpTool[]> {
  if (cachedTools) return cachedTools;
  const result = (await cmsRpc(env, siteId, "tools/list", {})) as {
    tools?: McpTool[];
  };
  cachedTools = result?.tools ?? [];
  return cachedTools;
}

export async function callCmsTool(
  env: Env,
  siteId: string,
  name: string,
  args: unknown,
): Promise<McpToolResult> {
  const result = (await cmsRpc(env, siteId, "tools/call", {
    name,
    arguments: args ?? {},
  })) as McpToolResult;
  return result;
}
