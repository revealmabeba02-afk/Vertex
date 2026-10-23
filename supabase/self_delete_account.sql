-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- (Safe to run again — create or replace / revoke+grant make it idempotent.)
--
-- Lets a signed-in user delete their own account and all their own data in
-- one call, with their own JWT — no service-role key involved. A security
-- definer function is the only way a client-held anon/authenticated key can
-- ever reach auth.users directly, so this function is kept to exactly one
-- job (delete the caller's own row, nothing else) and only `authenticated`
-- may execute it.

create or replace function public.self_delete_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.broker_accounts where user_id = uid;
  delete from public.credit_balances where user_id = uid;
  delete from public.credit_orders where user_id = uid;
  delete from public.feedback_messages where user_id = uid;
  delete from public.free_scan_log where user_id = uid;
  delete from public.news_signal_unlocks where user_id = uid;
  delete from public.referral_codes where user_id = uid;
  delete from public.referrals where referred_user_id = uid or referrer_user_id = uid;
  delete from public.scan_failures where user_id = uid;
  delete from public.scan_history where user_id = uid;
  delete from public.support_messages where user_id = uid;
  delete from public.trade_journal where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.self_delete_account() from public, anon;
grant execute on function public.self_delete_account() to authenticated;
