import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Spinner, ErrorNote, Badge, Modal, Field } from '../components/ui';
import { MobileHeader } from './MobileApp';
import SupportTicketModal, { CATEGORIES } from '../components/SupportTicketModal';

const FILTERS = ['open', 'in_progress', 'resolved'];
const FILTER_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const STATUS_COLORS = { open: '#0ea5e9', in_progress: '#f59e0b', resolved: '#16a34a' };
const categoryLabel = (v) => CATEGORIES.find((c) => c.value === v)?.label || v;

export default function Support() {
  const [tickets, setTickets] = useState(null);
  const [filter, setFilter] = useState('open');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = () => api.get(`/support-tickets?status=${filter}`).then(setTickets).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [filter]);

  return (
    <>
      <MobileHeader title="Support Tickets" />
      <div className="space-y-4 p-4">
        <ErrorNote error={error} />

        <div className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap ${
                filter === f ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}>
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        <button onClick={() => setShowCreate(true)} className="btn-primary w-full">+ Log a Support Ticket</button>

        {!tickets ? <Spinner /> : tickets.length === 0 ? (
          <div className="card p-6 text-center text-sm text-slate-400">No {FILTER_LABELS[filter].toLowerCase()} tickets.</div>
        ) : (
          <div className="space-y-2">
            {tickets.map((t) => (
              <button key={t.id} onClick={() => setSelected(t)} className="card block w-full p-3 text-left">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{t.subject}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{categoryLabel(t.category)}{t.customer_name ? ` · ${t.customer_name}` : ''}</div>
                    <div className="text-xs text-slate-400 mt-1">{fmtDateTime(t.created_at)}</div>
                  </div>
                  <Badge color={STATUS_COLORS[t.status]}>{FILTER_LABELS[t.status]}</Badge>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <SupportTicketModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      )}

      {selected && <TicketDetailSheet ticket={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function TicketDetailSheet({ ticket, onClose }) {
  return (
    <Modal title={ticket.subject} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>{categoryLabel(ticket.category)}</span>
          <span>Priority: <b className="text-slate-700">{ticket.priority}</b></span>
          <span>{fmtDateTime(ticket.created_at)}</span>
          {ticket.customer_name && <span>Customer: <b className="text-slate-700">{ticket.customer_name}</b></span>}
        </div>
        <Field label="Description">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap">{ticket.description}</div>
        </Field>
        {ticket.admin_notes && (
          <Field label="Notes from support">
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap">{ticket.admin_notes}</div>
          </Field>
        )}
        <div className="flex justify-between items-center border-t border-slate-100 pt-4">
          <Badge color={STATUS_COLORS[ticket.status]}>{FILTER_LABELS[ticket.status]}</Badge>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
