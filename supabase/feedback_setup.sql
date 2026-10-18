-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — it replaces the table/functions in place.)
--
-- "Suggest a feature" box in the Help tab. Separate from support_messages
-- (support_setup.sql) on purpose: support is a question needing an answer,
-- feedback is a request/idea that goes on a build list — different shape,
-- different lifecycle (new -> planned -> done, not open -> resolved), and
-- mixing them would make both lists noisier to work through.

create table if not exists public.feedback_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  message text not null,
  status text not null default 'new', -- 'new' | 'planned' | 'done' | 'dismissed'
  created_at timestamptz not null default now()
);

alter table public.feedback_messages enable row level security;

drop policy if exists "read own feedback" on public.feedback_messages;
create policy "read own feedback" on public.feedback_messages
  for select using (auth.uid() = user_id);

create index if not exists feedback_messages_status_idx on public.feedback_messages (status, created_at desc);

create or replace function public.create_feedback_message(p_message text)
returns public.feedback_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.feedback_messages;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_message is null or length(trim(p_message)) = 0 then
    raise exception 'Message cannot be empty';
  end if;
  if length(p_message) > 2000 then
    raise exception 'Message is too long';
  end if;

  v_email := coalesce(auth.jwt() ->> 'email', '');

  insert into public.feedback_messages (user_id, email, message)
  values (auth.uid(), v_email, trim(p_message))
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.create_feedback_message(text) from public;
grant execute on function public.create_feedback_message(text) to authenticated;

-- Admin-only read of every suggestion, newest first.
create or replace function public.admin_list_feedback()
returns setof public.feedback_messages
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  return query
    select * from public.feedback_messages
    order by created_at desc
    limit 300;
end;
$$;
revoke all on function public.admin_list_feedback() from public;
grant execute on function public.admin_list_feedback() to authenticated;

-- Move a suggestion through the build list from the admin page.
create or replace function public.admin_set_feedback_status(p_id uuid, p_status text)
returns public.feedback_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.feedback_messages;
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;
  if p_status not in ('new', 'planned', 'done', 'dismissed') then
    raise exception 'Invalid status';
  end if;

  update public.feedback_messages
    set status = p_status
    where id = p_id
    returning * into v_row;

  if not found then
    raise exception 'Feedback not found';
  end if;

  return v_row;
end;
$$;
revoke all on function public.admin_set_feedback_status(uuid, text) from public;
grant execute on function public.admin_set_feedback_status(uuid, text) to authenticated;
