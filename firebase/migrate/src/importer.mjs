/**
 * Idempotent import of a migration plan into Firebase Auth + Firestore.
 *
 * - Users: existing UIDs are skipped (never overwritten); the rest go through
 *   `auth.importUsers` with their Google provider link and no password.
 * - Documents: `create()` by default, so a re-run reports "existing" instead
 *   of overwriting data written since (heartbeats, new jobs). `--overwrite`
 *   uses `set()` for a deliberate re-import into a fresh staging project.
 * - Dry run: reads only; reports what a real run would create or skip.
 *
 * Never point this at production without explicit authorization
 * (migration plan §4, DATA_MIGRATION.md).
 */
import { Timestamp } from "firebase-admin/firestore";

const USER_CHUNK = 100; // getUsers limit
const DOC_CHUNK = 300;

/** Plan values → Firestore values ({ __ts } → Timestamp), recursively. */
export function toFirestore(value) {
  if (Array.isArray(value)) return value.map(toFirestore);
  if (value && typeof value === "object") {
    if (typeof value.__ts === "string" && Object.keys(value).length === 1) return Timestamp.fromDate(new Date(value.__ts));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toFirestore(v)]));
  }
  return value;
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function existingUids(auth, users) {
  const found = new Set();
  for (const part of chunks(users, USER_CHUNK)) {
    const res = await auth.getUsers(part.map((u) => ({ uid: u.uid })));
    for (const u of res.users) found.add(u.uid);
  }
  return found;
}

async function existingPaths(db, docs) {
  const found = new Set();
  for (const part of chunks(docs, DOC_CHUNK)) {
    const snaps = await db.getAll(...part.map((d) => db.doc(d.path)));
    for (const s of snaps) if (s.exists) found.add(s.ref.path);
  }
  return found;
}

/**
 * @returns {Promise<{ dryRun: boolean, users: object, docs: object }>}
 */
export async function importPlan(plan, { db, auth, overwrite = false, dryRun = false }) {
  const result = {
    dryRun,
    users: { planned: plan.users.length, created: 0, existing: 0, failed: [] },
    docs: { planned: plan.docs.length, created: 0, overwritten: 0, existing: 0, failed: [] },
  };

  // ---- users -------------------------------------------------------------------
  const haveUsers = await existingUids(auth, plan.users);
  const newUsers = plan.users.filter((u) => !haveUsers.has(u.uid));
  result.users.existing = haveUsers.size;
  if (dryRun) {
    result.users.created = newUsers.length;
  } else {
    for (const part of chunks(newUsers, 1000)) {
      const res = await auth.importUsers(part.map((u) => ({
        uid: u.uid,
        email: u.email,
        emailVerified: u.emailVerified,
        ...(u.displayName ? { displayName: u.displayName } : {}),
        disabled: u.disabled,
        providerData: u.providers.map((p) => ({ uid: p.uid, providerId: p.providerId, email: p.email })),
      })));
      result.users.created += res.successCount;
      for (const e of res.errors) result.users.failed.push({ uid: part[e.index].uid, reason: e.error.code ?? e.error.message });
    }
  }

  // ---- documents ---------------------------------------------------------------
  const havePaths = overwrite ? new Set() : await existingPaths(db, plan.docs);
  const toWrite = plan.docs.filter((d) => !havePaths.has(d.path));
  result.docs.existing = havePaths.size;
  if (dryRun) {
    result.docs.created = toWrite.length;
    return result;
  }
  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    if (err.code === 6) return false; // ALREADY_EXISTS: written concurrently; counted below
    return err.failedAttempts < 3;
  });
  // Queue every write first: BulkWriter only settles a write once its batch
  // flushes, and close() is what flushes the last batch.
  const outcomes = toWrite.map((d) => {
    const ref = db.doc(d.path);
    const op = overwrite ? writer.set(ref, toFirestore(d.data)) : writer.create(ref, toFirestore(d.data));
    return op.then(
      () => { if (overwrite) result.docs.overwritten++; else result.docs.created++; },
      (e) => {
        if (e.code === 6) result.docs.existing++;
        else result.docs.failed.push({ path: d.path, reason: e.code ?? e.message });
      },
    );
  });
  await writer.close();
  await Promise.all(outcomes);
  return result;
}
