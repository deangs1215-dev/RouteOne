// Rep's customer view: check in / out with GPS stamps, visit notes, photos,
// field forms, quick order and quote. Visits captured with no signal are
// stored locally and logged to the server in one call when back online.
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime, getPosition, todayISO, toLocalDateTime } from '../api';
import { Spinner, ErrorNote, GradeBadge, OrderStatusBadge, Modal, Field, EmptyState } from '../components/ui';
import VisitSummary from '../components/VisitSummary';
import VisitTimer, { visitDuration } from '../components/VisitTimer';
import DatePicker from '../components/DatePicker';
import TaskCreateModal from '../components/TaskCreateModal';
import TaskRescheduleModal from '../components/TaskRescheduleModal';
import { queueWrite } from '../offline';
import { MobileHeader } from './MobileApp';

const offlineVisitKey = (custId) => `fsp_offline_visit_${custId}`;

// Prospects have no order history, so the intelligence engine's product/churn
// tips don't apply - these are general new-business tips instead, one per
// prospect (rotates through the list as the customer id increments).
const PROSPECT_TIPS = [
  'Ask what they currently buy and from which supplier — knowing the incumbent tells you where to compete.',
  'Find out their biggest pain point with their current ingredients supplier: price, delivery, quality, or service.',
  'Bring a small sample of your bestselling product to a first visit — let them taste or test it.',
  'Ask about their production volume so you can recommend the right pack sizes.',
  'Find out who makes the purchasing decision — owner, head baker, or procurement.',
  'Ask about seasonal peaks (holidays, weekends) so you can plan stock and follow-up timing.',
  'Offer a no-obligation price comparison on their top 3 ingredients.',
  "Leave a product catalogue and your contact card even if they're not ready to switch today.",
  'Ask what would make them consider changing suppliers.',
  'Note their current shelf or storage space — it hints at order volume potential.',
  'Ask about delivery frequency and minimum order requirements they need.',
  "Find out if they've had any recent quality or stock issues with their current supplier.",
  'Mention any current promotions or introductory pricing for new accounts.',
  'Ask if they\'d be open to a trial order on one or two products first.',
  'Note their business hours so you know the best time to visit or call.',
  'Ask about their menu or product range to identify which ingredients they\'d need most.',
  'Find out if they belong to a buying group or franchise with existing supplier agreements.',
  'Compliment something specific about their shop or products — build rapport before pitching.',
  'Ask how long they\'ve been in business and how it\'s grown.',
  'Offer to set up a tasting or demo day with one of your bakery specialists.',
  'Find out their payment terms preference — cash, account, or COD.',
  'Ask about upcoming expansion plans that might increase their ingredient needs.',
  'Note competitor delivery vehicles or branded packaging on-site — useful intel.',
  'Follow up within 48 hours of a first visit while you\'re still top of mind.',
  'Ask what "great service" looks like to them, then show how you\'ll deliver it.',
  'Bring a one-page comparison sheet showing your key products vs generic alternatives.',
  'Ask if they\'d like to be added to your route for a regular check-in visit.',
  'Find out if they do wholesale or catering as well as retail — it changes volume needs.',
  'Offer a small starter hamper of samples to try over a week before committing.',
  'Always leave with a clear next step — a callback date, a quote, or a second visit.'
];

// Rep-captured field intel fields (not from SYSPRO). label + placeholder drive
// both the read-only card and the edit modal. `long` renders a textarea.
const FIELD_NOTE_FIELDS = [
  { key: 'current_supplier', label: 'Current supplier', placeholder: 'Who they buy from now' },
  { key: 'decision_maker', label: 'Decision maker', placeholder: 'Who signs off orders (name / role)' },
  { key: 'best_visit_time', label: 'Best time to visit', placeholder: 'e.g. weekday mornings before 10am' },
  { key: 'delivery_notes', label: 'Delivery / access notes', placeholder: 'Back entrance, gate code, parking…', long: true },
  { key: 'products_of_interest', label: 'Products of interest', placeholder: 'What to pitch / what they asked about', long: true },
  { key: 'competitor_notes', label: 'Competitor activity', placeholder: 'Rival branding or vehicles seen on-site', long: true },
  { key: 'general_notes', label: 'General notes', placeholder: 'Rapport, owner name, preferences…', long: true }
];

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

export default function RepCustomer({ base = '/mobile' }) {
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
  const [salesPushes, setSalesPushes] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [checkInMenuOpen, setCheckInMenuOpen] = useState(false);
  const [checkInAddressPrompt, setCheckInAddressPrompt] = useState(null); // 'onsite_manual' | 'offsite'
  const [openVisit, setOpenVisit] = useState(null); // rep's current in-progress visit (any customer)
  const [historyFrom, setHistoryFrom] = useState(null); // activity history date filter: show items on/before this date
  const [showHistoryDatePicker, setShowHistoryDatePicker] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [reschedulingTask, setReschedulingTask] = useState(null);
  const [taskBusyId, setTaskBusyId] = useState(null);
  const [tab, setTab] = useState('overview'); // 'overview' or 'timeline'
  const [showFieldNotes, setShowFieldNotes] = useState(false);
  const [showOnsiteDetails, setShowOnsiteDetails] = useState(false);
  const [timeline, setTimeline] = useState(null);
  const [timelineVisit, setTimelineVisit] = useState(null); // visit id shown in the summary modal
  const [timelineTask, setTimelineTask] = useState(null); // task item shown in the detail modal
  const [timelineInvoice, setTimelineInvoice] = useState(null); // invoice item shown in the detail modal

  const loadTasks = () => api.get(`/customers/${id}/tasks`).then(setTasks).catch(() => {});
  const loadTimeline = () => api.get(`/customers/${id}/timeline`).then(setTimeline).catch(() => {});

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
    const planned = (cust.recent_visits || []).find((v) => v.status === 'planned' && v.planned_date === todayISO());
    const av = open || planned || null;
    setActiveVisit(av);
    // Load existing photos for today's visit (whether checked-in or just planned).
    if (av?.id) api.get(`/visits/${av.id}/photos`).then(setPhotos).catch(() => setPhotos([]));
    else setPhotos([]);
    try { setOfflineVisit(JSON.parse(localStorage.getItem(offlineVisitKey(id)))); } catch { setOfflineVisit(null); }
  };
  useEffect(() => {
    load().catch(console.error);
    api.get('/form-templates').then((ts) => setTemplates(ts.filter((t) => t.active))).catch(() => {});
    api.get(`/intel/customer/${id}`).then(setIntel).catch(() => {});
    api.get('/sales-pushes/active').then(setSalesPushes).catch(() => {});
    api.get('/visits/open').then(setOpenVisit).catch(() => {});
    loadTasks();
  }, [id]);

  if (!c) return <><MobileHeader title="Customer" back={`${base}/customers`} /><Spinner /></>;

  const checkedIn = activeVisit?.status === 'in_progress' || !!offlineVisit;
  const visitParam = activeVisit?.status === 'in_progress' ? `?visit=${activeVisit.id}` : '';

  // An open visit at ANOTHER customer blocks checking in here. Cover both the
  // online case (server) and an offline visit parked under a different key.
  const offlineElsewhere = Object.keys(localStorage)
    .find((k) => k.startsWith('fsp_offline_visit_') && k !== offlineVisitKey(id) && localStorage.getItem(k));
  const openElsewhere = (openVisit && openVisit.customer_id !== Number(id))
    ? { id: openVisit.customer_id, name: openVisit.customer_name }
    : (offlineElsewhere ? { id: offlineElsewhere.replace('fsp_offline_visit_', ''), name: 'another customer' } : null);

  const checkIn = async (checkInType = 'onsite', checkInAddress = null) => {
    if (openElsewhere) {
      setError(`You're still checked in at ${openElsewhere.name}. Check out there first.`);
      return;
    }
    setBusy(true);
    setError('');
    const pos = await getPosition();
    // GPS honesty prompt only applies to a straight onsite check-in - manual
    // address / offsite are the rep knowingly declaring a different location.
    if (checkInType === 'onsite') {
      const dist = distanceM(pos.lat, pos.lng, c.lat, c.lng);
      if (dist != null && dist > 500) {
        const ok = window.confirm(`You appear to be ${(dist / 1000).toFixed(1)} km from ${c.name}. Check in anyway?`);
        if (!ok) { setBusy(false); return; }
      }
    }
    try {
      await api.post('/visits/check-in', {
        visit_id: activeVisit?.id, customer_id: c.id,
        check_in_type: checkInType, check_in_address: checkInAddress, ...pos
      });
      await load();
    } catch (e) {
      if (e.isNetworkError) {
        // No signal: track the visit locally; it's logged in full at check-out.
        const record = {
          check_in_at: toLocalDateTime(),
          check_in_type: checkInType, check_in_address: checkInAddress, ...pos
        };
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
    const now = toLocalDateTime();
    if (offlineVisit) {
      // Entire visit was offline: queue one consolidated record.
      queueWrite('POST', '/visits/log-offline', {
        customer_id: Number(id),
        check_in_at: offlineVisit.check_in_at, check_in_lat: offlineVisit.lat, check_in_lng: offlineVisit.lng,
        check_in_type: offlineVisit.check_in_type, check_in_address: offlineVisit.check_in_address,
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

  // Downscale + JPEG-compress on the device before upload so photos stay small
  // (~200-400 KB instead of multi-MB), saving storage and mobile data.
  const compressImage = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1280; // longest edge
        let { width, height } = img;
        if (width > height && width > MAX) { height = Math.round(height * MAX / width); width = MAX; }
        else if (height > MAX) { width = Math.round(width * MAX / height); height = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });

  const addPhoto = async (file) => {
    if (!activeVisit?.id) { setError('Check in to this customer first to add photos.'); return; }
    if (photos.length >= 10) { setError('Maximum 10 photos per visit.'); return; }
    setError('');
    setBusy(true);
    try {
      const dataUrl = await compressImage(file);
      try {
        const photo = await api.post(`/visits/${activeVisit.id}/photos`, { data_url: dataUrl });
        setPhotos((ps) => [...ps, photo]);
      } catch (e) {
        if (e.isNetworkError) {
          queueWrite('POST', `/visits/${activeVisit.id}/photos`, { data_url: dataUrl });
          setPhotos((ps) => [...ps, { id: `local-${Date.now()}`, path: dataUrl, queued: true }]);
        } else setError(e.message);
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const deletePhoto = async (photo) => {
    if (!window.confirm('Delete this photo?')) return;
    // Not-yet-synced local photo: just drop it from the list.
    if (photo.queued || String(photo.id).startsWith('local-')) {
      setPhotos((ps) => ps.filter((p) => p.id !== photo.id));
      return;
    }
    try {
      await api.del(`/visits/${activeVisit.id}/photos/${photo.id}`);
      setPhotos((ps) => ps.filter((p) => p.id !== photo.id));
    } catch (e) {
      if (e.isNetworkError) {
        queueWrite('DELETE', `/visits/${activeVisit.id}/photos/${photo.id}`);
        setPhotos((ps) => ps.filter((p) => p.id !== photo.id));
      } else setError(e.message);
    }
  };

  return (
    <>
      <MobileHeader title={c.name} back={`${base}/customers`} />
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
            {(c.onsite_phone || c.phone) && (
              <a href={`tel:${(c.onsite_phone || c.phone).replace(/\s/g, '')}`} className="btn-secondary px-3">📞</a>
            )}
          </div>

          {/* Onsite details — rep-captured, used when SYSPRO's info is wrong. */}
          {(() => {
            const hasOnsite = c.onsite_name || c.onsite_contact ||
              c.onsite_phone || c.onsite_cell || c.onsite_vat || c.onsite_address || c.onsite_lat != null;
            return (
              <>
                {hasOnsite && (
                  <div className="mt-3 rounded-lg bg-sky-50 border border-sky-100 px-3 py-2 text-xs space-y-0.5">
                    <div className="font-semibold text-sky-700">📍 Onsite details</div>
                    {c.onsite_name && <div className="text-slate-600">{c.onsite_name}</div>}
                    {c.onsite_contact && <div className="whitespace-pre-line text-slate-600">👤 {c.onsite_contact}</div>}
                    {c.onsite_phone && <div className="text-slate-600">☎ {c.onsite_phone}</div>}
                    {c.onsite_cell && <div className="text-slate-600">📱 {c.onsite_cell}</div>}
                    {c.onsite_vat && <div className="text-slate-600">VAT: {c.onsite_vat}</div>}
                    {c.onsite_address && <div className="text-slate-600">{c.onsite_address}</div>}
                    {c.onsite_lat != null && <div className="text-slate-400">Pin: {c.onsite_lat.toFixed(5)}, {c.onsite_lng.toFixed(5)}</div>}
                  </div>
                )}
                <button type="button" onClick={() => setShowOnsiteDetails(true)}
                  className="mt-3 w-full rounded-lg border border-slate-200 py-2 text-xs font-semibold text-brand-600 hover:bg-slate-50">
                  {hasOnsite ? 'Edit onsite details' : '✏️ Add onsite details'}
                </button>
              </>
            );
          })()}
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

        {/* Tab navigation */}
        <div className="flex gap-2 border-b border-slate-200">
          <button
            onClick={() => setTab('overview')}
            className={`flex-1 px-3 py-2 text-xs font-semibold border-b-2 transition ${tab === 'overview' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400'}`}
          >
            Overview
          </button>
          <button
            onClick={() => { setTab('timeline'); if (!timeline) loadTimeline(); }}
            className={`flex-1 px-3 py-2 text-xs font-semibold border-b-2 transition ${tab === 'timeline' ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-400'}`}
          >
            Timeline
          </button>
        </div>

        {tab === 'overview' && (
          <>
        {/* + Add: order / quote / field forms — the on-site action menu */}
        <div>
          <button className="btn-primary flex w-full items-center justify-center gap-1 py-3" onClick={() => setMenuOpen((o) => !o)}>
            ＋ Add {menuOpen ? '▲' : '▼'}
          </button>
          {menuOpen && (
            <div className="card mt-2 max-h-96 divide-y divide-slate-100 overflow-y-auto p-0">
              <Link to={`${base}/customers/${c.id}/order${visitParam}`} className="block px-4 py-3 text-sm hover:bg-slate-50">🧾 New order</Link>
              <Link to={`${base}/customers/${c.id}/order${visitParam ? visitParam + '&' : '?'}kind=quote`} className="block px-4 py-3 text-sm hover:bg-slate-50">📄 New quote</Link>
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
              <Link to={`${base}/customers/${openElsewhere.id}`} className="btn-secondary mt-3 block py-2 text-center">Go to {openElsewhere.name}</Link>
            </div>
          ) : (
            <div>
              <button
                className="btn w-full py-3 bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-1"
                onClick={() => setCheckInMenuOpen((o) => !o)}
                disabled={busy}
              >
                {busy ? 'Checking in…' : <>📍 Check in{activeVisit ? '' : ' (unplanned visit)'} {checkInMenuOpen ? '▲' : '▼'}</>}
              </button>
              {checkInMenuOpen && !busy && (
                <div className="card mt-2 divide-y divide-slate-100 p-0">
                  <button type="button" className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-50"
                    onClick={() => { setCheckInMenuOpen(false); checkIn('onsite'); }}>
                    <div className="font-medium">📍 Onsite</div>
                    <div className="text-xs text-slate-400">Using {c.name}'s address on record</div>
                  </button>
                  <button type="button" className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-50"
                    onClick={() => { setCheckInMenuOpen(false); setCheckInAddressPrompt('onsite_manual'); }}>
                    <div className="font-medium">📍 Onsite (manual address)</div>
                    <div className="text-xs text-slate-400">SYSPRO's address is wrong — enter the correct one</div>
                  </button>
                  <button type="button" className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-50"
                    onClick={() => { setCheckInMenuOpen(false); setCheckInAddressPrompt('offsite'); }}>
                    <div className="font-medium">☕ Offsite</div>
                    <div className="text-xs text-slate-400">Meeting them elsewhere — coffee shop, etc.</div>
                  </button>
                </div>
              )}
            </div>
          )
        ) : (
          <div className="space-y-3">
            <div className="card p-4">
              <div className="text-sm font-semibold text-emerald-600">
                ✓ Checked in {fmtDateTime(offlineVisit ? offlineVisit.check_in_at : activeVisit.check_in_at)}
                {offlineVisit && <span className="ml-1 text-xs font-normal text-slate-400">(offline)</span>}
              </div>
              {(() => {
                const type = offlineVisit ? offlineVisit.check_in_type : activeVisit.check_in_type;
                const address = offlineVisit ? offlineVisit.check_in_address : activeVisit.check_in_address;
                if (type === 'offsite') return <div className="mt-1 text-xs text-slate-500">☕ Offsite{address ? ` — ${address}` : ''}</div>;
                if (type === 'onsite_manual') return <div className="mt-1 text-xs text-slate-500">📍 Manual address{address ? ` — ${address}` : ''}</div>;
                return null;
              })()}
              <div className="mt-3 flex flex-col items-center rounded-lg bg-emerald-50 py-3">
                <VisitTimer since={offlineVisit ? offlineVisit.check_in_at : activeVisit.check_in_at}
                  className="text-3xl font-extrabold text-emerald-700" />
                <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-600">Time on site</div>
              </div>
            </div>

            {/* Visit activity summary */}
            {activeVisit?.status === 'in_progress' && <VisitSummary visitId={activeVisit.id} />}

            <div className="card space-y-3 p-4">
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

        {/* Field notes — rep-captured intel not held in SYSPRO. */}
        {(() => {
          const notes = c.intel_notes;
          const filled = notes && FIELD_NOTE_FIELDS.some((f) => notes[f.key]);
          return (
            <div className="card p-4">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-600">📝 Field notes</h2>
                <button type="button" className="text-xs font-semibold text-brand-600" onClick={() => setShowFieldNotes(true)}>
                  {filled ? 'Edit' : '+ Add'}
                </button>
              </div>
              {filled ? (
                <div className="space-y-2">
                  {FIELD_NOTE_FIELDS.filter((f) => notes[f.key]).map((f) => (
                    <div key={f.key}>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{f.label}</div>
                      <div className="whitespace-pre-line text-sm text-slate-700">{notes[f.key]}</div>
                    </div>
                  ))}
                  {notes.updated_by_name && (
                    <div className="pt-1 text-[10px] text-slate-400">Last updated by {notes.updated_by_name}</div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  Capture what SYSPRO doesn't hold — current supplier, decision maker, access notes and more.
                </p>
              )}
            </div>
          );
        })()}

        {/* Prospect: no order history to base tips on, so rotate a general
            new-business tip instead - one per prospect, picked off their id. */}
        {c.status === 'prospect' && (
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-600">New prospect tip</h2>
            <div className="text-sm text-slate-700">💡 {PROSPECT_TIPS[c.id % PROSPECT_TIPS.length]}</div>
          </div>
        )}

        {/* Selling tips from the intelligence engine, plus any manager-broadcast
            sales push (not customer-specific — see sales-pushes.routes.js).
            Shows once either has loaded, so a push doesn't wait on intel. */}
        {c.status !== 'prospect' && (salesPushes.length > 0 || (intel && (intel.suggested_products.length > 0 || intel.lapsed_products.length > 0 || intel.risk_score >= 40))) && (
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-600">Selling tips</h2>
            {salesPushes.map((p) => (
              <div key={p.id} className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
                📢 {p.message}
              </div>
            ))}
            {/* Risk banner for the 40-69 band; at 70+ the AI alerts card below carries it. */}
            {intel && intel.risk_score >= 40 && !intel.actions?.some((a) => a.type === 'churn') && (
              <div className={`mb-2 rounded-lg px-3 py-2 text-xs ${intel.risk_score >= 70 ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                Churn risk {intel.risk_score}/100 — last order {intel.last_order_at ? `${intel.recency_days} days ago` : 'never'}
                {intel.decline_pct > 0 && `, spend down ${intel.decline_pct}%`}
              </div>
            )}
            {intel && intel.lapsed_products.length > 0 && (
              <div className="mb-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Stopped buying — win back</div>
                {intel.lapsed_products.map((p) => <div key={p.id} className="text-sm">• {p.name}</div>)}
              </div>
            )}
            {intel && intel.suggested_products.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase text-slate-400">Others buy, they don't — pitch</div>
                {intel.suggested_products.map((p) => <div key={p.id} className="text-sm">• {p.name}</div>)}
              </div>
            )}
          </div>
        )}

        {/* Sales AI alerts — same notifications as the desktop Sales AI page */}
        {intel?.actions?.length > 0 && (
          <div className="card border border-red-200 bg-red-50 p-4">
            <h2 className="mb-2 text-sm font-semibold text-red-900">
              🤖 AI alerts ({intel.actions.length})
            </h2>
            <div className="space-y-2">
              {intel.actions.map((a, i) => {
                const icon = { churn: '🚨', declining: '📉', overdue: '⏰', quote: '📄', account: '💳' }[a.type] || '⚡';
                const body = (
                  <>
                    <div className="text-xs font-medium text-slate-700">{icon} {a.action}</div>
                    {a.quote_id && <div className="mt-1 text-[10px] font-semibold text-brand-600">View quote ›</div>}
                  </>
                );
                return a.quote_id ? (
                  <Link key={i} to={`${base}/quotes/${a.quote_id}`}
                    className="block rounded-lg border border-red-100 bg-white px-3 py-2 hover:bg-slate-50">
                    {body}
                  </Link>
                ) : (
                  <div key={i} className="rounded-lg border border-red-100 bg-white px-3 py-2">{body}</div>
                );
              })}
            </div>
          </div>
        )}

        {/* Visit photos — take up to 10 photos for today's visit */}
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">📸 Photos <span className="text-xs font-normal text-slate-400">({photos.length}/10)</span></h2>
          </div>
          {activeVisit?.id ? (
            <div className="flex flex-wrap gap-2">
              {photos.map((p) => (
                <div key={p.id} className="relative">
                  <img src={p.path} alt="" className={`h-20 w-20 rounded-lg object-cover border ${p.queued ? 'border-amber-300 opacity-70' : 'border-slate-200'}`} />
                  <button
                    onClick={() => deletePhoto(p)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white shadow hover:bg-red-600"
                    aria-label="Delete photo"
                  >×</button>
                </div>
              ))}
              {photos.length < 10 && (
                <label className={`flex h-20 w-20 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 text-slate-400 hover:border-brand-500 ${busy ? 'opacity-50' : ''}`}>
                  <span className="text-2xl">📷</span>
                  <span className="text-[10px] font-medium">{busy ? 'Saving…' : 'Take photo'}</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy}
                    onChange={(e) => e.target.files[0] && addPhoto(e.target.files[0])} />
                </label>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400">Check in to this customer to attach photos to today's visit.</p>
          )}
        </div>

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
          const today = todayISO();
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
            const invoices = (c.recent_invoices || []).filter((iv) => upTo(iv.invoice_date));
            const nothing = visits.length === 0 && orders.length === 0 && quotes.length === 0 && forms.length === 0 && invoices.length === 0;

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
                        {v.check_in_type === 'offsite' && <div className="mt-0.5 text-xs text-slate-400">☕ Offsite{v.check_in_address ? ` — ${v.check_in_address}` : ''}</div>}
                        {v.check_in_type === 'onsite_manual' && <div className="mt-0.5 text-xs text-slate-400">📍 Manual address{v.check_in_address ? ` — ${v.check_in_address}` : ''}</div>}
                        <VisitPhotosTimeline visitId={v.id} />
                      </div>
                    );
                  })}
                </CollapsibleSection>

                <CollapsibleSection title="Orders" count={orders.length}>
                  {orders.map((o) => (
                    <Link key={`order-${o.id}`} to={`${base}/orders/${o.id}`} className="card block p-3">
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
                    <Link key={`quote-${q.id}`} to={`${base}/quotes/${q.id}`} className="card block p-3">
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

                <CollapsibleSection title="Invoices (last 30 days)" count={invoices.length}>
                  {invoices.map((iv) => (
                    <div key={`inv-${iv.id}`} className="card p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{iv.number}</span>
                      </div>
                      <div className="mt-0.5 flex justify-between text-xs text-slate-400">
                        <span>{fmtDate(iv.invoice_date)}{iv.order_number ? ` · ${iv.order_number}` : ''}</span>
                        <span className="font-semibold text-slate-700">{fmtR(iv.total)}</span>
                      </div>
                    </div>
                  ))}
                </CollapsibleSection>

                <CollapsibleSection title="Forms & Records" count={forms.length}>
                  {forms.map((f) => (
                    <Link key={`form-${f.id}`} to={`${base}/forms/${f.id}`} className="card block p-3">
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
                  <div className="card">
                    <EmptyState icon="🕒">{historyFrom ? 'No activity on or before that date.' : 'No activity yet.'}</EmptyState>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
          </>
        )}

        {tab === 'timeline' && (
          <div className="space-y-2">
            {!timeline ? (
              <div className="card p-6 text-center"><Spinner /></div>
            ) : timeline.length === 0 ? (
              <div className="card"><EmptyState icon="🕒">No activity yet.</EmptyState></div>
            ) : (
              <>
                {timeline.map((item, i) => {
                  const isLastItem = i === timeline.length - 1;
                  let icon, label, detail, color;

                  if (item.type === 'order') {
                    icon = '🧾';
                    label = `Order ${item.number}`;
                    detail = `${fmtR(item.total)} · ${item.status}`;
                    color = 'blue';
                  } else if (item.type === 'quote') {
                    icon = '📄';
                    label = `Quote ${item.number}`;
                    detail = `${fmtR(item.total)} · ${item.status}`;
                    color = 'purple';
                  } else if (item.type === 'visit') {
                    icon = '📍';
                    label = `Visit: ${item.purpose}`;
                    detail = `${item.status}${item.notes ? ` · ${item.notes}` : ''}`;
                    color = 'green';
                  } else if (item.type === 'task') {
                    icon = '✓';
                    label = `Task: ${item.task_type}`;
                    detail = `${item.status}${item.description ? ` · ${item.description}` : ''}`;
                    color = 'amber';
                  } else if (item.type === 'form') {
                    icon = '📋';
                    label = `Form: ${item.template_name}`;
                    detail = 'submitted';
                    color = 'slate';
                  } else if (item.type === 'invoice') {
                    icon = '💳';
                    label = `Invoice ${item.number}`;
                    detail = `${fmtR(item.total)}${item.balance > 0 ? ` · ${fmtR(item.balance)} due` : ''}`;
                    color = 'red';
                  }

                  const colorMap = {
                    blue: 'bg-blue-50 border-blue-200 text-blue-700',
                    purple: 'bg-purple-50 border-purple-200 text-purple-700',
                    green: 'bg-green-50 border-green-200 text-green-700',
                    amber: 'bg-amber-50 border-amber-200 text-amber-700',
                    slate: 'bg-slate-50 border-slate-200 text-slate-700',
                    red: 'bg-red-50 border-red-200 text-red-700'
                  };

                  // Where each item type navigates / opens on tap.
                  const linkTo = item.type === 'order' ? `${base}/orders/${item.id}`
                    : item.type === 'quote' ? `${base}/quotes/${item.id}`
                    : item.type === 'form' ? `${base}/forms/${item.id}`
                    : null;
                  const onOpen = item.type === 'visit' ? () => setTimelineVisit(item.id)
                    : item.type === 'task' ? () => setTimelineTask(item)
                    : item.type === 'invoice' ? () => setTimelineInvoice(item)
                    : null;

                  const cardBody = (
                    <div className={`card border-l-4 p-4 ${colorMap[color]} active:opacity-70`}>
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 text-xl">{icon}</div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm">{label}</div>
                          <div className="text-xs opacity-75 mt-0.5">{detail}</div>
                          <div className="text-xs opacity-60 mt-1">{fmtDate(item.date)}</div>
                          {item.rep_name && <div className="text-xs opacity-60">{item.rep_name}</div>}
                        </div>
                        <span className="shrink-0 self-center text-slate-300">›</span>
                      </div>
                    </div>
                  );

                  return (
                    <div key={`${item.type}-${item.id}`} className="relative">
                      {/* Timeline connector */}
                      {!isLastItem && (
                        <div className="absolute left-5 top-12 bottom-0 w-0.5 bg-slate-200" />
                      )}

                      {/* Item */}
                      {linkTo ? (
                        <Link to={linkTo} className="block">{cardBody}</Link>
                      ) : onOpen ? (
                        <button type="button" onClick={onOpen} className="block w-full text-left">{cardBody}</button>
                      ) : cardBody}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {showHistoryDatePicker && (
        <DatePicker value={historyFrom} onChange={setHistoryFrom} onClose={() => setShowHistoryDatePicker(false)}
          label="View activity from date" />
      )}

      {checkInAddressPrompt && (
        <CheckInAddressModal
          type={checkInAddressPrompt}
          onClose={() => setCheckInAddressPrompt(null)}
          onConfirm={(address) => { const type = checkInAddressPrompt; setCheckInAddressPrompt(null); checkIn(type, address); }}
        />
      )}

      {fillingForm && (
        <FormFillModal template={fillingForm} customerId={Number(id)}
          visitId={activeVisit?.status === 'in_progress' ? activeVisit.id : null}
          onClose={() => setFillingForm(null)}
          onDone={() => { setFormsDone((d) => [...d, fillingForm.id]); setFillingForm(null); }} />
      )}

      {showFieldNotes && (
        <FieldNotesModal
          customerId={Number(id)}
          initial={c.intel_notes}
          onClose={() => setShowFieldNotes(false)}
          onSaved={() => { setShowFieldNotes(false); load(); }}
        />
      )}

      {showOnsiteDetails && (
        <OnsiteDetailsModal
          customerId={Number(id)}
          customer={c}
          onClose={() => setShowOnsiteDetails(false)}
          onSaved={() => { setShowOnsiteDetails(false); load(); }}
        />
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

      {/* Timeline: tapping a visit opens its activity summary */}
      {timelineVisit && (
        <Modal title="Visit summary" onClose={() => setTimelineVisit(null)}>
          <VisitSummary visitId={timelineVisit} />
        </Modal>
      )}

      {/* Timeline: tapping a task opens its detail with quick actions */}
      {timelineTask && (
        <Modal title={timelineTask.task_type} onClose={() => setTimelineTask(null)}>
          <div className="space-y-3">
            <div className="text-sm">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${timelineTask.status === 'done' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                {timelineTask.status}
              </span>
            </div>
            {timelineTask.description && <div className="text-sm text-slate-600">{timelineTask.description}</div>}
            <div className="text-xs text-slate-400">Follow-up date: {fmtDate(timelineTask.date)}</div>
            {timelineTask.rep_name && <div className="text-xs text-slate-400">Assigned to: {timelineTask.rep_name}</div>}
            {timelineTask.status === 'open' && (
              <div className="flex justify-end gap-2 pt-2">
                <button className="btn-secondary" onClick={() => {
                  setReschedulingTask({ id: timelineTask.id, task_type: timelineTask.task_type, notes: timelineTask.description, follow_up_date: timelineTask.date });
                  setTimelineTask(null);
                }}>Reschedule</button>
                <button className="btn-primary" disabled={taskBusyId === timelineTask.id}
                  onClick={async () => { await markTaskDone(timelineTask.id); loadTimeline(); setTimelineTask(null); }}>
                  {taskBusyId === timelineTask.id ? 'Saving…' : 'Mark done'}
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Timeline: tapping an invoice opens its detail */}
      {timelineInvoice && (
        <Modal title={`Invoice ${timelineInvoice.number}`} onClose={() => setTimelineInvoice(null)}>
          <div className="space-y-2 text-sm">
            {timelineInvoice.order_number && (
              <div className="flex justify-between"><span className="text-slate-400">Order reference</span><span>{timelineInvoice.order_number}</span></div>
            )}
            <div className="flex justify-between"><span className="text-slate-400">Invoice date</span><span>{fmtDate(timelineInvoice.date)}</span></div>
            {timelineInvoice.due_date && (
              <div className="flex justify-between"><span className="text-slate-400">Due date</span><span>{fmtDate(timelineInvoice.due_date)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-slate-400">Total</span><span className="font-semibold">{fmtR(timelineInvoice.total)}</span></div>
            {timelineInvoice.balance > 0 && (
              <div className="flex justify-between text-red-600"><span>Outstanding</span><span className="font-semibold">{fmtR(timelineInvoice.balance)}</span></div>
            )}
            {timelineInvoice.status && (
              <div className="flex justify-between"><span className="text-slate-400">Status</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  timelineInvoice.status === 'paid' ? 'bg-emerald-50 text-emerald-700'
                  : timelineInvoice.status === 'overdue' ? 'bg-red-50 text-red-700'
                  : 'bg-amber-50 text-amber-700'}`}>
                  {timelineInvoice.status}
                </span>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

// Collects the rep-entered address for an onsite (SYSPRO address wrong) or
// offsite (meeting elsewhere) check-in before GPS is captured and submitted.
function CheckInAddressModal({ type, onClose, onConfirm }) {
  const [address, setAddress] = useState('');
  const isOffsite = type === 'offsite';

  const submit = (e) => {
    e.preventDefault();
    if (!address.trim()) return;
    onConfirm(address.trim());
  };

  return (
    <Modal title={isOffsite ? 'Offsite check-in' : 'Onsite check-in (manual address)'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-slate-400">
          {isOffsite
            ? "Meeting this customer somewhere else? Note where — e.g. a coffee shop name or address."
            : "SYSPRO's address is wrong for this customer? Enter the correct address for this visit."}
        </p>
        <Field label="Location">
          <input className="input" value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder={isOffsite ? 'e.g. Vida e Caffè, Main Rd' : 'Correct street address'} autoFocus required />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary">Check in</button>
        </div>
      </form>
    </Modal>
  );
}

// Edit the rep-captured field intel for a customer. Offline edits queue and
// replay via the outbox like everything else.
function FieldNotesModal({ customerId, initial, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    const seed = {};
    for (const f of FIELD_NOTE_FIELDS) seed[f.key] = initial?.[f.key] || '';
    return seed;
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put(`/customers/${customerId}/intel-notes`, form);
      onSaved();
    } catch (err) {
      if (err.isNetworkError) {
        queueWrite('PUT', `/customers/${customerId}/intel-notes`, form);
        onSaved();
      } else {
        setError(err.message);
        setBusy(false);
      }
    }
  };

  return (
    <Modal title="Field notes" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote error={error} />
        <p className="text-xs text-slate-400">
          Your own notes on this customer — kept in RouteOne, never overwritten by a SYSPRO sync.
        </p>
        {FIELD_NOTE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.long ? (
              <textarea className="input" rows="2" value={form[f.key]} onChange={set(f.key)} placeholder={f.placeholder} />
            ) : (
              <input className="input" value={form[f.key]} onChange={set(f.key)} placeholder={f.placeholder} />
            )}
          </Field>
        ))}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save notes'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Edit rep-captured onsite details (name, phone, address, GPS pin) for when
// SYSPRO's info is wrong. Never touches SYSPRO fields, so a sync can't
// overwrite it. Offline edits queue and replay via the outbox.
function OnsiteDetailsModal({ customerId, customer, onClose, onSaved }) {
  const [form, setForm] = useState({
    onsite_name: customer.onsite_name || '',
    onsite_contact: customer.onsite_contact || '',
    onsite_phone: customer.onsite_phone || '',
    onsite_cell: customer.onsite_cell || '',
    onsite_vat: customer.onsite_vat || '',
    onsite_address: customer.onsite_address || '',
    onsite_lat: customer.onsite_lat ?? null,
    onsite_lng: customer.onsite_lng ?? null
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const capturePin = async () => {
    setLocating(true);
    setError('');
    try {
      const pos = await getPosition();
      if (pos.lat == null) throw new Error('Could not get your location. Check GPS is on.');
      setForm((s) => ({ ...s, onsite_lat: pos.lat, onsite_lng: pos.lng }));
    } catch (e) { setError(e.message); }
    setLocating(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.put(`/customers/${customerId}/details`, form);
      onSaved();
    } catch (err) {
      if (err.isNetworkError) {
        queueWrite('PUT', `/customers/${customerId}/details`, form);
        onSaved();
      } else {
        setError(err.message);
        setBusy(false);
      }
    }
  };

  return (
    <Modal title="Onsite details" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote error={error} />
        <p className="text-xs text-slate-400">
          Correct info for this site when SYSPRO's is wrong — kept in RouteOne, never overwritten by a sync.
        </p>
        <Field label="Onsite name">
          <input className="input" value={form.onsite_name} onChange={set('onsite_name')} placeholder="Actual location name" />
        </Field>
        <Field label="Contact person(s)">
          <textarea className="input" rows="2" value={form.onsite_contact} onChange={set('onsite_contact')} placeholder="Name(s) & role — list more than one if needed" />
        </Field>
        <Field label="Phone number">
          <input className="input" type="tel" value={form.onsite_phone} onChange={set('onsite_phone')} placeholder="Landline / office number" />
        </Field>
        <Field label="Cell number">
          <input className="input" type="tel" value={form.onsite_cell} onChange={set('onsite_cell')} placeholder="Mobile number" />
        </Field>
        <Field label="VAT number">
          <input className="input" value={form.onsite_vat} onChange={set('onsite_vat')} placeholder="VAT registration number" />
        </Field>
        <Field label="Address">
          <textarea className="input" rows="2" value={form.onsite_address} onChange={set('onsite_address')} placeholder="Correct delivery address" />
        </Field>
        <div>
          <label className="label">Location pin</label>
          <div className="mt-1 text-sm text-slate-500">
            {form.onsite_lat != null ? `📍 ${form.onsite_lat.toFixed(5)}, ${form.onsite_lng.toFixed(5)}` : 'No pin set yet.'}
          </div>
          <button type="button" className="btn-secondary mt-2 w-full" onClick={capturePin} disabled={locating}>
            {locating ? 'Getting location…' : form.onsite_lat != null ? '📍 Update pin to here' : '📍 Drop pin at my location'}
          </button>
          {form.onsite_lat != null && (
            <button type="button" className="mt-1 text-xs text-slate-400 underline"
              onClick={() => setForm((s) => ({ ...s, onsite_lat: null, onsite_lng: null }))}>
              Clear pin
            </button>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Fill and submit one field form. Photo answers become base64 data URLs;
// the server stores them as files. Offline submissions queue in the outbox.
// Field types: heading | text | email | number | date | select | checkbox |
// photo | signature | product.
function FormFillModal({ template, customerId, visitId, onClose, onDone }) {
  const [data, setData] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState(null);
  const set = (key, value) => setData((d) => ({ ...d, [key]: value }));

  // Load the catalogue once if this form has any product-picker field.
  const hasProductField = (template.fields || []).some((f) => f.type === 'product');
  useEffect(() => {
    if (hasProductField) api.get('/products').then(setProducts).catch(() => setProducts([]));
  }, [hasProductField]);

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
        {template.fields.map((f, i) => {
          // Headings are non-input section dividers, not wrapped in a Field.
          if (f.type === 'heading') {
            return (
              <div key={f.key || `h${i}`} className="pt-3 first:pt-0">
                <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">{f.label}</h3>
                <div className="mt-1 border-b border-slate-200" />
              </div>
            );
          }
          return (
            <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
              {f.type === 'text' && <input className="input" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required} />}
              {f.type === 'email' && <input className="input" type="email" placeholder="e.g. bob@email.com, eve@email.com" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required} />}
              {f.type === 'number' && <input className="input" type="number" step="any" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required} />}
              {f.type === 'date' && <input className="input" type="date" value={data[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} required={f.required} />}
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
              {f.type === 'signature' && (
                <FormSignatureField value={data[f.key]} onChange={(v) => set(f.key, v)} />
              )}
              {f.type === 'product' && (
                <FormProductField value={data[f.key]} products={products} onChange={(v) => set(f.key, v)} />
              )}
            </Field>
          );
        })}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit form'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Inline signature pad for a form field. Writes a PNG data URL to the field on
// each stroke end so it's captured without a separate confirm step.
function FormSignatureField({ value, onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const ctxRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#152a44';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctxRef.current = ctx;
  }, []);

  const pos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const p = e.touches?.[0] || e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  };
  const start = (e) => { drawing.current = true; const { x, y } = pos(e); ctxRef.current.beginPath(); ctxRef.current.moveTo(x, y); };
  const move = (e) => { if (!drawing.current) return; e.preventDefault(); const { x, y } = pos(e); ctxRef.current.lineTo(x, y); ctxRef.current.stroke(); };
  const end = () => { if (!drawing.current) return; drawing.current = false; ctxRef.current.closePath(); onChange(canvasRef.current.toDataURL('image/png')); };
  const clear = () => { const c = canvasRef.current; ctxRef.current.clearRect(0, 0, c.width, c.height); onChange(''); };

  return (
    <div>
      <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white overflow-hidden">
        <canvas ref={canvasRef} className="h-32 w-full bg-white" style={{ touchAction: 'none' }}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
      </div>
      <button type="button" className="mt-1 text-xs text-slate-400 underline" onClick={clear}>Clear</button>
    </div>
  );
}

// Searchable single-product picker for a form field. Stores "CODE — Name".
function FormProductField({ value, products, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  if (value) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 truncate rounded-lg border border-slate-200 px-3 py-2 text-sm">{value}</div>
        <button type="button" className="text-xs text-slate-400 underline" onClick={() => onChange('')}>Change</button>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
        onClick={() => setOpen(true)}>
        ＋ Set product
      </button>
    );
  }
  const s = q.toLowerCase();
  const matches = (products || []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)).slice(0, 30);
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <input className="input" autoFocus placeholder="Search product code or name…" value={q} onChange={(e) => setQ(e.target.value)} />
      {products === null ? (
        <div className="py-3 text-center text-xs text-slate-400">Loading products…</div>
      ) : (
        <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
          {matches.map((p) => (
            <button key={p.id} type="button" className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50"
              onClick={() => { onChange(`${p.code} — ${p.name}`); setOpen(false); setQ(''); }}>
              <span className="font-medium">{p.name}</span> <span className="text-xs text-slate-400">{p.code}</span>
            </button>
          ))}
          {matches.length === 0 && <div className="py-3 text-center text-xs text-slate-400">No products match.</div>}
        </div>
      )}
    </div>
  );
}

function VisitPhotosTimeline({ visitId }) {
  const [photos, setPhotos] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || !visitId) return;
    api.get(`/visits/${visitId}/photos`)
      .then(setPhotos)
      .catch(() => setPhotos([]));
  }, [visitId, expanded]);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-700"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        📸 Photos
      </button>
      {expanded && (
        <div className="mt-2 flex flex-wrap gap-2">
          {photos === null ? (
            <div className="text-xs text-slate-400">Loading…</div>
          ) : photos.length === 0 ? (
            <div className="text-xs text-slate-400">No photos</div>
          ) : (
            photos.map((p) => (
              <img
                key={p.id}
                src={p.path}
                alt="Visit photo"
                className="h-16 w-16 rounded-lg object-cover border border-slate-200"
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
