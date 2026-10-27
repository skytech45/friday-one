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
import { availableAgentSpecs, probeVersion, reportedAgents, resolveAgent, } from "./agents.js";
import { GatewayConnection } from "./gateway.js";
import { rotationCheckIntervalMs, startRotationChecks } from "./rotation.js";
import { createHash, randomBytes } from "node:crypto";
const CONNECTOR_VERSION = "0.1.0";
/** Identity holder: filled from the gateway's auth.resume.ok (mutable ref). */
const ids = { serverId: "00000000-0000-0000-0000-000000000000", connectorId: "" };
/** One ACP child per selected adapter — never a single global agent. */
const agents = new Map();
/** Version strings learned at spawn time (reported to the app). */
const agentVersions = new Map();
let conn = null;
/** Live job → ACP session map so command.cancel can kill the right agent. */
const liveJobs = new Map();
/** SHA-256 hex of a string (for the rotation handshake). */
function sha256hex(v) {
    return createHash("sha256").update(v).digest("hex");
}
/**
 * Credential rotation (plan §8): the control plane signals `rotation_due`
 * via policy sync; the connector generates a NEW random secret locally and
 * submits ONLY its hash. On ack it swaps the credential file atomically —
 * the old credential stays valid for the server-side grace window, so
 * in-flight dispatches finish.
 */
async function maybeRotate(cfg) {
    try {
        const current = readCredential(cfg.credentialFile);
        const sync = await fetch(`${cfg.controlPlaneUrl}/api/v1/policies/sync`, {
            headers: { "x-connector-credential": current },
            signal: AbortSignal.timeout(5000),
        });
        if (!sync.ok)
            return;
        const body = (await sync.json());
        if (!body.rotation_due)
            return;
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
    }
    catch (e) {
        console.error(`rotation check failed: ${e.message}`);
    }
}
/**
 * Report what this host can run. Sent after every (re)connect and again when
 * a version is learned at first spawn — the app's pickers are driven by this,
 * never by a hardcoded list in the client.
 */
function reportCapabilities(cfg) {
    if (!conn)
        return;
    const specs = availableAgentSpecs();
    conn.emit("connector.hello", {
        connector_version: CONNECTOR_VERSION,
        agents: reportedAgents(specs, agentVersions),
        // Roots are owner-configured (FRIDAY_ALLOWED_ROOTS) and already enforced
        // locally; reporting them lets the app offer a project selector.
        projects: cfg.allowedRoots.map((root) => ({
            root,
            label: root.split("/").filter(Boolean).pop() ?? root,
        })),
    });
    console.log(`capabilities: agents=[${specs.map((s) => s.adapter).join(", ")}] ` +
        `projects=${cfg.allowedRoots.length}`);
}
/** Lazily start the ACP agent for a specific adapter. */
async function getAgent(cfg, spec) {
    const existing = agents.get(spec.adapter);
    if (existing && !existing.exited)
        return existing;
    const a = AcpAgent.spawn(spec.cmd, console.log);
    agents.set(spec.adapter, a);
    const info = await a.initialize();
    agentVersions.set(spec.adapter, info.version || null);
    console.log(`acp agent ready: ${spec.adapter} (${info.name} ${info.version}, protocol ${info.protocolVersion})`);
    reportCapabilities(cfg); // version is now known
    return a;
}
/** The Phase-5 command loop: dispatch → policy gate → adapter → acks. */
async function handleDispatch(cfg, env) {
    const p = env.payload;
    const jobId = typeof p.job_id === "string" ? p.job_id : "";
    const operation = typeof p.operation === "string" ? p.operation : "";
    const root = typeof p.arguments?.root === "string" ? p.arguments.root : "";
    const prompt = typeof p.arguments?.prompt === "string" ? p.arguments.prompt : "";
    const requestedAgent = typeof p.arguments?.agent === "string" ? p.arguments.agent : null;
    const failJob = (reason) => {
        conn.emit("command.failed", { job_id: jobId, reason });
    };
    if (!jobId || operation !== "session.prompt" || !root || !prompt) {
        return failJob("unsupported_operation");
    }
    // Agent selection (§7/§9): the app picks an adapter it saw reported; the
    // connector maps it to a LOCAL spec and refuses anything else. Unknown
    // adapter = fail closed, never a silent fallback to a different agent.
    const available = availableAgentSpecs();
    const spec = resolveAgent(available, requestedAgent);
    if (!spec) {
        console.warn(`dispatch denied: agent ${requestedAgent} unavailable`);
        return failJob("agent_unavailable");
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
    let policy = null;
    try {
        const res = await fetch(`${cfg.controlPlaneUrl}/api/v1/policies/sync`, {
            headers: { "x-connector-credential": readCredential(cfg.credentialFile) },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            throw new Error(`sync ${res.status}`);
        policy = (await res.json());
    }
    catch {
        conn.emit("command.failed", { job_id: jobId, reason: "policy_unavailable" }, env.message_id);
        return;
    }
    const decision = decide(policy, {
        agentId: env.agent_id ?? null,
        projectRoot: root,
        action: operation,
        executable: null,
    });
    if (decision !== "allow") {
        console.warn(`dispatch denied by policy: ${decision}`);
        return failJob(`policy_${decision}`);
    }
    conn.emit("command.accepted", { job_id: jobId, agent: spec.adapter }, env.message_id);
    conn.emit("command.started", { job_id: jobId, agent: spec.adapter }, env.message_id);
    try {
        const a = await getAgent(cfg, spec);
        const sessionId = await a.newSession(root);
        liveJobs.set(jobId, { sessionId, adapter: spec.adapter });
        let deltaSeq = 0;
        try {
            const result = await a.prompt(sessionId, prompt, (delta) => {
                deltaSeq += 1;
                conn.emit("chat.delta", { job_id: jobId, session_id: sessionId, agent: spec.adapter, delta, seq: deltaSeq }, env.message_id);
            });
            conn.emit("command.completed", {
                job_id: jobId,
                result_summary: {
                    stopReason: result.stopReason,
                    session_id: sessionId,
                    agent: spec.adapter,
                },
            }, env.message_id);
            console.log(`job ${jobId} completed on ${spec.adapter} (${deltaSeq} deltas, stop=${result.stopReason})`);
        }
        finally {
            liveJobs.delete(jobId);
        }
    }
    catch (err) {
        console.error(`job ${jobId} failed:`, err instanceof Error ? err.message : err);
        conn.emit("command.failed", { job_id: jobId, reason: "execution_failed" }, env.message_id);
    }
}
async function main() {
    const cfg = loadConfig();
    const command = process.argv[2] ?? "run";
    if (command === "enroll") {
        // Plan v2: token comes from the app's version-pinned install command.
        const token = process.env.FRIDAY_ENROLLMENT_TOKEN ?? process.argv[3] ?? "";
        if (!token)
            throw new Error("FRIDAY_ENROLLMENT_TOKEN required for `enroll` (from the app's install command)");
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
                        const p = env.payload;
                        if (typeof p.server_id === "string")
                            ids.serverId = p.server_id;
                        if (typeof p.connector_id === "string")
                            ids.connectorId = p.connector_id;
                        console.log(`gateway accepted us: server=${ids.serverId} connector=${ids.connectorId}`);
                        // Probe versions off the auth path, then publish capabilities so
                        // the app can populate its agent/project pickers.
                        setTimeout(() => {
                            for (const s of availableAgentSpecs()) {
                                if (!agentVersions.has(s.adapter)) {
                                    const v = probeVersion(s.cmd);
                                    if (v)
                                        agentVersions.set(s.adapter, v);
                                }
                            }
                            reportCapabilities(cfg);
                        }, 0);
                        return;
                    }
                    if (env.event_type === "command.dispatch") {
                        void handleDispatch(cfg, env).catch((e) => console.error("dispatch error:", e.message));
                        return;
                    }
                    if (env.event_type === "command.cancel") {
                        const jobId = env.payload.job_id ?? "";
                        const live = liveJobs.get(jobId);
                        const a = live ? agents.get(live.adapter) : undefined;
                        if (a && live) {
                            a.cancel(live.sessionId); // ACP session/cancel — prompt rejects, job exits
                            console.log(`cancel: job ${jobId.slice(0, 8)} ${live.adapter} session ${live.sessionId.slice(0, 10)}`);
                        }
                        else {
                            console.log(`cancel: job ${jobId.slice(0, 8)} not live (already finished)`);
                        }
                        return;
                    }
                    console.log(`[gateway] inbound: ${env.event_type}`);
                },
                log: console.log,
            });
            conn.start();
        }
        else {
            console.warn("[config] FRIDAY_GATEWAY_URL not set: running disconnected");
        }
        // Policy is REMOTE and fetched before EVERY execution (handleDispatch,
        // fail closed). The same sync response carries the rotation-due signal,
        // which is checked on boot and then on a slower background cadence.
        const rotationEvery = rotationCheckIntervalMs();
        console.log(`rotation check every ${rotationEvery / 1000}s`);
        startRotationChecks(() => maybeRotate(cfg), rotationEvery);
        return;
    }
    throw new Error(`unknown command: ${command} (use: enroll | run)`);
}
process.on("SIGTERM", () => {
    for (const a of agents.values())
        a.shutdown();
    process.exit(0);
});
main().catch((err) => {
    console.error("connector failed:", err instanceof Error ? err.message : err);
    process.exit(1);
});
