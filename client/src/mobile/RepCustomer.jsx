// Rep's customer view: check in / out with GPS stamps, visit notes, photos,
// field forms, quick order and quote. Visits captured with no signal are
// stored locally and logged to the server in one call when back online.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtR, fmtDate, fmtDateTime, getPosition } from '../api';
import { Spinner, ErrorNote, GradeBadge, OrderStatusBadge, Modal, Field } from '../components/ui';
import { queueWrite } from '../offline';
import { MobileHeader } from './MobileApp';

const offlineVisitKey = (custId) => `fsp_offline_visit_${custId}`;

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
  }, [id]);

  if (!c) return <><MobileHeader title="Customer" back="/mobile/customers" /><Spinner /></>;

  const checkedIn = activeVisit?.status === 'in_progress' || !!offlineVisit;
  const visitParam = activeVisit?.status === 'in_progress' ? `?visit=${activeVisit.id}` : '';

  const checkIn = async () => {
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
      } else setError(e.message);
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

        {/* Visit flow */}
        {!checkedIn ? (
          <button className="btn-primary w-full py-3" onClick={checkIn} disabled={busy}>
            {busy ? 'Checking in…' : `📍 Check in${activeVisit ? '' : ' (unplanned visit)'}`}
          </button>
        ) : (
          <div className="card space-y-3 p-4">
            <div className="text-sm font-semibold text-emerald-600">
              ✓ Checked in {fmtDateTime(offlineVisit ? offlineVisit.check_in_at : activeVisit.check_in_at)}
              {offlineVisit && <span className="ml-1 text-xs font-normal text-slate-400">(offline)</span>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Link to={`/mobile/customers/${c.id}/order${visitParam}`} className="btn-primary py-3">🧾 New order</Link>
              <Link to={`/mobile/customers/${c.id}/order${visitParam ? visitParam + '&' : '?'}kind=quote`} className="btn-secondary py-3">📄 New quote</Link>
            </div>

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

            {/* Field forms */}
            {templates.length > 0 && (
              <div>
                <label className="label">Field forms</label>
                <div className="space-y-1.5">
                  {templates.map((t) => (
                    <button key={t.id} className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => setFillingForm(t)}>
                      <span>{t.name}</span>
                      <span className="text-xs">{formsDone.includes(t.id) ? '✅' : '›'}</span>
                    </button>
                  ))}
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
            <button className="btn-secondary w-full py-3" onClick={checkOut} disabled={busy}>
              {busy ? 'Checking out…' : 'Check out'}
            </button>
          </div>
        )}

        {!checkedIn && (
          <div className="grid grid-cols-2 gap-2">
            <Link to={`/mobile/customers/${c.id}/order`} className="btn-secondary py-3">🧾 Order</Link>
            <Link to={`/mobile/customers/${c.id}/order?kind=quote`} className="btn-secondary py-3">📄 Quote</Link>
          </div>
        )}

        {/* Selling tips from the intelligence engine */}
        {intel && (intel.suggested_products.length > 0 || intel.lapsed_products.length > 0 || intel.risk_score >= 40) && (
          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-600">💡 Selling tips</h2>
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

        {/* Recent orders */}
        <div>
          <h2 className="mb-2 text-sm font-semibold text-slate-600">Recent orders</h2>
          <div className="space-y-2">
            {c.recent_orders.slice(0, 5).map((o) => (
              <div key={o.id} className="card p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{o.number}</span>
                  <OrderStatusBadge status={o.status} />
                </div>
                <div className="mt-0.5 flex justify-between text-xs text-slate-400">
                  <span>{fmtDate(o.order_date)}</span>
                  <span className="font-semibold text-slate-700">{fmtR(o.total)}</span>
                </div>
              </div>
            ))}
            {c.recent_orders.length === 0 && <div className="card p-4 text-center text-sm text-slate-400">No orders yet.</div>}
          </div>
        </div>
      </div>

      {fillingForm && (
        <FormFillModal template={fillingForm} customerId={Number(id)}
          visitId={activeVisit?.status === 'in_progress' ? activeVisit.id : null}
          onClose={() => setFillingForm(null)}
          onDone={() => { setFormsDone((d) => [...d, fillingForm.id]); setFillingForm(null); }} />
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
