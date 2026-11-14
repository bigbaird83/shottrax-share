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
 * read a score or a wager. The one exception is the invitee's invite list
 * (fr:sginv:<ownerId>:<gameId>): game id, time, host name and course only.
 *
 * Not deployed. A deploy needs Brian's OK. No new secrets and no new vars.
 */
import {
  EXPO_PUSH_URL,
  PUSH_TOKEN_RE,
  areFriends,
  boardsBinding,
  consumeIpAction,
  friendGet,
  friendKvKey,
  consumeReadLimit,
  friendDelete,
  friendJson,
  friendPut,
  guessNamespace,
  hasBlock,
  listKeysByPrefix,
  loadCaller,
  randomOwnerId,
  readFriendKey,
  readInviteName,
  readJsonObject,
  unknownFields,
} from "./friends.js";

export const SHARED_MAX_PLAYERS = 8;
export const SHARED_MAX_TEAMS = 2;
export const SHARED_MAX_PER_TEAM = 4;
export const SHARED_WOLF_PLAYERS = 4;
export const SHARED_TEAM_NAME_MAX = 20;
/**
 * Team-name filter, the same list and rule as the app (src/domain/sharedGame.ts
 * SHARED_TEAM_NAME_BLOCKLIST / nameHitsBlocklist): whole word, any case; a listed
 * word of 4+ letters also matches inside the letters-only spelling.
 */
export const SHARED_TEAM_NAME_BLOCKLIST = Object.freeze([
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "cock",
  "cunt",
  "dick",
  "fag",
  "faggot",
  "fuck",
  "nigga",
  "nigger",
  "piss",
  "pussy",
  "shit",
  "slut",
]);
/** Invite push data kind. The app opens the in-app invite for this game on tap. */
export const SHARED_INVITE_PUSH_KIND = "shared_game_invite";
const PUSH_TITLE_MAX = 200;
/** An invite stays on the invitee's list this long after it is sent, unless joined or declined first. */
export const SHARED_INVITE_LIST_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Most invites GET /v1/shared-games/invites returns, newest first. */
export const SHARED_INVITE_LIST_MAX = 20;
const INVITE_TITLE_RE = /^(.+) invited you to a shared scorecard$/;
const INVITE_SCRAMBLE_BODY_RE = /^Scramble match at (.+)\. Your scores show for everyone in the match\.$/;
const PUSH_BODY_MAX = 500;
export const SHARED_FORMATS = Object.freeze([
  "strokePlay",
  "matchPlay",
  "skins",
  "bestBall",
  "scramble",
  "shamble",
  "wolf",
]);
/** Keys that must never appear on a shared-card response, empty or not. */
export const WAGER_KEYS = Object.freeze([
  "wager",
  "wagers",
  "sidegame",
  "sidegames",
  "side_game",
  "side_games",
  "bet",
  "bets",
]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WAGER_KEY_RE = /^(wagers?|sidegames?|side_games?|bets?)$/i;
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
    created_at INTEGER NOT NULL
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
  // Invites sent by the organizer. A row stays as "sent" until that friend joins.
  `CREATE TABLE IF NOT EXISTS invite (
    player_id TEXT PRIMARY KEY,
    friend_id TEXT NOT NULL,
    team INTEGER NOT NULL,
    status TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // Score suggestions. Open until the player accepts or keeps their own score.
  `CREATE TABLE IF NOT EXISTS suggestion (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    hole INTEGER NOT NULL,
    strokes INTEGER NOT NULL,
    suggested_by TEXT NOT NULL,
    against_rev INTEGER NOT NULL,
    status TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // First hole a player who joined mid-round plays. Null: from the start.
  `CREATE TABLE IF NOT EXISTS joined_hole (
    player_id TEXT PRIMARY KEY,
    hole INTEGER
  )`,
];

export function isSharedGamePath(pathname) {
  return pathname === "/v1/shared-games" || pathname.startsWith("/v1/shared-games/");
}

/** Whole word, any case; a listed word of 4+ letters also hits inside the letters-only spelling. */
export function teamNameHitsBlocklist(name, blocklist = SHARED_TEAM_NAME_BLOCKLIST) {
  const lower = String(name).toLowerCase();
  const letters = lower.replace(/[^a-z]/g, "");
  for (const word of blocklist) {
    const listed = String(word).toLowerCase();
    if (!/^[a-z]+$/.test(listed)) continue;
    if (new RegExp(`(?:^|[^a-z])${listed}(?:[^a-z]|$)`).test(lower)) return true;
    if (listed.length >= 4 && letters.includes(listed)) return true;
  }
  return false;
}

/**
 * Drop wager keys at every level. An empty object or array is removed with the key,
 * not returned as `wagers: []`.
 */
export function stripWagerKeys(value) {
  if (Array.isArray(value)) return value.map((item) => stripWagerKeys(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (WAGER_KEY_RE.test(key)) continue;
      out[key] = stripWagerKeys(value[key]);
    }
    return out;
  }
  return value;
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
  if (url.pathname === "/v1/shared-games/invites") {
    if (request.method !== "GET") return reply(405, { error: "method_not_allowed" }, cors);
    return listMyInvites(request, env, cors);
  }
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
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, cors);
  if (route.kind === "invites") return postInvites(request, env, cors, route.gameId);
  if (route.kind === "join") return postJoin(request, env, cors, route.gameId);
  if (route.kind === "decline") return postDecline(request, env, cors, route.gameId);
  if (route.kind === "team") return postTeamName(request, env, cors, route.gameId, route.team);
  if (route.kind === "suggestions") return postSuggestion(request, env, cors, route.gameId);
  if (route.kind === "suggestion") return postSuggestionAction(request, env, cors, route.gameId, route.suggestionId);
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
  if (parts.length === 2 && ["scores", "invites", "join", "decline", "suggestions"].includes(parts[1])) {
    if (!ID_RE.test(parts[0])) return { kind: "bad" };
    return { kind: parts[1], gameId: parts[0] };
  }
  if (parts.length === 3 && parts[1] === "teams") {
    if (!ID_RE.test(parts[0])) return { kind: "bad" };
    const team = /^[1-9][0-9]?$/.test(parts[2]) ? Number(parts[2]) : NaN;
    if (!Number.isInteger(team) || team < 1 || team > SHARED_MAX_TEAMS) return { kind: "bad" };
    return { kind: "team", gameId: parts[0], team };
  }
  if (parts.length === 3 && parts[1] === "suggestions") {
    if (!ID_RE.test(parts[0]) || !ID_RE.test(parts[2])) return { kind: "bad" };
    return { kind: "suggestion", gameId: parts[0], suggestionId: parts[2] };
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

/**
 * POST /v1/shared-games/:gameId/invites (organizer only)
 *   { invitees: [{ playerId, friendId, team }], push: { title, body? } }
 *   → { invites: [{ playerId, status: "sent" | "joined" }] }
 * An invitee's playerId is their friend ownerId (the Worker's player identity).
 * They must be the organizer's accepted friend both ways and not blocked either
 * way with anyone on the card. Pending invites count toward the caps. A friend
 * newly invited gets the push once, as the APNs alert through Expo, with data
 * { kind: "shared_game_invite", gameId }.
 */
async function postInvites(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const body = normalizeInvites(stripWagerKeys(parsed.value));
  if (body.error === "cap") return reply(409, { error: "cap" }, cors);
  if (body.error) return reply(400, { error: "invalid_body" }, cors);
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  if (access.members.organizerId !== ready.caller.ownerId) return reply(403, { error: "forbidden" }, cors);
  const roster = access.members.players.map((player) => player.playerId);
  for (const invitee of body.invitees) {
    if (invitee.friendId === ready.caller.ownerId) return reply(400, { error: "invalid_body" }, cors);
    const friends =
      (await areFriends(ready.boards, ready.caller.ownerId, invitee.friendId)) &&
      (await areFriends(ready.boards, invitee.friendId, ready.caller.ownerId));
    if (!friends) return reply(403, { error: "forbidden" }, cors);
    if (await callerBlocked(ready.boards, invitee.friendId, roster)) return reply(409, { error: "blocked" }, cors);
  }
  const answer = await gameCall(env, gameId, {
    op: "invite",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    invitees: body.invitees,
  });
  if (!answer.ok) return mapScore(answer, cors);
  await indexInvites(ready.boards, gameId, ready.caller.ownerId, answer.newlySent, body.push);
  await sendInvitePushes(env, ready.boards, gameId, answer.newlySent, body.push);
  return reply(200, { invites: answer.invites }, cors);
}

/**
 * POST /v1/shared-games/:gameId/join  { playerId, joinedHole } → { game }
 * Only the invited friend, as themselves. joinedHole is null (from the start)
 * or 1–18 for a mid-round joiner. Joining again returns the game.
 */
async function postJoin(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const body = stripWagerKeys(parsed.value);
  if (!body || typeof body !== "object" || Array.isArray(body) || unknownFields(body, ["playerId", "joinedHole"])) {
    return reply(400, { error: "invalid_body" }, cors);
  }
  if (typeof body.playerId !== "string" || !ID_RE.test(body.playerId)) return reply(400, { error: "invalid_body" }, cors);
  const joinedHole = body.joinedHole == null ? null : body.joinedHole;
  if (joinedHole !== null && (!Number.isInteger(joinedHole) || joinedHole < 1 || joinedHole > HOLE_MAX)) {
    return reply(400, { error: "invalid_body" }, cors);
  }
  if (body.playerId !== ready.caller.ownerId) return reply(403, { error: "forbidden" }, cors);
  const members = await gameCall(env, gameId, { op: "members" });
  if (!members.ok) return reply(404, { error: "not_found" }, cors);
  const roster = members.players.map((player) => player.playerId);
  if (await callerBlocked(ready.boards, ready.caller.ownerId, roster)) return reply(409, { error: "blocked" }, cors);
  const answer = await gameCall(env, gameId, { op: "join", callerId: ready.caller.ownerId, joinedHole });
  if (answer.ok) {
    await unindexInvite(ready.boards, ready.caller.ownerId, gameId);
    return reply(200, { game: answer.game }, cors);
  }
  return mapScore(answer, cors);
}

/** POST /v1/shared-games/:gameId/decline  { playerId } → { ok: true }. Only the invited friend, before joining. */
async function postDecline(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const body = stripWagerKeys(parsed.value);
  if (!body || typeof body !== "object" || Array.isArray(body) || unknownFields(body, ["playerId"])) {
    return reply(400, { error: "invalid_body" }, cors);
  }
  if (typeof body.playerId !== "string" || !ID_RE.test(body.playerId)) return reply(400, { error: "invalid_body" }, cors);
  if (body.playerId !== ready.caller.ownerId) return reply(403, { error: "forbidden" }, cors);
  const answer = await gameCall(env, gameId, { op: "decline", callerId: ready.caller.ownerId });
  if (answer.ok) {
    await unindexInvite(ready.boards, ready.caller.ownerId, gameId);
    return reply(200, { ok: true }, cors);
  }
  return mapScore(answer, cors);
}

/**
 * POST /v1/shared-games/:gameId/teams/:n  { name } → { team: { number, name } }
 * Any player on team n renames it; anyone else is 403. 1–20 code points after a
 * trim, no control characters, and not caught by the team-name filter.
 */
async function postTeamName(request, env, cors, gameId, team) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const body = stripWagerKeys(parsed.value);
  if (!body || typeof body !== "object" || Array.isArray(body) || unknownFields(body, ["name"])) {
    return reply(400, { error: "invalid_body" }, cors);
  }
  const name = cleanTeamName(body.name);
  if (!name || teamNameHitsBlocklist(name)) return reply(400, { error: "invalid_body" }, cors);
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, { op: "rename", callerId: ready.caller.ownerId, team, name });
  if (answer.ok) return reply(200, { team: answer.team }, cors);
  return mapScore(answer, cors);
}

/**
 * POST /v1/shared-games/:gameId/suggestions
 *   { suggestionId, playerId, hole, strokes, rev } → { suggestion: { id, status: "open" } }
 * Another player suggests a fix to a player's standing score. Not for a guest
 * (the host keeps it) and not for your own score. rev is the cell's current
 * rev; a stale one is 409 stale_rev with the standing cell. The standing score
 * does not change until that player accepts.
 */
async function postSuggestion(request, env, cors, gameId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const body = stripWagerKeys(parsed.value);
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "invalid_body" }, cors);
  if (unknownFields(body, ["suggestionId", "playerId", "hole", "strokes", "rev"])) return reply(400, { error: "invalid_body" }, cors);
  if (typeof body.suggestionId !== "string" || !ID_RE.test(body.suggestionId)) return reply(400, { error: "invalid_body" }, cors);
  if (typeof body.playerId !== "string" || !ID_RE.test(body.playerId)) return reply(400, { error: "invalid_body" }, cors);
  if (!Number.isInteger(body.hole) || body.hole < 1 || body.hole > HOLE_MAX) return reply(400, { error: "invalid_body" }, cors);
  if (!Number.isInteger(body.strokes) || body.strokes < STROKE_MIN || body.strokes > STROKE_MAX) {
    return reply(400, { error: "invalid_body" }, cors);
  }
  if (!Number.isInteger(body.rev) || body.rev < 1 || body.rev > 1_000_000) return reply(400, { error: "invalid_body" }, cors);
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, {
    op: "suggest",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    suggestionId: body.suggestionId,
    playerId: body.playerId,
    hole: body.hole,
    strokes: body.strokes,
    rev: body.rev,
  });
  if (answer.ok) return reply(200, { suggestion: answer.suggestion }, cors);
  return mapScore(answer, cors);
}

/**
 * POST /v1/shared-games/:gameId/suggestions/:id  { action: "accept" | "keep" }
 *   → { suggestion: { id, status: "accepted" | "kept" } }
 * Only the player the suggestion is for. Accept writes it as their own score if
 * the cell is still at the rev it was made against (else 409 stale_rev with the
 * cell). Keep closes it and leaves the score as it is.
 */
async function postSuggestionAction(request, env, cors, gameId, suggestionId) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysgwrite:", "ipsgwrite:", cors);
  if (limited) return limited;
  const parsed = await readJsonObject(request, CREATE_BODY_LIMIT, false);
  if (parsed.error) return bodyError(parsed, cors);
  const body = stripWagerKeys(parsed.value);
  if (!body || typeof body !== "object" || Array.isArray(body) || unknownFields(body, ["action"])) {
    return reply(400, { error: "invalid_body" }, cors);
  }
  if (body.action !== "accept" && body.action !== "keep") return reply(400, { error: "invalid_body" }, cors);
  const access = await accessGame(ready, env, cors, gameId);
  if (access.response) return access.response;
  const answer = await gameCall(env, gameId, {
    op: "resolve",
    callerId: ready.caller.ownerId,
    now: Date.now(),
    suggestionId,
    action: body.action,
  });
  if (answer.ok) return reply(200, { suggestion: answer.suggestion }, cors);
  return mapScore(answer, cors);
}

/**
 * GET /v1/shared-games/invites → { invites: [{ gameId, hostName, format, course, invitedAt }] }
 * The caller's invites still waiting on them, newest first, so an invitee whose
 * push never arrived (or was cleared) still sees the Join row. Each one is
 * checked against its game: still "sent" to the caller's ownerId, the caller
 * not already on the card, and no block either way with anyone on it. Same
 * auth and read limit as GET /v1/shared-games/:gameId. hostName and course
 * come from the invite push text when it had them (course only for the
 * Scramble body), else the host's own Friends name and null. The read limit
 * is the card read limit in its own bucket, so it never eats a live card's reads.
 */
async function listMyInvites(request, env, cors) {
  const ready = await readyCaller(request, env, cors);
  if (ready.response) return ready.response;
  const rejected = await rejectGetBody(request, cors);
  if (rejected) return rejected;
  const limited = await consumeReadLimit(request, env, ready.friendKey, "keysginv:", "ipsginv:", cors);
  if (limited) return limited;
  const me = ready.caller.ownerId;
  const prefix = `${friendKvKey("sginv", me)}:`;
  const rows = [];
  for (const name of await listKeysByPrefix(ready.boards, prefix)) {
    const gameId = name.slice(prefix.length);
    if (!ID_RE.test(gameId)) continue;
    const stored = parseIndexRow(await friendGet(ready.boards, name));
    if (stored) rows.push({ gameId, ...stored });
  }
  rows.sort((a, b) => b.at - a.at);
  const invites = [];
  for (const row of rows) {
    if (invites.length >= SHARED_INVITE_LIST_MAX) break;
    const answer = await gameCall(env, row.gameId, { op: "pending", callerId: me });
    if (!answer.ok) {
      // The game is gone, or the Durable Object is busy: only a missing game drops the row.
      if (answer.error === "not_found") await unindexInvite(ready.boards, me, row.gameId);
      continue;
    }
    if (!answer.pending) {
      await unindexInvite(ready.boards, me, row.gameId);
      continue;
    }
    if (await callerBlocked(ready.boards, me, answer.playerIds)) continue;
    let hostName = row.hostName;
    if (!hostName) hostName = readInviteName(await friendGet(ready.boards, friendKvKey("ownname", answer.organizerId)));
    invites.push({
      gameId: row.gameId,
      hostName: hostName || null,
      format: answer.format,
      course: row.course,
      invitedAt: answer.invitedAt,
    });
  }
  return reply(200, { invites }, cors);
}

function parseIndexRow(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || !Number.isFinite(value.at)) return null;
    return {
      at: value.at,
      hostName: typeof value.hostName === "string" && value.hostName ? value.hostName : null,
      course: typeof value.course === "string" && value.course ? value.course : null,
    };
  } catch {
    return null;
  }
}

/** Host name and course as the push showed them: the approved title, and the Scramble body when sent. */
function inviteTextFromPush(push) {
  const title = INVITE_TITLE_RE.exec(push && typeof push.title === "string" ? push.title.trim() : "");
  const hostName = title ? title[1].trim() : "";
  const body = INVITE_SCRAMBLE_BODY_RE.exec(push && typeof push.body === "string" ? push.body : "");
  const course = body ? body[1].trim() : "";
  return {
    hostName: hostName && [...hostName].length <= 64 ? hostName : null,
    course: course && [...course].length <= 120 ? course : null,
  };
}

/** Best effort, after the invites are stored: one row per invitee, read by GET /v1/shared-games/invites. */
async function indexInvites(boards, gameId, organizerId, friendIds, push) {
  if (!Array.isArray(friendIds) || friendIds.length === 0) return;
  const text = inviteTextFromPush(push);
  const value = JSON.stringify({ at: Date.now(), organizerId, hostName: text.hostName, course: text.course });
  for (const friendId of friendIds) {
    try {
      await friendPut(boards, `${friendKvKey("sginv", friendId)}:${gameId}`, value, {
        expirationTtl: SHARED_INVITE_LIST_TTL_SECONDS,
      });
    } catch {
      // Best effort: the invite itself is stored in the game.
    }
  }
}

async function unindexInvite(boards, friendId, gameId) {
  try {
    await friendDelete(boards, `${friendKvKey("sginv", friendId)}:${gameId}`);
  } catch {
    // Best effort: the list checks each game anyway.
  }
}

function normalizeInvites(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  if (unknownFields(body, ["invitees", "push"])) return { error: "invalid_body" };
  if (!Array.isArray(body.invitees) || body.invitees.length < 1 || body.invitees.length > SHARED_MAX_PLAYERS) {
    return { error: "invalid_body" };
  }
  const invitees = [];
  const seen = new Set();
  let overTeams = false;
  for (const row of body.invitees) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { error: "invalid_body" };
    if (unknownFields(row, ["playerId", "friendId", "team"])) return { error: "invalid_body" };
    if (typeof row.playerId !== "string" || !ID_RE.test(row.playerId)) return { error: "invalid_body" };
    if (typeof row.friendId !== "string" || !ID_RE.test(row.friendId)) return { error: "invalid_body" };
    // The Worker's player identity: an invited friend plays as their own ownerId.
    if (row.playerId !== row.friendId || seen.has(row.playerId)) return { error: "invalid_body" };
    seen.add(row.playerId);
    if (typeof row.team !== "number" || !Number.isInteger(row.team) || row.team < 1) return { error: "invalid_body" };
    if (row.team > SHARED_MAX_TEAMS) overTeams = true;
    invitees.push({ playerId: row.playerId, friendId: row.friendId, team: row.team });
  }
  const push = body.push;
  if (!push || typeof push !== "object" || Array.isArray(push) || unknownFields(push, ["title", "body"])) {
    return { error: "invalid_body" };
  }
  if (typeof push.title !== "string" || push.title.trim().length < 1 || push.title.length > PUSH_TITLE_MAX) {
    return { error: "invalid_body" };
  }
  if (push.body != null && (typeof push.body !== "string" || push.body.trim().length < 1 || push.body.length > PUSH_BODY_MAX)) {
    return { error: "invalid_body" };
  }
  if (overTeams) return { error: "cap" };
  return { invitees, push: { title: push.title, ...(push.body != null ? { body: push.body } : {}) } };
}

/** Best effort, after the invites are stored. A friend with no push token has notifications off. */
async function sendInvitePushes(env, boards, gameId, friendIds, push) {
  if (!Array.isArray(friendIds) || friendIds.length === 0) return;
  const messages = [];
  for (const friendId of friendIds) {
    const token = await friendGet(boards, friendKvKey("push", friendId));
    if (typeof token !== "string" || !PUSH_TOKEN_RE.test(token)) continue;
    messages.push({
      to: token,
      title: push.title,
      ...(push.body ? { body: push.body } : {}),
      sound: "default",
      data: { kind: SHARED_INVITE_PUSH_KIND, gameId },
    });
  }
  if (messages.length === 0) return;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (env && typeof env.EXPO_ACCESS_TOKEN === "string" && env.EXPO_ACCESS_TOKEN.length > 0) {
    headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }
  try {
    await fetch(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(stripWagerKeys(messages)) });
  } catch {
    // Best effort: the invites are already stored.
  }
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
    if (answer.ok) return reply(200, { game: answer.game }, cors);
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
  if (answer.ok) return reply(200, { game: answer.game, scores: answer.scores }, cors);
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
  if (unknownFields(body, ["gameId", "format", "scoring", "options", "teams", "players"])) {
    return { error: "invalid_body" };
  }
  let gameId = null;
  if (body.gameId != null) {
    if (typeof body.gameId !== "string" || !ID_RE.test(body.gameId)) return { error: "invalid_body" };
    gameId = body.gameId;
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
      if (op === "pending") return gameJson(this.#pending(body));
      if (op === "read") return gameJson(this.#read(body));
      if (op === "score") return gameJson(this.ctx.storage.transactionSync(() => this.#score(body)));
      if (op === "invite") return gameJson(this.ctx.storage.transactionSync(() => this.#invite(body)));
      if (op === "join") return gameJson(this.ctx.storage.transactionSync(() => this.#join(body)));
      if (op === "decline") return gameJson(this.ctx.storage.transactionSync(() => this.#decline(body)));
      if (op === "rename") return gameJson(this.ctx.storage.transactionSync(() => this.#rename(body)));
      if (op === "suggest") return gameJson(this.ctx.storage.transactionSync(() => this.#suggest(body)));
      if (op === "resolve") return gameJson(this.ctx.storage.transactionSync(() => this.#resolve(body)));
    } catch {
      return gameJson({ ok: false, error: "unavailable" });
    }
    return gameJson({ ok: false, error: "invalid_body" });
  }

  #ensure() {
    for (const statement of GAME_SCHEMA) this.ctx.storage.sql.exec(statement);
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
      `INSERT INTO game (id, game_id, organizer_id, format, scoring, options_json, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      game.gameId,
      game.organizerId,
      game.format,
      game.scoring,
      JSON.stringify(game.options ?? {}),
      now,
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
    return { ok: true, organizerId: row.organizer_id, players };
  }

  /** Is there an invite still waiting on this caller? Never returns scores. */
  #pending({ callerId }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    const playerIds = this.#sql("SELECT player_id FROM player ORDER BY player_id").map((player) => player.player_id);
    const invite = this.#sql("SELECT status, at FROM invite WHERE player_id = ? AND friend_id = ?", callerId, callerId);
    const pending = invite.length === 1 && invite[0].status === "sent" && !playerIds.includes(callerId);
    return {
      ok: true,
      pending,
      format: row.format,
      organizerId: row.organizer_id,
      playerIds,
      invitedAt: pending ? Number(invite[0].at) : null,
    };
  }

  #read({ callerId }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    return { ok: true, game: this.#publicGame(row), scores: this.#scores() };
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

  /** Seats taken: players plus invites still waiting, overall and per team. */
  #seats() {
    const players = this.#sql("SELECT player_id, team FROM player");
    const pending = this.#sql("SELECT player_id, team FROM invite WHERE status = 'sent'").filter(
      (row) => !players.some((player) => player.player_id === row.player_id),
    );
    const perTeam = new Map();
    for (const row of [...players, ...pending]) {
      if (row.team == null) continue;
      const team = Number(row.team);
      perTeam.set(team, (perTeam.get(team) ?? 0) + 1);
    }
    return { total: players.length + pending.length, perTeam };
  }

  #invite({ callerId, now, invitees }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    if (row.organizer_id !== callerId) return { ok: false, error: "forbidden" };
    const seats = this.#seats();
    const fresh = [];
    const invites = [];
    for (const invitee of invitees) {
      if (this.#isPlayer(invitee.playerId)) {
        invites.push({ playerId: invitee.playerId, status: "joined" });
        continue;
      }
      const prior = this.#sql("SELECT status FROM invite WHERE player_id = ?", invitee.playerId);
      if (prior.length === 1) {
        invites.push({ playerId: invitee.playerId, status: prior[0].status === "joined" ? "joined" : "sent" });
        continue;
      }
      fresh.push(invitee);
      invites.push({ playerId: invitee.playerId, status: "sent" });
    }
    let total = seats.total;
    const perTeam = new Map(seats.perTeam);
    for (const invitee of fresh) {
      total += 1;
      perTeam.set(invitee.team, (perTeam.get(invitee.team) ?? 0) + 1);
    }
    if (total > SHARED_MAX_PLAYERS) return { ok: false, error: "cap" };
    if (row.format === "wolf" && total > SHARED_WOLF_PLAYERS) return { ok: false, error: "cap" };
    for (const count of perTeam.values()) if (count > SHARED_MAX_PER_TEAM) return { ok: false, error: "cap" };
    for (const invitee of fresh) {
      this.#run(
        "INSERT INTO invite (player_id, friend_id, team, status, at) VALUES (?, ?, ?, 'sent', ?)",
        invitee.playerId,
        invitee.friendId,
        invitee.team,
        now,
      );
    }
    return { ok: true, invites, newlySent: fresh.map((invitee) => invitee.friendId) };
  }

  #join({ callerId, joinedHole }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (this.#isPlayer(callerId)) return { ok: true, game: this.#publicGame(row) };
    const invite = this.#sql("SELECT team, status FROM invite WHERE player_id = ? AND friend_id = ?", callerId, callerId);
    if (invite.length !== 1 || invite[0].status !== "sent") return { ok: false, error: "forbidden" };
    const team = Number(invite[0].team);
    const players = this.#sql("SELECT team FROM player");
    if (players.length + 1 > SHARED_MAX_PLAYERS) return { ok: false, error: "cap" };
    if (players.filter((player) => Number(player.team) === team).length + 1 > SHARED_MAX_PER_TEAM) {
      return { ok: false, error: "cap" };
    }
    // installId is the friend's ownerId: the app reads every non-guest with an install id.
    this.#run(
      "INSERT INTO player (player_id, install_id, guest, team, name) VALUES (?, ?, 0, ?, NULL)",
      callerId,
      callerId,
      team,
    );
    this.#run("INSERT OR REPLACE INTO joined_hole (player_id, hole) VALUES (?, ?)", callerId, joinedHole);
    this.#run("UPDATE invite SET status = 'joined' WHERE player_id = ?", callerId);
    return { ok: true, game: this.#publicGame(this.#gameRow()) };
  }

  #decline({ callerId }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (this.#isPlayer(callerId)) return { ok: false, error: "refused" };
    const invite = this.#sql("SELECT status FROM invite WHERE player_id = ? AND friend_id = ?", callerId, callerId);
    if (invite.length !== 1) return { ok: false, error: "forbidden" };
    this.#run("DELETE FROM invite WHERE player_id = ?", callerId);
    return { ok: true };
  }

  #rename({ callerId, team, name }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    const caller = this.#player(callerId);
    if (!caller) return { ok: false, error: "forbidden" };
    if (caller.team == null || Number(caller.team) !== team) return { ok: false, error: "forbidden" };
    this.#run("INSERT INTO team (number, name) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET name = excluded.name", team, name);
    return { ok: true, team: { number: team, name } };
  }

  #suggest({ callerId, suggestionId, playerId, hole, strokes, rev, now }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    const prior = this.#sql("SELECT player_id, hole, strokes, suggested_by, status FROM suggestion WHERE id = ?", suggestionId);
    if (prior.length === 1) {
      const same =
        prior[0].player_id === playerId &&
        Number(prior[0].hole) === hole &&
        Number(prior[0].strokes) === strokes &&
        prior[0].suggested_by === callerId;
      return same ? { ok: true, suggestion: { id: suggestionId, status: prior[0].status } } : { ok: false, error: "refused" };
    }
    const target = this.#player(playerId);
    // The host keeps a guest's score, and your own score is not a suggestion.
    if (!target || Number(target.guest) === 1 || playerId === callerId) return { ok: false, error: "refused" };
    const cell = this.#cell(playerId, hole);
    if (cell.strokes == null) return { ok: false, error: "refused" };
    if (rev !== cell.rev) return { ok: false, error: "stale_rev", cell };
    this.#run(
      `INSERT INTO suggestion (id, player_id, hole, strokes, suggested_by, against_rev, status, at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      suggestionId,
      playerId,
      hole,
      strokes,
      callerId,
      cell.rev,
      now,
    );
    return { ok: true, suggestion: { id: suggestionId, status: "open" } };
  }

  #resolve({ callerId, suggestionId, action, now }) {
    const row = this.#gameRow();
    if (!row) return { ok: false, error: "not_found" };
    if (!this.#isPlayer(callerId)) return { ok: false, error: "forbidden" };
    const found = this.#sql("SELECT player_id, hole, strokes, against_rev, status FROM suggestion WHERE id = ?", suggestionId);
    if (found.length !== 1) return { ok: false, error: "not_found" };
    const suggestion = found[0];
    if (suggestion.player_id !== callerId) return { ok: false, error: "forbidden" };
    if (suggestion.status !== "open") return { ok: false, error: "refused" };
    const hole = Number(suggestion.hole);
    if (action === "keep") {
      this.#run("UPDATE suggestion SET status = 'kept' WHERE id = ?", suggestionId);
      return { ok: true, suggestion: { id: suggestionId, status: "kept" } };
    }
    const entries = this.#history(callerId, hole);
    const current = entries.length ? Number(entries[entries.length - 1].rev) : 0;
    if (current !== Number(suggestion.against_rev)) return { ok: false, error: "stale_rev", cell: this.#cell(callerId, hole) };
    const writeId = `sug:${suggestionId}`;
    this.#run(
      `INSERT INTO score_history (player_id, hole, rev, strokes, entered_by, source, client_write_id, at)
       VALUES (?, ?, ?, ?, ?, 'own', ?, ?)`,
      callerId,
      hole,
      current + 1,
      Number(suggestion.strokes),
      callerId,
      writeId,
      now,
    );
    this.#run("INSERT INTO write_id (client_write_id, player_id, hole) VALUES (?, ?, ?)", writeId, callerId, hole);
    this.#run("UPDATE suggestion SET status = 'accepted' WHERE id = ?", suggestionId);
    return { ok: true, suggestion: { id: suggestionId, status: "accepted" } };
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
