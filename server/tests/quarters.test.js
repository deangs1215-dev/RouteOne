import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuarters, deltaLabel, quarterStatus, QUARTER_MONTHS } from '../../client/src/quarters.js';

const reps = [
  { rep_id: 1, name: 'Lizl', months: { '2026-01': 100, '2026-02': 200, '2026-03': 300, '2026-04': 400, '2026-05': 100, '2026-06': 100, '2026-07': 50 } },
  { rep_id: 2, name: 'James', months: { '2026-01': 10, '2026-02': 20, '2026-03': 30, '2026-04': 0, '2026-05': 5 } }
];
const NOW = new Date(2026, 6, 15); // 15 July 2026 -> Q3 is in progress

test('the four quarters carry the right months, month totals and quarter totals', () => {
  const { quarters, totals } = buildQuarters(2026, reps, NOW);
  assert.equal(quarters.length, 4);
  assert.deepEqual(quarters[0].keys, ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(quarters[3].keys, ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(quarters[0].labels, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(quarters[0].monthTotals, [110, 220, 330]);     // both reps added together
  assert.equal(quarters[0].total, 660);
  assert.deepEqual(quarters[1].monthTotals, [400, 105, 100]);
  assert.equal(quarters[1].total, 605);
  assert.equal(quarters[2].total, 50);                            // only July so far
  assert.equal(quarters[3].total, 0);
  assert.equal(totals.total, 660 + 605 + 50);
  // the quarter totals always add up to the year, and the rows add up to the "All reps" row
  assert.equal(totals.total, totals.quarters.reduce((s, q) => s + q.total, 0));
});

test('per-rep rows: three months, a quarter total, and a year total each', () => {
  const { rows } = buildQuarters(2026, reps, NOW);
  const lizl = rows.find((r) => r.name === 'Lizl');
  assert.deepEqual(lizl.quarters[0].values, [100, 200, 300]);
  assert.equal(lizl.quarters[0].total, 600);
  assert.equal(lizl.quarters[1].total, 600);
  assert.equal(lizl.total, 600 + 600 + 50);
  const james = rows.find((r) => r.name === 'James');
  assert.deepEqual(james.quarters[1].values, [0, 5, 0]);          // missing months are zero, not undefined
  assert.equal(rows.reduce((s, r) => s + r.total, 0), buildQuarters(2026, reps, NOW).totals.total);
});

test('quarter status: done, current and future', () => {
  assert.equal(quarterStatus(2026, 1, NOW), 'done');
  assert.equal(quarterStatus(2026, 2, NOW), 'done');
  assert.equal(quarterStatus(2026, 3, NOW), 'current');
  assert.equal(quarterStatus(2026, 4, NOW), 'future');
  assert.equal(quarterStatus(2025, 4, NOW), 'done');              // last year is entirely done
  assert.equal(quarterStatus(2027, 1, NOW), 'future');
});

test('quarter-on-quarter change: only for a finished quarter against the one before it', () => {
  const { quarters } = buildQuarters(2026, reps, NOW);
  assert.equal(quarters[0].deltaPct, null);                       // Q1 has no earlier quarter in the year
  assert.equal(quarters[1].deltaPct, Math.round((605 / 660 - 1) * 100)); // -8
  assert.equal(quarters[1].deltaPct, -8);
  assert.equal(quarters[2].deltaPct, null);                       // in progress: would always look like a miss
  assert.equal(quarters[3].deltaPct, null);                       // not started
});

test('a quarter after one with no sales has no change figure, never a divide-by-zero', () => {
  const sparse = [{ rep_id: 1, name: 'A', months: { '2025-04': 500 } }];
  const { quarters } = buildQuarters(2025, sparse, NOW);          // 2025 is long finished
  assert.equal(quarters[0].total, 0);
  assert.equal(quarters[1].deltaPct, null);                       // Q1 total is 0 -> no percentage
  assert.equal(quarters[2].deltaPct, -100);                       // Q3 (0) vs Q2 (500)
});

test('an empty year and a rep with no data produce zeros, not errors', () => {
  const { quarters, rows, totals, maxMonth } = buildQuarters(2026, [], NOW);
  assert.equal(rows.length, 0);
  assert.equal(totals.total, 0);
  assert.equal(maxMonth, 0);
  assert.ok(quarters.every((q) => q.total === 0 && q.monthTotals.length === 3));
  assert.doesNotThrow(() => buildQuarters(2026, [{ rep_id: 9, name: 'New rep' }], NOW)); // months missing entirely
});

test('maxMonth is the best single month of the year (shared scale for the bars)', () => {
  assert.equal(buildQuarters(2026, reps, NOW).maxMonth, 400);
});

test('deltaLabel shows a plus or a true minus sign', () => {
  assert.equal(deltaLabel(12), '+12%');
  assert.equal(deltaLabel(0), '+0%');
  assert.equal(deltaLabel(-8), '−8%');
  assert.equal(deltaLabel(null), null);
  assert.equal(QUARTER_MONTHS.flat().length, 12);
});
