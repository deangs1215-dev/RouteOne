// Route planner: build a rep's day stop-by-stop, pull in overdue customers,
// optimise the order, see it on the map.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { Card, Spinner, ErrorNote, VisitStatusBadge, GradeBadge } from '../components/ui';
import MapView from '../components/MapView';

export default function RoutesPage() {
  const [reps, setReps] = useState([]);
  const [repId, setRepId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [stops, setStops] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/users').then((users) => {
      const rs = users.filter((u) => u.role === 'rep' && u.active);
      setReps(rs);
      if (rs.length && !repId) setRepId(String(rs[0].id));
    }).catch(() => {});
    api.get('/coverage').then(setCoverage).catch(() => {});
  }, []);

  const load = () => {
    if (!repId) return;
    api.get(`/routes?rep_id=${repId}&date=${date}`).then(setStops).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, [repId, date]);

  // Customers due/overdue for this rep and not already on the plan.
  const suggestions = useMemo(() => {
    const planned = new Set((stops || []).map((s) => s.customer_id));
    return coverage
      .filter((c) => String(c.rep_id) === String(repId) && !planned.has(c.id) && c.due_in_days <= 2 && !c.upcoming_planned)
      .sort((a, b) => a.due_in_days - b.due_in_days);
  }, [coverage, stops, repId]);

  const addStop = async (customerId) => {
    try {
      await api.post('/routes/stops', { rep_id: Number(repId), customer_id: customerId, date });
      load();
    } catch (e) { setError(e.message); }
  };

  const removeStop = async (visitId) => {
    try { await api.del(`/routes/stops/${visitId}`); load(); }
    catch (e) { setError(e.message); }
  };

  const move = async (index, dir) => {
    const planned = stops.filter((s) => s.status === 'planned');
    const target = index + dir;
    if (target < 0 || target >= planned.length) return;
    [planned[index], planned[target]] = [planned[target], planned[index]];
    try {
      await api.put('/routes/reorder', { visit_ids: planned.map((s) => s.id) });
      load();
    } catch (e) { setError(e.message); }
  };

  const optimize = async () => {
    setBusy(true);
    try { await api.post('/routes/optimize', { rep_id: Number(repId), date }); load(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  };

  const planned = (stops || []).filter((s) => s.status === 'planned');
  const done = (stops || []).filter((s) => s.status !== 'planned');
  const markers = planned.map((s, i) => ({
    lat: s.customer_lat, lng: s.customer_lng, label: i + 1,
    popup: `${i + 1}. ${s.customer_name}`, color: '#1a7ea8'
  })).concat(done.map((s) => ({
    lat: s.customer_lat, lng: s.customer_lng,
    popup: `✓ ${s.customer_name}`, color: '#16a34a', radius: 7
  })));
  const line = planned.filter((s) => s.customer_lat != null).map((s) => [s.customer_lat, s.customer_lng]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Route planning</h1>
        <button className="btn-primary" onClick={optimize} disabled={busy || planned.length < 2}>
          {busy ? 'Optimising…' : '⚡ Optimise route'}
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <select className="input max-w-[220px]" value={repId} onChange={(e) => setRepId(e.target.value)}>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input className="input max-w-[180px]" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <ErrorNote error={error} />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title={`Route — ${planned.length} stop${planned.length === 1 ? '' : 's'}`}>
            {!stops ? <Spinner /> : (
              <div className="space-y-2">
                {planned.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{i + 1}</div>
                    <div className="min-w-0 flex-1">
                      <Link className="block truncate text-sm font-medium hover:text-brand-600" to={`/customers/${s.customer_id}`}>{s.customer_name}</Link>
                      <div className="text-xs text-slate-400">{s.city} · {s.visit_frequency}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button className="btn-secondary h-7 w-7 p-0 text-xs" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                      <button className="btn-secondary h-7 w-7 p-0 text-xs" onClick={() => move(i, 1)} disabled={i === planned.length - 1}>↓</button>
                      <button className="ml-1 text-slate-300 hover:text-red-500" onClick={() => removeStop(s.id)}>×</button>
                    </div>
                  </div>
                ))}
                {planned.length === 0 && <div className="py-6 text-center text-sm text-slate-400">No stops planned — add customers from the suggestions.</div>}
                {done.length > 0 && (
                  <div className="border-t border-slate-100 pt-2">
                    {done.map((s) => (
                      <div key={s.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                        <span className="text-slate-500">✓ {s.customer_name}
                          {s.order_count > 0 && <span className="ml-1 text-xs">🧾</span>}
                        </span>
                        <span className="text-xs text-slate-400">{s.check_in_at ? fmtDateTime(s.check_in_at) : ''} <VisitStatusBadge status={s.status} /></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card title={`Due & overdue customers (${suggestions.length})`}>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {suggestions.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{c.name}</span> <GradeBadge grade={c.classification} />
                    </div>
                    <div className="text-xs">
                      {c.overdue
                        ? <span className="text-red-600 font-medium">overdue by {-c.due_in_days} day{c.due_in_days === -1 ? '' : 's'}</span>
                        : <span className="text-amber-600">due {c.due_in_days === 0 ? 'today' : `in ${c.due_in_days}d`}</span>}
                      <span className="text-slate-400"> · {c.visit_frequency} · last visit {c.days_since_visit != null ? `${c.days_since_visit}d ago` : 'never'}</span>
                    </div>
                  </div>
                  <button className="btn-secondary text-xs" onClick={() => addStop(c.id)}>+ Add</button>
                </div>
              ))}
              {suggestions.length === 0 && <div className="py-4 text-center text-sm text-slate-400">Nothing due — coverage is on track. 🎉</div>}
            </div>
          </Card>
        </div>

        <Card title="Map">
          <MapView markers={markers} line={line} height={520} />
        </Card>
      </div>
    </div>
  );
}
