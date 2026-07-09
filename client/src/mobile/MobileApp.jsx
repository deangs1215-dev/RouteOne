// Mobile-first rep app: today's route, customer list, order capture.
// Works offline: data comes from the sync snapshot, writes queue in the outbox.
import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, Navigate } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime, getPosition } from '../api';
import { useAuth } from '../auth';
import { Spinner, VisitStatusBadge, OrderStatusBadge } from '../components/ui';
import DatePicker from '../components/DatePicker';
import CustomerTasksSheet from '../components/CustomerTasksSheet';
import AppIcon from '../components/AppIcon';
import { onOfflineChange, getOutbox, flushOutbox, refreshSnapshot } from '../offline';
import RepCustomer from './RepCustomer';
import RepOrderCapture from './RepOrderCapture';
import OrderDetail from './OrderDetail';
import QuoteDetail from './QuoteDetail';
import FormDetail from './FormDetail';
import Tasks from './Tasks';

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
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-slate-100">
      <OfflineBanner />
      <div className="flex-1 pb-20">
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/customers" element={<RepCustomers />} />
          <Route path="/customers/:id/order" element={<RepOrderCapture />} />
          <Route path="/customers/:id" element={<RepCustomer />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/quotes/:id" element={<QuoteDetail />} />
          <Route path="/forms/:id" element={<FormDetail />} />
          <Route path="/orders" element={<RepOrders />} />
          <Route path="/tasks" element={<Tasks />} />
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
    { to: '/mobile/tasks', label: 'Tasks', icon: 'tasks' }
  ];
  return (
    <nav className="fixed bottom-0 left-1/2 z-30 w-full max-w-md -translate-x-1/2 border-t border-slate-200 bg-white">
      <div className="grid grid-cols-4">
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end}
            className={({ isActive }) =>
              `flex flex-col items-center gap-1 py-2 text-xs font-medium ${isActive ? 'text-brand-600' : 'text-slate-400'}`}>
            <AppIcon name={i.icon} size={30} />{i.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function MobileHeader({ title, back }) {
  const { user, logout } = useAuth();
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        {back && (
          <Link to={back} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition">
            <span className="text-lg leading-none">←</span>
            <span className="hidden sm:inline">Return Back</span>
          </Link>
        )}
        <h1 className="font-bold">{title}</h1>
      </div>
      <button onClick={logout} className="text-xs text-slate-400">Sign out</button>
    </header>
  );
}

function Today() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [taskSheet, setTaskSheet] = useState(null); // { customer_id, customer_name }

  const displayDate = selectedDate || new Date().toISOString().slice(0, 10);

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

  const dateStr = new Date(displayDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

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
                    <div className="truncate font-medium">{v.customer_name}</div>
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

function RepCustomers() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.get(`/customers?q=${encodeURIComponent(q)}`).then(setRows).catch(console.error);
  }, [q]);

  return (
    <>
      <MobileHeader title="My customers" />
      <div className="p-4 space-y-3">
        <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        {!rows ? <Spinner /> : rows.map((c) => (
          <Link key={c.id} to={`/mobile/customers/${c.id}`} className="card flex items-center justify-between p-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{c.name}</div>
              {c.code && <div className="text-xs font-semibold text-brand-600">Account {c.code}</div>}
              <div className="text-xs text-slate-400">{c.city} · last order {c.last_order_at ? c.last_order_at.slice(0, 10) : 'never'}</div>
            </div>
            <span className="text-slate-300">›</span>
          </Link>
        ))}
        {rows && rows.length === 0 && <div className="card p-6 text-center text-sm text-slate-400">No customers found.</div>}
      </div>
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
        {rows && rows.length === 0 && <div className="card p-6 text-center text-sm text-slate-400">No orders yet.</div>}
      </div>
    </>
  );
}
