// Loftur full-stack smoke suite. Runs every capability test against the LIVE
// deployment (loki + loftur-web) and aggregates pass/fail.
//
//   dotenvx run -f .env -- node scripts/smoke/run.mjs        # skips real-email steps
//   MAIL=1 dotenvx run -f .env -- node scripts/smoke/run.mjs # includes real sends
//
// Requires WRITE_KEY in the environment (admin key). Each test signs up a fresh
// throwaway {name}.loftur.app and drives the MCP + HTTP surfaces.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ["auth  (secrets · outbound · magic-link · user injection · logout)", "auth.mjs"],
  ["web   (account sign-in · dashboard · sites · gating)", "web.mjs"],
  // mail sends a real email — only with MAIL=1
  ...(process.env.MAIL ? [["mail  (env.MAIL transactional email)", "mail.mjs"]] : []),
  ["roles (user.role · set_user_role · list_users)", "roles.mjs"],
  ["logs  (env.LOG · site_logs · error capture)", "logs.mjs"],
  ["uploads (env.UPLOADS · /__uploads serving)", "uploads.mjs"],
  ["templates (scaffold_template · publish · render)", "templates.mjs"],
  ["allowlist (outbound allowedHosts enforcement)", "allowlist.mjs"],
];

function run(file) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (!process.env.MAIL) env.SKIP_MAIL = "1";
    const p = spawn(process.execPath, [join(here, file)], { env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const results = [];
for (const [label, file] of SUITES) {
  process.stdout.write(`\n▶ ${label}\n`);
  const { code, out } = await run(file);
  process.stdout.write(out.split("\n").filter((l) => /^[✅❌]|passed|FATAL/.test(l)).map((l) => "  " + l).join("\n") + "\n");
  results.push({ label, ok: code === 0 });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(52)}`);
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.label.split("  ")[0]}`);
console.log(`${passed}/${results.length} suites green`);
process.exit(passed === results.length ? 0 : 1);
