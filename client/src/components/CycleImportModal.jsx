import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Modal, Field, ErrorNote } from './ui';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// Parse a Week 1..8 / Monday..Friday grid pasted from Excel (tab-separated,
// falls back to 2+ spaces). Rep, start date and repeat count are set via the
// form fields above the paste box, not read from the pasted text - so this
// only ever looks for "Week N" and day-header rows, everything else is
// account codes (or ignored noise, e.g. a stray formula-bar artifact).
// The day-header row is usually the line right after "Week N" (as pasted from
// this company's sheet), but a header combined on the same row as "Week N" is
// also accepted.
function parseSchedule(text) {
  const weeks = [];
  let current = null;
  let pendingWeekNo = null;

  const findColMap = (cells) => {
    const colMap = {};
    cells.forEach((c, i) => { const d = c.toLowerCase(); if (DAYS.includes(d)) colMap[i] = d; });
    return colMap;
  };
  const startWeek = (weekNo, colMap) => {
    current = { week_no: weekNo, colMap, days: Object.fromEntries(Object.values(colMap).map((d) => [d, []])) };
    weeks.push(current);
  };

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/\s{2,}/)).map((c) => c.trim());
    const first = (cells[0] || '').toLowerCase();

    const wm = first.match(/^week\s*(\d+)/i);
    if (wm) {
      const colMap = findColMap(cells);
      if (Object.keys(colMap).length > 0) {
        startWeek(Number(wm[1]), colMap);
        pendingWeekNo = null;
      } else {
        current = null;
        pendingWeekNo = Number(wm[1]);
      }
      continue;
    }

    if (pendingWeekNo !== null) {
      const colMap = findColMap(cells);
      if (Object.keys(colMap).length > 0) startWeek(pendingWeekNo, colMap);
      pendingWeekNo = null;
      continue;
    }

    if (current) {
      for (const [idx, day] of Object.entries(current.colMap)) {
        const val = cells[idx];
        if (val && /\d/.test(val)) current.days[day].push(val);
      }
    }
  }
  return { weeks };
}

export default function CycleImportModal({ repId, onClose, onSaved }) {
  const [reps, setReps] = useState([]);
  const [selectedRep, setSelectedRep] = useState(repId || '');
  const [startDate, setStartDate] = useState('');
  const [repeat, setRepeat] = useState(1);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { api.get('/reps').then(setReps).catch(() => {}); }, []);

  const parsed = useMemo(() => (text.trim() ? parseSchedule(text) : null), [text]);
  const totalCodes = useMemo(() =>
    parsed ? parsed.weeks.reduce((s, w) => s + Object.values(w.days).reduce((a, c) => a + c.length, 0), 0) : 0,
  [parsed]);

  const canImport = selectedRep && startDate && parsed && parsed.weeks.length > 0;

  const doImport = async () => {
    setError('');
    if (!selectedRep) return setError('Select which rep this schedule belongs to.');
    if (!startDate) return setError('Enter the cycle start date.');
    if (!parsed || parsed.weeks.length === 0) {
      return setError('Could not find any "Week N" rows. Paste the grid straight from Excel (including the Week and Monday…Friday header rows).');
    }
    setBusy(true);
    try {
      const res = await api.post('/route-cycles/import', {
        rep_id: Number(selectedRep),
        start_date: startDate,
        repeat_count: Number(repeat) || 1,
        weeks: parsed.weeks.map((w) => ({ week_no: w.week_no, days: w.days }))
      });
      setResult(res);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  if (result) return (
    <Modal title="Schedule imported" onClose={() => { onSaved?.(); onClose(); }}>
      <div className="space-y-3">
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800">
          Loaded <b>{result.cycle_weeks}-week</b> cycle · <b>{result.matched}</b> of {result.total_stops} stops matched to customers.
        </div>
        {result.unmatched.length > 0 && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
            <div className="font-semibold mb-1">{result.unmatched.length} account code(s) didn't match a customer:</div>
            <div className="text-xs break-words">{result.unmatched.join(', ')}</div>
            <div className="mt-2 text-xs">These are skipped in compliance. Check the codes exist in Customers (they sync from SYSPRO on the <code>code</code> field).</div>
          </div>
        )}
        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => { onSaved?.(); onClose(); }}>Done</button>
        </div>
      </div>
    </Modal>
  );

  return (
    <Modal title="Import call-cycle schedule" onClose={onClose} wide>
      <ErrorNote error={error} />
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Sales rep">
            <select className="input" value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)} disabled={!!repId}>
              <option value="">Select rep…</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Cycle start date">
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Repeat count">
            <input className="input" type="number" min="1" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
        </div>

        <div>
          <p className="text-sm text-slate-500 mb-2">
            Copy the <b>Week 1</b> through <b>Week 8</b> account-number grid from Excel (including the Week and Monday…Friday header rows) and paste it below.
          </p>
          <textarea className="input font-mono text-xs" rows="16" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'Week 1\nMonday\tTuesday\tWednesday\tThursday\tFriday\n31217\t31437\t31468\t31032\t31328\n31634\t31314\t31320\t31571\t22660\n...\n\nWeek 2\nMonday\tTuesday\tWednesday\tThursday\tFriday\n...'} />
        </div>

        {parsed && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
            {parsed.weeks.length > 0
              ? <>Detected <b>{parsed.weeks.length} weeks</b> · <b>{totalCodes} customer codes</b></>
              : <span className="text-amber-700">No "Week N" rows detected yet - check the paste includes the Week and day-header rows.</span>}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={doImport} disabled={busy || !canImport}>
            {busy ? 'Importing…' : 'Import schedule'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
