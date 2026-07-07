// On-site order/quote capture: search products, tap to add, adjust quantities,
// submit. Prices are the customer's effective prices (contract > qty break >
// list). Works offline: prices come from the snapshot and the submit queues.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtR } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import { unitPriceFor } from '../components/NewOrderModal';
import { queueWrite } from '../offline';
import { MobileHeader } from './MobileApp';

const VAT_RATE = 0.15;

export default function RepOrderCapture() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const visitId = params.get('visit');
  const isQuote = params.get('kind') === 'quote';
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [products, setProducts] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState({}); // productId -> qty
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { number?, queued? }

  useEffect(() => {
    api.get(`/customers/${id}`).then(setCustomer).catch(console.error);
    api.get(`/products/for-customer/${id}`).then(setProducts).catch(console.error);
  }, [id]);

  const categories = useMemo(
    () => [...new Set((products || []).map((p) => p.category_name).filter(Boolean))],
    [products]
  );

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return (products || []).filter((p) =>
      (!s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) &&
      (!category || p.category_name === category)
    );
  }, [products, search, category]);

  const setQty = (pid, qty) => setCart((c) => {
    const next = { ...c };
    if (qty <= 0) delete next[pid];
    else next[pid] = qty;
    return next;
  });

  const cartLines = (products || []).filter((p) => cart[p.id]);
  const subtotal = cartLines.reduce((sum, p) => sum + cart[p.id] * unitPriceFor(p, cart[p.id]), 0);
  const total = subtotal * (1 + VAT_RATE);

  const submit = async () => {
    setBusy(true);
    setError('');
    const payload = {
      customer_id: Number(id),
      visit_id: visitId ? Number(visitId) : null,
      items: cartLines.map((p) => ({ product_id: p.id, qty: cart[p.id] })),
      notes: notes || null
    };
    const path = isQuote ? '/quotes' : '/orders';
    try {
      const doc = await api.post(path, payload);
      setDone({ number: doc.number, total: doc.total });
    } catch (e) {
      if (e.isNetworkError) {
        // No signal on site: park it in the outbox, it syncs automatically.
        queueWrite('POST', path, payload);
        setDone({ queued: true, total });
      } else {
        setError(e.message);
        setBusy(false);
      }
    }
  };

  const noun = isQuote ? 'Quote' : 'Order';

  if (done)
    return (
      <>
        <MobileHeader title={done.queued ? `${noun} queued` : `${noun} submitted`} back={`/mobile/customers/${id}`} />
        <div className="p-4">
          <div className="card p-6 text-center">
            <div className="text-4xl">{done.queued ? '📡' : '✅'}</div>
            <div className="mt-2 font-bold">{done.queued ? `${noun} saved offline` : done.number}</div>
            <div className="text-sm text-slate-500">{fmtR(done.total)} incl. VAT</div>
            {done.queued && <div className="mt-1 text-xs text-slate-400">It will submit automatically when you're back online.</div>}
            <button className="btn-primary mt-4 w-full" onClick={() => navigate(`/mobile/customers/${id}`)}>
              Back to customer
            </button>
          </div>
        </div>
      </>
    );

  if (!customer || !products) return <><MobileHeader title={`New ${noun.toLowerCase()}`} back={`/mobile/customers/${id}`} /><Spinner /></>;

  return (
    <>
      <MobileHeader title={`${noun} — ${customer.name}`} back={`/mobile/customers/${id}`} />
      <div className="space-y-3 p-4 pb-36">
        <ErrorNote error={error} />
        <input className="input" placeholder="Search products…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${!category ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            onClick={() => setCategory('')}>All</button>
          {categories.map((cat) => (
            <button key={cat}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${category === cat ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
              onClick={() => setCategory(cat === category ? '' : cat)}>{cat}</button>
          ))}
        </div>

        <div className="space-y-2">
          {filtered.map((p) => {
            const qty = cart[p.id] || 0;
            const price = unitPriceFor(p, qty || 1);
            const nextBreak = (p.price_breaks || []).find((b) => b.min_qty > (qty || 0));
            return (
              <div key={p.id} className="card flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-slate-400">
                    {p.code} · {fmtR(price)}
                    {p.has_contract_price === 1 && <span className="ml-1 text-emerald-600">contract</span>}
                    {qty > 0 && price < p.price_breaks?.[0]?.price && <span className="ml-1 text-emerald-600">qty break</span>}
                    {p.stock_qty <= 0
                      ? <span className="ml-1 text-red-500 font-medium">out of stock</span>
                      : p.stock_qty < 20 && <span className="ml-1 text-amber-600">low stock ({p.stock_qty})</span>}
                  </div>
                  {qty > 0 && nextBreak && (
                    <div className="text-[10px] text-sky-600">💡 {nextBreak.min_qty}+ units → {fmtR(nextBreak.price)} each</div>
                  )}
                </div>
                {qty === 0 ? (
                  <button className="btn-secondary px-3" onClick={() => setQty(p.id, 1)}>+</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button className="btn-secondary h-9 w-9 p-0" onClick={() => setQty(p.id, qty - 1)}>−</button>
                    <span className="w-6 text-center font-semibold">{qty}</span>
                    <button className="btn-primary h-9 w-9 p-0" onClick={() => setQty(p.id, qty + 1)}>+</button>
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && <div className="card p-6 text-center text-sm text-slate-400">No products match.</div>}
        </div>

        <div>
          <label className="label">{noun} notes</label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      {/* Sticky cart summary */}
      {cartLines.length > 0 && (
        <div className="fixed bottom-14 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-slate-200 bg-white p-3">
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-slate-500">{cartLines.length} products · subtotal {fmtR(subtotal)}</span>
            <span className="font-bold">{fmtR(total)} incl. VAT</span>
          </div>
          <button className="btn-primary w-full py-3" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : isQuote ? 'Create quote' : 'Submit order'}
          </button>
        </div>
      )}
    </>
  );
}
