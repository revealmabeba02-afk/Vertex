-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Pay-per-scan credits, built the same way as admin_setup.sql: no
-- service_role key anywhere. Two kinds of access:
--
--  1. The signed-in user's own token (RLS + functions that check auth.uid())
--     — used for checking your own balance, buying a bundle, and spending a
--     credit when you scan.
--
--  2. A small set of "system" functions that the server calls on its own
--     (no user is logged in for these — it's a background job watching for
--     payments). Those functions take a secret text parameter instead of
--     checking auth.uid(), the same way admin_user_count() checks a
--     hardcoded email. The secret lives in Render's environment as
--     CREDIT_FULFILL_SECRET and must match the value baked in below.
--
-- IMPORTANT: the secret already baked into this file (search for
-- 5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57 below) must be set as
-- CREDIT_FULFILL_SECRET in Render's environment variables, exactly as-is.
-- Treat it like a password — anyone who has it could credit themselves free
-- scans. If you ever want to rotate it, generate a new random string,
-- replace it in both places below, and update Render too.

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.credit_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.credit_balances enable row level security;

drop policy if exists "read own balance" on public.credit_balances;
create policy "read own balance" on public.credit_balances
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies for normal users — every change to a
-- balance goes through one of the SECURITY DEFINER functions below, so the
-- numbers can never be edited directly by a client.

create table if not exists public.credit_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bundle text not null,
  scans integer not null,
  amount_usd numeric(10,2) not null,
  status text not null default 'pending', -- 'pending' | 'paid' | 'expired'
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.credit_orders enable row level security;

drop policy if exists "read own orders" on public.credit_orders;
create policy "read own orders" on public.credit_orders
  for select using (auth.uid() = user_id);

-- No direct insert policy: orders are created through create_credit_order()
-- below, so the price/scans for a bundle can never be supplied by the
-- client — they come from the hardcoded table in that function.

create index if not exists credit_orders_status_idx on public.credit_orders (status, created_at);

-- ---------------------------------------------------------------------
-- User-facing functions (run as the signed-in user, via their own token)
-- ---------------------------------------------------------------------

-- Current balance, 0 if the user has never had a row created yet.
create or replace function public.my_credit_balance()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  result integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  select balance into result from public.credit_balances where user_id = auth.uid();
  return coalesce(result, 0);
end;
$$;
revoke all on function public.my_credit_balance() from public;
grant execute on function public.my_credit_balance() to authenticated;

-- Starts a new order for one of the three bundles. Price and scan count are
-- fixed here, never taken from the client, so nobody can order "150 scans
-- for $0.01" by editing a request.
create or replace function public.create_credit_order(p_bundle text)
returns public.credit_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scans integer;
  v_amount numeric(10,2);
  v_order public.credit_orders;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_bundle = 'starter' then
    v_scans := 20; v_amount := 8.99;
  elsif p_bundle = 'trader' then
    v_scans := 60; v_amount := 12.99;
  elsif p_bundle = 'pro' then
    v_scans := 150; v_amount := 19.99;
  else
    raise exception 'Unknown bundle';
  end if;

  insert into public.credit_orders (user_id, bundle, scans, amount_usd, status)
  values (auth.uid(), p_bundle, v_scans, v_amount, 'pending')
  returning * into v_order;

  return v_order;
end;
$$;
revoke all on function public.create_credit_order(text) from public;
grant execute on function public.create_credit_order(text) to authenticated;

-- Spends exactly one credit for the signed-in user. Raises an exception
-- (caught server-side) if they have none left, so there is never a way to
-- scan into a negative balance even with two requests at once — Postgres
-- serializes the update within this function call.
create or replace function public.spend_credit()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.credit_balances (user_id, balance)
  values (auth.uid(), 0)
  on conflict (user_id) do nothing;

  select balance into v_balance from public.credit_balances where user_id = auth.uid() for update;

  if v_balance is null or v_balance <= 0 then
    raise exception 'No credits left';
  end if;

  update public.credit_balances
    set balance = balance - 1, updated_at = now()
    where user_id = auth.uid();

  return v_balance - 1;
end;
$$;
revoke all on function public.spend_credit() from public;
grant execute on function public.spend_credit() to authenticated;

-- Gives one credit back. Used by the server when a scan was paid for in
-- credits but then failed (provider error), so a failed scan never costs
-- the user anything.
create or replace function public.refund_credit()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.credit_balances (user_id, balance)
  values (auth.uid(), 0)
  on conflict (user_id) do nothing;

  update public.credit_balances
    set balance = balance + 1, updated_at = now()
    where user_id = auth.uid()
  returning balance into v_balance;

  return v_balance;
end;
$$;
revoke all on function public.refund_credit() from public;
grant execute on function public.refund_credit() to authenticated;

-- ---------------------------------------------------------------------
-- System functions (called by the server itself, no logged-in user —
-- guarded by a shared secret instead of auth.uid(), same pattern as the
-- admin-email check in admin_setup.sql).
-- ---------------------------------------------------------------------

create or replace function public.list_pending_orders(p_secret text)
returns setof public.credit_orders
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_secret is distinct from '5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57' then
    raise exception 'Not authorized';
  end if;

  return query
    select * from public.credit_orders
    where status = 'pending'
      and created_at > now() - interval '48 hours'
    order by created_at asc;
end;
$$;
revoke all on function public.list_pending_orders(text) from public;
grant execute on function public.list_pending_orders(text) to anon, authenticated;

-- Marks one order paid and credits the buyer's balance. Only ever touches
-- an order that is still 'pending', so calling this twice for the same
-- order (e.g. a payment matched on two poll cycles) is harmless — the
-- second call simply finds nothing left to do.
create or replace function public.admin_credit_order(p_order_id uuid, p_secret text)
returns public.credit_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.credit_orders;
begin
  if p_secret is distinct from '5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57' then
    raise exception 'Not authorized';
  end if;

  select * into v_order from public.credit_orders where id = p_order_id and status = 'pending';
  if not found then
    raise exception 'Order not found or already processed';
  end if;

  update public.credit_orders
    set status = 'paid', paid_at = now()
    where id = p_order_id
    returning * into v_order;

  insert into public.credit_balances (user_id, balance, updated_at)
  values (v_order.user_id, v_order.scans, now())
  on conflict (user_id) do update
    set balance = public.credit_balances.balance + v_order.scans,
        updated_at = now();

  return v_order;
end;
$$;
revoke all on function public.admin_credit_order(uuid, text) from public;
grant execute on function public.admin_credit_order(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Admin-page read functions (same admin-email check as admin_setup.sql)
-- ---------------------------------------------------------------------

create or replace function public.admin_paying_users_count()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  result integer;
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  select count(distinct user_id) into result from public.credit_orders where status = 'paid';
  return coalesce(result, 0);
end;
$$;
revoke all on function public.admin_paying_users_count() from public;
grant execute on function public.admin_paying_users_count() to authenticated;

create or replace function public.admin_paid_summary()
returns table (user_id uuid, paid_usd numeric, paid_scans integer, orders_count integer)
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
      co.user_id,
      sum(co.amount_usd)::numeric as paid_usd,
      sum(co.scans)::integer as paid_scans,
      count(*)::integer as orders_count
    from public.credit_orders co
    where co.status = 'paid'
    group by co.user_id;
end;
$$;
revoke all on function public.admin_paid_summary() from public;
grant execute on function public.admin_paid_summary() to authenticated;
