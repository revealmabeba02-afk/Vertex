-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / policy guards make it idempotent.)
--
-- One MT4/MT5 broker account per user, connected through MetaApi.cloud.
-- IMPORTANT: this table never stores the broker login password. The
-- password is sent once, straight from the browser to our server to
-- MetaApi's provisioning API, in the same request — MetaApi holds it
-- (encrypted, on their side) from then on. We only keep the account
-- number, server name, MetaApi's own account id for that connection, and
-- a status, same RLS pattern as scan_history/trade_journal.

create table if not exists public.broker_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('mt4', 'mt5')),
  login text not null,
  server text not null,
  metaapi_account_id text,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  status_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One broker connection per user for now — simplest to reason about and
-- matches "connect your account" as a single action in Settings.
create unique index if not exists broker_accounts_user_id_idx
  on public.broker_accounts (user_id);

alter table public.broker_accounts enable row level security;

drop policy if exists broker_accounts_owner_policy on public.broker_accounts;
create policy broker_accounts_owner_policy on public.broker_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
