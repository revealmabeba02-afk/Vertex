-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — it replaces the table/functions in place.)
--
-- "Q2" is the admin-facing name for fully-autonomous support AI mode.
-- Normally (autopilot OFF) the AI triage in server.js only auto-replies to
-- questions it's confident about, and leaves anything it's unsure of as a
-- draft for the admin to review and send from the admin page. With Q2
-- switched ON, the AI's best-effort answer goes out immediately for EVERY
-- message, confident or not, with no human review.
-- One row, one switch, read by the server on every support message and
-- toggled from the admin page.

create table if not exists public.app_config (
  id int primary key default 1,
  q2_autopilot boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint app_config_single_row check (id = 1)
);

insert into public.app_config (id, q2_autopilot)
values (1, false)
on conflict (id) do nothing;

alter table public.app_config enable row level security;
-- No public policies: all access goes through the SECURITY DEFINER
-- functions below, same pattern as support_messages.

-- Read the current switch state. Called by the server (anon key, no logged
-- in user for this part) on every incoming support message, so it has no
-- auth check of its own — it's a single boolean, not sensitive.
create or replace function public.get_q2_autopilot()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select q2_autopilot from public.app_config where id = 1), false);
$$;
revoke all on function public.get_q2_autopilot() from public;
grant execute on function public.get_q2_autopilot() to anon, authenticated;

-- Flip the switch from the admin page.
create or replace function public.admin_set_q2_autopilot(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  update public.app_config set q2_autopilot = p_enabled, updated_at = now() where id = 1;
  return p_enabled;
end;
$$;
revoke all on function public.admin_set_q2_autopilot(boolean) from public;
grant execute on function public.admin_set_q2_autopilot(boolean) to authenticated;
