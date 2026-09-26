# shottrax-share

Cloudflare Worker for ShotTraxx live boards and the course paint cache. It also proxies golf course vendor reads so the phone never holds a vendor key, and it fetches OpenStreetMap golf overlays once per location so phones do not call Overpass themselves.

Live boards stay `GET` / `PUT` on a single path segment in the `BOARDS` KV namespace. Paint cache keys start with `id:` or `name:`. Keys that start with `osm:` are reserved for the overlay cache.

If `env.BOARDS` is not bound, board routes and overlay lookups return `503` `{ "error": "boards_not_configured" }` instead of throwing. Golf proxy routes are unchanged.

Merging to `main` deploys this Worker automatically through Cloudflare Workers Builds. A hand `wrangler deploy` is not required. The Workers Builds check fails immediately on every branch other than `main`. That failure is a Cloudflare branch-build setting, not a problem in this repo. After the merge build finishes, verify with the Magnolia curl below.

## Boards KV

`wrangler.toml` binds `BOARDS` to the existing namespace `shottrax-boards` (`cfa1824a10374ab6a7fa0c97d0990e80`). The automatic `main` deploy uses this file. Keep this id so that deploy does not drop the dashboard binding. No `preview_id` is set.

Board and paint-cache keys are stored only while that binding is present on the live Worker. If it is missing, those routes return `503` `{ "error": "boards_not_configured" }`.

`GET` and `PUT` for a key that starts with `osm:` return `400` and do not read or write KV, so a board request cannot read or replace an overlay cache entry.

## Golf vendor proxy

Successful GETs are cached at the edge for 24 hours. Upstream status codes pass through unchanged.

| Phone path | Upstream |
|---|---|
| `GET /gca/v1/courses`, `/gca/v1/courses/{id}`, `/gca/v1/courses/{id}/green-centers` | `https://golfcoursesapi.com/api/v1/` |
| `GET /golfapi/v2.3/courses`, `/golfapi/v2.3/courses/{id}`, `/golfapi/v2.3/coordinates/{id}` | `https://golfapi.io/api/v2.3/` |

The Worker adds `Authorization: Bearer <secret>`. Set both secrets on the Worker (do not commit them):

```
wrangler secret put GOLF_COURSES_API_KEY
wrangler secret put GOLFAPI_KEY
```

JSON errors: `method_not_allowed` (405), `unknown_route` (404), `not_configured` (503), `boards_not_configured` (503), `upstream_unreachable` (502).

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

The phone gets `200` `Content-Type: application/json` and the raw Overpass body, with `X-Overlay-Cache` of `HIT`, `HIT-NEAR`, `MISS`, `REFRESHED`, or `STALE`. CORS matches the other routes. The body is never a cache wrapper.

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
