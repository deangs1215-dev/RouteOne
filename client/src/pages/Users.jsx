import { useEffect, useState } from 'react';
import { api, fmtR } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, Badge } from '../components/ui';
import { useAuth } from '../auth';

export default function Users() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [roles, setRoles] = useState([]);
  const [territories, setTerritories] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | user row

  const isAdmin = user.role === 'admin';

  const load = () => api.get('/users').then(setRows).catch(console.error);
  useEffect(() => {
    load();
    api.get('/roles').then(setRoles).catch(() => {});
    api.get('/territories').then(setTerritories).catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Users</h1>
        {isAdmin && <button className="btn-primary" onClick={() => setEditing('new')}>+ New user</button>}
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Name', 'Email', 'Role', 'Territory', 'Target', 'Status']} empty={rows.length === 0 && 'No users.'}>
            {rows.map((u) => (
              <tr key={u.id} className={`hover:bg-slate-50 ${isAdmin ? 'cursor-pointer' : ''}`} onClick={() => isAdmin && setEditing(u)}>
                <td className="td font-medium">{u.name}</td>
                <td className="td text-slate-500">{u.email}</td>
                <td className="td capitalize">{u.role}</td>
                <td className="td text-slate-500">{u.territory_name || '—'}</td>
                <td className="td text-slate-500">{u.sales_target ? fmtR(u.sales_target) : '—'}</td>
                <td className="td"><Badge color={u.active ? '#16a34a' : '#64748b'}>{u.active ? 'active' : 'inactive'}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <UserModal u={editing === 'new' ? null : editing} roles={roles} territories={territories}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function UserModal({ u, roles, territories, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: u?.name || '', email: u?.email || '', phone: u?.phone || '', password: '',
    role_id: u ? (roles.find((r) => r.name === u.role)?.id || '') : '',
    territory_id: u?.territory_id || '', customer_id: u?.customer_id || '',
    sales_target: u?.sales_target ?? 0, active: u?.active ?? 1
  });
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const isCustomerRole = roles.find((r) => String(r.id) === String(form.role_id))?.name === 'customer';
  useEffect(() => {
    if (isCustomerRole && customers.length === 0) api.get('/customers').then(setCustomers).catch(() => {});
  }, [isCustomerRole]);

  const save = async (e) => {
    e.preventDefault();
    try {
      const body = {
        ...form, role_id: Number(form.role_id), territory_id: form.territory_id || null,
        customer_id: form.customer_id || null,
        sales_target: Number(form.sales_target), active: Number(form.active)
      };
      if (!body.password) delete body.password;
      if (u) await api.put(`/users/${u.id}`, body);
      else await api.post('/users', body);
      onSaved();
    } catch (err) { setError(err.message); }
  };

  return (
    <Modal title={u ? `Edit ${u.name}` : 'New user'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Name"><input className="input" value={form.name} onChange={set('name')} required /></Field>
        <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} required /></Field>
        <Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
        <Field label={u ? 'New password (leave blank to keep)' : 'Password'}>
          <input className="input" type="password" value={form.password} onChange={set('password')} required={!u} />
        </Field>
        <Field label="Role">
          <select className="input" value={form.role_id} onChange={set('role_id')} required>
            <option value="">Select…</option>
            {roles.map((r) => <option key={r.id} value={r.id} className="capitalize">{r.name}</option>)}
          </select>
        </Field>
        <Field label="Territory">
          <select className="input" value={form.territory_id} onChange={set('territory_id')}>
            <option value="">—</option>
            {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        {isCustomerRole && (
          <Field label="Linked customer account">
            <select className="input" value={form.customer_id} onChange={set('customer_id')} required>
              <option value="">Select…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select>
          </Field>
        )}
        <Field label="Monthly sales target (R)"><input className="input" type="number" min="0" value={form.sales_target} onChange={set('sales_target')} /></Field>
        {u && (
          <Field label="Status">
            <select className="input" value={form.active} onChange={set('active')}>
              <option value="1">Active</option><option value="0">Inactive</option>
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}
