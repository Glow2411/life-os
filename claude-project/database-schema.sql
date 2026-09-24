-- Life OS database schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Every table is locked to the logged-in user with Row Level Security.

-- ───────────── People ─────────────
create table if not exists people (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  name            text not null,
  phone           text,
  relationship    text,          -- friend, family, colleague…
  company         text,
  job_title       text,
  city            text,
  partner_name    text,
  kids            text,          -- e.g. "Aarav (5), Meera (2)"
  birthday        date,
  interests       text,
  notes           text,
  call_every_days int  default 21,   -- null = no call reminders
  snooze_until    date,
  created_at      timestamptz default now()
);

create table if not exists calls (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  person_id   uuid not null references people on delete cascade,
  call_date   date not null default current_date,
  summary     text,
  follow_ups  text,              -- things to ask about next time
  created_at  timestamptz default now()
);

-- ───────────── Garage ─────────────
create table if not exists vehicles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users on delete cascade,
  name                text not null,     -- "Kia K4"
  make                text,
  model               text,
  year                int,
  trim                text,
  color               text,
  vin                 text,
  plate               text,
  purchase_date       date,
  purchase_km         int default 0,
  current_km          int default 0,
  km_updated_at       date default current_date,
  insurance_provider  text,
  insurance_policy    text,
  insurance_expiry    date,
  registration_expiry date,
  tire_size           text,
  oil_spec            text,
  notes               text,
  created_at          timestamptz default now()
);

create table if not exists service_items (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  vehicle_id       uuid not null references vehicles on delete cascade,
  name             text not null,
  interval_km      int,          -- null = no km interval
  interval_months  int,          -- null = no time interval
  last_done_km     int,
  last_done_date   date,
  notes            text,
  created_at       timestamptz default now()
);

create table if not exists service_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  vehicle_id       uuid not null references vehicles on delete cascade,
  service_item_id  uuid references service_items on delete set null,
  title            text not null,
  done_date        date not null default current_date,
  km               int,
  shop             text,
  cost             numeric(10,2),
  notes            text,
  created_at       timestamptz default now()
);

create table if not exists mods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  vehicle_id  uuid not null references vehicles on delete cascade,
  name        text not null,     -- "Ceramic tint", "WeatherTech mats"
  added_date  date,
  cost        numeric(10,2),
  installer   text,
  notes       text,
  created_at  timestamptz default now()
);

-- ───────────── Security: each user sees only their own rows ─────────────
do $$
declare t text;
begin
  foreach t in array array['people','calls','vehicles','service_items','service_log','mods'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "own rows" on %I', t);
    execute format(
      'create policy "own rows" on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

create index if not exists calls_person_idx on calls (person_id, call_date desc);
create index if not exists items_vehicle_idx on service_items (vehicle_id);
create index if not exists log_vehicle_idx on service_log (vehicle_id, done_date desc);
-- Life OS v2: daily tasks + reminders. Run once in Supabase → SQL Editor.

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  title         text not null,
  notes         text,
  repeat_type   text not null default 'interval' check (repeat_type in ('interval','weekdays')),
  every_n       int  not null default 1,          -- 1 = daily, 2 = alternate days, N = every N days
  skip_weekends boolean not null default false,   -- count Mon–Fri only
  weekdays      int[] default '{}',               -- for repeat_type 'weekdays': 0 = Sun … 6 = Sat
  start_date    date not null default current_date,
  active        boolean not null default true,
  created_at    timestamptz default now()
);

create table if not exists task_done (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  task_id    uuid not null references tasks on delete cascade,
  done_date  date not null,
  created_at timestamptz default now(),
  unique (task_id, done_date)
);

create table if not exists reminders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  title      text not null,
  notes      text,
  remind_at  timestamptz not null,               -- first occurrence (anchor for repeats)
  next_at    timestamptz not null,               -- current/next occurrence
  repeat     text not null default 'none' check (repeat in ('none','daily','weekly','monthly','yearly')),
  sent_at    timestamptz,                        -- when the current occurrence was notified
  done       boolean not null default false,
  created_at timestamptz default now()
);

do $$
declare t text;
begin
  foreach t in array array['tasks','task_done','reminders'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "own rows" on %I', t);
    execute format('create policy "own rows" on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

create index if not exists task_done_idx on task_done (task_id, done_date desc);
create index if not exists reminders_due_idx on reminders (next_at) where not done;

-- Next occurrence of a repeating reminder, keeping the local (Toronto) wall-clock time across DST.
-- Used by the notify Edge Function (via rpc).
create extension if not exists pg_cron;
create extension if not exists pg_net;
create or replace function public.lifeos_next_occurrence(anchor timestamptz, rep text, after_ts timestamptz)
returns timestamptz language plpgsql stable as $$
declare
  local_anchor timestamp := anchor at time zone 'America/Toronto';
  step interval := case rep when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
                            when 'monthly' then interval '1 month' when 'yearly' then interval '1 year' end;
  k int := 0;
  cand timestamptz := anchor;
begin
  if step is null then return null; end if;
  while cand <= after_ts and k < 100000 loop
    k := k + 1;
    cand := (local_anchor + step * k) at time zone 'America/Toronto';
  end loop;
  return cand;
end $$;
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
