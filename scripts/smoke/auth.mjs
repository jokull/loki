// End-to-end test of the mediated-outbound + secrets + passwordless-auth mission.
// Signs up a fresh site, builds an auth+secret+outbound site over MCP, publishes,
// then drives the live HTTP surface: secret read, outbound fetch, magic-link
// session, user-in-loader gating, and a real Cloudflare Email send.
import { setTimeout as sleep } from "node:timers/promises";

const WRITE_KEY = process.env.WRITE_KEY;
if (!WRITE_KEY) throw new Error("WRITE_KEY missing (run under dotenvx -f .env)");
const APEX = "https://loftur.app";
const SUB = "authlab" + Math.floor(Date.now() / 1000) % 100000;

let mcpUrl, KEY, ORIGIN, siteId;
let rid = 1;
async function rpc(method, params) {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }),
  });
  const ct = r.headers.get("content-type") || "";
  const t = await r.text();
  if (r.status >= 400) throw new Error("HTTP " + r.status + ": " + t.slice(0, 300));
  let j;
  if (ct.includes("event-stream")) { const d = t.split(/\r?\n/).filter((l) => l.startsWith("data:")); j = JSON.parse(d[d.length - 1].slice(5).trim()); }
  else j = JSON.parse(t);
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const txt = (r.content || []).map((c) => c.text || "").join("\n");
  if (r.isError) throw new Error(`tool ${name} error: ${txt}`);
  return txt;
};
const write = (path, source) => tool("site_write", { path, source });

// Site files -----------------------------------------------------------------
const FILES = {
  "loki.config.json": `{ "writableModels": [] }`,
  "functions/test.ts": `import { serverFn } from "loki/runtime";

export const whoami = serverFn()
  .handler(async ({ user }) => ({ user: user || null }));

export const secretcheck = serverFn()
  .handler(async ({ env }) => {
    const token = await env.SECRETS.get("ECHO_TOKEN");
    const names = await env.SECRETS.names();
    let outbound = null;
    try {
      const res = await fetch("https://example.com/");
      outbound = res.status;
    } catch (e) { outbound = "ERR:" + (e && e.message || e); }
    return { hasSecret: !!token, secretLen: token ? token.length : 0, names, outbound };
  });
`,
  "routes/index.tsx": `export async function loader({ user }) { return { user: user || null }; }
export default function Home({ user }) {
  if (user) return (<main><h1 id="who">Signed in as {user.email}</h1><p><a href="/members">Members</a> · <a href="/__auth/logout">Log out</a></p></main>);
  return (<main><h1 id="who">Signed out</h1><form method="post" action="/login"><input name="email" type="email" required /><button>Email me a link</button></form></main>);
}
`,
  "routes/login.tsx": `export async function action({ request, env }) {
  const form = await request.formData();
  const email = String(form.get("email") || "");
  const r = await env.AUTH.requestMagicLink(email, "/members");
  if (!r.ok) return new Response(r.error || "failed", { status: 400 });
  return { redirect: "/?sent=1" };
}
export default function Login() {
  return (<main><h1>Login</h1><form method="post"><input name="email" type="email" required /><button>Send</button></form></main>);
}
`,
  "routes/members.tsx": `export async function loader({ user }) { return { user: user || null }; }
export default function Members({ user }) {
  if (!user) return (<main><h1 id="gate">Members only — please <a href="/">sign in</a></h1></main>);
  return (<main><h1 id="gate">Welcome, {user.email}</h1><p id="uid">{user.id}</p></main>);
}
`,
};

function parseCookie(setCookie, name) {
  if (!setCookie) return null;
  const m = new RegExp(name + "=([^;]+)").exec(setCookie);
  return m ? m[1] : null;
}

async function main() {
  const results = [];
  const ok = (label, cond, detail = "") => { results.push({ label, pass: !!cond, detail }); console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); };

  // 1. Sign up a fresh site
  const su = await fetch(APEX + "/api/signup", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ subdomain: SUB, email: "jokull@triptojapan.com" }) });
  const suj = await su.json();
  if (!suj.apiKey) throw new Error("signup failed: " + JSON.stringify(suj));
  KEY = suj.apiKey; ORIGIN = suj.siteUrl; mcpUrl = suj.mcpUrl;
  console.log(`\nSite: ${ORIGIN}  (mcp ${mcpUrl})`);

  // 2. Set a secret (owner tool)
  const setOut = await tool("set_secret", { name: "ECHO_TOKEN", value: "sk_test_ABC123_secret_value" });
  ok("set_secret stores a secret", /Stored secret/.test(setOut));
  const listOut = await tool("list_secrets", {});
  ok("list_secrets shows the name, not the value", /ECHO_TOKEN/.test(listOut) && !/ABC123/.test(listOut), listOut.split("\n")[0]);

  // 3. Build + publish the site
  for (const [p, s] of Object.entries(FILES)) await write(p, s);
  const pub = await tool("publish_site", { message: "auth+secret+outbound test" });
  const vm = /Published v(\d+)/.exec(pub);
  ok("publish_site succeeds", !!vm, vm ? "v" + vm[1] : pub.slice(0, 120));

  // Small delay for edge propagation
  await sleep(1500);

  // 4. secretcheck serverFn (GET) — proves SECRETS + OUTBOUND from the isolate
  const scRes = await fetch(`${ORIGIN}/__fn/v${vm[1]}/functions%2Ftest.ts%23secretcheck`);
  const sc = await scRes.json();
  ok("env.SECRETS.get returns the secret in-isolate", sc.hasSecret === true && sc.secretLen === "sk_test_ABC123_secret_value".length, JSON.stringify(sc));
  ok("mediated outbound fetch() works (example.com 200)", sc.outbound === 200, "status=" + sc.outbound);
  ok("env.SECRETS.names lists the secret", Array.isArray(sc.names) && sc.names.includes("ECHO_TOKEN"));

  // 5. Members page WITHOUT a session -> gated
  const anon = await (await fetch(`${ORIGIN}/members`)).text();
  ok("members page gates anonymous users", /Members only/.test(anon));

  // 6. Mint a magic link via the admin route (no real inbox), follow it -> session cookie
  const mm = await fetch(APEX + "/__authmagic", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + WRITE_KEY }, body: JSON.stringify({ sub: SUB, email: "member@example.com", redirectTo: "/members" }) });
  const mmj = await mm.json();
  ok("admin magic-link minter returns a link", !!mmj.link, mmj.link ? mmj.link.slice(0, 60) + "…" : JSON.stringify(mmj));
  siteId = mmj.siteId;

  const verify = await fetch(mmj.link, { redirect: "manual" });
  const setCookie = verify.headers.get("set-cookie");
  const session = parseCookie(setCookie, "loki_session");
  ok("verify sets a loki_session cookie + redirects", verify.status === 302 && !!session && verify.headers.get("location") === "/members", `status=${verify.status} loc=${verify.headers.get("location")}`);

  const cookieHeader = "loki_session=" + session;

  // 7. Members page WITH the session -> welcomed
  const authed = await (await fetch(`${ORIGIN}/members`, { headers: { cookie: cookieHeader } })).text();
  ok("members page shows the user when signed in", /Welcome, member@example.com/.test(authed));

  // 8. whoami serverFn WITH session -> user injected into serverFn too
  const whoRes = await fetch(`${ORIGIN}/__fn/v${vm[1]}/functions%2Ftest.ts%23whoami`, { headers: { cookie: cookieHeader } });
  const who = await whoRes.json();
  ok("user is injected into serverFns", who.user && who.user.email === "member@example.com", JSON.stringify(who));

  // 9. whoami WITHOUT session -> null (and a forged header must NOT be trusted)
  const whoAnon = await (await fetch(`${ORIGIN}/__fn/v${vm[1]}/functions%2Ftest.ts%23whoami`, { headers: { "x-loki-user": JSON.stringify({ id: "forged", email: "attacker@evil.com" }) } })).json();
  ok("client-supplied x-loki-user header is stripped (not trusted)", whoAnon.user === null, JSON.stringify(whoAnon));

  // 10. Logout clears the cookie
  const lo = await fetch(`${ORIGIN}/__auth/logout`, { headers: { cookie: cookieHeader }, redirect: "manual" });
  const cleared = lo.headers.get("set-cookie") || "";
  ok("logout clears the session cookie", lo.status === 302 && /loki_session=;/.test(cleared) && /Max-Age=0/.test(cleared));

  // 11. REAL email send via env.AUTH (route action -> Cloudflare Email). sent:true
  //     means env.EMAIL.send did not throw. Sends one real email — skip with SKIP_MAIL=1.
  if (!process.env.SKIP_MAIL) {
    const loginRes = await fetch(`${ORIGIN}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=jokull@triptojapan.com", redirect: "manual" });
    ok("login form triggers env.AUTH.requestMagicLink -> real email (303 redirect)", loginRes.status === 303 && loginRes.headers.get("location") === "/?sent=1", "status=" + loginRes.status);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed  —  site ${ORIGIN}`);
  if (passed !== results.length) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
