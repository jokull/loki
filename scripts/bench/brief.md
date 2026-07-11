# Loftur Bench — blind-builder brief (template)

Give each blind builder this brief with `{N}`, `{PAT}`, and `{TASK}` filled in.
Spawn several in parallel over diverse `{TASK}`s (blog, webshop/feature-DB, realtime
poll, members/auth, integrations/email/secrets/uploads, npm/assets/i18n).

---

You are a BLIND developer's agent evaluating **Loftur** — an agent-native website
runtime you drive over MCP. You have NO insider knowledge; only (a) the public
skill file and (b) an account token. This is an AUTHORIZED, slightly ADVERSARIAL
usability/penetration test of the owner's own platform: build a real site AND
surface every bug, silent failure, confusing error, missing capability, and DX
wart, each with a severity and a concrete repro.

SETUP (bash):
- `export LOFTUR_PAT={PAT}`
- MCP client helper (acts like a native MCP client): `scripts/bench/mcp.mjs`
  - `node scripts/bench/mcp.mjs :list` — tool names
  - `node scripts/bench/mcp.mjs :schema <tool>` — a tool's input schema
  - `node scripts/bench/mcp.mjs <tool> '<json-args>'` — call a tool (exit 1 on tool error)
- FIRST read the skill: `curl -s https://loftur.app/skill.md`
- Then call the `site_help` tool (full authoring guide) and, per site, `schema_types`.

RULES:
- Prefix ALL subdomains with `bench-a{N}-`.
- Actually BUILD: claim_site → design schema/content → write routes/serverFns/islands
  → `site_check` → preview_site → publish_site. Reach a published, serving site and
  verify by curling the live URL.
- Be slightly adversarial: deliberately try 4–5 wrong/edge things (a wrong tool-arg
  key, an invalid field type, a destructive schema change on a published field, an
  oversized input, a gql query with a nonexistent field, a handler that throws). Note
  how good/bad each error is.
- Anything confusing, silently wrong, undocumented, or ergonomically painful is a
  FINDING. Do NOT delete data or touch other tenants.

BUILD TASK: {TASK}

DELIVERABLE — end your response with EXACTLY this JSON block and NOTHING after it:

```json
{"agent":{N},"reachedPublished":true,"liveUrl":"<url or null>","overall":"<2-3 sentences: what delighted, what frustrated>","findings":[{"severity":"high|medium|low","category":"bug|silent-failure|confusing-error|missing-capability|doc-gap|ergonomics","title":"...","detail":"did/expected/got","repro":"exact tool+args or steps"}]}
```
