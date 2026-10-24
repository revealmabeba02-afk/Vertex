-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again.)
--
-- This-month-vs-last-month revenue and signups, for a quick growth-trend
-- glance on the admin Stats panel. Read-only report off existing
-- credit_orders/auth.users data (no new table), same admin-only check as
-- every other admin_* function.

create or replace function public.admin_month_comparison()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_this_revenue numeric;
  v_last_revenue numeric;
  v_this_orders int;
  v_last_orders int;
  v_this_signups int;
  v_last_signups int;
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  select coalesce(sum(amount_usd), 0), count(*) into v_this_revenue, v_this_orders
    from public.credit_orders
    where status = 'paid' and paid_at >= date_trunc('month', now());

  select coalesce(sum(amount_usd), 0), count(*) into v_last_revenue, v_last_orders
    from public.credit_orders
    where status = 'paid'
      and paid_at >= date_trunc('month', now()) - interval '1 month'
      and paid_at < date_trunc('month', now());

  select count(*) into v_this_signups from auth.users where created_at >= date_trunc('month', now());
  select count(*) into v_last_signups from auth.users
    where created_at >= date_trunc('month', now()) - interval '1 month'
      and created_at < date_trunc('month', now());

  return jsonb_build_object(
    'this_month', jsonb_build_object('revenue_usd', v_this_revenue, 'orders', v_this_orders, 'signups', v_this_signups),
    'last_month', jsonb_build_object('revenue_usd', v_last_revenue, 'orders', v_last_orders, 'signups', v_last_signups)
  );
end;
$$;
revoke all on function public.admin_month_comparison() from public;
grant execute on function public.admin_month_comparison() to authenticated;
