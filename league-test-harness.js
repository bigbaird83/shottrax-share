// Shared test helpers for the league round tests: the same real node:sqlite Durable Object fake
// as leagues.test.js (copied here so leagues.test.js stays exactly as it is). Made-up data only.
import { DatabaseSync } from "node:sqlite";
import entry, { FriendGuessLimiter, LeagueRoster } from "./entry.js";
import { EXPO_PUSH_URL } from "./friends.js";

export const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
export const SEASON = { seasonStarts: "2026-11-01", seasonEnds: "2027-03-31" };

export function sqliteState(name) {
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

export function namespace(Klass, states) {
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

export function key(n) {
  return `k${String(n).padStart(3, "0")}${"b".repeat(40)}`;
}

export function newLeague(extra = {}) {
  return {
    name: "Saturday Crew",
    yourName: "Player A",
    game: "strokePlay",
    scoring: "gross",
    carryOver: false,
    homeCourse: "Mock Pines GC",
    ...SEASON,
    ...extra,
  };
}

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4];
export const HOLES_18 = PARS.map((par, i) => ({ number: i + 1, par, strokeIndex: i + 1 }));
export const HOLES_FRONT = HOLES_18.slice(0, 9);

/** One isolated Worker world: KV, the league roster objects, the limiter, and captured pushes. */
export function leagueWorld() {
  const kv = new Map();
  const rosters = new Map();
  const limiters = new Map();
  const pushes = [];
  const world = {
    kv,
    rosters,
    limiters,
    pushes,
    pushFails: false,
    env: {
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
      FRIEND_GUESSES: namespace(FriendGuessLimiter, limiters),
      LEAGUES: namespace(LeagueRoster, rosters),
      EXPO_ACCESS_TOKEN: "test-expo-token",
    },
  };
  const realFetch = globalThis.fetch;
  world.install = () => {
    globalThis.fetch = async (url, init) => {
      if (String(url) === EXPO_PUSH_URL) {
        pushes.push({ headers: init.headers, messages: JSON.parse(init.body) });
        if (world.pushFails) throw new Error("push down");
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
  };
  world.uninstall = () => {
    globalThis.fetch = realFetch;
  };

  world.call = async (pathname, { method = "POST", body, friend, ip } = {}) => {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (ip) headers["CF-Connecting-IP"] = ip;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await entry.fetch(
      new Request(`${ORIGIN}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      world.env,
      { waitUntil() {} },
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };

  world.player = async (n) => {
    const friend = key(n);
    const res = await world.call("/v1/friends/code", { friend });
    if (res.status !== 200) throw new Error(`friend code ${res.status}`);
    return { friend, ownerId: res.json.ownerId, code: res.json.code };
  };

  /** A league owned by player 1 with `count` members in all (players 1..count), named Player A, B, … */
  world.league = async (count = 2, extra = {}) => {
    const people = [];
    const owner = await world.player(1);
    people.push(owner);
    const made = await world.call("/v1/leagues", { friend: owner.friend, body: newLeague(extra) });
    if (made.status !== 200) throw new Error(`create ${made.status} ${JSON.stringify(made.json)}`);
    for (let n = 2; n <= count; n += 1) {
      const p = await world.player(n);
      const join = await world.call("/v1/leagues/join", { friend: p.friend, body: { code: made.json.code, name: `Player ${String.fromCharCode(64 + n)}` } });
      if (join.status !== 200) throw new Error(`join ${join.status}`);
      people.push(p);
    }
    return { league: made.json.league, code: made.json.code, people };
  };

  world.roster = (leagueId) => world.rosters.get(`league:${leagueId}`);
  return world;
}

/** A W1 body for these members, every one in group 1, nobody host-entered. */
export function roundBody(leagueId, memberIds, extra = {}) {
  return {
    leagueId,
    course: "Mock Pines GC",
    playedOn: "2026-11-21",
    holes: HOLES_18,
    game: "strokePlay",
    scoring: "gross",
    carryOver: false,
    teamsMode: null,
    teams: null,
    players: memberIds.map((memberId) => ({ memberId, groupNo: 1, courseHandicap: null, hostEnters: false })),
    ...extra,
  };
}

/** Posts one score per hole for one player, each at rev 1. */
export async function scoreAll(world, friend, roundId, memberId, strokesByHole) {
  const out = [];
  for (const [hole, strokes] of Object.entries(strokesByHole)) {
    out.push(await world.call("/v1/leagues/rounds/score", { friend, body: { roundId, memberId, hole: Number(hole), strokes, rev: 1 } }));
  }
  return out;
}

/** { 1: s0, 2: s1, … } from an array of strokes for holes `holes`. */
export function byHole(holes, strokes) {
  return Object.fromEntries(holes.map((h, i) => [h.number, strokes[i]]).filter(([, s]) => s !== undefined));
}
