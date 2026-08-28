#!/usr/bin/env node
// Standalone entry point for stubhouse, for manual testing/documentation:
//   node capture/stubhouse/cli.mjs --port 8788
// capture.mjs does NOT spawn this file — it imports createStubhouse()
// directly and runs it in-process (one fewer child process to manage), but
// this CLI is real and useful on its own: point curl at it, or run it
// beside a manually-launched n8n while developing the patch.
import { createStubhouse } from './server.mjs';

function arg(name, fallback) {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}

const port = Number(arg('port', '8788'));
const locationId = arg('location-id', 'loc_demo_radiant');

const stubhouse = createStubhouse({ port, locationId });
const url = await stubhouse.start();
console.log(`[stubhouse] listening on ${url}`);
console.log(`[stubhouse] routes: /ghl/*  /slack/api/*  /sheets/*  /oauth/token  /_stubhouse/{health,fault,reset,log}`);
console.log(`[stubhouse] fault switch: curl -X POST "${url}/_stubhouse/fault?set=slack401"`);

process.on('SIGINT', async () => {
  await stubhouse.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await stubhouse.stop();
  process.exit(0);
});
