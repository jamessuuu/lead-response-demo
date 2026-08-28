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

## The base workflow's Google Sheets node silently ignores its own column mapping on an empty sheet — and `rec-medspa-happy` proves it, on purpose left uncorrected

This is the single most consequential thing the real recording found, and
it is **left exactly as captured, not patched** — see below for why.

`content/workflow.json`'s "Log to Google Sheets" node is configured with
`columns.mappingMode: "defineBelow"` and eight explicit per-column
expressions (`={{ $('Normalize Lead').item.json.receivedAt }}`, etc.), but
its `columns.value.schema` array — metadata a real n8n *editor* session
populates automatically the moment a user picks "Map Each Column
Manually" — is `[]`. Nothing in this repo's build pipeline can populate
that array outside the n8n UI itself, and neither `service-samples`' base
workflow nor this repo's copy of it was ever authored inside a live n8n
editor.

Reading the installed node's real source
(`n8n-nodes-base/dist/nodes/Google/Sheet/v2/actions/sheet/append.operation.js`,
this capture's n8n 2.36.8) shows exactly what that empty schema does at
runtime. Two facts, both verified by reading the code, not by guessing:

1. `if (!sheetData?.length) { dataMode = 'autoMapInputData'; }` — if the
   target sheet has **no existing rows**, n8n silently overrides
   `columns.mappingMode` to auto-map mode, unconditionally, before the
   node's own eight expressions are ever evaluated. `autoMapInputData`
   then maps the *current input item's own top-level JSON fields*
   straight to columns — and this node's direct predecessor in
   `content/workflow.json`'s connection graph is **`Notify Owner
   (Slack)`**, not `Normalize Lead`. `rec-medspa-happy`'s real
   `artifacts.sheetRow` and the raw PUT body in
   `nodes[].request.bodyPreview` for `node-sheets-log` are Slack's own
   `chat.postMessage` response (`ok`, `channel`, the `message` object,
   `ts`) written into the `receivedAt`/`firstName`/`lastName`/`phone`
   columns — because that response, not the lead's own data, was `$json`
   at the moment this node ran.
2. On a sheet that already has rows (`sheetData.length > 0` — true for
   this workflow on every lead after the first), that early override
   never fires, and a few lines later:
   `if (!Array.isArray(schema) || schema.length === 0) { throw new
   NodeOperationError(...'columns.schema is required when
   columns.mappingMode is defineBelow'...) }` fires instead. With no
   `continueOnFail` set on this node (matching this workflow's pattern
   everywhere else), that throw halts the entire execution at the
   Sheets step — the Wait node, the reply check, and both no-reply/human
   branches never run, for every lead after the first one.

Put together: as authored, this workflow logs one lead's contact details
by accident (against an empty sheet) and then hard-fails on every lead
after it (against a non-empty one). The simulator never had a chance to
catch this — `@lrd/engine` renders the Sheets artifact directly from the
lead's own normalized fields (Spec's own modeled shape), which is exactly
what this node's *author* intended and exactly what real n8n does not do.
This is precisely the category of defect a recording exists to catch and
a simulator, by construction, cannot: a real client library's runtime
fallback behavior around a manually-authored JSON file's missing UI
metadata.

**Why `rec-medspa-happy` is not re-captured with a patched schema.** Fixing
`content/workflow.json`'s `columns.value.schema` (or switching the node to
`autoMapInputData` outright) would make the recording "look right" — and
would also make it lie. Spec section 4's own rule, quoted throughout this
repo, is "the recording is real or it does not exist"; patching the
workflow specifically to erase a real, verified, reproducible defect from
the one recording whose entire purpose is proving what real n8n actually
does is the same dishonesty in the other direction. The base workflow at
`service-samples/automations/speed-to-lead/workflow.json` is this repo's
external reference artifact, out of scope to edit for this milestone
regardless. `RunPanel.astro` was given one factual, always-true sentence
for recordings pointing a reader at this file rather than silently
rendering the row as if it were unremarkable; `table.sheet-row` was given
`overflow-wrap: anywhere` (was previously undefined) because a real
captured value — unlike the simulator's own short modeled strings — can
be arbitrarily long, and the 320px zero-horizontal-scroll requirement
(Spec section 13) has to hold regardless of what a real execution happens
to write.

Fixing the underlying workflow (populating a real `columns.schema`, most
likely) belongs to whoever owns `service-samples/automations/speed-to-lead`,
not to this demo repo — flagging it upstream is noted as follow-up in
`docs/M1-REPORT.md`.

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

## The Simulator mode-chip label doesn't say "runs in a Cloudflare Worker" yet

Spec section 2's literal Simulator wording is: "Simulator — this is not
n8n. The same topology runs in a Cloudflare Worker, with per-node timings
taken from the recording. Nothing is sent; no CRM is written."
`packages/schema/src/labels.ts`'s `modeChip()` renders "...runs in a
deterministic engine..." instead, because at M0/M1 the literal claim would
be false: `packages/engine` executes at build time inside Node (via
`scripts/generate-runs.ts`, and `.astro` frontmatter at `astro build`
time), never inside a deployed Cloudflare Worker — no Worker exists in
this repo beyond `worker/`'s M0 `GET /api/health` scaffold (see this
file's own entry above), and nothing gets deployed this session regardless
(task scope: local commits only). Saying "Cloudflare Worker" now would be
exactly the kind of claim the honesty architecture exists to forbid — true
of the spec's *eventual* M2+ shape, false of what actually executes today.
`modeChip()` should switch to the spec's literal wording once
`packages/engine` genuinely runs inside `worker/` (M2's SSE-streamed
simulator surface); tracked here rather than matched early and quietly.

## The dispatch number's "measured"/"modeled" flag now states its own condition, not just its basis

Dispatcher-added, session-scoped requirement (recorded here because it
changes rendered copy the spec itself only implies): `metrics.
firstTouchDispatchMs` is 114-115ms *because the integrations it depends on
are local stubs* — a real GoHighLevel SMS round trip was never in the
loop. Before this fix, `numberFlag()` rendered a bare `"measured · recording
of n8n <version>"` for a recording — true as far as it went, but silent on
the one condition that actually matters to a reader deciding what the
number proves. `numberFlag()` (`packages/schema/src/labels.ts`) now states
the stub condition every time it renders for a recording, so the one place
Spec section 9's headline number appears (`site/src/pages/index.astro`'s
`.hero__flag`, directly beneath `.hero__number`) never shows the figure
without it; `packages/schema/test/labels.test.ts` and `tests/e2e/site.spec.ts`
pin the rendered text. Not yet applicable: an OG image (Spec section 14,
M4 scope — none exists in this repo yet) and README (which does not
currently state the specific figure at all, only "under a second" in
`index.astro`'s `<meta name="description">`, which is not a bare number
beside the HBR claim). Revisit both when they're built.
