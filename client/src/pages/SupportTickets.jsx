import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Spinner, ErrorNote, Badge, Modal, Field } from '../components/ui';
import { useAuth } from '../auth';
import SupportTicketModal, { CATEGORIES, PRIORITIES } from '../components/SupportTicketModal';

const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const STATUS_COLORS = { open: '#0ea5e9', in_progress: '#f59e0b', resolved: '#16a34a' };
const PRIORITY_COLORS = { low: '#64748b', normal: '#0ea5e9', high: '#f97316', urgent: '#dc2626' };
const categoryLabel = (v) => CATEGORIES.find((c) => c.value === v)?.label || v;

export default function SupportTickets() {
  const { user } = useAuth();
  const isTriage = user.role === 'admin';
  const [tickets, setTickets] = useState(null);
  const [status, setStatus] = useState('open');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = () => api.get(`/support-tickets?status=${status}`).then(setTickets).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Support Tickets</h1>
          <p className="text-sm text-slate-600">
            {isTriage ? 'Review and resolve issues logged by the team' : 'Issues you\'ve logged and their status'}
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Log a Support Ticket</button>
      </div>

      <div className="space-y-4">
        <ErrorNote error={error} />

        <div className="card p-4">
          <label className="block text-xs font-semibold text-slate-600 mb-1">Status</label>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>

        {!tickets ? (
          <Spinner />
        ) : tickets.length === 0 ? (
          <div className="card p-6 text-center text-sm text-slate-400">No tickets match this filter.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Subject</th>
                  <th className="px-4 py-3 text-left font-semibold">Category</th>
                  <th className="px-4 py-3 text-left font-semibold">Priority</th>
                  {isTriage && <th className="px-4 py-3 text-left font-semibold">Logged by</th>}
                  <th className="px-4 py-3 text-left font-semibold">Customer</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                  <th className="px-4 py-3 text-left font-semibold">Logged</th>
                  <th className="px-4 py-3 text-left font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {tickets.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{t.subject}</td>
                    <td className="px-4 py-3 text-xs">{categoryLabel(t.category)}</td>
                    <td className="px-4 py-3"><Badge color={PRIORITY_COLORS[t.priority]}>{t.priority}</Badge></td>
                    {isTriage && <td className="px-4 py-3 text-xs">{t.created_by_name}</td>}
                    <td className="px-4 py-3 text-xs">{t.customer_name || '—'}</td>
                    <td className="px-4 py-3"><Badge color={STATUS_COLORS[t.status]}>{STATUS_LABELS[t.status]}</Badge></td>
                    <td className="px-4 py-3 text-xs text-slate-500">{fmtDateTime(t.created_at)}</td>
                    <td className="px-4 py-3">
                      <button className="text-xs text-brand-600 hover:text-brand-700 font-medium" onClick={() => setSelected(t)}>
                        {isTriage ? 'View / Update' : 'View'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <SupportTicketModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      )}

      {selected && (
        <TicketDetailModal
          ticket={selected}
          canTriage={isTriage}
          onClose={() => setSelected(null)}
          onSaved={() => { setSelected(null); load(); }}
        />
      )}
    </>
  );
}

function TicketDetailModal({ ticket, canTriage, onClose, onSaved }) {
  const [status, setStatus] = useState(ticket.status);
  const [notes, setNotes] = useState(ticket.admin_notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/support-tickets/${ticket.id}`, { status, admin_notes: notes || null });
      onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={ticket.subject} onClose={onClose} wide>
      <ErrorNote error={error} />
      <div className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
          <span>Logged by <b className="text-slate-700">{ticket.created_by_name}</b></span>
          <span>{categoryLabel(ticket.category)}</span>
          <span>Priority: <b className="text-slate-700">{ticket.priority}</b></span>
          <span>{fmtDateTime(ticket.created_at)}</span>
          {ticket.customer_name && <span>Customer: <b className="text-slate-700">{ticket.customer_name}</b></span>}
          {ticket.order_number && <span>Order: <b className="text-slate-700">{ticket.order_number}</b></span>}
        </div>

        <Field label="Description">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap">{ticket.description}</div>
        </Field>

        {canTriage ? (
          <>
            <Field label="Status">
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="resolved">Resolved</option>
              </select>
            </Field>
            <Field label="Notes for the rep (optional)">
              <textarea className="input" rows="3" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did you find / do?" />
            </Field>
            <div className="flex gap-2 border-t border-slate-100 pt-4">
              <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Close</button>
              <button className="btn-primary flex-1" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
            </div>
          </>
        ) : (
          <>
            {ticket.admin_notes && (
              <Field label="Notes from support">
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap">{ticket.admin_notes}</div>
              </Field>
            )}
            <div className="flex justify-between items-center border-t border-slate-100 pt-4">
              <Badge color={STATUS_COLORS[ticket.status]}>{STATUS_LABELS[ticket.status]}</Badge>
              <button className="btn-secondary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
