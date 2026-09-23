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
