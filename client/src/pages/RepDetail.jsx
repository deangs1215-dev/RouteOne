import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, fmtR, fmtDate } from '../api';
import { Card, Spinner, Badge, OrderStatusBadge, VisitStatusBadge } from '../components/ui';
import { visitDuration } from '../components/VisitTimer';
import { useAuth } from '../auth';

const CUSTOMERS_PER_PAGE = 10;

export default function RepDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [rep, setRep] = useState(null);
  const [comp, setComp] = useState(null);
  const [customers, setCustomers] = useState(null);
  const [custPage, setCustPage] = useState(0);

  const loadCompliance = () => api.get(`/route-compliance?rep_id=${id}`).then(setComp).catch(() => setComp(null));
  const load = () => {
    api.get(`/reps/${id}/summary`).then(setRep).catch(console.error);
    api.get(`/customers?rep_id=${id}`).then(setCustomers).catch(() => setCustomers([]));
    loadCompliance();
  };
  useEffect(() => { load(); setCustPage(0); }, [id]);

  const custTotalPages = customers ? Math.max(1, Math.ceil(customers.length / CUSTOMERS_PER_PAGE)) : 1;
  const custPageRows = customers ? customers.slice(custPage * CUSTOMERS_PER_PAGE, custPage * CUSTOMERS_PER_PAGE + CUSTOMERS_PER_PAGE) : [];

  if (!rep) return <Spinner />;

  const targetPct = rep.sales_target ? Math.round((rep.sales.mtd / rep.sales_target) * 100) : null;

  return (
    <div className="space-y-4">
      <Link to="/team" className="text-sm text-brand-600 hover:underline">← Back to team</Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{rep.name}</h1>
          <div className="text-sm text-slate-500">
            {rep.rep_code && <>Code {rep.rep_code} · </>}{rep.email}
            {!rep.active && <Badge color="#64748b">inactive</Badge>}
          </div>
        </div>
        {isAdmin && (
          <Link to={`/users?edit=${rep.id}`} className="btn-secondary text-sm">⚙ Settings</Link>
        )}
      </div>

      {/* Performance snapshot */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sales (MTD)" value={fmtR(rep.sales.mtd)} sub={targetPct != null ? `${targetPct}% of ${fmtR(rep.sales_target)}` : 'no target'} />
        <Stat label="Orders (MTD)" value={rep.sales.orders} />
        <Stat label="Visits done (MTD)" value={rep.visits.completed} sub={rep.visits.in_progress ? `${rep.visits.in_progress} open now` : null} />
        <Stat label="Customers assigned" value={rep.customers_assigned} />
      </div>

      {/* Route compliance */}
      <Card title="Call-cycle compliance">
        <div className="p-4">
          {!comp ? <Spinner /> : !comp.has_cycle ? (
            <div className="text-center text-sm text-slate-400 py-6">
              No call-cycle schedule loaded for this rep yet.<br />
              <button className="mt-2 text-brand-600 font-medium" onClick={() => setImporting(true)}>Import a schedule →</button>
            </div>
          ) : (
            <ComplianceView comp={comp} onRefresh={loadCompliance} />
          )}
        </div>
      </Card>

      {/* Recent activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Recent orders">
            <div className="divide-y divide-slate-100">
              {rep.recent_orders.length === 0 && <div className="p-4 text-sm text-slate-400">No orders.</div>}
              {rep.recent_orders.map((o) => (
                <Link key={o.id} to={`/orders/${o.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-slate-50">
                  <span><span className="font-medium">{o.number}</span> <span className="text-slate-400">· {o.customer_name}</span></span>
                  <span className="flex items-center gap-2"><OrderStatusBadge status={o.status} /><span className="font-semibold">{fmtR(o.total)}</span></span>
                </Link>
              ))}
            </div>
          </Card>

          <Card title={`Customers${customers ? ` (${customers.length})` : ''}`}>
            <div className="divide-y divide-slate-100">
              {!customers ? (
                <div className="p-4"><Spinner /></div>
              ) : customers.length === 0 ? (
                <div className="p-4 text-sm text-slate-400">No customers assigned.</div>
              ) : (
                custPageRows.map((c) => (
                  <Link key={c.id} to={`/customers/${c.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-slate-50">
                    <span><span className="font-medium">{c.name}</span> <span className="text-slate-400">· {c.code}{c.city ? ` · ${c.city}` : ''}</span></span>
                    <Badge color={c.status === 'active' ? '#16a34a' : c.status === 'on_hold' ? '#f59e0b' : '#64748b'}>{c.status}</Badge>
                  </Link>
                ))
              )}
            </div>
            {customers && customers.length > CUSTOMERS_PER_PAGE && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-sm">
                <button
                  className="text-brand-600 disabled:text-slate-300"
                  disabled={custPage === 0}
                  onClick={() => setCustPage((p) => Math.max(0, p - 1))}
                >
                  ← Prev
                </button>
                <span className="text-slate-400">Page {custPage + 1} of {custTotalPages}</span>
                <button
                  className="text-brand-600 disabled:text-slate-300"
                  disabled={custPage >= custTotalPages - 1}
                  onClick={() => setCustPage((p) => Math.min(custTotalPages - 1, p + 1))}
                >
                  Next →
                </button>
              </div>
            )}
          </Card>
        </div>
        <Card title="Recent visits">
          <div className="divide-y divide-slate-100">
            {rep.recent_visits.length === 0 && <div className="p-4 text-sm text-slate-400">No visits.</div>}
            {rep.recent_visits.map((v) => (
              <div key={v.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>{v.customer_name}</span>
                <span className="flex items-center gap-2 text-slate-400">
                  {(() => { const d = visitDuration(v.check_in_at, v.check_out_at); return d
                    ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">⏱ {d}</span>
                    : null; })()}
                  {fmtDate(v.check_in_at || v.planned_date)}<VisitStatusBadge status={v.status} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-800">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function ComplianceView({ comp }) {
  const pct = comp.pct ?? 0;
  const color = pct >= 85 ? '#16a34a' : pct >= 60 ? '#f59e0b' : '#dc2626';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-6">
        <div className="text-center">
          <div className="text-4xl font-extrabold" style={{ color }}>{comp.pct == null ? '—' : `${comp.pct}%`}</div>
          <div className="text-xs text-slate-400">customers seen</div>
        </div>
        <div className="text-sm text-slate-600">
          <div><b>{comp.visited}</b> of <b>{comp.planned}</b> planned visits completed</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {comp.cycle.name} · {comp.cycle.cycle_weeks}-week cycle · window {fmtDate(comp.from)} – {fmtDate(comp.to)}
          </div>
        </div>
      </div>

      {/* Per-week bars */}
      {comp.weeks.length > 0 && (
        <div className="space-y-1.5">
          {comp.weeks.map((w) => (
            <div key={w.week_start} className="flex items-center gap-3 text-xs">
              <span className="w-24 shrink-0 text-slate-500">{fmtDate(w.week_start)}</span>
              <span className="w-14 shrink-0 text-slate-400">Wk {w.cycle_week}</span>
              <div className="h-3 flex-1 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-3 rounded-full" style={{ width: `${w.pct}%`, backgroundColor: w.pct >= 85 ? '#16a34a' : w.pct >= 60 ? '#f59e0b' : '#dc2626' }} />
              </div>
              <span className="w-24 shrink-0 text-right text-slate-500">{w.visited}/{w.planned} ({w.pct}%)</span>
            </div>
          ))}
        </div>
      )}

      {/* Missed customers */}
      {comp.missed.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Missed this window ({comp.missed.length})</div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
            {comp.missed.map((m, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-1.5 text-sm">
                <span><span className="font-medium">{m.name || m.code}</span> <span className="text-xs text-slate-400">{m.code}{m.city ? ` · ${m.city}` : ''}</span></span>
                <span className="text-xs text-slate-400">wk of {fmtDate(m.week_start)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
