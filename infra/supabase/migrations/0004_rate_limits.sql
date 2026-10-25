-- Migration 0004: shared rate-limit store for pairing endpoints (P0 fix).
--
-- Why Postgres: the control plane is Vercel serverless — in-memory counters
-- are per-instance and evaporate on every cold start, which is exactly the
-- replay/brute-force surface we are closing. Supabase Postgres is the shared,
-- already-deployed durable store, so the fixed-window counter lives here and
-- is consumed through an atomic RPC (race-safe under concurrent requests and
-- shared across all instances).
--
-- Buckets are keyed by "<endpoint>:<identity>" and use a fixed window.

create table public.rate_limit_hits (
  bucket_key   text primary key,
  window_start timestamptz not null,
  count        integer not null
);

alter table public.rate_limit_hits enable row level security;
-- No client policies: only the control plane (service role) touches this.

create or replace function public.consume_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_max integer
)
returns table (allowed boolean, retry_after_s integer)
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_window_start timestamptz;
begin
  -- Atomic fixed-window consume. A window older than p_window_seconds resets;
  -- otherwise the count increments. Row lock via ON CONFLICT makes concurrent
  -- callers serialize on the bucket.
  insert into public.rate_limit_hits (bucket_key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (bucket_key) do update
    set count = case
          when public.rate_limit_hits.window_start
                < v_now - make_interval(secs => p_window_seconds)
          then 1
          else public.rate_limit_hits.count + 1
        end,
        window_start = case
          when public.rate_limit_hits.window_start
                < v_now - make_interval(secs => p_window_seconds)
          then v_now
          else public.rate_limit_hits.window_start
        end
  returning public.rate_limit_hits.count, public.rate_limit_hits.window_start
  into v_count, v_window_start;

  -- Opportunistic cleanup (~5% of calls) so abandoned buckets do not accumulate.
  if random() < 0.05 then
    delete from public.rate_limit_hits
     where window_start < v_now - interval '2 days';
  end if;

  if v_count > p_max then
    return query select
      false,
      greatest(1, ceil(extract(epoch from
        (v_window_start + make_interval(secs => p_window_seconds) - v_now)))::integer);
  end if;
  return query select true, 0;
end $$;

-- Hardening: only the service role may consume limits.
revoke execute on function public.consume_rate_limit(text, integer, integer) from anon, authenticated;
