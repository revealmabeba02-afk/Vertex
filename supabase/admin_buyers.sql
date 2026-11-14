-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql (creates credit_orders) and
-- supabase/whop_setup.sql (adds the source column) to have been run first.
--
-- Admin-only list of people who actually paid: every credit_orders row with
-- status 'paid', newest first, joined to the account email so the admin page
-- can show "who bought what". Covers both payment routes because both write
-- to the same table: Whop webhooks (source 'whop') and orders marked paid by
-- hand on the admin page (source 'binance' by default).
--
-- Guard is the same hardcoded admin-email check used by the other admin
-- functions in supabase/admin_setup.sql.

create or replace function public.admin_list_buyers(p_limit integer default 200)
returns table (
  email text,
  full_name text,
  bundle text,
  scans integer,
  amount_usd numeric,
  source text,
  paid_at timestamptz
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
      u.email::text,
      coalesce(u.raw_user_meta_data ->> 'full_name', '')::text,
      o.bundle,
      o.scans,
      o.amount_usd,
      coalesce(o.source, 'binance')::text,
      coalesce(o.paid_at, o.created_at)
    from public.credit_orders o
    join auth.users u on u.id = o.user_id
    where o.status = 'paid'
    order by coalesce(o.paid_at, o.created_at) desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

revoke all on function public.admin_list_buyers(integer) from public;
grant execute on function public.admin_list_buyers(integer) to authenticated;
