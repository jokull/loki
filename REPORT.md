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
- **loki** (loftur.app + *.loftur.app) — all new capabilities in the site runtime

## Done, by phase
- **Phase 0 — scaffold** ✅ pnpm workspace (shared/, web/); TanStack Start on Workers, SSR 200.
- **Phase 1 — account dashboard** ✅ shared/ extraction (crypto+data+account; loki re-exports,
  stayed green). Passwordless OWNER sign-in (loftur_account cookie). Dashboard: my sites,
  **owner-key rotation/recovery** (fixes orphaned sites), editor-token + secret management,
  claim-new-site. Cross-worker shared SECRETS_KEY verified. e2e 9/9.
- **Phase 2 — marketing + docs** ✅ landing (hero/how-it-works/features/CTA), /docs, /changelog.
- **Phase 3 — observability** ✅ per-site `_logs` ring; render + serverFn errors captured;
  `env.LOG.write`; `site_logs` MCP tool. e2e 5/5.
- **Phase 4 — capabilities** (partial): ✅ `env.MAIL` (transactional email), ✅ end-user
  **roles** (`user.role` + set_user_role/list_users), ✅ `env.UPLOADS` (R2 uploads +
  /__uploads serving). Each blind-tested.
- **Phase 7 — DX** (partial): ✅ `site_status` health tool, ✅ consolidated `scripts/smoke/`
  suite (auth·web·mail·roles·logs·uploads).

## Smoke suite — all green
auth 13/13 (14 with mail) · web 9/9 · roles 5/5 · logs 5/5 · uploads 3/3 · mail 2/2.

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

## NOT done (scoped for next — see PLAN.md)
- Phase 4: i18n (needs agent-cms locale API confirmation), cron (scheduled fan-out is heavy +
  cost), analytics (needs Analytics Engine binding), SEO auto-gen (agent can already write
  sitemap/rss as routes — low platform value).
- Phase 5: templates / `scaffold_template`.
- Phase 6: hardening (outbound allowlist/rate-limits — note: SSRF-to-metadata is largely N/A
  on Workers; the real gap is rate-limiting email/uploads, which needs a counter store).
- Phase 7: pull/push-to-disk.
- Dashboard "Logs" tab (needs web→TenantFeatureDB read path; site_logs MCP tool covers the agent).

## Bugs/frictions resolved (no product bugs found)
getRouter export name · pnpm allowBuilds placeholders · shared D1/BufferSource lib-portability ·
/login required-search · TanStack route codegen writes routeTree mid-build (build twice after
adding routes).
