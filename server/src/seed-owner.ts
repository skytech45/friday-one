import "./env.js";
import { ownerCredentials } from "./config.js";
import { query, closePool } from "./db.js";
import { hashPassword } from "./security.js";

/**
 * Create or reset the single owner account.
 *
 * The password is read from FRIDAY_OWNER_PASSWORD and never written to disk, a
 * log or the repo. Storing only a scrypt hash means a database dump does not
 * hand over the credential, and the plaintext exists only in the environment of
 * this one process for the duration of the run.
 *
 * Usage:
 *   FRIDAY_OWNER_EMAIL=you@example.com \
 *   FRIDAY_OWNER_PASSWORD='...' npx tsx src/seed-owner.ts
 *
 * Idempotent: re-running resets the password. That is the recovery path if the
 * credential is ever lost or exposed - and it also clears any lockout.
 */

const EMAIL = ownerCredentials.email;
const PASSWORD = ownerCredentials.password;

async function main(): Promise<void> {
  if (!EMAIL) throw new Error("FRIDAY_OWNER_EMAIL is required");
  if (PASSWORD.length < 12) {
    // Refuse weak credentials rather than silently installing one.
    throw new Error("FRIDAY_OWNER_PASSWORD must be at least 12 characters");
  }

  // scrypt parameters live in security.ts; reuse them so the hash is verifiable
  // by the normal login path rather than a second, divergent scheme.
  const hash = await hashPassword(PASSWORD);

  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1",
    [EMAIL],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    await query(
      `UPDATE users
          SET password_hash   = $2,
              disabled        = false,
              failed_attempts = 0,
              lock_count      = 0,
              locked_until    = NULL
        WHERE email = $1`,
      [EMAIL, hash],
    );
    console.log(`owner account reset: ${EMAIL}`);
  } else {
    await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)`,
      [EMAIL, hash, "Owner"], // F-26: no personal name in source
    );
    console.log(`owner account created: ${EMAIL}`);
  }

  // Any other account is a security liability in a single-user app: remove the
  // ability to log in rather than leaving a forgotten credential live.
  const others = await query<{ email: string }>(
    "UPDATE users SET disabled = true WHERE email <> $1 AND disabled = false RETURNING email",
    [EMAIL],
  );
  if (others.rowCount) {
    console.log(`disabled ${others.rowCount} other account(s): ${others.rows.map((r) => r.email).join(", ")}`);
  }

  const total = await query<{ n: string }>("SELECT count(*)::text AS n FROM users");
  console.log(`users in database: ${total.rows[0]?.n}`);

  await closePool();
}

main().catch(async (err) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  await closePool().catch(() => {});
  process.exit(1);
});
