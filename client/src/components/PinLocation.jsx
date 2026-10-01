// "Pin this location": a rep standing at a customer records the customer's real position. It becomes
// the CONFIRMED location - the one the maps, route planning and the check-in distance check use, and
// it always outranks any approximate location. Used on the rep's phone and on the office customer page.
//
// The phone's GPS only works on a secure (https) site; until then - or whenever GPS is blocked or
// poor - the rep can choose the spot on a map instead.
import { useState } from 'react';
import { api, getPosition, fmtDate } from '../api';
import { Modal } from './ui';
import LocationPicker from './LocationPicker';

// GPS fixes worse than this are usually a phone indoors guessing off a mast; ask for a better one.
const MAX_ACCURACY_M = 150;

// allowGps=false hides the "use my phone's position" button (the office desktop's position is not the
// customer's); the map picker is always available.
export default function PinLocation({ customer, onChanged, allowGps = true }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mapOpen, setMapOpen] = useState(false);
  const [picked, setPicked] = useState(null);

  const pinned = customer.geo_source === 'rep_pin';
  const approximate = customer.geo_source === 'other';
  const info = customer.pin_info;
  const here = customer.map_lat != null ? { lat: customer.map_lat, lng: customer.map_lng } : null;

  const save = async (lat, lng, extra) => {
    await api.post(`/customers/${customer.id}/pin-location`, { lat, lng, ...extra });
    setMapOpen(false);
    setPicked(null);
    onChanged?.();
  };

  const pinHere = async () => {
    if (pinned && !window.confirm('Replace the confirmed location with where you are now?')) return;
    setBusy(true);
    setError('');
    try {
      const pos = await getPosition();
      if (pos.lat == null) {
        setError(
          !window.isSecureContext
            ? "Your phone only shares its location with secure (https) websites, and this one isn't yet. Choose the spot on the map instead."
            : pos.error === 1
              ? 'Location is switched off for this site. Allow it in your browser settings, or choose the spot on the map.'
              : "Couldn't get your location. Try again outside, or choose the spot on the map."
        );
        return;
      }
      if (pos.accuracy != null && pos.accuracy > MAX_ACCURACY_M) {
        setError(`Your location is only accurate to about ${Math.round(pos.accuracy)} m. Wait a moment outside and try again, or choose the spot on the map.`);
        return;
      }
      await save(pos.lat, pos.lng, { accuracy: pos.accuracy, method: 'gps' });
    } catch (e) {
      setError(e.message || 'Could not save the location.');
    } finally {
      setBusy(false);
    }
  };

  const saveFromMap = async () => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try { await save(picked.lat, picked.lng, { method: 'map' }); }
    catch (e) { setError(e.message || 'Could not save the location.'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm('Remove the confirmed location for this customer?')) return;
    setBusy(true);
    try { await api.del(`/customers/${customer.id}/pin-location`); onChanged?.(); }
    catch (e) { setError(e.message || 'Could not remove the location.'); }
    finally { setBusy(false); }
  };

  const tone = pinned ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50';

  return (
    <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`font-semibold ${pinned ? 'text-emerald-700' : 'text-amber-700'}`}>
            {pinned ? '📍 Location confirmed' : approximate ? '📍 Location is approximate' : '📍 Location not set'}
          </div>
          {pinned && (
            <div className="mt-0.5 text-slate-500">
              {info ? <>by {info.by_name || 'a rep'}{info.at ? ` · ${fmtDate(info.at)}` : ''}{info.accuracy_m != null ? ` · ±${info.accuracy_m} m` : ''}{info.method === 'map' ? ' · chosen on map' : ''}</> : 'pinned on site'}
            </div>
          )}
          {!pinned && (
            <div className="mt-0.5 text-slate-500">
              {approximate ? 'Not confirmed on site. ' : ''}{allowGps ? 'Standing at the customer? Pin the exact spot' : 'Pin the exact spot'} so maps and route planning use it.
            </div>
          )}
        </div>
        {pinned && here && (
          <a className="shrink-0 font-semibold text-brand-600 underline" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps/dir/?api=1&destination=${here.lat},${here.lng}`}>🧭 Navigate</a>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {allowGps && (
          <button type="button" disabled={busy} onClick={pinHere}
            className="btn-primary px-3 py-1.5 text-xs">
            {busy ? 'Working…' : pinned ? '📍 Update to here' : '📍 Pin this location'}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => { setError(''); setPicked(here); setMapOpen(true); }}
          className={`${allowGps ? 'btn-secondary' : 'btn-primary'} px-3 py-1.5 text-xs`}>🗺 Choose on map</button>
        {pinned && <button type="button" disabled={busy} onClick={remove} className="px-2 py-1.5 text-xs font-semibold text-red-600">Remove</button>}
      </div>
      {error && <div className="mt-2 text-red-600">{error}</div>}

      {mapOpen && (
        <Modal title={`Choose ${customer.name}'s location`} onClose={() => setMapOpen(false)}
          footer={(
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setMapOpen(false)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={!picked || busy} onClick={saveFromMap}>{busy ? 'Saving…' : 'Save this spot'}</button>
            </div>
          )}>
          <p className="mb-2 text-xs text-slate-500">
            Zoom in to the customer's building, then tap the exact spot. You can drag the pin to adjust it.
          </p>
          <LocationPicker value={picked} onChange={setPicked} height={340} />
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
        </Modal>
      )}
    </div>
  );
}
