# capture/ — the M1 recording rig

**This runs. Real recordings exist.** `content/runs/rec-medspa-happy/` and
`content/runs/rec-medspa-slack-401/` are `mode: "recording"` — a real,
locally-run n8n instance executed `content/workflow.json` exactly as
committed, with GoHighLevel, Slack and Google Sheets answered by
`stubhouse` (this directory), never a live vendor account. See
`docs/M1-REPORT.md` for the real numbers (n8n version, execution ids,
per-node timings, the redaction proof).

## The private capture rig (Spec section 2, option (c))

n8n never runs as a public service for this project. It runs **only** here,
on this machine, bound to `127.0.0.1`, for the few minutes a capture takes,
started by `capture.mjs` and killed when the capture finishes. That is the
Spec's own framing: option (c) is "REJECTED as the public demo; ADOPTED as
the private capture rig" — "it manufactures (a)", the recorded-replay
evidence layer `/demo`'s Recording tab and `/` 's hero number read from.

## How to run a capture yourself

```
pnpm --filter @lrd/capture capture:happy       # ~16 real minutes — genuinely waits out the 15-minute Wait node
pnpm --filter @lrd/capture capture:slack-401   # seconds — the Slack node fails before the Wait node is ever reached
```

Each run is self-contained: fresh `capture/.n8n/<run-id>/` user folder
(gitignored), fresh stubhouse state, its own n8n process on `127.0.0.1:5680`,
killed on exit whether the capture succeeded or not. Nothing is left running
afterward. Nothing here needs a GoHighLevel, Slack, or Google account —
every credential `capture.mjs` creates is an inert local placeholder string
`stubhouse` never validates.

## Exactly how a real node gets pointed at a local stub, with zero topology edits

The instruction this rig had to satisfy: point the workflow's real GHL/
Slack/Sheets nodes at `stubhouse`, without editing `content/workflow.json`'s
topology, and without breaking `scripts/drift-check.ts` (which compares
every committed run's `nodes[]`, reduced to `{id, name, type, typeVersion}`,
against `nodeSignatures(parseTopology(content/workflow.json))`). Two
different mechanisms were needed, because n8n's own node types don't all
expose their vendor base URL the same way:

**GoHighLevel (4 `n8n-nodes-base.httpRequest` nodes)** — the vendor URL is a
literal **node parameter** (`https://services.leadconnectorhq.com/...`
inside `parameters.url`). Parameters are not part of a node's topology
signature, so `transform-workflow.mjs` writes a **transient, in-memory
import copy** of the workflow with those four URLs repointed at
`http://127.0.0.1:8788/ghl/...`, `content/workflow.json` on disk untouched.
`verifyTopologyUnchanged()` proves the copy's `nodeSignatures()` is
byte-identical to the source's before anything is imported into n8n — using
the exact same function `drift-check.ts` uses, not a second comparison that
could quietly diverge from it.

**Slack (`n8n-nodes-base.slack`) and Google Sheets (`n8n-nodes-base.googleSheets`)**
are "app nodes": their vendor base URL (`https://slack.com/api`,
`https://sheets.googleapis.com`) is a **string literal compiled into the
installed `n8n-nodes-base` package**, not a workflow parameter — there is
nothing in `workflow.json` to edit for them either way. `patch-n8n.mjs`
finds the local npx install (`npm config get cache`'s `_npx/` folder) and
rewrites exactly those literals, in these files, to point at `stubhouse`
instead:

- `n8n-nodes-base/dist/nodes/Slack/V2/GenericFunctions.js` (and `V1/`, for safety)
- `n8n-nodes-base/dist/nodes/Google/Sheet/v2/transport/index.js` (and `v1/`)

This patches the **local, gitignored npm cache**, never anything inside this
repo or the system. It's idempotent (safe to re-run; reports
`already-patched` on a second pass) and fully reversible — delete the npx
cache entry, or let a future `n8n@latest` resolve a new one, and the patch
is gone. The node **type** never changes (`n8n-nodes-base.slack` stays
`n8n-nodes-base.slack`), so this is not a topology edit by the same
definition `drift-check.ts` uses.

The Google Sheets **OAuth2 credential**'s token endpoint needed no patch at
all: `accessTokenUrl` is a plain (if UI-hidden) credential *data* field
(`n8n-nodes-base`'s `OAuth2Api.credentials.ts`), so `capture.mjs` just sets
it directly on the credential it imports, alongside a pre-seeded
`oauthTokenData.access_token` — n8n's own OAuth2 helper computes token
expiry from `expires_in` relative to *now* every time it builds a signing
token from stored data, so a capture-length credential never needs a
real refresh call. `stubhouse` still answers `/oauth/token` as a defensive
fallback in case that ever changes.

## stubhouse

A plain HTTP server (`stubhouse/server.mjs`, no TLS, no proxy, no MITM —
see above for why none of that is needed) on `127.0.0.1:8788`:

| Route | Stands in for |
|---|---|
| `/ghl/*` | `services.leadconnectorhq.com` (contact upsert, SMS/email send, conversation search) |
| `/slack/api/*` | `slack.com/api` (`chat.postMessage`) |
| `/sheets/*` | `sheets.googleapis.com` (spreadsheet metadata, values read/update/append) |
| `/oauth/token` | Google's OAuth2 token endpoint (defensive fallback, see above) |
| `/_stubhouse/health`, `/fault`, `/reset`, `/log` | admin: state, the fault switch, and the full call log `capture.mjs` reads back to compose `run.json`'s artifacts |

Every response body for the modeled endpoints (`/ghl/*`, `/slack/api/chat.postMessage`,
`/sheets/*:append`) comes from **`answer()` in `@lrd/engine`'s `stubs.ts`** —
the same function the simulator calls — so a capture and a simulator run
agree by construction. The handful of extra Google Sheets calls a real n8n
node makes that the simulator has no reason to model (resolving a sheet
NAME to its numeric id, reserving a trailing row, reading the current
values to decide auto-map-vs-defined columns) are answered directly in
`stubhouse/server.mjs`, documented at the point they're handled — they
exist only to make a **real** Sheets node runnable, not because the
simulator and the recording disagree about what Sheets does.

**Fault switch** (Spec section 11's recorded seam):
`POST http://127.0.0.1:8788/_stubhouse/fault?set=slack401` makes every
subsequent `chat.postMessage` answer a real 401 `invalid_auth` — n8n's own
error path fires, exactly the way a revoked bot token would in production.
`capture.mjs` arms this before firing the webhook for the `slack-401`
scenario; the happy-path capture never sets it.

## Redaction (Spec section 4, decision 3)

`capture/lib/build-run-file.mjs` calls `@lrd/engine`'s `redactDeep()` /
`maskPhone()` — the same functions the simulator uses — over the whole
mapped run object **before** it is written, never at render time. Auth
headers are never captured in the first place (`headersRedacted: true` is
hardcoded on every `request` object; the actual header values are never
read out of stubhouse's request log into `run.json`). `scripts/check-secrets.mjs`
is the second net, scanning the committed tree including `content/runs/**`.

## What n8n execution data actually looks like, and how it becomes `run.json`

n8n serializes an execution's `data` field using
[`flatted`](https://www.npmjs.com/package/flatted) (the exact library and
version n8n itself depends on — pinned in `capture/package.json`), not
plain JSON, to handle the reference graph efficiently. `capture.mjs` fetches
the execution via n8n's own internal `/rest/executions/:id` (the same API
the Editor UI uses — session-authenticated against the throwaway owner
account `capture.mjs` creates on each fresh instance), `flatted.parse()`s
it, and hands the result plus stubhouse's call log to
`build-run-file.mjs`, which:

- walks `content/workflow.json`'s topology in execution order;
- reads each node's real `startTime`/`executionTime`/`error` from n8n's
  `resultData.runData`;
- matches each node to the stubhouse calls it made (a fixed, known count
  per node — GHL/Slack nodes make exactly one call each; the Sheets node's
  cluster of calls is consumed by path prefix) to recover the exact
  request/response bodies for `run.json`'s `artifacts` (the real composed
  SMS, email, Slack text, and sheet row — not a re-derivation from n8n's
  own expression templates, the actual bytes that were sent);
- computes `metrics` with the identical arithmetic
  `packages/schema/src/run.ts`'s own cross-check re-verifies at parse time
  (Spec section 4, decision 1 — `firstTouchDispatchMs` etc. are computed
  once, here, from absolute timestamps, never hand-authored);
- redacts, then validates against `RunFile` before anything is written.

## Files this produces

`content/runs/<id>/`: `run.json` (schema v1, `mode: "recording"`),
`execution.json` (n8n's raw export, `flatted`-serialized exactly as
received, phone-redacted the same way `run.json` is — "raw" describes the
shape, not an exemption from redaction — offered as a download),
`attest.json` (n8n version,
OS, the exact capture command, the git SHA of the `stubhouse` commit that
answered the calls, operator, date, redaction confirmation — shape defined
in `packages/schema/src/attest.ts`).

## Why the happy-path capture takes ~15 real minutes

`content/workflow.json`'s `Wait 15 Minutes` node parameter is untouched —
capture.mjs does not shorten it. The Spec's own decision 2 ("the wait leg
is compressed with a visible marker, never silently") is about how the
*table* should call out an unusually large duration relative to the rest of
the ledger, not license to make the wait shorter than it really is; doing
that would be the exact "hand-authored offset" the honesty architecture
bans. `Wait` genuinely suspends the n8n execution and genuinely resumes it
via n8n's own resume mechanism — `metrics.waitMs` on the happy recording is
a real measurement, not a parameter echoed back. The `slack-401` capture
has no such cost: the Slack node fails and halts the execution *before*
the Wait node is ever reached (confirmed against the simulator's own
`slack-revoked` golden trace, where `Wait 15 Minutes` is `not-run`).

## What already existed and got reused here, not reinvented

- `packages/schema/src/attest.ts` — `AttestFile`.
- `packages/schema/src/run.ts` — `REQUIRED_SIBLINGS`, `validateRunDirectory`,
  now covered by `packages/schema/test/run.test.ts`.
- `packages/engine/src/stubs.ts` — `stubhouse`'s response generator.
- `packages/engine/src/redact.ts` — `redactDeep`, `maskPhone`, `preview`.
- `scripts/drift-check.ts` — validates recordings exactly like simulator
  runs; no recording-specific drift mechanism was needed.
