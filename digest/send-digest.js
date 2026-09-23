// Daily email digest: reads your Supabase data, works out what's due, emails you a summary.
// Runs on GitHub Actions (see .github/workflows/daily-digest.yml). Secrets come from env vars.
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { buildAgenda, todayStr, renderAgendaEmail } from '../logic.js';

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

export { renderAgendaEmail as renderEmail };

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
  const mail = renderAgendaEmail(agenda, today, APP_URL);
  if (DRY_RUN === 'true') { console.log('\nDRY RUN — subject:', mail.subject); return; }

  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await tx.sendMail({ from: `Life OS <${GMAIL_USER}>`, to: DIGEST_TO || GMAIL_USER, ...mail });
  console.log('Email sent to', DIGEST_TO || GMAIL_USER);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
