# Leagues API (PR 1 of 4)

Built from the approved league mockups (Brian, Oct 29 2026, 8:44 AM CT). Not deployed.

Every call uses the friends `X-Friend-Key`. The caller needs a friend code already (`POST /v1/friends/code`); their league member id is that `ownerId`.

| Call | Body / query | Answer |
| --- | --- | --- |
| `POST /v1/leagues` | `{ name, yourName, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds }` | `{ league, code }` |
| `POST /v1/leagues/preview` | `{ code }` | `{ league }` (no member list, no owner id) |
| `POST /v1/leagues/join` | `{ code, name }` | `{ league, joined }` |
| `GET /v1/leagues/members` | `?league=<id>` | `{ league, code, members: [{ memberId, name, role, joinedAt }] }` |
| `GET /v1/leagues/standings` | `?league=<id>` | `{ season, rounds, rows: [{ memberId, name, rank, tied, rounds, avgNet, skins, points }] }` |

- `game`: strokePlay, skins, stableford, matchPlay, nassau. `scoring`: gross or net. `carryOver` only with skins.
- Names: 1-24 characters, spaces collapsed. `yourName` and the join `name` also set the caller's Friends name (one name per player).
- League name: 1-32 characters (placeholder limit; the mockups give none).
- Season dates are `YYYY-MM-DD`, start on or before end.
- Codes: friend-code alphabet and validator, 8 characters, never expire. Preview and join use the friend code guess limit (8 per key, 24 per IP per hour), but only failed or unknown-code attempts count: a successful preview or join (200) gives its guess back. A caller already at the limit gets 429 even with a valid code, until the hour window resets.
- Cap: 20 players including the owner. One SQLite Durable Object per league (`LeagueRoster`) checks the cap and inserts in one transaction. Over the cap: 409 `league_full`. A repeat join is a no-op.
- A caller the owner blocked gets 404 `code_not_found`, the same as a bad code.
- Members and standings: members only; anyone else gets 404.
- New leagues: 30 per IP per hour. Member/standings reads: 60 per key and per IP per hour.
- KV holds only `lg:code:<CODE>` -> league id.

## Standings

Derived on each read from finished round results; never stored. Rules (mockup 5 footnote, PLAN.md "Standings and running stats"):

- Only finished league rounds whose date falls inside the season (inclusive) count.
- 6 points for 1st, down to 1; 6th and below get 1.
- Ties split the points of the places they cover (two tied for 2nd get (5+4)/2 = 4.5 each).
- In team games every player on a team gets that team's points.
- Avg net: 18-hole rounds with a net score only. Skins: skins won.
- Equal points share a rank, shown tied.

Nothing writes round results yet; rounds posting to a league comes in PR 4.
