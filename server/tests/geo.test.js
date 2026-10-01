import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveLocation, parseCoordinates, geoLat, geoLng, geoSource } from '../geo.js';

test('a rep-confirmed pin always outranks the other location', () => {
  const row = { onsite_lat: -26.1, onsite_lng: 28.1, lat: -33.9, lng: 18.4 };
  assert.deepEqual(effectiveLocation(row), { lat: -26.1, lng: 28.1, source: 'rep_pin' });
});

test('with no pin, lat/lng is used and labelled as not confirmed', () => {
  assert.deepEqual(effectiveLocation({ onsite_lat: null, onsite_lng: null, lat: -33.9, lng: 18.4 }), { lat: -33.9, lng: 18.4, source: 'other' });
});

test('0,0 is "no location", not a point in the ocean', () => {
  assert.deepEqual(effectiveLocation({ lat: 0, lng: 0 }), { lat: null, lng: null, source: null });
  assert.deepEqual(effectiveLocation({ onsite_lat: null, onsite_lng: null, lat: null, lng: null }), { lat: null, lng: null, source: null });
  assert.deepEqual(effectiveLocation(null), { lat: null, lng: null, source: null });
  // a real point that merely has one zero coordinate is still real (the equator / Greenwich line)
  assert.equal(effectiveLocation({ lat: 0, lng: 18.4 }).source, 'other');
});

test('parseCoordinates accepts real positions and refuses junk', () => {
  assert.deepEqual(parseCoordinates(-26.2, 28.04), { lat: -26.2, lng: 28.04 });
  assert.deepEqual(parseCoordinates('-26.2', '28.04'), { lat: -26.2, lng: 28.04 });   // numbers sent as text
  for (const [a, b] of [[0, 0], [91, 0], [0, 181], ['abc', 1], [null, 1], [1, null], [undefined, undefined], ['', ''], [NaN, 1], [Infinity, 1]]) {
    assert.equal(parseCoordinates(a, b), null, `${a},${b}`);
  }
});

test('the SQL fragments follow the same rule as the JS helper (same columns, same order of precedence)', () => {
  assert.match(geoLat('c'), /COALESCE\(c\.onsite_lat/);
  assert.match(geoLng('x'), /COALESCE\(x\.onsite_lng/);
  assert.match(geoLat('c'), /c\.lat = 0 AND c\.lng = 0/);
  assert.match(geoSource('c'), /'rep_pin'.*'other'/s);
});
