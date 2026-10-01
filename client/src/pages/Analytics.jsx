// Analytics: current month trends, monthly sales vs budget, product performance, quote funnel.
// Margin is deliberately not shown anywhere on this page.
import { useEffect, useState } from 'react';
import { api, fmtR } from '../api';
import { Card, Stat, Table, Spinner } from '../components/ui';

export default function Analytics() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/analytics?days=30`).then(setData).catch(console.error);
  }, []);

  const exportCsv = () => {
    if (!data) return;
    const lines = [['Product code', 'Product', 'Units', 'Revenue']];
    for (const p of data.topProducts) lines.push([p.code, p.name, p.units, p.revenue.toFixed(2)]);
    const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'product-performance.csv';
    a.click();
  };

  if (!data) return <Spinner />;
  const { totals, monthly, topProducts, quoteFunnel } = data;
  // The budget line sits on the same scale as the bars, so the scale has to cover whichever is bigger.
  // A budget that covers only some of the reps (3 of 46 on production) is a different scale from the
  // bars, which are everyone's sales - so the line is drawn, and counted in the scale, only when the
  // budget covers all the reps. Otherwise just the percentage (it is measured on those reps alone).
  const budgetOnScale = (m) => m.budget > 0 && m.budgeted_reps === m.total_reps;
  const maxMonthly = Math.max(...monthly.map((m) => Math.max(m.sales, budgetOnScale(m) ? m.budget : 0)), 1);
  const coverage = [...monthly].reverse().find((m) => m.budget > 0);
  const CHART_H = 150;
  const MINUS = '−';
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Year to date, counting only COMPLETED months that have a budget - the month in progress would
  // read as a miss simply because it isn't over.
  const done = monthly.filter((m) => m.month < currentMonth && m.budget > 0);
  const ytdBudget = done.reduce((s, m) => s + m.budget, 0);
  const ytdSales = done.reduce((s, m) => s + (m.budget_sales || 0), 0);
  const ytdPct = ytdBudget > 0 ? Math.round((ytdSales / ytdBudget) * 100) : null;
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = (m) => MONTH_NAMES[parseInt(m.slice(5, 7), 10) - 1];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Analytics</h1>
        <button className="btn-secondary text-xs" onClick={exportCsv}>⬇ CSV</button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Revenue" value={fmtR(totals.revenue)} accent="text-brand-600" sub="month to date" />
        <Stat label="Orders" value={totals.orders} />
        <Stat label="Avg order value" value={fmtR(totals.aov)} />
        <Stat label="Buying customers" value={totals.active_customers} />
      </div>

      <Card title="Monthly sales (YTD)">
        {ytdPct !== null && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-slate-500">Year to date vs budget</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${ytdPct >= 100 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
              {ytdPct >= 100 ? `+${ytdPct - 100}%` : `${MINUS}${100 - ytdPct}%`}
            </span>
            <span className="text-xs text-slate-400">{ytdPct}% of budget · {fmtR(ytdSales)} of {fmtR(ytdBudget)} (completed months)</span>
          </div>
        )}
        <div className="flex items-start gap-2">
          {monthly.map((m) => {
            const pct = m.achieved_pct;
            const inProgress = m.month === currentMonth;
            return (
              <div key={m.month} className="group relative flex-1 text-center">
                <div className="relative flex items-end" style={{ height: `${CHART_H + 4}px` }}>
                  <div className="w-full rounded-t bg-brand-500/80 group-hover:bg-brand-600" style={{ height: `${(m.sales / maxMonthly) * CHART_H + 4}px` }} />
                  {budgetOnScale(m) && (
                    <div className="pointer-events-none absolute left-0 right-0 border-t-2 border-dashed border-slate-700/60" style={{ bottom: `${(m.budget / maxMonthly) * CHART_H + 4}px` }} />
                  )}
                </div>
                <div className="mt-1 text-[10px] text-slate-400">{monthLabel(m.month)}</div>
                {/* Past months: how far over (green +) or under (red −) budget. The month in progress is
                    shown as a plain "% of budget so far" - it would read as a miss just for not being over. */}
                <div className={`text-[11px] font-bold ${pct === null ? 'text-slate-300' : inProgress ? 'text-slate-500' : pct >= 100 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {pct === null ? '–' : inProgress ? `${pct}%` : pct >= 100 ? `+${pct - 100}%` : `${MINUS}${100 - pct}%`}
                </div>
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
                  {m.month}: {fmtR(m.sales)} · {m.orders} orders
                  {m.budget > 0 && (
                    <>
                      <br />{pct}% of budget{inProgress ? ' so far' : ''}: {fmtR(m.budget_sales)} of {fmtR(m.budget)}
                      <br />({m.budgeted_reps} of {m.total_reps} reps have a budget)
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[11px] text-slate-400">
          Under each month: <span className="font-semibold text-emerald-600">+%</span> over budget, <span className="font-semibold text-red-600">{MINUS}%</span> under budget; the current month shows % of budget so far.
          {coverage
            ? ` Measured on the ${coverage.budgeted_reps} of ${coverage.total_reps} reps who have a monthly budget set - their sales against their budget.`
            : ' No monthly budgets are set yet (Users → "budgets" on a rep).'}
          {monthly.some(budgetOnScale) && ' Dashed line = budget.'}
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
        <Table headers={['Code', 'Product', 'Units', 'Revenue']}>
          {topProducts.map((p) => (
            <tr key={p.code} className="hover:bg-slate-50">
              <td className="td text-slate-500">{p.code}</td>
              <td className="td font-medium">{p.name}</td>
              <td className="td">{p.units}</td>
              <td className="td font-medium">{fmtR(p.revenue)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
