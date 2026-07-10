// `.md` files import as their raw text — see the `Text` module rule in
// wrangler.jsonc (loki bundles SKILL.md and serves it at /skill.md).
declare module "*.md" {
  const content: string;
  export default content;
}
