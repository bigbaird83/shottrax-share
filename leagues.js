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
 * Not here yet (later PRs): resetting the code, removing members, the owner
 * adding friends directly, posting league rounds, and the /l/ landing page.
 * The round_results table is created now so standings has one source; nothing
 * writes it until rounds post to a league (PR 4).
 */
import {
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

const LEAGUE_BODY_LIMIT = 2048;
const LEAGUE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
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
    created_at INTEGER NOT NULL
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
];

export function isLeaguePath(pathname) {
  return pathname === "/v1/leagues" || pathname.startsWith("/v1/leagues/");
}

const LEAGUE_ROUTES = {
  "/v1/leagues": { POST: createLeague },
  "/v1/leagues/preview": { POST: previewLeague },
  "/v1/leagues/join": { POST: joinLeague },
  "/v1/leagues/members": { GET: listMembers },
  "/v1/leagues/standings": { GET: getStandings },
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
 * Body { name, yourName, game, scoring, carryOver, homeCourse, seasonStarts, seasonEnds }.
 * Answers { league, code }. The caller is the owner and the first member (1 / 20).
 */
async function createLeague(request, url, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const { boards, caller } = ready;
  const parsed = await readJsonObject(request, LEAGUE_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  const body = parsed.value;
  if (unknownFields(body, ["name", "yourName", "game", "scoring", "carryOver", "homeCourse", "seasonStarts", "seasonEnds"])) {
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
 *
 * rounds: [{ roundId, playedOn, finished, results: [{ memberId, unit, place, net, holes, skins }] }]
 */
export function leagueStandings({ season, rounds }) {
  const counted = rounds.filter(
    (round) => round.finished === true && round.playedOn >= season.starts && round.playedOn <= season.ends,
  );
  const byMember = new Map();
  for (const round of counted) {
    const points = roundPoints(round.results);
    for (const result of round.results) {
      let row = byMember.get(result.memberId);
      if (!row) {
        row = { memberId: result.memberId, rounds: 0, points: 0, skins: 0, netSum: 0, netCount: 0 };
        byMember.set(result.memberId, row);
      }
      row.rounds += 1;
      row.points += points.get(result.unit) ?? 0;
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
  }));
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const an = a.avgNet == null ? Infinity : a.avgNet;
    const bn = b.avgNet == null ? Infinity : b.avgNet;
    if (an !== bn) return an - bn;
    return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
  });
  let rank = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0 || rows[i].points !== rows[i - 1].points) rank = i + 1;
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
    if (op === "owner") {
      const row = this.#league();
      return rosterJson(row ? { ok: true, ownerId: row.owner_id } : { ok: false, error: "not_found" });
    }
    if (op === "members") return rosterJson(this.#members(body));
    if (op === "standings") return rosterJson(this.#standings(body));
    return rosterJson({ ok: false, error: "invalid_body" }, 400);
  }

  #ensure() {
    for (const statement of ROSTER_SCHEMA) this.ctx.storage.sql.exec(statement);
  }

  #sql(query, ...bindings) {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }

  #league() {
    const rows = this.#sql("SELECT * FROM league WHERE id = 1");
    return rows.length === 1 ? rows[0] : null;
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
      players: this.#count(),
      maxPlayers: LEAGUE_MAX_PLAYERS,
    };
  }

  #create({ league, owner, now }) {
    if (this.#league()) return { ok: false, error: "league_exists" };
    this.ctx.storage.sql.exec(
      `INSERT INTO league (id, league_id, name, owner_id, code, game, scoring, carry_over, home_course, season_starts, season_ends, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        round = { roundId: r.round_id, playedOn: r.played_on, finished: Number(r.finished) === 1, results: [] };
        byRound.set(r.round_id, round);
      }
      round.results.push({
        memberId: r.member_id,
        unit: r.unit,
        place: Number(r.place),
        net: r.net == null ? null : Number(r.net),
        holes: Number(r.holes),
        skins: r.skins == null ? null : Number(r.skins),
      });
    }
    return { ok: true, league: this.#publicLeague(row), members, rounds: [...byRound.values()] };
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
  return { ...ready, leagueId };
}

/** Code entry for preview and join: the friend-code validator and guess limits. A blocked caller reads as not found. */
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
  const owner = await rosterCall(env, leagueId, { op: "owner" });
  if (!owner.ok) return { response: friendJson(404, { error: "code_not_found" }, cors) };
  // Owner blocked the caller: same answer as a bad code, so the block is not revealed.
  if (await hasBlock(ready.boards, owner.ownerId, ready.caller.ownerId)) {
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

function rosterJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
