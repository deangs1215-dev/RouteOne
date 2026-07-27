// Mobile-first rep app: today's route, customer list, order capture.
// Works offline: data comes from the sync snapshot, writes queue in the outbox.
// Light/dark toggle lives in the header (top right) on every screen; "dark"
// is the corporate navy + brass palette, applied to the header/nav chrome
// plus the Today and Customers screens.
import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, Navigate, useNavigate } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime, getPosition, todayISO } from '../api';
import { useAuth } from '../auth';
import { Spinner, VisitStatusBadge, OrderStatusBadge, Badge, EmptyState } from '../components/ui';
import DatePicker from '../components/DatePicker';
import CustomerTasksSheet from '../components/CustomerTasksSheet';
import AddProspectModal from '../components/AddProspectModal';
import AppIcon from '../components/AppIcon';
import { onOfflineChange, getOutbox, flushOutbox, refreshSnapshot } from '../offline';
import { MobileThemeProvider, useMobileTheme } from './theme';
import RepCustomer from './RepCustomer';
import RepOrderCapture from './RepOrderCapture';
import OrderDetail from './OrderDetail';
import QuoteDetail from './QuoteDetail';
import FormDetail from './FormDetail';
import Tasks from './Tasks';
import RepStockCheck from './RepStockCheck';

// `new Date('YYYY-MM-DD')` parses as UTC midnight, so formatting it back for
// display can show the wrong day in timezones behind UTC. Building the Date
// from its y/m/d components instead keeps it in local time throughout.
function localDateFromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function OfflineBanner() {
  const [state, setState] = useState({ online: navigator.onLine, pending: getOutbox().length });

  useEffect(() => {
    const off = onOfflineChange(setState);
    refreshSnapshot(); // keep the offline cache fresh while we have signal
    return off;
  }, []);

  if (state.online && state.pending === 0) return null;
  return (
    <div className={`sticky top-0 z-30 px-4 py-2 text-center text-xs font-medium ${state.online ? 'bg-sky-600 text-white' : 'bg-slate-800 text-white'}`}>
      {!state.online
        ? <>📡 Offline — working from local data{state.pending > 0 && <>, {state.pending} pending sync</>}</>
        : <>⇅ Syncing {state.pending} queued item{state.pending === 1 ? '' : 's'}…
            <button className="ml-2 underline" onClick={flushOutbox}>retry now</button></>}
    </div>
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
  const { theme } = useMobileTheme();
  return (
    <div className={`mx-auto flex min-h-screen max-w-md flex-col ${theme === 'dark' ? 'bg-slate-50' : 'bg-slate-100'}`}>
      <OfflineBanner />
      <div className="flex-1 pb-20">
        <Routes>
          <Route path="/" element={theme === 'dark' ? <TodayDark /> : <Today />} />
          <Route path="/customers" element={theme === 'dark' ? <CustomersDark /> : <RepCustomers />} />
          <Route path="/customers/:id/order" element={<RepOrderCapture />} />
          <Route path="/customers/:id" element={<RepCustomer />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/quotes/:id" element={<QuoteDetail />} />
          <Route path="/forms/:id" element={<FormDetail />} />
          <Route path="/orders" element={<RepOrders />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/stock" element={<RepStockCheck />} />
          <Route path="*" element={<Navigate to="/mobile" replace />} />
        </Routes>
      </div>
      <BottomNav />
    </div>
  );
}

function BottomNav() {
  const { theme } = useMobileTheme();
  const items = [
    { to: '/mobile', label: 'Today', icon: 'today', end: true },
    { to: '/mobile/customers', label: 'Customers', icon: 'customers' },
    { to: '/mobile/orders', label: 'Orders', icon: 'orders' },
    { to: '/mobile/stock', label: 'Stock', icon: 'products' },
    { to: '/mobile/tasks', label: 'Tasks', icon: 'tasks' }
  ];
  const dark = theme === 'dark';
  return (
    <nav className={`fixed bottom-0 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t ${dark ? 'border-corp-800 bg-corp-950' : 'border-slate-200 bg-white'}`}>
      <div className="grid grid-cols-5">
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 py-2 text-xs font-medium ${isActive ? (dark ? 'text-brass-400' : 'text-brand-600') : (dark ? 'text-slate-400' : 'text-slate-400')}`}>
            <AppIcon name={i.icon} size={30} />{i.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

// Sun/moon toggle button, shown top-right in the header on every screen.
function ThemeToggle() {
  const { theme, toggleTheme } = useMobileTheme();
  return (
    <button onClick={toggleTheme} className="text-lg leading-none" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}

export function MobileHeader({ title, back }) {
  const { user, logout } = useAuth();
  const { theme } = useMobileTheme();
  const dark = theme === 'dark';
  const [newDocs, setNewDocs] = useState(false);

  useEffect(() => {
    if (user.role === 'customer') return;
    api.get('/documents/unread-count').then((d) => setNewDocs(d.count > 0)).catch(() => {});
  }, [user.role]);

  return (
    <header className={`sticky top-0 z-20 flex items-center justify-between border-b px-4 py-3 ${dark ? 'border-corp-800 bg-corp-950 text-white' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center gap-2">
        {back && (
          <Link to={back} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition">
            <span className="text-lg leading-none">←</span>
            <span className="hidden sm:inline">Return Back</span>
          </Link>
        )}
        <h1 className="font-bold">{title}</h1>
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        {user.role !== 'customer' && (
          <Link to="/" className={`relative text-xs font-medium ${dark ? 'text-brass-400' : 'text-brand-600'}`}>
            🖥️ Main Menu
            {newDocs && (
              <span className={`absolute -right-2.5 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold leading-none text-yellow-300 ring-2 ${dark ? 'ring-corp-950' : 'ring-white'}`}
                title="New documents available">!</span>
            )}
          </Link>
        )}
        <button onClick={logout} className={`text-xs ${dark ? 'text-slate-400' : 'text-slate-400'}`}>Sign out</button>
      </div>
    </header>
  );
}

function Today() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [taskSheet, setTaskSheet] = useState(null); // { customer_id, customer_name }

  const displayDate = selectedDate || todayISO();

  const loadDay = () => api.get(`/my-day?date=${displayDate}`).then(setData).catch(console.error);

  useEffect(() => {
    loadDay();
    // Best-effort position ping so managers see reps on the live map.
    getPosition().then((pos) => {
      if (pos.lat != null) api.post('/locations', pos).catch(() => {});
    });
  }, [displayDate]);

  if (!data) return <><MobileHeader title="My day" /><Spinner /></>;
  const { visits, stats } = data;
  const pct = stats.target ? Math.min(100, (stats.sales_mtd / stats.target) * 100) : 0;

  const dateStr = localDateFromISO(displayDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <>
      <MobileHeader title={`Hi ${user.name.split(' ')[0]} 👋`} />
      <div className="space-y-4 p-4">
        {/* Date selector */}
        <button
          onClick={() => setShowDatePicker(true)}
          className="w-full card p-3 text-center font-semibold text-slate-700 hover:bg-slate-50 transition"
        >
          📅 {dateStr}
        </button>

        <div className="card p-4">
          <div className="flex justify-between text-sm">
            <span className="text-slate-500">Sales this month</span>
            <span className="font-semibold">{fmtR(stats.sales_mtd)}</span>
          </div>
          {stats.target > 0 && (
            <>
              <div className="mt-2 h-2 rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs text-slate-400">{Math.round(pct)}% of {fmtR(stats.target)} target</div>
            </>
          )}
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div><div className="text-lg font-bold">{stats.visits_done}</div><div className="text-xs text-slate-400">visits done</div></div>
            <div><div className="text-lg font-bold">{stats.orders_today}</div><div className="text-xs text-slate-400">orders today</div></div>
            <div><div className="text-lg font-bold">{fmtR(stats.sales_today)}</div><div className="text-xs text-slate-400">sales today</div></div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-600">Today's visits</h2>
            <span className="text-xs text-slate-400">{visits.length} planned</span>
          </div>
          <div className="space-y-2">
            {visits.map((v, i) => (
              <div key={v.id} className="card p-3">
                <div className="flex items-center gap-3">
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${v.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-brand-600 text-white'}`}>
                    {v.status === 'completed' ? '✓' : v.route_order || i + 1}
                  </div>
                  <Link to={`/mobile/customers/${v.customer_id}`} className="min-w-0 flex-1">
                    <div className="truncate font-medium">{v.customer_name}{v.customer_code && <span className="ml-1 font-normal text-slate-400">({v.customer_code})</span>}</div>
                    <div className="text-xs text-slate-400">{v.city} · {v.purpose}</div>
                  </Link>
                  <div className="flex items-center gap-2">
                    {v.order_count > 0 && <span className="text-xs">🧾</span>}
                    {v.customer_lat != null && v.status !== 'completed' && (
                      <a className="btn-secondary px-2 py-1 text-xs" target="_blank" rel="noreferrer"
                        href={`https://www.google.com/maps/dir/?api=1&destination=${v.customer_lat},${v.customer_lng}`}>🧭</a>
                    )}
                    <VisitStatusBadge status={v.status} />
                  </div>
                </div>

                {/* Task indicator — tap to Done / reschedule / add without leaving Today */}
                <button
                  onClick={() => setTaskSheet({ customer_id: v.customer_id, customer_name: v.customer_name })}
                  className={`mt-2 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
                    v.overdue_task_count > 0
                      ? 'bg-red-50 text-red-700'
                      : v.open_task_count > 0
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-slate-50 text-slate-400'
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
                    className="mt-1.5 flex w-full items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-left text-xs text-red-700">
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
              <div className="card p-6 text-center text-sm text-slate-400">
                No visits planned for today.<br />
                <Link to="/mobile/customers" className="mt-1 inline-block text-brand-600 font-medium">Browse customers →</Link>
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
    </>
  );
}

// Dark-theme Today screen — same /my-day data, corporate navy + brass look.
function TodayDark() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [taskSheet, setTaskSheet] = useState(null);

  const displayDate = selectedDate || todayISO();
  const loadDay = () => api.get(`/my-day?date=${displayDate}`).then(setData).catch(console.error);

  useEffect(() => {
    loadDay();
    getPosition().then((pos) => {
      if (pos.lat != null) api.post('/locations', pos).catch(() => {});
    });
  }, [displayDate]);

  if (!data) return <><MobileHeader title="My day" /><Spinner /></>;
  const { visits, stats } = data;
  const pct = stats.target ? Math.min(100, (stats.sales_mtd / stats.target) * 100) : 0;
  const dateStr = localDateFromISO(displayDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <>
      <MobileHeader title={`Good day, ${user.name.split(' ')[0]}`} />
      <div className="space-y-4 p-4">
        <button
          onClick={() => setShowDatePicker(true)}
          className="w-full rounded-md border border-corp-700 bg-white px-4 py-3 text-left shadow-sm transition hover:border-brass-500"
        >
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Schedule for</div>
          <div className="mt-0.5 font-bold text-corp-900">{dateStr}</div>
        </button>

        <div className="rounded-md border border-corp-800 bg-corp-950 p-4 text-white shadow-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Sales this month</span>
            <span className="text-lg font-bold text-brass-400">{fmtR(stats.sales_mtd)}</span>
          </div>
          {stats.target > 0 && (
            <>
              <div className="mt-2.5 h-1.5 rounded-full bg-corp-700">
                <div className="h-1.5 rounded-full bg-brass-500" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-slate-400">{Math.round(pct)}% of {fmtR(stats.target)} monthly target</div>
            </>
          )}
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-corp-700 pt-3 text-center">
            <div><div className="text-base font-bold">{stats.visits_done}</div><div className="text-[10px] uppercase tracking-wide text-slate-400">Visits done</div></div>
            <div><div className="text-base font-bold">{stats.orders_today}</div><div className="text-[10px] uppercase tracking-wide text-slate-400">Orders today</div></div>
            <div><div className="text-base font-bold">{fmtR(stats.sales_today)}</div><div className="text-[10px] uppercase tracking-wide text-slate-400">Sales today</div></div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Scheduled visits</h2>
            <span className="text-[11px] font-medium text-slate-400">{visits.length} planned</span>
          </div>
          <div className="space-y-2">
            {visits.map((v, i) => (
              <div key={v.id} className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-corp-700 text-xs font-bold text-corp-900">
                    {v.route_order || i + 1}
                  </div>
                  <Link to={`/mobile/customers/${v.customer_id}`} className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-corp-900">{v.customer_name}{v.customer_code && <span className="ml-1 font-normal text-slate-400">({v.customer_code})</span>}</div>
                    <div className="text-xs text-slate-400">{v.city} · {v.purpose}</div>
                  </Link>
                  <VisitStatusBadge status={v.status} />
                </div>

                <button
                  onClick={() => setTaskSheet({ customer_id: v.customer_id, customer_name: v.customer_name })}
                  className={`mt-2 flex w-full items-center justify-between rounded px-3 py-2 text-left text-xs ${
                    v.overdue_task_count > 0
                      ? 'bg-red-50 text-red-700'
                      : v.open_task_count > 0
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-slate-50 text-slate-400'
                  }`}
                >
                  {v.open_task_count > 0
                    ? <span>{v.open_task_count} open task{v.open_task_count === 1 ? '' : 's'}{v.overdue_task_count > 0 ? ` · ${v.overdue_task_count} overdue` : ''}</span>
                    : <span>Add follow-up task</span>}
                  <span className="font-semibold">›</span>
                </button>

                {v.ai_alert_count > 0 && (
                  <Link to={`/mobile/customers/${v.customer_id}`}
                    className="mt-1.5 flex w-full items-center justify-between rounded border border-brass-500/40 bg-corp-950/5 px-3 py-2 text-left text-xs text-corp-900">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {v.ai_alert_count} intelligence alert{v.ai_alert_count > 1 ? 's' : ''}
                      {v.top_ai_alert && <span className="ml-1 font-normal text-slate-500">— {v.top_ai_alert.action}</span>}
                    </span>
                    <span className="ml-2 shrink-0 font-semibold">›</span>
                  </Link>
                )}
              </div>
            ))}
            {visits.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
                No visits scheduled for this date.<br />
                <Link to="/mobile/customers" className="mt-1 inline-block font-semibold text-corp-900 underline">Browse customers →</Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {showDatePicker && (
        <DatePicker value={displayDate} onChange={setSelectedDate} onClose={() => setShowDatePicker(false)} label="Select date" />
      )}
      {taskSheet && (
        <CustomerTasksSheet
          customerId={taskSheet.customer_id}
          customerName={taskSheet.customer_name}
          onClose={() => setTaskSheet(null)}
          onChanged={loadDay}
        />
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
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.get('/orders').then(setRows).catch(console.error);
  }, []);

  return (
    <>
      <MobileHeader title="My orders" />
      <div className="p-4 space-y-2">
        {!rows ? <Spinner /> : rows.map((o) => (
          <div key={o.id} className="card p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{o.number}</span>
              <OrderStatusBadge status={o.status} />
            </div>
            <div className="mt-0.5 flex items-center justify-between text-xs text-slate-400">
              <span>{o.customer_name} · {fmtDateTime(o.order_date)}</span>
              <span className="text-sm font-semibold text-slate-700">{fmtR(o.total)}</span>
            </div>
          </div>
        ))}
        {rows && rows.length === 0 && <div className="card"><EmptyState icon="🧾">No orders yet.</EmptyState></div>}
      </div>
    </>
  );
}
