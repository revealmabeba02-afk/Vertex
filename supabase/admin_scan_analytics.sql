-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again.)
--
-- Backfilled into the repo — this function was already live in Supabase
-- (applied directly in an earlier session) but the .sql file defining it
-- was never committed. Powers the admin Analytics panel: scans per day
-- (last 14 days), top 10 scanned pairs (last 30 days), and scans by hour
-- of day (last 30 days). Same admin-only check as every other admin_*
-- function. See GET /api/admin/analytics in server/server.js.

create or replace function public.admin_scan_analytics()
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_per_day json;
  v_top_pairs json;
  v_by_hour json;
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_per_day
  from (
    select to_char(d::date, 'YYYY-MM-DD') as day, count(sh.id) as scans
    from generate_series(current_date - interval '13 days', current_date, interval '1 day') d
    left join public.scan_history sh on sh.created_at::date = d::date
    group by d
    order by d
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_top_pairs
  from (
    select pair, count(*) as scans
    from public.scan_history
    where pair is not null and created_at > now() - interval '30 days'
    group by pair
    order by count(*) desc
    limit 10
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_by_hour
  from (
    select extract(hour from created_at)::int as hour, count(*) as scans
    from public.scan_history
    where created_at > now() - interval '30 days'
    group by hour
    order by hour
  ) t;

  return json_build_object(
    'per_day', v_per_day,
    'top_pairs', v_top_pairs,
    'by_hour', v_by_hour
  );
end;
$function$;

revoke all on function public.admin_scan_analytics() from public;
grant execute on function public.admin_scan_analytics() to authenticated;
