-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql to already be set up (uses the same
-- credit_balances table as the fallback once free scans run out).
--
-- Gives every signed-in user 4 free scans a day, resetting at midnight UTC.
-- Once those are used, scanning falls back to paid credit balance exactly
-- as before. Free scans never touch credit_balances, so they can't be
-- "spent" by buying more — they're just a daily allowance on top.

create table if not exists public.free_scan_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  scan_date date not null default current_date,
  count integer not null default 0,
  primary key (user_id, scan_date)
);

alter table public.free_scan_log enable row level security;
-- No policies granted to authenticated/anon on purpose — this table is only
-- ever touched through the security-definer functions below, never direct
-- REST access, so RLS being on with no policies is the safe default (deny
-- all direct access).

-- Spends one scan for the signed-in user: today's free allowance first (4 a
-- day), then falls back to their paid credit balance. Raises an exception
-- (caught server-side, same as the old spend_credit) only when both are
-- exhausted, so there's never a way to scan into a negative balance even
-- with two requests at once — Postgres serializes the row locks here.
create or replace function public.use_scan()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free_count integer;
  v_balance integer;
  v_free_limit constant integer := 4;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.free_scan_log (user_id, scan_date, count)
  values (auth.uid(), current_date, 0)
  on conflict (user_id, scan_date) do nothing;

  select count into v_free_count
  from public.free_scan_log
  where user_id = auth.uid() and scan_date = current_date
  for update;

  if v_free_count < v_free_limit then
    update public.free_scan_log
      set count = count + 1
      where user_id = auth.uid() and scan_date = current_date;
    return jsonb_build_object('source', 'free', 'free_remaining', v_free_limit - v_free_count - 1);
  end if;

  -- Free scans used up for today — fall back to paid credits, same logic
  -- spend_credit() used to do on its own.
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

  return jsonb_build_object('source', 'paid', 'balance', v_balance - 1);
end;
$$;
revoke all on function public.use_scan() from public;
grant execute on function public.use_scan() to authenticated;

-- Undoes whatever use_scan() did, for a scan that was charged but then
-- failed (provider error) — so a failed scan never costs the user a free
-- scan or a paid credit. p_source is whatever use_scan() returned.
create or replace function public.refund_scan(p_source text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_source = 'free' then
    update public.free_scan_log
      set count = greatest(count - 1, 0)
      where user_id = auth.uid() and scan_date = current_date;
  else
    insert into public.credit_balances (user_id, balance)
    values (auth.uid(), 0)
    on conflict (user_id) do nothing;

    update public.credit_balances
      set balance = balance + 1, updated_at = now()
      where user_id = auth.uid();
  end if;
end;
$$;
revoke all on function public.refund_scan(text) from public;
grant execute on function public.refund_scan(text) to authenticated;

-- How many free scans the signed-in user has left today, for the credits
-- page to display (resets at midnight UTC, same logic as use_scan()).
create or replace function public.free_scans_remaining()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free_count integer;
  v_free_limit constant integer := 4;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select count into v_free_count
  from public.free_scan_log
  where user_id = auth.uid() and scan_date = current_date;

  return v_free_limit - coalesce(v_free_count, 0);
end;
$$;
revoke all on function public.free_scans_remaining() from public;
grant execute on function public.free_scans_remaining() to authenticated;
