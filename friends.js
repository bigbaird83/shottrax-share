/**
 * Anonymous friend codes. Auth is X-Friend-Key, a random secret the phone
 * generates. It is not an install id and it is not a name. KV rows are fr:
 * only. Guess counts live in FriendGuessLimiter (SQLite Durable Object),
 * one object per friend-key hash and one per IP hash. listRequests and
 * listFriends use that same class, with their own per-key and per-IP names,
 * and they do not write KV.
 *
 * Served here: getCode, resetCode, code lookup, sendRequest, accept, block,
 * unblock, remove, publishRound, fetchRounds, listRequests, and listFriends.
 * Block is quiet for the blocked person. Unblock deletes only the caller's
 * block. Block requires a friendship and stores the block row before it
 * deletes that friendship. Remove and block delete only the caller's shared
 * rounds. One fr:rounds: value holds an owner's rounds. One fr:friends:
 * value is that owner's list. A pending request row is the string "pending"
 * and has no display name or created time. A quiet-block send writes
 * fr:out:<sender>:<recipient> = pending for that sender's outgoing list
 * only. It is not a request, it has no TTL, and unblock does not promote it.
 * setInvitePhoto stores the sharer's invite photo (JPEG, 64 KB cap) at fr:invphoto:<code>,
 * the same way as the name: never in a URL, returned only by lookup, deleted by reset.
 * setInviteName stores the sharer's invite name at fr:invname:<code>; only
 * code lookup returns it and resetCode deletes it. setPastRounds gives one
 * friend a pick of the caller's past rounds (private "to" audience inside
 * fr:rounds:); fetchRounds never returns a choice or an audience.
 */

export const FRIEND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const FRIEND_CODE_GUESS_LIMIT = 8;
export const FRIEND_IP_GUESS_LIMIT = 24;
export const FRIEND_GETCODE_IP_LIMIT = 30;
export const FRIEND_PUBLISH_IP_LIMIT = 60;
// Screen reads. Same 60-per-hour budget as publish, on separate objects so
// they do not spend getCode, publish, or code-guess counters.
export const FRIEND_READ_KEY_LIMIT = 60;
export const FRIEND_READ_IP_LIMIT = 60;
export const FRIEND_GUESS_WINDOW_MS = 60 * 60 * 1000;
export const FRIEND_CAP = 50;
export const ROUND_CAP = 100;
// Live rounds for friends (approved 2026-10-21 11:10 CT). A row is gone 30 minutes after its last update.
export const FRIEND_LIVE_TTL_MS = 30 * 60 * 1000;
// One update per hole plus a Friends-screen poll about once a minute.
export const FRIEND_LIVE_IP_LIMIT = 240;
// Invite name: the sharer's own name for this invite, stored with the code.
// It is never in the URL. lookup returns it; reset deletes it with the old code.
export const INVITE_NAME_MAX = 24;
// Invite photo cap: JPEG only, at most 64 KB decoded, sent as base64. The app sends a 256 px square.
export const INVITE_PHOTO_MAX_BYTES = 64 * 1024;
export const INVITE_PHOTO_TYPE = "image/jpeg";
// Past rounds: per friend, the owner's pick of rounds finished before the
// friendship. "all" is still capped at ROUND_CAP.
export const PAST_ROUND_CHOICES = Object.freeze(["none", "10", "25", "all"]);

const FRIEND_KEY_PREFIX = "fr:";
const FRIEND_KEY_HASH_PREFIX = "shottrax-friend-key-v1:";
const FRIEND_IP_HASH_PREFIX = "shottrax-friend-guess-ip-v1:";
const FRIEND_BODY_LIMIT = 2048;
const PUBLISH_BODY_LIMIT = 8192;
const PAST_BODY_LIMIT = 256 * 1024;
const PHOTO_BODY_LIMIT = 96 * 1024;
const ROUND_TTL_SECONDS = 365 * 24 * 60 * 60;
const ROUND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLAYED_ON_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLUB_RE = /^[A-Za-z0-9][A-Za-z0-9 +./-]{0,7}$/;
const COURSE_CACHE_PREFIXES = ["id:", "name:", "osm:", "gq:", "gapi:", "gqueue:", "gca:", "cr:"];
const FRIEND_KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;
const INSTALL_ID_RE = /^id_\d+_[a-z0-9]+$/i;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const OWNER_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const GUESS_SCHEMA = `CREATE TABLE IF NOT EXISTS guess_limit (
  id INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  blocked INTEGER NOT NULL
)`;

export function isFriendPath(pathname) {
  return pathname === "/v1/friends" || pathname.startsWith("/v1/friends/");
}

/** DO name for a friend key. Tests use this to reset and block the same object the route uses. */
export async function limiterNameForFriendKey(friendKey) {
  return `key:${await sha256Hex(FRIEND_KEY_HASH_PREFIX + friendKey)}`;
}

function limitForDurableObjectName(name) {
  // Longer prefixes first. "ipget:" and "ippub:" must not inherit the "ip:" guess cap.
  // "keyreq:" and "keylist:" must not inherit the 8-guess default.
  if (name.startsWith("ipget:")) return FRIEND_GETCODE_IP_LIMIT;
  if (name.startsWith("ippub:")) return FRIEND_PUBLISH_IP_LIMIT;
  if (name.startsWith("iplive:")) return FRIEND_LIVE_IP_LIMIT;
  if (name.startsWith("ipreq:")) return FRIEND_READ_IP_LIMIT;
  if (name.startsWith("iplist:")) return FRIEND_READ_IP_LIMIT;
  if (name.startsWith("ip:")) return FRIEND_IP_GUESS_LIMIT;
  if (name.startsWith("keyreq:")) return FRIEND_READ_KEY_LIMIT;
  if (name.startsWith("keylist:")) return FRIEND_READ_KEY_LIMIT;
  return FRIEND_CODE_GUESS_LIMIT;
}

export class FriendGuessLimiter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const name = ctx && ctx.id && typeof ctx.id.name === "string" ? ctx.id.name : "";
    this.limit = limitForDurableObjectName(name);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      this.#ensure();
    });
  }

  #ready;

  async fetch(request) {
    await this.#ready;
    if (request.method !== "POST") return doJson({ error: "method_not_allowed" }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return doJson({ error: "invalid_body" }, 400);
    }
    const now = Number.isFinite(body && body.now) ? body.now : Date.now();
    if (body && body.op === "attempt") {
      // Read, compare, and increment stay inside this synchronous transaction.
      const result = this.ctx.storage.transactionSync(() => this.#attemptSync(now));
      return doJson(result);
    }
    if (body && body.op === "reset") {
      this.ctx.storage.transactionSync(() => this.#resetSync());
      return doJson({ ok: true });
    }
    if (body && body.op === "block") {
      this.ctx.storage.transactionSync(() => this.#blockSync(now));
      return doJson({ ok: true });
    }
    return doJson({ error: "invalid_body" }, 400);
  }

  #ensure() {
    this.ctx.storage.sql.exec(GUESS_SCHEMA);
  }

  #attemptSync(now) {
    this.#ensure();
    const rows = this.ctx.storage.sql
      .exec("SELECT attempts, window_start, blocked FROM guess_limit WHERE id = 1")
      .toArray();
    if (rows.length === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO guess_limit (id, attempts, window_start, blocked) VALUES (1, 1, ?, 0)",
        now,
      );
      return { ok: true };
    }
    let attempts = Number(rows[0].attempts);
    let windowStart = Number(rows[0].window_start);
    const blocked = Number(rows[0].blocked) === 1;
    if (blocked) return { ok: false, retryAfterSec: Math.ceil(FRIEND_GUESS_WINDOW_MS / 1000) };
    if (now - windowStart >= FRIEND_GUESS_WINDOW_MS) {
      attempts = 0;
      windowStart = now;
    }
    if (attempts >= this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((FRIEND_GUESS_WINDOW_MS - (now - windowStart)) / 1000));
      return { ok: false, retryAfterSec };
    }
    attempts += 1;
    this.ctx.storage.sql.exec(
      "UPDATE guess_limit SET attempts = ?, window_start = ? WHERE id = 1",
      attempts,
      windowStart,
    );
    return { ok: true };
  }

  #resetSync() {
    this.#ensure();
    this.ctx.storage.sql.exec("DELETE FROM guess_limit");
  }

  #blockSync(now) {
    this.#ensure();
    const rows = this.ctx.storage.sql.exec("SELECT id FROM guess_limit WHERE id = 1").toArray();
    if (rows.length === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO guess_limit (id, attempts, window_start, blocked) VALUES (1, 0, ?, 1)",
        now,
      );
      return;
    }
    this.ctx.storage.sql.exec("UPDATE guess_limit SET blocked = 1 WHERE id = 1");
  }
}

export async function handleFriends(request, url, env, cors) {
  if (!isFriendPath(url.pathname)) return null;
  const route = FRIEND_ROUTES[url.pathname];
  if (!route) return friendJson(404, { error: "unknown_route" }, cors);
  const handler = route[request.method];
  if (!handler) return friendJson(405, { error: "method_not_allowed" }, cors);
  return handler(request, env, cors);
}

const FRIEND_ROUTES = {
  "/v1/friends/code": { POST: getCode },
  "/v1/friends/code/reset": { POST: resetCode },
  "/v1/friends/code/name": { POST: setInviteName },
  "/v1/friends/code/photo": { POST: setInvitePhoto },
  "/v1/friends/live": { PUT: putLive, GET: fetchLive },
  "/v1/friends/live/stop": { POST: stopLive },
  "/v1/friends/codes/lookup": { POST: lookupCode },
  "/v1/friends/requests": { POST: sendRequest, GET: listRequests },
  "/v1/friends/list": { GET: listFriends },
  "/v1/friends/requests/accept": { POST: acceptRequest },
  "/v1/friends/requests/cancel": { POST: cancelRequest },
  "/v1/friends/block": { POST: blockPerson },
  "/v1/friends/unblock": { POST: unblockPerson },
  "/v1/friends/remove": { POST: removeFriend },
  "/v1/friends/rounds": { PUT: publishRound, GET: fetchRounds },
  "/v1/friends/past": { PUT: setPastRounds },
};

async function getCode(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, true);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, [])) return friendJson(400, { error: "invalid_body" }, cors);
  const limited = await consumeIpAction(request, env, "ipget:", cors);
  if (limited) return limited;
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const keyHash = await sha256Hex(FRIEND_KEY_HASH_PREFIX + friendKey);
  const authKey = friendKvKey("k", keyHash);
  const existing = parseAuth(await friendGet(boards, authKey));
  if (existing) return friendJson(200, { code: existing.code, ownerId: existing.ownerId }, cors);
  const ownerId = randomOwnerId();
  const code = await unusedCode(boards, null);
  await friendPut(boards, friendKvKey("code", code), ownerId);
  await friendPut(boards, authKey, storedAuth(ownerId, code));
  return friendJson(200, { code, ownerId }, cors);
}

async function resetCode(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, true);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, [])) return friendJson(400, { error: "invalid_body" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const keyHash = await sha256Hex(FRIEND_KEY_HASH_PREFIX + friendKey);
  const authKey = friendKvKey("k", keyHash);
  const existing = parseAuth(await friendGet(boards, authKey));
  if (!existing) return friendJson(401, { error: "friend_key_required" }, cors);
  const previous = existing.code;
  const code = await unusedCode(boards, previous);
  await friendPut(boards, friendKvKey("code", code), existing.ownerId);
  await friendPut(boards, authKey, storedAuth(existing.ownerId, code));
  // The old code is deleted before the response, so a later lookup misses.
  await friendDelete(boards, friendKvKey("code", previous));
  // The invite name lives with the code. A reset deletes it; it does not move to the new code.
  await deleteIfPresent(boards, friendKvKey("invname", previous));
  await deleteIfPresent(boards, friendKvKey("invphoto", previous));
  return friendJson(200, { code, ownerId: existing.ownerId }, cors);
}

async function lookupCode(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  if (!guessNamespace(env)) return friendJson(503, { error: "guess_limiter_not_configured" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["code"])) return friendJson(400, { error: "invalid_body" }, cors);
  const code = normalizeFriendCode(parsed.value.code);
  if (!code) return friendJson(400, { error: "invalid_body" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  const limited = await consumeGuess(request, env, friendKey, cors);
  if (limited) return limited;
  const ownerId = await friendGet(boards, friendKvKey("code", code));
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return friendJson(404, { error: "code_not_found" }, cors);
  }
  // The invite name is returned only here, when the code (or its link) is opened.
  const name = readInviteName(await friendGet(boards, friendKvKey("invname", code)));
  const photo = readInvitePhoto(await friendGet(boards, friendKvKey("invphoto", code)));
  const found = { ownerId };
  if (name) found.name = name;
  if (photo) found.photo = photo;
  return friendJson(200, found, cors);
}

/**
 * Store or clear the caller's invite name. Body { name: string | null }.
 * 1-24 characters after trimming, no control characters. "" or null deletes it.
 */
async function setInviteName(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["name"]) || !Object.hasOwn(parsed.value, "name")) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const raw = parsed.value.name;
  let name = null;
  if (raw !== null) {
    if (typeof raw !== "string") return friendJson(400, { error: "invalid_body" }, cors);
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0) {
      name = readInviteName(trimmed);
      if (!name) return friendJson(400, { error: "invalid_body" }, cors);
    }
  }
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  const key = friendKvKey("invname", caller.code);
  if (name) await friendPut(boards, key, name);
  else await deleteIfPresent(boards, key);
  return friendJson(200, { ok: true }, cors);
}

/**
 * Store or clear the caller's invite photo. Body { photo: { type: "image/jpeg", data: base64 } | null }.
 * JPEG only, at most INVITE_PHOTO_MAX_BYTES decoded. null deletes it. Stored at fr:invphoto:<code>.
 */
async function setInvitePhoto(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, PHOTO_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["photo"]) || !Object.hasOwn(parsed.value, "photo")) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const raw = parsed.value.photo;
  let photo = null;
  if (raw !== null) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return friendJson(400, { error: "invalid_body" }, cors);
    if (unknownFields(raw, ["type", "data"])) return friendJson(400, { error: "invalid_body" }, cors);
    if (raw.type !== INVITE_PHOTO_TYPE) return friendJson(415, { error: "photo_type" }, cors);
    photo = readInvitePhoto(JSON.stringify({ type: raw.type, data: raw.data }));
    if (!photo) {
      const tooBig = typeof raw.data === "string" && raw.data.length > Math.ceil(INVITE_PHOTO_MAX_BYTES / 3) * 4;
      return friendJson(tooBig ? 413 : 400, { error: tooBig ? "photo_too_large" : "invalid_body" }, cors);
    }
  }
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  const key = friendKvKey("invphoto", caller.code);
  if (photo) await friendPut(boards, key, JSON.stringify(photo));
  else await deleteIfPresent(boards, key);
  return friendJson(200, { ok: true }, cors);
}

function readInvitePhoto(raw) {
  if (typeof raw !== "string") return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || value.type !== INVITE_PHOTO_TYPE || typeof value.data !== "string") return null;
  const data = value.data;
  if (data.length < 8 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > INVITE_PHOTO_MAX_BYTES) return null;
  // JPEG files start with FF D8 FF ("/9j/" in base64).
  if (!data.startsWith("/9j/")) return null;
  return { type: INVITE_PHOTO_TYPE, data };
}

function readInviteName(raw) {
  if (typeof raw !== "string") return null;
  if (raw.length < 1 || [...raw].length > INVITE_NAME_MAX) return null;
  if (raw !== raw.trim() || /[\u0000-\u001F\u007F]/.test(raw)) return null;
  return raw;
}

/**
 * The caller's past rounds for one friend. Body { ownerId, choice, rounds }.
 * choice is "none", "10", "25" or "all". rounds must fit the choice (all = ROUND_CAP).
 * The stored set is replaced, so a lower choice deletes the rest; "none" deletes the row.
 * Only the caller's own row is written. No call returns a choice, the caller's or the friend's.
 */
async function setPastRounds(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, PAST_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  const body = parsed.value;
  if (unknownFields(body, ["ownerId", "choice", "rounds"])) return friendJson(400, { error: "invalid_body" }, cors);
  const ownerId = readOwnerId(body.ownerId);
  const limit = pastChoiceLimit(body.choice);
  if (!ownerId || limit == null || !Array.isArray(body.rounds)) return friendJson(400, { error: "invalid_body" }, cors);
  if (body.rounds.length > limit) return friendJson(400, { error: "invalid_body" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  if (ownerId === caller.ownerId) return friendJson(400, { error: "invalid_body" }, cors);
  const stored = [];
  const seen = new Set();
  for (const round of body.rounds) {
    const clean = sanitizeRound(round, caller.ownerId);
    if (!clean || seen.has(clean.id)) return friendJson(400, { error: "invalid_body" }, cors);
    seen.add(clean.id);
    stored.push(clean);
  }
  if (!(await areFriends(boards, caller.ownerId, ownerId)) || !(await areFriends(boards, ownerId, caller.ownerId))) {
    return friendJson(409, { error: "not_friends" }, cors);
  }
  const limited = await consumeIpAction(request, env, "ippub:", cors);
  if (limited) return limited;
  // Past rounds live in the owner's one fr:rounds: value with a private
  // audience (to: ownerIds). First this friend is taken off every past round,
  // which deletes rounds no one else was given, then the new pick is added.
  // A round already shared the normal way is visible to every friend and is not touched.
  const next = withoutAudience(await loadOwnedRounds(boards, caller.ownerId), ownerId);
  for (const round of stored) {
    const index = next.findIndex((item) => item.id === round.id);
    if (index >= 0) {
      const current = next[index];
      if (!Array.isArray(current.to)) continue;
      next[index] = { ...round, to: [...current.to, ownerId] };
      continue;
    }
    if (next.length >= ROUND_CAP) return friendJson(409, { error: "round_limit" }, cors);
    next.push({ ...round, to: [ownerId] });
  }
  await saveOwnedRounds(boards, caller.ownerId, next);
  return friendJson(200, { ok: true }, cors);
}

/** Take one friend off every past round. A past round left with no audience is dropped. */
function withoutAudience(rounds, friendId) {
  const out = [];
  for (const round of rounds) {
    if (!Array.isArray(round.to)) {
      out.push(round);
      continue;
    }
    const to = round.to.filter((id) => id !== friendId);
    if (to.length > 0) out.push({ ...round, to });
  }
  return out;
}

async function saveOwnedRounds(boards, ownerId, rounds) {
  const key = friendKvKey("rounds", ownerId);
  if (rounds.length === 0) {
    await deleteIfPresent(boards, key);
    return;
  }
  await friendPut(boards, key, JSON.stringify(rounds), { expirationTtl: ROUND_TTL_SECONDS });
}

/** What a reader may see of a round: never the audience list. */
function publicRound(round) {
  if (!Object.hasOwn(round, "to")) return round;
  const { to: _to, ...rest } = round;
  return rest;
}

function pastChoiceLimit(choice) {
  if (choice === "none") return 0;
  if (choice === "10") return 10;
  if (choice === "25") return 25;
  if (choice === "all") return ROUND_CAP;
  return null;
}

/** After remove or block: the other side's past rounds given to the caller are taken back too. */
async function deletePastRoundsFor(boards, ownerId, friendId) {
  const rounds = await loadOwnedRounds(boards, ownerId);
  if (!rounds.some((round) => Array.isArray(round.to) && round.to.includes(friendId))) return;
  await saveOwnedRounds(boards, ownerId, withoutAudience(rounds, friendId));
}

async function sendRequest(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["code"])) return friendJson(400, { error: "invalid_body" }, cors);
  const code = normalizeFriendCode(parsed.value.code);
  if (!code) return friendJson(400, { error: "invalid_body" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  // Own code is rejected before the limiter and does not consume a guess.
  if (caller.code === code) return friendJson(400, { error: "invalid_body" }, cors);
  if (!guessNamespace(env)) return friendJson(503, { error: "guess_limiter_not_configured" }, cors);
  const limited = await consumeGuess(request, env, friendKey, cors);
  if (limited) return limited;
  const ownerId = await friendGet(boards, friendKvKey("code", code));
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    return friendJson(404, { error: "code_not_found" }, cors);
  }
  if (await hasBlock(boards, caller.ownerId, ownerId)) {
    return friendJson(409, { error: "blocked" }, cors);
  }
  // Quiet block: same pending body as a real request. The note is the
  // sender's outgoing row only. The recipient has no fr:req: to accept.
  if (await hasBlock(boards, ownerId, caller.ownerId)) {
    await storeOutgoingNote(boards, caller.ownerId, ownerId);
    return friendJson(200, { status: "pending", ownerId }, cors);
  }
  if (await areFriends(boards, caller.ownerId, ownerId)) {
    await deleteOutgoingNote(boards, caller.ownerId, ownerId);
    return friendJson(200, { status: "friends", ownerId }, cors);
  }
  const reqKey = requestKey(ownerId, caller.ownerId);
  const pending = await friendGet(boards, reqKey);
  if (typeof pending === "string" && pending.length > 0) {
    await deleteOutgoingNote(boards, caller.ownerId, ownerId);
    return friendJson(200, { status: "pending", ownerId }, cors);
  }
  await friendPut(boards, reqKey, "pending");
  await deleteOutgoingNote(boards, caller.ownerId, ownerId);
  return friendJson(200, { status: "pending", ownerId }, cors);
}

async function acceptRequest(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["ownerId"])) return friendJson(400, { error: "invalid_body" }, cors);
  const ownerId = readOwnerId(parsed.value.ownerId);
  if (!ownerId) return friendJson(400, { error: "invalid_body" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  if (ownerId === caller.ownerId) return friendJson(400, { error: "invalid_body" }, cors);
  // The opener who blocked the inviter hears blocked, even if no request remains.
  if (await hasBlock(boards, caller.ownerId, ownerId)) {
    return friendJson(409, { error: "blocked" }, cors);
  }
  if (await hasBlock(boards, ownerId, caller.ownerId)) {
    return friendJson(409, { error: "not_friends" }, cors);
  }
  const reqKey = requestKey(caller.ownerId, ownerId);
  const pending = await friendGet(boards, reqKey);
  if (typeof pending !== "string" || pending.length === 0) {
    return friendJson(409, { error: "not_friends" }, cors);
  }
  const callerIds = await loadFriendIds(boards, caller.ownerId);
  const otherIds = await loadFriendIds(boards, ownerId);
  if (friendListWouldExceed(callerIds, ownerId) || friendListWouldExceed(otherIds, caller.ownerId)) {
    return friendJson(409, { error: "friend_limit" }, cors);
  }
  await friendPut(boards, friendKvKey("friend", `${caller.ownerId}:${ownerId}`), "1");
  await friendPut(boards, friendKvKey("friend", `${ownerId}:${caller.ownerId}`), "1");
  await saveFriendIds(boards, caller.ownerId, addFriendId(callerIds, ownerId));
  await saveFriendIds(boards, ownerId, addFriendId(otherIds, caller.ownerId));
  // Drop a leftover sender note before the request row. A retry can still
  // see fr:req: if this delete fails. The note is not read and not accepted.
  await deleteOutgoingNote(boards, ownerId, caller.ownerId);
  await friendDelete(boards, reqKey);
  return friendJson(200, { status: "friends", ownerId }, cors);
}

/**
 * Withdraw a request the caller sent. Deletes only the caller's own pending row
 * (and any quiet-block note), so the recipient no longer sees it. Idempotent:
 * nothing pending is still 200. Never touches friendships, blocks or rounds.
 */
async function cancelRequest(request, env, cors) {
  const ready = await readyOwnerCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller, ownerId } = ready;
  await deleteIfPresent(boards, requestKey(ownerId, caller.ownerId));
  await deleteOutgoingNote(boards, caller.ownerId, ownerId);
  return friendJson(200, { ok: true }, cors);
}

async function blockPerson(request, env, cors) {
  const ready = await readyOwnerCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller, ownerId } = ready;
  const forward = await areFriends(boards, caller.ownerId, ownerId);
  const reverse = await areFriends(boards, ownerId, caller.ownerId);
  if (!forward || !reverse) return friendJson(409, { error: "not_friends" }, cors);
  // Store the block first. A failure later must not leave this pair with no block.
  await friendPut(boards, friendKvKey("block", `${caller.ownerId}:${ownerId}`), "1");
  await friendDelete(boards, friendKvKey("friend", `${caller.ownerId}:${ownerId}`));
  await friendDelete(boards, friendKvKey("friend", `${ownerId}:${caller.ownerId}`));
  await saveFriendIds(boards, caller.ownerId, removeFriendId(await loadFriendIds(boards, caller.ownerId), ownerId));
  await saveFriendIds(boards, ownerId, removeFriendId(await loadFriendIds(boards, ownerId), caller.ownerId));
  await deleteIfPresent(boards, requestKey(ownerId, caller.ownerId));
  await deleteIfPresent(boards, requestKey(caller.ownerId, ownerId));
  await deleteOwnedRounds(boards, caller.ownerId);
  await deletePastRoundsFor(boards, ownerId, caller.ownerId);
  return friendJson(200, { ok: true }, cors);
}

async function unblockPerson(request, env, cors) {
  const ready = await readyOwnerCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller, ownerId } = ready;
  // Only the caller's block. No friendship, request, round, or guess-limiter change.
  const key = friendKvKey("block", `${caller.ownerId}:${ownerId}`);
  const current = await friendGet(boards, key);
  if (typeof current === "string" && current.length > 0) await friendDelete(boards, key);
  return friendJson(200, { ok: true }, cors);
}

async function removeFriend(request, env, cors) {
  const ready = await readyOwnerCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller, ownerId } = ready;
  const forward = await areFriends(boards, caller.ownerId, ownerId);
  const reverse = await areFriends(boards, ownerId, caller.ownerId);
  if (!forward || !reverse) return friendJson(409, { error: "not_friends" }, cors);
  await friendDelete(boards, friendKvKey("friend", `${caller.ownerId}:${ownerId}`));
  await friendDelete(boards, friendKvKey("friend", `${ownerId}:${caller.ownerId}`));
  await saveFriendIds(boards, caller.ownerId, removeFriendId(await loadFriendIds(boards, caller.ownerId), ownerId));
  await saveFriendIds(boards, ownerId, removeFriendId(await loadFriendIds(boards, ownerId), caller.ownerId));
  await deleteOwnedRounds(boards, caller.ownerId);
  await deletePastRoundsFor(boards, ownerId, caller.ownerId);
  return friendJson(200, { ok: true }, cors);
}

async function publishRound(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, PUBLISH_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (unknownFields(parsed.value, ["share", "round"])) return friendJson(400, { error: "invalid_body" }, cors);
  if (!Object.hasOwn(parsed.value, "share") || !Object.hasOwn(parsed.value, "round")) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  const { share, round } = parsed.value;
  if (share === false && round === null) {
    const limited = await consumeIpAction(request, env, "ippub:", cors);
    if (limited) return limited;
    await deleteOwnedRounds(boards, caller.ownerId);
    return friendJson(200, { ok: true }, cors);
  }
  if (share !== true || round == null || typeof round !== "object" || Array.isArray(round)) {
    return friendJson(400, { error: "invalid_body" }, cors);
  }
  const stored = sanitizeRound(round, caller.ownerId);
  if (!stored) return friendJson(400, { error: "invalid_body" }, cors);
  const existing = await loadOwnedRounds(boards, caller.ownerId);
  const index = existing.findIndex((item) => item.id === stored.id);
  if (index >= 0) existing[index] = stored;
  else if (existing.length >= ROUND_CAP) return friendJson(409, { error: "round_limit" }, cors);
  else existing.push(stored);
  const limited = await consumeIpAction(request, env, "ippub:", cors);
  if (limited) return limited;
  await friendPut(boards, friendKvKey("rounds", caller.ownerId), JSON.stringify(existing), {
    expirationTtl: ROUND_TTL_SECONDS,
  });
  return friendJson(200, { ok: true, id: stored.id }, cors);
}

async function listRequests(request, env, cors) {
  const ready = await readyReadCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller, friendKey } = ready;
  if (typeof boards.list !== "function") return friendJson(503, { error: "boards_not_configured" }, cors);
  const limited = await consumeReadLimit(request, env, friendKey, "keyreq:", "ipreq:", cors);
  if (limited) return limited;
  // The requester id is the key suffix, so outgoing fr:req: rows are not a
  // prefix. One fr:req: scan feeds incoming and real outgoing. A quiet-block
  // note lives at fr:out:<sender>:<recipient> and is listed only for that
  // sender. Do not invent a row from fr:block:*:<caller>: a block without a
  // send is not a request, and reading those block rows would reveal it.
  const names = await listKeysByPrefix(boards, "fr:req:");
  const incoming = [];
  const outgoing = [];
  for (const name of names) {
    const parsed = parseRequestKey(name);
    if (!parsed || parsed.recipient === parsed.requester) continue;
    if (parsed.recipient === caller.ownerId) {
      const raw = await friendGet(boards, name);
      if (typeof raw !== "string" || raw.length === 0) continue;
      if (await hasBlock(boards, caller.ownerId, parsed.requester)) continue;
      incoming.push({ ownerId: parsed.requester });
    } else if (parsed.requester === caller.ownerId) {
      const raw = await friendGet(boards, name);
      if (typeof raw !== "string" || raw.length === 0) continue;
      outgoing.push({ ownerId: parsed.recipient });
    }
  }
  const noteNames = await listKeysByPrefix(boards, `fr:out:${caller.ownerId}:`);
  for (const name of noteNames) {
    const recipient = parseOutgoingNoteKey(name, caller.ownerId);
    if (!recipient) continue;
    const raw = await friendGet(boards, name);
    if (typeof raw !== "string" || raw.length === 0) continue;
    outgoing.push({ ownerId: recipient });
  }
  const incomingSorted = dedupeByOwnerId(incoming).sort(compareByOwnerId);
  const outgoingSorted = dedupeByOwnerId(outgoing).sort(compareByOwnerId);
  return friendJson(200, { incoming: incomingSorted, outgoing: outgoingSorted }, cors);
}

async function listFriends(request, env, cors) {
  const ready = await readyReadCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller, friendKey } = ready;
  const limited = await consumeReadLimit(request, env, friendKey, "keylist:", "iplist:", cors);
  if (limited) return limited;
  // accept stores at most FRIEND_CAP ids. Inspect that many, in stored order.
  const ids = (await loadFriendIds(boards, caller.ownerId)).slice(0, FRIEND_CAP);
  const friends = [];
  for (const otherId of ids) {
    const forward = await friendGet(boards, friendKvKey("friend", `${caller.ownerId}:${otherId}`));
    if (typeof forward !== "string" || forward.length === 0) continue;
    const reverse = await friendGet(boards, friendKvKey("friend", `${otherId}:${caller.ownerId}`));
    if (typeof reverse !== "string" || reverse.length === 0) continue;
    if (await hasBlock(boards, caller.ownerId, otherId)) continue;
    if (await hasBlock(boards, otherId, caller.ownerId)) continue;
    // The friend row is "1". No created time is stored, so there is no since.
    friends.push({ ownerId: otherId });
  }
  return friendJson(200, { friends: dedupeByOwnerId(friends).sort(compareByOwnerId) }, cors);
}

async function fetchRounds(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const bodyError = await rejectGetBody(request, cors);
  if (bodyError) return bodyError;
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  const friendIds = await loadFriendIds(boards, caller.ownerId);
  const rounds = await loadOwnedRounds(boards, caller.ownerId);
  for (const otherId of friendIds) {
    const blockedByCaller = await hasBlock(boards, caller.ownerId, otherId);
    const blockedByOther = await hasBlock(boards, otherId, caller.ownerId);
    if (blockedByCaller || blockedByOther) continue;
    for (const round of await loadOwnedRounds(boards, otherId)) {
      // A past round reaches only the friends it was given to.
      if (Array.isArray(round.to) && !round.to.includes(caller.ownerId)) continue;
      rounds.push(round);
    }
  }
  rounds.sort(compareRounds);
  return friendJson(200, { rounds: rounds.map(publicRound) }, cors);
}

/**
 * Your live round for friends. Body { courseName, hole, holes }. holes use the
 * publishRound hole allowlist (score and par always; fir, gir, putts, clubs only
 * when the phone's switches are on), so GPS or any other field is 400.
 * Stored at fr:live:<ownerId> and replaced on every update. The phone sends this
 * only while "Share live rounds with friends" is on and the round is shared.
 */
async function putLive(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, PUBLISH_BODY_LIMIT, false);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  const body = parsed.value;
  if (unknownFields(body, ["courseName", "hole", "holes"])) return friendJson(400, { error: "invalid_body" }, cors);
  if (!validCourseName(body.courseName)) return friendJson(400, { error: "invalid_body" }, cors);
  if (!Number.isInteger(body.hole) || body.hole < 1 || body.hole > 18) return friendJson(400, { error: "invalid_body" }, cors);
  if (!Array.isArray(body.holes) || body.holes.length > 18) return friendJson(400, { error: "invalid_body" }, cors);
  const holes = [];
  const seen = new Set();
  for (const hole of body.holes) {
    const clean = sanitizeHole(hole);
    if (!clean || seen.has(clean.hole)) return friendJson(400, { error: "invalid_body" }, cors);
    seen.add(clean.hole);
    holes.push(clean);
  }
  holes.sort((a, b) => a.hole - b.hole);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  const limited = await consumeIpAction(request, env, "iplive:", cors);
  if (limited) return limited;
  const row = { courseName: body.courseName, hole: body.hole, holes, updatedAt: Date.now() };
  await friendPut(boards, friendKvKey("live", caller.ownerId), JSON.stringify(row), {
    expirationTtl: Math.ceil(FRIEND_LIVE_TTL_MS / 1000),
  });
  return friendJson(200, { ok: true }, cors);
}

/** Round finished, switch turned off, or "Friends can follow" tapped: the row is deleted. */
async function stopLive(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return friendJson(401, { error: "friend_key_required" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, true);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (!parsed.empty && unknownFields(parsed.value, [])) return friendJson(400, { error: "invalid_body" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return friendJson(503, { error: "boards_not_configured" }, cors);
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return friendJson(401, { error: "friend_key_required" }, cors);
  await deleteIfPresent(boards, friendKvKey("live", caller.ownerId));
  return friendJson(200, { ok: true }, cors);
}

/**
 * Friends playing now: accepted friends both ways, not blocked either way,
 * with a live row updated in the last 30 minutes. Never your own row, never a
 * non-friend's, and no field beyond the stored allowlist.
 */
async function fetchLive(request, env, cors) {
  const ready = await readyReadCall(request, env, cors);
  if (ready.error) return ready.error;
  const { boards, caller } = ready;
  const limited = await consumeIpAction(request, env, "iplive:", cors);
  if (limited) return limited;
  const now = Date.now();
  const live = [];
  for (const otherId of await loadFriendIds(boards, caller.ownerId)) {
    if (!(await areFriends(boards, otherId, caller.ownerId))) continue;
    if ((await hasBlock(boards, caller.ownerId, otherId)) || (await hasBlock(boards, otherId, caller.ownerId))) continue;
    const row = readLiveRow(await friendGet(boards, friendKvKey("live", otherId)), now);
    if (row) live.push({ ownerId: otherId, ...row });
  }
  return friendJson(200, { live }, cors);
}

function readLiveRow(raw, now) {
  if (typeof raw !== "string") return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (!Number.isFinite(value.updatedAt) || now - value.updatedAt > FRIEND_LIVE_TTL_MS || value.updatedAt > now + 60_000) return null;
  if (!validCourseName(value.courseName) || !Number.isInteger(value.hole)) return null;
  const holes = Array.isArray(value.holes) ? value.holes.map(sanitizeHole).filter(Boolean) : [];
  const toPar = holes.reduce((sum, hole) => sum + hole.score - hole.par, 0);
  return {
    courseName: value.courseName,
    hole: value.hole,
    toPar,
    holes,
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

async function readyReadCall(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return { error: friendJson(401, { error: "friend_key_required" }, cors) };
  const bodyError = await rejectGetBody(request, cors);
  if (bodyError) return { error: bodyError };
  const boards = boardsBinding(env);
  if (!boards) return { error: friendJson(503, { error: "boards_not_configured" }, cors) };
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return { error: friendJson(401, { error: "friend_key_required" }, cors) };
  return { boards, caller, friendKey };
}

async function rejectGetBody(request, cors) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > FRIEND_BODY_LIMIT) {
    return friendJson(413, { error: "payload_too_large" }, cors);
  }
  if (Number.isFinite(declared) && declared > 0) return friendJson(400, { error: "invalid_body" }, cors);
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, true);
  if (parsed.error) return friendJson(parsed.status, { error: parsed.error }, cors);
  if (!parsed.empty) return friendJson(400, { error: "invalid_body" }, cors);
  return null;
}

function parseRequestKey(name) {
  const prefix = "fr:req:";
  if (typeof name !== "string" || !name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(":");
  if (parts.length !== 2) return null;
  if (!OWNER_ID_RE.test(parts[0]) || !OWNER_ID_RE.test(parts[1])) return null;
  return { recipient: parts[0], requester: parts[1] };
}

function parseOutgoingNoteKey(name, senderOwnerId) {
  const prefix = `fr:out:${senderOwnerId}:`;
  if (typeof name !== "string" || !name.startsWith(prefix)) return null;
  const recipient = name.slice(prefix.length);
  if (!OWNER_ID_RE.test(recipient) || recipient === senderOwnerId) return null;
  return recipient;
}

function compareByOwnerId(left, right) {
  if (left.ownerId < right.ownerId) return -1;
  if (left.ownerId > right.ownerId) return 1;
  return 0;
}

function dedupeByOwnerId(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.ownerId)) continue;
    seen.add(entry.ownerId);
    out.push(entry);
  }
  return out;
}

async function listKeysByPrefix(boards, prefix) {
  const names = [];
  const seenCursors = new Set();
  let cursor;
  for (;;) {
    const options = { prefix, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await boards.list(options);
    const keys = page && Array.isArray(page.keys) ? page.keys : [];
    for (const item of keys) {
      const name = typeof item === "string" ? item : item && item.name;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
    if (!page || page.list_complete !== false) break;
    if (typeof page.cursor !== "string" || page.cursor.length === 0 || seenCursors.has(page.cursor)) break;
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  return names;
}

async function readyOwnerCall(request, env, cors) {
  const friendKey = readFriendKey(request);
  if (!friendKey) return { error: friendJson(401, { error: "friend_key_required" }, cors) };
  const boards = boardsBinding(env);
  if (!boards) return { error: friendJson(503, { error: "boards_not_configured" }, cors) };
  const parsed = await readJsonObject(request, FRIEND_BODY_LIMIT, false);
  if (parsed.error) return { error: friendJson(parsed.status, { error: parsed.error }, cors) };
  if (unknownFields(parsed.value, ["ownerId"])) return { error: friendJson(400, { error: "invalid_body" }, cors) };
  const ownerId = readOwnerId(parsed.value.ownerId);
  if (!ownerId) return { error: friendJson(400, { error: "invalid_body" }, cors) };
  const caller = await loadCaller(boards, friendKey);
  if (!caller) return { error: friendJson(401, { error: "friend_key_required" }, cors) };
  if (ownerId === caller.ownerId) return { error: friendJson(400, { error: "invalid_body" }, cors) };
  return { boards, caller, ownerId };
}

function readOwnerId(raw) {
  if (typeof raw !== "string" || !OWNER_ID_RE.test(raw)) return null;
  return raw;
}

async function loadCaller(boards, friendKey) {
  const keyHash = await sha256Hex(FRIEND_KEY_HASH_PREFIX + friendKey);
  return parseAuth(await friendGet(boards, friendKvKey("k", keyHash)));
}

function requestKey(recipientOwnerId, requesterOwnerId) {
  return friendKvKey("req", `${recipientOwnerId}:${requesterOwnerId}`);
}

function outgoingNoteKey(senderOwnerId, recipientOwnerId) {
  return friendKvKey("out", `${senderOwnerId}:${recipientOwnerId}`);
}

async function storeOutgoingNote(boards, senderOwnerId, recipientOwnerId) {
  const key = outgoingNoteKey(senderOwnerId, recipientOwnerId);
  const existing = await friendGet(boards, key);
  if (typeof existing === "string" && existing.length > 0) return;
  await friendPut(boards, key, "pending");
}

async function deleteOutgoingNote(boards, senderOwnerId, recipientOwnerId) {
  await friendDelete(boards, outgoingNoteKey(senderOwnerId, recipientOwnerId));
}

async function hasBlock(boards, blockerOwnerId, blockedOwnerId) {
  const raw = await friendGet(boards, friendKvKey("block", `${blockerOwnerId}:${blockedOwnerId}`));
  return typeof raw === "string" && raw.length > 0;
}

async function areFriends(boards, leftOwnerId, rightOwnerId) {
  const raw = await friendGet(boards, friendKvKey("friend", `${leftOwnerId}:${rightOwnerId}`));
  return typeof raw === "string" && raw.length > 0;
}

async function loadFriendIds(boards, ownerId) {
  const raw = await friendGet(boards, friendKvKey("friends", ownerId));
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = [];
  const seen = new Set();
  for (const item of parsed) {
    if (typeof item !== "string" || !OWNER_ID_RE.test(item) || item === ownerId || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

async function saveFriendIds(boards, ownerId, ids) {
  const key = friendKvKey("friends", ownerId);
  if (ids.length === 0) {
    await deleteIfPresent(boards, key);
    return;
  }
  await friendPut(boards, key, JSON.stringify(ids));
}

function friendListWouldExceed(ids, otherId) {
  return !ids.includes(otherId) && ids.length >= FRIEND_CAP;
}

function addFriendId(ids, otherId) {
  if (ids.includes(otherId)) return ids;
  return [...ids, otherId];
}

function removeFriendId(ids, otherId) {
  return ids.filter((id) => id !== otherId);
}

async function loadOwnedRounds(boards, ownerId) {
  const raw = await friendGet(boards, friendKvKey("rounds", ownerId));
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rounds = [];
  const seen = new Set();
  for (const item of parsed) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    const { to, ...body } = item;
    const round = sanitizeRound(body, ownerId);
    if (!round || seen.has(round.id)) continue;
    if (Object.hasOwn(item, "to")) {
      // A past round with a bad or empty audience is dropped, never widened to everyone.
      if (!Array.isArray(to)) continue;
      const audience = [...new Set(to.filter((id) => typeof id === "string" && OWNER_ID_RE.test(id)))];
      if (audience.length === 0) continue;
      round.to = audience;
    }
    seen.add(round.id);
    rounds.push(round);
  }
  return rounds;
}

function sanitizeRound(round, callerOwnerId) {
  if (round == null || typeof round !== "object" || Array.isArray(round)) return null;
  if (unknownFields(round, ["id", "ownerId", "courseName", "playedOn", "gross", "toPar", "holes"])) return null;
  if (typeof round.id !== "string" || !ROUND_ID_RE.test(round.id)) return null;
  if (Object.hasOwn(round, "ownerId") && round.ownerId !== callerOwnerId) return null;
  if (!validCourseName(round.courseName)) return null;
  if (!validPlayedOn(round.playedOn)) return null;
  if (!Number.isInteger(round.gross) || round.gross < 1 || round.gross > 200) return null;
  if (!Number.isInteger(round.toPar) || round.toPar < -40 || round.toPar > 200) return null;
  if (!Array.isArray(round.holes) || round.holes.length < 1 || round.holes.length > 18) return null;
  const holes = [];
  const seen = new Set();
  for (const hole of round.holes) {
    const clean = sanitizeHole(hole);
    if (!clean) return null;
    if (seen.has(clean.hole)) return null;
    seen.add(clean.hole);
    holes.push(clean);
  }
  return {
    id: round.id,
    ownerId: callerOwnerId,
    courseName: round.courseName,
    playedOn: round.playedOn,
    gross: round.gross,
    toPar: round.toPar,
    holes,
  };
}

function sanitizeHole(hole) {
  if (hole == null || typeof hole !== "object" || Array.isArray(hole)) return null;
  if (unknownFields(hole, ["hole", "score", "par", "fir", "gir", "putts", "clubs"])) return null;
  if (!Number.isInteger(hole.hole) || hole.hole < 1 || hole.hole > 18) return null;
  if (!Number.isInteger(hole.score) || hole.score < 1 || hole.score > 20) return null;
  if (!Number.isInteger(hole.par) || hole.par < 3 || hole.par > 6) return null;
  const clean = { hole: hole.hole, score: hole.score, par: hole.par };
  if (Object.hasOwn(hole, "fir")) {
    if (typeof hole.fir !== "boolean") return null;
    clean.fir = hole.fir;
  }
  if (Object.hasOwn(hole, "gir")) {
    if (typeof hole.gir !== "boolean") return null;
    clean.gir = hole.gir;
  }
  if (Object.hasOwn(hole, "putts")) {
    if (!Number.isInteger(hole.putts) || hole.putts < 0 || hole.putts > 10) return null;
    clean.putts = hole.putts;
  }
  if (Object.hasOwn(hole, "clubs")) {
    if (!validClubs(hole.clubs)) return null;
    clean.clubs = hole.clubs.slice();
  }
  return clean;
}

function validClubs(clubs) {
  if (!Array.isArray(clubs) || clubs.length < 1 || clubs.length > 8) return false;
  return clubs.every((club) => typeof club === "string" && CLUB_RE.test(club));
}

function validCourseName(value) {
  if (typeof value !== "string") return false;
  if (value !== value.trim()) return false;
  if (value.length < 1 || value.length > 200) return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  return true;
}

function validPlayedOn(value) {
  if (typeof value !== "string") return false;
  const match = PLAYED_ON_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function compareRounds(left, right) {
  if (left.playedOn < right.playedOn) return -1;
  if (left.playedOn > right.playedOn) return 1;
  if (left.ownerId < right.ownerId) return -1;
  if (left.ownerId > right.ownerId) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

async function deleteIfPresent(boards, key) {
  const raw = await friendGet(boards, key);
  if (typeof raw === "string" && raw.length > 0) await friendDelete(boards, key);
}

async function deleteOwnedRounds(boards, ownerId) {
  await deleteIfPresent(boards, friendKvKey("rounds", ownerId));
}

function readFriendKey(request) {
  const raw = request.headers.get("X-Friend-Key");
  if (typeof raw !== "string") return null;
  const friendKey = raw.trim();
  if (!FRIEND_KEY_RE.test(friendKey)) return null;
  if (INSTALL_ID_RE.test(friendKey)) return null;
  const installId = request.headers.get("X-Install-Id");
  if (typeof installId === "string" && installId.trim() === friendKey) return null;
  return friendKey;
}

function normalizeFriendCode(raw) {
  if (typeof raw !== "string") return null;
  const compact = raw.trim().replace(/[\s-]+/g, "").toUpperCase();
  if (!CODE_RE.test(compact)) return null;
  return compact;
}

function unknownFields(value, allowed) {
  const allow = new Set(allowed);
  return Object.keys(value).some((key) => !allow.has(key));
}

async function readJsonObject(request, limit, allowEmpty) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) return { error: "payload_too_large", status: 413 };
  const raw = await request.text();
  // Content-Length can be omitted or understated. The cap is bytes, not UTF-16 units.
  if (byteLength(raw) > limit) return { error: "payload_too_large", status: 413 };
  if (raw.length === 0) {
    if (allowEmpty) return { value: {}, empty: true };
    return { error: "invalid_body", status: 400 };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid_body", status: 400 };
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "invalid_body", status: 400 };
  }
  return { value: parsed, empty: false };
}

function boardsBinding(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function" || typeof boards.delete !== "function") {
    return null;
  }
  return boards;
}

function guessNamespace(env) {
  const ns = env && env.FRIEND_GUESSES;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
  return ns;
}

async function consumeReadLimit(request, env, friendKey, keyPrefix, ipPrefix, cors) {
  if (!guessNamespace(env)) return friendJson(503, { error: "guess_limiter_not_configured" }, cors);
  const now = Date.now();
  const keyHash = await sha256Hex(FRIEND_KEY_HASH_PREFIX + friendKey);
  const keyAttempt = await guessAttempt(env, `${keyPrefix}${keyHash}`, now);
  if (!keyAttempt.ok) return rateLimited(cors, keyAttempt.retryAfterSec);
  const ipHash = await friendIpHash(request);
  if (ipHash) {
    const ipAttempt = await guessAttempt(env, `${ipPrefix}${ipHash}`, now);
    if (!ipAttempt.ok) return rateLimited(cors, ipAttempt.retryAfterSec);
  }
  return null;
}

async function consumeIpAction(request, env, prefix, cors) {
  const ipHash = await friendIpHash(request);
  if (!ipHash) return null;
  if (!guessNamespace(env)) return friendJson(503, { error: "guess_limiter_not_configured" }, cors);
  const attempt = await guessAttempt(env, `${prefix}${ipHash}`, Date.now());
  if (!attempt.ok) return rateLimited(cors, attempt.retryAfterSec);
  return null;
}

async function consumeGuess(request, env, friendKey, cors) {
  const now = Date.now();
  const keyAttempt = await guessAttempt(env, await limiterNameForFriendKey(friendKey), now);
  if (!keyAttempt.ok) return rateLimited(cors, keyAttempt.retryAfterSec);
  const ipHash = await friendIpHash(request);
  if (ipHash) {
    const ipAttempt = await guessAttempt(env, `ip:${ipHash}`, now);
    if (!ipAttempt.ok) return rateLimited(cors, ipAttempt.retryAfterSec);
  }
  return null;
}

async function guessAttempt(env, name, now) {
  const ns = guessNamespace(env);
  const stub = ns.get(ns.idFromName(name));
  const response = await stub.fetch("https://friend-guess.internal/limit", {
    method: "POST",
    body: JSON.stringify({ op: "attempt", now }),
  });
  const body = await response.json();
  if (body && body.ok === true) return { ok: true };
  const retryAfterSec = Number.isFinite(body && body.retryAfterSec) ? body.retryAfterSec : Math.ceil(FRIEND_GUESS_WINDOW_MS / 1000);
  return { ok: false, retryAfterSec };
}

function friendKvKey(kind, id) {
  if (
    kind !== "k" &&
    kind !== "code" &&
    kind !== "req" &&
    kind !== "out" &&
    kind !== "friend" &&
    kind !== "friends" &&
    kind !== "round" &&
    kind !== "rounds" &&
    kind !== "block" &&
    kind !== "invname" &&
    kind !== "invphoto" &&
    kind !== "live"
  ) {
    throw new Error("friend_namespace");
  }
  if (typeof id !== "string" || id.length < 1) throw new Error("friend_namespace");
  const key = `fr:${kind}:${id}`;
  assertFriendNamespace(key);
  return key;
}

function assertFriendNamespace(key) {
  if (typeof key !== "string" || !key.startsWith(FRIEND_KEY_PREFIX)) throw new Error("friend_namespace");
  const rest = key.slice(FRIEND_KEY_PREFIX.length);
  if (COURSE_CACHE_PREFIXES.some((prefix) => rest.startsWith(prefix))) throw new Error("friend_namespace");
}

async function friendGet(boards, key) {
  assertFriendNamespace(key);
  return boards.get(key);
}

async function friendPut(boards, key, value, options) {
  assertFriendNamespace(key);
  if (options) await boards.put(key, value, options);
  else await boards.put(key, value);
}

async function friendDelete(boards, key) {
  assertFriendNamespace(key);
  await boards.delete(key);
}

/** Auth row. Only these two fields. No name, no install id, no raw friend key. */
function storedAuth(ownerId, code) {
  return JSON.stringify({ ownerId, code });
}

function parseAuth(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.ownerId !== "string" || typeof parsed.code !== "string") return null;
  if (!CODE_RE.test(parsed.code)) return null;
  if (Object.keys(parsed).some((key) => key !== "ownerId" && key !== "code")) return null;
  return { ownerId: parsed.ownerId, code: parsed.code };
}

async function unusedCode(boards, avoid) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomFriendCode();
    if (code === avoid) continue;
    const existing = await friendGet(boards, friendKvKey("code", code));
    if (existing == null || existing === "") return code;
  }
  throw new Error("friend_code_exhausted");
}

function randomFriendCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length];
  return out;
}

function randomOwnerId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function friendIpHash(request) {
  const raw = request.headers.get("CF-Connecting-IP");
  if (typeof raw !== "string") return null;
  const ip = raw.trim();
  if (!ip || ip.length > 64 || /[\s\r\n]/.test(ip)) return null;
  return sha256Hex(FRIEND_IP_HASH_PREFIX + ip);
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rateLimited(cors, retryAfterSec) {
  const seconds = String(Math.max(1, Math.ceil(Number(retryAfterSec) || 1)));
  return friendJson(429, { error: "rate_limited" }, cors, { "Retry-After": seconds });
}

function friendJson(status, body, cors, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function doJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
