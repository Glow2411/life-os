# Life OS

> Already set up and live at https://glow2411.github.io/life-os/. **For changes or new modules, read [CLAUDE.md](CLAUDE.md) first.** The original setup guide is below for reference.

## Original setup guide (about 30 minutes, one time)

A personal app with two modules:

- **People**: call reminders, profiles (work, partner, kids, birthday), and a "before you call" summary of your last conversation
- **Garage**: a Kia K4 service schedule by km and months, service history, accessories and mods, insurance and plate-sticker renewals

It also sends a **daily email digest** of anything that's due. The email only goes out on days when something needs attention.

You need three free accounts: **Supabase** (the database), **GitHub** (hosting and the daily email job), and **Gmail** (sends the email).

---

## 1. Supabase: create the database (10 min)

1. Sign up at supabase.com and click **New project**. Pick any name and password; choose a region near you.
2. Once it's ready, open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, and click **Run**.
3. Go to **Project Settings → API** (or the **Connect** button) and copy three things:
   - **Project URL**
   - **anon / publishable key**: goes in the app
   - **service_role / secret key**: goes only into GitHub secrets. Never put it in the code.
4. Go to **Authentication → URL Configuration** and set **Site URL** to your GitHub Pages address from step 2 (for example `https://yourname.github.io/life-os/`). Add it under **Redirect URLs** as well.

## 2. GitHub: host the app (10 min)

1. Create a new repository named `life-os`. It must be **Public** for free GitHub Pages. Your data stays private because it lives in Supabase, not in the repo.
2. Open `config.js` and paste in your **Project URL** and **anon key**.
3. Upload every file in this folder to the repo, **including the `.github` folder**. The easiest way is **Add file → Upload files** and dragging the whole folder in.
4. Go to **Settings → Pages → Source: Deploy from branch → main / (root) → Save**. After about a minute your app is live at `https://yourname.github.io/life-os/`.
5. Open that address on your phone and sign in with your email. You'll get a one-time link.
   - **Android (Chrome):** menu ⋮ → **Add to Home screen / Install app**
   - **iPhone (Safari):** Share → **Add to Home Screen**
6. **Lock the door:** once you've signed in once, go to Supabase **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**, so nobody else can create an account.

## 3. Daily email digest (10 min)

1. **Gmail app password:** turn on 2-Step Verification for your Google account, then go to myaccount.google.com/apppasswords, create one named "Life OS", and copy the 16-character password.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

   | Secret | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role / secret key |
   | `GMAIL_USER` | your Gmail address |
   | `GMAIL_APP_PASSWORD` | the 16-character app password |
   | `DIGEST_TO` | where to send the digest (optional; defaults to GMAIL_USER) |

3. On the **Variables** tab, add `APP_URL` = your GitHub Pages address. This adds an "Open Life OS" button to the email.
4. Test it: **Actions → Daily digest → Run workflow**. If anything is due, the email arrives within a minute.

The digest runs at **7:00 AM Toronto time** in summer (6:00 AM in winter). To change the time, edit the `cron` line in `.github/workflows/daily-digest.yml`; it's in UTC. To use a different timezone, change `TZ` in that same file.

---

## Using it

- **Garage → Add my Kia K4** creates the car *and* loads a default schedule. Enter the purchase date and km so the first due dates are right.
- **Check the intervals.** The defaults come from Kia's US dealer schedule, converted to km: oil every 12,000 km or 6 months, and so on. Many Canadian Kia dealers recommend **6,000–8,000 km** for Canadian or severe conditions. Tap any service item to adjust it to what your owner's manual says.
- **Update the odometer** about once a month. The digest reminds you after 30 days. Km-based reminders are only as accurate as this number.
- **After each call**, tap **Log a call** and jot down 2–3 lines plus things to ask next time. That's what shows up under "Before you call".
- Tap **Done** on a service item to log it; the next due date resets automatically.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js` | The app |
| `logic.js` | Due-date rules, shared by the app and the email |
| `config.js` | **Your Supabase URL and anon key: the only file you edit** |
| `supabase/schema.sql` | Database tables and security rules |
| `digest/send-digest.js` | The daily email script |
| `.github/workflows/daily-digest.yml` | The schedule for the email |
| `manifest.json`, `sw.js`, `icon.svg` | Make it installable as a phone app |

## Ideas for v2

- AI call summaries: record a voice note after a call and have it write the summary and update the profile
- Receipt photos on service records (Supabase Storage)
- More modules: bills and renewals, job applications, home maintenance
