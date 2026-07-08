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
import { getCms } from "../env";
import { buildDraftBundle, smokeRender } from "./serve";
import { insertVersion, listFiles, setState } from "./store";

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

/** Extract every GraphQL document from the draft: gql`` templates + *.graphql. */
export async function extractDocuments(env: Env): Promise<ExtractedDoc[]> {
  const files = await listFiles(env);
  const docs: ExtractedDoc[] = [];
  for (const file of files) {
    if (file.path.endsWith(".graphql")) {
      const text = file.source.trim();
      if (text) docs.push({ source: file.path, text });
      continue;
    }
    if (!/\.(tsx|ts|jsx|mjs|js)$/.test(file.path)) continue;
    let match: RegExpExecArray | null;
    let i = 0;
    GQL_TEMPLATE.lastIndex = 0;
    while ((match = GQL_TEMPLATE.exec(file.source)) !== null) {
      // Strip ${...} interpolations so the document parses standalone.
      const text = match[1].replace(/\$\{[\s\S]*?\}/g, "").trim();
      if (text) docs.push({ source: `${file.path}#gql${i}`, text });
      i++;
    }
  }
  return docs;
}

export async function introspectSchema(env: Env): Promise<GraphQLSchema> {
  const cms = getCms(env);
  const result = await cms.execute(getIntrospectionQuery());
  if (result.errors && result.errors.length) {
    throw new Error(
      "Schema introspection failed: " +
        result.errors.map((e) => e.message).join("; "),
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

export type PublishResult =
  | {
      ok: true;
      versionId: number;
      validated: {
        documents: number;
        footprintFields: number;
        rootFields: string[];
      };
    }
  | { ok: false; stage: string; error: string };

export async function publishSite(
  env: Env,
  ctx: ExecutionContext,
  message: string | null,
): Promise<PublishResult> {
  // (a) extract documents from the draft
  const docs = await extractDocuments(env);

  // (b) validate against the live schema
  let schema: GraphQLSchema;
  try {
    schema = await introspectSchema(env);
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

  // (c) footprint
  const footprint = computeFootprint(schema, docs);

  // (d) smoke render "/" from the draft bundle
  const bundle = await buildDraftBundle(env);
  if (Object.keys(bundle).length === 0) {
    return {
      ok: false,
      stage: "smoke-render",
      error: "Draft is empty — nothing to publish.",
    };
  }
  try {
    const res = await smokeRender(env, ctx, bundle);
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

  // (e) snapshot + repoint
  const versionId = await insertVersion(env, message, bundle, footprint);
  await setState(env, "published_version", String(versionId));

  return {
    ok: true,
    versionId,
    validated: {
      documents: docs.length,
      footprintFields: footprint.fields.length,
      rootFields: footprint.rootFields,
    },
  };
}
