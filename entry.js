// Deploy entry for the live shottrax-share Worker.
// The share module is the live shottrax-share script (boards, /s/ pages,
// paint, OSM, course reports, /gca/*, /meta/*, and the golfapi hotfix).
// Only the golf-proxy paths go to golf-proxy.js.
// An fr: golfapi id or search is 404 before that proxy.
import live from "./live-shottrax-share.js";
import { coverageFromOverlayResponse, handleGolfProxy, GolfapiCounter, runGolfapiStockpile, STOCKPILE_CRON } from "./golf-proxy.js";
import { FriendGuessLimiter, handleFriends, isFriendPath } from "./friends.js";
import { LeagueRoster, handleLeagues, isLeaguePath } from "./leagues.js";

export { GolfapiCounter };
export { FriendGuessLimiter };
export { LeagueRoster };

function friendCors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Friend-Key, X-Install-Id",
  };
}

function isPrPath(p) {
  return (
    p.startsWith("/golfapi/") ||
    p.startsWith("/terrain/") ||
    p === "/admin/alert-test" ||
    p === "/admin/demand" ||
    p === "/admin/stockpile"
  );
}

function isFriendToken(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    if (current.startsWith("fr:")) return true;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (decoded === current) return false;
    current = decoded;
  }
  return current.startsWith("fr:");
}

function normalizeSearch(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** An fr: golfapi id or search must not reach the proxy or its KV. */
function friendGolfapiBlocked(pathname, url) {
  if (!pathname.startsWith("/golfapi/v2.3/")) return false;
  const rest = pathname.replace(/\/+$/, "").slice("/golfapi/v2.3/".length);
  if (rest === "courses") {
    const name = url.searchParams.get("name");
    const query = name != null && name.trim() !== "" ? name : url.searchParams.get("q");
    return query != null && isFriendToken(normalizeSearch(query));
  }
  const match = /^(?:courses|coordinates)\/([^/]+)$/.exec(rest);
  if (!match) return false;
  let id = match[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw segment. isFriendToken still checks it.
  }
  return isFriendToken(id);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function stockpileOverlay(course, env, ctx) {
  const id = typeof course?.courseId === "string" ? course.courseId.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || course.lat == null || course.lng == null) {
    return { kind: "unknown", reason: "no_match" };
  }
  const params = new URLSearchParams({
    courseId: id,
    lat: String(course.lat),
    lng: String(course.lng),
    radius: "1800",
  });
  const request = new Request(`https://stockpile.internal/osm/v1/overlay?${params}`);
  try {
    const response = await withTimeout(live.fetch(request, env, ctx), 8000);
    return coverageFromOverlayResponse(response, course.numHoles);
  } catch {
    return { kind: "unknown", reason: "error" };
  }
}

function isCourseReportPath(pathname) {
  return pathname === "/v1/course-reports" || pathname.startsWith("/v1/course-reports/");
}

function liveCorsHeaders(pathname) {
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

function withLiveCors(response, pathname) {
  const headers = new Headers(response.headers);
  const cors = liveCorsHeaders(pathname);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  if (!Object.prototype.hasOwnProperty.call(cors, "Access-Control-Allow-Origin")) {
    headers.delete("Access-Control-Allow-Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (isFriendPath(pathname)) {
      const cors = friendCors();
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });
      return handleFriends(request, url, env, cors);
    }
    if (isLeaguePath(pathname)) {
      const cors = friendCors();
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });
      return handleLeagues(request, url, env, cors);
    }
    if (request.method !== "OPTIONS" && friendGolfapiBlocked(pathname, url)) {
      return withLiveCors(new Response(JSON.stringify({ error: "unknown_route" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }), pathname);
    }
    if (request.method !== "OPTIONS" && isPrPath(pathname)) {
      const res = await handleGolfProxy(request, env, ctx);
      if (res) return withLiveCors(res, pathname);
    }
    return live.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    if (event && event.cron === STOCKPILE_CRON) {
      return runGolfapiStockpile(env, ctx, event, { overlay: (course) => stockpileOverlay(course, env, ctx) });
    }
    return { skipped: "cron" };
  },
};
