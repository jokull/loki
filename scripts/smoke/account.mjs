// End-to-end test of the ACCOUNT layer: one account PAT drives the unified MCP —
// claim a subdomain AND build it, over a single connection with a `site` selector.
// Mints a PAT via the WRITE_KEY-gated admin route, then acts purely as an agent
// holding that PAT would (claim_site → site_write → publish_site → fetch it live).
import { setTimeout as sleep } from "node:timers/promises";

const WRITE_KEY = process.env.WRITE_KEY;
if (!WRITE_KEY) throw new Error("WRITE_KEY missing (run under dotenvx -f .env)");
const APEX = "https://loftur.app";
const MCP = APEX + "/mcp";
const EMAIL = "jokull@triptojapan.com";
const SUB = "acctlab" + (Math.floor(Date.now() / 1000) % 100000);

let PAT;
let rid = 1;
async function rpc(method, params) {
  const r = await fetch(MCP, {
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
  if (r.status >= 400) throw new Error("HTTP " + r.status + ": " + t.slice(0, 300));
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
  if (r.isError) throw new Error(`tool ${name} error: ${txt}`);
  return txt;
};

const results = [];
const ok = (label, cond, detail = "") => {
  results.push(!!cond);
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};

async function main() {
  // 0. Mint an account PAT (admin route; the dashboard "Agent access" panel is the
  //    real path). This is the only privileged step — everything after is the agent.
  const mint = await fetch(APEX + "/__accounttoken", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + WRITE_KEY },
    body: JSON.stringify({ email: EMAIL, label: "smoke" }),
  });
  const mj = await mint.json();
  ok(
    "account PAT minted",
    !!mj.token && mj.token.startsWith("lftr_pat_"),
    mj.token ? mj.token.slice(0, 16) + "…" : JSON.stringify(mj),
  );
  PAT = mj.token;

  // 1. tools/list exposes account tools + build tools with a `site` selector
  const list = await rpc("tools/list", {});
  const names = new Set((list.tools || []).map((t) => t.name));
  ok(
    "account tools present (claim_site · list_sites · whoami)",
    names.has("claim_site") && names.has("list_sites") && names.has("whoami"),
  );
  const siteWrite = (list.tools || []).find((t) => t.name === "site_write");
  ok(
    "build tools advertise a required `site` selector",
    !!siteWrite && (siteWrite.inputSchema?.required || []).includes("site"),
    (siteWrite?.inputSchema?.required || []).join(","),
  );

  // 2. whoami — the account is resolved from the PAT
  const who = JSON.parse(await tool("whoami"));
  ok("whoami resolves the account email from the PAT", who.email === EMAIL, who.email);

  // 3. claim a brand-new subdomain over the SAME connection
  const claimed = JSON.parse(await tool("claim_site", { subdomain: SUB }));
  ok(
    "claim_site provisions {sub}.loftur.app + returns an owner key",
    claimed.ok &&
      claimed.url === `https://${SUB}.loftur.app` &&
      (claimed.ownerKey || "").startsWith("lft_"),
    claimed.url,
  );

  // 4. it shows up in list_sites
  const sites = JSON.parse(await tool("list_sites"));
  ok(
    "list_sites includes the newly claimed site",
    Array.isArray(sites) && sites.some((s) => s.subdomain === SUB),
  );

  // 5. build it — no reconnect, just pass `site`
  await tool("site_write", {
    site: SUB,
    path: "routes/index.tsx",
    source: `export default function Home() { return (<main><h1 id="hi">Built by an agent over the account PAT</h1></main>); }\n`,
  });
  const pub = await tool("publish_site", { site: SUB, message: "account-layer smoke" });
  const vm = /Published v(\d+)/.exec(pub);
  ok(
    "site_write + publish_site work via the `site` selector",
    !!vm,
    vm ? "v" + vm[1] : pub.slice(0, 120),
  );

  // 6. the published site actually serves
  await sleep(1500);
  const res = await fetch(`https://${SUB}.loftur.app/`);
  const html = await res.text();
  ok(
    "the claimed+built site renders live",
    res.status === 200 && /Built by an agent over the account PAT/.test(html),
    "status=" + res.status,
  );

  // 7. ownership isolation — a `site` the account doesn't own is rejected
  let denied = false;
  try {
    await tool("site_read", { site: "definitely-not-your-site-xyz", path: "routes/index.tsx" });
  } catch (e) {
    denied = /not owned|No site|not found/i.test(String(e.message || e));
  }
  ok("build tools reject a site the account doesn't own", denied);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed — account layer (PAT → claim + build)`);
  if (passed !== results.length) process.exit(1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
