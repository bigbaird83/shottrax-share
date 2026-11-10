// Shared scorecard SC-2. Made-up ids only. The card is not deployed.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter, SharedGame } from "./entry.js";
import { SHARED_GAME_CREATE_IP_LIMIT } from "./friends.js";
import {
  SHARED_MAX_PER_TEAM,
  SHARED_MAX_PLAYERS,
  SHARED_MAX_TEAMS,
  SHARED_WOLF_PLAYERS,
  WAGER_KEYS,
  projectStanding,
  stripWagerKeys,
} from "./shared-games.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

function wagerKeyHits(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) wagerKeyHits(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      if (WAGER_KEYS.includes(name.toLowerCase())) found.push(name);
      wagerKeyHits(child, found);
    }
  }
  return found;
}

function assertNoWager(value) {
  expect(wagerKeyHits(value)).toEqual([]);
  const text = JSON.stringify(value);
  for (const name of WAGER_KEYS) expect(text).not.toContain(`"${name}"`);
}

function assertNoCard(json) {
  expect(Object.keys(json)).toEqual(["error"]);
  expect(json.game).toBeUndefined();
  expect(json.scores).toBeUndefined();
  expect(json.cell).toBeUndefined();
  expect(json.players).toBeUndefined();
  expect(json.history).toBeUndefined();
  assertNoWager(json);
}

describe("shared games", () => {
  let kv;
  let env;

  beforeEach(() => {
    kv = new Map();
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

  async function call(pathname, { method = "POST", body, friend, ip } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (ip) headers["CF-Connecting-IP"] = ip;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await entry.fetch(
      new Request(`${ORIGIN}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {} },
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text, headers: res.headers };
  }

  async function player(n) {
    const friend = key(n);
    const res = await call("/v1/friends/code", { friend });
    expect(res.status).toBe(200);
    return { friend, ownerId: res.json.ownerId, code: res.json.code };
  }

  function person(playerId, extra = {}) {
    return {
      playerId,
      installId: Object.prototype.hasOwnProperty.call(extra, "installId") ? extra.installId : `id_${playerId.slice(-6)}_p`,
      guest: !!extra.guest,
      team: extra.team === undefined ? null : extra.team,
      ...(extra.name ? { name: extra.name } : {}),
    };
  }

  function gameBody(host, others = [], extra = {}) {
    return {
      format: "strokePlay",
      scoring: "gross",
      players: [person(host.ownerId, { installId: "id_0_host" }), ...others],
      ...extra,
    };
  }

  async function created(host, others, extra) {
    const res = await call("/v1/shared-games", { friend: host.friend, body: gameBody(host, others, extra) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.game;
  }

  function scorePath(gameId) {
    return `/v1/shared-games/${gameId}/scores`;
  }

  it("creates a stroke game and reads it back for a player only", async () => {
    const host = await player(1);
    const pal = await player(2);
    const before = [...kv.keys()].sort();
    const game = await created(host, [person(pal.ownerId)], {
      gameId: "saturday_card",
      scoring: "net",
      teams: [{ number: 1, name: "Birdie Boys", memberIds: [host.ownerId, pal.ownerId] }],
    });
    expect(game.gameId).toBe("saturday_card");
    expect(game).toMatchObject({
      organizerId: host.ownerId,
      format: "strokePlay",
      scoring: "net",
      options: {},
      teams: [{ number: 1, name: "Birdie Boys", memberIds: [host.ownerId, pal.ownerId].sort() }],
    });
    expect(game.players.map((row) => row.playerId).sort()).toEqual([host.ownerId, pal.ownerId].sort());
    expect([...kv.keys()].sort()).toEqual(before);
    expect([...kv.keys()].every((name) => name.startsWith("fr:"))).toBe(true);

    const read = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: pal.friend });
    expect(read.status).toBe(200);
    expect(Object.keys(read.json).sort()).toEqual(["game", "scores"]);
    expect(read.json.scores).toEqual([]);
    expect(read.json.game.gameId).toBe(game.gameId);
    assertNoWager(read.json);
  });

  it("a member gets the card with no wager keys at all, not empty ones", async () => {
    const host = await player(1);
    const body = {
      gameId: "card_no_wager",
      format: "strokePlay",
      scoring: "gross",
      wager: {},
      wagers: [],
      sidegame: null,
      sidegames: { amount: 5 },
      side_game: [],
      side_games: {},
      bet: 1,
      bets: [{ n: 1 }],
      options: { wager: { amount: 20 }, side_games: [], bets: [1] },
      teams: [{ number: 1, name: "Team 1", memberIds: [host.ownerId], bet: {}, wagers: [] }],
      players: [{ ...person(host.ownerId, { installId: "id_0_host", name: "Host" }), sidegame: {}, bets: [] }],
    };
    const made = await call("/v1/shared-games", { friend: host.friend, body });
    expect(made.status).toBe(200);
    assertNoWager(made.json);
    expect(made.json.game.options).toEqual({});
    expect(made.json.game.teams[0].wagers).toBeUndefined();
    expect(made.json.game.players[0].sidegame).toBeUndefined();

    const read = await call("/v1/shared-games/card_no_wager", { method: "GET", friend: host.friend });
    expect(read.status).toBe(200);
    assertNoWager(read.json);
    expect(read.json.game.options).toEqual({});

    const wrote = await call(scorePath(read.json.game.gameId), {
      friend: host.friend,
      body: {
        playerId: host.ownerId,
        hole: 1,
        strokes: 4,
        rev: 0,
        clientWriteId: "write_clean",
        wager: {},
        wagers: [],
        side_game: [],
        bet: 2,
        bets: [],
      },
    });
    expect(wrote.status).toBe(200);
    assertNoWager(wrote.json);
    expect(wrote.json.cell.strokes).toBe(4);
    expect(Object.keys(wrote.json)).toEqual(["cell"]);
  });

  it("a non-member gets 403 and an unknown game gets 404, with no card", async () => {
    const host = await player(1);
    const stranger = await player(2);
    const game = await created(host, [], { gameId: "private_card" });
    const denied = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: stranger.friend });
    expect(denied.status).toBe(403);
    expect(denied.json).toEqual({ error: "forbidden" });
    assertNoCard(denied.json);

    const missing = await call("/v1/shared-games/no_such_game", { method: "GET", friend: stranger.friend });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "not_found" });
    assertNoCard(missing.json);

    const badId = await call("/v1/shared-games/bad!id", { method: "GET", friend: host.friend });
    expect(badId.status).toBe(404);
    expect(badId.json).toEqual({ error: "not_found" });
    assertNoCard(badId.json);

    const wrote = await call(scorePath(game.gameId), {
      friend: stranger.friend,
      body: { playerId: host.ownerId, hole: 1, strokes: 4, rev: 0, clientWriteId: "outsider" },
    });
    expect(wrote.status).toBe(403);
    expect(wrote.json).toEqual({ error: "forbidden" });
    assertNoCard(wrote.json);

    const still = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: host.friend });
    expect(still.status).toBe(200);
    expect(still.json.scores).toEqual([]);
    assertNoWager(still.json);
  });

  for (const direction of ["organizer blocks player", "player blocks organizer"]) {
    it(`refuses blocked players both ways (${direction})`, async () => {
      const host = await player(1);
      const pal = await player(2);
      const other = await player(3);
      const [blocker, blockedId] = direction === "organizer blocks player" ? [host, pal] : [pal, host];
      const blockKey = `fr:block:${blocker.ownerId}:${blockedId.ownerId}`;
      kv.set(blockKey, "1");
      const denied = await call("/v1/shared-games", {
        friend: host.friend,
        body: gameBody(host, [person(pal.ownerId), person(other.ownerId)], { gameId: `blocked_${direction.length}` }),
      });
      expect(denied.status).toBe(409);
      expect(denied.json).toEqual({ error: "blocked" });
      assertNoCard(denied.json);
      const absent = await call(`/v1/shared-games/blocked_${direction.length}`, { method: "GET", friend: other.friend });
      expect(absent.status).toBe(404);
      assertNoCard(absent.json);

      kv.delete(blockKey);
      const game = await created(host, [person(pal.ownerId), person(other.ownerId)], { gameId: `live_${direction.length}` });
      kv.set(blockKey, "1");
      for (const who of [host, pal]) {
        const got = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: who.friend });
        expect(got.status).toBe(409);
        expect(got.json).toEqual({ error: "blocked" });
        assertNoCard(got.json);
        const wrote = await call(scorePath(game.gameId), {
          friend: who.friend,
          body: { playerId: who.ownerId, hole: 1, strokes: 5, rev: 0, clientWriteId: `blk_${who.ownerId.slice(0, 4)}` },
        });
        expect(wrote.status).toBe(409);
        expect(wrote.json).toEqual({ error: "blocked" });
        assertNoCard(wrote.json);
      }
      const third = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: other.friend });
      expect(third.status).toBe(200);
      expect(third.json.scores).toEqual([]);
      assertNoWager(third.json);
    });
  }

  it("keeps one winner and the earlier history when 25 writes race one cell", async () => {
    const host = await player(1);
    const game = await created(host, [], { gameId: "race_card" });
    const setup = await call(scorePath(game.gameId), {
      friend: host.friend,
      body: { playerId: host.ownerId, hole: 3, strokes: 4, rev: 0, clientWriteId: "setup_write" },
    });
    expect(setup.status).toBe(200);
    expect(setup.json.cell.rev).toBe(1);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        call(scorePath(game.gameId), {
          friend: host.friend,
          body: {
            playerId: host.ownerId,
            hole: 3,
            strokes: (i % 12) + 1,
            rev: 1,
            clientWriteId: `race_${i}`,
          },
        }),
      ),
    );
    const wins = results.filter((result) => result.status === 200);
    const loses = results.filter((result) => result.status === 409);
    expect(wins).toHaveLength(1);
    expect(loses).toHaveLength(24);
    expect(results.every((result) => result.status === 200 || result.status === 409)).toBe(true);
    const cell = wins[0].json.cell;
    expect(cell.rev).toBe(2);
    expect(cell.playerId).toBe(host.ownerId);
    expect(cell.hole).toBe(3);
    expect(cell.history.map((entry) => entry.clientWriteId)).toEqual(["setup_write", cell.history[1].clientWriteId]);
    expect(cell.history[0].strokes).toBe(4);
    expect(cell.strokes).toBe(cell.history[1].strokes);
    expect(cell.source).toBe("own");
    for (const lose of loses) {
      expect(lose.json.error).toBe("stale_rev");
      expect(Object.keys(lose.json).sort()).toEqual(["cell", "error"]);
      expect(lose.json.cell).toEqual(cell);
      assertNoWager(lose.json);
    }
    const read = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: host.friend });
    expect(read.status).toBe(200);
    expect(read.json.scores).toEqual([cell]);
    const loserIds = results.map((result) => result.json.cell.history.map((entry) => entry.clientWriteId)).flat();
    expect(new Set(loserIds)).toEqual(new Set(["setup_write", cell.history[1].clientWriteId]));
  });

  it("replays a clientWriteId without a second history row", async () => {
    const host = await player(1);
    const game = await created(host, [], { gameId: "idem_card" });
    const body = { playerId: host.ownerId, hole: 2, strokes: 4, rev: 0, clientWriteId: "write_once" };
    const first = await call(scorePath(game.gameId), { friend: host.friend, body });
    expect(first.status).toBe(200);
    const again = await call(scorePath(game.gameId), {
      friend: host.friend,
      body: { ...body, strokes: 9, rev: 0, wager: {}, bets: [] },
    });
    expect(again.status).toBe(200);
    expect(again.json.cell.strokes).toBe(4);
    expect(again.json.cell.rev).toBe(1);
    expect(again.json.cell.history).toHaveLength(1);
    expect(again.json.cell.history[0].clientWriteId).toBe("write_once");
    assertNoWager(again.json);
  });

  it("returns 409 stale_rev with the standing cell", async () => {
    const host = await player(1);
    const game = await created(host, [], { gameId: "stale_card" });
    const first = await call(scorePath(game.gameId), {
      friend: host.friend,
      body: { playerId: host.ownerId, hole: 5, strokes: 4, rev: 0, clientWriteId: "standing" },
    });
    expect(first.status).toBe(200);
    const stale = await call(scorePath(game.gameId), {
      friend: host.friend,
      body: { playerId: host.ownerId, hole: 5, strokes: 8, rev: 0, clientWriteId: "too_late" },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("stale_rev");
    expect(Object.keys(stale.json).sort()).toEqual(["cell", "error"]);
    expect(stale.json.cell).toEqual(first.json.cell);
    expect(stale.json.cell.strokes).toBe(4);
    expect(stale.json.cell.rev).toBe(1);
    expect(stale.json.cell.history).toHaveLength(1);
    assertNoWager(stale.json);
    const read = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: host.friend });
    expect(read.json.scores[0]).toEqual(first.json.cell);
  });

  it("own entry wins over a suggestion and a host entry for a non-guest", async () => {
    const host = await player(1);
    const pal = await player(2);
    const other = await player(3);
    const game = await created(
      host,
      [person(pal.ownerId), person(other.ownerId), person("guest_pat", { guest: true, installId: null })],
      { gameId: "own_wins" },
    );
    const path = scorePath(game.gameId);

    const suggestedFirst = await call(path, {
      friend: pal.friend,
      body: { playerId: host.ownerId, hole: 2, strokes: 9, rev: 0, clientWriteId: "suggest_blank" },
    });
    expect(suggestedFirst.status).toBe(200);
    expect(suggestedFirst.json.cell.strokes).toBeNull();
    expect(suggestedFirst.json.cell.source).toBeNull();
    expect(suggestedFirst.json.cell.history[0].source).toBe("suggestion");

    const hostEntry = await call(path, {
      friend: host.friend,
      body: { playerId: pal.ownerId, hole: 1, strokes: 7, rev: 0, clientWriteId: "host_provisional" },
    });
    expect(hostEntry.json.cell).toMatchObject({ strokes: 7, source: "host", enteredBy: host.ownerId, conflict: false, rev: 1 });

    const own = await call(path, {
      friend: pal.friend,
      body: { playerId: pal.ownerId, hole: 1, strokes: 4, rev: 1, clientWriteId: "pal_own" },
    });
    expect(own.status).toBe(200);
    expect(own.json.cell).toMatchObject({ strokes: 4, source: "own", enteredBy: pal.ownerId, conflict: true, rev: 2 });
    expect(own.json.cell.history.map((entry) => entry.source)).toEqual(["host", "own"]);

    const hostAgain = await call(path, {
      friend: host.friend,
      body: { playerId: pal.ownerId, hole: 1, strokes: 8, rev: 2, clientWriteId: "host_later" },
    });
    expect(hostAgain.json.cell).toMatchObject({ strokes: 4, source: "own", enteredBy: pal.ownerId, conflict: true, rev: 3 });

    const suggestion = await call(path, {
      friend: other.friend,
      body: { playerId: pal.ownerId, hole: 1, strokes: 5, rev: 3, clientWriteId: "other_suggests" },
    });
    expect(suggestion.json.cell.strokes).toBe(4);
    expect(suggestion.json.cell.source).toBe("own");
    expect(suggestion.json.cell.history).toHaveLength(4);
    expect(suggestion.json.cell.history.map((entry) => [entry.source, entry.strokes])).toEqual([
      ["host", 7],
      ["own", 4],
      ["host", 8],
      ["suggestion", 5],
    ]);

    const guest = await call(path, {
      friend: host.friend,
      body: { playerId: "guest_pat", hole: 3, strokes: 6, rev: 0, clientWriteId: "guest_host" },
    });
    expect(guest.json.cell).toMatchObject({ strokes: 6, source: "host", enteredBy: host.ownerId, conflict: false });
    const guestSuggest = await call(path, {
      friend: pal.friend,
      body: { playerId: "guest_pat", hole: 3, strokes: 8, rev: 1, clientWriteId: "guest_suggest" },
    });
    expect(guestSuggest.json.cell).toMatchObject({ strokes: 6, source: "host", enteredBy: host.ownerId, conflict: true, rev: 2 });
    expect(guestSuggest.json.cell.history.every((entry) => entry.source !== "own")).toBe(true);
    expect(guestSuggest.json.cell.history.map((entry) => entry.source)).toEqual(["host", "suggestion"]);

    const read = await call(`/v1/shared-games/${game.gameId}`, { method: "GET", friend: pal.friend });
    const hole1 = read.json.scores.find((cell) => cell.hole === 1);
    expect(hole1.strokes).toBe(4);
    expect(hole1.history).toHaveLength(4);
    assertNoWager(read.json);
  });

  it("refuses a roster over 2 teams, 4 per team, or 8 players, and wolf unless it is exactly 4", async () => {
    const host = await player(1);
    async function expectCap(body, error) {
      const res = await call("/v1/shared-games", { friend: host.friend, body });
      expect(res.status, JSON.stringify(body.players?.length)).toBe(409);
      expect(res.json).toEqual({ error });
      assertNoCard(res.json);
    }
    const many = (count) => [person(host.ownerId, { installId: "id_0_host" }), ...Array.from({ length: count - 1 }, (_, i) => person(`p${i + 1}`))];

    await expectCap({ format: "strokePlay", scoring: "gross", players: many(SHARED_MAX_PLAYERS + 1) }, "cap");
    await expectCap({ format: "wolf", scoring: "gross", players: many(SHARED_MAX_PLAYERS + 1) }, "cap");

    const five = many(SHARED_MAX_PER_TEAM + 1);
    await expectCap(
      {
        format: "strokePlay",
        scoring: "gross",
        players: five.map((row) => ({ ...row, team: 1 })),
        teams: [{ number: 1, name: "Team 1", memberIds: five.map((row) => row.playerId) }],
      },
      "cap",
    );

    const three = many(3);
    await expectCap(
      {
        format: "strokePlay",
        scoring: "gross",
        players: three.map((row, i) => ({ ...row, team: i + 1 })),
        teams: three.map((row, i) => ({ number: i + 1, name: `Team ${i + 1}`, memberIds: [row.playerId] })),
      },
      "cap",
    );
    expect(SHARED_MAX_TEAMS).toBe(2);

    await expectCap({ format: "wolf", scoring: "gross", players: many(3) }, "wolf");
    await expectCap({ format: "wolf", scoring: "gross", players: many(5) }, "wolf");
    await expectCap({ format: "wolf", scoring: "net", players: many(SHARED_MAX_PLAYERS) }, "wolf");

    const wolf = await call("/v1/shared-games", {
      friend: host.friend,
      body: { format: "wolf", scoring: "gross", players: many(SHARED_WOLF_PLAYERS), gameId: "wolf4" },
    });
    expect(wolf.status).toBe(200);
    expect(wolf.json.game.players).toHaveLength(4);
    expect(wolf.json.game.format).toBe("wolf");

    const full = many(SHARED_MAX_PLAYERS);
    const teams = [0, 1].map((side) => {
      const members = full.slice(side * 4, side * 4 + 4);
      return { number: side + 1, name: `Team ${side + 1}`, memberIds: members.map((row) => row.playerId) };
    });
    const eight = await call("/v1/shared-games", {
      friend: host.friend,
      body: {
        format: "strokePlay",
        scoring: "gross",
        gameId: "eight_players",
        players: full.map((row) => ({
          ...row,
          team: teams[0].memberIds.includes(row.playerId) ? 1 : 2,
        })),
        teams,
      },
    });
    expect(eight.status).toBe(200);
    expect(eight.json.game.players).toHaveLength(8);
    expect(eight.json.game.teams).toHaveLength(2);
    expect(eight.json.game.teams.every((team) => team.memberIds.length === 4)).toBe(true);
    assertNoWager(eight.json);
  });

  it("is idempotent for the same client game id and refuses a different roster", async () => {
    const host = await player(1);
    const body = gameBody(host, [], { gameId: "same_game", format: "bestBall", options: { balls: 2, matchPlay: true } });
    const first = await call("/v1/shared-games", { friend: host.friend, body });
    expect(first.status).toBe(200);
    expect(first.json.game.options).toEqual({ balls: 2, matchPlay: true });
    const wrote = await call(scorePath("same_game"), {
      friend: host.friend,
      body: { playerId: host.ownerId, hole: 1, strokes: 3, rev: 0, clientWriteId: "keep_me" },
    });
    expect(wrote.status).toBe(200);
    const second = await call("/v1/shared-games", { friend: host.friend, body });
    expect(second.status).toBe(200);
    expect(second.json.game.gameId).toBe("same_game");
    const read = await call("/v1/shared-games/same_game", { method: "GET", friend: host.friend });
    expect(read.json.scores).toHaveLength(1);
    expect(read.json.scores[0].strokes).toBe(3);

    const changed = await call("/v1/shared-games", {
      friend: host.friend,
      body: { ...body, scoring: "net" },
    });
    expect(changed.status).toBe(409);
    expect(changed.json).toEqual({ error: "refused" });
    assertNoCard(changed.json);
  });

  it("rejects a team name over 20 code points and counts an emoji once", async () => {
    const host = await player(1);
    const base = (name) =>
      gameBody(host, [], {
        teams: [{ number: 1, name, memberIds: [host.ownerId] }],
      });
    const ok = await call("/v1/shared-games", { friend: host.friend, body: base("👍".repeat(20)) });
    expect(ok.status).toBe(200);
    expect([...ok.json.game.teams[0].name].length).toBe(20);
    const tooLong = await call("/v1/shared-games", { friend: host.friend, body: base("👍".repeat(21)) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json).toEqual({ error: "invalid_body" });
  });

  it("requires a friend key and storage, and rate limits creates", async () => {
    expect((await call("/v1/shared-games", { body: { format: "strokePlay" } })).json).toEqual({ error: "key_required" });
    const host = await player(1);
    expect((await call("/v1/shared-games", { friend: key(99), body: gameBody(host) })).json).toEqual({ error: "key_required" });

    const saved = env.SHARED_GAMES;
    env.SHARED_GAMES = null;
    const down = await call("/v1/shared-games", { friend: host.friend, body: gameBody(host) });
    expect(down.status).toBe(503);
    expect(down.json).toEqual({ error: "unavailable" });
    env.SHARED_GAMES = saved;

    const ip = "203.0.113.40";
    for (let i = 0; i < SHARED_GAME_CREATE_IP_LIMIT; i += 1) {
      const res = await call("/v1/shared-games", { friend: host.friend, ip, body: gameBody(host, [], { gameId: `capgame_${i}` }) });
      expect(res.status, String(i)).toBe(200);
    }
    const limited = await call("/v1/shared-games", {
      friend: host.friend,
      ip,
      body: gameBody(host, [], { gameId: "capgame_over" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("answers options without a key and refuses the wrong method", async () => {
    const options = await call("/v1/shared-games", { method: "OPTIONS" });
    expect(options.status).toBe(200);
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("X-Friend-Key");
    const put = await call("/v1/shared-games", { method: "PUT", body: {} });
    expect(put.status).toBe(405);
    expect(put.json).toEqual({ error: "method_not_allowed" });
    const unknown = await call("/v1/shared-games/abc/nope");
    expect(unknown.json).toEqual({ error: "unknown_route" });
  });

  it("binds the shared-game Durable Object and does not add a var", () => {
    const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain('name = "SHARED_GAMES"');
    expect(toml).toContain('class_name = "SharedGame"');
    expect(toml).toContain('tag = "v4-shared-game"');
    expect(toml).toContain('new_sqlite_classes = ["SharedGame"]');
    expect(toml).not.toMatch(/^\s*SHARED_/m);
  });
});

describe("standing merge", () => {
  it("drops wager keys instead of keeping them empty", () => {
    expect(stripWagerKeys({ wager: {}, wagers: [], bet: 1, bets: [], sidegame: null, sidegames: "", side_game: { a: 1 }, side_games: [], ok: 1, nested: { Wager: 2, left: 3 } })).toEqual({
      ok: 1,
      nested: { left: 3 },
    });
  });

  it("lets the latest own entry beat a later host entry", () => {
    const entries = [
      { source: "host", strokes: 7, enteredBy: "h", rev: 1 },
      { source: "own", strokes: 4, enteredBy: "p", rev: 2 },
      { source: "host", strokes: 8, enteredBy: "h", rev: 3 },
      { source: "suggestion", strokes: 5, enteredBy: "x", rev: 4 },
    ];
    expect(projectStanding(false, entries)).toMatchObject({ strokes: 4, source: "own", enteredBy: "p", rev: 4, conflict: true });
    expect(projectStanding(true, [{ source: "host", strokes: 6, enteredBy: "h", rev: 1 }, { source: "suggestion", strokes: 8, enteredBy: "p", rev: 2 }])).toMatchObject({
      strokes: 6,
      source: "host",
      rev: 2,
      conflict: true,
    });
    expect(projectStanding(true, entries).source).not.toBe("own");
  });
});
