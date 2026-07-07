import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtR, fmtDateTime, fmtDate } from '../api';
import { Card, Table, Spinner, QuoteStatusBadge } from '../components/ui';
import NewOrderModal from '../components/NewOrderModal';

const STATUSES = ['', 'draft', 'sent', 'accepted', 'rejected', 'expired'];

export default function Quotes() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    api.get(`/quotes?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [q, status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Quotes</h1>
        <button className="btn-primary" onClick={() => setShowNew(true)}>+ New quote</button>
      </div>

      <div className="flex flex-wrap gap-3">
        <input className="input max-w-xs" placeholder="Search number or customer…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s ? s : 'All statuses'}</option>)}
        </select>
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Number', 'Customer', 'Rep', 'Date', 'Valid until', 'Status', 'Total']}
            empty={rows.length === 0 && 'No quotes found.'}>
            {rows.map((qu) => (
              <tr key={qu.id} className="hover:bg-slate-50">
                <td className="td font-medium"><Link className="hover:text-brand-600" to={`/quotes/${qu.id}`}>{qu.number}</Link></td>
                <td className="td">{qu.customer_name}</td>
                <td className="td text-slate-500">{qu.rep_name || '—'}</td>
                <td className="td text-slate-500">{fmtDateTime(qu.quote_date)}</td>
                <td className="td text-slate-500">{fmtDate(qu.valid_until)}</td>
                <td className="td"><QuoteStatusBadge status={qu.status} /></td>
                <td className="td font-medium">{fmtR(qu.total)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {showNew && <NewOrderModal kind="quote" onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
    </div>
  );
}
