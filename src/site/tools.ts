// Loki's own site MCP tools (dispatched locally in the merged /mcp endpoint).

import { z } from "zod";
import type { Env } from "../env";
import {
  deleteFile,
  getPublishedVersionId,
  getVersion,
  listFiles,
  listVersions,
  readFile,
  setState,
  writeFile,
} from "./store";
import { transpileModule } from "./transpile";
import { buildDraftBundle } from "./serve";
import { publishSite } from "./publish";
import { SITE_HELP } from "./help";
import type { Bundle } from "./bundle";

const SITE_ORIGIN = "https://loki.solberg.workers.dev";

export interface ToolCtx {
  env: Env;
  ctx: ExecutionContext;
}

export interface SiteToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(t: string): SiteToolResult {
  return { content: [{ type: "text", text: t }] };
}
function errorResult(t: string): SiteToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

export interface SiteTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any, tctx: ToolCtx) => Promise<SiteToolResult>;
}

export const SITE_TOOLS: SiteTool[] = [
  {
    name: "site_write",
    description:
      "Create or overwrite a site file in the draft tree. TSX/TS/JSX/JS are transpiled immediately (sucrase, preact JSX); transpile errors are returned and the write is rejected. Other files (styles.css, *.graphql) are stored as-is.",
    inputSchema: {
      path: z.string().describe("Repo-relative path, e.g. routes/index.tsx or styles.css"),
      source: z.string().describe("Full file contents"),
    },
    async handler({ path, source }, { env }) {
      const result = transpileModule(path, source);
      if (!result.ok) {
        return errorResult(`Transpile failed for ${path}:\n${result.error}`);
      }
      await writeFile(env, path, source, result.code ?? null);
      return text(
        `Wrote ${path} (${source.length} bytes${result.code ? ", transpiled" : ""}).`,
      );
    },
  },
  {
    name: "site_read",
    description: "Read a site file's source from the draft tree.",
    inputSchema: { path: z.string() },
    async handler({ path }, { env }) {
      const file = await readFile(env, path);
      if (!file) return errorResult(`No such file: ${path}`);
      return text(file.source);
    },
  },
  {
    name: "site_list",
    description: "List all files in the draft tree with sizes and update times.",
    inputSchema: {},
    async handler(_args, { env }) {
      const files = await listFiles(env);
      if (files.length === 0) return text("(draft tree is empty)");
      const lines = files.map(
        (f) => `${f.path}  (${f.source.length}b, ${f.updated_at})`,
      );
      return text(lines.join("\n"));
    },
  },
  {
    name: "site_delete",
    description: "Delete a file from the draft tree.",
    inputSchema: { path: z.string() },
    async handler({ path }, { env }) {
      const ok = await deleteFile(env, path);
      return ok ? text(`Deleted ${path}.`) : errorResult(`No such file: ${path}`);
    },
  },
  {
    name: "site_diff",
    description:
      "Show how the draft tree differs from the currently published version: added, removed, and changed paths (comparing deployed/compiled form).",
    inputSchema: {},
    async handler(_args, { env }) {
      const draft = await buildDraftBundle(env);
      const versionId = await getPublishedVersionId(env);
      let published: Bundle = {};
      if (versionId != null) {
        const v = await getVersion(env, versionId);
        if (v) published = JSON.parse(v.bundle) as Bundle;
      }
      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      for (const p of Object.keys(draft)) {
        if (!(p in published)) added.push(p);
        else if (published[p] !== draft[p]) changed.push(p);
      }
      for (const p of Object.keys(published)) {
        if (!(p in draft)) removed.push(p);
      }
      const fmt = (label: string, arr: string[]) =>
        `${label} (${arr.length}):${arr.length ? "\n  " + arr.sort().join("\n  ") : " none"}`;
      const base =
        versionId == null
          ? "No published version yet — everything is new.\n"
          : `Comparing draft vs published v${versionId}.\n`;
      return text(
        base +
          [fmt("Added", added), fmt("Changed", changed), fmt("Removed", removed)].join(
            "\n",
          ),
      );
    },
  },
  {
    name: "preview_site",
    description:
      "Mint a short-lived (30 min) preview URL. Visiting it sets a cookie and serves the DRAFT tree with draft CMS content visible. Returns an absolute URL.",
    inputSchema: {},
    async handler(_args, { env }) {
      const token = crypto.randomUUID().replace(/-/g, "");
      const expires = Date.now() + 30 * 60 * 1000;
      await setState(env, "preview_token", JSON.stringify({ token, expires }));
      const url = `${SITE_ORIGIN}/__preview?token=${token}`;
      return text(
        `Preview ready (valid 30 min):\n${url}\n\nOpen it to view the draft; it sets an HttpOnly cookie and redirects to /.`,
      );
    },
  },
  {
    name: "publish_site",
    description:
      "Validate all GraphQL documents against the live schema, extract the migration footprint, smoke-render '/', then snapshot the draft into a new immutable version and point the live site at it. Fails with precise errors at any step.",
    inputSchema: {
      message: z.string().optional().describe("Optional changelog message"),
    },
    async handler({ message }, { env, ctx }) {
      const result = await publishSite(env, ctx, message ?? null);
      if (!result.ok) {
        return errorResult(`Publish failed at ${result.stage}:\n${result.error}`);
      }
      return text(
        `Published v${result.versionId}.\n` +
          `- GraphQL documents validated: ${result.validated.documents}\n` +
          `- Footprint (Type.field) pairs: ${result.validated.footprintFields}\n` +
          `- Root fields used: ${result.validated.rootFields.join(", ") || "(none)"}\n` +
          `The live site now serves v${result.versionId}.`,
      );
    },
  },
  {
    name: "rollback_site",
    description: "Repoint the live site at a previously published version id.",
    inputSchema: { version_id: z.number().int().positive() },
    async handler({ version_id }, { env }) {
      const v = await getVersion(env, version_id);
      if (!v) return errorResult(`No such version: ${version_id}`);
      await setState(env, "published_version", String(version_id));
      return text(`Rolled back — the live site now serves v${version_id}.`);
    },
  },
  {
    name: "site_versions",
    description: "List published site versions (newest first).",
    inputSchema: {},
    async handler(_args, { env }) {
      const versions = await listVersions(env);
      const current = await getPublishedVersionId(env);
      if (versions.length === 0) return text("No versions published yet.");
      const lines = versions.map((v) => {
        const marker = v.id === current ? " <- live" : "";
        return `v${v.id}  ${v.created_at}  ${v.message ?? "(no message)"}${marker}`;
      });
      return text(lines.join("\n"));
    },
  },
  {
    name: "site_help",
    description:
      "Return the site authoring guide: routing conventions, route module shape, available imports, a full example, and the preview/publish/rollback workflow.",
    inputSchema: {},
    async handler() {
      return text(SITE_HELP);
    },
  },
];

export const SITE_TOOL_NAMES = new Set(SITE_TOOLS.map((t) => t.name));
