import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime } from '../api';
import { Card, Stat, Table, Modal, Field, Spinner, ErrorNote, GradeBadge, Badge, OrderStatusBadge, VisitStatusBadge, QuoteStatusBadge } from '../components/ui';
import VisitSummary from '../components/VisitSummary';
import LocationPicker from '../components/LocationPicker';
import { CustomerModal } from './Customers';
import { useAuth } from '../auth';

export default function CustomerDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [c, setC] = useState(null);
  const [intel, setIntel] = useState(null);
  const [salesPushes, setSalesPushes] = useState([]);
  const [showEdit, setShowEdit] = useState(false);
  const [showRouteOneDetails, setShowRouteOneDetails] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [selectedVisitId, setSelectedVisitId] = useState(null);

  const load = () => api.get(`/customers/${id}`).then(setC).catch(console.error);
  useEffect(() => {
    load();
    api.get(`/intel/customer/${id}`).then(setIntel).catch(() => {});
    api.get('/sales-pushes/active').then(setSalesPushes).catch(() => {});
  }, [id]);

  if (!c) return <Spinner />;
  const canPrice = ['admin', 'manager', 'office'].includes(user.role);
  const canEdit = ['admin', 'manager', 'office'].includes(user.role);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400"><Link to="/customers" className="hover:text-brand-600">Customers</Link> / {c.code}</div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            {c.name} <GradeBadge grade={c.classification} />
            <Badge color={c.status === 'active' ? '#16a34a' : c.status === 'on_hold' ? '#f59e0b' : '#64748b'}>{c.status.replace('_', ' ')}</Badge>
          </h1>
          <div className="text-sm text-slate-500">{c.address}{c.city ? `, ${c.city}` : ''} · Rep: {c.rep_name || '—'}</div>
        </div>
        <div className="flex gap-2">
          {canPrice && <button className="btn-secondary" onClick={() => setShowPrices(true)}>Contract prices</button>}
          <button className="btn-secondary" onClick={() => setShowRouteOneDetails(true)}>Update details</button>
          {canEdit && <button className="btn-primary" onClick={() => setShowEdit(true)}>Edit</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sales MTD" value={fmtR(c.stats.sales_mtd)} accent="text-brand-600" />
        <Stat label="Sales 12 months" value={fmtR(c.stats.sales_12m)} />
        <Stat label="Total orders" value={c.stats.order_count} />
        <Stat label="Credit limit" value={fmtR(c.credit_limit)} sub={c.payment_terms} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="SYSPRO info" actions={<span className="text-xs text-slate-400">Synced — read-only</span>}>
          <dl className="space-y-2 text-sm">
            <InfoRow label="Contact" value={c.contact_name} />
            <InfoRow label="Phone" value={c.phone} />
            <InfoRow label="Email" value={c.email} />
            <InfoRow label="Address" value={c.address} />
            <InfoRow label="City" value={c.city} />
            <InfoRow label="Warehouse" value={c.warehouse_name ? `${c.warehouse_name} (${c.warehouse_code})` : null} />
            <InfoRow label="Credit limit" value={fmtR(c.credit_limit)} />
            <InfoRow label="Payment terms" value={c.payment_terms} />
          </dl>
        </Card>

        <Card title="RouteOne info" actions={<button className="text-xs font-semibold text-brand-600 hover:underline" onClick={() => setShowRouteOneDetails(true)}>Update</button>}>
          <dl className="space-y-2 text-sm">
            <InfoRow label="Grade" value={c.classification} />
            <InfoRow label="Rep" value={c.rep_name} />
            <InfoRow label="Visit frequency" value={c.visit_frequency} />
            <InfoRow label="GPS pin" value={c.lat != null ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : null} />
            <InfoRow label="Notes" value={c.notes} />
            {(c.onsite_name || c.onsite_phone || c.onsite_address || c.onsite_lat) && (
              <>
                <div className="border-t my-2" />
                <div className="font-semibold text-slate-600">Onsite details:</div>
                <InfoRow label="Onsite name" value={c.onsite_name} />
                <InfoRow label="Onsite phone" value={c.onsite_phone} />
                <InfoRow label="Onsite address" value={c.onsite_address} />
                <InfoRow label="Onsite pin" value={c.onsite_lat != null ? `${c.onsite_lat.toFixed(5)}, ${c.onsite_lng.toFixed(5)}` : null} />
              </>
            )}
          </dl>
        </Card>
      </div>

      {salesPushes.length > 0 && (
        <Card title="Selling tips">
          {salesPushes.map((p) => (
            <div key={p.id} className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700 last:mb-0">
              📢 {p.message}
            </div>
          ))}
        </Card>
      )}

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
                    onClick={() => {
                      if (!window.confirm(`Remove contact ${ct.name}? This can't be undone.`)) return;
                      api.del(`/contacts/${ct.id}`).then(load);
                    }}>remove</button>
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

      <Card title="Invoices — last 30 days"
        actions={c.invoice_summary?.outstanding > 0 && (
          <span className="text-xs font-semibold text-red-600">{fmtR(c.invoice_summary.outstanding)} outstanding</span>
        )}>
        <Table headers={['Number', 'Date', 'Order', 'Status', 'Total', 'Balance']}
          empty={(!c.recent_invoices || c.recent_invoices.length === 0) && 'No invoices in the last 30 days.'}>
          {(c.recent_invoices || []).map((iv) => (
            <tr key={iv.id} className="hover:bg-slate-50">
              <td className="td font-medium">{iv.number}</td>
              <td className="td text-slate-500">{fmtDate(iv.invoice_date)}</td>
              <td className="td text-slate-500">{iv.order_number || '—'}</td>
              <td className="td">
                <Badge color={iv.status === 'paid' ? '#16a34a' : iv.status === 'overdue' ? '#dc2626' : '#d97706'}>{iv.status}</Badge>
              </td>
              <td className="td font-medium">{fmtR(iv.total)}</td>
              <td className={`td font-medium ${iv.balance > 0 ? 'text-red-600' : 'text-slate-400'}`}>{fmtR(iv.balance)}</td>
            </tr>
          ))}
        </Table>
      </Card>

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

      {showEdit && (
        <CustomerModal customer={c}
          onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />
      )}
      {showRouteOneDetails && (
        <RouteOneDetailsModal customer={c}
          onClose={() => setShowRouteOneDetails(false)} onSaved={() => { setShowRouteOneDetails(false); load(); }} />
      )}
      {showContact && <ContactModal customerId={c.id} onClose={() => setShowContact(false)} onSaved={() => { setShowContact(false); load(); }} />}
      {showPrices && <PricesModal customer={c} onClose={() => { setShowPrices(false); load(); }} />}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-700">{value || '—'}</dd>
    </div>
  );
}

// RouteOne-owned details a rep can add/update on their own customer - never
// touches SYSPRO-sourced fields, so a later sync can't silently overwrite it.
function RouteOneDetailsModal({ customer, onClose, onSaved }) {
  const [form, setForm] = useState({
    classification: customer.classification || 'B',
    visit_frequency: customer.visit_frequency || 'weekly',
    notes: customer.notes || '',
    lat: customer.lat ?? null,
    lng: customer.lng ?? null,
    onsite_name: customer.onsite_name || '',
    onsite_phone: customer.onsite_phone || '',
    onsite_address: customer.onsite_address || '',
    onsite_lat: customer.onsite_lat ?? null,
    onsite_lng: customer.onsite_lng ?? null
  });
  const [showPin, setShowPin] = useState(false);
  const [showOnsitePin, setShowOnsitePin] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put(`/customers/${customer.id}/details`, form);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Update details — ${customer.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Grade">
            <select className="input" value={form.classification} onChange={set('classification')}>
              <option>A</option><option>B</option><option>C</option>
            </select>
          </Field>
          <Field label="Visit frequency">
            <select className="input" value={form.visit_frequency} onChange={set('visit_frequency')}>
              <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option>
            </select>
          </Field>
          <Field label="Notes" span><textarea className="input" rows="3" value={form.notes} onChange={set('notes')} /></Field>
        </div>

        <div className="border-t pt-4">
          <h3 className="font-semibold text-sm mb-3">Onsite details (if different from SYSPRO)</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Onsite name"><input className="input" placeholder="Actual location name" value={form.onsite_name} onChange={set('onsite_name')} /></Field>
            <Field label="Onsite phone"><input className="input" placeholder="Contact number" value={form.onsite_phone} onChange={set('onsite_phone')} /></Field>
            <Field label="Onsite address" span><textarea className="input" rows="2" placeholder="Actual delivery address" value={form.onsite_address} onChange={set('onsite_address')} /></Field>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="label mb-0">Onsite location pin</label>
            {!showOnsitePin && (
              <button type="button" className="text-xs font-semibold text-brand-600 hover:underline" onClick={() => setShowOnsitePin(true)}>
                {form.onsite_lat != null ? 'Update pin' : '📍 Drop pin'}
              </button>
            )}
          </div>
          {showOnsitePin ? (
            <LocationPicker value={form.onsite_lat != null ? { lat: form.onsite_lat, lng: form.onsite_lng } : null}
              onChange={(p) => setForm((f) => ({ ...f, onsite_lat: p.lat, onsite_lng: p.lng }))} />
          ) : (
            <div className="text-sm text-slate-500">
              {form.onsite_lat != null ? `${form.onsite_lat.toFixed(5)}, ${form.onsite_lng.toFixed(5)}` : 'No pin set yet.'}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="label mb-0">GPS pin (for routing)</label>
            {!showPin && (
              <button type="button" className="text-xs font-semibold text-brand-600 hover:underline" onClick={() => setShowPin(true)}>
                {form.lat != null ? 'Update pin' : '📍 Drop pin'}
              </button>
            )}
          </div>
          {showPin ? (
            <LocationPicker value={form.lat != null ? { lat: form.lat, lng: form.lng } : null}
              onChange={(p) => setForm((f) => ({ ...f, lat: p.lat, lng: p.lng }))} />
          ) : (
            <div className="text-sm text-slate-500">
              {form.lat != null ? `${form.lat.toFixed(5)}, ${form.lng.toFixed(5)}` : 'No pin set yet.'}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
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
  const [search, setSearch] = useState('');

  const load = () => api.get(`/products/for-customer/${customer.id}`).then(setProducts).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const setPrice = async (productId, price) => {
    try {
      await api.put(`/customers/${customer.id}/prices/${productId}`, { price: price === '' ? null : Number(price) });
      load();
    } catch (e) { setError(e.message); }
  };

  const filtered = products?.filter((p) => {
    const q = search.toLowerCase();
    return p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  }) || [];

  return (
    <Modal title={`Contract prices — ${customer.name}`} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!products ? <Spinner /> : (
        <>
          <input
            className="input mb-4 max-w-xs"
            placeholder="Search by code or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Table headers={['Code', 'Product', 'List price', 'Contract price', '']}>
            {filtered.map((p) => (
              <tr key={p.id}>
                <td className="td text-slate-500 font-mono text-sm">{p.code}</td>
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
                    <button className="text-xs text-red-500 hover:underline"
                      onClick={() => { if (window.confirm(`Clear the contract price for ${p.name}? It reverts to the list price.`)) setPrice(p.id, ''); }}>clear</button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          {filtered.length === 0 && <p className="mt-4 text-sm text-slate-500">No products found.</p>}
        </>
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
