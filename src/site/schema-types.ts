// Generate a TypeScript source string from the live GraphQL schema so the
// authoring agent can code its loaders/props against real content types.
//
// The emitter walks the introspected schema (graphql-js `GraphQLSchema`, built
// exactly the way publish.ts does) and emits:
//   - one `interface` per object type (content Record types, StructuredText,
//     nested linked records, *Meta count shapes, and the `Query` root),
//   - a string-literal union `type` per enum (orderBy enums, ItemStatus, …),
//   - one `interface` per input object (filter inputs) with nullable fields
//     optional,
//   - faithful scalar / nullability / list mappings.
//
// It is exposed to the agent two ways: the `schema_types` MCP tool (read the
// exact shapes) and a types-only `loki/schema` module (`import type { … }`).
//
// The generated text is cached per-isolate keyed on agent-cms's
// `_cms_meta.schema_version`, which is bumped on every schema mutation, so a
// schema change is reflected within a short version-check TTL.

import {
  buildClientSchema,
  getIntrospectionQuery,
  isEnumType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  type GraphQLEnumType,
  type GraphQLField,
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLType,
  type IntrospectionQuery,
} from "graphql";
import type { Env } from "../env";
import { cmsExecuteFor } from "../cms-dispatch";

// ---- scalar mapping ---------------------------------------------------------

const SCALAR_TS: Record<string, string> = {
  ID: "string",
  String: "string",
  ItemId: "string",
  SiteLocale: "string",
  DateTime: "string",
  Date: "string",
  Int: "number",
  Float: "number",
  Boolean: "boolean",
  JSON: "unknown",
};

/** Map a named scalar to a TS type; unknown custom scalars fall back to string. */
function scalarToTs(name: string): string {
  return SCALAR_TS[name] ?? "string";
}

// ---- type reference rendering ----------------------------------------------

/**
 * Render a GraphQL type reference to a TS type. GraphQL fields are nullable
 * UNLESS wrapped in NON_NULL, so `String` -> `string | null`, `String!` ->
 * `string`, `[BlogPostRecord!]!` -> `BlogPostRecord[]`, `[JSON!]` ->
 * `unknown[] | null`.
 */
function renderType(type: GraphQLType): string {
  return renderNullable(type, true);
}

/** `nullable` tracks whether the current position may be null (no NON_NULL wrap). */
function renderNullable(type: GraphQLType, nullable: boolean): string {
  if (isNonNullType(type)) {
    return renderNullable(type.ofType, false);
  }
  let inner: string;
  if (isListType(type)) {
    const elem = renderNullable(type.ofType, true);
    // Parenthesise unions inside the array so `(T | null)[]` is unambiguous.
    inner = /[|&]/.test(elem) ? `(${elem})[]` : `${elem}[]`;
  } else {
    inner = namedToTs(type);
  }
  return nullable ? `${inner} | null` : inner;
}

/** A named (non-list, non-nonnull) type -> its TS identifier. */
function namedToTs(type: GraphQLType): string {
  const named = type as { name?: string };
  const name = named.name ?? "unknown";
  if (isScalarType(type)) return scalarToTs(name);
  // Object / enum / input identifiers are emitted verbatim (interfaces / types).
  return name;
}

// ---- emitters ---------------------------------------------------------------

function isInternalType(name: string): boolean {
  // Introspection meta-types only. Built-in scalars are handled by the scalar
  // map and never emitted as interfaces.
  return name.startsWith("__");
}

function emitObject(type: GraphQLObjectType): string {
  const fields = type.getFields();
  const lines: string[] = [`export interface ${type.name} {`];
  for (const field of Object.values(fields)) {
    const argsDoc = renderArgsDoc(field);
    if (argsDoc) lines.push(`  /** ${argsDoc} */`);
    lines.push(`  ${memberName(field.name)}: ${renderType(field.type)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Summarise a field's GraphQL args as a JSDoc line (query fields carry these). */
function renderArgsDoc(field: GraphQLField<unknown, unknown>): string | null {
  if (!field.args.length) return null;
  const parts = field.args.map((a) => {
    const optional = isNonNullType(a.type) ? "" : "?";
    return `${a.name}${optional}: ${renderArgType(a.type)}`;
  });
  return `args — ${parts.join(", ")}`;
}

/** Render an argument type for the JSDoc summary (GraphQL type name, list-aware). */
function renderArgType(type: GraphQLType): string {
  if (isNonNullType(type)) return renderArgType(type.ofType);
  if (isListType(type)) return `${renderArgType(type.ofType)}[]`;
  const name = (type as { name?: string }).name ?? "unknown";
  if (isScalarType(type)) return scalarToTs(name);
  return name;
}

function emitInputObject(type: GraphQLInputObjectType): string {
  const fields = type.getFields();
  const lines: string[] = [`export interface ${type.name} {`];
  for (const field of Object.values(fields)) {
    // Nullable input fields are optional; NON_NULL ones are required.
    const optional = isNonNullType(field.type) ? "" : "?";
    lines.push(`  ${memberName(field.name)}${optional}: ${renderType(field.type)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function emitEnum(type: GraphQLEnumType): string {
  const values = type.getValues().map((v) => JSON.stringify(v.name));
  if (!values.length) return `export type ${type.name} = never;`;
  return `export type ${type.name} =\n  | ${values.join("\n  | ")};`;
}

/** Quote a member name if it is not a plain identifier (all CMS fields are). */
function memberName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

const HEADER = (version: number) =>
  `// Generated from the live CMS GraphQL schema (schema_version ${version}).
// Types-only module: \`import type { BlogPostRecord, Query } from "loki/schema"\`.
// Regenerated automatically whenever the CMS schema changes. Do not edit.
`;

/** Emit the full .d.ts-style TypeScript source for the schema. */
export function generateSchemaTypes(
  schema: GraphQLSchema,
  version: number,
): string {
  const typeMap = schema.getTypeMap();
  const objects: GraphQLObjectType[] = [];
  const inputs: GraphQLInputObjectType[] = [];
  const enums: GraphQLEnumType[] = [];

  for (const type of Object.values(typeMap)) {
    const name = type.name;
    if (isInternalType(name)) continue;
    if (isObjectType(type)) objects.push(type);
    else if (isInputObjectType(type)) inputs.push(type);
    else if (isEnumType(type)) enums.push(type);
  }

  // Deterministic order: Query first (the entry point the agent reads for shapes),
  // then the rest alphabetically within each group.
  const queryTypeName = schema.getQueryType()?.name;
  objects.sort((a, b) => {
    if (a.name === queryTypeName) return -1;
    if (b.name === queryTypeName) return 1;
    return a.name.localeCompare(b.name);
  });
  inputs.sort((a, b) => a.name.localeCompare(b.name));
  enums.sort((a, b) => a.name.localeCompare(b.name));

  const sections: string[] = [HEADER(version)];

  sections.push("// ---- Query root & record / object types ----");
  sections.push(objects.map(emitObject).join("\n\n"));

  if (enums.length) {
    sections.push("// ---- Enums (orderBy, status, …) ----");
    sections.push(enums.map(emitEnum).join("\n\n"));
  }

  if (inputs.length) {
    sections.push("// ---- Filter / input object types ----");
    sections.push(inputs.map(emitInputObject).join("\n\n"));
  }

  return sections.join("\n\n") + "\n";
}

// ---- introspection + versioned per-isolate cache ----------------------------

/** Read agent-cms's shared schema-version counter directly from D1. */
async function readSchemaVersion(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT "value" AS value FROM "_cms_meta" WHERE "key" = 'schema_version'`,
    ).first<{ value: number | string }>();
    const n = Number(row?.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // Table missing / read error must never take down a write or a tool call.
    return 0;
  }
}

async function introspect(env: Env, siteId: string): Promise<GraphQLSchema> {
  const result = await cmsExecuteFor(env, siteId, getIntrospectionQuery(), {}, false);
  if (result.errors && result.errors.length) {
    throw new Error(
      "Schema introspection failed: " +
        result.errors.map((e: { message: string }) => e.message).join("; "),
    );
  }
  return buildClientSchema(result.data as unknown as IntrospectionQuery);
}

// Mirror agent-cms's SCHEMA_VERSION_TTL_MS: within the TTL we trust the cache
// without even the (cheap, indexed) version read; after it we do one read and
// only rebuild the schema/types when the version actually changed.
const VERSION_TTL_MS = 3000;

interface SchemaCacheEntry {
  version: number;
  schema: GraphQLSchema;
  ts: string;
  checkedAt: number;
}

// Per-site cache: tenants must never share each other's schema/types, so every
// entry is keyed by siteId (not one module-global var).
const schemaCache = new Map<string, SchemaCacheEntry>();

/**
 * Return the live schema + its generated TS, cached per-isolate PER SITE and
 * keyed on `_cms_meta.schema_version`. Both the write-time gql validator and the
 * `schema_types` tool go through here so they share one introspection.
 */
export async function getSchemaBundle(
  env: Env,
  siteId: string,
): Promise<{ schema: GraphQLSchema; ts: string; version: number }> {
  const now = Date.now();
  const cached = schemaCache.get(siteId);
  if (cached && now - cached.checkedAt < VERSION_TTL_MS) {
    return cached;
  }
  const version = await readSchemaVersion(env);
  if (cached && cached.version === version) {
    cached.checkedAt = now;
    return cached;
  }
  const schema = await introspect(env, siteId);
  const ts = generateSchemaTypes(schema, version);
  const entry: SchemaCacheEntry = { version, schema, ts, checkedAt: now };
  schemaCache.set(siteId, entry);
  return entry;
}
