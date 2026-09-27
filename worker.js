/**
 * Golf vendor proxy, inlined from ShotTraxx worker-golf-proxy.js.
 * Runs before board-key parsing so /gca/... and /golfapi/... are never stored
 * as live-board codes. The phone sends no vendor key; secrets stay on this Worker.
 *
 *   GET /gca/v1/courses[/{id}[/green-centers]]  → golfcoursesapi.com/api/v1/
 *   GET /golfapi/v2.3/courses?q=                → golfapi.io/api/v2.3/  (search)
 *   GET /golfapi/v2.3/courses/{id}              → golfapi.io/api/v2.3/
 *   GET /golfapi/v2.3/coordinates/{id}          → golfapi.io/api/v2.3/
 *   GET /meta/golfapi                           → quota snapshot, no secrets
 *
 * Any other /golfapi/ path is 404. The API key is the GOLFAPI_KEY secret only.
 *
 * OSM overlay proxy also runs before board-key parsing. The Worker builds the
 * Overpass query itself (clients never send Overpass QL):
 *
 *   GET /osm/v1/overlay?courseId&lat&lng&radius
 *
 * Golfapi quota (paid golfapi.io). GCA and OSM are not on this budget.
 * Periods are UTC: day YYYY-MM-DD, week ISO (YYYY-Www), month YYYY-MM.
 *
 * One lookup is the first fresh upstream fetch of courses/{id} or
 * coordinates/{id} for a course id by that device or IP within 24h, so the
 * pair counts once. Anything served from the edge cache or the gapi: KV store
 * is free and is not a lookup. Searches (courses?q=) use a separate daily
 * budget and do not spend lookups. A 200 with no course data, or an error
 * body, is not stored and is not edge-cached. A 24h gq:empty: marker stops a
 * retry of that empty answer from calling upstream again.
 *
 * Defaults, overridden by [vars] in wrangler.toml. Non-integers, negatives,
 * and blanks keep the default. IP limits default to twice the device limits
 * (carrier NAT) unless their own var is set.
 *
 *   GOLFAPI_DEVICE_DAY=3     GOLFAPI_DEVICE_WEEK=10    GOLFAPI_DEVICE_MONTH=20
 *   GOLFAPI_IP_DAY           GOLFAPI_IP_WEEK           GOLFAPI_IP_MONTH
 *   GOLFAPI_GLOBAL_DAY=40
 *   GOLFAPI_FLOOR=10         block fresh upstream calls when known balance <= this
 *   GOLFAPI_SEARCH_DEVICE_DAY=10
 *   GOLFAPI_SEARCH_IP_DAY    defaults to 2x the device search limit (20)
 *   GOLFAPI_SEARCH_GLOBAL_DAY=60
 *
 * Identity: header X-Install-Id (8–64 chars of [A-Za-z0-9-], else ignored)
 * and CF-Connecting-IP. Both are enforced when present; the install id is
 * spoofable. IPs are stored only as SHA-256 with a fixed prefix, never raw.
 *
 * Over a limit the phone gets 429 {error:"golfapi_limited", reason, queued,
 * retryAfterSec} and Retry-After. The app already falls back to free + GCA
 * data on non-2xx. Course ids are queued (gqueue:, deduped) and the daily
 * cron fills gapi: while under the global cap and above the floor.
 *
 * Counters live in the BOARDS namespace under gq: (stats, balance, per-device
 * and per-IP buckets). KV writes are not atomic, and the same key accepts
 * about one write per second, so a burst can overshoot by 1–2. The global
 * daily cap and the balance floor are the backstop. A Durable Object could
 * make this exact later. Public GET/PUT/DELETE cannot read or write gq:,
 * gapi:, gqueue:, or osm: keys.
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
/** Durable courses/{id} and coordinates/{id} bodies. Same horizon as the paint cache. */
const GOLFAPI_STORE_TTL = 60 * 60 * 24 * 365;
/** Device/IP buckets cover a month plus a little, so a late read still sees that month. */
const GOLFAPI_BUCKET_TTL = 60 * 60 * 24 * 32;
/** Daily stats stay readable for the 30-day meta window. */
const GOLFAPI_STATS_TTL = 60 * 60 * 24 * 40;
/** A queued course that nobody refills expires instead of sitting forever. */
const GOLFAPI_QUEUE_TTL = 60 * 60 * 24 * 14;
const GOLFAPI_SEEN_MS = 60 * 60 * 24 * 1000;
const GOLFAPI_GIVE_UP = 5;
const GOLFAPI_IP_PREFIX = "shottrax-golfapi-ip-v1:";
const GOLFAPI_BALANCE_KEY = "gq:balance";
const RESERVED_BOARD_PREFIXES = ["osm:", "gq:", "gapi:", "gqueue:"];
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
  "search_ip_day",
  "search_global_day",
];

function isReservedBoardKey(key) {
  return RESERVED_BOARD_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function readConfigInt(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed <= 1_000_000) return parsed;
  }
  return null;
}

function readGolfapiLimits(env) {
  const source = env || {};
  const deviceDay = readConfigInt(source.GOLFAPI_DEVICE_DAY) ?? 3;
  const deviceWeek = readConfigInt(source.GOLFAPI_DEVICE_WEEK) ?? 10;
  const deviceMonth = readConfigInt(source.GOLFAPI_DEVICE_MONTH) ?? 20;
  const searchDeviceDay = readConfigInt(source.GOLFAPI_SEARCH_DEVICE_DAY) ?? 10;
  return {
    deviceDay,
    deviceWeek,
    deviceMonth,
    ipDay: readConfigInt(source.GOLFAPI_IP_DAY) ?? deviceDay * 2,
    ipWeek: readConfigInt(source.GOLFAPI_IP_WEEK) ?? deviceWeek * 2,
    ipMonth: readConfigInt(source.GOLFAPI_IP_MONTH) ?? deviceMonth * 2,
    globalDay: readConfigInt(source.GOLFAPI_GLOBAL_DAY) ?? 40,
    floor: readConfigInt(source.GOLFAPI_FLOOR) ?? 10,
    searchDeviceDay,
    searchIpDay: readConfigInt(source.GOLFAPI_SEARCH_IP_DAY) ?? searchDeviceDay * 2,
    searchGlobalDay: readConfigInt(source.GOLFAPI_SEARCH_GLOBAL_DAY) ?? 60,
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
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  return id;
}

async function hashClientIp(ip) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(GOLFAPI_IP_PREFIX + ip),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function parseGolfapiRest(rest, url) {
  if (rest === "courses") {
    const q = url.searchParams.get("q");
    if (typeof q !== "string" || q.trim() === "") return null;
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

function blankStats() {
  return { lookups: 0, searches: 0, hits: 0, blocked: {} };
}

async function readStats(boards, key) {
  const stats = blankStats();
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return stats;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return stats;
    stats.lookups = clampCount(parsed.lookups);
    stats.searches = clampCount(parsed.searches);
    stats.hits = clampCount(parsed.hits);
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
  return {
    date,
    lookups: clampCount(stats && stats.lookups),
    searches: clampCount(stats && stats.searches),
    hits: clampCount(stats && stats.hits),
    blocked,
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
    seen: {},
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
  const cutoff = now.getTime() - GOLFAPI_SEEN_MS;
  if (isPlainObject(parsed.seen)) {
    for (const [id, at] of Object.entries(parsed.seen)) {
      if (!safeGolfapiId(id) || typeof at !== "number" || at < cutoff) continue;
      bucket.seen[id] = at;
    }
  }
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

function rememberSeen(bucket, courseId, nowMs) {
  bucket.seen[courseId] = nowMs;
  const entries = Object.entries(bucket.seen);
  if (entries.length <= 64) return;
  entries.sort((left, right) => left[1] - right[1]);
  bucket.seen = Object.fromEntries(entries.slice(entries.length - 64));
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

function publicBalance(balance) {
  if (!balance) return null;
  return {
    left: typeof balance.left === "number" ? balance.left : null,
    at: balance.at,
    lastStatus: balance.lastStatus,
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

async function rejectLimited(boards, day, reason, queued, courseId, cors, now) {
  await bumpStats(boards, day, (stats) => {
    stats.blocked[reason] = clampCount(stats.blocked[reason]) + 1;
  });
  if (queued && courseId) await enqueueCourse(boards, courseId);
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
    };
  } catch {
    return { configured: true, thrown: true };
  }
}

async function chargeLookup(boards, periods, devKey, dev, ipKey, ip, chargeDevice, chargeIp, chargeGlobal, definitive, courseId, nowMs) {
  if (chargeDevice && dev) {
    dev.dayCount += 1;
    dev.weekCount += 1;
    dev.monthCount += 1;
    if (definitive) rememberSeen(dev, courseId, nowMs);
    await saveBucket(boards, devKey, dev);
  }
  if (chargeIp && ip) {
    ip.dayCount += 1;
    ip.weekCount += 1;
    ip.monthCount += 1;
    if (definitive) rememberSeen(ip, courseId, nowMs);
    await saveBucket(boards, ipKey, ip);
  }
  if (chargeGlobal) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.lookups += 1;
    });
  }
}

async function handleGolfapiSearch({ url, env, ctx, cors, boards, now, periods, limits, installId, ipHash }) {
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached && cached.status >= 200 && cached.status < 300) {
      await bumpStats(boards, periods.day, (stats) => {
        stats.hits += 1;
      });
      return cached;
    }
  }

  const devKey = installId ? `gq:dev:${installId}` : null;
  const ipKey = ipHash ? `gq:ip:${ipHash}` : null;
  const dev = devKey ? await loadBucket(boards, devKey, now) : null;
  const ip = ipKey ? await loadBucket(boards, ipKey, now) : null;
  const balance = await readBalance(boards);
  if (balanceBlocks(balance, limits.floor)) {
    return rejectLimited(boards, periods.day, "floor", false, null, cors, now);
  }
  const stats = await readStats(boards, `gq:stats:${periods.day}`);
  if (stats.searches >= limits.searchGlobalDay) {
    return rejectLimited(boards, periods.day, "search_global_day", false, null, cors, now);
  }
  if (dev && dev.searchCount >= limits.searchDeviceDay) {
    return rejectLimited(boards, periods.day, "search_device_day", false, null, cors, now);
  }
  if (ip && ip.searchCount >= limits.searchIpDay) {
    return rejectLimited(boards, periods.day, "search_ip_day", false, null, cors, now);
  }

  const upstream = await fetchGolfapiUpstream(env, `courses${url.search}`);
  if (!upstream.configured) return golfJson(503, { error: "not_configured" }, cors);
  if (upstream.thrown) return golfJson(502, { error: "upstream_unreachable" }, cors);

  const classified = classifyGolfapi("search", upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  if (dev) {
    dev.searchCount += 1;
    await saveBucket(boards, devKey, dev);
  }
  if (ip) {
    ip.searchCount += 1;
    await saveBucket(boards, ipKey, ip);
  }
  await bumpStats(boards, periods.day, (statsNow) => {
    statsNow.searches += 1;
  });

  const cacheable = upstream.status >= 200 && upstream.status < 300;
  const response = upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, cacheable);
  if (cacheable) await rememberGolfEdge(cache, ctx, cacheKey, response);
  return response;
}

async function handleGolfapiLookup({ kind, id, url, env, ctx, cors, boards, now, periods, limits, installId, ipHash }) {
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

  const devKey = installId ? `gq:dev:${installId}` : null;
  const ipKey = ipHash ? `gq:ip:${ipHash}` : null;
  const dev = devKey ? await loadBucket(boards, devKey, now) : null;
  const ip = ipKey ? await loadBucket(boards, ipKey, now) : null;
  const deviceSeen = Boolean(dev && typeof dev.seen[id] === "number");
  const ipSeen = Boolean(ip && typeof ip.seen[id] === "number");
  const chargeDevice = Boolean(dev) && !deviceSeen;
  const chargeIp = Boolean(ip) && !ipSeen;
  const chargeGlobal = chargeDevice || chargeIp || (!dev && !ip);

  const balance = await readBalance(boards);
  if (balanceBlocks(balance, limits.floor)) {
    return rejectLimited(boards, periods.day, "floor", true, id, cors, now);
  }
  if (chargeGlobal) {
    const stats = await readStats(boards, `gq:stats:${periods.day}`);
    if (stats.lookups >= limits.globalDay) {
      return rejectLimited(boards, periods.day, "global_day", true, id, cors, now);
    }
  }
  if (chargeDevice) {
    if (dev.dayCount >= limits.deviceDay) return rejectLimited(boards, periods.day, "device_day", true, id, cors, now);
    if (dev.weekCount >= limits.deviceWeek) return rejectLimited(boards, periods.day, "device_week", true, id, cors, now);
    if (dev.monthCount >= limits.deviceMonth) return rejectLimited(boards, periods.day, "device_month", true, id, cors, now);
  }
  if (chargeIp) {
    if (ip.dayCount >= limits.ipDay) return rejectLimited(boards, periods.day, "ip_day", true, id, cors, now);
    if (ip.weekCount >= limits.ipWeek) return rejectLimited(boards, periods.day, "ip_week", true, id, cors, now);
    if (ip.monthCount >= limits.ipMonth) return rejectLimited(boards, periods.day, "ip_month", true, id, cors, now);
  }

  const stem = kind === "course" ? "courses" : "coordinates";
  const upstream = await fetchGolfapiUpstream(env, `${stem}/${id}${url.search}`);
  if (!upstream.configured) return golfJson(503, { error: "not_configured" }, cors);
  if (upstream.thrown) return golfJson(502, { error: "upstream_unreachable" }, cors);

  const classified = classifyGolfapi(kind, upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  const definitive = classified.outcome === "data" || classified.outcome === "nodata";
  await chargeLookup(
    boards,
    periods,
    devKey,
    dev,
    ipKey,
    ip,
    chargeDevice,
    chargeIp,
    chargeGlobal,
    definitive,
    id,
    now.getTime(),
  );

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
  const shared = {
    url,
    env,
    ctx,
    cors,
    boards,
    now,
    periods: golfapiPeriods(now),
    limits: readGolfapiLimits(env),
    installId: readInstallId(request),
    ipHash: await readIpHash(request),
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
    };
  } catch {
    return { attempts: 0, at: 0 };
  }
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
    const id = safeGolfapiId(name.slice("gqueue:".length));
    if (!id || name !== `gqueue:${id}`) {
      await boards.delete(name);
      continue;
    }
    items.push({ name, id, record: parseQueueRecord(await boards.get(name)) });
  }
  items.sort((left, right) => left.record.at - right.record.at || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const item of items) {
    if (item.record.attempts >= GOLFAPI_GIVE_UP) continue;
    const balance = await readBalance(boards);
    if (balanceBlocks(balance, limits.floor)) break;
    const stats = await readStats(boards, `gq:stats:${periods.day}`);
    if (stats.lookups >= limits.globalDay) break;

    let failed = false;
    let fetched = false;
    const partDone = async (kind, storeKey) => {
      if (typeof (await boards.get(storeKey)) === "string") return true;
      return (await boards.get(emptyMarkerKey(kind, item.id))) != null;
    };
    let courseDone = await partDone("course", courseStoreKey(item.id));
    let coordDone = await partDone("coord", coordStoreKey(item.id));

    const pull = async (kind, path, storeKey) => {
      const upstream = await fetchGolfapiUpstream(env, path);
      if (!upstream.configured || upstream.thrown) {
        failed = true;
        return;
      }
      fetched = true;
      const classified = classifyGolfapi(kind, upstream.status, upstream.text);
      await rememberBalance(boards, upstream.status, classified.payload);
      if (classified.outcome === "error") {
        failed = true;
        return;
      }
      if (classified.outcome === "data") {
        await boards.put(storeKey, upstream.text, { expirationTtl: GOLFAPI_STORE_TTL });
        await boards.delete(emptyMarkerKey(kind, item.id));
        return;
      }
      await boards.put(emptyMarkerKey(kind, item.id), "1", { expirationTtl: GOLF_CACHE_SECONDS });
    };

    if (!courseDone) {
      await pull("course", `courses/${item.id}`, courseStoreKey(item.id));
      if (!failed) courseDone = true;
    }
    if (!failed && !coordDone) {
      if (balanceBlocks(await readBalance(boards), limits.floor)) {
        if (fetched) {
          await bumpStats(boards, periods.day, (row) => {
            row.lookups += 1;
          });
        }
        break;
      }
      await pull("coord", `coordinates/${item.id}`, coordStoreKey(item.id));
      if (!failed) coordDone = true;
    }

    if (fetched) {
      await bumpStats(boards, periods.day, (row) => {
        row.lookups += 1;
      });
    }
    if (failed) {
      const attempts = item.record.attempts + 1;
      await boards.put(item.name, JSON.stringify({ attempts, at: item.record.at || Date.now() }), {
        expirationTtl: GOLFAPI_QUEUE_TTL,
      });
      continue;
    }
    if (courseDone && coordDone) await boards.delete(item.name);
  }
}

async function handleGolfapiMeta(request, env, cors) {
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = new Date();
  const balance = await readBalance(boards);
  const days = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const date = utcDay(now, offset);
    days.push(statsView(date, await readStats(boards, `gq:stats:${date}`)));
  }
  const queue = await listKeys(boards, "gqueue:");
  return golfJson(200, {
    balance: publicBalance(balance),
    today: days[days.length - 1],
    days,
    queueLength: queue.length,
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

/**
 * Response for a golf proxy route, or null so the caller falls through to
 * share-board GET/PUT /{code}.
 */
async function handleGolfProxy(request, env, ctx, cors) {
  const url = new URL(request.url);
  const hit = matchGolfVendor(url.pathname);
  if (!hit) return null;
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  if (hit.rest == null) return golfJson(404, { error: "unknown_route" }, cors);

  const key = typeof env[hit.vendor.secret] === "string" ? env[hit.vendor.secret].trim() : "";
  if (!key) return golfJson(503, { error: "not_configured" }, cors);
  if (hit.vendor.secret === "GOLFAPI_KEY") {
    return handleGolfapi(request, url, hit.rest, env, ctx, cors);
  }

  const upstreamUrl = `${hit.vendor.upstream}${hit.rest}${url.search}`;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    });
  } catch {
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }

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
  if (ok && cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  }
  return response;
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

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Install-Id",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/meta/golfapi") {
      return handleGolfapiMeta(request, env, cors);
    }

    const golf = await handleGolfProxy(request, env, ctx, cors);
    if (golf) return golf;

    const osm = await handleOsmOverlay(request, env, ctx, cors);
    if (osm) return osm;

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] || "");
    if (!key || key.length > 180) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    // Overlay, golfapi counters, the course store, and the refill queue share BOARDS.
    // Public board routes must not read, replace, or delete those keys.
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && isReservedBoardKey(key)) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    const isPaint = key.startsWith("id:") || key.startsWith("name:");
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
      return new Response(val, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      if (!body || body.length > 20000) {
        return new Response("bad body", { status: 400, headers: cors });
      }
      await env.BOARDS.put(key, body, { expirationTtl: ttl });
      return new Response(body, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("no", { status: 405, headers: cors });
  },

  async scheduled(_event, env, _ctx) {
    await drainGolfapiQueue(env || {});
  },
};
