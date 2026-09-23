// Quick self-check of the due-date logic with made-up data: `npm test`
import assert from 'node:assert/strict';
import { buildAgenda, personStatus, serviceStatus, addMonths, nextBirthday } from '../logic.js';
import { renderEmail } from './send-digest.js';

const today = '2026-09-23';
assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
assert.equal(nextBirthday('1994-09-25', today).days, 2);
assert.equal(nextBirthday('1994-01-10', today).date, '2027-01-10');

const people = [
  { id: 'p1', name: 'Friend A', call_every_days: 21, created_at: '2026-01-01T00:00:00Z', birthday: '1993-09-26' },
  { id: 'p2', name: 'Friend B', call_every_days: 14, created_at: '2026-01-01T00:00:00Z' },
  { id: 'p3', name: 'Friend C', call_every_days: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 'p4', name: 'Friend D', call_every_days: 7, created_at: '2026-01-01T00:00:00Z', snooze_until: '2026-09-30' },
];
const calls = [
  { person_id: 'p1', call_date: '2026-08-20', summary: 'New job, moving in Nov', follow_ups: 'Ask about the move' },
  { person_id: 'p2', call_date: '2026-09-20', summary: 'Quick catch-up' },
];
assert.equal(personStatus(people[0], calls, today).state, 'due');   // 34 days since last call
assert.equal(personStatus(people[1], calls, today).state, 'ok');    // due Oct 4
assert.equal(personStatus(people[2], calls, today).state, 'none');
assert.equal(personStatus(people[3], calls, today).state, 'ok');    // snoozed to Sep 30 → 7 days

const vehicles = [{ id: 'v1', name: 'Kia K4', purchase_km: 0, purchase_date: '2026-03-01', current_km: 11500,
  km_updated_at: '2026-08-01', insurance_expiry: '2026-10-10' }];
const items = [
  { id: 'i1', vehicle_id: 'v1', name: 'Oil & filter change', interval_km: 12000, interval_months: 6 },           // due Sep 1 by date
  { id: 'i2', vehicle_id: 'v1', name: 'Cabin air filter', interval_km: 24000, interval_months: 12 },            // ok
  { id: 'i3', vehicle_id: 'v1', name: 'Tire rotation', interval_km: 12000, interval_months: 12, last_done_km: 0, last_done_date: '2026-09-01' }, // 500 km left → soon
];
assert.equal(serviceStatus(items[0], vehicles[0], today).state, 'due');
assert.equal(serviceStatus(items[1], vehicles[0], today).state, 'ok');
assert.equal(serviceStatus(items[2], vehicles[0], today).state, 'soon');

const agenda = buildAgenda({ people, calls, vehicles, items }, today);
console.log(agenda.map(a => `[${a.level}] ${a.title} — ${a.detail}`).join('\n'));
const kinds = agenda.map(a => a.kind).sort();
assert.deepEqual(kinds, ['birthday', 'call', 'odometer', 'renewal', 'service', 'service']);
assert.equal(agenda[0].level, 'due');

const mail = renderEmail(agenda, today, 'https://example.github.io/life-os/');
console.log('\nSubject:', mail.subject);
console.log('\nAll logic checks passed ✅');
