// ─────────────────────────────────────────────────────────────────────────────
// Life OS notifier — Supabase Edge Function "notify" (Deno).
// Called every minute by pg_cron (see supabase/cron-notify.sql).
//   1. Timed reminders that are due  → push / email per reminder (or Reminders module default)
//   2. Daily module alerts (tasks, people, garage, summary) at each module's alert_time → push / email
// Build: `node tools/build-notify.mjs` inlines logic.js above this file → dist/notify.ts, which is what gets deployed.
// Secrets (Supabase → Edge Functions → Secrets): HOOK_SECRET, NTFY_TOPIC, GMAIL_USER, GMAIL_APP_PASSWORD, optional EMAIL_TO, APP_URL
// ─────────────────────────────────────────────────────────────────────────────
import nodemailer from 'npm:nodemailer@6.9.14';
import { createClient } from 'npm:@supabase/supabase-js@2';

const TZ = 'America/Toronto';
const env = k => Deno.env.get(k);
const APP_URL = env('APP_URL') || 'https://glow2411.github.io/life-os/';

function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const fmtLocal = ts => new Date(ts).toLocaleString('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const localDate = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));

// ── channels ──
async function sendPush({ title, message, click = APP_URL, priority = 3, tags = [] }) {
  const topic = env('NTFY_TOPIC');
  if (!topic) throw new Error('NTFY_TOPIC secret not set');
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message, click, priority, tags }),
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
}
let transport;
async function sendEmail({ to, subject, html, text }) {
  if (!env('GMAIL_USER') || !env('GMAIL_APP_PASSWORD')) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD secrets not set');
  transport ||= nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: env('GMAIL_USER'), pass: env('GMAIL_APP_PASSWORD') } });
  await transport.sendMail({ from: `Life OS <${env('GMAIL_USER')}>`, to, subject, html, text });
}
// msg = { push: {...}, email: {subject, html, text} }
async function deliver(channel, to, msg) {
  const done = [], errors = [];
  if (channel === 'push' || channel === 'both') {
    try { await sendPush(msg.push); done.push('push'); } catch (e) { errors.push(String(e.message || e)); }
  }
  if (channel === 'email' || channel === 'both') {
    try { await sendEmail({ to, ...msg.email }); done.push('email'); } catch (e) { errors.push(String(e.message || e)); }
  }
  return { done, errors };
}

function reminderMessage(r) {
  const when = fmtLocal(r.next_at);
  const body = r.notes || 'Reminder';
  return {
    push: { title: r.title, message: `${body}\n${when}`, click: APP_URL + '#reminders', priority: 4, tags: ['alarm_clock'] },
    email: {
      subject: `⏰ ${r.title}`,
      text: `${r.title}\n${body}\n${when}\n\n${APP_URL}#reminders`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1d2327">
        <h2 style="margin:0 0 6px">⏰ ${escHtml(r.title)}</h2>
        <div style="color:#6b7378">${escHtml(when)}${r.repeat && r.repeat !== 'none' ? ' · ' + escHtml(REPEAT_LABEL[r.repeat]) : ''}</div>
        ${r.notes ? `<p style="white-space:pre-wrap">${escHtml(r.notes)}</p>` : ''}
        <p><a href="${APP_URL}#reminders" style="background:#1f4e5f;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600">Open reminders</a></p></div>`,
    },
  };
}

async function loadUserData(sb, uid) {
  const q = t => sb.from(t).select('*').eq('user_id', uid).then(({ data, error }) => { if (error) throw error; return data; });
  const [people, calls, vehicles, items, tasks, taskDone, reminders] =
    await Promise.all(['people', 'calls', 'vehicles', 'service_items', 'tasks', 'task_done', 'reminders'].map(q));
  return { people, calls, vehicles, items, tasks, taskDone, reminders };
}

// Agenda for daily alerts. Reminders are added here (not via buildAgenda) so their day is computed in Toronto time.
function dailyAgenda(data, today) {
  const agenda = buildAgenda({ ...data, reminders: [] }, today);
  for (const r of data.reminders) {
    if (r.done || localDate(r.next_at) !== today) continue;
    agenda.push({ kind: 'reminder', level: 'soon', id: r.id, title: r.title, detail: `today at ${fmtLocal(r.next_at)}` });
  }
  return agenda;
}

async function runForUser(sb, user, now, opts, log) {
  const uid = user.id;
  const to = env('EMAIL_TO') || user.email;
  const { data: prefs = [] } = await sb.from('notify_prefs').select('*').eq('user_id', uid);

  // Manual test: POST {"test":"push"|"email"|"both"}
  if (opts.test) {
    const r = await deliver(opts.test, to, {
      push: { title: 'Life OS test', message: `Push works ✅ (${fmtLocal(new Date())})`, tags: ['white_check_mark'] },
      email: { subject: 'Life OS test ✅', text: 'Email works.', html: '<p>Email from Life OS works ✅</p>' },
    });
    log.push({ user: uid, test: opts.test, ...r });
    return;
  }

  // 1) Timed reminders
  const { data: due = [] } = await sb.from('reminders').select('*').eq('user_id', uid).eq('done', false)
    .lte('next_at', new Date().toISOString()).order('next_at').limit(20);
  for (const r of due.filter(r => !r.sent_at || new Date(r.sent_at) < new Date(r.next_at))) {
    const channel = r.channel || prefFor(prefs, 'reminders').channel;
    const res = channel === 'off' ? { done: [], errors: [] } : await deliver(channel, to, reminderMessage(r));
    let update = { sent_at: new Date().toISOString() };
    if (r.repeat && r.repeat !== 'none') {
      const after = new Date(Math.max(Date.now(), new Date(r.next_at).getTime())).toISOString();
      const { data: next } = await sb.rpc('lifeos_next_occurrence', { anchor: r.remind_at, rep: r.repeat, after_ts: after });
      if (next) update.next_at = next;
    }
    await sb.from('reminders').update(update).eq('id', r.id);
    log.push({ user: uid, reminder: r.title, channel, ...res });
  }

  // 2) Daily module alerts
  let data;
  for (const m of MODULES.filter(m => m.kind === 'daily')) {
    const pref = prefFor(prefs, m.key);
    const forced = opts.module === m.key;
    if (!forced) {
      if (pref.channel === 'off' || !pref.alert_time || now.time < String(pref.alert_time).slice(0, 5)) continue;
      const { data: sent } = await sb.from('notify_log').select('module').eq('user_id', uid).eq('module', m.key).eq('sent_on', now.date);
      if (sent?.length) continue;
      await sb.from('notify_log').insert({ user_id: uid, module: m.key, sent_on: now.date });   // claim first → never double-sends
    }
    data ||= await loadUserData(sb, uid);
    const items = agendaForModule(m.key, dailyAgenda(data, now.date));
    if (!items.length) { log.push({ user: uid, module: m.key, skipped: 'nothing due' }); continue; }
    const heading = m.key === 'summary' ? 'Life OS' : m.label.replace(/ \(.*\)/, '');
    const msg = {
      push: { ...renderAgendaPush(items, heading), click: APP_URL, tags: ['calendar'] },
      email: renderAgendaEmail(items, now.date, APP_URL, heading),
    };
    const res = await deliver(forced && opts.channel ? opts.channel : pref.channel, to, msg);
    log.push({ user: uid, module: m.key, items: items.length, ...res });
  }
}

Deno.serve(async req => {
  if (!env('HOOK_SECRET') || req.headers.get('x-hook-secret') !== env('HOOK_SECRET')) {
    return new Response('unauthorized', { status: 401 });
  }
  const opts = await req.json().catch(() => ({}));   // {} | {test:'push'} | {module:'tasks', channel:'email'}
  // Supabase injects the service key; name differs between legacy (SERVICE_ROLE_KEY) and new (SECRET_KEY[S]) projects
  let key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY');
  if (!key && env('SUPABASE_SECRET_KEYS')) { try { key = Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS')))[0]; } catch { /* ignore */ } }
  const sb = createClient(env('SUPABASE_URL'), key, { auth: { persistSession: false } });
  const now = localNow();
  const log = [];
  try {
    const { data, error } = await sb.auth.admin.listUsers();
    if (error) throw error;
    for (const user of data.users) await runForUser(sb, user, now, opts, log);
    return Response.json({ ok: true, now, log });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, now, error: String(e.message || e), log }, { status: 500 });
  }
});
