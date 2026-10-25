-- FRIDAY One — Phase 1 schema (SYSTEM_DESIGN.md §10), migration 0001.
--
-- Target: Supabase Postgres. Identity comes from Supabase Auth: every
-- user-owned table ultimately hangs off auth.users(id) via owner_id or a
-- chain of foreign keys, and Row Level Security is enabled on EVERY
-- user-reachable table. The control plane ALSO re-checks ownership server-side
-- (PROMPT.md Phase 2: never trust client-supplied owner_id) — RLS is defense
-- in depth for direct client access, not the only authorization layer.
--
-- Conventions: uuid PKs (gen_random_uuid), timestamptz everywhere, explicit
-- FK on delete behaviour, bounded enums via CHECK (add values by migration
-- only), indexes for every owner/parent scan, and no reusable plaintext
-- connector secrets anywhere (connector_credentials stores a hash only).
--
-- Apply order: 0001_init.sql first. Rollback: see 0001_rollback.sql.

-- ---------------------------------------------------------------------------
-- extensions & helpers
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto; -- gen_random_uuid on stock postgres

-- updated_at maintenance (Supabase ships moddatetime; guard anyway)
create extension if not exists moddatetime;

-- ---------------------------------------------------------------------------
-- profiles — 1:1 extension of auth.users (§10)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Auto-create a profile on signup. Replace the DO block body if the project
-- later moves to trigger-free onboarding via the control plane.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', null));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- servers — an enrolled machine (§10). The connector identity is created at
-- pairing time; see connector_credentials.
-- ---------------------------------------------------------------------------
create table public.servers (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 120),
  -- client-supplied display label ONLY: never used for auth or routing
  host_label       text check (char_length(host_label) <= 120),
  enrollment_state text not null default 'pending'
                   check (enrollment_state in ('pending', 'active', 'revoked')),
  connector_id     uuid, -- set when a credential is redeemed; FK added below
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index servers_owner_idx on public.servers (owner_id);

-- ---------------------------------------------------------------------------
-- connector_credentials — NOT reusable plaintext (§4, §10). The connector
-- redeems a pairing code and receives a bearer credential; only its hash is
-- stored. One ACTIVE credential per server (unique server_id); rotation
-- supersedes via rotated_from; revocation is explicit and immediate.
-- ---------------------------------------------------------------------------
create table public.connector_credentials (
  id             uuid primary key default gen_random_uuid(),
  server_id      uuid not null references public.servers (id) on delete cascade,
  credential_hash text not null unique, -- sha-256(credential) hex
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  rotated_from   uuid references public.connector_credentials (id)
);

create index connector_credentials_server_idx on public.connector_credentials (server_id);

alter table public.servers
  add constraint servers_connector_fk
  foreign key (connector_id) references public.connector_credentials (id) on delete set null;

-- ---------------------------------------------------------------------------
-- agents — discovered agent instances on a server, with the adapter's
-- DECLARED capabilities (§12: capabilities are verified, never assumed).
-- ---------------------------------------------------------------------------
create table public.agents (
  id              uuid primary key default gen_random_uuid(),
  server_id       uuid not null references public.servers (id) on delete cascade,
  adapter         text not null check (char_length(adapter) between 1 and 40),
  adapter_version text check (char_length(adapter_version) <= 40),
  -- e.g. {"sessions.list": true, "chat.send": true, "permissions.native": false}
  capabilities    jsonb not null default '{}'::jsonb,
  health          text not null default 'unknown'
                  check (health in ('unknown', 'healthy', 'degraded', 'unreachable')),
  discovered_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (server_id, adapter)
);

create index agents_server_idx on public.agents (server_id);

-- ---------------------------------------------------------------------------
-- projects — canonical, protected roots (§10). The connector re-derives and
-- enforces the canonical path locally; this column is the recorded intent.
-- ---------------------------------------------------------------------------
create table public.projects (
  id            uuid primary key default gen_random_uuid(),
  server_id     uuid not null references public.servers (id) on delete cascade,
  agent_id      uuid references public.agents (id) on delete cascade,
  canonical_root text not null check (char_length(canonical_root) <= 512),
  label         text check (char_length(label) <= 120),
  created_at    timestamptz not null default now(),
  unique (server_id, canonical_root)
);

create index projects_server_idx on public.projects (server_id);

-- ---------------------------------------------------------------------------
-- agent_sessions & chat_messages (§10). Chat content is bounded by the API
-- layer; large payloads stay as references on the connector.
-- ---------------------------------------------------------------------------
create table public.agent_sessions (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references public.agents (id) on delete cascade,
  project_id  uuid references public.projects (id) on delete set null,
  external_id text check (char_length(external_id) <= 256),
  status      text not null default 'active'
              check (status in ('active', 'closed', 'failed', 'unknown')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index agent_sessions_agent_idx on public.agent_sessions (agent_id);

create table public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.agent_sessions (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content    text not null, -- bounded at the API boundary (e.g. 64 KiB)
  seq        integer not null,
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);

create index chat_messages_session_idx on public.chat_messages (session_id, seq);

-- ---------------------------------------------------------------------------
-- permission_policies (§8). Scope fields are nullable on purpose: a policy
-- with fewer constraints is broader. Precedence: explicit deny > most specific
-- scope > lower priority value > newer version; the evaluation order is the
-- control plane's contract, documented in docs/ADAPTER_CONTRACT.md §policy.
-- ---------------------------------------------------------------------------
create table public.permission_policies (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  server_id        uuid references public.servers (id) on delete cascade,
  agent_id         uuid references public.agents (id) on delete cascade,
  project_id       uuid references public.projects (id) on delete cascade,
  action           text not null check (char_length(action) between 1 and 80),
  executable       text check (char_length(executable) <= 256),
  argument_pattern jsonb, -- structured constraints, never a raw shell string
  decision         text not null check (decision in ('allow', 'deny', 'require_approval')),
  priority         integer not null default 100,
  version          integer not null default 1,
  enabled          boolean not null default true,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index permission_policies_owner_idx on public.permission_policies (owner_id, enabled);
create index permission_policies_server_idx on public.permission_policies (server_id);

-- ---------------------------------------------------------------------------
-- permission_requests (§9 lifecycle). An approval binds to the exact payload
-- hash + policy version; a changed request invalidates it. Decisions are
-- authenticated users; expiry is mandatory.
-- ---------------------------------------------------------------------------
create table public.permission_requests (
  id             uuid primary key default gen_random_uuid(),
  server_id      uuid not null references public.servers (id) on delete cascade,
  connector_id   uuid,
  agent_id       uuid,
  project_id     uuid,
  session_id     uuid,
  operation      text not null check (char_length(operation) between 1 and 200),
  payload_hash   text not null check (char_length(payload_hash) <= 128),
  policy_version integer,
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'denied', 'expired',
                                   'executing', 'completed', 'failed', 'cancelled')),
  requested_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  decided_by     uuid references auth.users (id),
  decided_at     timestamptz,
  outcome        text
);

create index permission_requests_pending_idx on public.permission_requests (server_id, status);
create index permission_requests_expiry_idx on public.permission_requests (expires_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- command_jobs (§10): durable command state. Transient WSS delivery is NEVER
-- the record (§16 invariant 6). Idempotency is per server + key.
-- ---------------------------------------------------------------------------
create table public.command_jobs (
  id              uuid primary key default gen_random_uuid(),
  server_id       uuid not null references public.servers (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) <= 128),
  operation       text not null check (char_length(operation) between 1 and 200),
  state           text not null default 'queued'
                  check (state in ('queued', 'dispatched', 'accepted', 'started',
                                   'completed', 'failed', 'cancelled', 'unknown')),
  result_summary  jsonb, -- bounded summary; large output lives on the connector
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (server_id, idempotency_key)
);

create index command_jobs_server_state_idx on public.command_jobs (server_id, state);

-- ---------------------------------------------------------------------------
-- audit_events (§10): append-only, redacted at write (F-26 lesson: no owner
-- PII in detail). bigint identity — audit is append-heavy, never updated.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id             bigint generated always as identity primary key,
  actor_id       uuid references auth.users (id),
  server_id      uuid,
  action         text not null check (char_length(action) between 1 and 120),
  decision       text check (decision in ('allow', 'deny', 'require_approval', null)),
  correlation_id uuid,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index audit_events_created_idx on public.audit_events (created_at desc);
create index audit_events_actor_idx on public.audit_events (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — enabled on EVERY user-reachable table. Policies use
-- auth.uid(); nested resources gate through their parent chain.
-- ---------------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.servers              enable row level security;
alter table public.connector_credentials enable row level security;
alter table public.agents               enable row level security;
alter table public.projects             enable row level security;
alter table public.agent_sessions       enable row level security;
alter table public.chat_messages        enable row level security;
alter table public.permission_policies  enable row level security;
alter table public.permission_requests  enable row level security;
alter table public.command_jobs         enable row level security;
alter table public.audit_events         enable row level security;

-- profiles: self only
create policy profiles_self_select on public.profiles
  for select using (id = auth.uid());
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- servers: owner only. (The control plane service role bypasses RLS; the
-- connector NEVER talks to Supabase directly — it authenticates to the
-- control plane, which acts on its behalf.)
create policy servers_owner_all on public.servers
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- connector_credentials: NO client policy at all. Only the service role
-- (control plane) touches credentials. RLS with no policy = deny-all.
-- (Table is still enabled above — that is the point.)

-- agents/projects/agent_sessions/chat_messages: owner via the server chain.
create policy agents_owner on public.agents
  for all using (
    exists (select 1 from public.servers s where s.id = agents.server_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.servers s where s.id = agents.server_id and s.owner_id = auth.uid())
  );

create policy projects_owner on public.projects
  for all using (
    exists (select 1 from public.servers s where s.id = projects.server_id and s.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.servers s where s.id = projects.server_id and s.owner_id = auth.uid())
  );

create policy agent_sessions_owner on public.agent_sessions
  for all using (
    exists (
      select 1 from public.agents a join public.servers s on s.id = a.server_id
      where a.id = agent_sessions.agent_id and s.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.agents a join public.servers s on s.id = a.server_id
      where a.id = agent_sessions.agent_id and s.owner_id = auth.uid()
    )
  );

create policy chat_messages_owner on public.chat_messages
  for all using (
    exists (
      select 1
        from public.agent_sessions g
        join public.agents a on a.id = g.agent_id
        join public.servers s on s.id = a.server_id
       where g.id = chat_messages.session_id and s.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
        from public.agent_sessions g
        join public.agents a on a.id = g.agent_id
        join public.servers s on s.id = a.server_id
       where g.id = chat_messages.session_id and s.owner_id = auth.uid()
    )
  );

-- permission_policies / permission_requests / command_jobs: owner via
-- owner_id or the server chain.
create policy policies_owner on public.permission_policies
  for all using (
    owner_id = auth.uid()
    or exists (select 1 from public.servers s where s.id = permission_policies.server_id and s.owner_id = auth.uid())
  ) with check (
    owner_id = auth.uid()
  );

create policy permission_requests_owner_read on public.permission_requests
  for select using (
    exists (select 1 from public.servers s where s.id = permission_requests.server_id and s.owner_id = auth.uid())
  );
-- requests are CREATED by the control plane (connector events), not by
-- clients: no insert/update policy for anon/authenticated. Decisions flow
-- through the control plane, which records decided_by from the VERIFIED token.

create policy command_jobs_owner_read on public.command_jobs
  for select using (
    exists (select 1 from public.servers s where s.id = command_jobs.server_id and s.owner_id = auth.uid())
  );
-- command_jobs are written by the control plane only: no client write policy.

-- audit_events: read own events only; written by the control plane only.
create policy audit_events_owner_read on public.audit_events
  for select using (actor_id = auth.uid());
