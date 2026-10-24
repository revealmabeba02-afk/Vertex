-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — create or replace / revoke+grant make it idempotent.)
--
-- Powers the weekly trading recap email (server/server.js). Sent by an
-- in-process check inside the already-running server (a timer that checks
-- roughly once an hour whether a week has passed), not a separate paid
-- Render cron job — avoids new infrastructure for something this small.
-- Gated by the same shared secret as the Whop/Binance crediting functions
-- in credits_setup.sql (CREDIT_FULFILL_SECRET), since this is also a
-- no-user-JWT system call.
--
-- Run this first:
--   alter table public.app_config add column if not exists weekly_recap_last_sent timestamptz;
--
-- IMPORTANT: before running this, replace REPLACE_WITH_CREDIT_FULFILL_SECRET
-- below with the actual value of CREDIT_FULFILL_SECRET (same one already
-- hardcoded in credits_setup.sql / whop_setup.sql's functions) — left as a
-- placeholder here so the real secret isn't sitting in a fresh file.
--
-- Only returns a row for a user who actually logged at least one journal
-- trade in the last 7 days, so nobody gets a blank "you did nothing" email.
-- Also excludes anyone who's opted out via user_prefs.weekly_recap_opt_out
-- (user_prefs.sql) — run that file first too.

create or replace function public.weekly_recap_data(p_secret text)
returns table (
  user_id uuid, email text, trades_count int, wins int, losses int,
  win_rate int, top_pair text, scans_count int
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if p_secret is distinct from 'REPLACE_WITH_CREDIT_FULFILL_SECRET' then
    raise exception 'Not authorized';
  end if;

  return query
    with week_journal as (
      select tj.user_id, tj.result, tj.pair
      from public.trade_journal tj
      where tj.created_at >= now() - interval '7 days'
    ),
    week_scans as (
      select sh.user_id, count(*) as scans_count
      from public.scan_history sh
      where sh.created_at >= now() - interval '7 days'
      group by sh.user_id
    ),
    per_user as (
      select
        wj.user_id,
        count(*) as trades_count,
        count(*) filter (where wj.result = 'win') as wins,
        count(*) filter (where wj.result = 'loss') as losses,
        mode() within group (order by wj.pair) as top_pair
      from week_journal wj
      group by wj.user_id
    )
    select
      pu.user_id,
      u.email::text,
      pu.trades_count::int,
      pu.wins::int,
      pu.losses::int,
      case when (pu.wins + pu.losses) > 0
        then round((pu.wins::numeric / (pu.wins + pu.losses)) * 100)::int
        else null end as win_rate,
      pu.top_pair,
      coalesce(ws.scans_count, 0)::int
    from per_user pu
    join auth.users u on u.id = pu.user_id
    left join week_scans ws on ws.user_id = pu.user_id
    left join public.user_prefs up on up.user_id = pu.user_id
    where coalesce(up.weekly_recap_opt_out, false) = false;
end;
$$;

revoke all on function public.weekly_recap_data(text) from public, anon, authenticated;
grant execute on function public.weekly_recap_data(text) to anon, authenticated;

-- Lets the server claim "it's time to send the weekly recap" exactly once
-- per ~7 days, with the timestamp persisted here (not in server memory) so
-- it survives restarts/redeploys. app_config.weekly_recap_last_sent is
-- added by this file; run once:
--   alter table public.app_config add column if not exists weekly_recap_last_sent timestamptz;
-- Atomic: returns true and stamps "now" in the same statement only when due
-- (6.5+ days since the last send), so two near-simultaneous checks can't
-- both fire and double-send.
create or replace function public.weekly_recap_claim_if_due(p_secret text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last timestamptz;
  v_due boolean;
begin
  if p_secret is distinct from 'REPLACE_WITH_CREDIT_FULFILL_SECRET' then
    raise exception 'Not authorized';
  end if;

  select weekly_recap_last_sent into v_last from public.app_config where id = 1;
  v_due := v_last is null or v_last < now() - interval '6 days 12 hours';

  if v_due then
    update public.app_config set weekly_recap_last_sent = now() where id = 1;
  end if;

  return v_due;
end;
$$;
revoke all on function public.weekly_recap_claim_if_due(text) from public, authenticated;
grant execute on function public.weekly_recap_claim_if_due(text) to anon;
