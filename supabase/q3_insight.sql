-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again.)
--
-- "Q3" — "Ask about this scan". Off by default. Adds the on/off switch to
-- the same single-row app_config table q2_autopilot.sql created, so run
-- that one first if this is a fresh database.
alter table public.app_config add column if not exists q3_insight boolean not null default false;

create or replace function public.get_q3_insight()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select q3_insight from public.app_config where id = 1), false);
$$;
revoke all on function public.get_q3_insight() from public;
grant execute on function public.get_q3_insight() to anon, authenticated;

create or replace function public.admin_set_q3_insight(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  update public.app_config set q3_insight = p_enabled, updated_at = now() where id = 1;
  return p_enabled;
end;
$$;
revoke all on function public.admin_set_q3_insight(boolean) from public;
grant execute on function public.admin_set_q3_insight(boolean) to authenticated;
