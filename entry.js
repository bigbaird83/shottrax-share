// Deploy entry for the live shottrax-share Worker.
// The share module is the live shottrax-share script (boards, /s/ pages,
// paint, OSM, course reports, /gca/*, /meta/*, and the golfapi hotfix).
// Only the golf-proxy paths go to golf-proxy.js.
import live from "./live-shottrax-share.js";
import { coverageFromOverlayResponse, handleGolfProxy, GolfapiCounter, runGolfapiStockpile, STOCKPILE_CRON } from "./golf-proxy.js";
import { FriendGuessLimiter, handleFriends, isFriendPath } from "./friends.js";

export { GolfapiCounter };
export { FriendGuessLimiter };

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

// In-process OSM overlay. No fetch() back to this Worker, and no golfapi credit.
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
    if (request.method !== "OPTIONS" && isPrPath(pathname)) {
      const res = await handleGolfProxy(request, env, ctx);
      if (res) return withLiveCors(res, pathname);
    }
    return live.fetch(request, env, ctx);
  },
  // Only the 23:00 UTC stockpile cron stays here. It checks the balance window
  // every night. The 08:00 UTC queue drain is permanently off (Doc, Oct 9 2026).
  // It is not in crons, and this handler does not call it.
  async scheduled(event, env, ctx) {
    if (event && event.cron === STOCKPILE_CRON) {
      return runGolfapiStockpile(env, ctx, event, { overlay: (course) => stockpileOverlay(course, env, ctx) });
    }
    return { skipped: "cron" };
  },
};
