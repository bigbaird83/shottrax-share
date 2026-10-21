# Friends API

Contract for anonymous friends on the ShotTraxx share Worker. The phone draft is ShotTraxx PR #533, file `src/domain/friendsApi.ts`, on that PR's branch (commit `dde1414eb8dd81e14e8b39198643e92ca60f45a4`, which put the network calls behind `FriendsApi`). This document wins. The phone will match it. The Worker serves the calls in this document.

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

`200` with the new `code` and the same `ownerId`. The previous code then looks up as `404` `{ "error": "code_not_found" }`. Does not count as a guess, and does not clear the guess counter. The invite name stored with the previous code (`fr:invname:<old CODE>`) and the invite photo (`fr:invphoto:<old CODE>`) are deleted on the same request. Neither is copied to the new code.

### setInviteName

`POST /v1/friends/code/name`

```json
{ "name": "Alex M." }
```

The sharer's name for this invite. It is stored with the caller's current code and is never part of the link or the URL. Whitespace runs collapse to one space and the ends are trimmed. 1 to 24 characters, no control characters, else `400` `{ "error": "invalid_body" }`. `null`, `""` or all spaces deletes it. A key with no code is `401`. `200` `{ "ok": true }`. Not a guess and not rate limited beyond the normal key check.

The name is returned only by code lookup (below), when someone opens the link or types the code. `getCode`, `resetCode`, the lists and `fetchRounds` never carry it. It is invite-only: it changes nothing about what is shared.

### setInvitePhoto

`POST /v1/friends/code/photo`

```json
{ "photo": { "type": "image/jpeg", "data": "<base64>" } }
```

The sharer's optional photo for this invite, stored with the caller's current code at `fr:invphoto:<CODE>` and never part of the link or URL. Cap: `type` must be `image/jpeg` (else `415` `{ "error": "photo_type" }`), `data` is standard base64 of a JPEG (starts `FF D8 FF`) of at most 64 KB decoded (else `413` `{ "error": "photo_too_large" }`). Body cap 96 KB. Other shapes are `400`. `{ "photo": null }` deletes it. A key with no code is `401`. `200` `{ "ok": true }`.

Returned only by code lookup as `photo` next to `name`. `resetCode` deletes it from the server. A copy the friend already saved on their phone is theirs and is not affected.

### putLive / fetchLive / stopLive (live rounds for friends)

`PUT /v1/friends/live`

```json
{ "courseName": "Pine Hollow GC", "hole": 7, "holes": [ { "hole": 1, "score": 5, "par": 4 } ] }
```

Your round in progress, for friends. `hole` is the current hole (1 to 18). `holes` (0 to 18) use the publishRound hole allowlist: `score` and `par` always, and `fir`, `gir`, `putts` and `clubs` only when the phone's Round stats and Club averages switches are on. GPS, position or any other field is `400`. Stored at `fr:live:<ownerId>` with `updatedAt`, and replaced on every update. KV TTL is 30 minutes. The phone sends it only while "Share live rounds with friends" is on and that round is shared. Rate limited on the `iplive:` IP counter (240 per hour, shared with fetchLive). `200` `{ "ok": true }`.

`GET /v1/friends/live` returns `200` `{ "live": [ { "ownerId", "courseName", "hole", "toPar", "holes", "updatedAt" } ] }`: only accepted friends both ways, not blocked either way, whose row was updated in the last 30 minutes. `toPar` is worked out from `holes`. Your own row, non-friends' rows and anything older than 30 minutes are never returned.

`POST /v1/friends/live/stop` (empty body) deletes your row: at round finish, when the switch is turned off, or when "Friends can follow" is tapped. `200` `{ "ok": true }`.

### setPastRounds

`PUT /v1/friends/past`

```json
{ "ownerId": "<friend>", "choice": "10", "rounds": [ { "id": "...", "courseName": "...", "playedOn": "2025-04-01", "gross": 84, "toPar": 12, "holes": [ ] } ] }
```

The caller's own past rounds for one accepted friend. `choice` is `"none"`, `"10"`, `"25"` or `"all"`. `rounds` may hold at most 0, 10, 25 or 100 (`ROUND_CAP`) entries for those choices. Each round passes the same allowlist as `publishRound`, so GPS, names and unknown fields are `400`. Body cap 256 KB. Not friends both ways: `409` `{ "error": "not_friends" }`. Rate limited on the `ippub:` IP counter. `200` `{ "ok": true }`.

Storage: past rounds live in the owner's one `fr:rounds:<ownerId>` value with a private audience `to: [ownerIds]`. A call first takes this friend off every past round (a past round with no audience left is deleted), then adds the new pick. So a lower choice, or `"none"`, deletes the rounds that no longer fit from the Worker. A round already shared the normal way (no `to`) is visible to every friend and is left as it is. A later `publishRound` of the same id makes it a normal shared round. Counts toward the 100-round cap; over it is `409` `round_limit`.

Each side picks only for its own rounds. No call returns a choice or an audience, the caller's or the friend's: `fetchRounds` strips `to`, and there is no read route for `/past` (`GET` is `405`). Remove and block take the caller off the other side's past rounds too.

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

Quiet block: if the target has blocked the caller, the response is the same `200` pending body as a real request. The body is not `blocked`. This branch writes one sender-only note, `fr:out:<sender>:<recipient>` = `pending`, and does not write `fr:req:<recipient>:<sender>`. The note has no display name and no created time. Nothing is stored for the target to accept. A repeat send on this branch returns the same pending body and does not write a second note. If the caller has blocked the target, the caller gets `409` `{ "error": "blocked" }`. They already know. A block row alone is not a request. `GET /v1/friends/requests` does not invent an outgoing entry from `fr:block:*`.

That note is written only after the code guess is spent, same as a real request. First quiet send to that pair: 5 gets and 1 put. The gets are the auth row, `fr:code:<CODE>`, `fr:block:<caller>:<recipient>`, `fr:block:<recipient>:<caller>`, and `fr:out:<caller>:<recipient>`. The put is that note. The value is `pending`. There is no `expirationTtl`. No delete and no list. This path does not read or write `fr:req:`, `fr:friend:`, `fr:friends:`, or `fr:rounds:`. A repeat quiet send is the same 5 gets and no put when the note is already a non-empty string. A `rate_limited` send returns before the code read and writes no note, same as a real send.

A later real send to that same person (no block, including the already-friends response and a send that finds an existing `fr:req:`) deletes `fr:out:<caller>:<recipient>` without reading it. That is one delete on the non-blocked send path. The sender's outgoing entry does not disappear: it is the real row, or the person is already a friend.

### listRequests

`GET /v1/friends/requests`

No body. `Content-Length` greater than 0 is `400` `{ "error": "invalid_body" }`. `Content-Length` greater than 2048 is `413` `{ "error": "payload_too_large" }`. A non-empty body with no `Content-Length` is the same `invalid_body`. Empty, or `Content-Length: 0`, is allowed.

Auth is `X-Friend-Key`, the same as the other friends routes. A missing or bad key, or a key with no minted code, is `401` `{ "error": "friend_key_required" }`. Those failures do not consume the read limit below and do not list KV.

`200`

```json
{
  "incoming": [ { "ownerId": "p9Lq2mZ8nB4wK6tR1vYs0C" } ],
  "outgoing": [ { "ownerId": "k3mR9xQ2nB8wL4pT6vYs1A" } ]
}
```

`incoming` is pending requests other people sent the caller. `outgoing` is pending requests the caller sent: `fr:req:<recipient>:<caller>` rows and the caller's own `fr:out:<caller>:<recipient>` notes. Each entry is the other person's `ownerId` only. The stored row is the string `pending`. It has no display name and no created time, so this route does not add those fields. The raw value is not returned. A friend code, a friend key, a raw KV key, and anyone who is not the other party of that request are not returned.

A requester the caller has blocked is left out of `incoming`. A stored outgoing `fr:req:` row is still returned to the sender when the recipient has a block row. A quiet-block note is returned in that same `outgoing` array, in the same `{ "ownerId" }` shape, in the same `ownerId` sort. Hiding either one would tell the sender they were blocked. Incoming reads `fr:req:` only. A note is not an incoming row. `listFriends`, `fetchRounds`, accept, block, unblock, and remove do not read `fr:out:`.

Sort: `incoming` and `outgoing` are each sorted by `ownerId` ascending, using JavaScript string order (UTF-16 code units). `ownerId` is unique in each list. A note and a real row for the same person are one entry. There is no cursor. The response is the full set of stored rows this scan can see.

KV reads, no KV writes. One list of prefix `fr:req:` (the requester id is the key suffix, so a per-caller prefix cannot see outgoing rows) and one list of prefix `fr:out:<caller>:`. Formula: `1 + I + B + O + Q` gets and `P + S` lists. `P = max(1, ceil(R / 1000))` is the number of `fr:req:` list pages, and `R` is every `fr:req:` key in `BOARDS`. `S = max(1, ceil(N / 1000))` is the number of `fr:out:<caller>:` list pages, and `N` is every key with that prefix. An empty note prefix is still one list (`S = 1`). `I` is how many `fr:req:` keys name the caller as recipient (each is one value get). `B` is how many of those values are a non-empty string (each is one `fr:block:<caller>:<requester>` get). `O` is how many `fr:req:` keys name the caller as requester and someone else as recipient (each is one value get). `Q` is how many `fr:out:<caller>:` keys have a suffix that is a different owner id (each is one value get, including an empty value). The `1` is the auth row. Keys that belong to two other people are not gotten. A malformed note suffix is not gotten. No `put` and no `delete`.

The read limit is 60 calls per friend key per 60 minutes (`keyreq:` on `FriendGuessLimiter`) and 60 per IP hash per 60 minutes when `CF-Connecting-IP` is present (`ipreq:`). No IP header skips the IP limit. A missing `FRIEND_GUESSES` binding is `503` `{ "error": "guess_limiter_not_configured" }` and does not list. Over the limit is `429` `{ "error": "rate_limited" }` and `Retry-After`, and that request does not list. `invalid_body` and `payload_too_large` do not consume a call. These objects are not the code-guess, `ipget:`, or `ippub:` counters.

If `BOARDS` is missing, or it has no `list`, the call is `503` `{ "error": "boards_not_configured" }`.

### Sender-only note lifetime

A real pending request has no `expirationTtl`. It stays until the recipient accepts, or until a successful block deletes both `fr:req:` directions. There is no decline or withdraw call. Unblock, remove, and `resetCode` do not delete it. There is no cap on outstanding requests. Each send spends one code guess before the block check.

The note has that same lifetime from the sender's side. The rule is: delete the note only when a real pending request would also leave the sender's outgoing list, and only as a result of the sender's own later send or of the recipient accepting a real request.

- No `expirationTtl`. A TTL on the note alone would drop it from `outgoing` while a real request stayed. That difference is the block.
- No cancel. `POST /v1/friends/decline` stays `404` and deletes nothing, for a note and for a real request. There is no decline call.
- Unblock does not delete the note and does not copy it to `fr:req:`. Deleting it on unblock would remove the sender's outgoing entry with no action of theirs. That is how they would learn the block ended. After unblock the note is still not acceptable. A fresh `sendRequest` is required. That fresh send writes `fr:req:` and deletes the note. Outgoing still shows that `ownerId`.
- Remove does not delete the note. Remove does not delete `fr:req:` either. A quiet note exists only after the recipient has blocked the sender, so remove is `not_friends` and writes nothing, same as a pending request that was never accepted.
- A successful block does not delete the note. Block requires a friendship. While the note is the sender's only outgoing row, the two people are not friends, so block is `not_friends` and writes nothing. A real `fr:req:` row is also left in place when block refuses. Deleting the note on the blocker's later unblock or remove would change the sender's outgoing list. A real pending request does not change on those calls.
- `resetCode` does not delete the note. It does not delete `fr:req:` either, because `ownerId` is unchanged. Deleting only the note would make a quiet outgoing entry disappear on reset while a real one stayed.
- The note is deleted, without being read, when a later real send to that same person stores or finds `fr:req:<recipient>:<sender>`, including the already-friends response. Accept deletes the note key without reading it, and only after a real `fr:req:` row has already been confirmed, immediately before that row is deleted. A failed accept, including accept after unblock with no fresh send, does not delete the note and does not create a friendship. Accept never treats the note as a request.
- One note per pair, the same cardinality as one request per pair. No new cap was added. A note-only cap would reject a quiet send that a real send would store. The existing guess limits (8 per friend key and 24 per IP hash per 60 minutes) already bound how fast new notes are written. The 50-friend cap and the 100-round cap do not apply to sends. Notes are not given a separate KV bound, because real `fr:req:` rows do not have one either. A new friend key resets the 8-guess limit and can write more notes, the same way it can write more real requests.

### accept

`POST /v1/friends/requests/accept`

```json
{ "ownerId": "<the requester>" }
```

The phone's `id` is this `ownerId`. `name` is not a field.

Only the recipient of a pending request can accept. That creates the friendship.

`200` `{ "status": "friends", "ownerId": "<the requester>" }`

No pending request: `409` `{ "error": "not_friends" }`. The caller already blocked that person: `409` `{ "error": "blocked" }`. The caller is the one who was blocked: the same `not_friends` response as when there was never a request. No `blocked` signal. There is no decline call. A pending request stays pending until the recipient accepts or blocks.

Accept reads `fr:req:` only. A sender-only `fr:out:` note is not a request and cannot be accepted. On success, after the `fr:req:` row is confirmed and before that row is deleted, accept deletes `fr:out:<requester>:<recipient>` without reading it. A failed accept does not delete the note. Unblock does not turn the note into a row accept can grant.

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

Deletes only the caller's stored block on that person. It does not restore a friendship, and it does not recreate a request. A sender-only note from a quiet-block send is left in place. It is not copied to `fr:req:` and it is not deleted. It does not touch a block the other person holds on the caller. Rounds deleted by block stay deleted.

`200` `{ "ok": true }`

Unblocking someone the caller has not blocked, or an `ownerId` that does not exist, is the same `200` `{ "ok": true }` with nothing written. The response does not reveal whether a block or a person existed.

After unblock, the caller's `sendRequest` to that person no longer returns `blocked`. To be friends again, the caller sends a new request with the normal add flow, and the other person accepts it. After unblock, a request from the person who was blocked is stored as a real pending request the caller can accept. It is no longer quietly dropped. Neither side has a friendship or a pending request until a new request is sent.

Does not count as a guess, does not read a code, and does not require the guess limiter. This call is not the guess limiter's reset operation.

### listFriends

`GET /v1/friends/list`

No body. The `Content-Length` rules, auth errors, and `boards_not_configured` error match `GET /v1/friends/rounds` and listRequests. A missing limiter is `503` `{ "error": "guess_limiter_not_configured" }` and does not read the friend list.

`200`

```json
{ "friends": [ { "ownerId": "k3mR9xQ2nB8wL4pT6vYs1A" } ] }
```

Each entry is a current friend: an id in the caller's `fr:friends:` list, with both `fr:friend:` rows present (`fr:friend:<caller>:<friend>` and `fr:friend:<friend>:<caller>`). That is the accepted pair `accept` writes and the pair `remove` and `block` require. One row without the other is not a friend and is not listed. A block in either direction hides the friend, the same rule `fetchRounds` uses when it skips a friend's rounds. The response is at most 50 friends. Only the first 50 ids in the stored array are inspected, in that stored order, and ids past the cap are ignored.

`since` is the friendship's created time when a row stores one. Today each `fr:friend:` value is the string `1`, and the `fr:friends:` array is only ids, so no created time is stored. The field is omitted. An entry is `{ "ownerId" }` only. No friend code, friend key, raw KV key, name, or other person's data is returned.

Sort: `friends` is sorted by `ownerId` ascending, JavaScript string order. There is no cursor.

KV reads, no KV writes, no list. Formula: `2 + N + P + 2M` gets. `N` is the number of ids inspected, `N = min(length of fr:friends:<caller>, 50)`. `P` is how many of those have a caller→friend row, so the reverse row is read. `M` is how many have both rows, so both block rows are read (`M ≤ P ≤ N`). The `2` is the auth row and the `fr:friends:` value. A clean list, every inspected id a mutual friend whether or not a block remains, is `2 + 4N` gets. No `put` and no `delete`.

The read limit is 60 calls per friend key per 60 minutes (`keylist:`) and 60 per IP hash per 60 minutes when `CF-Connecting-IP` is present (`iplist:`). It does not share the listRequests counters, the code-guess counters, `ipget:`, or `ippub:`. No IP header skips the IP limit. Over the limit is `429` `{ "error": "rate_limited" }` and `Retry-After`, and that request does not read the friend list. A bad body does not consume a call.

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

Each entry is a stored round from an accepted friend, plus the caller's own published rounds. A friend's past round (see setPastRounds) is included only when it was given to the caller, and the `to` audience is never returned. Rounds the caller removed, blocked, or unshared are already gone. The other person's rounds are not deleted by remove or block, so that person's other friends still fetch them. Omitted stat fields stay omitted. A stored round that fails the allowlist, including one that carries GPS, is omitted on read. The response is the full list. There is no cursor. Rounds are sorted by `playedOn`, then `ownerId`, then `id`, ascending.

Fetch reads `3 + 2N + F` KV values and does not list. `N` is the caller's friend-list length. `F` is how many of those friends are unblocked in both directions (`F` ≤ `N`). The reads are 1 auth row, 1 `fr:friends:` list, 1 own `fr:rounds:` value, 2 block checks per friend, and 1 round-list read per unblocked friend. When nobody is blocked, that is `3 + 3N` gets.

## Code lookup

`POST /v1/friends/codes/lookup`

```json
{ "code": "AB3K7NP2" }
```

This is the resolve `sendRequest` uses. Both calls share one guess counter per friend key and one per IP. The friend key must already have a minted code, or the call is `401` `{ "error": "friend_key_required" }` and does not spend a guess.

`200` `{ "ownerId": "<public id>" }`, plus `"name"` when the code's owner set an invite name (`{ "ownerId": "<public id>", "name": "Alex M." }`). Also `"photo": { "type": "image/jpeg", "data": "<base64>" }` when an invite photo is set.

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
| Friend key, `GET /v1/friends/requests` (`keyreq:`) | 60 calls | 60 minutes |
| IP hash, `GET /v1/friends/requests` (`ipreq:`), when `CF-Connecting-IP` is present | 60 calls | 60 minutes |
| Friend key, `GET /v1/friends/list` (`keylist:`) | 60 calls | 60 minutes |
| IP hash, `GET /v1/friends/list` (`iplist:`), when `CF-Connecting-IP` is present | 60 calls | 60 minutes |

Either lookup limit returns `rate_limited`. The window is from the first counted lookup in the current window. `Retry-After` is the seconds left in that window. After the window, the next lookup starts at 1.

The 8-guess per-key limit is easy to get around by rotating friend keys. The 24-per-hour per-IP limit is the real control. `getCode` and `publishRound` do not spend either guess counter. They use their own per-IP objects on the same `FriendGuessLimiter` class and the same `FRIEND_GUESSES` binding. `GET /v1/friends/requests` and `GET /v1/friends/list` do not spend those counters either. Each has its own per-key object and its own per-IP object on that same class. The limit on those objects is 60 per 60 minutes, the same budget as `publishRound`.

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
- `fr:req:<recipient>:<requester>` — a pending request. The value is `pending`. No `expirationTtl`.
- `fr:out:<sender>:<recipient>` — a sender-only note for a quiet-block send. The value is `pending`. No `expirationTtl`. Not a request. Incoming scans, accept, `listFriends`, `fetchRounds`, block, unblock, and remove do not read it. `fr:` stays reserved, so a board path cannot read or write this key.
- `fr:friend:<a>:<b>` — one direction of an accepted friendship. The value is `1`. Both directions are required.
- `fr:friends:<ownerId>` — JSON array of the other owner ids. This is the fetch index and the 50-friend cap. `accept` writes both lists. `remove` and `block` take the other person out of both lists.
- `fr:block:<blocker>:<blocked>` — the caller's block. The value is `1`.
- `fr:rounds:<ownerId>` — JSON array of that owner's shared rounds, one value, `expirationTtl` of 365 days. This replaces per-round `fr:round:<owner>:<id>` keys. A past round carries `to: [ownerIds]`, the friends it was given to.
- `fr:invname:<CODE>` — the invite name for that code, a plain string of 1–24 characters. `resetCode` deletes it with the old code.

None of these routes read or write `id:`, `name:`, `osm:`, `gq:`, `gapi:`, `gqueue:`, `gca:`, or `cr:`. `GET /v1/friends/requests` and `GET /v1/friends/list` do not `put` or `delete` any KV key. The only mutation on those calls is the Durable Object attempt counter. Board `GET`, `PUT`, and `DELETE` reserve the `fr:` prefix and return `400` with no KV read or write. That includes a percent-encoded path (`fr%3A` and `fr%3a`), so a board path cannot read, replace, or forge a friend row. Guess counts live in the Durable Object, not in KV.

## Phone draft differences

ShotTraxx PR #533 `src/domain/friendsApi.ts` returns `FriendsApiResult` on every call: `{ ok: true, snapshot }` with `{ code, people, rounds }`, or `{ ok: false, reason }` where `reason` is `todo`, `off`, or `refused`. The contract wins. The server does not return that snapshot. Each call returns only its own body. The phone builds `{ code, people, rounds }` on the device. `people` and nicknames never come from the server.

`name` on `sendRequest` and `accept` is a local nickname. The phone keeps it on the device and does not send it. The server rejects a `name` field with `400` `{ "error": "invalid_body" }`. The phone's `id` is the server's `ownerId`.

| Phone call | Contract |
|---|---|
| `getCode()` | `POST /v1/friends/code` → `{ code, ownerId }` |
| `resetCode()` | `POST /v1/friends/code/reset` → `{ code, ownerId }` |
| `sendRequest({ code, name })` | `POST /v1/friends/requests` with `{ code }` only |
| `listRequests()` | `GET /v1/friends/requests` → `{ incoming, outgoing }`. Not in the cited phone draft. The client should add it. |
| `listFriends()` | `GET /v1/friends/list` → `{ friends }`. Not in the cited phone draft. The client should add it. |
| `accept({ id, name })` | `POST /v1/friends/requests/accept` with `{ ownerId }` only |
| `remove(id)` | `POST /v1/friends/remove` with `{ ownerId }` |
| `block(id)` | `POST /v1/friends/block` with `{ ownerId }` |
| `unblock(id)` | `POST /v1/friends/unblock` with `{ ownerId }` |
| `publishRound({ round, share })` | `PUT /v1/friends/rounds`. `share: true` and a round publishes it. `share: false` and `round: null` unshares and deletes the caller's shared rounds. |
| `fetchRounds()` | `GET /v1/friends/rounds` → `{ rounds }` |

`off` is the phone switch. No request is sent. `todo` is a call the phone has not finished, or a server that is not ready: `unknown_route`, `boards_not_configured`, `guess_limiter_not_configured`. `refused` is every other error: `friend_key_required`, `invalid_body`, `payload_too_large`, `method_not_allowed`, `code_not_found`, `not_friends`, `friend_limit`, `round_limit`, `rate_limited`, and `blocked`.

`blocked` is returned only to the person who blocked, and the phone maps it to `refused`, the same reason it uses for `code_not_found` and `not_friends`. The blocked person never receives `blocked`. Their `sendRequest` is the normal `200` pending body, and their `accept` is `not_friends`. That is a success or a `refused`, not a block.
