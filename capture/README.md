# capture/ — the M1 recording rig (not built yet)

**Nothing in this directory runs.** No real n8n recording exists anywhere in
this repo. `content/runs/*/run.json` are all `mode: "simulator"`, produced by
`packages/engine` via `scripts/generate-runs.ts` — see the mode chip on
`/demo`, which says exactly that, rendered from the same field. Faking a
`mode: "recording"` run without the real capture described below would be
exactly the kind of theater the honesty architecture (Spec section 2) exists
to refuse. `packages/schema`'s `RunFile` schema enforces this structurally:
a run claiming `mode: "recording"` is invalid unless `execution.json` and
`attest.json` sit beside it (`REQUIRED_SIBLINGS`, checked by
`validateRunDirectory` — see `packages/schema/test` … no test file exists
for it yet either; add one alongside the first real capture).

## Why this is empty at M0

Building the actual capture rig requires a locally runnable n8n. Verified at
M0 build time:

```
$ npx --no-install n8n --version
npm error npx canceled due to missing packages and no YES option: ["n8n@2.36.8"]
```

n8n is not installed and was not installed to check this — `--no-install`
means npx refuses to silently pull it down, which is exactly the point:
this session does not install n8n. The base workflow sample
(`C:\Users\admin\service-samples\automations\speed-to-lead\README.md`,
"Verification status") records that a real n8n 2.31.6 install elsewhere on
this machine already import-verified `content/workflow.json`'s ancestor
(21 nodes, all types resolve) — so the capture rig is expected to work when
someone builds it, just not proven inside this repo yet.

## What M1 builds here

1. **A Node script** that starts (or points at) a local n8n instance,
   triggers the webhook with a fixed fictional payload, waits for the
   15-minute Wait node (or fast-forwards it via n8n's own resume
   mechanism), and pulls the finished execution via n8n's REST API.
2. **`stubhouse`** — a small local HTTP server standing in for
   `services.leadconnectorhq.com`, `slack.com/api`, and
   `sheets.googleapis.com`, so the capture never depends on live GHL/Slack/
   Sheets accounts (Spec section 18, decision 2: real Slack/Sheets stays
   out of the public demo's recording — no path exists here for James's own
   accounts to appear in a recording). The response *shapes* it serves must
   be the ones `packages/engine/src/stubs.ts` already defines and tests
   against (`ENDPOINTS`, `classifyEndpoint`, `answer()`) — that module's own
   doc comment says these shapes are "MODELED from the public API
   documentation... nothing has verified them against a live API," and
   every run file says so via `simulator.stubShapes: "modeled"`. Capture
   should reuse `@lrd/engine`'s stub module as `stubhouse`'s response
   generator (same shapes served over real HTTP, not a second hand-written
   copy that can drift from the first) rather than re-inventing it, so a
   capture and a simulator run agree by construction, not by coincidence.
3. **A redaction pass** (Spec section 4, decision 3: "redaction at capture,
   never at render") that strips auth headers and masks the phone before
   anything is written — reuse `@lrd/engine`'s `redactDeep`/`maskPhone`
   rather than a second implementation, for the same reason as above.
4. **Emitting the three files** into `content/runs/<id>/`: `run.json`
   (mapped from the execution export into the schema), `execution.json`
   (the raw export, untouched), `attest.json` (n8n version, execution id,
   OS, capture command, `stubhouseCommit`, operator, date — see
   `packages/schema/src/attest.ts` for the exact shape already defined and
   waiting).
5. A second capture with `stubhouse` returning 401 on `chat.postMessage`,
   for the recorded half of the seam moment (Spec section 11).

## What already exists and is waiting to be reused here

- `packages/schema/src/attest.ts` — `AttestFile`, fully specified.
- `packages/schema/src/run.ts` — `REQUIRED_SIBLINGS`, `validateRunDirectory`
  — already reject a recording missing its siblings.
- `packages/engine/src/stubs.ts` — the response shapes `stubhouse` must
  serve.
- `packages/engine/src/redact.ts` — `redactDeep`, `maskPhone`, `preview`.
- `scripts/drift-check.ts` — already validates *any* run's node list
  against `content/workflow.json`, recording or simulator alike; a captured
  run does not need a new drift mechanism, only to pass the existing one.

## capture/package.json

Present as a workspace member (`pnpm-workspace.yaml` already lists
`capture`) so `pnpm install` resolves it and M1 has a place to add
dependencies without a second setup pass. It declares no scripts yet —
there is nothing to run.
