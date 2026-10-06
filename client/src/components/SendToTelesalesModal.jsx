// "Send to telesales" for an order that was not emailed at capture time, e.g. a
// quote converted to an order. Sends the same internal order email a rep's capture
// screen sends. Recipients: the branch's configured telesales addresses, the rep's
// own saved contacts, and/or one typed address. Nothing is ticked by default.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal, ErrorNote, Spinner } from './ui';

export default function SendToTelesalesModal({ order, onClose, onSent }) {
  const [recipients, setRecipients] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [pickedContacts, setPickedContacts] = useState(new Set());
  const [extra, setExtra] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/settings/order-email-info?warehouse_id=${order.warehouse_id || ''}`)
      .then((r) => setRecipients(r.recipients || []))
      .catch((e) => { setRecipients([]); setError(e.message); });
    api.get('/my-email-contacts').then(setContacts).catch(() => {});
  }, [order.warehouse_id]);

  const toggle = (set, setSet, id) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    setSet(next);
  };

  const send = async () => {
    setError('');
    if (picked.size === 0 && pickedContacts.size === 0 && !extra.trim()) {
      return setError('Choose at least one recipient or type an email address.');
    }
    setBusy(true);
    try {
      const r = await api.post(`/orders/${order.id}/email-telesales`, {
        recipient_ids: [...picked],
        personal_recipient_ids: [...pickedContacts],
        extra_email: extra.trim() || undefined
      });
      onSent?.(r);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Send ${order.number} to telesales`} onClose={onClose}>
      <ErrorNote error={error} />
      {!recipients ? <Spinner /> : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Sends the order, with the customer details and notes, so it can be captured in SYSPRO.
          </p>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase text-slate-400">Telesales</div>
            {recipients.length === 0 ? (
              <div className="text-sm text-slate-500">No telesales addresses are set up for this branch. Type one below.</div>
            ) : (
              <div className="space-y-1.5">
                {recipients.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={picked.has(r.id)} onChange={() => toggle(picked, setPicked, r.id)} />
                    <span>{r.name}</span>
                    <span className="text-xs text-slate-400">{r.email}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {contacts.length > 0 && (
            <div className="border-t border-slate-100 pt-3">
              <div className="mb-1.5 text-xs font-semibold uppercase text-slate-400">My contacts</div>
              <div className="space-y-1.5">
                {contacts.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={pickedContacts.has(c.id)} onChange={() => toggle(pickedContacts, setPickedContacts, c.id)} />
                    <span>{c.name}</span>
                    <span className="text-xs text-slate-400">{c.email}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-slate-100 pt-3">
            <label className="label">Or type an email address</label>
            <input className="input" type="email" placeholder="name@example.com" value={extra} onChange={(e) => setExtra(e.target.value)} />
          </div>

          <div className="flex gap-2 border-t border-slate-100 pt-4">
            <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary flex-1" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
