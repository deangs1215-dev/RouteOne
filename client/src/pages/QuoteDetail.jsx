import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime } from '../api';
import { Card, Table, Spinner, QuoteStatusBadge, ErrorNote } from '../components/ui';

export default function QuoteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [emailNote, setEmailNote] = useState('');

  const load = () => api.get(`/quotes/${id}`).then(setQuote).catch(console.error);
  useEffect(() => { load(); }, [id]);

  if (!quote) return <Spinner />;
  const open = !quote.order_id && ['draft', 'sent'].includes(quote.status);

  const setStatus = async (status) => {
    try { await api.put(`/quotes/${id}/status`, { status }); load(); }
    catch (e) { setError(e.message); }
  };

  const convert = async () => {
    try {
      const order = await api.post(`/quotes/${id}/convert`);
      navigate(`/orders/${order.id}`);
    } catch (e) { setError(e.message); }
  };

  const emailQuote = async () => {
    setEmailNote('');
    try {
      const r = await api.post(`/quotes/${id}/email`);
      setEmailNote(r.status === 'sent'
        ? `✓ Emailed to ${r.to_addr}`
        : `Saved to email log (${r.error || r.status}) — see Integration page.`);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400"><Link to="/quotes" className="hover:text-brand-600">Quotes</Link> / {quote.number}</div>
          <h1 className="text-xl font-bold flex items-center gap-2">{quote.number} <QuoteStatusBadge status={quote.status} /></h1>
          <div className="text-sm text-slate-500">
            <Link className="hover:text-brand-600 font-medium" to={`/customers/${quote.customer_id}`}>{quote.customer_name}</Link>
            {' '}· {fmtDateTime(quote.quote_date)} · valid until {fmtDate(quote.valid_until)} · Rep: {quote.rep_name || '—'}
          </div>
          {quote.order_id && (
            <div className="mt-1 text-sm">
              Converted to <Link className="text-brand-600 font-medium" to={`/orders/${quote.order_id}`}>{quote.order_number}</Link>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={emailQuote}>✉ Email quote to customer</button>
          {open && (
            <>
              <button className="btn-danger" onClick={() => setStatus('rejected')}>Mark rejected</button>
              <button className="btn-primary" onClick={convert}>Accept &amp; convert to order</button>
            </>
          )}
        </div>
      </div>

      <ErrorNote error={error} />
      {emailNote && <div className="rounded-lg bg-sky-50 border border-sky-200 text-sky-700 text-sm px-3 py-2">{emailNote}</div>}

      <Card title="Quote lines">
        <Table headers={['Product', 'Qty', 'UOM', 'Unit price', 'Line total']}>
          {quote.items.map((i) => (
            <tr key={i.id}>
              <td className="td font-medium">{i.product_name}</td>
              <td className="td">{i.qty}</td>
              <td className="td text-slate-500">{i.uom}</td>
              <td className="td">{fmtR(i.unit_price)}</td>
              <td className="td font-medium">{fmtR(i.line_total)}</td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex justify-end">
          <div className="w-64 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{fmtR(quote.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">VAT (15%)</span><span>{fmtR(quote.vat_amount)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Total</span><span>{fmtR(quote.total)}</span></div>
          </div>
        </div>
      </Card>

      {quote.notes && <Card title="Notes"><p className="text-sm">{quote.notes}</p></Card>}
    </div>
  );
}
