import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Modal, Field, ErrorNote } from './ui';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// Parse a schedule pasted from Excel (tab-separated). Falls back to 2+ spaces.
function parseSchedule(text) {
  const meta = {};
  const weeks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/\s{2,}/)).map((c) => c.trim());
    const first = (cells[0] || '').toLowerCase();
    const rest = cells.slice(1).find(Boolean) || '';
    if (first.startsWith('rep name')) { meta.rep_name = rest; continue; }
    if (first.startsWith('rep code')) { meta.rep_code = rest; continue; }
    if (first.startsWith('start date')) { meta.start_date = rest; continue; }
    if (first.startsWith('call cycle') || first.startsWith('cycle')) { meta.duration = rest; continue; }

    const wm = (cells[0] || '').match(/^week\s*(\d+)/i);
    if (wm) {
      const colMap = {};
      cells.forEach((c, i) => { const d = c.toLowerCase(); if (DAYS.includes(d)) colMap[i] = d; });
      current = { week_no: Number(wm[1]), colMap, days: Object.fromEntries(Object.values(colMap).map((d) => [d, []])) };
      weeks.push(current);
      continue;
    }
    if (current) {
      for (const [idx, day] of Object.entries(current.colMap)) {
        const val = cells[idx];
        if (val && /\d/.test(val)) current.days[day].push(val);
      }
    }
  }
  return { meta, weeks };
}

const parseDuration = (s = '') => {
  const t = s.toLowerCase();
  if (/twice|two|2/.test(t)) return 2;
  if (/thrice|three|3/.test(t)) return 3;
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const toISO = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function CycleImportModal({ repId, onClose, onSaved }) {
  const [reps, setReps] = useState([]);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [selectedRep, setSelectedRep] = useState(repId || '');
  const [startDate, setStartDate] = useState('');
  const [repeat, setRepeat] = useState(1);
  const [repCode, setRepCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { api.get('/reps').then(setReps).catch(() => {}); }, []);

  const totalCodes = useMemo(() =>
    parsed ? parsed.weeks.reduce((s, w) => s + Object.values(w.days).reduce((a, c) => a + c.length, 0), 0) : 0,
  [parsed]);

  const doParse = () => {
    setError('');
    const p = parseSchedule(text);
    if (p.weeks.length === 0) { setError('Could not find any "Week N" rows. Paste the grid straight from Excel (including the Week / Monday…Friday header rows).'); return; }
    setParsed(p);
    setRepCode(p.meta.rep_code || '');
    setRepeat(parseDuration(p.meta.duration));
    setStartDate(toISO(p.meta.start_date));
    // Try to preselect the rep by matching name or code.
    if (!repId && p.meta.rep_name) {
      const match = reps.find((r) => r.name.toLowerCase() === p.meta.rep_name.toLowerCase());
      if (match) setSelectedRep(String(match.id));
    }
  };

  const doImport = async () => {
    setError('');
    if (!selectedRep) return setError('Select which rep this schedule belongs to.');
    if (!startDate) return setError('Enter the cycle start date.');
    setBusy(true);
    try {
      const res = await api.post('/route-cycles/import', {
        rep_id: Number(selectedRep),
        rep_code: repCode || null,
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
      {!parsed ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Copy the rep's schedule from Excel (including the <b>Rep Name / Start Date</b> rows and the <b>Week / Monday…Friday</b> grid) and paste it below.
          </p>
          <textarea className="input font-mono text-xs" rows="12" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'Rep Name:\tLizl Scholtz\nRep Code:\t16\nStart Date:\t24 February 2025\nCall Cycle Duration:\tRepeat twice\n\nWeek 1\tMonday\tTuesday\tWednesday\tThursday\tFriday\n\t31359\t12800\t31471\t31485\t31455\n...'} />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={doParse} disabled={!text.trim()}>Preview</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
            Detected <b>{parsed.weeks.length} weeks</b> · <b>{totalCodes} customer codes</b>
            {parsed.meta.rep_name && <> · sheet rep <b>{parsed.meta.rep_name}</b></>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rep this schedule belongs to">
              <select className="input" value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)} disabled={!!repId}>
                <option value="">Select rep…</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <Field label="Cycle start date">
              <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="Repeat count (e.g. 'Repeat twice' = 2)">
              <input className="input" type="number" min="1" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </Field>
            <Field label="Rep code (from sheet)">
              <input className="input" value={repCode} onChange={(e) => setRepCode(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button className="btn-secondary" onClick={() => setParsed(null)} disabled={busy}>Back</button>
            <button className="btn-primary" onClick={doImport} disabled={busy}>{busy ? 'Importing…' : 'Import schedule'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
