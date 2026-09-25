// Sales push notifications: admin/manager broadcasts "push this product" to
// every rep. Shown highlighted (red/bold) at the top of the Selling tips card
// on every customer a rep opens - see RepCustomer.jsx and CustomerDetail.jsx.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, ErrorNote, Spinner } from '../components/ui';

function timeAgo(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SalesPush() {
  const [pushes, setPushes] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/sales-pushes').then(setPushes).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/sales-pushes', { message: trimmed });
      setMessage('');
      load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const toggle = async (p) => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/sales-pushes/${p.id}`, { active: p.active ? 0 : 1 });
      load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const remove = async (p) => {
    if (!confirm('Delete this push? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    try {
      await api.del(`/sales-pushes/${p.id}`);
      load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const active = pushes?.filter((p) => p.active) ?? null;
  const inactive = pushes?.filter((p) => !p.active) ?? null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Sales Push</h1>
      <p className="text-sm text-slate-500">
        Broadcast a product or deal for every rep to push this week. It shows up highlighted
        at the top of the Selling tips card on every customer they open, until you turn it off.
      </p>

      <ErrorNote error={error} />

      <Card title="New push">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <textarea
            className="input flex-1"
            rows="2"
            maxLength={500}
            placeholder="e.g. Push 20% off FLOUR this week — limited stock"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button className="btn-primary shrink-0" onClick={create} disabled={busy || !message.trim()}>
            {busy ? 'Sending…' : 'Send to reps'}
          </button>
        </div>
      </Card>

      <Card title={`Active (${active?.length ?? '…'})`}>
        {!active ? (
          <Spinner />
        ) : active.length === 0 ? (
          <p className="text-sm text-slate-400">No active pushes — reps see the normal Selling tips only.</p>
        ) : (
          <div className="space-y-2">
            {active.map((p) => (
              <div key={p.id} className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3">
                <div>
                  <div className="text-sm font-semibold text-red-800">{p.message}</div>
                  <div className="mt-1 text-xs text-red-600">
                    {p.created_by_name || 'Unknown'} · {timeAgo(p.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn-secondary text-xs" onClick={() => toggle(p)} disabled={busy}>Turn off</button>
                  <button className="text-xs text-red-600 hover:underline" onClick={() => remove(p)} disabled={busy}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {inactive && inactive.length > 0 && (
        <Card title={`Past (${inactive.length})`}>
          <div className="space-y-2">
            {inactive.map((p) => (
              <div key={p.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 p-3">
                <div>
                  <div className="text-sm text-slate-500 line-through">{p.message}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {p.created_by_name || 'Unknown'} · {timeAgo(p.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn-secondary text-xs" onClick={() => toggle(p)} disabled={busy}>Turn on</button>
                  <button className="text-xs text-red-600 hover:underline" onClick={() => remove(p)} disabled={busy}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
