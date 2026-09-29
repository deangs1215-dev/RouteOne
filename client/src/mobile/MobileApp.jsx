// Mobile-first rep app: today's route, customer list, order capture.
// Works offline: data comes from the sync snapshot, writes queue in the outbox.
//
// Appearance is chosen from the theme picker in the header (top right) - see
// mobile/theme.jsx for the themes and index.css for what each one defines.
// Converted screens style themselves from semantic tokens (bg-surface,
// text-ink, bg-accent) and therefore work with any theme; the ones still
// carrying a hardcoded per-palette copy are noted at their route below.
import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, Navigate, useNavigate } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime, getPosition, todayISO } from '../api';
import { useAuth } from '../auth';
import { Spinner, VisitStatusBadge, OrderStatusBadge, Badge, EmptyState, Modal } from '../components/ui';
import VisitSummary from '../components/VisitSummary';
import DatePicker from '../components/DatePicker';
import CustomerTasksSheet from '../components/CustomerTasksSheet';
import AddProspectModal from '../components/AddProspectModal';
import AppIcon from '../components/AppIcon';
import { onOfflineChange, getOutbox, flushOutbox, refreshSnapshot, describeOutboxItem, retryOutboxItem, discardOutboxItem } from '../offline';
import { MobileThemeProvider, useMobileTheme } from './theme';
import ThemePicker from './ThemePicker';
import RepCustomer from './RepCustomer';
import RepOrderCapture from './RepOrderCapture';
import OrderDetail from './OrderDetail';
import QuoteDetail from './QuoteDetail';
import FormDetail from './FormDetail';
import Tasks from './Tasks';
import RepStockCheck from './RepStockCheck';
import MyCycle from './MyCycle';
import BranchClockIn from './BranchClockIn';

// `new Date('YYYY-MM-DD')` parses as UTC midnight, so formatting it back for
// display can show the wrong day in timezones behind UTC. Building the Date
// from its y/m/d components instead keeps it in local time throughout.
function localDateFromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// R1-032/033: online/offline state plus per-item sync status for anything
// queued while offline. The headline bar is always visible whenever there's
// anything to report (offline, still syncing, or a failure needing
// attention); tapping it expands the actual queue so a rep can tell exactly
// which transaction hasn't reached the server, not just a count.
function OfflineBanner() {
  const [state, setState] = useState({ online: navigator.onLine, items: [], waiting: 0, syncing: 0, failed: 0, synced: 0, pending: getOutbox().length });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const off = onOfflineChange(setState);
    refreshSnapshot(); // keep the offline cache fresh while we have signal
    return off;
  }, []);

  if (state.online && state.pending === 0 && state.synced === 0) return null;
  const headline = !state.online
    ? <>📡 Offline — working from local data{state.pending > 0 && <>, {state.pending} pending sync</>}</>
    : state.failed > 0
      ? <>⚠ {state.failed} item{state.failed === 1 ? '' : 's'} failed to sync</>
      : state.waiting + state.syncing > 0
        ? <>⇅ Syncing {state.waiting + state.syncing} queued item{state.waiting + state.syncing === 1 ? '' : 's'}…</>
        : <>✓ All changes synced</>;
  const badge = {
    failed: 'bg-red-100 text-red-700', syncing: 'bg-sky-100 text-sky-700',
    synced: 'bg-emerald-100 text-emerald-700', pending: 'bg-slate-100 text-slate-600'
  };
  const statusLabel = { failed: 'Sync failed', syncing: 'Synchronising', synced: 'Synced', pending: 'Waiting to sync' };

  return (
    <div className={`sticky top-0 z-30 text-white ${!state.online ? 'bg-slate-800' : state.failed > 0 ? 'bg-red-700' : 'bg-sky-600'}`}>
      <button type="button" className="flex w-full items-center justify-center gap-2 px-4 py-2 text-center text-xs font-medium" onClick={() => setExpanded((v) => !v)}>
        {headline}
        <span className="underline">{expanded ? 'hide' : 'details'}</span>
      </button>
      {expanded && (
        <div className="max-h-56 overflow-y-auto border-t border-white/20 bg-white text-slate-700">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5">
            <span className="text-[11px] text-slate-400">{state.items.length} item{state.items.length === 1 ? '' : 's'} in the sync queue</span>
            <button type="button" className="text-xs font-semibold text-brand-600 underline" onClick={flushOutbox} disabled={!state.online}>Sync now</button>
          </div>
          {state.items.length === 0 && <div className="p-3 text-xs text-slate-400">Nothing queued.</div>}
          {state.items.map((item) => {
            const status = item.status || 'pending';
            return (
              <div key={item.id} className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-medium">{describeOutboxItem(item)}</div>
                  <div className="text-slate-400">{fmtDateTime(item.queued_at)}</div>
                  {status === 'failed' && item.error && <div className="mt-0.5 text-red-600">{item.error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 font-semibold ${badge[status]}`}>{statusLabel[status]}</span>
                  {status === 'failed' && (
                    <>
                      <button type="button" className="text-brand-600 underline" onClick={() => retryOutboxItem(item.id)}>Retry</button>
                      <button type="button" className="text-slate-400 underline" onClick={() => discardOutboxItem(item.id)}>Discard</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// R1-032: a small always-visible indicator (not just a banner that appears on
// trouble) so a rep can positively confirm "yes, I'm online" at a glance, not
// only find out they're offline once something already failed.
function ConnectionDot() {
  const [state, setState] = useState({ online: navigator.onLine, failed: 0 });
  useEffect(() => onOfflineChange(setState), []);
  const color = !state.online ? 'bg-slate-400' : state.failed > 0 ? 'bg-red-500' : 'bg-emerald-500';
  const label = !state.online ? 'Offline' : state.failed > 0 ? 'Sync issue' : 'Online';
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium" title={label}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

export default function MobileApp() {
  return (
    <MobileThemeProvider>
      <MobileAppShell />
    </MobileThemeProvider>
  );
}

function MobileAppShell() {
  const { isDark } = useMobileTheme();
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-app text-ink">
      <OfflineBanner />
      <div className="flex-1 pb-20">
        <Routes>
          {/* One Today for every theme - it reads its colours from the tokens.
              Screens below still have a per-palette copy and pick by mood
              until they are converted too. */}
          <Route path="/" element={<Today />} />
          <Route path="/customers" element={isDark ? <CustomersDark /> : <RepCustomers />} />
          <Route path="/customers/:id/order" element={<RepOrderCapture />} />
          <Route path="/customers/:id" element={<RepCustomer />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/quotes/:id" element={<QuoteDetail />} />
          <Route path="/forms/:id" element={<FormDetail />} />
          <Route path="/orders" element={<RepOrders />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/stock" element={<RepStockCheck />} />
          <Route path="/cycle" element={<MyCycle />} />
          <Route path="*" element={<Navigate to="/mobile" replace />} />
        </Routes>
      </div>
      <BottomNav />
    </div>
  );
}

function BottomNav() {
  const items = [
    { to: '/mobile', label: 'Today', icon: 'today', end: true },
    { to: '/mobile/customers', label: 'Customers', icon: 'customers' },
    { to: '/mobile/orders', label: 'Orders', icon: 'orders' },
    { to: '/mobile/stock', label: 'Stock', icon: 'products' },
    { to: '/mobile/tasks', label: 'Tasks', icon: 'tasks' }
    // Support is deliberately not here - logging a ticket lives on the main
    // menu (desktop /support), not in the rep's field nav.
  ];
  return (
    <nav className="fixed bottom-0 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-line bg-chrome pb-[env(safe-area-inset-bottom,0px)]">
      <div className="grid grid-cols-5">
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end}
            className={({ isActive }) =>
              `relative flex flex-col items-center gap-1 py-2 text-xs font-medium transition ${isActive ? 'text-accent' : 'text-faint'}`}>
            {({ isActive }) => (
              <>
                {/* The reference marks the active tab with a short accent bar
                    rather than a filled pill - it reads at a glance without
                    crowding six tabs. */}
                <span className={`absolute top-0 h-0.5 w-8 rounded-full transition ${isActive ? 'bg-accent' : 'bg-transparent'}`} />
                <AppIcon name={i.icon} size={30} />{i.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function MobileHeader({ title, back }) {
  const { user, logout } = useAuth();
  const [newDocs, setNewDocs] = useState(false);

  useEffect(() => {
    if (user.role === 'customer') return;
    api.get('/documents/unread-count').then((d) => setNewDocs(d.count > 0)).catch(() => {});
  }, [user.role]);

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-chrome px-4 py-3 text-chrome-ink">
      <div className="flex min-w-0 items-center gap-2">
        {back && (
          <Link to={back} className="flex items-center gap-1 rounded-control bg-white/10 px-2 py-1 text-sm font-semibold transition active:scale-95">
            <span className="text-lg leading-none">←</span>
            <span className="hidden sm:inline">Back</span>
          </Link>
        )}
        {/* text-base, not text-lg: the header also carries the theme picker,
            Main Menu and Sign out, and at 375px a larger title was being
            truncated to an ellipsis before any of them gave up space. */}
        <h1 className="app-title truncate text-base">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ConnectionDot />
        <ThemePicker />
        {user.role !== 'customer' && (
          <Link
            to="/"
            className="relative flex shrink-0 items-center gap-1 rounded-pill bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-ink transition active:scale-95"
          >
            🖥️ <span>Main Menu</span>
            {newDocs && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-bad text-[10px] font-bold leading-none text-white ring-2 ring-chrome"
                title="New documents available">!</span>
            )}
          </Link>
        )}
        <button onClick={logout} className="shrink-0 text-xs text-chrome-ink/60">Sign out</button>
      </div>
    </header>
  );
}

// Explicit "Clock in" action, shown at the top of the Home screen. Replaces
// the old silent background GPS ping - that gave no feedback if it failed
// (permission denied, no signal), so a rep could go a whole day with no
// anchor point for route optimisation and never know why. This captures a
// fresh, high-accuracy reading on tap and shows clear success/failure state.
function ClockInCard() {
  const [status, setStatus] = useState(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const checkStatus = () => api.get('/routes/start').then(setStatus).catch(() => setStatus({ source: 'none' }));
  useEffect(() => { checkStatus(); }, []);

  const clockIn = async () => {
    setBusy(true);
    setError('');
    const pos = await getPosition();
    if (pos.lat == null) {
      const messages = {
        1: 'Location access is blocked for this app — check your phone\'s location permission settings, then try again.',
        2: "Couldn't get a GPS fix — make sure Location Services/GPS is turned on, and try again outdoors or near a window.",
        3: 'Getting your location took too long — try again, ideally with a clearer view of the sky.'
      };
      setError(messages[pos.error] || "Couldn't get your location — check GPS is on and try again.");
      setBusy(false);
      return;
    }
    try {
      await api.post('/locations', pos);
      await checkStatus();
    } catch {
      setError('Failed to save your location — try again.');
    }
    setBusy(false);
  };

  if (status === undefined) return null; // avoid flashing the button while checking
  const clockedIn = status.source === 'gps_today';
  // recorded_at is stored in UTC (SQLite's own datetime('now') default) - the
  // explicit Z tells the browser to convert to local time for display,
  // instead of misreading it as an already-local timestamp.
  const time = clockedIn && status.recorded_at
    ? new Date(status.recorded_at.replace(' ', 'T') + 'Z').toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className={`card p-3 ${clockedIn ? 'bg-ok/10' : ''}`}>
      {clockedIn ? (
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-ok">✓ Clocked in{time ? ` at ${time}` : ''}</span>
          <button onClick={clockIn} disabled={busy} className="text-xs text-muted underline">{busy ? 'Updating…' : 'Refresh'}</button>
        </div>
      ) : (
        <button onClick={clockIn} disabled={busy} className="btn-primary w-full disabled:opacity-60">
          {busy ? 'Getting your location…' : '📍 Clock in'}
        </button>
      )}
      {error && <div className="mt-2 text-xs text-bad">{error}</div>}
    </div>
  );
}

function Today() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [taskSheet, setTaskSheet] = useState(null); // { customer_id, customer_name }
  const [visitSummaryId, setVisitSummaryId] = useState(null); // visit tapped for details (notes, outcome, etc.)

  const displayDate = selectedDate || todayISO();

  const loadDay = () => api.get(`/my-day?date=${displayDate}`).then(setData).catch(console.error);

  useEffect(() => { loadDay(); }, [displayDate]);

  if (!data) return <><MobileHeader title="My day" /><Spinner /></>;
  const { visits, stats } = data;
  const pct = stats.target ? Math.min(100, (stats.sales_mtd / stats.target) * 100) : 0;

  const dateStr = localDateFromISO(displayDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <>
      <MobileHeader title={`Hi ${user.name.split(' ')[0]} 👋`} />
      <div className="space-y-4 p-4">
        <ClockInCard />
        <div className="card p-3"><BranchClockIn /></div>

        {/* Date + call cycle sit side by side as pill controls, the way the
            reference groups its quick actions. */}
        {/* Quick actions as pill chips - fully rounded in the themes whose
            references use chips, squarer in the ones that don't (--r-pill). */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setShowDatePicker(true)}
            className="flex items-center justify-center gap-2 rounded-pill border border-line bg-surface p-3 text-sm font-semibold text-ink shadow-card transition active:scale-[0.98]"
          >
            📅 <span className="truncate">{dateStr}</span>
          </button>
          <Link to="/mobile/cycle" className="flex items-center justify-center gap-2 rounded-pill border border-line bg-surface p-3 text-sm font-semibold text-ink shadow-card transition active:scale-[0.98]">
            🗓️ My call cycle
          </Link>
        </div>

        {/* Headline metric: small muted label, oversized figure, progress to
            target - the stat-card treatment from the reference dashboard. */}
        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="app-eyebrow">Sales this month</div>
              <div className="app-title mt-1 text-3xl text-ink">{fmtR(stats.sales_mtd)}</div>
            </div>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">⚡</span>
          </div>
          {stats.target > 0 && (
            <>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-faint">{Math.round(pct)}% of {fmtR(stats.target)} target</div>
            </>
          )}
          {/* Label above figure, split by thin vertical rules - the bid-row
              treatment from the Sneaker reference. */}
          <div className="mt-4 grid grid-cols-3 divide-x divide-line border-t border-line pt-3 text-center">
            <div className="px-1"><div className="app-eyebrow">Visits</div><div className="app-title mt-0.5 text-lg text-ink">{stats.visits_done}</div></div>
            <div className="px-1"><div className="app-eyebrow">Orders</div><div className="app-title mt-0.5 text-lg text-ink">{stats.orders_today}</div></div>
            <div className="px-1"><div className="app-eyebrow">Sales</div><div className="app-title mt-0.5 text-lg text-ink">{fmtR(stats.sales_today)}</div></div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="app-title text-sm text-ink">Today's visits</h2>
            <span className="text-xs text-faint">{visits.length} planned</span>
          </div>
          <div className="space-y-2">
            {visits.map((v, i) => (
              <div key={v.id} className="card p-3">
                <div className="flex items-center gap-3">
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${v.status === 'completed' ? 'bg-ok/15 text-ok' : 'bg-accent text-accent-ink'}`}>
                    {v.status === 'completed' ? '✓' : v.route_order || i + 1}
                  </div>
                  <Link to={`/mobile/customers/${v.customer_id}`} className="min-w-0 flex-1">
                    <div className="app-title truncate text-sm text-ink">{v.customer_name}{v.customer_code && <span className="ml-1 font-normal normal-case tracking-normal text-faint">({v.customer_code})</span>}</div>
                    <div className="text-xs text-faint">{v.city} · {v.purpose}</div>
                  </Link>
                  <div className="flex items-center gap-2">
                    {v.order_count > 0 && <span className="text-xs">🧾</span>}
                    {v.customer_lat != null && v.status !== 'completed' && (
                      <a className="btn-secondary px-2 py-1 text-xs" target="_blank" rel="noreferrer"
                        href={`https://www.google.com/maps/dir/?api=1&destination=${v.customer_lat},${v.customer_lng}`}>🧭</a>
                    )}
                    {(v.status === 'completed' || v.status === 'in_progress') && (
                      <button className="text-xs font-medium text-accent underline" onClick={() => setVisitSummaryId(v.id)}>Details</button>
                    )}
                    <VisitStatusBadge status={v.status} />
                  </div>
                </div>

                {/* Task indicator — tap to Done / reschedule / add without leaving Today */}
                <button
                  onClick={() => setTaskSheet({ customer_id: v.customer_id, customer_name: v.customer_name })}
                  className={`mt-2 flex w-full items-center justify-between rounded-control px-3 py-2 text-left text-xs ${
                    v.overdue_task_count > 0
                      ? 'bg-bad/15 text-bad'
                      : v.open_task_count > 0
                      ? 'bg-warn/15 text-warn'
                      : 'bg-raised text-faint'
                  }`}
                >
                  {v.open_task_count > 0 ? (
                    <>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold">📋 {v.open_task_count} open{v.overdue_task_count > 0 ? ` · ${v.overdue_task_count} overdue` : ''}</span>
                        {v.next_task_type && (
                          <span className="ml-1 opacity-80">— next: {v.next_task_type} ({fmtDate(v.next_task_date)})</span>
                        )}
                      </span>
                      <span className="ml-2 shrink-0 font-semibold">›</span>
                    </>
                  ) : (
                    <>
                      <span>＋ Add task</span>
                      <span className="font-semibold">›</span>
                    </>
                  )}
                </button>

                {/* Sales AI alert indicator — tap through to the customer for the detail */}
                {v.ai_alert_count > 0 && (
                  <Link to={`/mobile/customers/${v.customer_id}`}
                    className="mt-1.5 flex w-full items-center justify-between rounded-control bg-bad/15 px-3 py-2 text-left text-xs text-bad">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold">🤖 {v.ai_alert_count} AI alert{v.ai_alert_count > 1 ? 's' : ''}</span>
                      {v.top_ai_alert && <span className="ml-1 opacity-80">— {v.top_ai_alert.action}</span>}
                    </span>
                    <span className="ml-2 shrink-0 font-semibold">›</span>
                  </Link>
                )}
              </div>
            ))}
            {visits.length === 0 && (
              <div className="card p-6 text-center text-sm text-faint">
                No visits planned for today.<br />
                <Link to="/mobile/customers" className="mt-1 inline-block font-medium text-accent">Browse customers →</Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {showDatePicker && (
        <DatePicker
          value={displayDate}
          onChange={setSelectedDate}
          onClose={() => setShowDatePicker(false)}
          label="Select date"
        />
      )}

      {taskSheet && (
        <CustomerTasksSheet
          customerId={taskSheet.customer_id}
          customerName={taskSheet.customer_name}
          onClose={() => setTaskSheet(null)}
          onChanged={loadDay}
        />
      )}

      {visitSummaryId && (
        <Modal title="Visit details" onClose={() => setVisitSummaryId(null)}>
          <VisitSummary visitId={visitSummaryId} />
        </Modal>
      )}
    </>
  );
}

function RepCustomers() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(true);
  const [showAddProspect, setShowAddProspect] = useState(false);

  // scope=all: reps see every account, but ones that aren't theirs render
  // greyed-out and non-clickable (the detail endpoint is rep-scoped anyway).
  // Fetched once regardless of the filter - "Mine"/"All" just slices the same
  // rows locally so toggling is instant, no re-fetch.
  const load = () => api.get(`/customers?scope=all&q=${encodeURIComponent(q)}`).then(setRows).catch(console.error);
  useEffect(() => { load(); }, [q]);
  const visible = rows ? (mineOnly ? rows.filter((c) => c.is_mine) : rows) : null;

  return (
    <>
      <MobileHeader title="My customers" />
      <div className="p-4 space-y-3">
        <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
          <button className={`flex-1 rounded-md py-1.5 ${mineOnly ? 'bg-white shadow text-brand-600' : 'text-slate-500'}`} onClick={() => setMineOnly(true)}>Mine</button>
          <button className={`flex-1 rounded-md py-1.5 ${!mineOnly ? 'bg-white shadow text-brand-600' : 'text-slate-500'}`} onClick={() => setMineOnly(false)}>All</button>
        </div>
        <button className="btn-secondary w-full py-2.5" onClick={() => setShowAddProspect(true)}>
          ＋ New prospect (not yet a SYSPRO account)
        </button>
        {!rows ? <Spinner /> : visible.map((c) => {
          const mine = !!c.is_mine;
          const inner = (
            <div className="min-w-0">
              <div className="flex items-center gap-2 truncate font-medium">
                {c.name}
                {c.status === 'prospect' && <Badge color="#a855f7">Prospect</Badge>}
              </div>
              {c.code && <div className={`text-xs font-semibold ${mine ? 'text-brand-600' : 'text-slate-400'}`}>Account {c.code}</div>}
              <div className="text-xs text-slate-400">
                {mine
                  ? `${c.city}${c.warehouse_name ? ` · ${c.warehouse_name}` : ''} · last order ${c.last_order_at ? c.last_order_at.slice(0, 10) : 'never'}`
                  : `${c.city} · ${c.rep_name || 'another rep'}'s account`}
              </div>
            </div>
          );
          return mine ? (
            <Link key={c.id} to={`/mobile/customers/${c.id}`} className="card flex items-center justify-between p-3">
              {inner}
              <span className="text-slate-300">›</span>
            </Link>
          ) : (
            <div key={c.id} className="card flex items-center justify-between p-3 opacity-50" aria-disabled="true">
              {inner}
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Other rep</span>
            </div>
          );
        })}
        {visible && visible.length === 0 && (
          <div className="card"><EmptyState icon="🔍">{mineOnly ? "No customers assigned to you yet." : "No customers found."}</EmptyState></div>
        )}
      </div>

      {showAddProspect && (
        <AddProspectModal
          onClose={() => setShowAddProspect(false)}
          onCreated={(customer) => navigate(`/mobile/customers/${customer.id}`)}
        />
      )}
    </>
  );
}

// Dark-theme customer list — same /customers data, corporate navy + brass look.
function CustomersDark() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(true);
  const [showAddProspect, setShowAddProspect] = useState(false);

  // scope=all: see every account; ones that aren't this rep's are greyed out
  // and non-clickable. Fetched once regardless of filter - "Mine"/"All" just
  // slices the same rows locally so toggling is instant, no re-fetch.
  const load = () => api.get(`/customers?scope=all&q=${encodeURIComponent(q)}`).then(setRows).catch(console.error);
  useEffect(() => { load(); }, [q]);
  const visible = rows ? (mineOnly ? rows.filter((c) => c.is_mine) : rows) : null;

  return (
    <>
      <MobileHeader title="My customers" />
      <div className="p-4 space-y-3">
        <input
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-corp-700 focus:outline-none"
          placeholder="Search accounts…" value={q} onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex rounded-md border border-slate-300 bg-white p-1 text-sm font-semibold">
          <button className={`flex-1 rounded py-1.5 ${mineOnly ? 'bg-corp-900 text-white' : 'text-slate-500'}`} onClick={() => setMineOnly(true)}>Mine</button>
          <button className={`flex-1 rounded py-1.5 ${!mineOnly ? 'bg-corp-900 text-white' : 'text-slate-500'}`} onClick={() => setMineOnly(false)}>All</button>
        </div>
        <button
          className="w-full rounded-md border border-corp-700 bg-white py-2.5 text-sm font-semibold text-corp-900 shadow-sm hover:bg-slate-50"
          onClick={() => setShowAddProspect(true)}
        >
          + New prospect (not yet a SYSPRO account)
        </button>

        {!rows ? <Spinner /> : visible.map((c) => {
          const mine = !!c.is_mine;
          const inner = (
            <div className="min-w-0">
              <div className="flex items-center gap-2 truncate font-semibold text-corp-900">
                {c.name}
                {c.status === 'prospect' && (
                  <span className="rounded-sm border border-brass-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brass-600">Prospect</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                {c.code && <span className={`font-semibold ${mine ? 'text-corp-700' : 'text-slate-400'}`}>{c.code}</span>}
                <span>{c.city}</span>
                {c.warehouse_name && <span className="text-slate-500">· {c.warehouse_name}</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                {mine ? `Last order ${c.last_order_at ? c.last_order_at.slice(0, 10) : 'never'}` : `${c.rep_name || 'another rep'}'s account`}
              </div>
            </div>
          );
          return mine ? (
            <Link key={c.id} to={`/mobile/customers/${c.id}`}
              className="flex items-center justify-between rounded-md border border-slate-200 bg-white p-3.5 shadow-sm transition hover:border-corp-700">
              {inner}
              <span className="shrink-0 text-slate-300">›</span>
            </Link>
          ) : (
            <div key={c.id} aria-disabled="true"
              className="flex items-center justify-between rounded-md border border-slate-200 bg-white p-3.5 shadow-sm opacity-50">
              {inner}
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Other rep</span>
            </div>
          );
        })}
        {visible && visible.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-300 bg-white">
            <EmptyState icon="🔍">{mineOnly ? "No accounts assigned to you yet." : "No accounts found."}</EmptyState>
          </div>
        )}
      </div>

      {showAddProspect && (
        <AddProspectModal
          onClose={() => setShowAddProspect(false)}
          onCreated={(customer) => navigate(`/mobile/customers/${customer.id}`)}
        />
      )}
    </>
  );
}

function RepOrders() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('orders'); // 'orders' | 'drafts'
  const [rows, setRows] = useState(null);
  const [drafts, setDrafts] = useState(null);

  useEffect(() => {
    api.get('/orders').then(setRows).catch(console.error);
    api.get('/drafts').then(setDrafts).catch(() => setDrafts([]));
  }, []);

  const resumeDraft = (d) => {
    if (d.kind === 'form') navigate(`/mobile/customers/${d.customer_id}?formDraft=${d.id}`);
    // A visit draft just tracks notes typed during an open visit - there's
    // nothing separate to "resume", the customer page picks it back up itself
    // (RepCustomer.jsx re-loads it once it sees the visit is still in_progress).
    else if (d.kind === 'visit') navigate(`/mobile/customers/${d.customer_id}`);
    else navigate(`/mobile/customers/${d.customer_id}/order?kind=${d.kind}&draft=${d.id}`);
  };

  const discardDraft = async (id) => {
    if (!window.confirm('Discard this draft? This can\'t be undone.')) return;
    await api.del(`/drafts/${id}`).catch(() => {});
    setDrafts((ds) => ds.filter((d) => d.id !== id));
  };

  const draftLabel = (d) => d.kind === 'form' ? (d.template_name || 'Form')
    : d.kind === 'quote' ? 'Quote' : d.kind === 'visit' ? 'Visit notes' : 'Order';

  return (
    <>
      <MobileHeader title="My orders" />
      <div className="flex gap-2 px-4 pt-3">
        <button className={`rounded-full px-3 py-1 text-xs font-medium ${tab === 'orders' ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}
          onClick={() => setTab('orders')}>Orders</button>
        <button className={`rounded-full px-3 py-1 text-xs font-medium ${tab === 'drafts' ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}
          onClick={() => setTab('drafts')}>Drafts{drafts?.length > 0 ? ` (${drafts.length})` : ''}</button>
      </div>

      {tab === 'orders' ? (
        <div className="p-4 space-y-2">
          {/* R1-043: tappable through to full detail, same as every other
              list in this app (customers, tasks, visits) - previously a
              plain non-interactive card with no way to open the order. */}
          {!rows ? <Spinner /> : rows.map((o) => (
            <Link key={o.id} to={`/mobile/orders/${o.id}`} className="card block p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{o.number}</span>
                <OrderStatusBadge status={o.status} />
              </div>
              <div className="mt-0.5 flex items-center justify-between text-xs text-slate-400">
                <span>
                  {o.customer_name} · {fmtDateTime(o.order_date)}
                  {o.customer_order_no && <> · their ref {o.customer_order_no}</>}
                </span>
                <span className="text-sm font-semibold text-slate-700">{fmtR(o.total)}</span>
              </div>
            </Link>
          ))}
          {rows && rows.length === 0 && <div className="card"><EmptyState icon="🧾">No orders yet.</EmptyState></div>}
        </div>
      ) : (
        <div className="p-4 space-y-2">
          {!drafts ? <Spinner /> : drafts.map((d) => (
            <div key={d.id} className="card p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{draftLabel(d)} draft</span>
                <span className="text-xs text-slate-400">{fmtDateTime(d.updated_at)}</span>
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {d.customer_name || 'No customer'}{d.label ? ` · ${d.label}` : ''}
              </div>
              <div className="mt-2 flex gap-2">
                <button className="btn-primary flex-1 py-1.5 text-xs" onClick={() => resumeDraft(d)}>Resume</button>
                <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => discardDraft(d.id)}>Discard</button>
              </div>
            </div>
          ))}
          {drafts && drafts.length === 0 && <div className="card"><EmptyState icon="📝">No saved drafts.</EmptyState></div>}
        </div>
      )}
    </>
  );
}
