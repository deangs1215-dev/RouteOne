// On-site order/quote capture: search products, tap to add, adjust quantities,
// submit. Prices are the customer's effective prices (contract > qty break >
// list). Works offline: prices come from the snapshot and the submit queues.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtR } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import { unitPriceFor, kgPriceFor } from '../components/NewOrderModal';
import { queueWrite } from '../offline';
import { useAuth } from '../auth';
import { MobileHeader } from './MobileApp';

const VAT_RATE = 0.15;

export default function RepOrderCapture({ base = '/mobile' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const visitId = params.get('visit');
  const isQuote = params.get('kind') === 'quote';
  const [draftId, setDraftId] = useState(params.get('draft') || null);
  const navigate = useNavigate();
  const { user } = useAuth();

  const [customer, setCustomer] = useState(null);
  const [products, setProducts] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyBought, setOnlyBought] = useState(false); // show only what this customer buys
  const [cart, setCart] = useState({}); // productId -> qty
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [showSummary, setShowSummary] = useState(false); // review screen before final submit
  const [signature, setSignature] = useState(null); // customer signature - required before an order can be submitted (not required for quotes)

  // Resuming a saved draft - load its cart/notes once, on top of whatever the
  // for-customer product fetch below already sets up.
  useEffect(() => {
    if (!draftId) return;
    api.get(`/drafts/${draftId}`).then((d) => {
      setCart(d.data?.items || {});
      setNotes(d.data?.notes || '');
    }).catch(() => {});
  }, [draftId]);

  // The product list can be scrolled far down before "Review" is tapped -
  // without this the review screen renders starting from that same scroll
  // position instead of its own top.
  useEffect(() => { if (showSummary) window.scrollTo(0, 0); }, [showSummary]);
  const [done, setDone] = useState(null); // { number?, queued? }
  const [orderEmailInfo, setOrderEmailInfo] = useState(null); // { recipients }
  const [sendToRep, setSendToRep] = useState(false);
  const [sendToCustomer, setSendToCustomer] = useState(false);
  const [extraEmail, setExtraEmail] = useState('');
  const [recipientIds, setRecipientIds] = useState(new Set()); // unticked by default — rep picks who gets it

  const toggleRecipient = (rid) => setRecipientIds((prev) => {
    const next = new Set(prev);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    return next;
  });

  useEffect(() => {
    api.get('/settings/order-email-info').then(setOrderEmailInfo).catch(() => {});
  }, []);

  useEffect(() => {
    api.get(`/customers/${id}`).then(setCustomer).catch(console.error);
    api.get(`/products/for-customer/${id}`).then((ps) => {
      setProducts(ps);
      setOnlyBought(ps.some((p) => p.times_bought > 0)); // default to their usual products
    }).catch(console.error);
  }, [id]);

  const boughtCount = useMemo(() => (products || []).filter((p) => p.times_bought > 0).length, [products]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return (products || []).filter((p) =>
      (!s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) &&
      (!onlyBought || p.times_bought > 0)
    );
  }, [products, search, onlyBought]);

  const setQty = (pid, qty) => setCart((c) => {
    const next = { ...c };
    if (qty <= 0) delete next[pid];
    else next[pid] = qty;
    return next;
  });

  // Once the cart or notes change again after a save, "Draft saved" is stale.
  useEffect(() => { setDraftSaved(false); }, [cart, notes]);

  const cartLines = (products || []).filter((p) => cart[p.id]);
  const subtotal = cartLines.reduce((sum, p) => sum + cart[p.id] * unitPriceFor(p, cart[p.id]), 0);
  const total = subtotal * (1 + VAT_RATE);

  // Saved server-side (not just this device) so the rep can pick it back up
  // from any phone. Doesn't need a cart - a rep who only got as far as
  // jotting a note before being pulled away can still save that.
  const saveDraft = async () => {
    setSavingDraft(true);
    setError('');
    setDraftSaved(false);
    const payload = {
      kind: isQuote ? 'quote' : 'order',
      customer_id: Number(id),
      visit_id: visitId ? Number(visitId) : null,
      label: `${cartLines.length} product${cartLines.length === 1 ? '' : 's'}`,
      data: { items: cart, notes }
    };
    try {
      if (draftId) await api.put(`/drafts/${draftId}`, payload);
      else {
        const d = await api.post('/drafts', payload);
        setDraftId(d.id);
      }
      setDraftSaved(true);
    } catch (e) {
      setError(e.message || 'Could not save draft - check your connection.');
    } finally {
      setSavingDraft(false);
    }
  };

  const confirmSubmit = async () => {
    // A quote isn't a binding sale, so no signature is required - only orders need one.
    if (!isQuote && !signature) {
      setError('Please get the customer\'s signature before submitting.');
      return;
    }
    const trimmedExtra = extraEmail.trim();
    if (trimmedExtra && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedExtra)) {
      setError('That extra email address doesn\'t look right.');
      return;
    }
    setBusy(true);
    setError('');
    const payload = {
      customer_id: Number(id),
      visit_id: visitId ? Number(visitId) : null,
      items: cartLines.map((p) => ({ product_id: p.id, qty: cart[p.id] })),
      notes: notes || null,
      signature: isQuote ? null : signature,
      send_to_rep: sendToRep,
      send_to_customer: sendToCustomer,
      extra_email: trimmedExtra || null,
      recipient_ids: [...recipientIds]
    };
    const path = isQuote ? '/quotes' : '/orders';
    try {
      const doc = await api.post(path, payload);
      if (draftId) api.del(`/drafts/${draftId}`).catch(() => {});
      setDone({ number: doc.number, total: doc.total });
    } catch (e) {
      if (e.isNetworkError) {
        queueWrite('POST', path, payload);
        if (draftId) api.del(`/drafts/${draftId}`).catch(() => {});
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
        <MobileHeader title={done.queued ? `${noun} queued` : `${noun} submitted`} back={`${base}/customers/${id}`} />
        <div className="p-4">
          <div className="card p-6 text-center">
            <div className="text-4xl">{done.queued ? '📡' : '✅'}</div>
            <div className="mt-2 font-bold">{done.queued ? `${noun} saved offline` : done.number}</div>
            <div className="text-sm text-slate-500">{fmtR(done.total)} incl. VAT</div>
            {done.queued && <div className="mt-1 text-xs text-slate-400">It will submit automatically when you're back online.</div>}
            <button className="btn-primary mt-4 w-full" onClick={() => navigate(`${base}/customers/${id}`)}>
              Back to customer
            </button>
          </div>
        </div>
      </>
    );

  if (!customer || !products) return <><MobileHeader title={`New ${noun.toLowerCase()}`} back={`${base}/customers/${id}`} /><Spinner /></>;

  return (
    <>
      {!showSummary && <MobileHeader title={`${noun} — ${customer.name}`} back={`${base}/customers/${id}`} />}
      {!showSummary && <div className="space-y-3 p-4 pb-36">
        <ErrorNote error={error} />
        <div className="relative">
          <input className="input pr-9" placeholder="Search products…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button type="button" onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Clear search">✕</button>
          )}
        </div>
        {boughtCount > 0 && (
          <div className="flex gap-2 pb-1">
            <button className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${onlyBought ? 'bg-emerald-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
              onClick={() => setOnlyBought(true)}>★ Previously bought ({boughtCount})</button>
            <button className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${!onlyBought ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
              onClick={() => setOnlyBought(false)}>All products</button>
          </div>
        )}

        <div className="space-y-2">
          {filtered.map((p) => {
            const qty = cart[p.id] || 0;
            const price = unitPriceFor(p, qty || 1);
            const kgPrice = kgPriceFor(p, price);
            const nextBreak = (p.price_breaks || []).find((b) => b.min_qty > (qty || 0));
            // General (list) price, per unit - same conversion as the server's
            // productUnitPrice(). Order screen only: shows how much below the
            // general price the customer's price is.
            const listPrice = (p.list_price || 0) * (p.conv_factor_alt_uom || p.pack_weight_kg || 1);
            const belowList = !isQuote && listPrice > 0 && price < listPrice ? listPrice - price : null;
            return (
              <div key={p.id} className="card flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {p.name}
                    {p.times_bought > 0 && <span className="ml-1.5 rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-600">buys {p.times_bought}×</span>}
                  </div>
                  <div className="text-xs text-slate-400">
                    {p.code} · {fmtR(price)}
                    {belowList != null && <span className="ml-1 text-red-600 font-semibold">-{fmtR(belowList)}</span>}
                    {kgPrice != null && <span className="ml-1">({fmtR(kgPrice)}/kg)</span>}
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
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            placeholder="Optional" />
          {notes.trim() && <div className="mt-1 text-xs text-emerald-600">✓ Saved with this {noun.toLowerCase()}</div>}
        </div>

        {/* Save & come back later - e.g. connectivity drops or the rep gets
            pulled away mid-capture. Doesn't need products in the cart. */}
        <button className="btn-secondary w-full" onClick={saveDraft} disabled={savingDraft}>
          {savingDraft ? 'Saving draft…' : draftSaved ? '✓ Draft saved' : `💾 Save as draft`}
        </button>
      </div>}

      {/* Summary review screen */}
      {showSummary && (
        <>
          <MobileHeader title={`Review ${isQuote ? 'quote' : 'order'}`} back={null} />
          <div className="p-4 pb-64 space-y-4">
            <ErrorNote error={error} />
            <OrderSummary
              order={{
                number: '',
                quote_date: new Date().toISOString(),
                order_date: new Date().toISOString(),
                subtotal,
                vat_amount: subtotal * VAT_RATE,
                total,
                notes,
                customer_code: customer.code
              }}
              items={cartLines.map((p) => ({
                product_name: p.name,
                product_code: p.code,
                unit_price: unitPriceFor(p, cart[p.id]),
                kg_price: kgPriceFor(p, unitPriceFor(p, cart[p.id])),
                qty: cart[p.id],
                uom: p.uom,
                line_total: cart[p.id] * unitPriceFor(p, cart[p.id])
              }))}
              customer={customer}
              type={isQuote ? 'quote' : 'order'}
              showSignature={!isQuote}
              onSignatureSave={setSignature}
            />

            {/* Who this gets emailed to, plus optional extra recipient */}
            <div className="card p-4 space-y-3">
              <div className="text-sm font-semibold text-slate-700">📧 Emailed to</div>
              {!customer.email && (
                <div className="text-xs text-amber-600">No email on file for this customer.</div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sendToCustomer} disabled={!customer.email}
                  onChange={(e) => setSendToCustomer(e.target.checked)} />
                <span>Customer{customer.email ? <span className="ml-1 text-xs text-slate-400">{customer.email}</span> : ''}</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sendToRep} onChange={(e) => setSendToRep(e.target.checked)} />
                Send a copy to me{user?.email ? ` (${user.email})` : ''}
              </label>

              {/* Recipients configured in Settings — unticked by default, rep picks who gets it */}
              {orderEmailInfo?.recipients?.length > 0 && (
                <div className="border-t border-slate-100 pt-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase text-slate-400">Also send to</div>
                  <div className="space-y-1.5">
                    {orderEmailInfo.recipients.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={recipientIds.has(r.id)} onChange={() => toggleRecipient(r.id)} />
                        <span>{r.name}</span>
                        <span className="text-xs text-slate-400">{r.email}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="label">Add another email address</label>
                <input className="input" type="email" placeholder="name@example.com" value={extraEmail}
                  onChange={(e) => setExtraEmail(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="fixed bottom-14 left-1/2 z-30 w-full max-w-md -translate-x-1/2 space-y-2 border-t border-slate-200 bg-white p-3">
            {!isQuote && !signature && (
              <div className="text-center text-xs text-amber-600">✋ Customer signature required before submitting</div>
            )}
            <button className="btn-primary w-full py-3" onClick={confirmSubmit} disabled={busy || (!isQuote && !signature)}>
              {busy ? 'Submitting…' : `Confirm & ${isQuote ? 'create quote' : 'submit order'}`}
            </button>
            <button className="btn-secondary w-full py-2" onClick={() => setShowSummary(false)} disabled={busy}>
              Back to cart
            </button>
          </div>
        </>
      )}

      {/* Sticky cart summary */}
      {!showSummary && cartLines.length > 0 && (
        <div className="fixed bottom-14 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-slate-200 bg-white p-3">
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-slate-500">{cartLines.length} products · subtotal {fmtR(subtotal)}</span>
            <span className="font-bold">{fmtR(total)} incl. VAT</span>
          </div>
          <button className="btn-primary w-full py-3" onClick={() => setShowSummary(true)} disabled={busy}>
            {busy ? 'Loading…' : isQuote ? 'Review quote' : 'Review order'}
          </button>
        </div>
      )}
    </>
  );
}
