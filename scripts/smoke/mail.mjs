// Blind test of env.MAIL: build a tenant site with a serverFn that sends a real
// transactional email, publish, invoke it, assert { ok: true }.
const APEX = "https://loftur.app";
const SUB = "maillab" + Math.floor(Date.now() / 1000) % 100000;
let mcpUrl, KEY, ORIGIN, rid = 1;

async function rpc(method, params) {
  const r = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + KEY }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }) });
  const ct = r.headers.get("content-type") || ""; const t = await r.text();
  if (r.status >= 400) throw new Error("HTTP " + r.status + ": " + t.slice(0, 200));
  let j; if (ct.includes("event-stream")) { const d = t.split(/\r?\n/).filter((l) => l.startsWith("data:")); j = JSON.parse(d[d.length - 1].slice(5).trim()); } else j = JSON.parse(t);
  if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}
const tool = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); const txt = (r.content || []).map((c) => c.text || "").join("\n"); if (r.isError) throw new Error(`tool ${name}: ${txt}`); return txt; };

const FILES = {
  "loki.config.json": `{ "writableModels": [] }`,
  "routes/index.tsx": `export default function Home(){ return <main><h1>mail test</h1></main>; }`,
  "functions/mail.ts": `import { serverFn } from "loki/runtime";
export const sendTest = serverFn()
  .handler(async ({ env }) => {
    return env.MAIL.send({ to: "jokull@triptojapan.com", subject: "Loftur env.MAIL test", text: "env.MAIL works.", html: "<p>env.MAIL works.</p>" });
  });
`,
};

async function main() {
  const su = await (await fetch(APEX + "/api/signup", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ subdomain: SUB, email: "jokull@triptojapan.com" }) })).json();
  if (!su.apiKey) throw new Error("signup failed: " + JSON.stringify(su));
  KEY = su.apiKey; ORIGIN = su.siteUrl; mcpUrl = su.mcpUrl;
  console.log("Site:", ORIGIN);
  for (const [p, s] of Object.entries(FILES)) await tool("site_write", { path: p, source: s });
  const pub = await tool("publish_site", { message: "mail test" });
  const v = /Published v(\d+)/.exec(pub);
  console.log(v ? `✅ published v${v[1]}` : "❌ publish: " + pub.slice(0, 120));
  await new Promise((r) => setTimeout(r, 1200));
  const res = await fetch(`${ORIGIN}/__fn/v${v[1]}/functions%2Fmail.ts%23sendTest`);
  const out = await res.json();
  const pass = out && out.ok === true;
  console.log(`${pass ? "✅" : "❌"} env.MAIL.send returns ok — ${JSON.stringify(out)}`);
  process.exit(pass && v ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
