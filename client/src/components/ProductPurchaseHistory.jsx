// R1-053: expandable per-product purchase history, shown on the Order/Quote
// capture screens (mobile RepOrderCapture.jsx, desktop NewOrderModal.jsx).
// Lazy-loaded by the parent - only rendered once a rep actually expands a
// product line, so the main product list stays fast with nothing prefetched.
import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, fmtDate } from '../api';

export default function ProductPurchaseHistory({ productId, customerId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api.get(`/products/${productId}/purchase-history?customer_id=${customerId}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [productId, customerId]);

  if (error) return <div className="rounded-lg bg-red-50 p-3 text-xs text-red-600">{error}</div>;
  if (!data) return <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-400">Loading history…</div>;

  if (data.purchase_count === 0) {
    return (
      <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-400">
        No SYSPRO invoices for this product in the last 30 days.
      </div>
    );
  }

  // Chart reads oldest-to-newest left-to-right; the list below stays
  // newest-first (matches how every other list/table in the app orders dates).
  const chartData = [...data.purchases].reverse();

  return (
    <div className="space-y-2.5 rounded-lg bg-slate-50 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-semibold uppercase tracking-wide text-slate-400">Purchase history · last 30 days</span>
        <div className="flex flex-wrap gap-x-3 text-slate-600">
          <span>Last bought <b className="text-slate-800">{fmtDate(data.last_invoice_date)}</b></span>
          <span>{data.purchase_count} purchase{data.purchase_count === 1 ? '' : 's'}</span>
          <span>{data.total_qty} units total</span>
        </div>
      </div>

      {chartData.length > 1 && (
        <div style={{ height: 90 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
              <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} allowDecimals={false} axisLine={false} tickLine={false} width={28} />
              <Tooltip
                formatter={(value) => [`${value} units`, 'Qty']}
                labelFormatter={(d) => fmtDate(d)}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Bar dataKey="qty" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Quantity only, not value - a rep checking history isn't shown pricing here. */}
      <div className="divide-y divide-slate-200 border-t border-slate-200">
        {data.purchases.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-2 py-1.5">
            <span className="text-slate-500">{fmtDate(p.date)}</span>
            <span className="font-medium text-slate-700">{p.qty} units</span>
          </div>
        ))}
      </div>
    </div>
  );
}
