import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import {
  todayStr, addDays, buildAgenda, personStatus, lastCall, nextBirthday,
  serviceStatus, describeService, fmtKm, KIA_K4_SCHEDULE,
} from './logic.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');
const S = { people: [], calls: [], vehicles: [], items: [], log: [], mods: [] };

// ───────────── helpers ─────────────
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chip = (state, text) => `<span class="chip ${state}">${esc(text)}</span>`;
const byId = (list, id) => list.find(x => x.id === id);

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}

async function run(promise) {
  const { data, error } = await promise;
  if (error) { toast(error.message); throw error; }
  return data;
}

async function loadAll() {
  const [people, calls, vehicles, items, log, mods] = await Promise.all([
    run(sb.from('people').select('*').order('name')),
    run(sb.from('calls').select('*').order('call_date', { ascending: false })),
    run(sb.from('vehicles').select('*').order('created_at')),
    run(sb.from('service_items').select('*').order('interval_km', { nullsFirst: false })),
    run(sb.from('service_log').select('*').order('done_date', { ascending: false })),
    run(sb.from('mods').select('*').order('added_date', { ascending: false, nullsFirst: false })),
  ]);
  Object.assign(S, { people, calls, vehicles, items, log, mods });
}

// ───────────── generic form sheet ─────────────
// field: { k, label, type: text|number|date|textarea|tel, required, half }
function openForm({ title, subtitle, fields, values = {}, saveLabel = 'Save', onSave, onDelete }) {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  const input = f => {
    const v = values[f.k] ?? '';
    const common = `name="${f.k}" id="f_${f.k}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}"`;
    const el = f.type === 'textarea'
      ? `<textarea ${common}>${esc(v)}</textarea>`
      : `<input ${common} type="${f.type || 'text'}" value="${esc(v)}" ${f.type === 'number' ? 'inputmode="numeric"' : ''}>`;
    return `<div><label for="f_${f.k}">${esc(f.label)}${f.required ? ' *' : ''}</label>${el}</div>`;
  };
  // pair up consecutive half-width fields
  let html = '', i = 0;
  while (i < fields.length) {
    if (fields[i].half && fields[i + 1]?.half) { html += `<div class="two">${input(fields[i])}${input(fields[i + 1])}</div>`; i += 2; }
    else { html += input(fields[i]); i += 1; }
  }
  bg.innerHTML = `<form class="sheet">
      <h3>${esc(title)}</h3>${subtitle ? `<div class="muted">${esc(subtitle)}</div>` : ''}
      ${html}
      <div class="actions">
        <button type="submit">${esc(saveLabel)}</button>
        <button type="button" class="ghost" data-x="cancel">Cancel</button>
        ${onDelete ? '<button type="button" class="danger" data-x="delete" style="margin-left:auto">Delete</button>' : ''}
      </div></form>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg || e.target.dataset.x === 'cancel') close(); });
  bg.querySelector('[data-x="delete"]')?.addEventListener('click', async () => {
    if (!confirm('Delete this permanently?')) return;
    await onDelete(); close(); await refresh();
  });
  bg.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      const raw = e.target.elements[f.k].value.trim();
      out[f.k] = raw === '' ? null : f.type === 'number' ? Number(raw) : raw;
    }
    e.submitter && (e.submitter.disabled = true);
    try { await onSave(out); close(); await refresh(); }
    catch { e.submitter && (e.submitter.disabled = false); }
  });
  document.body.appendChild(bg);
  bg.querySelector('input, textarea')?.focus();
}

// ───────────── field definitions ─────────────
const PERSON_FIELDS = [
  { k: 'name', label: 'Name', required: true },
  { k: 'phone', label: 'Phone', type: 'tel', half: true },
  { k: 'relationship', label: 'Relationship', placeholder: 'friend, family…', half: true },
  { k: 'company', label: 'Works at', half: true },
  { k: 'job_title', label: 'Role', half: true },
  { k: 'city', label: 'City', half: true },
  { k: 'birthday', label: 'Birthday', type: 'date', half: true },
  { k: 'partner_name', label: 'Partner' },
  { k: 'kids', label: 'Kids', placeholder: 'e.g. Aarav (5), Meera (2)' },
  { k: 'interests', label: 'Interests', placeholder: 'cricket, hiking, new house…' },
  { k: 'notes', label: 'Other notes', type: 'textarea' },
  { k: 'call_every_days', label: 'Remind me to call every (days) — blank = never', type: 'number' },
];
const CALL_FIELDS = [
  { k: 'call_date', label: 'Date', type: 'date', required: true },
  { k: 'summary', label: 'What did you talk about?', type: 'textarea' },
  { k: 'follow_ups', label: 'Ask about next time', type: 'textarea', placeholder: 'job interview result, trip to India…' },
];
const VEHICLE_FIELDS = [
  { k: 'name', label: 'Nickname', required: true },
  { k: 'make', label: 'Make', half: true }, { k: 'model', label: 'Model', half: true },
  { k: 'year', label: 'Year', type: 'number', half: true }, { k: 'trim', label: 'Trim', half: true },
  { k: 'color', label: 'Colour', half: true }, { k: 'plate', label: 'Plate', half: true },
  { k: 'vin', label: 'VIN' },
  { k: 'purchase_date', label: 'Purchase date', type: 'date', half: true },
  { k: 'purchase_km', label: 'Km at purchase', type: 'number', half: true },
  { k: 'current_km', label: 'Current odometer (km)', type: 'number' },
  { k: 'insurance_provider', label: 'Insurer', half: true }, { k: 'insurance_policy', label: 'Policy #', half: true },
  { k: 'insurance_expiry', label: 'Insurance renews', type: 'date', half: true },
  { k: 'registration_expiry', label: 'Plate sticker expires', type: 'date', half: true },
  { k: 'tire_size', label: 'Tire size', half: true }, { k: 'oil_spec', label: 'Oil spec', half: true },
  { k: 'notes', label: 'Notes', type: 'textarea' },
];
const ITEM_FIELDS = [
  { k: 'name', label: 'Service', required: true },
  { k: 'interval_km', label: 'Every (km)', type: 'number', half: true },
  { k: 'interval_months', label: 'Every (months)', type: 'number', half: true },
  { k: 'last_done_km', label: 'Last done at (km)', type: 'number', half: true },
  { k: 'last_done_date', label: 'Last done on', type: 'date', half: true },
  { k: 'notes', label: 'Notes', type: 'textarea' },
];
const LOG_FIELDS = [
  { k: 'title', label: 'What was done', required: true },
  { k: 'done_date', label: 'Date', type: 'date', required: true, half: true },
  { k: 'km', label: 'Odometer (km)', type: 'number', half: true },
  { k: 'shop', label: 'Shop', half: true },
  { k: 'cost', label: 'Cost ($)', type: 'number', half: true },
  { k: 'notes', label: 'Notes', type: 'textarea' },
];
const MOD_FIELDS = [
  { k: 'name', label: 'What was added', required: true },
  { k: 'added_date', label: 'Date', type: 'date', half: true },
  { k: 'cost', label: 'Cost ($)', type: 'number', half: true },
  { k: 'installer', label: 'Installed by' },
  { k: 'notes', label: 'Notes', type: 'textarea' },
];

// ───────────── actions ─────────────
const save = (table, row, id) => id ? run(sb.from(table).update(row).eq('id', id)) : run(sb.from(table).insert(row));
const del = (table, id) => run(sb.from(table).delete().eq('id', id));

const A = {
  addPerson: () => openForm({ title: 'Add person', fields: PERSON_FIELDS, values: { call_every_days: 21 },
    onSave: v => save('people', v) }),
  editPerson: id => openForm({ title: 'Edit person', fields: PERSON_FIELDS, values: byId(S.people, id),
    onSave: v => save('people', v, id), onDelete: async () => { await del('people', id); location.hash = '#people'; } }),
  logCall: id => {
    const p = byId(S.people, id);
    openForm({ title: `Log call with ${p.name}`, fields: CALL_FIELDS, values: { call_date: todayStr() },
      onSave: async v => { await save('calls', { ...v, person_id: id }); if (p.snooze_until) await save('people', { snooze_until: null }, id); } });
  },
  editCall: id => openForm({ title: 'Edit call', fields: CALL_FIELDS, values: byId(S.calls, id),
    onSave: v => save('calls', v, id), onDelete: () => del('calls', id) }),
  snooze: async (id, days) => { await save('people', { snooze_until: addDays(todayStr(), days) }, id); toast(`Snoozed ${days} days`); await refresh(); },

  addVehicle: (preset = {}) => openForm({ title: 'Add vehicle', fields: VEHICLE_FIELDS, values: { current_km: 0, purchase_km: 0, ...preset },
    onSave: async v => {
      const [row] = await run(sb.from('vehicles').insert({ ...v, km_updated_at: todayStr() }).select());
      if (preset.withK4Schedule) await loadK4(row.id);
    } }),
  editVehicle: id => openForm({ title: 'Edit vehicle', fields: VEHICLE_FIELDS, values: byId(S.vehicles, id),
    onSave: v => save('vehicles', v, id), onDelete: async () => { await del('vehicles', id); location.hash = '#garage'; } }),
  odometer: id => {
    const v = byId(S.vehicles, id);
    openForm({ title: 'Update odometer', subtitle: `Last: ${fmtKm(v.current_km)} km on ${v.km_updated_at || '—'}`,
      fields: [{ k: 'current_km', label: 'Current km', type: 'number', required: true }], values: { current_km: v.current_km },
      onSave: x => save('vehicles', { current_km: x.current_km, km_updated_at: todayStr() }, id) });
  },
  addItem: vid => openForm({ title: 'Add service item', fields: ITEM_FIELDS, onSave: v => save('service_items', { ...v, vehicle_id: vid }) }),
  editItem: id => openForm({ title: 'Edit service item', fields: ITEM_FIELDS, values: byId(S.items, id),
    onSave: v => save('service_items', v, id), onDelete: () => del('service_items', id) }),
  markDone: id => {
    const it = byId(S.items, id), v = byId(S.vehicles, it.vehicle_id);
    openForm({ title: `Done: ${it.name}`, saveLabel: 'Mark done', fields: LOG_FIELDS.filter(f => f.k !== 'title'),
      values: { done_date: todayStr(), km: v.current_km },
      onSave: async x => {
        await save('service_log', { ...x, title: it.name, vehicle_id: v.id, service_item_id: it.id });
        await save('service_items', { last_done_km: x.km, last_done_date: x.done_date }, it.id);
        if (x.km != null && x.km > (v.current_km || 0)) await save('vehicles', { current_km: x.km, km_updated_at: todayStr() }, v.id);
      } });
  },
  addLog: vid => openForm({ title: 'Log other service / repair', fields: LOG_FIELDS,
    values: { done_date: todayStr(), km: byId(S.vehicles, vid).current_km }, onSave: v => save('service_log', { ...v, vehicle_id: vid }) }),
  editLog: id => openForm({ title: 'Edit service record', fields: LOG_FIELDS, values: byId(S.log, id),
    onSave: v => save('service_log', v, id), onDelete: () => del('service_log', id) }),
  addMod: vid => openForm({ title: 'Add accessory / mod', fields: MOD_FIELDS, values: { added_date: todayStr() },
    onSave: v => save('mods', { ...v, vehicle_id: vid }) }),
  editMod: id => openForm({ title: 'Edit accessory / mod', fields: MOD_FIELDS, values: byId(S.mods, id),
    onSave: v => save('mods', v, id), onDelete: () => del('mods', id) }),
  loadK4: async vid => { await loadK4(vid); await refresh(); },
  signOut: async () => { await sb.auth.signOut(); location.hash = ''; boot(); },
};

async function loadK4(vehicleId) {
  await run(sb.from('service_items').insert(KIA_K4_SCHEDULE.map(s => ({ ...s, vehicle_id: vehicleId }))));
  toast('Kia K4 schedule loaded — edit intervals to match your manual');
}

// one click handler for everything with data-a="action" data-id="…" data-n="…"
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  e.preventDefault();
  const { a, id, n } = el.dataset;
  if (a === 'go') { location.hash = id; return; }
  if (a === 'addVehicleK4') { A.addVehicle({ name: 'Kia K4', make: 'Kia', model: 'K4', withK4Schedule: true }); return; }
  A[a]?.(id, n ? Number(n) : undefined);
});

// ───────────── screens ─────────────
const TABS = [['today', '📋', 'Today'], ['people', '👥', 'People'], ['garage', '🚗', 'Garage']];
function shell(title, body, tab, headerRight = '') {
  app.innerHTML = `
    <header class="top"><h1>${esc(title)}</h1>${headerRight}</header>
    <main>${body}</main>
    <nav class="tabs">${TABS.map(([k, ico, label]) =>
      `<a href="#${k}" class="${tab === k ? 'on' : ''}"><span class="ico">${ico}</span>${label}</a>`).join('')}</nav>`;
}

function screenToday() {
  const agenda = buildAgenda({ people: S.people, calls: S.calls, vehicles: S.vehicles, items: S.items });
  const target = x => (x.kind === 'call' || x.kind === 'birthday') ? `#person/${x.id}` : `#vehicle/${x.id}`;
  const body = agenda.length
    ? `<div class="card"><h2>${agenda.length} thing${agenda.length > 1 ? 's' : ''} need attention</h2>${agenda.map(x => `
        <div class="row tap" data-a="go" data-id="${target(x)}">
          <div class="grow"><div class="title">${esc(x.title)}</div>
            <div class="sub">${esc(x.detail)}</div>${x.extra ? `<div class="sub">${esc(x.extra)}</div>` : ''}</div>
          ${chip(x.level, x.level === 'due' ? 'Due' : 'Soon')}
        </div>`).join('')}</div>`
    : `<div class="card empty">✅ Nothing due. Enjoy the day.</div>`;
  const d = new Date().toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  shell(d, body, 'today', `<button class="ghost small" data-a="signOut">Sign out</button>`);
}

function screenPeople() {
  const rows = S.people.map(p => ({ p, st: personStatus(p, S.calls) }))
    .sort((a, b) => (a.st.days ?? 1e9) - (b.st.days ?? 1e9));
  const body = rows.length ? `<div class="card">${rows.map(({ p, st }) => `
      <div class="row tap" data-a="go" data-id="#person/${p.id}">
        <div class="grow"><div class="title">${esc(p.name)}</div>
          <div class="sub">${esc([p.job_title, p.company].filter(Boolean).join(' @ ') || p.relationship || '')}</div></div>
        ${st.state === 'none' ? chip('none', 'No reminder')
          : chip(st.state, st.days <= 0 ? 'Call now' : `in ${st.days}d`)}
      </div>`).join('')}</div>`
    : `<div class="card empty">No one here yet.<br>Add the people you want to keep in touch with.</div>`;
  shell('People', body, 'people', `<button class="small" data-a="addPerson">+ Add</button>`);
}

function screenPerson(id) {
  const p = byId(S.people, id);
  if (!p) return screenPeople();
  const st = personStatus(p, S.calls);
  const last = lastCall(p, S.calls);
  const history = S.calls.filter(c => c.person_id === id);
  const bd = nextBirthday(p.birthday);
  const facts = [
    ['Works', [p.job_title, p.company].filter(Boolean).join(' @ ')], ['City', p.city],
    ['Partner', p.partner_name], ['Kids', p.kids],
    ['Birthday', p.birthday ? `${p.birthday.slice(5)}${bd ? ` (in ${bd.days} days)` : ''}` : ''],
    ['Interests', p.interests], ['Relationship', p.relationship], ['Phone', p.phone],
  ].filter(([, v]) => v);
  const statusLine = st.state === 'none' ? 'No call reminder set'
    : st.days <= 0 ? `Call due${st.days < 0 ? ` (${-st.days} days overdue)` : ' today'}` : `Next call in ${st.days} days (${st.due})`;

  const body = `
    <div class="card">
      <div>${st.state !== 'none' ? chip(st.state, statusLine) : `<span class="muted">${statusLine}</span>`}</div>
      <div class="actions">
        ${p.phone ? `<a class="btn" href="tel:${esc(p.phone)}">📞 Call</a>` : ''}
        <button data-a="logCall" data-id="${id}">Log a call</button>
        ${st.state !== 'none' ? `<button class="ghost" data-a="snooze" data-id="${id}" data-n="7">Snooze 1 wk</button>` : ''}
      </div>
    </div>
    <div class="card"><h2>Before you call</h2>
      ${last ? `<div class="muted" style="font-size:14px">Last call · ${esc(last.call_date)}</div>
                <div class="note">${esc(last.summary || '(no notes)')}</div>
                ${last.follow_ups ? `<div style="margin-top:8px"><b>Ask about:</b> <span class="note">${esc(last.follow_ups)}</span></div>` : ''}`
             : '<div class="muted">No calls logged yet.</div>'}
    </div>
    <div class="card"><h2>About ${esc(p.name.split(' ')[0])}</h2>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '<div class="muted">No details yet.</div>'}
      ${p.notes ? `<div class="note" style="margin-top:10px">${esc(p.notes)}</div>` : ''}
      <div class="actions"><button class="ghost small" data-a="editPerson" data-id="${id}">Edit details</button></div>
    </div>
    <div class="card"><h2>Call history (${history.length})</h2>
      ${history.map(c => `<div class="row tap" data-a="editCall" data-id="${c.id}">
          <div class="grow"><div class="title">${esc(c.call_date)}</div><div class="sub note">${esc(c.summary || '(no notes)')}</div></div></div>`).join('')
        || '<div class="muted">Nothing yet.</div>'}
    </div>`;
  shell(p.name, body, 'people', `<a class="btn ghost small" href="#people">‹ Back</a>`);
}

function screenGarage() {
  const body = S.vehicles.length ? S.vehicles.map(v => {
    const sts = S.items.filter(i => i.vehicle_id === v.id).map(i => serviceStatus(i, v));
    const due = sts.filter(s => s.state === 'due').length, soon = sts.filter(s => s.state === 'soon').length;
    return `<div class="card tap" data-a="go" data-id="#vehicle/${v.id}">
      <div class="row"><div class="grow"><div class="title">${esc(v.name)}</div>
        <div class="sub">${esc([v.year, v.make, v.model, v.trim].filter(Boolean).join(' '))}</div></div>
        ${due ? chip('due', `${due} due`) : soon ? chip('soon', `${soon} soon`) : chip('ok', 'All good')}</div>
      <div class="big-num">${fmtKm(v.current_km)} <span class="muted" style="font-size:16px">km</span></div></div>`;
  }).join('') : `<div class="card empty">No vehicles yet.
      <div class="actions" style="justify-content:center">
        <button data-a="addVehicleK4">Add my Kia K4</button>
        <button class="ghost" data-a="addVehicle">Other vehicle</button></div></div>`;
  shell('Garage', body, 'garage', S.vehicles.length ? `<button class="small" data-a="addVehicle">+ Add</button>` : '');
}

function screenVehicle(id) {
  const v = byId(S.vehicles, id);
  if (!v) return screenGarage();
  const items = S.items.filter(i => i.vehicle_id === id).map(i => ({ i, st: serviceStatus(i, v) }))
    .sort((a, b) => ({ due: 0, soon: 1, ok: 2 }[a.st.state] - { due: 0, soon: 1, ok: 2 }[b.st.state]) || ((a.st.kmLeft ?? 1e9) - (b.st.kmLeft ?? 1e9)));
  const log = S.log.filter(l => l.vehicle_id === id);
  const mods = S.mods.filter(m => m.vehicle_id === id);
  const spent = log.reduce((s, l) => s + Number(l.cost || 0), 0) + mods.reduce((s, m) => s + Number(m.cost || 0), 0);
  const facts = [
    ['Vehicle', [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')], ['Colour', v.color],
    ['Plate', v.plate], ['VIN', v.vin], ['Purchased', v.purchase_date && `${v.purchase_date} at ${fmtKm(v.purchase_km)} km`],
    ['Insurance', [v.insurance_provider, v.insurance_policy].filter(Boolean).join(' · ')],
    ['Insurance renews', v.insurance_expiry], ['Sticker expires', v.registration_expiry],
    ['Tires', v.tire_size], ['Oil', v.oil_spec],
  ].filter(([, x]) => x);

  const body = `
    <div class="card"><h2>Odometer</h2>
      <div class="row"><div class="grow"><div class="big-num">${fmtKm(v.current_km)} km</div>
        <div class="sub">updated ${esc(v.km_updated_at || '—')}</div></div>
        <button data-a="odometer" data-id="${id}">Update</button></div></div>

    <div class="card"><h2>Service schedule</h2>
      ${items.map(({ i, st }) => `<div class="row">
          <div class="grow tap" data-a="editItem" data-id="${i.id}"><div class="title">${esc(i.name)}</div>
            <div class="sub">${esc(describeService(st))}</div></div>
          ${chip(st.state, st.state === 'due' ? 'Due' : st.state === 'soon' ? 'Soon' : 'OK')}
          <button class="ghost small" data-a="markDone" data-id="${i.id}">Done</button></div>`).join('')
        || `<div class="muted">No schedule yet.</div>
            <div class="actions"><button class="small" data-a="loadK4" data-id="${id}">Load Kia K4 default schedule</button></div>`}
      <div class="actions"><button class="ghost small" data-a="addItem" data-id="${id}">+ Service item</button></div></div>

    <div class="card"><h2>Service history</h2>
      ${log.map(l => `<div class="row tap" data-a="editLog" data-id="${l.id}"><div class="grow">
          <div class="title">${esc(l.title)}</div>
          <div class="sub">${esc([l.done_date, l.km != null && `${fmtKm(l.km)} km`, l.shop, l.cost != null && `$${l.cost}`].filter(Boolean).join(' · '))}</div></div></div>`).join('')
        || '<div class="muted">Nothing logged yet.</div>'}
      <div class="actions"><button class="ghost small" data-a="addLog" data-id="${id}">+ Log repair / other</button></div></div>

    <div class="card"><h2>Accessories & mods</h2>
      ${mods.map(m => `<div class="row tap" data-a="editMod" data-id="${m.id}"><div class="grow">
          <div class="title">${esc(m.name)}</div>
          <div class="sub">${esc([m.added_date, m.installer, m.cost != null && `$${m.cost}`].filter(Boolean).join(' · '))}</div></div></div>`).join('')
        || '<div class="muted">None added yet.</div>'}
      <div class="actions"><button class="ghost small" data-a="addMod" data-id="${id}">+ Add</button></div></div>

    <div class="card"><h2>Details</h2>
      ${facts.length ? `<dl class="facts">${facts.map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join('')}</dl>` : '<div class="muted">Add VIN, plate, insurance…</div>'}
      ${v.notes ? `<div class="note" style="margin-top:10px">${esc(v.notes)}</div>` : ''}
      ${spent ? `<div class="muted" style="margin-top:10px">Total logged spend: $${spent.toFixed(2)}</div>` : ''}
      <div class="actions"><button class="ghost small" data-a="editVehicle" data-id="${id}">Edit details</button></div></div>`;
  shell(v.name, body, 'garage', `<a class="btn ghost small" href="#garage">‹ Back</a>`);
}

function render() {
  const [route, id] = (location.hash.slice(1) || 'today').split('/');
  ({ today: screenToday, people: screenPeople, person: () => screenPerson(id),
     garage: screenGarage, vehicle: () => screenVehicle(id) }[route] || screenToday)();
}
async function refresh() { await loadAll(); render(); }

// ───────────── auth ─────────────
function screenLogin(sent) {
  app.innerHTML = `<div class="login">
    <h1>Life OS</h1>
    ${sent ? `<div class="card">📬 Check <b>${esc(sent)}</b> for a sign-in link. Open it on this device.</div>`
    : `<p class="muted">Sign in with a one-time link sent to your email.</p>
       <form id="login"><input type="email" name="email" required placeholder="you@example.com" autocomplete="email">
       <div class="actions"><button type="submit">Send sign-in link</button></div></form>`}</div>`;
  document.getElementById('login')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return toast(error.message);
    screenLogin(email);
  });
}

async function boot() {
  if (SUPABASE_URL.includes('YOUR-PROJECT')) {
    app.innerHTML = `<div class="login card">Open <b>config.js</b> and paste your Supabase URL and anon key.</div>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return screenLogin();
  try { await refresh(); } catch { /* toast already shown */ }
}

window.addEventListener('hashchange', render);
sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_IN') boot(); });
boot();
