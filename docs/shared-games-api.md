# Shared scorecard API (SC-2)

Not deployed. A deploy is a manual `npx wrangler deploy` and needs Brian's OK. This change adds a Durable Object class and does not add a secret or a `[vars]` entry.

Every call uses the friends `X-Friend-Key`. The caller needs a friend code already (`POST /v1/friends/code`). Their player id is that `ownerId`.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /v1/shared-games` | `{ gameId?, format, scoring, options?, teams?, players }` | `{ game }` |
| `GET /v1/shared-games/:gameId` | none | `{ game, scores }` |
| `POST /v1/shared-games/:gameId/scores` | `{ playerId, hole, strokes, rev, clientWriteId }` | `{ cell }` |

Ids (`gameId`, `playerId`, `installId`, `clientWriteId`, team `memberIds`) match `^[A-Za-z0-9_-]{1,64}$`.

`format`: `strokePlay`, `matchPlay`, `skins`, `bestBall`, `scramble`, `shamble`, `wolf`. `scoring`: `gross` or `net`.

`players`: `{ playerId, installId, guest, team, name? }`. The caller is the organizer and must be a non-guest player. `installId` may be null only for a guest. `name`, when sent, is 1–24 characters. `team` is `1`, `2`, or null.

`teams`: `{ number, name, memberIds }`. `name` is 1–20 code points (an emoji counts once). At most 2 teams, 4 players on a team, 8 players in the game. Over that is `409` `cap`. Wolf is exactly 4 players; any other count is `409` `wolf` (a roster that is also over the cap is `cap`).

`options` for best ball: `{ balls: 1 | 2, matchPlay: boolean }` (defaults 1 and false). Other formats store `{}`.

`rev` on a score write is the expected current rev (`0` when the cell is empty). The write compare-and-sets that rev in one transaction. The same `clientWriteId` again returns the cell from the first write and does not append history. A different write with a stale rev is `409` `{ error: "stale_rev", cell }` and `cell` is the standing cell.

The standing score for a non-guest is their latest own entry. A suggestion, or a host entry from the organizer, stays in history and does not replace it. Until the player has an own entry, the organizer's host entry is what the cell shows. A suggestion alone leaves `strokes` null. A guest's standing score is the organizer's host entry and is never `source: "own"`.

`cell`: `{ playerId, hole, strokes, rev, enteredBy, source, conflict, history }`. `history` keeps every accepted edit: `{ rev, strokes, enteredBy, source, clientWriteId, at }`. `source` is `own`, `host`, or `suggestion`.

Reads and score writes are only for players on the list. Someone else gets `403` `forbidden` when the game exists and `404` `not_found` when it does not. Neither body includes the card. A block in either direction between the caller and anyone else on the list is `409` `blocked` with no card, for both people. Starting a game whose roster already contains a blocked pair is the same `409`.

The card is one SQLite Durable Object per game (`SharedGame`, binding `SHARED_GAMES`). Nothing from the game is written to `BOARDS`.

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

Creates: 30 per IP per hour. Reads: 60 per key and per IP per hour. Score writes: 240 per key and per IP per hour, so a racing burst can finish.
