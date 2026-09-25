// Modal for sending orders/quotes to configured email recipients.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal, ErrorNote, Spinner } from './ui';

export default function OrderSendModal({ order, kind = 'order', warehouseId, onClose, onSent }) {
  const [recipients, setRecipients] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sendToRep, setSendToRep] = useState(false);
  const [sendToCustomer, setSendToCustomer] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Only the 'orders' list (this was previously fetching every category,
    // Technical included, and offering those as order-send checkboxes too),
    // and only recipients set up for this order/quote's own branch.
    const wid = warehouseId ?? order.warehouse_id;
    api.get(`/email-recipients?category=orders${wid ? `&warehouse_id=${wid}` : ''}`).then((rows) => {
      setRecipients(rows);
      // Pre-select all by default
      setSelectedIds(new Set(rows.map(r => r.id)));
    }).catch(console.error);
  }, [warehouseId, order.warehouse_id]);

  const handleRecipientChange = (id) => {
    const newIds = new Set(selectedIds);
    if (newIds.has(id)) {
      newIds.delete(id);
    } else {
      newIds.add(id);
    }
    setSelectedIds(newIds);
  };

  const handleSelectAll = (e) => {
    if (e.target.checked) {
      setSelectedIds(new Set(recipients.map(r => r.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const submit = async () => {
    setError('');
    const selectedRecipients = Array.from(selectedIds);

    // At least one recipient or option must be selected
    if (selectedRecipients.length === 0 && !sendToRep && !sendToCustomer) {
      return setError('Select at least one recipient or option');
    }

    setBusy(true);
    try {
      await api.post(`/${kind === 'quote' ? 'quotes' : 'orders'}/${order.id}/send-email`, {
        recipients: selectedRecipients,
        send_to_rep: sendToRep,
        send_to_customer: sendToCustomer
      });
      onSent?.();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (!recipients) return <Modal title={`Send ${kind}`} onClose={onClose} wide><Spinner /></Modal>;

  return (
    <Modal title={`Send ${kind}`} onClose={onClose} wide>
      <ErrorNote error={error} />

      <div className="space-y-4">
        <div>
          <p className="text-sm text-slate-500 mb-3">
            Send this {kind} to the following recipients:
          </p>

          <div className="space-y-2 border border-slate-200 rounded-lg p-4">
            {/* Recipient list */}
            {recipients.length > 0 && (
              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === recipients.length && recipients.length > 0}
                    onChange={handleSelectAll}
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium text-slate-700">Select all recipients</span>
                </label>
                <div className="pl-6 space-y-2 border-t border-slate-100 pt-2">
                  {recipients.map((r) => (
                    <label key={r.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(r.id)}
                        onChange={() => handleRecipientChange(r.id)}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-slate-700">{r.name}</span>
                      <span className="text-xs text-slate-400">{r.email}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {recipients.length === 0 && (
              <div className="text-sm text-slate-500">No configured recipients. Set them up in Settings.</div>
            )}
          </div>
        </div>

        {/* Additional recipients */}
        <div className="border-t border-slate-100 pt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Additional recipients:</p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sendToRep}
              onChange={(e) => setSendToRep(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-slate-700">Send copy to rep</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sendToCustomer}
              onChange={(e) => setSendToCustomer(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-slate-700">Send copy to customer</span>
          </label>
        </div>

        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary flex-1" onClick={submit} disabled={busy}>
            {busy ? 'Sending...' : `Send ${kind}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
