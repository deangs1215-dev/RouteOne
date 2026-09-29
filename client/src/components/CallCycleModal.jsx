// Read-only view of a rep's upcoming call cycle, projected onto real calendar
// dates (see GET /route-cycles/upcoming). Reps only ever see their own; office
// roles pick a rep first.
import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Modal, Field, Spinner, ErrorNote } from './ui';
import { useAuth } from '../auth';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

export default function CallCycleModal({ repId, onClose }) {
  const { user } = useAuth();
  const isRep = user.role === 'rep';
  const [reps, setReps] = useState([]);
  const [selectedRep, setSelectedRep] = useState(repId || '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { if (!isRep) api.get('/reps').then(setReps).catch(() => {}); }, [isRep]);

  useEffect(() => {
    setData(null);
    setError('');
    if (!isRep && !selectedRep) return;
    const params = new URLSearchParams({ weeks: '6' });
    if (!isRep && selectedRep) params.set('rep_id', selectedRep);
    api.get(`/route-cycles/upcoming?${params}`).then(setData).catch((e) => setError(e.message));
  }, [isRep, selectedRep]);

  return (
    <Modal title="Call cycle" onClose={onClose} wide>
      <ErrorNote error={error} />
      <div className="space-y-4">
        {!isRep && (
          <Field label="Rep">
            <select className="input" value={selectedRep} onChange={(e) => setSelectedRep(e.target.value)}>
              <option value="">Select rep…</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        )}

        {(isRep || selectedRep) && !data && !error && <Spinner />}

        {data && !data.has_cycle && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-slate-500">
            No call cycle has been imported for this rep yet.
          </div>
        )}

        {data?.has_cycle && (
          <div className="space-y-5">
            <div className="text-sm text-slate-500">{data.cycle.name} · {data.cycle.cycle_weeks}-week cycle</div>
            {data.weeks.map((w) => (
              <div key={w.week_start}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Week {w.cycle_week} · {fmtDate(w.week_start)}
                </div>
                <div className="grid grid-cols-5 gap-3 text-xs">
                  {DAYS.map((d) => (
                    <div key={d}>
                      <div className="mb-1 font-medium capitalize text-slate-500">{d}</div>
                      <div className="space-y-1">
                        {w.days[d].length === 0
                          ? <div className="text-slate-300">—</div>
                          : w.days[d].map((c) => (
                            <div key={c.customer_id} className="truncate rounded bg-slate-50 px-1.5 py-1" title={`${c.name || c.code}${c.city ? ` · ${c.city}` : ''}`}>
                              {c.name || c.code}
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
