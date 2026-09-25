// On-site order/quote capture: search products, tap to add, adjust quantities,
// submit. Prices are the customer's effective prices (contract > qty break >
// list). Works offline: prices come from the snapshot and the submit queues.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtR } from '../api';
import { Spinner, ErrorNote } from '../components/ui';
import OrderSummary from '../components/OrderSummary';
import ProductPurchaseHistory from '../components/ProductPurchaseHistory';
import { unitPriceFor, kgPriceFor, gPriceFor, discountPctFor, round2, priceSourceForLine, PriceSourceBadge } from '../components/NewOrderModal';
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
  const [sortByCode, setSortByCode] = useState(false); // false = default order | true = SYSPRO stock code, lowest to highest
  // R1-026: filter the list down to just what's already in the order, so a rep
  // can find and edit an existing line's qty/price without re-searching the
  // whole catalogue - the row itself (name, price, UOM, qty stepper/input) is
  // identical whether reached this way or via search, so editing it here needs
  // no separate "cart" UI or delete-and-re-add.
  const [onlyInCart, setOnlyInCart] = useState(false);
  // R1-053: which product's purchase-history panel is open, if any - only one
  // at a time, keeps the scrolling list from getting cluttered with several
  // expanded panels at once.
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [cart, setCart] = useState({}); // productId -> qty
  const [notes, setNotes] = useState('');
  // Customer's own PO / reference - its own field, never merged into notes.
  const [customerOrderNo, setCustomerOrderNo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // R1-046: 'idle' (nothing to save yet) | 'saving' | 'saved' | 'error'.
  const [draftStatus, setDraftStatus] = useState('idle');
  const draftSaveTimer = useRef(null);
  // R1-052: 'cart' (product lines) -> 'notes' (Order/Quote Notes & Special
  // Instructions, its own step) -> 'review' (final summary, notes shown
  // read-only). Was a single showSummary boolean before this ticket - notes
  // lived as a small field at the bottom of the cart screen instead of a
  // dedicated stop between capture and review.
  const [step, setStep] = useState('cart');
  const [signature, setSignature] = useState(null); // customer signature - required before an order can be submitted (not required for quotes)

  // Resuming a saved draft - load its cart/notes once, on top of whatever the
  // for-customer product fetch below already sets up. Skipped for a draftId
  // this screen just created itself (see saveDraft) - there's nothing to
  // resume from since the state here IS what was just saved, and re-fetching
  // it would only round-trip identical data back through setCart/etc.,
  // which - because those calls produce new object/string references - would
  // needlessly re-trigger the autosave effect below for a no-op change.
  const justCreatedDraftId = useRef(false);
  useEffect(() => {
    if (!draftId) return;
    if (justCreatedDraftId.current) { justCreatedDraftId.current = false; return; }
    api.get(`/drafts/${draftId}`).then((d) => {
      setCart(d.data?.items || {});
      setNotes(d.data?.notes || '');
      setCustomerOrderNo(d.data?.customer_order_no || '');
      setDraftStatus('saved'); // resumed as-is - nothing unsaved yet
    }).catch(() => {});
  }, [draftId]);

  // The product list can be scrolled far down before "Continue"/"Review" is
  // tapped - without this the notes/review screen renders starting from that
  // same scroll position instead of its own top.
  useEffect(() => { if (step !== 'cart') window.scrollTo(0, 0); }, [step]);
  const [done, setDone] = useState(null); // { number?, queued? }
  const [orderEmailInfo, setOrderEmailInfo] = useState(null); // { recipients }
  const [sendToRep, setSendToRep] = useState(false);
  const [sendToCustomer, setSendToCustomer] = useState(false);
  const [recipientIds, setRecipientIds] = useState(new Set()); // unticked by default — rep picks who gets it
  // The rep's own saved "add another email address" list - separate from
  // orderEmailInfo.recipients (admin/manager-managed, branch-wide). Reused
  // across every order/quote the rep captures, not just this one.
  const [myContacts, setMyContacts] = useState(null);
  const [personalIds, setPersonalIds] = useState(new Set());
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactEmail, setNewContactEmail] = useState('');
  const [addContactError, setAddContactError] = useState('');
  const [addingContact, setAddingContact] = useState(false);

  const toggleRecipient = (rid) => setRecipientIds((prev) => {
    const next = new Set(prev);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    return next;
  });
  const togglePersonal = (cid) => setPersonalIds((prev) => {
    const next = new Set(prev);
    if (next.has(cid)) next.delete(cid); else next.add(cid);
    return next;
  });

  // Branch-scoped to this customer's own warehouse - a Cape Town customer's
  // order shouldn't offer Johannesburg's recipients as tick-boxes, and vice
  // versa. Waits on the customer fetch below for its warehouse_id.
  useEffect(() => {
    if (!customer) return;
    api.get(`/settings/order-email-info?warehouse_id=${customer.warehouse_id || ''}`).then(setOrderEmailInfo).catch(() => {});
  }, [customer]);

  // The rep's saved contacts don't depend on the customer, so this only needs
  // to run once - not re-fetched every time `customer` changes above.
  useEffect(() => {
    api.get('/my-email-contacts').then(setMyContacts).catch(() => setMyContacts([]));
  }, []);

  // Saves the new contact to the rep's profile (so it's there next time too)
  // and immediately ticks it for THIS send - one action does both, matching
  // how ticking any other recipient works.
  const addContact = async () => {
    const name = newContactName.trim();
    const email = newContactEmail.trim();
    if (!name || !email) { setAddContactError('Name and email are both required'); return; }
    setAddingContact(true);
    setAddContactError('');
    try {
      const contact = await api.post('/my-email-contacts', { name, email });
      setMyContacts((cs) => [...(cs || []), contact].sort((a, b) => a.name.localeCompare(b.name)));
      setPersonalIds((prev) => new Set(prev).add(contact.id));
      setNewContactName('');
      setNewContactEmail('');
      setShowAddContact(false);
    } catch (e) {
      setAddContactError(e.message);
    } finally {
      setAddingContact(false);
    }
  };

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
    const rows = (products || []).filter((p) =>
      (!s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) &&
      (!onlyBought || p.times_bought > 0) &&
      (!onlyInCart || cart[p.id])
    );
    // numeric:true so a trailing-letter code (e.g. "8934700010 N") sorts next to
    // its base code in numeric order, not as a plain string comparison would.
    if (sortByCode) rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' }));
    return rows;
  }, [products, search, onlyBought, sortByCode, onlyInCart, cart]);

  const setQty = (pid, qty) => setCart((c) => {
    const next = { ...c };
    if (qty <= 0) delete next[pid];
    else next[pid] = qty;
    return next;
  });

  // R1-023: +/- must adjust from the TRUE current quantity, not the value the
  // row happened to be showing when the tap started. The old onClick handlers
  // called setQty(p.id, qty + 1) with `qty` read from the render closure - if
  // a second tap fired before React re-rendered (a real risk on mobile touch,
  // where a bounced touchend/click pair is common), both taps computed "+1"
  // from the SAME stale qty and only one increment actually landed, so a rep
  // could tap twice and see the quantity not change. Reading the previous
  // value from inside the setCart updater instead guarantees each tap sees
  // whatever the truly-latest quantity is, however many are already queued.
  const adjustQty = (pid, delta) => setCart((c) => {
    const value = (c[pid] || 0) + delta;
    const next = { ...c };
    if (value <= 0) delete next[pid];
    else next[pid] = value;
    return next;
  });

  const cartLines = (products || []).filter((p) => cart[p.id]);
  // R1-027/028: round EACH line first, then sum, then round VAT on that
  // rounded subtotal - the exact same order of operations orders.routes.js /
  // quotes.routes.js use server-side, so this preview can never differ from
  // what actually gets stored. round2 is the same epsilon-safe rounding as
  // server/db.js's round2 - see NewOrderModal.jsx's copy for why plain
  // Math.round(n*100)/100 misrounds at exact half-cent boundaries.
  const subtotal = round2(cartLines.reduce((sum, p) => sum + round2(cart[p.id] * unitPriceFor(p, cart[p.id])), 0));
  const vat = round2(subtotal * VAT_RATE);
  const total = round2(subtotal + vat);

  // R1-046: saved server-side (not just this device) so the rep can pick it
  // back up from any phone, and so an interrupted capture (connection drops,
  // app closes, phone dies) never loses more than the last ~1s of typing.
  // Doesn't need a cart - a rep who only got as far as jotting a note before
  // being pulled away can still save that.
  const saveDraft = async () => {
    setDraftStatus('saving');
    const payload = {
      kind: isQuote ? 'quote' : 'order',
      customer_id: Number(id),
      visit_id: visitId ? Number(visitId) : null,
      label: `${cartLines.length} product${cartLines.length === 1 ? '' : 's'}`,
      data: { items: cart, notes, customer_order_no: customerOrderNo }
    };
    try {
      if (draftId) await api.put(`/drafts/${draftId}`, payload);
      else {
        // First line just went in - this is the draft's actual creation,
        // which assigns it the server id everything after this PUTs to.
        const d = await api.post('/drafts', payload);
        justCreatedDraftId.current = true;
        setDraftId(d.id);
      }
      setDraftStatus('saved');
    } catch (e) {
      if (e.isNetworkError && draftId) {
        // The draft already has a real id, so the update is safe to queue
        // through the same offline outbox R1-033 tracks and surfaces to the
        // rep (Waiting to sync / Synchronising / Sync failed) - it'll reach
        // the server automatically once connectivity returns.
        queueWrite('PUT', `/drafts/${draftId}`, payload);
        setDraftStatus('saved');
      } else {
        // No draft id yet: there's nothing to queue a PUT against, and a
        // queued POST wouldn't hand back the id later PUTs need. The rep's
        // changes are still safe in this screen's own state either way -
        // just not yet on the server. Retried automatically on reconnect
        // (see the online-listener effect below) or by tapping the status.
        setDraftStatus('error');
      }
    }
  };

  // Debounced autosave: any change to the cart, notes, or the customer's own
  // reference saves the latest draft ~1s after the rep stops typing/tapping.
  // Nothing is saved until the first product line goes in - an empty draft
  // from notes alone, before any line exists, isn't what "create the Draft
  // record" in the ticket is describing.
  useEffect(() => {
    if (Object.keys(cart).length === 0 && !draftId) return;
    clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(saveDraft, 1000);
    return () => clearTimeout(draftSaveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, notes, customerOrderNo]);

  // A failed save (offline, no draft id yet to queue against) retries on its
  // own the moment the browser regains connectivity - the rep shouldn't have
  // to remember to tap retry just because signal came back.
  useEffect(() => {
    if (draftStatus !== 'error') return;
    const retry = () => saveDraft();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftStatus]);

  const confirmSubmit = async () => {
    // A quote isn't a binding sale, so no signature is required - only orders need one.
    if (!isQuote && !signature) {
      setError('Please get the customer\'s signature before submitting.');
      return;
    }
    setBusy(true);
    setError('');
    const payload = {
      customer_id: Number(id),
      visit_id: visitId ? Number(visitId) : null,
      items: cartLines.map((p) => ({ product_id: p.id, qty: cart[p.id] })),
      notes: notes || null,
      customer_order_no: isQuote ? undefined : customerOrderNo || null,
      signature: isQuote ? null : signature,
      send_to_rep: sendToRep,
      send_to_customer: sendToCustomer,
      recipient_ids: [...recipientIds],
      // Saved contacts ticked for this send - see addContact() and the "My
      // contacts" checkbox group below. Resolved server-side against
      // rep_email_contacts, scoped to this rep's own rows only.
      personal_recipient_ids: [...personalIds]
    };
    const path = isQuote ? '/quotes' : '/orders';
    clearTimeout(draftSaveTimer.current); // the draft is about to become a real order - don't let a stray autosave PUT recreate it after deletion
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
      {step === 'cart' && <MobileHeader title={`${noun} — ${customer.name}`} back={`${base}/customers/${id}`} />}
      {step === 'cart' && <div className="space-y-3 p-4 pb-36">
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
        <div className="flex gap-2 pb-1">
          <button type="button" className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${sortByCode ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            onClick={() => setSortByCode((v) => !v)}>Sort: code ↑{sortByCode ? '' : ' (off)'}</button>
          {cartLines.length > 0 && (
            <button type="button" className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${onlyInCart ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
              onClick={() => setOnlyInCart((v) => !v)}>
              🛒 In your order ({cartLines.length})
            </button>
          )}
        </div>

        <div className="space-y-2">
          {filtered.map((p) => {
            const qty = cart[p.id] || 0;
            const price = unitPriceFor(p, qty || 1);
            const kgPrice = kgPriceFor(p, price);
            const nextBreak = (p.price_breaks || []).find((b) => b.min_qty > (qty || 0));
            // General (list) price, per unit - the "G Price" (R1-019). Order
            // screen only: shows how much below it the customer's price is.
            const listPrice = gPriceFor(p);
            const belowList = !isQuote && listPrice > 0 && price < listPrice ? listPrice - price : null;
            // R1-020: % off G Price, specifically for SYSPRO negotiated pricing
            // (contract/buying-group/price-code) - not RouteOne qty-break
            // pricing, which belowList above already covers in Rand terms.
            const gDiscountPct = p.syspro_pricing_tier ? discountPctFor(listPrice, p.effective_price) : null;
            const blocked = !!p.discontinued || !!p.no_price;
            return (
              <div key={p.id} className={`card p-3 ${blocked ? 'border-red-200 bg-red-50/50' : ''}`}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    <span className={blocked ? 'text-red-700 line-through' : ''}>{p.name}</span>
                    {p.discontinued && <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700">discontinued</span>}
                    {!p.discontinued && p.no_price && <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700">no price set</span>}
                    {!blocked && p.times_bought > 0 && <span className="ml-1.5 rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-600">buys {p.times_bought}×</span>}
                  </div>
                  <div className="text-xs text-slate-400">
                    {/* R1-024: SYSPRO's own selling-unit UOM (products.uom, from
                        vw_FS_Products.OtherUom), shown right where the rep
                        decides the quantity - previously absent from this row
                        entirely, so a rep had no way to tell here whether they
                        were ordering EACH, KG, or something else. */}
                    {p.code} · {fmtR(price)} / <span className="font-medium text-slate-500">{p.uom || 'each'}</span>
                    {belowList != null && <span className="ml-1 text-red-600 font-semibold">-{fmtR(belowList)}</span>}
                    {kgPrice != null && <span className="ml-1">({fmtR(kgPrice)}/kg)</span>}
                    {/* R1-018/R1-044: which tier produced this price - not the
                        generic has_contract_price flag, which is also set for
                        buying-group and price-code pricing (would mislabel
                        those as "contract"). Mirrors the office order
                        builder's badge (NewOrderModal.jsx) so the same price
                        source always reads the same way everywhere. */}
                    <PriceSourceBadge className="ml-1" source={priceSourceForLine(p, price)} />
                    {p.syspro_pricing_tier && listPrice > 0 && (
                      <span className="ml-1">
                        · G {fmtR(listPrice)}{gDiscountPct != null && <span className="font-medium text-emerald-600"> -{gDiscountPct}%</span>}
                      </span>
                    )}
                    {p.stock_qty <= 0
                      ? <span className="ml-1 text-red-500 font-medium">out of stock</span>
                      : p.stock_qty < 20 && <span className="ml-1 text-amber-600">low stock ({p.stock_qty})</span>}
                  </div>
                  {qty > 0 && nextBreak && (
                    <div className="text-[10px] text-sky-600">💡 {nextBreak.min_qty}+ units → {fmtR(nextBreak.price)} each</div>
                  )}
                </div>
                {blocked ? (
                  <span className="whitespace-nowrap text-[11px] font-medium text-red-600">unavailable</span>
                ) : qty === 0 ? (
                  <button className="btn-secondary px-3" onClick={() => adjustQty(p.id, 1)}>+</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button className="btn-secondary h-9 w-9 p-0" onClick={() => adjustQty(p.id, -1)}>−</button>
                    {/* R1-023: a rep ordering, say, 144 units previously had to tap
                        + 144 times with no way to type the number directly - every
                        tap is a chance to overshoot/undershoot by one and not
                        notice, which is exactly the "quantity doesn't match what
                        was captured" failure this ticket describes. inputMode
                        brings up the numeric keypad on mobile. */}
                    <input type="number" inputMode="numeric" min="1" max="1000000"
                      className="w-14 rounded-lg border border-slate-200 py-1.5 text-center font-semibold"
                      value={qty}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setQty(p.id, Number.isFinite(n) ? Math.min(1000000, Math.max(0, n)) : 0);
                      }} />
                    <button className="btn-primary h-9 w-9 p-0" onClick={() => adjustQty(p.id, 1)}>+</button>
                  </div>
                )}
              </div>
              {/* R1-053: lazy-loaded - ProductPurchaseHistory only fetches once expanded */}
              <button type="button"
                className="mt-1.5 text-[11px] font-medium text-brand-600"
                onClick={() => setExpandedHistoryId((cur) => (cur === p.id ? null : p.id))}>
                {expandedHistoryId === p.id ? '▲ Hide purchase history' : '▼ Purchase history'}
              </button>
              {expandedHistoryId === p.id && (
                <div className="mt-2">
                  <ProductPurchaseHistory productId={p.id} customerId={Number(id)} />
                </div>
              )}
              </div>
            );
          })}
          {filtered.length === 0 && <div className="card p-6 text-center text-sm text-slate-400">No products match.</div>}
        </div>

        {!isQuote && (
          <div>
            <label className="label">Customer Order No. / Reference</label>
            <input className="input" value={customerOrderNo} maxLength={100}
              onChange={(e) => setCustomerOrderNo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
              placeholder="Their PO or reference number" />
          </div>
        )}

        {/* R1-046: small, unobtrusive autosave status - the rep never has to
            remember to press a save button. A failed save (offline, no draft
            id yet) is tappable to retry immediately, on top of the automatic
            retry-on-reconnect (see the online-listener effect above). */}
        {draftStatus !== 'idle' && (
          <div className="text-center text-xs">
            {draftStatus === 'saving' && <span className="text-slate-400">Saving…</span>}
            {draftStatus === 'saved' && <span className="text-emerald-600">✓ Draft Saved</span>}
            {draftStatus === 'error' && (
              <button type="button" className="font-medium text-red-600 underline" onClick={saveDraft}>
                ⚠ Unable to Save – Retry
              </button>
            )}
          </div>
        )}
      </div>}

      {/* R1-052: Notes & Special Instructions step - between the cart and the
          final review, not a field on the cart screen. */}
      {step === 'notes' && (
        <>
          <MobileHeader title={`${noun} notes`} back={null} />
          <div className="p-4 pb-40 space-y-4">
            <div>
              <label className="label">{noun} Notes &amp; Special Instructions</label>
              <textarea
                className="input"
                rows={8}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={'e.g. free stock required, COA required, sample/promotional stock, special delivery instructions, customer-specific instructions, telesales instructions…'}
              />
              <p className="mt-1 text-xs text-slate-400">Optional — leave blank if there's nothing special to note.</p>
            </div>
          </div>
          <div className="fixed bottom-14 left-1/2 z-30 w-full max-w-md -translate-x-1/2 space-y-2 border-t border-slate-200 bg-white p-3">
            <button className="btn-primary w-full py-3" onClick={() => setStep('review')}>
              {isQuote ? 'Review quote' : 'Review order'}
            </button>
            <button className="btn-secondary w-full py-2" onClick={() => setStep('cart')}>
              Back to cart
            </button>
          </div>
        </>
      )}

      {/* Summary review screen */}
      {step === 'review' && (
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
                vat_amount: vat,
                total,
                notes,
                customer_order_no: customerOrderNo || null,
                customer_code: customer.code
              }}
              items={cartLines.map((p) => {
                const price = unitPriceFor(p, cart[p.id]);
                return {
                  product_name: p.name,
                  product_code: p.code,
                  unit_price: price,
                  kg_price: kgPriceFor(p, price),
                  qty: cart[p.id],
                  uom: p.uom,
                  // R1-027: rounded per line, matching the server's exact formula.
                  line_total: round2(cart[p.id] * price),
                  price_source: priceSourceForLine(p, price)
                };
              })}
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

              {/* The rep's own saved contacts - persist across every order/quote
                  they capture, not just this one. Separate from the admin
                  "Also send to" list above. */}
              {myContacts?.length > 0 && (
                <div className="border-t border-slate-100 pt-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase text-slate-400">My contacts</div>
                  <div className="space-y-1.5">
                    {myContacts.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={personalIds.has(c.id)} onChange={() => togglePersonal(c.id)} />
                        <span>{c.name}</span>
                        <span className="text-xs text-slate-400">{c.email}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="border-t border-slate-100 pt-3">
                {!showAddContact ? (
                  <button type="button" className="text-sm font-medium text-brand-600" onClick={() => setShowAddContact(true)}>
                    + Add new email address
                  </button>
                ) : (
                  <div className="space-y-2">
                    <label className="label">Add a new email address</label>
                    <input className="input" placeholder="Name" value={newContactName}
                      onChange={(e) => setNewContactName(e.target.value)} />
                    <input className="input" type="email" placeholder="name@example.com" value={newContactEmail}
                      onChange={(e) => setNewContactEmail(e.target.value)} />
                    <ErrorNote error={addContactError} />
                    <div className="flex gap-2">
                      <button type="button" className="btn-secondary flex-1"
                        onClick={() => { setShowAddContact(false); setAddContactError(''); setNewContactName(''); setNewContactEmail(''); }}>
                        Cancel
                      </button>
                      <button type="button" className="btn-primary flex-1" disabled={addingContact} onClick={addContact}>
                        {addingContact ? 'Saving…' : 'Save & add'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-400">Saved to your profile — you'll be able to pick it again on future orders.</p>
                  </div>
                )}
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
            <button className="btn-secondary w-full py-2" onClick={() => setStep('notes')} disabled={busy}>
              Back
            </button>
          </div>
        </>
      )}

      {/* Sticky cart summary */}
      {step === 'cart' && cartLines.length > 0 && (
        <div className="fixed bottom-14 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-slate-200 bg-white p-3">
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-slate-500">{cartLines.length} products · subtotal {fmtR(subtotal)}</span>
            <span className="font-bold">{fmtR(total)} incl. VAT</span>
          </div>
          <button className="btn-primary w-full py-3" onClick={() => setStep('notes')} disabled={busy}>
            {busy ? 'Loading…' : 'Continue'}
          </button>
        </div>
      )}
    </>
  );
}
