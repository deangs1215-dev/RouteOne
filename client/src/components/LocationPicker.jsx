// Interactive map for pinning a precise location. Opens centred on the rep's
// current GPS position, then lets them click (or drag the pin) to place the
// exact spot. Falls back to a Cape Town default if GPS is unavailable.
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getPosition } from '../api';

export default function LocationPicker({ value, onChange, height = 320 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [locating, setLocating] = useState(false);

  // Place or move the single draggable pin, and report the new position up.
  const setPin = (lat, lng) => {
    if (!mapRef.current) return;
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    } else {
      const marker = L.marker([lat, lng], { draggable: true }).addTo(mapRef.current);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        onChange({ lat: p.lat, lng: p.lng });
      });
      markerRef.current = marker;
    }
    onChange({ lat, lng });
  };

  // Centre on the device's current location and drop the first pin there.
  const goToMyLocation = async () => {
    setLocating(true);
    const pos = await getPosition();
    setLocating(false);
    if (pos.lat != null && mapRef.current) {
      mapRef.current.setView([pos.lat, pos.lng], 16);
      setPin(pos.lat, pos.lng);
    }
  };

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    mapRef.current = map;

    // Clicking anywhere on the map drops/moves the pin there.
    map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng));

    // If we already have a value (re-pin), show it; otherwise open on my
    // location straight away so the map starts where the rep is standing.
    if (value?.lat != null) {
      map.setView([value.lat, value.lng], 16);
      setPin(value.lat, value.lng);
    } else {
      map.setView([-33.92, 18.6], 11); // Cape Town default until GPS resolves
      goToMyLocation();
    }

    // Leaflet needs a nudge to size correctly inside a freshly-opened modal.
    setTimeout(() => map.invalidateSize(), 100);
  }, []);

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null; markerRef.current = null; }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">Tap the map to drop a pin, or drag it to adjust.</span>
        <button type="button" className="text-xs font-semibold text-brand-600 underline" onClick={goToMyLocation} disabled={locating}>
          {locating ? 'Locating…' : '📍 My location'}
        </button>
      </div>
      <div ref={containerRef} style={{ height }} className="z-0 w-full rounded-xl border border-slate-200" />
    </div>
  );
}
