/**
 * /api/v1 behaviour on Firebase (migration plan §6: A-1..A-10).
 *
 * Runs under `firebase emulators:exec --only auth,firestore` (npm test), so
 * tokens are real Firebase Auth emulator ID tokens and every read/write
 * hits the Firestore emulator. The router is called in-process.
 *
 * Not provable on the emulator (staging items): the Auth emulator issues
 * unsigned tokens, so signature checks on forged tokens, and the trusted
 * X-Forwarded-For position on Google's front end (A-3b).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { handle } from "../lib/app.js";
import { db } from "../lib/db.js";

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-friday-one";
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join(".")}`;

beforeEach(async () => {
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
});

/** Google sign-in through the Auth emulator (fake IdP token, as the emulator allows). */
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
  assert.ok(j.idToken, `emulator sign-in failed: ${JSON.stringify(j)}`);
  return { uid: j.localId, token: j.idToken };
}

async function passwordUser(email) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Passw0rd-not-real", returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

function call(method, path, { token, body, ip, query = {}, headers = {} } = {}) {
  return handle({
    method,
    path,
    query,
    body,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": `203.0.113.9, ${ip ?? randomIp()}`,
      ...headers,
    },
  });
}

/** Full pairing: create → session → claim → pickup. Returns everything. */
async function pair(user, name = "prod-vps") {
  const created = await call("POST", "/api/v1/enrollments", { token: user.token, body: { name } });
  assert.equal(created.status, 201);
  const token = created.body.enrollment_token;
  const sess = await call("POST", "/api/v1/enrollments/session", { body: { token } });
  assert.equal(sess.status, 200);
  const claim = await call("POST", `/api/v1/enrollments/${sess.body.enrollment_id}/claim`, {
    token: user.token, body: { code: sess.body.display_code },
  });
  assert.equal(claim.status, 200);
  const pickup = await call("POST", "/api/v1/enrollments/session/poll", { body: { token } });
  assert.equal(pickup.body.state, "paired");
  return { serverId: created.body.server_id, enrollmentId: sess.body.enrollment_id, token, credential: pickup.body.credential };
}

const asConnector = (credential) => ({ "x-connector-credential": credential });

describe("A-1 identity", () => {
  test("missing, malformed and non-Google tokens are rejected", async () => {
    assert.equal((await call("GET", "/api/v1/servers")).status, 401);
    assert.equal((await call("GET", "/api/v1/servers", { token: "not-a-jwt" })).status, 401);
    const pw = await passwordUser("pw@example.test");
    assert.equal((await call("GET", "/api/v1/servers", { token: pw })).status, 401, "D2: Google sign-in only");
  });
  test("a Google user gets an empty list and a profile document", async () => {
    const alice = await googleUser("alice");
    const res = await call("GET", "/api/v1/servers", { token: alice.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { servers: [] });
    const profile = (await db.collection("users").doc(alice.uid).get()).data();
    assert.equal(profile.email, "alice@example.test");
  });
});

describe("A-2 enrollment and pairing", () => {
  test("full flow: one-time credential, active server, bound credential", async () => {
    const alice = await googleUser("alice");
    const p = await pair(alice);
    assert.match(p.credential, /^[A-Za-z0-9_-]{40,}$/);
    // The realtime envelope schema requires server_id to be a UUID.
    assert.match(p.serverId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // One-time pickup: a second poll gets no credential.
    const again = await call("POST", "/api/v1/enrollments/session/poll", { body: { token: p.token } });
    assert.deepEqual(again.body, { state: "pending" });

    const enr = (await db.collection("enrollments").doc(p.enrollmentId).get()).data();
    assert.equal(enr.state, "paired");
    assert.equal(enr.credentialPickup, undefined, "plaintext credential removed after pickup");
    const cred = (await db.collection("connectorCredentials").doc(sha256(p.credential)).get()).data();
    const server = (await db.collection("servers").doc(p.serverId).get()).data();
    assert.equal(server.enrollmentState, "active");
    assert.equal(server.connectorId, cred.credentialId, "F-M10: credential bound at claim");

    const list = await call("GET", "/api/v1/servers", { token: alice.token });
    assert.equal(list.body.servers[0].id, p.serverId);
    assert.equal(list.body.servers[0].enrollment_state, "active");

    const sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.rotation_due, false, "no spurious rotation after pairing");
  });

  test("GET poll with ?token= still works for connector 0.1.x", async () => {
    const alice = await googleUser("alice");
    const created = await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } });
    const res = await call("GET", "/api/v1/enrollments/session", { query: { token: created.body.enrollment_token } });
    assert.deepEqual(res.body, { state: "pending" });
  });

  test("session token is single-use and must be valid", async () => {
    const alice = await googleUser("alice");
    const created = await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } });
    const token = created.body.enrollment_token;
    assert.equal((await call("POST", "/api/v1/enrollments/session", { body: { token } })).status, 200);
    assert.equal((await call("POST", "/api/v1/enrollments/session", { body: { token } })).status, 403);
    assert.equal((await call("POST", "/api/v1/enrollments/session", { body: { token: "nope" } })).status, 403);
  });

  test("expired enrollment token is refused", async () => {
    const alice = await googleUser("alice");
    const created = await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } });
    const tokenDoc = await db.collection("enrollmentTokens").doc(sha256(created.body.enrollment_token)).get();
    await db.collection("enrollments").doc(tokenDoc.get("enrollmentId")).update({ tokenExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const res = await call("POST", "/api/v1/enrollments/session", { body: { token: created.body.enrollment_token } });
    assert.equal(res.status, 403);
  });

  test("claim: other user, wrong code, expired code, attempt budget, reuse", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const created = await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } });
    const sess = await call("POST", "/api/v1/enrollments/session", { body: { token: created.body.enrollment_token } });
    const path = `/api/v1/enrollments/${sess.body.enrollment_id}/claim`;
    const wrong = sess.body.display_code === "1".repeat(16) ? "2".repeat(16) : "1".repeat(16);

    assert.equal((await call("POST", path, { token: bob.token, body: { code: sess.body.display_code } })).body.error, "not_owner");
    assert.equal((await call("POST", path, { token: alice.token, body: { code: "123" } })).status, 400);
    for (let i = 0; i < 5; i++) {
      assert.equal((await call("POST", path, { token: alice.token, body: { code: wrong } })).body.error, "bad_code");
    }
    const sixth = await call("POST", path, { token: alice.token, body: { code: sess.body.display_code } });
    assert.equal(sixth.body.error, "too_many_attempts", "budget is exhausted even for the right code");
    assert.equal((await call("POST", "/api/v1/enrollments/nope/claim", { token: alice.token, body: { code: wrong } })).status, 404);
  });

  test("expired display code and second claim are refused", async () => {
    const alice = await googleUser("alice");
    const created = await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } });
    const sess = await call("POST", "/api/v1/enrollments/session", { body: { token: created.body.enrollment_token } });
    const path = `/api/v1/enrollments/${sess.body.enrollment_id}/claim`;
    const ref = db.collection("enrollments").doc(sess.body.enrollment_id);
    await ref.update({ displayCodeExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    assert.equal((await call("POST", path, { token: alice.token, body: { code: sess.body.display_code } })).body.error, "expired");
    await ref.update({ displayCodeExpiresAt: Timestamp.fromMillis(Date.now() + 60_000) });
    assert.equal((await call("POST", path, { token: alice.token, body: { code: sess.body.display_code } })).status, 200);
    assert.equal((await call("POST", path, { token: alice.token, body: { code: sess.body.display_code } })).body.error, "not_pending");
  });

  test("parallel correct claims issue exactly one credential", async () => {
    const alice = await googleUser("alice");
    const created = await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } });
    const sess = await call("POST", "/api/v1/enrollments/session", { body: { token: created.body.enrollment_token } });
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      call("POST", `/api/v1/enrollments/${sess.body.enrollment_id}/claim`, { token: alice.token, body: { code: sess.body.display_code } })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    const creds = await db.collection("connectorCredentials").where("serverId", "==", created.body.server_id).get();
    assert.equal(creds.size, 1, "no orphaned credentials from lost races");
  });
});

describe("A-3 rate limits (shared, transactional)", () => {
  test("enrollment creation: 10 per hour per IP, then 429 with Retry-After", async () => {
    const alice = await googleUser("alice");
    const ip = "198.51.100.7";
    const results = await Promise.all(Array.from({ length: 13 }, () =>
      call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" }, ip })));
    assert.equal(results.filter((r) => r.status === 201).length, 10, "exactly the budget, even in parallel");
    const limited = results.find((r) => r.status === 429);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal((await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" } })).status, 201, "other IPs unaffected");
  });

  test("failed claims are expensive: the second failure in an hour is throttled", async () => {
    const alice = await googleUser("alice");
    const ip = "198.51.100.8";
    const first = await call("POST", "/api/v1/enrollments/nope/claim", { token: alice.token, body: { code: "1".repeat(16) }, ip });
    assert.equal(first.status, 404);
    const second = await call("POST", "/api/v1/enrollments/nope/claim", { token: alice.token, body: { code: "1".repeat(16) }, ip });
    assert.equal(second.status, 429);
  });

  test("the bucket key is hashed: no raw IP stored", async () => {
    const alice = await googleUser("alice");
    await call("POST", "/api/v1/enrollments", { token: alice.token, body: { name: "x" }, ip: "198.51.100.9" });
    const docs = await db.collection("rateLimits").get();
    for (const d of docs.docs) assert.ok(!JSON.stringify({ id: d.id, ...d.data() }).includes("198.51.100.9"));
  });
});

describe("A-4 revocation", () => {
  test("revoke kills the credential, closes enrollments, is owner-only and idempotent", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const p = await pair(alice);
    assert.equal((await call("POST", `/api/v1/servers/${p.serverId}/revoke`, { token: bob.token })).status, 404);
    assert.equal((await call("POST", `/api/v1/servers/${p.serverId}/revoke`, { token: alice.token })).status, 200);
    const sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) });
    assert.equal(sync.status, 403);
    assert.equal(sync.body.error, "credential_revoked");
    const rot = await call("POST", "/api/v1/connector/rotate-credential", {
      headers: asConnector(p.credential), body: { new_credential_hash: sha256("x") },
    });
    assert.equal(rot.status, 403, "a revoked connector cannot rotate itself back in");
    assert.equal((await db.collection("servers").doc(p.serverId).get()).get("enrollmentState"), "revoked");
    assert.equal((await db.collection("enrollments").doc(p.enrollmentId).get()).get("state"), "revoked");
    assert.equal((await call("POST", `/api/v1/servers/${p.serverId}/revoke`, { token: alice.token })).status, 404);
  });
});

describe("A-5 policies and sync", () => {
  test("CRUD is owner-scoped and sync returns only effective rules", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const p = await pair(alice);
    const bobServer = await pair(bob, "bob-vps");

    assert.equal((await call("POST", "/api/v1/policies", { token: alice.token, body: { action: "rm -rf", decision: "allow" } })).status, 400);
    assert.equal((await call("POST", "/api/v1/policies", {
      token: alice.token, body: { action: "session.prompt", decision: "allow", server_id: bobServer.serverId },
    })).body.error, "not_your_server");

    const scoped = await call("POST", "/api/v1/policies", {
      token: alice.token, body: { action: "session.prompt", decision: "allow", server_id: p.serverId },
    });
    assert.equal(scoped.status, 201);
    assert.equal(scoped.body.policy.server_id, p.serverId);
    const global = await call("POST", "/api/v1/policies", { token: alice.token, body: { action: "shell.exec", decision: "deny" } });
    assert.equal(global.body.policy.server_id, null);

    const list = await call("GET", "/api/v1/policies", { token: alice.token });
    assert.equal(list.body.policies.length, 2);
    assert.equal(list.body.policies.find((x) => x.id === scoped.body.policy.id).server_name, "prod-vps");
    assert.equal((await call("GET", "/api/v1/policies", { token: bob.token })).body.policies.length, 0);

    let sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) });
    assert.deepEqual(sync.body.rules.map((r) => r.action).sort(), ["session.prompt", "shell.exec"]);
    const bobSync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(bobServer.credential) });
    assert.equal(bobSync.body.rules.length, 0, "another owner's rules never leak into sync");

    const id = scoped.body.policy.id;
    assert.equal((await call("PATCH", `/api/v1/policies/${id}`, { token: bob.token, body: { enabled: false } })).status, 404);
    assert.equal((await call("PATCH", `/api/v1/policies/${id}`, { token: alice.token, body: {} })).status, 400);
    assert.equal((await call("PATCH", `/api/v1/policies/${id}`, { token: alice.token, body: { enabled: false } })).status, 200);
    assert.equal((await db.collection("policies").doc(id).get()).get("version"), 2, "version bump invalidates old approvals");
    sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) });
    assert.deepEqual(sync.body.rules.map((r) => r.action), ["shell.exec"]);

    assert.equal((await call("DELETE", `/api/v1/policies/${global.body.policy.id}`, { token: alice.token })).status, 200);
    sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) });
    assert.equal(sync.body.rules.length, 0);
  });

  test("F-M3: an expired (unrevoked) credential cannot sync", async () => {
    const alice = await googleUser("alice");
    const p = await pair(alice);
    await db.collection("connectorCredentials").doc(sha256(p.credential)).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    assert.equal((await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) })).status, 403);
  });

  test("sync without a credential is 401", async () => {
    assert.equal((await call("GET", "/api/v1/policies/sync")).status, 401);
  });
});

describe("A-6 credential rotation", () => {
  test("owner trigger → connector rotates → old credential gets a grace expiry", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const p = await pair(alice);
    assert.equal((await call("POST", `/api/v1/servers/${p.serverId}/rotate`, { token: bob.token })).status, 404);
    assert.equal((await call("POST", `/api/v1/servers/${p.serverId}/rotate`, { token: alice.token })).status, 200);
    let sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(p.credential) });
    assert.equal(sync.body.rotation_due, true);

    const next = randomBytes(32).toString("base64url");
    const body = { new_credential_hash: sha256(next) };
    assert.equal((await call("POST", "/api/v1/connector/rotate-credential", { headers: asConnector(p.credential), body: { new_credential_hash: "zz" } })).status, 400);
    const rot = await call("POST", "/api/v1/connector/rotate-credential", { headers: asConnector(p.credential), body });
    assert.equal(rot.status, 200);
    assert.equal(rot.body.grace_seconds, 600);
    const replay = await call("POST", "/api/v1/connector/rotate-credential", { headers: asConnector(p.credential), body });
    assert.equal(replay.status, 200, "same hash replay is idempotent");
    assert.equal((await db.collection("connectorCredentials").where("serverId", "==", p.serverId).get()).size, 2);

    sync = await call("GET", "/api/v1/policies/sync", { headers: asConnector(next) });
    assert.equal(sync.body.rotation_due, false);
    const old = (await db.collection("connectorCredentials").doc(sha256(p.credential)).get()).data();
    assert.ok(old.expiresAt.toMillis() > Date.now(), "old credential still valid during grace");

    const bobServer = await pair(bob, "bob-vps");
    const steal = await call("POST", "/api/v1/connector/rotate-credential", {
      headers: asConnector(bobServer.credential), body,
    });
    assert.equal(steal.status, 409, "a hash bound to another server cannot be claimed");
  });
});

describe("A-7 jobs (F-M9 ownership)", () => {
  test("listing another user's server jobs is refused", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const p = await pair(alice);
    await db.collection("servers").doc(p.serverId).collection("jobs").doc("job-1").set({
      ownerId: alice.uid, serverId: p.serverId, operation: "session.prompt", state: "completed", updatedAt: Timestamp.now(),
    });
    const mine = await call("GET", "/api/v1/jobs", { token: alice.token, query: { server_id: p.serverId } });
    assert.equal(mine.body.jobs[0].id, "job-1");
    assert.equal((await call("GET", "/api/v1/jobs", { token: alice.token })).body.jobs.length, 1);
    assert.equal((await call("GET", "/api/v1/jobs", { token: bob.token, query: { server_id: p.serverId } })).status, 404);
    assert.equal((await call("GET", "/api/v1/jobs", { token: bob.token })).body.jobs.length, 0);
  });
});

describe("A-8 audit", () => {
  test("owner sees their events; nothing secret is recorded; others see nothing", async () => {
    const alice = await googleUser("alice");
    const bob = await googleUser("bob");
    const p = await pair(alice);
    await call("POST", "/api/v1/policies", { token: alice.token, body: { action: "file.read", decision: "allow" } });
    await call("POST", `/api/v1/servers/${p.serverId}/revoke`, { token: alice.token });
    const events = (await call("GET", "/api/v1/audit", { token: alice.token })).body.events;
    const actions = events.map((e) => e.action);
    for (const a of ["enrollment.claimed", "enrollment.paired", "policy.created", "server.revoked"]) assert.ok(actions.includes(a), a);
    const all = JSON.stringify((await db.collection("auditEvents").get()).docs.map((d) => d.data()));
    assert.ok(!all.includes(p.credential) && !all.includes(p.token), "no credential or token in audit");
    assert.equal((await call("GET", "/api/v1/audit", { token: bob.token })).body.events.length, 0);
    assert.equal((await call("GET", "/api/v1/audit", { token: alice.token, query: { limit: "2" } })).body.events.length, 2);
  });
});

describe("A-9/A-10 health and routing", () => {
  test("health returns the configured gateway URL", async () => {
    await db.collection("appConfig").doc("gateway_url").set({ value: "wss://gw.example.test" });
    const res = await call("GET", "/api/v1/health");
    assert.deepEqual(res.body, { ok: true, service: "friday-one-control-plane", gateway_url: "wss://gw.example.test" });
  });
  test("unknown path 404, wrong method 405, oversized body 413", async () => {
    assert.equal((await call("GET", "/api/v1/nope")).status, 404);
    assert.equal((await call("DELETE", "/api/v1/servers")).status, 405);
    assert.equal((await call("POST", "/api/v1/enrollments", { headers: { "content-length": String(70 * 1024) } })).status, 413);
  });
});
