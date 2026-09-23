-- Life OS v3: notification preferences, picklists, call type. Run once in Supabase → SQL Editor.
-- (The pg_cron job that calls the notify Edge Function is in supabase/cron-notify.sql — it contains a secret, keep it out of git.)

-- Per-module notification settings. module: reminders | tasks | people | garage | summary
create table if not exists notify_prefs (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  module     text not null check (module in ('reminders','tasks','people','garage','summary')),
  channel    text not null default 'push' check (channel in ('push','email','both','off')),
  alert_time time,                              -- daily modules: when to send (Toronto time). Ignored for reminders.
  primary key (user_id, module)
);

-- Daily alerts already sent (so each module alerts at most once a day)
create table if not exists notify_log (
  user_id  uuid not null references auth.users on delete cascade,
  module   text not null,
  sent_on  date not null,
  sent_at  timestamptz default now(),
  primary key (user_id, module, sent_on)
);

-- Editable dropdown values. list = picklist name (see DEFAULT_LISTS in logic.js)
create table if not exists picklists (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null default auth.uid() references auth.users on delete cascade,
  list     text not null,
  value    text not null,
  sort     int  not null default 0,
  unique (user_id, list, value)
);

-- Per-reminder channel override (null = use the Reminders module default)
alter table reminders add column if not exists channel text check (channel in ('push','email','both','off'));
-- How a call happened
alter table calls add column if not exists call_type text;

do $$
declare t text;
begin
  foreach t in array array['notify_prefs','picklists'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "own rows" on %I', t);
    execute format('create policy "own rows" on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
alter table notify_log enable row level security;   -- no policies: server-only

-- Retire the old SQL-only reminder sender (the Edge Function replaces it)
select cron.unschedule(jobid) from cron.job where jobname = 'lifeos-reminders';
drop function if exists public.lifeos_send_due_reminders();

-- Push via ntfy is sent from the database (pg_net) because ntfy.sh rate-limits the shared Edge Function IPs.
create or replace function public.lifeos_push(payload jsonb)
returns bigint language sql security definer set search_path = public, net as $$
  select net.http_post(url := 'https://ntfy.sh/', body := payload, headers := '{"Content-Type": "application/json"}'::jsonb);
$$;
revoke all on function public.lifeos_push(jsonb) from public, anon, authenticated;
grant execute on function public.lifeos_push(jsonb) to service_role;
