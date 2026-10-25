-- Migration 0003 (plan v2.0 §7): explicit enrollments entity with the
-- pairing state machine:
--   created -> pending_connector -> claim_requested -> paired -> online
--   terminal: expired, cancelled, rejected, revoked, error
--
-- Security properties encoded here (mandatory per plan §4):
--   - enrollment_token: CSPRNG, stored HASHED, 30 min, authorizes the
--     connector's enrollment session only (never shell access)
--   - display_code_hash: 16-20 digit one-time code shown on the terminal,
--     10 min expiry, max 5 claim attempts, hashed at rest
--   - credential_pickup: the connector credential plaintext is written by
--     the claim (server-side) and readable EXACTLY ONCE by the connector's
--     enrollment session; pickup clears it
--   - atomic state transitions only via UPDATE ... WHERE state = <expected>

create table public.enrollments (
  id                   uuid primary key default gen_random_uuid(),
  server_id            uuid not null references public.servers (id) on delete cascade,
  owner_id             uuid not null references auth.users (id) on delete cascade,
  state                text not null default 'created'
                       check (state in ('created','pending_connector','claim_requested',
                                        'paired','online','expired','cancelled',
                                        'rejected','revoked','error')),
  -- enrollment session token (connector side); hash only
  enrollment_token_hash text unique,
  token_expires_at     timestamptz,
  -- one-time numeric code displayed by the connector; hash only
  display_code_hash    text,
  display_code_expires_at timestamptz,
  claim_attempts       integer not null default 0,
  -- server-written, connector-readable-once credential handoff
  credential_pickup    text,
  credential_picked_up_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index enrollments_server_idx on public.enrollments (server_id);
create index enrollments_owner_idx on public.enrollments (owner_id, created_at desc);

alter table public.enrollments enable row level security;
-- No client policies: the control plane (service role) drives the state
-- machine; clients act through /api/v1/enrollments/* with JWT + ownership
-- checks server-side.
