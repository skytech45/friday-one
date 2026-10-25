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
import { enroll } from "./enroll.js";
import { decide, loadPolicy } from "./policy.js";
import { AcpAgent } from "./acp.js";
import { GatewayConnection } from "./gateway.js";
const CONNECTOR_VERSION = "0.1.0";
/** Identity holder: filled from the gateway's auth.resume.ok (mutable ref). */
const ids = { serverId: "00000000-0000-0000-0000-000000000000", connectorId: "" };
let agent = null;
let conn = null;
/** Lazily start ONE ACP agent (hermes first — verified on this host). */
async function getAgent(cfg) {
    if (agent && !agent.exited)
        return agent;
    const cmd = process.env.FRIDAY_ACP_CMD ?? "/home/ubuntu/.local/bin/hermes-acp";
    agent = AcpAgent.spawn(cmd, console.log);
    const info = await agent.initialize();
    console.log(`acp agent ready: ${info.name} ${info.version} (protocol ${info.protocolVersion})`);
    return agent;
}
/** The Phase-5 command loop: dispatch → policy gate → adapter → acks. */
async function handleDispatch(cfg, env) {
    const p = env.payload;
    const jobId = typeof p.job_id === "string" ? p.job_id : "";
    const operation = typeof p.operation === "string" ? p.operation : "";
    const root = typeof p.arguments?.root === "string" ? p.arguments.root : "";
    const prompt = typeof p.arguments?.prompt === "string" ? p.arguments.prompt : "";
    const failJob = (reason) => {
        conn.emit("command.failed", { job_id: jobId, reason });
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
    // The POLICY GATE — final local authority, fail closed. Rechecked here even
    // though the gateway authorized ownership: network auth ≠ execution auth.
    let policy = null;
    try {
        policy = loadPolicy(cfg.policyDir);
    }
    catch {
        /* fail closed below */
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
    conn.emit("command.accepted", { job_id: jobId }, env.message_id);
    conn.emit("command.started", { job_id: jobId }, env.message_id);
    try {
        const a = await getAgent(cfg);
        const sessionId = await a.newSession(root);
        let deltaSeq = 0;
        const result = await a.prompt(sessionId, prompt, (delta) => {
            deltaSeq += 1;
            conn.emit("chat.delta", { job_id: jobId, session_id: sessionId, delta, seq: deltaSeq }, env.message_id);
        });
        conn.emit("command.completed", { job_id: jobId, result_summary: { stopReason: result.stopReason, session_id: sessionId } }, env.message_id);
        console.log(`job ${jobId} completed (${deltaSeq} deltas, stop=${result.stopReason})`);
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
                        return;
                    }
                    if (env.event_type === "command.dispatch") {
                        void handleDispatch(cfg, env).catch((e) => console.error("dispatch error:", e.message));
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
        // Policy file presence is a startup assertion: the gate must have
        // SOMETHING to enforce, even an empty rule set, or we fail closed loudly.
        try {
            const policy = loadPolicy(cfg.policyDir);
            console.log(`policy loaded: v${policy.version}, ${policy.rules.length} rule(s)`);
        }
        catch {
            console.warn(`no policy file under ${cfg.policyDir}: fail-closed defaults apply`);
        }
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
