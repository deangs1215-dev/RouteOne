// Live map: customer pins coloured by coverage state, reps' last known
// positions, and today's check-ins.
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Card, Spinner } from '../components/ui';
import MapView from '../components/MapView';

export default function LiveMap() {
  const [coverage, setCoverage] = useState(null);
  const [repLocations, setRepLocations] = useState([]);
  const [visitsToday, setVisitsToday] = useState([]);

  const load = () => {
    api.get('/coverage').then(setCoverage).catch(console.error);
    api.get('/locations/latest').then(setRepLocations).catch(() => {});
    api.get(`/visits?date=${new Date().toISOString().slice(0, 10)}`).then(setVisitsToday).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // refresh every minute
    return () => clearInterval(t);
  }, []);

  if (!coverage) return <Spinner />;

  const visitedToday = new Set(visitsToday.filter((v) => v.check_in_at).map((v) => v.customer_id));
  const markers = [
    ...coverage.map((c) => ({
      lat: c.lat, lng: c.lng,
      color: visitedToday.has(c.id) ? '#16a34a' : c.overdue ? '#dc2626' : '#64748b',
      radius: 8,
      popup: `<b>${c.name}</b><br/>${c.city || ''}<br/>Rep: ${c.rep_name || '—'}<br/>` +
        (visitedToday.has(c.id) ? '✓ visited today' :
          c.overdue ? `⚠ overdue by ${-c.due_in_days}d` : `due in ${c.due_in_days}d`)
    })),
    ...repLocations.map((r) => ({
      lat: r.lat, lng: r.lng, color: '#2563eb', radius: 12, label: '🧍',
      popup: `<b>${r.name}</b><br/>last seen ${fmtDateTime(r.recorded_at)}`
    }))
  ];

  const overdueCount = coverage.filter((c) => c.overdue).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Live map</h1>
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
          <span><span className="mr-1 inline-block h-3 w-3 rounded-full bg-blue-600 align-middle" />rep position</span>
          <span><span className="mr-1 inline-block h-3 w-3 rounded-full bg-green-600 align-middle" />visited today ({visitedToday.size})</span>
          <span><span className="mr-1 inline-block h-3 w-3 rounded-full bg-red-600 align-middle" />overdue ({overdueCount})</span>
          <span><span className="mr-1 inline-block h-3 w-3 rounded-full bg-slate-500 align-middle" />on track</span>
        </div>
      </div>
      <Card>
        <MapView markers={markers} height={560} />
      </Card>
    </div>
  );
}
