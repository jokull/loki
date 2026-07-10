import { defineConfig } from "vite-plus";

// Vite+ toolchain config (root). Drives `vp lint` (oxlint, type-aware) and
// `vp fmt` (oxfmt) across the workspace. The apps themselves build via wrangler
// (loki) and web/vite.config.ts (loftur-web) — this file is tooling only.
const GENERATED = [
  "**/worker-configuration.d.ts",
  "**/routeTree.gen.ts",
  "src/vendor/**",
  "**/*.gen.ts",
];

export default defineConfig({
  lint: {
    // No warnings — the enabled rules (correctness + type-aware) are all errors.
    // pedantic/style/perf stay off: they're stylistic opinion, not bugs, and would
    // bury real findings under thousands of nits.
    categories: { correctness: "error" },
    // typeAware: type-informed lint rules. typeCheck: tsgolint's fast type-checker
    // (a much quicker `tsc --noEmit`) surfaced inline as diagnostics.
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: GENERATED,
  },
  fmt: {
    ignorePatterns: GENERATED,
  },
});
