// Toggle the `agent-cms` dependency between the LOCAL checkout (fast dev loop, no
// publish) and a PUBLISHED version. See DEVELOPING.md.
//
//   pnpm cms:link            -> agent-cms@link:../agent-cms  (local dev)
//   pnpm cms:use [version]   -> agent-cms@^<version>  (default: latest on npm)
//   pnpm cms:unlink          -> alias for `cms:use` (back to the published dep)
//
// `use`/`unlink` also add the version to pnpm-workspace.yaml's
// minimumReleaseAgeExclude so a just-published release isn't blocked by the
// supply-chain age policy.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (c) => execSync(c, { stdio: "inherit" });
const cmd = process.argv[2];

function allowFreshVersion(version) {
  const path = "pnpm-workspace.yaml";
  const text = readFileSync(path, "utf8");
  const line = text.split("\n").find((l) => l.includes("agent-cms@"));
  if (!line || line.includes(version)) return;
  const updated = text.replace(line, `${line.trimEnd()} || ${version}`);
  writeFileSync(path, updated);
  console.log(`• allowed agent-cms@${version} in pnpm-workspace.yaml`);
}

if (cmd === "link") {
  run("pnpm add -w agent-cms@link:../agent-cms");
  console.log(
    "\n✅ agent-cms → local ../agent-cms. In another pane run its watcher:\n" +
      "   (cd ../agent-cms && pnpm dev)\n" +
      "Run `pnpm cms:unlink` before committing (a pre-commit hook enforces this).",
  );
} else if (cmd === "use" || cmd === "unlink") {
  const version = process.argv[3] || execSync("npm view agent-cms version").toString().trim();
  allowFreshVersion(version);
  run(`pnpm add -w agent-cms@^${version}`);
  console.log(`\n✅ agent-cms → ^${version} (published).`);
} else {
  console.error("usage: node scripts/cms.mjs link | use [version] | unlink");
  process.exit(1);
}
