/**
 * Firestore Security Rules tests (migration plan §6, R-1..R-12).
 *
 * Runs against the local emulator under the `demo-friday-one` project via
 * `npm test`, which wraps `firebase emulators:exec`. Fixtures are seeded with
 * rules disabled (as the Admin-SDK backends would write them); each test
 * then acts as an unauthenticated client, the owner, or another user.
 */
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

const ALICE = "alice-uid";
const BOB = "bob-uid";
const SERVER = "srv-alice-1";
const REVOKED = "srv-alice-revoked";

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-friday-one",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

/** Seed the data the trusted backends would have written. */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();
    await setDoc(doc(db, "users", ALICE), { displayName: "Alice", email: "alice@example.test", createdAt: now, updatedAt: now });
    await setDoc(doc(db, "users", BOB), { displayName: "Bob", email: "bob@example.test", createdAt: now, updatedAt: now });
    await setDoc(doc(db, "servers", SERVER), {
      ownerId: ALICE, name: "prod-vps", enrollmentState: "active", connectorId: "cred-1", lastSeenAt: now, createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "servers", REVOKED), {
      ownerId: ALICE, name: "old-vps", enrollmentState: "revoked", connectorId: null, createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "servers", SERVER, "agents", "opencode"), { ownerId: ALICE, serverId: SERVER, adapter: "opencode", health: "healthy" });
    await setDoc(doc(db, "servers", SERVER, "projects", "p1"), { ownerId: ALICE, serverId: SERVER, canonicalRoot: "/srv/app" });
    await setDoc(doc(db, "servers", SERVER, "jobs", "job-1"), {
      ownerId: ALICE, serverId: SERVER, operation: "session.prompt", state: "started", createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "servers", SERVER, "permissionRequests", "req-1"), {
      ownerId: ALICE, serverId: SERVER, operation: "file.write", payloadHash: "abc", status: "pending", requestedAt: now, expiresAt: now,
    });
    await setDoc(doc(db, "policies", "pol-1"), {
      ownerId: ALICE, serverScope: SERVER, action: "session.prompt", decision: "require_approval", priority: 100, enabled: true, version: 1, createdAt: now,
    });
    await setDoc(doc(db, "auditEvents", "evt-1"), {
      ownerId: ALICE, actorId: ALICE, serverId: SERVER, action: "server.revoked", detail: {}, createdAt: now,
    });
    await setDoc(doc(db, "connectorCredentials", "f".repeat(64)), { ownerId: ALICE, serverId: SERVER, credentialId: "cred-1" });
    await setDoc(doc(db, "enrollments", "enr-1"), { ownerId: ALICE, serverId: SERVER, state: "created" });
    await setDoc(doc(db, "enrollmentTokens", "e".repeat(64)), { ownerId: ALICE, enrollmentId: "enr-1" });
    await setDoc(doc(db, "rateLimits", "claim:1.2.3.4"), { count: 1 });
    await setDoc(doc(db, "appConfig", "gateway_url"), { value: "wss://gw.example.test" });
  });
});

const anon = () => env.unauthenticatedContext().firestore();
const as = (uid) => env.authenticatedContext(uid).firestore();

describe("R-1 unauthenticated clients", () => {
  test("cannot read any document", async () => {
    const db = anon();
    for (const path of [["users", ALICE], ["servers", SERVER], ["policies", "pol-1"], ["auditEvents", "evt-1"], ["appConfig", "gateway_url"]]) {
      await assertFails(getDoc(doc(db, ...path)));
    }
  });
  test("cannot list servers or create anything", async () => {
    const db = anon();
    await assertFails(getDocs(query(collection(db, "servers"), where("ownerId", "==", ALICE))));
    await assertFails(setDoc(doc(db, "servers", "new"), { ownerId: ALICE, name: "x", enrollmentState: "pending" }));
  });
});

describe("R-2/R-3 server ownership", () => {
  test("owner can read own server", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "servers", SERVER)));
  });
  test("another user cannot read it", async () => {
    await assertFails(getDoc(doc(as(BOB), "servers", SERVER)));
  });
  test("owner-filtered list succeeds", async () => {
    await assertSucceeds(getDocs(query(collection(as(ALICE), "servers"), where("ownerId", "==", ALICE))));
  });
  test("unfiltered list and filtering on someone else fail", async () => {
    await assertFails(getDocs(collection(as(ALICE), "servers")));
    await assertFails(getDocs(query(collection(as(BOB), "servers"), where("ownerId", "==", ALICE))));
  });
});

describe("R-4 no client writes to servers (enrollment, ownership, revocation)", () => {
  test("unauthorized enrollment: creating a server fails even for self", async () => {
    await assertFails(setDoc(doc(as(ALICE), "servers", "srv-new"), {
      ownerId: ALICE, name: "sneaky", enrollmentState: "active", createdAt: serverTimestamp(),
    }));
  });
  test("owner cannot change enrollment state, connector binding or heartbeat", async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(doc(db, "servers", SERVER), { enrollmentState: "revoked" }));
    await assertFails(updateDoc(doc(db, "servers", SERVER), { connectorId: "cred-attacker" }));
    await assertFails(updateDoc(doc(db, "servers", SERVER), { lastSeenAt: serverTimestamp() }));
  });
  test("ownership cannot be transferred or stolen", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "servers", SERVER), { ownerId: BOB }));
    await assertFails(updateDoc(doc(as(BOB), "servers", SERVER), { ownerId: BOB }));
  });
  test("owner cannot delete a server record", async () => {
    await assertFails(deleteDoc(doc(as(ALICE), "servers", SERVER)));
  });
});

describe("R-5 operational subcollections and approvals", () => {
  for (const [sub, id] of [["agents", "opencode"], ["projects", "p1"], ["jobs", "job-1"], ["permissionRequests", "req-1"]]) {
    test(`${sub}: owner reads, other user does not`, async () => {
      await assertSucceeds(getDoc(doc(as(ALICE), "servers", SERVER, sub, id)));
      await assertFails(getDoc(doc(as(BOB), "servers", SERVER, sub, id)));
    });
  }
  test("approval tampering: owner cannot approve by writing the request", async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(doc(db, "servers", SERVER, "permissionRequests", "req-1"), { status: "approved", decidedBy: ALICE }));
    await assertFails(updateDoc(doc(db, "servers", SERVER, "permissionRequests", "req-1"), { payloadHash: "different" }));
  });
  test("forging a permission request or job fails", async () => {
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, "servers", SERVER, "permissionRequests", "req-forged"), {
      ownerId: ALICE, serverId: SERVER, operation: "credential.access", payloadHash: "x", status: "approved",
    }));
    await assertFails(setDoc(doc(db, "servers", SERVER, "jobs", "job-forged"), { ownerId: ALICE, state: "completed" }));
  });
});

describe("R-6 collection-group job history", () => {
  test("owner can query all own jobs", async () => {
    await assertSucceeds(getDocs(query(collectionGroup(as(ALICE), "jobs"), where("ownerId", "==", ALICE))));
  });
  test("another user cannot query them", async () => {
    await assertFails(getDocs(query(collectionGroup(as(BOB), "jobs"), where("ownerId", "==", ALICE))));
  });
});

describe("R-7 policies", () => {
  test("owner can read own policy, other user cannot", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "policies", "pol-1")));
    await assertFails(getDoc(doc(as(BOB), "policies", "pol-1")));
  });
  test("unauthorized policy changes fail, including by the owner", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "policies", "pol-1"), { decision: "allow" }));
    await assertFails(updateDoc(doc(as(BOB), "policies", "pol-1"), { decision: "allow" }));
    await assertFails(setDoc(doc(as(ALICE), "policies", "pol-new"), { ownerId: ALICE, serverScope: "all", action: "shell.exec", decision: "allow" }));
    await assertFails(deleteDoc(doc(as(ALICE), "policies", "pol-1")));
  });
});

describe("R-8 audit integrity", () => {
  test("owner can read own events, other user cannot", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "auditEvents", "evt-1")));
    await assertFails(getDoc(doc(as(BOB), "auditEvents", "evt-1")));
  });
  test("events cannot be forged, altered or deleted", async () => {
    const db = as(ALICE);
    await assertFails(addDoc(collection(db, "auditEvents"), { ownerId: ALICE, action: "server.revoked" }));
    await assertFails(updateDoc(doc(db, "auditEvents", "evt-1"), { action: "nothing.happened" }));
    await assertFails(deleteDoc(doc(db, "auditEvents", "evt-1")));
  });
});

describe("R-9 backend-only collections", () => {
  const paths = [
    ["connectorCredentials", "f".repeat(64)],
    ["enrollments", "enr-1"],
    ["enrollmentTokens", "e".repeat(64)],
    ["rateLimits", "claim:1.2.3.4"],
    ["appConfig", "gateway_url"],
  ];
  for (const [col, id] of paths) {
    test(`${col}: no read or write even for the owning user`, async () => {
      const db = as(ALICE);
      await assertFails(getDoc(doc(db, col, id)));
      await assertFails(setDoc(doc(db, col, id), { ownerId: ALICE, tampered: true }));
      await assertFails(deleteDoc(doc(db, col, id)));
    });
  }
  test("rate limits cannot be reset by a client", async () => {
    await assertFails(setDoc(doc(as(BOB), "rateLimits", "claim:1.2.3.4"), { count: 0 }));
  });
});

describe("R-10 user profile", () => {
  test("own profile readable, others not, no listing", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "users", ALICE)));
    await assertFails(getDoc(doc(as(ALICE), "users", BOB)));
    await assertFails(getDocs(collection(as(ALICE), "users")));
  });
  test("owner may change displayName with a server timestamp", async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), "users", ALICE), { displayName: "Alice B", updatedAt: serverTimestamp() }));
  });
  test("client-chosen timestamps, other fields and bad lengths are rejected", async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(doc(db, "users", ALICE), { displayName: "A", updatedAt: Timestamp.fromMillis(0) }));
    await assertFails(updateDoc(doc(db, "users", ALICE), { email: "evil@example.test", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "users", ALICE), { role: "admin", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "users", ALICE), { displayName: "", updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "users", ALICE), { displayName: "x".repeat(121), updatedAt: serverTimestamp() }));
  });
  test("cannot edit another user's profile or create/delete profiles", async () => {
    await assertFails(updateDoc(doc(as(BOB), "users", ALICE), { displayName: "pwned", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(as(ALICE), "users", "alice-2"), { displayName: "x" }));
    await assertFails(deleteDoc(doc(as(ALICE), "users", ALICE)));
  });
});

describe("R-11 revoked server", () => {
  test("owner keeps read access to history but cannot reactivate it", async () => {
    const db = as(ALICE);
    await assertSucceeds(getDoc(doc(db, "servers", REVOKED)));
    await assertFails(updateDoc(doc(db, "servers", REVOKED), { enrollmentState: "active" }));
    await assertFails(updateDoc(doc(db, "servers", REVOKED), { connectorId: "cred-1" }));
  });
});

describe("R-12 default deny", () => {
  test("unknown collections are closed", async () => {
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, "anything", "x"), { ownerId: ALICE }));
    await assertFails(getDoc(doc(db, "agent_sessions", "x")));
  });
});
