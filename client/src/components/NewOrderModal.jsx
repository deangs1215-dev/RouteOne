// Order/quote capture used by the back office. Picks a customer, then adds
// lines at the customer's effective price (contract > qty break > list).
import { useEffect, useMemo, useState } from 'react';
import { api, fmtR } from '../api';
import { Modal, Field, ErrorNote } from './ui';

const VAT_RATE = 0.15;

// Unit price for a given quantity: contract price wins, else the best
// applicable quantity break from the server-provided price_breaks.
export function unitPriceFor(product, qty) {
  if (product.has_contract_price === 1 || !product.price_breaks?.length) return product.effective_price;
  const applicable = product.price_breaks.filter((b) => qty >= b.min_qty);
  return applicable.length ? applicable[applicable.length - 1].price : product.effective_price;
}

export default function NewOrderModal({ customerId, kind = 'order', onClose, onSaved }) {
  const [customers, setCustomers] = useState([]);
  const [custId, setCustId] = useState(customerId || '');
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('bought'); // 'bought' | 'all'
  const [lines, setLines] = useState([]); // { product, qty }
  const [notes, setNotes] = useState('');
  const [delivery, setDelivery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!customerId) api.get('/customers').then(setCustomers).catch(() => {});
  }, [customerId]);

  useEffect(() => {
    if (!custId) return setProducts([]);
    api.get(`/products/for-customer/${custId}`).then((ps) => {
      setProducts(ps);
      // Default to the customer's usual products; fall back to all if they've
      // never ordered (a brand-new account).
      setFilterMode(ps.some((p) => p.times_bought > 0) ? 'bought' : 'all');
    }).catch(() => {});
    setLines([]);
  }, [custId]);

  const boughtCount = useMemo(() => products.filter((p) => p.times_bought > 0).length, [products]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return products
      .filter((p) => filterMode === 'all' || p.times_bought > 0)
      .filter((p) => !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s))
      .slice(0, 60);
  }, [products, search, filterMode]);

  const addLine = (product) => {
    setSearch('');
    setLines((ls) => {
      const existing = ls.find((l) => l.product.id === product.id);
      if (existing) return ls.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { product, qty: 1 }];
    });
  };

  const setQty = (productId, qty) =>
    setLines((ls) => ls.map((l) => (l.product.id === productId ? { ...l, qty } : l)));

  const subtotal = lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0;
    return sum + qty * unitPriceFor(l.product, qty);
  }, 0);
  const vat = subtotal * VAT_RATE;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(kind === 'quote' ? '/quotes' : '/orders', {
        customer_id: Number(custId),
        items: lines.map((l) => ({ product_id: l.product.id, qty: Number(l.qty) })),
        notes: notes || null,
        delivery_instructions: kind === 'quote' ? undefined : delivery || null
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={kind === 'quote' ? 'New quote' : 'New order'} onClose={onClose} wide>
      <ErrorNote error={error} />
      {!customerId && (
        <div className="mb-4">
          <Field label="Customer">
            <select className="input" value={custId} onChange={(e) => setCustId(e.target.value)}>
              <option value="">Select a customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select>
          </Field>
        </div>
      )}

      {custId && (
        <>
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <label className="label mb-0">Add products</label>
              <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
                <button className={`rounded-md px-2.5 py-1 ${filterMode === 'bought' ? 'bg-brand-600 text-white' : 'text-slate-500'}`}
                  onClick={() => setFilterMode('bought')}>Buys ({boughtCount})</button>
                <button className={`rounded-md px-2.5 py-1 ${filterMode === 'all' ? 'bg-brand-600 text-white' : 'text-slate-500'}`}
                  onClick={() => setFilterMode('all')}>All products</button>
              </div>
            </div>
            <input className="input" placeholder="Search by name or code…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mt-1 card p-0 max-h-64 overflow-y-auto">
              {filtered.map((p) => (
                <button key={p.id} className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
                  onClick={() => addLine(p)}>
                  <span>
                    <span className="font-medium">{p.name}</span>
                    {p.times_bought > 0 && <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-600">bought {p.times_bought}×</span>}
                    <span className="ml-2 text-xs text-slate-400">{p.code} · stock {p.stock_qty}</span>
                  </span>
                  <span className="font-medium">
                    {fmtR(p.effective_price)}
                    {p.has_contract_price === 1 && <span className="ml-1 text-xs text-emerald-600">contract</span>}
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-4 py-3 text-sm text-slate-400">
                  {filterMode === 'bought' ? 'No purchase history — switch to “All products”.' : 'No products match.'}
                </div>
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {lines.map((l) => {
                const qty = Number(l.qty) || 0;
                const price = unitPriceFor(l.product, qty);
                return (
                <div key={l.product.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{l.product.name}</div>
                    <div className="text-xs text-slate-400">
                      {fmtR(price)} / {l.product.uom}
                      {price < l.product.effective_price && <span className="ml-1 text-emerald-600">qty break</span>}
                    </div>
                  </div>
                  <input className="input w-20 text-center" type="number" min="0" value={l.qty}
                    onChange={(e) => setQty(l.product.id, e.target.value)} />
                  <div className="w-24 text-right text-sm font-medium">{fmtR(qty * price)}</div>
                  <button className="text-slate-300 hover:text-red-500"
                    onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))}>×</button>
                </div>
                );
              })}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={kind === 'quote' ? 'Quote notes' : 'Order notes'}>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {kind !== 'quote' && (
              <Field label="Delivery instructions"><input className="input" value={delivery} onChange={(e) => setDelivery(e.target.value)} /></Field>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
            <div className="text-sm text-slate-500">
              Subtotal {fmtR(subtotal)} · VAT {fmtR(vat)} ·
              <span className="ml-1 font-semibold text-slate-800">Total {fmtR(subtotal + vat)}</span>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" disabled={busy || lines.length === 0} onClick={save}>
                {busy ? 'Submitting…' : kind === 'quote' ? 'Create quote' : 'Submit order'}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
