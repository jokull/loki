// Migration guard seam (task 4 fills the body).
//
// Called before forwarding destructive CMS schema operations
// (delete_model, delete_field, update_model, update_field) to agent-cms.
// When it returns { allowed: false }, the merged MCP endpoint turns the reason
// into an MCP tool error instead of forwarding.
//
// The guard's job (task 4) is expand→contract enforcement: map the target
// model/field api_keys to GraphQL type/field names (agent-cms naming rules:
// snake_case -> camelCase fields / PascalCase types, `allX` collections) and
// reject if the currently published version's footprint (or any unexpired
// preview) references them. The footprint format it consumes is
// `Footprint` from ./site/publish.ts: { fields: ["Type.field"], types: [...],
// rootFields: [...] }, stored JSON-encoded on each site_versions row.

import type { Env } from "./env";

export const GUARDED_TOOLS = new Set([
  "delete_model",
  "delete_field",
  "update_model",
  "update_field",
]);

export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function guardSchemaOp(
  _toolName: string,
  _args: unknown,
  _env: Env,
): Promise<GuardResult> {
  // TASK 4: implement footprint-based expand/contract enforcement here.
  // For now, always allow.
  return { allowed: true };
}
