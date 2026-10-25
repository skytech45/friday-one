-- Migration 0002: single-use pairing codes for connector enrollment
-- (SYSTEM_DESIGN §7). Codes are stored HASHED, expire fast, and are marked
-- used atomically at redemption. Client policy: none (deny-all) — only the
-- control plane's service role touches this table.

create table public.pairing_codes (
  id          uuid primary key default gen_random_uuid(),
  server_id   uuid not null references public.servers (id) on delete cascade,
  code_hash   text not null unique, -- sha-256(code) hex; the code itself is never stored
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index pairing_codes_expiry_idx on public.pairing_codes (expires_at) where used_at is null;

alter table public.pairing_codes enable row level security;
-- No policies: clients never read or write pairing codes.
