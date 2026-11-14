// GET /v1/shared-games/invites: the caller's invites still waiting on them, so
// an invitee whose push never arrived still gets the Join row. Made-up ids only.
// Not deployed.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter, SharedGame } from "./entry.js";
import { friendKvKey } from "./friends.js";
import { SHARED_INVITE_LIST_MAX, WAGER_KEYS } from "./shared-games.js";

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

describe("GET /v1/shared-games/invites", () => {
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

  function mine(p) {
    return call("/v1/shared-games/invites", { method: "GET", friend: p.friend });
  }

  function indexKeys(p) {
    return [...kv.keys()].filter((name) => name.startsWith(`${friendKvKey("sginv", p.ownerId)}:`));
  }

  it("lists a pending invite for the invitee only: game id, host name, format, course, time", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const casey = await player(3);
    befriend(host, jordan);
    befriend(host, casey);
    const gameId = await game(host, [], { format: "scramble" });
    expect((await invite(host, gameId, [{ p: jordan }])).status).toBe(200);
    const res = await mine(jordan);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(Object.keys(res.json)).toEqual(["invites"]);
    expect(res.json.invites).toHaveLength(1);
    const [row] = res.json.invites;
    expect(Object.keys(row).sort()).toEqual(["course", "format", "gameId", "hostName", "invitedAt"]);
    expect(row).toMatchObject({ gameId, hostName: "Alex R", format: "scramble", course: "Pine Hollow" });
    expect(typeof row.invitedAt).toBe("number");
    assertNoWager(res.json);
    // Not invited, and the host: nothing.
    expect((await mine(casey)).json).toEqual({ invites: [] });
    expect((await mine(host)).json).toEqual({ invites: [] });
  });

  it("a title-only push lists the host name with no course", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const gameId = await game(host);
    await invite(host, gameId, [{ p: jordan }], { title: "Sam Q invited you to a shared scorecard" });
    expect((await mine(jordan)).json.invites).toEqual([
      expect.objectContaining({ gameId, hostName: "Sam Q", format: "strokePlay", course: null }),
    ]);
  });

  it("a title the app did not build falls back to the host's own Friends name", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    kv.set(friendKvKey("ownname", host.ownerId), "Pat H");
    const gameId = await game(host);
    await invite(host, gameId, [{ p: jordan }], { title: "Come play", body: "Something else." });
    expect((await mine(jordan)).json.invites).toEqual([
      expect.objectContaining({ gameId, hostName: "Pat H", course: null }),
    ]);
  });

  it("works with no push token: the list does not depend on the push", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const gameId = await game(host);
    await invite(host, gameId, [{ p: jordan }]);
    expect(pushes).toHaveLength(0);
    expect((await mine(jordan)).json.invites.map((row) => row.gameId)).toEqual([gameId]);
  });

  it("newest first, across games", async () => {
    const host = await player(1);
    const other = await player(3);
    const jordan = await player(2);
    befriend(host, jordan);
    befriend(other, jordan);
    const first = await game(host, [], { gameId: "g_first" });
    await invite(host, first, [{ p: jordan }]);
    const second = await game(other, [], { gameId: "g_second" });
    await invite(other, second, [{ p: jordan }]);
    // Make the order certain whatever the clock did.
    const firstKey = `${friendKvKey("sginv", jordan.ownerId)}:${first}`;
    kv.set(firstKey, JSON.stringify({ ...JSON.parse(kv.get(firstKey)), at: 1 }));
    expect((await mine(jordan)).json.invites.map((row) => row.gameId)).toEqual([second, first]);
  });

  it("a joined or declined invite leaves the list and its row", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const casey = await player(3);
    befriend(host, jordan);
    befriend(host, casey);
    const gameId = await game(host);
    await invite(host, gameId, [{ p: jordan }, { p: casey }]);
    expect(indexKeys(jordan)).toHaveLength(1);
    const joined = await call(`/v1/shared-games/${gameId}/join`, { friend: jordan.friend, body: { playerId: jordan.ownerId, joinedHole: null } });
    expect(joined.status).toBe(200);
    expect((await mine(jordan)).json).toEqual({ invites: [] });
    expect(indexKeys(jordan)).toHaveLength(0);
    const declined = await call(`/v1/shared-games/${gameId}/decline`, { friend: casey.friend, body: { playerId: casey.ownerId } });
    expect(declined.status).toBe(200);
    expect((await mine(casey)).json).toEqual({ invites: [] });
    expect(indexKeys(casey)).toHaveLength(0);
  });

  it("a row whose invite is no longer waiting is dropped when listed", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    // A row for a game that does not exist, and one for a game with no invite for Jordan.
    kv.set(`${friendKvKey("sginv", jordan.ownerId)}:ghost`, JSON.stringify({ at: 5, hostName: "X", course: null }));
    const gameId = await game(host);
    kv.set(`${friendKvKey("sginv", jordan.ownerId)}:${gameId}`, JSON.stringify({ at: 6, hostName: "X", course: null }));
    expect((await mine(jordan)).json).toEqual({ invites: [] });
    expect(indexKeys(jordan)).toEqual([]);
  });

  it("a block either way with anyone on the card hides the invite but keeps its row", async () => {
    const host = await player(1);
    const jordan = await player(2);
    const alex = await player(4);
    befriend(host, jordan);
    befriend(host, alex);
    const gameId = await game(host, [{ p: alex }]);
    await invite(host, gameId, [{ p: jordan }]);
    block(alex, jordan);
    expect((await mine(jordan)).json).toEqual({ invites: [] });
    expect(indexKeys(jordan)).toHaveLength(1);
    kv.delete(friendKvKey("block", `${alex.ownerId}:${jordan.ownerId}`));
    expect((await mine(jordan)).json.invites.map((row) => row.gameId)).toEqual([gameId]);
  });

  it(`returns at most ${SHARED_INVITE_LIST_MAX}`, async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    for (let n = 0; n < SHARED_INVITE_LIST_MAX + 2; n += 1) {
      const gameId = await game(host, [], { gameId: `g_${n}` });
      await invite(host, gameId, [{ p: jordan }]);
    }
    expect((await mine(jordan)).json.invites).toHaveLength(SHARED_INVITE_LIST_MAX);
  });

  it("has its own read budget: 60 list reads an hour, then 429, and card reads still work", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const gameId = await game(host);
    for (let n = 0; n < 60; n += 1) expect((await mine(host)).status).toBe(200);
    expect((await mine(host)).status).toBe(429);
    expect((await call(`/v1/shared-games/${gameId}`, { method: "GET", friend: host.friend })).status).toBe(200);
  });

  it("same auth as the other shared-games routes: no key 401, unknown key 401, GET only, no body", async () => {
    const jordan = await player(2);
    expect((await call("/v1/shared-games/invites", { method: "GET" })).status).toBe(401);
    expect((await call("/v1/shared-games/invites", { method: "GET", friend: key(99) })).status).toBe(401);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call("/v1/shared-games/invites", { method, friend: jordan.friend, body: {} });
      expect(res.status).toBe(405);
      expect(res.json).toEqual({ error: "method_not_allowed" });
    }
  });

  it("the invite row holds no score and no wager, and creating a game writes none", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    const before = [...kv.keys()].sort();
    const gameId = await game(host);
    expect([...kv.keys()].sort()).toEqual(before);
    await call(`/v1/shared-games/${gameId}/invites`, {
      friend: host.friend,
      body: { invitees: [{ playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2 }], push: { ...PUSH, wagers: [{ amount: 5 }] } },
    });
    const [row] = indexKeys(jordan);
    expect(Object.keys(JSON.parse(kv.get(row))).sort()).toEqual(["at", "course", "hostName", "organizerId"]);
    assertNoWager(JSON.parse(kv.get(row)));
  });
});
