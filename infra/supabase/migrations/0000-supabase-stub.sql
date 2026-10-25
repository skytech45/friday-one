-- Local/CI stand-in for Supabase's auth schema. ONLY for testing the
-- migration on stock Postgres — never run this against a real Supabase
-- project (it would shadow the real auth schema).
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
