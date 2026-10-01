// Map background for every Leaflet map in the app, in one place.
//
// OpenStreetMap standard tiles. Their servers reject requests that carry no referrer, and the app
// deliberately sends none cross-site (Referrer-Policy: same-origin) - which is what produced the
// grey "403 Access blocked" tiles. So the tile requests alone send our origin (and nothing else).
//
// To change provider: update TILE_URL / TILE_OPTIONS here AND the img-src entry in the
// Content-Security-Policy in server/index.js, or the browser will refuse the images. The
// attribution is required by the providers' terms - keep it on the map.
// (CARTO was tried: its free public tile address now stamps "API KEY REQUIRED" over every tile.)
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const TILE_OPTIONS = {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  referrerPolicy: 'strict-origin-when-cross-origin'
};
