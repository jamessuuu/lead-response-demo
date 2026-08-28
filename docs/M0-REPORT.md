# M0 report

Real output from this milestone's final verification run. Every number
below was measured, not estimated — the exact command is given so it can
be reproduced. Commit at time of writing: `87eb7e4` on `wip/m0` (8 commits
since the salvaged `6d6ab67`, resuming from a provider-limit interruption —
see `docs/PROGRESS.md` for the full log).

## Verdict

`pnpm verify` (typecheck → unit+golden tests → check:runs → check:drift →
check:bindings → check:secrets → build → e2e) **exits 0.** Every gate the
CI workflow (`.github/workflows/ci.yml`) runs was run locally, in the same
order, immediately before writing this report.

```
$ pnpm verify
...
EXIT CODE: 0
```

Not verified this session, out of scope by explicit instruction (local
commits only; no remote, no push, no deploy): CI actually green **on
GitHub Actions itself** (BATCH-2-STANDARDS.md's own rule — "local green is
not CI green" — applies; this repo has no remote yet to test it against),
and anything about a deployed artifact (Lighthouse, a live URL returning
200, a11y against a running interface). All explicitly named as
outstanding in `docs/LIMITATIONS.md`.

## Pipeline output, gate by gate

### Typecheck — `pnpm typecheck`

`tsc -p tsconfig.json` (root: `scripts/`, `tests/e2e/`,
`playwright.config.ts`) then `pnpm -r --if-present typecheck` across all
five buildable workspace packages. Zero errors in `packages/schema`,
`packages/engine`, `worker`, `site` (`astro check`: **0 errors, 0
warnings, 0 hints** across 7 `.astro`/`.ts` files), and the root.

### Unit + golden trace tests — `pnpm test`

```
 Test Files  5 passed (5)
      Tests  43 passed (43)
```

Breakdown: `worker/test/health.test.ts` (3), `packages/engine/test/
expressions.test.ts` (9), `normalize.test.ts` (9), `topology.test.ts` (9),
`execute.test.ts` (13 — one golden-trace snapshot per scenario at
`packages/engine/test/golden/*.run.json`, a determinism check across three
calls, a different-seed check, and per-scenario semantic assertions).
This was **0 runnable tests** at session start — the salvaged commit had
never been type-checked or run once; see `docs/PROGRESS.md` for the exact
defects that blocked it (a missing tsconfig option, a syntax error, a
`noUncheckedIndexedAccess` violation, and an unfilled hash placeholder).

### `pnpm check:runs` (byte-identical regeneration)

```
OK       sim-medspa-happy
OK       sim-medspa-slack-revoked
OK       sim-medspa-ghl-429
OK       sim-medspa-duplicate
OK       sim-medspa-reply-timeout

5 run(s) match a fresh regeneration byte-for-byte.
```

### `pnpm check:drift` (runs vs `content/workflow.json`)

```
OK    sim-medspa-duplicate (simulator, 14 nodes)
OK    sim-medspa-ghl-429 (simulator, 14 nodes)
OK    sim-medspa-happy (simulator, 14 nodes)
OK    sim-medspa-reply-timeout (simulator, 14 nodes)
OK    sim-medspa-slack-revoked (simulator, 14 nodes)

5 run(s) agree with content/workflow.json.
```

Fire-tested, not just trusted: a run's first node name was hand-tampered
to `"Tampered Node Name"` and re-run — `drift-check.ts` correctly reported
`DRIFT sim-medspa-happy: the run's node list ... does not match`, then the
file was restored and `git status --short` confirmed a byte-exact match
to what's committed.

### `pnpm check:bindings`

```
Binding allow-list check passed: nothing outside {DB, TURNSTILE_SECRET}, no *_API_KEY anywhere in the repo.
```

Fire-tested twice: a planted env read of a disallowed LLM-provider
credential name in `worker/src/` was correctly flagged and removed before
this report; the checker also caught its own build history describing
that test in `docs/PROGRESS.md`'s
prose (rephrased, not suppressed — see that file's own note on this).

### `pnpm check:secrets`

```
Secret scan passed: no secret-shaped strings found in the tracked tree.
```

Fire-tested: a planted AWS-key-shaped string (`AKIA` + 16 chars) was
correctly flagged and removed before this report.

### Build — `pnpm build`

```
[build] output: "static"
[build] mode: "static"
generating static routes
  ├─ /demo/index.html (+13ms)
  ├─ /limits/index.html (+3ms)
  ├─ /runs/sim-medspa-happy/run.json (+2ms)
  ├─ /index.html (+3ms)
3 page(s) built in ~260ms
```

**Exact build size** (`site/dist/`, measured with `wc -c` per file, not
estimated):

| File | Raw bytes | Gzip bytes |
|---|---:|---:|
| `index.html` (`/`) | 2,902 | 1,475 |
| `demo/index.html` (`/demo`) | 12,724 | 3,977 |
| `limits/index.html` (`/limits`) | 5,555 | 2,149 |
| `_astro/labels.*.css` (the one stylesheet) | 5,931 | 1,745 |
| `runs/sim-medspa-happy/run.json` (download, not page weight) | 13,381 | 3,382 |
| `_headers` | 797 | — |
| `_redirects` | 292 | — |
| **Total `site/dist/`** | **41,582** | — |

**Zero JavaScript files exist anywhere in the build** (`find site/dist -name
'*.js'` returns nothing) — so the "JS ≤40 KB gzipped on `/`" budget (Spec
section 13) is met at 0 B, not merely under budget, and "zero JS on `/`" is
verified two ways: no `.js` file in the build, and
`tests/e2e/site.spec.ts`'s dedicated test asserting the raw HTTP response
for `/` contains no `<script` tag at all.

### E2E — `pnpm e2e` (Playwright, via `scripts/e2e.mjs`)

```
Running 9 tests using 8 workers
  9 passed (2.2s)
```

Covers: zero horizontal overflow at 320px on `/`, `/demo`, `/limits`; the
node ledger on `/demo` scrolls inside its own container (`scrollWidth
708px > clientWidth 278px` at 320px) while the page itself does not; zero
`<script>` tags in the raw `/` response; and, with
`javaScriptEnabled: false`, that `/` delivers the headline number + its
provenance flag + the try link, `/demo` delivers the mode chip + the full
14-row ledger (every node name checked against the committed run file,
not a hardcoded count) + all 4 composed artifacts + the Sheets row, the
`/runs/<id>/run.json` download resolves and matches the committed file
byte-for-byte, and `/limits` names every entry in `stubbed[]`/`simulated[]`
and states the exact sentence "No SMS or email was ever sent" (Spec
section 16, acceptance criterion 2, asserted directly).

Verified reliable, not lucky: three consecutive clean `pnpm e2e` runs with
an explicit `netstat`/PowerShell port check between each — see
`docs/PROGRESS.md` and the comment block in `scripts/e2e.mjs` for the
Windows process-tree bug this caught and fixed.

## 320px measurement (Spec section 16, acceptance criterion 10)

Measured in a real Chromium browser (`mcp__agent-browser`), not only
asserted by the automated suite:

| Page | Viewport | `scrollWidth − clientWidth` | Result |
|---|---|---:|---|
| `/` | 320×720 | 0 | no horizontal scroll |
| `/demo` | 320×720 | 0 (ledger table itself: `scrollWidth 708 / clientWidth 278`, scrolling **inside** `.ledger-scroll`) | no horizontal scroll |
| `/limits` | 320×720 | 0 | no horizontal scroll |

Screenshots committed at `docs/screenshots/320px-home.png`,
`320px-demo.png`, `320px-limits.png`.

## `firstTouchDispatchMs` traceability (Spec section 16, acceptance criterion 8)

- **Source field:** `content/runs/sim-medspa-happy/run.json` →
  `metrics.firstTouchDispatchMs` = **839** (milliseconds; webhook receipt
  → the `GHL: Send Instant SMS` node's `finishedAt`, per
  `packages/schema/src/run.ts`'s `sinceT0` cross-check, gated on that node
  having actually succeeded — see `docs/PROGRESS.md` for why that gate
  matters).
- **Rendered as:** `formatSeconds(839)` = `"0.8 s"`, from
  `@lrd/schema`'s `formatSeconds` (`packages/schema/src/timeline.ts`) —
  the same function the site imports, not a re-implementation.
- **On the page:** `site/src/pages/index.astro`'s hero (`.hero__number`),
  with `numberFlag(run)` directly beneath it: `"modeled · simulator run ·
  no recording yet — from content/runs/sim-medspa-happy/run.json"`.
- **Asserted in CI:** `tests/e2e/site.spec.ts`, "/ delivers the headline
  number..." — reads `HAPPY_RUN.metrics.firstTouchDispatchMs` from the
  actual committed file at test time and computes the expected string with
  the real `formatSeconds`, rather than hardcoding `"0.8 s"` as a literal
  — so this assertion cannot silently drift from the data the way a
  hardcoded string could.

## Real defects found and fixed this session

Full detail in `docs/PROGRESS.md`. Summary:

1. `tsconfig.base.json` missing `allowImportingTsExtensions` — every
   source file failed to type-check (TS5097).
2. A mismatched-angle-bracket type cast in `topology.test.ts` — a plain
   syntax error.
3. A `noUncheckedIndexedAccess` violation in `expressions.test.ts`.
4. `normalize.ts` shipped the literal placeholder string
   `'__SET_BY_TEST__'` instead of a real computed hash.
5. **A genuine honesty-architecture bug**, caught by writing the first
   golden-trace test: the schema's cross-check credited a metric/artifact
   as "happened" whenever a node carried a `finishedAt` timestamp, without
   checking the node actually *succeeded* — meaning a failed Slack call
   (401) would have reported a non-null `ownerNotifiedMs`, crediting a
   notification that never sent. Fixed in both `packages/schema/src/
   run.ts` and `packages/engine/src/execute.ts`.
6. A `.astro`-frontmatter TSX-parser ambiguity (`value as Extract<typeof
   value, {...}>` inside a `.map()` misread as a JSX tag open — 60
   cascading parse errors).
7. `import.meta.url`-relative path resolution breaking once Vite bundles
   the module to a different output location than its source.
8. A Windows-specific process-tree bug in Playwright's `webServer`
   orchestration, reproduced twice, leaving an orphaned server holding
   the port between runs.
9. A missing-space rendering bug (`</code>` ending a source line
   immediately before plain continuation text collapsed to zero
   whitespace under Astro's compiler) — caught by actually looking at a
   320px screenshot rather than trusting the build to have succeeded.

## Explicit checklist against this session's M0 scope

| Item | Status |
|---|---|
| `packages/schema` (RunFile v1 + recording-mode refinement, LeadPayload, NodeEvent) | done |
| `packages/engine` (deterministic executor, all 4 fault seams, golden traces) | done |
| `content/runs/sim-medspa-happy/` + 4 seam runs, generated + regenerable | done |
| `site/` — `/`, `/demo`, `/limits`, `_headers`, `_redirects` | done |
| 320px clean, measured | done (screenshots + Playwright) |
| Zero JS on `/` | done (0 `.js` files; asserted) |
| `worker/` — `GET /api/health`, binding allow-list CI check, no fake `/api/lead` | done |
| CI workflow — typecheck, unit+golden, build, drift check, binding allow-list, Playwright 320px | done (workflow written, YAML-validated, every step run locally; not yet run on GitHub Actions itself — no remote) |
| README, `docs/PROGRESS.md`, `docs/DEVIATIONS.md`, `docs/LIMITATIONS.md` | done |
| Pages deploy command documented, not run | done (`README.md`) |
