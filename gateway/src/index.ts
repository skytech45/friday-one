/**
 * FRIDAY One realtime gateway — single instance (SYSTEM_DESIGN §2: a shared
 * routing layer is only needed multi-instance; durable state lives in
 * Firestore regardless). On Cloud Run it MUST run with max-instances=1:
 * routing and replay state are in process memory.
 *
 * Two principals connect here, BOTH authenticated per message and per socket:
 *   - connectors: `auth.connector` with the pairing-issued credential
 *     (hash-checked against connectorCredentials; revoked/expired refused,
 *     and a live socket is closed when its credential or server is revoked)
 *   - app clients: `auth.app` with a Firebase ID token (Google sign-in)
 *
 * A live socket is transport, never authorization: every sensitive message is
 * re-checked against durable state before routing (§16.5/6).
 */
import http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { ENVELOPE_BASE, type Envelope } from "./protocol.js";
import { ReplayGuard } from "./replay.js";
import {
  projectId,
  verifyAppToken,
  findLiveCredential,
  getServerForCredential,
  watchConnectorAuthorization,
  touchLastSeen,
  forgetServer,
  createQueuedJob,
  setJobState,
  cancelJobIfInFlight,
  findJob,
  findAgent,
  upsertAgents,
  upsertProjects,
  persistPermissionRequest,
  decidePermissionRequest,
} from "./store.js";
import { sanitizeAgents, sanitizeProjects } from "./agents.js";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1"; // loopback; TLS via tunnel/reverse proxy
const MAX_PAYLOAD = 1_048_576; // 1 MiB per message

// Fail fast on missing security-critical env (P2): a gateway that cannot
// authenticate its principals must not boot.
// The Firebase project determines which ID tokens are accepted.
if (!projectId) {
  console.error("missing required env: FIREBASE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) — refusing to start");
  process.exit(1);
}

// Dead-connector sweep (P2): a connector whose socket is open but silent for
// 90 s (6 missed 15 s heartbeats) is terminated — half-open TCP must not
// masquerade as an online server.
const CONNECTOR_IDLE_MS = Number(process.env.CONNECTOR_IDLE_MS ?? 90_000);
setInterval(() => {
  for (const c of connectorsByServer.values()) {
    if (Date.now() - c.lastSeenMs > CONNECTOR_IDLE_MS) {
      log(`idle connector swept: server=${c.serverId}`);
      try { c.socket.terminate(); } catch { /* already gone */ }
    }
  }
}, 15_000);

interface ConnectorConn {
  kind: "connector";
  serverId: string;
  ownerId: string;
  connectorId: string;
  socket: WebSocket;
  lastSeenMs: number; // updated on any authenticated message (idle sweep)
  unwatch?: () => void; // revocation listener
}
interface AppConn {
  kind: "app";
  userId: string;
  socket: WebSocket;
}
type Conn = ConnectorConn | AppConn;

const connections = new Set<Conn>();
const connectorsByServer = new Map<string, ConnectorConn>(); // one live conn per server
const replayGuard = new ReplayGuard();
const identities = new Set<string>(); // live replay identities (cleanup marker)

const log = (m: string): void => console.log(`${new Date().toISOString()} ${m}`);

/** The live connector sockets owned by `userId` (usually one or two). */
function ownedConnectors(userId: string): ConnectorConn[] {
  return [...connectorsByServer.values()].filter((c) => c.ownerId === userId);
}

/** --- envelope plumbing ---------------------------------------------------- */
function sendTo(conn: Conn, env: Envelope): void {
  if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(JSON.stringify(env));
}

function errorClose(socket: WebSocket, code: number, reason: string): void {
  log(`closing ${code} ${reason}`);
  try {
    socket.close(code, reason);
  } catch {
    /* already closing */
  }
}

let seqCounter = Date.now() % 1_000_000;
function gatewayEnvelope(fields: {
  correlationId: string | null;
  serverId: string;
  connectorId: string | null;
  eventType: string;
  payload: unknown;
  agentId?: string | null;
}): Envelope {
  return {
    protocol_version: 1,
    message_id: crypto.randomUUID(),
    correlation_id: fields.correlationId,
    server_id: fields.serverId,
    connector_id: fields.connectorId,
    agent_id: fields.agentId ?? null,
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
async function handleConnectorMessage(conn: ConnectorConn, env: Envelope): Promise<void> {
  switch (env.event_type) {
    case "connector.heartbeat": {
      conn.lastSeenMs = Date.now();
      await touchLastSeen(conn.serverId);
      return;
    }
    case "connector.hello": {
      // Discovery report from the authenticated connector. The server id is
      // taken from the credential-bound socket, never from the payload.
      const payload = (env.payload ?? {}) as { agents?: unknown; projects?: unknown };
      const agents = sanitizeAgents(payload.agents);
      const projects = sanitizeProjects(payload.projects);
      try {
        await upsertAgents(conn.serverId, conn.ownerId, agents);
        await upsertProjects(conn.serverId, conn.ownerId, projects);
        log(
          `connector ${conn.serverId.slice(0, 8)}: ${agents.length} agent(s), ${projects.length} project(s)`,
        );
      } catch (e) {
        // Discovery is additive: a failed upsert must not drop the socket.
        log(`capabilities store failed: ${(e as Error).message}`);
      }
      return;
    }
    case "command.accepted":
    case "command.started": {
      const jobId = (env.payload as { job_id?: string }).job_id;
      if (typeof jobId !== "string") return;
      // Looked up under the connector's OWN server: a forged id finds nothing.
      const job = await findJob(conn.serverId, jobId);
      if (!job) return;
      const state = env.event_type === "command.accepted" ? "accepted" : "started";
      if (!(await setJobState(conn.serverId, jobId, state))) return; // terminal: ignore late progress
      forwardToOwnerApps(conn.ownerId, env);
      return;
    }
    // Streaming agent output: forwarded to the owner's app connections as-is
    // (bounded per message by MAX_PAYLOAD; the connector backpressures).
    case "chat.delta":
    case "session.updated": {
      forwardToOwnerApps(conn.ownerId, env);
      return;
    }
    case "command.completed":
    case "command.failed": {
      const jobId = (env.payload as { job_id?: string }).job_id;
      if (typeof jobId !== "string") return;
      const job = await findJob(conn.serverId, jobId);
      if (!job) return;
      const state = env.event_type === "command.completed" ? "completed" : "failed";
      const summary = (env.payload as { result_summary?: unknown }).result_summary;
      // A cancelled job stays cancelled; the app still sees the outcome event.
      await setJobState(conn.serverId, jobId, state, summary);
      forwardToOwnerApps(conn.ownerId, env);
      return;
    }
    case "permission.requested": {
      const p = env.payload as {
        operation?: string;
        payload_hash?: string;
        policy_version?: number;
        ttl_seconds?: number;
      };
      if (typeof p.operation !== "string" || typeof p.payload_hash !== "string") return;
      const stored = await persistPermissionRequest({
        serverId: conn.serverId,
        ownerId: conn.ownerId,
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

async function handleAppMessage(conn: AppConn, env: Envelope): Promise<void> {
  switch (env.event_type) {
    case "app.heartbeat": // keepalive from app clients; no durable effect
      return;
    case "command.submit": {
      const p = env.payload as {
        operation?: string;
        arguments?: unknown;
        idempotency_key?: string;
        server_id?: string;
      };
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

      // Agent selection (plan §7/§9): resolve the requested adapter to a row
      // this server actually reported. An unavailable adapter is rejected
      // BEFORE a job is queued; the connector re-checks locally as well.
      const requestedAgent = (p.arguments as { agent?: unknown } | null)?.agent;
      let agentId: string | null = null;
      if (requestedAgent !== undefined && requestedAgent !== null) {
        if (typeof requestedAgent !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(requestedAgent)) {
          sendTo(conn, gatewayEnvelope({
            correlationId: env.message_id, serverId, connectorId: null,
            eventType: "command.rejected", payload: { reason: "invalid_agent" },
          }));
          return;
        }
        const agent = await findAgent(serverId, requestedAgent);
        if (!agent) {
          sendTo(conn, gatewayEnvelope({
            correlationId: env.message_id, serverId, connectorId: null,
            eventType: "command.rejected", payload: { reason: "agent_not_available" },
          }));
          return;
        }
        agentId = agent.id;
      }

      const { job, created } = await createQueuedJob({
        serverId, ownerId: conn.userId, idempotencyKey: idem.slice(0, 128), operation: p.operation.slice(0, 200), agentId,
      });
      if (!created) {
        // Same (server, idempotency key) as an earlier submit: never execute
        // twice. Tell the app which job it already is (F-M15).
        sendTo(conn, gatewayEnvelope({
          correlationId: env.message_id, serverId, connectorId: null,
          eventType: "command.rejected", payload: { reason: "duplicate_request", job_id: job.id, state: job.state },
        }));
        return;
      }
      const dispatch = gatewayEnvelope({
        correlationId: env.message_id,
        serverId,
        connectorId: connector.connectorId,
        eventType: "command.dispatch",
        agentId,
        payload: { job_id: job.id, operation: p.operation, arguments: p.arguments ?? null },
        // idempotency flows through so replays cannot double-execute
      });
      (dispatch as Envelope & { idempotency_key: string }).idempotency_key = idem;
      sendTo(connector, dispatch);
      return;
    }
    case "command.cancel": {
      const jobId = (env.payload as { job_id?: string }).job_id;
      if (typeof jobId !== "string") return;
      // Ownership: the job is looked up only under servers this user owns and
      // has live, and must be in a cancellable state.
      let connector: ConnectorConn | undefined;
      for (const c of ownedConnectors(conn.userId)) {
        if (await findJob(c.serverId, jobId)) { connector = c; break; }
      }
      if (!connector) return;
      if (!(await cancelJobIfInFlight(connector.serverId, jobId))) {
        log(`cancel ignored: job ${jobId.slice(0, 8)} already terminal`);
        return;
      }
      sendTo(connector, gatewayEnvelope({
        correlationId: env.message_id, serverId: connector.serverId, connectorId: connector.connectorId,
        eventType: "command.cancel",
        payload: { job_id: jobId },
      }));
      return;
    }
    case "permission.decided": {
      const p = env.payload as { request_id?: string; decision?: string };
      if (typeof p.request_id !== "string" || (p.decision !== "allow" && p.decision !== "deny")) return;
      // The request is looked up only under this user's live servers, and the
      // store re-checks owner, pending status and expiry in one transaction
      // (F-M14). A server whose connector is offline cannot be decided for:
      // the decision could not be delivered anyway.
      let decision: Awaited<ReturnType<typeof decidePermissionRequest>> = null;
      let target: ConnectorConn | undefined;
      for (const c of ownedConnectors(conn.userId)) {
        decision = await decidePermissionRequest(
          c.serverId, p.request_id, conn.userId, p.decision === "allow" ? "approved" : "denied",
        );
        if (decision) { target = c; break; }
      }
      if (!decision) return; // not pending / not theirs / expired / replay
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

function forwardToOwnerApps(ownerId: string, env: Envelope): void {
  for (const c of connections) {
    if (c.kind === "app" && c.userId === ownerId) sendTo(c, env);
  }
}

/** --- websocket server ------------------------------------------------------ */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "friday-one-gateway" }));
});
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on("connection", (socket: WebSocket) => {
  let conn: Conn | null = null;
  socket.on("message", (raw: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return errorClose(socket, 4400, "malformed_json");
    }
    const env = ENVELOPE_BASE.safeParse(parsed);
    if (!env.success) return errorClose(socket, 4400, "invalid_envelope");

    if (!conn) {
      // First message MUST authenticate. The replay guard's baseline is set
      // from the auth message's sequence; later messages must increase.
      (async () => {
        if (env.data.event_type === "auth.connector") {
          const credential = (env.data.payload as { credential?: string }).credential;
          if (typeof credential !== "string") return errorClose(socket, 4401, "unauthenticated");
          const cred = await findLiveCredential(credential);
          if (!cred) return errorClose(socket, 4403, "credential_revoked");
          const server = await getServerForCredential(cred);
          if (!server) return errorClose(socket, 4403, "server_not_active");
          const existing = connectorsByServer.get(server.id);
          if (existing) existing.socket.close(4529, "superseded");
          const connectorConn: ConnectorConn = {
            kind: "connector", serverId: server.id, ownerId: server.owner_id, connectorId: cred.id, socket, lastSeenMs: Date.now(),
          };
          conn = connectorConn;
          connections.add(conn);
          connectorsByServer.set(server.id, conn);
          // Revocation propagation: a revoked/expired credential or a server
          // that leaves `active` closes the LIVE socket, not just the next
          // reconnect. If the listener itself fails, close (fail closed).
          connectorConn.unwatch = watchConnectorAuthorization(cred, (reason) => {
            log(`connector deauthorized (${reason}): server=${server.id}`);
            errorClose(socket, 4403, reason);
          });
          // Replay guard identity: the CONNECTOR credential id (stable across
          // reconnects for this process, unique per pairing).
          const identity = `connector:${cred.id}`;
          identities.add(identity); // marker for cleanup
          replayGuard.initBaseline(identity, env.data.sequence);
          (conn as ConnectorConn & { replayIdentity?: string }).replayIdentity = identity;
          sendTo(conn, gatewayEnvelope({
            correlationId: env.data.message_id, serverId: server.id, connectorId: cred.id,
            eventType: "auth.resume.ok",
            payload: { server_id: server.id, connector_id: cred.id, owner_id: server.owner_id },
          }));
          log(`connector connected: server=${server.id}`);
        } else if (env.data.event_type === "auth.app") {
          const token = (env.data.payload as { token?: string }).token;
          if (typeof token !== "string") return errorClose(socket, 4401, "unauthenticated");
          const verified = await verifyAppToken(token);
          if (!verified) return errorClose(socket, 4403, "invalid_token");
          const userId = verified.uid;
          conn = { kind: "app", userId, socket };
          connections.add(conn);
          const identity = `app:${userId}`;
          replayGuard.initBaseline(identity, env.data.sequence);
          (conn as AppConn & { replayIdentity?: string }).replayIdentity = identity;
          sendTo(conn, gatewayEnvelope({
            correlationId: env.data.message_id, serverId: crypto.randomUUID(), connectorId: null,
            eventType: "auth.resume.ok", payload: { user_id: userId },
          }));
          log(`app connected: user=${userId}`);
        } else {
          errorClose(socket, 4401, "authenticate_first");
        }
      })().catch((e) => {
        log(`auth error: ${(e as Error).message}`);
        errorClose(socket, 1011, "auth_failed");
      });
      return;
    }

    // Replay protection (P0): every authenticated message is checked against
    // the identity's dedup set and sequence baseline.
    const replayIdentity = (conn as { replayIdentity?: string }).replayIdentity;
    if (replayIdentity) {
      const verdict = replayGuard.check(replayIdentity, env.data.message_id, env.data.sequence);
      if (verdict === "duplicate") return; // idempotent drop per protocol
      if (verdict === "stale") return errorClose(socket, 4400, "sequence_violation");
    }

    if (conn.kind === "connector") {
      void handleConnectorMessage(conn, env.data).catch((e) => log(`connector msg error: ${(e as Error).message}`));
    } else {
      void handleAppMessage(conn, env.data).catch((e) => log(`app msg error: ${(e as Error).message}`));
    }
  });

  socket.on("close", () => {
    if (!conn) return;
    connections.delete(conn);
    if (conn.kind === "connector") {
      conn.unwatch?.();
      if (connectorsByServer.get(conn.serverId) === conn) {
        connectorsByServer.delete(conn.serverId);
        forgetServer(conn.serverId);
        log(`connector disconnected: server=${conn.serverId}`);
      }
    }
  });
  socket.on("error", () => socket.terminate());
});

server.listen(PORT, HOST, () => log(`gateway listening on ws://${HOST}:${PORT}`));
