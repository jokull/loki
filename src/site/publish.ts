// publish_site: validate the draft's GraphQL against the live schema, extract a
// migration footprint, smoke-render "/", then snapshot the compiled bundle into
// a new site_versions row and repoint published_version.

import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  validate,
  visit,
  visitWithTypeInfo,
  TypeInfo,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import type { Env } from "../env";
import { cmsExecuteFor } from "../cms-dispatch";
import { buildDraftBundle, smokeRender } from "./serve";
import { draftDepSnapshot } from "./deps";
import { buildClientBuild, isTranspilable } from "./transpile";
import {
  DEFAULT_SITE_ID,
  buildDraftAssetManifest,
  insertVersion,
  listFiles,
  readFile,
  setState,
  type AssetManifest,
} from "./store";
import { assetServingUrl } from "./static-assets";

export interface ExtractedDoc {
  /** Where it came from (file path, optionally with an index for gql templates). */
  source: string;
  /** The GraphQL document text (interpolations stripped for gql templates). */
  text: string;
}

/** Footprint of the site's GraphQL usage, stored on the version row. */
export interface Footprint {
  /** "ParentType.fieldName" pairs referenced anywhere in the documents. */
  fields: string[];
  /** GraphQL type names referenced. */
  types: string[];
  /** Root operation field names (Query/Mutation entry points). */
  rootFields: string[];
}

const GQL_TEMPLATE = /\bgql\s*`([\s\S]*?)`/g;

/**
 * Extract the GraphQL documents from a SINGLE file: the whole body for a
 * `.graphql` file, or every `gql`` `` template inside a JS/TS module. `${...}`
 * interpolations are stripped so each document parses standalone — the same
 * logic the whole-tree scan and publish use, so write-time and publish-time
 * validation behave identically.
 */
export function extractDocsFromFile(path: string, source: string): ExtractedDoc[] {
  const docs: ExtractedDoc[] = [];
  if (path.endsWith(".graphql")) {
    const text = source.trim();
    if (text) docs.push({ source: path, text });
    return docs;
  }
  if (!/\.(tsx|ts|jsx|mjs|js)$/.test(path)) return docs;
  let match: RegExpExecArray | null;
  let i = 0;
  GQL_TEMPLATE.lastIndex = 0;
  while ((match = GQL_TEMPLATE.exec(source)) !== null) {
    // Strip ${...} interpolations so the document parses standalone.
    const text = match[1].replace(/\$\{[\s\S]*?\}/g, "").trim();
    if (text) docs.push({ source: `${path}#gql${i}`, text });
    i++;
  }
  return docs;
}

/** Extract every GraphQL document from the draft: gql`` templates + *.graphql. */
export async function extractDocuments(env: Env, siteId: string): Promise<ExtractedDoc[]> {
  const files = await listFiles(env, siteId);
  const docs: ExtractedDoc[] = [];
  for (const file of files) {
    docs.push(...extractDocsFromFile(file.path, file.source));
  }
  return docs;
}

export async function introspectSchema(env: Env, siteId: string): Promise<GraphQLSchema> {
  const result = await cmsExecuteFor(env, siteId, getIntrospectionQuery(), {}, false);
  if (result.errors && result.errors.length) {
    throw new Error(
      "Schema introspection failed: " +
        result.errors.map((e: { message: string }) => e.message).join("; "),
    );
  }
  return buildClientSchema(result.data as unknown as IntrospectionQuery);
}

export interface DocError {
  source: string;
  errors: string[];
}

/** Validate each document; returns per-document errors (empty = all valid). */
export function validateDocuments(
  schema: GraphQLSchema,
  docs: ExtractedDoc[],
): DocError[] {
  const problems: DocError[] = [];
  for (const doc of docs) {
    try {
      const ast = parse(doc.text);
      const errors = validate(schema, ast);
      if (errors.length) {
        problems.push({ source: doc.source, errors: errors.map((e) => e.message) });
      }
    } catch (err) {
      problems.push({
        source: doc.source,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return problems;
}

/** Walk every valid document with TypeInfo to compute the footprint. */
export function computeFootprint(
  schema: GraphQLSchema,
  docs: ExtractedDoc[],
): Footprint {
  const fields = new Set<string>();
  const types = new Set<string>();
  const rootFields = new Set<string>();
  const queryType = schema.getQueryType();
  const mutationType = schema.getMutationType();
  const subscriptionType = schema.getSubscriptionType();
  const rootNames = new Set(
    [queryType, mutationType, subscriptionType]
      .filter(Boolean)
      .map((t) => t!.name),
  );

  for (const doc of docs) {
    let ast;
    try {
      ast = parse(doc.text);
    } catch {
      continue;
    }
    const typeInfo = new TypeInfo(schema);
    visit(
      ast,
      visitWithTypeInfo(typeInfo, {
        Field(node) {
          const parent = typeInfo.getParentType();
          if (parent) {
            fields.add(`${parent.name}.${node.name.value}`);
            types.add(parent.name);
            if (rootNames.has(parent.name)) rootFields.add(node.name.value);
          }
          const fieldType = typeInfo.getType();
          if (fieldType) {
            const named = namedTypeName(fieldType);
            if (named) types.add(named);
          }
        },
      }),
    );
  }

  return {
    fields: [...fields].sort(),
    types: [...types].sort(),
    rootFields: [...rootFields].sort(),
  };
}

function namedTypeName(type: unknown): string | null {
  let t = type as { ofType?: unknown; name?: string };
  while (t && t.ofType) t = t.ofType as typeof t;
  return t && typeof t.name === "string" ? t.name : null;
}

/**
 * Validate the draft's loki.config.json (if present): it must parse as a JSON
 * object, and every `writableModels` entry must name a model that exists in D1.
 * These models become the RECORDS.create allowlist for the published tree.
 */
export async function validateSiteConfig(
  env: Env,
  siteId: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const file = await readFile(env, siteId, "loki.config.json");
  if (!file) return { ok: true, models: [] };

  let cfg: unknown;
  try {
    cfg = JSON.parse(file.source);
  } catch (err) {
    return {
      ok: false,
      error: `loki.config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (cfg == null || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ok: false, error: "loki.config.json must be a JSON object." };
  }

  const wm = (cfg as { writableModels?: unknown }).writableModels;
  if (wm === undefined) return { ok: true, models: [] };
  if (!Array.isArray(wm) || !wm.every((m) => typeof m === "string")) {
    return {
      ok: false,
      error:
        'loki.config.json "writableModels" must be an array of model api_key strings.',
    };
  }
  if (wm.length === 0) return { ok: true, models: [] };

  // Model list is per-site: default site → shared D1; tenant → its own CMS (DO).
  let modelKeys: string[];
  if (siteId === DEFAULT_SITE_ID) {
    const { results } = await env.DB.prepare(
      "SELECT api_key FROM models",
    ).all<{ api_key: string }>();
    modelKeys = (results ?? []).map((r) => r.api_key);
  } else {
    modelKeys = await env.TENANT_DB.get(
      env.TENANT_DB.idFromName(siteId),
    ).modelApiKeys();
  }
  const known = new Set(modelKeys);
  const missing = (wm as string[]).filter((m) => !known.has(m));
  if (missing.length) {
    return {
      ok: false,
      error:
        `loki.config.json writableModels references unknown model(s): ${missing.join(", ")}. ` +
        `Known models: ${[...known].sort().join(", ") || "(none)"}.`,
    };
  }
  return { ok: true, models: wm as string[] };
}

export type PublishResult =
  | {
      ok: true;
      versionId: number;
      validated: {
        documents: number;
        footprintFields: number;
        rootFields: string[];
        assets: number;
      };
      warnings: string[];
    }
  | { ok: false; stage: string; error: string };

/**
 * Best-effort scan of code sources for `/`-rooted asset references (e.g.
 * `url(/img/hero.jpg)`, `href="/favicon.ico"`) that map to a public/ file which
 * isn't in the draft manifest. Returns human-readable warnings — never fails the
 * publish (mirrors the GraphQL-validation ethos of teaching, not blocking here).
 */
function scanMissingAssetRefs(
  files: { path: string; source: string }[],
  manifest: AssetManifest,
): string[] {
  const served = new Set(Object.keys(manifest).map(assetServingUrl));
  // Quote/paren-delimited `/path.ext` references. Requires a file extension so
  // page routes (/about, /posts/x) don't produce noise.
  const REF = /["'(]\s*(\/[^"'()\s?#]+\.[A-Za-z0-9]+)/g;
  const missing = new Map<string, Set<string>>();
  for (const f of files) {
    if (!/\.(tsx|ts|jsx|mjs|js|css|graphql|html)$/.test(f.path)) continue;
    let m: RegExpExecArray | null;
    REF.lastIndex = 0;
    while ((m = REF.exec(f.source)) !== null) {
      const ref = m[1];
      if (ref.startsWith("//")) continue; // protocol-relative
      if (ref === "/styles.css") continue; // served by the site worker itself
      if (served.has(ref)) continue;
      (missing.get(ref) ?? missing.set(ref, new Set()).get(ref)!).add(f.path);
    }
  }
  return [...missing.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([ref, where]) =>
        `${ref} referenced in ${[...where].sort().join(", ")} has no matching ` +
        `public${ref} asset — add it with site_asset_import/site_asset_write, or ` +
        `it will 404.`,
    );
}

export async function publishSite(
  env: Env,
  ctx: ExecutionContext,
  siteId: string,
  message: string | null,
): Promise<PublishResult> {
  // (a) extract documents from the draft
  const docs = await extractDocuments(env, siteId);

  // (b) validate against the live schema
  let schema: GraphQLSchema;
  try {
    schema = await introspectSchema(env, siteId);
  } catch (err) {
    return {
      ok: false,
      stage: "introspection",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const problems = validateDocuments(schema, docs);
  if (problems.length) {
    const detail = problems
      .map((p) => `  ${p.source}:\n    - ${p.errors.join("\n    - ")}`)
      .join("\n");
    return {
      ok: false,
      stage: "graphql-validation",
      error: `GraphQL validation failed against the live schema:\n${detail}`,
    };
  }

  // (b2) validate loki.config.json (writableModels must reference real models)
  const config = await validateSiteConfig(env, siteId);
  if (!config.ok) {
    return { ok: false, stage: "config-validation", error: config.error };
  }

  // (b3) transpile guard: the shell can LAND a file whose TSX/TS failed to
  // transpile (compiled === null) for filesystem fidelity; such a file must never
  // publish. (site_write can't produce this — it rejects on transpile error — so
  // this only trips on a shell-landed broken write.)
  const broken = (await listFiles(env, siteId)).filter(
    (f) => isTranspilable(f.path) && f.compiled === null,
  );
  if (broken.length) {
    return {
      ok: false,
      stage: "transpile",
      error:
        `These draft files failed to transpile and must be fixed before ` +
        `publishing:\n${broken.map((f) => `  - ${f.path}`).join("\n")}`,
    };
  }

  // (c) footprint
  const footprint = computeFootprint(schema, docs);

  // (d) smoke render "/" from the draft bundle
  const bundle = await buildDraftBundle(env, siteId);
  if (Object.keys(bundle).length === 0) {
    return {
      ok: false,
      stage: "smoke-render",
      error: "Draft is empty — nothing to publish.",
    };
  }
  try {
    const res = await smokeRender(env, ctx, siteId, bundle);
    if (res.status >= 500) {
      const body = await res.text();
      return {
        ok: false,
        stage: "smoke-render",
        error: `Smoke render of "/" returned ${res.status}:\n${body.slice(0, 2000)}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      stage: "smoke-render",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // (d2) synthesize the browser stub bundle for serverFn modules. Recomputed
  // from source (not just read from client_compiled) so it also catches any
  // collision in a file written before client stubs existed — a serverFn module
  // that leaks non-serverFn exports must not publish.
  const clientBundle: Record<string, string> = {};
  for (const f of await listFiles(env, siteId)) {
    const built = buildClientBuild(f.path, f.source);
    if (!built.ok) {
      return { ok: false, stage: "client-build", error: built.error! };
    }
    if (built.clientCompiled != null) clientBundle[f.path] = built.clientCompiled;
  }

  // (e) snapshot the draft asset manifest (blobs already live in R2, so this is
  // just a path->{hash,contentType,size} map; publish/rollback swap manifests).
  const assetManifest = await buildDraftAssetManifest(env, siteId);
  const warnings = scanMissingAssetRefs(
    (await listFiles(env, siteId)).map((f) => ({ path: f.path, source: f.source })),
    assetManifest,
  );

  // (e2) snapshot the resolved npm-dep pins so published/preview/rollback all
  // serve identical, version-pinned esm.sh bytes (the blobs already live in R2).
  const deps = await draftDepSnapshot(env, siteId, bundle);

  // (e3) snapshot the exact authored source (path -> source). This is what makes
  // a version faithfully reconstructable: rollback/reset restore SOURCE, not just
  // the compiled bundle. See migrations/0006_source_in_versions.sql.
  const sourceBundle: Record<string, string> = {};
  for (const f of await listFiles(env, siteId)) sourceBundle[f.path] = f.source;

  // (f) snapshot + repoint
  const versionId = await insertVersion(
    env,
    siteId,
    message,
    bundle,
    footprint,
    assetManifest,
    clientBundle,
    deps,
    sourceBundle,
  );
  await setState(env, siteId, "published_version", String(versionId));

  return {
    ok: true,
    versionId,
    validated: {
      documents: docs.length,
      footprintFields: footprint.fields.length,
      rootFields: footprint.rootFields,
      assets: Object.keys(assetManifest).length,
    },
    warnings,
  };
}
