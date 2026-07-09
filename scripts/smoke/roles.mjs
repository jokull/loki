// Blind test of user roles: sign a user in (role=member), promote via set_user_role
// MCP tool, re-sign-in, confirm user.role=admin flows into a serverFn.
const WRITE_KEY = process.env.WRITE_KEY;
if (!WRITE_KEY) throw new Error("WRITE_KEY missing");
const APEX = "https://loftur.app";
const SUB = "rolelab" + Math.floor(Date.now() / 1000) % 100000;
const USER = "member@example.com";
let mcpUrl, KEY, ORIGIN, rid = 1;
const results = [];
const ok = (l, c, d = "") => { results.push(!!c); console.log(`${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`); };

async function rpc(method, params) {
  const r = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + KEY }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }) });
  const ct = r.headers.get("content-type") || ""; const t = await r.text();
  if (r.status >= 400) throw new Error("HTTP " + r.status + ": " + t.slice(0, 200));
  let j; if (ct.includes("event-stream")) { const d = t.split(/\r?\n/).filter((l) => l.startsWith("data:")); j = JSON.parse(d[d.length - 1].slice(5).trim()); } else j = JSON.parse(t);
  if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}
const tool = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); const txt = (r.content || []).map((c) => c.text || "").join("\n"); if (r.isError) throw new Error(`tool ${name}: ${txt}`); return txt; };
const cookieOf = (sc) => (sc && /loki_session=([^;]+)/.exec(sc) || [])[1];

async function signIn(vnum) {
  const mm = await (await fetch(APEX + "/__authmagic", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + WRITE_KEY }, body: JSON.stringify({ sub: SUB, email: USER, redirectTo: "/" }) })).json();
  const verify = await fetch(mm.link, { redirect: "manual" });
  const cookie = cookieOf(verify.headers.get("set-cookie"));
  const who = await (await fetch(`${ORIGIN}/__fn/v${vnum}/functions%2Ftest.ts%23whoami`, { headers: { cookie: "loki_session=" + cookie } })).json();
  return who.user;
}

async function main() {
  const su = await (await fetch(APEX + "/api/signup", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ subdomain: SUB, email: "jokull@triptojapan.com" }) })).json();
  KEY = su.apiKey; ORIGIN = su.siteUrl; mcpUrl = su.mcpUrl;
  console.log("Site:", ORIGIN);
  await tool("site_write", { path: "loki.config.json", source: `{ "writableModels": [] }` });
  await tool("site_write", { path: "routes/index.tsx", source: `export default function H(){return <main>ok</main>;}` });
  await tool("site_write", { path: "functions/test.ts", source: `import { serverFn } from "loki/runtime";\nexport const whoami = serverFn().handler(async ({ user }) => ({ user: user || null }));\n` });
  const pub = await tool("publish_site", { message: "roles" });
  const v = (/Published v(\d+)/.exec(pub) || [])[1];
  ok("publish", !!v, "v" + v);
  await new Promise((r) => setTimeout(r, 1000));

  const u1 = await signIn(v);
  ok("new user signs in as member", u1 && u1.role === "member", JSON.stringify(u1));

  const setOut = await tool("set_user_role", { email: USER, role: "admin" });
  ok("set_user_role succeeds", /role "admin"/.test(setOut), setOut.slice(0, 60));

  const u2 = await signIn(v);
  ok("re-sign-in reflects new role in user.role", u2 && u2.role === "admin", JSON.stringify(u2));

  const list = await tool("list_users", {});
  ok("list_users shows the user as admin", new RegExp(USER + "\\s+admin").test(list), list.split("\n")[0]);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed — ${ORIGIN}`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
