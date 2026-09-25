# shottrax-share

Cloudflare Worker for ShotTraxx live boards and the course paint cache. It also proxies golf course vendor reads so the phone never holds a vendor key, and it returns raw plays-like measurements (elevation and wind). The phone computes any adjusted yardage.

Live boards stay `GET` / `PUT` on a single path segment in the `BOARDS` KV namespace. Paint cache keys start with `id:` or `name:`.

If `env.BOARDS` is not bound, those routes return `503` `{ "error": "boards_not_configured" }` instead of throwing. Golf proxy routes are unchanged.

## Boards KV

`wrangler.toml` binds `BOARDS` to the existing namespace `shottrax-boards` (`cfa1824a10374ab6a7fa0c97d0990e80`). The next `wrangler deploy` must keep that id so it does not drop the dashboard binding. No `preview_id` is set.

Board and paint-cache keys are stored only while that binding is present on the live Worker. If it is missing, those routes return `503` `{ "error": "boards_not_configured" }`.

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

## Plays-like lookup

`GET /playslike/v1?from=LAT,LNG&to=LAT,LNG` returns raw measurements for the shottracker plays-like calculation. `from` is the player and `to` is the green point. This route is handled before share-board key parsing, so it is never stored as a board code. No API key is required. Coordinates are not logged.

The Worker does not guess. If a source fails, that field is `null` and the response includes a reason (`elevation_error` or `wind_error`). It does not compute adjusted yardage.

Incoming coordinates must be finite decimals, latitude -90..90, longitude -180..180. Invalid coordinates return `400` `{ "error": "bad_coords" }`. `from` and `to` more than 1000 yards apart (great-circle) return `400` `{ "error": "too_far" }`. Any method other than GET returns `405` `{ "error": "method_not_allowed" }`. Coordinates are rounded to 5 decimal places before any upstream call or cache key.

| Measurement | Source | Cache |
|---|---|---|
| Elevation at both points | [USGS EPQS](https://epqs.nationalmap.gov/v1/json) (`x` = longitude, `y` = latitude, `wkid=4326`, meters) first. A non-numeric value, the `-1000000` no-data sentinel, or any value below -500 is a miss. On miss, error, or a 2.5s timeout, both points are read from [Open-Meteo elevation](https://api.open-meteo.com/v1/elevation). | 30 days in the edge cache (`caches.default`), per rounded point, stored separately for each dataset |
| Wind at `to` | [Open-Meteo forecast](https://api.open-meteo.com/v1/forecast) current `wind_speed_10m`, `wind_direction_10m`, and `wind_gusts_10m` with `wind_speed_unit=mph` | 10 minutes, keyed by the point rounded to 2 decimals |

Both elevations always come from the same dataset. If USGS returns a value for only one of the two points, Open-Meteo is used for both so the height difference does not mix sources. If neither source can supply both points, `elevation_m`, `elevation_delta_m`, and `elevation_source` are null.

`elevation_delta_m` is the measured `to` elevation minus `from`, in meters. `elevation_source` is `"usgs"`, `"open-meteo"`, or `null`.

Wind direction `from_deg` is meteorological: degrees the wind comes from. The wind object repeats that as `from_deg_meaning`. `source` is `"open-meteo"`. `observed_at` is the upstream observation time, unchanged.

The phone response uses `Cache-Control: no-store` and the same CORS headers as the other routes. Status is 200 when at least one of elevation or wind is present. Status is 502 only when both fail entirely. Partial data is returned with nulls rather than a fabricated number.

```
npm test
```
