// Daily email digest: reads your Supabase data, works out what's due, emails you a summary.
// Runs on GitHub Actions (see .github/workflows/daily-digest.yml). Secrets come from env vars.
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { buildAgenda, todayStr } from '../logic.js';

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO,
  APP_URL = '', SEND_WHEN_EMPTY = 'false', DRY_RUN = 'false',
} = process.env;

let sb;
async function all(table) {
  const { data, error } = await sb.from(table).select('*');
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON = { call: '📞', birthday: '🎂', service: '🔧', odometer: '🚗', renewal: '📄', task: '✅', reminder: '⏰' };

export function renderEmail(agenda, today, appUrl) {
  const due = agenda.filter(a => a.level === 'due'), soon = agenda.filter(a => a.level === 'soon');
  const section = (title, list, color) => list.length ? `
    <h3 style="margin:20px 0 8px;color:${color};font-size:15px">${title}</h3>
    ${list.map(a => `<div style="padding:10px 12px;border:1px solid #e4e2dc;border-radius:10px;margin-bottom:8px">
      <div style="font-weight:600">${ICON[a.kind] || '•'} ${esc(a.title)}</div>
      <div style="color:#6b7378;font-size:14px">${esc(a.detail)}</div>
      ${a.extra ? `<div style="color:#6b7378;font-size:14px;margin-top:4px">${esc(a.extra)}</div>` : ''}</div>`).join('')}` : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;color:#1d2327">
    <h2 style="margin:0 0 4px">Life OS · ${today}</h2>
    <div style="color:#6b7378">${agenda.length ? `${agenda.length} item${agenda.length > 1 ? 's' : ''} need attention` : 'Nothing due today ✅'}</div>
    ${section('Due now', due, '#b3261e')}${section('Coming up', soon, '#8a5a00')}
    ${appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}" style="background:#1f4e5f;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600">Open Life OS</a></p>` : ''}
  </div>`;
  const text = [`Life OS · ${today}`, ...agenda.map(a => `- [${a.level.toUpperCase()}] ${a.title} — ${a.detail}${a.extra ? `\n    ${a.extra}` : ''}`), appUrl].join('\n');
  const subject = due.length ? `Life OS: ${due.length} due today — ${due.slice(0, 2).map(a => a.title).join(', ')}${due.length > 2 ? '…' : ''}`
    : agenda.length ? `Life OS: ${agenda.length} coming up` : 'Life OS: all clear';
  return { html, text, subject };
}

async function main() {
  const required = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ...(DRY_RUN === 'true' ? {} : { GMAIL_USER, GMAIL_APP_PASSWORD }) };
  for (const [k, v] of Object.entries(required)) if (!v) throw new Error(`Missing secret: ${k}`);
  sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const today = todayStr();
  const [people, calls, vehicles, items, tasks, taskDone, reminders] =
    await Promise.all(['people', 'calls', 'vehicles', 'service_items', 'tasks', 'task_done', 'reminders'].map(all));
  const agenda = buildAgenda({ people, calls, vehicles, items, tasks, taskDone, reminders }, today);
  console.log(`${today}: ${agenda.length} agenda item(s)`);
  agenda.forEach(a => console.log(` - [${a.level}] ${a.title}: ${a.detail}`));

  if (!agenda.length && SEND_WHEN_EMPTY !== 'true') { console.log('Nothing due — no email sent.'); return; }
  const mail = renderEmail(agenda, today, APP_URL);
  if (DRY_RUN === 'true') { console.log('\nDRY RUN — subject:', mail.subject); return; }

  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await tx.sendMail({ from: `Life OS <${GMAIL_USER}>`, to: DIGEST_TO || GMAIL_USER, ...mail });
  console.log('Email sent to', DIGEST_TO || GMAIL_USER);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
