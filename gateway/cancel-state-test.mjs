/**
 * Regression test: command.cancel may only cancel jobs that are still in
 * flight (queued/dispatched/accepted/started).
 *
 * Boots the real gateway against a fake Supabase (REST + JWKS), connects a
 * connector and its owner's app, then cancels one finished and one running
 * job. A finished job must keep its terminal state and must NOT be forwarded
 * to the connector; a running job must become `cancelled` and be forwarded.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const SERVER_ID = crypto.randomUUID();
const OWNER_ID = crypto.randomUUID();
const CREDENTIAL = "cancel-state-test-credential";
const DONE_JOB = crypto.randomUUID();
const LIVE_JOB = crypto.randomUUID();

/** In-memory command_jobs table. */
const jobs = new Map([
  [DONE_JOB, { id: DONE_JOB, server_id: SERVER_ID, state: "completed" }],
  [LIVE_JOB, { id: LIVE_JOB, server_id: SERVER_ID, state: "started" }],
]);

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256", use: "sig" };

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : null));
  });
}

/** PostgREST filters used by the gateway: `eq.<v>` and `in.(<a>,<b>)`. */
function matches(filter, value) {
  if (filter === null) return true;
  if (filter.startsWith("eq.")) return value === filter.slice(3);
  if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(value);
  throw new Error(`unsupported filter ${filter}`);
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const body = req.method === "PATCH" || req.method === "POST" ? await readBody(req) : null;
  const table = url.pathname.replace("/rest/v1/", "");
  res.setHeader("content-type", "application/json");

  if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.method === "GET" && table === "connector_credentials") {
    const expected = "eq." + crypto.createHash("sha256").update(CREDENTIAL).digest("hex");
    return res.end(JSON.stringify(url.searchParams.get("credential_hash") === expected
      ? [{ id: crypto.randomUUID(), server_id: SERVER_ID, revoked_at: null, expires_at: null }]
      : []));
  }
  if (req.method === "GET" && table === "servers") {
    return res.end(JSON.stringify([{ id: SERVER_ID, owner_id: OWNER_ID, enrollment_state: "active" }]));
  }
  if (table === "command_jobs") {
    const idFilter = url.searchParams.get("id");
    const stateFilter = url.searchParams.get("state");
    const hit = [...jobs.values()].filter((j) => matches(idFilter, j.id) && matches(stateFilter, j.state));
    if (req.method === "PATCH") {
      const updated = hit.map((j) => {
        const next = { ...j, ...body };
        jobs.set(j.id, next);
        return next;
      });
      const wantsRows = (req.headers.prefer ?? "").includes("return=representation");
      return res.end(wantsRows ? JSON.stringify(updated) : "");
    }
    return res.end(JSON.stringify(hit));
  }
  res.end(req.method === "GET" ? "[]" : "");
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
}

await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = fake.address().port;
const SUPABASE_URL = `http://127.0.0.1:${fakePort}`;
const gwPort = 19000 + Math.floor(Math.random() * 1000);

const gw = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(gwPort),
    HOST: "127.0.0.1",
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: "test-secret",
    SUPABASE_JWKS_URL: `${SUPABASE_URL}/jwks`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwLog = "";
gw.stdout.on("data", (d) => (gwLog += d));
gw.stderr.on("data", (d) => (gwLog += d));

const envelope = (eventType, sequence, payload) => ({
  protocol_version: 1,
  message_id: crypto.randomUUID(),
  correlation_id: null,
  server_id: SERVER_ID,
  connector_id: null,
  agent_id: null,
  session_id: null,
  event_type: eventType,
  issued_at: new Date().toISOString(),
  expires_at: null,
  sequence,
  idempotency_key: null,
  payload,
});

/** Opens a socket, sends the auth envelope, resolves once resumed. */
async function connect(authEnvelope, inbox) {
  const ws = new WebSocket(`ws://127.0.0.1:${gwPort}`);
  ws.on("error", () => {});
  let resumed = false;
  ws.on("open", () => ws.send(JSON.stringify(authEnvelope)));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.event_type === "auth.resume.ok") resumed = true;
    else inbox.push(m);
  });
  await waitFor(() => resumed || ws.readyState === WebSocket.CLOSED, 8000);
  assert.ok(resumed, `auth failed for ${authEnvelope.event_type}: ${gwLog.slice(-400)}`);
  return ws;
}

let connectorWs;
let appWs;
const connectorInbox = [];

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${gwPort}/`)).ok;
    } catch {
      await wait(50);
    }
  }
  assert.ok(up, `gateway did not start: ${gwLog.slice(-400)}`);

  connectorWs = await connect(envelope("auth.connector", 1, { credential: CREDENTIAL }), connectorInbox);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setSubject(OWNER_ID)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  appWs = await connect(envelope("auth.app", 1, { token }), []);

  // 1) A finished job is not cancellable: state kept, nothing forwarded.
  appWs.send(JSON.stringify(envelope("command.cancel", 2, { job_id: DONE_JOB })));
  await wait(800);
  assert.equal(jobs.get(DONE_JOB).state, "completed", "a completed job must not be overwritten as cancelled");
  assert.equal(
    connectorInbox.filter((m) => m.event_type === "command.cancel").length, 0,
    "cancel for a finished job must not reach the connector",
  );

  // 2) A running job is cancelled and the cancel is forwarded.
  appWs.send(JSON.stringify(envelope("command.cancel", 3, { job_id: LIVE_JOB })));
  const forwarded = await waitFor(() => connectorInbox.some((m) => m.event_type === "command.cancel"), 4000);
  assert.ok(forwarded, "cancel for a running job must reach the connector");
  assert.equal(jobs.get(LIVE_JOB).state, "cancelled");
  assert.equal(connectorInbox.find((m) => m.event_type === "command.cancel").payload.job_id, LIVE_JOB);

  console.log("cancel state: PASS (terminal jobs untouched, in-flight jobs cancelled)");
} catch (e) {
  console.log(`cancel state: FAIL — ${e.message}`);
  console.log(gwLog.slice(-1200));
  process.exitCode = 1;
} finally {
  connectorWs?.close();
  appWs?.close();
  gw.kill("SIGTERM");
  fake.close();
}
