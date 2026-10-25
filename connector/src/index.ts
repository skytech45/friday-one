/**
 * FRIDAY Connector entrypoint.
 *
 * STATUS: pairing verified end-to-end; gateway connection LIVE (Phase 4);
 * command execution via the ACP adapter behind the fail-closed policy gate
 * (Phase 5). Remaining: permission-request round trips, PTY bridge migration.
 *
 * Security posture: runs as a dedicated unprivileged account; its only
 * secret is its own revocable credential; every command passes the policy
 * gate immediately before execution — fail closed.
 */
import { loadConfig, readCredential } from "./config.js";
import { installCredential } from "./pairing.js";
import { enroll } from "./enroll.js";
import { decide } from "./policy.js";
import { AcpAgent } from "./acp.js";
import { GatewayConnection } from "./gateway.js";
import { createHash, randomBytes } from "node:crypto";

const CONNECTOR_VERSION = "0.1.0";

/** Identity holder: filled from the gateway's auth.resume.ok (mutable ref). */
const ids = { serverId: "00000000-0000-0000-0000-000000000000", connectorId: "" };

let agent: AcpAgent | null = null;
let conn: GatewayConnection | null = null;
/** Live job → ACP session map so command.cancel can kill the right session. */
const liveJobs = new Map<string, string>(); // jobId -> acp sessionId

/** SHA-256 hex of a string (for the rotation handshake). */
function sha256hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

/**
 * Credential rotation (plan §8): the control plane signals `rotation_due`
 * via policy sync; the connector generates a NEW random secret locally and
 * submits ONLY its hash. On ack it swaps the credential file atomically —
 * the old credential stays valid for the server-side grace window, so
 * in-flight dispatches finish.
 */
async function maybeRotate(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    const current = readCredential(cfg.credentialFile);
    const sync = await fetch(`${cfg.controlPlaneUrl}/api/v1/policies/sync`, {
      headers: { "x-connector-credential": current },
      signal: AbortSignal.timeout(5000),
    });
    if (!sync.ok) return;
    const body = (await sync.json()) as { rotation_due?: boolean };
    if (!body.rotation_due) return;
    console.log("rotation due: generating new credential");
    const next = randomBytes(32).toString("base64url");
    const commit = await fetch(`${cfg.controlPlaneUrl}/api/v1/connector/rotate-credential`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-connector-credential": current },
      body: JSON.stringify({ new_credential_hash: sha256hex(next) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!commit.ok) {
      console.error(`rotation commit failed (${commit.status}); will retry on next sync`);
      return;
    }
    installCredential(cfg.credentialFile, next);
    console.log("credential rotated ✓ (old one expires server-side after grace)");
    // Force an immediate reconnect with the new credential.
    process.kill(process.pid, "SIGTERM");
  } catch (e) {
    console.error(`rotation check failed: ${(e as Error).message}`);
  }
}

/** Lazily start ONE ACP agent (hermes first — verified on this host). */
async function getAgent(cfg: ReturnType<typeof loadConfig>): Promise<AcpAgent> {
  if (agent && !agent.exited) return agent;
  const cmd = process.env.FRIDAY_ACP_CMD ?? "/home/ubuntu/.local/bin/hermes-acp";
  agent = AcpAgent.spawn(cmd, console.log);
  const info = await agent.initialize();
  console.log(`acp agent ready: ${info.name} ${info.version} (protocol ${info.protocolVersion})`);
  return agent;
}

/** The Phase-5 command loop: dispatch → policy gate → adapter → acks. */
async function handleDispatch(
  cfg: ReturnType<typeof loadConfig>,
  env: { message_id: string; payload: unknown },
): Promise<void> {
  const p = env.payload as {
    job_id?: string;
    operation?: string;
    arguments?: { root?: string; prompt?: string };
  };
  const jobId = typeof p.job_id === "string" ? p.job_id : "";
  const operation = typeof p.operation === "string" ? p.operation : "";
  const root = typeof p.arguments?.root === "string" ? p.arguments.root : "";
  const prompt = typeof p.arguments?.prompt === "string" ? p.arguments.prompt : "";
  const failJob = (reason: string): void => {
    conn!.emit("command.failed", { job_id: jobId, reason });
  };

  if (!jobId || operation !== "session.prompt" || !root || !prompt) {
    return failJob("unsupported_operation");
  }

  // Project-root containment (F-17-style boundary): the connector only works
  // inside roots configured at pairing time.
  if (cfg.allowedRoots.length > 0 && !cfg.allowedRoots.includes(root)) {
    console.warn(`dispatch denied: root ${root} not in allowedRoots`);
    return failJob("root_not_allowed");
  }

  // POLICY (plan v2 §10): fetch the EFFECTIVE rules from the control plane
  // immediately before execution — network auth is not execution auth, and a
  // policy service that cannot be reached fails CLOSED.
  let policy: import("./policy.js").LocalPolicy | null = null;
  try {
    const res = await fetch(`${cfg.controlPlaneUrl}/api/v1/policies/sync`, {
      headers: { "x-connector-credential": readCredential(cfg.credentialFile) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`sync ${res.status}`);
    policy = (await res.json()) as import("./policy.js").LocalPolicy;
  } catch {
    conn!.emit("command.failed", { job_id: jobId, reason: "policy_unavailable" }, env.message_id);
    return;
  }
  const decision = decide(policy, {
    agentId: null,
    projectRoot: root,
    action: operation,
    executable: null,
  });
  if (decision !== "allow") {
    console.warn(`dispatch denied by policy: ${decision}`);
    return failJob(`policy_${decision}`);
  }

  conn!.emit("command.accepted", { job_id: jobId }, env.message_id);
  conn!.emit("command.started", { job_id: jobId }, env.message_id);

  try {
    const a = await getAgent(cfg);
    const sessionId = await a.newSession(root);
    liveJobs.set(jobId, sessionId);
    let deltaSeq = 0;
    try {
      const result = await a.prompt(sessionId, prompt, (delta) => {
        deltaSeq += 1;
        conn!.emit(
          "chat.delta",
          { job_id: jobId, session_id: sessionId, delta, seq: deltaSeq },
          env.message_id,
        );
      });
      conn!.emit(
        "command.completed",
        { job_id: jobId, result_summary: { stopReason: result.stopReason, session_id: sessionId } },
        env.message_id,
      );
      console.log(`job ${jobId} completed (${deltaSeq} deltas, stop=${result.stopReason})`);
    } finally {
      liveJobs.delete(jobId);
    }
  } catch (err) {
    console.error(`job ${jobId} failed:`, err instanceof Error ? err.message : err);
    conn!.emit("command.failed", { job_id: jobId, reason: "execution_failed" }, env.message_id);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const command = process.argv[2] ?? "run";

  if (command === "enroll") {
    // Plan v2: token comes from the app's version-pinned install command.
    const token = process.env.FRIDAY_ENROLLMENT_TOKEN ?? process.argv[3] ?? "";
    if (!token) throw new Error("FRIDAY_ENROLLMENT_TOKEN required for `enroll` (from the app's install command)");
    await enroll(cfg.controlPlaneUrl, token, cfg.credentialFile);
    return;
  }

  if (command === "run") {
    const credential = readCredential(cfg.credentialFile);
    console.log(`connector ${CONNECTOR_VERSION} starting`);

    if (cfg.gatewayUrl) {
      conn = new GatewayConnection({
        url: cfg.gatewayUrl,
        ids,
        credential: () => readCredential(cfg.credentialFile),
        onMessage: (env) => {
          if (env.event_type === "auth.resume.ok") {
            const p = env.payload as { server_id?: string; connector_id?: string };
            if (typeof p.server_id === "string") ids.serverId = p.server_id;
            if (typeof p.connector_id === "string") ids.connectorId = p.connector_id;
            console.log(`gateway accepted us: server=${ids.serverId} connector=${ids.connectorId}`);
            return;
          }
          if (env.event_type === "command.dispatch") {
            void handleDispatch(cfg, env).catch((e) => console.error("dispatch error:", e.message));
            return;
          }
          if (env.event_type === "command.cancel") {
            const jobId = (env.payload as { job_id?: string }).job_id ?? "";
            const sessionId = liveJobs.get(jobId);
            if (agent && sessionId) {
              agent.cancel(sessionId); // ACP session/cancel — prompt rejects, job exits
              console.log(`cancel: job ${jobId.slice(0, 8)} session ${sessionId.slice(0, 10)}`);
            } else {
              console.log(`cancel: job ${jobId.slice(0, 8)} not live (already finished)`);
            }
            return;
          }
          console.log(`[gateway] inbound: ${env.event_type}`);
        },
        log: console.log,
      });
      conn.start();
    } else {
      console.warn("[config] FRIDAY_GATEWAY_URL not set: running disconnected");
    }

    // Policy is REMOTE (per-dispatch, fail closed); the same sync response
    // carries the rotation-due signal — checked on boot and every 60 s.
    void maybeRotate(cfg);
    setInterval(() => { void maybeRotate(cfg); }, 60_000);
    return;
  }

  throw new Error(`unknown command: ${command} (use: enroll | run)`);
}

process.on("SIGTERM", () => {
  agent?.shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error("connector failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
