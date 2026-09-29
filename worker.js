import { applyGcaScorecardCorrection } from "./gca-corrections.js";
import { handleLivePage, isLiveBoardCode } from "./live-page.js";

/**
 * Golf vendor proxy, inlined from ShotTraxx worker-golf-proxy.js.
 * Runs before board-key parsing so /gca/... and /golfapi/... are never stored
 * as live-board codes. The phone sends no vendor key; secrets stay on this Worker.
 *
 *   GET /gca/v1/courses[/{id}[/green-centers]]  → golfcoursesapi.com/api/v1/
 *   GET /golfapi/v2.3/courses?name=             → golfapi.io/api/v2.3/  (search; else q=)
 *   GET /golfapi/v2.3/courses/{id}              → golfapi.io/api/v2.3/
 *   GET /golfapi/v2.3/coordinates/{id}          → golfapi.io/api/v2.3/
 *   GET /meta/golfapi                           → quota snapshot, no secrets
 *   GET /meta/gca                               → GCA call / 429 / stale counts
 *
 * Any other /golfapi/ path is 404. The API key is the GOLFAPI_KEY secret only.
 *
 * Successful JSON for a listed `/gca/v1/courses/{id}` is corrected from
 * gca-corrections.js in presentGcaCourseBody, once, on the way out: an
 * edge-cache hit, a fresh upstream read, a fresh KV copy, and a stale KV copy.
 * Search, list, green-centers, and golfapi bodies are returned unchanged.
 * KV and the edge cache keep the raw upstream body.
 *
 * OSM overlay proxy also runs before board-key parsing. The Worker builds the
 * Overpass query itself (clients never send Overpass QL):
 *
 *   GET /osm/v1/overlay?courseId&lat&lng&radius
 *
 * Golfapi quota (paid golfapi.io). GCA and OSM are not on this budget.
 * Periods are UTC: day YYYY-MM-DD, week ISO (YYYY-Www), month YYYY-MM.
 *
 * One lookup is one set: a search plus courses/{id} plus coordinates/{id}.
 * The set is counted on its first fresh upstream call and stays open for 15
 * minutes per device and per IP (gq:set:, short TTL). A fresh search opens it
 * and counts 1. A fresh courses/{id} or coordinates/{id} for the first course
 * id in that window counts nothing extra. A course call with no open set (the
 * search was a cache hit) opens a set and counts 1. A different course id
 * opens a new set and counts again. Cache hits never count and do not open a
 * set. There is no separate search budget. Fresh searches are also capped at
 * 3x the device daily lookup limit per device per day, including searches
 * inside an open set.
 *
 * A 200 with no course data, or an error body, is not stored and is not
 * edge-cached. A 24h gq:empty: marker stops a retry of that empty answer from
 * calling upstream again. Successful searches are stored for 30 days (gapi:search:)
 * so a queued search is free the next time. The store key is the normalized
 * name when that param is non-empty, otherwise q. The original query string
 * is sent upstream and replayed from the queue, so a name= search stays name=.
 *
 * Defaults, overridden by [vars] in wrangler.toml. Non-integers, negatives,
 * and blanks keep the default. IP limits default to twice the device limits
 * (carrier NAT) unless their own var is set.
 *
 *   GOLFAPI_DEVICE_DAY=3     GOLFAPI_DEVICE_WEEK=10    GOLFAPI_DEVICE_MONTH=20
 *   GOLFAPI_IP_DAY           GOLFAPI_IP_WEEK           GOLFAPI_IP_MONTH
 *   GOLFAPI_GLOBAL_DAY=100
 *   GOLFAPI_FLOOR=10         block fresh upstream calls when known balance <= this
 *
 * GOLFAPI_ALLOWLIST is a Worker secret (comma-separated install ids), not a
 * var: `wrangler secret put GOLFAPI_ALLOWLIST`. An allowlisted install id
 * skips device, IP, search, and the global cap. Those lookups are not added
 * to the global cap or the IP counters. The balance floor still applies.
 * They are counted on their own as allowlistedLookups. The ids are never
 * returned by /meta/golfapi.
 *
 * Identity: header X-Install-Id (8–64 chars of [A-Za-z0-9_-]).
 * /golfapi/v2.3/* requires a valid id. Missing or invalid is 401
 * {error:"install_id_required"} with no upstream call and no counter or
 * queue write except blocked.install_id_required (GET /meta/golfapi).
 * The 08:00 UTC cron is not an HTTP request and does not read the header.
 * /gca/v1/* still serves a missing id while GCA_REQUIRE_INSTALL_ID is off
 * (the default). missingInstallId counts only an edge-cache miss (a fresh
 * KV serve, an upstream fetch, a stale serve, or a 404), not an edge hit.
 * When the var is on, the same 401 is returned before any cache, KV, or
 * upstream work.
 * CF-Connecting-IP is limited on golfapi once an id is present. The id is
 * spoofable. IPs are stored only as SHA-256 with a fixed prefix, never raw.
 *
 * /gca/ and /golfapi/ responses do not send Access-Control-Allow-Origin,
 * including OPTIONS and errors. Share boards, /meta/*, and /osm/ still send *.
 *
 * Over a limit the phone gets 429 {error:"golfapi_limited", reason, queued,
 * retryAfterSec} and Retry-After. The app already falls back to free + GCA
 * data on non-2xx. Course ids and search queries are queued (gqueue:, deduped)
 * and the daily cron fills gapi: while under the global cap and above the floor.
 * A queued search is followed by course + coordinates only when exactly one
 * result's normalized name equals the query.
 *
 * GET /meta/golfapi includes asOf (when the balance was read), generatedAt,
 * today's globalLookups and globalCap, allowlistedLookups, and per-endpoint
 * fetch timing (count, median of a small sample, max). It does not include
 * the key, the allowlist, install ids, or IPs.
 *
 * Counters live in the BOARDS namespace under gq: (stats, balance, per-device
 * and per-IP buckets). KV writes are not atomic, and the same key accepts
 * about one write per second, so a burst can overshoot by 1–2. The global
 * daily cap and the balance floor are the backstop. A Durable Object could
 * make this exact later. Public GET/PUT/DELETE cannot read or write gq:,
 * gapi:, gqueue:, gca:, osm:, or cr: keys, or any key that starts with v1.
 *
 * GCA search stays edge-only for 24 hours. courses/{id} and
 * courses/{id}/green-centers keep the raw upstream body in BOARDS for a year
 * (gca:course:{id}, gca:greens:{id}) with metadata { status: 200, storedAt }.
 * Read order is the edge cache, then KV. A copy younger than GCA_REFRESH_DAYS
 * (default 30) is served with no upstream call and re-warms the edge cache.
 * An older copy is refreshed: a 2xx overwrites KV and the edge cache; a 429,
 * 5xx, timeout, or thrown fetch serves that copy with X-Course-Data-Stale: 1
 * and X-Course-Data-Age (seconds). Error bodies are never written to KV.
 * presentGcaCourseBody is the only response-time transform, so a scorecard
 * correction applies to edge, KV, and stale serves. The KV value stays raw.
 * Daily counts (upstream, 429, stale, missingInstallId) live at
 * gca:stats:YYYY-MM-DD for 40 days and are returned by GET /meta/gca.
 * missingInstallId is an edge-cache miss with no valid install id. An edge
 * hit does not read or write KV for that count. A valid id is not counted.
 * GCA_REQUIRE_INSTALL_ID is an optional var, default off. No new secrets.
 *
 * In-round course/hole problem reports run before the board-key catch-all.
 * Otherwise the first path segment would be a KV board key: POST /v1/... is
 * 405 and GET /v1 would read a board named "v1". Any other /v1/* path is
 * 404 {error:"unknown_route"}.
 *
 *   POST /v1/course-reports
 *   GET  /v1/course-reports                         admin
 *   GET  /v1/course-reports/{clientReportId}        admin, one record
 *   POST /v1/course-reports/{clientReportId}/review admin, review a contribution
 *
 * POST JSON, 4096 bytes max. 201 {ok:true,id} stores a new report. The same
 * clientReportId is 200 {ok:true,id,duplicate:true} and does not write again.
 * Invalid JSON is 400 {error:"invalid_json"}. Larger than 4096 is 413
 * {error:"too_large"}. A field that can never succeed is 422
 * {error:"invalid",field}. Unknown top-level fields are ignored. Unknown
 * reason strings are dropped, not rejected, unless none of the known reasons
 * remain. The public POST response is only {ok,id} (plus duplicate on a
 * replay). It does not echo contributorEmail or position.
 *
 * Required: clientReportId (loose uuid, ≤64), createdAt (ISO, stored as
 * sent), courseId (1..180), courseName (trimmed, 1..200), holeNumber (1..18),
 * reasons (non-empty after the known-value filter). Optional: note (≤500),
 * position, appVersion, buildNumber, platform (each ≤32), paintSource (≤32,
 * stored lowercased), shown, and header X-Install-Id (≤100, stored as
 * installId). shown never rejects the report: a non-object becomes null.
 * par on shown is kept when it is an integer 1..10 and is otherwise null.
 * green and tee on shown are kept only as a valid lat/lon and are otherwise
 * null.
 *
 * Known reasons: hole_missing, green_wrong, tee_wrong, wrong_par,
 * wrong_course, other, hole-contribution. hole-contribution requires a
 * contribution object. A contribution sent without that reason is ignored.
 *
 * contribution:
 *   green {lat, lon}                    required, via parseLatLon
 *   greenMethod "tap-map" | "im-here"   required
 *   tee {lat, lon}                      optional, via parseLatLon
 *   par                                 optional integer 3..6
 *   contributorEmail                    optional, trimmed, max 254, basic
 *                                       email shape, stored lowercased
 * The address is not written on the report. It is stored at
 * cr:email:<clientReportId> with a 365-day expirationTtl, so KV drops it
 * even if nobody reviews the report. The cr: prefix is already reserved,
 * so a board GET cannot read it. The report keeps hadEmail:true when an
 * address was accepted. If createdAt is already 365 days old or older, the
 * address is not stored. Admin GETs copy the address onto
 * contribution.contributorEmail while the key exists.
 * A bad contribution is 422 {error:"invalid", field} with field "contribution"
 * or "contribution.<name>". position stays the top-level {lat, lon, accuracyM}
 * and is the GPS fix for "I'm here". This route does not copy position onto
 * green and does not invent a tee or a par.
 *
 * contribution.hints is stored for review and never causes a 422. The phone
 * refuses a bad fix or an implausible length. The server only records:
 *   greenToPositionM    meters, im-here when position has a lat/lon
 *   positionAccuracyM   position.accuracyM when that is a number
 *   poorFix             true when that accuracy is over 15
 *   greenToTeeM         meters, only when tee and par were both sent
 *   plausibleForPar     same condition. Inclusive yards: par 3 is 60–280,
 *                       par 4 is 230–520, par 5 is 400–680. Par 6 has no
 *                       band, so the flag is false.
 *
 * A contribution record stores review
 * {status, reviewedAt, note, usedAt, rewardedAt}. status starts as "pending".
 * The other four start null.
 *
 * The review POST uses the same bearer token and fails closed the same way.
 * Body is {status, note?}. status must be "approved", "rejected", "used", or
 * "rewarded". note is optional, trimmed, max 500. Omit note to keep the
 * previous one. Allowed transitions: pending→approved, pending→rejected,
 * approved→used, used→rewarded. Anything else is 409
 * {error:"invalid_transition"}. Moving to used sets usedAt. rewardEligible
 * is stored true only when the new status is used and the email key is still
 * present. Moving to rejected or rewarded deletes that key in the same
 * request and leaves hadEmail. rewarded also sets rewardedAt and keeps
 * rewardEligible. No reward is granted. Nothing here writes the paint cache
 * or any course record. Applying an approved hole is manual.
 * A missing report is 404 {error:"not_found"}.
 *
 * BOARDS keys:
 *   cr:id:<clientReportId>                  dedupe marker; value is the record key; TTL 180 days
 *   cr:r:<receivedAt ISO with ms>:<id>      normalized JSON; TTL 180 days
 *   cr:email:<clientReportId>               contributor address only; TTL 365 days
 * Server fields on the record: receivedAt, installId, and request.cf.country
 * when that is present. The raw IP is never stored. New reports are capped
 * per UTC day at 30 for CF-Connecting-IP and 20 for X-Install-Id when the
 * header is present. Duplicates do not count, and neither do review writes.
 * Over the cap is 429 {error:"rate_limited"} plus Retry-After in seconds.
 * Override with COURSE_REPORTS_IP_DAY and COURSE_REPORTS_DEVICE_DAY.
 * Counters are short-TTL cr:n: keys and are not atomic.
 *
 * Admin GET and the review POST require Authorization: Bearer
 * <COURSE_REPORTS_ADMIN_TOKEN>, compared in constant time. Set it with
 * `wrangler secret put COURSE_REPORTS_ADMIN_TOKEN`. Unset fails closed: 503
 * {error:"not_configured"}. Wrong or missing bearer is 401. Query: since
 * (ISO, key order on receivedAt), courseId (exact), reason (a known reason),
 * status (pending, approved, rejected, used, or rewarded), limit (default 100, max
 * 500), cursor (KV list cursor). An unknown reason or status is 422. Body is
 * {reports, cursor|null}, oldest first. Unbound BOARDS is 503
 * {error:"boards_not_configured"} on POST and on admin GET. contributorEmail
 * and position are returned on the admin GETs. The review POST returns the
 * updated record to that same admin caller.
 */

const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
const OVERPASS_MIRROR = "https://overpass.private.coffee/api/interpreter";
const OVERPASS_USER_AGENT = "shottracker-worker/1.0 (+https://shottrax-share.bcbaird.workers.dev)";
/** KV keeps the only copy for a year. Freshness is fetchedAt, not expiration. */
const OSM_KV_TTL = 60 * 60 * 24 * 365;
const OSM_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** Short edge TTL so caches.default cannot pin an overlay past its refresh. */
const OSM_EDGE_TTL = 60 * 60 * 24;
const OSM_NEGATIVE_TTL = 60 * 60 * 6;
/** One refresh attempt per location per hour while the copy is stale. */
const OSM_REFRESH_TTL = 60 * 60;
/**
 * Primary gets about 11s. Timeout, throw, 429, and 504 then use the mirror
 * for whatever is left of the ~27s budget. A short backoff sits between them.
 */
const OSM_BUDGET_MS = 27000;
const OSM_PRIMARY_MS = 11000;
const OSM_BACKOFF_MS = 400;
/** Nearby reuse: same radius, center within this many meters. Not for negative markers. */
const OSM_NEAR_M = 600;
/** Coarse index cell, in millionths of a degree. 10_000 millionths = 0.01 degree. */
const OSM_CELL_MILLIONTHS = 10000;
const OSM_MAX_CELL_STEPS = 3;
const EARTH_M = 6371000;
const COURSE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** In-isolate collapse so identical misses share one Overpass call. */
export const osmInflight = new Map();

const GOLF_VENDORS = {
  gca: {
    prefix: "/gca/v1/",
    upstream: "https://golfcoursesapi.com/api/v1/",
    secret: "GOLF_COURSES_API_KEY",
    routes: [/^courses$/, /^courses\/[^/]+$/, /^courses\/[^/]+\/green-centers$/],
  },
  golfapi: {
    prefix: "/golfapi/v2.3/",
    upstream: "https://golfapi.io/api/v2.3/",
    secret: "GOLFAPI_KEY",
    routes: [/^courses$/, /^courses\/[^/]+$/, /^coordinates\/[^/]+$/],
  },
};

/** Edge cache for successful reads. Course data changes rarely; golfapi is paid per call. */
const GOLF_CACHE_SECONDS = 60 * 60 * 24;
/** Phones must see scorecard corrections quickly. The edge cache and KV keep the longer raw-body lifetime. */
const GCA_CLIENT_MAX_AGE = 300;
/** Durable GCA courses/{id} and green-centers bodies. Same horizon as golfapi. */
const GCA_STORE_TTL = 60 * 60 * 24 * 365;
/** Hung GCA course fetches abort here so a stored copy can still be served. */
const GCA_UPSTREAM_MS = 15000;
/** Optional negative edge cache for a GCA 404 when nothing is stored in KV. */
const GCA_NEGATIVE_TTL = 300;
const GCA_REFRESH_DAYS_DEFAULT = 30;
const GCA_RATE_HEADERS = new Set([
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
]);
/** Durable courses/{id} and coordinates/{id} bodies. Same horizon as the paint cache. */
const GOLFAPI_STORE_TTL = 60 * 60 * 24 * 365;
/** Device/IP buckets cover a month plus a little, so a late read still sees that month. */
const GOLFAPI_BUCKET_TTL = 60 * 60 * 24 * 32;
/** Daily stats stay readable for the 30-day meta window. */
const GOLFAPI_STATS_TTL = 60 * 60 * 24 * 40;
/** A queued course that nobody refills expires instead of sitting forever. */
const GOLFAPI_QUEUE_TTL = 60 * 60 * 24 * 14;
/** How long one search + course + coordinates set stays open. */
const GOLFAPI_SET_MS = 15 * 60 * 1000;
const GOLFAPI_SET_TTL = 15 * 60;
const GOLFAPI_SEARCH_TTL = 60 * 60 * 24 * 30;
const GOLFAPI_SEARCH_GUARD = 3;
const GOLFAPI_GIVE_UP = 5;
/** Reservoir size for per-endpoint fetch times. Count and max stay exact. */
const GOLFAPI_LATENCY_SAMPLE = 21;
const GOLFAPI_LATENCY_KINDS = ["search", "course", "coordinates"];
const GOLFAPI_IP_PREFIX = "shottrax-golfapi-ip-v1:";
const GOLFAPI_SEARCH_PREFIX = "shottrax-golfapi-search-v1:";
const GOLFAPI_BALANCE_KEY = "gq:balance";
const RESERVED_BOARD_PREFIXES = ["osm:", "gq:", "gapi:", "gqueue:", "gca:", "cr:"];
const GOLFAPI_REASONS = [
  "device_day",
  "device_week",
  "device_month",
  "ip_day",
  "ip_week",
  "ip_month",
  "global_day",
  "floor",
  "search_device_day",
  "install_id_required",
];

function isReservedBoardKey(key) {
  if (typeof key !== "string") return false;
  // /v1/... must not fall through to a board named "v1", and neither may any other key.
  if (key.startsWith("v1")) return true;
  return RESERVED_BOARD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Course paint cache keys share BOARDS with live boards. */
function isPaintKey(key) {
  return key.startsWith("id:") || key.startsWith("name:");
}

function readConfigInt(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed <= 1_000_000) return parsed;
  }
  return null;
}

function readGcaRefreshDays(env) {
  const parsed = readConfigInt(env && env.GCA_REFRESH_DAYS);
  return parsed == null ? GCA_REFRESH_DAYS_DEFAULT : parsed;
}

/** Off unless the var is 1, true, yes, or on. Installed builds omit the GCA header. */
function gcaRequiresInstallId(env) {
  const raw = env && env.GCA_REQUIRE_INSTALL_ID;
  if (raw === true) return true;
  if (typeof raw !== "string") return false;
  const text = raw.trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function readGolfapiLimits(env) {
  const source = env || {};
  const deviceDay = readConfigInt(source.GOLFAPI_DEVICE_DAY) ?? 3;
  const deviceWeek = readConfigInt(source.GOLFAPI_DEVICE_WEEK) ?? 10;
  const deviceMonth = readConfigInt(source.GOLFAPI_DEVICE_MONTH) ?? 20;
  return {
    deviceDay,
    deviceWeek,
    deviceMonth,
    ipDay: readConfigInt(source.GOLFAPI_IP_DAY) ?? deviceDay * 2,
    ipWeek: readConfigInt(source.GOLFAPI_IP_WEEK) ?? deviceWeek * 2,
    ipMonth: readConfigInt(source.GOLFAPI_IP_MONTH) ?? deviceMonth * 2,
    globalDay: readConfigInt(source.GOLFAPI_GLOBAL_DAY) ?? 100,
    floor: readConfigInt(source.GOLFAPI_FLOOR) ?? 10,
    searchCap: deviceDay * GOLFAPI_SEARCH_GUARD,
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function golfapiPeriods(now) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const date = now.getUTCDate();
  const day = `${year}-${pad2(monthIndex + 1)}-${pad2(date)}`;
  const month = `${year}-${pad2(monthIndex + 1)}`;
  const thursday = new Date(Date.UTC(year, monthIndex, date));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekNo = Math.ceil((((thursday.getTime() - yearStart) / 86400000) + 1) / 7);
  return { day, week: `${isoYear}-W${pad2(weekNo)}`, month };
}

function utcDay(now, offset) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
}

function secondsUntil(now, nextMs) {
  return Math.max(1, Math.ceil((nextMs - now.getTime()) / 1000));
}

function retryAfterFor(reason, now) {
  if (reason === "device_week" || reason === "ip_week") {
    const weekday = now.getUTCDay() || 7;
    let add = (8 - weekday) % 7;
    if (add === 0) add = 7;
    return secondsUntil(now, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add));
  }
  if (reason === "device_month" || reason === "ip_month") {
    return secondsUntil(now, Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return secondsUntil(now, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function clampCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), 1_000_000_000);
}

function readInstallId(request) {
  const raw = request.headers.get("X-Install-Id");
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  return id;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashClientIp(ip) {
  return sha256Hex(GOLFAPI_IP_PREFIX + ip);
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function searchToken(normalized) {
  return sha256Hex(GOLFAPI_SEARCH_PREFIX + normalized);
}

async function readIpHash(request) {
  const raw = request.headers.get("CF-Connecting-IP");
  if (typeof raw !== "string") return null;
  const ip = raw.trim();
  if (!ip || ip.length > 64 || /[\s\r\n]/.test(ip)) return null;
  return hashClientIp(ip);
}

function safeGolfapiId(raw) {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return null;
  return id;
}

/**
 * golfapi.io ignores `q` and filters on `name`. The app sends `name`.
 * `q` stays valid so older clients and stored gapi:search: keys still match.
 * A non-empty name wins; a blank name falls through to q.
 */
function golfapiSearchQuery(url) {
  const name = url.searchParams.get("name");
  if (typeof name === "string" && name.trim() !== "") return name;
  const q = url.searchParams.get("q");
  if (typeof q === "string" && q.trim() !== "") return q;
  return null;
}

function parseGolfapiRest(rest, url) {
  if (rest === "courses") {
    if (golfapiSearchQuery(url) == null) return null;
    return { kind: "search" };
  }
  let match = /^courses\/([^/]+)$/.exec(rest);
  if (match) {
    const id = safeGolfapiId(match[1]);
    return id ? { kind: "course", id } : null;
  }
  match = /^coordinates\/([^/]+)$/.exec(rest);
  if (match) {
    const id = safeGolfapiId(match[1]);
    return id ? { kind: "coord", id } : null;
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRequestsLeft(payload) {
  if (!isPlainObject(payload)) return null;
  const raw = payload.apiRequestsLeft;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function payloadHasError(payload) {
  return !isPlainObject(payload) || (payload.error != null && payload.error !== false);
}

function courseHasData(payload) {
  if (payloadHasError(payload)) return false;
  if (isPlainObject(payload.course) && courseHasData(payload.course)) return true;
  const id = payload.courseID ?? payload.courseId;
  if (typeof id !== "string" || id.trim() === "") return false;
  if (typeof payload.courseName === "string" && payload.courseName.trim() !== "") return true;
  if (payload.numHoles != null && payload.numHoles !== "" && Number(payload.numHoles) > 0) return true;
  if (Array.isArray(payload.tees) && payload.tees.length > 0) return true;
  if (Array.isArray(payload.parsMen) && payload.parsMen.length > 0) return true;
  if (Array.isArray(payload.pars) && payload.pars.length > 0) return true;
  return false;
}

function coordHasData(payload) {
  if (payloadHasError(payload)) return false;
  return Array.isArray(payload.coordinates) && payload.coordinates.length > 0;
}

function searchHasData(payload) {
  if (payloadHasError(payload)) return false;
  return Array.isArray(payload.courses);
}

function searchBodyOk(text) {
  try {
    return searchHasData(JSON.parse(text));
  } catch {
    return false;
  }
}

/** The one course whose normalized course or club name equals the query, or null. */
function matchingCourseId(payload, normalizedQuery) {
  if (!searchHasData(payload) || !normalizedQuery) return null;
  const hits = [];
  for (const course of payload.courses) {
    if (!isPlainObject(course)) continue;
    const names = [course.courseName, course.clubName, course.name].map(normalizeName).filter(Boolean);
    if (!names.some((name) => name === normalizedQuery)) continue;
    hits.push(safeGolfapiId(String(course.courseID ?? course.courseId ?? "")));
  }
  if (hits.length !== 1) return null;
  return hits[0];
}

function bodyHasData(kind, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return false;
  }
  return kind === "course" ? courseHasData(payload) : coordHasData(payload);
}

function classifyGolfapi(kind, status, text) {
  let payload = null;
  if (typeof text === "string" && text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  const left = readRequestsLeft(payload);
  if (status < 200 || status >= 300) {
    return { payload, left, outcome: status === 404 ? "nodata" : "error" };
  }
  if (kind === "search") return { payload, left, outcome: "search" };
  const hasData = kind === "course" ? courseHasData(payload) : coordHasData(payload);
  return { payload, left, outcome: hasData ? "data" : "nodata" };
}

function courseStoreKey(id) {
  return `gapi:course:${id}`;
}

function coordStoreKey(id) {
  return `gapi:coord:${id}`;
}

function storeKeyFor(kind, id) {
  return kind === "course" ? courseStoreKey(id) : coordStoreKey(id);
}

function emptyMarkerKey(kind, id) {
  return `gq:empty:${kind}:${id}`;
}

function blankLatencyRow() {
  return { count: 0, max: 0, samples: [] };
}

function blankLatency() {
  return {
    search: blankLatencyRow(),
    course: blankLatencyRow(),
    coordinates: blankLatencyRow(),
  };
}

function normalizeLatency(raw) {
  const latency = blankLatency();
  if (!isPlainObject(raw)) return latency;
  for (const kind of GOLFAPI_LATENCY_KINDS) {
    const row = raw[kind];
    if (!isPlainObject(row)) continue;
    latency[kind].count = clampCount(row.count);
    latency[kind].max = clampCount(row.max);
    if (Array.isArray(row.samples)) {
      latency[kind].samples = row.samples
        .map((value) => clampCount(value))
        .slice(0, GOLFAPI_LATENCY_SAMPLE);
    }
  }
  return latency;
}

function noteLatency(stats, kind, ms) {
  if (!GOLFAPI_LATENCY_KINDS.includes(kind) || typeof ms !== "number" || !Number.isFinite(ms)) return;
  if (!stats.latency) stats.latency = blankLatency();
  const row = stats.latency[kind];
  const elapsed = clampCount(ms);
  row.count += 1;
  if (elapsed > row.max) row.max = elapsed;
  if (row.samples.length < GOLFAPI_LATENCY_SAMPLE) {
    row.samples.push(elapsed);
    return;
  }
  const slot = Math.floor(Math.random() * row.count);
  if (slot < GOLFAPI_LATENCY_SAMPLE) row.samples[slot] = elapsed;
}

function sampleMedian(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function latencyView(stats) {
  const latency = normalizeLatency(stats && stats.latency);
  const view = {};
  for (const kind of GOLFAPI_LATENCY_KINDS) {
    view[kind] = {
      count: latency[kind].count,
      median: sampleMedian(latency[kind].samples),
      max: latency[kind].max,
    };
  }
  return view;
}

function blankStats() {
  return { lookups: 0, allowlistedLookups: 0, searches: 0, hits: 0, blocked: {}, latency: blankLatency() };
}

async function readStats(boards, key) {
  const stats = blankStats();
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return stats;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return stats;
    stats.lookups = clampCount(parsed.lookups);
    stats.allowlistedLookups = clampCount(parsed.allowlistedLookups);
    stats.searches = clampCount(parsed.searches);
    stats.hits = clampCount(parsed.hits);
    stats.latency = normalizeLatency(parsed.latency);
    if (isPlainObject(parsed.blocked)) stats.blocked = parsed.blocked;
  } catch {
    return blankStats();
  }
  return stats;
}

async function putCounter(boards, key, value, opts) {
  try {
    await boards.put(key, value, opts);
  } catch {
    // Same-key KV writes are about 1/s and are not atomic. Dropping one beat can overshoot a little.
  }
}

async function bumpStats(boards, day, mutate) {
  const key = `gq:stats:${day}`;
  const stats = await readStats(boards, key);
  mutate(stats);
  await putCounter(boards, key, JSON.stringify(stats), { expirationTtl: GOLFAPI_STATS_TTL });
  return stats;
}

function blankGcaStats() {
  return { upstream: 0, rateLimited: 0, stale: 0, missingInstallId: 0 };
}

async function readGcaStats(boards, key) {
  const stats = blankGcaStats();
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return stats;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return stats;
    stats.upstream = clampCount(parsed.upstream);
    stats.rateLimited = clampCount(parsed.rateLimited);
    stats.stale = clampCount(parsed.stale);
    stats.missingInstallId = clampCount(parsed.missingInstallId);
  } catch {
    return blankGcaStats();
  }
  return stats;
}

async function bumpGcaStats(boards, day, mutate) {
  const key = `gca:stats:${day}`;
  const stats = await readGcaStats(boards, key);
  mutate(stats);
  await putCounter(boards, key, JSON.stringify(stats), { expirationTtl: GOLFAPI_STATS_TTL });
  return stats;
}

function gcaStatsView(date, stats) {
  return {
    date,
    upstream: clampCount(stats && stats.upstream),
    rateLimited: clampCount(stats && stats.rateLimited),
    stale: clampCount(stats && stats.stale),
    missingInstallId: clampCount(stats && stats.missingInstallId),
  };
}

async function recordGcaUpstream(boards, day, { status, stale }) {
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return;
  await bumpGcaStats(boards, day, (stats) => {
    stats.upstream += 1;
    if (status === 429) stats.rateLimited += 1;
    if (stale) stats.stale += 1;
  });
}

async function recordGcaMissingInstall(boards, day) {
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return;
  await bumpGcaStats(boards, day, (stats) => {
    stats.missingInstallId += 1;
  });
}

/** The only write for a golfapi call that has no valid X-Install-Id. */
async function noteGolfapiInstallRequired(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return;
  const day = golfapiPeriods(new Date()).day;
  await bumpStats(boards, day, (stats) => {
    stats.blocked.install_id_required = clampCount(stats.blocked.install_id_required) + 1;
  });
}

function emptyBlocked() {
  const blocked = {};
  for (const reason of GOLFAPI_REASONS) blocked[reason] = 0;
  return blocked;
}

function statsView(date, stats) {
  const blocked = emptyBlocked();
  if (stats && isPlainObject(stats.blocked)) {
    for (const reason of GOLFAPI_REASONS) {
      blocked[reason] = clampCount(stats.blocked[reason]);
    }
  }
  const lookups = clampCount(stats && stats.lookups);
  return {
    date,
    lookups,
    globalLookups: lookups,
    allowlistedLookups: clampCount(stats && stats.allowlistedLookups),
    searches: clampCount(stats && stats.searches),
    hits: clampCount(stats && stats.hits),
    blocked,
    latency: latencyView(stats),
  };
}

function emptyBucket(now) {
  const periods = golfapiPeriods(now);
  return {
    day: periods.day,
    dayCount: 0,
    week: periods.week,
    weekCount: 0,
    month: periods.month,
    monthCount: 0,
    searchDay: periods.day,
    searchCount: 0,
  };
}

function normalizeBucket(raw, now) {
  const bucket = emptyBucket(now);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isPlainObject(parsed)) return bucket;
  const periods = golfapiPeriods(now);
  if (parsed.day === periods.day) bucket.dayCount = clampCount(parsed.dayCount);
  if (parsed.week === periods.week) bucket.weekCount = clampCount(parsed.weekCount);
  if (parsed.month === periods.month) bucket.monthCount = clampCount(parsed.monthCount);
  if (parsed.searchDay === periods.day) bucket.searchCount = clampCount(parsed.searchCount);
  return bucket;
}

async function loadBucket(boards, key, now) {
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return emptyBucket(now);
  return normalizeBucket(raw, now);
}

async function saveBucket(boards, key, bucket) {
  await putCounter(boards, key, JSON.stringify(bucket), { expirationTtl: GOLFAPI_BUCKET_TTL });
}

async function readSet(boards, key, now) {
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || typeof parsed.at !== "number") return null;
    if (now.getTime() - parsed.at >= GOLFAPI_SET_MS) return null;
    const courseId = typeof parsed.courseId === "string" ? safeGolfapiId(parsed.courseId) : null;
    return { at: parsed.at, courseId };
  } catch {
    return null;
  }
}

async function writeSet(boards, key, set, now) {
  const elapsed = Math.floor((now.getTime() - set.at) / 1000);
  const ttl = Math.max(60, GOLFAPI_SET_TTL - Math.max(0, elapsed));
  await putCounter(boards, key, JSON.stringify({ at: set.at, courseId: set.courseId || null }), { expirationTtl: ttl });
}

function planCourse(openSet, courseId, nowMs) {
  if (!openSet || (openSet.courseId && openSet.courseId !== courseId)) {
    return { charge: true, next: { at: nowMs, courseId } };
  }
  return { charge: false, next: { at: openSet.at, courseId: openSet.courseId || courseId } };
}

function planSearch(openSet, nowMs) {
  if (!openSet) return { charge: true, next: { at: nowMs, courseId: null } };
  return { charge: false, next: null };
}

function isAllowlisted(env, installId) {
  if (!installId || !env || typeof env.GOLFAPI_ALLOWLIST !== "string") return false;
  return env.GOLFAPI_ALLOWLIST.split(",").some((part) => part.trim() === installId);
}

function quotaFor(ident, allowlisted, openSetPlan) {
  if (allowlisted) {
    const devPlan = ident.dev ? openSetPlan(ident.devSet) : null;
    return {
      allowlisted: true,
      devPlan,
      ipPlan: null,
      chargeDevice: false,
      chargeIp: false,
      chargeGlobal: false,
      countAllowlisted: Boolean(devPlan && devPlan.charge),
      searchCount: 0,
    };
  }
  const devPlan = ident.dev ? openSetPlan(ident.devSet) : null;
  const ipPlan = ident.ip ? openSetPlan(ident.ipSet) : null;
  const chargeDevice = Boolean(devPlan && devPlan.charge);
  const chargeIp = Boolean(ipPlan && ipPlan.charge);
  return {
    allowlisted: false,
    devPlan,
    ipPlan,
    chargeDevice,
    chargeIp,
    chargeGlobal: chargeDevice || chargeIp || (!ident.dev && !ident.ip),
    countAllowlisted: false,
    searchCount: ident.dev ? ident.dev.searchCount : (ident.ip ? ident.ip.searchCount : 0),
  };
}

function lookupBlockReason({ chargeDevice, chargeIp, chargeGlobal, dev, ip, stats, limits }) {
  if (chargeGlobal && stats.lookups >= limits.globalDay) return "global_day";
  if (chargeDevice && dev) {
    if (dev.dayCount >= limits.deviceDay) return "device_day";
    if (dev.weekCount >= limits.deviceWeek) return "device_week";
    if (dev.monthCount >= limits.deviceMonth) return "device_month";
  }
  if (chargeIp && ip) {
    if (ip.dayCount >= limits.ipDay) return "ip_day";
    if (ip.weekCount >= limits.ipWeek) return "ip_week";
    if (ip.monthCount >= limits.ipMonth) return "ip_month";
  }
  return null;
}

async function loadIdentity(boards, installId, ipHash, now) {
  const devKey = installId ? `gq:dev:${installId}` : null;
  const ipKey = ipHash ? `gq:ip:${ipHash}` : null;
  const devSetKey = installId ? `gq:set:dev:${installId}` : null;
  const ipSetKey = ipHash ? `gq:set:ip:${ipHash}` : null;
  const dev = devKey ? await loadBucket(boards, devKey, now) : null;
  const ip = ipKey ? await loadBucket(boards, ipKey, now) : null;
  const devSet = devSetKey ? await readSet(boards, devSetKey, now) : null;
  const ipSet = ipSetKey ? await readSet(boards, ipSetKey, now) : null;
  return { devKey, ipKey, devSetKey, ipSetKey, dev, ip, devSet, ipSet };
}

async function readBalance(boards) {
  const raw = await boards.get(GOLFAPI_BALANCE_KEY);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const left = typeof parsed.left === "number" && Number.isFinite(parsed.left) ? parsed.left : null;
    const at = typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0;
    const lastStatus = Number.isInteger(parsed.lastStatus) ? parsed.lastStatus : 0;
    return { left, at, lastStatus };
  } catch {
    return null;
  }
}

function balanceBlocks(balance, floor) {
  return Boolean(balance && typeof balance.left === "number" && balance.left <= floor);
}

async function rememberBalance(boards, status, payload) {
  const parsedLeft = readRequestsLeft(payload);
  const prev = await readBalance(boards);
  const left = parsedLeft == null ? (prev ? prev.left : null) : parsedLeft;
  const next = { left, at: Date.now(), lastStatus: status };
  await putCounter(boards, GOLFAPI_BALANCE_KEY, JSON.stringify(next));
  return next;
}

function balanceAsOf(balance) {
  if (!balance || typeof balance.at !== "number" || balance.at <= 0) return null;
  return new Date(balance.at).toISOString();
}

function publicBalance(balance) {
  if (!balance) return null;
  return {
    left: typeof balance.left === "number" ? balance.left : null,
    at: balance.at,
    lastStatus: balance.lastStatus,
    asOf: balanceAsOf(balance),
  };
}

function limitedResponse(reason, queued, cors, now) {
  const retryAfterSec = retryAfterFor(reason, now);
  return golfJson(429, {
    error: "golfapi_limited",
    reason,
    queued,
    retryAfterSec,
  }, cors, { "Retry-After": String(retryAfterSec) });
}

async function enqueueCourse(boards, courseId) {
  const key = `gqueue:${courseId}`;
  const existing = await boards.get(key);
  if (existing != null) return;
  await boards.put(key, JSON.stringify({ attempts: 0, at: Date.now() }), { expirationTtl: GOLFAPI_QUEUE_TTL });
}

async function enqueueSearch(boards, job) {
  const token = await searchToken(job.q);
  const key = `gqueue:q:${token}`;
  const existing = await boards.get(key);
  if (existing != null) return;
  await boards.put(key, JSON.stringify({
    attempts: 0,
    at: Date.now(),
    q: job.q,
    search: job.search,
  }), { expirationTtl: GOLFAPI_QUEUE_TTL });
}

async function rejectLimited(boards, day, reason, queued, courseId, cors, now, searchJob) {
  await bumpStats(boards, day, (stats) => {
    stats.blocked[reason] = clampCount(stats.blocked[reason]) + 1;
  });
  if (queued && courseId) await enqueueCourse(boards, courseId);
  if (queued && searchJob) await enqueueSearch(boards, searchJob);
  return limitedResponse(reason, Boolean(queued), cors, now);
}

function storedGolfResponse(text, cors) {
  return new Response(text, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${GOLF_CACHE_SECONDS}`,
    },
  });
}

function upstreamGolfResponse(status, text, contentType, cors, cacheable) {
  return new Response(text, {
    status,
    headers: {
      ...cors,
      "Content-Type": contentType || "application/json",
      "Cache-Control": cacheable ? `public, max-age=${GOLF_CACHE_SECONDS}` : "no-store",
    },
  });
}

function edgeCache() {
  return typeof caches !== "undefined" && caches ? caches.default : null;
}

function rememberGolfEdge(cache, ctx, cacheKey, response) {
  if (!cache || typeof cache.put !== "function") return undefined;
  const put = Promise.resolve(cache.put(cacheKey, response.clone())).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else return put;
  return undefined;
}

async function fetchGolfapiUpstream(env, pathAndQuery) {
  const key = typeof env.GOLFAPI_KEY === "string" ? env.GOLFAPI_KEY.trim() : "";
  if (!key) return { configured: false };
  const started = Date.now();
  try {
    const upstream = await fetch(`https://golfapi.io/api/v2.3/${pathAndQuery}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    });
    return {
      configured: true,
      thrown: false,
      status: upstream.status,
      text: await upstream.text(),
      contentType: upstream.headers.get("Content-Type") ?? "application/json",
      ms: Math.max(0, Date.now() - started),
    };
  } catch {
    return { configured: true, thrown: true, ms: Math.max(0, Date.now() - started) };
  }
}

function callLatency(kind, upstream) {
  if (!upstream || typeof upstream.ms !== "number" || !Number.isFinite(upstream.ms)) return null;
  return { kind, ms: upstream.ms };
}

async function recordLatency(boards, day, kind, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return;
  await bumpStats(boards, day, (stats) => noteLatency(stats, kind, ms));
}

async function recordFresh(boards, periods, ident, chargeDevice, chargeIp, chargeGlobal, countSearch, extra) {
  const allowlisted = Boolean(extra && extra.allowlisted);
  const countAllowlisted = Boolean(extra && extra.countAllowlisted);
  const latency = extra && extra.latency;
  const trackSearch = countSearch && !allowlisted;
  if (ident.dev && (trackSearch || chargeDevice)) {
    if (trackSearch) ident.dev.searchCount += 1;
    if (chargeDevice) {
      ident.dev.dayCount += 1;
      ident.dev.weekCount += 1;
      ident.dev.monthCount += 1;
    }
    await saveBucket(boards, ident.devKey, ident.dev);
  }
  if (ident.ip && ((trackSearch && !ident.dev) || chargeIp)) {
    if (trackSearch && !ident.dev) ident.ip.searchCount += 1;
    if (chargeIp) {
      ident.ip.dayCount += 1;
      ident.ip.weekCount += 1;
      ident.ip.monthCount += 1;
    }
    await saveBucket(boards, ident.ipKey, ident.ip);
  }
  if (chargeGlobal || countSearch || countAllowlisted || latency) {
    await bumpStats(boards, periods.day, (stats) => {
      if (chargeGlobal) stats.lookups += 1;
      if (countAllowlisted) stats.allowlistedLookups += 1;
      if (countSearch) stats.searches += 1;
      if (latency) noteLatency(stats, latency.kind, latency.ms);
    });
  }
}

async function commitSets(boards, ident, devPlan, ipPlan, now) {
  if (devPlan && devPlan.next) await writeSet(boards, ident.devSetKey, devPlan.next, now);
  if (ipPlan && ipPlan.next) await writeSet(boards, ident.ipSetKey, ipPlan.next, now);
}

async function handleGolfapiSearch({ url, env, ctx, cors, boards, now, periods, limits, installId, ipHash, allowlisted }) {
  const normalized = normalizeName(golfapiSearchQuery(url));
  if (!normalized) return golfJson(404, { error: "unknown_route" }, cors);
  const token = await searchToken(normalized);
  const storeKey = `gapi:search:${token}`;
  const searchJob = { q: normalized, search: url.search };
  const stored = await boards.get(storeKey);
  if (typeof stored === "string" && searchBodyOk(stored)) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.hits += 1;
    });
    return storedGolfResponse(stored, cors);
  }

  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached && cached.status >= 200 && cached.status < 300) {
      const text = await cached.text();
      if (searchBodyOk(text)) {
        await boards.put(storeKey, text, { expirationTtl: GOLFAPI_SEARCH_TTL });
        await bumpStats(boards, periods.day, (stats) => {
          stats.hits += 1;
        });
        return storedGolfResponse(text, cors);
      }
    }
  }

  const ident = await loadIdentity(boards, installId, ipHash, now);
  const quota = quotaFor(ident, allowlisted, (openSet) => planSearch(openSet, now.getTime()));
  const balance = await readBalance(boards);
  if (balanceBlocks(balance, limits.floor)) {
    return rejectLimited(boards, periods.day, "floor", true, null, cors, now, searchJob);
  }
  if (!allowlisted && quota.chargeGlobal) {
    const reason = lookupBlockReason({
      chargeDevice: quota.chargeDevice,
      chargeIp: quota.chargeIp,
      chargeGlobal: quota.chargeGlobal,
      dev: ident.dev,
      ip: ident.ip,
      stats: await readStats(boards, `gq:stats:${periods.day}`),
      limits,
    });
    if (reason) return rejectLimited(boards, periods.day, reason, true, null, cors, now, searchJob);
  }
  if (!allowlisted && (ident.dev || ident.ip) && quota.searchCount >= limits.searchCap) {
    return rejectLimited(boards, periods.day, "search_device_day", true, null, cors, now, searchJob);
  }

  const upstream = await fetchGolfapiUpstream(env, `courses${url.search}`);
  if (!upstream.configured) return golfJson(503, { error: "not_configured" }, cors);
  if (upstream.thrown) {
    await recordLatency(boards, periods.day, "search", upstream.ms);
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }

  const classified = classifyGolfapi("search", upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  await recordFresh(boards, periods, ident, quota.chargeDevice, quota.chargeIp, quota.chargeGlobal, true, {
    allowlisted,
    countAllowlisted: quota.countAllowlisted,
    latency: callLatency("search", upstream),
  });
  await commitSets(boards, ident, quota.devPlan, quota.ipPlan, now);

  if (searchHasData(classified.payload)) {
    await boards.put(storeKey, upstream.text, { expirationTtl: GOLFAPI_SEARCH_TTL });
    const response = upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, true);
    await rememberGolfEdge(cache, ctx, cacheKey, response);
    return response;
  }
  return upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, false);
}

async function handleGolfapiLookup({ kind, id, url, env, ctx, cors, boards, now, periods, limits, installId, ipHash, allowlisted }) {
  const storeKey = storeKeyFor(kind, id);
  const stored = await boards.get(storeKey);
  if (typeof stored === "string" && bodyHasData(kind, stored)) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.hits += 1;
    });
    return storedGolfResponse(stored, cors);
  }

  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached && cached.status >= 200 && cached.status < 300) {
      const text = await cached.text();
      if (bodyHasData(kind, text)) {
        await boards.put(storeKey, text, { expirationTtl: GOLFAPI_STORE_TTL });
        if (typeof boards.delete === "function") await boards.delete(emptyMarkerKey(kind, id));
        await bumpStats(boards, periods.day, (stats) => {
          stats.hits += 1;
        });
        return storedGolfResponse(text, cors);
      }
    }
  }

  if ((await boards.get(emptyMarkerKey(kind, id))) != null) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.hits += 1;
    });
    return golfJson(404, { error: "no_course_data" }, cors);
  }

  const ident = await loadIdentity(boards, installId, ipHash, now);
  const quota = quotaFor(ident, allowlisted, (openSet) => planCourse(openSet, id, now.getTime()));
  const latencyKind = kind === "course" ? "course" : "coordinates";

  const balance = await readBalance(boards);
  if (balanceBlocks(balance, limits.floor)) {
    return rejectLimited(boards, periods.day, "floor", true, id, cors, now);
  }
  if (!allowlisted && quota.chargeGlobal) {
    const reason = lookupBlockReason({
      chargeDevice: quota.chargeDevice,
      chargeIp: quota.chargeIp,
      chargeGlobal: quota.chargeGlobal,
      dev: ident.dev,
      ip: ident.ip,
      stats: await readStats(boards, `gq:stats:${periods.day}`),
      limits,
    });
    if (reason) return rejectLimited(boards, periods.day, reason, true, id, cors, now);
  }

  const stem = kind === "course" ? "courses" : "coordinates";
  const upstream = await fetchGolfapiUpstream(env, `${stem}/${id}${url.search}`);
  if (!upstream.configured) return golfJson(503, { error: "not_configured" }, cors);
  if (upstream.thrown) {
    await recordLatency(boards, periods.day, latencyKind, upstream.ms);
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }

  const classified = classifyGolfapi(kind, upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  await recordFresh(boards, periods, ident, quota.chargeDevice, quota.chargeIp, quota.chargeGlobal, false, {
    allowlisted,
    countAllowlisted: quota.countAllowlisted,
    latency: callLatency(latencyKind, upstream),
  });
  await commitSets(boards, ident, quota.devPlan, quota.ipPlan, now);

  if (classified.outcome === "data") {
    await boards.put(storeKey, upstream.text, { expirationTtl: GOLFAPI_STORE_TTL });
    if (typeof boards.delete === "function") await boards.delete(emptyMarkerKey(kind, id));
    const response = upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, true);
    await rememberGolfEdge(cache, ctx, cacheKey, response);
    return response;
  }
  if (classified.outcome === "nodata") {
    // Remember "nothing here" without storing the error body, so a retry does not spend another paid call.
    await boards.put(emptyMarkerKey(kind, id), "1", { expirationTtl: GOLF_CACHE_SECONDS });
  }
  return upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, false);
}

async function handleGolfapi(request, url, rest, env, ctx, cors) {
  const parsed = parseGolfapiRest(rest, url);
  if (!parsed) return golfJson(404, { error: "unknown_route" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = new Date();
  const installId = readInstallId(request);
  const shared = {
    url,
    env,
    ctx,
    cors,
    boards,
    now,
    periods: golfapiPeriods(now),
    limits: readGolfapiLimits(env),
    installId,
    ipHash: await readIpHash(request),
    allowlisted: isAllowlisted(env, installId),
  };
  if (parsed.kind === "search") return handleGolfapiSearch(shared);
  return handleGolfapiLookup({ ...shared, kind: parsed.kind, id: parsed.id });
}

async function listKeys(boards, prefix) {
  if (!boards || typeof boards.list !== "function") return [];
  const names = [];
  let cursor;
  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    const page = await boards.list(cursor ? { prefix, cursor } : { prefix });
    const keys = page && Array.isArray(page.keys) ? page.keys : [];
    for (const entry of keys) {
      if (entry && typeof entry.name === "string") names.push(entry.name);
    }
    if (!page || page.list_complete !== false || !page.cursor) break;
    cursor = page.cursor;
  }
  return names;
}

function parseQueueRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    const attempts = Number(parsed && parsed.attempts);
    return {
      attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 0,
      at: Number(parsed && parsed.at) || 0,
      q: typeof parsed?.q === "string" ? parsed.q : "",
      search: typeof parsed?.search === "string" ? parsed.search : "",
    };
  } catch {
    return { attempts: 0, at: 0, q: "", search: "" };
  }
}

async function partReady(boards, kind, id) {
  if (typeof (await boards.get(storeKeyFor(kind, id))) === "string") return true;
  return (await boards.get(emptyMarkerKey(kind, id))) != null;
}

async function pullQueuedPart(env, boards, day, state, kind, id) {
  const stem = kind === "course" ? "courses" : "coordinates";
  const upstream = await fetchGolfapiUpstream(env, `${stem}/${id}`);
  await recordLatency(boards, day, kind === "course" ? "course" : "coordinates", upstream.ms);
  if (!upstream.configured || upstream.thrown) {
    state.failed = true;
    return;
  }
  state.fetched = true;
  const classified = classifyGolfapi(kind, upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  if (classified.outcome === "error") {
    state.failed = true;
    return;
  }
  if (classified.outcome === "data") {
    await boards.put(storeKeyFor(kind, id), upstream.text, { expirationTtl: GOLFAPI_STORE_TTL });
    await boards.delete(emptyMarkerKey(kind, id));
    return;
  }
  await boards.put(emptyMarkerKey(kind, id), "1", { expirationTtl: GOLF_CACHE_SECONDS });
}

/** Course then coordinates. A floor hit between them leaves the queue row for the next cron. */
async function refillCoursePair(env, boards, limits, day, state, courseId) {
  let courseDone = await partReady(boards, "course", courseId);
  let coordDone = await partReady(boards, "coord", courseId);
  if (!courseDone) {
    if (balanceBlocks(await readBalance(boards), limits.floor)) {
      state.stop = true;
      return;
    }
    await pullQueuedPart(env, boards, day, state, "course", courseId);
    if (state.failed) return;
    courseDone = true;
  }
  if (!coordDone) {
    if (balanceBlocks(await readBalance(boards), limits.floor)) {
      state.stop = true;
      return;
    }
    await pullQueuedPart(env, boards, day, state, "coord", courseId);
    if (state.failed) return;
    coordDone = true;
  }
  state.done = courseDone && coordDone;
}

async function drainSearchItem(env, boards, limits, day, item) {
  const state = { fetched: false, failed: false, stop: false, done: false };
  const storeKey = `gapi:search:${item.token}`;
  let stored = await boards.get(storeKey);
  if (typeof stored !== "string" || !searchBodyOk(stored)) {
    const upstream = await fetchGolfapiUpstream(env, `courses${item.record.search}`);
    await recordLatency(boards, day, "search", upstream.ms);
    if (!upstream.configured || upstream.thrown) {
      state.failed = true;
      return state;
    }
    state.fetched = true;
    let payload = null;
    if (typeof upstream.text === "string" && upstream.text) {
      try {
        payload = JSON.parse(upstream.text);
      } catch {
        payload = null;
      }
    }
    await rememberBalance(boards, upstream.status, payload);
    const httpOk = upstream.status >= 200 && upstream.status < 300;
    if (upstream.status === 404 || (httpOk && !searchHasData(payload))) {
      state.done = true;
      return state;
    }
    if (!httpOk || !searchHasData(payload)) {
      state.failed = true;
      return state;
    }
    await boards.put(storeKey, upstream.text, { expirationTtl: GOLFAPI_SEARCH_TTL });
    stored = upstream.text;
  }

  let payload = null;
  try {
    payload = JSON.parse(stored);
  } catch {
    payload = null;
  }
  const courseId = matchingCourseId(payload, item.record.q);
  if (!courseId) {
    state.done = true;
    return state;
  }
  await refillCoursePair(env, boards, limits, day, state, courseId);
  return state;
}

async function drainGolfapiQueue(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function" || typeof boards.delete !== "function") return;
  const secret = typeof env.GOLFAPI_KEY === "string" ? env.GOLFAPI_KEY.trim() : "";
  if (!secret) return;

  const now = new Date();
  const periods = golfapiPeriods(now);
  const limits = readGolfapiLimits(env);
  const names = await listKeys(boards, "gqueue:");
  const items = [];
  for (const name of names) {
    const record = parseQueueRecord(await boards.get(name));
    if (name.startsWith("gqueue:q:")) {
      const token = name.slice("gqueue:q:".length);
      // Original query string. The app sends name=; older rows used q=.
      const searchOk = record.search.startsWith("?") && !/[\r\n#]/.test(record.search);
      const tokenOk = /^[0-9a-f]{64}$/.test(token) && token === await searchToken(record.q);
      if (!tokenOk || record.q !== normalizeName(record.q) || !searchOk) {
        await boards.delete(name);
        continue;
      }
      items.push({ name, kind: "search", token, record });
      continue;
    }
    const id = safeGolfapiId(name.slice("gqueue:".length));
    if (!id || name !== `gqueue:${id}`) {
      await boards.delete(name);
      continue;
    }
    items.push({ name, kind: "course", id, record });
  }
  items.sort((left, right) => left.record.at - right.record.at || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  for (const item of items) {
    if (item.record.attempts >= GOLFAPI_GIVE_UP) continue;
    if (balanceBlocks(await readBalance(boards), limits.floor)) break;
    const stats = await readStats(boards, `gq:stats:${periods.day}`);
    if (stats.lookups >= limits.globalDay) break;

    const outcome = item.kind === "search"
      ? await drainSearchItem(env, boards, limits, periods.day, item)
      : await (async () => {
        const state = { fetched: false, failed: false, stop: false, done: false };
        await refillCoursePair(env, boards, limits, periods.day, state, item.id);
        return state;
      })();

    if (outcome.fetched) {
      await bumpStats(boards, periods.day, (row) => {
        row.lookups += 1;
      });
    }
    if (outcome.stop) break;
    if (outcome.failed) {
      const attempts = item.record.attempts + 1;
      const body = { attempts, at: item.record.at || Date.now() };
      if (item.kind === "search") {
        body.q = item.record.q;
        body.search = item.record.search;
      }
      await boards.put(item.name, JSON.stringify(body), { expirationTtl: GOLFAPI_QUEUE_TTL });
      continue;
    }
    if (outcome.done) await boards.delete(item.name);
  }
}

async function handleGolfapiMeta(request, env, cors) {
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = new Date();
  const limits = readGolfapiLimits(env);
  const balance = await readBalance(boards);
  const days = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const date = utcDay(now, offset);
    days.push(statsView(date, await readStats(boards, `gq:stats:${date}`)));
  }
  const today = { ...days[days.length - 1], globalCap: limits.globalDay };
  days[days.length - 1] = today;
  const queue = await listKeys(boards, "gqueue:");
  return golfJson(200, {
    balance: publicBalance(balance),
    asOf: balanceAsOf(balance),
    generatedAt: now.toISOString(),
    globalCap: limits.globalDay,
    today,
    days,
    queueLength: queue.length,
  }, cors);
}

async function handleGcaMeta(request, env, cors) {
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = new Date();
  const days = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const date = utcDay(now, offset);
    days.push(gcaStatsView(date, await readGcaStats(boards, `gca:stats:${date}`)));
  }
  return golfJson(200, {
    refreshDays: readGcaRefreshDays(env),
    generatedAt: now.toISOString(),
    today: days[days.length - 1],
    days,
  }, cors);
}

function golfJson(status, body, cors, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function matchGolfVendor(pathname) {
  for (const vendor of Object.values(GOLF_VENDORS)) {
    if (!pathname.startsWith(vendor.prefix)) continue;
    const rest = pathname.slice(vendor.prefix.length);
    if (vendor.routes.some((route) => route.test(rest))) return { vendor, rest };
    return { vendor, rest: null };
  }
  return null;
}

function isJsonContentType(value) {
  const media = String(value ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}

function safeGcaId(raw) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) return null;
  return raw;
}

/** Search stays edge-only. Course and green-centers are the durable reads. */
function parseGcaRest(rest) {
  if (rest === "courses") return { kind: "search" };
  let match = /^courses\/([^/]+)\/green-centers$/.exec(rest);
  if (match) {
    const id = safeGcaId(match[1]);
    return id ? { kind: "green-centers", id } : { kind: "search" };
  }
  match = /^courses\/([^/]+)$/.exec(rest);
  if (match) {
    const id = safeGcaId(match[1]);
    return id ? { kind: "course", id } : { kind: "search" };
  }
  return { kind: "search" };
}

function gcaStoreKey(kind, id) {
  return kind === "green-centers" ? `gca:greens:${id}` : `gca:course:${id}`;
}

function gcaRateHeaderValues(headers) {
  const values = {};
  if (!headers || typeof headers.forEach !== "function") return values;
  headers.forEach((value, name) => {
    const lower = String(name).toLowerCase();
    if (!GCA_RATE_HEADERS.has(lower) && !lower.startsWith("ratelimit-")) return;
    const text = String(value);
    values[lower] = text.length > 200 ? text.slice(0, 200) : text;
  });
  return values;
}

function logGcaRateLimit(kind, status, headers) {
  const rates = gcaRateHeaderValues(headers);
  if (status !== 429 && Object.keys(rates).length === 0) return;
  console.log(JSON.stringify({ route: kind, status, ...rates }));
}

/**
 * Only response-time transform for a durable GCA body. Called once per
 * client response. KV and the edge cache keep the raw upstream bytes.
 * Scorecard corrections run here for courses/{id}.
 */
export function presentGcaCourseBody(kind, courseId, rawBody, contentType) {
  if (kind !== "course") return rawBody;
  if (contentType != null && contentType !== "" && !isJsonContentType(contentType)) return rawBody;
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (!applyGcaScorecardCorrection(payload, courseId)) return rawBody;
  return JSON.stringify(payload);
}

function gcaClientResponse(kind, courseId, rawBody, cors, { maxAge, stale, ageSeconds, contentType } = {}) {
  const body = presentGcaCourseBody(kind, courseId, rawBody, contentType);
  const headers = {
    ...cors,
    "Content-Type": contentType || "application/json",
    "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
  };
  if (stale) {
    headers["X-Course-Data-Stale"] = "1";
    if (Number.isInteger(ageSeconds) && ageSeconds >= 0) headers["X-Course-Data-Age"] = String(ageSeconds);
  }
  return new Response(body, { status: 200, headers });
}

function gcaRawEdgeResponse(rawBody, cors, contentType) {
  return new Response(rawBody, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": contentType || "application/json",
      "Cache-Control": `public, max-age=${GOLF_CACHE_SECONDS}`,
    },
  });
}

async function readGcaStored(boards, key) {
  if (!boards || typeof boards.getWithMetadata !== "function") return null;
  const row = await boards.getWithMetadata(key);
  if (!row || typeof row.value !== "string" || row.value.length === 0) return null;
  const metadata = row.metadata;
  if (!isPlainObject(metadata) || metadata.status !== 200) return null;
  if (typeof metadata.storedAt !== "number" || !Number.isFinite(metadata.storedAt)) return null;
  return { body: row.value, storedAt: metadata.storedAt };
}

async function fetchGcaDurable(apiKey, upstreamUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GCA_UPSTREAM_MS);
  try {
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    return { thrown: false, response, body };
  } catch {
    return { thrown: true, response: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function handleGcaEdgeOnly({ url, rest, env, ctx, cors, apiKey, route, missingInstallId }) {
  const upstreamUrl = `${GOLF_VENDORS.gca.upstream}${rest}${url.search}`;
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const day = utcDay(new Date(), 0);
  const boards = env && env.BOARDS;
  if (missingInstallId) await recordGcaMissingInstall(boards, day);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    await recordGcaUpstream(boards, day, { status: null, stale: false });
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }

  logGcaRateLimit(route, upstream.status, upstream.headers);
  await recordGcaUpstream(boards, day, { status: upstream.status, stale: false });
  const body = await upstream.arrayBuffer();
  const ok = upstream.status >= 200 && upstream.status < 300;
  const response = new Response(body, {
    status: upstream.status,
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": ok ? `public, max-age=${GOLF_CACHE_SECONDS}` : "no-store",
    },
  });
  if (ok) {
    const put = rememberGolfEdge(cache, ctx, cacheKey, response);
    if (put) await put;
  }
  return response;
}

async function handleGcaDurable({ kind, id, url, rest, env, ctx, cors, apiKey, missingInstallId }) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }

  const storeKey = gcaStoreKey(kind, id);
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached) {
      if (cached.status >= 200 && cached.status < 300) {
        const raw = await cached.text();
        return gcaClientResponse(kind, id, raw, cors, {
          maxAge: GCA_CLIENT_MAX_AGE,
          contentType: cached.headers.get("Content-Type") || "application/json",
        });
      }
      if (cached.status === 404) return cached;
    }
  }

  if (missingInstallId) await recordGcaMissingInstall(boards, utcDay(new Date(), 0));

  const copy = await readGcaStored(boards, storeKey);
  const nowMs = Date.now();
  if (copy && nowMs - copy.storedAt < readGcaRefreshDays(env) * 24 * 60 * 60 * 1000) {
    const response = gcaClientResponse(kind, id, copy.body, cors, { maxAge: GCA_CLIENT_MAX_AGE });
    const put = rememberGolfEdge(cache, ctx, cacheKey, gcaRawEdgeResponse(copy.body, cors));
    if (put) await put;
    return response;
  }

  const outcome = await fetchGcaDurable(apiKey, `${GOLF_VENDORS.gca.upstream}${rest}${url.search}`);
  const day = utcDay(new Date(), 0);
  const status = outcome.response ? outcome.response.status : null;
  if (outcome.response) logGcaRateLimit(kind, status, outcome.response.headers);

  const upstreamFailed = outcome.thrown || status === 429 || (typeof status === "number" && status >= 500);
  if (upstreamFailed && copy) {
    await recordGcaUpstream(boards, day, { status, stale: true });
    const ageSeconds = Math.max(0, Math.floor((Date.now() - copy.storedAt) / 1000));
    return gcaClientResponse(kind, id, copy.body, cors, { stale: true, ageSeconds });
  }

  await recordGcaUpstream(boards, day, { status, stale: false });
  if (outcome.thrown) return golfJson(502, { error: "upstream_unreachable" }, cors);

  if (status === 429) {
    const retry = cleanRetryAfter(outcome.response.headers.get("Retry-After")) || "30";
    return golfJson(429, { error: "rate_limited" }, cors, { "Retry-After": retry });
  }

  const text = new TextDecoder().decode(outcome.body);
  if (status >= 200 && status < 300) {
    const contentType = outcome.response.headers.get("Content-Type") || "application/json";
    await boards.put(storeKey, text, {
      expirationTtl: GCA_STORE_TTL,
      metadata: { status: 200, storedAt: Date.now() },
    });
    const response = gcaClientResponse(kind, id, text, cors, { maxAge: GCA_CLIENT_MAX_AGE, contentType });
    const put = rememberGolfEdge(cache, ctx, cacheKey, gcaRawEdgeResponse(text, cors, contentType));
    if (put) await put;
    return response;
  }

  if (status === 404) {
    const notFound = new Response(outcome.body, {
      status: 404,
      headers: {
        ...cors,
        "Content-Type": outcome.response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": copy ? "no-store" : `public, max-age=${GCA_NEGATIVE_TTL}`,
      },
    });
    if (!copy) {
      const put = rememberGolfEdge(cache, ctx, cacheKey, notFound);
      if (put) await put;
    }
    return notFound;
  }

  return new Response(outcome.body, {
    status,
    headers: {
      ...cors,
      "Content-Type": outcome.response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function handleGca(request, url, rest, env, ctx, cors, apiKey) {
  const missingInstallId = !readInstallId(request);
  if (missingInstallId && gcaRequiresInstallId(env)) {
    return golfJson(401, { error: "install_id_required" }, cors);
  }
  const parsed = parseGcaRest(rest);
  if (parsed.kind === "course" || parsed.kind === "green-centers") {
    return handleGcaDurable({ kind: parsed.kind, id: parsed.id, url, rest, env, ctx, cors, apiKey, missingInstallId });
  }
  return handleGcaEdgeOnly({ url, rest, env, ctx, cors, apiKey, route: "search", missingInstallId });
}

/**
 * Response for a golf proxy route, or null so the caller falls through to
 * share-board GET/PUT /{code}.
 */
function responseWithoutAllowOrigin(response) {
  if (!response.headers.has("Access-Control-Allow-Origin")) return response;
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleGolfProxy(request, env, ctx, cors) {
  const url = new URL(request.url);
  const hit = matchGolfVendor(url.pathname);
  if (!hit) return null;
  if (hit.vendor.secret === "GOLFAPI_KEY") {
    if (!readInstallId(request)) {
      await noteGolfapiInstallRequired(env);
      return golfJson(401, { error: "install_id_required" }, cors);
    }
  } else if (!readInstallId(request) && gcaRequiresInstallId(env)) {
    return golfJson(401, { error: "install_id_required" }, cors);
  }
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  if (hit.rest == null) return golfJson(404, { error: "unknown_route" }, cors);

  const key = typeof env[hit.vendor.secret] === "string" ? env[hit.vendor.secret].trim() : "";
  if (!key) return golfJson(503, { error: "not_configured" }, cors);
  if (hit.vendor.secret === "GOLFAPI_KEY") {
    return handleGolfapi(request, url, hit.rest, env, ctx, cors);
  }
  return handleGca(request, url, hit.rest, env, ctx, cors, key);
}

/**
 * Same query as ShotTraxx src/course/osmOverlay.ts `overpassQuery`.
 * Golf-tagged ways and relations around the point, with geometry.
 * That function does not query nodes; copying it keeps parseOverpassOverlay unchanged.
 */
function overpassQuery(lat, lng, radiusM) {
  const r = Math.max(50, Math.min(3000, Math.round(radiusM)));
  return `[out:json][timeout:25];
(
  way["golf"="green"](around:${r},${lat},${lng});
  way["golf"="fairway"](around:${r},${lat},${lng});
  way["golf"="tee"](around:${r},${lat},${lng});
  way["golf"="hole"](around:${r},${lat},${lng});
  way["golf"="bunker"](around:${r},${lat},${lng});
  way["golf"="water_hazard"](around:${r},${lat},${lng});
  way["golf"="lateral_water_hazard"](around:${r},${lat},${lng});
  way["golf"="cartpath"](around:${r},${lat},${lng});
  relation["golf"="green"](around:${r},${lat},${lng});
  relation["golf"="fairway"](around:${r},${lat},${lng});
  relation["golf"="tee"](around:${r},${lat},${lng});
  relation["golf"="bunker"](around:${r},${lat},${lng});
  relation["golf"="water_hazard"](around:${r},${lat},${lng});
  relation["golf"="lateral_water_hazard"](around:${r},${lat},${lng});
);
out geom;`;
}

function parseCoord(raw, min, max) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function parseRadius(raw) {
  if (raw == null) return 1800;
  if (!/^\d+$/.test(raw)) return null;
  const radius = Number(raw);
  if (radius < 200 || radius > 2000) return null;
  return radius;
}

function parseOverlayRequest(url) {
  const courseId = url.searchParams.get("courseId");
  if (courseId == null || !COURSE_ID_RE.test(courseId)) return null;
  const lat = parseCoord(url.searchParams.get("lat"), -90, 90);
  const lng = parseCoord(url.searchParams.get("lng"), -180, 180);
  if (lat == null || lng == null) return null;
  const radius = parseRadius(url.searchParams.get("radius"));
  if (radius == null) return null;
  return { courseId, lat, lng, radius };
}

/** Location identity. courseId is not part of the key. */
function overlayLocationKey(lat, lng, radius) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}:${radius}`;
}

function cellIndex(value) {
  const millionths = Math.round(value * 1e6);
  return Math.floor(millionths / OSM_CELL_MILLIONTHS);
}

function formatCell(index) {
  const sign = index < 0 ? "-" : "";
  const abs = Math.abs(index);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

function wrapLngCell(index) {
  const span = 360 * 100;
  return ((index + 180 * 100) % span + span) % span - 180 * 100;
}

function clampLatCell(index) {
  if (index < -90 * 100) return -90 * 100;
  if (index > 90 * 100) return 90 * 100;
  return index;
}

function cellToken(lat, lng) {
  return `${formatCell(clampLatCell(cellIndex(lat)))},${formatCell(wrapLngCell(cellIndex(lng)))}`;
}

function cellsAround(lat, lng) {
  const latSpan = OSM_NEAR_M / 111320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngSpan = OSM_NEAR_M / Math.max(111320 * Math.abs(cos), 1);
  const steps = (span) => Math.min(OSM_MAX_CELL_STEPS, Math.floor(span / 0.01) + 1);
  const latN = steps(latSpan);
  const lngN = steps(lngSpan);
  const baseLat = cellIndex(lat);
  const baseLng = cellIndex(lng);
  const cells = new Set();
  for (let i = -latN; i <= latN; i++) {
    for (let j = -lngN; j <= lngN; j++) {
      cells.add(`${formatCell(clampLatCell(baseLat + i))},${formatCell(wrapLngCell(baseLng + j))}`);
    }
  }
  return [...cells];
}

function indexKeyFor(lat, lng) {
  return `osm:v1:index:${cellToken(lat, lng)}`;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return EARTH_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function validIndexEntry(entry) {
  return Boolean(
    entry
    && typeof entry.lat === "number"
    && typeof entry.lng === "number"
    && Number.isFinite(entry.lat)
    && Number.isFinite(entry.lng)
    && typeof entry.radius === "number"
    && entry.radius >= 200
    && entry.radius <= 2000,
  );
}

function savedCenter(lat, lng) {
  return {
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4)),
  };
}

function remarkIsRuntimeFailure(payload) {
  if (!payload || typeof payload !== "object") return false;
  const remark = payload.remark;
  if (typeof remark !== "string") return false;
  return /runtime error|timed ?out|timeout|too busy/i.test(remark);
}

function payloadHasGolf(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.elements)) return false;
  return payload.elements.some((element) => {
    if (!element || typeof element !== "object") return false;
    const tags = element.tags;
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) return false;
    return typeof tags.golf === "string" && tags.golf.trim() !== "";
  });
}

/** Positive cache entries must still be an overlay. A negative marker is never a 200. */
function storedOverlay(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const payload = JSON.parse(text);
    if (remarkIsRuntimeFailure(payload) || !payloadHasGolf(payload)) return null;
    return text;
  } catch {
    return null;
  }
}

function cleanRetryAfter(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function overlayDataResponse(body, cors, cacheState) {
  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": cacheState === "STALE" ? "no-store" : `public, max-age=${OSM_EDGE_TTL}`,
      "X-Overlay-Cache": cacheState,
    },
  });
}

/** Edge copy carries fetchedAt so a hit older than 30 days is not served as fresh. */
function edgeCacheResponse(body, cors, fetchedAt) {
  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${OSM_EDGE_TTL}`,
      "X-Overlay-Cache": "HIT",
      "X-Overlay-Fetched-At": String(fetchedAt),
    },
  });
}

function serveOutcome(outcome, cors, cacheState) {
  if (outcome.kind === "data") return overlayDataResponse(outcome.body, cors, cacheState);
  if (outcome.kind === "empty") {
    return golfJson(404, { error: "no_overlay" }, cors, {
      "X-Overlay-Cache": cacheState,
    });
  }
  return golfJson(503, { error: "upstream_busy" }, cors, {
    "Retry-After": outcome.retryAfter || "30",
  });
}

function presentedState(outcome, waiter) {
  const state = outcome.cacheState;
  if (waiter && state === "MISS") return "HIT";
  return state;
}

async function callOverpass(url, query, timeoutMs) {
  if (timeoutMs < 200) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": OVERPASS_USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    return { response, status: response.status, text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** null → retry or give up. Empty is final: no golf features, do not retry. */
function classifyAttempt(result) {
  if (!result || result.status !== 200) return null;
  let payload;
  try {
    payload = JSON.parse(result.text);
  } catch {
    return null;
  }
  if (remarkIsRuntimeFailure(payload)) return null;
  if (payloadHasGolf(payload)) return { kind: "data", body: result.text };
  return { kind: "empty" };
}

async function fetchOverlayUpstream(query) {
  const deadline = Date.now() + OSM_BUDGET_MS;
  const primaryBudget = Math.min(OSM_PRIMARY_MS, Math.max(0, deadline - Date.now()));
  const first = await callOverpass(OVERPASS_PRIMARY, query, primaryBudget);
  const firstHit = classifyAttempt(first);
  if (firstHit) return firstHit;

  const firstRetry = first && first.response ? first.response.headers.get("Retry-After") : null;
  // No response means the primary timed out or threw. Those, plus 429 and 504, use the mirror.
  const useMirror = !first || first.status === 429 || first.status === 504;
  const pause = Math.min(OSM_BACKOFF_MS, Math.max(0, deadline - Date.now() - 500));
  if (pause > 0) await sleep(pause);
  const remaining = deadline - Date.now();
  if (remaining < 500) {
    return { kind: "busy", retryAfter: cleanRetryAfter(firstRetry) || "30" };
  }
  const secondUrl = useMirror ? OVERPASS_MIRROR : OVERPASS_PRIMARY;
  const second = await callOverpass(secondUrl, query, remaining);
  const secondHit = classifyAttempt(second);
  if (secondHit) return secondHit;
  const secondRetry = second && second.response ? second.response.headers.get("Retry-After") : null;
  return {
    kind: "busy",
    retryAfter: cleanRetryAfter(secondRetry) || cleanRetryAfter(firstRetry) || "30",
  };
}

/** Remember where a positive overlay was stored so a nearby pin can find it. */
async function indexSavedOverlay(boards, lat, lng, radius) {
  const center = savedCenter(lat, lng);
  const key = indexKeyFor(center.lat, center.lng);
  let entries = [];
  const raw = await boards.get(key);
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.filter(validIndexEntry);
    } catch {
      entries = [];
    }
  }
  const exists = entries.some((entry) => entry.lat === center.lat && entry.lng === center.lng && entry.radius === radius);
  if (!exists) {
    entries.push({ lat: center.lat, lng: center.lng, radius });
    if (entries.length > 32) entries = entries.slice(entries.length - 32);
  }
  await boards.put(key, JSON.stringify(entries), { expirationTtl: OSM_KV_TTL });
}

async function rememberEdge(cache, ctx, edgeKey, response) {
  if (!cache || typeof cache.put !== "function") return;
  // KV is the durable copy. A full edge cache should not fail the phone.
  const put = Promise.resolve()
    .then(() => cache.put(edgeKey, response))
    .catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else await put;
}

function isFresh(fetchedAt, now = Date.now()) {
  return Number.isFinite(fetchedAt) && fetchedAt > 0 && now - fetchedAt < OSM_FRESH_MS;
}

function positivePutOptions(fetchedAt) {
  return { expirationTtl: OSM_KV_TTL, metadata: { fetchedAt } };
}

/** Value stays the raw Overpass JSON. fetchedAt lives in KV metadata. */
async function readPositive(boards, dataKey) {
  if (typeof boards.getWithMetadata === "function") {
    const row = await boards.getWithMetadata(dataKey);
    if (!row || row.value == null) return null;
    const body = storedOverlay(row.value);
    if (!body) return null;
    const fetchedAt = row.metadata && Number(row.metadata.fetchedAt);
    return { body, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
  }
  const body = storedOverlay(await boards.get(dataKey));
  if (!body) return null;
  return { body, fetchedAt: 0 };
}

/**
 * Ask Overpass for a newer overlay. Success overwrites the positive entry.
 * Busy, timeout, or empty leaves it untouched. Returns the new body, or null.
 */
async function refreshStoredOverlay({ boards, cache, edgeKey, dataKey, query, cors, lat, lng, radius }) {
  try {
    const upstream = await fetchOverlayUpstream(query);
    if (upstream.kind !== "data") return null;
    const fetchedAt = Date.now();
    await boards.put(dataKey, upstream.body, positivePutOptions(fetchedAt));
    await indexSavedOverlay(boards, lat, lng, radius).catch(() => {});
    if (cache && typeof cache.put === "function") {
      await Promise.resolve(cache.put(edgeKey, edgeCacheResponse(upstream.body, cors, fetchedAt))).catch(() => {});
    }
    return { body: upstream.body, fetchedAt };
  } catch {
    return null;
  }
}

/**
 * Fresh copy is HIT (or HIT-NEAR). A stale copy is served immediately and refreshed
 * at most once an hour. refreshedState is REFRESHED only when this request waited.
 */
async function serveStored({
  existing,
  boards,
  cache,
  ctx,
  edgeKey,
  dataKey,
  refreshKey,
  query,
  cors,
  lat,
  lng,
  radius,
  freshState,
  staleState,
  refreshedState,
}) {
  if (isFresh(existing.fetchedAt)) {
    await rememberEdge(cache, ctx, edgeKey, edgeCacheResponse(existing.body, cors, existing.fetchedAt));
    return { kind: "data", body: existing.body, cacheState: freshState };
  }
  if ((await boards.get(refreshKey)) != null) {
    return { kind: "data", body: existing.body, cacheState: staleState };
  }
  await boards.put(refreshKey, "1", { expirationTtl: OSM_REFRESH_TTL });
  const refresh = refreshStoredOverlay({ boards, cache, edgeKey, dataKey, query, cors, lat, lng, radius });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(refresh);
    return { kind: "data", body: existing.body, cacheState: staleState };
  }
  const updated = await refresh;
  if (updated) return { kind: "data", body: updated.body, cacheState: refreshedState };
  return { kind: "data", body: existing.body, cacheState: staleState };
}

/**
 * One cheap read of the pre-location key for this same courseId and rounded point.
 * Other course ids are not scanned; those entries re-warm on the next miss.
 */
async function adoptLegacy(boards, courseId, lat, lng, radius, dataKey) {
  const legacyKey = `osm:v1:${courseId}:${overlayLocationKey(lat, lng, radius)}`;
  const legacy = await readPositive(boards, legacyKey);
  if (!legacy) return null;
  if (legacy.fetchedAt > 0) {
    await boards.put(dataKey, legacy.body, positivePutOptions(legacy.fetchedAt));
  } else {
    await boards.put(dataKey, legacy.body, { expirationTtl: OSM_KV_TTL });
  }
  await indexSavedOverlay(boards, lat, lng, radius).catch(() => {});
  return legacy;
}

/** Nearest saved overlay with the same radius whose center is within OSM_NEAR_M. Negatives are not indexed. */
async function findNearbyOverlay(boards, lat, lng, radius) {
  const exact = savedCenter(lat, lng);
  const cells = cellsAround(lat, lng);
  const lists = await Promise.all(cells.map(async (cell) => {
    const raw = await boards.get(`osm:v1:index:${cell}`);
    if (typeof raw !== "string" || !raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(validIndexEntry) : [];
    } catch {
      return [];
    }
  }));
  const ranked = [];
  for (const entry of lists.flat()) {
    if (entry.radius !== radius) continue;
    if (entry.lat === exact.lat && entry.lng === exact.lng) continue;
    const dist = distanceMeters(lat, lng, entry.lat, entry.lng);
    if (dist > OSM_NEAR_M) continue;
    const token = overlayLocationKey(entry.lat, entry.lng, entry.radius);
    ranked.push({ entry, dist, token });
  }
  ranked.sort((a, b) => a.dist - b.dist || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  for (const item of ranked) {
    const dataKey = `osm:v1:${item.token}`;
    const existing = await readPositive(boards, dataKey);
    if (!existing) continue;
    return {
      ...existing,
      dataKey,
      refreshKey: `osm:v1:refreshing:${item.token}`,
      lat: item.entry.lat,
      lng: item.entry.lng,
      radius: item.entry.radius,
    };
  }
  return null;
}

async function loadOverlay({
  env,
  ctx,
  cache,
  edgeKey,
  dataKey,
  noneKey,
  refreshKey,
  query,
  cors,
  courseId,
  lat,
  lng,
  radius,
}) {
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(edgeKey);
    if (cached && cached.status === 200) {
      const fetchedAt = Number(cached.headers.get("X-Overlay-Fetched-At"));
      if (isFresh(fetchedAt)) {
        const body = storedOverlay(await cached.text());
        if (body) return { kind: "data", body, cacheState: "HIT" };
      }
    }
  }

  const boards = env.BOARDS;
  const storedArgs = { boards, cache, ctx, edgeKey, cors, lat, lng, radius };
  let existing = await readPositive(boards, dataKey);
  if (!existing) existing = await adoptLegacy(boards, courseId, lat, lng, radius, dataKey);
  if (existing) {
    return serveStored({
      ...storedArgs,
      existing,
      dataKey,
      refreshKey,
      query,
      freshState: "HIT",
      staleState: "STALE",
      refreshedState: "REFRESHED",
    });
  }

  // Nearby reuse beats an exact-location negative marker. A 404 at this pin must
  // not hide a saved overlay within 600 m.
  const nearby = await findNearbyOverlay(boards, lat, lng, radius).catch(() => null);
  if (nearby) {
    return serveStored({
      ...storedArgs,
      existing: nearby,
      dataKey: nearby.dataKey,
      refreshKey: nearby.refreshKey,
      query: overpassQuery(nearby.lat, nearby.lng, nearby.radius),
      lat: nearby.lat,
      lng: nearby.lng,
      radius: nearby.radius,
      freshState: "HIT-NEAR",
      staleState: "HIT-NEAR",
      refreshedState: "HIT-NEAR",
    });
  }

  // Negative marker only when there is no exact or nearby positive. It answers
  // 404 for this location only and is never indexed for nearby reuse.
  if ((await boards.get(noneKey)) != null) return { kind: "empty", cacheState: "HIT" };

  const upstream = await fetchOverlayUpstream(query);
  if (upstream.kind === "data") {
    const fetchedAt = Date.now();
    await boards.put(dataKey, upstream.body, positivePutOptions(fetchedAt));
    await indexSavedOverlay(boards, lat, lng, radius).catch(() => {});
    await rememberEdge(cache, ctx, edgeKey, edgeCacheResponse(upstream.body, cors, fetchedAt));
    return { kind: "data", body: upstream.body, cacheState: "MISS" };
  }
  if (upstream.kind === "empty") {
    await boards.put(noneKey, "1", { expirationTtl: OSM_NEGATIVE_TTL });
    return { kind: "empty", cacheState: "MISS" };
  }
  return { kind: "busy", retryAfter: upstream.retryAfter || "30" };
}

/**
 * Response for /osm/..., or null so the caller falls through to share-board GET/PUT.
 */
async function handleOsmOverlay(request, env, ctx, cors) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/osm/")) return null;
  if (url.pathname !== "/osm/v1/overlay") return golfJson(404, { error: "unknown_route" }, cors);
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);

  const params = parseOverlayRequest(url);
  if (!params) return golfJson(400, { error: "bad_request" }, cors);

  // courseId stays on the query for clients and for one legacy-key read. It is not part of the cache key.
  const locationKey = overlayLocationKey(params.lat, params.lng, params.radius);
  const dataKey = `osm:v1:${locationKey}`;
  const noneKey = `osm:v1:none:${locationKey}`;
  const refreshKey = `osm:v1:refreshing:${locationKey}`;
  const boards = env && env.BOARDS;
  const boardsReady = Boolean(boards && typeof boards.get === "function" && typeof boards.put === "function");
  if (!boardsReady) return golfJson(503, { error: "boards_not_configured" }, cors);

  const pending = osmInflight.get(dataKey);
  if (pending) {
    const outcome = await pending;
    return serveOutcome(outcome, cors, presentedState(outcome, true));
  }

  const cache = typeof caches !== "undefined" && caches ? caches.default : null;
  const edgeKey = new Request(url.toString(), { method: "GET" });
  const run = loadOverlay({
    env,
    ctx,
    cache,
    edgeKey,
    dataKey,
    noneKey,
    refreshKey,
    query: overpassQuery(params.lat, params.lng, params.radius),
    cors,
    courseId: params.courseId,
    lat: params.lat,
    lng: params.lng,
    radius: params.radius,
  }).catch(() => ({ kind: "busy", retryAfter: "30" }));
  osmInflight.set(dataKey, run);
  try {
    const outcome = await run;
    return serveOutcome(outcome, cors, presentedState(outcome, false));
  } finally {
    if (osmInflight.get(dataKey) === run) osmInflight.delete(dataKey);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasLatLng(point) {
  return isPlainObject(point) && finiteNumber(point.lat) && finiteNumber(point.lng);
}

function holeHasTeeAndGreen(hole) {
  return isPlainObject(hole) && hasLatLng(hole.tee) && hasLatLng(hole.green);
}

/** Positive integer hole number already present on a stored hole. */
function holeNumber(hole) {
  if (!isPlainObject(hole)) return null;
  const raw = hole.hole;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}

function parsePaintRecord(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function emptyPaintField(value) {
  if (value == null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function numericNumHoles(record) {
  if (!isPlainObject(record) || record.numHoles == null || record.numHoles === "") return null;
  const n = typeof record.numHoles === "number" ? record.numHoles : Number(String(record.numHoles).trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function sameNumHoles(a, b) {
  const left = numericNumHoles(a);
  const right = numericNumHoles(b);
  return left != null && left === right;
}

/** One entry per hole number. A complete tee+green hole wins over an earlier blank. */
function indexPaintHoles(holes) {
  const map = new Map();
  const order = [];
  if (!Array.isArray(holes)) return { map, order };
  for (const hole of holes) {
    const n = holeNumber(hole);
    if (n == null) continue;
    const prev = map.get(n);
    if (!prev) {
      map.set(n, hole);
      order.push(n);
      continue;
    }
    if (!holeHasTeeAndGreen(prev) && holeHasTeeAndGreen(hole)) map.set(n, hole);
  }
  return { map, order };
}

function completeHoleCount(holes) {
  const { map } = indexPaintHoles(holes);
  let count = 0;
  for (const hole of map.values()) {
    if (holeHasTeeAndGreen(hole)) count += 1;
  }
  return count;
}

function paintHasGaps(record) {
  const numHoles = numericNumHoles(record);
  if (numHoles == null) return false;
  return completeHoleCount(record.holes) < numHoles;
}

function unionPaintAliases(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const list of [existing, incoming]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "string") continue;
      const alias = item.trim();
      if (!alias || alias.length > 180 || seen.has(alias)) continue;
      seen.add(alias);
      out.push(alias);
    }
  }
  return out;
}

function paintAliasKeys(record, selfKey) {
  const keys = [];
  const seen = new Set();
  if (!Array.isArray(record.aliases)) return keys;
  for (const item of record.aliases) {
    if (typeof item !== "string") continue;
    const alias = item.trim();
    if (!alias || alias.length > 180 || alias === selfKey || seen.has(alias)) continue;
    if (!isPaintKey(alias) || isReservedBoardKey(alias)) continue;
    seen.add(alias);
    keys.push(alias);
  }
  return keys;
}

/**
 * Copy holes the base record is missing, or replace a hole that has no tee or
 * no green. A hole that already has both stays as stored. Hole objects are
 * moved whole; tee and green are never mixed from two records.
 */
function mergePaintHoles(baseHoles, donorHoles) {
  const { map, order } = indexPaintHoles(baseHoles);
  const donor = indexPaintHoles(donorHoles);
  let changed = false;
  for (const n of donor.order) {
    const incomingHole = donor.map.get(n);
    const current = map.get(n);
    if (!current) {
      map.set(n, incomingHole);
      order.push(n);
      changed = true;
      continue;
    }
    if (holeHasTeeAndGreen(current)) continue;
    if (JSON.stringify(current) === JSON.stringify(incomingHole)) continue;
    map.set(n, incomingHole);
    changed = true;
  }
  const holes = order.map((n) => map.get(n));
  if (Array.isArray(baseHoles)) {
    for (const hole of baseHoles) {
      if (isPlainObject(hole) && holeNumber(hole) == null) holes.push(hole);
    }
  }
  return { holes, changed };
}

/**
 * Blanks-only merge for a PUT over an existing paint record.
 * `added` is false when the stored record would not gain a hole, an alias,
 * or a top-level value that was empty.
 */
function mergePaintRecords(existing, incoming) {
  const base = isPlainObject(existing) ? existing : {};
  const next = isPlainObject(incoming) ? incoming : {};
  const merged = { ...base };
  let fieldsChanged = false;
  for (const [field, value] of Object.entries(next)) {
    if (field === "holes" || field === "aliases") continue;
    if (emptyPaintField(merged[field]) && !emptyPaintField(value)) {
      merged[field] = value;
      fieldsChanged = true;
    }
  }

  const aliases = unionPaintAliases(base.aliases, next.aliases);
  const previousAliases = unionPaintAliases(base.aliases, []);
  const aliasesChanged = aliases.length !== previousAliases.length
    || aliases.some((alias, index) => alias !== previousAliases[index]);
  if (aliases.length > 0) merged.aliases = aliases;

  const holeMerge = mergePaintHoles(base.holes, next.holes);
  const beforeComplete = completeHoleCount(base.holes);
  const afterComplete = completeHoleCount(holeMerge.holes);
  const holesChanged = holeMerge.changed && afterComplete >= beforeComplete;
  if (holesChanged) merged.holes = holeMerge.holes;

  return {
    record: merged,
    added: fieldsChanged || aliasesChanged || holesChanged,
  };
}

function paintReplaceRequested(request) {
  const raw = request.headers.get("X-Paint-Replace");
  return typeof raw === "string" && raw.trim() === "1";
}

function paintUnchangedResponse(cors) {
  return new Response(JSON.stringify({ changed: false, message: "nothing changed" }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function paintStoredResponse(body, cors) {
  return new Response(body, {
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * Older phones PUT a short hole list over a fuller record. Keep every stored
 * hole that already has a tee and a green. X-Paint-Replace: 1 stores the
 * body as sent, for an intentional correction.
 */
async function putPaintRecord(boards, key, body, ttl, request, cors) {
  if (paintReplaceRequested(request)) {
    await boards.put(key, body, { expirationTtl: ttl });
    return paintStoredResponse(body, cors);
  }
  const existingRaw = await boards.get(key);
  if (!existingRaw) {
    await boards.put(key, body, { expirationTtl: ttl });
    return paintStoredResponse(body, cors);
  }
  const existing = parsePaintRecord(existingRaw);
  const incoming = parsePaintRecord(body);
  if (!existing || !incoming) return paintUnchangedResponse(cors);
  const { record, added } = mergePaintRecords(existing, incoming);
  if (!added || completeHoleCount(record.holes) < completeHoleCount(existing.holes)) {
    return paintUnchangedResponse(cors);
  }
  const stored = JSON.stringify(record);
  await boards.put(key, stored, { expirationTtl: ttl });
  return paintStoredResponse(stored, cors);
}

/** Read-only fill. Alias holes are copied only when numHoles matches. */
async function paintGetBody(boards, key, raw) {
  const record = parsePaintRecord(raw);
  if (!record || !paintHasGaps(record)) return raw;
  const aliases = paintAliasKeys(record, key).slice(0, 3);
  if (aliases.length === 0) return raw;
  let current = record;
  let changed = false;
  for (const alias of aliases) {
    const other = parsePaintRecord(await boards.get(alias));
    if (!other || !sameNumHoles(current, other)) continue;
    const holeMerge = mergePaintHoles(current.holes, other.holes);
    if (!holeMerge.changed) continue;
    if (completeHoleCount(holeMerge.holes) < completeHoleCount(current.holes)) continue;
    current = { ...current, holes: holeMerge.holes };
    changed = true;
  }
  return changed ? JSON.stringify(current) : raw;
}

const COURSE_REPORT_TTL = 60 * 60 * 24 * 180;
/** KV deletes the address this long after accept, even if nobody reviews it. */
const COURSE_REPORT_EMAIL_TTL = 60 * 60 * 24 * 365;
const COURSE_REPORT_BODY_MAX = 4096;
const COURSE_REPORT_IP_DAY_DEFAULT = 30;
const COURSE_REPORT_DEVICE_DAY_DEFAULT = 20;
const COURSE_REPORT_REASONS = new Set([
  "hole_missing",
  "green_wrong",
  "tee_wrong",
  "wrong_par",
  "wrong_course",
  "other",
  "hole-contribution",
]);
const CONTRIBUTION_METHODS = new Set(["tap-map", "im-here"]);
const REVIEW_STATUSES = new Set(["pending", "approved", "rejected", "used", "rewarded"]);
const REVIEW_DECISIONS = new Set(["approved", "rejected", "used", "rewarded"]);
/** Inclusive playing length in yards. Par 6 is accepted and has no band. */
const PAR_LENGTH_YARDS = {
  3: [60, 280],
  4: [230, 520],
  5: [400, 680],
};
const METERS_PER_YARD = 0.9144;
const POOR_FIX_ACCURACY_M = 15;
const COURSE_REPORT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 8-4-4-4-12 hex, any version. Case-insensitive. The 64-char cap is a hard ceiling. */
const COURSE_REPORT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COURSE_REPORT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isCourseReportPath(pathname) {
  return pathname === "/v1/course-reports" || pathname.startsWith("/v1/course-reports/");
}

function readCourseReportLimits(env) {
  const source = env || {};
  return {
    ipDay: readConfigInt(source.COURSE_REPORTS_IP_DAY) ?? COURSE_REPORT_IP_DAY_DEFAULT,
    deviceDay: readConfigInt(source.COURSE_REPORTS_DEVICE_DAY) ?? COURSE_REPORT_DEVICE_DAY_DEFAULT,
  };
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

function validClientReportId(value) {
  return typeof value === "string" && value.length <= 64 && COURSE_REPORT_UUID_RE.test(value);
}

function isIsoDateTime(value) {
  if (typeof value !== "string" || value.length > 40 || !COURSE_REPORT_ISO_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function invalidField(field) {
  return { ok: false, field };
}

function readOptionalString(payload, field, max) {
  if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] == null) {
    return { ok: true, present: false };
  }
  if (typeof payload[field] !== "string") return invalidField(field);
  const text = payload[field].trim();
  if (text.length > max) return invalidField(field);
  return { ok: true, present: true, value: text };
}

function parseLatLon(point) {
  if (!isPlainObject(point) || !finiteNumber(point.lat) || !finiteNumber(point.lon)) return null;
  if (point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) return null;
  return { lat: point.lat, lon: point.lon };
}

/**
 * What the phone displayed. Bad data is the report, so this never fails the
 * request: a non-object becomes null, a par outside 1..10 becomes null, and
 * a green or tee that is not a lat/lon becomes null.
 */
function normalizeShown(shown) {
  if (!isPlainObject(shown)) return null;
  const out = {};
  if (Object.prototype.hasOwnProperty.call(shown, "par")) {
    out.par = Number.isInteger(shown.par) && shown.par >= 1 && shown.par <= 10 ? shown.par : null;
  }
  for (const name of ["green", "tee"]) {
    if (!Object.prototype.hasOwnProperty.call(shown, name)) continue;
    out[name] = parseLatLon(shown[name]);
  }
  return out;
}

function invalidContribution(name) {
  return invalidField(name ? `contribution.${name}` : "contribution");
}

/**
 * Hole map sent by the player. Required only when reasons includes
 * hole-contribution. Without that reason the object is ignored, including
 * when it is malformed, so an ordinary problem report still stores.
 */
function parseHoleContribution(payload, reasons) {
  const required = reasons.includes("hole-contribution");
  if (!required) return { ok: true, present: false, contributorEmail: null };
  if (!isPlainObject(payload.contribution)) return invalidContribution();
  const src = payload.contribution;
  const green = parseLatLon(src.green);
  if (!green) return invalidContribution("green");
  if (typeof src.greenMethod !== "string" || !CONTRIBUTION_METHODS.has(src.greenMethod)) {
    return invalidContribution("greenMethod");
  }
  const contribution = { green, greenMethod: src.greenMethod };

  if (Object.prototype.hasOwnProperty.call(src, "tee") && src.tee != null) {
    const tee = parseLatLon(src.tee);
    if (!tee) return invalidContribution("tee");
    contribution.tee = tee;
  }
  if (Object.prototype.hasOwnProperty.call(src, "par") && src.par != null) {
    if (!Number.isInteger(src.par) || src.par < 3 || src.par > 6) return invalidContribution("par");
    contribution.par = src.par;
  }
  let contributorEmail = null;
  if (Object.prototype.hasOwnProperty.call(src, "contributorEmail") && src.contributorEmail != null) {
    if (typeof src.contributorEmail !== "string") return invalidContribution("contributorEmail");
    const email = src.contributorEmail.trim().toLowerCase();
    if (email.length < 1 || email.length > 254 || !COURSE_REPORT_EMAIL_RE.test(email)) {
      return invalidContribution("contributorEmail");
    }
    contributorEmail = email;
    contribution.hadEmail = true;
  }
  return { ok: true, present: true, contribution, contributorEmail };
}

/**
 * Review hints only. A poor fix or an implausible length is still stored.
 * The phone is what refuses those. Missing tee, par, or position omits the
 * hint that needs it. Coordinates and par are never filled in here.
 */
function contributionHints(contribution, position) {
  const hints = {};
  const fix = isPlainObject(position) && finiteNumber(position.lat) && finiteNumber(position.lon)
    ? position
    : null;
  if (contribution.greenMethod === "im-here" && fix) {
    hints.greenToPositionM = Math.round(distanceMeters(
      contribution.green.lat,
      contribution.green.lon,
      fix.lat,
      fix.lon,
    ));
  }
  if (fix && finiteNumber(fix.accuracyM)) {
    hints.positionAccuracyM = fix.accuracyM;
    hints.poorFix = fix.accuracyM > POOR_FIX_ACCURACY_M;
  }
  if (contribution.tee && Number.isInteger(contribution.par)) {
    const meters = distanceMeters(
      contribution.green.lat,
      contribution.green.lon,
      contribution.tee.lat,
      contribution.tee.lon,
    );
    hints.greenToTeeM = Math.round(meters);
    const band = PAR_LENGTH_YARDS[contribution.par];
    const yards = meters / METERS_PER_YARD;
    hints.plausibleForPar = Boolean(band) && yards >= band[0] && yards <= band[1];
  }
  return hints;
}

/** Client fields only. Server fields are added after this accepts the body. */
function parseCourseReport(payload) {
  if (!isPlainObject(payload)) return invalidField("body");
  if (!validClientReportId(payload.clientReportId)) return invalidField("clientReportId");
  if (!isIsoDateTime(payload.createdAt)) return invalidField("createdAt");
  if (typeof payload.courseId !== "string" || payload.courseId.length < 1 || payload.courseId.length > 180) {
    return invalidField("courseId");
  }
  if (typeof payload.courseName !== "string") return invalidField("courseName");
  const courseName = payload.courseName.trim();
  if (courseName.length < 1 || courseName.length > 200) return invalidField("courseName");
  if (!Number.isInteger(payload.holeNumber) || payload.holeNumber < 1 || payload.holeNumber > 18) {
    return invalidField("holeNumber");
  }
  if (!Array.isArray(payload.reasons)) return invalidField("reasons");
  const reasons = [];
  const seen = new Set();
  for (const item of payload.reasons) {
    if (typeof item !== "string" || !COURSE_REPORT_REASONS.has(item) || seen.has(item)) continue;
    seen.add(item);
    reasons.push(item);
  }
  if (reasons.length === 0) return invalidField("reasons");

  const record = {
    clientReportId: payload.clientReportId,
    createdAt: payload.createdAt,
    courseId: payload.courseId,
    courseName,
    holeNumber: payload.holeNumber,
    reasons,
  };

  if (Object.prototype.hasOwnProperty.call(payload, "note") && payload.note != null) {
    if (typeof payload.note !== "string") return invalidField("note");
    const note = payload.note.trim();
    if (note.length > 500) return invalidField("note");
    record.note = note;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "position")) {
    if (payload.position == null) {
      record.position = null;
    } else if (!isPlainObject(payload.position)) {
      return invalidField("position");
    } else {
      const point = parseLatLon(payload.position);
      if (!point) return invalidField("position");
      let accuracyM = null;
      if (Object.prototype.hasOwnProperty.call(payload.position, "accuracyM") && payload.position.accuracyM != null) {
        if (!finiteNumber(payload.position.accuracyM) || payload.position.accuracyM < 0) return invalidField("position");
        accuracyM = payload.position.accuracyM;
      }
      record.position = { lat: point.lat, lon: point.lon, accuracyM };
    }
  }

  for (const field of ["appVersion", "buildNumber", "platform"]) {
    const parsed = readOptionalString(payload, field, 32);
    if (!parsed.ok) return invalidField(field);
    if (parsed.present) record[field] = parsed.value;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "paintSource")) {
    if (payload.paintSource == null) {
      record.paintSource = null;
    } else if (typeof payload.paintSource !== "string") {
      return invalidField("paintSource");
    } else {
      const paintSource = payload.paintSource.trim().toLowerCase();
      if (paintSource.length > 32) return invalidField("paintSource");
      record.paintSource = paintSource;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "shown")) {
    record.shown = normalizeShown(payload.shown);
  }

  const contribution = parseHoleContribution(payload, reasons);
  if (!contribution.ok) return contribution;
  if (contribution.present) {
    contribution.contribution.hints = contributionHints(contribution.contribution, record.position);
    record.contribution = contribution.contribution;
    record.review = {
      status: "pending",
      reviewedAt: null,
      note: null,
      usedAt: null,
      rewardedAt: null,
    };
  }

  return { ok: true, record, contributorEmail: contribution.contributorEmail };
}

function readCourseReportInstallId(request) {
  const raw = request.headers.get("X-Install-Id");
  if (typeof raw !== "string") return { ok: true, id: null };
  const id = raw.trim();
  if (!id) return { ok: true, id: null };
  if (id.length > 100) return { ok: false };
  return { ok: true, id };
}

function readRequestCountry(request) {
  const cf = request && request.cf;
  if (!cf || typeof cf !== "object") return null;
  const country = cf.country;
  if (typeof country !== "string") return null;
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}

async function timingSafeEqualText(left, right) {
  const enc = new TextEncoder();
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(left))),
    crypto.subtle.digest("SHA-256", enc.encode(String(right))),
  ]);
  const a = new Uint8Array(aBuf);
  const b = new Uint8Array(bBuf);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function courseReportsAdminToken(env) {
  if (!env || typeof env.COURSE_REPORTS_ADMIN_TOKEN !== "string") return "";
  return env.COURSE_REPORTS_ADMIN_TOKEN.trim();
}

async function authorizeCourseReports(request, env, cors) {
  const secret = courseReportsAdminToken(env);
  if (!secret) return golfJson(503, { error: "not_configured" }, cors);
  const header = request.headers.get("Authorization");
  const match = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  const presented = match ? match[1] : "";
  const matches = await timingSafeEqualText(secret, presented);
  if (!match || !matches) return golfJson(401, { error: "unauthorized" }, cors);
  return null;
}

function boardsBinding(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return null;
  return boards;
}

function courseReportMarkerKey(clientReportId) {
  return `cr:id:${clientReportId}`;
}

function courseReportEmailKey(clientReportId) {
  return `cr:email:${clientReportId}`;
}

/** True when createdAt is still inside the 365-day address window. */
function contributionEmailWithinCap(createdAt, now) {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  return now.getTime() - createdMs < COURSE_REPORT_EMAIL_TTL * 1000;
}

function courseReportRecordKey(receivedAt, clientReportId) {
  return `cr:r:${receivedAt}:${clientReportId}`;
}

async function readCourseReportCount(boards, key) {
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return 0;
  return clampCount(raw);
}

function courseReportCounterTtl(now) {
  return Math.max(60, retryAfterFor("course_report", now));
}

/**
 * Duplicates are decided before this runs, so a replay does not consume a slot.
 * KV increments are not atomic; a burst can overshoot by a little.
 */
async function courseReportRateLimit(boards, env, request, installId, now, cors) {
  const limits = readCourseReportLimits(env);
  const day = now.toISOString().slice(0, 10);
  const ipHash = await readIpHash(request);
  const ipKey = ipHash ? `cr:n:ip:${ipHash}:${day}` : null;
  const devKey = installId ? `cr:n:dev:${installId}:${day}` : null;
  const ipCount = ipKey ? await readCourseReportCount(boards, ipKey) : 0;
  const devCount = devKey ? await readCourseReportCount(boards, devKey) : 0;
  if ((ipKey && ipCount >= limits.ipDay) || (devKey && devCount >= limits.deviceDay)) {
    const retryAfter = String(retryAfterFor("course_report", now));
    return {
      limited: true,
      response: golfJson(429, { error: "rate_limited" }, cors, { "Retry-After": retryAfter }),
    };
  }
  return {
    limited: false,
    async commit() {
      const ttl = courseReportCounterTtl(now);
      if (ipKey) await putCounter(boards, ipKey, String(ipCount + 1), { expirationTtl: ttl });
      if (devKey) await putCounter(boards, devKey, String(devCount + 1), { expirationTtl: ttl });
    },
  };
}

function readReportLimit(raw) {
  if (raw == null || raw === "") return 100;
  if (!/^\d+$/.test(raw)) return 100;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 100;
  return Math.min(500, parsed);
}

function canonicalSince(raw) {
  if (raw == null || raw === "") return { ok: true, iso: null };
  if (!isIsoDateTime(raw)) return { ok: false };
  return { ok: true, iso: new Date(Date.parse(raw)).toISOString() };
}

function parseStoredReport(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readKnownFilter(raw, allowed) {
  if (raw == null || raw === "") return { ok: true, value: null };
  if (!allowed.has(raw)) return { ok: false };
  return { ok: true, value: raw };
}

function reportMatchesFilters(record, { courseId, reason, status }) {
  if (courseId && record.courseId !== courseId) return false;
  if (reason && !(Array.isArray(record.reasons) && record.reasons.includes(reason))) return false;
  if (status && !(isPlainObject(record.review) && record.review.status === status)) return false;
  return true;
}

async function listCourseReports(boards, { sinceIso, courseId, reason, status, limit, cursor }) {
  let pageCursor = cursor || undefined;
  for (let hop = 0; hop < 20; hop++) {
    const page = await boards.list({
      prefix: "cr:r:",
      limit,
      ...(pageCursor ? { cursor: pageCursor } : {}),
    });
    const keys = (page && Array.isArray(page.keys) ? page.keys : [])
      .map((entry) => (entry && typeof entry.name === "string" ? entry.name : null))
      .filter(Boolean)
      .sort();
    const complete = !page || page.list_complete !== false || !page.cursor;
    const last = keys[keys.length - 1];
    if (sinceIso && last && last < `cr:r:${sinceIso}` && !complete) {
      pageCursor = page.cursor;
      continue;
    }
    const reports = [];
    for (const name of keys) {
      if (sinceIso && name < `cr:r:${sinceIso}`) continue;
      const record = parseStoredReport(await boards.get(name));
      if (!record) continue;
      if (!reportMatchesFilters(record, { courseId, reason, status })) continue;
      reports.push(record);
    }
    // KV is asked for `limit` keys, so this cap only matters if a page is larger.
    const capped = reports.slice(0, limit);
    return { reports: capped, cursor: complete ? null : (page.cursor || null) };
  }
  return { reports: [], cursor: pageCursor || null };
}

async function readCourseReportPayload(request, cors) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > COURSE_REPORT_BODY_MAX) {
    return { ok: false, response: golfJson(413, { error: "too_large" }, cors) };
  }
  const raw = await request.text();
  if (utf8ByteLength(raw) > COURSE_REPORT_BODY_MAX) {
    return { ok: false, response: golfJson(413, { error: "too_large" }, cors) };
  }
  try {
    return { ok: true, payload: JSON.parse(raw) };
  } catch {
    return { ok: false, response: golfJson(400, { error: "invalid_json" }, cors) };
  }
}

async function handleCourseReportPost(request, env, cors) {
  const body = await readCourseReportPayload(request, cors);
  if (!body.ok) return body.response;
  const payload = body.payload;
  const parsed = parseCourseReport(payload);
  if (!parsed.ok) return golfJson(422, { error: "invalid", field: parsed.field }, cors);
  const install = readCourseReportInstallId(request);
  if (!install.ok) return golfJson(422, { error: "invalid", field: "installId" }, cors);

  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);

  const clientReportId = parsed.record.clientReportId;
  const markerKey = courseReportMarkerKey(clientReportId);
  const existing = await boards.get(markerKey);
  if (existing != null) {
    return golfJson(200, { ok: true, id: clientReportId, duplicate: true }, cors);
  }

  const now = new Date();
  const rate = await courseReportRateLimit(boards, env, request, install.id, now, cors);
  if (rate.limited) return rate.response;

  const receivedAt = now.toISOString();
  const recordKey = courseReportRecordKey(receivedAt, clientReportId);
  const record = {
    ...parsed.record,
    receivedAt,
    installId: install.id,
  };
  const country = readRequestCountry(request);
  if (country) record.country = country;
  await boards.put(recordKey, JSON.stringify(record), { expirationTtl: COURSE_REPORT_TTL });
  await boards.put(markerKey, recordKey, { expirationTtl: COURSE_REPORT_TTL });
  if (parsed.contributorEmail && contributionEmailWithinCap(record.createdAt, now)) {
    await boards.put(courseReportEmailKey(clientReportId), parsed.contributorEmail, {
      expirationTtl: COURSE_REPORT_EMAIL_TTL,
    });
  }
  await rate.commit();
  return golfJson(201, { ok: true, id: clientReportId }, cors);
}

async function readContributionEmail(boards, clientReportId) {
  const raw = await boards.get(courseReportEmailKey(clientReportId));
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  if (!email || email.length > 254 || !COURSE_REPORT_EMAIL_RE.test(email)) return null;
  return email;
}

async function deleteContributionEmail(boards, clientReportId) {
  if (!boards || typeof boards.delete !== "function") return;
  await boards.delete(courseReportEmailKey(clientReportId));
}

/**
 * Admin reads see the address only while its KV key still exists. The stored
 * report never holds it. hadEmail stays after the key is deleted or expires.
 */
async function presentCourseReport(boards, record) {
  if (!isPlainObject(record) || !isPlainObject(record.contribution)) return record;
  const contribution = { ...record.contribution };
  delete contribution.contributorEmail;
  if (contribution.hadEmail === true) {
    const email = await readContributionEmail(boards, record.clientReportId);
    if (email) contribution.contributorEmail = email;
  }
  return { ...record, contribution };
}

async function loadCourseReport(boards, clientReportId) {
  const marker = await boards.get(courseReportMarkerKey(clientReportId));
  if (typeof marker !== "string" || !marker.startsWith("cr:r:")) return null;
  const record = parseStoredReport(await boards.get(marker));
  if (!record) return null;
  return { key: marker, record };
}

async function handleCourseReportGetOne(boards, clientReportId, cors) {
  const loaded = await loadCourseReport(boards, clientReportId);
  if (!loaded) return golfJson(404, { error: "not_found" }, cors);
  return golfJson(200, await presentCourseReport(boards, loaded.record), cors);
}

async function handleCourseReportsGet(request, url, env, cors, clientReportId) {
  const denied = await authorizeCourseReports(request, env, cors);
  if (denied) return denied;
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  if (clientReportId) return handleCourseReportGetOne(boards, clientReportId, cors);
  if (typeof boards.list !== "function") return golfJson(503, { error: "boards_not_configured" }, cors);

  const since = canonicalSince(url.searchParams.get("since"));
  if (!since.ok) return golfJson(422, { error: "invalid", field: "since" }, cors);
  const reason = readKnownFilter(url.searchParams.get("reason"), COURSE_REPORT_REASONS);
  if (!reason.ok) return golfJson(422, { error: "invalid", field: "reason" }, cors);
  const status = readKnownFilter(url.searchParams.get("status"), REVIEW_STATUSES);
  if (!status.ok) return golfJson(422, { error: "invalid", field: "status" }, cors);
  const courseId = url.searchParams.get("courseId");
  const listed = await listCourseReports(boards, {
    sinceIso: since.iso,
    courseId: courseId ? courseId : null,
    reason: reason.value,
    status: status.value,
    limit: readReportLimit(url.searchParams.get("limit")),
    cursor: url.searchParams.get("cursor"),
  });
  const reports = [];
  for (const record of listed.reports) reports.push(await presentCourseReport(boards, record));
  return golfJson(200, { reports, cursor: listed.cursor }, cors);
}

function decodeCourseReportId(raw) {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return validClientReportId(id) ? id : null;
}

function courseReportRoute(pathname) {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/v1/course-reports") return { ok: true, id: null, action: null };
  const rest = path.slice("/v1/course-reports/".length);
  if (!rest) return { ok: false };
  const parts = rest.split("/");
  if (parts.length === 1) {
    const id = decodeCourseReportId(parts[0]);
    if (!id) return { ok: false };
    return { ok: true, id, action: null };
  }
  if (parts.length === 2 && parts[1] === "review") {
    const id = decodeCourseReportId(parts[0]);
    if (!id) return { ok: false };
    return { ok: true, id, action: "review" };
  }
  return { ok: false };
}

function parseCourseReportReview(payload) {
  if (!isPlainObject(payload)) return invalidField("body");
  if (typeof payload.status !== "string" || !REVIEW_DECISIONS.has(payload.status)) {
    return invalidField("status");
  }
  const decision = { ok: true, status: payload.status, noteSet: false, note: null };
  if (!Object.prototype.hasOwnProperty.call(payload, "note")) return decision;
  if (payload.note == null) {
    decision.noteSet = true;
    return decision;
  }
  if (typeof payload.note !== "string") return invalidField("note");
  const note = payload.note.trim();
  if (note.length > 500) return invalidField("note");
  decision.noteSet = true;
  decision.note = note.length ? note : null;
  return decision;
}

function reviewTransitionAllowed(current, next) {
  if (current === "pending") return next === "approved" || next === "rejected";
  if (current === "approved") return next === "used";
  if (current === "used") return next === "rewarded";
  return false;
}

function dropStoredContributorEmail(record) {
  if (!isPlainObject(record.contribution)) return;
  if (typeof record.contribution.contributorEmail === "string" && record.contribution.contributorEmail) {
    record.contribution.hadEmail = true;
  }
  delete record.contribution.contributorEmail;
}

/**
 * Records the review decision on the existing cr:r: row. rewardEligible is
 * set by the handler only when status becomes used and the email key exists.
 * rejected and rewarded remove any address from this row. This does not call
 * a billing or subscription API.
 */
function applyCourseReportReview(record, decision, nowIso) {
  const previous = isPlainObject(record.review) ? record.review : {};
  const review = {
    status: decision.status,
    reviewedAt: previous.reviewedAt ?? null,
    note: previous.note ?? null,
    usedAt: previous.usedAt ?? null,
    rewardedAt: previous.rewardedAt ?? null,
  };
  if (decision.status === "approved" || decision.status === "rejected") {
    review.reviewedAt = nowIso;
  }
  if (decision.status === "used") review.usedAt = nowIso;
  if (decision.status === "rewarded") review.rewardedAt = nowIso;
  if (decision.noteSet) review.note = decision.note;
  record.review = review;
  if (decision.status === "rejected" || decision.status === "rewarded") {
    dropStoredContributorEmail(record);
  }
  return record;
}

async function handleCourseReportReview(request, env, cors, clientReportId) {
  const denied = await authorizeCourseReports(request, env, cors);
  if (denied) return denied;
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  const body = await readCourseReportPayload(request, cors);
  if (!body.ok) return body.response;
  const decision = parseCourseReportReview(body.payload);
  if (!decision.ok) return golfJson(422, { error: "invalid", field: decision.field }, cors);

  const loaded = await loadCourseReport(boards, clientReportId);
  if (!loaded) return golfJson(404, { error: "not_found" }, cors);
  const current = isPlainObject(loaded.record.review) ? loaded.record.review.status : null;
  if (!reviewTransitionAllowed(current, decision.status)) {
    return golfJson(409, { error: "invalid_transition" }, cors);
  }

  const nowIso = new Date().toISOString();
  const emailOnFile = decision.status === "used"
    ? await readContributionEmail(boards, clientReportId)
    : null;
  const record = applyCourseReportReview(loaded.record, decision, nowIso);
  if (decision.status === "used" && emailOnFile) record.rewardEligible = true;
  await boards.put(loaded.key, JSON.stringify(record), { expirationTtl: COURSE_REPORT_TTL });
  if (decision.status === "rejected" || decision.status === "rewarded") {
    await deleteContributionEmail(boards, clientReportId);
  }
  return golfJson(200, await presentCourseReport(boards, record), cors);
}

async function handleCourseReports(request, url, env, cors) {
  const parsed = courseReportRoute(url.pathname);
  if (!parsed.ok) return golfJson(404, { error: "unknown_route" }, cors);
  if (request.method === "GET") {
    if (parsed.action) return golfJson(405, { error: "method_not_allowed" }, cors);
    return handleCourseReportsGet(request, url, env, cors, parsed.id);
  }
  if (request.method === "POST" && parsed.action === "review") {
    return handleCourseReportReview(request, env, cors, parsed.id);
  }
  if (request.method === "POST" && parsed.id == null) return handleCourseReportPost(request, env, cors);
  return golfJson(405, { error: "method_not_allowed" }, cors);
}

function corsHeaders(pathname) {
  const courseReports = isCourseReportPath(pathname);
  const headers = {
    "Access-Control-Allow-Methods": courseReports ? "GET,POST,OPTIONS" : "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": courseReports
      ? "Content-Type, X-Install-Id, Authorization"
      : "Content-Type, X-Install-Id",
  };
  if (!pathname.startsWith("/gca/") && !pathname.startsWith("/golfapi/")) {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const cors = corsHeaders(requestUrl.pathname);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (requestUrl.pathname === "/meta/golfapi") {
      return handleGolfapiMeta(request, env, cors);
    }
    if (requestUrl.pathname === "/meta/gca") {
      return handleGcaMeta(request, env, cors);
    }

    const golf = await handleGolfProxy(request, env, ctx, cors);
    if (golf) return responseWithoutAllowOrigin(golf);

    const osm = await handleOsmOverlay(request, env, ctx, cors);
    if (osm) return osm;

    // Live board web page (GET /s/{code}). Only a real board code is read: never a reserved
    // key and never a paint key, so the page cannot show overlay, course-store, GCA, golfapi,
    // queue, paint-cache, or course-report data.
    const page = await handleLivePage(request, env, {
      loadBoard: (code) => {
        if (!isLiveBoardCode(code) || isReservedBoardKey(code) || isPaintKey(code)) return null;
        const boards = env && env.BOARDS;
        return boards && typeof boards.get === "function" ? boards.get(code) : null;
      },
    });
    if (page) return page;

    // /v1/course-reports before the board-key catch-all. The first segment of
    // /v1/... would otherwise be a KV key named "v1" (POST 405, GET reads that board).
    if (isCourseReportPath(requestUrl.pathname)) {
      return handleCourseReports(request, requestUrl, env, cors);
    }
    if (requestUrl.pathname.startsWith("/v1/")) {
      return golfJson(404, { error: "unknown_route" }, cors);
    }

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] || "");
    if (!key || key.length > 180) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    // Overlay, golfapi counters, the course store, GCA copies, the refill queue, and
    // course reports share BOARDS. Public board routes must not read, replace, or delete those keys.
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && isReservedBoardKey(key)) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    const isPaint = isPaintKey(key);
    const ttl = isPaint ? 60 * 60 * 24 * 365 : 60 * 60 * 24 * 7;
    // Unbound BOARDS throws and Cloudflare turns that into error 1101.
    // Golf and OSM routes already returned above, so this only covers board keys.
    if (request.method === "GET" || request.method === "PUT") {
      const boards = env && env.BOARDS;
      if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
        return golfJson(503, { error: "boards_not_configured" }, cors);
      }
    }
    if (request.method === "GET") {
      const val = await env.BOARDS.get(key);
      if (!val) return new Response("{}", { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      const body = isPaint ? await paintGetBody(env.BOARDS, key, val) : val;
      return new Response(body, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      if (!body || body.length > 20000) {
        return new Response("bad body", { status: 400, headers: cors });
      }
      if (isPaint) return putPaintRecord(env.BOARDS, key, body, ttl, request, cors);
      await env.BOARDS.put(key, body, { expirationTtl: ttl });
      return new Response(body, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("no", { status: 405, headers: cors });
  },

  async scheduled(_event, env, _ctx) {
    await drainGolfapiQueue(env || {});
  },
};
