-- RLS smoke test for 0001_init.sql — runs against ANY stock Postgres.
-- Stubs Supabase's auth schema (auth.users + auth.uid()) so the migration can
-- be exercised in CI and locally before a Supabase project exists.
--
-- Verifies the adversarial cases SYSTEM_DESIGN §14 demands:
--   * cross-user access (IDOR): user B cannot read user A's servers/agents/
--     sessions/messages/jobs
--   * ID substitution: setting a forged sub claim for rows you don't own
--   * deny-by-default: connector_credentials has NO client policy at all
--
-- Usage: psql -v ON_ERROR_STOP=1 -f 0001_init.sql -f rls-test.sql (scratch db)

\set ON_ERROR_STOP on

-- ---- Supabase stand-ins ------------------------------------------------------
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

-- ---- fixtures (as service role) ---------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');

insert into public.servers (id, owner_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A-server'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'B-server');

insert into public.agents (id, server_id, adapter) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'hermes');

insert into public.agent_sessions (id, agent_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001');

insert into public.chat_messages (session_id, role, content, seq) values
  ('cccccccc-0000-0000-0000-000000000001', 'user', 'hello', 1);

insert into public.command_jobs (server_id, idempotency_key, operation) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'key-1', 'session.chat');

insert into public.connector_credentials (server_id, credential_hash) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'deadbeef');

-- ---- helper ------------------------------------------------------------------
create or replace function public.test_expect_rows(query text, expected bigint, label text)
returns void language plpgsql as $$
declare n bigint;
begin
  execute query into n;
  if n is distinct from expected then
    raise exception 'RLS FAIL: % — expected % rows, got %', label, expected, n;
  end if;
  raise notice 'RLS PASS: % (% rows)', label, n;
end $$;

-- ---- the role a Supabase client actually runs as ----------------------------
do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

-- ---- A sees own data ---------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select public.test_expect_rows(
  'select count(*) from public.servers', 1, 'A sees exactly own server');
select public.test_expect_rows(
  'select count(*) from public.agents', 1, 'A sees agent via server chain');
select public.test_expect_rows(
  'select count(*) from public.agent_sessions', 1, 'A sees session via agent chain');
select public.test_expect_rows(
  'select count(*) from public.chat_messages', 1, 'A sees chat message via session chain');
select public.test_expect_rows(
  'select count(*) from public.command_jobs', 1, 'A sees own command job');
select public.test_expect_rows(
  'select count(*) from public.connector_credentials', 0,
  'credentials are INVISIBLE to clients (no policy = deny-all)');

-- ---- B must not see ANY of A's data (cross-user / IDOR) ----------------------
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select public.test_expect_rows(
  'select count(*) from public.servers', 1, 'B sees only own server (no IDOR)');
select public.test_expect_rows(
  'select count(*) from public.agents', 0, 'B sees none of A''s agents');
select public.test_expect_rows(
  'select count(*) from public.agent_sessions', 0, 'B sees none of A''s sessions');
select public.test_expect_rows(
  'select count(*) from public.chat_messages', 0, 'B sees none of A''s messages');
select public.test_expect_rows(
  'select count(*) from public.command_jobs', 0, 'B sees none of A''s jobs');

-- ---- forged claim with an unknown sub sees nothing --------------------------
set request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
select public.test_expect_rows(
  'select count(*) from public.servers', 0, 'unknown sub sees nothing');

reset role;
reset request.jwt.claim.sub;
-- Cleanup is the caller's job: drop the scratch database when done.
