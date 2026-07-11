// Regression tests for the first-user feedback (Guðróður, netverslunar-test):
//  #1 silently-swallowed input — create_record with a wrong top-level key used to
//     succeed with an EMPTY record (fixed in agent-cms 0.4.3: strict
//     additionalProperties). Now it must be a clear error.
//  #2 stale schema cache after create_field — site_write gql-validation /
//     schema_types lagged the live schema on TENANT sites (fixed in loki: the
//     schema-version counter is read from the tenant DO, not the supervisor D1).
import { setTimeout as sleep } from "node:timers/promises";

const WRITE_KEY = process.env.WRITE_KEY;
if (!WRITE_KEY) throw new Error("WRITE_KEY missing (run under dotenvx -f .env)");
const APEX = "https://loftur.app";
const SUB = "fbklab" + (Math.floor(Date.now() / 1000) % 100000);

let mcpUrl,
  KEY,
  rid = 1;
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
  if (r.status >= 400) throw new Error("HTTP " + r.status + ": " + t.slice(0, 300));
  let j;
  if (ct.includes("event-stream")) {
    const d = t.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    j = JSON.parse(d[d.length - 1].slice(5).trim());
  } else j = JSON.parse(t);
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const callTool = async (name, args = {}) => rpc("tools/call", { name, arguments: args });
const text = (r) => (r.content || []).map((c) => c.text || "").join("\n");

const results = [];
const ok = (label, cond, detail = "") => {
  results.push(!!cond);
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};

async function main() {
  const su = await (
    await fetch(APEX + "/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subdomain: SUB, email: "jokull@triptojapan.com" }),
    })
  ).json();
  if (!su.apiKey) throw new Error("signup failed: " + JSON.stringify(su));
  KEY = su.apiKey;
  mcpUrl = su.mcpUrl;
  console.log(`Site: ${su.siteUrl}`);

  // #1 — a wrong top-level key must ERROR, not silently write an empty record.
  const wrong = await callTool("create_record", { modelApiKey: "widget", fields: { title: "x" } });
  ok(
    "#1 create_record rejects an unknown key (`fields`) instead of swallowing it",
    wrong.isError === true && /fields|unexpected property|additionalProperties/i.test(text(wrong)),
    text(wrong).slice(0, 90),
  );

  // #2 — create a model + field, then the write-time validator / schema_types must
  // see the new field promptly (not a 10-min stale cache) on this tenant.
  const cm = await callTool("create_model", { name: "Widget", apiKey: "widget" });
  const modelId = (text(cm).match(/"id"\s*:\s*"([^"]+)"/) || [])[1];
  ok("#2 setup: create_model", !cm.isError && !!modelId, modelId || text(cm).slice(0, 80));
  const cf = await callTool("create_field", {
    modelId,
    label: "Headline",
    apiKey: "headline",
    fieldType: "string",
  });
  const fieldId = (text(cf).match(/"id"\s*:\s*"([^"]+)"/) || [])[1];

  let sawField = false;
  for (let i = 0; i < 6 && !sawField; i++) {
    const st = await callTool("schema_types", {});
    if (/headline/i.test(text(st)) && /WidgetRecord/.test(text(st))) sawField = true;
    else await sleep(1200);
  }
  ok("#2 schema_types reflects a just-created field (no stale tenant cache)", sawField);

  // And the write-time gql validator agrees (no false 'Cannot query field' error).
  const wr = await callTool("site_write", {
    path: "routes/index.tsx",
    source:
      `import { gql, query } from "loki/runtime";\n` +
      `const Q = gql\`query { allWidgets { headline } }\`;\n` +
      `export async function loader({ env }) { return { d: await query(env, Q) }; }\n` +
      `export default function Home() { return <main><h1>ok</h1></main>; }\n`,
  });
  ok(
    "#2 write-time gql validation sees the new field (no stale-schema error)",
    !/Cannot query field .headline./i.test(text(wr)),
    (text(wr).match(/Cannot query field[^\n]*/) || ["clean"])[0].slice(0, 80),
  );

  // #3 (pen test H1) — the migration guard must block deleting a field the
  // PUBLISHED site queries, on a TENANT site (was a no-op: guard read the
  // supervisor D1, not the tenant DO, so every destructive op passed).
  await callTool("publish_site", { message: "footprint uses headline" });
  const del = await callTool("delete_field", { fieldId });
  ok(
    "#3 migration guard blocks delete_field of a published-dependent field (tenant)",
    del.isError === true && /migration guard/i.test(text(del)),
    text(del).split("\n")[0].slice(0, 90),
  );

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed — first-user feedback regressions`);
  if (passed !== results.length) process.exit(1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
