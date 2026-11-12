// Shared scorecard routes for ShotTraxx PR #861: invites, join, decline,
// team rename and suggestions. Made-up ids only. Not deployed.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter, SharedGame } from "./entry.js";
import { EXPO_PUSH_URL, friendKvKey } from "./friends.js";
import { SHARED_INVITE_PUSH_KIND, SHARED_TEAM_NAME_BLOCKLIST, WAGER_KEYS, teamNameHitsBlocklist } from "./shared-games.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const TOKEN = (n) => `ExponentPushToken[tok${n}xxxxxxxxxx]`;

function sqliteState(name) {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const text = String(query);
        const select = /^\s*select\b/i.test(text);
        let rows = [];
        if (!select && bindings.length === 0) db.exec(text);
        else if (select) rows = db.prepare(text).all(...bindings);
        else db.prepare(text).run(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
  let ready = Promise.resolve();
  return {
    id: { name },
    storage,
    db,
    blockConcurrencyWhile(fn) {
      ready = ready.then(() => fn());
      return ready;
    },
  };
}

function namespace(Klass) {
  const objects = new Map();
  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      let obj = objects.get(id.name);
      if (!obj) {
        obj = new Klass(sqliteState(id.name), {});
        objects.set(id.name, obj);
      }
      return {
        fetch(input, init) {
          return obj.fetch(input instanceof Request ? input : new Request(input, init));
        },
      };
    },
  };
}

function key(n) {
  return `k${String(n).padStart(3, "0")}${"b".repeat(40)}`;
}

function assertNoWager(value) {
  const text = JSON.stringify(value);
  for (const name of WAGER_KEYS) expect(text).not.toContain(`"${name}"`);
}

describe("shared games routes for the app (PR #861)", () => {
  let kv;
  let env;
  let pushes;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    kv = new Map();
    pushes = [];
    globalThis.fetch = async (url, init) => {
      pushes.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? "null") });
      return new Response("{}", { status: 200 });
    };
    env = {
      BOARDS: {
        async get(k) {
          return kv.has(k) ? kv.get(k) : null;
        },
        async put(k, v) {
          kv.set(k, v);
        },
        async delete(k) {
          kv.delete(k);
        },
        async list({ prefix = "" } = {}) {
          return {
            keys: [...kv.keys()].filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name })),
            list_complete: true,
          };
        },
      },
      FRIEND_GUESSES: namespace(FriendGuessLimiter),
      SHARED_GAMES: namespace(SharedGame),
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function call(pathname, { method = "POST", body, friend, raw } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
    const res = await entry.fetch(
      new Request(`${ORIGIN}${pathname}`, {
        method,
        headers,
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {} },
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function player(n) {
    const friend = key(n);
    const res = await call("/v1/friends/code", { friend });
    expect(res.status).toBe(200);
    return { friend, ownerId: res.json.ownerId };
  }

  function befriend(a, b) {
    kv.set(friendKvKey("friend", `${a.ownerId}:${b.ownerId}`), "1");
    kv.set(friendKvKey("friend", `${b.ownerId}:${a.ownerId}`), "1");
  }

  function block(a, b) {
    kv.set(friendKvKey("block", `${a.ownerId}:${b.ownerId}`), "1");
  }

  function token(p, n) {
    kv.set(friendKvKey("push", p.ownerId), TOKEN(n));
  }

  /** Host on team 1 plus `others` (each { p, team }), created through the real create route. */
  async function game(host, others = [], extra = {}) {
    const players = [
      { playerId: host.ownerId, installId: "id_host", guest: false, team: 1 },
      ...others.map(({ p, team, guest }) => ({
        playerId: guest ? p : p.ownerId,
        installId: guest ? null : `id_${(guest ? p : p.ownerId).slice(-6)}`,
        guest: !!guest,
        team: team ?? 1,
      })),
    ];
    const wolf = extra.format === "wolf";
    const teams = [];
    for (const row of players) {
      if (wolf) {
        row.team = null;
        continue;
      }
      let team = teams.find((t) => t.number === row.team);
      if (!team) teams.push((team = { number: row.team, name: `Team ${row.team}`, memberIds: [] }));
      team.memberIds.push(row.playerId);
    }
    const res = await call("/v1/shared-games", {
      friend: host.friend,
      body: { gameId: extra.gameId ?? "g1", format: extra.format ?? "strokePlay", scoring: "gross", teams, players },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.game.gameId;
  }

  const PUSH = {
    title: "Alex R invited you to a shared scorecard",
    body: "Scramble match at Pine Hollow. Your scores show for everyone in the match.",
  };

  async function invite(host, gameId, friends, push = PUSH) {
    return call(`/v1/shared-games/${gameId}/invites`, {
      friend: host.friend,
      body: { invitees: friends.map(({ p, team }) => ({ playerId: p.ownerId, friendId: p.ownerId, team: team ?? 2 })), push },
    });
  }

  async function score(p, gameId, playerId, hole, strokes, rev, id) {
    return call(`/v1/shared-games/${gameId}/scores`, {
      friend: p.friend,
      body: { playerId, hole, strokes, rev, clientWriteId: id },
    });
  }

  // ---------- invites ----------

  it("invites: the organizer invites friends; each gets the push once, with the app text and data", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const casey = await player(3);
    befriend(host, jordan);
    befriend(host, casey);
    token(jordan, 2);
    const gameId = await game(host);
    const res = await invite(host, gameId, [{ p: jordan }, { p: casey }]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      invites: [
        { playerId: jordan.ownerId, status: "sent" },
        { playerId: casey.ownerId, status: "sent" },
      ],
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].url).toBe(EXPO_PUSH_URL);
    // Casey has no push token (notifications off): only Jordan's alert goes out.
    expect(pushes[0].body).toEqual([
      { to: TOKEN(2), title: PUSH.title, body: PUSH.body, sound: "default", data: { kind: SHARED_INVITE_PUSH_KIND, gameId } },
    ]);
    expect(SHARED_INVITE_PUSH_KIND).toBe("shared_game_invite");
    // Again: same answer, no second push.
    const again = await invite(host, gameId, [{ p: jordan }]);
    expect(again.json).toEqual({ invites: [{ playerId: jordan.ownerId, status: "sent" }] });
    expect(pushes).toHaveLength(1);
  });

  it("invites: a title-only push sends no body", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    token(jordan, 2);
    const gameId = await game(host);
    const res = await invite(host, gameId, [{ p: jordan }], { title: PUSH.title });
    expect(res.status).toBe(200);
    expect(pushes[0].body[0]).toEqual({ to: TOKEN(2), title: PUSH.title, sound: "default", data: { kind: SHARED_INVITE_PUSH_KIND, gameId } });
  });

  it("invites: a player already in the game reads as joined", async () => {
    const host = await player(1);
    const alex = await player(2);
    befriend(host, alex);
    const gameId = await game(host, [{ p: alex, team: 1 }]);
    const res = await invite(host, gameId, [{ p: alex, team: 1 }]);
    expect(res.json).toEqual({ invites: [{ playerId: alex.ownerId, status: "joined" }] });
    expect(pushes).toHaveLength(0);
  });

  it("invites: only the organizer (403), only for players on the card (403/404), only friends (403)", async () => {
    const host = await player(1);
    const alex = await player(2);
    const jordan = await player(3);
    const stranger = await player(4);
    befriend(host, alex);
    befriend(alex, jordan);
    const gameId = await game(host, [{ p: alex }]);
    expect((await invite(alex, gameId, [{ p: jordan }])).status).toBe(403);
    expect((await invite(stranger, gameId, [{ p: jordan }])).status).toBe(403);
    expect((await invite(host, "nope", [{ p: jordan }])).status).toBe(404);
    // Jordan is not the host's friend.
    const notFriend = await invite(host, gameId, [{ p: jordan }]);
    expect(notFriend.status).toBe(403);
    expect(notFriend.json).toEqual({ error: "forbidden" });
    expect(pushes).toHaveLength(0);
  });

  it("invites: blocked either way with anyone on the card is 409 blocked", async () => {
    const host = await player(1);
    const alex = await player(2);
    const jordan = await player(3);
    befriend(host, alex);
    befriend(host, jordan);
    const gameId = await game(host, [{ p: alex }]);
    for (const [a, b] of [
      [jordan, alex],
      [alex, jordan],
    ]) {
      block(a, b);
      const res = await invite(host, gameId, [{ p: jordan }]);
      expect(res.status).toBe(409);
      expect(res.json).toEqual({ error: "blocked" });
      kv.delete(friendKvKey("block", `${a.ownerId}:${b.ownerId}`));
    }
    expect(pushes).toHaveLength(0);
  });

  it("invites: caps are 409 cap: a third team, a fifth on a team, a ninth player, a fifth wolf", async () => {
    const host = await player(1);
    const friends = [];
    for (let n = 2; n <= 9; n += 1) {
      const p = await player(n);
      befriend(host, p);
      friends.push(p);
    }
    const gameId = await game(host);
    expect((await invite(host, gameId, [{ p: friends[0], team: 3 }])).json).toEqual({ error: "cap" });
    expect((await invite(host, gameId, friends.slice(0, 4).map((p) => ({ p, team: 2 })))).status).toBe(200);
    // Pending invites hold their seats: a fifth on Team 2 is over.
    expect((await invite(host, gameId, [{ p: friends[4], team: 2 }])).json).toEqual({ error: "cap" });
    expect((await invite(host, gameId, friends.slice(4, 7).map((p) => ({ p, team: 1 })))).status).toBe(200);
    // 1 + 4 + 3 = 8; a ninth is over.
    expect((await invite(host, gameId, [{ p: friends[7], team: 1 }])).json).toEqual({ error: "cap" });

    // Eight with no team (stroke play): a ninth on a team is still over eight.
    const host3 = await player(30);
    const solo = [];
    for (let n = 31; n <= 38; n += 1) {
      const p = await player(n);
      befriend(host3, p);
      solo.push(p);
    }
    const open = await call("/v1/shared-games", {
      friend: host3.friend,
      body: {
        gameId: "solo8",
        format: "strokePlay",
        scoring: "gross",
        players: [host3, ...solo.slice(0, 7)].map((p, i) => ({ playerId: p.ownerId, installId: `id_s${i}`, guest: false })),
      },
    });
    expect(open.status, JSON.stringify(open.json)).toBe(200);
    expect((await invite(host3, "solo8", [{ p: solo[7], team: 1 }])).json).toEqual({ error: "cap" });

    const host2 = await player(20);
    const w = [];
    for (let n = 21; n <= 25; n += 1) {
      const p = await player(n);
      befriend(host2, p);
      w.push(p);
    }
    const wolfGame = await game(host2, w.slice(0, 3).map((p) => ({ p, team: 1 })), { gameId: "wolf1", format: "wolf" });
    const fifth = await invite(host2, wolfGame, [{ p: w[3], team: 1 }]);
    expect(fifth.status).toBe(409);
    expect(fifth.json).toEqual({ error: "cap" });
  });

  it("invites: bad bodies are 400 invalid_body", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const gameId = await game(host);
    const path = `/v1/shared-games/${gameId}/invites`;
    const good = { playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2 };
    for (const body of [
      {},
      { invitees: [], push: PUSH },
      { invitees: [good] },
      { invitees: [good], push: {} },
      { invitees: [good], push: { title: "" } },
      { invitees: [good], push: { title: "t", body: "" } },
      { invitees: [good], push: { title: "t", extra: 1 } },
      { invitees: [{ ...good, playerId: "f-other" }], push: PUSH },
      { invitees: [{ ...good, team: 0 }], push: PUSH },
      { invitees: [{ ...good, extra: 1 }], push: PUSH },
      { invitees: [good, good], push: PUSH },
      { invitees: [good], push: PUSH, extra: true },
    ]) {
      const res = await call(path, { friend: host.friend, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    }
    expect((await call(path, { friend: host.friend, raw: "{" })).status).toBe(400);
    expect((await call(path, { body: { invitees: [good], push: PUSH } })).status).toBe(401);
    expect((await call(path, { method: "GET", friend: host.friend })).status).toBe(405);
  });

  it("invites: wager keys are stripped and never pushed", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    token(jordan, 2);
    const gameId = await game(host);
    const res = await call(`/v1/shared-games/${gameId}/invites`, {
      friend: host.friend,
      body: {
        invitees: [{ playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2, wager: 5 }],
        push: { ...PUSH, bets: [1] },
        sidegames: {},
      },
    });
    expect(res.status).toBe(200);
    assertNoWager(res.json);
    assertNoWager(pushes);
  });

  // ---------- join / decline ----------

  it("join: the invited friend joins as themselves, mid-round too, and reads the card", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const gameId = await game(host);
    await invite(host, gameId, [{ p: jordan }]);
    const joined = await call(`/v1/shared-games/${gameId}/join`, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: 4 } });
    expect(joined.status, JSON.stringify(joined.json)).toBe(200);
    expect(Object.keys(joined.json)).toEqual(["game"]);
    const me = joined.json.game.players.find((row) => row.playerId === jordan.ownerId);
    expect(me).toEqual({ playerId: jordan.ownerId, installId: jordan.ownerId, guest: false, team: 2, name: null });
    expect(joined.json.game.teams.find((team) => team.number === 2)).toBeUndefined();
    const read = await call(`/v1/shared-games/${gameId}`, { method: "GET", friend: jordan.friend });
    expect(read.status).toBe(200);
    // The invite now reads as joined.
    expect((await invite(host, gameId, [{ p: jordan }])).json).toEqual({ invites: [{ playerId: jordan.ownerId, status: "joined" }] });
    // Joining again returns the game.
    const again = await call(`/v1/shared-games/${gameId}/join`, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: null } });
    expect(again.status).toBe(200);
  });

  it("join: not invited is 403, as someone else is 403, no game is 404, blocked is 409, bad holes are 400", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const casey = await player(3);
    const alex = await player(4);
    befriend(host, jordan);
    befriend(host, casey);
    befriend(host, alex);
    const gameId = await game(host, [{ p: alex }]);
    const path = `/v1/shared-games/${gameId}/join`;
    expect((await call(path, { friend: casey.friend, body: { playerId: casey.ownerId, joinedHole: null } })).json).toEqual({ error: "forbidden" });
    await invite(host, gameId, [{ p: jordan }, { p: casey }]);
    // Casey is invited too, but cannot join as Jordan.
    expect((await call(path, { friend: casey.friend, body: { playerId: jordan.ownerId, joinedHole: null } })).json).toEqual({ error: "forbidden" });
    expect((await call("/v1/shared-games/nope/join", { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: null } })).status).toBe(404);
    for (const joinedHole of [0, 19, 2.5, "4"]) {
      expect((await call(path, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole } })).status).toBe(400);
    }
    expect((await call(path, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: null, x: 1 } })).status).toBe(400);
    block(alex, jordan);
    const blocked = await call(path, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: null } });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toEqual({ error: "blocked" });
  });

  it("decline: the invited friend declines; then they cannot join; a player cannot decline", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const alex = await player(3);
    befriend(host, jordan);
    befriend(host, alex);
    const gameId = await game(host, [{ p: alex }]);
    await invite(host, gameId, [{ p: jordan }]);
    const res = await call(`/v1/shared-games/${gameId}/decline`, { friend: jordan.friend, body: { playerId: jordan.ownerId } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect((await call(`/v1/shared-games/${gameId}/join`, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: null } })).status).toBe(403);
    expect((await call(`/v1/shared-games/${gameId}/decline`, { friend: jordan.friend, body: { playerId: jordan.ownerId } })).status).toBe(403);
    const player2 = await call(`/v1/shared-games/${gameId}/decline`, { friend: alex.friend, body: { playerId: alex.ownerId } });
    expect(player2.status).toBe(409);
    expect(player2.json).toEqual({ error: "refused" });
    expect((await call(`/v1/shared-games/${gameId}/decline`, { friend: alex.friend, body: { playerId: jordan.ownerId } })).status).toBe(403);
    expect((await call(`/v1/shared-games/${gameId}/decline`, { friend: alex.friend, body: {} })).status).toBe(400);
    expect((await call("/v1/shared-games/nope/decline", { friend: jordan.friend, body: { playerId: jordan.ownerId } })).status).toBe(404);
  });

  // ---------- team rename ----------

  it("teams/:n: a player on that team renames it; another team is 403", async () => {
    const host = await player(1);
    const alex = await player(2);
    befriend(host, alex);
    const gameId = await game(host, [{ p: alex, team: 2 }]);
    const res = await call(`/v1/shared-games/${gameId}/teams/2`, { friend: alex.friend, body: { name: "  Birdie Boys " } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ team: { number: 2, name: "Birdie Boys" } });
    const read = await call(`/v1/shared-games/${gameId}`, { method: "GET", friend: host.friend });
    expect(read.json.game.teams.find((team) => team.number === 2)).toEqual({ number: 2, name: "Birdie Boys", memberIds: [alex.ownerId] });
    const other = await call(`/v1/shared-games/${gameId}/teams/1`, { friend: alex.friend, body: { name: "Mine now" } });
    expect(other.status).toBe(403);
    expect(other.json).toEqual({ error: "forbidden" });
  });

  it("teams/:n: 20 code points, no control characters, the app's filter; bad team numbers are 404", async () => {
    const host = await player(1);
    const gameId = await game(host);
    const path = `/v1/shared-games/${gameId}/teams/1`;
    expect((await call(path, { friend: host.friend, body: { name: "⛳".repeat(20) } })).status).toBe(200);
    for (const name of ["", "   ", "a".repeat(21), "⛳".repeat(21), "bad\u0007name", "Shit Show", "s.h.i.t.s", 7]) {
      const res = await call(path, { friend: host.friend, body: { name } });
      expect(res.status, String(name)).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    }
    expect((await call(path, { friend: host.friend, body: { name: "Classic Pass" } })).status).toBe(200);
    expect((await call(path, { friend: host.friend, body: { name: "ok", x: 1 } })).status).toBe(400);
    expect((await call(`/v1/shared-games/${gameId}/teams/3`, { friend: host.friend, body: { name: "x" } })).status).toBe(404);
    expect((await call(`/v1/shared-games/${gameId}/teams/0`, { friend: host.friend, body: { name: "x" } })).status).toBe(404);
    expect((await call("/v1/shared-games/nope/teams/1", { friend: host.friend, body: { name: "x" } })).status).toBe(404);
  });

  it("the team-name filter matches the app's list and rule", () => {
    expect(SHARED_TEAM_NAME_BLOCKLIST).toHaveLength(16);
    expect(teamNameHitsBlocklist("Shit Show")).toBe(true);
    expect(teamNameHitsBlocklist("s.h.i.t")).toBe(true);
    expect(teamNameHitsBlocklist("Classic")).toBe(false);
    expect(teamNameHitsBlocklist("Pass")).toBe(false);
    expect(teamNameHitsBlocklist("Birdie Boys")).toBe(false);
  });

  // ---------- suggestions ----------

  async function scoredGame() {
    const host = await player(1);
    const alex = await player(2);
    befriend(host, alex);
    const gameId = await game(host, [{ p: alex }, { p: "guest_pat", guest: true }]);
    expect((await score(alex, gameId, alex.ownerId, 3, 5, 0, "w_a3")).status).toBe(200);
    expect((await score(host, gameId, "guest_pat", 3, 6, 0, "w_p3")).status).toBe(200);
    return { host, alex, gameId };
  }

  async function suggest(p, gameId, body) {
    return call(`/v1/shared-games/${gameId}/suggestions`, { friend: p.friend, body });
  }

  async function resolve(p, gameId, id, action) {
    return call(`/v1/shared-games/${gameId}/suggestions/${id}`, { friend: p.friend, body: { action } });
  }

  it("suggestions: another player suggests a fix; the standing score does not move until accepted", async () => {
    const { host, alex, gameId } = await scoredGame();
    const res = await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ suggestion: { id: "s1", status: "open" } });
    const read = await call(`/v1/shared-games/${gameId}`, { method: "GET", friend: host.friend });
    const cell = read.json.scores.find((row) => row.playerId === alex.ownerId && row.hole === 3);
    expect([cell.strokes, cell.rev, cell.source]).toEqual([5, 1, "own"]);
    // Same id again is the same suggestion.
    expect((await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 })).json).toEqual({
      suggestion: { id: "s1", status: "open" },
    });
    // Same id, different content: refused.
    expect((await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 6, rev: 1 })).json).toEqual({
      error: "refused",
    });
  });

  it("suggestions: a stale rev is 409 stale_rev with the standing cell", async () => {
    const { host, alex, gameId } = await scoredGame();
    const res = await suggest(host, gameId, { suggestionId: "s2", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 2 });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("stale_rev");
    expect(res.json.cell).toMatchObject({ playerId: alex.ownerId, hole: 3, strokes: 5, rev: 1, source: "own" });
  });

  it("suggestions: not for a guest, not for your own score, not before a score, not off the card", async () => {
    const { host, alex, gameId } = await scoredGame();
    const refused = { error: "refused" };
    expect((await suggest(alex, gameId, { suggestionId: "g1", playerId: "guest_pat", hole: 3, strokes: 5, rev: 1 })).json).toEqual(refused);
    expect((await suggest(alex, gameId, { suggestionId: "o1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 })).json).toEqual(refused);
    expect((await suggest(host, gameId, { suggestionId: "n1", playerId: alex.ownerId, hole: 9, strokes: 4, rev: 1 })).json).toEqual(refused);
    expect((await suggest(host, gameId, { suggestionId: "x1", playerId: "someone_else", hole: 3, strokes: 4, rev: 1 })).json).toEqual(refused);
    const stranger = await player(9);
    expect((await suggest(stranger, gameId, { suggestionId: "z1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 })).status).toBe(403);
    expect((await suggest(host, "nope", { suggestionId: "z2", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 })).status).toBe(404);
  });

  it("suggestions: bad bodies are 400", async () => {
    const { host, alex, gameId } = await scoredGame();
    const good = { suggestionId: "s9", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 };
    for (const body of [
      {},
      { ...good, suggestionId: "bad id" },
      { ...good, hole: 0 },
      { ...good, hole: 19 },
      { ...good, strokes: 0 },
      { ...good, strokes: 26 },
      { ...good, rev: 0 },
      { ...good, extra: 1 },
    ]) {
      const res = await suggest(host, gameId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    }
  });

  it("suggestions/:id accept: the player takes it as their own score", async () => {
    const { host, alex, gameId } = await scoredGame();
    await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 });
    const res = await resolve(alex, gameId, "s1", "accept");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ suggestion: { id: "s1", status: "accepted" } });
    const read = await call(`/v1/shared-games/${gameId}`, { method: "GET", friend: alex.friend });
    const cell = read.json.scores.find((row) => row.playerId === alex.ownerId && row.hole === 3);
    expect([cell.strokes, cell.rev, cell.source, cell.enteredBy]).toEqual([4, 2, "own", alex.ownerId]);
    // Closed: a second accept or keep is refused.
    expect((await resolve(alex, gameId, "s1", "keep")).json).toEqual({ error: "refused" });
  });

  it("suggestions/:id keep: closes it and the score stays", async () => {
    const { host, alex, gameId } = await scoredGame();
    await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 });
    expect((await resolve(alex, gameId, "s1", "keep")).json).toEqual({ suggestion: { id: "s1", status: "kept" } });
    const read = await call(`/v1/shared-games/${gameId}`, { method: "GET", friend: alex.friend });
    const cell = read.json.scores.find((row) => row.playerId === alex.ownerId && row.hole === 3);
    expect([cell.strokes, cell.rev]).toEqual([5, 1]);
  });

  it("suggestions/:id: accept after the score moved is 409 stale_rev with the cell, and the suggestion stays open", async () => {
    const { host, alex, gameId } = await scoredGame();
    await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 });
    expect((await score(alex, gameId, alex.ownerId, 3, 6, 1, "w_a3b")).status).toBe(200);
    const res = await resolve(alex, gameId, "s1", "accept");
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("stale_rev");
    expect(res.json.cell).toMatchObject({ strokes: 6, rev: 2 });
    expect((await resolve(alex, gameId, "s1", "keep")).json).toEqual({ suggestion: { id: "s1", status: "kept" } });
  });

  it("suggestions/:id: only that player (403), unknown id (404), bad action (400)", async () => {
    const { host, alex, gameId } = await scoredGame();
    await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 });
    expect((await resolve(host, gameId, "s1", "accept")).json).toEqual({ error: "forbidden" });
    expect((await resolve(alex, gameId, "nope", "accept")).status).toBe(404);
    expect((await resolve(alex, gameId, "s1", "approve")).status).toBe(400);
    expect((await call(`/v1/shared-games/${gameId}/suggestions/s1`, { friend: alex.friend, body: { action: "keep", x: 1 } })).status).toBe(400);
    expect((await call(`/v1/shared-games/${gameId}/suggestions/bad%20id`, { friend: alex.friend, body: { action: "keep" } })).status).toBe(404);
  });

  it("no new route answers with a wager key", async () => {
    const { host, alex, gameId } = await scoredGame();
    const answers = [
      await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1, wager: 1 }),
      await suggest(host, gameId, { suggestionId: "s1", playerId: alex.ownerId, hole: 3, strokes: 4, rev: 1 }),
      await resolve(alex, gameId, "s1", "keep"),
      await call(`/v1/shared-games/${gameId}/teams/1`, { friend: host.friend, body: { name: "Team One", bets: [] } }),
    ];
    expect(answers[0].status).toBe(200);
    for (const answer of answers) assertNoWager(answer.json);
  });
  // ---------- the app's client (ShotTraxx PR #861, src/domain/sharedGameInviteApi.ts) ----------
  // The client lives in the app repo, so its six request builders and its
  // checks on each answer are copied here as they are in #861. A change to
  // either side that breaks the other fails this test.
  const client = {
    invite: (gameId, invitees, push) => [
      `/v1/shared-games/${encodeURIComponent(gameId)}/invites`,
      {
        invitees: invitees.map((row) => ({ playerId: row.playerId, friendId: row.friendId, team: row.teamNo })),
        push: { title: push.title, ...(push.body ? { body: push.body } : {}) },
      },
    ],
    join: (gameId, playerId, joinedHole) => [`/v1/shared-games/${encodeURIComponent(gameId)}/join`, { playerId, joinedHole }],
    decline: (gameId, playerId) => [`/v1/shared-games/${encodeURIComponent(gameId)}/decline`, { playerId }],
    renameTeam: (gameId, teamNo, name) => [`/v1/shared-games/${encodeURIComponent(gameId)}/teams/${teamNo}`, { name }],
    suggest: (gameId, input) => [
      `/v1/shared-games/${encodeURIComponent(gameId)}/suggestions`,
      { suggestionId: input.suggestionId, playerId: input.playerId, hole: input.hole, strokes: input.strokes, rev: input.rev },
    ],
    resolve: (gameId, id, action) => [`/v1/shared-games/${encodeURIComponent(gameId)}/suggestions/${encodeURIComponent(id)}`, { action }],
  };
  const send = (who, [path, body]) => call(path, { friend: who.friend, body });

  it("the app's request bodies get answers the app's client accepts, start to finish", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const alex = await player(3);
    befriend(host, jordan);
    befriend(host, alex);
    token(jordan, 2);
    const gameId = await game(host, [{ p: alex, team: 1 }]);

    const invited = await send(host, client.invite(gameId, [{ playerId: jordan.ownerId, friendId: jordan.ownerId, teamNo: 2 }], PUSH));
    expect(invited.status).toBe(200);
    for (const row of invited.json.invites) {
      expect(Object.keys(row).sort()).toEqual(["playerId", "status"]);
      expect(["sent", "joined"]).toContain(row.status);
    }
    expect(pushes[0].body[0].data).toEqual({ kind: "shared_game_invite", gameId });

    const joined = await send(jordan, client.join(gameId, jordan.ownerId, null));
    expect(joined.status).toBe(200);
    // parseSharedGame: same gameId, every non-guest has an install id.
    expect(joined.json.game.gameId).toBe(gameId);
    for (const row of joined.json.game.players) if (!row.guest) expect(typeof row.installId).toBe("string");

    const renamed = await send(jordan, client.renameTeam(gameId, 2, "Fairway Finders"));
    expect(renamed.json.team).toEqual({ number: 2, name: "Fairway Finders" });

    expect((await score(alex, gameId, alex.ownerId, 1, 5, 0, "w_c1")).status).toBe(200);
    const suggested = await send(jordan, client.suggest(gameId, { suggestionId: "sg_1", playerId: alex.ownerId, hole: 1, strokes: 4, rev: 1 }));
    expect(suggested.json.suggestion.id).toBe("sg_1");
    const stale = await send(jordan, client.suggest(gameId, { suggestionId: "sg_2", playerId: alex.ownerId, hole: 1, strokes: 4, rev: 2 }));
    // sharedGameFailureForStatus reads 409 stale_rev with the standing cell.
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("stale_rev");
    expect(stale.json.cell.hole).toBe(1);
    const accepted = await send(alex, client.resolve(gameId, "sg_1", "accept"));
    expect(accepted.json.suggestion).toEqual({ id: "sg_1", status: "accepted" });

    const casey = await player(4);
    befriend(host, casey);
    await send(host, client.invite(gameId, [{ playerId: casey.ownerId, friendId: casey.ownerId, teamNo: 2 }], { title: PUSH.title }));
    expect((await send(casey, client.decline(gameId, casey.ownerId))).json).toEqual({ ok: true });
  });

  it("an invitee's playerId must be their friend id: #861's f-<friendId> is 400 until the app sends the friend id", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const gameId = await game(host);
    const prefixed = `f-${jordan.ownerId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const res = await send(host, client.invite(gameId, [{ playerId: prefixed, friendId: jordan.ownerId, teamNo: 2 }], PUSH));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_body" });
  });
});
