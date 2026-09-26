# shottrax-share

Cloudflare Worker for ShotTraxx live boards and the course paint cache. It also proxies golf course vendor reads so the phone never holds a vendor key, and it fetches OpenStreetMap golf overlays once per course so phones do not call Overpass themselves.

Live boards stay `GET` / `PUT` on a single path segment in the `BOARDS` KV namespace. Paint cache keys start with `id:` or `name:`. Keys that start with `osm:` are reserved for the overlay cache.

If `env.BOARDS` is not bound, board routes and overlay lookups return `503` `{ "error": "boards_not_configured" }` instead of throwing. Golf proxy routes are unchanged.

Deploy is manual. Brian runs `wrangler deploy` after merge. Do not deploy from CI.

## Boards KV

`wrangler.toml` binds `BOARDS` to the existing namespace `shottrax-boards` (`cfa1824a10374ab6a7fa0c97d0990e80`). The next `wrangler deploy` must keep that id so it does not drop the dashboard binding. No `preview_id` is set.

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

The phone gets `200` `Content-Type: application/json` and the raw Overpass body, with `X-Overlay-Cache` of `HIT`, `MISS`, `REFRESHED`, or `STALE`. CORS matches the other routes. The body is never a cache wrapper.

Cache key: `osm:v1:<courseId>:<lat to 4 decimals>,<lng to 4 decimals>:<radius>`. A successful response (at least one element with a `golf` tag, and no timeout or runtime `remark`) is stored in `BOARDS` as that raw JSON. `expirationTtl` is 365 days so the entry is not deleted on a 30-day timer. `fetchedAt` is KV metadata.

- Younger than 30 days: `X-Overlay-Cache: HIT`. Overpass is not called.
- 30 days or older: the Worker asks Overpass again. A new non-empty overlay overwrites the entry and is served as `X-Overlay-Cache: REFRESHED`. If Overpass is busy, times out, errors, or returns no golf features, the stored overlay is left unchanged and served as `X-Overlay-Cache: STALE`. A refresh never drops a course's overlays and never answers `503` or `404` while an older copy exists.

`caches.default` holds a copy for 1 day, with `fetchedAt` on that cached response, so an edge hit cannot keep serving an overlay past its refresh. A `STALE` answer is not written to the edge cache. A hit does not call Overpass. Identical misses in the same isolate share one upstream call.

When nothing is stored yet, `429`, `5xx`, timeouts, network errors, bad JSON, and an Overpass `200` whose `remark` reports a runtime error or timeout (Overpass uses `200` plus `remark` when a query times out) are not cached. The phone gets `503` `{ "error": "upstream_busy" }` and `Retry-After` (the upstream value when it sent one, otherwise 30). The Worker retries once. On `429` or `504` the retry goes to `https://overpass.private.coffee/api/interpreter`. The upstream `User-Agent` is `shottracker-worker/1.0 (+https://shottrax-share.bcbaird.workers.dev)`.

A valid response with no golf features, and no positive copy already stored, is `404` `{ "error": "no_overlay" }`. That negative marker is stored for 6 hours at `osm:v1:none:...` and only ever answers `404`. It is not written when a positive overlay exists.

Other overlay errors: `bad_request` (400), `method_not_allowed` (405), `unknown_route` (404), `boards_not_configured` (503). No new secrets, env vars, or KV namespaces.

### Attribution

Overlays are OpenStreetMap data, © OpenStreetMap contributors, under the Open Database License (ODbL). Apps must show **© OpenStreetMap contributors** wherever those overlays are drawn.

https://www.openstreetmap.org/copyright

### Check after Brian deploys

```
curl -D - "https://shottrax-share.bcbaird.workers.dev/osm/v1/overlay?courseId=2fa21943-abaa-43a4-a90f-cb06c82216b4&lat=33.1940935&lng=-93.2077463&radius=1800"
```

Magnolia Country Club, AR. Expect `200` and golf features. Run it again and expect `X-Overlay-Cache: HIT`.

`npm test` runs the worker tests (mocked fetch, KV, and cache). It does not deploy.
