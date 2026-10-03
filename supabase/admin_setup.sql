-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Lets the admin page ask "how many people have signed up" WITHOUT ever
-- using the service_role key (that key is never put in this app's code or
-- environment, by design). Instead, Postgres itself checks who is asking:
-- this function only returns a number when the logged-in user's own email
-- matches the one baked in below. Everyone else gets an error.
--
-- If you want to change who counts as admin, edit the email on the line
-- below (inside the quotes) before running this, or re-run it later with a
-- different email to update it.

create or replace function public.admin_user_count()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  result integer;
begin
  if (auth.jwt() ->> 'email') is distinct from 'reveal@shadowfx.co.za' then
    raise exception 'Not authorized';
  end if;

  select count(*) into result from auth.users;
  return result;
end;
$$;

-- No one can call this except a logged-in user (and the check above narrows
-- that down to just the admin email). Nothing is exposed to the public.
revoke all on function public.admin_user_count() from public;
grant execute on function public.admin_user_count() to authenticated;
