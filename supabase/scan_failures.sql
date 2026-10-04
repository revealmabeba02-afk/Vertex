-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql to already be set up (uses the same
-- admin-email gate pattern).
--
-- Logs every failed scan (FXSynapse errors, rate limits, bad symbols, etc.)
-- so the admin AI Briefing can tell King how many scans failed recently and
-- why, instead of him only finding out from Render logs.

create table if not exists public.scan_failures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  pair text,
  timeframe text,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.scan_failures enable row level security;

-- Any signed-in user can log their own failed scan (same pattern as
-- scan_history) — never anyone else's, and never read by non-admins.
drop policy if exists "insert own scan failures" on public.scan_failures;
create policy "insert own scan failures"
  on public.scan_failures for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Summarizes failures from the last `p_hours` hours (default 48) for the
-- admin AI Briefing: a total count plus the most common reasons, so the
-- briefing can say something like "3 scans failed today — FXSynapse rate
-- limit" instead of just a number.
create or replace function public.admin_scan_failure_summary(p_hours integer default 48)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_reasons jsonb;
begin
  if auth.jwt() ->> 'email' is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  select count(*) into v_total
  from public.scan_failures
  where created_at > now() - make_interval(hours => p_hours);

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_reasons
  from (
    select reason, count(*) as count
    from public.scan_failures
    where created_at > now() - make_interval(hours => p_hours)
      and reason is not null
    group by reason
    order by count(*) desc
    limit 5
  ) t;

  return jsonb_build_object('total', v_total, 'hours', p_hours, 'top_reasons', v_reasons);
end;
$$;
revoke all on function public.admin_scan_failure_summary(integer) from public;
grant execute on function public.admin_scan_failure_summary(integer) to authenticated;
