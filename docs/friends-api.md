# Friends API

Contract for anonymous friends on the ShotTraxx share Worker. The phone draft is ShotTraxx PR #533, file `src/domain/friendsApi.ts`, on that PR's branch (commit `dde1414eb8dd81e14e8b39198643e92ca60f45a4`, which put the network calls behind `FriendsApi`). This document wins. The phone will match it. This PR does not serve the routes.

PR #533 is titled Friends/Groups. This contract is friends only. It does not define groups, league membership, or chat.

## Every call

Auth is the anonymous friend key in the `X-Friend-Key` header. It is a fresh random secret the phone generates. It is not derived from the install id, and it is not a person's name.

The header value is 32 to 64 characters from `A–Z`, `a–z`, `0–9`, `_`, and `-`. The Worker rejects a missing or bad value with `401` `{ "error": "friend_key_required" }`. It also rejects that code when the value equals `X-Install-Id`, or when it has the install-id shape `id_<digits>_<base36>`. `X-Install-Id` is ignored. It is not stored.

The raw friend key is never written to KV and never returned. The Worker stores only SHA-256 of a fixed prefix plus the key, under an `fr:` key. Responses never include a name, email, phone, install id, or the friend key.

Request bodies are JSON objects. A field that is not in that call's allowlist, including a `null` placeholder, is `400` `{ "error": "invalid_body" }`. JSON that does not parse, a non-object, or a wrong type is the same error. The one accepted null is unshare: `{ "share": false, "round": null }`. A body over the call's size limit is `413` `{ "error": "payload_too_large" }`. The limit is 2048 bytes, except `publishRound`, which is 8192. An empty body is allowed only where this document says so.

`GET` and `POST` are the methods below, plus `PUT` for `publishRound`. `OPTIONS` is the CORS preflight: status `200`, empty body, no friend key, and no KV read or write. Any other method on a known friends path is `405` `{ "error": "method_not_allowed" }`. A path under `/v1/friends` that this document does not list is `404` `{ "error": "unknown_route" }`. Existing `/v1/course-reports` is unchanged.

If `BOARDS` is not bound, a call that needs it is `503` `{ "error": "boards_not_configured" }`. Code lookup (and later `sendRequest`, which uses that lookup) needs the guess limiter. If that binding is missing, the call fails closed with `503` `{ "error": "guess_limiter_not_configured" }` and does not read the code.

Responses are JSON, `Cache-Control: no-store`. A limited call also sends `Retry-After` in seconds. CORS for `/v1/friends` allows `GET, POST, PUT, OPTIONS` and the headers `Content-Type` and `X-Friend-Key`.

## Friend codes

Eight characters from the same unambiguous alphabet as live board codes: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0`, `1`, `I`, or `O`). The Worker stores codes in uppercase. Lookup accepts spaces and hyphens, then compares the compact uppercase form. Any other shape is `invalid_body` and does not count as a guess.

`getCode` mints a code the first time a friend key is seen and returns the same code after that. `resetCode` replaces it. The old code stops resolving on that request, before the response is sent. There is no grace period.

The public id in round payloads is `ownerId`, 128 random bits encoded as 22 unpadded base64url characters (`A–Z`, `a–z`, `0–9`, `-`, `_`), not the friend key. `resetCode` keeps `ownerId`.

## Calls

### getCode

`POST /v1/friends/code`

Body: empty, or `{}`. No other fields.

`200`

```json
{ "code": "AB3K7NP2", "ownerId": "k3mR9xQ2nB8wL4pT6vYs1A" }
```

Does not count as a guess. Does not require the guess limiter.

### resetCode

`POST /v1/friends/code/reset`

Body: empty, or `{}`.

The friend key must already have a code. Otherwise `401` `{ "error": "friend_key_required" }`.

`200` with the new `code` and the same `ownerId`. The previous code then looks up as `404` `{ "error": "code_not_found" }`. Does not count as a guess, and does not clear the guess counter.

### sendRequest

`POST /v1/friends/requests`

```json
{ "code": "AB3K7NP2" }
```

`name` is not a field. The phone keeps that nickname on the device. Sending `name` is `invalid_body`.

Performs the code lookup below, including the guess limit. A limited caller gets `rate_limited` and is not told whether the code exists.

A real code that is not the caller, and no block in either direction, stores a pending request. Access does not start here. The other person must accept.

`200` `{ "status": "pending", "ownerId": "<their ownerId>" }`

Already friends: `200` `{ "status": "friends", "ownerId": "<their ownerId>" }` and no second request is stored. A pending request that is already stored returns the same `200` pending body and does not store a second row.

The caller's own code is `400` `{ "error": "invalid_body" }`. That check is made before the guess limiter and does not consume a guess.

Quiet block: if the target has blocked the caller, the response is the same `200` pending body as a real request. Nothing is stored for the target to accept, and the body is not `blocked`. If the caller has blocked the target, the caller gets `409` `{ "error": "blocked" }`. They already know.

### accept

`POST /v1/friends/requests/accept`

```json
{ "ownerId": "<the requester>" }
```

The phone's `id` is this `ownerId`. `name` is not a field.

Only the recipient of a pending request can accept. That creates the friendship.

`200` `{ "status": "friends", "ownerId": "<the requester>" }`

No pending request: `409` `{ "error": "not_friends" }`. The caller already blocked that person: `409` `{ "error": "blocked" }`. The caller is the one who was blocked: the same `not_friends` response as when there was never a request. No `blocked` signal. There is no decline call. A pending request stays pending until the recipient accepts or blocks.

### remove

`POST /v1/friends/remove`

```json
{ "ownerId": "<the other person>" }
```

The phone's `id` is this `ownerId`.

Deletes the friendship and deletes shared rounds on both sides in that request. Fetch no longer returns those rounds.

`200` `{ "ok": true }`

No accepted friendship: `409` `{ "error": "not_friends" }`.

### block

`POST /v1/friends/block`

```json
{ "ownerId": "<the other person>" }
```

The phone's `id` is this `ownerId`.

Same deletion as remove: both sides' shared rounds are deleted in that request, and access ends immediately. The block is stored for the caller.

`200` `{ "ok": true }`

The blocked person gets no notice. Their later `sendRequest` and `accept` behave as in those sections: same status and body as if they were not blocked. This call is not the guess limiter's block operation.

### publishRound

`PUT /v1/friends/rounds`

The body is `{ "share", "round" }`, at most 8192 bytes. No other fields.

Publish when sharing is on:

```json
{ "share": true, "round": { "id": "round_7Kp2", "courseName": "Greystone", "playedOn": "2026-10-11", "gross": 82, "toPar": 10, "holes": [] } }
```

`round` uses the shared-round allowlist. The Worker sets `ownerId` from the friend key. A client `ownerId` must match that id or the body is `invalid_body`. The same `id` replaces the previous round.

`200` `{ "ok": true, "id": "<round id>" }`

Unshare and delete:

```json
{ "share": false, "round": null }
```

Deletes the caller's shared rounds in that request. The next fetch does not include them.

`200` `{ "ok": true }`

`share: false` with a round, `share: true` with `null`, or a `name` field is `invalid_body`.

Friends can fetch a published round only after they have accepted. Publishing does not make a pending request into a friendship.

### fetchRounds

`GET /v1/friends/rounds`

No body.

`200` `{ "rounds": [ ] }`

Each entry is a stored round from an accepted friend, plus the caller's own published rounds. Rounds removed or blocked are already gone. Omitted stat fields stay omitted. The response is the full list. There is no cursor.

## Code lookup

`POST /v1/friends/codes/lookup`

```json
{ "code": "AB3K7NP2" }
```

This is the resolve `sendRequest` uses. Both calls share one guess counter per friend key and one per IP.

`200` `{ "ownerId": "<public id>" }`

Unknown code, including a code that `resetCode` just replaced: `404` `{ "error": "code_not_found" }`.

Over the guess limit, or a guesser the limiter has blocked: `429` `{ "error": "rate_limited" }` and `Retry-After`. The body has no other field. The Worker does not look up the code on that request, so the response does not reveal whether it exists.

A bad code shape or an unknown field is `invalid_body` and does not consume a guess. A hit and a miss both consume one.

## Guess limit

The count is exact and applies on the request that crosses it. It is not a KV counter and it is not the Workers Rate Limiting binding (that binding is per location, eventually consistent, and has no reset or block).

One SQLite-backed Durable Object, class `FriendGuessLimiter`, binding `FRIEND_GUESSES`. One object per friend-key hash and one per IP hash (`CF-Connecting-IP`, stored only as SHA-256 with a fixed prefix, never the raw IP). The check and the increment run in one `transactionSync` on that object.

| Subject | Limit | Window |
|---|---|---|
| Friend key | 8 lookups | 60 minutes |
| IP hash, when `CF-Connecting-IP` is present | 24 lookups | 60 minutes |

Either limit returns `rate_limited`. The window is from the first counted lookup in the current window. `Retry-After` is the seconds left in that window. After the window, the next lookup starts at 1.

The object supports three operations. Only `attempt` is used by lookup. The other two exist so a later step can clear or stop a guesser without an eventually consistent counter:

- `attempt` counts one lookup and reports whether it is allowed.
- `reset` clears the count and clears a limiter block, immediately.
- `block` rejects further attempts immediately. The HTTP response is still `rate_limited`, never `blocked`.

`resetCode` does not call limiter `reset`.

## Shared round

Allowlist at the top level: `id`, `ownerId`, `courseName`, `playedOn`, `gross`, `toPar`, `holes`.

| Field | Rule |
|---|---|
| `id` | String, 1–64 characters, `[A-Za-z0-9_-]`. |
| `ownerId` | The publisher's public id. |
| `courseName` | String, trimmed, 1–200 characters. |
| `playedOn` | `YYYY-MM-DD`. |
| `gross` | Integer, 1–200. |
| `toPar` | Integer, −40 through 200. |
| `holes` | Array of 1–18 objects. Each `hole` is an integer from 1 to 18, and the numbers are unique. A nine-hole round does not have to include holes 10–18. |

Each hole allowlist: `hole`, `score`, `par`, and the optional stats below.

| Field | Rule |
|---|---|
| `hole` | Integer, 1–18. |
| `score` | Integer, 1–20. |
| `par` | Integer, 3–6. |
| `fir` | Boolean. Present only when the golfer turned FIR sharing on. |
| `gir` | Boolean. Present only when GIR sharing is on. |
| `putts` | Integer, 0–10. Present only when putts sharing is on. |
| `clubs` | Array of 1–8 strings. Each string is 1–8 characters. Present only when club sharing is on. |

`fir`, `gir`, `putts`, and `clubs` live on the hole. When that share switch is off, the field is omitted on every hole. The Worker does not store or return `null` for it. A present `null` is `invalid_body`. A switch can be on while a single hole omits the stat (no fairway, no putts entered). The Worker never fills the hole in.

No GPS, photos, or names, on the round or on a hole. `lat`, `lon`, `lng`, `gps`, `photo`, `photos`, `name`, `playerName`, `email`, and any other key not in the allowlist are `invalid_body`.

Example with FIR and putts on, and GIR and clubs off:

```json
{
  "id": "round_7Kp2",
  "ownerId": "k3mR9xQ2nB8wL4pT6vYs1A",
  "courseName": "Greystone",
  "playedOn": "2026-10-11",
  "gross": 82,
  "toPar": 10,
  "holes": [
    { "hole": 1, "score": 4, "par": 4, "fir": true, "putts": 2 },
    { "hole": 2, "score": 6, "par": 5, "fir": false, "putts": 2 }
  ]
}
```

League scores are these shared rounds. The Worker keeps one for up to 1 year (`expirationTtl` of 365 days) or until `remove`, `block`, or unshare (`share: false` with `round: null`) deletes it, whichever comes first. Text filtering for league titles and report notes is not part of this contract. Those fields are unknown today. Filtering comes later.

## Storage

Friend rows use the `fr:` prefix only. The keys this API writes are:

- `fr:k:<sha256>` — `{ "ownerId", "code" }` for the friend key. No name and no raw key.
- `fr:code:<CODE>` — the `ownerId` string. `resetCode` deletes the old key before it responds.
- `fr:req:`, `fr:friend:`, and `fr:round:` — requests, accepted friendships, and rounds, when those calls are built.

None of these routes read or write `id:`, `name:`, `osm:`, `gq:`, `gapi:`, `gqueue:`, `gca:`, or `cr:`. Board `GET` / `PUT` / `DELETE` still refuse `fr:`, so a board path cannot read a friend row. Guess counts live in the Durable Object, not in KV.

## Phone draft differences

ShotTraxx PR #533 `src/domain/friendsApi.ts` returns `FriendsApiResult` on every call: `{ ok: true, snapshot }` with `{ code, people, rounds }`, or `{ ok: false, reason }` where `reason` is `todo`, `off`, or `refused`. The contract wins. The server does not return that snapshot. Each call returns only its own body. The phone builds `{ code, people, rounds }` on the device. `people` and nicknames never come from the server.

`name` on `sendRequest` and `accept` is a local nickname. The phone keeps it on the device and does not send it. The server rejects a `name` field with `400` `{ "error": "invalid_body" }`. The phone's `id` is the server's `ownerId`.

| Phone call | Contract |
|---|---|
| `getCode()` | `POST /v1/friends/code` → `{ code, ownerId }` |
| `resetCode()` | `POST /v1/friends/code/reset` → `{ code, ownerId }` |
| `sendRequest({ code, name })` | `POST /v1/friends/requests` with `{ code }` only |
| `accept({ id, name })` | `POST /v1/friends/requests/accept` with `{ ownerId }` only |
| `remove(id)` | `POST /v1/friends/remove` with `{ ownerId }` |
| `block(id)` | `POST /v1/friends/block` with `{ ownerId }` |
| `publishRound({ round, share })` | `PUT /v1/friends/rounds`. `share: true` and a round publishes it. `share: false` and `round: null` unshares and deletes the caller's shared rounds. |
| `fetchRounds()` | `GET /v1/friends/rounds` → `{ rounds }` |

`off` is the phone switch. No request is sent. `todo` is a call the phone has not finished, or a server that is not ready: `unknown_route`, `boards_not_configured`, `guess_limiter_not_configured`. `refused` is every other error: `friend_key_required`, `invalid_body`, `payload_too_large`, `method_not_allowed`, `code_not_found`, `not_friends`, `rate_limited`, and `blocked`.

`blocked` is returned only to the person who blocked, and the phone maps it to `refused`, the same reason it uses for `code_not_found` and `not_friends`. The blocked person never receives `blocked`. Their `sendRequest` is the normal `200` pending body, and their `accept` is `not_friends`. That is a success or a `refused`, not a block.
