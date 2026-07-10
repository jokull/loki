// In-process shell over the site's D1 draft tree (the "working copy").
//
// Bridges just-bash — an in-process TypeScript bash interpreter with a virtual
// filesystem (grep/sed/awk/find/jq/ls/cat/head/tail/… , no kernel, runs in
// workerd) — to Loki's `site_files` draft. Every `shell` tool call:
//   1. HYDRATES a fresh in-memory FS from the current draft (code files as real
//      source; binary assets as opaque empty placeholders so listings look real),
//      mounted at /site.
//   2. Runs the command with just-bash.
//   3. RECONCILES: any file the command wrote/changed under /site is routed back
//      through the SAME transpile + validate + dep-resolve pipeline `site_write`
//      uses (never a raw D1 UPDATE), so a `sed -i` yields a validated, transpiled
//      draft file; deletions map to deleteFile.
//
// We use the hydrate-per-call model (not a live lazy IFileSystem adapter): the
// draft tree is small, the write pipeline is async + aggregates warnings, and a
// post-exec diff keeps all the write-through logic in one place. The draft is the
// persistent working copy between calls (live-through): preview reflects it on the
// next load; publish commits; reset_site discards.
//
// `just-bash/browser` is the workerd-safe entry (only node:zlib, no static wasm,
// python/js/sqlite runtimes left disabled). Loki's supervisor has nodejs_compat.

import { Bash } from "just-bash/browser";
import type { Env } from "../env";
import {
  deleteFile,
  getPublishedVersionId,
  getVersion,
  listAssets,
  listFiles,
  restoreDraftFromVersion,
  writeFile,
} from "./store";
import { transpileModule, buildClientBuild } from "./transpile";
import { BUILTIN_SPECIFIERS, parseBareImports, resolveDep } from "./deps";
import { extractDocsFromFile, validateDocuments } from "./publish";
import { getSchemaBundle } from "./schema-types";

/** Mount point for the site tree inside the virtual FS. */
const MOUNT = "/site";
/** Wall-clock ceiling for a single shell command (protects the isolate). */
const SHELL_TIMEOUT_MS = 15_000;

const PUBLIC_PREFIX = "public/";

function mountPath(repoPath: string): string {
  return `${MOUNT}/${repoPath}`;
}
function repoPath(mounted: string): string | null {
  const prefix = MOUNT + "/";
  return mounted.startsWith(prefix) ? mounted.slice(prefix.length) : null;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: string[];
  deletedFiles: string[];
  warnings: string[];
}

/**
 * Commit ONE draft file through the real write pipeline, with land-and-surface
 * semantics (unlike site_write, which rejects): the source is ALWAYS stored so
 * the shell has filesystem fidelity (a later `cat` reads back what was written),
 * but any transpile / serverFn / dep / gql problem is returned as a warning.
 *
 * A transpile failure stores `compiled = null`; buildDraftBundle then serves the
 * raw source, so the broken route errors in preview AND publish_site hard-fails
 * (see the transpile guard in publish.ts) until it is fixed — no silent corruption.
 */
async function commitDraftFile(
  env: Env,
  siteId: string,
  path: string,
  source: string,
): Promise<string[]> {
  const warnings: string[] = [];
  let compiled: string | null = null;
  let clientCompiled: string | null = null;

  const t = transpileModule(path, source);
  if (!t.ok) {
    warnings.push(
      `${path}: TRANSPILE FAILED — file saved but publish is BLOCKED until fixed:\n    ${t.error}`,
    );
  } else {
    compiled = t.code ?? null;
    const cb = buildClientBuild(path, source);
    if (!cb.ok) {
      warnings.push(`${path}: serverFn/client-build error:\n    ${cb.error}`);
    } else {
      clientCompiled = cb.clientCompiled ?? null;
    }
    // Dependency resolution (same esm.sh snapshot + test-load path as site_write).
    // Surface-not-reject: an unresolvable import is a warning; the draft lands so
    // the agent can keep editing, and preview/publish will fail loudly on it.
    for (const specifier of parseBareImports(source)) {
      if (BUILTIN_SPECIFIERS.has(specifier)) continue;
      try {
        await resolveDep(env, siteId, specifier);
      } catch (err) {
        warnings.push(
          `${path}: dependency "${specifier}" could not be resolved:\n    ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  await writeFile(env, siteId, path, source, compiled, clientCompiled);

  // Write-time gql validation (non-fatal), identical to site_write.
  const docs = extractDocsFromFile(path, source);
  if (docs.length > 0) {
    try {
      const { schema } = await getSchemaBundle(env, siteId);
      const problems = validateDocuments(schema, docs);
      for (const p of problems) {
        warnings.push(`${path} (graphql ${p.source}): ${p.errors.join("; ")}`);
      }
    } catch {
      // schema read failure never blocks a shell write
    }
  }
  return warnings;
}

/**
 * Run a shell command line against the live draft, reconciling any writes back
 * through the transpile/validate/dep pipeline. Live-through: the draft is mutated
 * in place and is the persistent working copy between calls.
 */
export async function runShell(env: Env, siteId: string, command: string): Promise<ShellResult> {
  // 1. Hydrate a fresh in-memory FS from the current draft.
  const files = await listFiles(env, siteId);
  const assets = await listAssets(env, siteId);
  const seed: Record<string, string> = {};
  const baseline = new Map<string, string>(); // mounted path -> source
  for (const f of files) {
    const mp = mountPath(f.path);
    seed[mp] = f.source;
    baseline.set(mp, f.source);
  }
  // Binary assets appear as opaque empty placeholders so ls/find/tree look real;
  // they are never routed through the code pipeline on reconcile.
  const assetPaths = new Set<string>();
  for (const a of assets) {
    const mp = mountPath(a.path);
    if (!(mp in seed)) {
      seed[mp] = "";
      assetPaths.add(mp);
    }
  }

  const bash = new Bash({ files: seed, cwd: MOUNT, env: { HOME: MOUNT, PWD: MOUNT } });

  // 2. Execute, with a hard wall-clock cap so a runaway loop can't wedge the DO.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SHELL_TIMEOUT_MS);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const res = await bash.exec(command, { signal: ac.signal });
    stdout = res.stdout ?? "";
    stderr = res.stderr ?? "";
    exitCode = res.exitCode ?? 0;
  } catch (err) {
    stderr = `shell: ${err instanceof Error ? err.message : String(err)}`;
    exitCode = 124; // timeout / aborted / interpreter error
  } finally {
    clearTimeout(timer);
  }

  // 3. Reconcile the post-exec FS against the baseline.
  const warnings: string[] = [];
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const seenMounted = new Set<string>();

  for (const mounted of bash.fs.getAllPaths()) {
    if (repoPath(mounted) == null) continue; // outside /site (e.g. /bin, /proc)
    let isFile = false;
    try {
      isFile = (await bash.fs.stat(mounted)).isFile;
    } catch {
      continue;
    }
    if (!isFile) continue;
    seenMounted.add(mounted);
    const rp = repoPath(mounted)!;

    if (assetPaths.has(mounted) || rp.startsWith(PUBLIC_PREFIX)) {
      // Binary asset territory — shell edits here are ignored (use site_asset_*).
      let content = "";
      try {
        content = await bash.fs.readFile(mounted);
      } catch {
        /* ignore */
      }
      if (!assetPaths.has(mounted) && content !== "") {
        warnings.push(
          `${rp}: writes under public/ are ignored by the shell — binary assets ` +
            `are managed with site_asset_import / site_asset_write.`,
        );
      }
      continue;
    }

    let content: string;
    try {
      content = await bash.fs.readFile(mounted);
    } catch {
      continue;
    }
    const prev = baseline.get(mounted);
    if (prev === undefined || prev !== content) {
      warnings.push(...(await commitDraftFile(env, siteId, rp, content)));
      changedFiles.push(rp);
    }
  }

  // Deletions: a baseline code file the command removed.
  for (const [mounted] of baseline) {
    if (!seenMounted.has(mounted)) {
      const rp = repoPath(mounted)!;
      await deleteFile(env, siteId, rp);
      deletedFiles.push(rp);
    }
  }

  changedFiles.sort();
  deletedFiles.sort();
  return { stdout, stderr, exitCode, changedFiles, deletedFiles, warnings };
}

/**
 * Discard ALL draft changes, restoring the draft tree to match the currently
 * published version (the `git checkout .` escape hatch). site_diff is clean
 * afterward.
 *
 * Delegates to restoreDraftFromVersion, which reconstructs the working copy from
 * the version's snapshot: byte-faithful authored SOURCE for versions published
 * with a source snapshot (0006+), or a compiled-form fallback for legacy versions
 * (surfaced via `faithful: false`).
 */
export async function resetDraft(
  env: Env,
  siteId: string,
): Promise<
  | { ok: true; restoredFiles: number; restoredAssets: number; faithful: boolean }
  | { ok: false; error: string }
> {
  const versionId = await getPublishedVersionId(env, siteId);
  if (versionId == null) {
    return { ok: false, error: "No published version to reset to." };
  }
  const version = await getVersion(env, siteId, versionId);
  if (!version) {
    return { ok: false, error: `Published version v${versionId} is missing.` };
  }
  const r = await restoreDraftFromVersion(env, siteId, version);
  return {
    ok: true,
    faithful: r.compiledFallbackPaths.length === 0,
    restoredFiles: r.files,
    restoredAssets: r.assets,
  };
}

/** Human-readable rendering of a ShellResult for the MCP tool text response. */
export function formatShellResult(command: string, r: ShellResult): string {
  const parts: string[] = [];
  parts.push(r.stdout.length ? r.stdout.replace(/\n$/, "") : "(no stdout)");
  const footer: string[] = [];
  if (r.stderr.trim()) footer.push(`stderr:\n${r.stderr.replace(/\n$/, "")}`);
  footer.push(`exit: ${r.exitCode}`);
  if (r.changedFiles.length) footer.push(`changedFiles: ${r.changedFiles.join(", ")}`);
  if (r.deletedFiles.length) footer.push(`deletedFiles: ${r.deletedFiles.join(", ")}`);
  if (r.warnings.length) footer.push(`warnings:\n  - ${r.warnings.join("\n  - ")}`);
  return `$ ${command}\n\n${parts.join("\n")}\n\n---\n${footer.join("\n")}`;
}
