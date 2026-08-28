# Progress log

Read this first on resume, alongside `docs/M0-REPORT.md` (the verification
snapshot) and `docs/DEVIATIONS.md`/`docs/LIMITATIONS.md`. Newest first.

## 2026-08-28/29 — M0 walking skeleton + engine, from salvage, complete

**Starting state.** A provider session limit killed the previous builder
mid-flight; `6d6ab67 "wip: M0 scaffold + engine in progress - UNVERIFIED"`
was the salvage commit — `packages/schema` and `packages/engine` fully
written (very thoroughly, in retrospect) but never verified to run, and
`site/`, `worker/`, `capture/`, `scripts/`, `tests/`, `.github/`, `docs/`
either empty or package.json-only stubs. This session's job: verify the
salvage, then build everything M0 + the engine needed to actually be done.

**`30abef3` — fix: repair salvaged schema/engine so the suite actually
runs.** First `pnpm -r typecheck` and `vitest run` found the salvage had
never been executed even once:

- `tsconfig.base.json` was missing `allowImportingTsExtensions` even
  though every source file imports with explicit `.ts` extensions under
  `moduleResolution: "bundler"` — every file failed with TS5097.
- `packages/engine/test/topology.test.ts` had a mismatched-angle-bracket
  type cast, a straight syntax error (TS1005/TS1128).
- `packages/engine/test/expressions.test.ts` needed a `!` for
  `noUncheckedIndexedAccess` on a `Record<string,string>` access, same
  pattern already used elsewhere in the file.
- `packages/engine/src/normalize.ts` shipped `PORTED_FROM_JSCODE_SHA256 =
  '__SET_BY_TEST__'` — a literal placeholder never filled in. Computed the
  real sha256 of the `Normalize Lead` node's `jsCode` in
  `content/workflow.json` and set it.

After this: schema + engine typecheck clean, 27/27 existing tests pass
(previously 0 had ever run).

**`8fec460` — feat(engine): golden trace tests + fix a real
honesty-architecture bug.** `execute()` itself had never been called by
any test. Writing the first golden-trace test (one committed JSON snapshot
per scenario via vitest's `toMatchFileSnapshot`) immediately surfaced a
real bug: the `slack-revoked` scenario crashed inside `execute()`'s own
internal `RunFile.parse()` call. Root cause: the schema's cross-check
computed "did this metric/artifact happen" from whether a node carried a
`finishedAt` timestamp, not from whether it actually *succeeded* — and a
node's error path stamps `finishedAt` too (the failure has a duration).
Fixed, this would have let `ownerNotifiedMs` report a real number for a
Slack call that returned 401 — crediting a notification that never sent,
exactly the failure mode the honesty architecture exists to prevent. Fixed
in both `packages/schema/src/run.ts` (the cross-check) and
`packages/engine/src/execute.ts` (the matching computation, since the
schema recomputes from `nodes[]` and compares). Added
`packages/engine/test/execute.test.ts`: one golden trace per scenario,
determinism assertions, and scenario-semantics assertions pinning the
exact node-status sequence and the specific honesty-critical fields per
seam. 40/40 tests passing after this commit.

**`88a829c` — feat: run-generation + CI-check scripts, five committed demo
runs.** Wrote `scripts/generate-runs.ts` (`gen:runs`/`check:runs --check`),
`scripts/drift-check.ts`, `scripts/check-bindings.mjs`,
`scripts/check-secrets.mjs`. Generated the five runs
(`sim-medspa-happy/-slack-revoked/-ghl-429/-duplicate/-reply-timeout`),
all sharing one fictional lead (Alex Rivera / lip filler) and business
(Radiant Aesthetics). `sim-medspa-happy.metrics.firstTouchDispatchMs =
839` — the hero number `site/` renders. Both check scripts verified
firing on a planted violation (an AWS-key-shaped string; an env read of a
disallowed LLM-provider credential name) as well as passing clean — the
second of those two plantings is exactly why this sentence doesn't spell
the literal token out.

**`53a105a` — feat(worker): M0 Hono scaffold.** `GET /api/health` only,
zero bindings declared in `wrangler.jsonc`. `worker/test/health.test.ts`
asserts the health shape and, directly, that `POST /api/lead` 404s — "no
fake `/api/lead`" as a running test, not only a comment. 43/43 tests after
this commit.

**`8b0517a` — feat(site): M0 Astro static site.** `/` and `/demo`, zero JS,
53 KB total build. Chose an instrument-panel direction (monospace
timestamps as the organizing device, hairline rules, functional-only
color — no invented brand accent since the identity is still provisional)
deliberately unlike every named competitor's soft-gradient-card look.
Two real bugs found and fixed while building this:

- `.astro` frontmatter parses in a TSX-like mode where `value as
  Extract<typeof value, {...}>` inside a `.map()` callback is ambiguous
  with a JSX tag open (60 cascading parse errors) — restructured to
  compute plain render data before the template.
- `site/src/lib/runs.ts` resolved `content/runs/` via
  `import.meta.url`, which breaks once Vite bundles the module into
  `dist/.prerender/chunks/` (a different location than the source file) —
  switched to `process.cwd()`-relative resolution, which survives
  bundling since cwd is a process-level property.

Also found and fixed a genuine Windows CI-reliability bug: Playwright's
own `webServer` orchestration reproducibly left an orphaned `astro
preview` process holding port 4321 after teardown (a multi-level
`cmd -> pnpm -> node -> astro` process tree; pnpm's CLI wrapper exits
after spawning astro, so the PID Node's `spawn()` returned wasn't the real
server by the time cleanup ran) — replaced with `scripts/e2e.mjs`, which
asks Windows who currently owns the port after the run and kills that PID
directly. Verified clean across three consecutive `pnpm e2e` runs with an
explicit port check between each.

Manually verified in a real browser at 320px on both pages (zero
horizontal overflow; screenshots at `docs/screenshots/`), plus 7/7
Playwright assertions covering the same thing programmatically, in CI, on
every future run.

**Next commits (this same session): CI workflow, `capture/README.md`
(stubhouse contract only — n8n confirmed not locally runnable, see that
file), the docs this file lives beside, then `docs/M0-REPORT.md` with the
final `pnpm verify` output and a `main` branch cut from a green `wip/m0`.**

## What's next (M1)

Per the spec's build order: the recording (`capture/`, a real n8n capture,
the player island, an a11y pass on it) — see `capture/README.md`'s "what
M1 builds here" for the concrete plan, including which existing modules
(`packages/engine/src/stubs.ts`, `redact.ts`; `packages/schema/src/
attest.ts`) M1 should reuse rather than re-implement.
