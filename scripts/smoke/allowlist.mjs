const APEX = "https://loftur.app";
const SUB = "allowlab" + (Math.floor(Date.now() / 1000) % 100000);
let mcpUrl,
  KEY,
  ORIGIN,
  rid = 1;
const results = [];
const ok = (l, c, d = "") => {
  results.push(!!c);
  console.log(`${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`);
};
async function rpc(m, p) {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method: m, params: p }),
  });
  const ct = r.headers.get("content-type") || "";
  const t = await r.text();
  if (r.status >= 400) throw new Error("HTTP " + r.status + ": " + t.slice(0, 200));
  let j;
  if (ct.includes("event-stream")) {
    const d = t.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    j = JSON.parse(d[d.length - 1].slice(5).trim());
  } else j = JSON.parse(t);
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const tool = async (n, a = {}) => {
  const r = await rpc("tools/call", { name: n, arguments: a });
  const x = (r.content || []).map((c) => c.text || "").join("\n");
  if (r.isError) throw new Error(`${n}: ${x}`);
  return x;
};
async function main() {
  const su = await (
    await fetch(APEX + "/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ subdomain: SUB, email: "jokull@triptojapan.com" }),
    })
  ).json();
  KEY = su.apiKey;
  ORIGIN = su.siteUrl;
  mcpUrl = su.mcpUrl;
  console.log("Site:", ORIGIN);
  await tool("site_write", {
    path: "loki.config.json",
    source: `{ "writableModels": [], "allowedHosts": ["example.com"] }`,
  });
  await tool("site_write", {
    path: "routes/index.tsx",
    source: `export default function H(){return <main>ok</main>;}`,
  });
  await tool("site_write", {
    path: "functions/net.ts",
    source: `import { serverFn } from "loki/runtime";
export const allowed = serverFn().handler(async () => { const r = await fetch("https://example.com/"); return { status: r.status }; });
export const blocked = serverFn().handler(async () => { const r = await fetch("https://api.github.com/"); return { status: r.status }; });
`,
  });
  const pub = await tool("publish_site", { message: "allowlist" });
  const v = (/Published v(\d+)/.exec(pub) || [])[1];
  ok("publish", !!v, "v" + v);
  await new Promise((r) => setTimeout(r, 900));
  const a = await (await fetch(`${ORIGIN}/__fn/v${v}/functions%2Fnet.ts%23allowed`)).json();
  ok("allowed host (example.com) reachable -> 200", a && a.status === 200, JSON.stringify(a));
  const b = await (await fetch(`${ORIGIN}/__fn/v${v}/functions%2Fnet.ts%23blocked`)).json();
  ok("unlisted host (api.github.com) BLOCKED -> 403", b && b.status === 403, JSON.stringify(b));
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
