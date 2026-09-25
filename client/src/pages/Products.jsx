import { useEffect, useState } from 'react';
import { api, fmtR, fmtDate } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, Badge, usePagination, PageSizeSelect, Pagination } from '../components/ui';
import { useAuth } from '../auth';

export default function Products() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | product
  const [showRules, setShowRules] = useState(false);
  const { page, setPage, pageSize, setPageSize, totalPages, pageRows } = usePagination(rows);

  const canEdit = ['admin', 'manager', 'office'].includes(user.role);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    // No active filter: discontinued run-out stock (active = 0) must stay
    // visible and badged red, not vanish - a rep searching for it needs to see
    // that it exists and why it can't be ordered. Ordering is blocked
    // server-side regardless (orders/quotes resolve lines with active = 1).
    api.get(`/products?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Products</h1>
        {canEdit && (
          <button className="btn-secondary" onClick={() => setShowRules(true)}>Pricing rules</button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input className="input max-w-xs" placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
        <PageSizeSelect value={pageSize} onChange={setPageSize} />
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <>
            <Table headers={['Code', 'Name', 'Pack', 'UOM', 'List price', 'Stock', 'Status']}
              empty={rows.length === 0 && 'No products found.'} emptyIcon="📦">
              {pageRows.map((p) => (
                <tr key={p.id} className={`hover:bg-slate-50 ${canEdit ? 'cursor-pointer' : ''}`}
                  onClick={() => canEdit && setEditing(p)}>
                  <td className="td text-slate-500">{p.code}</td>
                  <td className="td font-medium">{p.name}</td>
                  <td className="td text-slate-500">{p.pack_size || '—'}</td>
                  <td className="td text-slate-500">{p.uom}</td>
                  <td className="td font-medium">{fmtR(p.list_price)}</td>
                  <td className="td">
                    <span className={p.stock_qty <= 0 ? 'text-red-600 font-medium' : p.stock_qty < 50 ? 'text-amber-600' : ''}>
                      {p.stock_qty}
                    </span>
                    {p.stock_by_warehouse?.some((s) => s.qty_available > 0) && (
                      <div className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-slate-400">
                        {p.stock_by_warehouse.filter((s) => s.qty_available > 0).map((s) => (
                          <span key={s.warehouse_code} title={s.warehouse_name}>
                            {s.warehouse_code}: {s.qty_available}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="td">
                    {p.discontinued
                      ? <Badge color="#dc2626">discontinued</Badge>
                      : !p.list_price
                        ? <Badge color="#dc2626">no price set</Badge>
                        : <Badge color={p.active ? '#16a34a' : '#64748b'}>{p.active ? 'active' : 'inactive'}</Badge>}
                  </td>
                </tr>
              ))}
            </Table>
            {rows.length > 0 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
          </>
        )}
      </Card>

      {editing && (
        <ProductModal product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {showRules && <PriceRulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}

// Pricing rules: volume breaks and fixed clearance prices, per product.
// Contract prices (per customer) still beat all of these.
function PriceRulesModal({ onClose }) {
  const [rules, setRules] = useState(null);
  const [products, setProducts] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: '', product_id: '',
    rule_type: 'discount_pct', discount_pct: '', fixed_price: '', min_qty: 0, starts_on: '', ends_on: ''
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const load = () => api.get('/price-rules').then(setRules).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/products').then(setProducts).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/price-rules', {
        name: form.name,
        product_id: Number(form.product_id) || null,
        rule_type: form.rule_type,
        discount_pct: form.rule_type === 'discount_pct' ? Number(form.discount_pct) : null,
        fixed_price: form.rule_type === 'fixed_price' ? Number(form.fixed_price) : null,
        min_qty: Number(form.min_qty) || 0,
        starts_on: form.starts_on || null,
        ends_on: form.ends_on || null
      });
      setAdding(false);
      setForm({ ...form, name: '', discount_pct: '', fixed_price: '', min_qty: 0, starts_on: '', ends_on: '' });
      load();
    } catch (err) { setError(err.message); }
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this price rule? This can't be undone.")) return;
    try { await api.del(`/price-rules/${id}`); load(); }
    catch (err) { setError(err.message); }
  };

  const describe = (r) =>
    (r.rule_type === 'fixed_price' ? `fixed ${fmtR(r.fixed_price)}` : `${r.discount_pct}% off`) +
    (r.min_qty > 0 ? ` from ${r.min_qty}+ units` : '') +
    (r.starts_on || r.ends_on ? ` (${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)})` : '');

  return (
    <Modal title="Pricing rules" onClose={onClose} wide>
      <ErrorNote error={error} />
      {!rules ? <Spinner /> : (
        <Table headers={['Rule', 'Applies to', 'Effect', '']} empty={rules.length === 0 && 'No rules yet.'}>
          {rules.map((r) => (
            <tr key={r.id}>
              <td className="td font-medium">{r.name}</td>
              <td className="td text-slate-500">{r.product_name || '—'}</td>
              <td className="td text-slate-500">{describe(r)}</td>
              <td className="td">
                <button className="text-xs text-red-500 hover:underline" onClick={() => remove(r.id)}>delete</button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      {!adding ? (
        <button className="btn-secondary mt-4" onClick={() => setAdding(true)}>+ Add rule</button>
      ) : (
        <form onSubmit={save} className="mt-4 space-y-3 rounded-lg border border-slate-200 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Rule name" span><input className="input" value={form.name} onChange={set('name')} required /></Field>
            <Field label="Product">
              <select className="input" value={form.product_id} onChange={set('product_id')} required>
                <option value="">Select…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Rule type">
              <select className="input" value={form.rule_type} onChange={set('rule_type')}>
                <option value="discount_pct">Discount %</option>
                <option value="fixed_price">Fixed price</option>
              </select>
            </Field>
            {form.rule_type === 'discount_pct' ? (
              <Field label="Discount %"><input className="input" type="number" step="0.1" min="0" max="100" value={form.discount_pct} onChange={set('discount_pct')} required /></Field>
            ) : (
              <Field label="Fixed price (R)"><input className="input" type="number" step="0.01" min="0" value={form.fixed_price} onChange={set('fixed_price')} required /></Field>
            )}
            <Field label="Minimum qty (0 = always)"><input className="input" type="number" min="0" value={form.min_qty} onChange={set('min_qty')} /></Field>
            <Field label="Starts on (optional)"><input className="input" type="date" value={form.starts_on} onChange={set('starts_on')} /></Field>
            <Field label="Ends on (optional)"><input className="input" type="date" value={form.ends_on} onChange={set('ends_on')} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn-primary">Add rule</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function ProductModal({ product, onClose, onSaved }) {
  const [form, setForm] = useState({
    code: product?.code || '', name: product?.name || '',
    description: product?.description || '', uom: product?.uom || 'each', pack_size: product?.pack_size || '',
    list_price: product?.list_price ?? 0, cost_price: product?.cost_price ?? 0,
    stock_qty: product?.stock_qty ?? 0, active: product?.active ?? 1
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        ...form,
        list_price: Number(form.list_price), cost_price: Number(form.cost_price),
        stock_qty: Number(form.stock_qty), active: Number(form.active)
      };
      if (product) await api.put(`/products/${product.id}`, body);
      else await api.post('/products', body);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={product ? `Edit ${product.code}` : 'New product'} onClose={onClose} wide>
      <form onSubmit={save}>
        <ErrorNote error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code"><input className="input" value={form.code} onChange={set('code')} required /></Field>
          <Field label="Name" span><input className="input" value={form.name} onChange={set('name')} required /></Field>
          <Field label="Description" span><textarea className="input" rows="2" value={form.description} onChange={set('description')} /></Field>
          <Field label="Unit of measure">
            <select className="input" value={form.uom} onChange={set('uom')}>
              <option>each</option><option>bag</option><option>box</option><option>tub</option><option>case</option><option>kg</option>
            </select>
          </Field>
          <Field label="Pack size"><input className="input" value={form.pack_size} onChange={set('pack_size')} placeholder="12.5kg, 12 x 1L…" /></Field>
          <Field label="List price (R)"><input className="input" type="number" step="0.01" min="0" value={form.list_price} onChange={set('list_price')} required /></Field>
          <Field label="Cost price (R)"><input className="input" type="number" step="0.01" min="0" value={form.cost_price} onChange={set('cost_price')} /></Field>
          <Field label="Stock on hand"><input className="input" type="number" value={form.stock_qty} onChange={set('stock_qty')} /></Field>
          <Field label="Status">
            <select className="input" value={form.active} onChange={set('active')}>
              <option value="1">Active</option><option value="0">Inactive</option>
            </select>
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button>
        </div>
      </form>
    </Modal>
  );
}
