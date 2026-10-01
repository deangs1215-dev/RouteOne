// Rep KPIs per month: sales vs target, activity, route compliance, strike rate.
import { useEffect, useState } from 'react';
import { api, fmtR, todayISO } from '../api';
import { Card, Table, Spinner } from '../components/ui';
import { buildQuarters, deltaLabel } from '../quarters';

const pctColor = (pct) => (pct == null ? 'text-slate-400' : pct >= 90 ? 'text-emerald-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600');

export default function Kpis() {
  const [tab, setTab] = useState('current'); // 'current' | 'history'
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [year, setYear] = useState(null); // null = this year; the history tab pages through earlier years

  useEffect(() => {
    if (tab !== 'current') return;
    setData(null);
    api.get(`/kpis?month=${month}`).then(setData).catch(console.error);
  }, [tab, month]);

  useEffect(() => {
    if (tab !== 'history' || history) return;
    api.get(`/kpis/monthly-history${year ? `?year=${year}` : ''}`).then(setHistory).catch(console.error);
  }, [tab, history, year]);

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
        !history ? <Spinner /> : <QuarterlyHistory history={history} year={year} onYear={(y) => { setHistory(null); setYear(y); }} />
      )}
    </div>
  );
}

// One accent per quarter so the four are told apart at a glance. Class names are written out in
// full (not built from strings) so Tailwind sees and keeps them.
const ACCENTS = [
  { bar: 'bg-sky-500', soft: 'bg-sky-50', text: 'text-sky-700', fill: 'bg-sky-400', head: 'border-sky-400', cell: 'bg-sky-50/70' },
  { bar: 'bg-emerald-500', soft: 'bg-emerald-50', text: 'text-emerald-700', fill: 'bg-emerald-400', head: 'border-emerald-400', cell: 'bg-emerald-50/70' },
  { bar: 'bg-amber-500', soft: 'bg-amber-50', text: 'text-amber-700', fill: 'bg-amber-400', head: 'border-amber-400', cell: 'bg-amber-50/70' },
  { bar: 'bg-violet-500', soft: 'bg-violet-50', text: 'text-violet-700', fill: 'bg-violet-400', head: 'border-violet-400', cell: 'bg-violet-50/70' }
];

function QuarterlyHistory({ history, year, onYear }) {
  const { quarters, rows, totals, maxMonth } = buildQuarters(history.year, history.reps);
  const years = history.years;
  const at = years.indexOf(history.year);
  const money = (v) => (v > 0 ? fmtR(v) : <span className="text-slate-300">—</span>);

  return (
    <div className="space-y-4">
      {/* Year switcher + the year's total */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <button className="rounded-lg px-2.5 py-1.5 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30" disabled={at <= 0}
            onClick={() => onYear(years[at - 1])} aria-label="Previous year">◀</button>
          <div className="min-w-[72px] text-center text-sm font-bold text-slate-700">{history.year}</div>
          <button className="rounded-lg px-2.5 py-1.5 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30" disabled={at < 0 || at >= years.length - 1}
            onClick={() => onYear(years[at + 1])} aria-label="Next year">▶</button>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{history.year} total</div>
          <div className="text-xl font-extrabold text-slate-800">{fmtR(totals.total)}</div>
        </div>
      </div>

      {/* The four quarters */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {quarters.map((qt, i) => {
          const a = ACCENTS[i];
          const delta = deltaLabel(qt.deltaPct);
          return (
            <div key={qt.q} className="card overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
              <div className={`h-1.5 ${a.bar}`} />
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className={`text-3xl font-extrabold leading-none ${a.text}`}>Q{qt.q}</div>
                    <div className="mt-1 text-xs text-slate-400">{qt.labels[0]} – {qt.labels[2]}</div>
                  </div>
                  {qt.status === 'current' && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-600">In progress</span>}
                  {qt.status === 'future' && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Upcoming</span>}
                  {delta && (
                    <span title={`vs Q${qt.q - 1}`} className={`rounded-full px-2 py-0.5 text-xs font-bold ${qt.deltaPct >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                      {qt.deltaPct >= 0 ? '▲' : '▼'} {delta}
                    </span>
                  )}
                </div>

                <div className="mt-4 space-y-2.5">
                  {qt.labels.map((label, m) => (
                    <div key={label}>
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="font-semibold text-slate-500">{label}</span>
                        <span className={`whitespace-nowrap ${qt.monthTotals[m] > 0 ? 'font-semibold text-slate-700' : 'text-slate-300'}`}>{qt.monthTotals[m] > 0 ? fmtR(qt.monthTotals[m]) : '—'}</span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-slate-100">
                        <div className={`h-2 rounded-full ${a.fill} transition-all duration-500`} style={{ width: `${maxMonth ? Math.max(qt.monthTotals[m] > 0 ? 3 : 0, (qt.monthTotals[m] / maxMonth) * 100) : 0}%` }} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className={`mt-4 rounded-lg px-3 py-2 ${a.soft}`}>
                  <div className={`text-[11px] font-bold uppercase tracking-wider ${a.text}`}>Q{qt.q} total</div>
                  <div className="whitespace-nowrap text-lg font-extrabold text-slate-800">{fmtR(qt.total)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Every rep, quarter by quarter */}
      <Card title={`Sales by rep — ${history.year}`}>
        {rows.length === 0 ? <div className="py-6 text-center text-sm text-slate-400">No reps found.</div> : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th rowSpan={2} className="th sticky left-0 z-10 border-b border-slate-200 bg-white align-bottom">Rep</th>
                  {quarters.map((qt, i) => (
                    <th key={qt.q} colSpan={4} className={`border-b-2 px-3 py-2 text-center text-xs font-extrabold uppercase tracking-wider ${ACCENTS[i].head} ${ACCENTS[i].text} ${ACCENTS[i].soft}`}>
                      Q{qt.q}
                    </th>
                  ))}
                  <th rowSpan={2} className="th border-b border-slate-200 bg-slate-50 text-right align-bottom">{history.year}</th>
                </tr>
                <tr>
                  {quarters.map((qt, i) => (
                    [...qt.labels.map((l) => <th key={`${qt.q}-${l}`} className="th border-b border-slate-200 text-right">{l}</th>),
                      <th key={`${qt.q}-t`} className={`th border-b border-slate-200 text-right ${ACCENTS[i].text} ${ACCENTS[i].cell}`}>Q{qt.q} total</th>]
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rep_id} className="group">
                    <td className="td sticky left-0 z-10 border-b border-slate-100 bg-white font-medium group-hover:bg-slate-50">{r.name}</td>
                    {r.quarters.map((qv, i) => (
                      [...qv.values.map((v, m) => <td key={`${i}-${m}`} className="td whitespace-nowrap border-b border-slate-100 text-right text-slate-600 group-hover:bg-slate-50">{money(v)}</td>),
                        <td key={`${i}-t`} className={`td whitespace-nowrap border-b border-slate-100 text-right font-semibold text-slate-800 ${ACCENTS[i].cell}`}>{money(qv.total)}</td>]
                    ))}
                    <td className="td whitespace-nowrap border-b border-slate-100 bg-slate-50 text-right font-bold">{fmtR(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="td sticky left-0 z-10 border-t-2 border-slate-300 bg-white font-extrabold">All reps</td>
                  {totals.quarters.map((qv, i) => (
                    [...qv.values.map((v, m) => <td key={`${i}-${m}`} className="td whitespace-nowrap border-t-2 border-slate-300 text-right font-semibold text-slate-700">{money(v)}</td>),
                      <td key={`${i}-t`} className={`td whitespace-nowrap border-t-2 border-slate-300 text-right font-extrabold text-slate-900 ${ACCENTS[i].cell}`}>{money(qv.total)}</td>]
                  ))}
                  <td className="td whitespace-nowrap border-t-2 border-slate-300 bg-slate-100 text-right font-extrabold">{fmtR(totals.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      <div className="text-[11px] text-slate-400">
        Actual invoiced sales from SYSPRO. Arrows compare a finished quarter with the one before it; the current quarter is still in progress.
      </div>
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
