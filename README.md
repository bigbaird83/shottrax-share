# shottrax-share

Cloudflare Worker for ShotTraxx live boards and the course paint cache. It also proxies golf course vendor reads so the phone never holds a vendor key, and it fetches OpenStreetMap golf overlays once per location so phones do not call Overpass themselves.

Live boards stay `GET` / `PUT` on a single path segment in the `BOARDS` KV namespace. Paint cache keys start with `id:` or `name:`. Keys that start with `osm:`, `gq:`, `gapi:`, `gqueue:`, `gca:`, or `cr:` are reserved, and so is any key that starts with `v1`.

If `env.BOARDS` is not bound, board routes, overlay lookups, golfapi reads, and GCA course reads (`courses/{id}`, `courses/{id}/green-centers`) return `503` `{ "error": "boards_not_configured" }` instead of throwing. GCA search still proxies without that namespace.

Merging to `main` deploys this Worker automatically through Cloudflare Workers Builds. A hand `wrangler deploy` is not required. The Workers Builds check fails immediately on every branch other than `main`. That failure is a Cloudflare branch-build setting, not a problem in this repo. After the merge build finishes, verify with the Magnolia curl below.

## Boards KV

`wrangler.toml` binds `BOARDS` to the existing namespace `shottrax-boards` (`cfa1824a10374ab6a7fa0c97d0990e80`). The automatic `main` deploy uses this file. Keep this id so that deploy does not drop the dashboard binding. No `preview_id` is set.

Board and paint-cache keys are stored only while that binding is present on the live Worker. If it is missing, those routes return `503` `{ "error": "boards_not_configured" }`.

`GET`, `PUT`, and `DELETE` for a reserved prefix return `400` and do not read or write KV, so a board request cannot read, replace, or reset an overlay, a golfapi counter, a stored course, a GCA copy, the refill queue, or a course report. Paint keys (`id:`, `name:`) and ordinary board codes are unchanged. A key that starts with `v1` is reserved too, so `GET /v1` cannot read a board.

## Live board web page

`GET /s/{code}` is an HTML page anyone can open in a browser, no app needed (`live-page.js`). The ShotTraxx™ app shares this link for a live board. The page renders the board stored at `{code}` in `BOARDS` on the Worker, so Messages and WhatsApp previews show the course and score (`Live · Greystone CC` / `E thru 2 · On hole 3`). Then it polls `GET /{code}` every 8 s until the round is final. Scores only: no map, and the page never asks for location.

- Only a six-character board code from the app's alphabet is read. Anything else under `/s/` is a `404` page, and the route also refuses reserved keys, so it never reads or shows overlay, golfapi, course-store, GCA, refill-queue, or paint (`id:` / `name:`) data.
- A valid code with nothing stored yet (or `BOARDS` unbound) gets a "Waiting for the first hole" page that keeps polling.
- Every stored string is HTML-escaped (anyone can `PUT` a board). Scripts and styles run under a per-request CSP nonce, and `connect-src` is `'self'`.
- `STORE_LIVE` (var, default off). Leave it unset until ShotTraxx™ is live in the App Store. Off shows "Open in ShotTraxx™" (`shottrax:///s/{code}`) only. `"true"` adds the Safari App Store banner and a "Track your own round" card with "Get ShotTraxx™ on the App Store". "Open in ShotTraxx™" shows either way: the app has no associated domain, so tapping the web link opens Safari even for people who have the app. The page makes no trial offer; that comes back with the paywall's real terms. Set it under `[vars]` in `wrangler.toml` (the automatic `main` deploy uses that file). `APP_STORE_ID` overrides the App Store id (`6812944398`).

Check after merge (any six-character code; an unknown one shows the waiting page):

```bash
curl -sS -o /dev/null -w "%{http_code} %{content_type}\n" https://shottrax-share.bcbaird.workers.dev/s/BK3MCQ
# 200 text/html; charset=utf-8
curl -sS -o /dev/null -w "%{http_code}\n" https://shottrax-share.bcbaird.workers.dev/s/gq:balance
# 404
```

## Course reports

The app queues an in-round "problem with this course/hole" report on the phone and `POST`s it here. The same endpoint takes a "Map this hole" contribution when a hole has no map. `200` and `201` with `{ "ok": true, "id" }` mean the report was accepted (a `200` is a duplicate and is not stored again). The app drops a report only on `400`, `413`, or `422`. Anything else (`404`, `405`, `429`, `5xx`, network) stays queued and is retried. Unknown JSON fields are ignored, so a newer app build can add fields without the report being dropped.

```
POST /v1/course-reports
GET  /v1/course-reports                      admin
GET  /v1/course-reports/{clientReportId}     admin, one record
POST /v1/course-reports/{clientReportId}/review   admin, review a contribution
```

`POST` body is JSON, at most 4096 bytes. Over that is `413` `{ "error": "too_large" }`. Invalid JSON is `400` `{ "error": "invalid_json" }`. A field that can never succeed is `422` `{ "error": "invalid", "field" }`. Any other `/v1/*` path is `404` `{ "error": "unknown_route" }`. This route is matched before the board-key catch-all.

| Field | Rule |
|---|---|
| `clientReportId` | Required. Loose uuid (`8-4-4-4-12` hex, any version), at most 64 characters. Idempotency key. |
| `createdAt` | Required ISO-8601 timestamp. Stored as sent. Not used for ordering. |
| `courseId` | Required string, 1–180 characters. Same key as the paint cache (`id:…` or `name:…`). |
| `courseName` | Required string. Trimmed, then 1–200 characters. |
| `holeNumber` | Required integer, 1–18. |
| `reasons` | Required non-empty array. Allowed: `hole_missing`, `green_wrong`, `tee_wrong`, `wrong_par`, `wrong_course`, `other`, `hole-contribution`. Unknown values are dropped and duplicates collapse. If none remain, `422`. |
| `note` | Optional string. Trimmed, max 500. |
| `position` | `null` or `{ lat, lon, accuracyM }`. Finite `lat` −90..90, `lon` −180..180, `accuracyM` ≥ 0 or `null`. This is the GPS fix for "I'm here". |
| `contribution` | Required when `reasons` includes `hole-contribution`. Ignored on any other report. See below. |
| `appVersion`, `buildNumber`, `platform` | Optional strings, each max 32. |
| `paintSource` | Optional string or `null`, max 32. Any value is accepted and stored lowercased. |
| `shown` | Optional. Never rejected. A non-object is stored as `null`. `par` is kept when it is an integer 1–10 and is otherwise `null`. `green` and `tee` are kept only as a valid `{ lat, lon }` and are otherwise `null`. |
| `X-Install-Id` | Optional header, max 100 characters. Stored as `installId`. |

`contribution` when `hole-contribution` is one of the reasons:

| Field | Rule |
|---|---|
| `green` | Required `{ lat, lon }`. Same lat/lon rules as `position`. |
| `greenMethod` | Required. `tap-map` or `im-here`. |
| `tee` | Optional `{ lat, lon }`. Omit it, or send `null`, when the player did not mark a tee. A present value that is not a lat/lon is `422` with `field` `contribution.tee`. |
| `tees` | Optional array, at most 8. Each entry is `{ color, lat, lon, method, accuracyM? }`. `color` is a string, trimmed and stored lowercased, 1–24 characters, and unique in the list. `lat` and `lon` use the same rules as `tee`. `method` is `tap-map` or `im-here`. `accuracyM`, when sent, is a finite number ≥ 0. Omit `tees`, or send `null`, and it is ignored. An empty array stores nothing. A non-array, more than 8 entries, or any bad entry is `422` with `field` `contribution.tees`. Stored as `[{ color, lat, lon, method, accuracyM? }]`. The single `tee` field is unchanged. |
| `par` | Optional integer, 3–6. Omit it, or send `null`, when the player did not enter par. |
| `contributorEmail` | Optional. Trimmed, max 254 characters, basic `local@domain.tld` shape, stored lowercased. The report JSON does not hold the address. |

A missing or non-object `contribution` is `422` `{ "error": "invalid", "field": "contribution" }`. A bad `green`, `greenMethod`, `tee`, `tees`, `par`, or `contributorEmail` uses `field` `contribution.<name>`. The server does not copy `position` onto `green` and does not fill in a tee, a tees list, or a par the player did not send.

When an address is accepted, the report stores `contribution.hadEmail: true` and the address itself goes to `cr:email:<clientReportId>` with `expirationTtl` of 365 days. KV deletes that key on its own if nobody reviews the report. The `cr:` prefix is reserved, so `GET /cr:email:…` cannot read it. If `createdAt` is already 365 days old or older, the address is not stored. Admin `GET`s copy a live key onto `contribution.contributorEmail`. After the key is gone, those responses still show `hadEmail` and do not show the address.

The phone refuses a bad GPS fix and an implausible hole length. The server still stores the contribution and adds `contribution.hints` for the reviewer. Hints never cause a `422`.

| Hint | When it is set |
|---|---|
| `greenToPositionM` | `im-here` and `position` has a lat/lon. Meters, rounded, from the green to that fix. |
| `positionAccuracyM` | `position.accuracyM` is a number. Copied through. |
| `poorFix` | Same as `positionAccuracyM`. `true` when accuracy is over 15 meters. |
| `greenToTeeM` | Both `tee` and `par` were sent. Meters, rounded, from the green to the tee. |
| `plausibleForPar` | Same as `greenToTeeM`. Inclusive yards: par 3 is 60–280, par 4 is 230–520, par 5 is 400–680. Par 6 has no band, so the flag is `false`. |
| `tees` | When `tees` were sent, one entry per tee: `{ color, greenToTeeM }`. `greenToTeeM` is meters, rounded, from the green to that tee. `accuracyM` and `poorFix` are included only when that tee sent `accuracyM`. `poorFix` is `true` when that accuracy is over 15 meters. `plausibleForPar` is included only when `par` was sent, using the same inclusive yard bands as the single-tee hint. |

A contribution record also stores `review`: `{ "status": "pending", "reviewedAt": null, "note": null, "usedAt": null, "rewardedAt": null }`.

A new report is `201` `{ "ok": true, "id": "<clientReportId>" }`. The same id again is `200` `{ "ok": true, "id", "duplicate": true }` and does not write. Neither response includes the stored record, so `contributorEmail` and `position` are not echoed to the phone. The report keys live 180 days. The address key lives 365 days:

- `cr:id:<clientReportId>` — dedupe marker. The value is the record key.
- `cr:r:<receivedAt ISO with milliseconds>:<clientReportId>` — the normalized JSON, plus `receivedAt`, `installId`, and `country` from `request.cf.country` when Cloudflare sends it. The raw IP is not stored. The address is not in this JSON.
- `cr:email:<clientReportId>` — the lowercased address, only when one was accepted and `createdAt` is still inside 365 days. `expirationTtl` is 365 days.

New reports (not duplicates) are limited per UTC day: 30 per `CF-Connecting-IP`, and 20 per `X-Install-Id` when that header is present. Over the limit is `429` `{ "error": "rate_limited" }` with `Retry-After` in seconds, which the app retries. Override the caps with `COURSE_REPORTS_IP_DAY` and `COURSE_REPORTS_DEVICE_DAY` (see the comments in `wrangler.toml`). If `BOARDS` is unbound the response is `503` `{ "error": "boards_not_configured" }`. Review writes do not count toward the cap.

Admin `GET` and the review `POST` require `Authorization: Bearer <token>`. The token is compared in constant time. Wrong or missing is `401`. If the secret is unset the route fails closed with `503` `{ "error": "not_configured" }`. Set it on the Worker (do not commit it):

```
wrangler secret put COURSE_REPORTS_ADMIN_TOKEN
```

Query params: `since` (ISO timestamp; reports with an earlier `receivedAt` are skipped using key order), `courseId` (exact match), `reason` (one known reason, for example `hole-contribution`), `status` (`pending`, `approved`, `rejected`, `used`, or `rewarded`), `limit` (default 100, max 500), `cursor` (pass the previous KV list cursor back). An unknown `reason` or `status` is `422`. The body is `{ "reports": [ ... ], "cursor": "<cursor or null>" }`, oldest first. `GET /v1/course-reports/<clientReportId>` returns that one record, or `404` `{ "error": "not_found" }`. `position` is on these admin GETs. `contributorEmail` is on them only while the `cr:email:` key exists.

`POST /v1/course-reports/<clientReportId>/review` body is `{ "status": "approved" | "rejected" | "used" | "rewarded", "note"?: string }`. `note` is optional, trimmed, max 500. Leave it out to keep the previous note. Send `null` or `""` to clear it. Allowed transitions are pending → approved, pending → rejected, approved → used, and used → rewarded. Anything else is `409` `{ "error": "invalid_transition" }`. A missing report is `404`. Moving to `approved` or `rejected` sets `reviewedAt`. Moving to `used` sets `usedAt` and leaves `reviewedAt` as it was. `rewardEligible` is stored `true` only when the new status is `used` and the email key is still present. Moving to `rejected` deletes `cr:email:<clientReportId>` in that same request and leaves `hadEmail`. Moving to `rewarded` sets `rewardedAt`, deletes that same key, and keeps `rewardEligible`. Nothing in this route grants the free month, and nothing writes the paint cache or any course record. Applying an approved hole is a separate manual step. The response is `200` and the updated record, with `contributorEmail` joined in only when the key is still there.

CORS for this route allows `GET,POST,OPTIONS` and the `Authorization` header. Other routes are unchanged.

Merging to `main` deploys this Worker. The admin list and review stay closed until `COURSE_REPORTS_ADMIN_TOKEN` is set. Do not put that token in `wrangler.toml`.

## Golf vendor proxy

GCA search (`GET /gca/v1/courses?...`) is cached at the edge for 24 hours. Its upstream status passes through unchanged, and it is not written to KV.

`courses/{id}` and `courses/{id}/green-centers` also keep a durable copy in `BOARDS` for 365 days. Keys are `gca:course:{id}` and `gca:greens:{id}`. The value is the raw upstream body. Metadata is `{ "status": 200, "storedAt": <ms> }`. The edge cache is checked first, then KV. A copy younger than `GCA_REFRESH_DAYS` (default 30) is served without calling upstream, and that response re-warms the edge cache. An older copy is refreshed: a 2xx overwrites KV and the edge cache; a 429, 5xx, timeout, or thrown fetch serves the stored body with `X-Course-Data-Stale: 1` and `X-Course-Data-Age` (seconds since `storedAt`) and does not store the error. With no copy, a 429 is `{ "error": "rate_limited" }` plus `Retry-After` (the upstream value, or 30). A 404 is not stored in KV. A miss 404 may sit in the edge cache for 5 minutes. `presentGcaCourseBody` is the only response-time body transform. The Magnolia scorecard correction runs there once, on an edge hit, a fresh upstream read, a fresh KV serve, and a stale serve. KV and the edge cache keep the raw body.

Upstream calls, 429s, stale serves, and edge-cache misses with no valid install id (`missingInstallId`) are counted per UTC day at `gca:stats:YYYY-MM-DD` (40-day TTL). `GET /meta/gca` returns `refreshDays`, today's counts, and the last 30 UTC days. A 429, or any upstream response that carries `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `ratelimit-*`, or `retry-after`, is one `console.log` JSON line with `route`, `status`, and those header values. `GCA_REFRESH_DAYS` is an optional Worker var. Invalid values keep 30. `GCA_REQUIRE_INSTALL_ID` is an optional var and defaults off (`1`, `true`, `yes`, or `on` turn it on). While it is off, `/gca/v1/*` still serves a request with no valid `X-Install-Id`. `missingInstallId` increments only on an edge-cache miss, before the KV read or the upstream fetch, so a fresh KV serve, an upstream fetch, a stale serve, and a 404 each count once. An edge hit does not read or write KV for that count. A request with a valid id is not counted. When the var is on, that request is `401` `{ "error": "install_id_required" }` before any cache, KV, or upstream work. Installed builds do not send the header on GCA, so leave the var unset until `missingInstallId` stays at zero. No new secrets.

Golfapi is paid. One lookup is one set: a search plus `courses/{id}` plus `coordinates/{id}`. The set is counted on its first fresh upstream call and stays open for 15 minutes, separately for the device and for the IP (`gq:set:`). A fresh search opens the set and counts 1. A fresh course or coordinates call for the first course id in that window counts nothing extra. If the search was a cache hit, the later course call opens the set and counts 1. A different course id opens a new set and counts again. Cache hits never count. Course and coordinates bodies are stored in KV for a year (`gapi:course:`, `gapi:coord:`) and a repeat is free for a caller that sends a valid install id. Successful searches are stored for 30 days (`gapi:search:`) so a repeat of that query is free. The app searches with `name` (golfapi.io ignores `q` and filters on `name`). A search is valid when `name` is non-empty, or, when `name` is absent, when `q` is. The store key and queue token use that value, so older `q`-only keys still match a `q`-only request. The original query string is forwarded and replayed, including `name=`. Any other `/golfapi/` path is `404` after the install id checks out. A 200 with no course data, or an error body, is not stored and is not edge-cached.

Limits default to 3 lookups per device per UTC day, 10 per ISO week, and 20 per month. IP limits are twice that. The whole Worker allows 100 fresh lookups per UTC day. Fresh upstream calls stop when the last known `apiRequestsLeft` is 10 or less. There is no separate search budget. Fresh searches are also capped at 3 times the device daily limit per device per day (9 at the default), including searches inside an open set. Override the lookup limits with `[vars]` in `wrangler.toml` (`GOLFAPI_DEVICE_DAY`, `GOLFAPI_DEVICE_WEEK`, `GOLFAPI_DEVICE_MONTH`, `GOLFAPI_IP_DAY`, `GOLFAPI_IP_WEEK`, `GOLFAPI_IP_MONTH`, `GOLFAPI_GLOBAL_DAY`, `GOLFAPI_FLOOR`). Invalid values keep the defaults. Older `GOLFAPI_SEARCH_*` vars are ignored. The API key is not a var.

`/golfapi/v2.3/*` requires `X-Install-Id` (8–64 characters, `A–Z`, `a–z`, `0–9`, `_`, `-`). The current app id looks like `id_<ms>_<base36>`, for example `id_1790517745797_pfjtwbfa`. A missing or invalid id is `401` `{ "error": "install_id_required" }`. That response does not call upstream and does not write a device bucket, an IP bucket, a set, or the queue. The only write is `blocked.install_id_required` on that UTC day's stats. The 08:00 UTC cron is not an HTTP request and does not read the header. With a valid id, the Worker also limits `CF-Connecting-IP`. IPs are stored only as a SHA-256 with a fixed prefix. Both limits apply, because the install id can be spoofed.

Install ids in `GOLFAPI_ALLOWLIST` (comma-separated) skip the device limits, the IP limits, the search cap, and the global daily cap. Their lookups are not added to the global count or the IP counters. They are counted separately (`allowlistedLookups`). The balance floor still applies. Set this as a Worker secret so it is not in git and a deploy does not wipe it:

```
wrangler secret put GOLFAPI_ALLOWLIST
```

Over a limit the response is `429` `{ "error": "golfapi_limited", "reason": "device_day", "queued": true, "retryAfterSec": ... }` plus `Retry-After`. The app already treats a non-2xx as "use free and GCA data," so the course still opens. Course ids are queued as `gqueue:{id}`. A search that is limited is queued as `gqueue:q:{hash}` (one row per normalized query; the first query string is the one that is replayed). A cron at 08:00 UTC runs the queue while the global cap and the balance floor allow it. A course row fetches `courses/{id}` and `coordinates/{id}` into `gapi:`. A search row runs the search, stores it for 30 days, and fetches course plus coordinates only when exactly one result's normalized name equals the query. Otherwise it stores just the search. The next open is free, and the app writes its combined paint into the shared paint cache. Errors stay queued and stop after 5 attempts.

`GET /meta/golfapi` returns the last known balance, an `asOf` ISO time for that balance reading, a `generatedAt` time for the response, today's global lookup count (`today.globalLookups`) and the cap (`globalCap` and `today.globalCap`), allowlisted lookups for today and each of the last 30 UTC days, search counts, blocks by reason (including `install_id_required`), the queue length, and today's fetch timing. Timing is per endpoint (`search`, `course`, `coordinates`): how many fresh upstream calls, a median of a 21-sample reservoir, and the max for the day. It does not return the key, the allowlist, install ids, or IPs.

KV counters are not atomic, and one key accepts about one write per second, so a burst can overshoot a limit by a couple of calls. The global cap and the balance floor are the backstop.

On a day that uses the full budget (100 sets) the writes are about one per counter touch: a new set writes the device bucket, the IP bucket, the daily stats (including the latency sample), the balance, a short set record, and a body. A course or coordinates call inside that set writes the balance, the body, and the set record, not another lookup counter. A full search plus course plus coordinates set is on the order of 15 writes, so 100 of those can pass the free plan's 1,000 writes/day. The global cap limits paid golfapi calls; it does not keep KV inside the free tier on a maxed-out day. Repeat opens of a stored course are one write (the hit counter) and one read. Search bodies are smaller and expire after 30 days; course and coordinates bodies stay for a year. The Workers Free KV plan allows 1,000 writes, 1,000 deletes, 1,000 lists, and 100,000 reads per day, plus 1 GB. A quieter day, and a few hundred repeat opens, still fit. Cache-hit accounting is the other way the free write cap gets tight.

| Phone path | Upstream |
|---|---|
| `GET /gca/v1/courses`, `/gca/v1/courses/{id}`, `/gca/v1/courses/{id}/green-centers` | `https://golfcoursesapi.com/api/v1/` |
| `GET /golfapi/v2.3/courses?name=` (or `?q=`), `/golfapi/v2.3/courses/{id}`, `/golfapi/v2.3/coordinates/{id}` | `https://golfapi.io/api/v2.3/` |

The Worker adds `Authorization: Bearer <secret>`. Set both secrets on the Worker (do not commit them):

```
wrangler secret put GOLF_COURSES_API_KEY
wrangler secret put GOLFAPI_KEY
```

`/gca/` and `/golfapi/` responses omit `Access-Control-Allow-Origin`, including OPTIONS preflight and errors. Share-board routes, `/meta/*`, and `/osm/` still send `Access-Control-Allow-Origin: *`. The phone is React Native, so CORS does not affect it. There is no browser page in this repo that calls `/gca/` or `/golfapi/`.
Dropping CORS on `/gca/` and `/golfapi/` means the Expo web dev target (`expo start --web` in the app repo) can't load course data through this Worker from a browser. Native iOS and Android builds aren't affected.

JSON errors: `install_id_required` (401), `method_not_allowed` (405), `unknown_route` (404), `not_configured` (503), `boards_not_configured` (503), `upstream_unreachable` (502), `golfapi_limited` (429), `no_course_data` (404 on a repeat of an empty golfapi answer).

After deploy, search Magnolia with:

https://shottrax-share.bcbaird.workers.dev/gca/v1/courses?q=magnolia

## OSM overlay proxy

Phones call this Worker instead of `https://overpass-api.de/api/interpreter`. The public Overpass server asks apps not to send heavy direct traffic, and it often answers `504` or `429`. The Worker builds the query itself, the same golf ways and relations as ShotTraxx `overpassQuery` in `src/course/osmOverlay.ts` (`[out:json][timeout:25]`, `around` the point, `out geom`). Clients never send Overpass QL, so this is not an open proxy. The JSON body is returned unchanged for the app's `parseOverpassOverlay`.

```
GET /osm/v1/overlay?courseId=<id>&lat=<lat>&lng=<lng>&radius=<meters>
```

| Param | Rule |
|---|---|
| `courseId` | Required. 1–128 characters, `[A-Za-z0-9._:-]` |
| `lat` | Required. Finite, -90 through 90 |
| `lng` | Required. Finite, -180 through 180 |
| `radius` | Optional integer meters. 200–2000, default 1800 |

The phone gets `200` `Content-Type: application/json` and the raw Overpass body, with `X-Overlay-Cache` of `HIT`, `HIT-NEAR`, `MISS`, `REFRESHED`, or `STALE`. CORS matches share-board and `/meta/` routes (`Access-Control-Allow-Origin: *`). The body is never a cache wrapper.

`courseId` is required and is kept for clients. It is not part of the cache key. The same rounded point and radius share one entry no matter which course id the phone sends.

Cache key: `osm:v1:<lat to 4 decimals>,<lng to 4 decimals>:<radius>`. A successful response (at least one element with a `golf` tag, and no timeout or runtime `remark`) is stored in `BOARDS` as that raw JSON. `expirationTtl` is 365 days so the entry is not deleted on a 30-day timer. `fetchedAt` is KV metadata.

- Younger than 30 days: `X-Overlay-Cache: HIT`. Overpass is not called.
- 30 days or older: the phone gets the stored overlay immediately with `X-Overlay-Cache: STALE`. The refresh runs in the background (`ctx.waitUntil`). A new non-empty overlay overwrites the entry; the next request is `HIT`. If Overpass is busy, times out, errors, or returns no golf features, the stored overlay is left unchanged. A refresh never drops a saved overlay and never answers `503` or `404` while an older copy exists.

Before a background refresh, the Worker writes `osm:v1:refreshing:<same location key>` with a 1-hour TTL. While that marker exists, another request for that location serves `STALE` and does not call Overpass. `GET` / `PUT` for that key is refused like any other `osm:` key. Without `ctx.waitUntil` the Worker waits for the refresh instead, and a successful one is `X-Overlay-Cache: REFRESHED`.

On a miss, the Worker can reuse a saved overlay for a nearby pin before it honors a negative marker. Each positive entry is recorded in a coarse cell index, `osm:v1:index:<lat to 0.01>,<lng to 0.01>`, holding that entry's center and radius. A lookup reads the request's cell and its neighbors and serves the nearest saved entry with the same radius whose center is within 600 m. That response is `X-Overlay-Cache: HIT-NEAR`, including when this exact point has a `none` marker. A negative marker is not indexed and never answers for a neighboring point. It answers `404` only when this location has no exact overlay and no nearby one.

Older entries were stored as `osm:v1:<courseId>:<lat>,<lng>:<radius>`. A miss does one extra KV read of that key for the course id on the request, and copies a hit onto the location key. Entries under any other course id are not scanned. Those copies re-warm when that location is requested again.

`caches.default` holds a copy for 1 day, with `fetchedAt` on that cached response, so an edge hit cannot keep serving an overlay past its refresh. A `STALE` answer is not written to the edge cache. A hit does not call Overpass. Identical misses in the same isolate share one upstream call.

When nothing is stored yet, `429`, `5xx`, timeouts, network errors, bad JSON, and an Overpass `200` whose `remark` reports a runtime error or timeout (Overpass uses `200` plus `remark` when a query times out) are not cached. The phone gets `503` `{ "error": "upstream_busy" }` and `Retry-After` (the upstream value when it sent one, otherwise 30). The primary attempt is about 11 seconds. If it times out, throws, or returns `429` or `504`, the retry goes to `https://overpass.private.coffee/api/interpreter` with the time left in the ~27 second budget. Other failed responses retry the primary. The upstream `User-Agent` is `shottracker-worker/1.0 (+https://shottrax-share.bcbaird.workers.dev)`.

A valid response with no golf features, and no exact or nearby overlay already stored, is `404` `{ "error": "no_overlay" }`. That negative marker is stored for 6 hours at `osm:v1:none:<lat>,<lng>:<radius>` and only ever answers `404` for that exact location. It is not written when a positive overlay exists, and it does not block a later `HIT-NEAR`.

Other overlay errors: `bad_request` (400), `method_not_allowed` (405), `unknown_route` (404), `boards_not_configured` (503). No new secrets, env vars, or KV namespaces.

### Attribution

Overlays are OpenStreetMap data, © OpenStreetMap contributors, under the Open Database License (ODbL). Apps must show **© OpenStreetMap contributors** wherever those overlays are drawn.

https://www.openstreetmap.org/copyright

### Check after merge

Merging to `main` deploys the Worker. When that Workers Builds run finishes, check Magnolia Country Club, AR:

```
curl -D - "https://shottrax-share.bcbaird.workers.dev/osm/v1/overlay?courseId=2fa21943-abaa-43a4-a90f-cb06c82216b4&lat=33.1940935&lng=-93.2077463&radius=1800"
```

Expect `200` and golf features. Run it again and expect `X-Overlay-Cache: HIT`. If that course was already stored under the old course-id key, this same id adopts it and the first response can already be `HIT`.

Then the GCA pin, within 600 m of that point, should reuse that copy:

```
curl -D - "https://shottrax-share.bcbaird.workers.dev/osm/v1/overlay?courseId=14322&lat=33.1958&lng=-93.2134&radius=1800"
```

Expect `200`, the same golf features, and `X-Overlay-Cache: HIT-NEAR`. A request for that second pin before the location key exists misses the old course-id entry and has to fetch.

`npm test` runs the worker tests (mocked fetch, KV, and cache). It does not deploy.
