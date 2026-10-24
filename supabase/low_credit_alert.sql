-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / create or replace make it idempotent.)
-- Requires supabase/credits_setup.sql and supabase/free_scans.sql to already
-- be set up.
--
-- Backs the proactive "you're low on credits" email (server/server.js). The
-- flag lives on credit_balances itself: use_scan() (free_scans.sql) sets it
-- the first time a scan drops the paid balance to 2 or below, and this
-- trigger clears it the moment the balance goes back up (a purchase, an
-- admin adjustment, a referral bonus) — so the alert fires once per
-- crossing, not once per low-balance scan.

alter table public.credit_balances add column if not exists low_alert_sent boolean not null default false;

create or replace function public.reset_low_credit_alert()
returns trigger
language plpgsql
as $$
begin
  if new.balance > old.balance then
    new.low_alert_sent := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reset_low_credit_alert on public.credit_balances;
create trigger trg_reset_low_credit_alert
  before update on public.credit_balances
  for each row
  execute function public.reset_low_credit_alert();
