// Blind test of observability: a serverFn that throws and one that calls
// env.LOG.write; then site_logs shows both.
const APEX = "https://loftur.app";
const SUB = "loglab" + (Math.floor(Date.now() / 1000) % 100000);
let mcpUrl,
  KEY,
  ORIGIN,
  rid = 1;
const results = [];
const ok = (l, c, d = "") => {
  results.push(!!c);
  console.log(`${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`);
};
async function rpc(method, params) {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
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
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const txt = (r.content || []).map((c) => c.text || "").join("\n");
  if (r.isError) throw new Error(`tool ${name}: ${txt}`);
  return txt;
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
  await tool("site_write", { path: "loki.config.json", source: `{ "writableModels": [] }` });
  await tool("site_write", {
    path: "routes/index.tsx",
    source: `export default function H(){return <main>ok</main>;}`,
  });
  await tool("site_write", {
    path: "functions/test.ts",
    source: `import { serverFn } from "loki/runtime";
export const boom = serverFn().handler(async () => { throw new Error("kaboom in handler"); });
export const noisy = serverFn().handler(async ({ env }) => { await env.LOG.write("info", "custom log from noisy", "checkout"); return { ok: true }; });
`,
  });
  const pub = await tool("publish_site", { message: "logs" });
  const v = (/Published v(\d+)/.exec(pub) || [])[1];
  ok("publish", !!v, "v" + v);
  await new Promise((r) => setTimeout(r, 1000));

  // trigger an error + a custom log
  const boom = await fetch(`${ORIGIN}/__fn/v${v}/functions%2Ftest.ts%23boom`);
  ok("erroring serverFn returns 500", boom.status === 500);
  const noisy = await (await fetch(`${ORIGIN}/__fn/v${v}/functions%2Ftest.ts%23noisy`)).json();
  ok("env.LOG.write serverFn returns ok", noisy && noisy.ok === true, JSON.stringify(noisy));
  // trigger a render 500 too (hit a route that throws? our index doesn't throw; skip)
  await new Promise((r) => setTimeout(r, 800));

  const logs = await tool("site_logs", { limit: 20 });
  ok("site_logs captures the serverFn error", /kaboom in handler/.test(logs), "");
  ok("site_logs captures the custom env.LOG line", /custom log from noisy/.test(logs), "");
  console.log("--- logs ---\n" + logs.split("\n").slice(0, 6).join("\n"));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed — ${ORIGIN}`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
