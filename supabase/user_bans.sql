-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — IF NOT EXISTS / create or replace make it idempotent.)
--
-- Lets King suspend an abusive/fraudulent account (chargebacks, scam
-- signups) without deleting their data, and without a service_role key —
-- same pattern as every other admin_* function: Postgres checks the
-- caller's own JWT email, not a secret the client could replay.
--
-- No RLS policies are granted here on purpose (deny-all by default): this
-- table is only ever touched through the security-definer functions below,
-- same as free_scan_log.

create table if not exists public.user_bans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text,
  banned_at timestamptz not null default now()
);

alter table public.user_bans enable row level security;

-- Ban or unban a user by email. Banning inserts a row; unbanning removes it
-- (so "is this user banned" is just "does a row exist", checked inline by
-- use_scan() without a second round trip).
create or replace function public.admin_set_user_banned(p_email text, p_banned boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  select id into v_user_id from auth.users where lower(auth.users.email) = lower(p_email) limit 1;
  if v_user_id is null then
    raise exception 'No user with that email';
  end if;

  if p_banned then
    insert into public.user_bans (user_id, reason, banned_at)
    values (v_user_id, p_reason, now())
    on conflict (user_id) do update set reason = excluded.reason, banned_at = now();
  else
    delete from public.user_bans where user_id = v_user_id;
  end if;

  insert into public.admin_audit_log (actor_email, action, detail)
  values (
    (auth.jwt() ->> 'email'),
    case when p_banned then 'ban_user' else 'unban_user' end,
    p_email || case when p_banned and p_reason is not null and p_reason <> '' then ' — ' || p_reason else '' end
  );
end;
$$;
revoke all on function public.admin_set_user_banned(text, boolean, text) from public, anon;
grant execute on function public.admin_set_user_banned(text, boolean, text) to authenticated;

-- admin_list_users() (admin_setup.sql) already lists everyone; this adds the
-- banned flag to that same listing so the admin page can show it without a
-- second query per row.
create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  full_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  banned boolean
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
      u.last_sign_in_at,
      (b.user_id is not null) as banned
    from auth.users u
    left join public.user_bans b on b.user_id = u.id
    order by u.created_at desc
    limit 200;
end;
$$;
revoke all on function public.admin_list_users() from public;
grant execute on function public.admin_list_users() to authenticated;
