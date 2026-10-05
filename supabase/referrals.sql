-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql to already be set up (same
-- credit_balances table, same SECURITY DEFINER pattern as everything else).
--
-- Referral program (v2 — paid-only, no free giveaways): every user gets a
-- short share code. Signing up via someone's link just links the two
-- accounts — no credits change hands yet. The referrer only gets rewarded
-- (+2 credits) the first time their referred friend actually BUYS credits,
-- paid for by a real purchase, never for free.

create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  rewarded boolean not null default false
);
-- Upgrading from v1 (which had no "rewarded" column): add it if missing.
alter table public.referrals add column if not exists rewarded boolean not null default false;

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

-- Links a new signup to whoever's code they arrived with. No credits here
-- — this just records who referred whom, so the reward below has someone
-- to pay out to once (and if) this new user actually buys credits.
create or replace function public.claim_referral_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer uuid;
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

  return jsonb_build_object('claimed', true);
end;
$$;
revoke all on function public.claim_referral_code(text) from public;
grant execute on function public.claim_referral_code(text) to authenticated;

-- How many people the signed-in user has referred, and how many of those
-- have actually paid (and so earned a reward), for the referral card.
create or replace function public.my_referral_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_rewarded integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select count(*), count(*) filter (where rewarded) into v_count, v_rewarded
    from public.referrals where referrer_user_id = auth.uid();
  return jsonb_build_object('referred_count', v_count, 'paid_count', v_rewarded, 'credits_earned', v_rewarded * 2);
end;
$$;
revoke all on function public.my_referral_stats() from public;
grant execute on function public.my_referral_stats() to authenticated;

-- System function, called by the server (never the browser) right after a
-- real Whop payment is credited. Pays the referrer +2 credits the first
-- time — and only the first time — their referred friend's payment clears.
-- Same secret pattern as admin_credit_order() in credits_setup.sql.
create or replace function public.reward_referral_on_purchase(p_email text, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
  v_referrer uuid;
  v_bonus constant integer := 2;
begin
  if p_secret is distinct from '5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57' then
    raise exception 'Not authorized';
  end if;

  select id into v_buyer from auth.users where lower(email) = lower(p_email);
  if v_buyer is null then
    return jsonb_build_object('rewarded', false, 'reason', 'no_such_user');
  end if;

  select referrer_user_id into v_referrer from public.referrals
    where referred_user_id = v_buyer and rewarded = false;
  if v_referrer is null then
    return jsonb_build_object('rewarded', false, 'reason', 'no_pending_referral');
  end if;

  update public.referrals set rewarded = true where referred_user_id = v_buyer;

  insert into public.credit_balances (user_id, balance) values (v_referrer, v_bonus)
    on conflict (user_id) do update set balance = credit_balances.balance + v_bonus, updated_at = now();

  return jsonb_build_object('rewarded', true, 'referrer_user_id', v_referrer, 'bonus', v_bonus);
end;
$$;
revoke all on function public.reward_referral_on_purchase(text, text) from public;
grant execute on function public.reward_referral_on_purchase(text, text) to anon, authenticated;
