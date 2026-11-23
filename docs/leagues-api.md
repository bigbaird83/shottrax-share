# Leagues API

PR 1 (create, preview, join, members, standings, remove, reset) was built from the approved league mockups (Brian, Oct 29 2026, 8:44 AM CT). League rounds (W1–W5), settings (W15) and game points (W-C) follow below.

**Not deployed.** A deploy is a manual `npx wrangler deploy` and needs Brian's OK. No new Durable Object class, no migration, no secret, no `[vars]` change.

Every call uses the friends `X-Friend-Key`. The caller needs a friend code already (`POST /v1/friends/code`); their league member id is that `ownerId`.

| Call | Body / query | Answer |
| --- | --- | --- |
| `POST /v1/leagues` | `{ name, yourName, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds, roundDay?, gamePoints?, pointsMode? }` | `{ league, code }` |
| `POST /v1/leagues/preview` | `{ code }` | `{ league }` (no member list, no owner id) |
| `POST /v1/leagues/join` | `{ code, name }` | `{ league, joined }` |
| `GET /v1/leagues/members` | `?league=<id>` | `{ league, code, members: [{ memberId, name, role, joinedAt }] }` |
| `GET /v1/leagues/standings` | `?league=<id>` | `{ season, rounds, rows: [{ memberId, name, rank, tied, rounds, avgNet, skins, points }] }` |
| `POST /v1/leagues/members/remove` | `{ leagueId, memberId }` | `{ removed, league }`. Organizer only. |
| `POST /v1/leagues/code/reset` | `{ leagueId }` | `{ code, league }`. Organizer only. |
| `POST /v1/leagues/claims` | `{ code, spotMemberId?, name? }` | Not built yet: 501 `not_implemented` when the code lets the caller in. |
| `POST /v1/leagues/rounds` (W1) | see [League rounds](#league-rounds) | `{ round }` |
| `POST /v1/leagues/rounds/score` (W2) | `{ roundId, memberId, hole, strokes, rev }` | `{ cell }` |
| `GET /v1/leagues/rounds` (W3) | `?league=<id>&since=<ms>` | `{ round, lastSeen, now }` |
| `POST /v1/leagues/rounds/finish` (W4) | `{ roundId }` | `{ results }` |
| `POST /v1/leagues/settings` (W15) | `{ leagueId, name, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds, roundDay, gamePoints?, pointsMode? }` | `{ league }`. Organizer only. |

- `game`: strokePlay, skins, stableford, matchPlay, nassau. `scoring`: gross or net. `carryOver` only with skins.
- Names: 1-24 characters, spaces collapsed. `yourName` and the join `name` also set the caller's Friends name (one name per player).
- League name: 1-32 characters (placeholder limit; the mockups give none).
- Season dates are `YYYY-MM-DD`, start on or before end.
- `roundDay` (optional): the weekly round day the organizer picks, an integer 0 (Sunday) to 6 (Saturday). Missing or `null` means no round day. Every `league` answer carries `roundDay` (`null` when none, including leagues made before this field). The app works out the next date in the course's local calendar.
- Codes: friend-code alphabet and validator, 8 characters. A code lasts until the organizer resets it; the reset deletes the old `lg:code` row, so the old code is unknown to everyone. Preview and join use the friend code guess limit (8 per key, 24 per IP per hour), but only failed or unknown-code attempts count: a successful preview or join (200) gives its guess back. A caller already at the limit gets 429 even with a valid code, until the hour window resets. If the per-IP limit refuses, the per-key slot is given back.
- Cap: 20 players including the owner. One SQLite Durable Object per league (`LeagueRoster`) checks the cap and inserts in one transaction. Over the cap: 409 `league_full`. A repeat join is a no-op.
- A block either way between the caller and the owner: preview and join get 404 `code_not_found`, the same as a bad code, and the guess still counts. Members and standings get 404 `not_found`, even for someone who joined before the block.
- Members and standings: members only; anyone else gets 404.
- Decision 8 (Brian, Nov 17 2026): a removed player rejoins only with a new code. The roster keeps the code each member was removed under (`removedUnder`, in the league's Durable Object, never KV). When that person presents that code, preview, join and claims answer 404 `code_not_found`, the same as an unknown code, and the guess counts. Anyone else can still use that code. After a reset the new code lets the removed player in. A claim whose code lets the caller in gives its guess back.
- Remove and reset: anyone but the organizer gets 403 `forbidden`, and the organizer cannot remove themselves (403). A missing league or member is 404 `not_found`. Both share the member read limit.
- New leagues: 30 per IP per hour. Member/standings reads: 60 per key and per IP per hour.
- KV holds only `lg:code:<CODE>` -> league id. Rounds live only in the league's Durable Object.
- Every `league` answer (create, preview, join, members, reset, remove, settings) carries `gamePoints` and `pointsMode`, resolved with the defaults (see [Game points](#game-points)).

## Standings

Derived on each read from finished round results; never stored. Rules (mockup 5 footnote, PLAN.md "Standings and running stats"):

- Only finished league rounds whose date falls inside the season (inclusive) count.
- 6 points for 1st, down to 1; 6th and below get 1.
- Ties split the points of the places they cover (two tied for 2nd get (5+4)/2 = 4.5 each).
- In team games every player on a team gets that team's points.
- Avg net: 18-hole rounds with a net score only. Skins: skins won.
- Equal points share a rank, shown tied. Points stay exact (three tied for 5th get (2+1+1)/3 = 4/3 each, not 1.5); points within 1e-9 of each other count as equal. The app shows the nearest half (`formatLeaguePoints`).
- Game points: each round's points per player = finish points + that player's game points when the round was played on **Add**, or game points only when it was played on **Replace**. The mode is read from the round's own stored results, never from the league's current setting. Rows written before game points read as 0 game points and Add.
- A row carries `gamePoints` (the season's sum) once any counted round stored game points. Rows are otherwise unchanged.

Round results are written by W4 (one row per player, never changed afterwards).

## League rounds

Brian OK'd W1–W15 on Nov 18 2026 (ShotTraxx #900, decisions 1 and 22) and W-A with game points on Nov 22 2026. The behavior matches the app's `leagueFakeWorker.ts` and `leagueRound.ts` (ShotTraxx b555c794). Errors are `{ "error": "<code>" }`; 401 `friend_key_required`, 429 with `Retry-After`, and 503 as for every league call.

A **round id** is the league id (22 characters), `_`, and 16 random characters from `[A-Za-z0-9_-]`: 39 characters. W2 and W4 send only the round id; its first 22 characters pick the league. A malformed or unknown round id is 404 `not_found`. A member blocked either way with the league's owner gets 404 `not_found` on every round route, as on members and standings.

### W1 `POST /v1/leagues/rounds`

Body (every field required, unknown fields refused, at most 16 KB):

```
{ leagueId, course, playedOn,
  holes: [{ number, par, strokeIndex }],
  game, scoring, carryOver,
  teamsMode, teams: [{ teamNo, memberIds }] | null,
  players: [{ memberId, groupNo, courseHandicap, hostEnters }] }
```

- `course`: 1–200 characters, no padding. `playedOn`: `YYYY-MM-DD`.
- `holes`: 9 or 18, unique hole numbers 1–18. `par`: null or 3–6. `strokeIndex`: null or 1–18.
- `game` / `scoring` as for create; `carryOver` true only with skins.
- `players`: 1–20 unique current members. `groupNo` ≥ 1, `courseHandicap` null or 0–54, `hostEnters` a boolean.
- `teamsMode`: null, `pairs` or `teams`. `teams`: null, or teams with an integer `teamNo` whose members are players in the round, each in at most one team. With `teamsMode` null the teams are dropped (the app reads them only with a mode).
- Any failure: 400 `invalid_body`. A caller who isn't a member: 403 `forbidden`. A live round already in the league: 409 `round_live` (one live round per league, checked in the Durable Object's transaction).

Answer `{ round }`:

```
{ roundId, leagueId, hostId, startedAt, playedOn, course, holes, game, scoring, carryOver,
  teamsMode, teams,
  players: [{ memberId, name, kind, groupNo, courseHandicap, hostEnters }],
  cells: { <memberId>: { <hole>: { strokes, rev, enteredBy, by, at } } },
  finished, pointsMode, gamePoints }
```

The caller is the host. Names and `kind` come from the roster, never the body (`kind` is `app` for everyone until no-app players are built). `pointsMode` and `gamePoints` are the round's **snapshot** of the league's values when it started; today's app parser ignores them.

### W2 `POST /v1/leagues/rounds/score`

Body `{ roundId, memberId, hole, strokes, rev }`. `strokes` is null (clear) or an integer 1–20. Answer `{ cell }`.

- A player writes their own score. The host writes for players with `hostEnters`. A player can't write over a cell the host entered (403 `host_entered`); the host can change it, and it stays `host`.
- Compare-and-set: a write must carry `rev` = current + 1. Otherwise 409 `conflict` with `{ cell }`, the cell that won.
- Every accepted edit is kept in the round's history. History never leaves the Durable Object.
- Errors: 403 `forbidden` / `host_entered`; 409 `conflict` / `finished`; 400 `bad_hole` / `bad_strokes` / `not_in_round` / `invalid_body`; 404 `not_found`. A caller not in the league: 403 `forbidden`. A refusal carries `cell` (the current one, or null).
- When every player has scored every hole, the round finishes in the same transaction (W4).

### W3 `GET /v1/leagues/rounds?league=<id>&since=<ms>`

Polled about every 60 s. Members only (403 `forbidden`). Answer `{ round, lastSeen, now }`:

- `round`: the live round; with no live round and `since` given, the latest round started at or after `since` (finished included); otherwise null. Never the history.
- `lastSeen`: `{ memberId: ms }`, when each member's phone last reached a round route. A start or score write sets the writer's time; a poll sets the caller's time only when it has none.
- `now`: the Worker's clock (ms).

### W4 `POST /v1/leagues/rounds/finish`

Body `{ roundId }`. Host only (403 `forbidden`); a finished round is 409 `finished`. Answer:

```
{ results: { roundId, playedOn, finished, pointsMode,
             results: [{ memberId, unit, place, net, holes, skins, gamePoints, incomplete }] } }
```

Places, net and skins come from the app's engine, ported in `league-scoring.js` and checked against golden fixtures the app's own `leagueRoundResults` wrote (`scripts/league-golden.mts`, `test/fixtures/league-round-results.golden.json`). `unit` is the player, or `team-<n>` in a Pairs/Teams round. `gamePoints` is a number (exact). The round is marked finished and one `round_results` row per player is written in one transaction. **Decision 23: past rounds are never rescored** — stored rows never change, and W15 never touches them.

### W5 round-started push

Sent after W1 is stored, best effort (a push failure never fails W1), the same way as shared-scorecard invites (`EXPO_ACCESS_TOKEN` when set):

- To every member except the starter; never to anyone blocked either way with the starter or anyone without a valid push token.
- Title: `{Starter} started a league round`. The starter's current Friends name, else their roster name.
- Body: `{League}: {Game} at {course}. Tap to follow the live leaderboard.` with Game from Stroke play, Skins, Stableford, Match play, Nassau.
- Data: exactly `{ kind: "league_round_start", leagueId, roundId }`. No scores, no other names.

### W15 `POST /v1/leagues/settings`

Organizer only (403 `forbidden`). The same checks as create: a bad name is 400 `name_required`, anything else 400 `invalid_body`. `carryOver` is forced off unless the game is skins (as the app's `leagueSettingsForWorker` sends it). `homeCourse` null or a course name; `roundDay` null or 0–6.

- 409 `season_before_round` when `seasonEnds` is before the latest `playedOn` of any round in the league, live or finished.
- Updates the league row only. A live round keeps the game, scoring and point values it started with; finished rounds and `round_results` are never touched.
- A body without `gamePoints` / `pointsMode` (today's app body) leaves them as they are. A partial `gamePoints` merges over the stored values.
- Answer `{ league }`.

### Limits

- W1, W4, W15: the member read limit (`keylgread:` / `iplgread:`, 60 per key and per IP per hour).
- W2: `keylgwrite:` / `iplgwrite:`, 240 per key and per IP per hour (the shared-scorecard write limit).
- W3: `keylglive:` / `iplglive:`, 240 per key and per IP per hour (`LEAGUE_LIVE_LIMIT`), so live polling never eats the member/standings budget.

## Game points

Approved wording and rules: Match play, Skins and Stroke play (Brian, Nov 11 2026, mockup `league-game-points`); Stableford and Nassau (Brian, Nov 22 2026, mockup `league-game-points-stableford-nassau-1122`).

```
gamePoints: { matchPlay: { perHole, per9, fullRound }, skins: { perSkin },
              strokePlay: { per9, fullRound }, stableford: { per9, fullRound },
              nassau: { per9, fullRound } }
pointsMode: "add" | "replace"
```

- Optional on create and W15; always present (resolved with the defaults) on every `league` answer.
- Defaults: Match 1 / 0 / 0, Skins 1, Stroke 2 / 3, Stableford 2 / 3, Nassau 1 / 1. Mode: Add.
- Values are integers 0–20. **20 is a placeholder cap** (no mockup gives one).
- A partial object merges over the stored values (or the defaults). Unknown keys, or a game other than these five, are 400 `invalid_body`. A stored object missing a game resolves that game to its defaults.
- Add: "Added to finish points (6 for 1st, down to 1)." Replace: "Replaces finish points. Standings use game points only."
- Stored on the league as `game_points` (JSON, null = defaults) and `points_mode` (null = Add), and snapshotted onto each round when it starts.

Scored at finish from the round's own snapshot:

- **Units**: the same units as finish places — a team in a Pairs/Teams round (best ball, as `teamBestBall`), otherwise each player (the engine's gross, or net off the low course handicap when the round is Net and net isn't blocked). On a team, every player gets the team's points. A round with fewer than 2 units scores no game points.
- **Segments**: front = holes 1–9, back = holes 10–18; Per 9 is scored for each nine with holes in the round; Full round = every hole. "On a 9-hole round, Per 9 and Full round both apply."
- **Match play**: a hole counts only when every unit has a score. Per hole won: the lowest score(s) share `perHole`. Per 9 / Full round: the most hole-wins (a halved hole is ½ a win each) share the value. A segment with no counted hole awards nothing.
- **Skins**: `perSkin` × skins won from the engine (a carry-over counts one per hole it covers; nothing after the first missing score). Individual.
- **Stroke play**: individual. Per 9 / Full round go to the lowest total among players who scored every hole of that segment. Nobody eligible: nothing awarded.
- **Stableford**: individual, the same eligibility. Most points wins, points per hole `max(0, 2 + par − score)` (the app's `groupGames.ts` formula, net or gross as stroke play). A hole with no valid par adds nothing and does not block eligibility; a segment with no par hole awards nothing. Finish places are unchanged (the engine ranks Stableford like stroke play).
- **Nassau**: every pair of units plays its own match per segment (front, back, overall), the `teamMatchPoints` loop. The unit ahead on counted holes gets `per9` (each nine) or `fullRound` (overall); level splits it. A hole counts when both units have a score (best ball for teams); a missing score is skipped, not a stop. A segment with no counted hole awards nothing. A clean sweep of one match is 3 with the defaults.
- "Ties split the points (halves count)." The Worker keeps ties **exact** (2 points split 3 ways = 2/3) and compares points with a 1e-9 tolerance; the app shows the nearest half (Brian, Nov 22 2026: "Keep nearest half as shown now").

Storage: `round_results` gains three nullable columns — `game_points REAL` (null = 0), `points_mode TEXT` (null = Add) and `incomplete INTEGER` — added with `ALTER TABLE` the first time a round finishes in that league. `league` gains `game_points TEXT` and `points_mode TEXT` in `#ensure()`. Nothing is dropped or rewritten.
