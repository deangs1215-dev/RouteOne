// Small shared UI primitives used across all pages.
import { useEffect } from 'react';

export function Badge({ color = '#64748b', children }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ backgroundColor: color + '22', color }}
    >
      {children}
    </span>
  );
}

const ORDER_STATUS_COLORS = {
  draft: '#64748b', submitted: '#0ea5e9', processing: '#f59e0b', invoiced: '#16a34a', cancelled: '#dc2626'
};
export function OrderStatusBadge({ status }) {
  return <Badge color={ORDER_STATUS_COLORS[status] || '#64748b'}>{status}</Badge>;
}

const VISIT_STATUS_COLORS = {
  planned: '#64748b', in_progress: '#f59e0b', completed: '#16a34a', missed: '#dc2626'
};
export function VisitStatusBadge({ status }) {
  return <Badge color={VISIT_STATUS_COLORS[status] || '#64748b'}>{status.replace('_', ' ')}</Badge>;
}

const QUOTE_STATUS_COLORS = {
  draft: '#64748b', sent: '#0ea5e9', accepted: '#16a34a', rejected: '#dc2626', expired: '#f59e0b'
};
export function QuoteStatusBadge({ status }) {
  return <Badge color={QUOTE_STATUS_COLORS[status] || '#64748b'}>{status}</Badge>;
}

export function GradeBadge({ grade }) {
  const colors = { A: '#16a34a', B: '#0ea5e9', C: '#64748b' };
  return <Badge color={colors[grade] || '#64748b'}>Grade {grade}</Badge>;
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          <div className="flex gap-2">{actions}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub, accent = 'text-slate-900' }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export function Table({ headers, children, empty }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead>
          <tr>{headers.map((h, i) => <th key={i} className="th">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty && <div className="py-10 text-center text-sm text-slate-400">{empty}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 p-4 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`card mt-8 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-0`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, span }) {
  return (
    <div className={span ? 'sm:col-span-2' : ''}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-brand-600" />
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 mb-3">{error}</div>;
}
