import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, VisitStatusBadge } from '../components/ui';

export default function Visits() {
  const [rows, setRows] = useState(null);
  const [date, setDate] = useState('');
  const [repId, setRepId] = useState('');
  const [reps, setReps] = useState([]);
  const [showPlan, setShowPlan] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (repId) params.set('rep_id', repId);
    api.get(`/visits?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [date, repId]);
  useEffect(() => {
    api.get('/users').then((users) => setReps(users.filter((u) => u.role === 'rep'))).catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Visits</h1>
        <button className="btn-primary" onClick={() => setShowPlan(true)}>+ Plan visit</button>
      </div>

      <div className="flex flex-wrap gap-3">
        <input className="input max-w-[180px]" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select className="input max-w-[200px]" value={repId} onChange={(e) => setRepId(e.target.value)}>
          <option value="">All reps</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {(date || repId) && <button className="btn-secondary" onClick={() => { setDate(''); setRepId(''); }}>Clear</button>}
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Customer', 'Rep', 'Check-in', 'Check-out', 'Status', 'Outcome', 'Orders']}
            empty={rows.length === 0 && 'No visits found.'}>
            {rows.map((v) => (
              <tr key={v.id} className="hover:bg-slate-50">
                <td className="td font-medium">
                  <Link className="hover:text-brand-600" to={`/customers/${v.customer_id}`}>{v.customer_name}</Link>
                  <span className="ml-1 text-xs text-slate-400">{v.customer_city}</span>
                </td>
                <td className="td text-slate-500">{v.rep_name}</td>
                <td className="td text-slate-500">{v.check_in_at ? fmtDateTime(v.check_in_at) : `planned ${v.planned_date}`}</td>
                <td className="td text-slate-500">{v.check_out_at ? fmtDateTime(v.check_out_at) : '—'}</td>
                <td className="td"><VisitStatusBadge status={v.status} /></td>
                <td className="td text-slate-500">{v.outcome ? v.outcome.replace('_', ' ') : '—'}</td>
                <td className="td">{v.order_count > 0 ? `🧾 ${v.order_count}` : '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {showPlan && <PlanVisitModal reps={reps} onClose={() => setShowPlan(false)} onSaved={() => { setShowPlan(false); load(); }} />}
    </div>
  );
}

function PlanVisitModal({ reps, onClose, onSaved }) {
  const [customers, setCustomers] = useState([]);
  const [form, setForm] = useState({ customer_id: '', rep_id: '', planned_date: new Date().toISOString().slice(0, 10), purpose: 'sales call' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => { api.get('/customers').then(setCustomers).catch(() => {}); }, []);

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.post('/visits', { ...form, customer_id: Number(form.customer_id), rep_id: form.rep_id ? Number(form.rep_id) : undefined });
      onSaved();
    } catch (err) { setError(err.message); }
  };

  return (
    <Modal title="Plan a visit" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Customer">
          <select className="input" value={form.customer_id} onChange={set('customer_id')} required>
            <option value="">Select…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Rep">
          <select className="input" value={form.rep_id} onChange={set('rep_id')}>
            <option value="">Customer's assigned rep</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Date"><input className="input" type="date" value={form.planned_date} onChange={set('planned_date')} required /></Field>
        <Field label="Purpose">
          <select className="input" value={form.purpose} onChange={set('purpose')}>
            <option>sales call</option><option>delivery follow-up</option><option>complaint</option><option>new customer intro</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary">Plan visit</button>
        </div>
      </form>
    </Modal>
  );
}
