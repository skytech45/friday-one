/**
 * Regression test for F-M14: permission.decided must only decide a request
 * on one of the deciding user's own servers, and only while it is pending
 * and unexpired.
 *
 * Boots the real gateway against a fake Supabase (PostgREST + JWKS). Alice
 * and Bob each have a server with a live connector. Bob tries to decide
 * Alice's request; Alice tries an expired one; then Alice decides a valid one.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const A_SERVER = crypto.randomUUID();
const B_SERVER = crypto.randomUUID();
const A_CRED = "alice-connector-credential";
const B_CRED = "bob-connector-credential";
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const future = () => new Date(Date.now() + 600_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const servers = new Map([
  [A_SERVER, { id: A_SERVER, owner_id: ALICE, enrollment_state: "active" }],
  [B_SERVER, { id: B_SERVER, owner_id: BOB, enrollment_state: "active" }],
]);
const credentials = new Map([
  [sha256(A_CRED), { id: crypto.randomUUID(), server_id: A_SERVER, revoked_at: null, expires_at: null }],
  [sha256(B_CRED), { id: crypto.randomUUID(), server_id: B_SERVER, revoked_at: null, expires_at: null }],
]);
const REQ_LIVE = crypto.randomUUID();
const REQ_EXPIRED = crypto.randomUUID();
const requests = new Map([
  [REQ_LIVE, { id: REQ_LIVE, server_id: A_SERVER, status: "pending", payload_hash: "hash-live", policy_version: 3, expires_at: future() }],
  [REQ_EXPIRED, { id: REQ_EXPIRED, server_id: A_SERVER, status: "pending", payload_hash: "hash-old", policy_version: 3, expires_at: past() }],
]);

/** PostgREST filters the gateway uses on permission_requests. */
function matches(filter, value) {
  if (filter === null) return true;
  if (filter.startsWith("eq.")) return String(value) === filter.slice(3);
  if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(String(value));
  if (filter.startsWith("gt.")) return Date.parse(value) > Date.parse(filter.slice(3));
  throw new Error(`unsupported filter ${filter}`);
}

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256", use: "sig" };

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : null));
  });
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const table = url.pathname.replace("/rest/v1/", "");
  const body = req.method === "PATCH" || req.method === "POST" ? await readBody(req) : null;
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  if (table === "connector_credentials") {
    const row = credentials.get((url.searchParams.get("credential_hash") ?? "").slice(3));
    return res.end(JSON.stringify(row ? [row] : []));
  }
  if (table === "servers" && req.method === "GET") {
    const row = servers.get((url.searchParams.get("id") ?? "").slice(3));
    return res.end(JSON.stringify(row ? [row] : []));
  }
  if (table === "permission_requests" && req.method === "PATCH") {
    const filters = ["id", "status", "server_id", "expires_at"].map((k) => [k, url.searchParams.get(k)]);
    const hit = [...requests.values()].filter((r) => filters.every(([k, f]) => matches(f, r[k])));
    for (const r of hit) Object.assign(r, body);
    return res.end(JSON.stringify(hit));
  }
  res.end(req.method === "GET" ? "[]" : "");
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const SUPABASE_URL = `http://127.0.0.1:${fake.address().port}`;
const gwPort = 20_000 + Math.floor(Math.random() * 1000);
const gw = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env, PORT: String(gwPort), HOST: "127.0.0.1",
    SUPABASE_URL, SUPABASE_SECRET_KEY: "test-secret", SUPABASE_JWKS_URL: `${SUPABASE_URL}/jwks`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwLog = "";
gw.stdout.on("data", (d) => (gwLog += d));
gw.stderr.on("data", (d) => (gwLog += d));

function client(authEvent, authPayload) {
  const ws = new WebSocket(`ws://127.0.0.1:${gwPort}`);
  const inbox = [];
  let seq = 1;
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  ws.on("error", () => {});
  const send = (eventType, payload) => ws.send(JSON.stringify({
    protocol_version: 1, message_id: crypto.randomUUID(), correlation_id: null,
    server_id: crypto.randomUUID(), connector_id: null, agent_id: null, session_id: null,
    event_type: eventType, issued_at: new Date().toISOString(), expires_at: null,
    sequence: seq++, idempotency_key: null, payload,
  }));
  const ready = new Promise((resolve, reject) => {
    ws.on("open", () => send(authEvent, authPayload));
    const t = setInterval(() => {
      if (inbox.some((m) => m.event_type === "auth.resume.ok")) { clearInterval(t); resolve(); }
    }, 25);
    ws.on("close", (c) => { clearInterval(t); reject(new Error(`closed ${c}: ${gwLog.slice(-400)}`)); });
  });
  return { ws, inbox, send, ready, count: (e) => inbox.filter((m) => m.event_type === e).length };
}

const tokenFor = (sub) => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "test" })
  .setSubject(sub).setIssuer(`${SUPABASE_URL}/auth/v1`).setIssuedAt().setExpirationTime("5m").sign(privateKey);

const sockets = [];
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${gwPort}/`)).ok) break; } catch { await wait(50); }
  }
  const aConn = client("auth.connector", { credential: A_CRED });
  const bConn = client("auth.connector", { credential: B_CRED });
  const aliceApp = client("auth.app", { token: await tokenFor(ALICE) });
  const bobApp = client("auth.app", { token: await tokenFor(BOB) });
  sockets.push(aConn, bConn, aliceApp, bobApp);
  await Promise.all(sockets.map((s) => s.ready));

  // 1) Bob (who has his own live server) decides Alice's request.
  bobApp.send("permission.decided", { request_id: REQ_LIVE, decision: "allow" });
  await wait(600);
  assert.equal(requests.get(REQ_LIVE).status, "pending", "another user's decision must not consume the request");
  assert.equal(aConn.count("permission.decided") + bConn.count("permission.decided"), 0);

  // 2) Alice decides an expired request.
  aliceApp.send("permission.decided", { request_id: REQ_EXPIRED, decision: "allow" });
  await wait(600);
  assert.equal(requests.get(REQ_EXPIRED).status, "pending", "an expired request cannot be approved");
  assert.equal(aConn.count("permission.decided"), 0);

  // 3) Alice decides her live request: recorded and forwarded once.
  aliceApp.send("permission.decided", { request_id: REQ_LIVE, decision: "allow" });
  for (let i = 0; i < 40 && aConn.count("permission.decided") === 0; i++) await wait(50);
  assert.equal(requests.get(REQ_LIVE).status, "approved");
  assert.equal(requests.get(REQ_LIVE).decided_by, ALICE);
  const fwd = aConn.inbox.find((m) => m.event_type === "permission.decided");
  assert.equal(fwd.payload.payload_hash, "hash-live");
  aliceApp.send("permission.decided", { request_id: REQ_LIVE, decision: "deny" });
  await wait(400);
  assert.equal(aConn.count("permission.decided"), 1, "a repeated decision is a no-op");
  assert.equal(bConn.count("permission.decided"), 0);

  console.log("permission decide: PASS (owner-only, unexpired, forwarded once)");
} catch (e) {
  console.log(`permission decide: FAIL — ${e.message}`);
  console.log(gwLog.slice(-800));
  process.exitCode = 1;
} finally {
  for (const s of sockets) s.ws.close();
  gw.kill("SIGTERM");
  fake.close();
}
