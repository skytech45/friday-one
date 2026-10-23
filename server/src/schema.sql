-- FRIDAY One schema.
--
-- Security model: every row that belongs to a user carries user_id, and every
-- query filters by the authenticated subject. There is no "admin" role that
-- bypasses this -- elevated actions are explicit, audited endpoints.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled      boolean NOT NULL DEFAULT false
);

-- A device is bound to a user by a hardware fingerprint computed on the phone
-- (ANDROID_ID + Build fields + keystore-backed install id). A new fingerprint
-- is untrusted until the user approves it, which is what stops a stolen
-- password from silently logging in on an unknown handset.
CREATE TABLE IF NOT EXISTS devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  name        text,
  platform    text,
  app_version text,
  trusted     boolean NOT NULL DEFAULT false,
  revoked     boolean NOT NULL DEFAULT false,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

-- Refresh tokens are stored hashed: a database leak must not yield usable
-- session tokens.
CREATE TABLE IF NOT EXISTS sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid REFERENCES devices(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked    boolean NOT NULL DEFAULT false,
  ip         text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path        text NOT NULL,
  name        text NOT NULL,
  size        bigint NOT NULL DEFAULT 0,
  mime        text,
  sha256      text,
  storage_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);

CREATE INDEX IF NOT EXISTS files_user_idx ON files(user_id);

CREATE TABLE IF NOT EXISTS crash_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  fingerprint text,
  app_version text,
  build_type  text,
  severity    text NOT NULL DEFAULT 'error',
  message     text NOT NULL,
  stack_trace text,
  context     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed    boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS crash_created_idx ON crash_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  device_id  uuid,
  action     text NOT NULL,
  ip         text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);
