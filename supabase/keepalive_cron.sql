-- Keeps the free Render instance awake, without depending on GitHub's
-- scheduler. Optional: the GitHub Actions workflow in
-- .github/workflows/keepalive.yml is the primary pinger. This is the backup
-- for the case where scheduled workflows stay quiet.
--
-- Run once in Supabase -> SQL Editor. Takes about 15 seconds.
-- Safe to re-run: the schedule is replaced, not duplicated.
--
-- Cost: zero. pg_cron and pg_net are included on every Supabase plan, and a
-- request every five minutes is a rounding error against the free quota.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Render free instances sleep after ~15 minutes without traffic.
select cron.unschedule('vertex-keepalive')
where exists (select 1 from cron.job where jobname = 'vertex-keepalive');

select cron.schedule(
  'vertex-keepalive',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://vertex-9s4c.onrender.com/api/health',
    timeout_milliseconds := 30000
  );
  $$
);

-- Check that it is registered:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'vertex-keepalive';
--
-- Check that it is actually firing (should grow every five minutes):
--   select count(*), max(start_time) from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'vertex-keepalive');
--
-- To remove it later:
--   select cron.unschedule('vertex-keepalive');
