// Word-order-independent product search: every word typed must appear somewhere in the name or
// code, so "red col" finds both "RED COLOUR SPECIAL" and "COLOUR RED SPECIAL". Keep in step with
// searchWhere() in server/routes/products.routes.js.
export function matchesWords(query, ...fields) {
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.map((f) => (f || '').toLowerCase()).join(' ');
  return words.every((w) => hay.includes(w));
}
