-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Why this exists at all:
--
-- Every admin_* function in this folder checks the caller's own email
-- (auth.jwt() ->> 'email'), which means only a logged-in owner can call them.
-- That is the right default. But it also means an agent cannot read revenue at
-- 3am — and an agent that can only tell you the site is up, while the actual
-- question is "are we earning", is a monitoring tool pretending to be a partner.
--
-- The usual fix is to put the service_role key on the server. That key bypasses
-- every row-level-security rule in the database — one process would be able to
-- read, edit and delete every user, order and credit. Too much power for a
-- summary.
--
-- So this is a single, narrow function instead:
--   * it takes one shared secret (the server holds it, nobody else does),
--   * it returns a read-only summary of the same numbers the dashboard shows,
--   * it cannot read a user row, a password, an email, or a bank detail,
--   * with a wrong or missing secret it raises an error instead of answering.
--
-- Replace PASTE_SECRET_HERE with the value given to you before running this.

create table if not exists public.agent_config (
  id integer primary key check (id = 1),
  money_secret text not null,
  admin_email text not null
);

-- Row-level security with no policies: the table is unreachable through the
-- API even with the anon key. Only the function below (which runs as the table
-- owner) can read it.
alter table public.agent_config enable row level security;
revoke all on public.agent_config from anon, authenticated;

insert into public.agent_config (id, money_secret, admin_email)
values (1, 'PASTE_SECRET_HERE', 'revealmabeba02@gmail.com')
on conflict (id) do update
  set money_secret = excluded.money_secret,
      admin_email = excluded.admin_email;

create or replace function public.agent_money(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cfg public.agent_config%rowtype;
  v_users integer;
  v_paying integer;
  v_paid jsonb;
  v_analytics json;
  v_months jsonb;
  v_pending jsonb;
  v_days jsonb;
begin
  select * into cfg from public.agent_config where id = 1;
  if cfg.id is null then
    raise exception 'agent_money is not configured' using errcode = '42501';
  end if;
  if p_secret is null or length(p_secret) < 24 or p_secret is distinct from cfg.money_secret then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- The admin_* readers only look at the JWT email claim, and that claim is read
  -- from this setting. Set it for this transaction only, then clear it, so the
  -- same connection cannot be reused to impersonate the owner afterwards.
  perform set_config(
    'request.jwt.claims',
    json_build_object('email', cfg.admin_email, 'role', 'authenticated')::text,
    true
  );

  -- Each reader is wrapped: a migration that was never run must degrade one
  -- number, not blank the whole summary.
  begin
    select public.admin_user_count() into v_users;
  exception when others then v_users := null;
  end;

  begin
    select public.admin_paying_users_count() into v_paying;
  exception when others then v_paying := null;
  end;

  begin
    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_paid from public.admin_paid_summary() t;
  exception when others then v_paid := '[]'::jsonb;
  end;

  begin
    select public.admin_scan_analytics() into v_analytics;
  exception when others then v_analytics := null;
  end;

  begin
    select public.admin_month_comparison() into v_months;
  exception when others then v_months := null;
  end;

  begin
    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_pending from public.admin_list_pending_orders() t;
  exception when others then v_pending := '[]'::jsonb;
  end;

  begin
    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_days from public.admin_purchase_day_pattern() t;
  exception when others then v_days := '[]'::jsonb;
  end;

  perform set_config('request.jwt.claims', '', true);

  return jsonb_build_object(
    'at', now(),
    'users', v_users,
    'paying', v_paying,
    'paid', v_paid,
    'analytics', v_analytics,
    'months', v_months,
    'pending', v_pending,
    'days', v_days
  );
end;
$$;

revoke all on function public.agent_money(text) from public;
grant execute on function public.agent_money(text) to anon, authenticated;

-- To rotate the secret later, re-run just this line with a new value:
-- update public.agent_config set money_secret = 'new-secret' where id = 1;
