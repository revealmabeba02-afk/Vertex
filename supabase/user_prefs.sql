-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / policy guards make it idempotent.)
--
-- Per-user email preferences — right now just opt-outs for the weekly
-- recap and low-credit alert emails, added at the same time as those
-- features so nobody gets emails they can't turn off. Same RLS pattern as
-- scan_history/trade_journal: the user owns their own row.

create table if not exists public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  weekly_recap_opt_out boolean not null default false,
  low_credit_alert_opt_out boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_prefs enable row level security;

drop policy if exists user_prefs_owner_policy on public.user_prefs;
create policy user_prefs_owner_policy on public.user_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
