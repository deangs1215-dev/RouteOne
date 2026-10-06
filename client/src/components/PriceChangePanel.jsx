// "SYSPRO prices have changed" - shown when the server stops an order at submit
// because a line's live SYSPRO price differs from the price that was quoted
// (see the live check in server/routes/orders.routes.js). The change list is
// the server's `changes` array: { product_id, product_code, product_name, qty,
// quoted_price, current_price, source }. Nothing is submitted until the person
// explicitly accepts the new prices.
import { fmtR } from '../api';

const SOURCE_LABELS = {
  contract: 'Contract price', buying_group: 'Buying group price', price_code: 'Price code',
  customer_price: 'Customer price', qty_break: 'Quantity break', g_price: 'G price'
};

// Ex-VAT effect of accepting every change, so the person sees what the total moves by.
export function priceChangeImpact(changes) {
  return Math.round(changes.reduce((sum, c) => sum + c.qty * (c.current_price - c.quoted_price), 0) * 100) / 100;
}

export default function PriceChangePanel({ changes, onAccept, onBack, acceptLabel = 'Accept new prices', backLabel = 'Go back', busy = false, children }) {
  const impact = priceChangeImpact(changes);
  return (
    <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
      <div className="font-bold">SYSPRO prices have changed</div>
      <p className="mt-1">
        {changes.length === 1 ? 'This line is' : `${changes.length} lines are`} priced differently in SYSPRO than the price shown.
        Nothing has been submitted yet.
      </p>
      <ul className="mt-3 space-y-2">
        {changes.map((c) => (
          <li key={c.product_id} className="rounded-lg bg-white/70 p-2">
            <div className="font-medium">{c.product_name} <span className="text-xs text-slate-500">{c.product_code} · qty {c.qty}</span></div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <span className="text-slate-500 line-through">{fmtR(c.quoted_price)}</span>
              <span aria-hidden>→</span>
              <span className="font-bold">{fmtR(c.current_price)}</span>
              <span className="text-xs text-slate-500">each · {SOURCE_LABELS[c.source] || c.source}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 font-semibold">
        {impact === 0 ? 'No change to the total.' : `Total ${impact > 0 ? 'increases' : 'decreases'} by ${fmtR(Math.abs(impact))} (excl. VAT).`}
      </div>
      {children}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={onAccept} disabled={busy}>{acceptLabel}</button>
        {onBack && <button type="button" className="btn-secondary" onClick={onBack} disabled={busy}>{backLabel}</button>}
      </div>
    </div>
  );
}
