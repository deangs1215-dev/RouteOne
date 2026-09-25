import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtR } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, Badge } from '../components/ui';
import { useAuth } from '../auth';

export default function Users() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [roles, setRoles] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | user row
  const [budgetsOpen, setBudgetsOpen] = useState(null); // null | user row with role info
  const [sendingLoginDetails, setSendingLoginDetails] = useState(null); // user id being sent details to
  const [sendMessage, setSendMessage] = useState(''); // success/error message

  const isAdmin = user.role === 'admin';

  const load = () => api.get('/users').then(setRows).catch(console.error);

  const sendLoginDetails = async (userId) => {
    setSendingLoginDetails(userId);
    setSendMessage('');
    try {
      const result = await api.post(`/users/${userId}/send-login-details`, {});
      setSendMessage(result.message || 'Login details sent successfully!');
      setTimeout(() => setSendMessage(''), 3000);
    } catch (e) {
      setSendMessage('Error: ' + (e.message || 'Failed to send login details'));
    }
    setSendingLoginDetails(null);
  };

  useEffect(() => {
    load();
    api.get('/roles').then(setRoles).catch(() => {});
    api.get('/warehouses').then(setWarehouses).catch(() => {});
  }, []);

  // Deep-link support: /users?edit=<id> opens that user's edit modal directly
  // (used by the "Settings" link on a rep's Team detail page).
  useEffect(() => {
    const editId = params.get('edit');
    if (editId && rows) {
      const target = rows.find((r) => String(r.id) === editId);
      if (target) setEditing(target);
      setParams({}, { replace: true });
    }
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Users</h1>
        {isAdmin && <button className="btn-primary" onClick={() => setEditing('new')}>+ New user</button>}
      </div>

      {sendMessage && (
        <div className={`rounded-lg px-3 py-2 text-sm ${sendMessage.startsWith('Error') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
          {sendMessage}
        </div>
      )}

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Name', 'Email', 'Role', 'Code', 'Branch', 'Target', 'Status', '']} empty={rows.length === 0 && 'No users.'}>
            {rows.map((u) => (
              <tr key={u.id} className={`hover:bg-slate-50 ${isAdmin ? 'cursor-pointer' : ''}`} onClick={() => isAdmin && setEditing(u)}>
                <td className="td font-medium">{u.name}</td>
                <td className="td text-slate-500">{u.email}</td>
                <td className="td capitalize">{u.role}</td>
                <td className="td text-slate-500">{u.rep_code || '—'}</td>
                <td className="td text-slate-500">{u.warehouse_name || '—'}</td>
                <td className="td text-slate-500">{u.sales_target ? fmtR(u.sales_target) : '—'}</td>
                <td className="td"><Badge color={u.active ? '#16a34a' : '#64748b'}>{u.active ? 'active' : 'inactive'}</Badge></td>
                <td className="td text-right space-x-2">
                  <button className="text-xs text-brand-600 hover:underline" onClick={(e) => {
                    e.stopPropagation();
                    sendLoginDetails(u.id);
                  }}>
                    Send login
                  </button>
                  {u.role === 'rep' && (
                    <button className="text-xs text-brand-600 hover:underline" onClick={(e) => { e.stopPropagation(); setBudgetsOpen(u); }}>
                      budgets
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <UserModal u={editing === 'new' ? null : editing} roles={roles} warehouses={warehouses}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}

      {budgetsOpen && (
        <BudgetsModal u={budgetsOpen} onClose={() => setBudgetsOpen(null)} />
      )}
    </div>
  );
}

function UserModal({ u, roles, warehouses, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: u?.name || '', email: u?.email || '', phone: u?.phone || '', password: '',
    role_id: u ? (roles.find((r) => r.name === u.role)?.id || '') : '',
    customer_id: u?.customer_id || '',
    rep_code: u?.rep_code || '', warehouse_id: u?.warehouse_id || '',
    sales_target: u?.sales_target ?? 0, active: u?.active ?? 1,
    home_address: u?.home_address || '', home_lat: u?.home_lat ?? '', home_lng: u?.home_lng ?? '',
    manager_warehouses: u?.manager_warehouses || []
  });
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const toggleWarehouse = (warehouseId) => {
    const updated = form.manager_warehouses.includes(warehouseId)
      ? form.manager_warehouses.filter(id => id !== warehouseId)
      : [...form.manager_warehouses, warehouseId];
    setForm({ ...form, manager_warehouses: updated });
  };

  const isCustomerRole = roles.find((r) => String(r.id) === String(form.role_id))?.name === 'customer';
  const isRepRole = roles.find((r) => String(r.id) === String(form.role_id))?.name === 'rep';
  const isManagerRole = roles.find((r) => String(r.id) === String(form.role_id))?.name === 'manager';
  useEffect(() => {
    if (isCustomerRole && customers.length === 0) api.get('/customers').then(setCustomers).catch(() => {});
  }, [isCustomerRole]);

  const save = async (e) => {
    e.preventDefault();
    try {
      const body = {
        ...form, role_id: Number(form.role_id),
        customer_id: form.customer_id || null, warehouse_id: form.warehouse_id || null,
        sales_target: Number(form.sales_target), active: Number(form.active),
        home_address: form.home_address || null,
        home_lat: form.home_lat === '' ? null : Number(form.home_lat),
        home_lng: form.home_lng === '' ? null : Number(form.home_lng)
      };
      if (!body.password) delete body.password;
      if (u) await api.put(`/users/${u.id}`, body);
      else await api.post('/users', body);
      onSaved();
    } catch (err) { setError(err.message); }
  };

  const remove = async () => {
    if (!u) return;
    if (!window.confirm(`Delete ${u.name}? This permanently removes the user and can't be undone.`)) return;
    try {
      await api.del(`/users/${u.id}`);
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
          <input className="input" type="password" minLength={9} maxLength={128}
            value={form.password} onChange={set('password')} required={!u} />
        </Field>
        <Field label="Role">
          <select className="input" value={form.role_id} onChange={set('role_id')} required>
            <option value="">Select…</option>
            {roles.map((r) => <option key={r.id} value={r.id} className="capitalize">{r.name}</option>)}
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
        {isRepRole && (
          <Field label="Rep code">
            <input className="input" value={form.rep_code} onChange={set('rep_code')} placeholder="e.g. 16" />
          </Field>
        )}
        {isRepRole && (
          <Field label="Branch / warehouse">
            <select className="input" value={form.warehouse_id} onChange={set('warehouse_id')}>
              <option value="">—</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </select>
          </Field>
        )}
        {isManagerRole && (
          <Field label="Manages branches">
            <div className="space-y-2">
              {warehouses.map((w) => (
                <label key={w.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.manager_warehouses.includes(w.id)}
                    onChange={() => toggleWarehouse(w.id)}
                    className="rounded"
                  />
                  <span>{w.name} ({w.code})</span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label="Monthly sales target (R)">
          <input className="input" type="number" min="0" value={form.sales_target} onChange={set('sales_target')} />
        </Field>
        {isRepRole && (
          <>
            <p className="text-xs text-slate-400 -mt-2">
              Used only where no month-specific figure is set. Save this rep first, then use the "budgets" link in the table to set Jan–Dec targets — the app automatically uses the current month's figure.
            </p>
            <Field label="Day-start address (home/office)">
              <input className="input" value={form.home_address} onChange={set('home_address')} placeholder="Where they start their route each morning" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start latitude"><input className="input" type="number" step="any" value={form.home_lat} onChange={set('home_lat')} /></Field>
              <Field label="Start longitude"><input className="input" type="number" step="any" value={form.home_lng} onChange={set('home_lng')} /></Field>
            </div>
            <p className="text-xs text-slate-400 -mt-2">Used to anchor "Optimise route" and the Routes map before the rep's phone has logged a GPS position for the day.</p>
          </>
        )}
        {u && (
          <Field label="Status">
            <select className="input" value={form.active} onChange={set('active')}>
              <option value="1">Active</option><option value="0">Inactive</option>
            </select>
          </Field>
        )}
        <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
          {u && (
            <button type="button" className="text-sm font-medium text-red-600 hover:text-red-700" onClick={remove}>
              Delete user
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary">Save</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function BudgetsModal({ u, onClose }) {
  const [budgets, setBudgets] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const currentMonth = new Date().getMonth() + 1; // 1-12

  useEffect(() => {
    api.get(`/budgets/${u.id}`).then(setBudgets).catch((e) => setError(e.message));
  }, [u.id]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/budgets/${u.id}`, budgets);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const setBudget = (month, value) => {
    setBudgets({ ...budgets, [month]: Number(value) || 0 });
  };

  return (
    <Modal title={`Monthly Budgets — ${u.name}`} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!budgets ? (
        <Spinner />
      ) : (
        <>
          <p className="text-sm text-slate-500 mb-4">
            Set a target for each month — the app automatically switches to the current month's figure as the date rolls over (used on KPIs, the mobile "My day" screen, and the daily digest email).
          </p>
          <div className="grid grid-cols-2 gap-4 mb-6">
            {months.map((month, idx) => {
              const isCurrent = idx + 1 === currentMonth;
              return (
                <div key={idx + 1} className={isCurrent ? 'rounded-lg border border-brand-500 bg-brand-50 p-2 -m-2' : ''}>
                  <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700">
                    {month}
                    {isCurrent && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Current</span>}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    className="input w-full"
                    value={budgets[idx + 1] || 0}
                    onChange={(e) => setBudget(idx + 1, e.target.value)}
                    disabled={busy}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save Budgets'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
