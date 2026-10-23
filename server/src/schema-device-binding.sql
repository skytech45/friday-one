-- Device binding + login lockout.
--
-- Applied idempotently: migrate.ts runs schema.sql on every boot, so these must
-- be safe to re-run. All ADD COLUMN ... IF NOT EXISTS.

-- ----------------------------------------------------------------- login guard
-- Persisted rather than in-memory so a process restart cannot reset an
-- attacker's attempt counter.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_count      integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until    timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at   timestamptz;

-- -------------------------------------------------------------- device binding
-- The device's hardware-backed public key (X.509, Base64). Captured once at
-- registration. This is the row that makes a copied APK useless: the clone has
-- a different Keystore key, so its signatures do not verify against this value.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS public_key text;

-- SHA-256 of the public key. Convenient unique-ish identifier for auditing and
-- for spotting the same hardware key appearing under two accounts.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS public_key_id text;

-- What the phone reported about its own key: STRONGBOX | TEE | SOFTWARE.
-- Reported context only - a patched client can lie about this. The value that
-- cannot be faked is whether a signature verifies against public_key.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS key_security_level text;

-- Emulator/integrity verdict string, for audit. Also client-reported.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS integrity_verdict text;

-- Distinguishes "this device's key is missing" from "this device is revoked",
-- so the client can be told to re-register rather than to give up.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS key_bound_at timestamptz;

-- A public key may only ever belong to one device row. Prevents a replayed
-- registration from cloning a binding onto a second device.
CREATE UNIQUE INDEX IF NOT EXISTS devices_public_key_id_uniq
  ON devices (public_key_id)
  WHERE public_key_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_locked_until_idx
  ON users (locked_until)
  WHERE locked_until IS NOT NULL;
