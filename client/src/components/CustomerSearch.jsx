import { useState } from 'react';
import useCustomerSearch from '../useCustomerSearch';

// Type-to-search customer picker (replaces a <select> holding every customer).
// `value` is the chosen customer object (or null); `onChange(customer | null)`.
export default function CustomerSearch({ value, onChange, placeholder = 'Search name, code or city…', autoFocus = false }) {
  const [term, setTerm] = useState('');
  const { results, loading } = useCustomerSearch(term);

  if (value) {
    return (
      <div className="input flex items-center justify-between gap-2">
        <span className="truncate font-medium">{value.name}{value.code ? <span className="font-normal text-slate-400"> ({value.code})</span> : null}</span>
        <button type="button" className="shrink-0 text-xs text-brand-600 hover:underline" onClick={() => { onChange(null); setTerm(''); }}>Change</button>
      </div>
    );
  }

  const searching = term.trim().length >= 2;
  return (
    <div className="relative">
      <input className="input" placeholder={placeholder} value={term} autoFocus={autoFocus}
        onChange={(e) => setTerm(e.target.value)} />
      {searching && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((c) => (
            <button key={c.id} type="button" onClick={() => { onChange(c); setTerm(''); }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100">
              <span className="font-medium">{c.name}</span>
              <span className="ml-1 text-xs text-slate-400">{c.code}{c.city ? ` · ${c.city}` : ''}</span>
            </button>
          ))}
          {results.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">{loading ? 'Searching…' : 'No customers found'}</div>}
        </div>
      )}
      {!searching && <div className="mt-1 text-[11px] text-slate-400">Type at least 2 characters to search.</div>}
    </div>
  );
}
