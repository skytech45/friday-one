-- Rollback for 0001_init.sql. Drops in reverse dependency order.
-- Run ONLY if a Phase 1 migration must be unwound before go-live.

drop policy if exists audit_events_owner_read on public.audit_events;
drop policy if exists command_jobs_owner_read on public.command_jobs;
drop policy if exists permission_requests_owner_read on public.permission_requests;
drop policy if exists policies_owner on public.permission_policies;
drop policy if exists chat_messages_owner on public.chat_messages;
drop policy if exists agent_sessions_owner on public.agent_sessions;
drop policy if exists projects_owner on public.projects;
drop policy if exists agents_owner on public.agents;
drop policy if exists servers_owner_all on public.servers;
drop policy if exists profiles_self_update on public.profiles;
drop policy if exists profiles_self_select on public.profiles;

drop table if exists public.audit_events;
drop table if exists public.command_jobs;
drop table if exists public.permission_requests;
drop table if exists public.permission_policies;
drop table if exists public.chat_messages;
drop table if exists public.agent_sessions;
drop table if exists public.projects;
drop table if exists public.agents;
drop table if exists public.connector_credentials;
drop table if exists public.servers;
drop table if exists public.profiles;

drop function if exists public.handle_new_user();
drop trigger if exists on_auth_user_created on auth.users;
