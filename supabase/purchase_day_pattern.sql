-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again.)
--
-- Which day of the week people actually buy credits on. Read-only report
-- off existing credit_orders data (no new table) — groups paid orders by
-- weekday so the admin page can show "Wednesdays are your best day" once
-- there's enough history to say anything meaningful.
create or replace function public.admin_purchase_day_pattern()
returns table (
  dow int,            -- 0 = Sunday .. 6 = Saturday (matches JS Date.getDay())
  order_count bigint,
  revenue_usd numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  return query
    select
      extract(dow from paid_at)::int as dow,
      count(*)::bigint as order_count,
      coalesce(sum(amount_usd), 0)::numeric as revenue_usd
    from public.credit_orders
    where status = 'paid' and paid_at is not null
    group by 1
    order by 1;
end;
$$;
revoke all on function public.admin_purchase_day_pattern() from public;
grant execute on function public.admin_purchase_day_pattern() to authenticated;
