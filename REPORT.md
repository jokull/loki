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

## Needs-you (Morning TODO) — accumulating
- Apex routing cutover (loftur.app/* → loftur-web; keep /mcp, /__*, *.loftur.app → loki). Not done overnight by design.

## Bugs found + fixed
- (none yet)

## Next
- Phase 1: shared/ extraction (keep loki green) + account auth + dashboard core.
