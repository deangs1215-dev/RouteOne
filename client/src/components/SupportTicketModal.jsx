// Shared "log a support ticket" form, used from both the desktop Support
// Tickets page and the mobile Support screen.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Modal, Field, ErrorNote } from './ui';

export const CATEGORIES = [
  { value: 'system_issue', label: 'System / App Issue' },
  { value: 'product_question', label: 'Product Question' },
  { value: 'pricing', label: 'Pricing Question' },
  { value: 'order_problem', label: 'Order Problem' },
  { value: 'customer_issue', label: 'Customer Issue' },
  { value: 'other', label: 'Other' }
];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export default function SupportTicketModal({ onClose, onCreated }) {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [priority, setPriority] = useState('normal');
  const [customers, setCustomers] = useState([]);
  const [selectedCustId, setSelectedCustId] = useState('');
  const [searchCust, setSearchCust] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/customers').then(setCustomers).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    const s = searchCust.toLowerCase();
    if (!s) return [];
    return customers.filter((c) => c.name.toLowerCase().includes(s) || c.code.toLowerCase().includes(s)).slice(0, 15);
  }, [customers, searchCust]);

  const submit = async () => {
    setError('');
    if (!subject.trim()) return setError('Subject is required');
    if (!description.trim()) return setError('Description is required');

    setBusy(true);
    try {
      await api.post('/support-tickets', {
        subject: subject.trim(),
        description: description.trim(),
        category,
        priority,
        customer_id: selectedCustId ? Number(selectedCustId) : null
      });
      onCreated();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Log a Support Ticket" onClose={onClose} wide>
      <ErrorNote error={error} />
      <div className="space-y-4">
        <Field label="Subject *">
          <input
            type="text"
            className="input"
            placeholder="Short summary of the issue"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>

        <Field label="Description *">
          <textarea
            className="input"
            rows="4"
            placeholder="What's happening? Include steps to reproduce if it's a system issue."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Related customer (optional)">
          {selectedCustId ? (
            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 text-sm font-medium text-slate-700">
              <span>{customers.find((c) => c.id === Number(selectedCustId))?.name}</span>
              <button type="button" onClick={() => { setSelectedCustId(''); setSearchCust(''); }} className="text-xs text-slate-400 hover:text-slate-600">
                Change
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                type="text"
                className="input"
                placeholder="Search by name or code..."
                value={searchCust}
                onChange={(e) => setSearchCust(e.target.value)}
              />
              {searchCust && filtered.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg z-10 max-h-48 overflow-y-auto">
                  {filtered.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setSelectedCustId(c.id); setSearchCust(''); }}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
                    >
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-slate-400">{c.code}</div>
                    </button>
                  ))}
                </div>
              )}
              {searchCust && filtered.length === 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg z-10 px-3 py-2 text-sm text-slate-400">
                  No customers found
                </div>
              )}
            </div>
          )}
        </Field>

        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary flex-1" onClick={submit} disabled={busy}>
            {busy ? 'Submitting...' : 'Submit Ticket'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
