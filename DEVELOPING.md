# Developing loftur + agent-cms in lockstep

loki bundles [`agent-cms`](https://github.com/jokull/agent-cms) (its own repo at
`../agent-cms`, published to npm). They're tight partners, so you can develop
against a **local** agent-cms and cut releases without an interactive OTP.

## Local dev loop (edit agent-cms, see it in loki immediately)

Point loki at your local checkout and run agent-cms's watcher — no publish needed:

```sh
pnpm cms:link                       # agent-cms -> link:../agent-cms

# in two tmux panes:
(cd ../agent-cms && pnpm dev)       # tsdown --watch: rebuilds dist on save
pnpm dev                            # loki wrangler dev (picks up the rebuilt dist)
```

Edit `../agent-cms/src` → tsdown rebuilds `dist` → loki's dev worker uses it.

When you're done, restore the published dependency **before committing**:

```sh
pnpm cms:unlink                     # agent-cms -> ^<latest published>
```

A pre-commit hook (`.githooks/pre-commit`, wired up by the `prepare` script)
blocks any commit while `agent-cms` is still a `link:` — so a local link never
lands in git.

## Cutting an agent-cms release (no OTP)

Releases publish from CI via **npm Trusted Publishing (OIDC)** — no token, no 2FA:

```sh
cd ../agent-cms
# fix, add a test, then:
pnpm typecheck && pnpm test:run && pnpm lint
pnpm version patch -m "Release v%s"
git push --follow-tags                # tag push triggers .github/workflows/release.yml
```

One-time setup on npmjs.com (account owner): **agent-cms → Settings → Trusted
Publisher → GitHub Actions**, repo `jokull/agent-cms`, workflow `release.yml`.

## Adopting a new agent-cms release in loki

```sh
pnpm cms:use 0.4.4                   # or `pnpm cms:unlink` for the latest
```

This bumps `package.json`, adds the version to `pnpm-workspace.yaml`'s
`minimumReleaseAgeExclude` (so a fresh publish isn't blocked by the supply-chain
age policy), and reinstalls. Then `pnpm deploy` + `pnpm smoke`.
