// Visit activity summary: shows orders, quotes, forms, and photos from a visit
import { useEffect, useState } from 'react';
import { api, fmtR, fmtDateTime } from '../api';
import { Spinner, Badge } from './ui';

export default function VisitSummary({ visitId }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visitId) return;
    api.get(`/visits/${visitId}/summary`).then(setSummary).catch((e) => setError(e.message));
  }, [visitId]);

  if (!visitId) return null;
  if (!summary) return <div className="card p-4"><Spinner /></div>;
  if (error) return <div className="card p-4 text-red-600 text-sm">{error}</div>;

  const { visit, orders = [], quotes = [], forms = [], photo_count = 0 } = summary;

  const hasActivity = orders.length > 0 || quotes.length > 0 || forms.length > 0 || photo_count > 0;

  if (!hasActivity) {
    return (
      <div className="card p-4 text-center text-slate-400 text-sm">
        No orders, quotes, or forms recorded for this visit.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Orders */}
      {orders.length > 0 && (
        <div className="card p-4">
          <div className="font-semibold text-slate-800 mb-2">📋 Orders</div>
          <div className="space-y-1">
            {orders.map((o) => (
              <div key={o.id} className="flex justify-between text-sm">
                <span className="font-medium">{o.number}</span>
                <span>{fmtR(o.total)}</span>
                <Badge color={o.status === 'completed' ? '#16a34a' : o.status === 'cancelled' ? '#ef4444' : '#0ea5e9'}>
                  {o.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quotes */}
      {quotes.length > 0 && (
        <div className="card p-4">
          <div className="font-semibold text-slate-800 mb-2">💬 Quotes</div>
          <div className="space-y-1">
            {quotes.map((q) => (
              <div key={q.id} className="flex justify-between text-sm">
                <span className="font-medium">{q.number}</span>
                <span>{fmtR(q.total)}</span>
                <Badge color={q.status === 'accepted' ? '#16a34a' : q.status === 'rejected' ? '#ef4444' : '#8b5cf6'}>
                  {q.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Forms */}
      {forms.length > 0 && (
        <div className="card p-4">
          <div className="font-semibold text-slate-800 mb-2">📝 Forms</div>
          <div className="space-y-1">
            {forms.map((f) => (
              <div key={f.id} className="flex justify-between text-sm">
                <span>{f.template_name}</span>
                <Badge color="#a78bfa">{f.count} submitted</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Photos */}
      {photo_count > 0 && (
        <div className="card p-4">
          <div className="font-semibold text-slate-800">📸 Photos</div>
          <div className="text-sm text-slate-600">{photo_count} photo{photo_count !== 1 ? 's' : ''} attached</div>
        </div>
      )}
    </div>
  );
}
