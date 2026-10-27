/** Transform rules (DATA_MIGRATION.md §3). Pure: no emulator needed. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { transform } from "../src/transform.mjs";
import {
  A_AGENT, A_CRED_ID, A_CREDENTIAL, A_SERVER, ALICE, B_SERVER, CAROL, GHOST, ORPHAN_SERVER, PENDING_REQ, fixture, sha256,
} from "./fixture.mjs";

const plan = transform(fixture());
const doc = (path) => plan.docs.find((d) => d.path === path)?.data;
const paths = plan.docs.map((d) => d.path);

describe("identity mapping", () => {
  test("Supabase UUIDs become Firebase UIDs; Google identities carried over", () => {
    const alice = plan.users.find((u) => u.uid === ALICE);
    assert.deepEqual(alice.providers, [{ providerId: "google.com", uid: "google-sub-alice", email: "alice@example.test" }]);
    assert.equal(alice.emailVerified, true);
  });
  test("password-only users are imported without a provider and flagged", () => {
    const carol = plan.users.find((u) => u.uid === CAROL);
    assert.deepEqual(carol.providers, []);
    assert.ok(plan.report.flagged.some((f) => f.id === CAROL));
  });
  test("profiles keep the UID; a profile without an auth user fails", () => {
    assert.equal(doc(`users/${ALICE}`).displayName, "Alice");
    assert.equal(doc(`users/${CAROL}`).displayName, "carol", "falls back to the email local part");
    assert.ok(plan.report.failed.some((f) => f.table === "profiles" && f.id === GHOST));
  });
});

describe("referential integrity", () => {
  test("servers whose owner is missing fail, and so does everything under them", () => {
    assert.ok(!paths.includes(`servers/${ORPHAN_SERVER}`));
    assert.ok(plan.report.failed.some((f) => f.table === "servers" && f.id === ORPHAN_SERVER));
    assert.ok(plan.report.failed.some((f) => f.table === "connector_credentials" && f.reason === "server not migrated"));
  });
  test("credentials keyed by hash with ownership; malformed hashes fail", () => {
    const c = doc(`connectorCredentials/${sha256(A_CREDENTIAL)}`);
    assert.equal(c.credentialId, A_CRED_ID);
    assert.equal(c.ownerId, ALICE);
    assert.ok(plan.report.failed.some((f) => f.reason.includes("sha256")));
  });
  test("agent UUID preserved as agentId; duplicate and invalid adapters fail", () => {
    assert.equal(doc(`servers/${A_SERVER}/agents/opencode`).agentId, A_AGENT);
    assert.deepEqual(plan.agentIdMap[A_AGENT], { serverId: A_SERVER, adapter: "opencode" });
    assert.equal(plan.report.tables.agents.failed, 2);
  });
  test("policies: scope, agent and project root mapped; a policy on another owner's server fails", () => {
    const p = doc("policies/f0000000-0000-4000-8000-000000000002");
    assert.equal(p.serverScope, A_SERVER);
    assert.equal(p.agentId, A_AGENT);
    assert.equal(p.projectRoot, "/srv/app");
    assert.equal(p.version, 3);
    assert.equal(doc("policies/f0000000-0000-4000-8000-000000000001").serverScope, "all");
    assert.ok(plan.report.failed.some((f) => f.id === "f0000000-0000-4000-8000-000000000003"));
    assert.ok(!paths.some((x) => x.includes(B_SERVER) && x.startsWith("policies/")));
  });
});

describe("operational history", () => {
  test("jobs use the gateway's deterministic ID and keep the legacy ID; summaries bounded", () => {
    const id = sha256(`${A_SERVER}:k1`);
    assert.equal(doc(`servers/${A_SERVER}/jobs/${id}`).legacyId, "b0000000-0000-4000-8000-000000000001");
    const big = doc(`servers/${A_SERVER}/jobs/${sha256(`${A_SERVER}:k2`)}`);
    assert.equal(big.resultSummary.truncated, true);
  });
  test("pending approvals are imported as expired, with gateway-compatible IDs", () => {
    const r = doc(`servers/${A_SERVER}/permissionRequests/${PENDING_REQ.replaceAll("-", "")}`);
    assert.equal(r.status, "expired");
    assert.match(PENDING_REQ.replaceAll("-", ""), /^[A-Za-z0-9]{1,64}$/);
  });
  test("audit: owner from actor or server; ownerless rows skipped; secrets redacted", () => {
    const e1 = doc("auditEvents/legacy-1");
    assert.deepEqual(e1.detail, { reason: "lost laptop" });
    assert.equal(doc("auditEvents/legacy-2").ownerId, ALICE, "owner via server");
    assert.ok(!paths.includes("auditEvents/legacy-3"));
    assert.ok(plan.report.skipped.some((s) => s.table === "audit_events" && s.id === "3"));
  });
});

describe("secrets and not-migrated tables", () => {
  test("nothing from enrollments (or any plaintext secret) reaches the plan", () => {
    const text = JSON.stringify(plan);
    for (const secret of ["PLAINTEXT-PICKUP-SECRET", "SECRET-TOKEN", "SECRET-CRED", A_CREDENTIAL]) {
      assert.ok(!text.includes(secret), `${secret} leaked into the plan`);
    }
    assert.equal(plan.report.tables.enrollments.skipped, 1);
    assert.equal(plan.report.tables.rate_limit_hits.skipped, 4);
  });
  test("counts add up per table", () => {
    for (const [t, c] of Object.entries(plan.report.tables)) {
      if (t === "auth_users") continue;
      assert.equal(c.planned + c.skipped + c.failed, c.source, `table ${t}: ${JSON.stringify(c)}`);
    }
  });
  test("deterministic: the same snapshot gives the same plan", () => {
    const again = transform(fixture());
    assert.deepEqual(again.docs.map((d) => d.path), plan.docs.map((d) => d.path));
  });
});
