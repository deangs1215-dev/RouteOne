import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtR, fmtDateTime } from '../api';
import { Card, Table, Spinner, OrderStatusBadge } from '../components/ui';
import NewOrderModal from '../components/NewOrderModal';

const STATUSES = ['', 'draft', 'submitted', 'processing', 'invoiced', 'cancelled'];

export default function Orders() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    api.get(`/orders?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [q, status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Orders</h1>
        <button className="btn-primary" onClick={() => setShowNew(true)}>+ New order</button>
      </div>

      <div className="flex flex-wrap gap-3">
        <input className="input max-w-xs" placeholder="Search number or customer…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s ? s : 'All statuses'}</option>)}
        </select>
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Number', 'Customer', 'Rep', 'Date', 'Lines', 'Status', 'Total']}
            empty={rows.length === 0 && 'No orders found.'} emptyIcon="🧾">
            {rows.map((o) => (
              <tr key={o.id} className="hover:bg-slate-50">
                <td className="td font-medium"><Link className="hover:text-brand-600" to={`/orders/${o.id}`}>{o.number}</Link></td>
                <td className="td">{o.customer_name}</td>
                <td className="td text-slate-500">{o.rep_name || '—'}</td>
                <td className="td text-slate-500">{fmtDateTime(o.order_date)}</td>
                <td className="td text-slate-500">{o.line_count}</td>
                <td className="td"><OrderStatusBadge status={o.status} /></td>
                <td className="td font-medium">{fmtR(o.total)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {showNew && <NewOrderModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
    </div>
  );
}
