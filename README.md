# shottrax-share

Cloudflare Worker for ShotTrax live boards and the course paint cache. It also proxies golf course vendor reads so the phone never holds a vendor key.

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
