import { useEffect, useState } from 'react';

// Server timestamps are UTC ('YYYY-MM-DD HH:MM:SS' from datetime('now')); the
// offline path also stores UTC (toISOString). Parse both as UTC.
const parseUTC = (s) => {
  if (!s) return null;
  const norm = s.includes('T') ? s : s.replace(' ', 'T');
  return new Date(norm.endsWith('Z') ? norm : norm + 'Z');
};

// Device-local 'YYYY-MM-DD HH:MM:SS' (what toLocalDateTime() writes for an offline visit).
const parseLocal = (s) => (s ? new Date(s.replace(' ', 'T')) : null);

// Live "H:MM:SS" while on site.
function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Compact recorded duration, e.g. "1h 23m" or "12m".
export function visitDuration(checkIn, checkOut) {
  const a = parseUTC(checkIn);
  const b = parseUTC(checkOut);
  if (!a || !b) return null;
  const mins = Math.max(0, Math.round((b - a) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

// Live counting-up timer since check-in.
//  - serverNow: the server's "now" (same clock that stamped `since`), as received
//    with the visit. Elapsed time is measured against it, so a phone clock that
//    is off by seconds or minutes doesn't change the starting value.
//  - local: `since` is a device-local timestamp (a visit started offline), not UTC.
export default function VisitTimer({ since, serverNow, local = false, className = '' }) {
  const start = local ? parseLocal(since) : parseUTC(since);
  // Computed once per received value: server minus device clock, at receipt.
  const [skewMs] = useState(() => {
    const server = !local && serverNow ? parseUTC(serverNow) : null;
    return server ? server.getTime() - Date.now() : 0;
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!start) return null;
  return <span className={`tabular-nums ${className}`}>{fmtElapsed(now + skewMs - start.getTime())}</span>;
}
