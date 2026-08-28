# M1 report

Real output from this milestone's final verification run — every number
below was measured, not estimated. Read alongside `capture/README.md`
(the "exactly how" writeup), `docs/PROGRESS.md` (the session log), and
`docs/DEVIATIONS.md` (every place this build diverges from the spec, with
reasoning). Placeholder — finalized once both real captures complete and
`pnpm verify` runs clean on the committed result.

## Verdict

_(pending — filled in once both captures are committed and `pnpm verify`
has been run against the result)_

## The two real recordings

| | `rec-medspa-happy` | `rec-medspa-slack-401` |
|---|---|---|
| n8n version | _pending_ | _pending_ |
| execution id | _pending_ | _pending_ |
| `n8n.mode` | `webhook` | `webhook` |
| status | _pending_ | _pending_ |
| `metrics.firstTouchDispatchMs` | _pending_ | _pending_ |
| `metrics.ownerNotifiedMs` | _pending_ | `null` (Slack node errored) |
| `metrics.waitMs` | _pending_ (real ~900000ms) | `null` (Wait never reached) |
| `metrics.totalMs` | _pending_ | _pending_ |
| nodes captured | 14 | 14 |

## How the capture actually ran

_(pending — the real command, the real wall-clock duration including the
genuine 15-minute Wait node, and the exact patch/redirection mechanism
verified live, per `capture/README.md`)_

## Redaction proof

_(pending — grep the committed `content/runs/rec-medspa-*/` for the real
phone number vs. the masked form, and confirm `scripts/check-secrets.mjs`
passes clean over the committed recordings)_

## Test counts

_(pending — `pnpm test` and `pnpm e2e` output, same format as
`docs/M0-REPORT.md`)_

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

## Explicit checklist against this session's M1 scope

| Item | Status |
|---|---|
| `capture/stubhouse` — GHL/Slack/Sheets response shapes over real local HTTP, fault switch | done |
| `capture/patch-n8n.mjs` — Slack/Sheets app-node redirection, topology-safe, idempotent | done |
| `capture/capture.mjs` — end-to-end orchestration, real webhook fire, real Wait | done |
| Two real recordings committed (`rec-medspa-happy`, `rec-medspa-slack-401`) | _pending_ |
| `run.json` schema v1 `mode: "recording"`, siblings present, validated | _pending_ |
| `/demo` Recording tab, zero JS, mode label rendered from data | done (code); _pending_ (against real data) |
| `/limits` still accurate (fixed the now-false "no recording exists" line) | done |
| `packages/schema/test/run.test.ts` — REQUIRED_SIBLINGS coverage | done |
| `scripts/drift-check.ts` passes for the recordings | _pending_ |
| `scripts/check-secrets.mjs` clean over `content/runs/**` | _pending_ |
| `pnpm e2e` — 320px + JS-disabled + Recording tab | _pending_ |
| `docs/PROGRESS.md`, `docs/DEVIATIONS.md`, this report | in progress |
