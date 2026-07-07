// Tiny API client. Token lives in localStorage; 401s bounce to login.
let token = localStorage.getItem('fsp_token') || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('fsp_token', t);
  else localStorage.removeItem('fsp_token');
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
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
    setToken(null);
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
