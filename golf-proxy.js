/**
 * Deployable golf + terrain routes for the existing share-sync Worker
 * (the host behind EXPO_PUBLIC_SHARE_SYNC_URL).
 *
 * CoS deploys this after Doc's OK, by importing `handleGolfProxy` into the
 * existing Worker. This repo does not deploy it. Share boards stay
 * `GET/PUT /{code}` in that Worker; these routes are two or more segments.
 *
 *   GET {share sync}/gca/v1/courses?lat=&lng=&radius=     nearby
 *   GET {share sync}/gca/v1/courses?q=                     search
 *   GET {share sync}/gca/v1/courses/{id}                   scorecard
 *   GET {share sync}/gca/v1/courses/{id}/green-centers     Pro greens
 *   GET {share sync}/golfapi/v2.3/courses?country=&name=   name search
 *   GET {share sync}/golfapi/v2.3/courses/{id}
 *   GET {share sync}/golfapi/v2.3/coordinates/{id}
 *   GET {share sync}/golfapi/v2.3/status                   this Worker, no credit
 *   GET {share sync}/terrain/v1/{courseKey}/{hole}?teeLat&teeLng&...
 *
 * Worker contract (PR #460, Signal). The phone sends `X-Install-Id` on every
 * golfapi request and on GET /golfapi/v2.3/status. That id is the one shown
 * at the bottom of Settings. It sends `X-ShotTraxx-Storefront` when the App
 * Store country is known. `US` or `USA` is a US store account (the app
 * normalizes RevenueCat's `USA` to `US`). A missing header, or any other
 * value, is not a US App Store account, except the field-build case below.
 *
 * GET /golfapi/v2.3/status is answered here. It is never forwarded and it
 * costs no credit. It reads `X-Install-Id`, compares it to `GOLFAPI_ALLOWLIST`,
 * and returns `{ "exempt": boolean, "dailyPulls": number }`. `dailyPulls` is
 * GOLFAPI_INSTALL_DAILY_PULLS. The credit backstop and the search cap are not in this body.
 * `/status` is computed per request,
 * sent with `Cache-Control: no-store`, and kept out of every cache (edge
 * cache and KV included). It does not get `X-ShotTraxx-Golfapi-Exempt`.
 *
 * `X-ShotTraxx-Golfapi-Exempt` is added on proxied golfapi replies AFTER the
 * KV / edge lookup, computed from that request's install ID, and never stored
 * in KV or the edge cache. `1` is allowlisted. Any other value is not.
 *
 * A paid golfapi pull is forwarded only when the install is exempt, the
 * storefront header is `US` / `USA`, or the field-build exception applies.
 * Otherwise the Worker answers without calling the vendor and does not cache
 * that answer (`429` `golfapi_limited`). Each phone may count 4 course pulls
 * per UTC day. A pull counts only when a paid open returns a usable map
 * (a course body with hole coordinates). Stored copies, failures, and
 * replies with no map do not count. A new open is refused when that phone
 * already has 4. Each phone may also make 30 name searches per UTC day.
 * Only a search that calls golfapi counts; a stored or edge copy does not.
 * App-wide caps still apply on top, including for a US
 * storefront. An exempt install skips the storefront rule, the 4-pull limit,
 * the 30-search limit, the 20-credit backstop,
 * and the app caps, not the credit floor. Those caps stay authoritative.
 * The app flag only decides whether the phone asks.
 * The app does not hardcode these caps; they belong to this Worker.
 * App-wide caps ship at today's values, 150 golfapi credits per day and 450 per month.
 *
 * Field builds 149–151 do not send X-ShotTraxx-Storefront. Their name search
 * is hardcoded to country=US. See `golfapiSpendAllowed`. The exception applies
 * only when that header is absent entirely.
 *
 * Secrets (names only): GOLFAPI_KEY, GOLF_COURSES_API_KEY, GOLFAPI_ALLOWLIST.
 * Allowlist value CoS sets: id_1791116603913_10pagfk2. Empty means nobody
 * is exempt. Exact match. Not hardcoded here.
 *
 * Vars: GOLFAPI_INSTALL_DAILY_PULLS (4), GOLFAPI_DAILY_CAP (150),
 * GOLFAPI_MONTHLY_CAP (450), GOLFAPI_CREDIT_FLOOR (50),
 * GOLFAPI_PLAN_MONTHLY (500), GOLFAPI_CYCLE_DAY (5),
 * GOLFAPI_INSTALL_DAILY_SEARCHES (30, not returned to the phone),
 * GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP (20 credits, not returned to the phone),
 * GOLFAPI_ROLLOVER_CREDITS (156, never-expire balance the stockpile keeps),
 * GOLFAPI_STOCKPILE_ENABLED (false until Doc turns the stockpile on),
 * GOLFAPI_STOCKPILE_RUN_CREDITS (safety ceiling, toml only, no code default;
 *   ships at 800). Stockpile spend is stored on golfapi:stockpile:credit:*
 *   and does not move the golfer daily or monthly counters.
 * GOLFAPI_STOCKPILE_MAX_DAYS (7, the last nights before renewal at 23:00 UTC;
 *   a higher value is clamped to 7),
 * TERRAIN_INSTALL_DAILY_CAP (54, three full courses),
 * TERRAIN_MAX_GRID_POINTS (6000, Workers Paid).
 * ALERT_TO (shottraxx@gmail.com), ALERT_FROM (alerts@shottraxx.com).
 * Secret ALERT_ADMIN_TOKEN gates POST /admin/alert-test and GET /admin/demand.
 * An empty secret rejects both. An install id does not grant access.
 * The test send is limited to 1 per 10 minutes and 5 per UTC day in the DO.
 * 2000-plan caps, set only on the day Doc upgrades golfapi:
 *   GOLFAPI_DAILY_CAP=300
 *   GOLFAPI_MONTHLY_CAP=1800
 *   GOLFAPI_PLAN_MONTHLY=2000
 *
 * GOLFAPI_CREDIT_FLOOR is the reserve Doc approved with the caps. The live
 * Worker already enforces it (PRs #379, #385–#387). A paid call is refused
 * with golfapi_limited when the last-seen apiRequestsLeft is at or below
 * the floor, including an allowlisted install. The allowlist still skips
 * the per-phone pull limit and the 150/450 caps. A balance that has never been seen does not block.
 * A KV or edge hit is never refused by the floor. The number is read from
 * the JSON field apiRequestsLeft, else the apiRequestsLeft or
 * X-Api-Requests-Left header, and stored at gq:balance in GOLFAPI_KV.
 *
 * Durable Object `GolfapiCounter` (binding GOLFAPI_COUNTER) is SQLite-backed
 * so it runs on the Workers Paid plan. It holds the per-phone pull count,
 * the per-phone search count, the per-phone credit backstop, the app-daily
 * and app-monthly counters, the per-call open charge, the terrain per-phone
 * sample count, the terrain sampler lock, the billing-cycle start balance,
 * the usage-alert sent flags, the last 200 US course ids per field-build
 * phone, and the demand log. Those do not write KV.
 * The monthly counter uses the golfapi billing cycle (GOLFAPI_CYCLE_DAY,
 * default the 5th, through the 4th), the same cycle as the alert flags.
 * golfapi bills 0.1 for a name search and 1 for a course or coordinates pull.
 * Counters store those amounts in tenths so 0.1 does not drift. A new open
 * needs room for 2.1 credits (one search plus course and coordinates) on the
 * app counters and the per-phone backstop, then charges the actual cost of
 * this call. Each later paid call in that open needs room for its own cost
 * and charges that cost. A failed call refunds what it charged. A stored
 * copy charges 0 and does not count as a search. The backstop is 20 credits
 * of spend per phone per day. The 31st search in a UTC day is refused.
 * The backstop is not included in /status or the 429 body.
 *
 * Field builds 149–151 keep the course ids from a US search on that phone's
 * DO record (last 200, dropped after 7 days). A later course or coordinates
 * read checks that record and `golfapi:us:{id}`. It does not list KV.
 *
 * Usage alerts fire at 75%, 90%, and 95% of GOLFAPI_PLAN_MONTHLY (500).
 * used = (first apiRequestsLeft seen this cycle) - (current apiRequestsLeft),
 * so the non-expiring extra credits in that field cancel out. If this cycle
 * has no start balance yet, the Worker's own cycle count is the fallback.
 * Each threshold sends once per cycle. The send uses the ALERT_EMAIL binding
 * from ctx.waitUntil and never fails the golfer's request.
 *
 * KV: GOLFAPI_KV (permanent bodies, an opened course id, gq:balance).
 * TERRAIN_KV (finished terrain blobs only).
 * TERRAIN_KV falls back to GOLFAPI_KV.
 */

import { handleStockpileAdmin, usStateCode } from './golf-stockpile.js';

const VENDORS = {
  gca: {
    prefix: '/gca/v1/',
    upstream: 'https://golfcoursesapi.com/api/v1/',
    secret: 'GOLF_COURSES_API_KEY',
    routes: [/^courses$/, /^courses\/[^/]+$/, /^courses\/[^/]+\/green-centers$/],
  },
  golfapi: {
    prefix: '/golfapi/v2.3/',
    upstream: 'https://golfapi.io/api/v2.3/',
    secret: 'GOLFAPI_KEY',
    routes: [/^courses$/, /^courses\/[^/]+$/, /^coordinates\/[^/]+$/],
  },
};

const GOLFAPI_STATUS_PATH = '/golfapi/v2.3/status';
const GOLFAPI_EXEMPT_HEADER = 'X-ShotTraxx-Golfapi-Exempt';
const STOREFRONT_HEADER = 'X-ShotTraxx-Storefront';
const INSTALL_HEADER = 'X-Install-Id';

/** Edge cache for successful vendor reads. Course, coordinates, and search hits stay in KV with no TTL. */
const CACHE_SECONDS = 60 * 60 * 24;
/** Zero-hit name search only. A repeat inside this window is served as a stored copy. */
const EMPTY_SEARCH_TTL = 604800;
const EMPTY_SEARCH_HEADER = 'X-ShotTraxx-Golfapi-Empty-Search';
const TERRAIN_CACHE_SECONDS = 60 * 60 * 24 * 365;

const DEFAULT_INSTALL_PULLS = 4;
const DEFAULT_DAILY_SEARCHES = 30;
/** Per-phone credit spend. A name search is 0.1; a course or coordinates pull is 1. */
const DEFAULT_CALL_BACKSTOP = 20;
const SEARCH_CREDIT_TENTHS = 1;
const PULL_CREDIT_TENTHS = 10;
/** One search plus a course pull and a coordinates pull. Room check for a new open. */
const OPEN_ROOM_TENTHS = SEARCH_CREDIT_TENTHS + PULL_CREDIT_TENTHS + PULL_CREDIT_TENTHS;
const DEFAULT_APP_DAILY = 150;
const DEFAULT_APP_MONTHLY = 450;
const DEFAULT_CREDIT_FLOOR = 50;
const DEFAULT_PLAN_MONTHLY = 500;
const DEFAULT_CYCLE_DAY = 5;
const ALERT_LEVELS = [75, 90, 95];
const ALERT_RETRY_MS = 60 * 60 * 1000;
const ALERT_TEST_INTERVAL_MS = 10 * 60 * 1000;
const ALERT_TEST_DAILY = 5;
const PHONE_US_ID_LIMIT = 200;
const PHONE_US_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEMAND_LIMIT = 500;
const DEMAND_REASONS = new Set(['non_us', 'phone_limit', 'app_cap', 'no_data']);
const DEFAULT_TERRAIN_DAILY = 54;
/** Same key the live Worker uses for the last-seen golfapi balance. */
const GOLFAPI_BALANCE_KEY = 'gq:balance';
const DEFAULT_LOCK_TTL_SEC = 120;
const DEFAULT_LOCK_WAIT_MS = 400;
const OPEN_WINDOW_MS = 15 * 60 * 1000;

/** Doc's install. CoS puts this in the GOLFAPI_ALLOWLIST secret. Not auto-exempt. */
export const DOC_GOLFAPI_ALLOWLIST_ID = 'id_1791116603913_10pagfk2';

const TERRAIN_PREFIX = '/terrain/v1/';
const USGS_3DEP_SAMPLES_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';
export const TERRAIN_GRID_STEP_M = 10;
export const TERRAIN_CORRIDOR_BUFFER_M = 150;
/** Workers Paid plan default. */
export const MAX_GRID_POINTS = 6000;
const FEET_PER_METER = 3.280839895013123;
const METERS_PER_DEG_LAT = 111_320;
const SAMPLE_BATCH = 100;

/** Same-isolate guard so two concurrent requests cannot both pass the KV lock check. */
const terrainInflight = new Set();

/** Tests clear a lock left behind by a failed sample. */
export function resetTerrainInflightForTests() {
  terrainInflight.clear();
}

/**
 * Simple bounding polygons for the US and territories. CONUS is a coarse
 * outline (not a coastline). The others are inclusive bounding rectangles.
 * A sample is allowed only when every corner of the corridor sits inside one
 * polygon. Rings are [lat, lng].
 */
const CONUS_RING = [
  [49.0, -124.8],
  [49.0, -95.15],
  [48.3, -89.6],
  [46.8, -84.7],
  [45.3, -83.4],
  [43.6, -82.1],
  [41.7, -83.1],
  [41.7, -82.4],
  [42.9, -78.9],
  [43.6, -76.2],
  [44.2, -76.3],
  [44.8, -74.9],
  [45.0, -71.5],
  [47.3, -69.2],
  [47.46, -68.0],
  [45.1, -67.0],
  [43.0, -70.6],
  [41.4, -70.0],
  [40.5, -74.0],
  [36.9, -75.7],
  [35.2, -75.5],
  [32.0, -80.6],
  [30.3, -81.2],
  [28.4, -80.4],
  [26.5, -80.0],
  [25.7, -80.1],
  [25.1, -80.3],
  [24.45, -81.9],
  [24.5, -82.05],
  [25.3, -81.3],
  [26.2, -82.1],
  [27.8, -82.85],
  [29.2, -89.4],
  [28.9, -95.3],
  [26.1, -97.1],
  [25.84, -97.5],
  [26.5, -99.2],
  [28.2, -100.5],
  [29.4, -103.2],
  [31.4, -105.8],
  [31.55, -106.7],
  [31.33, -108.2],
  [31.33, -111.1],
  [32.53, -117.25],
  [34.5, -120.6],
  [38.9, -123.7],
  [42.0, -124.3],
  [46.3, -124.1],
  [48.4, -124.7],
];

const US_RECTANGLES = [
  { name: 'alaska', minLat: 51.2, maxLat: 71.4, minLng: -179.15, maxLng: -129.97 },
  { name: 'aleutians', minLat: 51.0, maxLat: 54.5, minLng: 172.0, maxLng: 180.0 },
  { name: 'hawaii', minLat: 18.91, maxLat: 22.24, minLng: -160.25, maxLng: -154.8 },
  { name: 'puerto-rico', minLat: 17.88, maxLat: 18.52, minLng: -67.28, maxLng: -65.24 },
  { name: 'usvi', minLat: 17.67, maxLat: 18.42, minLng: -65.09, maxLng: -64.56 },
  { name: 'guam', minLat: 13.23, maxLat: 13.66, minLng: 144.63, maxLng: 144.96 },
  { name: 'nmi', minLat: 14.11, maxLat: 20.56, minLng: 145.11, maxLng: 146.07 },
  { name: 'american-samoa', minLat: -14.55, maxLat: -14.15, minLng: -170.86, maxLng: -169.41 },
];

function json(status, body, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function limited(reason, retryAfterSec) {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  return json(
    429,
    {
      error: 'golfapi_limited',
      message: 'golfapi_limited',
      reason,
      queued: true,
      retryAfterSec: sec,
    },
    { 'Retry-After': String(sec) },
  );
}

function edgeCache() {
  const root = globalThis.caches;
  if (root && root.default) return root.default;
  return null;
}

function intEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function golfApiAllowlist(env) {
  const raw = env && typeof env.GOLFAPI_ALLOWLIST === 'string' ? env.GOLFAPI_ALLOWLIST : '';
  const ids = new Set();
  for (const part of raw.split(/[\s,]+/)) {
    const id = part.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function installIdOf(request) {
  return (request.headers.get(INSTALL_HEADER) ?? '').trim();
}

function installIsExempt(request, env) {
  const id = installIdOf(request);
  if (!id) return false;
  return golfApiAllowlist(env).has(id);
}

/**
 * `US` and `USA` only, after the same fold the app uses (drop dots and
 * non-letters, so `U.S.A.` counts). A missing header is not US.
 */
function storefrontIsUs(request) {
  if (!request.headers.has(STOREFRONT_HEADER)) return false;
  const raw = (request.headers.get(STOREFRONT_HEADER) ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z]/g, '');
  return raw === 'us' || raw === 'usa';
}

function queryCountryIsUs(url) {
  const country = url.searchParams.get('country');
  if (country == null) return false;
  const raw = country.toLowerCase().replace(/\./g, '').replace(/[^a-z]/g, '');
  return raw === 'us' || raw === 'usa';
}

/**
 * Header goes on the response the phone sees, after the KV / edge lookup.
 * The stored response has no exempt header. Computed from this request's
 * install ID. `1` is allowlisted. Any other value is not.
 */
function withExemptHeader(response, exempt) {
  const headers = new Headers(response.headers);
  headers.set(GOLFAPI_EXEMPT_HEADER, exempt ? '1' : '0');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function matchVendor(pathname) {
  for (const vendor of Object.values(VENDORS)) {
    if (!pathname.startsWith(vendor.prefix)) continue;
    const rest = pathname.slice(vendor.prefix.length);
    if (vendor.routes.some((route) => route.test(rest))) return { vendor, rest };
    return { vendor, rest: null };
  }
  return null;
}

function secretOf(env, name) {
  return typeof env?.[name] === 'string' ? env[name].trim() : '';
}

function golfKv(env) {
  return env?.GOLFAPI_KV ?? null;
}

function terrainKv(env) {
  return env?.TERRAIN_KV ?? env?.GOLFAPI_KV ?? null;
}

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

function secondsUntilUtcDay(now) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function cycleDayOf(env) {
  const day = intEnv(env, 'GOLFAPI_CYCLE_DAY', DEFAULT_CYCLE_DAY);
  if (day < 1) return DEFAULT_CYCLE_DAY;
  return Math.min(28, day);
}

/**
 * Billing cycle id, `YYYY-MM-DD` of the cycle start.
 * The cycle runs from GOLFAPI_CYCLE_DAY (default the 5th) through the day
 * before that date next month. 1–4 October still belong to 5 September.
 */
export function golfapiCycleId(now, cycleDay = DEFAULT_CYCLE_DAY) {
  const day = Math.min(28, Math.max(1, Number(cycleDay) || DEFAULT_CYCLE_DAY));
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() < day) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function secondsUntilCycle(now, cycleDay) {
  const day = Math.min(28, Math.max(1, Number(cycleDay) || DEFAULT_CYCLE_DAY));
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() >= day) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  const next = Date.UTC(year, month, day);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function courseIdFromRest(rest) {
  const match = /^(?:courses|coordinates)\/([^/]+)$/.exec(rest);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function usCourseKey(id) {
  return `golfapi:us:${id}`;
}

/** `stored=1` is a client flag, not part of the golfapi query, so it must not change the KV key. */
function golfApiLookupUrl(url) {
  if (!url.searchParams.has('stored')) return url;
  const copy = new URL(url.toString());
  copy.searchParams.delete('stored');
  return copy;
}

function permanentKey(rest, url) {
  const id = courseIdFromRest(rest);
  if (rest.startsWith('coordinates/') && id) return `golfapi:permanent:coordinates:${id}`;
  if (rest.startsWith('courses/') && id) return `golfapi:permanent:course:${id}`;
  const params = [...url.searchParams.entries()].filter(([key]) => key !== 'stored');
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return `golfapi:permanent:search:${new URLSearchParams(params).toString()}`;
}

function collectCourseIds(node, into) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectCourseIds(item, into);
    return;
  }
  const id = node.courseID ?? node.courseId;
  if (typeof id === 'string' && id.trim()) into.add(id.trim());
  else if (typeof id === 'number' && Number.isFinite(id)) into.add(String(id));
  for (const key of ['courses', 'data', 'results', 'course']) {
    if (node[key]) collectCourseIds(node[key], into);
  }
}

function placeIsUs(value) {
  if (typeof value !== 'string') return false;
  const raw = value.toLowerCase().replace(/\./g, '').replace(/[^a-z]/g, '');
  return raw === 'us' || raw === 'usa' || raw === 'unitedstates' || raw === 'unitedstatesofamerica';
}

function idsMarkedUsByBody(node, into) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) idsMarkedUsByBody(item, into);
    return;
  }
  const country = node.country ?? node.countryCode ?? node.country_code;
  if (placeIsUs(country)) {
    const id = node.courseID ?? node.courseId;
    if (typeof id === 'string' && id.trim()) into.add(id.trim());
    else if (typeof id === 'number' && Number.isFinite(id)) into.add(String(id));
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') idsMarkedUsByBody(value, into);
  }
}

/**
 * Who may trigger a paid golfapi pull.
 *
 * 1. Allowlisted install: exempt from the storefront rule, the 4-pull limit,
 *    the search cap, the credit backstop, and the 150/450 caps. Not exempt from GOLFAPI_CREDIT_FLOOR.
 * 2. Header present and US/USA: any course worldwide, caps still apply.
 * 3. Field builds 149–151 ONLY. The header is absent entirely (not present
 *    and blank). Then either the query country is US/USA (those builds
 *    hardcode country=US on name search) or the id is already recorded as a
 *    US course. A present non-US header is always refused, even with
 *    country=US and even for a known US id. A missing header on any other
 *    request is refused: a missing storefront is not US.
 */
async function golfapiSpendAllowed(request, url, rest, env, kv) {
  if (installIsExempt(request, env)) return { ok: true };
  if (!installIdOf(request)) return { ok: false, reason: 'storefront' };
  if (request.headers.has(STOREFRONT_HEADER)) {
    if (storefrontIsUs(request)) return { ok: true };
    return { ok: false, reason: 'storefront' };
  }
  if (queryCountryIsUs(url)) return { ok: true };
  const courseId = courseIdFromRest(rest);
  if (courseId && kv) {
    const known = await knownUsCourse(env, kv, installIdOf(request), courseId);
    if (known.known) return { ok: true, usFromSearch: known.via === 'search' ? courseId : null };
  }
  return { ok: false, reason: 'storefront' };
}

async function knownUsCourse(env, kv, install, id) {
  if (!id) return { known: false, via: null };
  if (kv && (await kv.get(usCourseKey(id)))) return { known: true, via: 'id' };
  if (!install) return { known: false, via: null };
  const noted = await counterFetch(env, { op: 'phoneHasId', install, id, now: Date.now() });
  if (noted && noted.known) return { known: true, via: 'search' };
  return { known: false, via: null };
}

function counterStub(env) {
  const ns = env && env.GOLFAPI_COUNTER;
  if (!ns || typeof ns.get !== 'function') return null;
  const id = typeof ns.idFromName === 'function' ? ns.idFromName('golfapi') : 'golfapi';
  return ns.get(id);
}

async function counterFetch(env, body) {
  const stub = counterStub(env);
  if (!stub || typeof stub.fetch !== 'function') return null;
  const response = await stub.fetch('https://golfapi-counter.internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function creditKeySet(install, now, env) {
  const day = utcDay(now);
  const cycleId = golfapiCycleId(now, cycleDayOf(env));
  return {
    installKey: `golfapi:credit:install:${install}:${day}`,
    pullKey: `golfapi:pull:${install}:${day}`,
    searchKey: `golfapi:search:${install}:${day}`,
    dayKey: `golfapi:credit:day:${day}`,
    monthKey: `golfapi:credit:month:${cycleId}`,
    cycleId,
  };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function learnUsIds(kv, rest, url, text) {
  const ids = new Set();
  const parsed = parseJsonLoose(text);
  if (queryCountryIsUs(url)) collectCourseIds(parsed, ids);
  if (parsed) idsMarkedUsByBody(parsed, ids);
  const pathId = courseIdFromRest(rest);
  if (pathId && parsed && placeIsUs(parsed.country ?? parsed.countryCode ?? parsed.country_code)) {
    ids.add(pathId);
  }
  if (!pathId || ids.size === 0 || !ids.has(pathId)) return;
  const key = usCourseKey(pathId);
  if (await kv.get(key)) return;
  await kv.put(key, '1');
}

function finiteNumber(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function latLngOf(node) {
  if (!node || typeof node !== 'object') return null;
  const lat = finiteNumber(node.latitude ?? node.lat);
  const lng = finiteNumber(node.longitude ?? node.lng);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function holeNo(node) {
  const n = finiteNumber(node.hole ?? node.holeNumber ?? node.hole_number);
  if (n == null || n < 1) return null;
  return Math.floor(n);
}

function markHole(holes, hole, kind) {
  if (!hole || !kind) return false;
  let row = holes.get(hole);
  if (!row) {
    row = { green: false, tee: false };
    holes.set(hole, row);
  }
  if (kind === 'green') row.green = true;
  if (kind === 'tee') row.tee = true;
  return row.green && row.tee;
}

function nodeHasMapPoint(node, holes) {
  const hole = holeNo(node);
  const poi = finiteNumber(node.poi);
  if (hole && latLngOf(node) && poi != null) {
    const kind = poi === 1 ? 'green' : poi === 11 || poi === 12 ? 'tee' : null;
    if (markHole(holes, hole, kind)) return true;
  }
  const tee = latLngOf({
    lat: node.teeLat ?? node.teeLatitude,
    lng: node.teeLng ?? node.teeLongitude,
  });
  const green = latLngOf({
    lat: node.greenLat ?? node.greenLatitude,
    lng: node.greenLng ?? node.greenLongitude,
  });
  if (hole && tee && markHole(holes, hole, 'tee')) return true;
  if (hole && green && markHole(holes, hole, 'green')) return true;
  return false;
}

function walkNodes(node, visit) {
  if (!node || typeof node !== 'object') return false;
  if (visit(node)) return true;
  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    if (value && typeof value === 'object' && walkNodes(value, visit)) return true;
  }
  return false;
}

/** A hole with both a tee and a green. Search hits and bare course cards are not. */
function hasUsableMap(payload) {
  const holes = new Map();
  return walkNodes(payload, (node) => nodeHasMapPoint(node, holes));
}

function textField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function courseIdentity(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const idRaw = node.courseID ?? node.courseId;
  const courseId = typeof idRaw === 'number' && Number.isFinite(idRaw)
    ? String(Math.trunc(idRaw))
    : textField(idRaw);
  const club = textField(node.clubName) || textField(node.courseName);
  const name = club || (courseId ? textField(node.name) : '');
  const country = textField(node.country ?? node.countryCode ?? node.country_code);
  if (!courseId && !club) return null;
  return { courseId, name, country };
}

function statesFromSearch(url, payload) {
  const found = new Set();
  const query = usStateCode(url.searchParams.get('state'));
  if (query) found.add(query);
  const rows = payload && Array.isArray(payload.courses) ? payload.courses : [];
  for (const row of rows) {
    const code = usStateCode(row && row.state);
    if (code) found.add(code);
  }
  return [...found];
}

function coursesInPayload(payload) {
  const found = [];
  const seen = new Set();
  walkNodes(payload, (node) => {
    const row = courseIdentity(node);
    if (!row) return false;
    const key = row.courseId || `${row.name}|${row.country}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push(row);
    }
    return false;
  });
  return found;
}

async function noteCourses(env, now, reason, courses) {
  const rows = (courses || []).filter((course) => course && (course.courseId || course.name || course.country));
  if (rows.length === 0) return;
  await counterFetch(env, {
    op: 'noteCourses',
    cycleId: golfapiCycleId(now, cycleDayOf(env)),
    day: utcDay(now),
    reason: reason || '',
    courses: rows.map((course) => ({
      courseId: course.courseId || '',
      name: course.name || '',
      country: course.country || '',
    })),
  });
}

async function logKnownRefusal(env, now, reason, courseId) {
  if (!courseId || !reason) return;
  const known = (await counterFetch(env, { op: 'knownCourse', courseId })) || {};
  await noteCourses(env, now, reason, [{
    courseId,
    name: known.name || '',
    country: known.country || '',
  }]);
}

function serveStored(envelope, cacheControl) {
  const parsed = typeof envelope === 'string' ? parseJsonLoose(envelope) : null;
  if (!parsed || typeof parsed.body !== 'string') return null;
  return new Response(parsed.body, {
    status: typeof parsed.status === 'number' ? parsed.status : 200,
    headers: {
      'Content-Type': parsed.contentType || 'application/json',
      'Cache-Control': cacheControl,
    },
  });
}

async function putEdge(cache, request, response) {
  if (!cache) return;
  await cache.put(request, response.clone());
}

/** Body field first, then the headers the live Worker already reads. */
function readRequestsLeft(payload, headers) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const raw = payload.apiRequestsLeft;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (!headers || typeof headers.get !== 'function') return null;
  for (const name of ['apiRequestsLeft', 'X-Api-Requests-Left']) {
    const raw = headers.get(name);
    if (raw == null || String(raw).trim() === '') continue;
    const parsed = Number(String(raw).trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function readBalance(kv) {
  if (!kv) return null;
  const raw = await kv.get(GOLFAPI_BALANCE_KEY);
  if (typeof raw !== 'string' || !raw) return null;
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const left = typeof parsed.left === 'number' && Number.isFinite(parsed.left) ? parsed.left : null;
  if (left == null) return null;
  return parsed;
}

async function rememberBalance(kv, status, payload, headers) {
  const left = readRequestsLeft(payload, headers);
  if (left == null || !kv) return left;
  await kv.put(GOLFAPI_BALANCE_KEY, JSON.stringify({ left, at: Date.now(), lastStatus: status }));
  return left;
}

function alertAddresses(env) {
  return {
    from: secretOf(env, 'ALERT_FROM') || 'alerts@shottraxx.com',
    to: secretOf(env, 'ALERT_TO') || 'shottraxx@gmail.com',
  };
}

function alertText(env, noted, pct) {
  const plan = intEnv(env, 'GOLFAPI_PLAN_MONTHLY', DEFAULT_PLAN_MONTHLY);
  const monthCap = intEnv(env, 'GOLFAPI_MONTHLY_CAP', DEFAULT_APP_MONTHLY);
  const dayCap = intEnv(env, 'GOLFAPI_DAILY_CAP', DEFAULT_APP_DAILY);
  const floor = intEnv(env, 'GOLFAPI_CREDIT_FLOOR', DEFAULT_CREDIT_FLOOR);
  const left = noted.left == null ? null : Number(noted.left);
  const known = left != null && Number.isFinite(left);
  const raw = known ? String(left) : 'unknown';
  const before = known ? String(Math.max(0, left - floor)) : 'unknown';
  const golf = noted.source === 'fallback'
    ? `Golfapi: no start-of-cycle balance yet, so this percent uses the Worker count ${noted.used}/${plan}. apiRequestsLeft ${raw}.`
    : `Golfapi: ${noted.used}/${plan} used (${pct}%). apiRequestsLeft ${raw}.`;
  const lines = [];
  if (noted.sample) lines.push('This is a test email. No golfapi credit was used.');
  lines.push(
    `ShotTraxx golfapi usage crossed ${pct}% of the ${plan}-call plan.`,
    golf,
    `Worker count this cycle: ${noted.workerCount}/${monthCap}.`,
    `Today: ${noted.dayCount}/${dayCap}.`,
    `Credits left before the floor: ${before}.`,
    'Moving to the 2000 plan raises the caps (daily 300, monthly 1800, plan allowance 2000).',
  );
  return lines.join('\n');
}

function plainEmail(from, to, subject, text) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n');
}

/**
 * Returns false when the binding is missing or the send throws.
 * Never throws. Does not call golfapi.
 */
export async function sendPlainEmail(env, subject, text) {
  const binding = env?.ALERT_EMAIL;
  if (!binding || typeof binding.send !== 'function') {
    console.log('alert email binding missing');
    return false;
  }
  const { from, to } = alertAddresses(env);
  const raw = plainEmail(from, to, subject, text);
  let message = { from, to, raw };
  try {
    const mod = await import('cloudflare:email');
    if (mod && typeof mod.EmailMessage === 'function') {
      message = new mod.EmailMessage(from, to, raw);
    }
  } catch {
    // Node tests and runtimes without the email module send the plain message.
  }
  try {
    await binding.send(message);
    return true;
  } catch (err) {
    console.log('alert email send failed', err && err.message ? err.message : err);
    return false;
  }
}

async function deliverAlert(env, noted) {
  const pct = noted.pct;
  const subject = noted.sample
    ? 'ShotTraxx golfapi alert test'
    : `ShotTraxx golfapi usage crossed ${pct}%`;
  return sendPlainEmail(env, subject, alertText(env, noted, pct));
}

async function sendClaimedAlerts(env, noted) {
  for (const pct of noted.alerts) {
    const ok = await deliverAlert(env, { ...noted, pct });
    if (!ok) {
      console.log('alert email not sent', pct);
      break;
    }
    await counterFetch(env, { op: 'markAlertSent', cycleId: noted.cycleId, pct });
  }
}

function scheduleAlerts(ctx, env, noted) {
  if (!noted || !Array.isArray(noted.alerts) || noted.alerts.length === 0) return;
  const task = sendClaimedAlerts(env, noted).catch((err) => {
    console.log('alert email failed', err && err.message ? err.message : err);
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
}

function adminTokenOk(request, env) {
  const expected = secretOf(env, 'ALERT_ADMIN_TOKEN');
  const got = (request.headers.get('X-Admin-Token') || '').trim();
  if (!expected || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function handleAlertTest(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!adminTokenOk(request, env)) return json(401, { error: 'unauthorized' });
  const now = new Date();
  const slot = await counterFetch(env, {
    op: 'claimAlertTest',
    now: now.getTime(),
    day: utcDay(now),
    retryDay: secondsUntilUtcDay(now),
  });
  if (!slot) return json(503, { error: 'not_configured' });
  if (slot.ok === false) {
    const sec = Math.max(1, Math.ceil(slot.retryAfterSec || 1));
    return json(
      429,
      { error: 'alert_test_limited', message: 'alert_test_limited', retryAfterSec: sec },
      { 'Retry-After': String(sec) },
    );
  }
  const ok = await deliverAlert(env, {
    pct: 75,
    used: 375,
    left: 281,
    workerCount: 0,
    dayCount: 0,
    source: 'balance',
    sample: true,
  });
  if (!ok) return json(503, { error: 'alert_email_unavailable' });
  return json(200, { ok: true });
}

async function handleDemand(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  if (!adminTokenOk(request, env)) return json(401, { error: 'unauthorized' });
  const now = new Date();
  const listed = await counterFetch(env, {
    op: 'readDemand',
    cycleId: golfapiCycleId(now, cycleDayOf(env)),
  });
  return json(200, listed || { pull_candidates: [], no_data: [] });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function payloadHasError(payload) {
  return !isPlainObject(payload) || (payload.error != null && payload.error !== false);
}

const GOLFAPI_QUOTA_TEXT = /quota|rate.?limit|too many requests|limit (reached|exceeded)|no (api )?requests left|insufficient (credits|requests)|subscription|unauthori[sz]ed|invalid api key|forbidden/i;

function looksLikeQuota(payload) {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.message === 'string' && payload.message.trim() !== '') return true;
  for (const field of ['status', 'detail', 'msg']) {
    if (typeof payload[field] === 'string' && GOLFAPI_QUOTA_TEXT.test(payload[field])) return true;
  }
  return false;
}

function searchRowHasData(row) {
  if (!isPlainObject(row)) return false;
  if (Array.isArray(row.courses)) return row.courses.length > 0;
  return true;
}

/** Live golfapiBodyHasData('search'): a courses array with at least one real row. */
function searchHasHits(payload) {
  if (payloadHasError(payload) || !Array.isArray(payload.courses)) return false;
  return payload.courses.some(searchRowHasData);
}

function searchIsZeroHit(payload) {
  if (payloadHasError(payload) || looksLikeQuota(payload)) return false;
  return Array.isArray(payload.courses) && payload.courses.length === 0;
}

function searchStorePlan(status, payload) {
  if (status !== 200) return null;
  if (searchHasHits(payload)) return 'permanent';
  if (searchIsZeroHit(payload)) return 'ttl';
  return null;
}

function searchEnvelopeUsable(raw) {
  const envelope = typeof raw === 'string' ? parseJsonLoose(raw) : null;
  if (!envelope || typeof envelope.body !== 'string') return false;
  const payload = parseJsonLoose(envelope.body);
  if (searchHasHits(payload)) return true;
  return envelope.emptySearchTtl === EMPTY_SEARCH_TTL && searchIsZeroHit(payload);
}

function emptySearchMaxAge(envelope, now = Date.now()) {
  const until = envelope && typeof envelope.emptySearchUntil === 'number' ? envelope.emptySearchUntil : null;
  if (until == null) return EMPTY_SEARCH_TTL;
  const remaining = Math.ceil((until - now) / 1000);
  if (remaining <= 0) return 0;
  return Math.min(EMPTY_SEARCH_TTL, remaining);
}

function emptySearchHeaders(contentType, maxAge) {
  return {
    'Content-Type': contentType || 'application/json',
    'Cache-Control': `public, max-age=${maxAge}`,
    [EMPTY_SEARCH_HEADER]: String(EMPTY_SEARCH_TTL),
  };
}

function markedEmptyEnvelope(raw) {
  const envelope = typeof raw === 'string' ? parseJsonLoose(raw) : null;
  if (!envelope || envelope.emptySearchTtl !== EMPTY_SEARCH_TTL || typeof envelope.body !== 'string') return null;
  const payload = parseJsonLoose(envelope.body);
  if (!searchIsZeroHit(payload)) return null;
  return envelope;
}

/** Same headers as the first zero-hit reply. max-age is the row's remaining life, never the 24h edge default. */
async function serveMarkedEmptySearch(raw, cache, cacheKey) {
  const envelope = markedEmptyEnvelope(raw);
  if (!envelope) return null;
  const maxAge = emptySearchMaxAge(envelope);
  if (maxAge <= 0) return null;
  const response = new Response(envelope.body, {
    status: typeof envelope.status === 'number' ? envelope.status : 200,
    headers: emptySearchHeaders(envelope.contentType, maxAge),
  });
  await putEdge(cache, cacheKey, response);
  return response;
}

async function edgeSearchUsable(response) {
  let text = '';
  try {
    text = await response.clone().text();
  } catch {
    return false;
  }
  const payload = parseJsonLoose(text);
  if (searchHasHits(payload)) return true;
  return response.headers.get(EMPTY_SEARCH_HEADER) === String(EMPTY_SEARCH_TTL) && searchIsZeroHit(payload);
}

async function refundStoredOpen(env, request, rest) {
  const install = installIdOf(request);
  if (!install || installIsExempt(request, env)) return;
  try {
    await counterFetch(env, {
      op: 'refundCache',
      install,
      courseId: courseIdFromRest(rest),
      now: Date.now(),
    });
  } catch {
    // A stored copy is still served when the counter cannot be reached.
  }
}

async function handleGolfApi(request, url, rest, env, exempt, ctx) {
  const kv = golfKv(env);
  const cache = edgeCache();
  const storedOnly = url.searchParams.get('stored') === '1';
  const lookup = golfApiLookupUrl(url);
  const cacheKey = new Request(lookup.toString(), { method: 'GET' });
  const storedKey = permanentKey(rest, lookup);
  const search = rest === 'courses';
  if (kv) {
    const hit = await kv.get(storedKey);
    if (hit && search && markedEmptyEnvelope(hit)) {
      const served = await serveMarkedEmptySearch(hit, cache, cacheKey);
      if (served) {
        await refundStoredOpen(env, request, rest);
        return withExemptHeader(served, exempt);
      }
    } else if (hit && (!search || searchEnvelopeUsable(hit))) {
      const stored = serveStored(hit, `public, max-age=${CACHE_SECONDS}`);
      if (stored) {
        await refundStoredOpen(env, request, rest);
        return withExemptHeader(stored, exempt);
      }
    }
  }
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached && (!search || await edgeSearchUsable(cached))) {
      await refundStoredOpen(env, request, rest);
      return withExemptHeader(cached, exempt);
    }
  }

  // Stored-only: KV or edge, then stop. A miss must not reserve a credit or call golfapi.
  if (storedOnly) return withExemptHeader(json(404, { error: 'not_stored' }), exempt);

  if (!kv) return json(503, { error: 'not_configured' });
  const now = new Date();
  const pathId = courseIdFromRest(rest);
  const balance = await readBalance(kv);
  const floor = intEnv(env, 'GOLFAPI_CREDIT_FLOOR', DEFAULT_CREDIT_FLOOR);
  if (balance && balance.left <= floor) {
    await logKnownRefusal(env, now, 'app_cap', pathId);
    return limited('floor', secondsUntilUtcDay(now));
  }
  const spend = await golfapiSpendAllowed(request, url, rest, env, kv);
  if (!spend.ok) {
    await logKnownRefusal(env, now, 'non_us', pathId);
    return limited(spend.reason, secondsUntilUtcDay(now));
  }

  let openKey = null;
  let pendingAlert = null;
  const usage = creditKeySet(installIdOf(request) || 'none', now, env);
  if (!exempt) {
    const reserved = await counterFetch(env, {
      op: 'reserve',
      install: installIdOf(request),
      courseId: pathId,
      now: now.getTime(),
      ...usage,
      callCap: intEnv(env, 'GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP', DEFAULT_CALL_BACKSTOP),
      pullCap: intEnv(env, 'GOLFAPI_INSTALL_DAILY_PULLS', DEFAULT_INSTALL_PULLS),
      searchCap: intEnv(env, 'GOLFAPI_INSTALL_DAILY_SEARCHES', DEFAULT_DAILY_SEARCHES),
      dayCap: intEnv(env, 'GOLFAPI_DAILY_CAP', DEFAULT_APP_DAILY),
      monthCap: intEnv(env, 'GOLFAPI_MONTHLY_CAP', DEFAULT_APP_MONTHLY),
      planMonthly: intEnv(env, 'GOLFAPI_PLAN_MONTHLY', DEFAULT_PLAN_MONTHLY),
      chargeTenths: search ? SEARCH_CREDIT_TENTHS : PULL_CREDIT_TENTHS,
      needTenths: OPEN_ROOM_TENTHS,
      isSearch: search,
      retryDay: secondsUntilUtcDay(now),
      retryMonth: secondsUntilCycle(now, cycleDayOf(env)),
    });
    if (!reserved) return json(503, { error: 'not_configured' });
    if (reserved.ok === false) {
      const demandReason = reserved.reason === 'phone_limit' ? 'phone_limit' : 'app_cap';
      if (pathId) await logKnownRefusal(env, now, demandReason, pathId);
      else if (search && demandReason === 'phone_limit') {
        await noteCourses(env, now, 'phone_limit', [{
          courseId: '',
          name: url.searchParams.get('name') || '',
          country: url.searchParams.get('country') || '',
        }]);
      }
      return limited(reserved.reason, reserved.retryAfterSec);
    }
    openKey = reserved.openKey;
    if (reserved.alerts?.length) pendingAlert = reserved;
  }
  if (spend.usFromSearch) await kv.put(usCourseKey(spend.usFromSearch), '1');

  const key = secretOf(env, 'GOLFAPI_KEY');
  if (!key) {
    if (openKey) {
      await counterFetch(env, {
        op: 'settle',
        openKey,
        outcome: 'refund',
        refundTenths: search ? 1 : 10,
        uncountSearch: search,
        searchKey: usage.searchKey,
      });
    }
    return json(503, { error: 'not_configured' });
  }

  const upstreamUrl = `https://golfapi.io/api/v2.3/${rest}${url.search}`;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    });
  } catch {
    if (openKey) {
      await counterFetch(env, {
        op: 'settle',
        openKey,
        outcome: 'refund',
        refundTenths: search ? 1 : 10,
        uncountSearch: search,
        searchKey: usage.searchKey,
      });
    }
    return withExemptHeader(json(502, { error: 'upstream_unreachable' }), exempt);
  }

  const bytes = await upstream.arrayBuffer();
  const ok = upstream.status >= 200 && upstream.status < 300;
  const contentType = upstream.headers.get('Content-Type') ?? 'application/json';
  const response = new Response(bytes, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': ok ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
    },
  });

  const text = new TextDecoder().decode(bytes);
  const payload = parseJsonLoose(text);
  const left = kv ? await rememberBalance(kv, upstream.status, payload, upstream.headers) : null;
  if (left != null) {
    const noted = await counterFetch(env, {
      op: 'noteBalance',
      ...usage,
      left,
      planMonthly: intEnv(env, 'GOLFAPI_PLAN_MONTHLY', DEFAULT_PLAN_MONTHLY),
      now: Date.now(),
    });
    scheduleAlerts(ctx, env, noted);
  }
  if (pendingAlert) scheduleAlerts(ctx, env, { ...pendingAlert, left: pendingAlert.left ?? left });
  if (openKey) {
    await counterFetch(env, {
      op: 'settle',
      openKey,
      outcome: ok ? 'spent' : 'refund',
      refundTenths: search ? 1 : 10,
      uncountSearch: !ok && search,
      searchKey: usage.searchKey,
    });
  }
  if (ok) {
    const courses = coursesInPayload(payload);
    const usable = hasUsableMap(payload);
    const coordinates = rest.startsWith('coordinates/');
    if (usable && openKey) await counterFetch(env, { op: 'countPull', openKey, pullKey: usage.pullKey });
    if (coordinates && !usable) {
      let rows = courses;
      if (rows.length === 0 && pathId) {
        const known = (await counterFetch(env, { op: 'knownCourse', courseId: pathId })) || {};
        rows = [{ courseId: pathId, name: known.name || '', country: known.country || '' }];
      }
      await noteCourses(env, now, 'no_data', rows);
    } else {
      await noteCourses(env, now, '', courses);
    }
    const install = installIdOf(request);
    if (!pathId && install && !request.headers.has(STOREFRONT_HEADER) && queryCountryIsUs(url)) {
      const ids = new Set();
      collectCourseIds(payload, ids);
      if (ids.size) {
        await counterFetch(env, {
          op: 'rememberPhoneIds',
          install,
          ids: [...ids],
          now: now.getTime(),
        });
      }
    }
    if (search) {
      const states = statesFromSearch(url, payload);
      if (states.length) {
        const tally = (async () => {
          try {
            await counterFetch(env, {
              op: 'noteSearchStates',
              cycleId: golfapiCycleId(now, cycleDayOf(env)),
              states,
            });
          } catch {
            // A state tally must not fail or delay the golfer's search.
          }
        })();
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(tally);
      }
      const plan = searchStorePlan(upstream.status, payload);
      if (plan === 'permanent') {
        if (kv) {
          await kv.put(storedKey, JSON.stringify({ status: upstream.status, contentType, body: text }));
          await learnUsIds(kv, rest, url, text);
        }
        await putEdge(cache, cacheKey, response);
      } else if (plan === 'ttl') {
        if (kv) {
          await kv.put(
            storedKey,
            JSON.stringify({
              status: upstream.status,
              contentType,
              body: text,
              emptySearchTtl: EMPTY_SEARCH_TTL,
              emptySearchUntil: Date.now() + EMPTY_SEARCH_TTL * 1000,
            }),
            { expirationTtl: EMPTY_SEARCH_TTL },
          );
          await learnUsIds(kv, rest, url, text);
        }
        const marked = new Response(bytes, {
          status: upstream.status,
          headers: emptySearchHeaders(contentType, EMPTY_SEARCH_TTL),
        });
        await putEdge(cache, cacheKey, marked);
        return withExemptHeader(marked, exempt);
      }
    } else {
      // Course and coordinates stay permanent on a 2xx, same as today.
      if (kv) {
        await kv.put(storedKey, JSON.stringify({ status: upstream.status, contentType, body: text }));
        await learnUsIds(kv, rest, url, text);
      }
      await putEdge(cache, cacheKey, response);
    }
  }
  return withExemptHeader(response, exempt);
}

async function handleGca(request, url, rest, env) {
  const key = secretOf(env, 'GOLF_COURSES_API_KEY');
  if (!key) return json(503, { error: 'not_configured' });
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const upstreamUrl = `https://golfcoursesapi.com/api/v1/${rest}${url.search}`;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    });
  } catch {
    return json(502, { error: 'upstream_unreachable' });
  }
  const bytes = await upstream.arrayBuffer();
  const ok = upstream.status >= 200 && upstream.status < 300;
  const response = new Response(bytes, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': ok ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
    },
  });
  if (ok) await putEdge(cache, cacheKey, response);
  return response;
}

export function metersToDegrees(lat, eastM, northM) {
  const cos = Math.cos((lat * Math.PI) / 180);
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.max(0.2, Math.abs(cos));
  return { dLat: northM / METERS_PER_DEG_LAT, dLon: eastM / metersPerDegLon };
}

function onRingBoundary(lat, lng, ring) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [y1, x1] = ring[j];
    const [y2, x2] = ring[i];
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (len2 === 0) continue;
    const cross = (lat - y1) * (x2 - x1) - (lng - x1) * (y2 - y1);
    if (Math.abs(cross) > 1e-8) continue;
    const dot = (lng - x1) * (x2 - x1) + (lat - y1) * (y2 - y1);
    if (dot < 0) continue;
    if (dot <= len2 + 1e-8) return true;
  }
  return false;
}

function pointInRing(lat, lng, ring) {
  if (onRingBoundary(lat, lng, ring)) return true;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInRect(lat, lng, rect) {
  return lat >= rect.minLat && lat <= rect.maxLat && lng >= rect.minLng && lng <= rect.maxLng;
}

/** Which US/territory polygon contains this point, or null. */
export function usTerritoryAt(lat, lng) {
  if (pointInRing(lat, lng, CONUS_RING)) return 'conus';
  for (const rect of US_RECTANGLES) {
    if (pointInRect(lat, lng, rect)) return rect.name;
  }
  return null;
}

export function corridorInsideUs(corridor) {
  const corners = [
    [corridor.minLat, corridor.minLon],
    [corridor.minLat, corridor.maxLon],
    [corridor.maxLat, corridor.minLon],
    [corridor.maxLat, corridor.maxLon],
  ];
  const first = usTerritoryAt(corners[0][0], corners[0][1]);
  if (!first) return false;
  return corners.every(([lat, lng]) => usTerritoryAt(lat, lng) === first);
}

function finiteLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function readCoord(url, latNames, lngNames) {
  let lat = null;
  let lng = null;
  for (const name of latNames) {
    const raw = url.searchParams.get(name);
    if (raw != null && raw.trim() !== '') {
      lat = Number(raw);
      break;
    }
  }
  for (const name of lngNames) {
    const raw = url.searchParams.get(name);
    if (raw != null && raw.trim() !== '') {
      lng = Number(raw);
      break;
    }
  }
  if (!finiteLatLng(lat, lng)) return null;
  return { lat, lng };
}

/**
 * Tee + green front/center/back. Canonical query names are teeLat/teeLng,
 * frontLat/frontLng, centerLat/centerLng, backLat/backLng. Lon and
 * greenFront/greenCenter/greenBack prefixes are accepted too.
 */
export function pinsFromUrl(url) {
  const tee = readCoord(url, ['teeLat'], ['teeLng', 'teeLon']);
  const front = readCoord(url, ['frontLat', 'greenFrontLat'], ['frontLng', 'frontLon', 'greenFrontLng', 'greenFrontLon']);
  const center = readCoord(url, ['centerLat', 'greenCenterLat'], ['centerLng', 'centerLon', 'greenCenterLng', 'greenCenterLon']);
  const back = readCoord(url, ['backLat', 'greenBackLat'], ['backLng', 'backLon', 'greenBackLng', 'greenBackLon']);
  return { tee, front, center, back };
}

function round6(n) {
  return n.toFixed(6);
}

function pinPoint(point) {
  if (!point) return '-';
  return `${round6(point.lat)},${round6(point.lng)}`;
}

/** Same identity the app stores: tee|front|center|back at 6 decimals. A change is a re-pin. */
export function terrainPinKey(pins) {
  return [pinPoint(pins.tee), pinPoint(pins.front), pinPoint(pins.center), pinPoint(pins.back)].join('|');
}

export async function terrainPinHash(pins) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(terrainPinKey(pins)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Axis-aligned tee/green box plus 150 m. Needs a tee and a green center. */
export function holeCorridor(pins) {
  if (!pins.tee || !pins.center) return null;
  const points = [pins.tee, pins.front, pins.center, pins.back].filter(Boolean);
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLon = points[0].lng;
  let maxLon = points[0].lng;
  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lng);
    maxLon = Math.max(maxLon, point.lng);
  }
  const midLat = (minLat + maxLat) / 2;
  const pad = metersToDegrees(midLat, TERRAIN_CORRIDOR_BUFFER_M, TERRAIN_CORRIDOR_BUFFER_M);
  return {
    minLat: minLat - pad.dLat,
    maxLat: maxLat + pad.dLat,
    minLon: minLon - pad.dLon,
    maxLon: maxLon + pad.dLon,
  };
}

/** 10 m lattice. Origin is the southwest corner. Null when the box exceeds maxPoints. */
export function buildTerrainGrid(corridor, maxPoints = MAX_GRID_POINTS) {
  const originLat = corridor.minLat;
  const originLon = corridor.minLon;
  const step = metersToDegrees(originLat, TERRAIN_GRID_STEP_M, TERRAIN_GRID_STEP_M);
  if (step.dLat <= 0 || step.dLon <= 0) return null;
  const cols = Math.ceil((corridor.maxLon - originLon) / step.dLon - 1e-9) + 1;
  const rows = Math.ceil((corridor.maxLat - originLat) / step.dLat - 1e-9) + 1;
  if (cols < 2 || rows < 2 || cols * rows > maxPoints) return null;
  const points = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      points.push({ lat: originLat + row * step.dLat, lng: originLon + col * step.dLon });
    }
  }
  return { originLat, originLon, stepM: TERRAIN_GRID_STEP_M, cols, rows, points };
}

function elevationFeet(value) {
  const meters = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(meters)) return null;
  return meters * FEET_PER_METER;
}

async function fetchUsgsElevations(points) {
  const out = points.map(() => null);
  for (let start = 0; start < points.length; start += SAMPLE_BATCH) {
    const slice = points.slice(start, start + SAMPLE_BATCH);
    const body = new URLSearchParams({
      geometry: JSON.stringify({
        points: slice.map((point) => [point.lng, point.lat]),
        spatialReference: { wkid: 4326 },
      }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      interpolation: 'RSP_BilinearInterpolation',
      f: 'json',
    });
    const response = await fetch(USGS_3DEP_SAMPLES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`USGS 3DEP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error('USGS 3DEP error');
    const samples = Array.isArray(payload?.samples) ? payload.samples : [];
    samples.forEach((sample, index) => {
      const id = typeof sample.locationId === 'number' ? sample.locationId : index;
      if (id >= 0 && id < slice.length) out[start + id] = elevationFeet(sample.value);
    });
  }
  return out;
}

function terrainInstallAllowed(request, env) {
  if (installIsExempt(request, env)) return true;
  return storefrontIsUs(request);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerrainBlob(kv, blobKey, waitMs) {
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const ready = await kv.get(blobKey);
      if (ready) return ready;
      await sleep(25);
    }
  }
  return kv.get(blobKey);
}

function terrainPending(retryAfterSec) {
  const sec = Math.max(1, Math.ceil(retryAfterSec || 2));
  return json(503, { error: 'terrain_pending', retryAfterSec: sec }, { 'Retry-After': String(sec) });
}

function terrainResponse(blob) {
  return new Response(JSON.stringify(blob), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${TERRAIN_CACHE_SECONDS}`,
    },
  });
}

async function handleTerrain(request, url, env) {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const install = installIdOf(request);
  if (!install) return json(401, { error: 'install_required' });

  const path = url.pathname.replace(/\/+$/, '');
  const match = /^\/terrain\/v1\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return json(404, { error: 'unknown_route' });
  const courseKey = decodeURIComponent(match[1]);
  const hole = Number(match[2]);
  if (!courseKey || courseKey === '.' || courseKey === '..') return json(400, { error: 'bad_course' });
  if (!Number.isInteger(hole) || hole < 1 || hole > 18) return json(400, { error: 'bad_hole' });

  const pins = pinsFromUrl(url);
  if (!pins.tee || !pins.center) return json(400, { error: 'pins_required' });
  const corridor = holeCorridor(pins);
  if (!corridor) return json(400, { error: 'pins_required' });
  if (!corridorInsideUs(corridor)) return json(404, { error: 'terrain_unavailable' });
  const maxPoints = intEnv(env, 'TERRAIN_MAX_GRID_POINTS', MAX_GRID_POINTS);
  const grid = buildTerrainGrid(corridor, maxPoints);
  if (!grid) return json(400, { error: 'terrain_too_large', maxGridPoints: maxPoints });
  if (!terrainInstallAllowed(request, env)) return json(404, { error: 'terrain_unavailable' });

  const pinHash = await terrainPinHash(pins);
  const pinKey = terrainPinKey(pins);
  const blobKey = `terrain:v1:${encodeURIComponent(courseKey)}:${hole}:${pinHash}`;
  const lockKey = `terrain:sampling:${encodeURIComponent(courseKey)}:${hole}:${pinHash}`;
  const kv = terrainKv(env);
  if (!kv) return json(503, { error: 'not_configured' });

  const existing = await kv.get(blobKey);
  if (existing) {
    const blob = parseJsonLoose(existing);
    if (blob) return terrainResponse(blob);
  }

  const exempt = installIsExempt(request, env);
  const day = utcDay(new Date());
  const sampleKey = `terrain:samples:${install}:${day}`;
  const waitMs = intEnv(env, 'TERRAIN_LOCK_WAIT_MS', DEFAULT_LOCK_WAIT_MS);
  if (terrainInflight.has(lockKey)) {
    const ready = await waitForTerrainBlob(kv, blobKey, waitMs);
    const blob = ready ? parseJsonLoose(ready) : null;
    if (blob) return terrainResponse(blob);
    return terrainPending(2);
  }
  terrainInflight.add(lockKey);
  let ownedLock = false;
  let counted = false;
  let sampled = false;
  try {
    const ttl = Math.max(DEFAULT_LOCK_TTL_SEC, intEnv(env, 'TERRAIN_LOCK_TTL_SEC', DEFAULT_LOCK_TTL_SEC));
    const begun = await counterFetch(env, {
      op: 'terrainBegin',
      lockKey,
      now: Date.now(),
      ttlSec: ttl,
      sampleKey,
      cap: intEnv(env, 'TERRAIN_INSTALL_DAILY_CAP', DEFAULT_TERRAIN_DAILY),
      exempt,
    });
    if (!begun) return json(503, { error: 'not_configured' });
    if (begun.limited) {
      const sec = secondsUntilUtcDay(new Date());
      return json(429, { error: 'terrain_limited', retryAfterSec: sec }, { 'Retry-After': String(sec) });
    }
    if (begun.pending) {
      const ready = await waitForTerrainBlob(kv, blobKey, waitMs);
      const blob = ready ? parseJsonLoose(ready) : null;
      if (blob) return terrainResponse(blob);
      return terrainPending(begun.retryAfterSec);
    }
    ownedLock = true;
    counted = Boolean(begun.counted);

    const again = await kv.get(blobKey);
    if (again) {
      const blob = parseJsonLoose(again);
      if (blob) return terrainResponse(blob);
    }

    const extras = [];
    if (pins.front) extras.push({ key: 'front', point: pins.front });
    extras.push({ key: 'center', point: pins.center });
    if (pins.back) extras.push({ key: 'back', point: pins.back });
    const samples = await fetchUsgsElevations([...grid.points, ...extras.map((extra) => extra.point)]);
    const heightsFt = grid.points.map((_, index) => samples[index] ?? null);
    const green = { front: null, center: null, back: null };
    extras.forEach((extra, index) => {
      green[extra.key] = samples[grid.points.length + index] ?? null;
    });
    const blob = {
      courseKey,
      hole,
      originLat: grid.originLat,
      originLng: grid.originLon,
      originLon: grid.originLon,
      stepM: grid.stepM,
      cols: grid.cols,
      rows: grid.rows,
      heightsFt,
      greenFrontFt: green.front,
      greenCenterFt: green.center,
      greenBackFt: green.back,
      pinHash,
      pinKey,
    };
    await kv.put(blobKey, JSON.stringify(blob));
    sampled = true;
    return terrainResponse(blob);
  } catch {
    return json(502, { error: 'upstream_unreachable' });
  } finally {
    terrainInflight.delete(lockKey);
    if (ownedLock) {
      try {
        await counterFetch(env, {
          op: sampled ? 'terrainFinish' : 'terrainAbort',
          lockKey,
          sampleKey,
          counted: counted && !sampled,
        });
      } catch {
        // The lock TTL releases a sampler this isolate could not clear.
      }
    }
  }
}

/**
 * Returns a Response for a golf or terrain route, or null when the path is
 * not one (so the caller falls through to share-board handling).
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil?(promise: Promise<unknown>): void } | undefined} ctx
 * @returns {Promise<Response | null>}
 */
export async function handleGolfProxy(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  // Answered here. Never forwarded, never cache.put, never KV.
  // Computed per request. Cache-Control: no-store. No exempt header.
  if (pathname === GOLFAPI_STATUS_PATH) {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    return json(200, {
      exempt: installIsExempt(request, env),
      dailyPulls: intEnv(env, 'GOLFAPI_INSTALL_DAILY_PULLS', DEFAULT_INSTALL_PULLS),
    });
  }

  if (pathname === '/admin/alert-test') return handleAlertTest(request, env ?? {});
  if (pathname === '/admin/demand') return handleDemand(request, env ?? {});
  if (pathname === '/admin/stockpile') return handleStockpileAdmin(request, env ?? {});

  if (pathname.startsWith(TERRAIN_PREFIX)) {
    return handleTerrain(request, url, env ?? {});
  }

  const hit = matchVendor(pathname);
  if (!hit) return null;
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  if (hit.rest == null) return json(404, { error: 'unknown_route' });

  if (hit.vendor.secret === 'GOLFAPI_KEY') {
    return handleGolfApi(request, url, hit.rest, env ?? {}, installIsExempt(request, env), ctx);
  }
  return handleGca(request, url, hit.rest, env ?? {});
}

function sqlRows(result) {
  if (!result) return [];
  if (typeof result.toArray === 'function') return result.toArray();
  if (typeof result[Symbol.iterator] === 'function') return [...result];
  return [];
}

/**
 * SQLite-backed counter for the Workers Paid plan. One global instance
 * serializes golfapi opens, terrain sampling, and usage-alert claims so
 * caps cannot overshoot and a threshold cannot send twice.
 * Nothing in this class writes KV.
 */
export class GolfapiCounter {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    const setup = () => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    };
    if (typeof ctx.blockConcurrencyWhile === 'function') ctx.blockConcurrencyWhile(setup);
    else setup();
  }

  get(key) {
    const rows = sqlRows(this.sql.exec('SELECT value FROM state WHERE key = ?', key));
    if (!rows.length || rows[0].value == null) return null;
    return String(rows[0].value);
  }

  put(key, value) {
    this.sql.exec('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', key, String(value));
  }

  del(key) {
    this.sql.exec('DELETE FROM state WHERE key = ?', key);
  }

  num(key) {
    const n = Number(this.get(key));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  add(key, delta) {
    const next = Math.max(0, this.num(key) + delta);
    this.put(key, String(next));
  }

  /** Credit counters are tenths of a credit so 0.1 + 0.1 + 0.1 stays 0.3. */
  creditTenths(key) {
    const n = Number(this.get(key));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 10);
  }

  creditAmount(key) {
    return this.creditTenths(key) / 10;
  }

  putCredits(key, tenths) {
    const next = Math.max(0, tenths);
    this.put(key, next % 10 === 0 ? String(next / 10) : (next / 10).toFixed(1));
  }

  addCredits(key, deltaTenths) {
    this.putCredits(key, this.creditTenths(key) + deltaTenths);
  }

  readOpen(key) {
    const raw = this.get(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  }

  writeOpen(key, open) {
    this.put(key, JSON.stringify(open));
  }

  fresh(open, now) {
    return Boolean(open && typeof open.at === 'number' && now - open.at < OPEN_WINDOW_MS);
  }

  room(body, needTenths) {
    const callCap = body.callCap == null ? null : Math.round(Number(body.callCap) * 10);
    if (callCap != null && this.creditTenths(body.installKey) + needTenths > callCap) {
      return { ok: false, reason: 'phone_limit', retryAfterSec: body.retryDay };
    }
    const dayCap = Math.round(Number(body.dayCap) * 10);
    if (this.creditTenths(body.dayKey) + needTenths > dayCap) {
      return { ok: false, reason: 'app_daily', retryAfterSec: body.retryDay };
    }
    const monthCap = Math.round(Number(body.monthCap) * 10);
    if (this.creditTenths(body.monthKey) + needTenths > monthCap) {
      return { ok: false, reason: 'app_monthly', retryAfterSec: body.retryMonth };
    }
    return null;
  }

  pullBlocked(body) {
    if (body.pullCap == null || !body.pullKey) return null;
    if (this.num(body.pullKey) >= body.pullCap) {
      return { ok: false, reason: 'phone_limit', retryAfterSec: body.retryDay };
    }
    return null;
  }

  charge(open, tenths) {
    this.addCredits(open.installKey, tenths);
    this.addCredits(open.dayKey, tenths);
    this.addCredits(open.monthKey, tenths);
  }

  chargeTenthsOf(body) {
    const n = Math.round(Number(body.chargeTenths));
    return Number.isFinite(n) && n > 0 ? n : PULL_CREDIT_TENTHS;
  }

  reserve(body) {
    const courseId = body.courseId || null;
    const directKey = `golfapi:open:${body.install}:${courseId || 'search'}`;
    const searchKey = `golfapi:open:${body.install}:search`;
    const direct = courseId ? this.readOpen(directKey) : this.readOpen(searchKey);
    const search = this.readOpen(searchKey);
    const charge = this.chargeTenthsOf(body);
    const needRaw = Math.round(Number(body.needTenths));
    const need = Number.isFinite(needRaw) && needRaw > 0 ? needRaw : charge;
    if (body.isSearch && body.searchKey && body.searchCap != null && this.num(body.searchKey) >= Number(body.searchCap)) {
      return { ok: false, reason: 'phone_limit', retryAfterSec: body.retryDay };
    }
    let key = null;
    let open = null;
    if (this.fresh(direct, body.now)) {
      key = courseId ? directKey : searchKey;
      open = direct;
    } else if (courseId && this.fresh(search, body.now) && (!search.courseId || search.courseId === courseId)) {
      key = searchKey;
      open = search;
    }
    const take = (row, rowKey) => {
      const blocked = this.room(body, row ? charge : need);
      if (blocked) return blocked;
      this.charge(row || {
        installKey: body.installKey,
        dayKey: body.dayKey,
        monthKey: body.monthKey,
      }, charge);
      return null;
    };
    if (open && key) {
      if (courseId && key === searchKey) {
        this.del(searchKey);
        key = directKey;
        open.courseId = courseId;
      }
      const blocked = take(open, key);
      if (blocked) return blocked;
      open.pendingTenths = charge;
      open.held += 1;
      open.calls += 1;
      if (body.isSearch && body.searchKey) this.add(body.searchKey, 1);
      this.writeOpen(key, open);
      return { ok: true, openKey: key, fresh: false, ...this.fallbackSnapshot(body) };
    }
    if (!body.isSearch) {
      const pulls = this.pullBlocked(body);
      if (pulls) return pulls;
    }
    const blocked = take(null, null);
    if (blocked) return blocked;
    const created = {
      at: body.now,
      courseId,
      calls: 1,
      held: 1,
      spent: 0,
      pendingTenths: charge,
      installKey: body.installKey,
      dayKey: body.dayKey,
      monthKey: body.monthKey,
    };
    if (body.isSearch && body.searchKey) this.add(body.searchKey, 1);
    this.writeOpen(directKey, created);
    return { ok: true, openKey: directKey, fresh: true, ...this.fallbackSnapshot(body) };
  }

  claimThresholds(body, used) {
    const plan = body.planMonthly;
    if (!body.cycleId || !plan || !Number.isFinite(used)) return [];
    const now = typeof body.now === 'number' ? body.now : Date.now();
    const due = [];
    const usedTenths = Math.round(Number(used) * 10);
    for (const pct of ALERT_LEVELS) {
      if (usedTenths * 10 < pct * plan) continue;
      const sentKey = `golfapi:alert:sent:${body.cycleId}:${pct}`;
      const tryKey = `golfapi:alert:try:${body.cycleId}:${pct}`;
      if (this.get(sentKey)) continue;
      const last = Number(this.get(tryKey));
      if (Number.isFinite(last) && now - last < ALERT_RETRY_MS) continue;
      this.put(tryKey, String(now));
      due.push(pct);
    }
    return due;
  }

  /**
   * Worker-count fallback. Real usage takes over once this cycle has a
   * start balance, so a charge does not also alert from the 450 counter.
   */
  fallbackSnapshot(body) {
    const workerCount = this.creditAmount(body.monthKey);
    const dayCount = this.creditAmount(body.dayKey);
    const base = {
      cycleId: body.cycleId,
      used: workerCount,
      workerCount,
      dayCount,
      source: 'fallback',
      left: null,
    };
    if (!body.cycleId || this.get(`golfapi:cycle-start:${body.cycleId}`) != null) {
      return { ...base, alerts: [] };
    }
    return { ...base, alerts: this.claimThresholds(body, workerCount) };
  }

  noteBalance(body) {
    const workerCount = this.creditAmount(body.monthKey);
    const dayCount = this.creditAmount(body.dayKey);
    const startKey = `golfapi:cycle-start:${body.cycleId}`;
    const existing = this.get(startKey);
    if (existing == null) {
      this.put(startKey, String(body.left));
      return {
        alerts: [],
        used: 0,
        start: body.left,
        left: body.left,
        workerCount,
        dayCount,
        cycleId: body.cycleId,
        source: 'start',
      };
    }
    const start = Number(existing);
    const used = Math.max(0, start - Number(body.left));
    return {
      alerts: this.claimThresholds(body, used),
      used,
      start,
      left: body.left,
      workerCount,
      dayCount,
      cycleId: body.cycleId,
      source: 'balance',
    };
  }

  markAlertSent(body) {
    this.put(`golfapi:alert:sent:${body.cycleId}:${body.pct}`, '1');
    return { ok: true };
  }

  claimAlertTest(body) {
    const now = typeof body.now === 'number' ? body.now : Date.now();
    const day = typeof body.day === 'string' ? body.day : '';
    const storedDay = this.get('golfapi:alert-test:day');
    const count = storedDay === day ? this.num('golfapi:alert-test:count') : 0;
    const last = Number(this.get('golfapi:alert-test:last'));
    if (count >= ALERT_TEST_DAILY) {
      return { ok: false, retryAfterSec: body.retryDay };
    }
    if (Number.isFinite(last) && last > 0 && now - last < ALERT_TEST_INTERVAL_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((last + ALERT_TEST_INTERVAL_MS - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    this.put('golfapi:alert-test:day', day);
    this.put('golfapi:alert-test:count', String(count + 1));
    this.put('golfapi:alert-test:last', String(now));
    return { ok: true, count: count + 1 };
  }

  countPull(body) {
    const open = this.readOpen(body.openKey);
    const pulls = this.num(body.pullKey);
    if (!open || open.pullCounted || !body.pullKey) return { counted: false, pulls };
    open.pullCounted = true;
    this.writeOpen(body.openKey, open);
    this.add(body.pullKey, 1);
    return { counted: true, pulls: this.num(body.pullKey) };
  }

  readJson(key, fallback) {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  rememberPhoneIds(body) {
    const install = typeof body.install === 'string' ? body.install.trim() : '';
    if (!install) return { ok: false };
    const key = `golfapi:us-phone:${install}`;
    const now = typeof body.now === 'number' ? body.now : Date.now();
    const existing = this.readJson(key, null);
    const prior = existing && typeof existing.at === 'number' && now - existing.at < PHONE_US_TTL_MS && Array.isArray(existing.ids)
      ? existing.ids
      : [];
    const ids = [];
    const seen = new Set();
    for (const id of [...(Array.isArray(body.ids) ? body.ids : []), ...prior]) {
      const text = typeof id === 'number' && Number.isFinite(id) ? String(Math.trunc(id)) : typeof id === 'string' ? id.trim() : '';
      if (!text || seen.has(text)) continue;
      seen.add(text);
      ids.push(text);
      if (ids.length >= PHONE_US_ID_LIMIT) break;
    }
    this.put(key, JSON.stringify({ at: now, ids }));
    return { ok: true, count: ids.length };
  }

  phoneHasId(body) {
    const install = typeof body.install === 'string' ? body.install.trim() : '';
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!install || !id) return { known: false };
    const parsed = this.readJson(`golfapi:us-phone:${install}`, null);
    const now = typeof body.now === 'number' ? body.now : Date.now();
    if (!parsed || typeof parsed.at !== 'number' || now - parsed.at >= PHONE_US_TTL_MS) return { known: false };
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return { known: ids.includes(id) };
  }

  rememberCourse(body) {
    const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
    if (!courseId) return { ok: false };
    const prev = this.readJson(`golfapi:known:${courseId}`, {});
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : prev.name || '';
    const country = typeof body.country === 'string' && body.country.trim() ? body.country.trim() : prev.country || '';
    if (!name && !country) return { ok: true };
    this.put(`golfapi:known:${courseId}`, JSON.stringify({ name, country }));
    return { ok: true };
  }

  knownCourse(body) {
    const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
    if (!courseId) return { name: '', country: '' };
    const parsed = this.readJson(`golfapi:known:${courseId}`, {});
    return { name: parsed.name || '', country: parsed.country || '' };
  }

  noteDemand(body) {
    if (!DEMAND_REASONS.has(body.reason) || !body.cycleId) return { ok: false };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const country = typeof body.country === 'string' ? body.country.trim() : '';
    const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : '';
    if (!name && !country && !courseId) return { ok: false };
    this.rememberCourse({ courseId, name, country });
    const key = `golfapi:demand:${body.cycleId}`;
    const rows = this.readJson(key, []);
    const list = Array.isArray(rows) ? rows : [];
    const idKey = `${body.reason}|${courseId}|${name.toLowerCase()}|${country.toLowerCase()}`;
    let row = list.find((item) => item && item.key === idKey);
    if (!row) {
      row = { key: idKey, name, country, courseId: courseId || null, reason: body.reason, count: 0, lastSeen: body.day || '' };
      list.push(row);
    }
    row.count += 1;
    row.lastSeen = body.day || row.lastSeen;
    if (name) row.name = name;
    if (country) row.country = country;
    if (courseId) row.courseId = courseId;
    list.sort((a, b) => b.count - a.count || String(b.lastSeen).localeCompare(String(a.lastSeen)));
    this.put(key, JSON.stringify(list.slice(0, DEMAND_LIMIT)));
    return { ok: true };
  }

  noteCourses(body) {
    const courses = Array.isArray(body.courses) ? body.courses : [];
    for (const course of courses) {
      if (body.reason) this.noteDemand({ ...body, ...course });
      else this.rememberCourse(course || {});
    }
    return { ok: true };
  }

  readDemand(body) {
    const rows = this.readJson(`golfapi:demand:${body.cycleId}`, []);
    const list = Array.isArray(rows) ? rows : [];
    const pull = new Map();
    const noData = [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      if (row.reason === 'no_data') {
        noData.push({
          name: row.name || '',
          country: row.country || '',
          courseId: row.courseId || null,
          count: row.count,
          lastSeen: row.lastSeen || '',
        });
        continue;
      }
      const ident = row.courseId || `${row.name}|${row.country}`;
      const existing = pull.get(ident);
      if (!existing) {
        pull.set(ident, {
          name: row.name || '',
          country: row.country || '',
          courseId: row.courseId || null,
          count: row.count,
          lastSeen: row.lastSeen || '',
          reasons: [row.reason],
        });
        continue;
      }
      existing.count += row.count;
      if (!existing.reasons.includes(row.reason)) existing.reasons.push(row.reason);
      if (String(row.lastSeen) > String(existing.lastSeen)) existing.lastSeen = row.lastSeen;
      if (!existing.name && row.name) existing.name = row.name;
      if (!existing.country && row.country) existing.country = row.country;
      if (!existing.courseId && row.courseId) existing.courseId = row.courseId;
    }
    const byCount = (a, b) => b.count - a.count;
    return {
      pull_candidates: [...pull.values()].sort(byCount),
      no_data: noData.sort(byCount),
    };
  }

  settle(body) {
    const open = this.readOpen(body.openKey);
    if (!open) return { ok: true };
    if (body.outcome === 'spent') {
      open.spent += 1;
      open.pendingTenths = 0;
      this.writeOpen(body.openKey, open);
      return { ok: true, held: open.held, spent: open.spent };
    }
    if (open.held > open.spent) {
      const explicit = Math.round(Number(body.refundTenths));
      const pending = Math.round(Number(open.pendingTenths));
      const tenths = Number.isFinite(explicit) && explicit > 0
        ? explicit
        : (Number.isFinite(pending) && pending > 0 ? pending : PULL_CREDIT_TENTHS);
      this.charge(open, -tenths);
      open.held -= 1;
      open.pendingTenths = 0;
      if (body.uncountSearch && body.searchKey) this.add(body.searchKey, -1);
    }
    this.writeOpen(body.openKey, open);
    return { ok: true, held: open.held, spent: open.spent };
  }

  refundCache() {
    return { refunded: false };
  }

  terrainBegin(body) {
    const raw = this.get(`terrain:lock:${body.lockKey}`);
    const existing = raw ? JSON.parse(raw) : null;
    if (existing && typeof existing.at === 'number' && body.now - existing.at < existing.ttl * 1000) {
      const retry = Math.max(1, Math.ceil((existing.at + existing.ttl * 1000 - body.now) / 1000));
      return { ok: false, pending: true, retryAfterSec: retry };
    }
    let counted = false;
    if (!body.exempt) {
      if (this.num(body.sampleKey) >= body.cap) return { ok: false, limited: true };
      this.add(body.sampleKey, 1);
      counted = true;
    }
    this.put(`terrain:lock:${body.lockKey}`, JSON.stringify({ at: body.now, ttl: body.ttlSec }));
    return { ok: true, counted };
  }

  terrainFinish(body) {
    this.del(`terrain:lock:${body.lockKey}`);
    return { ok: true };
  }

  terrainAbort(body) {
    this.del(`terrain:lock:${body.lockKey}`);
    if (body.counted) this.add(body.sampleKey, -1);
    return { ok: true };
  }

  stockpileLock(body) {
    const key = 'golfapi:stockpile:lock';
    const existing = this.readJson(key, null);
    const ttlMs = (Number(body.ttlSec) || 900) * 1000;
    const now = Number(body.now) || Date.now();
    if (existing && typeof existing.at === 'number' && now - existing.at < ttlMs) {
      return { ok: false, locked: true };
    }
    this.put(key, JSON.stringify({ at: now, ttlSec: Number(body.ttlSec) || 900 }));
    return { ok: true };
  }

  stockpileUnlock() {
    this.del('golfapi:stockpile:lock');
    return { ok: true };
  }

  stockpileCharge(body) {
    const cost = Math.round(Number(body.chargeTenths));
    if (!Number.isFinite(cost) || cost <= 0) return { ok: false, reason: 'cap' };
    const golferCap = Math.round(Number(body.dayCap) * 10);
    const head = Math.max(0, Math.round(Number(body.dayHeadroomTenths) || 0));
    if (golferCap - this.creditTenths(body.golferDayKey) < head) {
      return { ok: false, reason: 'app_daily' };
    }
    const nightCap = Math.round(Number(body.runCap) * 10);
    if (!Number.isFinite(nightCap) || this.creditTenths(body.stockpileDayKey) + cost > nightCap) {
      return { ok: false, reason: 'run_cap' };
    }
    this.addCredits(body.stockpileDayKey, cost);
    this.addCredits(body.stockpileMonthKey, cost);
    return { ok: true };
  }

  stockpileRefund(body) {
    const cost = Math.round(Number(body.chargeTenths));
    if (Number.isFinite(cost) && cost > 0) {
      this.addCredits(body.stockpileDayKey, -cost);
      this.addCredits(body.stockpileMonthKey, -cost);
    }
    return { ok: true };
  }

  readUsage(body) {
    return {
      ok: true,
      day: this.creditAmount(body.dayKey),
      month: this.creditAmount(body.monthKey),
    };
  }

  noteSearchStates(body) {
    if (!body.cycleId) return { ok: false };
    const key = `golfapi:state-counts:${body.cycleId}`;
    const counts = this.readJson(key, {});
    const row = counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
    for (const raw of Array.isArray(body.states) ? body.states : []) {
      const state = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      if (!/^[A-Z]{2}$/.test(state)) continue;
      row[state] = (Number(row[state]) || 0) + 1;
    }
    this.put(key, JSON.stringify(row));
    return { ok: true };
  }

  readStateCounts(body) {
    const counts = this.readJson(`golfapi:state-counts:${body.cycleId}`, {});
    const states = Object.entries(counts && typeof counts === 'object' ? counts : {})
      .map(([state, count]) => ({ state, count: Number(count) || 0 }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
    return { states };
  }

  saveStockpileReport(body) {
    this.put('golfapi:stockpile:last', JSON.stringify(body.report || {}));
    return { ok: true };
  }

  readStockpileReport() {
    return { report: this.readJson('golfapi:stockpile:last', null) };
  }

  async fetch(request) {
    const body = await request.json();
    let result;
    if (body.op === 'reserve') result = this.reserve(body);
    else if (body.op === 'settle') result = this.settle(body);
    else if (body.op === 'refundCache') result = this.refundCache(body);
    else if (body.op === 'noteBalance') result = this.noteBalance(body);
    else if (body.op === 'markAlertSent') result = this.markAlertSent(body);
    else if (body.op === 'claimAlertTest') result = this.claimAlertTest(body);
    else if (body.op === 'countPull') result = this.countPull(body);
    else if (body.op === 'rememberPhoneIds') result = this.rememberPhoneIds(body);
    else if (body.op === 'phoneHasId') result = this.phoneHasId(body);
    else if (body.op === 'knownCourse') result = this.knownCourse(body);
    else if (body.op === 'noteCourses') result = this.noteCourses(body);
    else if (body.op === 'noteDemand') result = this.noteDemand(body);
    else if (body.op === 'readDemand') result = this.readDemand(body);
    else if (body.op === 'terrainBegin') result = this.terrainBegin(body);
    else if (body.op === 'terrainFinish') result = this.terrainFinish(body);
    else if (body.op === 'terrainAbort') result = this.terrainAbort(body);
    else if (body.op === 'stockpileLock') result = this.stockpileLock(body);
    else if (body.op === 'stockpileUnlock') result = this.stockpileUnlock();
    else if (body.op === 'stockpileCharge') result = this.stockpileCharge(body);
    else if (body.op === 'stockpileRefund') result = this.stockpileRefund(body);
    else if (body.op === 'readUsage') result = this.readUsage(body);
    else if (body.op === 'noteSearchStates') result = this.noteSearchStates(body);
    else if (body.op === 'readStateCounts') result = this.readStateCounts(body);
    else if (body.op === 'saveStockpileReport') result = this.saveStockpileReport(body);
    else if (body.op === 'readStockpileReport') result = this.readStockpileReport();
    else result = { ok: false, error: 'unknown_op' };
    return Response.json(result);
  }
}

export { runGolfapiStockpile, coverageFromOverlayResponse, STOCKPILE_CRON } from './golf-stockpile.js';

export default {
  async fetch(request, env, ctx) {
    const golf = await handleGolfProxy(request, env, ctx);
    if (golf) return golf;
    return json(404, { error: 'not_found' });
  },
};
