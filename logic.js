// Shared "what's due" logic — used by the app (browser) and the daily email digest (Node).

export const SOON_DAYS = 14;     // flag things due within 2 weeks
export const SOON_KM = 1000;     // …or within 1,000 km
export const ODOMETER_STALE_DAYS = 30;

// Default Kia K4 (1.6L Turbo) schedule — Kia Canada severe conditions. Edit freely in the app.
export const KIA_K4_SCHEDULE = [
  { name: 'Engine oil & filter – replace', interval_km: 6000, interval_months: 6 },
  { name: 'Brakes – pads, discs, calipers, lines & parking brake inspection', interval_km: 6000, interval_months: 6 },
  { name: 'Tire rotation', interval_km: 12000, interval_months: 12 },
  { name: 'Cabin (climate control) air filter – replace', interval_km: 12000, interval_months: 12 },
  { name: 'Suspension, steering & drive shaft boots inspection', interval_km: 12000, interval_months: 12 },
  { name: 'Multi-point inspection – cooling, exhaust, fuel & vacuum lines, A/C, brake fluid level', interval_km: 12000, interval_months: 12 },
  { name: 'Engine air filter – replace', interval_km: 24000, interval_months: 24 },
  { name: 'Brake fluid – replace', interval_km: 72000, interval_months: 48 },
  { name: 'Spark plugs – replace (1.6L Turbo)', interval_km: 72000, interval_months: null },
  { name: 'Automatic transmission fluid – replace (8-speed)', interval_km: 91000, interval_months: null },
  { name: 'Drive belt, tensioner & pulleys inspection', interval_km: null, interval_months: 84 },
  { name: 'Engine coolant – replace', interval_km: 195000, interval_months: 120 },
];

// ── date helpers (all dates are 'YYYY-MM-DD' strings, local time) ──
export function todayStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parse(s) { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return todayStr(d); }
export function addMonths(s, n) {
  const d = parse(s); const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return todayStr(d);
}
export function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }

// ── People ──
export function lastCall(person, calls) {
  return calls.filter(c => c.person_id === person.id)
              .sort((a, b) => b.call_date.localeCompare(a.call_date))[0] || null;
}

export function personStatus(person, calls, today = todayStr()) {
  if (!person.call_every_days) return { state: 'none' };
  const last = lastCall(person, calls);
  const base = last ? last.call_date : (person.created_at || today).slice(0, 10);
  let due = addDays(base, person.call_every_days);
  if (person.snooze_until && person.snooze_until > due) due = person.snooze_until;
  const days = daysBetween(today, due);
  return { state: days <= 0 ? 'due' : days <= 3 ? 'soon' : 'ok', due, days, last };
}

export function nextBirthday(birthday, today = todayStr()) {
  if (!birthday) return null;
  const y = Number(today.slice(0, 4));
  let d = `${y}${birthday.slice(4, 10)}`;
  if (d < today) d = `${y + 1}${birthday.slice(4, 10)}`;
  return { date: d, days: daysBetween(today, d) };
}

// ── Garage ──
export function serviceStatus(item, vehicle, today = todayStr()) {
  const baseKm = item.last_done_km ?? vehicle.purchase_km ?? 0;
  const baseDate = item.last_done_date || vehicle.purchase_date || null;
  const dueKm = item.interval_km ? baseKm + item.interval_km : null;
  const dueDate = item.interval_months && baseDate ? addMonths(baseDate, item.interval_months) : null;
  const kmLeft = dueKm != null ? dueKm - (vehicle.current_km || 0) : null;
  const daysLeft = dueDate ? daysBetween(today, dueDate) : null;
  let state = 'ok';
  if ((kmLeft != null && kmLeft <= 0) || (daysLeft != null && daysLeft <= 0)) state = 'due';
  else if ((kmLeft != null && kmLeft <= SOON_KM) || (daysLeft != null && daysLeft <= SOON_DAYS)) state = 'soon';
  return { state, dueKm, dueDate, kmLeft, daysLeft };
}

export function describeService(st) {
  const parts = [];
  if (st.kmLeft != null) parts.push(st.kmLeft <= 0 ? `${fmtKm(-st.kmLeft)} km overdue` : `in ${fmtKm(st.kmLeft)} km`);
  if (st.daysLeft != null) parts.push(st.daysLeft <= 0 ? `${-st.daysLeft} days overdue` : `by ${st.dueDate}`);
  return parts.join(' · ') || 'no interval set';
}

export function fmtKm(n) { return Number(n || 0).toLocaleString('en-CA'); }

// ── Everything due, in one list (Today screen + email digest) ──
export function buildAgenda({ people = [], calls = [], vehicles = [], items = [], tasks = [], taskDone = [], reminders = [] }, today = todayStr()) {
  const out = [];
  for (const p of people) {
    const st = personStatus(p, calls, today);
    if (st.state === 'due' || st.state === 'soon') {
      out.push({
        kind: 'call', level: st.state, id: p.id,
        title: `Call ${p.name}`,
        detail: st.state === 'due'
          ? (st.days === 0 ? 'due today' : `${-st.days} days overdue`)
          : `due in ${st.days} days`,
        extra: st.last ? `Last call ${st.last.call_date}: ${st.last.summary || '(no notes)'}` : 'No calls logged yet',
      });
    }
    const bd = nextBirthday(p.birthday, today);
    if (bd && bd.days <= 7) {
      out.push({ kind: 'birthday', level: bd.days === 0 ? 'due' : 'soon', id: p.id,
        title: `${p.name}'s birthday`, detail: bd.days === 0 ? 'today' : `in ${bd.days} days (${bd.date})` });
    }
  }
  for (const v of vehicles) {
    for (const it of items.filter(i => i.vehicle_id === v.id)) {
      const st = serviceStatus(it, v, today);
      if (st.state !== 'ok') out.push({ kind: 'service', level: st.state, id: v.id,
        title: `${v.name}: ${it.name}`, detail: describeService(st) });
    }
    if (v.km_updated_at && daysBetween(v.km_updated_at, today) >= ODOMETER_STALE_DAYS) {
      out.push({ kind: 'odometer', level: 'soon', id: v.id,
        title: `${v.name}: update odometer`, detail: `last updated ${v.km_updated_at} (${fmtKm(v.current_km)} km)` });
    }
    for (const [field, label] of [['insurance_expiry', 'insurance'], ['registration_expiry', 'registration']]) {
      if (!v[field]) continue;
      const d = daysBetween(today, v[field]);
      if (d <= 30) out.push({ kind: 'renewal', level: d <= 0 ? 'due' : 'soon', id: v.id,
        title: `${v.name}: ${label} renewal`, detail: d <= 0 ? `expired ${v[field]}` : `expires in ${d} days` });
    }
  }
  for (const t of tasks) {
    if (!taskDueOn(t, today) || isTaskDone(t.id, today, taskDone)) continue;
    const s = taskStreak(t, taskDone, today);
    out.push({ kind: 'task', level: 'due', id: t.id, title: t.title,
      detail: `${describeRepeat(t)}${s ? ` · ${s}-day streak` : ''}` });
  }
  for (const r of reminders) {
    if (r.done || !r.next_at) continue;
    const day = todayStr(new Date(r.next_at));
    if (day > today) continue;
    out.push({ kind: 'reminder', level: day < today ? 'due' : 'soon', id: r.id, title: r.title,
      detail: day < today ? `was due ${fmtDateTime(r.next_at)}` : `today at ${fmtTime(r.next_at)}` });
  }
  const rank = { due: 0, soon: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ── Daily tasks ──
// repeat_type: 'interval' (every N days, optionally weekdays only) | 'weekdays' (specific days of week)
// weekdays: array of 0-6 (0 = Sunday)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = s => parse(s).getDay();
const isWeekend = s => dow(s) === 0 || dow(s) === 6;

function weekdaysBetween(a, b) {           // count of Mon–Fri days in (a, b]
  let n = 0;
  for (let d = a; d < b; ) { d = addDays(d, 1); if (!isWeekend(d)) n++; }
  return n;
}

export function taskDueOn(task, date) {
  if (task.active === false) return false;
  const start = task.start_date || date;
  if (date < start) return false;
  if (task.repeat_type === 'weekdays') return (task.weekdays || []).includes(dow(date));
  const every = Math.max(1, task.every_n || 1);
  if (task.skip_weekends) {
    if (isWeekend(date)) return false;
    // anchor on the first weekday on/after start
    let anchor = start; while (isWeekend(anchor)) anchor = addDays(anchor, 1);
    if (date < anchor) return false;
    return weekdaysBetween(anchor, date) % every === 0;
  }
  return daysBetween(start, date) % every === 0;
}

export function describeRepeat(t) {
  if (t.repeat_type === 'weekdays') {
    const w = [...(t.weekdays || [])].sort();
    return w.length ? w.map(i => DOW[i]).join(', ') : 'no days picked';
  }
  const n = Math.max(1, t.every_n || 1);
  const base = n === 1 ? 'Every day' : n === 2 ? 'Alternate days' : `Every ${n} days`;
  return t.skip_weekends ? `${base} (weekdays only)` : base;
}

export function isTaskDone(taskId, date, taskDone) {
  return taskDone.some(d => d.task_id === taskId && d.done_date === date);
}

// consecutive scheduled occurrences completed, counting back from today
// (today not being done yet doesn't break the streak)
export function taskStreak(task, taskDone, today = todayStr()) {
  let streak = 0;
  for (let i = 0, d = today; i < 400; i++, d = addDays(d, -1)) {
    if (task.start_date && d < task.start_date) break;
    if (!taskDueOn(task, d)) continue;
    if (isTaskDone(task.id, d, taskDone)) streak++;
    else if (d !== today) break;
  }
  return streak;
}

// ── Reminders ──
export function fmtTime(ts) { return new Date(ts).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }); }
export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export const REPEAT_LABEL = { none: 'One-time', daily: 'Every day', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };

// ── Notifications ──
// Modules that can alert. 'timed' = fires at each item's own time; 'daily' = one message a day at alert_time.
export const MODULES = [
  { key: 'reminders', label: 'Reminders', kind: 'timed', kinds: ['reminder'] },
  { key: 'tasks',     label: 'Daily tasks', kind: 'daily', kinds: ['task'] },
  { key: 'people',    label: 'People (calls & birthdays)', kind: 'daily', kinds: ['call', 'birthday'] },
  { key: 'garage',    label: 'Garage (services & renewals)', kind: 'daily', kinds: ['service', 'odometer', 'renewal'] },
  { key: 'summary',   label: 'Morning summary (everything)', kind: 'daily', kinds: null },
];
export const CHANNEL_LABEL = { push: 'Push', email: 'Email', both: 'Push + Email', off: 'Off' };
export const DEFAULT_PREFS = {
  reminders: { channel: 'both', alert_time: null },
  tasks:     { channel: 'push', alert_time: '08:00' },
  people:    { channel: 'push', alert_time: '18:00' },
  garage:    { channel: 'email', alert_time: '08:00' },
  summary:   { channel: 'email', alert_time: '07:00' },
};
export function prefFor(prefs, module) {
  const p = prefs.find(x => x.module === module);
  return { ...DEFAULT_PREFS[module], ...(p || {}) };
}
export function agendaForModule(module, agenda) {
  const m = MODULES.find(x => x.key === module);
  return m?.kinds ? agenda.filter(a => m.kinds.includes(a.kind)) : agenda;
}

// ── Picklists ──
// Defaults used until you edit a list in Settings (edits are stored in the `picklists` table).
// `fields` documents where each list is used.
export const DEFAULT_LISTS = {
  relationship:  { label: 'Relationship', fields: 'People › Relationship',
    values: ['Friend', 'Close friend', 'Family', 'Relative', 'Colleague', 'Ex-colleague', 'Classmate', 'Neighbour', 'Mentor', 'Acquaintance'] },
  call_type:     { label: 'Call type', fields: 'People › Log a call',
    values: ['Phone call', 'Video call', 'WhatsApp call', 'In person', 'Text chat'] },
  car_make:      { label: 'Car make', fields: 'Garage › Make',
    values: ['Kia', 'Toyota', 'Honda', 'Hyundai', 'Mazda', 'Nissan', 'Subaru', 'Volkswagen', 'Ford', 'Chevrolet', 'Tesla', 'BMW', 'Mercedes-Benz', 'Audi', 'Lexus'] },
  car_color:     { label: 'Car colour', fields: 'Garage › Colour',
    values: ['White', 'Black', 'Grey', 'Silver', 'Blue', 'Red', 'Green', 'Brown', 'Beige'] },
  insurer:       { label: 'Insurer', fields: 'Garage › Insurer',
    values: ['Intact', 'Aviva', 'Desjardins', 'TD Insurance', 'Belairdirect', 'Economical', 'The Co-operators', 'Allstate', 'RBC Insurance', 'CAA Insurance', 'Sonnet', 'Wawanesa'] },
  oil_spec:      { label: 'Oil spec', fields: 'Garage › Oil spec',
    values: ['0W-20 full synthetic', '0W-30 full synthetic', '5W-20 full synthetic', '5W-30 full synthetic', '5W-30 synthetic blend'] },
  service_type:  { label: 'Service type', fields: 'Garage › Service item / service record',
    values: ['Engine oil & filter – replace', 'Tire rotation', 'Brake inspection', 'Cabin air filter – replace', 'Engine air filter – replace',
             'Brake fluid – replace', 'Spark plugs – replace', 'Transmission fluid – replace', 'Engine coolant – replace', 'Wheel alignment',
             'Battery check / replace', 'Wiper blades – replace', 'Winter tires on', 'Summer tires on', 'Multi-point inspection', 'Car wash / detailing'] },
  shop:          { label: 'Shop / installer', fields: 'Garage › Shop, Installed by',
    values: ['Kia dealer', 'Canadian Tire', 'Costco Tire Centre', 'Mr. Lube', 'Jiffy Lube', 'Midas', 'Kal Tire', 'Myself'] },
  mod_type:      { label: 'Accessory / mod', fields: 'Garage › Accessories & mods',
    values: ['All-weather floor mats', 'Window tint', 'Winter tires', 'Dash cam', 'Remote starter', 'Mud flaps', 'Roof rack', 'Seat covers', 'Paint protection film', 'Ceramic coating'] },
  tire_size:     { label: 'Tire size', fields: 'Garage › Tire size',
    values: ['205/55R16', '215/55R17', '225/45R18', '225/65R17', '235/65R18', '235/55R19'] },
  task_title:    { label: 'Task ideas', fields: 'Tasks › Task (suggestions)',
    values: ['Gym', 'Walk 10k steps', 'Vitamins', 'Read 20 min', 'Meditate', 'Apply to jobs', 'Learn / course', 'Drink 2L water', 'Journal', 'Tidy up 15 min'] },
  reminder_title:{ label: 'Reminder ideas', fields: 'Reminders › Remind me to (suggestions)',
    values: ['Pay rent', 'Pay credit card', 'Pay phone bill', 'Pay insurance', 'Doctor appointment', 'Dentist appointment', 'Renew licence', 'Call family', 'Take out garbage', 'Book service'] },
};

// ── Email rendering (used by the digest script and the notify Edge Function) ──
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const ICON = { call: '📞', birthday: '🎂', service: '🔧', odometer: '🚗', renewal: '📄', task: '✅', reminder: '⏰' };

export function renderAgendaEmail(agenda, today, appUrl, heading = 'Life OS') {
  const due = agenda.filter(a => a.level === 'due'), soon = agenda.filter(a => a.level === 'soon');
  const section = (title, list, color) => list.length ? `
    <h3 style="margin:20px 0 8px;color:${color};font-size:15px">${title}</h3>
    ${list.map(a => `<div style="padding:10px 12px;border:1px solid #e4e2dc;border-radius:10px;margin-bottom:8px">
      <div style="font-weight:600">${ICON[a.kind] || '•'} ${escHtml(a.title)}</div>
      <div style="color:#6b7378;font-size:14px">${escHtml(a.detail)}</div>
      ${a.extra ? `<div style="color:#6b7378;font-size:14px;margin-top:4px">${escHtml(a.extra)}</div>` : ''}</div>`).join('')}` : '';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;color:#1d2327">
    <h2 style="margin:0 0 4px">${escHtml(heading)} · ${today}</h2>
    <div style="color:#6b7378">${agenda.length ? `${agenda.length} item${agenda.length > 1 ? 's' : ''} need attention` : 'Nothing due today ✅'}</div>
    ${section('Due now', due, '#b3261e')}${section('Coming up', soon, '#8a5a00')}
    ${appUrl ? `<p style="margin-top:20px"><a href="${escHtml(appUrl)}" style="background:#1f4e5f;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600">Open Life OS</a></p>` : ''}
  </div>`;
  const text = [`${heading} · ${today}`, ...agenda.map(a => `- [${a.level.toUpperCase()}] ${a.title} — ${a.detail}${a.extra ? `\n    ${a.extra}` : ''}`), appUrl].join('\n');
  const subject = due.length ? `${heading}: ${due.length} due today — ${due.slice(0, 2).map(a => a.title).join(', ')}${due.length > 2 ? '…' : ''}`
    : agenda.length ? `${heading}: ${agenda.length} coming up` : `${heading}: all clear`;
  return { html, text, subject };
}


// Short text for a push notification (ntfy): title + up to 6 lines
export function renderAgendaPush(agenda, heading) {
  const lines = agenda.slice(0, 6).map(a => `${ICON[a.kind] || '•'} ${a.title} — ${a.detail}`);
  if (agenda.length > 6) lines.push(`…and ${agenda.length - 6} more`);
  return { title: `${heading}: ${agenda.length} item${agenda.length > 1 ? 's' : ''}`, message: lines.join('\n') };
}
