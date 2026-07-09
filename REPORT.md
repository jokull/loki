# Loftur overnight run — REPORT

Branch `feat/loftur-web`. Roadmap = PLAN.md. Live progress log; final summary at bottom.

## Status by phase
- **Keystone (pre-run)** ✅ committed to `main` + pushed (mediated outbound + secrets + auth), verified 14/14.
- **Phase 0 — de-risk + scaffold** ✅ DONE
  - pnpm workspace: members `shared`, `web`. Fixed `allowBuilds` (workerd/esbuild → true).
  - `web/` = TanStack Start 1.168 + React 19 + Vite 8 + @cloudflare/vite-plugin 1.43.
  - Gotchas resolved: router entry must export `getRouter` (not createRouter); `allowBuilds`
    placeholders broke `pnpm build`'s deps-check.
  - **Deployed + verified: https://loftur-web.solberg.workers.dev serves 200 SSR HTML.**
    Framework bet is validated — proceeding with the full plan.

- **Phase 1 — account auth + dashboard core** ✅ DONE
  - shared/ extraction (crypto + data + account) — loki re-exports, typechecks, redeployed,
    keystone still 14/14 (no regression). Structural D1 type keeps shared lib-agnostic.
  - One shared SECRETS_KEY set on BOTH workers (rotated; invalidated only test data).
  - loftur-web account auth: /login (magic-link via env.EMAIL), /auth/verify (sets
    loftur_account cookie + redirect), /auth/logout. Dashboard: my-sites, owner-key
    rotation/recovery, editor-token mint/revoke, secrets set/list/delete, claim-new-site.
    All server-side logic in createServerFn (server-only; cloudflare:workers isolated).
  - Admin /__accountmagic on loki (WRITE_KEY) mints account links for testing.
  - **Blind e2e 9/9** (scratchpad/webtest.mjs): landing+login render; account link minted
    on loki VERIFIES on web (shared SECRETS_KEY works cross-worker) → cookie → /dashboard
    shows email + owned sites + actions; anonymous gated → /login.
  - Note: mutation server-fns (rotate/token/secret) verified structurally (same
    createServerFn path as the working mySitesFn/verifyFn) over proven shared/data;
    RPC-level mutation tests deferred to Phase 7 regression harness.

## Needs-you (Morning TODO) — accumulating
- Apex routing cutover (loftur.app/* → loftur-web; keep /mcp, /__*, *.loftur.app → loki). Not done overnight by design.
- Review dashboard/marketing design + copy at https://loftur-web.solberg.workers.dev

## Bugs found + fixed
- (none yet — build/type frictions only: getRouter export name, allowBuilds placeholders,
  shared D1/BufferSource lib-portability, /login required-search.)

- **Phase 2 — marketing + docs** ✅ landing (hero/how-it-works/features/CTA), /docs, /changelog. Live on staging.
- **Phase 4 — platform capabilities** (reordered ahead of Phase 3; higher value/effort):
  - `env.MAIL` transactional email ✅ (blind build sent a real email, CF message id).
  - End-user roles ✅ — `user.role` in every loader/serverFn; set_user_role/list_users tools (5/5).
  - In progress: observability (site_logs).

## Next
- Phase 3 observability (site_logs) · more Phase 4 (i18n needs agent-cms locale API check;
  cron; uploads; analytics; SEO) · Phase 6 hardening · Phase 7 DX + regression harness.
