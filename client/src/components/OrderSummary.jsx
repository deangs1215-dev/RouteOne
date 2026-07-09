import { useState } from 'react';
import { fmtR, fmtDate } from '../api';
import SignatureCapture from './SignatureCapture';

export default function OrderSummary({ order, items, customer, type = 'order', showSignature = false, onSignatureSave }) {
  const [capturingSignature, setCapturingSignature] = useState(false);
  const [signature, setSignature] = useState(null);

  const handleSignatureSave = (dataUrl) => {
    setSignature(dataUrl);
    setCapturingSignature(false);
    if (onSignatureSave) onSignatureSave(dataUrl);
  };

  const title = type === 'quote' ? 'QUOTATION' : 'ORDER CONFIRMATION';
  const dateLabel = type === 'quote' ? 'Date' : 'Placed';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b-2 border-brand-600 pb-4">
        <h1 className="text-3xl font-bold text-navy-900">{title}</h1>
      </div>

      {/* Meta info and Bill To */}
      <div className="grid grid-cols-2 gap-8">
        <div className="space-y-2">
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">{type === 'quote' ? 'Quotation No' : 'Order No'}</span>
            <div className="text-lg font-bold text-slate-800">{order.number}</div>
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase">{dateLabel}</span>
            <div className="text-sm text-slate-700">{fmtDate(order.quote_date || order.order_date)}</div>
          </div>
          {order.customer_code && (
            <div>
              <span className="text-xs font-semibold text-slate-500 uppercase">Account</span>
              <div className="text-sm text-slate-700">{order.customer_code}</div>
            </div>
          )}
        </div>

        <div className="text-right">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-2">TO</div>
          <div className="text-lg font-bold text-slate-800">{customer?.name}</div>
          {customer?.contact_name && <div className="text-sm text-slate-600">{customer.contact_name}</div>}
          {customer?.address && <div className="text-sm text-slate-600">{customer.address}</div>}
          {customer?.city && <div className="text-sm text-slate-600">{customer.city}</div>}
        </div>
      </div>

      {/* Line items table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-navy-900 text-white">
              <th className="px-4 py-3 text-left font-bold">Product</th>
              <th className="px-4 py-3 text-right font-bold">Unit</th>
              <th className="px-4 py-3 text-right font-bold">Qty</th>
              <th className="px-4 py-3 text-right font-bold">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className="border-b last:border-b-0 hover:bg-slate-50">
                <td className="px-4 py-3 text-slate-800">
                  <div className="font-medium">{item.product_name}</div>
                  <div className="text-xs text-slate-500">{item.product_code}</div>
                </td>
                <td className="px-4 py-3 text-right text-slate-700">{fmtR(item.unit_price)}</td>
                <td className="px-4 py-3 text-right font-medium text-slate-700">
                  {item.qty} {item.uom}
                </td>
                <td className="px-4 py-3 text-right font-bold text-slate-800">{fmtR(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals */}
      <div className="space-y-2 ml-auto w-64">
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">Subtotal</span>
          <span className="font-medium text-slate-800">{fmtR(order.subtotal)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">VAT (15%)</span>
          <span className="font-medium text-slate-800">{fmtR(order.vat_amount)}</span>
        </div>
        <div className="flex justify-between bg-brand-600 text-white px-4 py-3 rounded font-bold text-lg">
          <span>Total</span>
          <span>{fmtR(order.total)}</span>
        </div>
      </div>

      {/* Notes */}
      {order.notes && (
        <div className="p-4 bg-slate-50 rounded border border-slate-200">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-2">Notes</div>
          <div className="text-sm text-slate-700">{order.notes}</div>
        </div>
      )}

      {/* Signature section */}
      {showSignature && (
        <div className="border-t pt-6">
          {capturingSignature ? (
            <SignatureCapture
              onSave={handleSignatureSave}
              onCancel={() => setCapturingSignature(false)}
              label="Customer signature"
            />
          ) : signature ? (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-slate-700">Signature</div>
              <img src={signature} alt="Customer signature" className="h-20 border border-slate-300 rounded" />
              <button
                onClick={() => setCapturingSignature(true)}
                className="text-sm text-brand-600 hover:underline"
              >
                Retake signature
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCapturingSignature(true)}
              className="btn-primary w-full py-3"
            >
              ✋ Add signature
            </button>
          )}
        </div>
      )}
    </div>
  );
}
