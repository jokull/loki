// Per-site secret store. The CRUD + encryption now lives in the shared workspace
// package (so loftur-web can manage secrets too); this file re-exports it and
// keeps the loki-only SecretsEntrypoint capability handed to site isolates.
//
// A secret is plaintext to the SITE'S OWN code by design (env.SECRETS.get) — it
// needs the key to call the API; cross-tenant isolation holds because the
// entrypoint is bound with that site's siteId in props and reads only its rows.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { getSecret, listSecretNames } from "shared/data";
import { DEFAULT_SITE_ID } from "./site/store";

export {
  setSecret,
  getSecret,
  listSecretNames,
  deleteSecret,
  validateSecretName,
} from "shared/data";

/**
 * Per-site secret capability handed to the site isolate as `env.SECRETS`. Only
 * `get`/`names` are exposed to site code — setting/deleting is an owner action,
 * not something the running site can do to itself.
 */
export class SecretsEntrypoint extends WorkerEntrypoint<Env, { siteId?: string }> {
  async get(name: string): Promise<string | null> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    return getSecret(this.env, siteId, name);
  }

  async names(): Promise<string[]> {
    const siteId = this.ctx.props?.siteId ?? DEFAULT_SITE_ID;
    return (await listSecretNames(this.env, siteId)).map((s) => s.name);
  }
}
