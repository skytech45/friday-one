/**
 * FRIDAY One realtime gateway — single instance (SYSTEM_DESIGN §2: a shared
 * routing layer is only needed multi-instance; durable state lives in
 * Supabase regardless).
 *
 * Two principals connect here, BOTH authenticated per message and per socket:
 *   - connectors: `auth.connector` with the pairing-issued credential
 *     (hash-checked against connector_credentials; revoked/expired refused)
 *   - app clients: `auth.app` with a Supabase access token (JWKS-verified)
 *
 * A live socket is transport, never authorization: every sensitive message is
 * re-checked against durable state before routing (§16.5/6).
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ENVELOPE_BASE } from "./protocol.js";
import { findLiveCredential, getServerForCredential, touchLastSeen, upsertQueuedJob, setJobState, findQueuedJob, persistPermissionRequest, decidePermissionRequest, } from "./supabase.js";
const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1"; // loopback; TLS via tunnel/reverse proxy
const MAX_PAYLOAD = 1_048_576; // 1 MiB per message
const SUPABASE_URL = process.env.SUPABASE_URL.replace(/\/$/, "");
const JWKS = createRemoteJWKSet(new URL(process.env.SUPABASE_JWKS_URL));
const connections = new Set();
const connectorsByServer = new Map(); // one live conn per server
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
/** --- app auth ------------------------------------------------------------ */
async function verifyAppToken(token) {
    try {
        const { payload } = await jwtVerify(token, JWKS, { issuer: `${SUPABASE_URL}/auth/v1` });
        return typeof payload.sub === "string" ? payload.sub : null;
    }
    catch {
        return null;
    }
}
/** --- envelope plumbing ---------------------------------------------------- */
function sendTo(conn, env) {
    if (conn.socket.readyState === WebSocket.OPEN)
        conn.socket.send(JSON.stringify(env));
}
function errorClose(socket, code, reason) {
    try {
        socket.close(code, reason);
    }
    catch {
        /* already closing */
    }
}
let seqCounter = Date.now() % 1_000_000;
function gatewayEnvelope(fields) {
    return {
        protocol_version: 1,
        message_id: crypto.randomUUID(),
        correlation_id: fields.correlationId,
        server_id: fields.serverId,
        connector_id: fields.connectorId,
        agent_id: null,
        session_id: null,
        event_type: fields.eventType,
        issued_at: new Date().toISOString(),
        expires_at: null,
        sequence: seqCounter++,
        idempotency_key: null,
        payload: fields.payload,
    };
}
/** --- routing --------------------------------------------------------------- */
async function handleConnectorMessage(conn, env) {
    switch (env.event_type) {
        case "connector.heartbeat": {
            await touchLastSeen(conn.serverId);
            return;
        }
        case "command.accepted":
        case "command.started": {
            const jobId = env.payload.job_id;
            if (typeof jobId !== "string")
                return;
            const job = await findQueuedJob(jobId);
            if (!job || job.server_id !== conn.serverId)
                return; // forged id: ignore
            const state = env.event_type === "command.accepted" ? "accepted" : "started";
            await setJobState(jobId, state);
            forwardToOwnerApps(conn.ownerId, env);
            return;
        }
        case "command.completed":
        case "command.failed": {
            const jobId = env.payload.job_id;
            if (typeof jobId !== "string")
                return;
            const job = await findQueuedJob(jobId);
            if (!job || job.server_id !== conn.serverId)
                return;
            const state = env.event_type === "command.completed" ? "completed" : "failed";
            await setJobState(jobId, state, env.payload.result_summary);
            forwardToOwnerApps(conn.ownerId, env);
            return;
        }
        case "permission.requested": {
            const p = env.payload;
            if (typeof p.operation !== "string" || typeof p.payload_hash !== "string")
                return;
            const stored = await persistPermissionRequest({
                serverId: conn.serverId,
                connectorId: conn.connectorId,
                agentId: env.agent_id,
                sessionId: env.session_id,
                operation: p.operation,
                payloadHash: p.payload_hash,
                policyVersion: typeof p.policy_version === "number" ? p.policy_version : null,
                ttlSeconds: typeof p.ttl_seconds === "number" ? Math.min(p.ttl_seconds, 3600) : 600,
            });
            // Notify the owner's app connections with the DURABLE request id.
            const notify = gatewayEnvelope({
                correlationId: env.correlation_id,
                serverId: conn.serverId,
                connectorId: conn.connectorId,
                eventType: "permission.requested",
                payload: {
                    request_id: stored.id,
                    operation: p.operation,
                    payload_hash: p.payload_hash,
                    expires_at: stored.expires_at,
                },
            });
            forwardToOwnerApps(conn.ownerId, notify);
            return;
        }
        default:
            log(`connector ${conn.serverId}: unhandled ${env.event_type} (ignored)`);
    }
}
async function handleAppMessage(conn, env) {
    switch (env.event_type) {
        case "command.submit": {
            const p = env.payload;
            const serverId = typeof p.server_id === "string" ? p.server_id : "";
            if (typeof p.operation !== "string" || !serverId) {
                sendTo(conn, gatewayEnvelope({
                    correlationId: env.message_id, serverId, connectorId: null,
                    eventType: "command.rejected", payload: { reason: "invalid_payload" },
                }));
                return;
            }
            // Authorization: the submitting user must OWN the target server —
            // verified against durable state, never the payload.
            const connector = connectorsByServer.get(serverId);
            if (!connector || connector.ownerId !== conn.userId) {
                sendTo(conn, gatewayEnvelope({
                    correlationId: env.message_id, serverId, connectorId: null,
                    eventType: "command.rejected", payload: { reason: "server_offline_or_forbidden" },
                }));
                return;
            }
            const idem = typeof p.idempotency_key === "string" && p.idempotency_key
                ? p.idempotency_key
                : crypto.randomUUID();
            const job = await upsertQueuedJob(serverId, idem, p.operation);
            const dispatch = gatewayEnvelope({
                correlationId: env.message_id,
                serverId,
                connectorId: connector.connectorId,
                eventType: "command.dispatch",
                payload: { job_id: job.id, operation: p.operation, arguments: p.arguments ?? null },
                // idempotency flows through so replays cannot double-execute
            });
            dispatch.idempotency_key = idem;
            sendTo(connector, dispatch);
            return;
        }
        case "permission.decided": {
            const p = env.payload;
            if (typeof p.request_id !== "string" || (p.decision !== "allow" && p.decision !== "deny"))
                return;
            // The stored request proves ownership AND the live connector binding.
            const connector = [...connectorsByServer.values()].find((c) => c.ownerId === conn.userId);
            const decision = await decidePermissionRequest(p.request_id, conn.userId, p.decision === "allow" ? "approved" : "denied");
            if (!decision)
                return; // not pending / not theirs / replay
            // Forward ONLY to the connector it was requested by (durable row knows).
            const target = [...connectorsByServer.values()].find((c) => c.serverId === decision.server_id && c.ownerId === conn.userId);
            if (target) {
                sendTo(target, gatewayEnvelope({
                    correlationId: null, serverId: decision.server_id, connectorId: target.connectorId,
                    eventType: "permission.decided",
                    payload: {
                        request_id: decision.id,
                        decision: p.decision,
                        payload_hash: decision.payload_hash,
                        policy_version: decision.policy_version,
                        decided_by: conn.userId,
                    },
                }));
            }
            return;
        }
        default:
            log(`app ${conn.userId}: unhandled ${env.event_type} (ignored)`);
    }
}
function forwardToOwnerApps(ownerId, env) {
    for (const c of connections) {
        if (c.kind === "app" && c.userId === ownerId)
            sendTo(c, env);
    }
}
/** --- websocket server ------------------------------------------------------ */
const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "friday-one-gateway" }));
});
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
wss.on("connection", (socket) => {
    let conn = null;
    socket.on("message", (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(String(raw));
        }
        catch {
            return errorClose(socket, 4400, "malformed_json");
        }
        const env = ENVELOPE_BASE.safeParse(parsed);
        if (!env.success)
            return errorClose(socket, 4400, "invalid_envelope");
        if (!conn) {
            // First message MUST authenticate.
            (async () => {
                if (env.data.event_type === "auth.connector") {
                    const credential = env.data.payload.credential;
                    if (typeof credential !== "string")
                        return errorClose(socket, 4401, "unauthenticated");
                    const cred = await findLiveCredential(credential);
                    if (!cred)
                        return errorClose(socket, 4403, "credential_revoked");
                    const server = await getServerForCredential(cred);
                    if (!server)
                        return errorClose(socket, 4403, "server_not_active");
                    const existing = connectorsByServer.get(server.id);
                    if (existing)
                        existing.socket.close(4529, "superseded");
                    conn = { kind: "connector", serverId: server.id, ownerId: server.owner_id, connectorId: cred.id, socket };
                    connections.add(conn);
                    connectorsByServer.set(server.id, conn);
                    sendTo(conn, gatewayEnvelope({
                        correlationId: env.data.message_id, serverId: server.id, connectorId: cred.id,
                        eventType: "auth.resume.ok",
                        payload: { server_id: server.id, connector_id: cred.id, owner_id: server.owner_id },
                    }));
                    log(`connector connected: server=${server.id}`);
                }
                else if (env.data.event_type === "auth.app") {
                    const token = env.data.payload.token;
                    if (typeof token !== "string")
                        return errorClose(socket, 4401, "unauthenticated");
                    const userId = await verifyAppToken(token);
                    if (!userId)
                        return errorClose(socket, 4403, "invalid_token");
                    conn = { kind: "app", userId, socket };
                    connections.add(conn);
                    sendTo(conn, gatewayEnvelope({
                        correlationId: env.data.message_id, serverId: crypto.randomUUID(), connectorId: null,
                        eventType: "auth.resume.ok", payload: { user_id: userId },
                    }));
                    log(`app connected: user=${userId}`);
                }
                else {
                    errorClose(socket, 4401, "authenticate_first");
                }
            })().catch((e) => {
                log(`auth error: ${e.message}`);
                errorClose(socket, 1011, "auth_failed");
            });
            return;
        }
        if (conn.kind === "connector") {
            void handleConnectorMessage(conn, env.data).catch((e) => log(`connector msg error: ${e.message}`));
        }
        else {
            void handleAppMessage(conn, env.data).catch((e) => log(`app msg error: ${e.message}`));
        }
    });
    socket.on("close", () => {
        if (!conn)
            return;
        connections.delete(conn);
        if (conn.kind === "connector" && connectorsByServer.get(conn.serverId) === conn) {
            connectorsByServer.delete(conn.serverId);
            log(`connector disconnected: server=${conn.serverId}`);
        }
    });
    socket.on("error", () => socket.terminate());
});
server.listen(PORT, HOST, () => log(`gateway listening on ws://${HOST}:${PORT}`));
