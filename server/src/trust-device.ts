import "./env.js";
import { query, closePool } from "./db.js";

/**
 * Trust (or revoke) a device.
 *
 * Why this is needed: the device model trusts the handset that *registers*, and
 * every later device starts untrusted. That is the right default against a
 * stolen password, but it makes reinstalling the app a dead end - the new
 * install has a new fingerprint, so it can never become trusted through the API
 * alone. This is the deliberate out-of-band path for that.
 *
 * Usage:
 *   npx tsx src/trust-device.ts list
 *   npx tsx src/trust-device.ts trust  <device-id|latest>
 *   npx tsx src/trust-device.ts revoke <device-id|latest>
 *   npx tsx src/trust-device.ts prune       # drop untrusted devices
 *
 * Trust is enforced server-side on the terminal socket and on refresh, so this
 * genuinely gates access - it is not a cosmetic flag.
 */

async function list(): Promise<void> {
  const res = await query<{
    id: string;
    email: string;
    name: string | null;
    platform: string | null;
    fingerprint: string;
    trusted: boolean;
    revoked: boolean;
    last_seen: Date;
  }>(
    `SELECT d.id, u.email, d.name, d.platform, d.fingerprint, d.trusted, d.revoked, d.last_seen
       FROM devices d JOIN users u ON u.id = d.user_id
      ORDER BY d.last_seen DESC`,
  );

  if (!res.rowCount) {
    console.log("no devices registered");
    return;
  }
  console.log("id                                    trusted  last seen             fp        name");
  for (const r of res.rows) {
    console.log(
      `${r.id}  ${r.trusted ? "yes" : "no "}      ${new Date(r.last_seen).toISOString().slice(0, 19)}  ` +
        `${r.fingerprint.slice(0, 12)}  ${r.name ?? "-"}`,
    );
  }
}

/** Resolve an id, or pick the most recently seen device for "latest". */
async function resolveId(arg: string): Promise<string | null> {
  if (arg !== "latest") return arg;
  const res = await query<{ id: string }>(
    "SELECT id FROM devices ORDER BY last_seen DESC LIMIT 1",
  );
  return res.rows[0]?.id ?? null;
}

async function setTrusted(arg: string, trusted: boolean): Promise<void> {
  const id = await resolveId(arg);
  if (!id) {
    console.error("no device matched");
    process.exit(1);
  }
  const res = await query<{ id: string; trusted: boolean }>(
    `UPDATE devices SET trusted = $2, revoked = false, last_seen = now()
      WHERE id = $1 RETURNING id, trusted`,
    [id, trusted],
  );
  if (!res.rowCount) {
    console.error(`no device with id ${id}`);
    process.exit(1);
  }
  console.log(`device ${id} -> trusted=${trusted}`);
}

async function prune(): Promise<void> {
  const res = await query<{ id: string }>(
    "DELETE FROM devices WHERE trusted = false AND revoked = false RETURNING id",
  );
  console.log(`pruned ${res.rowCount ?? 0} untrusted device(s)`);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      await list();
      break;
    case "trust":
      if (!arg) throw new Error("trust needs a device id or 'latest'");
      await setTrusted(arg, true);
      break;
    case "revoke":
      if (!arg) throw new Error("revoke needs a device id or 'latest'");
      // Revoking is a hard stop: the row stays so the attempt is visible, but
      // the terminal and refresh paths both refuse it.
      await query("UPDATE devices SET revoked = true WHERE id = $1", [
        await resolveId(arg),
      ]);
      console.log("device revoked");
      break;
    case "prune":
      await prune();
      break;
    default:
      console.log("usage: list | trust <id|latest> | revoke <id|latest> | prune");
  }
  await list();
  await closePool();
}

main().catch(async (err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  await closePool().catch(() => {});
  process.exit(1);
});
