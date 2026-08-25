import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtRWhole, fmtDate, fmtDateTime } from '../api';
import { Card, Stat, Table, Spinner, OrderStatusBadge } from '../components/ui';
import { useAuth } from '../auth';

export default function Dashboard() {
  const { user } = useAuth();
  const isRep = user.role === 'rep';
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/dashboard').then(setData).catch(console.error);
  }, []);

  if (!data) return <Spinner />;
  const { stats, salesByRep, topCustomers, atRisk, recentOrders, salesTrend } = data;
  const maxTrend = Math.max(...salesTrend.map((d) => d.total), 1);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Sales MTD" value={fmtRWhole(stats.sales_mtd)} accent="text-brand-600" />
        <Stat label="Orders today" value={stats.orders_today} />
        <Stat label="Visits today" value={stats.visits_today} sub={`${stats.visits_pending} still planned`} />
        <Stat label="Active customers" value={stats.active_customers} />
        <Stat label="Avg order value" value={fmtRWhole(stats.avg_order_value)} sub="last 30 days" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {!isRep && (
          <Card title="Sales by rep (month to date)">
            <div className="space-y-3">
              {salesByRep.map((r) => {
                const pct = r.sales_target ? Math.min(100, (r.sales_mtd / r.sales_target) * 100) : 0;
                return (
                  <div key={r.id}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-medium">{r.name}</span>
                      <span>{fmtRWhole(r.sales_mtd)}
                        {r.sales_target > 0 && <span className="ml-1 text-xs text-slate-400">/ {fmtRWhole(r.sales_target)}</span>}
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-slate-100">
                      <div className="h-2 rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                    </div>
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

        <Card title="Top customers (month to date)">
          <Table headers={['Customer', 'City', 'Orders', 'Sales']} empty={topCustomers.length === 0 && 'No sales this month yet.'}>
            {topCustomers.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="td font-medium"><Link className="hover:text-brand-600" to={`/customers/${c.id}`}>{c.name}</Link></td>
                <td className="td text-slate-500">{c.city}</td>
                <td className="td">{c.orders_mtd}</td>
                <td className="td font-medium">{fmtRWhole(c.sales_mtd)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="At-risk customers (no order in 30+ days)">
          <Table headers={['Customer', 'Rep', 'Last order']} empty={atRisk.length === 0 && 'Everyone ordered recently 🎉'}>
            {atRisk.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="td font-medium"><Link className="hover:text-brand-600" to={`/customers/${c.id}`}>{c.name}</Link></td>
                <td className="td text-slate-500">{c.rep_name || '—'}</td>
                <td className="td text-red-600">{c.last_order_at ? fmtDate(c.last_order_at) : 'never'}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Recent orders">
        <Table headers={['Number', 'Customer', 'Rep', 'Date', 'Status', 'Total']} empty={recentOrders.length === 0 && 'No orders yet.'}>
          {recentOrders.map((o) => (
            <tr key={o.id} className="hover:bg-slate-50">
              <td className="td font-medium"><Link className="hover:text-brand-600" to={`/orders/${o.id}`}>{o.number}</Link></td>
              <td className="td">{o.customer_name}</td>
              <td className="td text-slate-500">{o.rep_name || '—'}</td>
              <td className="td text-slate-500">{fmtDateTime(o.order_date)}</td>
              <td className="td"><OrderStatusBadge status={o.status} /></td>
              <td className="td font-medium">{fmtRWhole(o.total)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
