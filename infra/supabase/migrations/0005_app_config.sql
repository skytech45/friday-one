-- Migration 0005: runtime app configuration (non-secret).
-- The gateway quick-tunnel URL changes on every gateway restart; the tunnel
-- service upserts the current URL here and clients discover it via
-- GET /api/v1/config. Public read — a URL is not a secret.

create table public.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

create policy app_config_public_read on public.app_config
  for select using (true);
-- Writes: service role only (no client write policy).
