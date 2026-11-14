# Shared scorecard API (SC-2)

Not deployed. A deploy is a manual `npx wrangler deploy` and needs Brian's OK. This change adds a Durable Object class and does not add a secret or a `[vars]` entry.

Every call uses the friends `X-Friend-Key`. The caller needs a friend code already (`POST /v1/friends/code`). Their player id is that `ownerId`.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /v1/shared-games` | `{ gameId?, format, scoring, options?, teams?, players }` | `{ game }` |
| `GET /v1/shared-games/invites` | none | `{ invites: [{ gameId, hostName, format, course, invitedAt }] }` |
| `GET /v1/shared-games/:gameId` | none | `{ game, scores }` |
| `POST /v1/shared-games/:gameId/scores` | `{ playerId, hole, strokes, rev, clientWriteId }` | `{ cell }` |
| `POST /v1/shared-games/:gameId/invites` | `{ invitees: [{ playerId, friendId, team }], push: { title, body? } }` | `{ invites: [{ playerId, status }] }` |
| `POST /v1/shared-games/:gameId/join` | `{ playerId, joinedHole }` | `{ game }` |
| `POST /v1/shared-games/:gameId/decline` | `{ playerId }` | `{ ok: true }` |
| `POST /v1/shared-games/:gameId/teams/:n` | `{ name }` | `{ team: { number, name } }` |
| `POST /v1/shared-games/:gameId/suggestions` | `{ suggestionId, playerId, hole, strokes, rev }` | `{ suggestion: { id, status } }` |
| `POST /v1/shared-games/:gameId/suggestions/:id` | `{ action: "accept" \| "keep" }` | `{ suggestion: { id, status } }` |

Ids (`gameId`, `playerId`, `installId`, `clientWriteId`, team `memberIds`) match `^[A-Za-z0-9_-]{1,64}$`.

`format`: `strokePlay`, `matchPlay`, `skins`, `bestBall`, `scramble`, `shamble`, `wolf`. `scoring`: `gross` or `net`.

`players`: `{ playerId, installId, guest, team, name? }`. The caller is the organizer and must be a non-guest player. `installId` may be null only for a guest. `name`, when sent, is 1–24 characters. `team` is `1`, `2`, or null.

`teams`: `{ number, name, memberIds }`. `name` is 1–20 code points (an emoji counts once). At most 2 teams, 4 players on a team, 8 players in the game. Over that is `409` `cap`. Wolf is exactly 4 players; any other count is `409` `wolf` (a roster that is also over the cap is `cap`).

`options` for best ball: `{ balls: 1 | 2, matchPlay: boolean }` (defaults 1 and false). Other formats store `{}`.

`rev` on a score write is the expected current rev (`0` when the cell is empty). The write compare-and-sets that rev in one transaction. The same `clientWriteId` again returns the cell from the first write and does not append history. A different write with a stale rev is `409` `{ error: "stale_rev", cell }` and `cell` is the standing cell.

The standing score for a non-guest is their latest own entry. A suggestion, or a host entry from the organizer, stays in history and does not replace it. Until the player has an own entry, the organizer's host entry is what the cell shows. A suggestion alone leaves `strokes` null. A guest's standing score is the organizer's host entry and is never `source: "own"`.

`cell`: `{ playerId, hole, strokes, rev, enteredBy, source, conflict, history }`. `history` keeps every accepted edit: `{ rev, strokes, enteredBy, source, clientWriteId, at }`. `source` is `own`, `host`, or `suggestion`.

Reads and score writes are only for players on the list. Someone else gets `403` `forbidden` when the game exists and `404` `not_found` when it does not. Neither body includes the card. A block in either direction between the caller and anyone else on the list is `409` `blocked` with no card, for both people. Starting a game whose roster already contains a blocked pair is the same `409`.

The card is one SQLite Durable Object per game (`SharedGame`, binding `SHARED_GAMES`). Nothing from the card is written to `BOARDS`.

`GET /v1/shared-games/invites` lists the caller's invites still waiting on them, newest first, at most 20, so an invitee whose push never arrived still sees them. Each newly sent invite also writes one `BOARDS` row for the invitee, `fr:sginv:<ownerId>:<gameId>` (`{ at, organizerId, hostName, course }`, kept 7 days). Join and decline delete it. On read each row is checked against its game: the invite must still be `sent` to the caller's `ownerId` and the caller not on the card yet, or the row is dropped; a block either way with anyone on the card hides it. `hostName` is the name in the approved push title (`{Name} invited you to a shared scorecard`), else the host's own Friends name, else null. `course` is the course in the approved Scramble push body, else null. Same auth as `GET /v1/shared-games/:gameId`, and the same read limit (60 an hour per key and per IP) in its own bucket, so it never uses up a live card's reads; a body is `400`, another method `405`.

Wager keys are stripped from the input and never returned, empty or not: `wager`, `wagers`, `sidegame`, `sidegames`, `side_game`, `side_games`, `bet`, `bets`.

| Status | `error` |
| --- | --- |
| 401 | `key_required` |
| 400 | `invalid_body` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `stale_rev` (with `cell`), `blocked`, `cap`, `wolf`, `refused` |
| 413 | `payload_too_large` |
| 429 | `rate_limited`, plus `Retry-After` |
| 503 | `unavailable` |

## Invites, join, decline, team names, suggestions (for ShotTraxx PR #861)

Invites: only the organizer. Each invitee must be the organizer's friend both ways, and plays as their own `ownerId`, so `playerId` must equal `friendId` (else `400`). Inviting yourself is `400`. A block in either direction between an invitee and anyone on the list is `409` `blocked`. `team` is 1 or 2 (3 or more is `409` `cap`). A pending invite holds its seat, so the 8-player, 4-per-team and wolf caps count it (`409` `cap`). `status` is `sent`, or `joined` once they are on the card. Sending the same invite again gives the same answer and no second push.

Each newly invited friend with a push token gets one push through Expo (an APNs alert): `{ to, title, body?, sound: "default", data: { kind: "shared_game_invite", gameId } }`. `title` is 1–200 characters, `body` 1–500 and left out when not sent. A friend with no token (notifications off) gets the invite with no push.

Join: only the invited friend, with their own `ownerId` as `playerId` (else `403`). `joinedHole` is null (from the start) or 1–18 for a mid-round join. No invite, or a declined one, is `403`. A block with anyone on the list is `409` `blocked`. Joining again returns the game. A joined player's `installId` is their `ownerId`.

Decline: only the invited friend (else `403`), before joining (after is `409` `refused`). It removes the invite.

Team names: any player on team `n` (else `403`). `n` other than 1 or 2 is `404`. `name` is trimmed, 1–20 code points, no control characters, and not caught by the app's team-name filter (else `400`).

Suggestions: any player on the list suggests a fix to another non-guest player's score. Not for a guest (the host keeps it), not for your own score, and not before the player has a score: `409` `refused`. `rev` is the cell's current rev (1 or more); a stale one is `409` `stale_rev` with `cell`. The standing score does not change. The same `suggestionId` again with the same content returns it; with different content it is `409` `refused`.

Accept or keep: only the player the suggestion is for (else `403`). An unknown id is `404`. A closed one is `409` `refused`. `accept` writes the suggestion as the player's own score (`source: "own"`, `clientWriteId` `sug:<id>`) if the cell is still at the rev it was made against; otherwise `409` `stale_rev` with `cell`, and the suggestion stays open. `keep` closes it and leaves the score.

Creates: 30 per IP per hour. Reads: 60 per key and per IP per hour. Score writes and the six routes above share one limit: 240 per key and per IP per hour, so a racing burst can finish.
