import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, GradeBadge, Badge, usePagination, PageSizeSelect, Pagination } from '../components/ui';
import { useAuth } from '../auth';

export default function Customers() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(false);
  const { page, setPage, pageSize, setPageSize, totalPages, pageRows } = usePagination(rows);
  const canEdit = ['admin', 'manager', 'office'].includes(user.role);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    api.get(`/customers?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Customers</h1>
        {canEdit && <button className="btn-primary" onClick={() => setShowNew(true)}>+ New customer</button>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <input className="input max-w-xs" placeholder="Search name, code or city…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <PageSizeSelect value={pageSize} onChange={setPageSize} />
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <>
            <Table headers={['Code', 'Name', 'Grade', 'City', 'Rep', 'Last order', 'Last visit', 'Status']}
              empty={rows.length === 0 && 'No customers found.'} emptyIcon="🔍">
              {pageRows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="td text-slate-500">{c.code}</td>
                  <td className="td font-medium"><Link className="hover:text-brand-600" to={`/customers/${c.id}`}>{c.name}</Link></td>
                  <td className="td"><GradeBadge grade={c.classification} /></td>
                  <td className="td text-slate-500">{c.city}</td>
                  <td className="td text-slate-500">{c.rep_name || '—'}</td>
                  <td className="td text-slate-500">{fmtDate(c.last_order_at)}</td>
                  <td className="td text-slate-500">{fmtDate(c.last_visit_at)}</td>
                  <td className="td">
                    <Badge color={c.status === 'active' ? '#16a34a' : c.status === 'on_hold' ? '#f59e0b' : '#64748b'}>
                      {c.status.replace('_', ' ')}
                    </Badge>
                  </td>
                </tr>
              ))}
            </Table>
            {rows.length > 0 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
          </>
        )}
      </Card>

      {showNew && <CustomerModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

export function CustomerModal({ customer, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: customer?.name || '', classification: customer?.classification || 'B',
    rep_id: customer?.rep_id || '',
    contact_name: customer?.contact_name || '', phone: customer?.phone || '', email: customer?.email || '',
    address: customer?.address || '', city: customer?.city || '',
    credit_limit: customer?.credit_limit ?? 0, payment_terms: customer?.payment_terms || '30 days',
    visit_frequency: customer?.visit_frequency || 'weekly', status: customer?.status || 'active',
    notes: customer?.notes || ''
  });
  const [reps, setReps] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    api.get('/users').then((users) => setReps(users.filter((u) => u.role === 'rep' && u.active))).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { ...form, rep_id: form.rep_id || null, credit_limit: Number(form.credit_limit) };
      if (customer) await api.put(`/customers/${customer.id}`, body);
      else await api.post('/customers', body);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={customer ? 'Edit customer' : 'New customer'} onClose={onClose} wide>
      <form onSubmit={save}>
        <ErrorNote error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" span><input className="input" value={form.name} onChange={set('name')} required /></Field>
          <Field label="Grade">
            <select className="input" value={form.classification} onChange={set('classification')}>
              <option>A</option><option>B</option><option>C</option>
            </select>
          </Field>
          <Field label="Status">
            <select className="input" value={form.status} onChange={set('status')}>
              <option value="active">Active</option><option value="on_hold">On hold</option><option value="closed">Closed</option>
            </select>
          </Field>
          <Field label="Assigned rep">
            <select className="input" value={form.rep_id} onChange={set('rep_id')}>
              <option value="">—</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Contact person"><input className="input" value={form.contact_name} onChange={set('contact_name')} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="City"><input className="input" value={form.city} onChange={set('city')} /></Field>
          <Field label="Address" span><input className="input" value={form.address} onChange={set('address')} /></Field>
          <Field label="Credit limit (R)"><input className="input" type="number" min="0" value={form.credit_limit} onChange={set('credit_limit')} /></Field>
          <Field label="Payment terms">
            <select className="input" value={form.payment_terms} onChange={set('payment_terms')}>
              <option>COD</option><option>7 days</option><option>30 days</option><option>60 days</option>
            </select>
          </Field>
          <Field label="Visit frequency">
            <select className="input" value={form.visit_frequency} onChange={set('visit_frequency')}>
              <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option>
            </select>
          </Field>
          <Field label="Notes" span><textarea className="input" rows="2" value={form.notes} onChange={set('notes')} /></Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</button>
        </div>
      </form>
    </Modal>
  );
}
