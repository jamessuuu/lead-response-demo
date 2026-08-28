#!/usr/bin/env node
/**
 * Runs the Playwright suite against a real preview server, managing that
 * server's lifecycle by hand instead of via Playwright's own `webServer`
 * option.
 *
 * Why: on Windows, `pnpm --filter @lrd/site preview` is a multi-level
 * process tree (cmd.exe -> pnpm.cmd -> node -> astro preview), and pnpm's
 * own CLI wrapper routinely exits after spawning astro (a thin delegator),
 * detaching the real server from the PID Node's `spawn()` handed back.
 * Two failure modes were reproduced back to back while building this
 * script: Playwright's webServer teardown killed only that now-empty
 * wrapper PID and left the real astro-preview process (a DIFFERENT PID)
 * still bound to port 4321, so the *next* run failed immediately with
 * "already used, set reuseExistingServer:true" before it ever spawned
 * anything; and even a direct `taskkill /PID <spawned-pid> /T /F` missed it
 * for the same re-parenting reason. The only mechanism that reliably works
 * is asking Windows who currently owns the port and killing that PID.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4321;
const URL = `http://127.0.0.1:${PORT}/`;
const IS_WINDOWS = process.platform === 'win32';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
    p.on('error', reject);
  });
}

/** Runs a command, capturing stdout instead of inheriting it. */
function capture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('exit', () => resolve(out));
    p.on('error', () => resolve(out));
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${URL}`);
}

/** Best-effort: kill the process tree rooted at a PID Node itself spawned. */
async function killTree(pid) {
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    await new Promise((resolve) => {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true });
      p.on('exit', () => resolve());
      p.on('error', () => resolve());
    });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Authoritative: kill whichever process is actually bound to PORT right now. */
async function killPortOwner(port) {
  if (IS_WINDOWS) {
    const out = await capture('powershell', [
      '-NoProfile',
      '-Command',
      `"Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
    ]);
    const pids = [...new Set(out.split(/\s+/).filter((s) => /^\d+$/.test(s)))];
    for (const pid of pids) {
      console.log(`[e2e] killing PID ${pid} (owns port ${port})`);
      await new Promise((resolve) => {
        const p = spawn('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore', shell: true });
        p.on('exit', () => resolve());
        p.on('error', () => resolve());
      });
    }
  }
  // Non-Windows CI (none currently configured) can add the lsof/fuser
  // equivalent here if this script ever needs to run there.
}

async function main() {
  console.log('[e2e] building site...');
  await run('pnpm', ['--filter', '@lrd/site', 'build']);

  console.log('[e2e] starting preview server...');
  const server = spawn('pnpm', ['--filter', '@lrd/site', 'preview'], {
    stdio: 'inherit',
    shell: true,
    detached: !IS_WINDOWS,
  });

  let exitCode = 1;
  try {
    await waitForServer();
    console.log('[e2e] server ready, running Playwright...');
    await run('npx', ['playwright', 'test']);
    exitCode = 0;
  } catch (err) {
    console.error('[e2e]', err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    console.log('[e2e] stopping preview server...');
    await killTree(server.pid);
    await killPortOwner(PORT);
  }
  process.exitCode = exitCode;
}

main();
