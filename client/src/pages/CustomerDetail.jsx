import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime } from '../api';
import { Card, Stat, Table, Modal, Field, Spinner, ErrorNote, GradeBadge, Badge, OrderStatusBadge, VisitStatusBadge, QuoteStatusBadge } from '../components/ui';
import VisitSummary from '../components/VisitSummary';
import { CustomerModal } from './Customers';
import { useAuth } from '../auth';

export default function CustomerDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [c, setC] = useState(null);
  const [intel, setIntel] = useState(null);
  const [territories, setTerritories] = useState([]);
  const [showEdit, setShowEdit] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [selectedVisitId, setSelectedVisitId] = useState(null);

  const load = () => api.get(`/customers/${id}`).then(setC).catch(console.error);
  useEffect(() => {
    load();
    api.get(`/intel/customer/${id}`).then(setIntel).catch(() => {});
  }, [id]);
  useEffect(() => { api.get('/territories').then(setTerritories).catch(() => {}); }, []);

  if (!c) return <Spinner />;
  const canPrice = ['admin', 'manager', 'office'].includes(user.role);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400"><Link to="/customers" className="hover:text-brand-600">Customers</Link> / {c.code}</div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            {c.name} <GradeBadge grade={c.classification} />
            <Badge color={c.status === 'active' ? '#16a34a' : c.status === 'on_hold' ? '#f59e0b' : '#64748b'}>{c.status.replace('_', ' ')}</Badge>
          </h1>
          <div className="text-sm text-slate-500">{c.address}{c.city ? `, ${c.city}` : ''} · {c.territory_name || 'No territory'} · Rep: {c.rep_name || '—'}</div>
        </div>
        <div className="flex gap-2">
          {canPrice && <button className="btn-secondary" onClick={() => setShowPrices(true)}>Contract prices</button>}
          <button className="btn-primary" onClick={() => setShowEdit(true)}>Edit</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sales MTD" value={fmtR(c.stats.sales_mtd)} accent="text-brand-600" />
        <Stat label="Sales 12 months" value={fmtR(c.stats.sales_12m)} />
        <Stat label="Total orders" value={c.stats.order_count} />
        <Stat label="Credit limit" value={fmtR(c.credit_limit)} sub={c.payment_terms} />
      </div>

      {intel && (
        <Card title="Sales intelligence">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span>Segment: <Badge color="#8b5cf6">{intel.segment}</Badge></span>
            <span>Churn risk: <b className={intel.risk_score >= 70 ? 'text-red-600' : intel.risk_score >= 40 ? 'text-amber-600' : 'text-emerald-600'}>{intel.risk_score}/100</b></span>
            <span className="text-slate-500">Last order {intel.last_order_at ? `${intel.recency_days}d ago` : 'never'} · buys ~every {intel.cycle_days}d · R·F·M {intel.r_score}·{intel.f_score}·{intel.m_score}</span>
            {intel.decline_pct > 0 && <span className="text-red-600">▼ spend down {intel.decline_pct}% vs prior quarter</span>}
          </div>
          {(intel.suggested_products.length > 0 || intel.lapsed_products.length > 0) && (
            <div className="mt-3 grid gap-4 border-t border-slate-100 pt-3 sm:grid-cols-2">
              <div>
                <div className="label">Suggested products (others buy, they don't)</div>
                <ul className="space-y-0.5 text-sm">
                  {intel.suggested_products.map((p) => <li key={p.id}>• {p.name}</li>)}
                  {intel.suggested_products.length === 0 && <li className="text-slate-400">None</li>}
                </ul>
              </div>
              <div>
                <div className="label">Lapsed products (stopped buying)</div>
                <ul className="space-y-0.5 text-sm">
                  {intel.lapsed_products.map((p) => <li key={p.id}>• {p.name} <span className="text-xs text-slate-400">last {fmtDate(p.last_bought)}</span></li>)}
                  {intel.lapsed_products.length === 0 && <li className="text-slate-400">None</li>}
                </ul>
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Contacts" actions={<button className="btn-secondary text-xs" onClick={() => setShowContact(true)}>+ Add</button>}>
          <Table headers={['Name', 'Role', 'Phone', 'Email', '']} empty={c.contacts.length === 0 && 'No contacts yet.'}>
            {c.contacts.map((ct) => (
              <tr key={ct.id}>
                <td className="td font-medium">{ct.name}</td>
                <td className="td text-slate-500">{ct.role || '—'}</td>
                <td className="td text-slate-500">{ct.phone || '—'}</td>
                <td className="td text-slate-500">{ct.email || '—'}</td>
                <td className="td">
                  <button className="text-xs text-red-500 hover:underline"
                    onClick={() => api.del(`/contacts/${ct.id}`).then(load)}>remove</button>
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Visit history">
          <Table headers={['Date', 'Rep', 'Status', 'Outcome']} empty={c.recent_visits.length === 0 && 'No visits yet.'}>
            {c.recent_visits.map((v) => (
              <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelectedVisitId(selectedVisitId === v.id ? null : v.id)}>
                <td className="td">{fmtDateTime(v.check_in_at || v.planned_date)}</td>
                <td className="td text-slate-500">{v.rep_name}</td>
                <td className="td"><VisitStatusBadge status={v.status} /></td>
                <td className="td text-slate-500">{v.outcome ? v.outcome.replace('_', ' ') : '—'}</td>
              </tr>
            ))}
          </Table>
          {selectedVisitId && (
            <div className="border-t border-slate-100 pt-4 mt-4">
              <div className="text-xs font-semibold text-slate-500 uppercase mb-3">Visit summary</div>
              <VisitSummary visitId={selectedVisitId} />
            </div>
          )}
        </Card>
      </div>

      {c.recent_quotes?.length > 0 && (
        <Card title="Quotes">
          <Table headers={['Number', 'Date', 'Rep', 'Status', 'Total']}>
            {c.recent_quotes.map((qu) => (
              <tr key={qu.id} className="hover:bg-slate-50">
                <td className="td font-medium"><Link className="hover:text-brand-600" to={`/quotes/${qu.id}`}>{qu.number}</Link></td>
                <td className="td text-slate-500">{fmtDateTime(qu.quote_date)}</td>
                <td className="td text-slate-500">{qu.rep_name || '—'}</td>
                <td className="td"><QuoteStatusBadge status={qu.status} /></td>
                <td className="td font-medium">{fmtR(qu.total)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Order history">
        <Table headers={['Number', 'Date', 'Rep', 'Status', 'Total']} empty={c.recent_orders.length === 0 && 'No orders yet.'}>
          {c.recent_orders.map((o) => (
            <tr key={o.id} className="hover:bg-slate-50">
              <td className="td font-medium"><Link className="hover:text-brand-600" to={`/orders/${o.id}`}>{o.number}</Link></td>
              <td className="td text-slate-500">{fmtDateTime(o.order_date)}</td>
              <td className="td text-slate-500">{o.rep_name || '—'}</td>
              <td className="td"><OrderStatusBadge status={o.status} /></td>
              <td className="td font-medium">{fmtR(o.total)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {c.notes && <Card title="Notes"><p className="text-sm whitespace-pre-wrap">{c.notes}</p></Card>}

      {showEdit && (
        <CustomerModal customer={c} territories={territories}
          onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />
      )}
      {showContact && <ContactModal customerId={c.id} onClose={() => setShowContact(false)} onSaved={() => { setShowContact(false); load(); }} />}
      {showPrices && <PricesModal customer={c} onClose={() => { setShowPrices(false); load(); }} />}
    </div>
  );
}

function ContactModal({ customerId, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', role: '', phone: '', email: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/customers/${customerId}/contacts`, form);
      onSaved();
    } catch (err) { setError(err.message); }
  };

  return (
    <Modal title="Add contact" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Name"><input className="input" value={form.name} onChange={set('name')} required /></Field>
        <Field label="Role"><input className="input" value={form.role} onChange={set('role')} placeholder="Buyer, Owner…" /></Field>
        <Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// Contract price editor: shows every product with list price and optional customer price.
function PricesModal({ customer, onClose }) {
  const [products, setProducts] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.get(`/products/for-customer/${customer.id}`).then(setProducts).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const setPrice = async (productId, price) => {
    try {
      await api.put(`/customers/${customer.id}/prices/${productId}`, { price: price === '' ? null : Number(price) });
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <Modal title={`Contract prices — ${customer.name}`} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!products ? <Spinner /> : (
        <Table headers={['Product', 'List price', 'Contract price', '']}>
          {products.map((p) => (
            <tr key={p.id}>
              <td className="td">{p.name}</td>
              <td className="td text-slate-500">{fmtR(p.list_price)}</td>
              <td className="td">
                <PriceInput
                  initial={p.has_contract_price ? p.effective_price : ''}
                  onCommit={(v) => setPrice(p.id, v)}
                />
              </td>
              <td className="td">
                {p.has_contract_price === 1 && (
                  <button className="text-xs text-red-500 hover:underline" onClick={() => setPrice(p.id, '')}>clear</button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Modal>
  );
}

function PriceInput({ initial, onCommit }) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <input className="input max-w-[120px]" type="number" step="0.01" min="0" placeholder="—"
      value={value} onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== initial && onCommit(value)} />
  );
}
