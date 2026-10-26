/**
 * Integration test for capability reporting (plan §7/§9).
 *
 * Boots the real gateway binary against a fake Supabase REST endpoint and a
 * real WebSocket, then authenticates as a connector and sends
 * `connector.hello`. Asserts that the gateway upserts SANITISED agent and
 * project rows, scoped to the credential's server — no database required.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import WebSocket from "ws";

const SERVER_ID = crypto.randomUUID();
const CREDENTIAL = "integration-test-credential";
const OWNER_ID = crypto.randomUUID();

const writes = [];
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : null));
  });
}

/** Minimal PostgREST stand-in: auth lookups + a write recorder. */
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : null;
  const table = url.pathname.replace("/rest/v1/", "");
  res.setHeader("content-type", "application/json");

  if (req.method === "GET" && table === "connector_credentials") {
    const hash = url.searchParams.get("credential_hash") ?? "";
    const expected = "eq." + crypto.createHash("sha256").update(CREDENTIAL).digest("hex");
    res.end(JSON.stringify(hash === expected
      ? [{ id: crypto.randomUUID(), server_id: SERVER_ID, revoked_at: null, expires_at: null }]
      : []));
    return;
  }
  if (req.method === "GET" && table === "servers") {
    res.end(JSON.stringify([{ id: SERVER_ID, owner_id: OWNER_ID, enrollment_state: "active" }]));
    return;
  }
  if (req.method === "POST") {
    writes.push({ table, body, onConflict: url.searchParams.get("on_conflict") });
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
const gwPort = 18000 + Math.floor(Math.random() * 1000);

const gw = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(gwPort),
    HOST: "127.0.0.1",
    SUPABASE_URL: `http://127.0.0.1:${fakePort}`,
    SUPABASE_SECRET_KEY: "test-secret",
    SUPABASE_JWKS_URL: `http://127.0.0.1:${fakePort}/jwks`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwLog = "";
gw.stdout.on("data", (d) => (gwLog += d));
gw.stderr.on("data", (d) => (gwLog += d));

const base = {
  protocol_version: 1,
  correlation_id: null,
  server_id: SERVER_ID,
  connector_id: null,
  agent_id: null,
  session_id: null,
  issued_at: new Date().toISOString(),
  expires_at: null,
  idempotency_key: null,
};

let ws;
let resumed = false;

try {
  // The gateway binds after module load; poll its health endpoint first.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${gwPort}/`);
      up = r.ok;
    } catch {
      await wait(50);
    }
  }
  assert.ok(up, `gateway did not start: ${gwLog.slice(-400)}`);

  ws = new WebSocket(`ws://127.0.0.1:${gwPort}`);
  ws.on("error", () => {}); // surfaced by the assertion below, not as a crash
  ws.on("open", () => {
    ws.send(JSON.stringify({
      ...base,
      message_id: crypto.randomUUID(),
      event_type: "auth.connector",
      sequence: 1,
      payload: { credential: CREDENTIAL },
    }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.event_type === "auth.resume.ok") resumed = true;
  });
  await waitFor(() => resumed || ws.readyState === WebSocket.CLOSED, 8000);
  assert.ok(resumed, `gateway did not authenticate the test connector: ${gwLog.slice(-400)}`);

  ws.send(JSON.stringify({
    ...base,
    message_id: crypto.randomUUID(),
    event_type: "connector.hello",
    sequence: 2,
    payload: {
      connector_version: "test",
      agents: [
        { adapter: "hermes", version: "0.22.5", health: "healthy" },
        { adapter: "../bad", version: "x", health: "healthy" },
        { adapter: "hermes", version: "0.22.6", health: "healthy" },
      ],
      projects: [
        { root: "/srv/app", label: "app" },
        { root: "relative/root" },
        { root: "/srv/app", label: "dupe" },
      ],
    },
  }));

  const stored = await waitFor(() => writes.filter((w) => w.table === "agents").length > 0, 4000);
  assert.ok(stored, "gateway did not persist agents");

  const agentWrite = writes.find((w) => w.table === "agents");
  const projectWrite = writes.find((w) => w.table === "projects");
  assert.equal(agentWrite.onConflict, "server_id,adapter");
  assert.equal(agentWrite.body.length, 1, "invalid + duplicate adapters must be dropped");
  assert.deepEqual(agentWrite.body[0], {
    server_id: SERVER_ID,
    adapter: "hermes",
    adapter_version: "0.22.5", // duplicate adapter: first report wins
    capabilities: {},
    health: "healthy",
    discovered_at: agentWrite.body[0].discovered_at,
    updated_at: agentWrite.body[0].updated_at,
  });
  assert.equal(projectWrite.onConflict, "server_id,canonical_root");
  assert.deepEqual(projectWrite.body.map((p) => p.canonical_root), ["/srv/app"]);
  assert.equal(projectWrite.body[0].server_id, SERVER_ID);

  console.log("capabilities integration: PASS (sanitised upserts scoped to the credential's server)");
} catch (e) {
  console.log(`capabilities integration: FAIL — ${e.message}`);
  console.log(gwLog.slice(-1200));
  process.exitCode = 1;
} finally {
  ws?.close();
  gw.kill("SIGTERM");
  fake.close();
}
