// Shared helpers for the audit harnesses.
//
// THE PROCESS-GROUP PROBLEM: the harnesses spawn the server via
// `spawn("npx", ["tsx", "src/index.ts"])`. `npx` is a wrapper that execs node,
// so `server.kill()` signals the WRAPPER and the actual server (a grandchild)
// survives. A surviving server:
//   - keeps holding the TCP port, so the next run's server fails to bind and
//     the harness silently talks to the OLD instance (with the OLD JWT secret,
//     the OLD schema and the OLD code) — this produced several completely
//     bogus test results during the audit;
//   - keeps holding the database, so the next run's CREATE DATABASE fails.
//
// The fix: spawn with `detached: true` so the child becomes a process-group
// leader, then kill the whole group with `process.kill(-pid)`.

import { spawn } from "node:child_process";

/**
 * Spawn a process in its own process group so the whole tree can be killed.
 * Pass `detached: true` and then call `killGroup()` on it.
 */
export function spawnGrouped(cmd, args, opts = {}) {
  return spawn(cmd, args, { ...opts, detached: true });
}

/**
 * Kill a process group spawned by spawnGrouped, escalating to SIGKILL.
 * Safe to call more than once.
 */
export function killGroup(child, label = "server") {
  if (!child || child.pid === undefined) return;
  const pid = child.pid;
  const signalGroup = (sig) => {
    try { process.kill(-pid, sig); } catch { /* already gone */ }
  };
  signalGroup("SIGTERM");
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-pid, 0); } catch { return; } // group is gone
    signalGroup("SIGKILL");
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 1500);
}

/**
 * Wait until `url` answers, or give up. Returns true on success.
 */
export async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
  }
  return false;
}

/**
 * Abort if the port is already serving something. A stale server answering on
 * the harness port invalidates every result, so this is a hard failure.
 */
export async function assertPortFree(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
  if (res && res.ok) {
    console.error(`ABORT: port ${port} is already serving a FRIDAY server.`);
    console.error("A stale instance would answer with the wrong JWT secret and");
    console.error("the wrong code. Kill it first:");
    console.error(`  fuser -k ${port}/tcp   # or: ss -ltnp | grep ${port}`);
    process.exit(1);
  }
}
