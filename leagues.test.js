// Leagues PR 1: create, preview/join by code, members, standings. Made-up data only.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry, { FriendGuessLimiter, LeagueRoster } from "./entry.js";
import { FRIEND_GUESS_WINDOW_MS } from "./friends.js";
import { LEAGUE_MAX_PLAYERS, leagueStandings, pointsForPosition, roundPoints } from "./leagues.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

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

const SEASON = { seasonStarts: "2026-11-01", seasonEnds: "2027-03-31" };

function newLeague(extra = {}) {
  return {
    name: "Saturday Crew",
    yourName: "Player A",
    game: "skins",
    scoring: "net",
    carryOver: true,
    homeCourse: "Mock Pines GC",
    ...SEASON,
    ...extra,
  };
}

describe("leagues", () => {
  let kv;
  let env;
  let rosters;

  beforeEach(() => {
    kv = new Map();
    rosters = new Map();
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
          return { keys: [...kv.keys()].filter((n) => n.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
        },
      },
      FRIEND_GUESSES: namespace(FriendGuessLimiter),
      LEAGUES: namespace(LeagueRoster, rosters),
    };
  });

  async function call(pathname, { method = "POST", body, friend, ip } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (ip) headers["CF-Connecting-IP"] = ip;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await entry.fetch(
      new Request(`${ORIGIN}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
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
    return { friend, ownerId: res.json.ownerId, code: res.json.code };
  }

  async function created(owner, extra) {
    const res = await call("/v1/leagues", { friend: owner.friend, body: newLeague(extra) });
    expect(res.status).toBe(200);
    return res.json;
  }

  it("creates a league with the owner as the first of 20 players", async () => {
    const owner = await player(1);
    const out = await created(owner);
    expect(out.code).toMatch(CODE_RE);
    expect(out.league).toMatchObject({
      name: "Saturday Crew",
      ownerId: owner.ownerId,
      ownerName: "Player A",
      game: "skins",
      scoring: "net",
      carryOver: true,
      homeCourse: "Mock Pines GC",
      seasonStarts: "2026-11-01",
      seasonEnds: "2027-03-31",
      players: 1,
      maxPlayers: 20,
    });
    // KV holds only the code -> league id row for leagues. Names live in the roster object.
    const leagueRows = [...kv.keys()].filter((k) => k.startsWith("lg:"));
    expect(leagueRows).toEqual([`lg:code:${out.code}`]);
    expect(kv.get(`lg:code:${out.code}`)).toBe(out.league.id);
    // One name per player: creating sets the Friends name too.
    expect(kv.get(`fr:ownname:${owner.ownerId}`)).toBe("Player A");
  });

  it("refuses bad create bodies", async () => {
    const owner = await player(1);
    const cases = [
      [{ name: "   " }, "invalid_body"],
      [{ name: "x".repeat(33) }, "invalid_body"],
      [{ yourName: " " }, "name_required"],
      [{ yourName: "y".repeat(25) }, "name_required"],
      [{ game: "wolf" }, "invalid_body"],
      [{ scoring: "both" }, "invalid_body"],
      [{ game: "strokePlay", carryOver: true }, "invalid_body"],
      [{ seasonStarts: "2027-04-01" }, "invalid_body"],
      [{ seasonEnds: "2027-02-30" }, "invalid_body"],
      [{ extra: 1 }, "invalid_body"],
    ];
    for (const [patch, error] of cases) {
      const res = await call("/v1/leagues", { friend: owner.friend, body: newLeague(patch) });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.json.error).toBe(error);
    }
    expect([...kv.keys()].some((k) => k.startsWith("lg:"))).toBe(false);
  });

  it("allows a league with no home course", async () => {
    const owner = await player(1);
    const out = await created(owner, { homeCourse: null, game: "stableford", carryOver: false });
    expect(out.league.homeCourse).toBeNull();
  });

  it("needs a friend key with a friend code", async () => {
    expect((await call("/v1/leagues", { body: newLeague() })).status).toBe(401);
    expect((await call("/v1/leagues", { friend: key(9), body: newLeague() })).status).toBe(401);
  });

  it("limits new leagues per IP", async () => {
    const owner = await player(1);
    for (let i = 0; i < 30; i += 1) {
      expect((await call("/v1/leagues", { friend: owner.friend, ip: "203.0.113.7", body: newLeague() })).status).toBe(200);
    }
    const res = await call("/v1/leagues", { friend: owner.friend, ip: "203.0.113.7", body: newLeague() });
    expect(res.status).toBe(429);
  });

  it("previews by code without a member list or owner id, typed or spaced", async () => {
    const owner = await player(1);
    const { code } = await created(owner);
    const guest = await player(2);
    const spaced = `${code.slice(0, 4)} ${code.slice(4)}`.toLowerCase();
    const res = await call("/v1/leagues/preview", { friend: guest.friend, body: { code: spaced } });
    expect(res.status).toBe(200);
    expect(res.json.league).toMatchObject({ name: "Saturday Crew", ownerName: "Player A", homeCourse: "Mock Pines GC", players: 1, maxPlayers: 20 });
    expect(res.json.league.ownerId).toBeUndefined();
    expect(res.json.members).toBeUndefined();
    expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code: "AAAABBBB" } })).status).toBe(404);
    expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code: "AAAA0BBB" } })).status).toBe(400);
  });

  it("join needs a name, sets the Friends name, and a repeat join is a no-op", async () => {
    const owner = await player(1);
    const { code, league } = await created(owner);
    const guest = await player(2);
    for (const name of ["", "   ", null]) {
      const res = await call("/v1/leagues/join", { friend: guest.friend, body: { code, name } });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("name_required");
    }
    const first = await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "  Player   K " } });
    expect(first.status).toBe(200);
    expect(first.json.joined).toBe(true);
    expect(first.json.league.players).toBe(2);
    expect(kv.get(`fr:ownname:${guest.ownerId}`)).toBe("Player K");
    const again = await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } });
    expect(again.status).toBe(200);
    expect(again.json.joined).toBe(false);
    expect(again.json.league.players).toBe(2);
    const members = await call(`/v1/leagues/members?league=${league.id}`, { method: "GET", friend: guest.friend });
    expect(members.json.members.map((m) => [m.name, m.role])).toEqual([
      ["Player A", "owner"],
      ["Player K", "member"],
    ]);
  });

  it("25 joins at once make exactly 20 players; the rest get league_full", async () => {
    const owner = await player(1);
    const { code, league } = await created(owner);
    const guests = [];
    for (let i = 2; i <= 26; i += 1) guests.push(await player(i));
    const results = await Promise.all(
      guests.map((g, i) => call("/v1/leagues/join", { friend: g.friend, body: { code, name: `Player ${i}` } })),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(LEAGUE_MAX_PLAYERS - 1);
    const full = results.filter((r) => r.status === 409);
    expect(full.length).toBe(6);
    expect(full.every((r) => r.json.error === "league_full")).toBe(true);
    const members = await call(`/v1/leagues/members?league=${league.id}`, { method: "GET", friend: owner.friend });
    expect(members.json.members.length).toBe(20);
    expect(members.json.league.players).toBe(20);
    const preview = await call("/v1/leagues/preview", { friend: guests[24].friend, body: { code } });
    expect(preview.json.league.players).toBe(20);
  });

  it("a caller the owner blocked sees the code as not found", async () => {
    const owner = await player(1);
    const { code } = await created(owner);
    const guest = await player(2);
    kv.set(`fr:block:${owner.ownerId}:${guest.ownerId}`, "1");
    expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code } })).status).toBe(404);
    const res = await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("code_not_found");
  });

  it("code guesses use the friend code guess limit", async () => {
    const guest = await player(2);
    for (let i = 0; i < 8; i += 1) {
      expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code: "AAAABBBB" } })).status).toBe(404);
    }
    expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code: "AAAABBBB" } })).status).toBe(429);
  });

  describe("only bad or unknown codes use up a guess", () => {
    afterEach(() => vi.restoreAllMocks());

    it("a successful preview and join leave all 8 guesses", async () => {
      const owner = await player(1);
      const { code } = await created(owner);
      const guest = await player(2);
      const ip = "203.0.113.9";
      expect((await call("/v1/leagues/preview", { friend: guest.friend, ip, body: { code } })).status).toBe(200);
      expect((await call("/v1/leagues/join", { friend: guest.friend, ip, body: { code, name: "Player K" } })).status).toBe(200);
      for (let i = 0; i < 8; i += 1) {
        expect((await call("/v1/leagues/preview", { friend: guest.friend, ip, body: { code: "AAAABBBB" } })).status).toBe(404);
      }
      expect((await call("/v1/leagues/preview", { friend: guest.friend, ip, body: { code: "AAAABBBB" } })).status).toBe(429);
    });

    it("8 bad codes block, and a valid code stays blocked until the window resets", async () => {
      let now = Date.UTC(2026, 10, 1, 20, 0, 0);
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const owner = await player(1);
      const { code } = await created(owner);
      const guest = await player(2);
      for (let i = 0; i < 8; i += 1) {
        expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code: "AAAABBBB" } })).status).toBe(404);
      }
      expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code: "AAAABBBB" } })).status).toBe(429);
      expect((await call("/v1/leagues/preview", { friend: guest.friend, body: { code } })).status).toBe(429);
      expect((await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } })).status).toBe(429);
      now += FRIEND_GUESS_WINDOW_MS - 1000;
      expect((await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } })).status).toBe(429);
      now += 1000;
      const joined = await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } });
      expect(joined.status).toBe(200);
      expect(joined.json.joined).toBe(true);
    });
  });

  it("members and standings are for members only; any member sees the code", async () => {
    const owner = await player(1);
    const { code, league } = await created(owner);
    const outsider = await player(3);
    for (const path of ["members", "standings"]) {
      const res = await call(`/v1/leagues/${path}?league=${league.id}`, { method: "GET", friend: outsider.friend });
      expect(res.status).toBe(404);
    }
    const guest = await player(2);
    await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } });
    const members = await call(`/v1/leagues/members?league=${league.id}`, { method: "GET", friend: guest.friend });
    expect(members.status).toBe(200);
    expect(members.json.code).toBe(code);
    expect(Object.keys(members.json.members[0]).sort()).toEqual(["joinedAt", "memberId", "name", "role"]);
    expect((await call(`/v1/leagues/members?league=bad`, { method: "GET", friend: guest.friend })).status).toBe(400);
    expect((await call(`/v1/leagues/members?league=${league.id}&x=1`, { method: "GET", friend: guest.friend })).status).toBe(400);
  });

  it("a Friends name change shows in the member list", async () => {
    const owner = await player(1);
    const { league } = await created(owner);
    const res = await call("/v1/friends/code/name", { friend: owner.friend, body: { name: "Player Z" } });
    expect(res.status).toBe(200);
    const members = await call(`/v1/leagues/members?league=${league.id}`, { method: "GET", friend: owner.friend });
    expect(members.json.members[0].name).toBe("Player Z");
  });

  it("standings start empty and read finished results from the league's roster", async () => {
    const owner = await player(1);
    const { code, league } = await created(owner);
    const guest = await player(2);
    await call("/v1/leagues/join", { friend: guest.friend, body: { code, name: "Player K" } });
    const empty = await call(`/v1/leagues/standings?league=${league.id}`, { method: "GET", friend: owner.friend });
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ season: { starts: "2026-11-01", ends: "2027-03-31" }, rounds: 0, rows: [] });
    // Nothing posts rounds until PR 4; seed the roster table directly with made-up results.
    const state = rosters.get(`league:${league.id}`);
    const insert = state.db.prepare("INSERT INTO round_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("r1", "2026-11-07", 1, owner.ownerId, owner.ownerId, 1, 70, 18, 3);
    insert.run("r1", "2026-11-07", 1, guest.ownerId, guest.ownerId, 2, 74, 18, 1);
    insert.run("r2", "2026-11-14", 0, owner.ownerId, owner.ownerId, 2, 80, 18, 0);
    const res = await call(`/v1/leagues/standings?league=${league.id}`, { method: "GET", friend: guest.friend });
    expect(res.json.rounds).toBe(1);
    expect(res.json.rows).toEqual([
      { memberId: owner.ownerId, name: "Player A", rank: 1, tied: false, rounds: 1, avgNet: 70, skins: 3, points: 6 },
      { memberId: guest.ownerId, name: "Player K", rank: 2, tied: false, rounds: 1, avgNet: 74, skins: 1, points: 5 },
    ]);
  });

  it("unknown league routes and methods", async () => {
    expect((await call("/v1/leagues/reset", {})).status).toBe(404);
    expect((await call("/v1/leagues/members", { method: "POST", body: {} })).status).toBe(405);
  });
});

describe("league standings rules (mockup 5)", () => {
  const season = { starts: "2026-11-01", ends: "2027-03-31" };
  const solo = (id, place, net = null, holes = 18, skins = null) => ({ memberId: id, unit: id, place, net, holes, skins });

  it("6 for 1st down to 1; 6th and below get 1", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(pointsForPosition)).toEqual([6, 5, 4, 3, 2, 1, 1, 1]);
  });

  it("ties split the points of the places they cover", () => {
    const pts = roundPoints([solo("a", 1), solo("b", 3), solo("c", 3), solo("d", 4)]);
    expect(Object.fromEntries(pts)).toEqual({ a: 6, b: 4.5, c: 4.5, d: 3 });
    const tail = roundPoints([1, 2, 3, 4, 5, 6, 6].map((p, i) => solo(`p${i}`, p)));
    expect(tail.get("p5")).toBe(1);
    expect(tail.get("p6")).toBe(1);
    const twoForThird = roundPoints([solo("a", 1), solo("b", 2), solo("c", 3), solo("d", 3)]);
    expect(twoForThird.get("c")).toBe(3.5);
  });

  it("every player on a team gets that team's points", () => {
    const results = [
      { memberId: "a", unit: "t1", place: 1, net: null, holes: 18, skins: null },
      { memberId: "c", unit: "t1", place: 1, net: null, holes: 18, skins: null },
      { memberId: "b", unit: "t2", place: 2, net: null, holes: 18, skins: null },
      { memberId: "f", unit: "t2", place: 2, net: null, holes: 18, skins: null },
      { memberId: "d", unit: "t3", place: 3, net: null, holes: 18, skins: null },
    ];
    const table = leagueStandings({ season, rounds: [{ roundId: "r", playedOn: "2026-12-05", finished: true, results }] });
    expect(Object.fromEntries(table.rows.map((r) => [r.memberId, r.points]))).toEqual({ a: 6, c: 6, b: 5, f: 5, d: 4 });
  });

  it("counts only finished rounds inside the season dates", () => {
    const r = (roundId, playedOn, finished) => ({ roundId, playedOn, finished, results: [solo("a", 1, 72)] });
    const table = leagueStandings({
      season,
      rounds: [r("in", "2026-11-01", true), r("end", "2027-03-31", true), r("live", "2026-12-01", false), r("before", "2026-10-31", true), r("after", "2027-04-01", true)],
    });
    expect(table.rounds).toBe(2);
    expect(table.rows[0]).toMatchObject({ memberId: "a", rounds: 2, points: 12 });
  });

  it("avg net uses 18-hole rounds with a net score only; skins add up", () => {
    const table = leagueStandings({
      season,
      rounds: [
        { roundId: "1", playedOn: "2026-11-07", finished: true, results: [solo("a", 1, 71, 18, 2)] },
        { roundId: "2", playedOn: "2026-11-14", finished: true, results: [solo("a", 1, 72, 18, 1)] },
        { roundId: "3", playedOn: "2026-11-21", finished: true, results: [solo("a", 1, 35, 9, 4)] },
        { roundId: "4", playedOn: "2026-11-28", finished: true, results: [solo("a", 1, null, 18, null)] },
      ],
    });
    expect(table.rows[0]).toMatchObject({ rounds: 4, avgNet: 71.5, skins: 7, points: 24 });
  });

  it("equal points share a rank and are marked tied", () => {
    const table = leagueStandings({
      season,
      rounds: [
        { roundId: "1", playedOn: "2026-11-07", finished: true, results: [solo("c", 1, 70), solo("b", 2, 74), solo("f", 2, 73)] },
      ],
    });
    expect(table.rows.map((r) => [r.memberId, r.rank, r.tied, r.points])).toEqual([
      ["c", 1, false, 6],
      ["f", 2, true, 4.5],
      ["b", 2, true, 4.5],
    ]);
  });
});
