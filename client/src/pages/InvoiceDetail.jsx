import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate } from '../api';
import { Card, Table, Spinner, Badge } from '../components/ui';

const STATUS_COLORS = { paid: '#16a34a', outstanding: '#0ea5e9', overdue: '#dc2626' };

export default function InvoiceDetail() {
  const { id } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/invoices/${id}`).then(setInvoice).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (!invoice) return <Spinner />;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-slate-400"><Link to="/invoices" className="hover:text-brand-600">Invoices</Link> / {invoice.number}</div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          {invoice.number}
          <Badge color={STATUS_COLORS[invoice.status] || '#64748b'}>{invoice.status}</Badge>
        </h1>
        <div className="text-sm text-slate-500">
          <Link className="hover:text-brand-600 font-medium" to={`/customers/${invoice.customer_id}`}>{invoice.customer_name || invoice.customer_code}</Link>
          {' '}· {fmtDate(invoice.invoice_date)}
          {invoice.due_date && <> · Due {fmtDate(invoice.due_date)}</>}
          {invoice.order_number && <> · Order {invoice.order_number}</>}
        </div>
      </div>

      <Card title="Line items">
        {invoice.items_source === 'order' && (
          <div className="mb-3 text-xs text-amber-600">
            Breakdown from the linked RouteOne order — SYSPRO doesn't sync invoice line detail, so this may not exactly
            match the final invoiced quantities or prices if SYSPRO adjusted them at billing time.
          </div>
        )}
        {invoice.items.length === 0 ? (
          <div className="text-sm text-slate-400">
            {invoice.order_number
              ? "No matching RouteOne order found for this invoice's order number — no line-item breakdown available."
              : 'This invoice has no linked order, so no line-item breakdown is available.'}
          </div>
        ) : (
          <Table headers={['Product', { label: 'Qty', align: 'right' }, { label: 'Unit price', align: 'right' }, { label: 'Total', align: 'right' }]}>
            {invoice.items.map((it, idx) => (
              <tr key={idx} className="hover:bg-slate-50">
                <td className="td">
                  <div className="font-medium">{it.product_name || it.product_code || 'Unknown product'}</div>
                  {it.product_name && it.product_code && <div className="text-xs text-slate-400">{it.product_code}</div>}
                </td>
                <td className="td text-right text-slate-500">{it.qty} {it.uom || ''}</td>
                <td className="td text-right text-slate-500">{fmtR(it.unit_price)}</td>
                <td className="td text-right font-medium">{fmtR(it.line_total)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Totals">
        <div className="max-w-xs space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{fmtR(invoice.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">VAT</span><span>{fmtR(invoice.vat_amount)}</span></div>
          <div className="flex justify-between font-bold border-t border-slate-100 pt-1 mt-1"><span>Total</span><span>{fmtR(invoice.total)}</span></div>
          <div className="flex justify-between text-slate-500"><span>Paid</span><span>{fmtR(invoice.amount_paid)}</span></div>
          <div className="flex justify-between font-medium"><span>Balance</span><span>{fmtR(invoice.balance)}</span></div>
        </div>
      </Card>
    </div>
  );
}
