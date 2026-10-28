/**
 * Fake FRIDAY One backend for installer/CLI end-to-end tests: a control plane
 * (health, enrollment session, POST poll, policy sync) and a realtime gateway
 * that speak the real protocol. The "app" side is simulated: the first poll
 * after a session opens is treated as claimed and hands out the credential
 * once. Test-only; never deploy.
 *
 *   node test/e2e/fake-backend.mjs <ports-file>
 * writes {"http": <port>, "ws": <port>} to <ports-file>, then serves until killed.
 * Control endpoints: POST /__control/revoke, GET /__control/state
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";

const VALID_TOKEN = process.env.FAKE_ENROLLMENT_TOKEN ?? "e2e-enrollment-token-0123456789abcdef";
const CREDENTIAL = "e2e-connector-credential-0123456789abcdefghijklmnop";
const SERVER_ID = randomUUID();
const state = { sessionOpened: false, pickedUp: false, revoked: false, authOk: 0, authRefused: 0, syncs: 0, pollMethods: [] };
let liveSockets = new Set();

const envelope = (eventType, payload) => JSON.stringify({
  protocol_version: 1, message_id: randomUUID(), correlation_id: null, server_id: SERVER_ID,
  connector_id: null, agent_id: null, session_id: null, event_type: eventType,
  issued_at: new Date().toISOString(), expires_at: null, sequence: 1, idempotency_key: null, payload,
});

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
wss.on("connection", (ws) => {
  ws.once("message", (raw) => {
    let env;
    try { env = JSON.parse(String(raw)); } catch { return ws.close(4400, "malformed_json"); }
    if (env.event_type !== "auth.connector") return ws.close(4401, "authenticate_first");
    if (env.payload?.credential !== CREDENTIAL || state.revoked) {
      state.authRefused++;
      return ws.close(4403, "credential_revoked");
    }
    state.authOk++;
    liveSockets.add(ws);
    ws.on("close", () => liveSockets.delete(ws));
    ws.send(envelope("auth.resume.ok", { server_id: SERVER_ID, connector_id: randomUUID(), owner_id: "e2e-owner" }));
  });
});
await new Promise((r) => wss.once("listening", r));
const wsPort = wss.address().port;

function readJson(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (url.searchParams.has("token")) state.tokenInUrl = true; // must never happen with POST polling
  if (url.pathname === "/api/v1/health") return send(200, { ok: true, service: "fake-control-plane", gateway_url: `ws://127.0.0.1:${wsPort}` });
  if (url.pathname === "/api/v1/enrollments/session" && req.method === "POST") {
    const { token } = await readJson(req);
    if (token !== VALID_TOKEN || state.sessionOpened) return send(403, { error: "invalid_or_expired_token" });
    state.sessionOpened = true;
    return send(200, { enrollment_id: randomUUID(), server_id: SERVER_ID, display_code: "1234567890123456", display_code_expires_at: new Date(Date.now() + 600_000).toISOString() });
  }
  if (url.pathname === "/api/v1/enrollments/session/poll" && req.method === "POST") {
    state.pollMethods.push("POST");
    const { token } = await readJson(req);
    if (token !== VALID_TOKEN || !state.sessionOpened || state.pickedUp) return send(200, { state: "pending" });
    state.pickedUp = true;
    return send(200, { state: "paired", server_id: SERVER_ID, credential: CREDENTIAL });
  }
  if (url.pathname === "/api/v1/policies/sync") {
    state.syncs++;
    if (req.headers["x-connector-credential"] !== CREDENTIAL || state.revoked) return send(403, { error: "credential_revoked" });
    return send(200, { version: 1, server_id: SERVER_ID, rules: [], rotation_due: false });
  }
  if (url.pathname === "/__control/revoke" && req.method === "POST") {
    state.revoked = true;
    for (const ws of liveSockets) ws.close(4403, "credential_revoked");
    return send(200, { revoked: true });
  }
  if (url.pathname === "/__control/state") return send(200, { ...state, serverId: SERVER_ID, connected: liveSockets.size });
  send(404, { error: "not_found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

writeFileSync(process.argv[2] ?? "fake-backend.ports.json", JSON.stringify({ http: server.address().port, ws: wsPort, serverId: SERVER_ID }));
process.on("SIGTERM", () => process.exit(0));
