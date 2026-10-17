# Friends API

Contract for anonymous friends on the ShotTraxx share Worker. The phone draft is ShotTraxx PR #533, file `src/domain/friendsApi.ts`, on that PR's branch (commit `dde1414eb8dd81e14e8b39198643e92ca60f45a4`, which put the network calls behind `FriendsApi`). This document wins. The phone will match it. This PR does not serve the routes.

PR #533 is titled Friends/Groups. This contract is friends only. It does not define groups, league membership, or chat.

## Every call

Auth is the anonymous friend key in the `X-Friend-Key` header. It is a fresh random secret the phone generates. It is not derived from the install id, and it is not a person's name.

The header value is 32 to 64 characters from `A–Z`, `a–z`, `0–9`, `_`, and `-`. The Worker rejects a missing or bad value with `401` `{ "error": "friend_key_required" }`. It also rejects that code when the value equals `X-Install-Id`, or when it has the install-id shape `id_<digits>_<base36>`. `X-Install-Id` is ignored. It is not stored.

Every friends call except `getCode` returns `401` `{ "error": "friend_key_required" }` when that key has no minted code. `getCode` is the call that mints one. Lookup checks this before it spends a guess and before it reads `fr:code:`.

The raw friend key is never written to KV and never returned. The Worker stores only SHA-256 of a fixed prefix plus the key, under an `fr:` key. Responses never include a name, email, phone, install id, or the friend key.

Request bodies are JSON objects. A field that is not in that call's allowlist, including a `null` placeholder, is `400` `{ "error": "invalid_body" }`. JSON that does not parse, a non-object, or a wrong type is the same error. The one accepted null is unshare: `{ "share": false, "round": null }`. A body over the call's size limit is `413` `{ "error": "payload_too_large" }`. The limit is 2048 bytes, except `publishRound`, which is 8192. An empty body is allowed only where this document says so.

`GET` and `POST` are the methods below, plus `PUT` for `publishRound`. `OPTIONS` is the CORS preflight: status `200`, empty body, no friend key, and no KV read or write. `OPTIONS` on an unknown `/v1/friends/*` path also returns `200`. Any other method on a known friends path is `405` `{ "error": "method_not_allowed" }`. A path under `/v1/friends` that this document does not list is `404` `{ "error": "unknown_route" }`. Existing `/v1/course-reports` is unchanged.

If `BOARDS` is not bound, a call that needs it is `503` `{ "error": "boards_not_configured" }`. Code lookup (and later `sendRequest`, which uses that lookup) needs the guess limiter. If that binding is missing, the call fails closed with `503` `{ "error": "guess_limiter_not_configured" }` and does not read the code.

Responses are JSON, `Cache-Control: no-store`. A limited call also sends `Retry-After` in seconds. CORS for `/v1/friends` allows `GET, POST, PUT, OPTIONS` and the headers `Content-Type` and `X-Friend-Key`, and also `X-Install-Id`.

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

Does not count as a guess. Does not require the guess limiter when `CF-Connecting-IP` is absent. When that header is present, `getCode` allows 30 calls per IP hash per 60 minutes. That counter is a separate `FriendGuessLimiter` object whose name starts with `ipget:`, not the 24-lookup IP object. A missing limiter fails closed with `guess_limiter_not_configured` and does not mint. A missing key, a bad key, or `invalid_body` does not consume one of the 30. Over the limit is `429` `{ "error": "rate_limited" }` and `Retry-After`.

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

Deletes the friendship (both `fr:friend:` rows and both `fr:friends:` lists) and deletes only the caller's shared rounds. The other person's rounds stay for their remaining friends. Fetch no longer returns the caller's rounds to anyone.

This is Brian's approved behavior as of Oct 17, 2026, 5:37 PM CT. It replaces his earlier answer that remove and block wipe both people's shared rounds for every friend. There is no per-friend share list.

`200` `{ "ok": true }`

No accepted friendship: `409` `{ "error": "not_friends" }`.

### block

`POST /v1/friends/block`

```json
{ "ownerId": "<the other person>" }
```

The phone's `id` is this `ownerId`.

Requires an accepted friendship (both `fr:friend:` rows). Otherwise `409` `{ "error": "not_friends" }` and nothing is written: no block row and no round delete. A key that only learned an `ownerId` from lookup cannot block that person.

The block row is stored first. Then the friendship rows and both friend lists are deleted, then pending request rows, then only the caller's round list. A failure after the block row is stored must not leave the pair with the friendship already gone and no block. The other person's rounds stay for their remaining friends. Access ends immediately. The block is stored for the caller. Same as remove: caller-only round deletion is Brian's approved behavior as of Oct 17, 2026, 5:37 PM CT, replacing the earlier both-people answer.

`200` `{ "ok": true }`

The blocked person gets no notice. Their later `sendRequest` and `accept` behave as in those sections: same status and body as if they were not blocked. This call is not the guess limiter's block operation.

### unblock

`POST /v1/friends/unblock`

```json
{ "ownerId": "<the other person>" }
```

The phone's `id` is this `ownerId`. Auth, body allowlist, and size limit are the same as block.

Deletes only the caller's stored block on that person. It does not restore a friendship, and it does not recreate a request: the quiet block stored nothing, so there is nothing to bring back. It does not touch a block the other person holds on the caller. Rounds deleted by block stay deleted.

`200` `{ "ok": true }`

Unblocking someone the caller has not blocked, or an `ownerId` that does not exist, is the same `200` `{ "ok": true }` with nothing written. The response does not reveal whether a block or a person existed.

After unblock, the caller's `sendRequest` to that person no longer returns `blocked`. To be friends again, the caller sends a new request with the normal add flow, and the other person accepts it. After unblock, a request from the person who was blocked is stored as a real pending request the caller can accept. It is no longer quietly dropped. Neither side has a friendship or a pending request until a new request is sent.

Does not count as a guess, does not read a code, and does not require the guess limiter. This call is not the guess limiter's reset operation.

### publishRound

`PUT /v1/friends/rounds`

The body is `{ "share", "round" }`, at most 8192 bytes. No other fields.

Publish when sharing is on:

```json
{ "share": true, "round": { "id": "round_7Kp2", "courseName": "Greystone", "playedOn": "2026-10-11", "gross": 82, "toPar": 10, "holes": [] } }
```

`round` uses the shared-round allowlist. The Worker sets `ownerId` from the friend key. A client `ownerId` must match that id or the body is `invalid_body`. The same `id` replaces the previous round and refreshes the 365-day TTL on that owner's one round-list value.

An owner can store 100 shared rounds. A new `id` past that cap is `409` `{ "error": "round_limit" }` and stores nothing. Replacing an existing `id` is still allowed at the cap. The cap is checked before the per-IP publish limit, so a full list returns `round_limit` rather than `rate_limited`.

When `CF-Connecting-IP` is present, publish and unshare share a limit of 60 calls per IP hash per 60 minutes. That counter is a separate `FriendGuessLimiter` object whose name starts with `ippub:`. It is not the code-guess counter. A missing limiter fails closed with `guess_limiter_not_configured` and does not write. No IP header skips this limit. `invalid_body` does not consume one of the 60. Over the limit is `429` `{ "error": "rate_limited" }` and `Retry-After`.

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

Each entry is a stored round from an accepted friend, plus the caller's own published rounds. Rounds the caller removed, blocked, or unshared are already gone. The other person's rounds are not deleted by remove or block, so that person's other friends still fetch them. Omitted stat fields stay omitted. A stored round that fails the allowlist, including one that carries GPS, is omitted on read. The response is the full list. There is no cursor. Rounds are sorted by `playedOn`, then `ownerId`, then `id`, ascending.

Fetch reads `3 + 2N + F` KV values and does not list. `N` is the caller's friend-list length. `F` is how many of those friends are unblocked in both directions (`F` ≤ `N`). The reads are 1 auth row, 1 `fr:friends:` list, 1 own `fr:rounds:` value, 2 block checks per friend, and 1 round-list read per unblocked friend. When nobody is blocked, that is `3 + 3N` gets.

## Code lookup

`POST /v1/friends/codes/lookup`

```json
{ "code": "AB3K7NP2" }
```

This is the resolve `sendRequest` uses. Both calls share one guess counter per friend key and one per IP. The friend key must already have a minted code, or the call is `401` `{ "error": "friend_key_required" }` and does not spend a guess.

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
| IP hash, `getCode` (`ipget:`) | 30 calls | 60 minutes |
| IP hash, `publishRound` including unshare (`ippub:`) | 60 calls | 60 minutes |

Either lookup limit returns `rate_limited`. The window is from the first counted lookup in the current window. `Retry-After` is the seconds left in that window. After the window, the next lookup starts at 1.

The 8-guess per-key limit is easy to get around by rotating friend keys. The 24-per-hour per-IP limit is the real control. `getCode` and `publishRound` do not spend either guess counter. They use their own per-IP objects on the same `FriendGuessLimiter` class and the same `FRIEND_GUESSES` binding.

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
| `courseName` | String, already trimmed, 1–200 characters. ASCII control characters (U+0000–U+001F and U+007F) are rejected. |
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
| `clubs` | Array of 1–8 strings. Each string matches `^[A-Za-z0-9][A-Za-z0-9 +./-]{0,7}$` (1–8 characters; a letter or digit, then letters, digits, space, `+`, `.`, `/`, or `-`). Present only when club sharing is on. |

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

League scores are these shared rounds. The Worker keeps one owner's rounds in one KV value for up to 1 year (`expirationTtl` of 365 days) or until `remove`, `block`, or unshare (`share: false` with `round: null`) deletes it, whichever comes first. Replacing a round refreshes that TTL. Text filtering for league titles and report notes is not part of this contract. Those fields are unknown today. Filtering comes later.

An accepted friendship is capped at 50 friends per owner. `accept` checks both `fr:friends:` lists before it writes. If either person would go past 50, the call is `409` `{ "error": "friend_limit" }`, the pending request stays, and no friendship row is written.

## Storage

Friend rows use the `fr:` prefix only. The keys this API writes are:

- `fr:k:<sha256>` — `{ "ownerId", "code" }` for the friend key. No name and no raw key.
- `fr:code:<CODE>` — the `ownerId` string. `resetCode` deletes the old key before it responds.
- `fr:req:<recipient>:<requester>` — a pending request. The value is `pending`.
- `fr:friend:<a>:<b>` — one direction of an accepted friendship. The value is `1`. Both directions are required.
- `fr:friends:<ownerId>` — JSON array of the other owner ids. This is the fetch index and the 50-friend cap. `accept` writes both lists. `remove` and `block` take the other person out of both lists.
- `fr:block:<blocker>:<blocked>` — the caller's block. The value is `1`.
- `fr:rounds:<ownerId>` — JSON array of that owner's shared rounds, one value, `expirationTtl` of 365 days. This replaces per-round `fr:round:<owner>:<id>` keys.

None of these routes read or write `id:`, `name:`, `osm:`, `gq:`, `gapi:`, `gqueue:`, `gca:`, or `cr:`. Board `GET`, `PUT`, and `DELETE` reserve the `fr:` prefix and return `400` with no KV read or write. That includes a percent-encoded path (`fr%3A` and `fr%3a`), so a board path cannot read, replace, or forge a friend row. Guess counts live in the Durable Object, not in KV.

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
| `unblock(id)` | `POST /v1/friends/unblock` with `{ ownerId }` |
| `publishRound({ round, share })` | `PUT /v1/friends/rounds`. `share: true` and a round publishes it. `share: false` and `round: null` unshares and deletes the caller's shared rounds. |
| `fetchRounds()` | `GET /v1/friends/rounds` → `{ rounds }` |

`off` is the phone switch. No request is sent. `todo` is a call the phone has not finished, or a server that is not ready: `unknown_route`, `boards_not_configured`, `guess_limiter_not_configured`. `refused` is every other error: `friend_key_required`, `invalid_body`, `payload_too_large`, `method_not_allowed`, `code_not_found`, `not_friends`, `friend_limit`, `round_limit`, `rate_limited`, and `blocked`.

`blocked` is returned only to the person who blocked, and the phone maps it to `refused`, the same reason it uses for `code_not_found` and `not_friends`. The blocked person never receives `blocked`. Their `sendRequest` is the normal `200` pending body, and their `accept` is `not_friends`. That is a success or a `refused`, not a block.
