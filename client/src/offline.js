// Offline engine for the rep app.
//
// Two halves:
//  1. Snapshot - a full copy of the rep's customers, products (with price
//     breaks), contract prices, today's visits and form templates, refreshed
//     whenever we're online. GET requests fall back to it when the network dies.
//  2. Outbox - writes (orders, check-ins, check-outs, form submissions) that
//     fail with a network error are queued and replayed when we're back online.
import { api } from './api';

const SNAPSHOT_KEY = 'fsp_snapshot';
const OUTBOX_KEY = 'fsp_outbox';
const listeners = new Set();

export function onOfflineChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// R1-033: each outbox item carries a status - 'pending' (waiting to sync),
// 'syncing' (send in flight), 'synced' (just succeeded - lingers briefly so
// the rep sees the confirmation, then is removed) or 'failed' (the server
// rejected it for a real reason, e.g. validation - not a connectivity issue,
// so retrying automatically would just fail again the same way). `pending`
// here counts everything NOT yet successfully synced (waiting + syncing +
// failed), matching what earlier UI already called "pending sync"; `synced`
// is broken out separately since those items are done, just not yet cleared.
function emit() {
  const items = getOutbox();
  const state = {
    online: navigator.onLine,
    items,
    waiting: items.filter((o) => o.status === 'pending' || !o.status).length,
    syncing: items.filter((o) => o.status === 'syncing').length,
    failed: items.filter((o) => o.status === 'failed').length,
    synced: items.filter((o) => o.status === 'synced').length,
    pending: items.filter((o) => o.status !== 'synced').length,
    snapshotAt: getSnapshot()?.generated_at || null
  };
  listeners.forEach((fn) => fn(state));
}

// --- Snapshot ---------------------------------------------------------------

export function getSnapshot() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY)); } catch { return null; }
}

export async function refreshSnapshot() {
  try {
    const snap = await api.get('/sync/snapshot');
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    emit();
    return snap;
  } catch {
    return getSnapshot();
  }
}

// Serve known GET endpoints from the snapshot when the network is gone.
export function snapshotFallback(path) {
  const snap = getSnapshot();
  if (!snap) return null;

  if (path.startsWith('/customers?') || path === '/customers') {
    const q = new URLSearchParams(path.split('?')[1] || '').get('q')?.toLowerCase();
    return snap.customers.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.city || '').toLowerCase().includes(q));
  }

  let m = path.match(/^\/customers\/(\d+)$/);
  if (m) {
    const c = snap.customers.find((x) => x.id === Number(m[1]));
    if (!c) return null;
    return {
      ...c,
      contacts: [], recent_orders: [], recent_visits: snap.visits_today.filter((v) => v.customer_id === c.id),
      recent_quotes: [], prices: [],
      stats: { order_count: 0, sales_total: 0, sales_mtd: 0, sales_12m: 0 },
      _offline: true
    };
  }

  m = path.match(/^\/products\/for-customer\/(\d+)$/);
  if (m) {
    const custId = Number(m[1]);
    return snap.products.map((p) => {
      const contract = snap.contract_prices.find((cp) => cp.customer_id === custId && cp.product_id === p.id);
      return {
        ...p,
        effective_price: contract ? contract.price : p.price_breaks[0].price,
        has_contract_price: contract ? 1 : 0,
        price_breaks: contract ? [] : p.price_breaks
      };
    });
  }

  if (path === '/my-day') {
    return {
      visits: snap.visits_today,
      stats: { visits_done: 0, orders_today: 0, sales_today: 0, sales_mtd: 0, target: 0, _offline: true }
    };
  }

  if (path === '/form-templates') return snap.form_templates;

  return null;
}

// --- Outbox -----------------------------------------------------------------

export function getOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; }
}

export async function clearOfflineData() {
  localStorage.removeItem(SNAPSHOT_KEY);
  localStorage.removeItem(OUTBOX_KEY);
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('fsp-')).map((key) => caches.delete(key)));
  }
  emit();
}

function persistOutbox(outbox) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  emit();
}

export function queueWrite(method, path, body) {
  const outbox = getOutbox();
  outbox.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), method, path, body, queued_at: new Date().toISOString(), status: 'pending' });
  persistOutbox(outbox);
}

// R1-033: friendly label for an outbox item, for the sync-status list - the
// item itself only carries the raw method/path it'll be replayed with.
export function describeOutboxItem({ method, path }) {
  if (method === 'POST' && path === '/orders') return 'Order';
  if (method === 'POST' && path === '/quotes') return 'Quote';
  if (method === 'POST' && path === '/visits/log-offline') return 'Visit';
  if (method === 'POST' && /^\/visits\/\d+\/check-out$/.test(path)) return 'Visit check-out';
  if (method === 'POST' && /^\/visits\/\d+\/photos$/.test(path)) return 'Visit photo';
  if (method === 'DELETE' && /^\/visits\/\d+\/photos\/\d+$/.test(path)) return 'Delete photo';
  if (/^\/customers\/\d+\/notes$/.test(path)) return 'Customer note';
  if (/^\/customers\/\d+\/intel-notes$/.test(path)) return 'Field notes';
  if (/^\/customers\/\d+\/details$/.test(path)) return 'Customer details';
  if (method === 'POST' && path === '/form-submissions') return 'Form submission';
  return `${method} ${path}`;
}

// A failed item sits until the rep acts on it - resets it to 'pending' and
// kicks a flush so it's retried right away.
export function retryOutboxItem(id) {
  const outbox = getOutbox();
  const item = outbox.find((o) => o.id === id);
  if (!item) return;
  item.status = 'pending';
  delete item.error;
  persistOutbox(outbox);
  flushOutbox();
}

export function discardOutboxItem(id) {
  persistOutbox(getOutbox().filter((o) => o.id !== id));
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    // Snapshot the order once; items are mutated/removed by reference as we
    // go (via getOutbox()/persistOutbox()), not by re-reading this array.
    const toTry = getOutbox().filter((o) => o.status !== 'failed'); // a failed item needs a manual retry, not another automatic attempt
    for (const item of toTry) {
      let outbox = getOutbox();
      const live = outbox.find((o) => o.id === item.id);
      if (!live) continue; // discarded by the rep while we were mid-flush
      live.status = 'syncing';
      persistOutbox(outbox);
      try {
        await api.raw(live.method, live.path, live.body);
        live.status = 'synced';
        persistOutbox(outbox);
        // Linger briefly so the rep actually sees the "synced" confirmation
        // rather than the item just vanishing. Reads fresh state rather than
        // closing over `outbox` so it can't clobber a write from elsewhere.
        setTimeout(() => persistOutbox(getOutbox().filter((o) => o.id !== live.id)), 2500);
      } catch (e) {
        // Network still down or session expired: stop and retry everything
        // after reconnect/re-login - this item and any not yet attempted stay
        // 'pending'. A real server rejection (validation, etc.) is a
        // different problem retrying won't fix on its own, so it's marked
        // 'failed' and kept - visible and actionable - rather than silently
        // dropped, which is what happened before this ticket.
        if (e.isNetworkError || e.status === 401) {
          live.status = 'pending';
          persistOutbox(outbox);
          break;
        }
        live.status = 'failed';
        live.error = e.message;
        live.failed_at = new Date().toISOString();
        persistOutbox(outbox);
      }
    }
  } finally {
    flushing = false;
  }
  emit();
}

// Wire up connectivity events once at app start. Nothing runs while logged
// out - a snapshot call without a token would just 401.
export function initOffline() {
  const loggedIn = () => !!localStorage.getItem('fsp_session');
  window.addEventListener('online', () => {
    emit();
    if (loggedIn()) flushOutbox().then(refreshSnapshot);
  });
  window.addEventListener('offline', emit);
  if (loggedIn()) flushOutbox().then(refreshSnapshot);
}
