# Loftur Bench — blind-agent DX benchmark

A repeatable adversarial DX gate: point **N blind LLM agents** at Loftur with only
the public `skill.md` + an account token, have each build a real app across the
capability surface, and collect every bug / silent-failure / confusing-error /
missing-capability / doc-gap / ergonomics wart as structured findings. Run it each
release; a rising finding count is a DX regression.

It found the first big batch (guard no-op, dead relations, gated-content leak,
node:-import 500, `[lang]` asset shadowing, typed-error gap, observability gap …) —
all now fixed. This formalizes the harness so it's one command away next time.

## What's here
- `mcp.mjs` — MCP client an agent drives (like a native client). Auth via `LOFTUR_PAT`.
- `mint.mjs` — mint N isolated account PATs (one per agent) via the admin route.
- `brief.md` — the blind-builder prompt template (`{N}` / `{PAT}` / `{TASK}`).

## Run it
1. **Mint tokens** (needs `WRITE_KEY` in `.env`):
   ```sh
   dotenvx run --quiet -f .env -- node scripts/bench/mint.mjs 6 | grep '^lftr_pat_' > /tmp/bench-pats.txt
   ```
2. **Self-test the harness** with PAT #1:
   ```sh
   LOFTUR_PAT=$(sed -n 1p /tmp/bench-pats.txt) node scripts/bench/mcp.mjs whoami
   ```
3. **Spawn the agents.** This step is LLM-driven — it needs an agent runner (Claude
   Code's Agent tool, or the Claude Agent SDK in CI). Spawn one agent per line in
   `/tmp/bench-pats.txt`, each with `brief.md` filled in (`{N}` = row, `{PAT}` = the
   token, `{TASK}` = a distinct build task). Suggested task set:
   - a1: a blog (models, tags relation, structured text, list + `/posts/[slug]`)
   - a2: a webshop (Product content + orders feature-DB + drizzle checkout serverFn)
   - a3: a live poll (realtime publish/subscribe + island + serverFn RPC)
   - a4: a members area (magic-link auth + `requireUser`/`requireRole` gating)
   - a5: integrations (contact form + email + secret + outbound fetch + upload)
   - a6: polish (npm import in a serverFn + favicon/og assets + i18n `/[lang]`)
4. **Aggregate.** Collect each agent's final JSON block, dedupe, severity-rank, and
   route each finding to loki / agent-cms / docs. That ranked list is the bench
   report; diff it against the previous run.

## Notes
- Agents create real throwaway `bench-a*.loftur.app` sites (evidence). Reap later.
- Isolated accounts (`bench-i@bench.loftur.app`) keep each agent's `list_sites` clean.
- Keep the harness (`mcp.mjs`) as the ONLY crutch — the point is testing *authoring*
  DX, not MCP transport (a real Claude Code / Openclaw has native MCP).
