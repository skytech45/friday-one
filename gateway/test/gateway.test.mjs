/**
 * Gateway on Firebase (migration plan §6: G-1, G-2, G-3, G-5..G-10).
 *
 * Boots the real gateway (dist/index.js) against the Auth + Firestore
 * emulators (`npm test` wraps `firebase emulators:exec`), connects real
 * WebSocket clients as connectors and apps, and checks routing, authorization,
 * revocation, replay protection and durable state. Replaces the fake-Supabase
 * capabilities/cancel-state scripts and the live-only replay/audit scripts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import WebSocket from "ws";
import { initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-friday-one";
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const PORT = 18_500 + Math.floor(Math.random() * 400);
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

initializeApp({ projectId: PROJECT });
const db = getFirestore();

let gw;
let gwLog = "";

before(async () => {
  gw = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", FIREBASE_PROJECT_ID: PROJECT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout.on("data", (d) => (gwLog += d));
  gw.stderr.on("data", (d) => (gwLog += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return; } catch { /* not up yet */ }
    await wait(100);
  }
  throw new Error(`gateway did not start:\n${gwLog}`);
});

after(() => gw?.kill("SIGTERM"));

beforeEach(async () => {
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
});

async function googleUser(sub) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(JSON.stringify({ sub, email: `${sub}@example.test`, email_verified: true }))}&providerId=google.com`,
      requestUri: "http://localhost",
      returnSecureToken: true,
    }),
  });
  const j = await r.json();
  return { uid: j.localId, token: j.idToken };
}

async function passwordToken() {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pw@example.test", password: "Passw0rd-not-real", returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

/** An active server owned by `uid` with a live connector credential. */
async function seedServer(uid, { state = "active" } = {}) {
  const serverId = crypto.randomUUID();
  const credential = crypto.randomBytes(32).toString("base64url");
  const credentialId = crypto.randomUUID();
  await db.collection("servers").doc(serverId).set({
    ownerId: uid, name: "vps", enrollmentState: state, connectorId: credentialId, lastSeenAt: null,
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
  await db.collection("connectorCredentials").doc(sha256(credential)).set({
    credentialId, serverId, ownerId: uid, createdAt: Timestamp.now(), expiresAt: null, revokedAt: null,
  });
  return { serverId, credential, credentialId };
}

/** WebSocket client with an inbox, a close promise and a sequence counter. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox = [];
  let seq = 1;
  let resolveClose;
  const closed = new Promise((r) => (resolveClose = r));
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  ws.on("close", (code, reason) => resolveClose({ code, reason: String(reason) }));
  ws.on("error", () => {});
  const opened = new Promise((r) => ws.on("open", r));
  const envelope = (eventType, payload, extra = {}) => ({
    protocol_version: 1, message_id: crypto.randomUUID(), correlation_id: null,
    server_id: crypto.randomUUID(), connector_id: null, agent_id: null, session_id: null,
    event_type: eventType, issued_at: new Date().toISOString(), expires_at: null,
    sequence: seq++, idempotency_key: null, payload, ...extra,
  });
  return {
    ws, inbox, closed,
    async send(eventType, payload, extra) {
      await opened;
      const env = envelope(eventType, payload, extra);
      ws.send(JSON.stringify(env));
      return env;
    },
    async sendRaw(text) { await opened; ws.send(text); },
    resendExact(env) { ws.send(JSON.stringify(env)); },
    async waitFor(eventType, ms = 4000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const m = inbox.find((x) => x.event_type === eventType);
        if (m) return m;
        await wait(25);
      }
      return null;
    },
    count: (eventType) => inbox.filter((x) => x.event_type === eventType).length,
    close: () => ws.close(),
  };
}

async function connectApp(token) {
  const c = client();
  await c.send("auth.app", { token });
  assert.ok(await c.waitFor("auth.resume.ok"), `app auth failed:\n${gwLog.slice(-600)}`);
  return c;
}

async function connectConnector(credential) {
  const c = client();
  await c.send("auth.connector", { credential });
  assert.ok(await c.waitFor("auth.resume.ok"), `connector auth failed:\n${gwLog.slice(-600)}`);
  return c;
}

async function expectClose(c, code, ms = 5000) {
  const res = await Promise.race([c.closed, wait(ms).then(() => null)]);
  assert.ok(res, `socket not closed within ${ms} ms`);
  assert.equal(res.code, code, `close reason: ${res.reason}`);
  return res;
}

describe("G-2 authentication", () => {
  test("app: garbage and non-Google tokens are refused, Google accepted", async () => {
    const bad = client();
    await bad.send("auth.app", { token: "garbage" });
    await expectClose(bad, 4403);
    const pw = client();
    await pw.send("auth.app", { token: await passwordToken() });
    await expectClose(pw, 4403);
    const alice = await googleUser("alice");
    const ok = await connectApp(alice.token);
    assert.equal((await ok.waitFor("auth.resume.ok")).payload.user_id, alice.uid);
    ok.close();
  });

  test("connector: unknown, revoked, expired and inactive-server credentials are refused", async () => {
    const alice = await googleUser("alice");
    const unknown = client();
    await unknown.send("auth.connector", { credential: "nope" });
    await expectClose(unknown, 4403);

    const revoked = await seedServer(alice.uid);
    await db.collection("connectorCredentials").doc(sha256(revoked.credential)).update({ revokedAt: Timestamp.now() });
    const r = client();
    await r.send("auth.connector", { credential: revoked.credential });
    await expectClose(r, 4403);

    const expired = await seedServer(alice.uid);
    await db.collection("connectorCredentials").doc(sha256(expired.credential)).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const e = client();
    await e.send("auth.connector", { credential: expired.credential });
    await expectClose(e, 4403);

    const pending = await seedServer(alice.uid, { state: "pending" });
    const p = client();
    await p.send("auth.connector", { credential: pending.credential });
    assert.equal((await expectClose(p, 4403)).reason, "server_not_active");
  });

  test("first message must authenticate", async () => {
    const c = client();
    await c.send("command.submit", {});
    await expectClose(c, 4401);
  });
});

describe("G-3 revocation propagates to live sockets", () => {
  test("revoking the credential closes the connected connector", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    await db.collection("connectorCredentials").doc(sha256(s.credential)).update({ revokedAt: Timestamp.now() });
    assert.equal((await expectClose(conn, 4403)).reason, "credential_revoked");
  });

  test("revoking the server closes the connected connector", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    await db.collection("servers").doc(s.serverId).update({ enrollmentState: "revoked" });
    assert.equal((await expectClose(conn, 4403)).reason, "server_not_active");
  });

  test("a rotated-out credential is closed when its grace expiry passes", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    await db.collection("connectorCredentials").doc(sha256(s.credential)).update({ expiresAt: Timestamp.fromMillis(Date.now() + 1500) });
    assert.equal((await expectClose(conn, 4403, 8000)).reason, "credential_expired");
  });
});

describe("G-1 capabilities", () => {
  test("hello upserts sanitised agents/projects under the credential's server, with UUID agent ids", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    await conn.send("connector.hello", {
      connector_version: "test",
      agents: [
        { adapter: "hermes", version: "0.22.5", health: "healthy" },
        { adapter: "../bad", version: "x", health: "healthy" },
        { adapter: "hermes", version: "0.22.6", health: "healthy" },
      ],
      projects: [{ root: "/srv/app", label: "app" }, { root: "relative/root" }],
    }, { server_id: crypto.randomUUID() /* payload/envelope server id is ignored */ });
    let agents;
    for (let i = 0; i < 40 && !(agents?.size); i++) {
      await wait(100);
      agents = await db.collection("servers").doc(s.serverId).collection("agents").get();
    }
    assert.equal(agents.size, 1);
    const hermes = agents.docs[0].data();
    assert.equal(hermes.adapter, "hermes");
    assert.equal(hermes.adapterVersion, "0.22.5");
    assert.equal(hermes.ownerId, alice.uid);
    assert.match(hermes.agentId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const projects = await db.collection("servers").doc(s.serverId).collection("projects").get();
    assert.deepEqual(projects.docs.map((d) => d.get("canonicalRoot")), ["/srv/app"]);
    conn.close();
  });
});

describe("G-5 command submission, duplicates and cross-user isolation", () => {
  test("owner submit dispatches once; a repeated idempotency key never re-dispatches", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    const app = await connectApp(alice.token);
    const submit = { server_id: s.serverId, operation: "session.prompt", idempotency_key: "k1", arguments: { root: "/srv/app", prompt: "hi" } };
    await app.send("command.submit", submit);
    const dispatch = await conn.waitFor("command.dispatch");
    assert.ok(dispatch, "dispatch reached the connector");
    const job = (await db.collection("servers").doc(s.serverId).collection("jobs").doc(dispatch.payload.job_id).get()).data();
    assert.equal(job.state, "queued");
    assert.equal(job.ownerId, alice.uid);

    await app.send("command.submit", submit);
    const dup = await app.waitFor("command.rejected");
    assert.equal(dup.payload.reason, "duplicate_request");
    assert.equal(dup.payload.job_id, dispatch.payload.job_id);
    await wait(300);
    assert.equal(conn.count("command.dispatch"), 1, "F-M15: no second execution");
    conn.close(); app.close();
  });

  test("another user cannot submit to, cancel on, or approve for alice's server", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    const bobApp = await connectApp(bob.token);

    await bobApp.send("command.submit", { server_id: s.serverId, operation: "session.prompt", arguments: {} });
    assert.equal((await bobApp.waitFor("command.rejected")).payload.reason, "server_offline_or_forbidden");

    const jobId = sha256(`${s.serverId}:k`);
    await db.collection("servers").doc(s.serverId).collection("jobs").doc(jobId).set({ ownerId: alice.uid, serverId: s.serverId, state: "started" });
    await bobApp.send("command.cancel", { job_id: jobId });

    await conn.send("permission.requested", { operation: "file.write", payload_hash: "abc", ttl_seconds: 600 });
    let reqs;
    for (let i = 0; i < 40 && !(reqs?.size); i++) {
      await wait(100);
      reqs = await db.collection("servers").doc(s.serverId).collection("permissionRequests").get();
    }
    await bobApp.send("permission.decided", { request_id: reqs.docs[0].id, decision: "allow" });
    await wait(800);
    assert.equal(conn.count("command.cancel"), 0);
    assert.equal(conn.count("permission.decided"), 0);
    assert.equal((await db.collection("servers").doc(s.serverId).collection("jobs").doc(jobId).get()).get("state"), "started");
    assert.equal(reqs.docs[0].ref ? (await reqs.docs[0].ref.get()).get("status") : null, "pending", "F-M14: bob cannot decide");
    conn.close(); bobApp.close();
  });
});

describe("G-6 cancel state (ported regression test)", () => {
  test("terminal jobs stay terminal; in-flight jobs are cancelled and forwarded; late completion keeps cancelled", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    const app = await connectApp(alice.token);
    const jobs = db.collection("servers").doc(s.serverId).collection("jobs");
    const done = sha256(`${s.serverId}:done`);
    const live = sha256(`${s.serverId}:live`);
    await jobs.doc(done).set({ ownerId: alice.uid, serverId: s.serverId, state: "completed" });
    await jobs.doc(live).set({ ownerId: alice.uid, serverId: s.serverId, state: "started" });

    await app.send("command.cancel", { job_id: done });
    await wait(600);
    assert.equal((await jobs.doc(done).get()).get("state"), "completed");
    assert.equal(conn.count("command.cancel"), 0);

    await app.send("command.cancel", { job_id: live });
    const fwd = await conn.waitFor("command.cancel");
    assert.equal(fwd.payload.job_id, live);
    assert.equal((await jobs.doc(live).get()).get("state"), "cancelled");

    await conn.send("command.completed", { job_id: live, result_summary: { stopReason: "end_turn" } });
    await wait(600);
    assert.equal((await jobs.doc(live).get()).get("state"), "cancelled", "late completion does not overwrite cancel");
    conn.close(); app.close();
  });

  test("result summaries are bounded to 4 KiB", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    const jobId = sha256(`${s.serverId}:big`);
    const ref = db.collection("servers").doc(s.serverId).collection("jobs").doc(jobId);
    await ref.set({ ownerId: alice.uid, serverId: s.serverId, state: "started" });
    await conn.send("command.completed", { job_id: jobId, result_summary: { blob: "x".repeat(10_000) } });
    for (let i = 0; i < 40 && (await ref.get()).get("state") !== "completed"; i++) await wait(100);
    assert.deepEqual((await ref.get()).get("resultSummary"), { truncated: true, bytes: 10_011 });
    conn.close();
  });
});

describe("G-7 request-bound approvals", () => {
  test("owner approval is forwarded once with the stored payload hash; expired requests cannot be approved", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    const app = await connectApp(alice.token);
    await conn.send("permission.requested", { operation: "file.write", payload_hash: "hash-1", ttl_seconds: 600 });
    const req = await app.waitFor("permission.requested");
    assert.equal(req.payload.payload_hash, "hash-1");

    await app.send("permission.decided", { request_id: req.payload.request_id, decision: "allow" });
    const decided = await conn.waitFor("permission.decided");
    assert.equal(decided.payload.payload_hash, "hash-1");
    assert.equal(decided.payload.decided_by, alice.uid);
    await app.send("permission.decided", { request_id: req.payload.request_id, decision: "deny" });
    await wait(500);
    assert.equal(conn.count("permission.decided"), 1, "replayed decision is a no-op");
    const doc = (await db.collection("servers").doc(s.serverId).collection("permissionRequests").doc(req.payload.request_id).get()).data();
    assert.equal(doc.status, "approved");
    assert.equal(doc.decidedBy, alice.uid);

    await conn.send("permission.requested", { operation: "file.delete", payload_hash: "hash-2", ttl_seconds: 600 });
    for (let i = 0; i < 40 && app.inbox.filter((m) => m.event_type === "permission.requested").length < 2; i++) await wait(50);
    const second = app.inbox.filter((m) => m.event_type === "permission.requested")[1];
    const ref = db.collection("servers").doc(s.serverId).collection("permissionRequests").doc(second.payload.request_id);
    await ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await app.send("permission.decided", { request_id: second.payload.request_id, decision: "allow" });
    await wait(600);
    assert.equal(conn.count("permission.decided"), 1, "expired request not forwarded");
    assert.equal((await ref.get()).get("status"), "expired");
    conn.close(); app.close();
  });
});

describe("G-8 replay protection and malformed input", () => {
  test("duplicate message id is dropped; stale sequence closes 4400", async () => {
    const alice = await googleUser("alice");
    const s = await seedServer(alice.uid);
    const conn = await connectConnector(s.credential);
    const app = await connectApp(alice.token);
    const env = await app.send("command.submit", { server_id: s.serverId, operation: "session.prompt", idempotency_key: "r1", arguments: {} });
    assert.ok(await conn.waitFor("command.dispatch"));
    app.resendExact(env); // same message_id + sequence
    await wait(500);
    assert.equal(conn.count("command.dispatch"), 1);
    assert.equal(app.count("command.rejected"), 0, "dropped before routing, not even a duplicate_request reply");

    await app.send("app.heartbeat", {}, { sequence: 0 }); // below baseline
    await expectClose(app, 4400);
    conn.close();
  });

  test("malformed JSON and invalid envelopes close 4400", async () => {
    const a = client();
    await a.sendRaw("{not json");
    await expectClose(a, 4400);
    const b = client();
    await b.sendRaw(JSON.stringify({ event_type: "auth.app" }));
    await expectClose(b, 4400);
  });
});

describe("G-9 heartbeats (F-M13)", () => {
  test("two connectors' heartbeats both update their own server", async () => {
    const alice = await googleUser("alice");
    const s1 = await seedServer(alice.uid);
    const s2 = await seedServer(alice.uid);
    const c1 = await connectConnector(s1.credential);
    const c2 = await connectConnector(s2.credential);
    await c1.send("connector.heartbeat", {});
    await c2.send("connector.heartbeat", {});
    await wait(800);
    for (const id of [s1.serverId, s2.serverId]) {
      assert.ok((await db.collection("servers").doc(id).get()).get("lastSeenAt"), `lastSeenAt set for ${id}`);
    }
    c1.close(); c2.close();
  });
});
