/**
 * Shared scorecard (SC-2). One SQLite Durable Object per game (SharedGame)
 * holds the roster, every score cell, and the history of every edit.
 * A score write compare-and-sets the expected current rev inside one
 * transaction, so two writes cannot both win the same rev.
 *
 * Auth is the friends X-Friend-Key (friends.js readFriendKey / loadCaller).
 * The caller must already have a friend code. Their player id is that ownerId.
 * Reads and writes are only for players on the game's list. A block either
 * way with anyone else on that list refuses the caller: the card would
 * otherwise include the blocked person's scores. KV is not used for the card.
 * BOARDS stays the friend auth and block rows only, so a board GET cannot
 * read a score or a wager.
 *
 * SG-2 keeps wagers in this same object, in their own tables, keyed by the
 * game. The allowlist table stores install ids only. A player whose install
 * id is on that list gets wager fields. Anyone else who can read the card
 * gets the scorecard with those keys removed, not emptied. Deleting the game
 * deletes the wagers. Deleting the linked round deletes the wagers and leaves
 * the card. No new Durable Object class, no new secret, and no new var.
 *
 * Not deployed. A deploy needs Brian's OK.
 */
import {
  boardsBinding,
  consumeIpAction,
  consumeReadLimit,
  friendJson,
  guessNamespace,
  hasBlock,
  loadCaller,
  randomOwnerId,
  readFriendKey,
  readInviteName,
  readJsonObject,
  unknownFields,
} from "./friends.js";
import { carriesWagerKeys, scrubMoney, stripWagerKeys } from "./wager-keys.js";

export { carriesWagerKeys, stripWagerKeys, WAGER_KEYS } from "./wager-keys.js";

export const SHARED_MAX_PLAYERS = 8;
export const SHARED_MAX_TEAMS = 2;
export const SHARED_MAX_PER_TEAM = 4;
export const SHARED_WOLF_PLAYERS = 4;
export const SHARED_TEAM_NAME_MAX = 20;
export const SHARED_FORMATS = Object.freeze([
  "strokePlay",
  "matchPlay",
  "skins",
  "bestBall",
  "scramble",
  "shamble",
  "wolf",
]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const WAGER_UNITS = Object.freeze(["$", "Points", "Beers", "custom"]);
const WAGER_WHO = Object.freeze(["player", "team"]);
const WAGER_PAYS = Object.freeze(["hole", "skin", "nine", "round"]);
const CUSTOM_UNIT_MAX = 24;
/** Same class, separate object. Not a game id, so it cannot collide with `shared:<gameId>`. */
const ROUND_INDEX_NAME = "wager-round-index";
const CREATE_BODY_LIMIT = 8192;
const STROKE_MIN = 1;
const STROKE_MAX = 25;
const HOLE_MAX = 18;

const GAME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS game (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    game_id TEXT NOT NULL,
    organizer_id TEXT NOT NULL,
    format TEXT NOT NULL,
    scoring TEXT NOT NULL,
    options_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    round_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS team (
    number INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS player (
    player_id TEXT PRIMARY KEY,
    install_id TEXT,
    guest INTEGER NOT NULL,
    team INTEGER,
    name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS score_history (
    player_id TEXT NOT NULL,
    hole INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    strokes INTEGER NOT NULL,
    entered_by TEXT NOT NULL,
    source TEXT NOT NULL,
    client_write_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (player_id, hole, rev)
  )`,
  `CREATE TABLE IF NOT EXISTS write_id (
    client_write_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    hole INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wager (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    unit TEXT NOT NULL,
    custom_unit TEXT,
    who TEXT NOT NULL,
    pays TEXT NOT NULL,
    amount TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wager_player (
    player_id TEXT PRIMARY KEY,
    opted_in INTEGER NOT NULL,
    confirmed INTEGER NOT NULL,
    amount TEXT
  )`,
  /** Install ids only. No player id, name, or amount. */
  `CREATE TABLE IF NOT EXISTS wager_allow (
    install_id TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS round_link (
    round_id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL
  )`,
];

export function isSharedGamePath(pathname) {
  return pathname === "/v1/shared-games" || pathname.startsWith("/v1/shared-games/");
}

/**
 * Standing cell from history. For a non-guest, the latest own entry wins over a
 * later suggestion or a host entry. A host entry shows only until that own entry
 * exists. A suggestion never becomes the standing score. A guest's standing score
 * is the organizer's host entry, never an own entry.
 */
export function projectStanding(guest, entries) {
  let own = null;
  let host = null;
  for (const entry of entries) {
    if (!guest && entry.source === "own") own = entry;
    if (entry.source === "host") host = entry;
  }
  const standing = guest ? host : own || host;
  const rev = entries.length ? entries[entries.length - 1].rev : 0;
  let conflict = false;
  if (standing && !guest && standing.source === "own") {
    conflict = entries.some((entry) => entry.source !== "own" && entry.strokes !== standing.strokes);
  } else if (standing && guest && standing.source === "host") {
    conflict = entries.some((entry) => entry.source !== "host" && entry.strokes !== standing.strokes);
  }
  return {
    strokes: standing ? standing.strokes : null,
    rev,
    enteredBy: standing ? standing.enteredBy : null,
    source: standing ? standing.source : null,
    conflict,
  };
}

export async function handleSharedGames(request, url, env, cors) {
  if (!isSharedGamePath(url.pathname)) return null;
  const route = routeOf(url.pathname);
  if (route.kind === "unknown") return reply(404, { error: "unknown_route" }, cors);
  if (route.kind === "bad") return reply(404, { error: "not_found" }, cors);
  if (route.kind === "collection") {
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, cors);
    return createGame(request, env, cors);
  }
  if (route.kind === "game") {
    if (request.method !== "GET") return reply(405, { error: "method_not_allowed" }, cors);
    return readGame(request, env, cors, route.gameId);
  }
  if (route.kind === "wager") {
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, cors);
    return putWager(request, env, cors, route.gameId);
  }
  if (route.kind === "export") {
    if (request.method !== "GET") return reply(405, { error: "method_not_allowed" }, cors);
    return exportWager(request, env, cors, route.gameId);
  }
  if (route.kind === "share") {
    if (request.method !== "GET") return reply(405, { error: "method_not_allowed" }, cors);
    return shareCard(request, env, cors, route.gameId);
  }
  if (route.kind === "delete") {
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, cors);
    return deleteGame(request, env, cors, route.gameId);
  }
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, cors);
  return postScore(request, env, cors, route.gameId);
}

function routeOf(pathname) {
  if (pathname === "/v1/shared-games") return { kind: "collection" };
  const rest = pathname.slice("/v1/shared-games/".length);
  let parts;
  try {
    parts = rest.split("/").map((part) => decodeURIComponent(part));
  } catch {
    return { kind: "bad" };
  }
  if (parts.length === 1) {
    if (!ID_RE.test(parts[0])) return { kind: "bad" };
    return { kind: "game", gameId: parts[0] };
  }
  if (parts.length === 2 && parts[1] === "scores") {
    if (!ID_RE.test(parts[0])) return { kind: "bad" };
    return { kind: "scores", gameId: parts[0] };
  }
  if (parts.length === 2 && (parts[1] === "wager" || parts[1] === "export" || parts[1] === "share" || parts[1] === "delete")) {
    if (!ID_RE.test(parts[0])) return { kind: "bad" };
    return { kind: parts[1], gameId: parts[0] };
  }
  return { kind: "unknown" };
}

async function createGame(request, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const normalized = normalizeCreate(stripWagerKeys(parsed.value), ready.caller.ownerId);
  if (normalized.error === "invalid_body") return reply(400, { error: "invalid_body" }, cors);
  if (normalized.error === "cap" || normalized.error === "wolf") return reply(409, { error: normalized.error }, cors);
  const ids = normalized.game.players.map((player) => player.playerId);
  if (await rosterHasBlock(ready.boards, ids)) return reply(409, { error: "blocked" }, cors);
  const limited = await consumeIpAction(request, env, "ipsgnew:", cors);
  if (limited) return limited;
  return storeNewGame(ready, env, cors, normalized.game);
}

async function readGame(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const rejected = await rejectGetBody(request, cors);
  if (rejected) return rejected;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgread:", "ipsgread:", cors);
  if (limited) return limited;
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, { op: "read", callerId: ready.caller.ownerId });
  return mapRead(answer, cors);
}

async function postScore(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const score = normalizeScore(stripWagerKeys(parsed.value));
  if (score.error) return reply(400, { error: "invalid_body" }, cors);
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, {
    op: "score",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    ...score.score,
  });
  return mapScore(answer, cors);
}

async function putWager(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  if (carriesWagerKeys(parsed.value)) return reply(400, { error: "wager_rejected" }, cors);
  const wager = normalizeWager(parsed.value);
  if (wager.error) return reply(400, { error: "invalid_body" }, cors);
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, {
    op: "wager",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    wager: wager.wager,
  });
  return mapWager(answer, cors);
}

async function exportWager(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const rejected = await rejectGetBody(request, cors);
  if (rejected) return rejected;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgread:", "ipsgread:", cors);
  if (limited) return limited;
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, { op: "export", callerId: ready.caller.ownerId });
  if (!answer.ok) return mapRead(answer, cors);
  const body = { gameId: answer.gameId };
  if (answer.wager) body.wager = answer.wager;
  return friendJson(200, body, cors);
}

async function shareCard(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const rejected = await rejectGetBody(request, cors);
  if (rejected) return rejected;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgread:", "ipsgread:", cors);
  if (limited) return limited;
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, { op: "read", callerId: ready.caller.ownerId });
  if (!answer.ok) return mapRead(answer, cors);
  return friendJson(200, scorecardSharePayload(answer.game, answer.scores), cors);
}

async function deleteGame(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, true);
  if (parsed.error) return bodyError(parsed, cors);
  if (!parsed.empty && unknownFields(parsed.value, [])) return reply(400, { error: "invalid_body" }, cors);
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  if (access.members.organizerId !== ready.caller.ownerId) return reply(403, { error: "forbidden" }, cors);
  const answer = await gameCall(env, gameId, { op: "deleteGame" });
  if (!answer.ok) return mapRead(answer, cors);
  if (access.members.roundId) await indexCall(env, { op: "unlinkRound", roundId: access.members.roundId });
  return reply(200, { ok: true }, cors);
}

function mapWager(answer, cors) {
  if (answer.ok) return friendJson(200, { wager: answer.wager }, cors);
  if (answer.error === "locked") return reply(409, { error: "locked" }, cors);
  if (answer.error === "forbidden") return reply(403, { error: "forbidden" }, cors);
  if (answer.error === "not_found") return reply(404, { error: "not_found" }, cors);
  if (answer.error === "invalid_body") return reply(400, { error: "invalid_body" }, cors);
  return reply(503, { error: "unavailable" }, cors);
}

/** Share image and share page. Scores only: no wager fields and no "$". */
export function scorecardSharePayload(game, scores) {
  const safeGame = scrubMoney(stripWagerKeys(game || {}));
  const safeScores = scrubMoney(stripWagerKeys(scores || []));
  const players = (safeGame.players || []).map((player) => ({
    playerId: player.playerId,
    name: player.name ?? null,
    guest: player.guest,
    team: player.team ?? null,
  }));
  const cardScores = (Array.isArray(safeScores) ? safeScores : []).map((cell) => ({
    playerId: cell.playerId,
    hole: cell.hole,
    strokes: cell.strokes,
  }));
  const image = {
    gameId: safeGame.gameId,
    format: safeGame.format,
    scoring: safeGame.scoring,
    teams: safeGame.teams || [],
    players,
    scores: cardScores,
  };
  const page = {
    title: "Shared scorecard",
    gameId: image.gameId,
    format: image.format,
    scoring: image.scoring,
    teams: image.teams,
    players,
    scores: cardScores,
  };
  return { image, page };
}

async function storeNewGame(ready, env, cors, game) {
  let gameId = game.gameId;
  const clientId = typeof gameId === "string";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!gameId) gameId = randomOwnerId();
    const answer = await gameCall(env, gameId, {
      op: "create",
      now: Date.now(),
      game: { ...game, gameId },
    });
    if (answer.ok) {
      if (game.roundId) await linkRound(env, game.roundId, gameId);
      return reply(200, { game: answer.game }, cors);
    }
    if (answer.error === "cap" || answer.error === "wolf") return reply(409, { error: answer.error }, cors);
    if (answer.error === "exists") {
      const current = await gameCall(env, gameId, { op: "read", callerId: ready.caller.ownerId });
      if (current.ok && current.game.organizerId === ready.caller.ownerId && sameRoster(current.game, game)) {
        return reply(200, { game: current.game }, cors);
      }
      if (clientId && current.ok && current.game.organizerId === ready.caller.ownerId) {
        return reply(409, { error: "refused" }, cors);
      }
      if (clientId) return reply(404, { error: "not_found" }, cors);
      gameId = null;
      continue;
    }
    return reply(503, { error: "unavailable" }, cors);
  }
  return reply(503, { error: "unavailable" }, cors);
}

function mapRead(answer, cors) {
  if (answer.ok) {
    const body = { game: answer.game, scores: answer.scores };
    if (answer.wager) body.wager = answer.wager;
    // SG-2 exclusion: a caller who is not on the install-id allowlist gets this
    // scorecard only after wager keys are removed. The keys are absent, not empty.
    if (!answer.seesWagers) return friendJson(200, stripWagerKeys(body), cors);
    return friendJson(200, body, cors);
  }
  if (answer.error === "forbidden") return reply(403, { error: "forbidden" }, cors);
  if (answer.error === "not_found") return reply(404, { error: "not_found" }, cors);
  return reply(503, { error: "unavailable" }, cors);
}

function mapScore(answer, cors) {
  if (answer.ok) return reply(200, { cell: answer.cell }, cors);
  if (answer.error === "stale_rev") return reply(409, { error: "stale_rev", cell: answer.cell }, cors);
  if (answer.error === "blocked" || answer.error === "cap" || answer.error === "wolf" || answer.error === "refused") {
    return reply(409, { error: answer.error }, cors);
  }
  if (answer.error === "forbidden") return reply(403, { error: "forbidden" }, cors);
  if (answer.error === "invalid_body") return reply(400, { error: "invalid_body" }, cors);
  if (answer.error === "not_found") return reply(404, { error: "not_found" }, cors);
  return reply(503, { error: "unavailable" }, cors);
}

async function readyCaller(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return { response: reply(401, { error: "key_required" }, cors) };
  const boards = boardsBinding(env);
  if (!boards || !guessNamespace(env) || !sharedNamespace(env)) {
    return { response: reply(503, { error: "unavailable" }, cors) };
  }
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return { response: reply(401, { error: "key_required" }, cors) };
  return { boards, caller, friendKey };
}

/** Game exists and the caller is on its list, and is not blocked either way with anyone else on it. */
async function accessGame(ready, env, cors, gameId) {
  const members = await gameCall(env, gameId, { op: "members" });
  if (!members.ok) return { response: reply(404, { error: "not_found" }, cors) };
  const ids = members.players.map((player) => player.playerId);
  if (!ids.includes(ready.caller.ownerId)) return { response: reply(403, { error: "forbidden" }, cors) };
  if (await callerBlocked(ready.boards, ready.caller.ownerId, ids)) {
    return { response: reply(409, { error: "blocked" }, cors) };
  }
  return { members };
}

async function callerBlocked(boards, callerId, playerIds) {
  for (const playerId of playerIds) {
    if (await blockedEitherWay(boards, callerId, playerId)) return true;
  }
  return false;
}

async function rosterHasBlock(boards, playerIds) {
  for (let i = 0; i < playerIds.length; i += 1) {
    for (let j = i + 1; j < playerIds.length; j += 1) {
      if (await blockedEitherWay(boards, playerIds[i], playerIds[j])) return true;
    }
  }
  return false;
}

async function blockedEitherWay(boards, left, right) {
  if (left === right) return false;
  return (await hasBlock(boards, left, right)) || (await hasBlock(boards, right, left));
}

function sharedNamespace(env) {
  const ns = env && env.SHARED_GAMES;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
  return ns;
}

async function linkRound(env, roundId, gameId) {
  await indexCall(env, { op: "linkRound", roundId, gameId });
}

/** Drop wagers for rounds that were just deleted. No-op when the shared-game binding is absent. */
export async function deleteWagersForRounds(env, roundIds) {
  if (!Array.isArray(roundIds) || !sharedNamespace(env)) return;
  for (const roundId of roundIds) {
    if (typeof roundId !== "string" || !ID_RE.test(roundId)) continue;
    const found = await indexCall(env, { op: "gamesForRound", roundId });
    for (const gameId of found.gameIds || []) {
      await gameCall(env, gameId, { op: "deleteWagers" });
    }
    await indexCall(env, { op: "unlinkRound", roundId });
  }
}

async function indexCall(env, op) {
  const ns = sharedNamespace(env);
  if (!ns) return { ok: false, error: "unavailable" };
  try {
    const stub = ns.get(ns.idFromName(ROUND_INDEX_NAME));
    const res = await stub.fetch("https://shared-game.internal/index", {
      method: "POST",
      body: JSON.stringify(op),
    });
    const body = await res.json();
    return body && typeof body === "object" ? body : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

async function gameCall(env, gameId, op) {
  const ns = sharedNamespace(env);
  if (!ns) return { ok: false, error: "unavailable" };
  try {
    const stub = ns.get(ns.idFromName(`shared:${gameId}`));
    const res = await stub.fetch("https://shared-game.internal/game", {
      method: "POST",
      body: JSON.stringify(op),
    });
    const body = await res.json();
    return body && typeof body === "object" ? body : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

function normalizeCreate(body, organizerId) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  if (unknownFields(body, ["gameId", "format", "scoring", "options", "teams", "players", "roundId"])) {
    return { error: "invalid_body" };
  }
  let gameId = null;
  if (body.gameId != null) {
    if (typeof body.gameId !== "string" || !ID_RE.test(body.gameId)) return { error: "invalid_body" };
    gameId = body.gameId;
  }
  let roundId = null;
  if (body.roundId != null) {
    if (typeof body.roundId !== "string" || !ID_RE.test(body.roundId)) return { error: "invalid_body" };
    roundId = body.roundId;
  }
  if (!SHARED_FORMATS.includes(body.format)) return { error: "invalid_body" };
  if (body.scoring !== "gross" && body.scoring !== "net") return { error: "invalid_body" };
  const options = normalizeOptions(body.format, body.options == null ? {} : body.options);
  if (options.error) return options;
  const teams = normalizeTeams(body.teams == null ? [] : body.teams);
  if (teams.error) return teams;
  const players = normalizePlayers(body.players, organizerId);
  if (players.error) return players;
  const linked = linkTeams(teams.teams, players.players);
  if (linked.error) return linked;
  const cap = rosterCap(body.format, linked.teams, linked.players);
  if (cap) return { error: cap };
  return {
    game: {
      gameId,
      roundId,
      organizerId,
      format: body.format,
      scoring: body.scoring,
      options: options.options,
      teams: linked.teams,
      players: linked.players,
    },
  };
}

function normalizeOptions(format, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_body" };
  if (format === "bestBall") {
    if (unknownFields(raw, ["balls", "matchPlay"])) return { error: "invalid_body" };
    const balls = raw.balls == null ? 1 : raw.balls;
    const matchPlay = raw.matchPlay == null ? false : raw.matchPlay;
    if (balls !== 1 && balls !== 2) return { error: "invalid_body" };
    if (typeof matchPlay !== "boolean") return { error: "invalid_body" };
    return { options: { balls, matchPlay } };
  }
  if (unknownFields(raw, [])) return { error: "invalid_body" };
  return { options: {} };
}

function normalizeTeams(raw) {
  if (!Array.isArray(raw)) return { error: "invalid_body" };
  const teams = [];
  const seen = new Set();
  for (const team of raw) {
    if (!team || typeof team !== "object" || Array.isArray(team)) return { error: "invalid_body" };
    if (unknownFields(team, ["number", "name", "memberIds"])) return { error: "invalid_body" };
    if (typeof team.number !== "number" || !Number.isInteger(team.number) || team.number < 1) {
      return { error: "invalid_body" };
    }
    if (seen.has(team.number)) return { error: "invalid_body" };
    seen.add(team.number);
    const name = cleanTeamName(team.name);
    if (!name) return { error: "invalid_body" };
    if (!Array.isArray(team.memberIds) || team.memberIds.length < 1) return { error: "invalid_body" };
    const memberIds = [];
    const members = new Set();
    for (const id of team.memberIds) {
      if (typeof id !== "string" || !ID_RE.test(id) || members.has(id)) return { error: "invalid_body" };
      members.add(id);
      memberIds.push(id);
    }
    memberIds.sort();
    teams.push({ number: team.number, name, memberIds });
  }
  teams.sort((a, b) => a.number - b.number);
  return { teams };
}

function normalizePlayers(raw, organizerId) {
  if (!Array.isArray(raw) || raw.length < 1) return { error: "invalid_body" };
  const players = [];
  const seen = new Set();
  let organizer = false;
  for (const player of raw) {
    if (!player || typeof player !== "object" || Array.isArray(player)) return { error: "invalid_body" };
    if (unknownFields(player, ["playerId", "installId", "guest", "team", "name"])) return { error: "invalid_body" };
    if (typeof player.playerId !== "string" || !ID_RE.test(player.playerId) || seen.has(player.playerId)) {
      return { error: "invalid_body" };
    }
    seen.add(player.playerId);
    if (typeof player.guest !== "boolean") return { error: "invalid_body" };
    let installId = null;
    if (player.installId != null) {
      if (typeof player.installId !== "string" || !ID_RE.test(player.installId)) return { error: "invalid_body" };
      installId = player.installId;
    } else if (!player.guest) {
      return { error: "invalid_body" };
    }
    let team = null;
    if (player.team != null) {
      if (typeof player.team !== "number" || !Number.isInteger(player.team) || player.team < 1) {
        return { error: "invalid_body" };
      }
      team = player.team;
    }
    let name = null;
    if (player.name != null) {
      name = cleanPlayerName(player.name);
      if (!name) return { error: "invalid_body" };
    }
    if (player.playerId === organizerId) {
      if (player.guest) return { error: "invalid_body" };
      organizer = true;
    }
    players.push({ playerId: player.playerId, installId, guest: player.guest, team, name });
  }
  if (!organizer) return { error: "invalid_body" };
  players.sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  return { players };
}

function linkTeams(teams, players) {
  const byId = new Map(players.map((player) => [player.playerId, player]));
  const teamOf = new Map();
  for (const team of teams) {
    for (const id of team.memberIds) {
      if (!byId.has(id) || teamOf.has(id)) return { error: "invalid_body" };
      teamOf.set(id, team.number);
    }
  }
  for (const player of players) {
    const listed = teamOf.has(player.playerId) ? teamOf.get(player.playerId) : null;
    if (player.team == null) player.team = listed;
    else if (player.team !== listed) return { error: "invalid_body" };
  }
  return { teams, players };
}

function rosterCap(format, teams, players) {
  if (players.length > SHARED_MAX_PLAYERS) return "cap";
  if (teams.length > SHARED_MAX_TEAMS) return "cap";
  for (const team of teams) {
    if (team.number > SHARED_MAX_TEAMS || team.memberIds.length > SHARED_MAX_PER_TEAM) return "cap";
  }
  if (format === "wolf" && players.length !== SHARED_WOLF_PLAYERS) return "wolf";
  return null;
}

function normalizeWager(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  if (unknownFields(body, ["unit", "customUnit", "who", "pays", "amount", "players"])) return { error: "invalid_body" };
  if (!WAGER_UNITS.includes(body.unit)) return { error: "invalid_body" };
  if (!WAGER_WHO.includes(body.who)) return { error: "invalid_body" };
  if (!WAGER_PAYS.includes(body.pays)) return { error: "invalid_body" };
  if (typeof body.amount !== "string" || !AMOUNT_RE.test(body.amount)) return { error: "invalid_body" };
  let customUnit = null;
  if (body.unit === "custom") {
    customUnit = cleanCustomUnit(body.customUnit);
    if (!customUnit) return { error: "invalid_body" };
  } else if (body.customUnit != null) {
    return { error: "invalid_body" };
  }
  let players = null;
  if (body.players != null) {
    if (!Array.isArray(body.players)) return { error: "invalid_body" };
    players = [];
    const seen = new Set();
    for (const player of body.players) {
      if (!player || typeof player !== "object" || Array.isArray(player)) return { error: "invalid_body" };
      if (unknownFields(player, ["playerId", "optedIn", "confirmed", "amount"])) return { error: "invalid_body" };
      if (typeof player.playerId !== "string" || !ID_RE.test(player.playerId) || seen.has(player.playerId)) {
        return { error: "invalid_body" };
      }
      seen.add(player.playerId);
      if (typeof player.optedIn !== "boolean" || typeof player.confirmed !== "boolean") return { error: "invalid_body" };
      let amount = null;
      if (player.amount != null) {
        if (typeof player.amount !== "string" || !AMOUNT_RE.test(player.amount)) return { error: "invalid_body" };
        amount = player.amount;
      }
      players.push({ playerId: player.playerId, optedIn: player.optedIn, confirmed: player.confirmed, amount });
    }
  }
  return { wager: { unit: body.unit, customUnit, who: body.who, pays: body.pays, amount: body.amount, players } };
}

function cleanCustomUnit(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 1 || [...text].length > CUSTOM_UNIT_MAX) return null;
  if (/[\u0000-\u001F\u007F]/.test(text)) return null;
  return text;
}

function normalizeScore(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  if (unknownFields(body, ["playerId", "hole", "strokes", "rev", "clientWriteId"])) return { error: "invalid_body" };
  if (typeof body.playerId !== "string" || !ID_RE.test(body.playerId)) return { error: "invalid_body" };
  if (typeof body.clientWriteId !== "string" || !ID_RE.test(body.clientWriteId)) return { error: "invalid_body" };
  if (!Number.isInteger(body.hole) || body.hole < 1 || body.hole > HOLE_MAX) return { error: "invalid_body" };
  if (!Number.isInteger(body.strokes) || body.strokes < STROKE_MIN || body.strokes > STROKE_MAX) {
    return { error: "invalid_body" };
  }
  if (!Number.isInteger(body.rev) || body.rev < 0 || body.rev > 1_000_000) return { error: "invalid_body" };
  return {
    score: {
      playerId: body.playerId,
      hole: body.hole,
      strokes: body.strokes,
      rev: body.rev,
      clientWriteId: body.clientWriteId,
    },
  };
}

function cleanTeamName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < 1 || [...name].length > SHARED_TEAM_NAME_MAX) return null;
  if (/[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}

function cleanPlayerName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return readInviteName(name);
}

function sameRoster(stored, desired) {
  return JSON.stringify(canonical(stored)) === JSON.stringify(canonical(desired));
}

function canonical(game) {
  return {
    format: game.format,
    scoring: game.scoring,
    options: game.options,
    organizerId: game.organizerId,
    roundId: game.roundId ?? null,
    teams: game.teams.map((team) => ({
      number: team.number,
      name: team.name,
      memberIds: [...team.memberIds].sort(),
    })),
    players: game.players
      .map((player) => ({
        playerId: player.playerId,
        installId: player.installId ?? null,
        guest: player.guest,
        team: player.team ?? null,
        name: player.name ?? null,
      }))
      .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0)),
  };
}

async function rejectGetBody(request, cors) {
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, true);
  if (parsed.error) return bodyError(parsed, cors);
  if (!parsed.empty) return reply(400, { error: "invalid_body" }, cors);
  return null;
}

function bodyError(parsed, cors) {
  if (parsed.status === 413) return reply(413, { error: "payload_too_large" }, cors);
  return reply(400, { error: "invalid_body" }, cors);
}

function reply(status, body, cors, extra) {
  return friendJson(status, stripWagerKeys(body), cors, extra);
}

function gameJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** One SQLite Durable Object per shared game. Score writes are one synchronous transaction. */
export class SharedGame {
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
    if (request.method !== "POST") return gameJson({ ok: false, error: "method_not_allowed" });
    let body;
    try {
      body = await request.json();
    } catch {
      return gameJson({ ok: false, error: "invalid_body" });
    }
    const op = body && body.op;
    try {
      if (op === "create") return gameJson(this.ctx.storage.transactionSync(() => this.#create(body)));
      if (op === "members") return gameJson(this.#members());
      if (op === "read") return gameJson(this.#read(body));
      if (op === "score") return gameJson(this.ctx.storage.transactionSync(() => this.#score(body)));
      if (op === "wager") return gameJson(this.ctx.storage.transactionSync(() => this.#wager(body)));
      if (op === "export") return gameJson(this.#export(body));
      if (op === "deleteGame") return gameJson(this.ctx.storage.transactionSync(() => this.#deleteGame()));
      if (op === "deleteWagers") return gameJson(this.ctx.storage.transactionSync(() => this.#deleteWagers()));
      if (op === "linkRound") return gameJson(this.ctx.storage.transactionSync(() => this.#linkRound(body)));
      if (op === "unlinkRound") return gameJson(this.ctx.storage.transactionSync(() => this.#unlinkRound(body)));
      if (op === "gamesForRound") return gameJson(this.#gamesForRound(body));
    } catch {
      return gameJson({ ok: false, error: "unavailable" });
    }
    return gameJson({ ok: false, error: "invalid_body" });
  }

  #ensure() {
    for (const statement of GAME_SCHEMA) this.ctx.storage.sql.exec(statement);
    try {
      this.#run("ALTER TABLE game ADD COLUMN round_id TEXT");
    } catch {
      // The column is already in the CREATE TABLE for new objects.
    }
  }

  #sql(query, ...bindings) {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }

  #run(query, ...bindings) {
    this.ctx.storage.sql.exec(query, ...bindings);
  }

  #gameRow() {
    const rows = this.#sql("SELECT * FROM game WHERE id = 1");
    return rows.length === 1 ? rows[0] : null;
  }

  #player(playerId) {
    const rows = this.#sql("SELECT * FROM player WHERE player_id = ?", playerId);
    return rows.length === 1 ? rows[0] : null;
  }

  #isPlayer(playerId) {
    return !!this.#player(playerId);
  }

  #history(playerId, hole) {
    return this.#sql(
      "SELECT rev, strokes, entered_by, source, client_write_id, at FROM score_history WHERE player_id = ? AND hole = ? ORDER BY rev",
      playerId,
      hole,
    );
  }

  #create({ game, now }) {
    if (this.#gameRow()) return { ok: false, error: "exists" };
    const cap = rosterCap(game.format, game.teams, game.players);
    if (cap) return { ok: false, error: cap };
    this.#run(
      `INSERT INTO game (id, game_id, organizer_id, format, scoring, options_json, created_at, round_id)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      game.gameId,
      game.organizerId,
      game.format,
      game.scoring,
      JSON.stringify(game.options ?? {}),
      now,
      game.roundId ?? null,
    );
    for (const team of game.teams) {
      this.#run("INSERT INTO team (number, name) VALUES (?, ?)", team.number, team.name);
    }
    for (const player of game.players) {
      this.#run(
        "INSERT INTO player (player_id, install_id, guest, team, name) VALUES (?, ?, ?, ?, ?)",
        player.playerId,
        player.installId,
        player.guest ? 1 : 0,
        player.team,
        player.name,
      );
      if (typeof player.installId === "string" && player.installId.length > 0) {
        this.#run("INSERT OR IGNORE INTO wager_allow (install_id) VALUES (?)", player.installId);
      }
    }
    return { ok: true, game: this.#publicGame(this.#gameRow()) };
  }

  #members() {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    const players = this.#sql("SELECT player_id, guest FROM player ORDER BY player_id").map((player) => ({
      playerId: player.player_id,
      guest: Number(player.guest) === 1,
    }));
    return { ok: true, organizerId: row.organizer_id, roundId: row.round_id ?? null, players };
  }

  #read({ callerId }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    const wager = this.#publicWager();
    return {
      ok: true,
      game: this.#publicGame(row),
      scores: this.#scores(),
      wager,
      seesWagers: this.#allowlisted(callerId),
    };
  }

  #allowlisted(callerId) {
    const player = this.#player(callerId);
    if (!player || player.install_id == null || player.install_id === "") return false;
    const rows = this.#sql("SELECT install_id FROM wager_allow WHERE install_id = ?", player.install_id);
    return rows.length === 1;
  }

  #holeOneScored() {
    return this.#sql("SELECT 1 AS n FROM score_history WHERE hole = 1 LIMIT 1").length > 0;
  }

  #wager({ callerId, wager, now }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId) || callerId !== row.organizer_id) return { ok: false, error: "forbidden" };
    if (this.#holeOneScored()) return { ok: false, error: "locked" };
    const roster = this.#sql("SELECT player_id FROM player").map((player) => player.player_id);
    const sent = new Map();
    for (const player of wager.players || []) {
      if (!roster.includes(player.playerId)) return { ok: false, error: "invalid_body" };
      sent.set(player.playerId, player);
    }
    this.#run("DELETE FROM wager_player");
    this.#run("DELETE FROM wager");
    this.#run(
      "INSERT INTO wager (id, unit, custom_unit, who, pays, amount, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
      wager.unit,
      wager.customUnit,
      wager.who,
      wager.pays,
      wager.amount,
      now,
    );
    for (const playerId of roster) {
      const player = sent.get(playerId);
      this.#run(
        "INSERT INTO wager_player (player_id, opted_in, confirmed, amount) VALUES (?, ?, ?, ?)",
        playerId,
        player && player.optedIn ? 1 : 0,
        player && player.confirmed ? 1 : 0,
        player ? player.amount : null,
      );
    }
    return { ok: true, wager: this.#publicWager() };
  }

  #export({ callerId }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    const wager = this.#publicWager();
    if (!wager) return { ok: true, gameId: row.game_id, wager: null };
    const self = wager.players.find((player) => player.playerId === callerId) || {
      playerId: callerId,
      optedIn: false,
      confirmed: false,
      amount: null,
    };
    return {
      ok: true,
      gameId: row.game_id,
      wager: {
        unit: wager.unit,
        customUnit: wager.customUnit,
        who: wager.who,
        pays: wager.pays,
        self: {
          playerId: self.playerId,
          optedIn: self.optedIn,
          confirmed: self.confirmed,
          amount: self.amount,
        },
      },
    };
  }

  #deleteGame() {
    if (!this.#gameRow()) return { ok: false, error: "not_found" };
    for (const table of ["wager_player", "wager", "wager_allow", "score_history", "write_id", "player", "team", "game"]) {
      this.#run(`DELETE FROM ${table}`);
    }
    return { ok: true };
  }

  #deleteWagers() {
    if (!this.#gameRow()) return { ok: false, error: "not_found" };
    this.#run("DELETE FROM wager_player");
    this.#run("DELETE FROM wager");
    return { ok: true };
  }

  #linkRound({ roundId, gameId }) {
    if (typeof roundId !== "string" || typeof gameId !== "string") return { ok: false, error: "invalid_body" };
    this.#run(
      "INSERT INTO round_link (round_id, game_id) VALUES (?, ?) ON CONFLICT(round_id) DO UPDATE SET game_id = excluded.game_id",
      roundId,
      gameId,
    );
    return { ok: true };
  }

  #unlinkRound({ roundId }) {
    if (typeof roundId !== "string") return { ok: false, error: "invalid_body" };
    this.#run("DELETE FROM round_link WHERE round_id = ?", roundId);
    return { ok: true };
  }

  #gamesForRound({ roundId }) {
    if (typeof roundId !== "string") return { ok: false, error: "invalid_body" };
    const rows = this.#sql("SELECT game_id FROM round_link WHERE round_id = ?", roundId);
    return { ok: true, gameIds: rows.map((row) => row.game_id) };
  }

  #publicWager() {
    const rows = this.#sql("SELECT unit, custom_unit, who, pays, amount FROM wager WHERE id = 1");
    if (rows.length !== 1) return null;
    const row = rows[0];
    const players = this.#sql(
      "SELECT player_id, opted_in, confirmed, amount FROM wager_player ORDER BY player_id",
    ).map((player) => ({
      playerId: player.player_id,
      optedIn: Number(player.opted_in) === 1,
      confirmed: Number(player.confirmed) === 1,
      amount: player.amount ?? null,
    }));
    return {
      unit: row.unit,
      customUnit: row.custom_unit ?? null,
      who: row.who,
      pays: row.pays,
      amount: row.amount,
      locked: this.#holeOneScored(),
      players,
    };
  }

  #score({ callerId, playerId, hole, strokes, rev, clientWriteId, now }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    const target = this.#player(playerId);
    if (!target) return { ok: false, error: "refused" };
    const prior = this.#sql("SELECT player_id, hole FROM write_id WHERE client_write_id = ?", clientWriteId);
    if (prior.length === 1) return { ok: true, cell: this.#cell(prior[0].player_id, Number(prior[0].hole)) };
    const entries = this.#history(playerId, hole);
    const current = entries.length ? Number(entries[entries.length - 1].rev) : 0;
    if (rev !== current) return { ok: false, error: "stale_rev", cell: this.#cell(playerId, hole) };
    const source = classifySource(callerId, row.organizer_id, target);
    const next = current + 1;
    this.#run(
      `INSERT INTO score_history (player_id, hole, rev, strokes, entered_by, source, client_write_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      playerId,
      hole,
      next,
      strokes,
      callerId,
      source,
      clientWriteId,
      now,
    );
    this.#run("INSERT INTO write_id (client_write_id, player_id, hole) VALUES (?, ?, ?)", clientWriteId, playerId, hole);
    return { ok: true, cell: this.#cell(playerId, hole) };
  }

  #scores() {
    const pairs = this.#sql("SELECT DISTINCT player_id, hole FROM score_history ORDER BY player_id, hole");
    return pairs.map((pair) => this.#cell(pair.player_id, Number(pair.hole)));
  }

  #cell(playerId, hole) {
    const target = this.#player(playerId);
    const entries = this.#history(playerId, hole).map((entry) => ({
      rev: Number(entry.rev),
      strokes: Number(entry.strokes),
      enteredBy: entry.entered_by,
      source: entry.source,
      clientWriteId: entry.client_write_id,
      at: Number(entry.at),
    }));
    const standing = projectStanding(target ? Number(target.guest) === 1 : false, entries);
    return {
      playerId,
      hole,
      strokes: standing.strokes,
      rev: standing.rev,
      enteredBy: standing.enteredBy,
      source: standing.source,
      conflict: standing.conflict,
      history: entries,
    };
  }

  #publicGame(row) {
    const teams = this.#sql("SELECT number, name FROM team ORDER BY number").map((team) => ({
      number: Number(team.number),
      name: team.name,
      memberIds: this.#sql("SELECT player_id FROM player WHERE team = ? ORDER BY player_id", Number(team.number)).map(
        (player) => player.player_id,
      ),
    }));
    const players = this.#sql("SELECT player_id, install_id, guest, team, name FROM player ORDER BY player_id").map(
      (player) => ({
        playerId: player.player_id,
        installId: player.install_id ?? null,
        guest: Number(player.guest) === 1,
        team: player.team == null ? null : Number(player.team),
        name: player.name ?? null,
      }),
    );
    let options = {};
    try {
      const parsed = JSON.parse(row.options_json);
      options = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      options = {};
    }
    return {
      gameId: row.game_id,
      roundId: row.round_id ?? null,
      organizerId: row.organizer_id,
      format: row.format,
      scoring: row.scoring,
      options: stripWagerKeys(options),
      teams,
      players,
    };
  }
}

function classifySource(callerId, organizerId, target) {
  const guest = Number(target.guest) === 1;
  if (guest) return callerId === organizerId ? "host" : "suggestion";
  if (callerId === target.player_id) return "own";
  if (callerId === organizerId) return "host";
  return "suggestion";
}
