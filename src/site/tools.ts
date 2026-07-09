// Loki's own site MCP tools (dispatched locally in the merged /mcp endpoint).

import { z } from "zod";
import type { Env } from "../env";
import { getCms } from "../env";
import {
  buildDraftAssetManifest,
  deleteAsset,
  deleteFile,
  getPublishedVersionId,
  getVersion,
  listAssets,
  listFiles,
  listVersions,
  readAsset,
  readFile,
  setState,
  versionAssetManifest,
  writeFile,
  type AssetManifest,
} from "./store";
import { transpileModule, buildClientBuild } from "./transpile";
import {
  allowedScopesDoc,
  BUILTIN_SPECIFIERS,
  isAllowedDep,
  parseBareImports,
  resolveDep,
} from "./deps";
import { buildDraftBundle } from "./serve";
import {
  extractDocsFromFile,
  publishSite,
  validateDocuments,
} from "./publish";
import { getSchemaBundle } from "./schema-types";
import { SITE_HELP } from "./help";
import type { Bundle } from "./bundle";
import {
  assetServingUrl,
  checkAssetPath,
  inferContentType,
  MAX_INLINE_BYTES,
  OCTET_STREAM,
  storeAsset,
} from "./static-assets";

const PUBLIC_PREFIX = "public/";

function jsonText(value: unknown): SiteToolResult {
  return text(JSON.stringify(value, null, 2));
}

/** Decode base64 (tolerating an optional data: URL prefix and whitespace). */
function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(",");
  const body =
    input.startsWith("data:") && comma !== -1 ? input.slice(comma + 1) : input;
  const clean = body.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Prefer a concrete response Content-Type; else infer from the path. */
function resolveContentType(
  headerValue: string | null,
  path: string,
): string {
  const media = headerValue?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (media && media !== "application/octet-stream") return media;
  return inferContentType(path);
}

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
    name: "graphql_query",
    description:
      "Explore the content API before writing route queries. Runs a GraphQL document " +
      "in-process against the live CMS schema and returns the raw { data, errors } as " +
      "JSON. Introspection is allowed (send a __schema / __type query to discover models " +
      "and fields). The schema is DatoCMS-style: collection fields are pluralised " +
      "(allBlogPosts), single-record fields are singular (blogPost(filter: ...)), and " +
      "record types are suffixed with Record (BlogPostRecord). Set includeDrafts to true " +
      "to see unpublished content; it defaults to published-only. Use this to prototype a " +
      "query here, then paste the working document into a route's gql loader.",
    inputSchema: {
      query: z.string().describe("GraphQL query or introspection document"),
      variables: z
        .record(z.unknown())
        .optional()
        .describe("Query variables as a JSON object"),
      includeDrafts: z
        .boolean()
        .optional()
        .describe("Include draft (unpublished) content; defaults to false"),
    },
    async handler({ query, variables, includeDrafts }, { env }) {
      const result = await getCms(env).execute(query, variables ?? {}, {
        includeDrafts: includeDrafts ?? false,
      });
      return text(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "schema_types",
    description:
      "Return TypeScript types generated from the LIVE CMS GraphQL schema — the " +
      "source of truth for content field names and types. READ THIS BEFORE writing " +
      "route queries, loaders, or component props: an agent has no IDE hover, so " +
      "reading these types is how you learn the exact shapes you are coding against. " +
      "It declares one interface per record type (e.g. BlogPostRecord), the Query root " +
      "(allBlogPosts / blogPost / _allBlogPostsMeta return shapes, with each field's " +
      "args in a JSDoc comment), the orderBy/status enums, and the filter input types. " +
      "Nullability (`| null`), lists (`T[]`), nested linked records, and Structured Text " +
      "(`{ value, blocks, inlineBlocks, links }`) are rendered faithfully. These are the " +
      "SAME types importable as `import type { BlogPostRecord, Query } from \"loki/schema\"` " +
      "to annotate loaders and props. Regenerates automatically when the schema changes.",
    inputSchema: {},
    async handler(_args, { env }) {
      const { ts, version } = await getSchemaBundle(env);
      return text(`// schema_version: ${version}\n${ts}`);
    },
  },
  {
    name: "site_write",
    description:
      "Create or overwrite a site file in the draft tree. TSX/TS/JSX/JS are transpiled immediately (sucrase, preact JSX); transpile errors are returned and the write is REJECTED. Other files (styles.css, *.graphql) are stored as-is. " +
      "After a successful write, every gql`...` document in the file (and standalone *.graphql files) is VALIDATED against the live CMS schema; any problems come back in a `graphqlErrors` block (with precise messages like `Cannot query field \"x\" on type \"BlogPostRecord\". Did you mean \"y\"?`). These are NON-FATAL — the file is still saved so you can write a component before its query is finished — but fix them before publish_site, which hard-gates on the same validation. " +
      "You may also `import` from resolver-allowlisted npm packages (currently the `drizzle-orm` scope and its subpaths): Loki resolves them via esm.sh at write time, snapshots a self-contained version-pinned copy, and returns a `resolvedDeps` block. Resolving a package for the FIRST time may take a few seconds (crawl + store); an unknown bare specifier, or one needing Node built-ins, is REJECTED. " +
      "For typed authoring, read the `schema_types` tool output and `import type { BlogPostRecord } from \"loki/schema\"`.",
    inputSchema: {
      path: z.string().describe("Repo-relative path, e.g. routes/index.tsx or styles.css"),
      source: z.string().describe("Full file contents"),
    },
    async handler({ path, source }, { env }) {
      const result = transpileModule(path, source);
      if (!result.ok) {
        return errorResult(`Transpile failed for ${path}:\n${result.error}`);
      }
      // Synthesize the browser stub for serverFn modules (and enforce the
      // "serverFn modules export only serverFns" convention). REJECT the write
      // on a collision so handler source can never leak to the client.
      const clientBuild = buildClientBuild(path, source);
      if (!clientBuild.ok) {
        return errorResult(`Write rejected for ${path}:\n${clientBuild.error}`);
      }

      // Dependency resolution (npm-dep spike). Detect bare specifiers this file
      // imports. Loki built-ins (preact family, loki/runtime, loki/schema) are
      // injected already. Allowlisted deps (drizzle-orm scope) are resolved +
      // snapshotted via esm.sh in the supervisor NOW so the pin is recorded
      // before publish. An unknown bare specifier, or a resolution/compat
      // failure, REJECTS the write (like a transpile error) so the tree never
      // holds an unresolvable import. This mirrors the write-time gql ethos.
      const resolvedDeps: Array<{
        specifier: string;
        version: string;
        files: number;
        bytes: number;
        loadable: true;
      }> = [];
      for (const specifier of parseBareImports(source)) {
        if (BUILTIN_SPECIFIERS.has(specifier)) continue;
        if (!isAllowedDep(specifier)) {
          return errorResult(
            `Write rejected for ${path}: unknown import "${specifier}". ` +
              `Allowed imports are the Loki built-ins (preact, preact/hooks, ` +
              `preact/jsx-runtime, preact-render-to-string, loki/runtime, ` +
              `loki/schema) and resolver-allowlisted npm packages: ` +
              `${allowedScopesDoc()} (and their subpaths). To add a package, ` +
              `it must be ESM and workerd-compatible without node builtins.`,
          );
        }
        try {
          const dep = await resolveDep(env, specifier);
          resolvedDeps.push({
            specifier: dep.specifier,
            version: dep.version,
            files: dep.files,
            bytes: dep.bytes,
            loadable: true,
          });
        } catch (err) {
          return errorResult(
            `Write rejected for ${path}: could not resolve dependency ` +
              `"${specifier}" via esm.sh:\n${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      await writeFile(
        env,
        path,
        source,
        result.code ?? null,
        clientBuild.clientCompiled ?? null,
      );
      const stubNote = clientBuild.clientCompiled
        ? ", serverFn module (browser gets a stub build)"
        : "";
      const depNote =
        resolvedDeps.length > 0
          ? `\nresolvedDeps (${resolvedDeps.length}, snapshotted via esm.sh — ` +
            `version-pinned, self-contained):\n` +
            resolvedDeps
              .map(
                (d) =>
                  `  - ${d.specifier}@${d.version}  (${d.files} file${
                    d.files === 1 ? "" : "s"
                  }, ${d.bytes} bytes, loadable)`,
              )
              .join("\n")
          : "";
      const base = `Wrote ${path} (${source.length} bytes${result.code ? ", transpiled" : ""}${stubNote}).${depNote}`;

      // Write-time gql validation: extract this file's documents and validate
      // them against the live schema so field/type mistakes surface NOW, not at
      // publish. Non-fatal — the write already succeeded. Never let a schema
      // read failure block the write.
      const docs = extractDocsFromFile(path, source);
      if (docs.length === 0) return text(base);
      let problems;
      try {
        const { schema } = await getSchemaBundle(env);
        problems = validateDocuments(schema, docs);
      } catch (err) {
        return text(
          `${base}\n\n(Skipped gql validation — could not read the live schema: ` +
            `${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (problems.length === 0) {
        return text(
          `${base}\nValidated ${docs.length} GraphQL document(s) against the live schema — no errors.`,
        );
      }
      const detail = problems
        .map((p) => `  ${p.source}:\n    - ${p.errors.join("\n    - ")}`)
        .join("\n");
      return text(
        `${base}\n\ngraphqlErrors (NON-FATAL — file saved; fix before publish_site):\n${detail}\n\n` +
          `Tip: read \`schema_types\` for exact field names/types, or prototype with graphql_query.`,
      );
    },
  },
  {
    name: "site_asset_import",
    description:
      "Import a static/design asset by URL. Loki (which has network access) " +
      "fetches the URL, stores the bytes content-addressed in R2, and records a " +
      "DRAFT asset entry. Path MUST start with `public/` and serves at the site " +
      "root (public/img/hero.jpg -> /img/hero.jpg). Returns JSON " +
      "{ path, url, hash, size, contentType } where `url` is the EXACT string to " +
      "paste into markup/CSS. Prefer this over site_asset_write for anything but " +
      "tiny files. Assets version/preview/rollback exactly like code — publish to " +
      "go live.",
    inputSchema: {
      path: z
        .string()
        .describe("public/… path, e.g. public/img/hero.jpg (serves at /img/hero.jpg)"),
      url: z.string().describe("Source URL to fetch (http/https)"),
    },
    async handler({ path, url }, { env }) {
      const check = checkAssetPath(path);
      if (!check.ok) return errorResult(check.error!);
      if (!/^https?:\/\//i.test(url)) {
        return errorResult("url must be an http(s) URL.");
      }
      let res: Response;
      try {
        res = await fetch(url, { redirect: "follow" });
      } catch (err) {
        return errorResult(
          `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        return errorResult(`Fetch of ${url} returned HTTP ${res.status}.`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) return errorResult(`${url} returned an empty body.`);
      const contentType = resolveContentType(res.headers.get("content-type"), path);
      const stored = await storeAsset(env, path, bytes, contentType);
      return jsonText(stored);
    },
  },
  {
    name: "site_asset_write",
    description:
      "Write a small static asset from base64 bytes (favicon, SVG, etc). Path " +
      "MUST start with `public/` and serves at the site root " +
      "(public/favicon.ico -> /favicon.ico). Size cap ~2 MB — larger files are " +
      "rejected with a pointer to site_asset_import. contentType is inferred from " +
      "the extension if omitted. Returns JSON { path, url, hash, size, contentType }; " +
      "`url` is the exact string to reference. Records a DRAFT entry — publish to " +
      "go live.",
    inputSchema: {
      path: z
        .string()
        .describe("public/… path, e.g. public/favicon.ico (serves at /favicon.ico)"),
      base64: z
        .string()
        .describe("File bytes as base64 (a data: URL prefix is tolerated)"),
      contentType: z
        .string()
        .optional()
        .describe("MIME type; inferred from the extension if omitted"),
    },
    async handler({ path, base64, contentType }, { env }) {
      const check = checkAssetPath(path);
      if (!check.ok) return errorResult(check.error!);
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(base64);
      } catch {
        return errorResult("base64 is not valid base64 data.");
      }
      if (bytes.length === 0) return errorResult("Decoded body is empty.");
      if (bytes.length > MAX_INLINE_BYTES) {
        return errorResult(
          `Decoded file is ${bytes.length} bytes, over the ~${Math.round(
            MAX_INLINE_BYTES / (1024 * 1024),
          )} MB site_asset_write cap. Use site_asset_import({ path, url }) instead.`,
        );
      }
      const explicit = contentType && contentType.trim();
      const ct = explicit ? contentType.trim() : inferContentType(path);
      const stored = await storeAsset(env, path, bytes, ct);
      // If we had to fall back to octet-stream from the extension, flag it so the
      // agent knows to pass an explicit contentType (browsers won't render it).
      if (!explicit && ct === OCTET_STREAM) {
        return jsonText({
          ...stored,
          contentTypeInferred: false,
          note:
            `Content-Type could not be inferred from the extension of "${path}" — ` +
            `stored as ${OCTET_STREAM}. Re-run site_asset_write with an explicit ` +
            `contentType (e.g. "text/plain; charset=utf-8") so it serves correctly.`,
        });
      }
      return jsonText({ ...stored, contentTypeInferred: !explicit });
    },
  },
  {
    name: "site_read",
    description:
      "Read a site file's source from the draft tree. For a binary asset " +
      "(public/… path) this returns JSON metadata (hash, size, contentType, " +
      "serving url) — NOT the raw bytes.",
    inputSchema: { path: z.string() },
    async handler({ path }, { env }) {
      if (path.startsWith(PUBLIC_PREFIX)) {
        const asset = await readAsset(env, path);
        if (!asset) return errorResult(`No such asset: ${path}`);
        return jsonText({
          path: asset.path,
          kind: "asset",
          url: assetServingUrl(asset.path),
          hash: asset.hash,
          size: asset.size,
          contentType: asset.content_type,
          updated_at: asset.updated_at,
          note: "Binary asset — bytes are served at `url`, not returned here.",
        });
      }
      const file = await readFile(env, path);
      if (!file) return errorResult(`No such file: ${path}`);
      return text(file.source);
    },
  },
  {
    name: "site_list",
    description:
      "List the draft tree: code files (with sizes/update times) AND static " +
      "assets (marked, with size/contentType/serving url).",
    inputSchema: {},
    async handler(_args, { env }) {
      const files = await listFiles(env);
      const assets = await listAssets(env);
      if (files.length === 0 && assets.length === 0) {
        return text("(draft tree is empty)");
      }
      const sections: string[] = [];
      if (files.length) {
        sections.push(
          "Code files:\n" +
            files
              .map((f) => `  ${f.path}  (${f.source.length}b, ${f.updated_at})`)
              .join("\n"),
        );
      }
      if (assets.length) {
        sections.push(
          "Assets (public/… -> served at site root):\n" +
            assets
              .map(
                (a) =>
                  `  ${a.path} -> ${assetServingUrl(a.path)}  ` +
                  `(${a.content_type}, ${a.size}b, ${a.updated_at})`,
              )
              .join("\n"),
        );
      }
      return text(sections.join("\n\n"));
    },
  },
  {
    name: "site_delete",
    description:
      "Delete a file or asset from the draft tree (public/… paths delete the asset entry).",
    inputSchema: { path: z.string() },
    async handler({ path }, { env }) {
      if (path.startsWith(PUBLIC_PREFIX)) {
        const ok = await deleteAsset(env, path);
        return ok
          ? text(`Deleted asset ${path}.`)
          : errorResult(`No such asset: ${path}`);
      }
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
      const draftAssets = await buildDraftAssetManifest(env);
      const versionId = await getPublishedVersionId(env);
      let published: Bundle = {};
      let publishedAssets: AssetManifest = {};
      if (versionId != null) {
        const v = await getVersion(env, versionId);
        if (v) {
          published = JSON.parse(v.bundle) as Bundle;
          publishedAssets = versionAssetManifest(v);
        }
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
      // Assets compared by content hash (distinct from code).
      const aAdded: string[] = [];
      const aRemoved: string[] = [];
      const aChanged: string[] = [];
      for (const p of Object.keys(draftAssets)) {
        if (!(p in publishedAssets)) aAdded.push(p);
        else if (publishedAssets[p].hash !== draftAssets[p].hash) aChanged.push(p);
      }
      for (const p of Object.keys(publishedAssets)) {
        if (!(p in draftAssets)) aRemoved.push(p);
      }
      const fmt = (label: string, arr: string[]) =>
        `${label} (${arr.length}):${arr.length ? "\n  " + arr.sort().join("\n  ") : " none"}`;
      const base =
        versionId == null
          ? "No published version yet — everything is new.\n"
          : `Comparing draft vs published v${versionId}.\n`;
      return text(
        base +
          "Code:\n" +
          [fmt("Added", added), fmt("Changed", changed), fmt("Removed", removed)]
            .map((l) => "  " + l.replace(/\n/g, "\n  "))
            .join("\n") +
          "\nAssets:\n" +
          [fmt("Added", aAdded), fmt("Changed", aChanged), fmt("Removed", aRemoved)]
            .map((l) => "  " + l.replace(/\n/g, "\n  "))
            .join("\n"),
      );
    },
  },
  {
    name: "preview_site",
    description:
      "Mint a short-lived (30 min) preview URL. Visiting it sets the HttpOnly cookie " +
      "`loki_preview` and serves the DRAFT tree with draft CMS content visible. Returns " +
      "an absolute URL. Non-browser clients: GET the returned /__preview?token=... URL " +
      "with a cookie jar (it 302-redirects to / and Set-Cookie: loki_preview), then " +
      "request any draft path reusing that jar. The token/cookie is bound to a 30-min " +
      "window, NOT to the draft contents — after further site_write edits just re-request " +
      "the path with the same jar (the draft rebuilds every request); mint a new token " +
      "only once the 30 min lapses.",
    inputSchema: {},
    async handler(_args, { env }) {
      const token = crypto.randomUUID().replace(/-/g, "");
      const expires = Date.now() + 30 * 60 * 1000;
      await setState(env, "preview_token", JSON.stringify({ token, expires }));
      const url = `${SITE_ORIGIN}/__preview?token=${token}`;
      return text(
        `Preview ready (valid 30 min):\n${url}\n\n` +
          `Browser: open it — sets the HttpOnly cookie \`loki_preview\` and redirects to /.\n` +
          `Programmatic (curl -c jar -b jar / fetch with a cookie jar):\n` +
          `  1. GET ${url}  (follow the 302; stores the loki_preview cookie)\n` +
          `  2. GET ${SITE_ORIGIN}/<any draft path>  reusing the jar -> draft HTML\n` +
          `The token lasts 30 min and is independent of edits: after more site_write calls, ` +
          `just re-request with the same jar (no new token needed until it expires).`,
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
      const warnBlock = result.warnings.length
        ? `\nWarnings (non-fatal):\n  - ${result.warnings.join("\n  - ")}`
        : "";
      return text(
        `Published v${result.versionId}.\n` +
          `- GraphQL documents validated: ${result.validated.documents}\n` +
          `- Footprint (Type.field) pairs: ${result.validated.footprintFields}\n` +
          `- Root fields used: ${result.validated.rootFields.join(", ") || "(none)"}\n` +
          `- Static assets snapshotted: ${result.validated.assets}\n` +
          `The live site now serves v${result.versionId}.${warnBlock}`,
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
