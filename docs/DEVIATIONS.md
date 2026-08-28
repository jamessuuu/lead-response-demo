# Deviations from the spec

Every divergence between `offer1-demo-SPEC.md` and what this repo actually
does, with the reasoning. Rule: repo truth wins over any doc, but a
reviewer should never have to guess *why* the repo disagrees with the spec
it's binding against.

## identity: provisional

Spec section 12 calls for "a provisional monochrome maker's mark... in the
footer" at M1. At M0 the footer is **text-only** — "Built by James Lorenz
Santos" plus a portfolio link, no mark graphic. Two reasons: (1) M0's own
scope in this build (the walking skeleton — `/` and `/demo` as a static
table) never reaches the sales-page chrome the mark belongs on; (2) the
mark itself is genuinely undecided — `workshop/identity/makers-mark/`
holds 44 candidate SVGs and a `KEEPERS-FORM.md` that James has not yet
filled in. Rendering one of the 44 now would pre-empt a decision that
belongs to him. No `favicon.ico` exists yet for the same reason (Spec
section 16, acceptance criterion 13) — the browser's automatic
`/favicon.ico` request 404s harmlessly; see `docs/LIMITATIONS.md`.

## Run files loaded directly, not through Astro's content collection API

Spec section 3's rationale for choosing Astro is "content collections + Zod
validate the run files at build so a malformed recording cannot deploy."
`site/src/lib/runs.ts` gets the same *behavior* — `RunFile.safeParse`
throws, and `.astro` frontmatter runs in Node at build time for
`output: 'static'`, so the throw fails the build exactly the same way —
but does it with a plain Node `fs.readFileSync` + this repo's own zod v4
schema, not Astro's `content.config.ts` + `astro:content`'s `z` export.
Reason: Astro's Content Layer API re-exports its own zod instance
internally, and coupling `@lrd/schema` (zod v4, shared with the engine and
the Worker) to whatever version that happens to be — unconfirmed without
testing it live — is a version-compatibility risk for zero behavioral
gain. If a future Astro upgrade makes that coupling clearly safe, this can
switch; nothing about the run files or the schema needs to change either
way.

## `/demo` renders one run, not all five

`content/runs/` holds five committed, golden-tested runs (happy + all four
seams — Spec section 15's M0 row and this session's own build brief both
call for exactly this). Only `sim-medspa-happy` is wired into a page.
This matches the spec's own M0 acceptance line precisely — "`/` + `/demo`
rendering **one committed run** as a static table" — while the
recording-tabs / simulator / break-it-controls surface that would expose
the other four is explicitly later scope (Spec section 10, Information
architecture: tabs and break-it controls are M2/M3). The other four are
not vaporware: `packages/engine/test/golden/` golden-traces all of them,
`scripts/drift-check.ts` validates all of them against
`content/workflow.json`, and they regenerate byte-identical under
`pnpm check:runs`. They are simply not yet linked from a page.

## `astro.config.mjs` has no `site` (canonical URL)

Spec section 18's dispatcher decision is a free `*.pages.dev` subdomain
until a paying client, with the product's actual name blocked on the
identity brief (also section 18, item 1). No Pages project has been
created this session (no deploy happened at all — see the task scope this
build ran under), so there is no real URL to put here yet. Setting a
placeholder would be an invented fact the honesty architecture exists to
refuse the same way a fake `/api/lead` would be.

## Every page carries `<meta name="robots" content="noindex">`

Not named anywhere in the spec. Added because this is a walking skeleton,
not the finished sales site (that's M3), and nothing about it should
out-rank the real thing once it exists. Remove as part of the M3 launch
checklist — tracked here so it isn't forgotten silently.

## `GET /api/health` doesn't return a build SHA or ping D1

Spec section 6's API table describes the **finished** (M2+) surface:
"`GET /api/health` | build SHA + D1 ping." `worker/package.json`'s own
description already scoped M0 down to "GET /api/health only... D1 and
Turnstile arrive at M2 and are absent, not stubbed" before this session
started; the implementation matches that pre-existing scope note. M0's
`/api/health` returns an honest `{ bindings: { db: false, turnstileSecret:
false } }` instead of pretending to ping a database binding that does not
exist in `worker/wrangler.jsonc` yet.

## `pnpm e2e` doesn't use Playwright's own `webServer` option

Tooling choice, not a spec deviation, noted here because it changes how a
reviewer runs things. `scripts/e2e.mjs` builds the site and manages the
preview server's lifecycle by hand. Reason, reproduced twice while
building this: on Windows, `pnpm --filter @lrd/site preview` is a
multi-level process tree, and Playwright's `webServer` teardown (and even
a direct `taskkill /PID <spawned-pid> /T /F`) killed only the outer
wrapper it spawned, leaving the real `astro preview` process orphaned and
still bound to port 4321 — which made the *next* run fail immediately.
`pnpm e2e` (not `npx playwright test` directly) is the supported entry
point; see the comment at the top of `playwright.config.ts`.
