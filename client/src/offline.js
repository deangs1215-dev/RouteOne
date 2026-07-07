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
function emit() {
  const state = { online: navigator.onLine, pending: getOutbox().length, snapshotAt: getSnapshot()?.generated_at || null };
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

export function queueWrite(method, path, body) {
  const outbox = getOutbox();
  outbox.push({ id: Date.now() + Math.random().toString(36).slice(2, 6), method, path, body, queued_at: new Date().toISOString() });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  emit();
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let outbox = getOutbox();
    while (outbox.length > 0) {
      const item = outbox[0];
      try {
        await api.raw(item.method, item.path, item.body);
      } catch (e) {
        // Network still down or session expired: stop and retry after
        // reconnect/re-login. Real server rejection (other 4xx): drop the item
        // so one bad entry can't block the queue forever.
        if (e.isNetworkError || e.status === 401) break;
        console.warn('Outbox item rejected by server, dropping:', item.path, e.message);
      }
      outbox = outbox.slice(1);
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
      emit();
    }
  } finally {
    flushing = false;
  }
  emit();
}

// Wire up connectivity events once at app start. Nothing runs while logged
// out - a snapshot call without a token would just 401.
export function initOffline() {
  const loggedIn = () => !!localStorage.getItem('fsp_token');
  window.addEventListener('online', () => {
    emit();
    if (loggedIn()) flushOutbox().then(refreshSnapshot);
  });
  window.addEventListener('offline', emit);
  if (loggedIn()) flushOutbox().then(refreshSnapshot);
}
