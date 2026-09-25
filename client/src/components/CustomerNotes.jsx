// Customer contact log - a rep records a call/email/WhatsApp/meeting without
// checking in or being on site. Shared by the office customer page and the
// mobile rep screen so both render the same history and the same entry form.
//
// These are NOT visits: logging contact here never affects a rep's visit
// compliance, coverage or strike rate (see customer_notes in schema.sql).
import { useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Card, EmptyState, ErrorNote } from './ui';
import { queueWrite } from '../offline';

// Keep in step with NOTE_TYPES in server/routes/customers.routes.js - the server
// falls back to 'note' for anything it doesn't recognise.
export const NOTE_TYPES = [
  { value: 'call', label: 'Phone call', icon: '📞' },
  { value: 'email', label: 'Email', icon: '✉️' },
  { value: 'whatsapp', label: 'WhatsApp', icon: '💬' },
  { value: 'meeting', label: 'Meeting', icon: '🤝' },
  { value: 'sample', label: 'Sample drop', icon: '📦' },
  { value: 'note', label: 'General note', icon: '📝' }
];

const typeMeta = (value) => NOTE_TYPES.find((t) => t.value === value) || NOTE_TYPES[NOTE_TYPES.length - 1];

export default function CustomerNotes({ customerId, notes = [], currentUserId, canDelete = false, onChanged, compact = false }) {
  const [open, setOpen] = useState(false);
  const [noteType, setNoteType] = useState('call');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const note = text.trim();
    if (!note || saving) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/customers/${customerId}/notes`, { note_type: noteType, note });
      setText('');
      setOpen(false);
      onChanged?.();
    } catch (err) {
      // Reps log notes in the field, often with no signal. Queue the write so
      // it lands when connectivity returns rather than losing what they typed.
      if (!navigator.onLine) {
        queueWrite('POST', `/customers/${customerId}/notes`, { note_type: noteType, note });
        setText('');
        setOpen(false);
        onChanged?.();
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    try {
      await api.del(`/customer-notes/${id}`);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const body = (
    <>
      {!open && (
        <button className="btn-secondary w-full text-sm" onClick={() => setOpen(true)}>
          + Log a call, email or note
        </button>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {NOTE_TYPES.map((t) => (
              <button key={t.value} type="button"
                onClick={() => setNoteType(t.value)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                  noteType === t.value ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <textarea className="input min-h-[80px]" autoFocus maxLength={4000}
            placeholder="What happened? e.g. Phoned about the outstanding quote — will confirm Friday."
            value={text} onChange={(e) => setText(e.target.value)} />
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary"
              onClick={() => { setOpen(false); setText(''); setError(''); }}>Cancel</button>
            <button className="btn-primary" disabled={!text.trim() || saving}>
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </form>
      )}

      {notes.length === 0 ? (
        !open && <EmptyState icon="📝">No calls or notes logged yet.</EmptyState>
      ) : (
        <div className={open ? 'mt-3 space-y-2' : 'space-y-2'}>
          {notes.map((n) => {
            const meta = typeMeta(n.note_type);
            return (
              <div key={n.id} className="rounded-lg border border-slate-200 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{meta.icon} {meta.label}</span>
                    <span className="ml-2 text-xs text-slate-400">
                      {n.rep_name} · {fmtDateTime(n.created_at)}
                    </span>
                  </div>
                  {(canDelete || n.user_id === currentUserId) && (
                    <button onClick={() => remove(n.id)}
                      title="Delete note"
                      className="shrink-0 text-xs text-slate-400 hover:text-red-600">✕</button>
                  )}
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{n.note}</div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  // compact = embedded in the mobile rep screen, which supplies its own section
  // heading; the office page wants a full Card around it.
  return compact ? <div className="space-y-2">{body}</div> : <Card title="Notes & activity">{body}</Card>;
}
