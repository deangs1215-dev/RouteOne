// Sales intelligence: RFM segments, churn risk, recommended next actions.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtR, fmtDate } from '../api';
import { Card, Table, Spinner, Badge } from '../components/ui';

const SEGMENT_COLORS = {
  'Champion': '#16a34a', 'Loyal': '#0ea5e9', 'New / promising': '#8b5cf6',
  'Needs attention': '#f59e0b', "Can't lose": '#dc2626', 'At risk': '#ea580c', 'Hibernating': '#64748b'
};
const riskColor = (r) => (r >= 70 ? 'text-red-600' : r >= 40 ? 'text-amber-600' : 'text-emerald-600');

const ACTION_ICONS = { churn: '🚨', declining: '📉', overdue: '⏰', quote: '📄', account: '💳' };

export default function SalesAI() {
  const [customers, setCustomers] = useState(null);
  const [actions, setActions] = useState(null);
  const [segFilter, setSegFilter] = useState('');

  useEffect(() => {
    api.get('/intel/customers').then(setCustomers).catch(console.error);
    api.get('/intel/actions').then(setActions).catch(console.error);
  }, []);

  if (!customers || !actions) return <Spinner />;

  const segments = {};
  for (const c of customers) segments[c.segment] = (segments[c.segment] || 0) + 1;
  const shown = segFilter ? customers.filter((c) => c.segment === segFilter) : customers;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Sales AI</h1>
        <p className="text-sm text-slate-500">RFM segmentation, churn risk and recommended actions — recomputed live from orders, visits and quotes.</p>
      </div>

      {/* Segment cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {Object.entries(SEGMENT_COLORS).map(([seg, color]) => (
          <button key={seg}
            className={`card p-3 text-left transition ${segFilter === seg ? 'ring-2 ring-brand-500' : 'hover:shadow'}`}
            onClick={() => setSegFilter(segFilter === seg ? '' : seg)}>
            <div className="text-2xl font-bold" style={{ color }}>{segments[seg] || 0}</div>
            <div className="text-xs font-medium text-slate-600">{seg}</div>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card title={`Recommended actions (${actions.length})`} className="lg:col-span-2">
          <div className="max-h-[540px] space-y-2 overflow-y-auto">
            {actions.map((a, i) => (
              <Link key={i} to={a.quote_id ? `/quotes/${a.quote_id}` : `/customers/${a.customer_id}`}
                className="block rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{ACTION_ICONS[a.type]} {a.customer_name}</span>
                  <span className="text-xs text-slate-400">{a.rep_name || '—'}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{a.action}</div>
              </Link>
            ))}
            {actions.length === 0 && <div className="py-6 text-center text-sm text-slate-400">No actions right now — book is healthy. 🎉</div>}
          </div>
        </Card>

        <Card title={`Customers${segFilter ? ` — ${segFilter}` : ' by risk'}`} className="lg:col-span-3">
          <Table headers={['Customer', 'Segment', 'R·F·M', 'Last order', '180d sales', 'Trend', 'Risk']}>
            {shown.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="td font-medium">
                  <Link className="hover:text-brand-600" to={`/customers/${c.id}`}>{c.name}</Link>
                  <div className="text-xs font-normal text-slate-400">{c.rep_name || '—'}</div>
                </td>
                <td className="td"><Badge color={SEGMENT_COLORS[c.segment]}>{c.segment}</Badge></td>
                <td className="td text-slate-500">{c.r_score}·{c.f_score}·{c.m_score}</td>
                <td className="td text-slate-500">{c.last_order_at ? `${c.recency_days}d ago` : 'never'}</td>
                <td className="td">{fmtR(c.monetary_180)}</td>
                <td className={`td ${c.decline_pct > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {c.decline_pct > 0 ? `▼ ${c.decline_pct}%` : '▲'}
                </td>
                <td className={`td font-bold ${riskColor(c.risk_score)}`}>{c.risk_score}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
