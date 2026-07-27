// Analytics: trends, product performance, margin, quote funnel.
import { useEffect, useState } from 'react';
import { api, fmtR } from '../api';
import { Card, Stat, Table, Spinner } from '../components/ui';

const PERIODS = [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '12 months']];

export default function Analytics() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    api.get(`/analytics?days=${days}`).then(setData).catch(console.error);
  }, [days]);

  const exportCsv = () => {
    if (!data) return;
    const lines = [['Product code', 'Product', 'Units', 'Revenue', 'Margin']];
    for (const p of data.topProducts) lines.push([p.code, p.name, p.units, p.revenue.toFixed(2), p.margin.toFixed(2)]);
    const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `product-performance-${days}d.csv`;
    a.click();
  };

  if (!data) return <Spinner />;
  const { totals, monthly, topProducts, quoteFunnel } = data;
  const maxMonthly = Math.max(...monthly.map((m) => m.sales), 1);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Analytics</h1>
        <div className="flex gap-2">
          {PERIODS.map(([d, label]) => (
            <button key={d} className={days === d ? 'btn-primary text-xs' : 'btn-secondary text-xs'} onClick={() => setDays(d)}>{label}</button>
          ))}
          <button className="btn-secondary text-xs" onClick={exportCsv}>⬇ CSV</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Revenue" value={fmtR(totals.revenue)} accent="text-brand-600" sub={`last ${days} days`} />
        <Stat label="Gross margin" value={fmtR(totals.margin)} sub={`${totals.margin_pct}% of revenue`} />
        <Stat label="Orders" value={totals.orders} />
        <Stat label="Avg order value" value={fmtR(totals.aov)} />
        <Stat label="Buying customers" value={totals.active_customers} />
      </div>

      <Card title="Monthly sales (last 12 months)">
        <div className="flex h-44 items-end gap-2">
          {monthly.map((m) => (
            <div key={m.month} className="group relative flex-1 text-center">
              <div className="mx-auto rounded-t bg-brand-500/80 group-hover:bg-brand-600" style={{ height: `${(m.sales / maxMonthly) * 150 + 4}px` }} />
              <div className="mt-1 text-[10px] text-slate-400">{m.month.slice(2).replace('-', '/')}</div>
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
                {m.month}: {fmtR(m.sales)} · {m.orders} orders
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6">
        <Card title="Quote funnel">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div><div className="text-xl font-bold">{quoteFunnel.total}</div><div className="text-[10px] uppercase text-slate-400">quoted</div></div>
            <div><div className="text-xl font-bold text-emerald-600">{quoteFunnel.accepted}</div><div className="text-[10px] uppercase text-slate-400">accepted</div></div>
            <div><div className="text-xl font-bold text-red-600">{quoteFunnel.rejected}</div><div className="text-[10px] uppercase text-slate-400">rejected</div></div>
            <div><div className="text-xl font-bold text-sky-600">{quoteFunnel.open}</div><div className="text-[10px] uppercase text-slate-400">open</div></div>
          </div>
          <div className="mt-3 text-center text-xs text-slate-400">
            {quoteFunnel.total > 0 ? `${Math.round((quoteFunnel.accepted / quoteFunnel.total) * 100)}% acceptance` : 'No quotes in period'} · accepted value {fmtR(quoteFunnel.accepted_value)}
          </div>
        </Card>
      </div>

      <Card title="Product performance">
        <Table headers={['Code', 'Product', 'Units', 'Revenue', 'Margin', 'Margin %']}>
          {topProducts.map((p) => (
            <tr key={p.code} className="hover:bg-slate-50">
              <td className="td text-slate-500">{p.code}</td>
              <td className="td font-medium">{p.name}</td>
              <td className="td">{p.units}</td>
              <td className="td font-medium">{fmtR(p.revenue)}</td>
              <td className="td">{fmtR(p.margin)}</td>
              <td className={`td font-medium ${p.revenue && p.margin / p.revenue < 0.15 ? 'text-red-600' : 'text-emerald-600'}`}>
                {p.revenue ? Math.round((p.margin / p.revenue) * 100) : 0}%
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
