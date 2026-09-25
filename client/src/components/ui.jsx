// Small shared UI primitives used across all pages.
import { useEffect, useMemo, useState } from 'react';

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

// Friendly "nothing here" state — icon + message, reused by Table below and
// by mobile pages that render cards instead of tables.
export function EmptyState({ children, icon = '🗂️' }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <span className="text-3xl opacity-40">{icon}</span>
      <span className="text-sm text-slate-400">{children}</span>
    </div>
  );
}

// Each header is either a plain string (left-aligned) or { label, align } so a
// numeric column's heading can line up with its right-aligned values.
export function Table({ headers, children, empty, emptyIcon }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead>
          <tr>{headers.map((h, i) => {
            const label = typeof h === 'string' ? h : h.label;
            const align = typeof h === 'string' ? 'left' : h.align;
            return <th key={i} className={`th ${align === 'right' ? 'text-right' : ''}`}>{label}</th>;
          })}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty && <EmptyState icon={emptyIcon}>{empty}</EmptyState>}
    </div>
  );
}

// Slices `rows` into pages, defaulting to 20/page. Resets to page 1 whenever
// the row set itself changes (new search/filter), but not when just the
// page size changes size mid-browse - only reset there if the current page
// would now be out of range.
export function usePagination(rows, initialPageSize = 20) {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(1);
  const count = rows ? rows.length : 0;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));

  useEffect(() => { setPage(1); }, [count]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [pageSize, totalPages]);

  const pageRows = useMemo(
    () => (rows ? rows.slice((page - 1) * pageSize, page * pageSize) : []),
    [rows, page, pageSize]
  );

  return { page, setPage, pageSize, setPageSize, totalPages, pageRows };
}

export function PageSizeSelect({ value, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-500">
      Show
      <select className="input w-auto" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={20}>20</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
      </select>
      at a time
    </label>
  );
}

// Windowed page numbers with ellipses, e.g. 1 … 4 5 [6] 7 8 … 30
export function Pagination({ page, totalPages, onChange }) {
  const pages = useMemo(() => {
    const window = 1;
    const items = [];
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || Math.abs(p - page) <= window) items.push(p);
      else if (items[items.length - 1] !== '…') items.push('…');
    }
    return items;
  }, [page, totalPages]);

  if (totalPages <= 1) return null;

  const btn = (active) =>
    `min-w-[2rem] rounded-lg px-2 py-1 text-sm ${active ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-1 border-t border-slate-100 pt-4">
      <button className={btn(false)} disabled={page === 1} onClick={() => onChange(page - 1)}>‹ Prev</button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-1 text-slate-400">…</span>
        ) : (
          <button key={p} className={btn(p === page)} onClick={() => onChange(p)}>{p}</button>
        )
      )}
      <button className={btn(false)} disabled={page === totalPages} onClick={() => onChange(page + 1)}>Next ›</button>
    </div>
  );
}

// `footer` renders pinned below the scrollable body (e.g. action buttons) so
// it stays visible without scrolling, even when the body content is long.
export function Modal({ title, onClose, children, wide, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* mt-4 (not mt-8): the panel is capped at 100dvh-4rem, and p-4 on the
          overlay already contributes 1rem top and bottom. An mt-8 on top of
          that pushed the panel's lower edge past the bottom of the screen on
          short viewports, taking the end of the scroll area with it. */}
      <div className={`card modal-panel mt-4 flex w-full flex-col ${wide ? 'max-w-3xl' : 'max-w-lg'} p-0`}>
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        {/* min-h-0 is required: a flex child defaults to min-height:auto, which
            refuses to shrink below its content, so overflow-y-auto never
            actually scrolls on a tall form. */}
        <div className="modal-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">{children}</div>
        {footer && <div className="shrink-0 border-t border-slate-100 px-5 py-3">{footer}</div>}
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
