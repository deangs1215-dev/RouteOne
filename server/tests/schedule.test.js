import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, slotDue } from '../integration/schedule.js';

// A fixed "today" so the tests don't depend on when they run.
const at = (hh, mm = 0, day = 15) => new Date(2026, 9, day, hh, mm, 0, 0); // 15 Oct 2026, local time
const ms = (d) => d.getTime();
const TWICE = ['08:00', '17:00'];

test('parseTime accepts 24h times and falls back on blank or junk', () => {
  assert.deepEqual(parseTime('08:00', null), { h: 8, m: 0 });
  assert.deepEqual(parseTime('17:30', null), { h: 17, m: 30 });
  assert.deepEqual(parseTime('9:05', null), { h: 9, m: 5 });
  assert.deepEqual(parseTime('', '17:00'), { h: 17, m: 0 });       // untouched field saved as ''
  assert.deepEqual(parseTime(undefined, '08:00'), { h: 8, m: 0 });
  assert.deepEqual(parseTime('25:00', '08:00'), { h: 8, m: 0 });    // out of range -> fallback
  assert.deepEqual(parseTime('junk', '08:00'), { h: 8, m: 0 });
  assert.equal(parseTime('junk', null), null);
});

test('twice daily: not due before the first run of the day', () => {
  // yesterday's last run was 17:02; it is 07:59 today
  assert.equal(slotDue(TWICE, ms(at(17, 2, 14)), at(7, 59)), false);
});

test('twice daily: first run fires from 08:00, once', () => {
  const last = ms(at(17, 2, 14));
  assert.equal(slotDue(TWICE, last, at(8, 0)), true);
  assert.equal(slotDue(TWICE, last, at(8, 1)), true);
  // after it ran at 08:00:30 it must not fire again until 17:00
  const ran = ms(at(8, 0, 15) ) + 30000;
  assert.equal(slotDue(TWICE, ran, at(8, 1)), false);
  assert.equal(slotDue(TWICE, ran, at(12, 30)), false);
  assert.equal(slotDue(TWICE, ran, at(16, 59)), false);
});

test('twice daily: the second run fires at 17:00 even though it is only 9 hours after the first', () => {
  const ranMorning = ms(at(8, 0, 15)) + 30000;
  assert.equal(slotDue(TWICE, ranMorning, at(17, 0)), true);
  const ranEvening = ms(at(17, 0, 15)) + 30000;
  assert.equal(slotDue(TWICE, ranEvening, at(17, 1)), false);
  assert.equal(slotDue(TWICE, ranEvening, at(23, 59)), false);
  // and the next morning it is due again
  assert.equal(slotDue(TWICE, ranEvening, at(8, 0, 16)), true);
});

test('twice daily: a restart or outage over a slot catches up on the next tick', () => {
  // server was down 07:50-08:20: first run is due as soon as it is back
  assert.equal(slotDue(TWICE, ms(at(17, 2, 14)), at(8, 20)), true);
  // down all day, back at 18:00 with the last run yesterday: one catch-up run (the 17:00 slot)
  assert.equal(slotDue(TWICE, ms(at(17, 2, 14)), at(18, 0)), true);
  // ...and once it has run, nothing more until tomorrow
  assert.equal(slotDue(TWICE, ms(at(18, 1)), at(18, 5)), false);
});

test('a manual "sync now" after a slot counts as that slot having run', () => {
  assert.equal(slotDue(TWICE, ms(at(9, 15)), at(10, 0)), false);   // manual at 09:15, first slot satisfied
  assert.equal(slotDue(TWICE, ms(at(9, 15)), at(17, 0)), true);    // second slot still due
});

test('never run before: due as soon as the first slot passes', () => {
  assert.equal(slotDue(TWICE, null, at(7, 0)), false);
  assert.equal(slotDue(TWICE, null, at(8, 0)), true);
  assert.equal(slotDue(TWICE, -Infinity, at(20, 0)), true);
});

test('slot order does not matter, a single slot works, and blanks fall back to the defaults', () => {
  assert.equal(slotDue(['17:00', '08:00'], ms(at(17, 2, 14)), at(8, 0)), true);
  assert.equal(slotDue(['06:30'], ms(at(6, 31, 14)), at(6, 30)), true);
  assert.equal(slotDue(['06:30'], ms(at(6, 31)), at(20, 0)), false);
  const a = parseTime('', '08:00'), b = parseTime('', '17:00');      // both fields left blank in the form
  assert.equal(slotDue([a, b], ms(at(17, 2, 14)), at(8, 5)), true);
  assert.equal(slotDue([a, b], ms(at(8, 5)), at(17, 5)), true);
  assert.equal(slotDue([null, null], null, at(12, 0)), false);        // nothing valid -> never due, no crash
});
