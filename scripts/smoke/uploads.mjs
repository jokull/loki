const APEX = "https://loftur.app";
const SUB = "uplab" + (Math.floor(Date.now() / 1000) % 100000);
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
// 1x1 transparent PNG
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAoD3vAAAAABJRU5ErkJggg==";
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
    path: "functions/up.ts",
    source: `import { serverFn } from "loki/runtime";
export const upload = serverFn({ method: "POST" }).validator((i)=>({ b64:String(i.b64||"") })).handler(async ({ data, env }) => {
  return env.UPLOADS.put("pics/test.png", data.b64, "image/png");
});`,
  });
  const pub = await tool("publish_site", { message: "uploads" });
  const v = (/Published v(\d+)/.exec(pub) || [])[1];
  ok("publish", !!v, "v" + v);
  await new Promise((r) => setTimeout(r, 1000));
  const res = await (
    await fetch(`${ORIGIN}/__fn/v${v}/functions%2Fup.ts%23upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { b64: PNG } }),
    })
  ).json();
  ok(
    "env.UPLOADS.put returns url",
    res && res.ok && res.url === "/__uploads/pics/test.png",
    JSON.stringify(res),
  );
  await new Promise((r) => setTimeout(r, 500));
  const img = await fetch(`${ORIGIN}/__uploads/pics/test.png`);
  const ctype = img.headers.get("content-type");
  const buf = new Uint8Array(await img.arrayBuffer());
  ok(
    "uploaded file serves at /__uploads/ with content-type",
    img.status === 200 && ctype === "image/png" && buf.length > 0,
    `status=${img.status} ct=${ctype} bytes=${buf.length}`,
  );
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} — ${ORIGIN}`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
