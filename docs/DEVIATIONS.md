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

## `/demo` renders two runs (M1), not all seven

**At M0:** `content/runs/` held five committed, golden-tested simulator
runs (happy + all four seams). Only `sim-medspa-happy` was wired into a
page, matching the spec's own M0 acceptance line precisely — "`/` +
`/demo` rendering **one committed run** as a static table."

**At M1:** two real recordings joined the five simulator runs (seven
total). `/demo` now renders **two** — `rec-medspa-happy` (Recording tab,
default) and `sim-medspa-happy` (Simulator tab) — via the zero-JS tab
switcher (see this file's M1 entry below). `rec-medspa-slack-401` is
linked (both downloads) but has no ledger page of its own yet; the other
four simulator seams remain data + engine test coverage only. The
recording-tabs / simulator / break-it-controls surface that would expose
every scenario interactively is still later scope (Spec section 10:
tabs are M1+, break-it controls are M2/M3 — this build ships the tabs,
not yet the controls). None of the unlinked five are vaporware:
`packages/engine/test/golden/` golden-traces all four simulator seams,
`scripts/drift-check.ts` validates all seven runs (simulator and
recording alike) against `content/workflow.json`, and the five simulator
runs regenerate byte-identical under `pnpm check:runs`.

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

## M1: the animated, keyboard-walkable player is deferred to M2

Spec section 15's M1 row bundles "player island" and "a11y pass logged"
into the same milestone as the capture rig itself. This session's build
brief scoped M1 more narrowly: the capture rig (`capture/`, `stubhouse`,
two real recordings) plus a **static, zero-JS** Recording tab on `/demo` —
explicitly "still JS-free for the table view." The two scopes conflict on
exactly one point (animated/interactive playback), and the narrower brief
governs this build. Reasoning, not just deference: the animated player
implies compressed/sped-up playback of the real 15-minute wait, which is
squarely M2 territory once SSE and the break-it controls exist (Spec
section 10 already places "break-it controls" at M2/M3); building it now
would mean either JS on `/demo` before the JS budget section (13) is
formally gated, or a half-built player with no interactivity to justify it.
`/demo`'s tab switcher (Recording ⇄ Simulator) is a CSS-only radio/label
pattern instead — real tab *content*, keyboard-operable (native radio
group semantics: Tab to reach it, Arrow keys to move between options,
Space/click to select), but not full ARIA `tablist`/`tab`/`tabpanel`
semantics or roving-tabindex JS. A formal `a11y-audit` pass against the
deployed site (contrast numbers written down, reduced-motion handling,
target sizes) stays explicit M3 scope per `docs/LIMITATIONS.md` — nothing
here is deployed yet.

## `/limits` still reads the simulator run, not either recording

`sim-medspa-happy` and `rec-medspa-happy` carry the *same* `stubbed[]` list
by schema (a recording's `stubbed` is required to include everything a
simulator's is, per `packages/schema/src/run.ts`'s cross-check), so nothing
`/limits` currently states is inaccurate. The simulator run is a strictly
richer source for this specific page because it *also* has a non-empty
`simulated[]` (a recording's is always `[]`, since n8n genuinely ran) —
`/limits`'s whole point is naming every stubbed **and** simulated system,
so switching its source to a recording would silently drop the "simulated"
half of that panel. Left unchanged; the one now-false sentence it carried
("No real n8n recording exists") is fixed to state the opposite.

## The recording's `artifacts.errorWorkflow.assumed` stays `true`

The `slack-401` recording (`content/runs/rec-medspa-slack-401/`) has a real
n8n execution that really failed at the Slack node — but no second n8n
workflow (an Error Trigger → Slack alert) was built and wired via n8n's
Settings → Error Workflow for this capture. The deployment runbook already
frames that error workflow as "prescribed... not part of workflow.json"
(`capture/README.md`, `service-samples/.../deployment-runbook.md` section
4) — it lives outside the one file this repo captures against. Recording
`assumed: true` here (identical to the simulator's own `slack-revoked`
scenario) is the honest choice: claiming `assumed: false` would assert a
second real execution that was never captured. A genuinely captured error
workflow is a reasonable future upgrade, not attempted this session to
keep scope bounded to what the build brief asked for.

## `/` 's hero number now reads the recording, not the simulator

Not spec-mandated by name, but a direct consequence of the honesty
architecture's own logic: Spec section 2 calls the recording "the only
artefact that proves n8n *ran*," and `numberFlag()` already renders
`"measured"` for a recording vs. `"modeled"` for a simulator run — the
strictly stronger, truer claim, now that it exists. `/`'s hero switched
from `sim-medspa-happy` to `rec-medspa-happy`; `/demo` puts the Recording
tab first for the same reason. `/limits` did not switch — see above.

## stubhouse answers more than `@lrd/engine`'s modeled Google Sheets shapes

`capture/README.md`'s original (M0-era) plan said stubhouse should reuse
`@lrd/engine`'s stub module "rather than re-inventing it." That still holds
for every response the simulator also needs (GHL upsert/messages/search,
Slack `chat.postMessage`, the Sheets `values:append` shape) — all of them
call `answer()` from `@lrd/engine/stubs.ts` unchanged. A **real** n8n
Google Sheets node makes several additional plumbing calls the simulator
has no reason to model at all (resolving a sheet name to its numeric id,
reserving a trailing row via `:batchUpdate`, reading current values to
decide auto-map-vs-defined-columns before writing) — these are answered
directly in `capture/stubhouse/server.mjs`, documented at the point they're
handled. This is not the simulator and the recording disagreeing about
what Sheets does; it's the difference between a model that renders one
artifact directly and a real HTTP client library that has to ask the API
questions first.

## The simulator's timing table is not swapped for the recording's real numbers

`packages/engine/src/timing/modeled-v1.json`'s own note says: "M1 replaces
this table with one derived from the raw execution export, and the run
files' labels change with it." That was the previous (M0) builder's
forward-looking comment, written before this session's actual M1 build
brief existed. This session's brief scoped M1 explicitly to the capture
rig, the two recordings, and the Recording tab — it does not ask for a new
timing table, a re-derivation of `simulator.timingTable.basis` from
`"modeled"` to `"recording"`, or regenerating the five simulator runs
against it. Doing that properly also deserves more than one real
execution's numbers to derive a jitter distribution from — a single
happy-path capture gives exact per-node durations for *that run*, not yet
a defensible `nominal`/`jitterPct` pair for a simulator meant to represent
the general case. Left as explicit future work, not attempted this
session; `docs/LIMITATIONS.md` states plainly that the simulator's timings
remain modeled assumptions sitting next to (not reconciled with) the two
real measurements now in the repo.

## Only two recordings exist; the other three simulator seams stay simulator-only

Spec section 11 calls for exactly one recorded seam (a revoked Slack
token) alongside the happy path — the other three fault seams
(GoHighLevel 429, duplicate webhook, reply-check timeout) are named as
**live** seam buttons at M2 ("four buttons on `/demo`... each injects a
fault into the engine"), not as additional recordings. `rec-medspa-happy`
and `rec-medspa-slack-401` are the complete M1 recording set by design, not
a partial one.

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
