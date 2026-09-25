// Rep KPIs per month: sales vs target, activity, route compliance, strike rate.
import { useEffect, useState } from 'react';
import { api, fmtR, todayISO } from '../api';
import { Card, Table, Spinner } from '../components/ui';

const pctColor = (pct) => (pct == null ? 'text-slate-400' : pct >= 90 ? 'text-emerald-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600');

// Short month label for a table column header, e.g. "2026-07" -> "Jul '26".
const monthLabel = (m) => {
  const [y, mo] = m.split('-');
  const name = new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-ZA', { month: 'short' });
  return `${name} '${y.slice(2)}`;
};

export default function Kpis() {
  const [tab, setTab] = useState('current'); // 'current' | 'history'
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);

  useEffect(() => {
    if (tab !== 'current') return;
    setData(null);
    api.get(`/kpis?month=${month}`).then(setData).catch(console.error);
  }, [tab, month]);

  useEffect(() => {
    if (tab !== 'history' || history) return;
    api.get('/kpis/monthly-history').then(setHistory).catch(console.error);
  }, [tab]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Rep KPIs</h1>
        {tab === 'current' && (
          <input className="input max-w-[170px]" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        )}
      </div>

      <div className="flex gap-2 border-b border-slate-200">
        <button
          onClick={() => setTab('current')}
          className={`px-3 py-2 text-sm font-semibold border-b-2 transition ${tab === 'current' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400'}`}
        >
          This month
        </button>
        <button
          onClick={() => setTab('history')}
          className={`px-3 py-2 text-sm font-semibold border-b-2 transition ${tab === 'history' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400'}`}
        >
          Monthly history
        </button>
      </div>

      {tab === 'current' && (
        !data ? <Spinner /> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.kpis.map((k) => (
              <Card key={k.rep_id} title={k.name}>
                <div className="mb-3">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-slate-500">Sales vs target</span>
                    <span className="font-semibold">{fmtR(k.sales)}
                      {k.target > 0 && <span className="ml-1 text-xs font-normal text-slate-400">/ {fmtR(k.target)}</span>}
                    </span>
                  </div>
                  {k.target > 0 && (
                    <div className="mt-1.5 h-2.5 rounded-full bg-slate-100">
                      <div className={`h-2.5 rounded-full ${k.target_pct >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                        style={{ width: `${Math.min(100, k.target_pct)}%` }} />
                    </div>
                  )}
                </div>

                {/* R1-056: Jan-through-selected-month, not the full annual
                    target - see the server-side comment on ytdSales/ytdTarget
                    for why comparing e.g. September actuals against a
                    12-month target would misleadingly understate achievement. */}
                <div className="mb-3">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-slate-500">YTD vs target</span>
                    <span className="font-semibold">{fmtR(k.ytd_sales)}
                      {k.ytd_target > 0 && <span className="ml-1 text-xs font-normal text-slate-400">/ {fmtR(k.ytd_target)}</span>}
                    </span>
                  </div>
                  {k.ytd_target > 0 && (
                    <div className="mt-1.5 h-2.5 rounded-full bg-slate-100">
                      <div className={`h-2.5 rounded-full ${k.ytd_target_pct >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                        style={{ width: `${Math.min(100, k.ytd_target_pct)}%` }} />
                    </div>
                  )}
                  {k.ytd_target_pct != null && (
                    <div className={`mt-1 text-right text-xs font-semibold ${pctColor(k.ytd_target_pct)}`}>{k.ytd_target_pct}% YTD achieved</div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-x-3 gap-y-3 text-center">
                  <Kpi label="Orders" value={k.orders} />
                  <Kpi label="Avg order" value={fmtR(k.avg_order_value)} />
                  <Kpi label="Quotes" value={`${k.quotes_accepted}/${k.quotes}`} sub="accepted" />
                  <Kpi label="Visits done" value={k.visits_completed} sub={`${k.visits_missed} missed`} />
                  <Kpi label="Compliance" value={k.compliance_pct != null ? `${k.compliance_pct}%` : '—'} accent={pctColor(k.compliance_pct)} sub="planned → done" />
                  <Kpi label="Strike rate" value={k.strike_rate_pct != null ? `${k.strike_rate_pct}%` : '—'} accent={pctColor(k.strike_rate_pct)} sub="visits → orders" />
                  <Kpi label="Coverage" value={k.coverage_pct != null ? `${k.coverage_pct}%` : '—'} accent={pctColor(k.coverage_pct)} sub={`${k.customers_visited}/${k.customers_assigned} customers`} />
                  <Kpi label="Time on site" value={`${k.hours_on_site}h`} />
                  <Kpi label="Target" value={k.target_pct != null ? `${k.target_pct}%` : '—'} accent={pctColor(k.target_pct)} />
                </div>
              </Card>
            ))}
          </div>

          <Card title="Leaderboard">
            <Table headers={['#', 'Rep', 'Sales', 'Target %', 'Orders', 'Visits', 'Compliance', 'Strike rate', 'Coverage']}>
              {data.kpis.map((k, i) => (
                <tr key={k.rep_id} className="hover:bg-slate-50">
                  <td className="td">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                  <td className="td font-medium">{k.name}</td>
                  <td className="td font-medium">{fmtR(k.sales)}</td>
                  <td className={`td font-medium ${pctColor(k.target_pct)}`}>{k.target_pct != null ? `${k.target_pct}%` : '—'}</td>
                  <td className="td">{k.orders}</td>
                  <td className="td">{k.visits_completed}</td>
                  <td className={`td ${pctColor(k.compliance_pct)}`}>{k.compliance_pct != null ? `${k.compliance_pct}%` : '—'}</td>
                  <td className={`td ${pctColor(k.strike_rate_pct)}`}>{k.strike_rate_pct != null ? `${k.strike_rate_pct}%` : '—'}</td>
                  <td className={`td ${pctColor(k.coverage_pct)}`}>{k.coverage_pct != null ? `${k.coverage_pct}%` : '—'}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
        )
      )}

      {tab === 'history' && (
        !history ? <Spinner /> : (
          <Card title={`Monthly sales — ${monthLabel(history.months[0])} to ${monthLabel(history.months[history.months.length - 1])}`}>
            <Table headers={['Rep', ...history.months.map((m) => ({ label: monthLabel(m), align: 'right' })), { label: '12-mo total', align: 'right' }]}
              empty={history.reps.length === 0 && 'No reps found.'}>
              {history.reps.map((r) => (
                <tr key={r.rep_id} className="hover:bg-slate-50">
                  <td className="td font-medium sticky left-0 bg-white">{r.name}</td>
                  {history.months.map((m) => (
                    <td key={m} className="td text-right text-slate-600">
                      {r.months[m] > 0 ? fmtR(r.months[m]) : <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                  <td className="td text-right font-semibold">{fmtR(r.total)}</td>
                </tr>
              ))}
            </Table>
          </Card>
        )
      )}
    </div>
  );
}

function Kpi({ label, value, sub, accent = 'text-slate-900' }) {
  return (
    <div>
      <div className={`text-lg font-bold ${accent}`}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}
