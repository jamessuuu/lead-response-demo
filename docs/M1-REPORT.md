# M1 report

Real output from this milestone's final verification run — every number
below was measured, not estimated. Read alongside `capture/README.md`
(the "exactly how" writeup), `docs/PROGRESS.md` (the session log), and
`docs/DEVIATIONS.md` (every place this build diverges from the spec, with
reasoning).

## Verdict

M1 ("the recording") is complete. Two real n8n executions were captured
against a genuinely running local n8n 2.36.8 — one full happy path
(including the real ~15-minute Wait node), one halted by a real Slack 401
— redacted, schema-validated, and committed. `pnpm verify` (typecheck,
79 unit/integration tests, the 5 simulator runs' byte-for-byte
regeneration check, the 7-run drift check against `content/workflow.json`,
the binding allow-list check, the repo-wide secret scan, the static build,
and 12 Playwright e2e tests) exits 0 against the final committed state.
Sixteen real defects were found and fixed this session (list below); one
of them is not a defect in this repo at all but a genuine, reproduced-twice
defect in the base workflow this demo is built around, deliberately left
uncorrected and documented instead of patched away (see "The most
consequential finding" below and `docs/DEVIATIONS.md`).

## The two real recordings

| | `rec-medspa-happy` | `rec-medspa-slack-401` |
|---|---|---|
| n8n version | 2.36.8 | 2.36.8 |
| execution id | 1 | 1 |
| `n8n.mode` | `webhook` | `webhook` |
| status | `success` | `error` |
| `metrics.firstTouchDispatchMs` | 119 | 107 |
| `metrics.ownerNotifiedMs` | 153 | `null` (Slack node errored) |
| `metrics.waitMs` | 900027 (real ~15:00 min) | `null` (Wait never reached) |
| `metrics.totalMs` | 900236 | 165 |
| nodes captured | 14 | 14 |
| `attest.json` → `stubhouseCommit` | `5f4674a92af365508c666a8934262396962fec12` | `5f4674a92af365508c666a8934262396962fec12` |

`firstTouchDispatchMs`/`ownerNotifiedMs`/`waitMs`/`totalMs` are each
independently recomputed by `packages/schema`'s own cross-check (not just
trusted from the mapper) as part of `RunFile.parse` and again in
`packages/schema/test/run.test.ts` against the committed files — both
recordings pass that arithmetic check.

## How the capture actually ran

`pnpm --filter @lrd/capture capture:happy` (then `capture:slack-401`),
against a `capture/.n8n/<runId>/` fresh n8n user folder each time, with
`capture/stubhouse` bound to `127.0.0.1:8788` and n8n's webserver moved to
`127.0.0.1:5680` (the default 5679 collides with n8n's own task-runner
broker). The happy-path capture's real wall-clock duration — from the
webhook POST to `attest.json` being written — was 906.1 seconds (15.10
minutes): the genuine 15-minute Wait node plus real n8n startup, REST
setup, and mapping/validation overhead. Nothing about the wait was
shortened, mocked, or fast-forwarded (Spec section 4, decision 2) — the
15:00-minute gap between "Log to Google Sheets" finishing and "Wait 15
Minutes" resuming is real elapsed wall-clock time, confirmed by
`metrics.waitMs: 900027`. The slack-401 capture finished in seconds — the
Slack node's real 401 halts the execution long before the Wait node is
ever reached (`metrics.totalMs: 165`).

Redirection mechanism (full detail in `capture/README.md`): GoHighLevel's
four `httpRequest` nodes get their `url` parameter string-replaced in a
transient import copy (`capture/transform-workflow.mjs`); Slack and Google
Sheets are "app nodes" whose vendor base URL is a string literal compiled
into the installed `n8n-nodes-base` package, patched in place
(`capture/patch-n8n.mjs`, idempotent, reversible, never touches
`content/workflow.json`). No TLS/MITM proxy — stubhouse is plain HTTP on
loopback. `scripts/drift-check.ts` proves both recordings' topology is
byte-identical to `content/workflow.json`'s own signature.

## Redaction proof

Every occurrence of the fictional lead's real phone digit sequence
(`5125550134`) across all four recording files (`run.json`/`execution.json`
× two recordings) — `grep -c 5125550134`: **0, 0, 0, 0**. The masked form
(`+1512•••0134`) appears 7 times in `rec-medspa-happy/execution.json` and
3 times in `rec-medspa-slack-401/execution.json` (plus throughout both
`run.json` files and the rendered site). `scripts/check-secrets.mjs`
(a real filesystem walk from the repo root, not a git-tracked-only scan —
verified by reading its source, not assumed) passes clean over the
committed tree, including both recordings. `attest.json`'s
`redaction: {authHeadersStripped: true, phoneMasked: true}` claim is now
actually true for all three files per recording, not just `run.json` —
see defect #14 below for the bug this fixes.

## Test counts

- `pnpm test` (Vitest): **79 passed**, 0 failed, 0 skipped (10 test files;
  the skips that existed pre-capture — recording-dependent schema tests —
  now run for real against both committed recordings).
- `pnpm check:runs`: 5/5 simulator runs regenerate byte-for-byte.
- `pnpm check:drift`: 7/7 runs (2 recordings + 5 simulators) agree with
  `content/workflow.json`.
- `pnpm check:bindings` / `pnpm check:secrets`: both clean.
- `pnpm build`: static build succeeds, all 8 expected routes generated
  (`/`, `/demo`, `/limits`, both recordings' `run.json`+`execution.json`,
  the simulator's `run.json`).
- `pnpm e2e` (Playwright): **12 passed**, 0 failed — 320px zero-overflow
  on `/`, `/demo`, `/limits`; zero `<script>` tags on `/` and `/demo`;
  every "works with JavaScript disabled" assertion, including the
  CSS-only tab switcher and both recordings' download links resolving to
  the committed files.
- `pnpm verify` (the full chain): **exit 0**.

## The most consequential finding: the base workflow's Google Sheets node silently writes the wrong data

Full technical detail, verified against real n8n source
(`n8n-nodes-base/dist/nodes/Google/Sheet/v2/actions/sheet/append.operation.js`),
lives in `docs/DEVIATIONS.md`. Summary: `content/workflow.json`'s "Log to
Google Sheets" node declares `columns.mappingMode: "defineBelow"` with
eight explicit per-column expressions referencing `Normalize Lead`'s
fields — but its `columns.value.schema` is `[]` (a real n8n *editor*
session always populates this; nothing in this repo's pipeline can, and
neither `service-samples`' base workflow nor this repo's copy of it was
ever authored inside one). Real n8n 2.36.8's own append operation code:
when the target sheet is empty, it silently overrides
`columns.mappingMode` to `autoMapInputData` and maps the *current input
item's raw JSON* instead — which for this node is `Notify Owner
(Slack)`'s own `chat.postMessage` response, not the lead's data. Both
committed recordings' `artifacts.sheetRow` show exactly this: `ok`,
`channel`, the `message` object, and `ts` written into
`receivedAt`/`firstName`/`lastName`/`phone` — **reproduced identically
across two independent real captures**, proving this is deterministic
n8n behavior, not a fluke. On a *non-empty* sheet, the same missing
schema instead throws `NodeOperationError: columns.schema is required
when columns.mappingMode is defineBelow` — with no `continueOnFail`, that
halts the entire remaining execution (Wait, reply-check, both branches)
on every lead after the first.

This is deliberately **not fixed** in `content/workflow.json` and neither
recording was re-captured to "correct" it — Spec section 4's "the
recording is real or it does not exist" cuts both ways: patching the
workflow specifically to erase a real, reproducible defect from the one
artifact whose entire purpose is proving what real n8n actually does
would be the same dishonesty as fabricating a number. The site says so
explicitly now (`RunPanel.astro`, recording mode only) rather than
rendering the row as if nothing were unusual. Follow-up: this is a real
defect in `service-samples/automations/speed-to-lead/workflow.json`
itself, out of scope for this repo to fix — worth flagging to whoever
owns that file.

## Real defects found and fixed this session

Full detail in `docs/PROGRESS.md`. Summary:

1. `capture.mjs` trusted `/rest/owner/setup`'s response body to carry
   `data.id` directly — n8n doesn't shape it that way (or the shape isn't
   worth pinning across versions); fixed by reading the authenticated user
   back via a dedicated `GET /rest/login` ("whoami") call instead, which
   the manual fire-test had already proven reliable.
2. The readiness probe (`GET /rest/settings`) can succeed before the rest
   of the REST API — `/rest/login`/`/rest/owner/setup` — is actually ready;
   n8n answers those with a plain-text "n8n is starting up. Please wait"
   for a short window afterward. Fixed by retrying the whole
   settings-check → setup-or-login → whoami sequence as one unit, re-
   derived from scratch each attempt, rather than treating `/rest/settings`
   alone as the readiness signal.
3. `transform-workflow.mjs`'s `rewriteCredentials` helper (caught before
   the first real fire) returned the whole node object instead of
   `undefined` for nodes with no `credentials` block, corrupting the
   sticky-note nodes' JSON in the n8n-imported workflow — caught by
   inspecting the imported workflow via REST before ever firing the
   webhook.
4. `build-run-file.mjs` trusted the Wait node's own `runData.startTime` as
   when it began waiting. n8n actually reports that field as the RESUME
   instant (`executionTime` ≈ 0) — confirmed against the raw
   `execution.json` from the first full capture: the gap between the
   previous node finishing and the Wait node's reported `startTime` was
   900018ms (essentially the real 15-minute parameter), while the Wait
   node's own start→start+executionTime span collapsed to 0ms. This
   produced a schema-*valid* (internally self-consistent) but false
   `metrics.waitMs: 0` for a real 15-minute wait — caught only by manually
   inspecting the completed recording's numbers, not by any automated
   check, since schema cross-checks prove internal consistency, not truth.
   Fixed by deriving the Wait node's effective `startedAt` from the
   previous node's `finishedAt`; pinned with a regression test using the
   real 900018ms gap as its fixture
   (`capture/lib/test/build-run-file.test.mjs`). The first `rec-medspa-happy`
   capture was discarded and re-run in full — another real 15-minute wait
   — rather than hand-patching the already-written file.

A background code-reviewer agent, run against the capture-rig + site diff
during the second happy-path capture's real wait, found nine more real
defects before either recording was finalized — including one
(`node-if-replied` reading the wrong If-node output branch) that would
have corrupted the run then in flight the moment it reached that node.
The run was killed with a clean window still ahead of it, all nine were
fixed together, and both recordings were captured fresh afterward:

5. `node-if-replied` read `data.main[0][0]` unconditionally; n8n's If node
   puts the branch that actually fired in one of two arrays
   (`[trueItems, falseItems]`), and the no-reply branch — this workflow's
   own happy path — is the one that leaves index 0 empty. Fixed to read
   whichever array is non-empty; pinned with a regression test that only
   populates the false branch.
6. `attest.json`'s `captureCommand` recorded a plain `node capture/
   capture.mjs ...` invocation, which cannot run (needs `tsx`) — corrected
   to the real `pnpm --filter @lrd/capture capture:<scenario>`.
7. `capture.mjs`'s `try` started after `patchN8n()`/build/`spawn()`, so a
   throw in any of those steps skipped `finally` and leaked a running
   stubhouse (and possibly n8n). Restructured so the whole sequence is
   inside `try`, with `n8nProc?.kill()` in `finally`.
8. `popCalls()` never checked that a popped stubhouse call actually
   belonged to the service a node could call — added a same-service
   assertion (`SERVICE_FOR_NODE`) that throws on mismatch instead of
   mis-attributing; pinned with a regression test.
9. All ten `recordLog()` sites in `stubhouse/server.mjs` logged
   `url.pathname` only, dropping query strings (the GHL reply-check call's
   `?locationId=...&contactId=...`). Fixed to log `pathname + search`.
10. `--run-id` was interpolated unvalidated into `shell: true` spawns —
    added a strict regex check on argv before it can reach a shell.
11. Removed `capture/lib/n8n-rest.mjs`'s dead, unused `waitForExecution`
    export (`capture.mjs` has always used its own `waitFor()`).
12. Merged two separate `node:child_process` imports in `capture.mjs`.
13. `site/src/lib/runs.ts`'s `loadRun()` used a bare `RunFile.safeParse`,
    so the site build never actually enforced `REQUIRED_SIBLINGS` — a
    recording missing its `execution.json`/`attest.json` siblings was
    schema-legal on its own, contradicting `execution.json.ts`'s doc
    comment claiming this protection exists. Rewritten to call
    `validateRunDirectory` against the real directory listing.

Two more real defects surfaced only after both recordings existed and
`pnpm e2e` ran for the first time against real (not simulator) data:

14. `capture.mjs` redacted `run.json` (via `redactDeep`) before writing it
    but never applied the same pass to `execution.json` — the fictional
    lead's real phone number appeared unmasked 7 times in
    `rec-medspa-happy/execution.json` and 3 times in
    `rec-medspa-slack-401/execution.json`, directly contradicting
    `attest.json`'s own `phoneMasked: true` claim and Spec section 4's
    "masks phone at capture time" for *all three* recording files, not
    just `run.json`. The header comment even said so, self-contradicting
    itself in the same sentence ("redacts it... execution.json (untouched
    raw export)"). Fixed by applying `redactDeep` to a copy of the
    execution data before writing `execution.json`; both existing
    recordings were deleted and re-captured fresh (not hand-patched) so
    `attest.json`'s `stubhouseCommit` stays accurate to the code that
    actually produced the file. Every "raw, untouched" claim in the site,
    `capture/README.md`, and the download route's doc comment was
    corrected to "raw export, phone-redacted" — "raw" was never meant to
    mean "unredacted."
15. `/demo` overflowed 320px viewports by 318-321px (`pnpm e2e`'s own
    zero-horizontal-scroll gate, Spec section 13 criterion 10) — two
    independent real causes, both traced to real captured data the
    simulator never generates and both fixed with CSS, not by hiding the
    data: (a) `table.sheet-row`'s cells had no wrap protection, and the
    Sheets-node finding above (this section) means a cell can genuinely
    contain n8n's own unbroken tracking-URL text
    (`_Automated with this <http://.../n8n-nodes-base.slack_...|n8n
    workflow>_`) with no whitespace to break on — fixed with
    `overflow-wrap: anywhere` + `table-layout: fixed`. (b) That same
    unbroken URL is *also* in the real Slack message artifact text
    (`.artifact__body`, the "What it composed" cards) — fixed the same
    way. Both were root-caused with live browser measurement
    (`getBoundingClientRect()` plus `Range.getClientRects()` on text
    nodes specifically, since a fixed-width table cell's own box can stay
    narrow while its un-wrapped text content visually escapes it) rather
    than guessed at from reading CSS, and both are verified fixed with
    `pnpm e2e` green (12/12) and a live 320px measurement showing
    `document.documentElement.scrollWidth === clientWidth` exactly, on
    both the Recording and Simulator tabs.
16. `site/src/lib/runs.ts` and `execution.json.ts`'s doc comments, and
    `capture/README.md`, all described `execution.json` as "raw,
    untouched" without qualification — corrected alongside #14 so no
    surviving prose overclaims what the file actually contains.

## Explicit checklist against this session's M1 scope

| Item | Status |
|---|---|
| `capture/stubhouse` — GHL/Slack/Sheets response shapes over real local HTTP, fault switch | done |
| `capture/patch-n8n.mjs` — Slack/Sheets app-node redirection, topology-safe, idempotent | done |
| `capture/capture.mjs` — end-to-end orchestration, real webhook fire, real Wait | done |
| Two real recordings committed (`rec-medspa-happy`, `rec-medspa-slack-401`) | done |
| `run.json` schema v1 `mode: "recording"`, siblings present, validated | done |
| `/demo` Recording tab, zero JS, mode label rendered from data | done |
| `/limits` still accurate (fixed the now-false "no recording exists" line) | done |
| `packages/schema/test/run.test.ts` — REQUIRED_SIBLINGS coverage | done |
| `scripts/drift-check.ts` passes for the recordings | done (7/7) |
| `scripts/check-secrets.mjs` clean over `content/runs/**` | done |
| `pnpm e2e` — 320px + JS-disabled + Recording tab | done (12/12) |
| `docs/PROGRESS.md`, `docs/DEVIATIONS.md`, this report | done |
