/**
 * Golf vendor proxy, inlined from ShotTraxx worker-golf-proxy.js.
 * Runs before board-key parsing so /gca/... and /golfapi/... are never stored
 * as live-board codes. The phone sends no vendor key; secrets stay on this Worker.
 *
 *   GET /gca/v1/courses[/{id}[/green-centers]]  → golfcoursesapi.com/api/v1/
 *   GET /golfapi/v2.3/courses[/{id}]            → golfapi.io/api/v2.3/
 *   GET /golfapi/v2.3/coordinates/{id}          → golfapi.io/api/v2.3/
 *
 * Plays-like measurements for the shottracker GPS app. Raw data only. The app
 * computes any adjusted yardage. A failed source is null plus a reason; this
 * Worker never invents or estimates a value. Handled before board-key parsing,
 * same as the golf proxy, so /playslike/v1 is never stored as a board code.
 * Coordinates are not logged.
 *
 *   GET /playslike/v1?from=LAT,LNG&to=LAT,LNG   (from = player, to = green)
 *     elevation: USGS EPQS, else Open-Meteo for both points (one dataset)
 *     wind at `to`: Open-Meteo forecast; from_deg is meteorological (wind FROM)
 *     elevation cached 30 days per point; wind cached 10 minutes at 2 decimals
 */

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

function golfJson(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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

const PLAYS_PATH = "/playslike/v1";
const UPSTREAM_TIMEOUT_MS = 2500;
const ELEVATION_CACHE_SECONDS = 60 * 60 * 24 * 30;
const WIND_CACHE_SECONDS = 60 * 10;
const MAX_SEPARATION_YARDS = 1000;
const EARTH_RADIUS_M = 6371000;
const METERS_PER_YARD = 0.9144;
const USGS_NO_DATA = -1000000;
const ELEVATION_FLOOR_M = -500;

/**
 * Raw plays-like lookup, or null so the caller falls through to share boards.
 * Non-GET on this path is 405 and must not reach BOARDS.
 */
async function handlePlaysLike(request, ctx, cors) {
  const url = new URL(request.url);
  if (url.pathname !== PLAYS_PATH) return null;
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);

  const fromRaw = parseLatLng(url.searchParams.get("from"));
  const toRaw = parseLatLng(url.searchParams.get("to"));
  if (!fromRaw || !toRaw) return golfJson(400, { error: "bad_coords" }, cors);
  if (distanceYards(fromRaw, toRaw) > MAX_SEPARATION_YARDS) {
    return golfJson(400, { error: "too_far" }, cors);
  }

  const from = roundPoint(fromRaw, 5);
  const to = roundPoint(toRaw, 5);
  const [elevation, wind] = await Promise.all([lookupElevation(from, to, ctx), lookupWind(to, ctx)]);

  const body = {
    from: { lat: from.lat, lng: from.lng, elevation_m: elevation.from },
    to: { lat: to.lat, lng: to.lng, elevation_m: elevation.to },
    elevation_delta_m: elevation.delta,
    elevation_source: elevation.source,
    wind: wind.value,
  };
  if (elevation.error) body.elevation_error = elevation.error;
  if (wind.error) body.wind_error = wind.error;

  const bothFailed = elevation.source == null && wind.value == null;
  return golfJson(bothFailed ? 502 : 200, body, cors);
}

function parseLatLng(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const lat = parseDecimal(parts[0].trim());
  const lng = parseDecimal(parts[1].trim());
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseDecimal(text) {
  if (typeof text !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function roundTo(n, places) {
  return Number(n.toFixed(places));
}

function roundPoint(point, places) {
  return { lat: roundTo(point.lat, places), lng: roundTo(point.lng, places) };
}

/** Great-circle distance in yards. Incoming coordinates, before rounding. */
function distanceYards(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const meters = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  return meters / METERS_PER_YARD;
}

/**
 * Both points come from one dataset. USGS first; if either point misses,
 * Open-Meteo is used for both so the delta never mixes sources. If neither
 * source covers both points, elevations stay null.
 */
async function lookupElevation(from, to, ctx) {
  const usgs = await pairElevation("usgs", from, to, ctx);
  if (usgs.ok) return elevationOk(usgs.from, usgs.to, "usgs");
  const openMeteo = await pairElevation("open-meteo", from, to, ctx);
  if (openMeteo.ok) return elevationOk(openMeteo.from, openMeteo.to, "open-meteo");
  return {
    from: null,
    to: null,
    delta: null,
    source: null,
    error: `usgs:${usgs.reason};open-meteo:${openMeteo.reason}`,
  };
}

function elevationOk(fromM, toM, source) {
  return { from: fromM, to: toM, delta: elevationDelta(toM, fromM), source, error: null };
}

/** `to` minus `from`. Nine decimals (1 nm) drops IEEE residue and is finer than either source. */
function elevationDelta(toM, fromM) {
  return Number((toM - fromM).toFixed(9));
}

async function pairElevation(source, from, to, ctx) {
  const [a, b] = await Promise.all([pointElevation(source, from, ctx), pointElevation(source, to, ctx)]);
  if (a.value != null && b.value != null) return { ok: true, from: a.value, to: b.value, reason: null };
  const reasons = [];
  if (a.value == null) reasons.push(a.reason || "unavailable");
  if (b.value == null) reasons.push(b.reason || "unavailable");
  return { ok: false, reason: [...new Set(reasons)].join("+") || "unavailable" };
}

async function pointElevation(source, point, ctx) {
  const key = elevationCacheKey(source, point);
  const cached = await cachedJson(key);
  const cachedValue = cached && typeof cached === "object" ? parseElevation(cached.elevation_m) : null;
  if (cachedValue != null) return { value: cachedValue, reason: null };

  const fetched = await fetchElevation(source, point);
  if (fetched.value != null) {
    await storeJson(key, { elevation_m: fetched.value }, ELEVATION_CACHE_SECONDS, ctx);
  }
  return fetched;
}

function elevationCacheKey(source, point) {
  return `https://playslike.invalid/v1/elev/${source}/${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

async function fetchElevation(source, point) {
  const url = source === "usgs" ? usgsUrl(point) : openMeteoElevationUrl(point);
  const got = await fetchJson(url);
  if (!got.ok) return { value: null, reason: got.reason };
  const value = source === "usgs" ? elevationFromUsgs(got.data) : elevationFromOpenMeteo(got.data);
  if (value == null) return { value: null, reason: "no_data" };
  return { value, reason: null };
}

function usgsUrl(point) {
  const url = new URL("https://epqs.nationalmap.gov/v1/json");
  url.searchParams.set("x", String(point.lng));
  url.searchParams.set("y", String(point.lat));
  url.searchParams.set("wkid", "4326");
  url.searchParams.set("units", "Meters");
  url.searchParams.set("includeDate", "false");
  return url.toString();
}

function openMeteoElevationUrl(point) {
  const url = new URL("https://api.open-meteo.com/v1/elevation");
  url.searchParams.set("latitude", String(point.lat));
  url.searchParams.set("longitude", String(point.lng));
  return url.toString();
}

function elevationFromUsgs(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, "value")) {
    return null;
  }
  return parseElevation(data.value);
}

function elevationFromOpenMeteo(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.elevation)) return null;
  return parseElevation(data.elevation[0]);
}

/** Numeric USGS strings are measurements. The -1000000 sentinel and anything below -500 are misses. */
function parseElevation(value) {
  const n = measuredNumber(value);
  if (n == null || n === USGS_NO_DATA || n < ELEVATION_FLOOR_M) return null;
  return n;
}

function measuredNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseDecimal(value.trim());
  return null;
}

async function lookupWind(point, ctx) {
  const key = windCacheKey(point);
  const cached = await cachedJson(key);
  const cachedWind = normalizeWind(cached);
  if (cachedWind) return { value: cachedWind, error: null };

  const got = await fetchJson(openMeteoWindUrl(point));
  if (!got.ok) return { value: null, error: got.reason };
  if (!windUnitsAreMph(got.data)) return { value: null, error: "bad_payload" };
  const wind = windFromCurrent(got.data && got.data.current);
  if (!wind) return { value: null, error: "no_data" };
  await storeJson(key, wind, WIND_CACHE_SECONDS, ctx);
  return { value: wind, error: null };
}

function windCacheKey(point) {
  const lat = roundTo(point.lat, 2);
  const lng = roundTo(point.lng, 2);
  return `https://playslike.invalid/v1/wind/${lat.toFixed(2)},${lng.toFixed(2)}`;
}

function openMeteoWindUrl(point) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(point.lat));
  url.searchParams.set("longitude", String(point.lng));
  url.searchParams.set("current", "wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  url.searchParams.set("wind_speed_unit", "mph");
  return url.toString();
}

function windUnitsAreMph(data) {
  const units = data && data.current_units;
  if (units == null) return true;
  if (typeof units !== "object") return false;
  const mph = new Set(["mph", "mp/h"]);
  if (units.wind_speed_10m != null && !mph.has(units.wind_speed_10m)) return false;
  if (units.wind_gusts_10m != null && !mph.has(units.wind_gusts_10m)) return false;
  return true;
}

function windFromCurrent(current) {
  if (!current || typeof current !== "object") return null;
  return normalizeWind({
    speed_mph: current.wind_speed_10m,
    gust_mph: current.wind_gusts_10m,
    from_deg: current.wind_direction_10m,
    observed_at: current.time,
  });
}

function normalizeWind(value) {
  if (!value || typeof value !== "object") return null;
  const speed = measuredNumber(value.speed_mph);
  const gust = measuredNumber(value.gust_mph);
  const fromDeg = measuredNumber(value.from_deg);
  if (speed == null || gust == null || fromDeg == null) return null;
  if (typeof value.observed_at !== "string" || value.observed_at.length === 0) return null;
  return {
    speed_mph: speed,
    gust_mph: gust,
    from_deg: fromDeg,
    from_deg_meaning: "meteorological degrees the wind comes from",
    source: "open-meteo",
    observed_at: value.observed_at,
  };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "upstream_error" };
    try {
      return { ok: true, data: await response.json() };
    } catch {
      return { ok: false, reason: "bad_payload" };
    }
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "upstream_error" };
  }
}

function edgeCache() {
  if (typeof caches === "undefined" || !caches || typeof caches.default === "undefined") return null;
  return caches.default;
}

async function cachedJson(key) {
  const cache = edgeCache();
  if (!cache || typeof cache.match !== "function") return null;
  try {
    const hit = await cache.match(new Request(key, { method: "GET" }));
    if (!hit) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

async function storeJson(key, value, ttlSeconds, ctx) {
  const cache = edgeCache();
  if (!cache || typeof cache.put !== "function") return;
  const response = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSeconds}`,
    },
  });
  try {
    const put = Promise.resolve(cache.put(new Request(key, { method: "GET" }), response)).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  } catch {
    // Edge cache is best-effort. The measured value is still returned.
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

    const plays = await handlePlaysLike(request, ctx, cors);
    if (plays) return plays;

    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] || "");
    if (!key || key.length > 180) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    const isPaint = key.startsWith("id:") || key.startsWith("name:");
    const ttl = isPaint ? 60 * 60 * 24 * 365 : 60 * 60 * 24 * 7;
    // Unbound BOARDS throws and Cloudflare turns that into error 1101.
    // Golf routes already returned above, so this only covers board keys.
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
