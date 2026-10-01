// Calendar quarters for the Rep KPIs "Monthly history" tab. Pure functions (no React, no
// fetching) so the numbers can be unit-tested.
//
//   year:  the calendar year shown, e.g. 2026
//   reps:  [{ rep_id, name, months: { '2026-01': 123, ... } }]   (as returned by /kpis/monthly-history)
//   today: a Date, injectable for tests
//
// A quarter is 'done' once it has ended, 'current' while it is running and 'future' before it
// starts. Quarter-on-quarter change is only given for a COMPLETED quarter measured against the
// quarter before it: the quarter in progress would always read as a drop for not being over yet.

export const QUARTER_MONTHS = [
  ['Jan', 'Feb', 'Mar'],
  ['Apr', 'May', 'Jun'],
  ['Jul', 'Aug', 'Sep'],
  ['Oct', 'Nov', 'Dec']
];

const sum = (list) => list.reduce((s, v) => s + (Number(v) || 0), 0);
const key = (year, monthIndex) => `${year}-${String(monthIndex + 1).padStart(2, '0')}`;

export function quarterStatus(year, q, today = new Date()) {
  const thisYear = today.getFullYear();
  const thisQuarter = Math.floor(today.getMonth() / 3) + 1;
  if (year < thisYear || (year === thisYear && q < thisQuarter)) return 'done';
  if (year === thisYear && q === thisQuarter) return 'current';
  return 'future';
}

export function buildQuarters(year, reps, today = new Date()) {
  const quarters = [1, 2, 3, 4].map((q) => {
    const keys = [0, 1, 2].map((i) => key(year, (q - 1) * 3 + i));
    const monthTotals = keys.map((k) => sum(reps.map((r) => r.months?.[k])));
    return { q, keys, labels: QUARTER_MONTHS[q - 1], monthTotals, total: sum(monthTotals), status: quarterStatus(year, q, today), deltaPct: null };
  });
  quarters.forEach((qt, i) => {
    const prev = quarters[i - 1];
    if (prev && qt.status === 'done' && prev.total > 0) qt.deltaPct = Math.round((qt.total / prev.total - 1) * 100);
  });

  const rows = reps.map((r) => {
    const qs = quarters.map((qt) => {
      const values = qt.keys.map((k) => Number(r.months?.[k]) || 0);
      return { values, total: sum(values) };
    });
    return { rep_id: r.rep_id, name: r.name, quarters: qs, total: sum(qs.map((x) => x.total)) };
  });
  const totals = {
    quarters: quarters.map((qt) => ({ values: qt.monthTotals, total: qt.total })),
    total: sum(quarters.map((qt) => qt.total))
  };
  // The best single month of the year, so the month bars in every quarter share one scale
  const maxMonth = Math.max(0, ...quarters.flatMap((qt) => qt.monthTotals));
  return { quarters, rows, totals, maxMonth };
}

// Formats a quarter-on-quarter change: "+12%" / "−8%" (a true minus sign), or null when there is none.
export function deltaLabel(pct) {
  if (pct == null) return null;
  return pct >= 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}
