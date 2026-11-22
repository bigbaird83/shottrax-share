/**
 * Leagues, PR 1 of 4: create a league, preview and join by invite code,
 * list members, and read standings. Built from the approved mockups in
 * /workspace/mockups/leagues (Brian, Oct 29 2026): screens 1, 5, 8, 9, 10, 12.
 *
 * Auth is the friends X-Friend-Key: the caller must already have a friend code
 * (friends.js getCode), and their league member id is that ownerId.
 * One SQLite Durable Object per league (LeagueRoster) holds the league row,
 * its members and its round results. A join checks the 20-player cap and
 * inserts in one transaction, so two joins can never make 21.
 * KV holds only lg:code:<CODE> -> leagueId. No names, scores or members in KV.
 *
 * Decision 8 (Brian, Nov 17 2026): a removed player rejoins only with a new code.
 * The organizer can remove a member and reset the code; the roster keeps the
 * code each member was removed under, and that person's old code reads as an
 * unknown code (404 code_not_found) on preview, join and claims.
 *
 * League rounds (W-A, Brian, Nov 18 / Nov 22 2026, ShotTraxx #900): W1 start, W2 score
 * (compare-and-set, every edit kept in history), W3 live read, W4 finish (also automatic when
 * everyone has scored every hole), W5 the round-started push, and W15 league settings.
 * Game points (W-C) for all five games are scored at finish from the round's own snapshot
 * of the league's point values and Add/Replace mode (decision 23: never rescore past rounds).
 * Scoring is the app's engine, ported in league-scoring.js.
 *
 * Not here yet (later PRs): leaving, claims beyond the decision-8 gate, no-app players,
 * renames, the owner adding friends directly, member handicaps, and the /l/ landing page.
 */
import {
  EXPO_PUSH_URL,
  PUSH_TOKEN_RE,
  boardsBinding,
  consumeIpAction,
  consumeReadLimit,
  friendGet,
  friendJson,
  friendKvKey,
  friendPut,
  guessNamespace,
  hasBlock,
  loadCaller,
  normalizeFriendCode,
  randomFriendCode,
  randomOwnerId,
  readFriendKey,
  readInviteName,
  readJsonObject,
  reserveGuess,
  unknownFields,
  validCourseName,
  validPlayedOn,
} from "./friends.js";
import {
  POINTS_EPSILON,
  POINTS_MODES,
  applyScoreWrite,
  everyoneFinished,
  leagueRoundResults,
  mergeGamePoints,
  resolveGamePoints,
  resolvePointsMode,
} from "./league-scoring.js";

/** Screens 2, 8, 9, 14: "Up to 20 players", "14 / 20". Owner included. */
export const LEAGUE_MAX_PLAYERS = 20;
/** Screen 1 "League name". The mockups give no limit; 32 is a placeholder for Brian. */
export const LEAGUE_NAME_MAX = 32;
/** Screen 4 "Existing games". Same ids as the app's GroupGameId. */
export const LEAGUE_GAMES = Object.freeze(["strokePlay", "skins", "stableford", "matchPlay", "nassau"]);
/** Screens 1 and 4 "Scoring": Gross or Net. */
export const LEAGUE_SCORINGS = Object.freeze(["gross", "net"]);
/** Screen 5: "6 for 1st in a round, down to 1." */
export const LEAGUE_FIRST_PLACE_POINTS = 6;

/** Push 3 game names (app leagueCopy.ts LEAGUE_GAME_LABEL). */
export const LEAGUE_GAME_LABEL = Object.freeze({
  strokePlay: "Stroke play",
  skins: "Skins",
  stableford: "Stableford",
  matchPlay: "Match play",
  nassau: "Nassau",
});
/** W1: 18 holes and 20 players with their fields fit well under this. */
export const LEAGUE_ROUND_BODY_LIMIT = 16 * 1024;
/** W1: the app's parseGroupHandicap range. */
export const LEAGUE_HANDICAP_MAX = 54;
export const LEAGUE_TEAMS_MODES = Object.freeze(["pairs", "teams"]);

const LEAGUE_BODY_LIMIT = 2048;
const LEAGUE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** A round id is its league id, "_", and 16 random characters (39 in all). */
const ROUND_ID_RE = /^[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{16}$/;
const LEAGUE_KV_PREFIX = "lg:";

const ROSTER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS league (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    league_id TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    code TEXT NOT NULL,
    game TEXT NOT NULL,
    scoring TEXT NOT NULL,
    carry_over INTEGER NOT NULL,
    home_course TEXT,
    season_starts TEXT NOT NULL,
    season_ends TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    round_day INTEGER,
    game_points TEXT,
    points_mode TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS member (
    member_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS round_results (
    round_id TEXT NOT NULL,
    played_on TEXT NOT NULL,
    finished INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    unit TEXT NOT NULL,
    place INTEGER NOT NULL,
    net INTEGER,
    holes INTEGER NOT NULL,
    skins INTEGER,
    PRIMARY KEY (round_id, member_id)
  )`,
  // One row per league round (W1). Game, scoring and the point values are a snapshot taken at start.
  `CREATE TABLE IF NOT EXISTS league_round (
    round_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    played_on TEXT NOT NULL,
    course TEXT NOT NULL,
    holes TEXT NOT NULL,
    game TEXT NOT NULL,
    scoring TEXT NOT NULL,
    carry_over INTEGER NOT NULL,
    teams_mode TEXT,
    teams TEXT,
    players TEXT NOT NULL,
    game_points TEXT NOT NULL,
    points_mode TEXT NOT NULL,
    finished INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  // The current cell per player and hole (W2).
  `CREATE TABLE IF NOT EXISTS round_cell (
    round_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    hole INTEGER NOT NULL,
    strokes INTEGER,
    rev INTEGER NOT NULL,
    entered_by TEXT NOT NULL,
    by_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (round_id, member_id, hole)
  )`,
  // Every accepted edit, in order. Never sent to phones.
  `CREATE TABLE IF NOT EXISTS round_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    hole INTEGER NOT NULL,
    strokes INTEGER,
    rev INTEGER NOT NULL,
    entered_by TEXT NOT NULL,
    by_id TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // When each member's phone last reached a round route (the live leaderboard's "⏳ 2m").
  `CREATE TABLE IF NOT EXISTS last_seen (
    member_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  )`,
  // Decision 8: the league code each removed member was removed under. Overwritten on a later removal.
  `CREATE TABLE IF NOT EXISTS removed (
    member_id TEXT PRIMARY KEY,
    removed_under TEXT NOT NULL,
    removed_at INTEGER NOT NULL
  )`,
];

/** Decision 8: a code lets a caller in unless it is the code they were removed under. */
export function codeLetsIn({ code, removedUnder }) {
  return removedUnder == null || removedUnder !== code;
}

export function isLeaguePath(pathname) {
  return pathname === "/v1/leagues" || pathname.startsWith("/v1/leagues/");
}

const LEAGUE_ROUTES = {
  "/v1/leagues": { POST: createLeague },
  "/v1/leagues/preview": { POST: previewLeague },
  "/v1/leagues/join": { POST: joinLeague },
  "/v1/leagues/members": { GET: listMembers },
  "/v1/leagues/members/remove": { POST: removeMember },
  "/v1/leagues/code/reset": { POST: resetLeagueCode },
  "/v1/leagues/claims": { POST: claimSpot },
  "/v1/leagues/standings": { GET: getStandings },
  "/v1/leagues/rounds": { POST: startRound, GET: liveRound },
  "/v1/leagues/rounds/score": { POST: scoreRound },
  "/v1/leagues/rounds/finish": { POST: finishRound },
  "/v1/leagues/settings": { POST: updateSettings },
};

export async function handleLeagues(request, url, env, cors) {
  if (!isLeaguePath(url.pathname)) return null;
  const route = LEAGUE_ROUTES[url.pathname];
  if (!route) return friendJson(404, { error: "unknown_route" }, cors);
  const handler = route[request.method];
  if (!handler) return friendJson(405, { error: "method_not_allowed" }, cors);
  return handler(request, url, env, cors);
}

/**
 * Body { name, yourName, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds, roundDay?, gamePoints?, pointsMode? }.
 * roundDay is the weekly round day the organizer picks, 0 (Sunday) to 6 (Saturday); missing or null = none.
 * gamePoints (a partial object, merged over the defaults) and pointsMode ("add" | "replace") are optional.
 * Answers { league, code }. The caller is the owner and the first member (1 / 20).
 */
async function createLeague(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const { boards, caller } = ready;
  const parsed = await readJsonObject(request, LEAGUE_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  const body = parsed.value;
  if (
    unknownFields(body, [
      "name",
      "yourName",
      "game",
      "scoring",
      "carryOver",
      "homeCourse",
      "seasonStarts",
      "seasonEnds",
      "roundDay",
      "gamePoints",
      "pointsMode",
    ])
  ) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const name = cleanLeagueName(body.name);
  const yourName = cleanPlayerName(body.yourName);
  if (!name) return friendJson(400, { error: "invalid_body" }, cors);
  if (!yourName) return friendJson(400, { error: "name_required" }, cors);
  if (!LEAGUE_GAMES.includes(body.game) || !LEAGUE_SCORINGS.includes(body.scoring)) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  if (typeof body.carryOver !== "boolean" || (body.carryOver && body.game !== "skins")) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  if (body.homeCourse !== null && !validCourseName(body.homeCourse)) return friendJson(400, { error: "invalid_body" }, cors);
  if (!validSeason(body.seasonStarts, body.seasonEnds)) return friendJson(400, { error: "invalid_body" }, cors);
  const roundDay = body.roundDay ?? null;
  if (roundDay !== null && !validRoundDay(roundDay)) return friendJson(400, { error: "invalid_body" }, cors);
  const points = readPointsFields(body, null);
  if (!points) return friendJson(400, { error: "invalid_body" }, cors);
  const limited = await consumeIpAction(request, env, "iplgnew:", cors);
  if (limited) return limited;
  const leagueId = randomOwnerId();
  const code = await unusedLeagueCode(boards);
  const answer = await rosterCall(env, leagueId, {
    op: "create",
    now: Date.now(),
    league: {
      leagueId,
      name,
      ownerId: caller.ownerId,
      code,
      game: body.game,
      scoring: body.scoring,
      carryOver: body.carryOver,
      homeCourse: body.homeCourse,
      seasonStarts: body.seasonStarts,
      seasonEnds: body.seasonEnds,
      roundDay,
      gamePoints: points.gamePoints,
      pointsMode: points.pointsMode,
    },
    owner: { memberId: caller.ownerId, name: yourName },
  });
  if (!answer.ok) return friendJson(409, { error: answer.error || "refused" }, cors);
  await leaguePut(boards, leagueKvKey("code", code), leagueId);
  await saveOwnName(boards, caller, yourName);
  return friendJson(200, { league: answer.league, code }, cors);
}

/** Body { code }. Screen 9 step 2 / screen 12: name, owner's name, course, count / 20, season. No member list. */
async function previewLeague(request, url, env, cors) {
  const found = await leagueForCode(request, env, cors, ["code"]);
  if (found.response) return found.response;
  const answer = await rosterCall(env, found.leagueId, { op: "preview", callerId: found.caller.ownerId });
  if (!answer.ok) return friendJson(404, { error: "code_not_found" }, cors);
  await found.refundGuess();
  return friendJson(200, { league: answer.league }, cors);
}

/**
 * Body { code, name }. The name is required (Brian, 8:41 AM) and becomes the
 * caller's one Friends name, the same as setInviteName. Joining again is a no-op.
 */
async function joinLeague(request, url, env, cors) {
  const found = await leagueForCode(request, env, cors, ["code", "name"]);
  if (found.response) return found.response;
  const name = cleanPlayerName(found.body.name);
  if (!name) return friendJson(400, { error: "name_required" }, cors);
  const answer = await rosterCall(env, found.leagueId, {
    op: "join",
    now: Date.now(),
    code: found.code,
    member: { memberId: found.caller.ownerId, name },
  });
  if (!answer.ok) {
    if (answer.error === "league_full") return friendJson(409, { error: "league_full" }, cors);
    return friendJson(404, { error: "code_not_found" }, cors);
  }
  await saveOwnName(found.boards, found.caller, name);
  await found.refundGuess();
  return friendJson(200, { league: answer.league, joined: answer.joined }, cors);
}

/**
 * Body { code, spotMemberId?, name? }. Claims are not built yet: this route exists so
 * decision 8 holds on it. A code that does not let the caller in is 404 code_not_found
 * (guess used); one that does gives the guess back and answers 501 not_implemented.
 * Nothing is stored.
 */
async function claimSpot(request, url, env, cors) {
  const found = await leagueForCode(request, env, cors, ["code", "spotMemberId", "name"]);
  if (found.response) return found.response;
  await found.refundGuess();
  return friendJson(501, { error: "not_implemented" }, cors);
}

/**
 * Body { leagueId, memberId }. Organizer only (403 forbidden otherwise); the organizer
 * cannot remove themselves. Missing league or member: 404 not_found. The roster keeps the
 * current code as the member's removedUnder (decision 8).
 */
async function removeMember(request, url, env, cors) {
  const ready = await readyOrganizerWrite(request, env, cors, ["leagueId", "memberId"]);
  if (ready.response) return ready.response;
  const memberId = ready.body.memberId;
  if (typeof memberId !== "string" || memberId.length < 1 || memberId.length > 64) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const answer = await rosterCall(env, ready.leagueId, {
    op: "remove",
    now: Date.now(),
    callerId: ready.caller.ownerId,
    memberId,
  });
  if (!answer.ok) return friendJson(answer.error === "forbidden" ? 403 : 404, { error: answer.error }, cors);
  return friendJson(200, { removed: memberId, league: answer.league }, cors);
}

/**
 * Body { leagueId }. Organizer only. Gives the league a new code and deletes the old
 * lg:code row, so the old code is unknown to everyone. removedUnder is kept: the new
 * code differs, so codeLetsIn lets a removed player back in with it.
 */
async function resetLeagueCode(request, url, env, cors) {
  const ready = await readyOrganizerWrite(request, env, cors, ["leagueId"]);
  if (ready.response) return ready.response;
  const code = await unusedLeagueCode(ready.boards);
  const answer = await rosterCall(env, ready.leagueId, { op: "reset", callerId: ready.caller.ownerId, code });
  if (!answer.ok) return friendJson(answer.error === "forbidden" ? 403 : 404, { error: answer.error }, cors);
  await leaguePut(ready.boards, leagueKvKey("code", code), ready.leagueId);
  if (answer.oldCode && answer.oldCode !== code) await leagueDelete(ready.boards, leagueKvKey("code", answer.oldCode));
  return friendJson(200, { code, league: answer.league }, cors);
}

/** GET ?league=<id>. Members only. Names are each player's own typed name; the code is shown to any member (screen 8). */
async function listMembers(request, url, env, cors) {
  const ready = await readyMemberRead(request, url, env, cors);
  if (ready.response) return ready.response;
  const answer = await rosterCall(env, ready.leagueId, { op: "members", callerId: ready.caller.ownerId });
  if (!answer.ok) return friendJson(404, { error: "not_found" }, cors);
  const members = [];
  for (const member of answer.members) {
    // One name per player: a later Friends name change shows here too.
    const current = readInviteName(await friendGet(ready.boards, friendKvKey("ownname", member.memberId)));
    members.push({ ...member, name: current || member.name });
  }
  return friendJson(200, { league: answer.league, code: answer.code, members }, cors);
}

/** GET ?league=<id>. Members only. Derived from finished round results; never stored. */
async function getStandings(request, url, env, cors) {
  const ready = await readyMemberRead(request, url, env, cors);
  if (ready.response) return ready.response;
  const answer = await rosterCall(env, ready.leagueId, { op: "standings", callerId: ready.caller.ownerId });
  if (!answer.ok) return friendJson(404, { error: "not_found" }, cors);
  const names = new Map();
  for (const member of answer.members) {
    const current = readInviteName(await friendGet(ready.boards, friendKvKey("ownname", member.memberId)));
    names.set(member.memberId, current || member.name);
  }
  const table = leagueStandings({
    season: { starts: answer.league.seasonStarts, ends: answer.league.seasonEnds },
    rounds: answer.rounds,
  });
  const rows = table.rows.map((row) => ({ ...row, name: names.get(row.memberId) || null }));
  return friendJson(200, { season: table.season, rounds: table.rounds, rows }, cors);
}

/**
 * W1. Body { leagueId, course, playedOn, holes, game, scoring, carryOver, teamsMode, teams, players }.
 * Any member can start a round (403 forbidden otherwise); one live round per league (409 round_live).
 * Names and kind come from the roster. The round snapshots the league's current game points and
 * Add/Replace mode, so a later W15 change never touches a round already started (decision 23).
 * Answers { round }. The round-started push (W5) goes out after the round is stored, best effort.
 */
async function startRound(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const parsed = await readJsonObject(request, LEAGUE_ROUND_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  const start = readRoundStart(parsed.value);
  if (!start) return friendJson(400, { error: "invalid_body" }, cors);
  const allowed = await readyLeague(request, env, cors, ready, start.leagueId, "keylgread:", "iplgread:");
  if (allowed) return allowed;
  const now = Date.now();
  const roundId = `${start.leagueId}_${randomOwnerId().slice(0, 16)}`;
  const answer = await rosterCall(env, start.leagueId, { op: "roundStart", callerId: ready.caller.ownerId, now, roundId, start });
  if (!answer.ok) return friendJson(roundErrorStatus(answer.error), { error: answer.error }, cors);
  try {
    await sendRoundStartPushes(env, ready.boards, answer.push);
  } catch {
    // Best effort (W5): the round is already stored.
  }
  return friendJson(200, { round: answer.round }, cors);
}

/** W2. Body { roundId, memberId, hole, strokes, rev }. Answers { cell }; a lost race is 409 conflict with the cell that won. */
async function scoreRound(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const parsed = await readJsonObject(request, LEAGUE_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  const body = parsed.value;
  if (unknownFields(body, ["roundId", "memberId", "hole", "strokes", "rev"])) return friendJson(400, { error: "invalid_body" }, cors);
  const leagueId = leagueIdOfRound(body.roundId);
  if (!leagueId) return friendJson(404, { error: "not_found" }, cors);
  if (typeof body.memberId !== "string" || body.memberId.length < 1 || body.memberId.length > 64) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  if (!Number.isInteger(body.hole) || !Number.isInteger(body.rev)) return friendJson(400, { error: "invalid_body" }, cors);
  if (body.strokes !== null && typeof body.strokes !== "number") return friendJson(400, { error: "invalid_body" }, cors);
  const allowed = await readyLeague(request, env, cors, ready, leagueId, "keylgwrite:", "iplgwrite:");
  if (allowed) return allowed;
  const answer = await rosterCall(env, leagueId, {
    op: "roundScore",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    roundId: body.roundId,
    memberId: body.memberId,
    hole: body.hole,
    strokes: body.strokes,
    rev: body.rev,
  });
  if (!answer.ok) {
    const out = { error: answer.error };
    if (answer.cell !== undefined) out.cell = answer.cell;
    return friendJson(roundErrorStatus(answer.error), out, cors);
  }
  return friendJson(200, { cell: answer.cell }, cors);
}

/**
 * W3. GET ?league=<id>&since=<ms>. Members only (403 forbidden). The live round, or with `since`
 * the latest round started at or after it (finished included), or null. Never the edit history.
 */
async function liveRound(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const leagueId = url.searchParams.get("league");
  const sinceRaw = url.searchParams.get("since");
  if (
    !leagueId ||
    !LEAGUE_ID_RE.test(leagueId) ||
    [...url.searchParams.keys()].some((k) => k !== "league" && k !== "since") ||
    (sinceRaw !== null && !/^\d{1,16}$/.test(sinceRaw))
  ) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const allowed = await readyLeague(request, env, cors, ready, leagueId, "keylglive:", "iplglive:");
  if (allowed) return allowed;
  const answer = await rosterCall(env, leagueId, {
    op: "roundLive",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    since: sinceRaw === null ? null : Number(sinceRaw),
  });
  if (!answer.ok) return friendJson(roundErrorStatus(answer.error), { error: answer.error }, cors);
  return friendJson(200, { round: answer.round, lastSeen: answer.lastSeen, now: answer.now }, cors);
}

/** W4. Body { roundId }. Host only (403); a finished round is 409 finished. Answers { results }. */
async function finishRound(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const parsed = await readJsonObject(request, LEAGUE_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["roundId"])) return friendJson(400, { error: "invalid_body" }, cors);
  const leagueId = leagueIdOfRound(parsed.value.roundId);
  if (!leagueId) return friendJson(404, { error: "not_found" }, cors);
  const allowed = await readyLeague(request, env, cors, ready, leagueId, "keylgread:", "iplgread:");
  if (allowed) return allowed;
  const answer = await rosterCall(env, leagueId, {
    op: "roundFinish",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    roundId: parsed.value.roundId,
  });
  if (!answer.ok) return friendJson(roundErrorStatus(answer.error), { error: answer.error }, cors);
  return friendJson(200, { results: answer.results }, cors);
}

/**
 * W15. Body { leagueId, name, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds, roundDay, gamePoints?, pointsMode? }.
 * Organizer only. Updates the league row only: rounds and round_results are never touched (decision 23).
 * A body without gamePoints / pointsMode leaves them as they are. Answers { league }.
 */
async function updateSettings(request, url, env, cors) {
  const ready = await readyOrganizerWrite(request, env, cors, [
    "leagueId",
    "name",
    "game",
    "scoring",
    "carryOver",
    "homeCourse",
    "seasonStarts",
    "seasonEnds",
    "roundDay",
    "gamePoints",
    "pointsMode",
  ]);
  if (ready.response) return ready.response;
  const read = readSettings(ready.body);
  const answer = await rosterCall(env, ready.leagueId, {
    op: "settings",
    callerId: ready.caller.ownerId,
    refusal: read.refusal,
    settings: read.settings,
    gamePoints: read.gamePoints,
    pointsMode: read.pointsMode,
  });
  if (!answer.ok) {
    const status = answer.error === "forbidden" ? 403 : answer.error === "season_before_round" ? 409 : answer.error === "not_found" ? 404 : 400;
    return friendJson(status, { error: answer.error }, cors);
  }
  return friendJson(200, { league: answer.league }, cors);
}

/** W15 body checks, in the app's leagueSettingsRefusal order after the organizer check (done in the roster). */
function readSettings(body) {
  const fail = (refusal) => ({ refusal, settings: null });
  const name = cleanLeagueName(body.name);
  if (!name) return fail("name_required");
  if (!LEAGUE_GAMES.includes(body.game) || !LEAGUE_SCORINGS.includes(body.scoring)) return fail("invalid_body");
  if (typeof body.carryOver !== "boolean") return fail("invalid_body");
  if (body.homeCourse !== null && !validCourseName(body.homeCourse)) return fail("invalid_body");
  if (!validSeason(body.seasonStarts, body.seasonEnds)) return fail("invalid_body");
  const roundDay = body.roundDay ?? null;
  if (roundDay !== null && !validRoundDay(roundDay)) return fail("invalid_body");
  const points = readPointsFields(body);
  if (!points) return fail("invalid_body");
  return {
    refusal: null,
    settings: {
      name,
      game: body.game,
      scoring: body.scoring,
      // As the app's leagueSettingsForWorker: carry-over is a skins setting only.
      carryOver: body.game === "skins" ? body.carryOver : false,
      homeCourse: body.homeCourse,
      seasonStarts: body.seasonStarts,
      seasonEnds: body.seasonEnds,
      roundDay,
    },
    gamePoints: points.gamePoints,
    pointsMode: points.pointsMode,
  };
}

/**
 * The optional gamePoints / pointsMode fields of create and W15. Null when either is invalid.
 * gamePoints is returned as the partial patch (merged in the roster over what is stored);
 * undefined means "not sent" (leave as is). A null field counts as not sent.
 */
function readPointsFields(body) {
  let gamePoints;
  let pointsMode;
  if (body.gamePoints !== undefined && body.gamePoints !== null) {
    if (!mergeGamePoints(null, body.gamePoints)) return null;
    gamePoints = body.gamePoints;
  }
  if (body.pointsMode !== undefined && body.pointsMode !== null) {
    if (!POINTS_MODES.includes(body.pointsMode)) return null;
    pointsMode = body.pointsMode;
  }
  return { gamePoints, pointsMode };
}

/** W1 body, checked field by field. Null on any failure (400 invalid_body). */
function readRoundStart(body) {
  const allowed = ["leagueId", "course", "playedOn", "holes", "game", "scoring", "carryOver", "teamsMode", "teams", "players"];
  if (unknownFields(body, allowed) || allowed.some((k) => !(k in body))) return null;
  if (typeof body.leagueId !== "string" || !LEAGUE_ID_RE.test(body.leagueId)) return null;
  if (!validCourseName(body.course) || !validPlayedOn(body.playedOn)) return null;
  if (!LEAGUE_GAMES.includes(body.game) || !LEAGUE_SCORINGS.includes(body.scoring)) return null;
  if (typeof body.carryOver !== "boolean" || (body.carryOver && body.game !== "skins")) return null;
  const holes = readRoundHoles(body.holes);
  if (!holes) return null;
  const players = readRoundPlayers(body.players);
  if (!players) return null;
  if (body.teamsMode !== null && !LEAGUE_TEAMS_MODES.includes(body.teamsMode)) return null;
  const teams = readRoundTeams(body.teams, players);
  if (teams === false) return null;
  return {
    leagueId: body.leagueId,
    course: body.course,
    playedOn: body.playedOn,
    holes,
    game: body.game,
    scoring: body.scoring,
    carryOver: body.carryOver,
    teamsMode: body.teamsMode,
    // The app reads teams only with a teams mode (parseLeagueRound); an empty list is none.
    teams: body.teamsMode && teams && teams.length > 0 ? teams : null,
    players,
  };
}

function readRoundHoles(raw) {
  if (!Array.isArray(raw) || (raw.length !== 9 && raw.length !== 18)) return null;
  const seen = new Set();
  const holes = [];
  for (const h of raw) {
    if (h == null || typeof h !== "object" || Array.isArray(h) || unknownFields(h, ["number", "par", "strokeIndex"])) return null;
    const { number } = h;
    const par = h.par ?? null;
    const strokeIndex = h.strokeIndex ?? null;
    if (!Number.isInteger(number) || number < 1 || number > 18 || seen.has(number)) return null;
    if (par !== null && !(Number.isInteger(par) && par >= 3 && par <= 6)) return null;
    if (strokeIndex !== null && !(Number.isInteger(strokeIndex) && strokeIndex >= 1 && strokeIndex <= 18)) return null;
    seen.add(number);
    holes.push({ number, par, strokeIndex });
  }
  return holes;
}

function readRoundPlayers(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LEAGUE_MAX_PLAYERS) return null;
  const seen = new Set();
  const players = [];
  for (const p of raw) {
    if (p == null || typeof p !== "object" || Array.isArray(p) || unknownFields(p, ["memberId", "groupNo", "courseHandicap", "hostEnters"])) return null;
    const { memberId, groupNo, courseHandicap, hostEnters } = p;
    if (typeof memberId !== "string" || memberId.length < 1 || memberId.length > 64 || seen.has(memberId)) return null;
    if (!Number.isInteger(groupNo) || groupNo < 1) return null;
    if (courseHandicap !== null && !(Number.isInteger(courseHandicap) && courseHandicap >= 0 && courseHandicap <= LEAGUE_HANDICAP_MAX)) return null;
    if (typeof hostEnters !== "boolean") return null;
    seen.add(memberId);
    players.push({ memberId, groupNo, courseHandicap, hostEnters });
  }
  return players;
}

/** Teams: null, or teams of players in the round, each player in at most one team. False when invalid. */
function readRoundTeams(raw, players) {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > LEAGUE_MAX_PLAYERS) return false;
  const inRound = new Set(players.map((p) => p.memberId));
  const placed = new Set();
  const numbers = new Set();
  const teams = [];
  for (const t of raw) {
    if (t == null || typeof t !== "object" || Array.isArray(t) || unknownFields(t, ["teamNo", "memberIds"])) return false;
    if (!Number.isInteger(t.teamNo) || numbers.has(t.teamNo) || !Array.isArray(t.memberIds)) return false;
    for (const id of t.memberIds) {
      if (typeof id !== "string" || !inRound.has(id) || placed.has(id)) return false;
      placed.add(id);
    }
    numbers.add(t.teamNo);
    teams.push({ teamNo: t.teamNo, memberIds: [...t.memberIds] });
  }
  return teams;
}

function leagueIdOfRound(roundId) {
  return typeof roundId === "string" && ROUND_ID_RE.test(roundId) ? roundId.slice(0, 22) : null;
}

/** Status per refusal, as the app's fake Worker maps them. */
function roundErrorStatus(error) {
  if (error === "forbidden" || error === "host_entered") return 403;
  if (error === "conflict" || error === "finished" || error === "round_live") return 409;
  if (error === "not_found") return 404;
  return 400;
}

/** Round routes: the rate limit, then the owner-block check readyMemberRead makes (404 when blocked either way). */
async function readyLeague(request, env, cors, ready, leagueId, keyPrefix, ipPrefix) {
  const limited = await consumeReadLimit(request, env, ready.friendKey, keyPrefix, ipPrefix, cors);
  if (limited) return limited;
  const owner = await rosterCall(env, leagueId, { op: "owner" });
  if (!owner.ok || (await blockedEitherWay(ready.boards, owner.ownerId, ready.caller.ownerId))) {
    return friendJson(404, { error: "not_found" }, cors);
  }
  return null;
}

/**
 * W5, best effort after W1 is stored (the same pattern as shared-games sendInvitePushes): every
 * member except the starter, skipping anyone blocked either way with the starter and anyone with
 * no valid push token. The data is ids only.
 */
async function sendRoundStartPushes(env, boards, push) {
  if (!push || !Array.isArray(push.memberIds)) return;
  const starterName = readInviteName(await friendGet(boards, friendKvKey("ownname", push.starterId))) || push.starterName;
  const title = `${starterName} started a league round`;
  const body = `${push.leagueName}: ${LEAGUE_GAME_LABEL[push.game]} at ${push.course}. Tap to follow the live leaderboard.`;
  const messages = [];
  for (const memberId of push.memberIds) {
    if (memberId === push.starterId) continue;
    if (await blockedEitherWay(boards, push.starterId, memberId)) continue;
    const token = await friendGet(boards, friendKvKey("push", memberId));
    if (typeof token !== "string" || !PUSH_TOKEN_RE.test(token)) continue;
    messages.push({
      to: token,
      title,
      body,
      sound: "default",
      data: { kind: "league_round_start", leagueId: push.leagueId, roundId: push.roundId },
    });
  }
  if (messages.length === 0) return;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (env && typeof env.EXPO_ACCESS_TOKEN === "string" && env.EXPO_ACCESS_TOKEN.length > 0) {
    headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }
  try {
    await fetch(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(messages) });
  } catch {
    // Best effort: the round is already stored.
  }
}

/**
 * Standings for one season. Sources (mockup 5 footnote and PLAN "Standings and running stats"):
 * - Only finished league rounds count, and only rounds played inside the season dates (inclusive).
 * - Each round: 6 points for 1st, 5 for 2nd, down to 1; 6th and below get 1.
 * - Ties split the points: tied units share the average of the places they cover.
 * - In team games every player on a team gets that team's points (a result's `unit` is the team).
 * - Rds = finished season rounds played. Avg net = mean net of finished 18-hole rounds that have a
 *   net score (9-hole rounds are left out), one decimal, null when none. Skins = skins won.
 * - Rank by points; equal points share a rank shown as "T3". Rows inside a tie are ordered by
 *   lower Avg net, then member id. The mockup's example fits this order, but no rule is written: open question.
 * Only players with at least one counted round get a row.
 * - Game points (W-C): each round's points per member = finish points (0 when that ROUND's
 *   pointsMode is "replace"; the league's current mode is never read) + that member's game points.
 *   A row carries gamePoints (the season sum) once any counted round stored game points.
 * - Points stay exact (4/3 is 4/3); equal points (within 1e-9) share a rank.
 *
 * rounds: [{ roundId, playedOn, finished, pointsMode?, results: [{ memberId, unit, place, net, holes, skins, gamePoints? }] }]
 */
export function leagueStandings({ season, rounds }) {
  const counted = rounds.filter(
    (round) => round.finished === true && round.playedOn >= season.starts && round.playedOn <= season.ends,
  );
  const byMember = new Map();
  for (const round of counted) {
    const finish = round.pointsMode === "replace" ? null : roundPoints(round.results);
    for (const result of round.results) {
      let row = byMember.get(result.memberId);
      if (!row) {
        row = { memberId: result.memberId, rounds: 0, points: 0, skins: 0, netSum: 0, netCount: 0, gamePoints: null };
        byMember.set(result.memberId, row);
      }
      row.rounds += 1;
      const game = typeof result.gamePoints === "number" && Number.isFinite(result.gamePoints) ? result.gamePoints : null;
      row.points += (finish ? (finish.get(result.unit) ?? 0) : 0) + (game ?? 0);
      if (game != null) row.gamePoints = (row.gamePoints ?? 0) + game;
      if (Number.isInteger(result.skins)) row.skins += result.skins;
      if (result.holes === 18 && Number.isFinite(result.net)) {
        row.netSum += result.net;
        row.netCount += 1;
      }
    }
  }
  const rows = [...byMember.values()].map((row) => ({
    memberId: row.memberId,
    rounds: row.rounds,
    avgNet: row.netCount > 0 ? Math.round((row.netSum / row.netCount) * 10) / 10 : null,
    skins: row.skins,
    points: row.points,
    ...(row.gamePoints != null ? { gamePoints: row.gamePoints } : {}),
  }));
  const samePoints = (a, b) => Math.abs(a - b) <= POINTS_EPSILON;
  rows.sort((a, b) => {
    if (!samePoints(a.points, b.points)) return b.points - a.points;
    const an = a.avgNet == null ? Infinity : a.avgNet;
    const bn = b.avgNet == null ? Infinity : b.avgNet;
    if (an !== bn) return an - bn;
    return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
  });
  let rank = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0 || !samePoints(rows[i].points, rows[i - 1].points)) rank = i + 1;
    rows[i].rank = rank;
  }
  for (const row of rows) {
    row.tied = rows.filter((other) => other.rank === row.rank).length > 1;
  }
  return { season: { starts: season.starts, ends: season.ends }, rounds: counted.length, rows };
}

/** Points per unit (player or team) for one round. Lower place is better; gaps in place numbers are ignored. */
export function roundPoints(results) {
  const placeByUnit = new Map();
  for (const result of results) {
    if (!placeByUnit.has(result.unit)) placeByUnit.set(result.unit, result.place);
  }
  const units = [...placeByUnit.entries()];
  const points = new Map();
  for (const [unit, place] of units) {
    const better = units.filter(([, other]) => other < place).length;
    const tied = units.filter(([, other]) => other === place).length;
    let sum = 0;
    for (let position = better + 1; position <= better + tied; position += 1) sum += pointsForPosition(position);
    points.set(unit, sum / tied);
  }
  return points;
}

export function pointsForPosition(position) {
  return Math.max(1, LEAGUE_FIRST_PLACE_POINTS + 1 - position);
}

/** One SQLite Durable Object per league. Every write is a synchronous transaction. */
export class LeagueRoster {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      this.#ensure();
    });
  }

  #ready;

  async fetch(request) {
    await this.#ready;
    if (request.method !== "POST") return rosterJson({ ok: false, error: "method_not_allowed" }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return rosterJson({ ok: false, error: "invalid_body" }, 400);
    }
    const op = body && body.op;
    if (op === "create") return rosterJson(this.ctx.storage.transactionSync(() => this.#create(body)));
    if (op === "join") return rosterJson(this.ctx.storage.transactionSync(() => this.#join(body)));
    if (op === "preview") return rosterJson(this.#preview(body));
    if (op === "remove") return rosterJson(this.ctx.storage.transactionSync(() => this.#remove(body)));
    if (op === "reset") return rosterJson(this.ctx.storage.transactionSync(() => this.#reset(body)));
    if (op === "owner") {
      const row = this.#league();
      if (!row) return rosterJson({ ok: false, error: "not_found" });
      return rosterJson({ ok: true, ownerId: row.owner_id, removedUnder: this.#removedUnder(body.callerId) });
    }
    if (op === "members") return rosterJson(this.#members(body));
    if (op === "standings") return rosterJson(this.#standings(body));
    if (op === "roundStart") return rosterJson(this.ctx.storage.transactionSync(() => this.#roundStart(body)));
    if (op === "roundScore") return rosterJson(this.ctx.storage.transactionSync(() => this.#roundScore(body)));
    if (op === "roundLive") return rosterJson(this.ctx.storage.transactionSync(() => this.#roundLive(body)));
    if (op === "roundFinish") return rosterJson(this.ctx.storage.transactionSync(() => this.#roundFinishOp(body)));
    if (op === "settings") return rosterJson(this.ctx.storage.transactionSync(() => this.#settings(body)));
    return rosterJson({ ok: false, error: "invalid_body" }, 400);
  }

  #ensure() {
    for (const statement of ROSTER_SCHEMA) this.ctx.storage.sql.exec(statement);
    // Leagues made before round days: add the column (null = no round set). Additive only.
    const columns = this.#sql("SELECT name FROM pragma_table_info('league')").map((c) => c.name);
    if (!columns.includes("round_day")) this.ctx.storage.sql.exec("ALTER TABLE league ADD COLUMN round_day INTEGER");
    // Leagues made before game points (W-C): null = the defaults, and Add.
    if (!columns.includes("game_points")) this.ctx.storage.sql.exec("ALTER TABLE league ADD COLUMN game_points TEXT");
    if (!columns.includes("points_mode")) this.ctx.storage.sql.exec("ALTER TABLE league ADD COLUMN points_mode TEXT");
  }

  /**
   * round_results gains game_points, points_mode and incomplete (nullable; null reads as 0, Add,
   * and not known) the first time a round finishes here. Added then, not in #ensure, so the
   * table's original 9-column shape stays as it is until this Worker writes a result. Additive only.
   */
  #ensureResultColumns() {
    const columns = this.#sql("SELECT name FROM pragma_table_info('round_results')").map((c) => c.name);
    if (!columns.includes("game_points")) this.ctx.storage.sql.exec("ALTER TABLE round_results ADD COLUMN game_points REAL");
    if (!columns.includes("points_mode")) this.ctx.storage.sql.exec("ALTER TABLE round_results ADD COLUMN points_mode TEXT");
    if (!columns.includes("incomplete")) this.ctx.storage.sql.exec("ALTER TABLE round_results ADD COLUMN incomplete INTEGER");
  }

  #sql(query, ...bindings) {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }

  #league() {
    const rows = this.#sql("SELECT * FROM league WHERE id = 1");
    return rows.length === 1 ? rows[0] : null;
  }

  #removedUnder(memberId) {
    if (typeof memberId !== "string") return null;
    const rows = this.#sql("SELECT removed_under FROM removed WHERE member_id = ?", memberId);
    return rows.length === 1 ? rows[0].removed_under : null;
  }

  #role(memberId) {
    if (typeof memberId !== "string") return null;
    const rows = this.#sql("SELECT role FROM member WHERE member_id = ?", memberId);
    return rows.length === 1 ? rows[0].role : null;
  }

  #count() {
    return Number(this.#sql("SELECT COUNT(*) AS n FROM member")[0].n);
  }

  #isMember(memberId) {
    return typeof memberId === "string" && this.#sql("SELECT member_id FROM member WHERE member_id = ?", memberId).length === 1;
  }

  #publicLeague(row) {
    const owner = this.#sql("SELECT name FROM member WHERE member_id = ?", row.owner_id)[0];
    return {
      id: row.league_id,
      name: row.name,
      ownerId: row.owner_id,
      ownerName: owner ? owner.name : null,
      game: row.game,
      scoring: row.scoring,
      carryOver: Number(row.carry_over) === 1,
      homeCourse: row.home_course ?? null,
      seasonStarts: row.season_starts,
      seasonEnds: row.season_ends,
      roundDay: validRoundDay(row.round_day) ? Number(row.round_day) : null,
      players: this.#count(),
      maxPlayers: LEAGUE_MAX_PLAYERS,
      gamePoints: resolveGamePoints(parseStoredJson(row.game_points)),
      pointsMode: resolvePointsMode(row.points_mode),
    };
  }

  #create({ league, owner, now }) {
    if (this.#league()) return { ok: false, error: "league_exists" };
    this.ctx.storage.sql.exec(
      `INSERT INTO league (id, league_id, name, owner_id, code, game, scoring, carry_over, home_course, season_starts, season_ends, created_at, round_day, game_points, points_mode)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      league.leagueId,
      league.name,
      league.ownerId,
      league.code,
      league.game,
      league.scoring,
      league.carryOver ? 1 : 0,
      league.homeCourse,
      league.seasonStarts,
      league.seasonEnds,
      now,
      league.roundDay ?? null,
      league.gamePoints ? JSON.stringify(mergeGamePoints(null, league.gamePoints)) : null,
      league.pointsMode ?? null,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO member (member_id, name, role, joined_at) VALUES (?, ?, 'owner', ?)",
      owner.memberId,
      owner.name,
      now,
    );
    return { ok: true, league: this.#publicLeague(this.#league()) };
  }

  #preview() {
    const row = this.#league();
    if (!row) return { ok: false, error: "not_found" };
    const league = this.#publicLeague(row);
    // The preview is for joining: no owner id, no member list.
    delete league.ownerId;
    return { ok: true, league };
  }

  #join({ code, member, now }) {
    const row = this.#league();
    // A reset (later PR) changes league.code; an old code must not join.
    if (!row || row.code !== code) return { ok: false, error: "not_found" };
    // Decision 8: the code this player was removed under does not let them back in.
    if (!codeLetsIn({ code, removedUnder: this.#removedUnder(member.memberId) })) return { ok: false, error: "not_found" };
    if (this.#isMember(member.memberId)) {
      this.ctx.storage.sql.exec("UPDATE member SET name = ? WHERE member_id = ?", member.name, member.memberId);
      return { ok: true, joined: false, league: this.#publicLeague(row) };
    }
    if (this.#count() >= LEAGUE_MAX_PLAYERS) return { ok: false, error: "league_full" };
    this.ctx.storage.sql.exec(
      "INSERT INTO member (member_id, name, role, joined_at) VALUES (?, ?, 'member', ?)",
      member.memberId,
      member.name,
      now,
    );
    return { ok: true, joined: true, league: this.#publicLeague(row) };
  }

  /** Organizer only (canRemoveMember: actor is organizer and the member is not the owner). */
  #remove({ callerId, memberId, now }) {
    const row = this.#league();
    if (!row) return { ok: false, error: "not_found" };
    if (this.#role(callerId) !== "owner") return { ok: false, error: "forbidden" };
    const role = this.#role(memberId);
    if (role == null) return { ok: false, error: "not_found" };
    if (role === "owner") return { ok: false, error: "forbidden" };
    this.ctx.storage.sql.exec("DELETE FROM member WHERE member_id = ?", memberId);
    this.ctx.storage.sql.exec(
      `INSERT INTO removed (member_id, removed_under, removed_at) VALUES (?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET removed_under = excluded.removed_under, removed_at = excluded.removed_at`,
      memberId,
      row.code,
      now,
    );
    return { ok: true, league: this.#publicLeague(row) };
  }

  /** Organizer only. Answers the old code so the Worker can delete its KV row. */
  #reset({ callerId, code }) {
    const row = this.#league();
    if (!row) return { ok: false, error: "not_found" };
    if (this.#role(callerId) !== "owner") return { ok: false, error: "forbidden" };
    this.ctx.storage.sql.exec("UPDATE league SET code = ? WHERE id = 1", code);
    return { ok: true, oldCode: row.code, league: this.#publicLeague(this.#league()) };
  }

  #members({ callerId }) {
    const row = this.#league();
    if (!row || !this.#isMember(callerId)) return { ok: false, error: "not_found" };
    const members = this.#sql("SELECT member_id, name, role, joined_at FROM member ORDER BY joined_at, member_id").map(
      (m) => ({ memberId: m.member_id, name: m.name, role: m.role, joinedAt: Number(m.joined_at) }),
    );
    return { ok: true, league: this.#publicLeague(row), code: row.code, members };
  }

  #standings({ callerId }) {
    const row = this.#league();
    if (!row || !this.#isMember(callerId)) return { ok: false, error: "not_found" };
    const members = this.#sql("SELECT member_id, name FROM member").map((m) => ({ memberId: m.member_id, name: m.name }));
    const byRound = new Map();
    for (const r of this.#sql("SELECT * FROM round_results ORDER BY round_id, member_id")) {
      let round = byRound.get(r.round_id);
      if (!round) {
        // The mode stored on the round's own rows (null or missing column = Add).
        round = { roundId: r.round_id, playedOn: r.played_on, finished: Number(r.finished) === 1, pointsMode: resolvePointsMode(r.points_mode), results: [] };
        byRound.set(r.round_id, round);
      }
      const result = {
        memberId: r.member_id,
        unit: r.unit,
        place: Number(r.place),
        net: r.net == null ? null : Number(r.net),
        holes: Number(r.holes),
        skins: r.skins == null ? null : Number(r.skins),
      };
      // Rows written before game points have no value: they count as 0.
      if (r.game_points != null) result.gamePoints = Number(r.game_points);
      round.results.push(result);
    }
    return { ok: true, league: this.#publicLeague(row), members, rounds: [...byRound.values()] };
  }

  // ------------------------------------------------------------------------------------------
  // League rounds (W1–W4) and settings (W15).

  #roundRow(roundId) {
    const rows = this.#sql("SELECT * FROM league_round WHERE round_id = ?", roundId);
    return rows.length === 1 ? rows[0] : null;
  }

  /** The round as leagueRound.ts LeagueRound (history left out: it never leaves the roster). */
  #loadRound(row) {
    const leagueId = this.#league().league_id;
    const cells = {};
    for (const c of this.#sql("SELECT * FROM round_cell WHERE round_id = ? ORDER BY member_id, hole", row.round_id)) {
      (cells[c.member_id] ??= {})[Number(c.hole)] = {
        strokes: c.strokes == null ? null : Number(c.strokes),
        rev: Number(c.rev),
        enteredBy: c.entered_by,
        by: c.by_id,
        at: Number(c.at),
      };
    }
    return {
      roundId: row.round_id,
      leagueId,
      hostId: row.host_id,
      startedAt: Number(row.started_at),
      playedOn: row.played_on,
      course: row.course,
      holes: JSON.parse(row.holes),
      game: row.game,
      scoring: row.scoring,
      carryOver: Number(row.carry_over) === 1,
      teamsMode: row.teams_mode ?? null,
      teams: row.teams == null ? null : JSON.parse(row.teams),
      players: JSON.parse(row.players),
      cells,
      finished: Number(row.finished) === 1,
      // The snapshot taken at start (decision 23). Today's app parser ignores these two.
      pointsMode: resolvePointsMode(row.points_mode),
      gamePoints: resolveGamePoints(parseStoredJson(row.game_points)),
    };
  }

  #lastSeen() {
    return Object.fromEntries(this.#sql("SELECT member_id, at FROM last_seen ORDER BY member_id").map((r) => [r.member_id, Number(r.at)]));
  }

  #roundStart({ callerId, now, roundId, start }) {
    const league = this.#league();
    if (!league) return { ok: false, error: "not_found" };
    if (!this.#isMember(callerId)) return { ok: false, error: "forbidden" };
    // Decision 1: one live round per league, checked inside this transaction.
    if (this.#sql("SELECT round_id FROM league_round WHERE finished = 0 LIMIT 1").length > 0) return { ok: false, error: "round_live" };
    const roster = new Map(this.#sql("SELECT member_id, name FROM member").map((m) => [m.member_id, m.name]));
    if (start.players.some((p) => !roster.has(p.memberId))) return { ok: false, error: "invalid_body" };
    // Names and kind from the roster, never the body. Every member has the app until no-app players (W-B).
    const players = start.players.map((p) => ({
      memberId: p.memberId,
      name: roster.get(p.memberId),
      kind: "app",
      groupNo: p.groupNo,
      courseHandicap: p.courseHandicap,
      hostEnters: p.hostEnters,
    }));
    this.ctx.storage.sql.exec(
      `INSERT INTO league_round (round_id, host_id, started_at, played_on, course, holes, game, scoring, carry_over, teams_mode, teams, players, game_points, points_mode, finished, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      roundId,
      callerId,
      now,
      start.playedOn,
      start.course,
      JSON.stringify(start.holes),
      start.game,
      start.scoring,
      start.carryOver ? 1 : 0,
      start.teamsMode,
      start.teams == null ? null : JSON.stringify(start.teams),
      JSON.stringify(players),
      // Decision 23: the league's CURRENT resolved values, frozen onto the round.
      JSON.stringify(resolveGamePoints(parseStoredJson(league.game_points))),
      resolvePointsMode(league.points_mode),
    );
    this.#seen(callerId, now);
    return {
      ok: true,
      round: this.#loadRound(this.#roundRow(roundId)),
      push: {
        leagueId: league.league_id,
        roundId,
        leagueName: league.name,
        game: start.game,
        course: start.course,
        starterId: callerId,
        starterName: roster.get(callerId),
        memberIds: [...roster.keys()].sort(),
      },
    };
  }

  #seen(memberId, now) {
    this.ctx.storage.sql.exec(
      "INSERT INTO last_seen (member_id, at) VALUES (?, ?) ON CONFLICT(member_id) DO UPDATE SET at = excluded.at",
      memberId,
      now,
    );
  }

  #roundScore({ callerId, now, roundId, memberId, hole, strokes, rev }) {
    if (!this.#league()) return { ok: false, error: "not_found" };
    const row = this.#roundRow(roundId);
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isMember(callerId)) return { ok: false, error: "forbidden" };
    const round = this.#loadRound(row);
    const res = applyScoreWrite(round, { memberId, hole, strokes, rev, actorId: callerId, at: now });
    if (!res.ok) return { ok: false, error: res.reason, cell: res.cell };
    const cell = res.cell;
    this.ctx.storage.sql.exec(
      `INSERT INTO round_cell (round_id, member_id, hole, strokes, rev, entered_by, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(round_id, member_id, hole) DO UPDATE SET strokes = excluded.strokes, rev = excluded.rev,
         entered_by = excluded.entered_by, by_id = excluded.by_id, at = excluded.at`,
      roundId,
      memberId,
      hole,
      cell.strokes,
      cell.rev,
      cell.enteredBy,
      cell.by,
      cell.at,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO round_history (round_id, member_id, hole, strokes, rev, entered_by, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      roundId,
      memberId,
      hole,
      cell.strokes,
      cell.rev,
      cell.enteredBy,
      cell.by,
      cell.at,
    );
    this.#seen(callerId, now);
    // Decision 9 / W4: the round ends on its own when every player has scored every hole.
    if (everyoneFinished(res.round)) this.#finishRound(res.round, now);
    return { ok: true, cell };
  }

  #roundLive({ callerId, now, since }) {
    if (!this.#league()) return { ok: false, error: "not_found" };
    if (!this.#isMember(callerId)) return { ok: false, error: "forbidden" };
    // As the app's fake: a poll sets lastSeen only when it is missing.
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO last_seen (member_id, at) VALUES (?, ?)", callerId, now);
    let row = this.#sql("SELECT * FROM league_round WHERE finished = 0 LIMIT 1")[0] ?? null;
    if (!row && since != null) {
      row = this.#sql("SELECT * FROM league_round WHERE started_at >= ? ORDER BY started_at DESC, rowid DESC LIMIT 1", since)[0] ?? null;
    }
    return { ok: true, round: row ? this.#loadRound(row) : null, lastSeen: this.#lastSeen(), now };
  }

  #roundFinishOp({ callerId, now, roundId }) {
    if (!this.#league()) return { ok: false, error: "not_found" };
    const row = this.#roundRow(roundId);
    if (!row) return { ok: false, error: "not_found" };
    if (row.host_id !== callerId) return { ok: false, error: "forbidden" };
    if (Number(row.finished) === 1) return { ok: false, error: "finished" };
    return { ok: true, results: this.#finishRound(this.#loadRound(row), now) };
  }

  /**
   * W4: results from the ported engine plus game points from the round's own snapshot; the round
   * is marked finished and one round_results row per player is written. Rows never change after.
   */
  #finishRound(round, now) {
    const finished = { ...round, finished: true };
    const results = leagueRoundResults(finished, finished.gamePoints);
    this.ctx.storage.sql.exec("UPDATE league_round SET finished = 1, finished_at = ? WHERE round_id = ?", now, round.roundId);
    this.#ensureResultColumns();
    for (const r of results.results) {
      this.ctx.storage.sql.exec(
        `INSERT INTO round_results (round_id, played_on, finished, member_id, unit, place, net, holes, skins, game_points, points_mode, incomplete)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        round.roundId,
        round.playedOn,
        r.memberId,
        r.unit,
        r.place,
        r.net,
        r.holes,
        r.skins,
        r.gamePoints,
        finished.pointsMode,
        r.incomplete ? 1 : 0,
      );
    }
    return { ...results, pointsMode: finished.pointsMode };
  }

  /** W15. Organizer first (403), then the body's own refusal, then the season check. League row only. */
  #settings({ callerId, refusal, settings, gamePoints, pointsMode }) {
    const row = this.#league();
    if (!row) return { ok: false, error: "not_found" };
    if (this.#role(callerId) !== "owner") return { ok: false, error: "forbidden" };
    if (refusal) return { ok: false, error: refusal };
    const played = this.#sql(
      "SELECT MAX(played_on) AS latest FROM (SELECT played_on FROM league_round UNION ALL SELECT played_on FROM round_results)",
    )[0];
    const latest = played && typeof played.latest === "string" ? played.latest : null;
    if (latest && settings.seasonEnds < latest) return { ok: false, error: "season_before_round" };
    this.ctx.storage.sql.exec(
      `UPDATE league SET name = ?, game = ?, scoring = ?, carry_over = ?, home_course = ?, season_starts = ?, season_ends = ?, round_day = ?
       WHERE id = 1`,
      settings.name,
      settings.game,
      settings.scoring,
      settings.carryOver ? 1 : 0,
      settings.homeCourse,
      settings.seasonStarts,
      settings.seasonEnds,
      settings.roundDay,
    );
    // Sent: merged over what is stored. Not sent: left exactly as it is.
    if (gamePoints !== undefined) {
      const merged = mergeGamePoints(parseStoredJson(row.game_points), gamePoints);
      if (!merged) return { ok: false, error: "invalid_body" };
      this.ctx.storage.sql.exec("UPDATE league SET game_points = ? WHERE id = 1", JSON.stringify(merged));
    }
    if (pointsMode !== undefined) this.ctx.storage.sql.exec("UPDATE league SET points_mode = ? WHERE id = 1", pointsMode);
    return { ok: true, league: this.#publicLeague(this.#league()) };
  }
}

async function readyCaller(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return { response: friendJson(401, { error: "friend_key_required" }, cors) };
  const boards = boardsBinding(env);
  if (!boards) return { response: friendJson(503, { error: "boards_not_configured" }, cors) };
  if (!guessNamespace(env)) return { response: friendJson(503, { error: "guess_limiter_not_configured" }, cors) };
  if (!rosterNamespace(env)) return { response: friendJson(503, { error: "leagues_not_configured" }, cors) };
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return { response: friendJson(401, { error: "friend_key_required" }, cors) };
  return { boards, caller, friendKey };
}

async function readyMemberRead(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready;
  const leagueId = url.searchParams.get("league");
  if (!leagueId || !LEAGUE_ID_RE.test(leagueId) || [...url.searchParams.keys()].some((k) => k !== "league")) {
    return { response: friendJson(400, { error: "invalid_body" }, cors) };
  }
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keylgread:", "iplgread:", cors);
  if (limited) return { response: limited };
  // A member the owner blocked (or who blocked the owner) after joining reads nothing.
  const owner = await rosterCall(env, leagueId, { op: "owner" });
  if (!owner.ok || (await blockedEitherWay(ready.boards, owner.ownerId, ready.caller.ownerId))) {
    return { response: friendJson(404, { error: "not_found" }, cors) };
  }
  return { ...ready, leagueId };
}

/** Body-carrying organizer calls (remove, reset): friend key, a valid leagueId, and the member read limit. */
async function readyOrganizerWrite(request, env, cors, allowed) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready;
  const parsed = await readJsonObject(request, LEAGUE_BODY_LIMIT, false);
  if (parsed.error) return { response: friendJson(parsed.status, { error: parsed.error }, cors) };
  if (unknownFields(parsed.value, allowed)) return { response: friendJson(400, { error: "invalid_body" }, cors) };
  const leagueId = parsed.value.leagueId;
  if (typeof leagueId !== "string" || !LEAGUE_ID_RE.test(leagueId)) {
    return { response: friendJson(400, { error: "invalid_body" }, cors) };
  }
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keylgread:", "iplgread:", cors);
  if (limited) return { response: limited };
  return { ...ready, body: parsed.value, leagueId };
}

async function blockedEitherWay(boards, ownerId, callerId) {
  return (await hasBlock(boards, ownerId, callerId)) || (await hasBlock(boards, callerId, ownerId));
}

/**
 * Code entry for preview, join and claims: the friend-code validator and guess limits.
 * A blocked caller, or a removed player presenting the code they were removed under
 * (decision 8), reads as an unknown code and the guess is not given back.
 */
async function leagueForCode(request, env, cors, allowed) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready;
  const parsed = await readJsonObject(request, LEAGUE_BODY_LIMIT, false);
  if (parsed.error) return { response: friendJson(parsed.status, { error: parsed.error }, cors) };
  if (unknownFields(parsed.value, allowed)) return { response: friendJson(400, { error: "invalid_body" }, cors) };
  const code = normalizeFriendCode(parsed.value.code);
  if (!code) return { response: friendJson(400, { error: "invalid_body" }, cors) };
  // Only bad or unknown codes use up a guess (ShotTraxx Lead, Nov 1): the slot is
  // held now and given back by the caller when the preview or join succeeds.
  const guess = await reserveGuess(request, env, ready.friendKey, cors);
  if (guess.response) return guess;
  const leagueId = await leagueGet(ready.boards, leagueKvKey("code", code));
  if (typeof leagueId !== "string" || !LEAGUE_ID_RE.test(leagueId)) {
    return { response: friendJson(404, { error: "code_not_found" }, cors) };
  }
  const owner = await rosterCall(env, leagueId, { op: "owner", callerId: ready.caller.ownerId });
  if (!owner.ok) return { response: friendJson(404, { error: "code_not_found" }, cors) };
  // A block either way (PLAN.md): same answer as a bad code, so the block is not revealed.
  if (await blockedEitherWay(ready.boards, owner.ownerId, ready.caller.ownerId)) {
    return { response: friendJson(404, { error: "code_not_found" }, cors) };
  }
  // Decision 8: the same answer as an unknown code, so the removal is not revealed.
  if (!codeLetsIn({ code, removedUnder: owner.removedUnder ?? null })) {
    return { response: friendJson(404, { error: "code_not_found" }, cors) };
  }
  return { ...ready, body: parsed.value, code, leagueId, refundGuess: guess.refund };
}

function rosterNamespace(env) {
  const ns = env && env.LEAGUES;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
  return ns;
}

async function rosterCall(env, leagueId, op) {
  const ns = rosterNamespace(env);
  const stub = ns.get(ns.idFromName(`league:${leagueId}`));
  const res = await stub.fetch("https://league-roster.internal/roster", { method: "POST", body: JSON.stringify(op) });
  return res.json();
}

async function saveOwnName(boards, caller, name) {
  // One name per player (PLAN "Required name"): the same two rows setInviteName writes.
  await friendPut(boards, friendKvKey("invname", caller.code), name);
  await friendPut(boards, friendKvKey("ownname", caller.ownerId), name);
}

function cleanPlayerName(raw) {
  if (typeof raw !== "string") return null;
  return readInviteName(raw.replace(/\s+/g, " ").trim());
}

function cleanLeagueName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 1 || [...name].length > LEAGUE_NAME_MAX) return null;
  if (/[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}

/** Weekly round day: 0 = Sunday ... 6 = Saturday (JavaScript getDay order). */
function validRoundDay(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function validSeason(starts, ends) {
  return validPlayedOn(starts) && validPlayedOn(ends) && starts <= ends;
}

async function unusedLeagueCode(boards) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomFriendCode();
    // League and friend codes share the alphabet; never hand out one that is live in either.
    const league = await leagueGet(boards, leagueKvKey("code", code));
    const friend = await friendGet(boards, friendKvKey("code", code));
    if ((league == null || league === "") && (friend == null || friend === "")) return code;
  }
  throw new Error("league_code_exhausted");
}

function leagueKvKey(kind, id) {
  if (kind !== "code") throw new Error("league_namespace");
  if (typeof id !== "string" || id.length < 1) throw new Error("league_namespace");
  return `${LEAGUE_KV_PREFIX}${kind}:${id}`;
}

function assertLeagueNamespace(key) {
  if (typeof key !== "string" || !key.startsWith(`${LEAGUE_KV_PREFIX}code:`)) throw new Error("league_namespace");
}

async function leagueGet(boards, key) {
  assertLeagueNamespace(key);
  return boards.get(key);
}

async function leaguePut(boards, key, value) {
  assertLeagueNamespace(key);
  await boards.put(key, value);
}

async function leagueDelete(boards, key) {
  assertLeagueNamespace(key);
  await boards.delete(key);
}

function parseStoredJson(raw) {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rosterJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
