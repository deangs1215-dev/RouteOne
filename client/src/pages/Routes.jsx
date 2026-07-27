// Route planner: build a rep's day stop-by-stop, pull in overdue customers,
// optimise the order, see it on the map.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime, todayISO } from '../api';
import { Card, Spinner, ErrorNote, VisitStatusBadge, GradeBadge } from '../components/ui';
import MapView from '../components/MapView';
import { useAuth } from '../auth';

export default function RoutesPage() {
  const { user } = useAuth();
  const isRep = user.role === 'rep';
  const [reps, setReps] = useState([]);
  const [repId, setRepId] = useState(isRep ? String(user.id) : '');
  const [date, setDate] = useState(todayISO());
  const [stops, setStops] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [allCustomers, setAllCustomers] = useState([]); // every account, for the map backdrop
  const [start, setStart] = useState(null);
  const [roadRoute, setRoadRoute] = useState(null); // { line:[[lat,lng]…], distance, duration } from OSRM
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Reps only ever see their own route - no need for the rep list/dropdown
    // (and /users is office-only anyway).
    if (!isRep) {
      api.get('/users').then((users) => {
        const rs = users.filter((u) => u.role === 'rep' && u.active);
        setReps(rs);
        if (rs.length && !repId) setRepId(String(rs[0].id));
      }).catch(() => {});
    }
    api.get('/coverage').then(setCoverage).catch(() => {});
    // All customers (with locations) so the map can show this rep's accounts in
    // green and every other rep's in red behind the planned route.
    api.get('/customers?scope=all').then(setAllCustomers).catch(() => {});
  }, []);

  const load = async () => {
    if (!repId) return;
    await Promise.all([
      api.get(`/routes?rep_id=${repId}&date=${date}`).then(setStops).catch((e) => setError(e.message)),
      api.get(`/routes/start?rep_id=${repId}&date=${date}`).then(setStart).catch(() => setStart(null))
    ]);
  };
  useEffect(() => { load(); }, [repId, date]);

  // Ask OSRM for a road-following driving route through the day's stops (in
  // order), starting from the rep's start point. Falls back to straight lines
  // if the routing service is unreachable (e.g. offline). Re-runs whenever the
  // ordered set of stops or the start point changes.
  const routeKey = JSON.stringify([
    start?.lat, start?.lng,
    ...(stops || []).filter((s) => s.status === 'planned').map((s) => [s.id, s.customer_lat, s.customer_lng])
  ]);
  useEffect(() => {
    const plannedStops = (stops || []).filter(
      (s) => s.status === 'planned' && s.customer_lat != null && s.customer_lng != null
    );
    const pts = [];
    if (start?.lat != null && start?.lng != null) pts.push([start.lng, start.lat]);
    for (const s of plannedStops) pts.push([s.customer_lng, s.customer_lat]);
    if (pts.length < 2) { setRoadRoute(null); return; }

    const coords = pts.map((p) => `${p[0]},${p[1]}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const route = data.routes?.[0];
        if (!route) { setRoadRoute(null); return; }
        setRoadRoute({
          line: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          distance: route.distance,
          duration: route.duration
        });
      })
      .catch(() => { if (!cancelled) setRoadRoute(null); });
    return () => { cancelled = true; };
  }, [routeKey]);

  const startLabel = {
    gps_today: "Start (today's GPS)",
    home: 'Start (home/office)',
    gps_stale: 'Start (last known position)'
  }[start?.source];

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
    if (!window.confirm('Remove this stop from the route?')) return;
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
    try {
      await api.post('/routes/optimize', { rep_id: Number(repId), date });
      await load();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  const planned = (stops || []).filter((s) => s.status === 'planned');
  const done = (stops || []).filter((s) => s.status !== 'planned');
  const hasStart = start?.lat != null && start?.lng != null;

  // Customers already on today's route — drawn as the highlighted numbered/✓
  // markers below, so we skip them in the plain green/red backdrop.
  const routeCustomerIds = new Set([...planned, ...done].map((s) => s.customer_id));
  // Backdrop: this rep's other accounts in green, every other rep's in red.
  const mine = [];
  const others = [];
  for (const c of allCustomers) {
    if (c.lat == null || c.lng == null || routeCustomerIds.has(c.id)) continue;
    if (String(c.rep_id) === String(repId)) {
      mine.push({ lat: c.lat, lng: c.lng, popup: c.name, color: '#16a34a', radius: 5 });
    } else {
      others.push({ lat: c.lat, lng: c.lng, popup: `${c.name} (${c.rep_name || 'other rep'})`, color: '#ef4444', radius: 5 });
    }
  }

  const startMarker = hasStart ? [{
    lat: start.lat, lng: start.lng, label: '🏠',
    popup: startLabel || 'Start', color: '#f59e0b', radius: 10
  }] : [];
  const routeMarkers = planned.map((s, i) => ({
    lat: s.customer_lat, lng: s.customer_lng, label: i + 1,
    popup: `${i + 1}. ${s.customer_name}`, color: '#1a7ea8'
  })).concat(done.map((s) => ({
    lat: s.customer_lat, lng: s.customer_lng,
    popup: `✓ ${s.customer_name}`, color: '#16a34a', radius: 7
  })));

  // Order matters: red/green backdrop first, route + start highlighted on top.
  const markers = [...others, ...mine, ...startMarker, ...routeMarkers];
  // Fit to the rep's own world (route + start + their accounts), so a distant
  // other-rep pin never yanks the zoom out.
  const fitMarkers = [...startMarker, ...routeMarkers, ...mine];
  // Prefer the real road-following route; fall back to straight lines between
  // stops if OSRM hasn't answered (or is unreachable).
  const straightLine = (hasStart ? [[start.lat, start.lng]] : [])
    .concat(planned.filter((s) => s.customer_lat != null).map((s) => [s.customer_lat, s.customer_lng]));
  const line = roadRoute?.line || straightLine;
  const fmtDuration = (secs) => {
    const mins = Math.round(secs / 60);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}min` : `${mins} min`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Route planning</h1>
        <button className="btn-primary" onClick={optimize} disabled={busy || planned.length < 2}>
          {busy ? 'Optimising…' : '⚡ Optimise route'}
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        {!isRep && (
          <select className="input max-w-[220px]" value={repId} onChange={(e) => setRepId(e.target.value)}>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
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
          <MapView markers={markers} line={line} height={520} fitMarkers={fitMarkers} lineDashed={!roadRoute} />
          {roadRoute && (
            <p className="mt-2 text-sm font-medium text-slate-700">
              🚗 Driving route: {(roadRoute.distance / 1000).toFixed(1)} km · ~{fmtDuration(roadRoute.duration)}
              <span className="ml-1 font-normal text-slate-400">following roads, in stop order</span>
            </p>
          )}
          {!roadRoute && planned.length >= 2 && (
            <p className="mt-2 text-xs text-slate-400">Straight-line preview — driving directions load when online.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-brand-600" /> On route</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#16a34a' }} /> This rep's accounts</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#ef4444' }} /> Other reps' accounts</span>
          </div>
          {hasStart && <p className="mt-2 text-xs text-slate-400">🏠 {startLabel}{start.home_address ? ` — ${start.home_address}` : ''}</p>}
          {!hasStart && <p className="mt-2 text-xs text-slate-400">No start point yet — set a home/office address for this rep under Users, or it'll use their first GPS ping of the day.</p>}
        </Card>
      </div>
    </div>
  );
}
