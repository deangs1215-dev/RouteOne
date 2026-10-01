// Pure scheduling helpers for the in-app syncs - no database, so they are easy to test.

// 'HH:MM' -> { h, m }, or null when it is not a valid 24h time. A blank or junk
// value falls back to `fallback`: the settings form saves '' for any time field
// that was never touched, and an empty string must not silently disable a schedule.
export function parseTime(value, fallback) {
  for (const candidate of [value, fallback]) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(candidate ?? '').trim());
    if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return { h: Number(m[1]), m: Number(m[2]) };
  }
  return null;
}

// "Run at these times each day" (one or two slots, e.g. 08:00 and 17:00).
// Due once a slot's time has passed today and nothing has run since that slot.
//
// Slot-based on purpose, not "23 hours since the last run": with two runs a day only
// ~9 hours apart, an elapsed-time floor would skip the second one. It also keeps the
// catch-up behaviour of the old daily check - a restart or deploy at 17:00 doesn't
// lose the run, it fires on the next tick - and a run that already happened after the
// latest slot (even a manual "sync now") counts, so it never fires twice for one slot.
//   times:  array of 'HH:MM'
//   lastMs: time of the last run in ms since epoch (-Infinity / null if never)
export function slotDue(times, lastMs, now = new Date()) {
  const slots = times
    .map((t) => (typeof t === 'object' && t ? t : parseTime(t, null)))
    .filter(Boolean)
    .map(({ h, m }) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); })
    .sort((a, b) => a - b);
  const passed = slots.filter((s) => s <= now.getTime());
  if (!passed.length) return false;                // before today's first slot
  const latest = passed[passed.length - 1];
  const last = Number.isFinite(lastMs) ? lastMs : -Infinity;
  return last < latest;
}
