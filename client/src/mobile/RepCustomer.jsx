// Rep's customer view: check in / out with GPS stamps, visit notes, photos,
// field forms, quick order and quote. Visits captured with no signal are
// stored locally and logged to the server in one call when back online.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime, getPosition } from '../api';
import { Spinner, ErrorNote, GradeBadge, OrderStatusBadge, Modal, Field } from '../components/ui';
import VisitSummary from '../components/VisitSummary';
import VisitTimer, { visitDuration } from '../components/VisitTimer';
import DatePicker from '../components/DatePicker';
import TaskCreateModal from '../components/TaskCreateModal';
import TaskRescheduleModal from '../components/TaskRescheduleModal';
import { queueWrite } from '../offline';
import { MobileHeader } from './MobileApp';

const offlineVisitKey = (custId) => `fsp_offline_visit_${custId}`;

// Green "view details" affordance shown on each clickable activity card.
function DetailsLink() {
  return (
    <div className="mt-2 flex items-center justify-end gap-1 text-xs font-semibold text-emerald-600">
      <span>Details</span>
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
        <path fillRule="evenodd" d="M7.293 4.293a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414-1.414L11.586 10 7.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
      </svg>
    </div>
  );
}

// Collapsible section used by each Activity history group (Visits, Orders,
// Quotes, Forms). Starts collapsed; the chevron rotates and the full list
// (not just the preview slice) renders once expanded.
function CollapsibleSection({ title, count, children }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-center justify-between text-xs font-bold uppercase text-slate-500 tracking-wide">
        <span>{title} <span className="text-slate-400 font-semibold normal-case">({count})</span></span>
        <svg viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  );
}

// Straight-line metres between two GPS points, for the "you seem far away" check.
function distanceM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
}

export default function RepCustomer() {
  const { id } = useParams();
  const [c, setC] = useState(null);
  const [activeVisit, setActiveVisit] = useState(null);
  const [offlineVisit, setOfflineVisit] = useState(null); // { check_in_at, lat, lng }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState('order');
  const [photos, setPhotos] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [fillingForm, setFillingForm] = useState(null);
  const [formsDone, setFormsDone] = useState([]);
  const [intel, setIntel] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openVisit, setOpenVisit] = useState(null); // rep's current in-progress visit (any customer)
  const [historyFrom, setHistoryFrom] = useState(null); // activity history date filter: show items on/before this date
  const [showHistoryDatePicker, setShowHistoryDatePicker] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [reschedulingTask, setReschedulingTask] = useState(null);
  const [taskBusyId, setTaskBusyId] = useState(null);

  const loadTasks = () => api.get(`/customers/${id}/tasks`).then(setTasks).catch(() => {});

  const markTaskDone = async (taskId) => {
    setTaskBusyId(taskId);
    try {
      await api.put(`/tasks/${taskId}`, { status: 'done' });
      await loadTasks();
    } catch (e) {
      setError(e.message);
    } finally {
      setTaskBusyId(null);
    }
  };

  const load = async () => {
    const cust = await api.get(`/customers/${id}`);
    setC(cust);
    const open = (cust.recent_visits || []).find((v) => v.status === 'in_progress');
    const planned = (cust.recent_visits || []).find((v) => v.status === 'planned' && v.planned_date === new Date().toISOString().slice(0, 10));
    setActiveVisit(open || planned || null);
    if (open) api.get(`/visits/${open.id}/photos`).then(setPhotos).catch(() => {});
    try { setOfflineVisit(JSON.parse(localStorage.getItem(offlineVisitKey(id)))); } catch { setOfflineVisit(null); }
  };
  useEffect(() => {
    load().catch(console.error);
    api.get('/form-templates').then((ts) => setTemplates(ts.filter((t) => t.active))).catch(() => {});
    api.get(`/intel/customer/${id}`).then(setIntel).catch(() => {});
    api.get('/visits/open').then(setOpenVisit).catch(() => {});
    loadTasks();
  }, [id]);

  if (!c) return <><MobileHeader title="Customer" back="/mobile/customers" /><Spinner /></>;

  const checkedIn = activeVisit?.status === 'in_progress' || !!offlineVisit;
  const visitParam = activeVisit?.status === 'in_progress' ? `?visit=${activeVisit.id}` : '';

  // An open visit at ANOTHER customer blocks checking in here. Cover both the
  // online case (server) and an offline visit parked under a different key.
  const offlineElsewhere = Object.keys(localStorage)
    .find((k) => k.startsWith('fsp_offline_visit_') && k !== offlineVisitKey(id) && localStorage.getItem(k));
  const openElsewhere = (openVisit && openVisit.customer_id !== Number(id))
    ? { id: openVisit.customer_id, name: openVisit.customer_name }
    : (offlineElsewhere ? { id: offlineElsewhere.replace('fsp_offline_visit_', ''), name: 'another customer' } : null);

  const checkIn = async () => {
    if (openElsewhere) {
      setError(`You're still checked in at ${openElsewhere.name}. Check out there first.`);
      return;
    }
    setBusy(true);
    setError('');
    const pos = await getPosition();
    // GPS honesty prompt: reps can still check in remotely, but knowingly.
    const dist = distanceM(pos.lat, pos.lng, c.lat, c.lng);
    if (dist != null && dist > 500) {
      const ok = window.confirm(`You appear to be ${(dist / 1000).toFixed(1)} km from ${c.name}. Check in anyway?`);
      if (!ok) { setBusy(false); return; }
    }
    try {
      await api.post('/visits/check-in', { visit_id: activeVisit?.id, customer_id: c.id, ...pos });
      await load();
    } catch (e) {
      if (e.isNetworkError) {
        // No signal: track the visit locally; it's logged in full at check-out.
        const record = { check_in_at: new Date().toISOString().slice(0, 19).replace('T', ' '), ...pos };
        localStorage.setItem(offlineVisitKey(id), JSON.stringify(record));
        setOfflineVisit(record);
      } else {
        setError(e.message);
        // e.g. a 409 "checked in elsewhere" — refresh so the block banner shows.
        api.get('/visits/open').then(setOpenVisit).catch(() => {});
      }
    }
    setBusy(false);
  };

  const checkOut = async () => {
    setBusy(true);
    setError('');
    const pos = await getPosition();
    const now = new Date().toISOString().slice(0, 19).replace(' ', 'T').replace('T', ' ');
    if (offlineVisit) {
      // Entire visit was offline: queue one consolidated record.
      queueWrite('POST', '/visits/log-offline', {
        customer_id: Number(id),
        check_in_at: offlineVisit.check_in_at, check_in_lat: offlineVisit.lat, check_in_lng: offlineVisit.lng,
        check_out_at: now, check_out_lat: pos.lat, check_out_lng: pos.lng,
        notes: notes || null, outcome
      });
      localStorage.removeItem(offlineVisitKey(id));
      setOfflineVisit(null);
      setNotes('');
      setBusy(false);
      return;
    }
    try {
      await api.post(`/visits/${activeVisit.id}/check-out`, { ...pos, notes: notes || null, outcome });
      setNotes('');
      await load();
    } catch (e) {
      if (e.isNetworkError) {
        // Checked in online but signal died: queue the check-out itself.
        queueWrite('POST', `/visits/${activeVisit.id}/check-out`, { ...pos, notes: notes || null, outcome });
        setActiveVisit(null);
        setNotes('');
      } else setError(e.message);
    }
    setBusy(false);
  };

  const addPhoto = (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      if (!activeVisit || activeVisit.status !== 'in_progress') return;
      try {
        const photo = await api.post(`/visits/${activeVisit.id}/photos`, { data_url: dataUrl });
        setPhotos((ps) => [...ps, photo]);
      } catch (e) {
        if (e.isNetworkError) {
          queueWrite('POST', `/visits/${activeVisit.id}/photos`, { data_url: dataUrl });
          setPhotos((ps) => [...ps, { id: `local-${Date.now()}`, path: dataUrl, queued: true }]);
        } else setError(e.message);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <MobileHeader title={c.name} back="/mobile/customers" />
      <div className="space-y-4 p-4">
        <ErrorNote error={error} />
        {c._offline && (
          <div className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-white">📡 Offline — showing cached customer data.</div>
        )}

        <div className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 font-semibold">{c.name} <GradeBadge grade={c.classification} /></div>
              {c.code && <div className="mt-0.5 text-xs font-semibold text-brand-600">Account {c.code}</div>}
              <div className="mt-0.5 text-xs text-slate-400">{c.address}{c.city ? `, ${c.city}` : ''}</div>
              <div className="text-xs text-slate-400">{c.contact_name} · {c.phone}</div>
            </div>
            {c.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`} className="btn-secondary px-3">📞</a>}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-center">
            <div><div className="text-sm font-bold">{fmtR(c.stats.sales_mtd)}</div><div className="text-[10px] uppercase text-slate-400">MTD</div></div>
            <div><div className="text-sm font-bold">{c.stats.order_count}</div><div className="text-[10px] uppercase text-slate-400">orders</div></div>
            <div><div className="text-sm font-bold">{c.payment_terms}</div><div className="text-[10px] uppercase text-slate-400">terms</div></div>
          </div>
          {c.status === 'on_hold' && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
              ⚠ Account on hold — orders are blocked (quotes still allowed).
            </div>
          )}
        </div>

        {/* + Add: order / quote / field forms — the on-site action menu */}
        <div>
          <button className="btn-primary flex w-full items-center justify-center gap-1 py-3" onClick={() => setMenuOpen((o) => !o)}>
            ＋ Add {menuOpen ? '▲' : '▼'}
          </button>
          {menuOpen && (
            <div className="card mt-2 max-h-96 divide-y divide-slate-100 overflow-y-auto p-0">
              <Link to={`/mobile/customers/${c.id}/order${visitParam}`} className="block px-4 py-3 text-sm hover:bg-slate-50">🧾 New order</Link>
              <Link to={`/mobile/customers/${c.id}/order${visitParam ? visitParam + '&' : '?'}kind=quote`} className="block px-4 py-3 text-sm hover:bg-slate-50">📄 New quote</Link>
              {templates.length > 0 && <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase text-slate-400">Forms</div>}
              {templates.map((t) => (
                <button key={t.id} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-slate-50"
                  onClick={() => { setFillingForm(t); setMenuOpen(false); }}>
                  <span>{t.name}</span>
                  <span className="text-xs">{formsDone.includes(t.id) ? '✅' : '›'}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Visit flow */}
        {!checkedIn ? (
          openElsewhere ? (
            <div className="card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <div className="font-semibold">✋ Check out first</div>
              <div className="mt-1">You're still checked in at <span className="font-semibold">{openElsewhere.name}</span>. Finish and check out there before starting a new visit.</div>
              <Link to={`/mobile/customers/${openElsewhere.id}`} className="btn-secondary mt-3 block py-2 text-center">Go to {openElsewhere.name}</Link>
            </div>
          ) : (
            <button className="btn w-full py-3 bg-emerald-600 text-white hover:bg-emerald-700" onClick={checkIn} disabled={busy}>
              {busy ? 'Checking in…' : `📍 Check in${activeVisit ? '' : ' (unplanned visit)'}`}
            </button>
          )
        ) : (
          <div className="space-y-3">
            <div className="card p-4">
              <div className="text-sm font-semibold text-emerald-600">
                ✓ Checked in {fmtDateTime(offlineVisit ? offlineVisit.check_in_at : activeVisit.check_in_at)}
                {offlineVisit && <span className="ml-1 text-xs font-normal text-slate-400">(offline)</span>}
              </div>
              <div className="mt-3 flex flex-col items-center rounded-lg bg-emerald-50 py-3">
                <VisitTimer since={offlineVisit ? offlineVisit.check_in_at : activeVisit.check_in_at}
                  className="text-3xl font-extrabold text-emerald-700" />
                <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-600">Time on site</div>
              </div>
            </div>

            {/* Visit activity summary */}
            {activeVisit?.status === 'in_progress' && <VisitSummary visitId={activeVisit.id} />}

            <div className="card space-y-3 p-4">
              {/* Photos (needs a server-side visit) */}
            {activeVisit?.status === 'in_progress' && (
              <div>
                <label className="label">Photos</label>
                <div className="flex flex-wrap gap-2">
                  {photos.map((p) => (
                    <img key={p.id} src={p.path} alt="" className={`h-16 w-16 rounded-lg object-cover border ${p.queued ? 'border-amber-300 opacity-70' : 'border-slate-200'}`} />
                  ))}
                  <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 text-xl text-slate-400 hover:border-brand-500">
                    📷
                    <input type="file" accept="image/*" capture="environment" className="hidden"
                      onChange={(e) => e.target.files[0] && addPhoto(e.target.files[0])} />
                  </label>
                </div>
              </div>
            )}

            <div>
              <label className="label">Visit notes</label>
              <textarea className="input" rows="2" value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Stock levels, feedback, complaints…" />
            </div>
            <div>
              <label className="label">Outcome</label>
              <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="order">Order placed</option>
                <option value="no_order">No order</option>
                <option value="follow_up">Follow-up needed</option>
                <option value="other">Other</option>
              </select>
            </div>
            <button className="btn-primary w-full py-3 bg-red-600 hover:bg-red-700" onClick={checkOut} disabled={busy}>
              {busy ? 'Checking out…' : '🔴 Check out'}
            </button>
            </div>
          </div>
        )}

        {/* Selling tips from the intelligence engine */}
        {intel && (intel.suggested_products.length > 0 || intel.lapsed_products.length > 0 || intel.risk_score >= 40) && (
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-600">Selling tips</h2>
            {intel.risk_score >= 40 && (
              <div className={`mb-2 rounded-lg px-3 py-2 text-xs ${intel.risk_score >= 70 ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                Churn risk {intel.risk_score}/100 — last order {intel.last_order_at ? `${intel.recency_days} days ago` : 'never'}
                {intel.decline_pct > 0 && `, spend down ${intel.decline_pct}%`}
              </div>
            )}
            {intel.lapsed_products.length > 0 && (
              <div className="mb-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Stopped buying — win back</div>
                {intel.lapsed_products.map((p) => <div key={p.id} className="text-sm">• {p.name}</div>)}
              </div>
            )}
            {intel.suggested_products.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-400">Others buy, they don't — pitch</div>
                {intel.suggested_products.map((p) => <div key={p.id} className="text-sm">• {p.name}</div>)}
              </div>
            )}
          </div>
        )}

        {/* Outstanding tasks */}
        {(() => {
          const openTasks = tasks.filter((t) => t.status === 'open');
          if (openTasks.length === 0) {
            return (
              <button
                onClick={() => setShowCreateTask(true)}
                className="btn-primary w-full py-2 text-sm"
              >
                ✓ Add follow-up task
              </button>
            );
          }
          const today = new Date().toISOString().slice(0, 10);
          return (
            <div className="card border border-amber-200 bg-amber-50 p-4">
              <h2 className="mb-2 text-sm font-semibold text-amber-900">
                ⚠️ Outstanding tasks ({openTasks.length})
              </h2>
              <div className="space-y-2 mb-3">
                {openTasks.map((t) => {
                  const isOverdue = t.follow_up_date < today;
                  return (
                    <div key={t.id} className={`rounded-lg px-3 py-2 ${isOverdue ? 'bg-red-100 border border-red-200' : 'bg-white border border-amber-100'}`}>
                      <div className={`text-xs font-medium ${isOverdue ? 'text-red-700' : 'text-slate-700'}`}>{t.task_type}</div>
                      {t.notes && <div className="mt-0.5 text-[11px] text-slate-500">{t.notes}</div>}
                      <div className={`mt-1 text-[10px] ${isOverdue ? 'text-red-600' : 'text-slate-400'}`}>
                        {isOverdue ? `⚠ Overdue · ${fmtDate(t.follow_up_date)}` : `Due ${fmtDate(t.follow_up_date)}`}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => markTaskDone(t.id)}
                          disabled={taskBusyId === t.id}
                          className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          ✓ Done
                        </button>
                        <button
                          onClick={() => setReschedulingTask(t)}
                          className="flex-1 rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          📅 Reschedule
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() => setShowCreateTask(true)}
                className="btn-secondary w-full text-sm py-2"
              >
                + Create new task
              </button>
            </div>
          );
        })()}

        {/* Activity history: visits, orders, quotes, forms */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-600">Activity history</h2>
            <button type="button" onClick={() => setShowHistoryDatePicker(true)}
              className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium ${historyFrom ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500'}`}>
              📅 {historyFrom ? fmtDate(historyFrom) : 'All dates'}
            </button>
          </div>
          {historyFrom && (
            <button type="button" onClick={() => setHistoryFrom(null)} className="mb-3 text-xs text-brand-600 underline">
              Clear date filter
            </button>
          )}
          {(() => {
            const cutoff = historyFrom; // show items on/before this date, newest first
            const upTo = (dateStr) => !cutoff || (dateStr || '').slice(0, 10) <= cutoff;
            const visits = (c.recent_visits || []).filter((v) => v.check_in_at && upTo(v.check_in_at));
            const orders = (c.recent_orders || []).filter((o) => upTo(o.order_date));
            const quotes = (c.recent_quotes || []).filter((q) => upTo(q.quote_date));
            const forms = (c.recent_forms || []).filter((f) => upTo(f.created_at));
            const nothing = visits.length === 0 && orders.length === 0 && quotes.length === 0 && forms.length === 0;

            return (
              <div className="space-y-4">
                <CollapsibleSection title="Visits" count={visits.length}>
                  {visits.map((v) => {
                    const dur = visitDuration(v.check_in_at, v.check_out_at);
                    return (
                      <div key={`visit-${v.id}`} className="card p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{fmtDateTime(v.check_in_at)}</span>
                          {dur ? (
                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">⏱ {dur} on site</span>
                          ) : v.status === 'in_progress' ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">in progress</span>
                          ) : null}
                        </div>
                        {v.outcome && <div className="mt-0.5 text-xs text-slate-400">Outcome: {v.outcome.replace('_', ' ')}{v.rep_name ? ` · ${v.rep_name}` : ''}</div>}
                      </div>
                    );
                  })}
                </CollapsibleSection>

                <CollapsibleSection title="Orders" count={orders.length}>
                  {orders.map((o) => (
                    <Link key={`order-${o.id}`} to={`/mobile/orders/${o.id}`} className="card block p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{o.number}</span>
                        <OrderStatusBadge status={o.status} />
                      </div>
                      <div className="mt-0.5 flex justify-between text-xs text-slate-400">
                        <span>{fmtDate(o.order_date)}</span>
                        <span className="font-semibold text-slate-700">{fmtR(o.total)}</span>
                      </div>
                      <DetailsLink />
                    </Link>
                  ))}
                </CollapsibleSection>

                <CollapsibleSection title="Quotes" count={quotes.length}>
                  {quotes.map((q) => (
                    <Link key={`quote-${q.id}`} to={`/mobile/quotes/${q.id}`} className="card block p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{q.number}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${q.status === 'accepted' ? 'bg-emerald-50 text-emerald-700' : q.status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-purple-50 text-purple-700'}`}>
                          {q.status}
                        </span>
                      </div>
                      <div className="mt-0.5 flex justify-between text-xs text-slate-400">
                        <span>{fmtDate(q.quote_date)}</span>
                        <span className="font-semibold text-slate-700">{fmtR(q.total)}</span>
                      </div>
                      <DetailsLink />
                    </Link>
                  ))}
                </CollapsibleSection>

                <CollapsibleSection title="Forms & Records" count={forms.length}>
                  {forms.map((f) => (
                    <Link key={`form-${f.id}`} to={`/mobile/forms/${f.id}`} className="card block p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{f.template_name}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">submitted</span>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        {fmtDate(f.created_at)}
                      </div>
                      <DetailsLink />
                    </Link>
                  ))}
                </CollapsibleSection>

                {nothing && (
                  <div className="card p-4 text-center text-sm text-slate-400">
                    {historyFrom ? 'No activity on or before that date.' : 'No activity yet.'}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {showHistoryDatePicker && (
        <DatePicker value={historyFrom} onChange={setHistoryFrom} onClose={() => setShowHistoryDatePicker(false)}
          label="View activity from date" />
      )}

      {fillingForm && (
        <FormFillModal template={fillingForm} customerId={Number(id)}
          visitId={activeVisit?.status === 'in_progress' ? activeVisit.id : null}
          onClose={() => setFillingForm(null)}
          onDone={() => { setFormsDone((d) => [...d, fillingForm.id]); setFillingForm(null); }} />
      )}

      {showCreateTask && (
        <TaskCreateModal
          customerId={parseInt(id)}
          customerName={c.name}
          onClose={() => setShowCreateTask(false)}
          onCreated={() => {
            setShowCreateTask(false);
            loadTasks();
          }}
        />
      )}

      {reschedulingTask && (
        <TaskRescheduleModal
          task={reschedulingTask}
          onClose={() => setReschedulingTask(null)}
          onSaved={() => { setReschedulingTask(null); loadTasks(); }}
        />
      )}
    </>
  );
}

// Fill and submit one field form. Photo answers become base64 data URLs;
// the server stores them as files. Offline submissions queue in the outbox.
function FormFillModal({ template, customerId, visitId, onClose, onDone }) {
  const [data, setData] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setData((d) => ({ ...d, [key]: value }));

  const setPhoto = (key, file) => {
    const reader = new FileReader();
    reader.onload = () => set(key, reader.result);
    reader.readAsDataURL(file);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const payload = { template_id: template.id, customer_id: customerId, visit_id: visitId, data };
    try {
      await api.post('/form-submissions', payload);
      onDone();
    } catch (err) {
      if (err.isNetworkError) {
        queueWrite('POST', '/form-submissions', payload);
        onDone();
      } else {
        setError(err.message);
        setBusy(false);
      }
    }
  };

  return (
    <Modal title={template.name} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote error={error} />
        {template.description && <p className="text-xs text-slate-400">{template.description}</p>}
        {template.fields.map((f) => (
          <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
            {f.type === 'text' && <input className="input" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required} />}
            {f.type === 'number' && <input className="input" type="number" step="any" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required} />}
            {f.type === 'select' && (
              <select className="input" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required}>
                <option value="">Select…</option>
                {(f.options || []).map((o) => <option key={o}>{o}</option>)}
              </select>
            )}
            {f.type === 'checkbox' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!data[f.key]} onChange={(e) => set(f.key, e.target.checked)} /> Yes
              </label>
            )}
            {f.type === 'photo' && (
              <div>
                {data[f.key] && <img src={data[f.key]} alt="" className="mb-2 max-h-40 rounded-lg border border-slate-200" />}
                <input type="file" accept="image/*" capture="environment" className="text-xs"
                  onChange={(e) => e.target.files[0] && setPhoto(f.key, e.target.files[0])} />
              </div>
            )}
          </Field>
        ))}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit form'}</button>
        </div>
      </form>
    </Modal>
  );
}
