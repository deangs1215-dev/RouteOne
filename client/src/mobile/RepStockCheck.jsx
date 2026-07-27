// Quick stock lookup for a rep on the road - search by product code or name,
// shows only their own depot's stock (not the company-wide total), since
// that's what's actually available to sell right now.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { MobileHeader } from './MobileApp';

export default function RepStockCheck() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!q.trim()) { setRows(null); return; }
    const handle = setTimeout(() => {
      api.get(`/products/depot-stock?q=${encodeURIComponent(q)}`).then(setRows).catch((e) => setError(e.message));
    }, 250); // debounce so every keystroke doesn't fire a request
    return () => clearTimeout(handle);
  }, [q]);

  return (
    <>
      <MobileHeader title="Stock check" />
      <div className="space-y-3 p-4 pb-20">
        <input className="input" placeholder="Search by product code or name…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {error && <div className="text-sm text-red-600">{error}</div>}

        {!q.trim() && <div className="pt-6 text-center text-sm text-slate-400">Start typing a product code or name.</div>}

        {rows && (
          <div className="space-y-2">
            {rows.map((p) => (
              <div key={p.id} className="card flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-slate-400">{p.code}{p.pack_size ? ` · ${p.pack_size}` : ''}</div>
                </div>
                {p.stock_qty == null ? (
                  <span className="shrink-0 text-xs text-amber-600">No depot assigned</span>
                ) : p.stock_qty <= 0 ? (
                  <span className="shrink-0 rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-600">Out of stock</span>
                ) : (
                  <span className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${p.stock_qty < 20 ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>
                    {p.stock_qty} {p.uom}
                  </span>
                )}
              </div>
            ))}
            {rows.length === 0 && <div className="pt-6 text-center text-sm text-slate-400">No products match "{q}".</div>}
          </div>
        )}
      </div>
    </>
  );
}
