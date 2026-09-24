# Life OS: project instructions for Claude

These instructions are for Claude (or a developer) working on **Life OS**, Sai's personal productivity app. Read this whole file before changing anything.

## Owner and working style

- **Owner:** Sai (ravisaikiran0@gmail.com). Based in the Toronto time zone (America/Toronto).
- **Wants:** the least possible effort. Build and deploy for him; he only does sign-ins, 2FA and pasting secrets.
- **Communication:** concise, bullet points. Ask clarifying questions (with multiple-choice options) before big changes.
- **Deploying:** always verify after you deploy. Diff the uploaded files against local, run `npm test`, and render the UI in a headless browser with mock data.

## Live system

| Piece | Where | Notes |
|---|---|---|
| App (static PWA) | https://glow2411.github.io/life-os/ | GitHub Pages from repo `Glow2411/life-os`, branch `main`, folder root |
| Database, auth, cron | Supabase project `life-os`, ref `zldvnpueiintyesvmwlb` (org "Glow2411's Org", free plan) | Dashboard: https://supabase.com/dashboard/project/zldvnpueiintyesvmwlb |
| Notifier | Supabase Edge Function `notify` | Deployed from `dist/notify.ts` (built by `tools/build-notify.mjs`) |
| Push | ntfy.sh, private topic stored in Edge secret `NTFY_TOPIC` | Sai subscribes in the ntfy phone app. Never commit the topic. |
| Email | Gmail SMTP (port 465) from ravisaikiran0@gmail.com using an app password | Edge secrets `GMAIL_USER` and `GMAIL_APP_PASSWORD` |
| Backup digest | GitHub Actions workflow "Daily digest" (manual only) | Uses repo secrets SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD |

Sign-in uses Supabase email magic links. **Sign-ups are disabled** (Auth → Sign In / Providers). The Site URL and redirect are `https://glow2411.github.io/life-os/`.

## Architecture

- **No build step for the app.** It is plain ES modules loaded straight by the browser:
  - `index.html` holds all CSS.
  - `app.js` is the UI, a hash router and a Supabase client (supabase-js v2 from the jsdelivr CDN).
  - `logic.js` holds the pure rules (due dates, streaks, agenda, picklist defaults, notification config, email rendering).
  - `config.js` holds the Supabase URL and publishable key. Both are safe to be public because RLS protects the data.
- **`logic.js` is shared** by three consumers: the browser app, `digest/send-digest.js` (Node) and the Edge Function (Deno, inlined at build time). Keep it dependency-free, with no DOM and no Node APIs.
- **Security:** every table has a `user_id default auth.uid()` column and the RLS policy "own rows". `notify_log` has RLS on with no policies, so only the server can touch it.
- **Notifications:**
  - pg_cron job `lifeos-notify` runs every minute. It sends `net.http_post` to `/functions/v1/notify` with header `x-hook-secret` (must equal the Edge secret `HOOK_SECRET`). JWT verification is **off** for this function.
  - For each user, the function:
    1. Sends due timed reminders on the reminder's own `channel`, or the Reminders module default.
    2. Sends each daily module (tasks, people, garage, summary) once a day at its `alert_time`, only if that module has items. `notify_log` prevents duplicates.
  - Push goes to ntfy through the SQL function `lifeos_push(payload)` (pg_net), **not** `fetch` from the Edge Function. ntfy.sh rate-limits the shared Edge Function IPs with 429 errors; the database has its own IP.
  - Email goes through nodemailer + Gmail SMTP on port 465.
  - To test manually, POST `{"test":"push"|"email"|"both"}` or `{"module":"garage","channel":"email"}` with the hook secret. The app's Settings has "Test push" and "Test email" buttons; these create a reminder due now.
  - Repeating reminders advance with SQL function `lifeos_next_occurrence(anchor, rep, after_ts)`, which keeps the local wall-clock time across DST.
- **Picklists:**
  - `DEFAULT_LISTS` in `logic.js` defines each list (label, where it's used, default values).
  - Once Sai edits a list in Settings, his values live in table `picklists` and override the defaults.
  - Form field types in `app.js`:
    - `pick`: a dropdown from a list, plus "Other…" free text.
    - `suggest`: free text with type-ahead from a list and values already used.
    - `select`: fixed options (km, months, years, times).

## Database (see `supabase/*.sql`, applied in order)

1. `schema.sql`: people, calls, vehicles, service_items, service_log, mods.
2. `schema-v2-tasks-reminders.sql`: tasks, task_done, reminders, plus `lifeos_next_occurrence()`.
3. `schema-v3-notify-picklists.sql`: notify_prefs, notify_log, picklists, reminders.channel, calls.call_type.
4. The cron job SQL is **not in git** because it contains the hook secret. To recreate it, see "Rotating secrets" below.

Key columns:

- **Tasks:**
  - `tasks.repeat_type` is `interval` (every `every_n` days, optionally `skip_weekends`) or `weekdays` (int[] 0=Sun…6=Sat).
  - `task_done` has one row per task per day done.
- **Reminders:**
  - `remind_at` is the anchor; `next_at` is the current occurrence.
  - `repeat` is none, daily, weekly, monthly or yearly.
  - `sent_at` is when the current occurrence was notified.
  - `channel` is null (use the module default), push, email, both or off.
  - `done` is true only for finished one-time reminders.
- **Notification prefs:** `notify_prefs(module, channel, alert_time)`. Defaults are in `DEFAULT_PREFS` in `logic.js`.
- **Garage:**
  - `service_items` has `interval_km` and/or `interval_months`. The due point is `last_done_*`, falling back to the vehicle's purchase km or date.
  - Sai's car is a 2025 Kia K4, 1.6L Turbo, on Kia Canada's severe schedule.

## Modules today

| Tab | Route | Tables | Alerts |
|---|---|---|---|
| Today | `#today` | everything (agenda) | Morning summary (`summary`) |
| Tasks | `#tasks` | tasks, task_done | `tasks` (daily) |
| Reminders | `#reminders` | reminders | `reminders` (timed) |
| People | `#people`, `#person/<id>` | people, calls | `people` (daily: calls due, birthdays ≤7 days) |
| Garage | `#garage`, `#vehicle/<id>` | vehicles, service_items, service_log, mods | `garage` (daily: services due/soon, odometer stale >30 days, renewals ≤30 days) |
| Settings | `#settings` (⚙️ on Today) | notify_prefs, picklists | – |

## How to add a new module (checklist)

1. **SQL:** write `supabase/schema-vN-<name>.sql` with `create table … user_id uuid not null default auth.uid() references auth.users on delete cascade`, add RLS plus the "own rows" policy (copy the `do $$` loop), and run it in the Supabase SQL Editor.
2. **`logic.js`:**
   - Put the pure rules in (e.g. `xxxStatus()`).
   - Emit agenda items inside `buildAgenda()` with a new `kind`, and add an icon in `ICON`.
   - Add the module to `MODULES` with its `kinds`, and to `DEFAULT_PREFS`.
   - Add any new dropdowns to `DEFAULT_LISTS`.
3. **SQL again:** allow the new module key in the `notify_prefs.module` check constraint (`alter table … drop constraint … add constraint …`).
4. **`app.js`:**
   - Add the table to `S` and to `loadAll()`.
   - Add a `XXX_FIELDS` array, using `pick`/`suggest`/`select` wherever possible (Sai wants picklists).
   - Add actions to `A`, a `screenXxx()` function, the route in `render()`, and a tab in `TABS` (5 tabs already, so consider a sub-page instead).
5. **Tests:** add cases to `digest/test-logic.js` and run `npm test`.
6. **Notifier:** if alerts are needed, the agenda items flow through automatically. Run `node tools/build-notify.mjs` and redeploy `dist/notify.ts`.
7. **Deploy and verify** (next section).

## Deploying

- **Local copy:** the project folder on Sai's PC is `C:\Users\ravik\Documents\LifeOS`. The `.github` folder can't be written there by Claude's tools, so the workflow is also kept at `workflows/daily-digest.yml`; upload it to `.github/workflows/` in the repo.
- **App or repo files:** Sai's machine has no git credentials, so upload through the GitHub web UI:
  - `https://github.com/Glow2411/life-os/upload/main/<folder>`, then commit.
  - With Claude in Chrome, `file_upload` can't read session files. Instead, in the upload page run JS that builds a `File`, sets `input[type=file].files` through a `DataTransfer`, dispatches `change`, then clicks "Commit changes".
  - To send less text, send a line-diff (ops) against the current file. Fetch the base from `raw.githubusercontent.com/Glow2411/life-os/<commit-sha>/<path>`; get the sha from `api.github.com/repos/Glow2411/life-os/commits/main`, because the `main` URL is CDN-cached for about 5 minutes. Check a SHA-256 of the result before uploading.
  - Pages redeploys in about 1 minute. Bump `CACHE` in `sw.js` when the app shell changes.
- **Edge Function:**
  1. Run `node tools/build-notify.mjs`, which writes `dist/notify.ts` (commit it too).
  2. In Supabase → Edge Functions → `notify` → Code, replace `index.ts`. In the dashboard page, fetch `logic.js` and `notifier.js` from raw.githubusercontent at the latest commit sha, rebuild with the same logic as `tools/build-notify.mjs`, and call `monaco.editor.getModels()[0].setValue(out)`.
  3. Click "Deploy updates", then confirm in the dialog.
- **SQL:** Supabase → SQL Editor. In the dashboard you can set text with `monaco.editor.getModels()[0].setValue(sql)` and click Run. It may warn about RLS or "destructive" statements; choose "Run and enable RLS".
- **Verify:**
  - `curl https://raw.githubusercontent.com/Glow2411/life-os/main/<file>` and diff it against local.
  - Check `select * from net._http_response order by created desc limit 5;` and `select * from cron.job_run_details order by start_time desc limit 5;`.
  - Edge Function logs are in the dashboard.

## Rotating secrets

- **Hook secret:** generate a new one, update the Edge secret `HOOK_SECRET`, then recreate the cron job:

  ```sql
  select cron.unschedule(jobid) from cron.job where jobname = 'lifeos-notify';
  select cron.schedule('lifeos-notify', '* * * * *', $$ select net.http_post(
    url := 'https://zldvnpueiintyesvmwlb.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type','application/json','x-hook-secret','<NEW SECRET>'),
    body := '{}'::jsonb, timeout_milliseconds := 20000); $$);
  ```

- **ntfy topic:** change the Edge secret `NTFY_TOPIC`, then re-subscribe in the ntfy app.
- **Gmail app password:** myaccount.google.com/apppasswords. Update the Edge secret `GMAIL_APP_PASSWORD` and the GitHub repo secret.

## Local development

- **Tests:** `npm install` then `npm test` (Node 22+) run the logic tests.
- **UI preview:** serve the folder with any static server, or use a headless browser with the Supabase client mocked. Past sessions routed `cdn.jsdelivr.net` to a mock `createClient` that returns in-memory tables.
- **Edge Function locally:** run with Deno, using an import map that points `npm:@supabase/supabase-js@2` and `npm:nodemailer@6.9.14` at mocks, and stub `fetch` for ntfy.

## Ideas backlog

- AI call summaries from a voice note, which also update the person's profile.
- Receipt photos on service records (Supabase Storage).
- Modules for bills and renewals, job applications, and home maintenance.
- Car maintenance export or share with the dealer.
