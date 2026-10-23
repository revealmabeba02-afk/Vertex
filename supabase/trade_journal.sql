-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / policy guards make it idempotent.)
--
-- A simple trade journal: users log their own trades (independent of
-- whether they came from a Vertex scan) so they can track win rate and P&L
-- over time. No admin visibility into this by design — it's the user's own
-- private record, same RLS pattern as scan_history.

create table if not exists public.trade_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pair text not null,
  direction text not null check (direction in ('buy', 'sell')),
  entry numeric,
  exit numeric,
  result text not null default 'open' check (result in ('open', 'win', 'loss', 'breakeven')),
  pnl numeric,
  notes text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists trade_journal_user_id_created_at_idx
  on public.trade_journal (user_id, created_at desc);

alter table public.trade_journal enable row level security;

drop policy if exists trade_journal_owner_policy on public.trade_journal;
create policy trade_journal_owner_policy on public.trade_journal
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
