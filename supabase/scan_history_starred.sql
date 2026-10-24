-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / policy guards make it idempotent.)
--
-- Lets a user star an individual scan in their History (separate from
-- pinning a whole pair) — for marking "this specific read was a good call"
-- without having to log a full journal trade for it.

alter table public.scan_history add column if not exists starred boolean not null default false;

-- scan_history had select/insert/delete policies for the owner already, but
-- no update policy (nothing needed to update a row before this), so add one
-- scoped to the owner the same way.
drop policy if exists scan_history_update_own on public.scan_history;
create policy scan_history_update_own
  on public.scan_history for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
