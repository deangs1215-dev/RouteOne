// Thin Leaflet wrapper. Markers: [{ lat, lng, label, color, radius, popup }].
// Polyline (optional): ordered [lat, lng] pairs for the route line.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export default function MapView({ markers = [], line = null, height = 380 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map(containerRef.current, { scrollWheelZoom: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(mapRef.current);
      layerRef.current = L.layerGroup().addTo(mapRef.current);
    }
    const layer = layerRef.current;
    layer.clearLayers();

    const points = markers.filter((m) => m.lat != null && m.lng != null);
    for (const m of points) {
      const marker = L.circleMarker([m.lat, m.lng], {
        radius: m.radius || 9,
        color: m.color || '#1a7ea8',
        weight: 2,
        fillColor: m.color || '#1a7ea8',
        fillOpacity: 0.5
      }).addTo(layer);
      if (m.popup) marker.bindPopup(m.popup);
      if (m.label != null) {
        marker.bindTooltip(String(m.label), {
          permanent: true, direction: 'center',
          className: 'route-stop-label', opacity: 1
        });
      }
    }
    if (line && line.length > 1) {
      L.polyline(line, { color: '#1a7ea8', weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(layer);
    }
    if (points.length > 0) {
      mapRef.current.fitBounds(L.latLngBounds(points.map((m) => [m.lat, m.lng])), { padding: [30, 30], maxZoom: 14 });
    } else {
      mapRef.current.setView([-33.92, 18.6], 10); // Cape Town default
    }
  }, [JSON.stringify(markers), JSON.stringify(line)]);

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null; }, []);

  return <div ref={containerRef} style={{ height }} className="z-0 w-full rounded-xl border border-slate-200" />;
}
