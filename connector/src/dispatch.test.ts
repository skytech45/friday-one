/**
 * Integration: the real connector process against a fake control plane and
 * a fake gateway. Proves that slowing the background rotation check did NOT
 * remove the policy fetch before execution:
 *   - after boot there is one rotation-check sync, then no periodic syncs;
 *   - a dispatch triggers a fresh policy sync BEFORE the job outcome, a deny
 *     rule fails the job, and an unreachable policy service fails it closed.
 *
 * Linux/macOS only: the connector refuses credential files readable by
 * group/others, and Windows reports every file that way (config.ts).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

const skip = process.platform === "win32" && "Windows cannot express a 0600 credential file (runs on CI/Linux)";
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  syncs: number[];
  gatewayIn: Array<{ type: string; payload: Record<string, unknown>; at: number }>;
  out: string;
  send: (eventType: string, payload: unknown) => void;
  stop: () => Promise<void>;
}

async function start(policy: "deny" | "unavailable-after-boot"): Promise<Harness> {
  const syncs: number[] = [];
  const control = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/v1/policies/sync")) {
      syncs.push(Date.now());
      if (policy === "unavailable-after-boot" && syncs.length > 1) {
        res.statusCode = 500;
        return res.end("{}");
      }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        version: 1,
        server_id: "s",
        rotation_due: false,
        rules: [{
          id: "r1", server_scoped: true, agent_id: null, project_root: null,
          action: "session.prompt", executable: null, decision: "deny", priority: 1, expires_at: null,
        }],
      }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));

  const gatewayIn: Harness["gatewayIn"] = [];
  let socket: WebSocket | null = null;
  const serverId = randomUUID();
  const envelope = (eventType: string, payload: unknown): string => JSON.stringify({
    protocol_version: 1, message_id: randomUUID(), correlation_id: null, server_id: serverId,
    connector_id: null, agent_id: null, session_id: null, event_type: eventType,
    issued_at: new Date().toISOString(), expires_at: null, sequence: 1, idempotency_key: null, payload,
  });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const env = JSON.parse(String(raw)) as { event_type: string; payload: Record<string, unknown> };
      gatewayIn.push({ type: env.event_type, payload: env.payload ?? {}, at: Date.now() });
      if (env.event_type === "auth.connector") {
        ws.send(envelope("auth.resume.ok", { server_id: serverId, connector_id: randomUUID(), owner_id: "o" }));
      }
    });
  });
  await new Promise<void>((r) => wss.once("listening", r));

  const dir = mkdtempSync(join(tmpdir(), "friday-connector-"));
  const credentialFile = join(dir, "credential");
  writeFileSync(credentialFile, "test-credential");
  chmodSync(credentialFile, 0o600);
  const agentStub = join(dir, "opencode"); // never executed: policy denies first
  writeFileSync(agentStub, "#!/bin/sh\nexit 1\n");
  chmodSync(agentStub, 0o755);

  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "run"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      FRIDAY_CONTROL_PLANE_URL: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
      FRIDAY_GATEWAY_URL: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      FRIDAY_CREDENTIAL_FILE: credentialFile,
      FRIDAY_ALLOWED_ROOTS: "/srv/app",
      FRIDAY_ACP_OPENCODE_CMD: `${agentStub} acp`,
      FRIDAY_ACP_HERMES_CMD: "/nonexistent/hermes acp",
      FRIDAY_ROTATION_CHECK_MS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const h: Harness = {
    syncs,
    gatewayIn,
    out: "",
    send: (eventType, payload) => socket?.send(envelope(eventType, payload)),
    stop: async () => {
      child.kill("SIGTERM");
      wss.close();
      control.close();
    },
  };
  child.stdout?.on("data", (d) => (h.out += d));
  child.stderr?.on("data", (d) => (h.out += d));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(syncs.length >= 1 && gatewayIn.some((m) => m.type === "auth.connector"))) await wait(50);
  assert.ok(syncs.length >= 1, `connector did not boot:\n${h.out}`);
  return h;
}

async function dispatchAndWaitForFailure(h: Harness): Promise<{ reason: unknown; at: number }> {
  h.send("command.dispatch", {
    job_id: "job-1",
    operation: "session.prompt",
    arguments: { root: "/srv/app", prompt: "hello", agent: "opencode" },
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const failed = h.gatewayIn.find((m) => m.type === "command.failed");
    if (failed) return { reason: failed.payload.reason, at: failed.at };
    await wait(50);
  }
  throw new Error(`no command.failed:\n${h.out}`);
}

test("background checks are slow, but every dispatch fetches policy first and obeys it", { skip }, async () => {
  const h = await start("deny");
  try {
    assert.match(h.out, /rotation check every 900s/);
    await wait(2_000);
    assert.equal(h.syncs.length, 1, "only the boot rotation check, no periodic burst");

    const { reason, at } = await dispatchAndWaitForFailure(h);
    assert.equal(reason, "policy_deny");
    assert.equal(h.syncs.length, 2, "a fresh policy fetch for the dispatch");
    assert.ok(h.syncs[1]! <= at, "policy fetched before the outcome");
    assert.ok(!h.gatewayIn.some((m) => m.type === "command.accepted"), "denied work is never accepted");
  } finally {
    await h.stop();
  }
});

test("an unreachable policy service fails the dispatch closed", { skip }, async () => {
  const h = await start("unavailable-after-boot");
  try {
    const { reason } = await dispatchAndWaitForFailure(h);
    assert.equal(reason, "policy_unavailable");
    assert.ok(!h.gatewayIn.some((m) => m.type === "command.accepted"));
  } finally {
    await h.stop();
  }
});
