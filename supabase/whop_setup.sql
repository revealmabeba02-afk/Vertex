-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Requires supabase/credits_setup.sql to have been run first (this adds to
-- the credit_orders table it creates).
--
-- Adds Whop as a payment method alongside the existing Binance Pay code.
-- Binance's API blocks requests from Render's server region (HTTP 451), so
-- Whop is now the primary way to buy credits — this function is what the
-- /api/webhooks/whop handler in server.js calls once a payment.succeeded
-- event is verified.

-- Lets a payment be looked up by Whop's own payment id, so a retried
-- webhook delivery (Whop retries on anything but a 2xx) never credits the
-- same payment twice.
alter table public.credit_orders add column if not exists external_id text;
alter table public.credit_orders add column if not exists source text not null default 'binance';
create unique index if not exists credit_orders_external_id_idx
  on public.credit_orders (external_id) where external_id is not null;

-- Finds the Vertex account by the email the buyer used at Whop checkout and
-- credits it. Guarded by the same shared secret as the Binance system
-- functions (CREDIT_FULFILL_SECRET in Render) rather than auth.uid(),
-- since this is called by the server itself with no logged-in user.
create or replace function public.whop_credit_by_email(
  p_email text,
  p_bundle text,
  p_scans integer,
  p_amount_usd numeric,
  p_external_id text,
  p_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_existing public.credit_orders;
  v_order public.credit_orders;
begin
  if p_secret is distinct from '5b43538659fe69465f251809e20f1ef73eb99a61ff6f4b57' then
    raise exception 'Not authorized';
  end if;

  -- Already processed this exact payment (e.g. a retried webhook) — do
  -- nothing and report what happened the first time, rather than crediting
  -- twice.
  select * into v_existing from public.credit_orders where external_id = p_external_id;
  if found then
    return jsonb_build_object('already_processed', true, 'order_id', v_existing.id);
  end if;

  select id into v_user_id from auth.users where lower(email) = lower(p_email) limit 1;
  if v_user_id is null then
    raise exception 'No Vertex account found for email %', p_email;
  end if;

  insert into public.credit_orders (user_id, bundle, scans, amount_usd, status, paid_at, external_id, source)
  values (v_user_id, p_bundle, p_scans, p_amount_usd, 'paid', now(), p_external_id, 'whop')
  returning * into v_order;

  insert into public.credit_balances (user_id, balance, updated_at)
  values (v_user_id, p_scans, now())
  on conflict (user_id) do update
    set balance = public.credit_balances.balance + p_scans,
        updated_at = now();

  return jsonb_build_object('already_processed', false, 'order_id', v_order.id, 'user_id', v_user_id);
end;
$$;
revoke all on function public.whop_credit_by_email(text, text, integer, numeric, text, text) from public;
grant execute on function public.whop_credit_by_email(text, text, integer, numeric, text, text) to anon, authenticated;
