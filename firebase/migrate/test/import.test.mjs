/**
 * Import + reconcile on the Auth and Firestore emulators (acceptance M-1),
 * plus an end-to-end check that migrated identities and credentials work
 * with the new API code (firebase/functions, must be built: npm run build).
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { transform } from "../src/transform.mjs";
import { importPlan } from "../src/importer.mjs";
import { reconcile } from "../src/reconcile.mjs";
import { A_AGENT, A_CREDENTIAL, A_CRED_ID, A_REVOKED, A_SERVER, ALICE, BOB, CAROL, fixture } from "./fixture.mjs";

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-friday-one";
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const FS = `http://${process.env.FIRESTORE_EMULATOR_HOST}`;
const app = initializeApp({ projectId: PROJECT }, "migrate-test");
const db = getFirestore(app);
const auth = getAuth(app);
const plan = transform(fixture());

async function wipe() {
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
}

describe("import and reconcile (sequential)", () => {
  before(wipe);

  test("dry run reports the work and writes nothing", async () => {
    const r = await importPlan(plan, { db, auth, dryRun: true });
    assert.equal(r.users.created, 3);
    assert.equal(r.docs.created, plan.docs.length);
    assert.equal((await db.collection("servers").get()).size, 0);
    assert.equal((await auth.listUsers()).users.length, 0);
  });

  test("import creates users with their providers and every planned document", async () => {
    const r = await importPlan(plan, { db, auth });
    assert.deepEqual(r.users.failed, []);
    assert.deepEqual(r.docs.failed, []);
    assert.equal(r.users.created, 3);
    assert.equal(r.docs.created, plan.docs.length);
    const alice = await auth.getUser(ALICE);
    assert.equal(alice.providerData[0].providerId, "google.com");
    assert.equal(alice.providerData[0].uid, "google-sub-alice");
    assert.equal((await auth.getUser(CAROL)).providerData.length, 0);
    const server = (await db.doc(`servers/${A_SERVER}`).get()).data();
    assert.equal(server.ownerId, ALICE);
    assert.equal(typeof server.createdAt.toMillis, "function", "timestamps are Firestore Timestamps");
  });

  test("reconcile: everything planned is present and matches", async () => {
    const r = await reconcile(plan, { db, auth });
    assert.equal(r.ok, true, JSON.stringify({ missing: r.missing, mismatches: r.mismatches, users: r.users }));
    assert.equal(r.collections.servers.found, 3);
  });

  test("re-running is idempotent: nothing created, nothing overwritten", async () => {
    await db.doc(`servers/${A_SERVER}`).update({ lastSeenAt: new Date() }); // live write after import
    const r = await importPlan(plan, { db, auth });
    assert.equal(r.users.created, 0);
    assert.equal(r.users.existing, 3);
    assert.equal(r.docs.created, 0);
    assert.equal(r.docs.existing, plan.docs.length);
    assert.ok((await db.doc(`servers/${A_SERVER}`).get()).get("lastSeenAt").toMillis() > Date.parse("2026-10-26"), "live data kept");
  });

  test("migrated identity and credentials work with the new API (no re-pairing)", async () => {
    // Same Google account → same UID (the imported Supabase UUID).
    const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(JSON.stringify({ sub: "google-sub-alice", email: "alice@example.test", email_verified: true }))}&providerId=google.com`,
        requestUri: "http://localhost",
        returnSecureToken: true,
      }),
    });
    const signIn = await r.json();
    assert.equal(signIn.localId, ALICE);

    const { handle } = await import("../../functions/lib/app.js");
    const call = (method, path, headers = {}) => handle({ method, path, query: {}, body: undefined, headers: { "x-forwarded-for": "10.9.9.9", ...headers } });

    const servers = await call("GET", "/api/v1/servers", { authorization: `Bearer ${signIn.idToken}` });
    assert.equal(servers.status, 200);
    const prod = servers.body.servers.find((s) => s.id === A_SERVER);
    assert.equal(prod.enrollment_state, "active");
    assert.equal(prod.agents[0].id, A_AGENT, "agent UUID preserved on the wire");
    assert.ok(servers.body.servers.some((s) => s.id === A_REVOKED && s.enrollment_state === "revoked"));
    assert.ok(!servers.body.servers.some((s) => s.ownerId === BOB));

    const sync = await call("GET", "/api/v1/policies/sync", { "x-connector-credential": A_CREDENTIAL });
    assert.equal(sync.status, 200, "an already-paired connector keeps working");
    assert.equal(sync.body.rotation_due, false, `connectorId ${A_CRED_ID} matches`);
    const prompt = sync.body.rules.find((x) => x.action === "session.prompt");
    assert.equal(prompt.agent_id, A_AGENT);
    assert.equal(prompt.project_root, "/srv/app");
    assert.ok(sync.body.rules.some((x) => x.action === "shell.exec" && x.decision === "deny"));
    assert.equal((await call("GET", "/api/v1/policies/sync", { "x-connector-credential": "old" })).status, 403, "revoked credential stays revoked");
  });

  test("reconcile detects drift and loss; --overwrite repairs it", async () => {
    await db.doc(`servers/${A_SERVER}`).update({ ownerId: BOB });
    await db.doc("policies/f0000000-0000-4000-8000-000000000002").delete();
    const bad = await reconcile(plan, { db, auth });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.mismatches, [{ path: `servers/${A_SERVER}`, fields: ["ownerId"] }]);
    assert.deepEqual(bad.missing, ["policies/f0000000-0000-4000-8000-000000000002"]);

    const fix = await importPlan(plan, { db, auth, overwrite: true });
    assert.equal(fix.docs.overwritten, plan.docs.length);
    assert.equal((await reconcile(plan, { db, auth })).ok, true);
  });
});
