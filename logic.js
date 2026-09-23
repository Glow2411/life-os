// Shared "what's due" logic — used by the app (browser) and the daily email digest (Node).

export const SOON_DAYS = 14;     // flag things due within 2 weeks
export const SOON_KM = 1000;     // …or within 1,000 km
export const ODOMETER_STALE_DAYS = 30;

// Default Kia K4 schedule (dealer-published intervals, converted to km).
// Edit freely in the app — check your owner's manual for Canadian/severe conditions.
export const KIA_K4_SCHEDULE = [
  { name: 'Oil & filter change',            interval_km: 12000, interval_months: 6 },
  { name: 'Tire rotation',                  interval_km: 12000, interval_months: 6 },
  { name: 'Brake inspection',               interval_km: 12000, interval_months: 6 },
  { name: 'Cabin air filter',               interval_km: 24000, interval_months: 12 },
  { name: 'Cooling / suspension / exhaust inspection', interval_km: 24000, interval_months: 12 },
  { name: 'Engine air filter',              interval_km: 48000, interval_months: 24 },
  { name: 'Drive belts & hoses inspection', interval_km: 48000, interval_months: 24 },
  { name: 'Brake fluid replacement',        interval_km: 72000, interval_months: 36 },
  { name: 'Wheel alignment check',          interval_km: 72000, interval_months: 36 },
  { name: 'Spark plugs / transmission fluid check', interval_km: 96000, interval_months: 48 },
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
export function buildAgenda({ people = [], calls = [], vehicles = [], items = [] }, today = todayStr()) {
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
  const rank = { due: 0, soon: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
