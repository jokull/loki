// Migration guard: expand/contract enforcement for destructive schema ops.
//
// Called before forwarding destructive CMS schema operations
// (delete_model, delete_field, update_model, update_field) to agent-cms — from
// BOTH the merged MCP endpoint (src/mcp.ts) and the forwarded REST seam
// (src/index.ts). When it returns { allowed: false }, the caller turns the
// reason into an MCP tool error / a 409 JSON response instead of forwarding.
//
// Enforcement: map the target model/field to its GraphQL surface (agent-cms
// naming rules, see ./site/naming) and reject a *contract* op (delete, or a
// BREAKING update = api_key rename / field_type change) if the currently
// published version's Footprint references that surface. Non-breaking updates
// (validators, labels, hints, appearance) always pass. The rejection reason
// names the exact footprint entries + published version id and teaches the
// expand -> backfill -> publish -> contract sequence.

import type { Env } from "./env";
import type { Footprint } from "./site/publish";
import { fieldSurface, modelSurface } from "./site/naming";
import { getPublishedVersionId, getVersion } from "./site/store";

export const GUARDED_TOOLS = new Set([
  "delete_model",
  "delete_field",
  "update_model",
  "update_field",
]);

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// ---- normalized operation descriptor ----------------------------------------

type SchemaOp =
  | { kind: "model"; op: "delete" | "update"; ref: string; newApiKey?: string }
  | {
      kind: "field";
      op: "delete" | "update";
      ref: string;
      newApiKey?: string;
      newFieldType?: string;
    };

// ---- D1 resolution (id OR api_key -> canonical api_keys) ---------------------

interface ResolvedModel {
  id: string;
  api_key: string;
}

interface ResolvedField {
  id: string;
  api_key: string;
  field_type: string;
  model_api_key: string;
}

/** Resolve a model reference (id or api_key) to its row. */
async function resolveModel(
  env: Env,
  ref: string,
): Promise<ResolvedModel | null> {
  return await env.DB.prepare(
    `SELECT id, api_key FROM models WHERE id = ?1 OR api_key = ?1 LIMIT 1`,
  )
    .bind(ref)
    .first<ResolvedModel>();
}

/** Resolve a field reference (id or api_key) to its row + parent model api_key. */
async function resolveField(
  env: Env,
  ref: string,
): Promise<ResolvedField | null> {
  return await env.DB.prepare(
    `SELECT f.id AS id, f.api_key AS api_key, f.field_type AS field_type,
            m.api_key AS model_api_key
       FROM fields f
       JOIN models m ON m.id = f.model_id
      WHERE f.id = ?1 OR f.api_key = ?1
      LIMIT 1`,
  )
    .bind(ref)
    .first<ResolvedField>();
}

// ---- published footprint ----------------------------------------------------

interface PublishedFootprint {
  versionId: number;
  footprint: Footprint;
}

async function loadPublishedFootprint(
  env: Env,
): Promise<PublishedFootprint | null> {
  const versionId = await getPublishedVersionId(env);
  if (versionId == null) return null;
  const version = await getVersion(env, versionId);
  if (!version || !version.footprint) return null;
  let footprint: Footprint;
  try {
    footprint = JSON.parse(version.footprint) as Footprint;
  } catch {
    return null;
  }
  // Defensive: tolerate partial/legacy footprints.
  footprint.fields ??= [];
  footprint.types ??= [];
  footprint.rootFields ??= [];
  return { versionId, footprint };
}

// ---- instructive rejection message ------------------------------------------

function contractSequence(
  targetKind: "field" | "model",
  targetLabel: string,
): string {
  const addNew =
    targetKind === "field"
      ? "add the replacement field (create_field) so old and new coexist"
      : "add the replacement model/field (create_model / create_field) so old and new coexist";
  return [
    `Follow the expand -> contract migration order instead of contracting first:`,
    `  1. EXPAND: ${addNew}.`,
    `  2. BACKFILL: publish content into the new shape so nothing is lost.`,
    `  3. UPDATE SITE CODE: edit the site's routes/queries with site_write so they no longer reference ${targetLabel}, then call publish_site. This snapshots a NEW published version whose footprint drops that reference.`,
    `  4. CONTRACT: retry this operation. Once the published footprint no longer references ${targetLabel}, the guard allows it.`,
  ].join("\n");
}

// ---- core checks ------------------------------------------------------------

async function checkFieldContract(
  env: Env,
  field: ResolvedField,
): Promise<GuardResult> {
  const published = await loadPublishedFootprint(env);
  if (!published) return { allowed: true };

  const { entry } = fieldSurface(field.model_api_key, field.api_key);
  if (!published.footprint.fields.includes(entry)) {
    return { allowed: true };
  }

  const reason = [
    `The published site (version v${published.versionId}) still queries field "${field.api_key}" ` +
      `(GraphQL ${entry}) on model "${field.model_api_key}".`,
    ``,
    `Published version v${published.versionId} footprint references:`,
    `  - ${entry}`,
    ``,
    `Removing or renaming this field now would break the live site's GraphQL queries.`,
    contractSequence("field", `"${entry}"`),
  ].join("\n");
  return { allowed: false, reason };
}

async function checkModelContract(
  env: Env,
  model: ResolvedModel,
): Promise<GuardResult> {
  const published = await loadPublishedFootprint(env);
  if (!published) return { allowed: true };

  const surface = modelSurface(model.api_key);
  const typeHit = published.footprint.types.includes(surface.recordType);
  const rootHits = surface.rootFields.filter((f) =>
    published.footprint.rootFields.includes(f),
  );
  if (!typeHit && rootHits.length === 0) {
    return { allowed: true };
  }

  const matched: string[] = [];
  if (typeHit) matched.push(`type ${surface.recordType}`);
  for (const rf of rootHits) matched.push(`root field ${rf}`);

  const reason = [
    `The published site (version v${published.versionId}) still uses model "${model.api_key}" ` +
      `(GraphQL type ${surface.recordType}; root fields ${surface.rootFields.join(", ")}).`,
    ``,
    `Published version v${published.versionId} footprint references:`,
    ...matched.map((m) => `  - ${m}`),
    ``,
    `Removing or renaming this model now would break the live site's GraphQL queries.`,
    contractSequence("model", `model "${model.api_key}" (${matched.join(", ")})`),
  ].join("\n");
  return { allowed: false, reason };
}

async function guardOp(env: Env, opDesc: SchemaOp): Promise<GuardResult> {
  if (opDesc.kind === "model") {
    const model = await resolveModel(env, opDesc.ref);
    // Unknown target: let agent-cms produce the authoritative "not found".
    if (!model) return { allowed: true };
    if (opDesc.op === "update") {
      const rename =
        opDesc.newApiKey != null && opDesc.newApiKey !== model.api_key;
      if (!rename) return { allowed: true }; // non-breaking update
    }
    return await checkModelContract(env, model);
  }

  const field = await resolveField(env, opDesc.ref);
  if (!field) return { allowed: true };
  if (opDesc.op === "update") {
    const rename =
      opDesc.newApiKey != null && opDesc.newApiKey !== field.api_key;
    const retype =
      opDesc.newFieldType != null && opDesc.newFieldType !== field.field_type;
    if (!rename && !retype) return { allowed: true }; // non-breaking update
  }
  return await checkFieldContract(env, field);
}

// ---- public entry points ----------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** MCP seam: guard a forwarded CMS tool call by (toolName, arguments). */
export async function guardSchemaOp(
  toolName: string,
  args: unknown,
  env: Env,
): Promise<GuardResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "delete_model": {
      const ref = str(a.modelId);
      if (!ref) return { allowed: true };
      return guardOp(env, { kind: "model", op: "delete", ref });
    }
    case "update_model": {
      const ref = str(a.modelId);
      if (!ref) return { allowed: true };
      return guardOp(env, {
        kind: "model",
        op: "update",
        ref,
        newApiKey: str(a.apiKey),
      });
    }
    case "delete_field": {
      const ref = str(a.fieldId);
      if (!ref) return { allowed: true };
      return guardOp(env, { kind: "field", op: "delete", ref });
    }
    case "update_field": {
      const ref = str(a.fieldId);
      if (!ref) return { allowed: true };
      return guardOp(env, {
        kind: "field",
        op: "update",
        ref,
        newApiKey: str(a.apiKey),
        // field_type is not exposed by update_field today; guarded defensively.
        newFieldType: str(a.fieldType) ?? str(a.field_type),
      });
    }
    default:
      return { allowed: true };
  }
}

/** Describe a forwarded REST schema op, or null if this request isn't one. */
export interface RestSchemaOp {
  descriptor: SchemaOp;
}

/**
 * REST seam: classify a `/api/models...` request into a guarded op.
 * Returns null for non-guarded requests (GET/POST, other paths).
 * `body` is the parsed JSON PATCH payload (ignored for DELETE).
 */
export function classifyRestSchemaOp(
  method: string,
  pathname: string,
  body: unknown,
): SchemaOp | null {
  const m = method.toUpperCase();
  if (m !== "DELETE" && m !== "PATCH") return null;

  // /api/models/:id/fields/:fieldId
  const fieldMatch = /^\/api\/models\/([^/]+)\/fields\/([^/]+)\/?$/.exec(
    pathname,
  );
  if (fieldMatch) {
    const ref = decodeURIComponent(fieldMatch[2]);
    if (m === "DELETE") return { kind: "field", op: "delete", ref };
    const b = (body ?? {}) as Record<string, unknown>;
    return {
      kind: "field",
      op: "update",
      ref,
      newApiKey: str(b.apiKey),
      newFieldType: str(b.fieldType) ?? str(b.field_type),
    };
  }

  // /api/models/:id
  const modelMatch = /^\/api\/models\/([^/]+)\/?$/.exec(pathname);
  if (modelMatch) {
    const ref = decodeURIComponent(modelMatch[1]);
    if (m === "DELETE") return { kind: "model", op: "delete", ref };
    const b = (body ?? {}) as Record<string, unknown>;
    return { kind: "model", op: "update", ref, newApiKey: str(b.apiKey) };
  }

  return null;
}

/** Run the guard for a classified REST op descriptor. */
export async function guardRestSchemaOp(
  env: Env,
  descriptor: SchemaOp,
): Promise<GuardResult> {
  return guardOp(env, descriptor);
}
