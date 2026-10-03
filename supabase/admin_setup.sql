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
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
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

-- Same idea, but returns the actual list: name, email and when they joined,
-- newest first. Same admin-only check as above.
create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  full_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  return query
    select
      u.id,
      u.email::text,
      coalesce(u.raw_user_meta_data ->> 'full_name', '')::text as full_name,
      u.created_at,
      u.last_sign_in_at
    from auth.users u
    order by u.created_at desc
    limit 200;
end;
$$;

revoke all on function public.admin_list_users() from public;
grant execute on function public.admin_list_users() to authenticated;
