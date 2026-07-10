# Architecture decisions

## ADR-001 — No bundler: JIT transpile + native ESM, not a build step

**Status:** accepted (2026-07-09)

### Context

Loki lets an agent manage a whole site at runtime: code lives in D1, is
transpiled per-file with sucrase on write, and served as native ES modules with
import maps. As we added islands, form actions, realtime, and typed server
functions, the natural question arose: are we reinventing TanStack Start, and
should we adopt a framework that already provides islands, dynamic bundling, and
a `"use server"` / `"use client"` split?

### The landscape (why nothing drops in)

Every islands/RSC framework assumes an **ahead-of-time build**:

- **TanStack Start** — Vite build-time; `createServerFn` server functions are
  addressed by IDs a bundler generates. An app framework for a human in a repo
  who runs a build and deploys.
- **`"use server"` / `"use client"`** is a _compiler_ feature — implemented by
  bundler plugins (Next/Turbopack, experimental Vite RSC, Parcel RSC, Waku).
  The compiler is what extracts server-function bodies and replaces them with
  client references.
- **HonoX** — islands on Hono, runs on Cloudflare Workers (our runtime), but is
  Vite-build-time. Right runtime, wrong model.
- **Deno Fresh** — the one framework sharing our DNA: no build step, JIT
  transpile, islands. But Deno-runtime and a filesystem project, not "modules in
  a database mutated over MCP." Right model, wrong runtime.

No framework targets "site code lives in a database and an agent rewrites it at
runtime with no repo and no build." Some hand-rolling is inherent to the idea.

### Decision

**Stay no-bundler (Path A).** Keep JIT per-file transpile + native ESM + import
maps. Make the server/client boundary an _explicit, enforced convention_ rather
than a compiler-derived one:

- A **serverFn** module is server-only. Its browser build is _synthesized_ from
  its serverFn exports — a stub per export keyed by a stable id + method — so
  handler/validator/gql source never ships to the client. A serverFn module that
  also exports a non-serverFn value is rejected at write/publish (its value would
  be dropped from the synthesized client build). This is `"use server"` as a
  convention with a guardrail instead of a compiler pass.
- Types (`loki/schema`) are generated from the live GraphQL SDL on demand and
  used only as `import type` (erased at transpile). GraphQL is validated at write
  time and hard-gated at publish — the runtime-native equivalent of type-checking
  without an IDE or codegen watcher.

We borrow the _ergonomics_ of TanStack Start / RSC (serverFn ≈ createServerFn,
islands ≈ client components, typed boundary) on purpose — they are the best API
designs available — while rejecting the _machinery_ (a bundler), which we cannot
share because ours is bundler-free by design.

### Rejected alternative (Path B) — esbuild-wasm dynamic bundling at publish

Running a real bundler inside the Worker at publish would give code-splitting,
tree-shaking (which would strip the serverFn handler leak for free), and a
directive-style split from a mature tool. Rejected as the _core model_ because:
the moment a heavyweight bundler is mandatory, Loki converges on "just use
TanStack Start in a repo," eroding its only differentiator — no repo, no build,
agent-in-the-loop. Publishes would also get heavier and more fragile, and most
RSC transforms assume Node/Vite, not workerd.

Kept as a **future, opt-in optimization**: esbuild-wasm at publish for real
code-splitting of a heavy island, or as a more robust way to implement the
server/client split (bundle the client island graph, dead-code-eliminate server
handlers). A v2 hardening, not a rewrite.

### Consequences

- Publishes stay instant; the runtime stays comprehensible; no heavy toolchain
  in the Worker.
- We hand-roll islands/RPC/split and must be disciplined. The one real cost seen
  so far — serverFn handler source leaking to the browser — is precisely the job
  an RSC compiler does for free, and is why the server/client boundary is now a
  first-class enforced concept (client-stub synthesis + the mixed-export guard).
- No true RSC and no automatic code-splitting/tree-shaking until/unless Path B's
  opt-in bundling lands.

## ADR-002 — Known risks for autonomous / cloud agent runs

**Status:** noted, to address when the hosted/cloud-agent product is built (2026-07-09)

Surfaced while spiking an in-Worker shell (`just-bash` over the D1 draft; since merged to `main`):

1. **Destructive DB recovery must not be autonomous.** During the spike an agent
   recovered from its own bug by running a **D1 Time Travel restore** on the
   production `loki-cms` database — a database-wide revert. Safe only because this
   is a single-user demo DB. For real data this is unacceptable unattended.
   **Decision:** when Loki gains hosted/cloud agent runs, destructive recovery
   (Time Travel restores, bulk deletes, schema drops beyond the migration guard)
   must require explicit human confirmation. The migration guard + immutable
   versions + rollback are the safe, reversible primitives agents should use
   instead. Not building the rail now; recorded as a gating requirement.

2. **`site_versions` stores compiled output, not source.** ✅ RESOLVED (2026-07-09,
   migration 0006). `publish_site` now snapshots the exact authored source
   (`site_versions.source_bundle`, path → source) alongside the compiled bundle, so
   a version row fully describes its tree (source + compiled + client stubs +
   immutable R2 asset blobs). `restoreDraftFromVersion` reconstructs a byte-faithful
   working copy from it; `rollback_site` checks out a version (live + draft) and
   `reset_site` (shell) discards the draft back to published — both source-faithful.
   v13 was backfilled (draft == v13 at migration time). Unblocks `pull`/`push`.
