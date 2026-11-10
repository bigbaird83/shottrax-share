# Shared scorecard API (SC-2)

Not deployed. A deploy is a manual `npx wrangler deploy` and needs Brian's OK. This change adds a Durable Object class and does not add a secret or a `[vars]` entry.

Every call uses the friends `X-Friend-Key`. The caller needs a friend code already (`POST /v1/friends/code`). Their player id is that `ownerId`.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /v1/shared-games` | `{ gameId?, roundId?, format, scoring, options?, teams?, players }` | `{ game }` |
| `GET /v1/shared-games/:gameId` | none | `{ game, scores }` or `{ game, scores, wager }` |
| `POST /v1/shared-games/:gameId/scores` | `{ playerId, hole, strokes, rev, clientWriteId }` | `{ cell }` |
| `POST /v1/shared-games/:gameId/wager` | `{ unit, customUnit?, who, pays, amount, players? }` | `{ wager }` |
| `GET /v1/shared-games/:gameId/export` | none | `{ gameId, wager? }` |
| `GET /v1/shared-games/:gameId/share` | none | `{ image, page }` |
| `POST /v1/shared-games/:gameId/delete` | empty or `{}` | `{ ok: true }` |

Ids (`gameId`, `playerId`, `installId`, `clientWriteId`, team `memberIds`) match `^[A-Za-z0-9_-]{1,64}$`.

`format`: `strokePlay`, `matchPlay`, `skins`, `bestBall`, `scramble`, `shamble`, `wolf`. `scoring`: `gross` or `net`.

`players`: `{ playerId, installId, guest, team, name? }`. The caller is the organizer and must be a non-guest player. `installId` may be null only for a guest. `name`, when sent, is 1–24 characters. `team` is `1`, `2`, or null.

`roundId`, when sent, links this game to a friends round. Deleting that round deletes the wager and leaves the card. `game.roundId` is `null` when the game is not linked.

`teams`: `{ number, name, memberIds }`. `name` is 1–20 code points (an emoji counts once). At most 2 teams, 4 players on a team, 8 players in the game. Over that is `409` `cap`. Wolf is exactly 4 players; any other count is `409` `wolf` (a roster that is also over the cap is `cap`).

`options` for best ball: `{ balls: 1 | 2, matchPlay: boolean }` (defaults 1 and false). Other formats store `{}`.

`rev` on a score write is the expected current rev (`0` when the cell is empty). The write compare-and-sets that rev in one transaction. The same `clientWriteId` again returns the cell from the first write and does not append history. A different write with a stale rev is `409` `{ error: "stale_rev", cell }` and `cell` is the standing cell.

The standing score for a non-guest is their latest own entry. A suggestion, or a host entry from the organizer, stays in history and does not replace it. Until the player has an own entry, the organizer's host entry is what the cell shows. A suggestion alone leaves `strokes` null. A guest's standing score is the organizer's host entry and is never `source: "own"`.

`cell`: `{ playerId, hole, strokes, rev, enteredBy, source, conflict, history }`. `history` keeps every accepted edit: `{ rev, strokes, enteredBy, source, clientWriteId, at }`. `source` is `own`, `host`, or `suggestion`.

Reads and score writes are only for players on the list. Someone else gets `403` `forbidden` when the game exists and `404` `not_found` when it does not. Neither body includes the card. A block in either direction between the caller and anyone else on the list is `409` `blocked` with no card, for both people. Starting a game whose roster already contains a blocked pair is the same `409`.

The card is one SQLite Durable Object per game (`SharedGame`, binding `SHARED_GAMES`). Nothing from the game is written to `BOARDS`. Wagers are rows in that same object, not a field on the round and not a new class. No new migration tag.

## Wagers (SG-2)

`POST /v1/shared-games/:gameId/wager` is the organizer only, and only before any score on hole 1. After that it is `409` `{ error: "locked" }` and the stored wager is unchanged. A non-organizer is `403` `forbidden`.

| Field | Rule |
| --- | --- |
| `unit` | `"$"`, `"Points"`, `"Beers"`, or `"custom"` |
| `customUnit` | Required when `unit` is `"custom"`: 1–12 characters, counted as Unicode code points (an emoji counts once). Blank or whitespace-only is refused. Otherwise omit it or send `null` |
| `who` | `"player"` or `"team"` |
| `pays` | `"hole"`, `"skin"`, `"nine"`, or `"round"` |
| `amount` | String. `0` or a number up to 12 digits, optional `.` and 1–2 decimals. `"1000000"` is accepted. No maximum value inside that shape |
| `players` | Optional. Each is `{ playerId, optedIn, confirmed, amount? }`. `amount` uses the same string shape. Omitted players are stored not opted in. An id that is not on the roster is `invalid_body` |

`wager` on a read:

```json
{
  "unit": "$",
  "customUnit": null,
  "who": "player",
  "pays": "hole",
  "amount": "5",
  "locked": false,
  "players": [
    { "playerId": "<id>", "optedIn": true, "confirmed": true, "amount": "3.34" }
  ]
}
```

`locked` is true once hole 1 has a score.

The allowlist table is `wager_allow (install_id TEXT PRIMARY KEY)`. It stores install ids only. Creating the game inserts each non-null player `installId`. A caller is on the list when their player row's install id is in that table. They get `wager` on `GET /v1/shared-games/:gameId` and on the wager `POST` response. A caller who is not on the list (a guest with no install id, or any other member whose install id was not stored) still gets `{ game, scores }` and the response has no wager key at all. The key is absent. It is not `null`, `{}`, or `[]`.

Stray wager keys on create or on a score write are still dropped and are not stored: `wager`, `wagers`, `sidegame`, `sidegames`, `side_game`, `side_games`, `bet`, `bets`. A wager `POST` whose body carries one of those keys is `400` `{ error: "wager_rejected" }` and writes nothing.

`GET /v1/shared-games/:gameId/export` is the caller's own wager only: `{ gameId, wager: { unit, customUnit, who, pays, self } }`. `self` is `{ playerId, optedIn, confirmed, amount }` for that caller. Other players' ids and amounts are not included. When the game has no wager, the `wager` key is absent.

`GET /v1/shared-games/:gameId/share` is the share image and the share page: `{ image, page }`. Both are scores, teams, and player names. They contain no wager field and no `$`.

`POST /v1/shared-games/:gameId/delete` is the organizer only. It deletes the game, the scores, the allowlist, and the wagers. A later read is `404`.

Deleting a friends round whose id is this game's `roundId` (`POST /v1/friends/rounds/delete`, or unshare) deletes the wagers and leaves the card.

A block in either direction is `409` `blocked` on the wager write, the export, and the share, same as the card, and the body has no wager key.

| Status | `error` |
| --- | --- |
| 401 | `key_required` |
| 400 | `invalid_body`, `wager_rejected` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `stale_rev` (with `cell`), `blocked`, `cap`, `wolf`, `refused`, `locked` |
| 413 | `payload_too_large` |
| 429 | `rate_limited`, plus `Retry-After` |
| 503 | `unavailable` |

Creates: 30 per IP per hour. Reads: 60 per key and per IP per hour. Score writes: 240 per key and per IP per hour, so a racing burst can finish.
