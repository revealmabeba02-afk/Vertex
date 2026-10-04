-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (If you already ran an earlier version of this file, running this one
-- again is safe — it replaces the table/functions in place.)
--
-- A support inbox with AI triage. Users submit a message from the Help tab.
-- The server asks Claude to look at it:
--   - confident, simple questions ("how do credits work?") get answered
--     automatically, instantly, no admin involved
--   - anything it's not sure about gets saved as a DRAFT reply for you to
--     review and send yourself from the admin page
-- Same pattern as the rest of this app: no service_role key. The AI step
-- runs as the server itself (no logged-in user for that part), guarded by
-- the same shared secret already used for crediting Binance payments
-- (CREDIT_FULFILL_SECRET) — one secret, already in your Render env, instead
-- of adding a new one just for this.

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  message text not null,
  status text not null default 'open', -- 'open' | 'resolved'
  reply text,                           -- the final answer the user sees
  ai_suggestion text,                   -- AI's draft, shown to admin only, when it wasn't confident enough to auto-reply
  replied_by text,                      -- 'ai' | 'admin'
  created_at timestamptz not null default now(),
  replied_at timestamptz
);

alter table public.support_messages enable row level security;

drop policy if exists "read own support messages" on public.support_messages;
create policy "read own support messages" on public.support_messages
  for select using (auth.uid() = user_id);

create index if not exists support_messages_status_idx on public.support_messages (status, created_at);

-- Creates the message. No AI reply yet — the server adds one right after,
-- via system_set_ai_reply below, once it's heard back from Claude.
create or replace function public.create_support_message(p_message text)
returns public.support_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.support_messages;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_message is null or length(trim(p_message)) = 0 then
    raise exception 'Message cannot be empty';
  end if;
  if length(p_message) > 4000 then
    raise exception 'Message is too long';
  end if;

  v_email := coalesce(auth.jwt() ->> 'email', '');

  insert into public.support_messages (user_id, email, message)
  values (auth.uid(), v_email, trim(p_message))
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.create_support_message(text) from public;
grant execute on function public.create_support_message(text) to authenticated;

-- Called by the server right after the AI triage call comes back.
-- p_reply set (not null)   -> confident answer: shown to the user immediately, marked resolved.
-- p_suggestion set instead -> not confident: saved as a draft for the admin page only, stays 'open'.
create or replace function public.system_set_ai_reply(p_id uuid, p_reply text, p_suggestion text, p_secret text)
returns public.support_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.support_messages;
begin
  if p_secret is distinct from '5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57' then
    raise exception 'Not authorized';
  end if;

  if p_reply is not null then
    update public.support_messages
      set reply = p_reply, status = 'resolved', replied_by = 'ai', replied_at = now()
      where id = p_id
      returning * into v_row;
  else
    update public.support_messages
      set ai_suggestion = p_suggestion
      where id = p_id
      returning * into v_row;
  end if;

  if not found then
    raise exception 'Message not found';
  end if;

  return v_row;
end;
$$;
revoke all on function public.system_set_ai_reply(uuid, text, text, text) from public;
grant execute on function public.system_set_ai_reply(uuid, text, text, text) to anon, authenticated;

-- Admin-only read of every message, newest first.
create or replace function public.admin_list_support_messages()
returns setof public.support_messages
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;

  return query
    select * from public.support_messages
    order by created_at desc
    limit 200;
end;
$$;
revoke all on function public.admin_list_support_messages() from public;
grant execute on function public.admin_list_support_messages() to authenticated;

-- Lets you send (or overwrite) the final reply from the admin page — either
-- your own words, or the AI's draft, edited or not.
create or replace function public.admin_reply_support_message(p_id uuid, p_reply text)
returns public.support_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.support_messages;
begin
  if (auth.jwt() ->> 'email') is distinct from 'revealmabeba02@gmail.com' then
    raise exception 'Not authorized';
  end if;
  if p_reply is null or length(trim(p_reply)) = 0 then
    raise exception 'Reply cannot be empty';
  end if;

  update public.support_messages
    set reply = trim(p_reply), status = 'resolved', replied_by = 'admin', replied_at = now()
    where id = p_id
    returning * into v_row;

  if not found then
    raise exception 'Message not found';
  end if;

  return v_row;
end;
$$;
revoke all on function public.admin_reply_support_message(uuid, text) from public;
grant execute on function public.admin_reply_support_message(uuid, text) to authenticated;
