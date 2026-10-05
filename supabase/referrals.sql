-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql to already be set up (same
-- credit_balances table, same SECURITY DEFINER pattern as everything else).
--
-- Referral program: every user gets a short share code. A new user who
-- signs up via someone's link and claims it gives the referrer +3 credits
-- and themselves +1 credit, once, the first time they claim a code.

create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;
-- No policies on purpose — only touched through the functions below
-- (SECURITY DEFINER), never direct REST access.

-- Gets the signed-in user's referral code, generating one the first time
-- they ask (8 hex chars, retried on the astronomically unlikely collision).
create or replace function public.my_referral_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_tries integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select code into v_code from public.referral_codes where user_id = auth.uid();
  if v_code is not null then
    return v_code;
  end if;

  loop
    v_code := substr(encode(gen_random_bytes(6), 'hex'), 1, 8);
    begin
      insert into public.referral_codes (user_id, code) values (auth.uid(), v_code);
      return v_code;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 5 then
        raise exception 'Could not generate a referral code, try again.';
      end if;
    end;
  end loop;
end;
$$;
revoke all on function public.my_referral_code() from public;
grant execute on function public.my_referral_code() to authenticated;

-- Claims a referral code for the signed-in (newly signed-up) user. One
-- claim per account, ever — can't be re-claimed or claimed for yourself.
-- Credits both sides: referrer +3, the new user +1.
create or replace function public.claim_referral_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer uuid;
  v_referrer_bonus constant integer := 3;
  v_referred_bonus constant integer := 1;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.referrals where referred_user_id = auth.uid()) then
    return jsonb_build_object('claimed', false, 'already', true);
  end if;

  select user_id into v_referrer from public.referral_codes where code = p_code;
  if v_referrer is null then
    return jsonb_build_object('claimed', false, 'error', 'invalid_code');
  end if;
  if v_referrer = auth.uid() then
    return jsonb_build_object('claimed', false, 'error', 'self_referral');
  end if;

  insert into public.referrals (referred_user_id, referrer_user_id) values (auth.uid(), v_referrer);

  insert into public.credit_balances (user_id, balance) values (v_referrer, v_referrer_bonus)
    on conflict (user_id) do update set balance = credit_balances.balance + v_referrer_bonus, updated_at = now();
  insert into public.credit_balances (user_id, balance) values (auth.uid(), v_referred_bonus)
    on conflict (user_id) do update set balance = credit_balances.balance + v_referred_bonus, updated_at = now();

  return jsonb_build_object('claimed', true, 'referrer_bonus', v_referrer_bonus, 'your_bonus', v_referred_bonus);
end;
$$;
revoke all on function public.claim_referral_code(text) from public;
grant execute on function public.claim_referral_code(text) to authenticated;

-- How many people the signed-in user has referred, for a small stat on
-- their referral card.
create or replace function public.my_referral_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select count(*) into v_count from public.referrals where referrer_user_id = auth.uid();
  return jsonb_build_object('referred_count', v_count, 'credits_earned', v_count * 3);
end;
$$;
revoke all on function public.my_referral_stats() from public;
grant execute on function public.my_referral_stats() to authenticated;
