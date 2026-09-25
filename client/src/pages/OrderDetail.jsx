import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, fmtR, fmtDateTime } from '../api';
import { Card, Table, Spinner, OrderStatusBadge, ErrorNote } from '../components/ui';
import { PRICE_SOURCE_LABELS } from '../components/NewOrderModal';
import { useAuth } from '../auth';

const NEXT_ACTIONS = {
  draft: [['submitted', 'Submit order']],
  submitted: [['processing', 'Start processing'], ['cancelled', 'Cancel']],
  processing: [['invoiced', 'Mark invoiced'], ['cancelled', 'Cancel']],
  invoiced: [],
  cancelled: []
};

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canChangeStatus = ['admin', 'manager', 'office'].includes(user.role);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [emailNote, setEmailNote] = useState('');

  const load = () => api.get(`/orders/${id}`).then(setOrder).catch(console.error);
  useEffect(() => { load(); }, [id]);

  if (!order) return <Spinner />;

  const setStatus = async (status) => {
    try {
      await api.put(`/orders/${id}/status`, { status });
      load();
    } catch (e) { setError(e.message); }
  };

  const repeat = async () => {
    try {
      const newOrder = await api.post(`/orders/${id}/repeat`);
      navigate(`/orders/${newOrder.id}`);
    } catch (e) { setError(e.message); }
  };

  const sendMail = async (path) => {
    setEmailNote('');
    try {
      const r = await api.post(path);
      setEmailNote(r.status === 'sent'
        ? `✓ Emailed to ${r.to_addr}`
        : `Saved to email log (${r.error || r.status}) — see Integration page.`);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400"><Link to="/orders" className="hover:text-brand-600">Orders</Link> / {order.number}</div>
          <h1 className="text-xl font-bold flex items-center gap-2">{order.number} <OrderStatusBadge status={order.status} /></h1>
          <div className="text-sm text-slate-500">
            <Link className="hover:text-brand-600 font-medium" to={`/customers/${order.customer_id}`}>{order.customer_name}</Link>
            {' '}· {fmtDateTime(order.order_date)} · Rep: {order.rep_name || '—'} · Terms: {order.payment_terms}
            {' '}· Warehouse: {order.warehouse_name ? `${order.warehouse_name} (${order.warehouse_code})` : '—'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => sendMail(`/orders/${id}/email-customer`)}>✉ Confirmation to customer</button>
          <button className="btn-secondary" onClick={repeat}>Repeat order</button>
          {canChangeStatus && NEXT_ACTIONS[order.status].map(([status, label]) => (
            <button key={status} className={status === 'cancelled' ? 'btn-danger' : 'btn-primary'} onClick={() => setStatus(status)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error} />
      {emailNote && <div className="rounded-lg bg-sky-50 border border-sky-200 text-sky-700 text-sm px-3 py-2">{emailNote}</div>}

      <Card title="Order lines">
        <Table headers={['Product', 'Qty', 'UOM', 'Unit price', 'Discount', 'Line total']}>
          {order.items.map((i) => (
            <tr key={i.id}>
              <td className="td font-medium">
                {i.product_name}
                {i.backorder === 1 && ['submitted', 'processing'].includes(order.status) && (
                  <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 border border-amber-200">BACKORDER</span>
                )}
              </td>
              <td className="td">{i.qty}</td>
              <td className="td text-slate-500">{i.uom}</td>
              <td className="td">
                {fmtR(i.unit_price)}
                {/* R1-044: which tier this line's price came from, so a rep
                    questioning it later doesn't have to guess or ask office -
                    older lines from before this was tracked show nothing. */}
                {i.price_source && PRICE_SOURCE_LABELS[i.price_source] && (
                  <div className="text-[11px] font-normal text-slate-400">{PRICE_SOURCE_LABELS[i.price_source]}</div>
                )}
              </td>
              <td className="td text-slate-500">{i.discount_pct ? `${i.discount_pct}%` : '—'}</td>
              <td className="td font-medium">{fmtR(i.line_total)}</td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex justify-end">
          <div className="w-64 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{fmtR(order.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">VAT (15%)</span><span>{fmtR(order.vat_amount)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Total</span><span>{fmtR(order.total)}</span></div>
          </div>
        </div>
      </Card>

      {order.customer_order_no && (
        <Card title="Customer Order No. / Reference">
          <p className="text-sm font-medium text-slate-800">{order.customer_order_no}</p>
        </Card>
      )}

      {(order.notes || order.delivery_instructions) && (
        <Card title="Notes">
          {order.notes && <p className="text-sm"><span className="font-medium">Notes:</span> {order.notes}</p>}
          {order.delivery_instructions && <p className="text-sm mt-1"><span className="font-medium">Delivery:</span> {order.delivery_instructions}</p>}
        </Card>
      )}
    </div>
  );
}
