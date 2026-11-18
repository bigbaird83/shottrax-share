/**
 * Brian's Oct 28 import checks, applied per course to a raw golfapi course +
 * coordinates pair. Ported from the ShotTraxx app (not invented here), with
 * the same thresholds:
 *
 * - every hole 1..numHoles has a green (poi 1, location 2) and a tee
 *   (poi 11/12, location 2) that is a real point (isCourseCardLatLng), not the
 *   clubhouse pin (< 5 yd), with a tee-to-green span of 5-700 yd
 *   (golfapi.ts mapGolfApiCourseToHydrate + pickTee, holeCamera.ts
 *   COURSE_CARD_MIN/MAX_HOLE_SPAN_YARDS);
 * - hole-level 15% card yardage: some tee point on each hole within 15% of
 *   some card yardage (SCORECARD_TOLERANCE / CARD_YARDS_TOLERANCE 0.15), with
 *   the scorecardCheck.ts 2-tee order rule (see scorecardHoleResult);
 * - hole length fits par (cardChecks.ts: par 3 over 280 yd or par 5 under
 *   380 yd is a par-length issue; par must be 3-6);
 * - OSM outline and right-course checks need OSM geometry that is not in the
 *   raw bodies. Those come from Signal Lab's import-ready verdicts and reject
 *   list (enforced by planImport), not distance from a possibly wrong
 *   clubhouse pin and not a new review verdict from this script.
 * - a back nine whose greens sit within 5 m of the front nine's (Signal Lab's
 *   trim-to-9 test, regional-validation.md) is reported as trim_to_9.
 *
 * Any failing hole fails the course. Nothing is moved, trimmed or invented.
 */

export const SCORECARD_TOLERANCE = 0.15;
export const SAME_TEE_POINT_M = 2;
export const MIN_HOLE_SPAN_YARDS = 5;
export const MAX_HOLE_SPAN_YARDS = 700;
export const CLUBHOUSE_PIN_YARDS = 5;
export const PAR3_LONG_YARDS = 280;
export const PAR5_SHORT_YARDS = 380;
export const TRIM_TO_9_GREEN_M = 5;
const EARTH_RADIUS_M = 6371000;
const METERS_PER_YARD = 0.9144;
const NEAR_ZERO_DEG = 0.01;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}
export function haversineYards(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))) / METERS_PER_YARD;
}
const metersBetween = (a, b) => haversineYards(a, b) * METERS_PER_YARD;

/** latLng.ts isCourseCardLatLng */
export function isCourseCardLatLng(p) {
  if (!p) return false;
  const { lat, lng } = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return !(Math.abs(lat) < NEAR_ZERO_DEG && Math.abs(lng) < NEAR_ZERO_DEG);
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function within(measured, card) {
  return Math.abs(measured - card) <= card * SCORECARD_TOLERANCE;
}

/**
 * Hole-level 15% rule (Signal Lab ruling on #66, Nov 17): a hole passes when
 * ANY of its tee points is within 15% of ANY card yardage for that hole. The
 * 2-tee order rule from scorecardCheck.ts still applies when both golfapi tees
 * (poi 12 back, poi 11 front) fit: the back tee's longest fit must not be
 * shorter than the front tee's shortest fit (a swapped pair fails). A hole
 * with no card yardage passes. Returns { ok, tees: [{ role, yards, fits }], card }.
 */
export function scorecardHoleResult({ tees, green, card }) {
  const yards = (card ?? []).filter((c) => Number.isFinite(c.yards) && c.yards > 0);
  if (yards.length === 0 || !isCourseCardLatLng(green)) return { ok: true, tees: [], card: yards };
  const points = [];
  for (const t of tees) {
    if (!isCourseCardLatLng(t.point)) continue;
    const dup = points.find((p) => (p.role ?? null) === (t.role ?? null) && metersBetween(p.point, t.point) <= SAME_TEE_POINT_M);
    if (!dup) points.push(t);
  }
  const measured = points.map((t) => {
    const m = haversineYards(t.point, green);
    return { role: t.role ?? null, yards: m, fits: yards.filter((c) => within(m, c.yards)).map((c) => c.yards) };
  });
  if (measured.length === 0) return { ok: true, tees: measured, card: yards };
  let ok = measured.some((t) => t.fits.length > 0);
  const back = measured.find((t) => t.role === 'back');
  const front = measured.find((t) => t.role === 'front');
  if (ok && back && front && back.fits.length > 0 && front.fits.length > 0) {
    ok = Math.max(...back.fits) >= Math.min(...front.fits);
  }
  return { ok, tees: measured, card: yards };
}

export function scorecardHolePasses(args) {
  return scorecardHoleResult(args).ok;
}

/** golfapi.ts parseTeeSets */
function teeSets(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.teeName ?? item.tee_name ?? '').trim() || 'default';
    const lengths = [];
    let any = false;
    for (let n = 1; n <= 18; n += 1) {
      const y = num(item[`length${n}`]) ?? 0;
      lengths.push(y > 0 ? y : 0);
      if (y > 0) any = true;
    }
    if (any) out.push({ name, lengths });
  }
  return out;
}

function coordRows(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.coordinates) ? payload.coordinates : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const poi = num(r.poi);
    const location = num(r.location);
    const hole = num(r.hole);
    const lat = num(r.latitude ?? r.lat);
    const lng = num(r.longitude ?? r.lng);
    if (poi == null || location == null || hole == null || !Number.isInteger(hole) || hole < 1 || hole > 18 || lat == null || lng == null) continue;
    if (!isCourseCardLatLng({ lat, lng })) continue;
    out.push({ poi, location, hole, lat, lng });
  }
  return out;
}

/** golfapi.ts pickTee: the tee spot closest to the preferred card yardage, else the farthest. */
function pickTee(candidates, green, hole, sets) {
  if (candidates.length === 0) return null;
  const preferred = sets.find((s) => /blue/i.test(s.name) && (s.lengths[hole - 1] ?? 0) > 0) ?? sets.find((s) => (s.lengths[hole - 1] ?? 0) > 0) ?? null;
  const target = preferred?.lengths[hole - 1] ?? 0;
  let chosen = candidates[0];
  let best = target > 0 ? Number.POSITIVE_INFINITY : -1;
  for (const c of candidates) {
    const span = haversineYards(c, green);
    if (target > 0 ? Math.abs(span - target) < best : span > best) {
      best = target > 0 ? Math.abs(span - target) : span;
      chosen = c;
    }
  }
  return chosen;
}

/**
 * Returns { ok: true } or { ok: false, check, hole, detail }. `check` is one of
 * bad_num_holes, missing_tee_or_green, tee_green_span, card_yards_15pct,
 * par_missing, par_length, trim_to_9.
 */
export function checkCourse(course, coordinates) {
  const numHoles = num(course?.numHoles);
  if (numHoles !== 9 && numHoles !== 18) return { ok: false, check: 'bad_num_holes', detail: `numHoles ${course?.numHoles}` };
  const clubLat = num(course.latitude);
  const clubLng = num(course.longitude);
  const clubhouse = clubLat != null && clubLng != null && isCourseCardLatLng({ lat: clubLat, lng: clubLng }) ? { lat: clubLat, lng: clubLng } : null;
  const isPin = (p) => clubhouse != null && haversineYards(p, clubhouse) < CLUBHOUSE_PIN_YARDS;
  const rows = coordRows(coordinates);
  const sets = teeSets(course.tees);
  const pars = Array.isArray(course.parsMen) ? course.parsMen : [];
  const greens = new Map();
  const cardFails = [];
  for (let n = 1; n <= numHoles; n += 1) {
    const at = rows.filter((r) => r.hole === n);
    const greenRow = at.find((r) => r.poi === 1 && r.location === 2);
    const green = greenRow ? { lat: greenRow.lat, lng: greenRow.lng } : null;
    const teeRows = at.filter((r) => (r.poi === 11 || r.poi === 12) && r.location === 2 && !isPin(r));
    if (!green || isPin(green) || teeRows.length === 0) return { ok: false, check: 'missing_tee_or_green', hole: n };
    greens.set(n, green);
    const tee = pickTee(teeRows.map((r) => ({ lat: r.lat, lng: r.lng })), green, n, sets);
    const span = haversineYards(tee, green);
    if (span < MIN_HOLE_SPAN_YARDS || span > MAX_HOLE_SPAN_YARDS) return { ok: false, check: 'tee_green_span', hole: n, detail: `${Math.round(span)} yd` };
    const card = sets.filter((s) => (s.lengths[n - 1] ?? 0) > 0).map((s) => ({ yards: s.lengths[n - 1], name: s.name }));
    const teePoints = teeRows.map((r) => ({ point: { lat: r.lat, lng: r.lng }, role: r.poi === 12 ? 'back' : 'front' }));
    const scored = scorecardHoleResult({ tees: teePoints, green, card });
    if (!scored.ok) {
      cardFails.push({
        hole: n,
        tees: scored.tees.map((t) => ({ role: t.role, yards: Math.round(t.yards) })),
        card: card.map((c) => ({ name: c.name, yards: c.yards })),
      });
      continue;
    }
    const par = num(pars[n - 1]);
    if (par == null || !Number.isInteger(par) || par < 3 || par > 6) return { ok: false, check: 'par_missing', hole: n };
    if ((par === 3 && span > PAR3_LONG_YARDS) || (par === 5 && span < PAR5_SHORT_YARDS)) {
      return { ok: false, check: 'par_length', hole: n, detail: `par ${par} is ${Math.round(span)} yd` };
    }

  }
  if (cardFails.length) return { ok: false, check: 'card_yards_15pct', hole: cardFails[0].hole, holes: cardFails };
  if (numHoles === 18) {
    for (let n = 10; n <= 18; n += 1) {
      if (metersBetween(greens.get(n), greens.get(n - 9)) <= TRIM_TO_9_GREEN_M) return { ok: false, check: 'trim_to_9', hole: n };
    }
  }
  return { ok: true };
}
