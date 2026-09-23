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
