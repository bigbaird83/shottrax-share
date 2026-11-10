/**
 * Greens-but-no-tees live pull (v2, Brian Oct 28).
 *
 * A source step is complete only when every hole in the span has a tee and a
 * green. Holes that are not complete are asked of the next source only.
 * Good holes already found stay. Nothing here invents a tee or a green.
 *
 * golfapi credits, matching worker/golf-proxy.js (search 0.1, course 1,
 * coordinates 1). A shared-card hit is 0. The golfer live cap stays 150/day.
 * A live pull must leave at least 156 credits (the never-expire balance).
 * MOCK fixtures only — this module never calls golfapi.
 */

import {
  GOLFAPI_COORDINATES_CREDITS,
  GOLFAPI_COURSE_CREDITS,
  GOLFAPI_CREDIT_FLOOR,
  GOLFAPI_SEARCH_CREDITS,
  golfApiPullCredits,
  golfApiSpendBreaksFloor,
} from './golfApiCreditFloor.mjs';

export const GOLFER_LIVE_DAILY_CREDIT_CAP = 150;
export const PHONE_PULLS_PER_DAY = 4;
export const CREDIT_FLOOR = GOLFAPI_CREDIT_FLOOR;
export const SEARCH_CREDITS = GOLFAPI_SEARCH_CREDITS;
export const COURSE_PULL_CREDITS = GOLFAPI_COURSE_CREDITS;
export const COORDINATES_PULL_CREDITS = GOLFAPI_COORDINATES_CREDITS;

/** Worker routes. A name search is skipped when the course id is already known. */
export const GOLFAPI_PULL_ENDPOINTS = Object.freeze({
  search: 'GET /golfapi/v2.3/courses',
  course: 'GET /golfapi/v2.3/courses/{id}',
  coordinates: 'GET /golfapi/v2.3/coordinates/{id}',
});

export const PAR_LENGTH_YARDS = Object.freeze({
  3: Object.freeze([50, 275]),
  4: Object.freeze([230, 500]),
  5: Object.freeze([400, 700]),
});

export const SCORECARD_TOLERANCE = 0.15;
export const OUTLINE_BUFFER_M = 30;
export const NEIGHBOR_GAP_M = 600;
export const MAX_CARD_HOLES = 36;
const METERS_PER_YARD = 0.9144;

export function golfApiCreditsForPull({ fromSharedCard = false, knownCourseId = false } = {}) {
  return golfApiPullCredits({ fromSharedCard, knownCourseId });
}

export function golfApiEndpointsForPull({ fromSharedCard = false, knownCourseId = false } = {}) {
  if (fromSharedCard) return [];
  const endpoints = [];
  if (!knownCourseId) endpoints.push(GOLFAPI_PULL_ENDPOINTS.search);
  endpoints.push(GOLFAPI_PULL_ENDPOINTS.course, GOLFAPI_PULL_ENDPOINTS.coordinates);
  return endpoints;
}

/**
 * @returns {'phone_limit' | 'app_cap' | 'floor' | null}
 * Phone pulls are a count of course pulls (the 5th is blocked).
 * App cap is credits, and this pull must fit under 150.
 * Floor blocks when this pull would leave fewer than 156 credits.
 * Landing on 156 is allowed. An unknown balance does not block.
 */
export function livePullBlockedByCap({
  phonePullsToday = 0,
  appCreditsToday = 0,
  balanceLeft = null,
  creditsThisPull = 0,
} = {}) {
  if (phonePullsToday >= PHONE_PULLS_PER_DAY) return 'phone_limit';
  if (golfApiSpendBreaksFloor(balanceLeft, creditsThisPull, CREDIT_FLOOR)) return 'floor';
  if (appCreditsToday + creditsThisPull > GOLFER_LIVE_DAILY_CREDIT_CAP) return 'app_cap';
  return null;
}

/** Two pulls of the same course share one run. A later pull, after it settles, starts again. */
export function claimCoursePull(inflight, courseId, start) {
  const key = String(courseId ?? '').trim();
  if (!key) return Promise.resolve().then(start);
  const existing = inflight.get(key);
  if (existing) return existing;
  const tracked = Promise.resolve()
    .then(start)
    .finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
  inflight.set(key, tracked);
  return tracked;
}

export function pointOk(point) {
  if (!point || typeof point !== 'object') return false;
  const { lat, lng } = point;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

export function holeHasTeeAndGreen(hole) {
  return pointOk(hole?.tee) && pointOk(hole?.green);
}

/**
 * Hole numbers the next source may be asked for.
 * `count` set: 1..count. `count` null: 1..highest painted hole.
 * A hole is included when it is absent or `holeIsComplete` is false.
 */
export function holeNumbersForTeeFill(holes, count, holeIsComplete = holeHasTeeAndGreen) {
  const byHole = new Map();
  for (const hole of holes ?? []) {
    if (Number.isInteger(hole?.hole) && hole.hole >= 1 && hole.hole <= 18) byHole.set(hole.hole, hole);
  }
  let last = 0;
  if (count != null && Number.isInteger(count) && count > 0) last = Math.min(count, 18);
  else if (byHole.size > 0) last = Math.max(...byHole.keys());
  const out = [];
  for (let n = 1; n <= last; n += 1) {
    const hole = byHole.get(n);
    if (!hole || !holeIsComplete(hole)) out.push(n);
  }
  return out;
}

/**
 * Keep holes that already pass. For a missing number, take a tee or a green
 * only when the incoming hole actually has that point. Never invent one.
 */
export function mergeMissingHoles(kept, incoming, missing) {
  const want = new Set(missing ?? []);
  const byHole = new Map();
  for (const hole of kept ?? []) {
    if (!Number.isInteger(hole?.hole)) continue;
    byHole.set(hole.hole, { ...hole });
  }
  for (const hole of incoming ?? []) {
    if (!Number.isInteger(hole?.hole) || !want.has(hole.hole)) continue;
    const prior = byHole.get(hole.hole);
    if (!prior) {
      const tee = pointOk(hole.tee) ? hole.tee : null;
      const green = pointOk(hole.green) ? hole.green : null;
      if (!tee && !green) continue;
      byHole.set(hole.hole, {
        hole: hole.hole,
        tee,
        green,
        par: finiteStat(hole.par),
        yards: finiteStat(hole.yards),
        source: hole.source ?? null,
      });
      continue;
    }
    const tee = pointOk(prior.tee) ? prior.tee : pointOk(hole.tee) ? hole.tee : null;
    const green = pointOk(prior.green) ? prior.green : pointOk(hole.green) ? hole.green : null;
    byHole.set(hole.hole, {
      ...prior,
      tee,
      green,
      par: finiteStat(prior.par) ?? finiteStat(hole.par),
      yards: finiteStat(prior.yards) ?? finiteStat(hole.yards),
    });
  }
  return [...byHole.values()].sort((left, right) => left.hole - right.hole);
}

function finiteStat(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function haversineYards(a, b) {
  if (!pointOk(a) || !pointOk(b)) return null;
  const earthM = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  const meters = 2 * earthM * Math.asin(Math.min(1, Math.sqrt(h)));
  return meters / METERS_PER_YARD;
}

function parLengthOk(par, yards) {
  if (par == null) return true;
  const band = PAR_LENGTH_YARDS[par];
  if (!band) return false;
  if (yards == null) return false;
  return yards >= band[0] && yards <= band[1];
}

function scorecardOk(measured, cardYards) {
  if (cardYards == null) return true;
  if (measured == null) return false;
  return Math.abs(measured - cardYards) <= cardYards * SCORECARD_TOLERANCE;
}

function ringPoint(point) {
  if (Array.isArray(point)) return { lat: point[0], lng: point[1] };
  return point;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ringPoint(ring[i]);
    const b = ringPoint(ring[j]);
    const intersect =
      a.lng > point.lng !== b.lng > point.lng &&
      point.lat < ((b.lat - a.lat) * (point.lng - a.lng)) / (b.lng - a.lng || 1e-12) + a.lat;
    if (intersect) inside = !inside;
  }
  return inside;
}

function metersBetween(a, b) {
  const yards = haversineYards(a, b);
  return yards == null ? null : yards * METERS_PER_YARD;
}

/** Inside the ring, or within 30 m of an edge. No ring → no rejection. */
export function pointInsideOutline(point, ring, bufferM = OUTLINE_BUFFER_M) {
  if (!ring || ring.length < 3) return true;
  if (!pointOk(point)) return false;
  if (pointInRing(point, ring)) return true;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ringPoint(ring[i]);
    const b = ringPoint(ring[(i + 1) % ring.length]);
    const distance = distanceToSegmentM(point, a, b);
    if (distance != null && distance <= bufferM) return true;
  }
  return false;
}

function distanceToSegmentM(point, a, b) {
  const abLat = b.lat - a.lat;
  const abLng = b.lng - a.lng;
  const len2 = abLat * abLat + abLng * abLng;
  if (len2 === 0) return metersBetween(point, a);
  let t = ((point.lat - a.lat) * abLat + (point.lng - a.lng) * abLng) / len2;
  t = Math.max(0, Math.min(1, t));
  return metersBetween(point, { lat: a.lat + t * abLat, lng: a.lng + t * abLng });
}

/**
 * Checks before a live card is published. A failing hole is reported, not moved.
 * A neighbor gap flags the card and still publishes. Bundled, hand-pinned, and
 * guarded courses are refused (hash-OK stays on the committed file).
 */
export function liveCardPublishVerdict(card) {
  const holes = [...(card?.holes ?? [])].sort((a, b) => a.hole - b.hole);
  const count = card?.count ?? (holes.length > 0 ? Math.max(...holes.map((hole) => hole.hole)) : 0);
  if (Number(count) > MAX_CARD_HOLES) {
    return { ok: false, reason: 'bad_count', fails: [], flags: [] };
  }
  if (!card || card.bundled || card.handPinned || card.guarded) {
    return { ok: false, reason: 'hash-ok', fails: [], flags: [] };
  }
  if (card.blocklisted || card.sisterCourse) {
    return { ok: false, reason: 'wrong-course', fails: [{ reason: 'wrong-course' }], flags: [] };
  }
  const fails = [];
  const flags = [];
  const byHole = new Map(holes.map((hole) => [hole.hole, hole]));
  for (let n = 1; n <= count; n += 1) {
    const hole = byHole.get(n);
    if (!holeHasTeeAndGreen(hole)) {
      fails.push({ hole: n, reason: 'missing-tee' });
      continue;
    }
    const measured = haversineYards(hole.tee, hole.green);
    const yards = finiteStat(hole.yards) ?? (measured == null ? null : Math.round(measured));
    if (!parLengthOk(finiteStat(hole.par), yards)) fails.push({ hole: n, reason: 'par-length' });
    if (!scorecardOk(measured, finiteStat(hole.yards))) fails.push({ hole: n, reason: 'scorecard' });
    if (card.outline && (!pointInsideOutline(hole.tee, card.outline) || !pointInsideOutline(hole.green, card.outline))) {
      fails.push({ hole: n, reason: 'outline' });
    }
  }
  for (let i = 0; i < holes.length - 1; i += 1) {
    const gap = metersBetween(holes[i].green, holes[i + 1].tee);
    if (gap != null && gap > NEIGHBOR_GAP_M) flags.push({ hole: holes[i].hole, reason: 'neighbor' });
  }
  if (fails.length > 0) return { ok: false, reason: fails[0].reason, fails, flags };
  return { ok: true, reason: null, fails, flags };
}

function cardReady(holes, count) {
  const missing = holeNumbersForTeeFill(holes, count, holeHasTeeAndGreen);
  if (missing.length > 0) return false;
  const span = count ?? (holes.length > 0 ? Math.max(...holes.map((hole) => hole.hole)) : 0);
  if (span < 1) return false;
  const byHole = new Map(holes.map((hole) => [hole.hole, hole]));
  for (let n = 1; n <= span; n += 1) {
    const hole = byHole.get(n);
    if (finiteStat(hole?.par) == null || finiteStat(hole?.yards) == null) return false;
  }
  return true;
}

function anyTee(holes) {
  return (holes ?? []).some((hole) => holeHasTeeAndGreen(hole));
}

function creditsForCalls(calls, knownCourseId) {
  if (!calls.includes('golfapi')) return 0;
  return golfApiCreditsForPull({ fromSharedCard: false, knownCourseId });
}

/**
 * OSM, then GCA, then golfapi, each asked only for holes still missing a tee
 * and a green. Shared card first (0 credits). Cap or a total miss queues.
 * A throw from one source moves to the next source. All three throwing queues.
 */
export async function runGreensNoTeesPull(args) {
  const inflight = args.inflight ?? runGreensNoTeesPull.inflight;
  return claimCoursePull(inflight, args.courseId, () => runGreensNoTeesPullOnce(args));
}

runGreensNoTeesPull.inflight = new Map();

export function resetGreensNoTeesPullsForTests() {
  runGreensNoTeesPull.inflight = new Map();
}

async function runGreensNoTeesPullOnce(args) {
  const knownCourseId = args.knownCourseId === true;
  if (args.bundled || args.handPinned || args.guarded) {
    return {
      ok: false,
      published: false,
      queued: false,
      filled: false,
      reason: 'hash-ok',
      holes: args.holes ?? [],
      credits: 0,
      calls: [],
      endpoints: [],
    };
  }
  if (typeof args.readShared === 'function') {
    const shared = await args.readShared(args.courseId);
    if (shared && cardReady(shared.holes ?? [], shared.count ?? args.count ?? null)) {
      return {
        ok: true,
        published: true,
        fromShared: true,
        queued: false,
        filled: true,
        reason: null,
        holes: shared.holes,
        credits: 0,
        calls: [],
        endpoints: [],
      };
    }
  }
  let holes = [...(args.holes ?? [])];
  let count = args.count ?? null;
  const calls = [];
  let failed = false;
  for (const source of ['osm', 'gca', 'golfapi']) {
    const missing = holeNumbersForTeeFill(holes, count);
    if (missing.length === 0 && holes.length > 0) break;
    if (source === 'golfapi') {
      const creditsThisPull = golfApiCreditsForPull({ fromSharedCard: false, knownCourseId });
      const block = livePullBlockedByCap({ ...(args.caps ?? {}), creditsThisPull });
      if (block) {
        return {
          ok: true,
          published: false,
          queued: !anyTee(holes),
          filled: false,
          reason: block,
          holes,
          credits: 0,
          calls,
          endpoints: [],
        };
      }
    }
    const load = args.sources?.[source];
    if (typeof load !== 'function') continue;
    calls.push(source);
    let incoming = null;
    try {
      incoming = await load(missing);
    } catch {
      failed = true;
      continue;
    }
    if (incoming == null) continue;
    const ask = missing.length > 0 ? missing : (incoming.holes ?? []).map((hole) => hole.hole);
    holes = mergeMissingHoles(holes, incoming.holes ?? [], ask);
    if (incoming.count != null) count = incoming.count;
  }
  const credits = creditsForCalls(calls, knownCourseId);
  const endpoints = calls.includes('golfapi')
    ? golfApiEndpointsForPull({ fromSharedCard: false, knownCourseId })
    : [];
  const ready = cardReady(holes, count);
  if (ready && !failed) {
    const verdict = liveCardPublishVerdict({ ...args.check, holes, count, bundled: false, handPinned: false, guarded: false });
    if (!verdict.ok) {
      return {
        ok: false,
        published: false,
        queued: false,
        filled: false,
        reason: verdict.reason,
        fails: verdict.fails,
        flags: verdict.flags,
        holes,
        credits,
        calls,
        endpoints,
      };
    }
    if (typeof args.writeShared === 'function') {
      await args.writeShared(args.courseId, {
        holes,
        count,
        source: calls[calls.length - 1] ?? null,
        at: args.now ?? Date.now(),
        flags: verdict.flags,
        checks: verdict,
      });
    }
    return {
      ok: true,
      published: true,
      queued: false,
      filled: true,
      reason: null,
      flags: verdict.flags,
      holes,
      credits,
      calls,
      endpoints,
    };
  }
  const queued = !anyTee(holes);
  return {
    ok: true,
    published: false,
    queued,
    filled: false,
    reason: queued ? (failed ? 'failed' : 'no_data') : 'partial',
    holes,
    credits,
    calls,
    endpoints,
  };
}

export function appendCardVersion(store, id, version) {
  const key = String(id);
  const row = store.get(key) ?? { flag: 'live', versions: [] };
  row.versions.push(version);
  store.set(key, row);
  return row;
}

/** `hidden` serves "Not mapped yet". `revert` serves the previous published card. */
export function readServedCard(row) {
  if (!row || !Array.isArray(row.versions) || row.versions.length === 0) return null;
  if (row.flag === 'hidden') return { mapped: false, message: 'Not mapped yet', card: null };
  if (row.flag === 'revert') {
    const index = Math.max(0, row.versions.length - 2);
    return { mapped: true, message: null, card: row.versions[index], reverted: row.versions.length > 1 };
  }
  return { mapped: true, message: null, card: row.versions[row.versions.length - 1], reverted: false };
}

export function setCardFlag(store, id, flag) {
  if (flag !== 'live' && flag !== 'hidden' && flag !== 'revert') {
    throw new Error('unknown flag');
  }
  const key = String(id);
  const row = store.get(key);
  if (!row) return null;
  row.flag = flag;
  store.set(key, row);
  return readServedCard(row);
}

export function buildDailyDigest(events, nowMs) {
  const since = nowMs - 24 * 60 * 60 * 1000;
  const recent = (events ?? []).filter((event) => event && event.at >= since && event.at <= nowMs);
  return {
    published: recent.filter((event) => event.kind === 'published').length,
    queued: recent.filter((event) => event.kind === 'queued').length,
    hidden: recent.filter((event) => event.kind === 'hidden').length,
    flagged: recent
      .filter((event) => Array.isArray(event.flags) && event.flags.length > 0)
      .map((event) => ({ id: event.id, flags: event.flags })),
    courses: recent.filter((event) => event.kind === 'published').map((event) => event.id),
  };
}
