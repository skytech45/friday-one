/**
 * Synthetic Supabase snapshot (no real data). Built to exercise every
 * transform rule: Google and password-only users, orphans, bad hashes,
 * duplicate agents, a cross-owner policy, pending approvals, ownerless
 * audit rows, secret-looking audit keys and a not-migrated enrollment that
 * holds a plaintext credential pickup.
 */
import { createHash } from "node:crypto";

export const sha256 = (v) => createHash("sha256").update(v).digest("hex");

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const CAROL = "33333333-3333-4333-8333-333333333333"; // password-only
export const GHOST = "99999999-9999-4999-8999-999999999999"; // not in auth export

export const A_SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const A_REVOKED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const B_SERVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
export const ORPHAN_SERVER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";

export const A_AGENT = "a9e71111-0000-4000-8000-000000000001";
export const A_PROJECT = "a9e71111-0000-4000-8000-0000000000p1".replace("p", "a");
export const A_CREDENTIAL = "alice-live-connector-credential";
export const A_CRED_ID = "c0000000-0000-4000-8000-000000000001";
export const PENDING_REQ = "d0000000-0000-4000-8000-000000000001";

const t = (s) => `2026-10-2${s}T10:00:00.000Z`;

export function fixture() {
  return {
    manifest: { exportedAt: t(6), sourceHost: "example.supabase.co" },
    counts: { pairing_codes: 0, rate_limit_hits: 4, agent_sessions: 0, chat_messages: 0, app_config: 1 },
    auth_users: [
      {
        id: ALICE, email: "alice@example.test", email_confirmed_at: t(0), created_at: t(0), banned_until: null,
        user_metadata: { full_name: "Alice A" },
        identities: [{ provider: "google", id: "google-sub-alice", identity_data: { sub: "google-sub-alice" } }],
      },
      {
        id: BOB, email: "bob@example.test", email_confirmed_at: t(0), created_at: t(0), banned_until: null,
        user_metadata: {}, identities: [{ provider: "google", identity_data: { sub: "google-sub-bob" } }],
      },
      {
        id: CAROL, email: "carol@example.test", email_confirmed_at: t(0), created_at: t(0), banned_until: null,
        user_metadata: {}, identities: [{ provider: "email", identity_data: { sub: CAROL } }],
      },
    ],
    profiles: [
      { id: ALICE, display_name: "Alice", created_at: t(0), updated_at: t(1) },
      { id: BOB, display_name: null, created_at: t(0), updated_at: t(0) },
      { id: GHOST, display_name: "Ghost", created_at: t(0), updated_at: t(0) },
    ],
    servers: [
      { id: A_SERVER, owner_id: ALICE, name: "prod-vps", host_label: null, enrollment_state: "active", connector_id: A_CRED_ID, last_seen_at: t(5), created_at: t(1), updated_at: t(5) },
      { id: A_REVOKED, owner_id: ALICE, name: "old-vps", host_label: null, enrollment_state: "revoked", connector_id: null, last_seen_at: null, created_at: t(1), updated_at: t(2) },
      { id: B_SERVER, owner_id: BOB, name: "bob-vps", host_label: null, enrollment_state: "active", connector_id: null, last_seen_at: null, created_at: t(1), updated_at: t(1) },
      { id: ORPHAN_SERVER, owner_id: GHOST, name: "orphan", host_label: null, enrollment_state: "active", connector_id: null, last_seen_at: null, created_at: t(1), updated_at: t(1) },
    ],
    connector_credentials: [
      { id: A_CRED_ID, server_id: A_SERVER, credential_hash: sha256(A_CREDENTIAL), created_at: t(1), expires_at: null, revoked_at: null, rotated_from: null },
      { id: "c0000000-0000-4000-8000-000000000002", server_id: A_REVOKED, credential_hash: sha256("old"), created_at: t(1), expires_at: null, revoked_at: t(2), rotated_from: null },
      { id: "c0000000-0000-4000-8000-000000000003", server_id: A_SERVER, credential_hash: "not-a-hash", created_at: t(1), expires_at: null, revoked_at: null, rotated_from: null },
      { id: "c0000000-0000-4000-8000-000000000004", server_id: ORPHAN_SERVER, credential_hash: sha256("orphan"), created_at: t(1), expires_at: null, revoked_at: null, rotated_from: null },
    ],
    agents: [
      { id: A_AGENT, server_id: A_SERVER, adapter: "opencode", adapter_version: "2.1.3", capabilities: {}, health: "healthy", discovered_at: t(3), created_at: t(3), updated_at: t(3) },
      { id: "a9e71111-0000-4000-8000-000000000002", server_id: A_SERVER, adapter: "opencode", adapter_version: "x", capabilities: {}, health: "healthy", discovered_at: t(3), created_at: t(3), updated_at: t(3) },
      { id: "a9e71111-0000-4000-8000-000000000003", server_id: A_SERVER, adapter: "../evil", adapter_version: "x", capabilities: {}, health: "healthy", discovered_at: t(3), created_at: t(3), updated_at: t(3) },
    ],
    projects: [
      { id: A_PROJECT, server_id: A_SERVER, agent_id: null, canonical_root: "/srv/app", label: "app", created_at: t(3) },
    ],
    permission_policies: [
      { id: "p0000000-0000-4000-8000-000000000001".replace("p", "f"), owner_id: ALICE, server_id: null, agent_id: null, project_id: null, action: "shell.exec", executable: null, argument_pattern: null, decision: "deny", priority: 10, version: 1, enabled: true, expires_at: null, created_at: t(3), updated_at: t(3) },
      { id: "f0000000-0000-4000-8000-000000000002", owner_id: ALICE, server_id: A_SERVER, agent_id: A_AGENT, project_id: A_PROJECT, action: "session.prompt", executable: null, argument_pattern: null, decision: "allow", priority: 100, version: 3, enabled: true, expires_at: null, created_at: t(3), updated_at: t(4) },
      { id: "f0000000-0000-4000-8000-000000000003", owner_id: ALICE, server_id: B_SERVER, agent_id: null, project_id: null, action: "file.read", executable: null, argument_pattern: null, decision: "allow", priority: 100, version: 1, enabled: true, expires_at: null, created_at: t(3), updated_at: t(3) },
    ],
    permission_requests: [
      { id: PENDING_REQ, server_id: A_SERVER, connector_id: A_CRED_ID, agent_id: A_AGENT, project_id: null, session_id: null, operation: "file.write", payload_hash: "h1", policy_version: 3, status: "pending", requested_at: t(5), expires_at: t(5), decided_by: null, decided_at: null, outcome: null },
      { id: "d0000000-0000-4000-8000-000000000002", server_id: A_SERVER, connector_id: A_CRED_ID, agent_id: A_AGENT, project_id: null, session_id: null, operation: "file.read", payload_hash: "h2", policy_version: 3, status: "approved", requested_at: t(4), expires_at: t(4), decided_by: ALICE, decided_at: t(4), outcome: null },
    ],
    command_jobs: [
      { id: "b0000000-0000-4000-8000-000000000001", server_id: A_SERVER, idempotency_key: "k1", operation: "session.prompt", state: "completed", result_summary: { stopReason: "end_turn" }, created_at: t(4), updated_at: t(4) },
      { id: "b0000000-0000-4000-8000-000000000002", server_id: A_SERVER, idempotency_key: "k2", operation: "session.prompt", state: "failed", result_summary: { blob: "x".repeat(5000) }, created_at: t(4), updated_at: t(4) },
    ],
    audit_events: [
      { id: 1, actor_id: ALICE, server_id: A_SERVER, action: "server.revoked", decision: null, correlation_id: null, detail: { reason: "lost laptop", enrollment_token: "SECRET-TOKEN", credential: "SECRET-CRED" }, created_at: t(2) },
      { id: 2, actor_id: null, server_id: A_SERVER, action: "credential.rotated", decision: null, correlation_id: null, detail: { grace_seconds: 600 }, created_at: t(3) },
      { id: 3, actor_id: null, server_id: null, action: "register_rejected", decision: null, correlation_id: null, detail: {}, created_at: t(3) },
    ],
    // Not migrated: must never appear in a plan.
    enrollments: [
      { id: "e0000000-0000-4000-8000-000000000001", server_id: B_SERVER, owner_id: BOB, state: "claim_requested", credential_pickup: "PLAINTEXT-PICKUP-SECRET" },
    ],
  };
}
