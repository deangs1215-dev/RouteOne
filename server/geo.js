// A customer's location, in ONE place, for every map, route and distance check.
//
// Two sources exist in the customers table:
//   onsite_lat / onsite_lng  the pin a rep drops while standing at the customer ("Pin this location"):
//                            confirmed, the most trustworthy, and it always wins.
//   lat / lng                everything else: a manually placed pin, or a prospect created with GPS.
//                            Some app-created prospects were saved as 0,0 when no GPS was available;
//                            that is "no location", not a point in the Atlantic.
//
// SYSPRO never supplies coordinates, and the SYSPRO sync never touches these columns. A future
// address-lookup (approximate) source belongs in lat/lng and must NEVER overwrite a rep pin.
//
// SQL fragments are for building queries (`a` is the customers table alias); effectiveLocation()
// is the same rule for a row already in memory. Keep the two in step.
export const geoLat = (a = 'c') => `COALESCE(${a}.onsite_lat, CASE WHEN ${a}.lat = 0 AND ${a}.lng = 0 THEN NULL ELSE ${a}.lat END)`;
export const geoLng = (a = 'c') => `COALESCE(${a}.onsite_lng, CASE WHEN ${a}.lat = 0 AND ${a}.lng = 0 THEN NULL ELSE ${a}.lng END)`;
export const geoSource = (a = 'c') => `CASE WHEN ${a}.onsite_lat IS NOT NULL THEN 'rep_pin' WHEN ${a}.lat IS NOT NULL AND NOT (${a}.lat = 0 AND ${a}.lng = 0) THEN 'other' END`;

// "c.*" plus the three computed location fields the screens use.
export const geoColumns = (a = 'c') => `${geoLat(a)} AS map_lat, ${geoLng(a)} AS map_lng, ${geoSource(a)} AS geo_source`;

export function effectiveLocation(row) {
  if (!row) return { lat: null, lng: null, source: null };
  if (row.onsite_lat != null && row.onsite_lng != null) return { lat: row.onsite_lat, lng: row.onsite_lng, source: 'rep_pin' };
  if (row.lat != null && row.lng != null && !(row.lat === 0 && row.lng === 0)) return { lat: row.lat, lng: row.lng, source: 'other' };
  return { lat: null, lng: null, source: null };
}

// Validates a coordinate pair from a request body. Returns { lat, lng } or null.
export function parseCoordinates(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null;   // the "no location" placeholder, never a real pin
  return { lat: a, lng: b };
}
