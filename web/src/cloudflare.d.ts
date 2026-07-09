// The Cloudflare Vite plugin provides this virtual module at build time; declare
// it for tsc. Server-only code casts `env` to the shared binding interfaces.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
