// Customer self-service portal: browse the catalogue at your prices, order,
// track orders, accept quotes. Mobile-friendly like the rep app.
import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { Spinner, ErrorNote, OrderStatusBadge, QuoteStatusBadge } from '../components/ui';
import AppIcon from '../components/AppIcon';

export default function PortalApp() {
  const [me, setMe] = useState(null);
  useEffect(() => { api.get('/portal/me').then(setMe).catch(console.error); }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-slate-100">
      <div className="flex-1 pb-20">
        <Routes>
          <Route path="/" element={<Shop me={me} />} />
          <Route path="/orders" element={<MyOrders />} />
          <Route path="/orders/:id" element={<PortalOrderDetail />} />
          <Route path="/quotes" element={<MyQuotes />} />
          <Route path="/account" element={<Account me={me} />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </div>
      <nav className="fixed bottom-0 left-1/2 z-30 w-full max-w-2xl -translate-x-1/2 border-t border-slate-200 bg-white">
        <div className="grid grid-cols-4">
          {[['/portal', 'shop', 'Shop', true], ['/portal/orders', 'orders', 'Orders'], ['/portal/quotes', 'quotes', 'Quotes'], ['/portal/account', 'account', 'Account']].map(([to, icon, label, end]) => (
            <NavLink key={to} to={to} end={!!end}
              className={({ isActive }) => `flex flex-col items-center gap-1 py-2 text-xs font-medium ${isActive ? 'text-brand-600' : 'text-slate-400'}`}>
              <AppIcon name={icon} size={30} />{label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

function PortalHeader({ title }) {
  const { logout } = useAuth();
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <img src="/icon.svg" alt="" className="h-6 w-6" />
        <h1 className="font-bold">{title}</h1>
      </div>
      <button onClick={logout} className="text-xs text-slate-400">Sign out</button>
    </header>
  );
}

function Shop({ me }) {
  const [products, setProducts] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { api.get('/portal/products').then(setProducts).catch((e) => setError(e.message)); }, []);

  const categories = useMemo(() => [...new Set((products || []).map((p) => p.category_name).filter(Boolean))], [products]);
  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return (products || []).filter((p) =>
      (!s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) &&
      (!category || p.category_name === category));
  }, [products, search, category]);

  const setQty = (pid, qty) => setCart((c) => {
    const next = { ...c };
    if (qty <= 0) delete next[pid];
    else next[pid] = qty;
    return next;
  });

  const cartLines = (products || []).filter((p) => cart[p.id]);
  const subtotal = cartLines.reduce((s, p) => s + cart[p.id] * p.price, 0);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const order = await api.post('/portal/orders', {
        items: cartLines.map((p) => ({ product_id: p.id, qty: cart[p.id] })),
        notes: notes || null
      });
      setDone(order);
      setCart({});
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (done)
    return (
      <>
        <PortalHeader title="Order placed" />
        <div className="p-4">
          <div className="card p-6 text-center">
            <div className="text-4xl">✅</div>
            <div className="mt-2 font-bold">{done.number}</div>
            <div className="text-sm text-slate-500">{fmtR(done.total)} incl. VAT</div>
            <p className="mt-1 text-xs text-slate-400">Our team will confirm your order shortly.</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="btn-secondary" onClick={() => { setDone(null); setBusy(false); }}>Keep shopping</button>
              <button className="btn-primary" onClick={() => navigate(`/portal/orders/${done.id}`)}>View order</button>
            </div>
          </div>
        </div>
      </>
    );

  return (
    <>
      <PortalHeader title={me ? me.name : 'Catalogue'} />
      <div className="space-y-3 p-4 pb-32">
        <ErrorNote error={error} />
        {me?.status === 'on_hold' && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
            ⚠ Your account is on hold — please contact us before placing orders.
          </div>
        )}
        <input className="input" placeholder="Search products…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${!category ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            onClick={() => setCategory('')}>All</button>
          {categories.map((cat) => (
            <button key={cat} className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${category === cat ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
              onClick={() => setCategory(cat === category ? '' : cat)}>{cat}</button>
          ))}
        </div>

        {!products ? <Spinner /> : (
          <div className="space-y-2">
            {filtered.map((p) => {
              const qty = cart[p.id] || 0;
              return (
                <div key={p.id} className="card flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-slate-400">
                      {p.pack_size || p.uom} · <span className="font-semibold text-slate-600">{fmtR(p.price)}</span>
                      {p.has_contract_price === 1 && <span className="ml-1 text-emerald-600">your price</span>}
                      {p.stock_qty <= 0 && <span className="ml-1 text-red-500">out of stock</span>}
                    </div>
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
          </div>
        )}
        {cartLines.length > 0 && (
          <div>
            <label className="label">Order notes</label>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        )}
      </div>

      {cartLines.length > 0 && (
        <div className="fixed bottom-14 left-1/2 z-30 w-full max-w-2xl -translate-x-1/2 border-t border-slate-200 bg-white p-3">
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-slate-500">{cartLines.length} products · subtotal {fmtR(subtotal)}</span>
            <span className="font-bold">{fmtR(subtotal * 1.15)} incl. VAT</span>
          </div>
          <button className="btn-primary w-full py-3" onClick={submit} disabled={busy}>
            {busy ? 'Placing order…' : 'Place order'}
          </button>
        </div>
      )}
    </>
  );
}

function MyOrders() {
  const [rows, setRows] = useState(null);
  const navigate = useNavigate();
  useEffect(() => { api.get('/portal/orders').then(setRows).catch(console.error); }, []);
  return (
    <>
      <PortalHeader title="My orders" />
      <div className="space-y-2 p-4">
        {!rows ? <Spinner /> : rows.map((o) => (
          <button key={o.id} className="card block w-full p-3 text-left" onClick={() => navigate(`/portal/orders/${o.id}`)}>
            <div className="flex items-center justify-between">
              <span className="font-medium">{o.number}</span>
              <OrderStatusBadge status={o.status} />
            </div>
            <div className="mt-0.5 flex justify-between text-xs text-slate-400">
              <span>{fmtDateTime(o.order_date)}</span>
              <span className="text-sm font-semibold text-slate-700">{fmtR(o.total)}</span>
            </div>
          </button>
        ))}
        {rows && rows.length === 0 && <div className="card p-6 text-center text-sm text-slate-400">No orders yet.</div>}
      </div>
    </>
  );
}

function PortalOrderDetail() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  useEffect(() => { api.get(`/portal/orders/${id}`).then(setOrder).catch(console.error); }, [id]);
  if (!order) return <><PortalHeader title="Order" /><Spinner /></>;
  return (
    <>
      <PortalHeader title={order.number} />
      <div className="space-y-3 p-4">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">{fmtDateTime(order.order_date)}</span>
            <OrderStatusBadge status={order.status} />
          </div>
          <div className="mt-3 divide-y divide-slate-100">
            {order.items.map((i) => (
              <div key={i.id} className="flex justify-between py-2 text-sm">
                <span>{i.qty} × {i.product_name}</span>
                <span className="font-medium">{fmtR(i.line_total)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-sm">
            <div className="flex justify-between text-slate-500"><span>Subtotal</span><span>{fmtR(order.subtotal)}</span></div>
            <div className="flex justify-between text-slate-500"><span>VAT (15%)</span><span>{fmtR(order.vat_amount)}</span></div>
            <div className="flex justify-between font-bold"><span>Total</span><span>{fmtR(order.total)}</span></div>
          </div>
        </div>
      </div>
    </>
  );
}

function MyQuotes() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.get('/portal/quotes').then(setRows).catch(console.error);
  useEffect(() => { load(); }, []);

  const accept = async (id) => {
    setError('');
    try { await api.post(`/portal/quotes/${id}/accept`); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <>
      <PortalHeader title="My quotes" />
      <div className="space-y-2 p-4">
        <ErrorNote error={error} />
        {!rows ? <Spinner /> : rows.map((q) => (
          <div key={q.id} className="card p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{q.number}</span>
              <QuoteStatusBadge status={q.status} />
            </div>
            <div className="mt-0.5 flex justify-between text-xs text-slate-400">
              <span>valid until {fmtDate(q.valid_until)}</span>
              <span className="text-sm font-semibold text-slate-700">{fmtR(q.total)}</span>
            </div>
            {q.status === 'sent' && !q.order_id && (
              <button className="btn-primary mt-2 w-full py-2 text-sm" onClick={() => accept(q.id)}>
                ✓ Accept quote & place order
              </button>
            )}
          </div>
        ))}
        {rows && rows.length === 0 && <div className="card p-6 text-center text-sm text-slate-400">No quotes yet.</div>}
      </div>
    </>
  );
}

function Account({ me }) {
  if (!me) return <><PortalHeader title="Account" /><Spinner /></>;
  return (
    <>
      <PortalHeader title="Account" />
      <div className="space-y-3 p-4">
        <div className="card p-4">
          <div className="font-bold">{me.name}</div>
          <div className="text-xs text-slate-400">Account {me.code}</div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div><div className="label">Payment terms</div>{me.payment_terms}</div>
            <div><div className="label">Credit limit</div>{fmtR(me.credit_limit)}</div>
            <div><div className="label">Balance</div>{fmtR(me.balance)}</div>
            <div><div className="label">Orders (12m)</div>{me.order_count} · {fmtR(me.sales_12m)}</div>
          </div>
        </div>
        {me.rep && (
          <div className="card p-4">
            <div className="label">Your rep</div>
            <div className="font-medium">{me.rep.name}</div>
            <div className="text-sm text-slate-500">{me.rep.email}{me.rep.phone ? ` · ${me.rep.phone}` : ''}</div>
          </div>
        )}
      </div>
    </>
  );
}
