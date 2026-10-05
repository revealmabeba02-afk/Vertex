-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql to already be set up (same auth.users
-- table, same SECURITY DEFINER pattern as everything else).
--
-- Economic news signals (NFP, CPI, FOMC, etc.). Small/medium-importance
-- events are free and unlimited (forecast, previous AND actual, always).
-- Big ("High" importance) events are free to see on the calendar (time,
-- forecast, previous) but the actual-vs-forecast bias signal, once the
-- event has released, is limited to 2 unlocks per calendar month until a
-- paid tier exists. Unlocking the SAME event twice never costs a second
-- unlock — it's tracked per distinct event, not per view.

create table if not exists public.news_signal_unlocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, event_key)
);

alter table public.news_signal_unlocks enable row level security;
-- No policies on purpose — only touched through the functions below
-- (SECURITY DEFINER), never direct REST access. RLS with no policy is
-- deny-all, which is what we want here.

-- Unlocks one big-event signal for the signed-in user, or confirms it was
-- already unlocked this month (free re-views of the same event). Returns
-- {unlocked: true, already: bool, remaining: int} or {unlocked: false,
-- remaining: 0} once the monthly free allowance (2) is used up.
create or replace function public.can_unlock_news_signal(p_event_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date := date_trunc('month', now());
  v_count integer;
  v_free_limit constant integer := 2;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Already unlocked this event (any time) — free to view again, no charge.
  if exists (
    select 1 from public.news_signal_unlocks
    where user_id = auth.uid() and event_key = p_event_key
  ) then
    select count(*) into v_count
      from public.news_signal_unlocks
      where user_id = auth.uid() and unlocked_at >= v_month_start;
    return jsonb_build_object('unlocked', true, 'already', true, 'remaining', greatest(v_free_limit - v_count, 0));
  end if;

  select count(*) into v_count
    from public.news_signal_unlocks
    where user_id = auth.uid() and unlocked_at >= v_month_start;

  if v_count >= v_free_limit then
    return jsonb_build_object('unlocked', false, 'already', false, 'remaining', 0);
  end if;

  insert into public.news_signal_unlocks (user_id, event_key) values (auth.uid(), p_event_key);
  return jsonb_build_object('unlocked', true, 'already', false, 'remaining', v_free_limit - v_count - 1);
end;
$$;
revoke all on function public.can_unlock_news_signal(text) from public;
grant execute on function public.can_unlock_news_signal(text) to authenticated;

-- How many free big-event unlocks the signed-in user has left this month,
-- for the News tab to display up front (resets on the 1st, UTC).
create or replace function public.news_signals_remaining()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date := date_trunc('month', now());
  v_count integer;
  v_free_limit constant integer := 2;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select count(*) into v_count
    from public.news_signal_unlocks
    where user_id = auth.uid() and unlocked_at >= v_month_start;

  return greatest(v_free_limit - v_count, 0);
end;
$$;
revoke all on function public.news_signals_remaining() from public;
grant execute on function public.news_signals_remaining() to authenticated;
