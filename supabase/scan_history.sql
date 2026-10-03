-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Creates the table that /api/history and the "Scan another chart" flow write
-- to, with row-level security so each user can only ever see their own scans.

create table if not exists public.scan_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pair text,
  timeframe text,
  bias text,
  signal text,
  created_at timestamptz not null default now()
);

create index if not exists scan_history_user_id_created_at_idx
  on public.scan_history (user_id, created_at desc);

alter table public.scan_history enable row level security;

create policy "Users can view their own scan history"
  on public.scan_history for select
  using (auth.uid() = user_id);

create policy "Users can insert their own scan history"
  on public.scan_history for insert
  with check (auth.uid() = user_id);
