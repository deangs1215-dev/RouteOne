// Tiny same-origin API client. Authentication is held in an HttpOnly cookie so
// application JavaScript cannot read or exfiltrate the session token.
localStorage.removeItem('fsp_token');

export function setSession(active) {
  if (active) localStorage.setItem('fsp_session', '1');
  else localStorage.removeItem('fsp_session');
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    // fetch itself failed = server unreachable (or no network). Broadcast so the
    // connection banner can warn the user instead of leaving a silent spinner.
    window.dispatchEvent(new Event('fsp-neterror'));
    const err = new Error('No connection');
    err.isNetworkError = true;
    throw err;
  }
  // Reached the server - clear any "unreachable" banner.
  window.dispatchEvent(new Event('fsp-netok'));
  if (res.status === 401) {
    setSession(false);
    if (!path.startsWith('/auth') && window.location.pathname !== '/login') window.location.href = '/login';
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// GETs fall back to the offline snapshot; failed writes can be queued by the
// caller (see offline.js). api.raw skips all offline handling - the outbox
// uses it so a replay failure isn't re-queued in a loop.
async function get(path) {
  try {
    return await request('GET', path);
  } catch (e) {
    if (e.isNetworkError) {
      const { snapshotFallback } = await import('./offline.js');
      const cached = snapshotFallback(path);
      if (cached) return cached;
    }
    throw e;
  }
}

export const api = {
  get,
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  raw: (method, p, b) => request(method, p, b)
};

export const fmtR = (n) =>
  'R ' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export const fmtDateTime = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// Today as 'YYYY-MM-DD' in the browser's local time. `new Date().toISOString()`
// converts through UTC first, which silently shifts the date in any timezone
// behind UTC (e.g. showing yesterday as "today" just after local midnight in
// US/UK timezones) - this builds the string from local y/m/d components instead.
export const todayISO = () => toISODateLocal(new Date());

// Same local-component approach as todayISO, but for an arbitrary Date object
// (e.g. today + N days) - use this instead of date.toISOString().slice(0, 10).
export function toISODateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// today.getDate() + N correctly rolls over month/year boundaries (Date
// normalizes out-of-range day values), so this is safe for any offset.
export function addDaysISO(days, from = new Date()) {
  return toISODateLocal(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));
}

// Current time as 'YYYY-MM-DD HH:MM:SS' in the browser's local time. Used for
// storing datetime strings (not dates) in the database format. Avoids UTC shifts.
export function toLocalDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Fetch a binary response (PDF, etc.) and trigger a browser download - the
// tiny json-only `api` client above can't handle these.
export async function downloadFile(path, filename) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin'
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Current GPS position (best effort - visit check-in stamps).
export function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { timeout: 4000, maximumAge: 60000 }
    );
  });
}
