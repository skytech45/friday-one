/**
 * Reconciliation: read the destination back and compare it with the plan.
 * Counts per collection plus the fields that matter for security and
 * ownership. A non-empty `missing` or `mismatched` means the migration is
 * NOT accepted (acceptance test M-1).
 */
import { Timestamp } from "firebase-admin/firestore";
import { toFirestore } from "./importer.mjs";

/** Critical fields per collection (by the last collection segment of the path). */
export const CRITICAL_FIELDS = {
  users: ["email"],
  servers: ["ownerId", "enrollmentState", "connectorId"],
  connectorCredentials: ["credentialId", "serverId", "ownerId", "revokedAt", "expiresAt"],
  agents: ["agentId", "ownerId", "adapter"],
  projects: ["ownerId", "canonicalRoot"],
  policies: ["ownerId", "serverScope", "decision", "enabled", "version", "agentId", "projectRoot", "action"],
  jobs: ["ownerId", "state", "idempotencyKey"],
  permissionRequests: ["ownerId", "status", "payloadHash"],
  auditEvents: ["ownerId", "action"],
};

const collectionOf = (path) => {
  const parts = path.split("/");
  return parts[parts.length - 2];
};

function normalize(v) {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v === undefined) return null;
  return v;
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function reconcile(plan, { db, auth }) {
  const collections = {};
  const mismatches = [];
  const missing = [];
  const bump = (c, k) => { (collections[c] ??= { planned: 0, found: 0, missing: 0, mismatched: 0 })[k]++; };

  for (const part of chunks(plan.docs, 300)) {
    const snaps = await db.getAll(...part.map((d) => db.doc(d.path)));
    snaps.forEach((snap, i) => {
      const d = part[i];
      const c = collectionOf(d.path);
      bump(c, "planned");
      if (!snap.exists) {
        bump(c, "missing");
        missing.push(d.path);
        return;
      }
      bump(c, "found");
      const expected = toFirestore(d.data);
      const diffs = (CRITICAL_FIELDS[c] ?? []).filter((f) => JSON.stringify(normalize(snap.get(f))) !== JSON.stringify(normalize(expected[f])));
      if (diffs.length > 0) {
        bump(c, "mismatched");
        mismatches.push({ path: d.path, fields: diffs });
      }
    });
  }

  const users = { planned: plan.users.length, found: 0, missing: [], mismatched: [] };
  for (const part of chunks(plan.users, 100)) {
    const res = await auth.getUsers(part.map((u) => ({ uid: u.uid })));
    const byUid = new Map(res.users.map((u) => [u.uid, u]));
    for (const u of part) {
      const got = byUid.get(u.uid);
      if (!got) { users.missing.push(u.uid); continue; }
      users.found++;
      const googleWanted = u.providers.some((p) => p.providerId === "google.com");
      const googleHave = got.providerData.some((p) => p.providerId === "google.com");
      if (got.email !== u.email || googleWanted !== googleHave) users.mismatched.push(u.uid);
    }
  }

  return {
    ok: missing.length === 0 && mismatches.length === 0 && users.missing.length === 0 && users.mismatched.length === 0,
    collections,
    users,
    missing: missing.slice(0, 200),
    mismatches: mismatches.slice(0, 200),
  };
}
