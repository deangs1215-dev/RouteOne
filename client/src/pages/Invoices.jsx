import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtR, fmtDate } from '../api';
import { Card, Table, Spinner } from '../components/ui';

export default function Invoices() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    api.get(`/invoices?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [q]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Invoices</h1>

      <div className="flex flex-wrap gap-3">
        <input className="input max-w-xs" placeholder="Search number, customer or code…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Number', 'Customer', 'Date', { label: 'Subtotal', align: 'right' }, { label: 'VAT', align: 'right' }, { label: 'Total', align: 'right' }]}
            empty={rows.length === 0 && 'No invoices found.'} emptyIcon="📋">
            {rows.map((inv) => (
              <tr key={inv.id} className="hover:bg-slate-50">
                <td className="td font-medium">{inv.number}</td>
                <td className="td">{inv.customer_name || inv.customer_code}</td>
                <td className="td text-slate-500">{fmtDate(inv.invoice_date)}</td>
                <td className="td text-right text-slate-500">{fmtR(inv.subtotal)}</td>
                <td className="td text-right text-slate-500">{fmtR(inv.vat_amount)}</td>
                <td className="td text-right font-medium">{fmtR(inv.total)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
