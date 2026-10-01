import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtRWhole, fmtDate, fmtDateTime } from '../api';
import { Card, Stat, Table, Spinner, OrderStatusBadge } from '../components/ui';
import { useAuth } from '../auth';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'mtd', label: 'Month to date' },
  { key: 'qtd', label: 'Quarter to date' }
];
const RANGE_NOUN = { today: 'today', week: 'this week', mtd: 'this month', qtd: 'this quarter' };

const DAY_MS = 86400000;
const daysSince = (s) => (s ? Math.floor((Date.now() - new Date(s.replace(' ', 'T')).getTime()) / DAY_MS) : null);
const pctColor = (pct) => (pct >= 100 ? 'text-emerald-600' : pct >= 80 ? 'text-amber-600' : 'text-red-600');

// A table row that opens `to` when clicked (or Enter is pressed). Picks up the app-wide
// clickable-row hover from the cursor-pointer class.
function GoRow({ to, children }) {
  const nav = useNavigate();
  return (
    <tr className="cursor-pointer hover:bg-slate-50" tabIndex={0} onClick={() => nav(to)}
      onKeyDown={(e) => { if (e.key === 'Enter') nav(to); }}>
      {children}
    </tr>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const isRep = user.role === 'rep';
  const [range, setRange] = useState('mtd');
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/dashboard?range=${range}`).then(setData).catch(console.error);
  }, [range]);

  if (!data) return <Spinner />;
  const { stats, salesByRep, topCustomers, atRisk, recentOrders, salesTrend, salesPace, openQuotes, productMovers, teamToday, noVisit } = data;
  const maxTrend = Math.max(...salesTrend.map((d) => d.total), 1);
  const noun = RANGE_NOUN[range];
  const delta = salesPace.delta_pct;
  const topThree = salesByRep.filter((r) => r.sales_mtd > 0).slice(0, 3);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Dashboard</h1>
        <div className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${range === r.key ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat to="/analytics" label={`Sales ${noun}`} value={fmtRWhole(stats.sales)} accent="text-brand-600"
          sub={range === 'mtd' && delta != null
            ? <span className={delta >= 0 ? 'text-emerald-600' : 'text-red-600'}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% vs same period last month</span>
            : (range === 'today' || range === 'week') ? 'invoiced, ex-VAT' : undefined} />
        <Stat to="/orders" label={`Orders ${noun}`} value={stats.orders} />
        <Stat to="/visits" label={`Visits ${noun}`} value={stats.visits} sub={`${stats.visits_pending} still planned`} />
        <Stat to="/customers" label="Active customers" value={stats.active_customers} />
        <Stat to="/orders" label="Avg order value" value={fmtRWhole(stats.avg_order_value)} sub="last 30 days" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SalesPace pace={salesPace} />

        <Card title={`Open quotes${openQuotes.count ? ` · ${openQuotes.count} worth ${fmtRWhole(openQuotes.value)}` : ''}`}>
          <Table headers={['Quote', 'Customer', 'Sent', { label: 'Total', align: 'right' }]}
            empty={openQuotes.rows.length === 0 && 'No quotes waiting on a customer 🎉'}>
            {openQuotes.rows.map((q) => {
              const age = daysSince(q.quote_date);
              const expired = q.valid_until && new Date(q.valid_until.replace(' ', 'T')).getTime() < Date.now();
              return (
                <GoRow key={q.id} to={`/quotes/${q.id}`}>
                  <td className="td font-medium">{q.number}</td>
                  <td className="td">{q.customer_name}{!isRep && q.rep_name && <div className="text-xs text-slate-400">{q.rep_name}</div>}</td>
                  <td className="td text-slate-500">
                    {age === 0 ? 'today' : `${age}d ago`}
                    {expired && <span className="ml-1.5 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-600">expired</span>}
                  </td>
                  <td className="td text-right font-medium">{fmtRWhole(q.total)}</td>
                </GoRow>
              );
            })}
          </Table>
          {openQuotes.count > openQuotes.rows.length && <div className="pt-2 text-xs text-slate-400">Showing the {openQuotes.rows.length} oldest of {openQuotes.count}.</div>}
        </Card>

        {!isRep && teamToday && <TeamToday rows={teamToday} />}

        {!isRep && (
          <Card title={`Sales by rep (${noun})`}>
            {topThree.length > 0 && (
              <div className="mb-4 grid grid-cols-3 gap-2">
                {topThree.map((r, i) => (
                  <div key={r.id} className="rounded-lg bg-slate-50 px-2 py-2 text-center">
                    <div className="text-lg">{['🥇', '🥈', '🥉'][i]}</div>
                    <div className="truncate text-xs font-semibold text-slate-700">{r.name}</div>
                    <div className="text-sm font-bold text-slate-900">{fmtRWhole(r.sales_mtd)}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-3">
              {salesByRep.map((r) => {
                const showTarget = range === 'mtd' && r.sales_target > 0;
                const pct = showTarget ? Math.min(100, (r.sales_mtd / r.sales_target) * 100) : 0;
                return (
                  <div key={r.id}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-medium">{r.name}</span>
                      <span>{fmtRWhole(r.sales_mtd)}
                        {showTarget && <span className="ml-1 text-xs text-slate-400">/ {fmtRWhole(r.sales_target)}</span>}
                      </span>
                    </div>
                    {showTarget && (
                      <div className="mt-1 h-2 rounded-full bg-slate-100">
                        <div className="h-2 rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-slate-400">{r.orders_mtd} orders · {r.visits_mtd} visits</div>
                  </div>
                );
              })}
              {salesByRep.length === 0 && <div className="text-sm text-slate-400">No reps yet.</div>}
            </div>
          </Card>
        )}

        <Card title="Sales trend (last 14 days)">
          <div className="flex h-40 items-end gap-1">
            {salesTrend.map((d) => (
              <div key={d.day} className="group relative flex-1">
                <div className="rounded-t bg-brand-500/80 hover:bg-brand-600" style={{ height: `${(d.total / maxTrend) * 150 + 4}px` }} />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
                  {fmtDate(d.day)}: {fmtRWhole(d.total)}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title={`Top customers (${noun})`}>
          <Table headers={['Customer', 'City', 'Orders', 'Sales']} empty={topCustomers.length === 0 && `No sales ${noun} yet.`}>
            {topCustomers.map((c) => (
              <GoRow key={c.id} to={`/customers/${c.id}`}>
                <td className="td font-medium">{c.name}</td>
                <td className="td text-slate-500">{c.city}</td>
                <td className="td">{c.orders_mtd}</td>
                <td className="td font-medium">{fmtRWhole(c.sales_mtd)}</td>
              </GoRow>
            ))}
          </Table>
        </Card>

        <Card title="Top products (last 30 days)">
          <Table headers={['Product', { label: 'Qty', align: 'right' }, { label: 'Sales', align: 'right' }]}
            empty={productMovers.top.length === 0 && 'No invoice lines in the last 30 days.'}>
            {productMovers.top.map((p) => (
              <tr key={p.product_code} className="hover:bg-slate-50">
                <td className="td font-medium">{p.name || p.product_code}{p.name && <div className="text-xs font-normal text-slate-400">{p.product_code}</div>}</td>
                <td className="td text-right text-slate-500">{Math.round(p.qty)}</td>
                <td className="td text-right font-medium">{fmtRWhole(p.sales)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Gone quiet (sold 2–4 weeks ago, nothing in the last 14 days)">
          <Table headers={['Product', { label: 'Sold earlier', align: 'right' }]}
            empty={productMovers.quiet.length === 0 && 'Every product that sold earlier has sold again recently.'}>
            {productMovers.quiet.map((p) => (
              <tr key={p.product_code} className="hover:bg-slate-50">
                <td className="td font-medium">{p.name || p.product_code}{p.name && <div className="text-xs font-normal text-slate-400">{p.product_code}</div>}</td>
                <td className="td text-right text-slate-500">{fmtRWhole(p.sales)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="At-risk customers (no order in 30+ days)">
          <Table headers={['Customer', 'Rep', 'Last order']} empty={atRisk.length === 0 && 'Everyone ordered recently 🎉'}>
            {atRisk.map((c) => (
              <GoRow key={c.id} to={`/customers/${c.id}`}>
                <td className="td font-medium">{c.name}</td>
                <td className="td text-slate-500">{c.rep_name || '—'}</td>
                <td className="td text-red-600">{c.last_order_at ? fmtDate(c.last_order_at) : 'never'}</td>
              </GoRow>
            ))}
          </Table>
        </Card>

        <Card title={`Not visited in 30+ days${noVisit.count ? ` · ${noVisit.count}` : ''}`}>
          <Table headers={['Customer', 'Rep', 'Last visit']} empty={noVisit.rows.length === 0 && 'Every active customer has been visited recently 🎉'}>
            {noVisit.rows.map((c) => (
              <GoRow key={c.id} to={`/customers/${c.id}`}>
                <td className="td font-medium">{c.name}</td>
                <td className="td text-slate-500">{c.rep_name || '—'}</td>
                <td className="td text-red-600">{c.last_visit_at ? fmtDate(c.last_visit_at) : 'never'}</td>
              </GoRow>
            ))}
          </Table>
          {noVisit.count > noVisit.rows.length && <div className="pt-2 text-xs text-slate-400">Showing 8 of {noVisit.count}, those visited longest ago first.</div>}
        </Card>
      </div>

      <Card title="Recent orders">
        <Table headers={['Number', 'Customer', 'Rep', 'Date', 'Status', 'Total']} empty={recentOrders.length === 0 && 'No orders yet.'}>
          {recentOrders.map((o) => (
            <GoRow key={o.id} to={`/orders/${o.id}`}>
              <td className="td font-medium">{o.number}</td>
              <td className="td">{o.customer_name}</td>
              <td className="td text-slate-500">{o.rep_name || '—'}</td>
              <td className="td text-slate-500">{fmtDateTime(o.order_date)}</td>
              <td className="td"><OrderStatusBadge status={o.status} /></td>
              <td className="td font-medium">{fmtRWhole(o.total)}</td>
            </GoRow>
          ))}
        </Table>
      </Card>
    </div>
  );
}

// This month so far, where it is heading, and how that sits against target and past months.
function SalesPace({ pace }) {
  const hasTarget = pace.target > 0;
  const projPct = hasTarget ? Math.round((pace.target_projected / pace.target) * 100) : null;
  const donePct = hasTarget ? Math.min(100, (pace.target_sales / pace.target) * 100) : 0;
  const markPct = hasTarget ? Math.min(100, (pace.target_projected / pace.target) * 100) : 0;
  return (
    <Card title="Sales pace this month">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-2xl font-extrabold text-slate-800">{fmtRWhole(pace.mtd)}</div>
          <div className="text-xs text-slate-400">so far · day {pace.day} of {pace.days_in_month}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-extrabold text-brand-600">{fmtRWhole(pace.projected)}</div>
          <div className="text-xs text-slate-400">projected for the month at this pace</div>
        </div>
      </div>

      {hasTarget ? (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-slate-500">Target {fmtRWhole(pace.target)}</span>
            <span className={`font-semibold ${pctColor(projPct)}`}>{projPct}% on pace</span>
          </div>
          <div className="relative mt-1.5 h-3 rounded-full bg-slate-100">
            <div className="h-3 rounded-full bg-brand-500" style={{ width: `${donePct}%` }} />
            <div className="absolute -top-0.5 h-4 w-0.5 bg-slate-700" style={{ left: `calc(${markPct}% - 1px)` }} title={`Projected ${fmtRWhole(pace.target_projected)}`} />
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            Bar = sales so far, marker = projected finish. Measured over the {pace.budgeted_reps} of {pace.total_reps} reps who have a target.
          </div>
        </div>
      ) : (
        <div className="mt-4 text-xs text-slate-400">No sales target is set for this month.</div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last month (full)</div>
          <div className="font-semibold">{pace.last_month_total > 0 ? fmtRWhole(pace.last_month_total) : '—'}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Same month last year (full)</div>
          <div className="font-semibold">{pace.last_year_month_total > 0 ? fmtRWhole(pace.last_year_month_total) : '—'}</div>
        </div>
      </div>
    </Card>
  );
}

// One row per rep: where they are right now, and a flag for anyone who has not got going.
function TeamToday({ rows }) {
  const hour = new Date().getHours();
  const statusOf = (r) => {
    if (r.on_visit) return { label: `On a visit · ${r.on_visit}`, cls: 'bg-sky-50 text-sky-700' };
    if (r.at_branch_since) return { label: 'At the branch', cls: 'bg-violet-50 text-violet-700' };
    if (r.completed > 0) return { label: 'Active', cls: 'bg-emerald-50 text-emerald-700' };
    if (r.planned > 0 && hour >= 10) return { label: 'No activity yet', cls: 'bg-red-50 text-red-700', flag: true };
    if (r.planned > 0) return { label: 'Not started', cls: 'bg-slate-100 text-slate-600' };
    return { label: 'Nothing planned', cls: 'bg-slate-50 text-slate-400' };
  };
  const flagged = rows.filter((r) => statusOf(r).flag).length;
  const nav = useNavigate();
  return (
    <Card title={`Team today${flagged ? ` · ${flagged} not started` : ''}`}>
      <Table headers={['Rep', 'Status', { label: 'Visits', align: 'right' }, 'Last check-in']} empty={rows.length === 0 && 'No reps yet.'}>
        {rows.map((r) => {
          const st = statusOf(r);
          return (
            <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/team/${r.id}`)}>
              <td className="td font-medium">{r.name}</td>
              <td className="td"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>{st.label}</span></td>
              <td className="td text-right">{r.completed}<span className="text-slate-400"> / {r.planned}</span></td>
              <td className="td text-slate-500">{r.last_check_in_at ? fmtDateTime(r.last_check_in_at) : '—'}</td>
            </tr>
          );
        })}
      </Table>
      {flagged > 0 && <div className="pt-2 text-xs text-slate-400">"No activity yet" = visits planned today, nothing started, after 10:00.</div>}
    </Card>
  );
}
