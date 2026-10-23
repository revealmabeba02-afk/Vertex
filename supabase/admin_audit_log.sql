-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / CREATE OR REPLACE make it idempotent.)
--
-- Tracks admin actions (maintenance toggles, feedback status changes,
-- support replies, ...) for accountability. No RLS policies are defined on
-- the table itself — it's reachable only through the two security-definer
-- functions below, each of which re-checks the caller's own email the same
-- way admin_set_maintenance() does, so the Node server never needs a
-- service-role key or shared secret for this.

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_at_idx
  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

create or replace function public.admin_log_action(p_action text, p_detail text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  insert into public.admin_audit_log (actor_email, action, detail)
  values ((auth.jwt() ->> 'email'), p_action, p_detail);
end;
$$;

create or replace function public.admin_get_audit_log(p_limit int default 100)
returns setof public.admin_audit_log
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  return query
    select * from public.admin_audit_log
    order by created_at desc
    limit p_limit;
end;
$$;
