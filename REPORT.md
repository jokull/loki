# Loftur overnight run — REPORT

Branch `feat/loftur-web` (pushed). Roadmap = PLAN.md. Everything below is deployed
and blind-tested against the LIVE workers. **Nothing touches the prod apex routing**
(that's the one morning step). Re-run all tests any time: `pnpm smoke` (needs WRITE_KEY
via dotenvx; `MAIL=1` to include real email sends).

## TL;DR

Shipped a second worker — **`loftur-web`** (TanStack Start) — with a full **account
dashboard**, plus a marketing/docs site, and extended the **loki** runtime with five
new site capabilities (email, roles, logs, uploads) and DX tooling. 9 feature commits,
each verified by a blind end-to-end test. loki keystone (auth/secrets/outbound) stayed
green (13–14/14) through every change.

Live now:

- **https://loftur-web.solberg.workers.dev** — landing, /docs, /changelog, /login, /dashboard
- **loki** (loftur.app + \*.loftur.app) — all new capabilities in the site runtime

## Done, by phase

- **Phase 0 — scaffold** ✅ pnpm workspace (shared/, web/); TanStack Start on Workers, SSR 200.
- **Phase 1 — account dashboard** ✅ shared/ extraction (crypto+data+account; loki re-exports,
  stayed green). Passwordless OWNER sign-in (loftur_account cookie). Dashboard: my sites,
  **owner-key rotation/recovery** (fixes orphaned sites), editor-token + secret management,
  claim-new-site. Cross-worker shared SECRETS_KEY verified. e2e 9/9.
- **Phase 2 — marketing + docs** ✅ landing (hero/how-it-works/features/CTA), /docs, /changelog.
- **Phase 3 — observability** ✅ per-site `_logs` ring; render + serverFn errors captured;
  `env.LOG.write`; `site_logs` MCP tool. e2e 5/5.
- **Phase 4 — capabilities**: ✅ `env.MAIL` (transactional email), ✅ end-user **roles**
  (`user.role` + set_user_role/list_users), ✅ `env.UPLOADS` (R2 uploads + /\_\_uploads),
  ✅ **i18n** (docs-only — agent-cms exposes `locale: SiteLocale` on every field; documented
  the query + `[lang]` route pattern in site_help). Each capability blind-tested.
- **Phase 5 — templates** ✅ `scaffold_template` + members & link-in-bio starters (publish clean).
- **Phase 6 — hardening**: ✅ per-site outbound `allowedHosts` allowlist (403 on unlisted).
- **Phase 7 — DX** (partial): ✅ `site_status` health tool, ✅ consolidated `scripts/smoke/`
  suite (auth·web·roles·logs·uploads·templates·allowlist; +mail with MAIL=1).

## Smoke suite — all green

`pnpm smoke` → 7/7 suites: auth 13/13 · web 9/9 · roles 5/5 · logs 5/5 · uploads 3/3 ·
templates 7/7 · allowlist 3/3 (+ mail 2/2 with MAIL=1).

## NEEDS YOU (morning)

1. **Review** https://loftur-web.solberg.workers.dev (dashboard + marketing — design/copy).
2. **Apex cutover** (only when happy): zone routes so `loftur.app/mcp` + `loftur.app/__*`
   stay on `loki`, `loftur.app/*` → `loftur-web`, `*.loftur.app/*` stays on `loki`. Then set
   loftur-web `ENVIRONMENT=production` (staging currently returns dev magic links in responses).
3. **Merge** `feat/loftur-web` when reviewed.

## Notes / decisions taken autonomously

- Rotated the shared `SECRETS_KEY` onto both workers (invalidated only test data — no real users).
- `loftur-web` deployed to workers.dev only; no DNS/apex changes.
- Added loki admin routes `/__accountmagic` (+ existing `/__authmagic`), WRITE_KEY-gated, for tests.
- RUNTIME_VERSION r13→r15 (user injection r14, logs r15).

## NOT done (scoped for next — each has a real blocker, better with you awake)

- **cron** (per-site scheduled serverFns): fan-out would load every tenant isolate on a
  schedule — real compute/cost implications; wants a design decision.
- **analytics** (env.ANALYTICS): needs an Analytics Engine binding added + a query token for
  the dashboard chart.
- **rate-limits** for email/uploads (abuse): needs a per-site counter store (DO/KV). Note the
  allowlist already lets a site cap egress hosts; SSRF-to-metadata is largely N/A on Workers.
- **pull/push-to-disk** (Phase 7): HTTP tarball checkout + push pipeline — substantial.
- **SEO auto-gen**: the agent can already write sitemap.xml/rss.xml/robots.txt as routes; a
  platform auto-generator needs page/URL conventions — low value.
- **Dashboard "Logs" tab**: needs a web→TenantFeatureDB read path; the `site_logs` MCP tool
  already covers the building agent.

## Bugs/frictions resolved (no product bugs found)

getRouter export name · pnpm allowBuilds placeholders · shared D1/BufferSource lib-portability ·
/login required-search · TanStack route codegen writes routeTree mid-build (build twice after
adding routes).
