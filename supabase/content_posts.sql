-- Content planner: a lightweight log of posts King plans/schedules for
-- Shadow FX / Vertex's social accounts, so he can batch-write captions at
-- night and check off what's been scheduled/posted — without needing a
-- separate tool. Admin-only (same pattern as link_clicks.sql): everything
-- goes through SECURITY DEFINER functions that check the caller's email,
-- so no RLS policies are needed on the table itself.

create table if not exists public.content_posts (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  caption text not null default '',
  scheduled_for date,
  status text not null default 'planned', -- 'planned' | 'scheduled' | 'posted'
  created_at timestamptz not null default now()
);
alter table public.content_posts enable row level security;
-- No policies created on purpose — all access goes through the functions below.

create or replace function public.admin_add_content_post(
  p_platform text,
  p_caption text,
  p_scheduled_for date
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.content_posts;
begin
  if auth.jwt() ->> 'email' is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;
  insert into public.content_posts (platform, caption, scheduled_for)
  values (p_platform, coalesce(p_caption, ''), p_scheduled_for)
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.admin_add_content_post(text, text, date) from public;
grant execute on function public.admin_add_content_post(text, text, date) to authenticated;

create or replace function public.admin_list_content_posts()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if auth.jwt() ->> 'email' is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
  from (
    select id, platform, caption, scheduled_for, status, created_at
    from public.content_posts
    order by (scheduled_for is null), scheduled_for asc, created_at desc
  ) t;
  return v_result;
end;
$$;
revoke all on function public.admin_list_content_posts() from public;
grant execute on function public.admin_list_content_posts() to authenticated;

create or replace function public.admin_set_content_post_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.jwt() ->> 'email' is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;
  if p_status not in ('planned', 'scheduled', 'posted') then
    raise exception 'Invalid status';
  end if;
  update public.content_posts set status = p_status where id = p_id;
end;
$$;
revoke all on function public.admin_set_content_post_status(uuid, text) from public;
grant execute on function public.admin_set_content_post_status(uuid, text) to authenticated;

create or replace function public.admin_delete_content_post(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.jwt() ->> 'email' is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;
  delete from public.content_posts where id = p_id;
end;
$$;
revoke all on function public.admin_delete_content_post(uuid) from public;
grant execute on function public.admin_delete_content_post(uuid) to authenticated;
