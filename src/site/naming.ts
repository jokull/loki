// agent-cms GraphQL naming rules, mirrored for the migration guard.
//
// These are a faithful copy of agent-cms's own helpers (verified against
// node_modules/agent-cms/dist/handler-*.mjs and a live introspection):
//   - model api_key `blog_post`  -> type `BlogPostRecord`
//   - root fields: `blogPost` (single), `allBlogPosts` (collection),
//                  `_allBlogPostsMeta` (meta)
//   - field api_key `hero_image` -> field `heroImage` on the model's Record type

/** snake_case api_key -> PascalCase (e.g. `blog_post` -> `BlogPost`). */
export function toTypeName(apiKey: string): string {
  return (
    apiKey.charAt(0).toUpperCase() +
    apiKey.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  );
}

/** Content model GraphQL object type name (Dato-compatible `Record` suffix). */
export function toContentTypeName(apiKey: string): string {
  return `${toTypeName(apiKey)}Record`;
}

/** snake_case api_key -> camelCase GraphQL field name. */
export function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Naive English pluralization matching agent-cms's query-name generator. */
export function pluralize(word: string): string {
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + "ies";
  }
  if (
    word.endsWith("s") ||
    word.endsWith("x") ||
    word.endsWith("z") ||
    word.endsWith("ch") ||
    word.endsWith("sh")
  ) {
    return word + "es";
  }
  return word + "s";
}

export interface ModelSurface {
  /** GraphQL object type, e.g. `BlogPostRecord`. */
  recordType: string;
  /** Collection root field, e.g. `allBlogPosts`. */
  listName: string;
  /** Single-record root field, e.g. `blogPost`. */
  singleName: string;
  /** Meta root field, e.g. `_allBlogPostsMeta`. */
  metaName: string;
  /** All Query-root entry points for this model. */
  rootFields: string[];
}

/** Compute the full GraphQL surface generated for a model api_key. */
export function modelSurface(modelApiKey: string): ModelSurface {
  const base = toTypeName(modelApiKey);
  const listName = `all${pluralize(base)}`;
  const singleName = toCamelCase(modelApiKey);
  const metaName = `_all${pluralize(base)}Meta`;
  return {
    recordType: `${base}Record`,
    listName,
    singleName,
    metaName,
    rootFields: [listName, singleName, metaName],
  };
}

export interface FieldSurface {
  /** The Record type the field lives on, e.g. `BlogPostRecord`. */
  typeName: string;
  /** The camelCase GraphQL field name, e.g. `heroImage`. */
  fieldName: string;
  /** Footprint entry `Type.field`, e.g. `BlogPostRecord.heroImage`. */
  entry: string;
}

/** Compute the GraphQL surface for a field, given its parent model api_key. */
export function fieldSurface(modelApiKey: string, fieldApiKey: string): FieldSurface {
  const typeName = toContentTypeName(modelApiKey);
  const fieldName = toCamelCase(fieldApiKey);
  return { typeName, fieldName, entry: `${typeName}.${fieldName}` };
}
