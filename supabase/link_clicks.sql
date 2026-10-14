-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Logs every click on a /go/:platform tracked link (TikTok, Instagram,
-- YouTube, Facebook) so King can see which platform is actually driving
-- traffic, both in the admin page and via the email alert sent by the
-- server at the moment of the click. These clicks come from anyone on the
-- open internet, not a signed-in Vertex user, so the insert goes through a
-- SECURITY DEFINER function (log_link_click) rather than user-scoped RLS —
-- there's no auth.uid() to check here, just a known set of platform names.

create table if not exists public.link_clicks (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  created_at timestamptz not null default now()
);

alter table public.link_clicks enable row level security;
-- No policies are created on purpose: nothing can read or write this table
-- directly from the browser. All access goes through the two functions
-- below, which run with definer privileges.

-- Called by the server (with just the anon key — no user token) every time
-- someone hits /go/:platform. Takes a plain platform name; the server
-- already validates it against a known list before calling this.
create or replace function public.log_link_click(p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.link_clicks (platform) values (p_platform);
end;
$$;
revoke all on function public.log_link_click(text) from public;
grant execute on function public.log_link_click(text) to anon, authenticated;

-- Admin-only summary: total clicks per platform, plus how many in the last
-- 24 hours. Same admin-email gate pattern as admin_scan_failure_summary.
create or replace function public.admin_link_click_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.jwt() ->> 'email' is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
  from (
    select
      platform,
      count(*) as total,
      count(*) filter (where created_at > now() - interval '24 hours') as last_24h
    from public.link_clicks
    group by platform
    order by total desc
  ) t;

  return v_result;
end;
$$;
revoke all on function public.admin_link_click_summary() from public;
grant execute on function public.admin_link_click_summary() to authenticated;
