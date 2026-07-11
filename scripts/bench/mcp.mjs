// Loftur Bench — MCP client for a blind builder. Simulates the native MCP client
// a real agent (Claude Code / Openclaw) has, so a blind builder drives tools
// without hand-writing JSON-RPC. Auth from env LOFTUR_PAT (an account PAT).
//
//   node mcp.mjs :list                    # tool names
//   node mcp.mjs :schema <toolName>       # a tool's input schema
//   node mcp.mjs <toolName> '<json-args>' # call a tool; prints result text; exit 1 on tool error
const PAT = process.env.LOFTUR_PAT;
if (!PAT) {
  console.error("LOFTUR_PAT env is required");
  process.exit(2);
}
const URL = process.env.LOFTUR_MCP || "https://loftur.app/mcp";
let rid = 1;

async function rpc(method, params) {
  const r = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + PAT,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
  });
  const ct = r.headers.get("content-type") || "";
  const t = await r.text();
  if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${t.slice(0, 400)}`);
  let j;
  if (ct.includes("event-stream")) {
    const d = t.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    j = JSON.parse(d[d.length - 1].slice(5).trim());
  } else j = JSON.parse(t);
  if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
  return j.result;
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === ":list") {
    console.log((await rpc("tools/list", {})).tools.map((t) => t.name).join("\n"));
  } else if (cmd === ":schema") {
    const t = (await rpc("tools/list", {})).tools.find((x) => x.name === arg);
    console.log(t ? JSON.stringify(t.inputSchema, null, 2) : `no such tool: ${arg}`);
  } else if (cmd) {
    let args = {};
    if (arg) {
      try {
        args = JSON.parse(arg);
      } catch (e) {
        console.error(`bad JSON args: ${e.message}`);
        process.exit(2);
      }
    }
    const res = await rpc("tools/call", { name: cmd, arguments: args });
    console.log((res.content || []).map((c) => c.text || "").join("\n"));
    if (res.isError) process.exit(1);
  } else {
    console.error("usage: node mcp.mjs :list | :schema <tool> | <tool> '<json>'");
    process.exit(2);
  }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
