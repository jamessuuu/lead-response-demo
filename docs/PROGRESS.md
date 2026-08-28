# Progress log

Read this first on resume, alongside `docs/M0-REPORT.md`/`docs/M1-REPORT.md`
(the verification snapshots) and `docs/DEVIATIONS.md`/`docs/LIMITATIONS.md`.
Newest first.

## 2026-08-29 — M1 the recording, on branch `feat/m1-recording`

**Starting state.** `main` at `48a7135`, M0 verified and green
(`docs/M0-REPORT.md`). `capture/` was a contract-only stub —
`capture/README.md` documented the plan but nothing ran, since M0
confirmed `npx --no-install n8n --version` failed with n8n not installed.
This session's job: get n8n genuinely running locally, build the real
capture rig around it, and produce two real recordings.

**Feasibility gate, passed.** `npx n8n@latest start` (Node 24.15.0, this
machine) works — first install pulled n8n's full dependency tree (a large,
one-off download, as the task's own facts predicted), then started
cleanly. One real environment bug hit and fixed immediately: n8n's task
runner broker defaults to port 5679, the same default the main webserver
was configured to (an env-var collision, not an n8n defect) — moved the
webserver to 5680.

**Design decision: no TLS/MITM proxy needed.** The instruction was to
point real GHL/Slack/Sheets node calls at a local stubhouse without
editing workflow topology. GHL's four nodes are plain `httpRequest` nodes
with a literal `url` *parameter* — trivially redirected in a transient
import copy (`capture/transform-workflow.mjs`), parameters being outside
drift-check's topology signature. Slack and Google Sheets are "app nodes"
whose vendor base URL is a **string literal compiled into the installed
n8n-nodes-base package** — verified by reading the actual installed
source (`Slack/V2/GenericFunctions.js`, `Google/Sheet/v2/transport/
index.js`) rather than guessing. Since the literal can simply be rewritten
to a **plain `http://127.0.0.1:8788/...`** URL, no HTTPS/TLS interception,
self-signed certs, or MITM proxy was ever needed — `capture/patch-n8n.mjs`
does a straight string replace in the local npx install, `stubhouse` is
plain HTTP. This eliminated an entire category of complexity (cert
generation, SNI-based dispatch, `NODE_TLS_REJECT_UNAUTHORIZED`) that the
task brief's own phrasing ("via n8n credentials/env — document exactly
how") left open as one possible approach among several.

**The Google Sheets OAuth2 credential needed no patch at all** — verified
by reading n8n-core's own OAuth2 token-refresh logic
(`node-execution-context/utils/request-helpers/oauth.js`):
`accessTokenUrl` is a plain (if UI-hidden) credential *data* field, and a
token's expiry is computed from `expires_in` relative to *now* every time
a signing token is built from stored data — so a pre-seeded
`oauthTokenData.access_token` with `expires_in: 3599` never actually
triggers a refresh within a capture's lifetime. `stubhouse` still answers
`/oauth/token` as a defensive fallback.

**Real n8n needs more from Google Sheets than the simulator ever modeled.**
Firing the (fixed) capture pipeline at a real n8n instance surfaced, one
real HTTP 404 at a time, calls the simulator's `@lrd/engine/stubs.ts` has
no reason to know about: a `GET .../v4/spreadsheets/{id}?fields=sheets.
properties` to resolve the "Leads" sheet name to a numeric id before
appending, then (since the fictional sheet is answered as genuinely empty)
n8n's own auto-map-when-empty fallback, which itself reads current values,
reserves a trailing row via `:batchUpdate`, and writes with a plain PUT
rather than `POST .../values/{range}:append` (n8n only uses the append
verb when the node's "Use Append" option is on, which this workflow leaves
off). All answered directly in `capture/stubhouse/server.mjs`,
documented at the point they're handled — see `docs/DEVIATIONS.md`.

**Manual fire-test, full pipeline, before writing capture.mjs.** Before
committing to a fully scripted orchestrator, every step was driven by hand
against a real local n8n: owner setup via REST, `n8n import:workflow`/
`import:credentials` via CLI, activation via REST, firing the real
webhook, and letting one execution run all the way through — including
the genuine 15-minute Wait node, the reply-check, the branch evaluation,
and the no-reply Slack escalation. That execution finished
`status: success` end to end, which is what justified writing `capture.mjs`
as the scripted version of exactly that path rather than a guess at one.

**`capture.mjs`, three real bugs found and fixed on the first scripted
runs** (full detail in `docs/M1-REPORT.md`):

1. `POST /rest/owner/setup`'s response body doesn't reliably carry
   `data.id` the way the manual test's follow-up `/rest/login` call had
   already proven works — fixed by always reading the authenticated user
   back via a dedicated "whoami" call instead of trusting either
   auth call's own response shape.
2. `/rest/settings` can report ready before the rest of n8n's REST API
   is — `/rest/login`/`/rest/owner/setup` answer a plain-text "n8n is
   starting up. Please wait" for a short window afterward. Fixed by
   retrying the whole settings-check → setup-or-login → whoami sequence
   as one unit, re-derived from scratch each attempt, instead of trusting
   a single upfront readiness probe.
3. `transform-workflow.mjs`'s credential-rewrite helper returned the
   whole node object instead of `undefined` for nodes without a
   `credentials` block (the sticky notes), corrupting their JSON in the
   imported workflow — caught by inspecting the imported workflow via
   REST before ever firing a webhook against it, not after.

**A fourth bug, found only after the first full 15-minute capture
succeeded** (`build-run-file.mjs`, not `capture.mjs`): n8n's own `runData`
for the Wait node reports `startTime` as the moment it *resumed*, with
`executionTime` ≈ 0 — not the moment it began waiting. Confirmed directly
against the raw `execution.json`: "Log to Google Sheets" finished at
`...T17:47:48.541Z`; "Wait 15 Minutes"' own reported `startTime` was
`...T18:02:48.559Z` (900018ms later — essentially exactly the real
15-minute parameter), while its own `startTime`→`startTime+executionTime`
span collapsed to 0ms. Uncorrected, `metrics.waitMs` computed as `0` for a
real 15-minute wait — schema-valid (internally self-consistent) but false,
exactly the kind of bug a schema's own cross-checks cannot catch on their
own, since they only prove internal consistency, not truth. Fixed by
deriving the Wait node's effective `startedAt` from the previous node's
`finishedAt` instead of trusting n8n's own reported value for that one
field; pinned with a dedicated regression test
(`capture/lib/test/build-run-file.test.mjs`) using the real gap (900018ms)
as its fixture. The first capture was discarded and re-run in full with
the fix — costing another real 15-minute wait, deliberately, rather than
patching the already-written `run.json` by hand.

**Independent code review, run during the second happy-path capture's real
15-minute wait** (a background code-reviewer agent, pointed at the
capture-rig + site diff): found nine more real, verified defects before
either recording was finalized. Since one of them (`node-if-replied`
reading `data.main[0][0]` unconditionally) would have corrupted the
capture then in flight the moment it reached that node, the run was
killed deliberately with a clean window still ahead of it, all nine
fixes were applied together, and both recordings were captured fresh
afterward rather than let a known-bad mapper touch real data:

1. **`node-if-replied` read the wrong branch.** n8n's If node reports
   `data.main` as `[trueItems, falseItems]` — whichever branch actually
   fired holds the data, the other is `[]`. The mapper's `jsonOf()`
   helper always read `main[0][0]`, so on the no-reply branch (this
   workflow's own happy path — nobody replies inside the simulated wait)
   it silently read an empty array and rendered "none" instead of the
   real reply-check direction. Fixed to pick whichever of the two arrays
   is non-empty; pinned with a dedicated regression test that only
   populates the false branch.
2. `attest.json`'s `captureCommand` field recorded a `node capture/
   capture.mjs ...` invocation that cannot actually run (the file needs
   `tsx` for its TypeScript-package imports) — corrected to the real
   `pnpm --filter @lrd/capture capture:<scenario>` command.
3. `capture.mjs`'s `try` block started after `patchN8n()`/workflow-build/
   `spawn()` — a throw in any of those steps skipped `finally` entirely,
   leaking a running stubhouse (and possibly n8n) forever. Restructured
   so `n8nProc` is declared before `try` and everything from the patch
   step onward is inside it, with `n8nProc?.kill()` in `finally`.
4. `popCalls()` trusted stubhouse's request log to be in the order the
   node map expected, with no check that a popped call actually belonged
   to the service (GHL/Slack/Sheets) the node in question could ever
   call — a silent mis-attribution risk if the log and the topology ever
   drifted. Added `SERVICE_FOR_NODE` + a same-service assertion inside
   `popCalls()` that throws with the offending node id and path instead
   of mapping garbage; pinned with a regression test that plants a
   wrong-service call and asserts the throw.
5. `stubhouse/server.mjs` logged `path: url.pathname` on all ten
   `recordLog()` call sites, dropping query strings — the GHL
   reply-check call (`conversations/search?locationId=...&contactId=...`)
   lost its query params in the recorded `request.url`. Fixed to log
   `url.pathname + url.search` everywhere.
6. `--run-id` was interpolated unvalidated into `shell: true` spawns —
   added a `/^[a-z0-9][a-z0-9-]{2,63}$/` check immediately after parsing
   argv, failing fast with a clear message instead of reaching a shell.
7. `capture/lib/n8n-rest.mjs` exported an unused `waitForExecution` —
   `capture.mjs` has always used its own generic `waitFor()` for this;
   removed the dead code, left a comment explaining why.
8. Two separate `import { spawn } from 'node:child_process'` / `import {
   execSync } from 'node:child_process'` lines in `capture.mjs` merged
   into one.
9. `site/src/lib/runs.ts`'s `loadRun()` used a bare `RunFile.safeParse`,
   so the site build never actually enforced `REQUIRED_SIBLINGS` (a
   recording missing `execution.json`/`attest.json` was schema-legal on
   its own) — contradicting `execution.json.ts`'s doc comment, which
   already claimed this protection exists. Rewritten to call
   `validateRunDirectory({ run, files: readdirSync(dir) })`, so a
   malformed or incomplete recording now fails the build itself, not
   only `scripts/drift-check.ts`.

`server.mjs`'s header comment (an overclaim about which function
generates which stub shapes) was also corrected while in there.

**Two real recordings captured**: `rec-medspa-happy` (the full happy path,
including the genuine ~15-minute wait, now correctly measured) and
`rec-medspa-slack-401` (stubhouse's fault switch set before firing; the
Slack node gets a real 401, the execution halts there — fast, since the
Wait node is never reached). Exact numbers in `docs/M1-REPORT.md`.

**Site**: `/demo` gains a zero-JS Recording/Simulator tab switcher (a
radio+label CSS pattern — real per-tab content, keyboard-operable via
native radio-group semantics, not full ARIA tabs; see
`docs/DEVIATIONS.md`), Recording tab first and default. `/`'s hero number
now reads the real recording (`numberFlag()` renders "measured", not
"modeled") rather than the simulator. `RunPanel.astro` extracted so both
tabs share one rendering path instead of duplicating the ledger/artifacts
markup. `/runs/[id]/execution.json.ts` added (the raw-export download
Spec section 6 names). `/limits`' one outdated sentence ("no real n8n
recording exists") corrected; its data source deliberately left on the
simulator run, which is a strict superset (a recording's `simulated[]` is
always empty) — see `docs/DEVIATIONS.md`.

**Tests**: `packages/schema/test/run.test.ts` — the `REQUIRED_SIBLINGS`/
`validateRunDirectory` coverage `capture/README.md` flagged as missing at
M0, plus recording-specific tests that load the two real committed files
directly (schema acceptance, `firstTouchDispatchMs` arithmetic recomputed
independently, `attest.json` cross-checked against `run.json`).
`capture/lib/test/build-run-file.test.mjs` — unit coverage for the
execution-to-run-file mapper against a hand-built, n8n-shaped fixture
(the error-halt path, the node-to-stubhouse-call matching for the Sheets
node's multi-call cluster, redaction), independent of a live capture —
all 8 passed on the first run, before the real captures finished, which
is what justified trusting the mapper against the real 15-minute capture
rather than debugging it live against an expensive-to-reproduce fixture.
`tests/e2e/site.spec.ts` updated for the new hero source, the tab
structure (locators scoped per-panel to avoid Playwright strict-mode
violations now that two `.mode-chip`/`table.ledger` elements exist in the
DOM), a dedicated "switch tabs with JS disabled" test (native
label-for-radio activation needs no JavaScript), and both recording
download links.

_(Verification output — `pnpm verify`, both recordings' real numbers, the
redaction proof — lands in `docs/M1-REPORT.md` once the second capture
and the full gate run are done; this entry is written mid-session and
will be reconciled against the final state before the branch is handed
back.)_

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

## What was next (M1) — see the top of this file for what actually happened

Per the spec's build order: the recording (`capture/`, a real n8n capture,
the player island, an a11y pass on it) — see `capture/README.md`'s "what
M1 builds here" for the concrete plan, including which existing modules
(`packages/engine/src/stubs.ts`, `redact.ts`; `packages/schema/src/
attest.ts`) M1 should reuse rather than re-implement. Landed as: the
capture rig + two real recordings + a static Recording tab; the animated
player and a11y-audit pass were explicitly rescoped to M2 — see
`docs/DEVIATIONS.md`.

## What's next (M2)

The simulator's live surface: `packages/engine` wired into the Worker,
D1-backed quota, Turnstile, SSE streaming of node-by-node progress, and
the four live "break it" buttons (Spec section 11). Also where the
animated/keyboard-walkable player and the formal a11y-audit pass land
(`docs/DEVIATIONS.md`'s M1 entry), and — if it ever happens — reconciling
the simulator's modeled timing table against the two real recordings now
in the repo.
