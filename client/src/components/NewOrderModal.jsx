// Order/quote capture used by the back office. Picks a customer, then adds
// lines at the customer's effective price (contract > qty break > list).
import { useEffect, useMemo, useState } from 'react';
import { api, fmtR } from '../api';
import { Modal, Field, ErrorNote } from './ui';
import OrderSummary from './OrderSummary';
import OrderSendModal from './OrderSendModal';
import { useAuth } from '../auth';

const VAT_RATE = 0.15;

// R1-028: same epsilon-safe rounding as server/db.js's round2 - see that
// function's comment for why plain Math.round(n*100)/100 misrounds at exact
// half-cent boundaries. Duplicated here (not imported) because this is
// client-side browser code with no access to the server module; the algorithm
// must stay identical to it, which is why every caller uses this helper
// rather than rolling its own Math.round.
export function round2(n) {
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n) * 100 + 1e-9) / 100;
}

// Unit price for a given quantity: contract price wins, else the best
// applicable quantity break from the server-provided price_breaks.
export function unitPriceFor(product, qty) {
  if (product.has_contract_price === 1 || !product.price_breaks?.length) return product.effective_price;
  const applicable = product.price_breaks.filter((b) => qty >= b.min_qty);
  return applicable.length ? applicable[applicable.length - 1].price : product.effective_price;
}

// Price per kg for a given unit price, or null if the kg factor isn't known.
// conv_factor_alt_uom is SYSPRO's own kg-per-selling-unit factor (see db.js) -
// the catalogue's list_price is itself a per-kg price, so this just reverses
// the same multiplication to show the rep what they're paying per kg.
export function kgPriceFor(product, unitPrice) {
  const kg = product.conv_factor_alt_uom || product.pack_weight_kg;
  return kg && kg > 0 ? unitPrice / kg : null;
}

// R1-019: the "G Price" / General Price, per selling unit - SYSPRO's normal
// list price before any customer-specific pricing. products.list_price is
// per-kg (vw_FS_Products prefers PriceCode 'G' when picking which InvPrice row
// to sync - see docs/sql/vw_FS_Products*.sql), so this scales it by the same
// conv_factor_alt_uom conversion productUnitPrice() uses server-side, to get
// the actual per-unit price a rep would pay with no contract in place.
export function gPriceFor(product) {
  // R1-025/027/028: rounded to cents, same as server/db.js's productUnitPrice()
  // now does - see its comment for why (a per-kg SYSPRO price scaled by the
  // conversion factor can land on many decimal places, e.g. 79.94 x 5.76 =
  // 460.4544, which is not a price any real system would actually charge).
  return round2((product.list_price || 0) * (product.conv_factor_alt_uom || product.pack_weight_kg || 1));
}

// R1-020: % discount the customer's negotiated price represents off the G
// Price - (G - negotiated) / G * 100, per the ticket's exact formula. Returns
// null (nothing to show) rather than 0 when there is no real saving to report:
// no G price to compare against, or the "negotiated" price is not actually
// below G (a price code row can equal or exceed G, which is not a discount).
export function discountPctFor(gPrice, negotiatedPrice) {
  if (!(gPrice > 0) || !(negotiatedPrice < gPrice)) return null;
  return Math.round(((gPrice - negotiatedPrice) / gPrice) * 100);
}

export default function NewOrderModal({ customerId, kind = 'order', onClose, onSaved }) {
  const { user } = useAuth();
  // R1-026: price/discount editing is only for office/manager/admin - matches
  // the server's own authorization exactly (orders.routes.js / quotes.routes.js:
  // "!scopeForUser(user).isRep && item.unit_price != null"). A rep never sees
  // this UI; if they somehow did, the server would still ignore any price they
  // sent and price the line at effectivePrice() regardless.
  // Fail closed: requires a confirmed non-rep role, not just "not confirmed
  // rep" - so the edit UI can never flash on before auth has actually loaded.
  const canEditPrice = !!user && user.role !== 'rep';
  const [customers, setCustomers] = useState([]);
  const [custId, setCustId] = useState(customerId || '');
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('bought'); // 'bought' | 'all'
  const [sortByCode, setSortByCode] = useState(false); // false = name (default) | true = SYSPRO stock code, lowest to highest
  const [lines, setLines] = useState([]); // { product, qty }
  const [notes, setNotes] = useState('');
  // The customer's own PO / reference. Kept out of notes on purpose - it's the
  // key they reconcile against, so it prints on the confirmation in its own row.
  const [customerOrderNo, setCustomerOrderNo] = useState('');
  const [delivery, setDelivery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSummary, setShowSummary] = useState(false); // review screen before final submit
  const [createdOrder, setCreatedOrder] = useState(null); // order just created, show send modal
  const [showSendModal, setShowSendModal] = useState(false);
  // R1-026: which cart line (by product id) currently has its price/discount
  // editor open, if any. Only one at a time - keeps the UI simple and avoids
  // a screenful of open editors after adding several lines.
  const [editingPriceFor, setEditingPriceFor] = useState(null);

  // Patch arbitrary fields (price_override, discount_pct) on one existing
  // cart line, without touching qty or requiring the line to be removed and
  // re-added - R1-026's actual requirement.
  const updateLine = (productId, patch) =>
    setLines((ls) => ls.map((l) => (l.product.id === productId ? { ...l, ...patch } : l)));

  useEffect(() => {
    if (!customerId) api.get('/customers').then(setCustomers).catch(() => {});
  }, [customerId]);

  useEffect(() => {
    if (!custId) return setProducts([]);
    api.get(`/products/for-customer/${custId}`).then((ps) => {
      setProducts(ps);
      setFilterMode(ps.some((p) => p.times_bought > 0) ? 'bought' : 'all');
    }).catch(() => {});
    setLines([]);
  }, [custId]);

  const boughtCount = useMemo(() => products.filter((p) => p.times_bought > 0).length, [products]);
  const selectedCustomer = useMemo(
    () => customers.find((c) => String(c.id) === String(custId)) || null,
    [customers, custId]
  );

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    const rows = products
      .filter((p) => filterMode === 'all' || p.times_bought > 0)
      .filter((p) => !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s));
    // Sorted before the 60-item cap so "lowest to highest" reflects the actual
    // SYSPRO stock code (p.code), not just the first 60 alphabetical-by-name
    // matches re-sorted afterwards. numeric:true handles codes that carry a
    // trailing letter (e.g. "8934700010" vs "8934700010 N") in numeric order
    // rather than "10" sorting after "10 N" as a plain string compare would.
    if (sortByCode) rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' }));
    return rows.slice(0, 60);
  }, [products, search, filterMode, sortByCode]);

  const addLine = (product) => {
    setSearch('');
    setLines((ls) => {
      const existing = ls.find((l) => l.product.id === product.id);
      if (existing) return ls.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l));
      // discount_pct / price_override default to "unset" (0 / null), i.e.
      // identical behaviour to before this feature existed, until an
      // authorized user explicitly edits a line.
      return [...ls, { product, qty: 1, discount_pct: 0, price_override: null }];
    });
  };

  // R1-025/026: the price actually charged for a line - an explicit office
  // override if one was entered, else the customer's normal effective price
  // (contract > qty break > list) for the current quantity. Used everywhere a
  // line's real price matters (subtotal calc, row display, submit payload) so
  // there is exactly one place this decision is made.
  const priceForLine = (l) => {
    const qty = Number(l.qty) || 0;
    if (l.price_override != null && l.price_override !== '') {
      const n = Number(l.price_override);
      if (Number.isFinite(n)) return n;
    }
    return unitPriceFor(l.product, qty);
  };

  const setQty = (productId, qty) =>
    setLines((ls) => ls.map((l) => (l.product.id === productId ? { ...l, qty } : l)));

  const subtotal = round2(lines.reduce((sum, l) => {
    const qty = Number(l.qty) || 0;
    // Discounts only apply to orders - quotes.routes.js has no discount
    // concept server-side (every quote line stores discount_pct = 0), so
    // applying one here would preview a total the created quote would not have.
    const discount = kind === 'quote' ? 0 : Number(l.discount_pct) || 0;
    return sum + round2(qty * priceForLine(l) * (1 - discount / 100));
  }, 0));
  const vat = round2(subtotal * VAT_RATE);

  const confirmSubmit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post(kind === 'quote' ? '/quotes' : '/orders', {
        customer_id: Number(custId),
        // unit_price/discount_pct are only sent for a line an office user
        // actually edited - every other line is left for the server to price
        // fresh via effectivePrice() at submit time, exactly as before this
        // feature existed. The server ignores both fields outright for a rep
        // (scopeForUser(user).isRep), so this can never let a rep set their
        // own price even if a request were crafted by hand.
        items: lines.map((l) => {
          const item = { product_id: l.product.id, qty: Number(l.qty) };
          if (canEditPrice && l.price_override != null && l.price_override !== '') {
            const n = Number(l.price_override);
            if (Number.isFinite(n)) item.unit_price = n;
          }
          if (canEditPrice && kind !== 'quote' && Number(l.discount_pct) > 0) item.discount_pct = Number(l.discount_pct);
          return item;
        }),
        notes: notes || null,
        customer_order_no: kind === 'quote' ? undefined : customerOrderNo || null,
        delivery_instructions: kind === 'quote' ? undefined : delivery || null
      });
      setCreatedOrder(result);
      setShowSendModal(true);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (showSummary) return (
    // key forces a remount on entering the review screen - without it, React
    // reuses the same Modal DOM node and the scroll position from the (often
    // long) product list carries over instead of starting at the top.
    <Modal
      key="summary"
      title={`Review ${kind}`}
      onClose={() => setShowSummary(false)}
      wide
      footer={
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setShowSummary(false)} disabled={busy}>Back</button>
          <button className="btn-primary" disabled={busy} onClick={confirmSubmit}>
            {busy ? 'Submitting...' : kind === 'quote' ? 'Create quote' : 'Submit order'}
          </button>
        </div>
      }
    >
      <ErrorNote error={error} />

      <div>
        <OrderSummary
          order={{
            number: '',
            quote_date: new Date().toISOString(),
            order_date: new Date().toISOString(),
            subtotal,
            vat_amount: vat,
            // R1-027: rounded the same way the server rounds the stored total
            // (round2(subtotal + vat)), not a raw sum of two already-rounded
            // numbers - kept explicit so this review screen can never show a
            // total that differs from what actually gets created.
            total: round2(subtotal + vat),
            notes,
            customer_order_no: customerOrderNo || null,
            customer_code: selectedCustomer?.code || ''
          }}
          items={lines.map((l) => {
            const qty = Number(l.qty) || 0;
            // R1-025: the price actually charged (respects an office price
            // override), not just the computed default - and the line total
            // mirrors the server's exact formula, discount included and
            // rounded per line, so this preview is never a cent off.
            const unitPrice = priceForLine(l);
            const discount = kind === 'quote' ? 0 : Number(l.discount_pct) || 0;
            return {
              product_name: l.product.name,
              product_code: l.product.code,
              unit_price: unitPrice,
              kg_price: kgPriceFor(l.product, unitPrice),
              qty,
              uom: l.product.uom,
              discount_pct: discount,
              line_total: round2(qty * unitPrice * (1 - discount / 100))
            };
          })}
          customer={selectedCustomer || { name: 'Customer', contact_name: '', address: '', city: '' }}
          type={kind}
          showSignature={false}
        />
      </div>
    </Modal>
  );

  return (
    <Modal
      key="builder"
      title={kind === 'quote' ? 'New quote' : 'New order'}
      onClose={onClose}
      wide
      footer={custId && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-500">
            Subtotal {fmtR(subtotal)} · VAT {fmtR(vat)} ·
            <span className="ml-1 font-semibold text-slate-800">Total {fmtR(round2(subtotal + vat))}</span>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy || lines.length === 0} onClick={() => setShowSummary(true)}>
              {busy ? 'Loading...' : `Review ${kind}`}
            </button>
          </div>
        </div>
      )}
    >
      <ErrorNote error={error} />
      {!customerId && (
        <div className="mb-4">
          <Field label="Customer">
            <select className="input" value={custId} onChange={(e) => setCustId(e.target.value)}>
              <option value="">Select a customer...</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select>
          </Field>
        </div>
      )}

      {custId && (
        <>
          {selectedCustomer && (
            <div className="mb-4 text-sm text-slate-500">
              Warehouse:{' '}
              {selectedCustomer.warehouse_name
                ? <span className="font-medium text-slate-700">{selectedCustomer.warehouse_name} ({selectedCustomer.warehouse_code})</span>
                : <span className="text-amber-600">Not assigned — set on this customer's SYSPRO record</span>}
            </div>
          )}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <label className="label mb-0">Add products</label>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs font-medium">
                  <button className={`rounded-md px-2.5 py-1 ${filterMode === 'bought' ? 'bg-brand-600 text-white' : 'text-slate-500'}`}
                    onClick={() => setFilterMode('bought')}>Buys ({boughtCount})</button>
                  <button className={`rounded-md px-2.5 py-1 ${filterMode === 'all' ? 'bg-brand-600 text-white' : 'text-slate-500'}`}
                    onClick={() => setFilterMode('all')}>All products</button>
                </div>
                <button type="button" title="Sort by product code, lowest to highest"
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${sortByCode ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-500'}`}
                  onClick={() => setSortByCode((v) => !v)}>
                  Code ↑
                </button>
              </div>
            </div>
            <input className="input" placeholder="Search by name or code..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mt-1 card p-0 max-h-64 overflow-y-auto">
              {filtered.map((p) => (
                <button key={p.id} disabled={!!p.discontinued}
                  title={p.discontinued ? 'Discontinued in SYSPRO — cannot be ordered' : undefined}
                  className={`flex w-full items-center justify-between border-b border-slate-100 px-4 py-2.5 text-left text-sm ${
                    p.discontinued ? 'cursor-not-allowed bg-red-50/50 opacity-60' : 'hover:bg-slate-50'}`}
                  onClick={() => { if (!p.discontinued) addLine(p); }}>
                  <span>
                    <span className={`font-medium ${p.discontinued ? 'text-red-700 line-through' : ''}`}>{p.name}</span>
                    {p.discontinued && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">discontinued</span>}
                    {!p.discontinued && p.times_bought > 0 && <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-600">bought {p.times_bought}x</span>}
                    {/* R1-024: SYSPRO's own selling-unit UOM, shown before the
                        rep picks the product, not only after it's been added. */}
                    <span className="ml-2 text-xs text-slate-400">{p.code} · {p.uom || 'each'} · stock {p.stock_qty}</span>
                  </span>
                  <span className="text-right">
                    <span className="font-medium">
                      {fmtR(p.effective_price)}
                      {p.syspro_pricing_tier === 'syspro_contract' && <span className="ml-1 text-xs text-emerald-600">contract</span>}
                      {p.syspro_pricing_tier === 'syspro_buying_group' && <span className="ml-1 text-xs text-blue-600">buying group</span>}
                      {p.syspro_pricing_tier === 'syspro_price_code' && <span className="ml-1 text-xs text-purple-600">price code</span>}
                      {!p.syspro_pricing_tier && p.has_contract_price === 1 && <span className="ml-1 text-xs text-emerald-600">contract</span>}
                    </span>
                    {kgPriceFor(p, p.effective_price) != null && (
                      <div className="text-xs text-slate-400">{fmtR(kgPriceFor(p, p.effective_price))}/kg</div>
                    )}
                    {/* R1-019/R1-020: G Price alongside the negotiated price, plus the
                        % it's discounted by - shown only where SYSPRO pricing actually
                        applies, so it isn't confused with a RouteOne qty-break saving. */}
                    {p.syspro_pricing_tier && (() => {
                      const g = gPriceFor(p);
                      const pct = discountPctFor(g, p.effective_price);
                      return g > 0 ? (
                        <div className="text-xs text-slate-400">
                          G {fmtR(g)}{pct != null && <span className="ml-1 font-medium text-emerald-600">-{pct}%</span>}
                        </div>
                      ) : null;
                    })()}
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-4 py-3 text-sm text-slate-400">
                  {filterMode === 'bought' ? 'No purchase history — switch to "All products".' : 'No products match.'}
                </div>
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <div className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {lines.map((l) => {
                const qty = Number(l.qty) || 0;
                // R1-025: the price actually charged (respects an office
                // override) - never the raw computed default once one is set.
                const price = priceForLine(l);
                const kgPrice = kgPriceFor(l.product, price);
                const discount = kind === 'quote' ? 0 : Number(l.discount_pct) || 0;
                const lineTotal = round2(qty * price * (1 - discount / 100));
                const isEditingPrice = editingPriceFor === l.product.id;
                return (
                  <div key={l.product.id} className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{l.product.name}</div>
                        <div className="text-xs text-slate-400">
                          {fmtR(price)} / {l.product.uom}
                          {l.price_override != null && l.price_override !== '' && (
                            <span className="ml-1 font-medium text-amber-600">edited</span>
                          )}
                          {discount > 0 && <span className="ml-1 font-medium text-amber-600">-{discount}%</span>}
                          {kgPrice != null && <span className="ml-1">({fmtR(kgPrice)}/kg)</span>}
                          {price < l.product.effective_price && <span className="ml-1 text-emerald-600">qty break</span>}
                          {l.product.syspro_pricing_tier === 'syspro_contract' && <span className="ml-1 text-emerald-600">contract</span>}
                          {l.product.syspro_pricing_tier === 'syspro_buying_group' && <span className="ml-1 text-blue-600">buying group</span>}
                          {l.product.syspro_pricing_tier === 'syspro_price_code' && <span className="ml-1 text-purple-600">price code</span>}
                          {l.product.syspro_pricing_tier && (() => {
                            const g = gPriceFor(l.product);
                            const pct = discountPctFor(g, l.product.effective_price);
                            return g > 0 ? (
                              <span className="ml-1">G {fmtR(g)}{pct != null && <span className="font-medium text-emerald-600"> -{pct}%</span>}</span>
                            ) : null;
                          })()}
                        </div>
                      </div>
                      <input className="input w-20 text-center" type="number" min="0" value={l.qty}
                        onChange={(e) => setQty(l.product.id, e.target.value)} />
                      <div className="w-24 text-right text-sm font-medium">{fmtR(lineTotal)}</div>
                      {canEditPrice && (
                        <button type="button" className="text-slate-300 hover:text-brand-600" title="Edit price"
                          onClick={() => setEditingPriceFor(isEditingPrice ? null : l.product.id)}>edit</button>
                      )}
                      <button className="text-slate-300 hover:text-red-500"
                        onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))}>x</button>
                    </div>
                    {isEditingPrice && (
                      <div className="mt-2 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-2">
                        <Field label="Unit price">
                          <input className="input w-28" type="number" min="0" step="0.01"
                            placeholder={fmtR(unitPriceFor(l.product, qty))}
                            value={l.price_override ?? ''}
                            onChange={(e) => updateLine(l.product.id, { price_override: e.target.value })} />
                        </Field>
                        {kind !== 'quote' && (
                          <Field label="Discount %">
                            <input className="input w-20" type="number" min="0" max="100" step="1"
                              value={l.discount_pct || ''}
                              onChange={(e) => updateLine(l.product.id, { discount_pct: e.target.value })} />
                          </Field>
                        )}
                        {(l.price_override != null && l.price_override !== '') && (
                          <button type="button" className="text-xs text-slate-400 underline"
                            onClick={() => updateLine(l.product.id, { price_override: null })}>
                            Reset to {fmtR(unitPriceFor(l.product, qty))}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {kind !== 'quote' && (
            <Field label="Customer Order No. / Reference">
              <input className="input" value={customerOrderNo} maxLength={100}
                placeholder="Their PO or reference number"
                onChange={(e) => setCustomerOrderNo(e.target.value)} />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={kind === 'quote' ? 'Quote notes' : 'Order notes'}>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {kind !== 'quote' && (
              <Field label="Delivery instructions"><input className="input" value={delivery} onChange={(e) => setDelivery(e.target.value)} /></Field>
            )}
          </div>
        </>
      )}

      {showSendModal && createdOrder && (
        <OrderSendModal
          order={createdOrder}
          kind={kind}
          onClose={() => {
            setShowSendModal(false);
            setCreatedOrder(null);
            onSaved(); // Close the entire modal after sending
          }}
          onSent={() => {
            setShowSendModal(false);
            setCreatedOrder(null);
            onSaved(); // Close the entire modal after sending
          }}
        />
      )}
    </Modal>
  );
}
