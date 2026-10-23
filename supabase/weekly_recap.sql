-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — create or replace / revoke+grant make it idempotent.)
--
-- Powers the weekly trading recap email (server/server.js, the
-- /api/cron/weekly-recap route, triggered by a Render cron job). Gated by
-- the same shared secret as the Whop/Binance crediting functions in
-- credits_setup.sql (CREDIT_FULFILL_SECRET) — this is a cron job calling
-- with no user JWT, same trust boundary as those.
--
-- IMPORTANT: before running this, replace REPLACE_WITH_CREDIT_FULFILL_SECRET
-- below with the actual value of CREDIT_FULFILL_SECRET (same one already
-- hardcoded in credits_setup.sql / whop_setup.sql's functions) — left as a
-- placeholder here so the real secret isn't sitting in a fresh file.
--
-- Only returns a row for a user who actually logged at least one journal
-- trade in the last 7 days, so nobody gets a blank "you did nothing" email.

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
    left join week_scans ws on ws.user_id = pu.user_id;
end;
$$;

revoke all on function public.weekly_recap_data(text) from public, anon, authenticated;
grant execute on function public.weekly_recap_data(text) to anon, authenticated;
