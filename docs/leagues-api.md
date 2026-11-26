# Leagues API

PR 1 (create, preview, join, members, standings, remove, reset) was built from the approved league mockups (Brian, Oct 29 2026, 8:44 AM CT). League rounds (W1–W5), settings (W15) and game points (W-C) follow below, then [W-B](#w-b-no-app-players-claims-leave-and-hand-over): no-app players, claims, leave, hand over and the roster friend request.

**Not deployed.** A deploy is a manual `npx wrangler deploy` and needs Brian's OK. No new Durable Object class, no migration, no secret, no `[vars]` change.

Every call uses the friends `X-Friend-Key`. The caller needs a friend code already (`POST /v1/friends/code`); their league member id is that `ownerId`.

| Call | Body / query | Answer |
| --- | --- | --- |
| `POST /v1/leagues` | `{ name, yourName, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds, roundDay?, gamePoints?, pointsMode? }` | `{ league, code }` |
| `POST /v1/leagues/preview` | `{ code }` | `{ league }` (no member list, no owner id), plus `spots` when the league has a claimable no-app spot (W8) |
| `POST /v1/leagues/join` | `{ code, name }` | `{ league, joined }` |
| `GET /v1/leagues/members` | `?league=<id>` | `{ league, code, members: [{ memberId, name, role, joinedAt }] }`; no-app rows add `kind:'noApp', addedBy, addedByName, addedAt`; a member who published a handicap index adds `handicapIndex` |
| `GET /v1/leagues/standings` | `?league=<id>` | `{ season, rounds, rows: [{ memberId, name, rank, tied, rounds, avgNet, skins, points }] }` |
| `POST /v1/leagues/members/remove` | `{ leagueId, memberId }` | `{ removed, league }`. Organizer only. |
| `POST /v1/leagues/code/reset` | `{ leagueId }` | `{ code, league }`. Organizer only. |
| `POST /v1/leagues/members/no-app` (W6) | `{ leagueId, name }` | `{ member }`. Any member. |
| `POST /v1/leagues/members/rename` (W7) | `{ memberId, name }` | `{ member }`. No-app only; organizer or adder. |
| `POST /v1/leagues/members/leave` (W16) | `{ leagueId }` | `{ left }`. Anyone but the organizer. |
| `POST /v1/leagues/members/handover` (W17) | `{ leagueId, memberId }` | `{ left, league }`. Organizer only. |
| `POST /v1/leagues/members/handicap` | `{ leagueId, index }` | `{ memberId, handicapIndex }`. The caller's own index only. See [Member handicaps](#member-handicaps). |
| `POST /v1/leagues/claims` (W9) | `{ code, spotMemberId, name }` | `{ claim }` |
| `POST /v1/leagues/claims/approve` / `decline` / `cancel` (W10–W12) | `{ claimId }` | `{ claim }` |
| `GET /v1/leagues/claims` (W13) | `?league=<id>` | `{ claims }`. Organizer only. |
| `GET /v1/leagues/claims/mine` (W13) | — | `{ claim, league }` (each may be `null`) |
| `POST /v1/friends/request-by-member` | `{ league, memberId }` | `{ outcome }` |
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
- KV holds only `lg:code:<CODE>` -> league id and (W-B) `lg:claim:<ownerId>` -> that person's latest claim id. Rounds, members and claims live only in the league's Durable Object.
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
  players: [{ memberId, groupNo, courseHandicap, hostEnters, teeName? }] }
```

- `course`: 1–200 characters, no padding. `playedOn`: `YYYY-MM-DD`.
- `holes`: 9 or 18, unique hole numbers 1–18. `par`: null or 3–6. `strokeIndex`: null or 1–18.
- `game` / `scoring` as for create; `carryOver` true only with skins.
- `players`: 1–20 unique current members. `groupNo` ≥ 1, `courseHandicap` null or 0–54, `hostEnters` a boolean.
- `teeName` (optional, Brian Nov 26 2026): the player's tee, for display only. A string trimmed to 1–24 characters with no control characters, or null; absent reads as null. Anything else (a number, `""`, 25+ characters after trimming) is 400 `invalid_body`. Course handicaps are still worked out on the host's phone, each from the player's own tee, and sent in `courseHandicap`; the 0–54 range is unchanged (the app sends a plus handicap as 0). A sent name is stored in the round's players snapshot and returned on that player in every round answer (start, live read); a player with no tee has no `teeName` key, so rounds without tees read exactly as before. Scoring, finish and standings never read it.
- `teamsMode`: null, `pairs` or `teams`. `teams`: null, or teams with an integer `teamNo` whose members are players in the round, each in at most one team. With `teamsMode` null the teams are dropped (the app reads them only with a mode).
- Any failure: 400 `invalid_body`. A caller who isn't a member: 403 `forbidden`. A live round already in the league: 409 `round_live` (one live round per league, checked in the Durable Object's transaction).

Answer `{ round }`:

```
{ roundId, leagueId, hostId, startedAt, playedOn, course, holes, game, scoring, carryOver,
  teamsMode, teams,
  players: [{ memberId, name, kind, groupNo, courseHandicap, hostEnters, teeName? }],
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

## W-B: no-app players, claims, leave and hand over

**Not deployed. Needs #70 deployed first.** A deploy is a manual `npx wrangler deploy` and needs Brian's OK. No new Durable Object class, no migration, no secret, no `[vars]` change.

Approvals: W6–W14 OK to build since Nov 18 2026 (ShotTraxx #900 decision table, item 1). W16, W17 and request-by-member: Brian, Nov 22 2026 ("Yes, build those routes"). Product rules: decisions 2, 3, 4, 5, 8 and 10 (Nov 17 2026). Contract: ShotTraxx #900 rows W6–W14; the app's `leagueFakeWorker.ts`, `leagueClaims.ts` and `leagueMembers.ts` at ShotTraxx 4efe08b6. Errors are `{ "error": "<code>" }`; 401 `friend_key_required`, 429 with `Retry-After`, unknown fields 400 `invalid_body`, as everywhere.

### Ids

- **No-app member id**: `noapp_` + the league id (22) + `_` + 16 random characters from `[A-Za-z0-9_-]` (45 in all). Made by the Worker. Never 22 characters, so it can never equal a Friends `ownerId`. W7 routes to the league by it.
- **Claim id**: the league id (22) + `_` + 16 random characters (39 in all), like a round id. W10–W12 route by it.
- **Claim pointer**: KV `lg:claim:<ownerId>` -> the caller's latest claim id, written by W9. `/claims/mine` reads it; W9 reads it to keep one pending claim per person across leagues.

### Storage

- `member` gains three nullable columns with additive `ALTER TABLE` in `#ensure()`: `kind` (null = an app member, `'noApp'`), `added_by`, `added_at`. Every older row reads as an app member.
- A new `claim` table (`CREATE TABLE IF NOT EXISTS`): `claim_id, spot_member_id, spot_name, claimer_id, claimer_name, status, created_at, decided_at`. Claims are never deleted.

### W6 `POST /v1/leagues/members/no-app`

`{ leagueId, name }`. Any member (decision 2); a non-member is 403 `forbidden`. `name` is 1–24 characters, spaces collapsed, else 400 `name_required`. No-app players count toward the 20 (decision 5), checked in the roster transaction: 409 `league_full`. Answers `{ member: { memberId, name, role:'member', joinedAt, kind:'noApp', addedBy, addedByName, addedAt } }`. `addedByName` is the adder's current Friends name, falling back to their roster name (null if they've left).

The members list returns those four extra fields on no-app rows only; app rows stay exactly `{ memberId, name, role, joinedAt }`.

### W7 `POST /v1/leagues/members/rename`

`{ memberId, name }`. A no-app player only; the organizer or the member who added them, while they are a member (decision 10), else 403 `forbidden`. A blank name is 400 `name_required`. An id that names no no-app spot is 404 `not_found` (an app member's id names no league, so it is 404 too). Answers `{ member }`.

### W8 preview spots

`POST /v1/leagues/preview` adds `spots: [{ memberId, name, addedByName, addedAt }]`: the no-app spots with no pending claim, in roster order. `spots` is sent only when there is at least one, so a league without any answers `{ league }` exactly as before (the app reads a missing `spots` as none).

### W9 `POST /v1/leagues/claims`

`{ code, spotMemberId, name }`. The same code lookup, removed-under check (decision 8) and guess limit as join: a code that doesn't let the caller in is 404 `code_not_found` and uses the guess; one that does gives it back. Then, in the app's `claimRefusal` order: 400 `name_required`; 409 `already_member`; 400 `invalid_body` (not a no-app spot of this league); 409 `already_pending` (the caller has a pending claim, in any league); 409 `spot_pending`. Answers `{ claim: { claimId, leagueId, spotMemberId, spotName, claimerId, claimerName, status:'pending', createdAt } }`. The claimer is **not** a member while it is pending.

### W10–W12 `POST /v1/leagues/claims/approve` | `decline` | `cancel`

`{ claimId }`. Only a pending claim can change; approve and decline are the organizer's, cancel is the claimer's. Anything else is 403 `forbidden`; an unknown claim id is 404 `not_found`. Answers `{ claim }` with status `approved`, `declined` or `cancelled`.

**Approve (W10)** is one roster transaction (decision 3). The spot's member row becomes the claimer: their id and W9 name, `kind` null, adder fields cleared, role and join time kept. The spot's id becomes the claimer's in `round_results` (and a solo `unit`), `round_cell`, `round_history`, `last_seen`, and every `league_round`'s players (kind becomes `app`), teams and host. `entered_by` is never changed, so host-entered cells stay `host` (decision 4). Points follow the results, so the claimer's standings row has the spot's points.

**Claimer joined while pending (Brian, Nov 23 2026).** Joining with the code doesn't touch the pending claim, and the organizer can still approve it. Approving then **merges** the spot into the claimer's existing member row. That row stays as it is (their name, role and join time). The spot's row is deleted, so there's no duplicate and the roster shrinks by one; the 20-player cap is never checked for a merge. Results, cells, history, last seen and round players/teams move exactly as above, and host-entered cells stay `host`. Declining leaves their joined spot alone.

**A round both played (Brian, Nov 23 2026, 2:17 PM CT).** When the claimer and the spot played the same round (the claimer joined, or is a former member), approve doesn't refuse. For each round both played, the claimer's own result, cells and history are kept, and the spot's are dropped: its `round_results` row, cells, history, and its place in the round's players and teams. Standings are derived from the remaining rows, so that round is scored again without the spot. Rounds only the spot played move over as above, with host-entered cells staying `host`. There's no duplicate member row, and no cap check.

The only refusal is a pending claim whose spot row is gone: 404 `not_found`, nothing changed. The remove route can't leave one, see below.

**Decline (W11)**: the spot stays unclaimed and is offered again; the same person may claim again.

### W13 `GET /v1/leagues/claims?league=<id>` and `GET /v1/leagues/claims/mine`

The list is the organizer's only (403 `forbidden`): `{ claims }`, pending first, each group oldest first. `mine` answers the caller's latest claim (any status) and its league in the preview shape (no owner id): `{ claim, league }`, or `{ claim: null, league: null }`.

### W14 claim push

Best effort after W9 is stored; a push failure never fails W9. One push, to the organizer only (the league's owner when the claim is stored). None when either has blocked the other or the organizer has no valid push token. Title `"{League}: claim request"`, body `"{Name} wants to claim {Spot}'s spot. Tap to review."` (approved 18c strings; Name = the claimer's W9 name, Spot = the spot's name), data exactly `{ kind:'league_claim_request', leagueId, claimId }`.

W5 (the round-started push) never goes to a no-app player. W1 takes each player's `kind` from the roster and forces `hostEnters: true` for a no-app player.

### Leave vs remove

| | Remove (organizer) | Leave (W16) | Hand over and leave (W17) |
| --- | --- | --- | --- |
| Member row | deleted | deleted | the caller's deleted; the target becomes `owner` |
| `removed` row | written (app member): the current code stops letting them in | **none**: the same code lets them back in | **none** |
| Rounds, results, cells, history, claims, code | untouched | untouched | untouched |

Removing a no-app player deletes the unclaimed spot and keeps its past rounds (decision 8); no `removed` row is written for a no-app id.

**A pending claim on a removed spot (Brian, Nov 23 2026)** is cancelled in the same roster transaction (status `cancelled`, so no orphan claim, and approving it later is 403 `forbidden`). The claimer's `lg:claim:<ownerId>` pointer is deleted when it names that claim, so `/claims/mine` answers nulls and the claimer can claim again. The claimer, and only the claimer, gets one push, best effort: title the league name only (e.g. `"Saturday Crew"`), body `"The organizer removed {Spot}'s spot, so your claim was cancelled."` (Brian, Nov 23 2026, 2:17 PM CT), data `{ kind:'league_claim_cancelled', leagueId, claimId }`. It is sent **even when the claimer and the organizer are blocked either way** (Brian, same answer); the other league pushes (W5, W14) keep their block skip. No push without a valid token; a push failure never fails the remove. The app has no handler for `league_claim_cancelled` yet (a later app PR). The remove answer is unchanged: `{ removed, league }`.

**Live rounds (Brian, Nov 23 2026):** remove, leave and hand-over are allowed anytime, including during a live round. Nothing blocks them and the round (players, cells, history) is not touched.

### W16 `POST /v1/leagues/members/leave`

`{ leagueId }`. Any current member except the organizer, who gets 403 `forbidden` (decision 8: hand over first). Deletes only the caller's member row (and their [member handicap](#member-handicaps) row, if any). Screen 10: "Your past rounds stay in the standings. You can rejoin with the league code." No league, not a member, or blocked either way with the owner: 404 `not_found`. Answers `{ left: <callerId> }`.

### W17 `POST /v1/leagues/members/handover`

`{ leagueId, memberId }` (memberId = the new organizer). One roster transaction: the caller must be the organizer (403 `forbidden`); the target must be a current member (404 `not_found`) with the app and not the caller (400 `invalid_body`; decision 5). The target's role becomes `owner`, `league.owner_id` becomes the target, and the caller's member row (and their member handicap row, if any) is deleted. No `removed` row; no round or result is touched. Afterwards the new organizer passes every organizer check (reset, remove, settings, claims list, approve / decline) and the old one passes none. Answers `{ left: <callerId>, league }` with the league after the change (new `ownerId` / `ownerName`, one fewer player).

Known effects: "Started by {name}" on League home is `ownerName`, so it shows the new organizer (there is one owner field; no creator field was approved). The owner-block rule follows the new organizer.

### `POST /v1/friends/request-by-member`

`{ league, memberId }` (`league` is the league id). Both the caller and the target must be current members of the league (404 `not_found`, also for no league or a block either way with the owner); the target must have the app and not be the caller (400 `invalid_body`). Then exactly `POST /v1/friends/requests` after its code lookup (one shared helper, `requestAfterLookup`): the caller blocked the target 409 `blocked`; the target blocked the caller `sent` (only the caller's outgoing note is stored, nothing to accept); already friends `already_friends`; your request pending `already_sent`; theirs pending `they_asked` (no second request); otherwise the request is written, `sent`. Answers `{ outcome }`. It uses no friend-code guess.

### Limits

- W6, W7, W10–W13, W16, W17 and request-by-member: the member read limit (`keylgread:` / `iplgread:`, 60 per key and per IP per hour).
- W9: join's limits (the friend-code guess limit; a code that lets the caller in gives its guess back).
- No new limiter prefix.

## Member handicaps

ShotTraxx plan `docs/leagues/net-handicaps.md`. Each member publishes their **own** handicap index to each league they're in, so the host's phone can read it from the members list at round start and work out a course handicap to send in W1's `courseHandicap`.

### `POST /v1/leagues/members/handicap`

`{ leagueId, index }`, both keys required and no others (400 `invalid_body`). `index` is `null` (withdraw) or a finite number from -54.0 to 54.0 inclusive with at most one decimal (negative = a plus index, as the app's `parseManualHandicapIndex`). Anything else (a string, `12.34`, `54.1`, `-54.1`, a missing `index`) is 400 `invalid_body`.

- It always writes the caller's own row. There is no `memberId` field: nobody, the organizer included, can set another member's index, and a no-app spot can never have one.
- Not a member: 403 `forbidden`. No league, or blocked either way with the owner: 404 `not_found`.
- Limits: the member read limit (`keylgread:` / `iplgread:`), as W6 and W16.
- Answers `{ memberId, handicapIndex }`. After a withdraw `handicapIndex` is `null`. When the index was set is stored (`set_at`) but never sent (Brian, Nov 26 2026: don't expose how old a shared handicap is).

### Members list

`GET /v1/leagues/members` adds `handicapIndex` (number) to a member who has published an index. A member without one has no such key, so those rows are exactly as before. No row ever carries when the index was set.

### Storage and cleanup

- A new table in the league's roster object: `member_handicap (member_id TEXT PRIMARY KEY, idx REAL NOT NULL, set_at INTEGER NOT NULL)`.
- The row is deleted in the same transaction when the member leaves (W16), is removed, or hands over and leaves (W17, the leaving organizer only). On a claim approve the no-app spot never had a row and the claimer's own row (if any) stays as it is.
- Nothing else reads it: W1 still snapshots whatever `courseHandicap` the host sends, and finish, scoring and standings are unchanged.

### Not built

The `/l/` landing page.
