import { useEffect, useRef, useState } from 'react';
import { api } from './api';

// Server-side customer search for pickers. The customer table is ~14,000 rows, so screens must
// not download it to filter in the browser: this asks /customers for a short page that matches
// what was typed (name, code or city), waiting a moment after the last keystroke.
// Returns { results, loading }; `results` stays empty until `term` has `minChars` characters.
export default function useCustomerSearch(term, { minChars = 2, limit = 15, delay = 250 } = {}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const text = (term || '').trim();

  useEffect(() => {
    if (text.length < minChars) { setResults([]); setLoading(false); return undefined; }
    const id = ++latest.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api.get(`/customers?q=${encodeURIComponent(text)}&limit=${limit}`)
        .then((rows) => { if (id === latest.current) setResults(rows); })
        .catch(() => { if (id === latest.current) setResults([]); })
        .finally(() => { if (id === latest.current) setLoading(false); });
    }, delay);
    return () => clearTimeout(timer);
  }, [text, minChars, limit, delay]);

  return { results, loading };
}
