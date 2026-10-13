// Deploy entry for shottrax-share.
// Share and board routes come from worker.js. Golf proxy paths and the
// 23:00 UTC stockpile come from golf-proxy.js. Live behavior wins where
// the two share implementations overlapped; see ROUTE_OVERLAPS below.
import share, {
  handlePaintPendingPromote,
  handlePaintRoute,
  PAINT_PROMOTE_PATH,
  parsePaintKey,
} from "./worker.js";
import {
  coverageFromOverlayResponse,
  GolfapiCounter,
  handleGolfProxy,
  runGolfapiStockpile,
  STOCKPILE_CRON,
} from "./golf-proxy.js";

export { GolfapiCounter };
export { FriendGuessLimiter } from "./worker.js";

// Route overlap between main worker.js and the live share bundle
// (live-shottrax-share.js), and how this entry resolves it.
//
// 1. OPTIONS, every path. Both answer the same CORS preflight (course-report
//    methods/headers, and no Allow-Origin on /gca/ or /golfapi/). Live serves
//    the share module, not golf-proxy. Resolved: worker.js.
// 2. GET /meta/golfapi. Live adds billing-cycle `month` and UTC `day` counters.
//    Resolved: worker.js now returns those fields. The other fields already matched.
// 3. GET /meta/gca. Same handler. Resolved: worker.js.
// 4. /gca/*. Both share modules match. golf-proxy can serve /gca/ too, but the
//    live entry does not send /gca/ there. Resolved: worker.js, not golf-proxy.
// 5. /golfapi/* except OPTIONS. Live serves golf-proxy; the share module's
//    golfapi handler is shadowed. Resolved: golf-proxy, including an fr: id
//    or search. Live does not reserve fr:.
// 6. /terrain/*, POST /admin/alert-test, GET /admin/demand, GET /admin/stockpile.
//    Only golf-proxy serves these. Resolved: golf-proxy.
// 7. /osm/*. Handlers match aside from bundler formatting. Resolved: worker.js.
// 8. GET /s/{code}. Same page. Unicode escapes in the live bundle are bundler
//    noise. Resolved: worker.js.
// 9. /v1/course-reports*. Same handlers. Resolved: worker.js.
// 10. POST /v1/paint-pending/promote. Live serves it. Main's /v1 catch-all
//     answers 404 unknown_route. Resolved: handlePaintPendingPromote.
// 11. GET/PUT paint keys (id:, name:). Live runs handlePaintRoute (install id
//     on PUT, per-IP rate limit, record shape, green-move guard) and then the
//     same partial merge. Main's fetch stores the body directly. Resolved:
//     this entry uses handlePaintRoute. Allowed sources are osm,
//     manual_verified, gca, and golfapi. A name
//     key that is not three normalized parts is 400, which is what live does.
//     worker.fetch still accepts the older unvalidated paint PUT so the
//     partial-merge tests keep their direct path.
// 12. Other board keys. Same reserved prefixes and TTL. Live does not reserve
//     fr:. Resolved: worker.js.
// 13. scheduled. Both share modules drain the golfapi queue. The live entry
//     does not call that drain. It runs the stockpile only when the cron is
//     0 23 * * *. Resolved: that handler, and no 08:00 cron. worker.scheduled
//     still drains for the existing tests and is not the deploy handler.
// 14. /v1/friends*. Not served by live or by main. Later friend routes stay
//     on worker.fetch, which this entry calls for everything it does not take.

const PAINT_TTL = 60 * 60 * 24 * 365;

function isPrPath(pathname) {
  return (
    pathname.startsWith("/golfapi/") ||
    pathname.startsWith("/terrain/") ||
    pathname === "/admin/alert-test" ||
    pathname === "/admin/demand" ||
    pathname === "/admin/stockpile"
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
    const response = await withTimeout(share.fetch(request, env, ctx), 8000);
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

function boardKey(pathname) {
  return decodeURIComponent(pathname.replace(/^\/+/, "").split("/")[0] || "");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method !== "OPTIONS" && isPrPath(pathname)) {
      const res = await handleGolfProxy(request, env, ctx);
      if (res) return withLiveCors(res, pathname);
    }
    if (pathname === PAINT_PROMOTE_PATH) {
      return handlePaintPendingPromote(request, env, liveCorsHeaders(pathname));
    }
    if (request.method === "GET" || request.method === "PUT") {
      let key = "";
      try {
        key = boardKey(pathname);
      } catch {
        key = "";
      }
      if (parsePaintKey(key).kind !== "none") {
        const boards = env && env.BOARDS;
        if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
          return share.fetch(request, env, ctx);
        }
        return handlePaintRoute(request, env, key, PAINT_TTL, liveCorsHeaders(pathname));
      }
    }
    return share.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (event && event.cron === STOCKPILE_CRON) {
      return runGolfapiStockpile(env, ctx, event, {
        overlay: (course) => stockpileOverlay(course, env, ctx),
      });
    }
    return { skipped: "cron" };
  },
};
