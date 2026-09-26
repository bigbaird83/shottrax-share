/**
 * Golf vendor proxy, inlined from ShotTraxx worker-golf-proxy.js.
 * Runs before board-key parsing so /gca/... and /golfapi/... are never stored
 * as live-board codes. The phone sends no vendor key; secrets stay on this Worker.
 *
 *   GET /gca/v1/courses[/{id}[/green-centers]]  → golfcoursesapi.com/api/v1/
 *   GET /golfapi/v2.3/courses[/{id}]            → golfapi.io/api/v2.3/
 *   GET /golfapi/v2.3/coordinates/{id}          → golfapi.io/api/v2.3/
 *
 * OSM overlay proxy also runs before board-key parsing. The Worker builds the
 * Overpass query itself (clients never send Overpass QL):
 *
 *   GET /osm/v1/overlay?courseId&lat&lng&radius
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

  // Negative marker only when there is no positive copy. It answers 404 for this
  // exact location only and is never indexed for nearby reuse.
  if ((await boards.get(noneKey)) != null) return { kind: "empty", cacheState: "HIT" };

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
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
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
    // Overlay cache lives in BOARDS under osm: keys. Boards must not read or replace those.
    if ((request.method === "GET" || request.method === "PUT") && key.startsWith("osm:")) {
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
};
