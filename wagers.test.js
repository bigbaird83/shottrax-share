// SG-2 wager store and exclusion. Made-up ids only. Not deployed.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter, LeagueRoster, SharedGame } from "./entry.js";
import { handleLivePage } from "./live-page.js";
import { WAGER_KEYS } from "./wager-keys.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";

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

function namespace(Klass, states) {
  const objects = new Map();
  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      let obj = objects.get(id.name);
      if (!obj) {
        const state = sqliteState(id.name);
        if (states) states.set(id.name, state);
        obj = new Klass(state, {});
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

describe("SG-2 wager store and exclusion", () => {
  let kv;
  let env;
  let states;

  beforeEach(() => {
    kv = new Map();
    states = new Map();
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
      SHARED_GAMES: namespace(SharedGame, states),
      LEAGUES: namespace(LeagueRoster),
    };
  });

  async function call(pathname, { method = "POST", body, friend } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
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
    };
  }

  async function befriend(from, to) {
    const sent = await call("/v1/friends/requests", { friend: from.friend, body: { code: to.code } });
    expect(sent.status).toBe(200);
    const accepted = await call("/v1/friends/requests/accept", { friend: to.friend, body: { ownerId: from.ownerId } });
    expect(accepted.status).toBe(200);
  }

  function wagerBody(host, pal) {
    return {
      unit: "$",
      who: "player",
      pays: "hole",
      amount: "5",
      players: [
        { playerId: host.ownerId, optedIn: true, confirmed: true, amount: "3.34" },
        { playerId: pal.ownerId, optedIn: true, confirmed: false, amount: "9.99" },
      ],
    };
  }

  async function gameWithWager() {
    const host = await player(1);
    const pal = await player(2);
    const guest = await player(3);
    const made = await call("/v1/shared-games", {
      friend: host.friend,
      body: {
        gameId: "side_card",
        format: "strokePlay",
        scoring: "gross",
        players: [
          person(host.ownerId, { installId: "id_host_allow" }),
          person(pal.ownerId, { installId: "id_pal_allow" }),
          person(guest.ownerId, { guest: true, installId: null }),
        ],
      },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const saved = await call("/v1/shared-games/side_card/wager", { friend: host.friend, body: wagerBody(host, pal) });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    return { host, pal, guest };
  }

  it("stores install ids only on the allowlist", async () => {
    const { host, pal, guest } = await gameWithWager();
    const db = states.get("shared:side_card").db;
    const columns = db.prepare("PRAGMA table_info(wager_allow)").all();
    expect(columns.map((column) => column.name)).toEqual(["install_id"]);
    const rows = db.prepare("SELECT * FROM wager_allow ORDER BY install_id").all();
    expect(rows).toEqual([{ install_id: "id_host_allow" }, { install_id: "id_pal_allow" }]);
    expect(rows.every((row) => Object.keys(row).length === 1 && typeof row.install_id === "string")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(guest.ownerId);
    expect(JSON.stringify(rows)).not.toContain(host.ownerId);
  });

  it("gives wager fields to an allowlisted caller and the scorecard with the keys absent otherwise", async () => {
    const { host, pal, guest } = await gameWithWager();
    const seen = await call("/v1/shared-games/side_card", { method: "GET", friend: host.friend });
    expect(seen.status).toBe(200);
    expect(seen.json.wager).toMatchObject({
      unit: "$",
      customUnit: null,
      who: "player",
      pays: "hole",
      amount: "5",
      locked: false,
    });
    expect(seen.json.wager.players.map((player) => player.amount).sort()).toEqual(["3.34", "9.99", null]);
    expect(seen.json.game.gameId).toBe("side_card");

    const palSeen = await call("/v1/shared-games/side_card", { method: "GET", friend: pal.friend });
    expect(palSeen.json.wager.unit).toBe("$");
    expect(palSeen.json.wager.amount).toBe("5");

    const hidden = await call("/v1/shared-games/side_card", { method: "GET", friend: guest.friend });
    expect(hidden.status).toBe(200);
    expect(hidden.json.game.gameId).toBe("side_card");
    expect(Array.isArray(hidden.json.scores)).toBe(true);
    expect(Object.hasOwn(hidden.json, "wager")).toBe(false);
    expect(hidden.json.wager).toBeUndefined();
    expect(Object.hasOwn(hidden.json, "wagers")).toBe(false);
    expect(hidden.json.wagers).toBeUndefined();
    const text = JSON.stringify(hidden.json);
    for (const name of WAGER_KEYS) expect(text).not.toContain(`"${name}"`);
    expect(text).not.toContain("3.34");
    expect(text).not.toContain("9.99");
  });

  it("accepts a custom unit of 12 code points and refuses 13 or a blank", async () => {
    const host = await player(1);
    const made = await call("/v1/shared-games", {
      friend: host.friend,
      body: {
        gameId: "unit_card",
        format: "strokePlay",
        scoring: "gross",
        players: [person(host.ownerId, { installId: "id_host_allow" })],
      },
    });
    expect(made.status).toBe(200);
    const twelve = "👍".repeat(12);
    const ok = await call("/v1/shared-games/unit_card/wager", {
      friend: host.friend,
      body: { unit: "custom", customUnit: twelve, who: "player", pays: "hole", amount: "1" },
    });
    expect(ok.status).toBe(200);
    expect([...ok.json.wager.customUnit].length).toBe(12);
    expect(ok.json.wager.customUnit).toBe(twelve);

    const thirteen = await call("/v1/shared-games/unit_card/wager", {
      friend: host.friend,
      body: { unit: "custom", customUnit: "👍".repeat(13), who: "player", pays: "hole", amount: "1" },
    });
    expect(thirteen.status).toBe(400);
    expect(thirteen.json).toEqual({ error: "invalid_body" });

    for (const customUnit of ["", "   "]) {
      const blank = await call("/v1/shared-games/unit_card/wager", {
        friend: host.friend,
        body: { unit: "custom", customUnit, who: "player", pays: "hole", amount: "1" },
      });
      expect(blank.status, JSON.stringify(customUnit)).toBe(400);
      expect(blank.json).toEqual({ error: "invalid_body" });
    }

    const kept = await call("/v1/shared-games/unit_card", { method: "GET", friend: host.friend });
    expect(kept.json.wager.customUnit).toBe(twelve);
  });

  it("accepts a 1000000 amount and locks the wager after hole 1 is scored", async () => {
    const host = await player(1);
    await call("/v1/shared-games", {
      friend: host.friend,
      body: {
        gameId: "big_card",
        format: "strokePlay",
        scoring: "gross",
        players: [person(host.ownerId, { installId: "id_host_allow" })],
      },
    });
    const big = await call("/v1/shared-games/big_card/wager", {
      friend: host.friend,
      body: { unit: "Points", who: "team", pays: "round", amount: "1000000" },
    });
    expect(big.status).toBe(200);
    expect(big.json.wager.amount).toBe("1000000");
    const scored = await call("/v1/shared-games/big_card/scores", {
      friend: host.friend,
      body: { playerId: host.ownerId, hole: 1, strokes: 4, rev: 0, clientWriteId: "hole_one" },
    });
    expect(scored.status).toBe(200);
    const locked = await call("/v1/shared-games/big_card/wager", {
      friend: host.friend,
      body: { unit: "Points", who: "team", pays: "round", amount: "2" },
    });
    expect(locked.status).toBe(409);
    expect(locked.json).toEqual({ error: "locked" });
    const read = await call("/v1/shared-games/big_card", { method: "GET", friend: host.friend });
    expect(read.json.wager.amount).toBe("1000000");
    expect(read.json.wager.locked).toBe(true);
  });

  it("strips Friends Board wager keys before ranking and rejects a post that carries them", async () => {
    const host = await player(1);
    const before = [...kv.keys()].sort();
    kv.set(
      `fr:rounds:${host.ownerId}`,
      JSON.stringify([
        {
          id: "low",
          ownerId: host.ownerId,
          courseName: "Pine",
          playedOn: "2026-11-01",
          gross: 70,
          toPar: -2,
          holes: [{ hole: 1, score: 3, par: 4 }],
          scramble: { size: 2, ownerIds: [], guests: 1, board: true },
          wager: { amount: "$5" },
          wagers: [],
        },
        {
          id: "high",
          ownerId: host.ownerId,
          courseName: "Pine",
          playedOn: "2026-11-02",
          gross: 90,
          toPar: 18,
          holes: [{ hole: 1, score: 6, par: 4 }],
          scramble: { size: 2, ownerIds: [], guests: 1, board: true },
        },
      ]),
    );
    const board = await call("/v1/friends/board", { method: "GET", friend: host.friend });
    expect(board.status).toBe(200);
    expect(board.json.board).toHaveLength(2);
    expect(board.json.board.map((round) => [round.rank, round.id])).toEqual([
      [1, "low"],
      [2, "high"],
    ]);
    expect(Object.hasOwn(board.json.board[0], "wager")).toBe(false);
    expect(board.json.board[0].wager).toBeUndefined();
    expect(board.json.board[0].wagers).toBeUndefined();
    expect(JSON.stringify(board.json)).not.toContain('"$5"');
    expect(JSON.stringify(board.json)).not.toContain('"wager"');
    expect(JSON.stringify(board.json)).not.toContain('"wagers"');

    const posted = await call("/v1/friends/board", {
      friend: host.friend,
      body: { id: "nope", wager: { amount: "$5" }, wagers: [] },
    });
    expect(posted.status).toBe(400);
    expect(posted.json).toEqual({ error: "wager_rejected" });
    expect([...kv.keys()].sort()).toEqual([...before, `fr:rounds:${host.ownerId}`].sort());
  });

  it("strips group-feed wager keys and rejects a post that carries them", async () => {
    const host = await player(1);
    const before = [...kv.keys()].sort();
    kv.set(
      `fr:rounds:${host.ownerId}`,
      JSON.stringify([
        {
          id: "feed_round",
          ownerId: host.ownerId,
          courseName: "Pine",
          playedOn: "2026-11-01",
          gross: 72,
          toPar: 0,
          holes: [{ hole: 1, score: 4, par: 4 }],
          side_game: { amount: "$5" },
          bet: 1,
        },
      ]),
    );
    const feed = await call("/v1/friends/feed", { method: "GET", friend: host.friend });
    expect(feed.status).toBe(200);
    expect(feed.json.feed).toHaveLength(1);
    expect(feed.json.feed[0].id).toBe("feed_round");
    expect(Object.hasOwn(feed.json.feed[0], "side_game")).toBe(false);
    expect(feed.json.feed[0].side_game).toBeUndefined();
    expect(feed.json.feed[0].bet).toBeUndefined();
    expect(JSON.stringify(feed.json)).not.toContain('"side_game"');
    expect(JSON.stringify(feed.json)).not.toContain('"bet"');
    expect(JSON.stringify(feed.json)).not.toContain("$");

    const posted = await call("/v1/friends/feed", { friend: host.friend, body: { bets: [], note: "hello" } });
    expect(posted.status).toBe(400);
    expect(posted.json).toEqual({ error: "wager_rejected" });
    expect([...kv.keys()].sort()).toEqual([...before, `fr:rounds:${host.ownerId}`].sort());
  });

  it("keeps wager data out of the live follow stream, even for a friend of a player in the game", async () => {
    const { host, pal } = await gameWithWager();
    await befriend(host, pal);
    const clean = await call("/v1/friends/live", {
      method: "PUT",
      friend: host.friend,
      body: { courseName: "Pine Hollow GC", hole: 2, holes: [{ hole: 1, score: 4, par: 4 }] },
    });
    expect(clean.status).toBe(200);
    const rejected = await call("/v1/friends/live", {
      method: "PUT",
      friend: host.friend,
      body: {
        courseName: "Pine Hollow GC",
        hole: 3,
        holes: [{ hole: 1, score: 5, par: 4 }],
        wager: { unit: "$", amount: "5" },
        wagers: [],
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toEqual({ error: "wager_rejected" });

    const stored = JSON.parse(kv.get(`fr:live:${host.ownerId}`));
    stored.wager = { unit: "$", amount: "5" };
    stored.side_games = [{ amount: "$5" }];
    stored.bets = [];
    kv.set(`fr:live:${host.ownerId}`, JSON.stringify(stored));

    const live = await call("/v1/friends/live", { method: "GET", friend: pal.friend });
    expect(live.status).toBe(200);
    expect(live.json.live).toHaveLength(1);
    expect(live.json.live[0].ownerId).toBe(host.ownerId);
    expect(live.json.live[0].courseName).toBe("Pine Hollow GC");
    expect(live.json.live[0].hole).toBe(2);
    expect(Object.hasOwn(live.json.live[0], "wager")).toBe(false);
    expect(live.json.live[0].wager).toBeUndefined();
    const text = JSON.stringify(live.json);
    for (const name of WAGER_KEYS) expect(text).not.toContain(`"${name}"`);
    expect(text).not.toContain("9.99");
    expect(text).not.toContain("3.34");
    expect(text).not.toContain("$");
  });

  it("builds share image and share page payloads with no $ and no wager fields", async () => {
    const { host } = await gameWithWager();
    const share = await call("/v1/shared-games/side_card/share", { method: "GET", friend: host.friend });
    expect(share.status).toBe(200);
    expect(share.json.page.title).toBe("Shared scorecard");
    expect(share.json.image.gameId).toBe("side_card");
    expect(share.json.image.players.length).toBeGreaterThan(0);
    const packed = JSON.stringify(share.json);
    expect(packed.includes("$")).toBe(false);
    for (const name of WAGER_KEYS) expect(packed).not.toContain(`"${name}"`);
    expect(packed).not.toContain("3.34");
    expect(packed).not.toContain("9.99");
    expect(Object.hasOwn(share.json, "wager")).toBe(false);
    expect(Object.hasOwn(share.json.image, "wager")).toBe(false);
    expect(Object.hasOwn(share.json.page, "wager")).toBe(false);

    kv.set(
      "BK3MCQ",
      JSON.stringify({
        courseName: "Pine $ Club",
        holes: [{ hole: 1, par: 4, score: 4, putts: 2 }],
        wager: { unit: "$", amount: "5" },
        wagers: [],
        side_game: { amount: "$5" },
        group: {
          players: [
            { name: "Alex", holes: [{ hole: 1, score: 4 }], total: 4 },
            { name: "Sam $", holes: [{ hole: 1, score: 5 }], total: 5 },
          ],
          results: [{ title: "Side games", lines: ["$5 each", "Team owes $10"] }],
        },
      }),
    );
    const pageRes = await entry.fetch(new Request(`${ORIGIN}/s/BK3MCQ`), env, { waitUntil() {} });
    expect(pageRes.status).toBe(200);
    const pageText = await pageRes.text();
    expect(pageText.includes("$")).toBe(false);
    const visible = pageText.slice(0, pageText.indexOf("<script"));
    expect(visible).not.toContain("Side games");
    expect(visible).not.toMatch(/wager/i);
    const boardJson = pageText.slice(pageText.indexOf("var board = "), pageText.indexOf("var POLL_MS"));
    expect(boardJson.includes("$")).toBe(false);
    for (const name of WAGER_KEYS) expect(boardJson).not.toContain(`"${name}"`);
    expect(boardJson).not.toContain("Side games");

    const direct = await handleLivePage(new Request(`${ORIGIN}/s/BK3MCQ`), env, {
      loadBoard: (code) => env.BOARDS.get(code),
    });
    const html = await direct.text();
    expect(html.includes("$")).toBe(false);
    expect(html.slice(html.indexOf("var board = "), html.indexOf("var POLL_MS"))).not.toContain('"wager"');
  });

  it("never returns wagers from league standings or members", async () => {
    const host = await player(1);
    const made = await call("/v1/leagues", {
      friend: host.friend,
      body: {
        name: "Saturday Crew",
        yourName: "Player A",
        game: "strokePlay",
        scoring: "net",
        carryOver: false,
        homeCourse: "Mock Pines GC",
        seasonStarts: "2026-11-01",
        seasonEnds: "2027-03-31",
      },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = made.json.league.id;
    const members = await call(`/v1/leagues/members?league=${id}`, { method: "GET", friend: host.friend });
    const standings = await call(`/v1/leagues/standings?league=${id}`, { method: "GET", friend: host.friend });
    expect(members.status).toBe(200);
    expect(standings.status).toBe(200);
    expect(members.json.members.length).toBeGreaterThan(0);
    expect(Array.isArray(standings.json.rows)).toBe(true);
    for (const res of [members, standings]) {
      const text = JSON.stringify(res.json);
      expect(text.includes("$")).toBe(false);
      for (const name of WAGER_KEYS) expect(text).not.toContain(`"${name}"`);
      expect(Object.hasOwn(res.json, "wager")).toBe(false);
      expect(res.json.wager).toBeUndefined();
    }
  });

  it("deletes wagers with the game and with the linked round", async () => {
    const host = await player(1);
    const round = {
      id: "round_side",
      courseName: "Pine",
      playedOn: "2026-11-01",
      gross: 72,
      toPar: 0,
      holes: [{ hole: 1, score: 4, par: 4 }],
    };
    expect((await call("/v1/friends/rounds", { method: "PUT", friend: host.friend, body: { share: true, round } })).status).toBe(200);
    const made = await call("/v1/shared-games", {
      friend: host.friend,
      body: {
        gameId: "linked_card",
        roundId: "round_side",
        format: "strokePlay",
        scoring: "gross",
        players: [person(host.ownerId, { installId: "id_host_allow" })],
      },
    });
    expect(made.status).toBe(200);
    expect(made.json.game.roundId).toBe("round_side");
    expect((await call("/v1/shared-games/linked_card/wager", {
      friend: host.friend,
      body: { unit: "Beers", who: "team", pays: "nine", amount: "1" },
    })).status).toBe(200);
    const before = await call("/v1/shared-games/linked_card", { method: "GET", friend: host.friend });
    expect(before.json.wager.unit).toBe("Beers");

    const removed = await call("/v1/friends/rounds/delete", { friend: host.friend, body: { ids: ["round_side"] } });
    expect(removed.status).toBe(200);
    expect(removed.json.removed).toBe(1);
    const afterRound = await call("/v1/shared-games/linked_card", { method: "GET", friend: host.friend });
    expect(afterRound.status).toBe(200);
    expect(afterRound.json.game.gameId).toBe("linked_card");
    expect(Object.hasOwn(afterRound.json, "wager")).toBe(false);
    expect(afterRound.json.wager).toBeUndefined();
    expect(states.get("shared:linked_card").db.prepare("SELECT COUNT(*) AS n FROM wager").get().n).toBe(0);
    expect(states.get("shared:linked_card").db.prepare("SELECT COUNT(*) AS n FROM game").get().n).toBe(1);

    expect((await call("/v1/shared-games/linked_card/wager", {
      friend: host.friend,
      body: { unit: "Beers", who: "team", pays: "nine", amount: "2" },
    })).status).toBe(200);
    const deleted = await call("/v1/shared-games/linked_card/delete", { friend: host.friend, body: {} });
    expect(deleted.status).toBe(200);
    expect(deleted.json).toEqual({ ok: true });
    const gone = await call("/v1/shared-games/linked_card", { method: "GET", friend: host.friend });
    expect(gone.status).toBe(404);
    expect(gone.json).toEqual({ error: "not_found" });
    expect(states.get("shared:linked_card").db.prepare("SELECT COUNT(*) AS n FROM wager").get().n).toBe(0);
    expect(states.get("shared:linked_card").db.prepare("SELECT COUNT(*) AS n FROM wager_allow").get().n).toBe(0);
    expect(states.get("shared:linked_card").db.prepare("SELECT COUNT(*) AS n FROM game").get().n).toBe(0);
  });

  it("applies the two-way block to wager reads and writes", async () => {
    const { host, pal } = await gameWithWager();
    for (const [blocker, blocked] of [
      [host, pal],
      [pal, host],
    ]) {
      kv.set(`fr:block:${blocker.ownerId}:${blocked.ownerId}`, "1");
      for (const who of [host, pal]) {
        const read = await call("/v1/shared-games/side_card", { method: "GET", friend: who.friend });
        expect(read.status).toBe(409);
        expect(read.json).toEqual({ error: "blocked" });
        expect(Object.hasOwn(read.json, "wager")).toBe(false);
        const wrote = await call("/v1/shared-games/side_card/wager", { friend: who.friend, body: wagerBody(host, pal) });
        expect(wrote.status).toBe(409);
        expect(wrote.json).toEqual({ error: "blocked" });
        const exported = await call("/v1/shared-games/side_card/export", { method: "GET", friend: who.friend });
        expect(exported.status).toBe(409);
        expect(exported.json).toEqual({ error: "blocked" });
        const share = await call("/v1/shared-games/side_card/share", { method: "GET", friend: who.friend });
        expect(share.status).toBe(409);
        expect(share.json).toEqual({ error: "blocked" });
      }
      kv.delete(`fr:block:${blocker.ownerId}:${blocked.ownerId}`);
    }
    const restored = await call("/v1/shared-games/side_card", { method: "GET", friend: host.friend });
    expect(restored.status).toBe(200);
    expect(restored.json.wager.amount).toBe("5");
  });

  it("exports the caller's own wager and leaves every other player's wager out", async () => {
    const { host, pal, guest } = await gameWithWager();
    const hostExport = await call("/v1/shared-games/side_card/export", { method: "GET", friend: host.friend });
    expect(hostExport.status).toBe(200);
    expect(hostExport.json.wager.self).toEqual({
      playerId: host.ownerId,
      optedIn: true,
      confirmed: true,
      amount: "3.34",
    });
    expect(hostExport.json.wager.unit).toBe("$");
    const hostText = JSON.stringify(hostExport.json);
    expect(hostText).not.toContain(pal.ownerId);
    expect(hostText).not.toContain(guest.ownerId);
    expect(hostText).not.toContain("9.99");
    expect(hostExport.json.wager.players).toBeUndefined();

    const palExport = await call("/v1/shared-games/side_card/export", { method: "GET", friend: pal.friend });
    expect(palExport.json.wager.self.playerId).toBe(pal.ownerId);
    expect(palExport.json.wager.self.amount).toBe("9.99");
    const palText = JSON.stringify(palExport.json);
    expect(palText).not.toContain(host.ownerId);
    expect(palText).not.toContain("3.34");

    const guestExport = await call("/v1/shared-games/side_card/export", { method: "GET", friend: guest.friend });
    expect(guestExport.status).toBe(200);
    expect(guestExport.json.wager.self.playerId).toBe(guest.ownerId);
    expect(guestExport.json.wager.self.amount).toBeNull();
    const guestText = JSON.stringify(guestExport.json);
    expect(guestText).not.toContain(host.ownerId);
    expect(guestText).not.toContain(pal.ownerId);
    expect(guestText).not.toContain("3.34");
    expect(guestText).not.toContain("9.99");
  });
});
