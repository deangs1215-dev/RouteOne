import { useEffect, useState } from 'react';
import { api, fmtR, fmtDate } from '../api';
import { Card, Table, Modal, Field, Spinner, ErrorNote, Badge } from '../components/ui';
import { useAuth } from '../auth';

export default function Products() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [catId, setCatId] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | product
  const [showRules, setShowRules] = useState(false);

  const canEdit = ['admin', 'manager', 'office'].includes(user.role);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (catId) params.set('category_id', catId);
    api.get(`/products?${params}`).then(setRows).catch(console.error);
  };

  useEffect(() => { load(); }, [q, catId]);
  useEffect(() => { api.get('/product-categories').then(setCats).catch(() => {}); }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Products</h1>
        {canEdit && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setShowRules(true)}>Pricing rules</button>
            <button className="btn-primary" onClick={() => setEditing('new')}>+ New product</button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <input className="input max-w-xs" placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[220px]" value={catId} onChange={(e) => setCatId(e.target.value)}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <Card>
        {!rows ? <Spinner /> : (
          <Table headers={['Code', 'Name', 'Category', 'Pack', 'UOM', 'List price', 'Stock', 'Status']}
            empty={rows.length === 0 && 'No products found.'}>
            {rows.map((p) => (
              <tr key={p.id} className={`hover:bg-slate-50 ${canEdit ? 'cursor-pointer' : ''}`}
                onClick={() => canEdit && setEditing(p)}>
                <td className="td text-slate-500">{p.code}</td>
                <td className="td font-medium">{p.name}</td>
                <td className="td text-slate-500">{p.category_name || '—'}</td>
                <td className="td text-slate-500">{p.pack_size || '—'}</td>
                <td className="td text-slate-500">{p.uom}</td>
                <td className="td font-medium">{fmtR(p.list_price)}</td>
                <td className="td">
                  <span className={p.stock_qty <= 0 ? 'text-red-600 font-medium' : p.stock_qty < 50 ? 'text-amber-600' : ''}>
                    {p.stock_qty}
                  </span>
                </td>
                <td className="td"><Badge color={p.active ? '#16a34a' : '#64748b'}>{p.active ? 'active' : 'inactive'}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing && (
        <ProductModal product={editing === 'new' ? null : editing} cats={cats}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {showRules && <PriceRulesModal cats={cats} onClose={() => setShowRules(false)} />}
    </div>
  );
}

// Pricing rules: volume breaks, category promos and fixed clearance prices.
// Contract prices (per customer) still beat all of these.
function PriceRulesModal({ cats, onClose }) {
  const [rules, setRules] = useState(null);
  const [products, setProducts] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: '', scope: 'category', product_id: '', category_id: '',
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
        product_id: form.scope === 'product' ? Number(form.product_id) || null : null,
        category_id: form.scope === 'category' ? Number(form.category_id) || null : null,
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
              <td className="td text-slate-500">{r.product_name || (r.category_name ? `Category: ${r.category_name}` : '—')}</td>
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
            <Field label="Scope">
              <select className="input" value={form.scope} onChange={set('scope')}>
                <option value="category">Category</option>
                <option value="product">Single product</option>
              </select>
            </Field>
            {form.scope === 'category' ? (
              <Field label="Category">
                <select className="input" value={form.category_id} onChange={set('category_id')} required>
                  <option value="">Select…</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Product">
                <select className="input" value={form.product_id} onChange={set('product_id')} required>
                  <option value="">Select…</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )}
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

function ProductModal({ product, cats, onClose, onSaved }) {
  const [form, setForm] = useState({
    code: product?.code || '', name: product?.name || '', category_id: product?.category_id || '',
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
        ...form, category_id: form.category_id || null,
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
          <Field label="Category">
            <select className="input" value={form.category_id} onChange={set('category_id')}>
              <option value="">—</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
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
