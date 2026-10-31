import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry, { FriendGuessLimiter } from "./entry.js";
import { limiterNameForFriendKey } from "./friends.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const OWNER_RE = /^[A-Za-z0-9_-]{22}$/;
const KEY_LIMIT = 8;
const IP_LIMIT = 24;
const WINDOW_MS = 60 * 60 * 1000;
const DISPLAY_NAME = "Casey Pines";
const INSTALL_ID = "id_1790517745797_pfjtwbfa";

function friendKey(suffix) {
  return `${suffix}${"a".repeat(32)}`.slice(0, 43);
}

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
        return {
          toArray() {
            return rows;
          },
          one() {
            if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
            return rows[0];
          },
        };
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
    blockConcurrencyWhile(fn) {
      ready = ready.then(() => fn());
      return ready;
    },
  };
}

function createLimiterNamespace() {
  const objects = new Map();
  return {
    idFromName(name) {
      if (typeof name !== "string" || name.length === 0 || name.length > 512) throw new Error("bad durable object name");
      return { name };
    },
    get(id) {
      const name = id && id.name;
      let obj = objects.get(name);
      if (!obj) {
        obj = new FriendGuessLimiter(sqliteState(name), {});
        objects.set(name, obj);
      }
      // A real stub accepts fetch(input, init) and delivers one Request to the class.
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return obj.fetch(request);
        },
      };
    },
  };
}


// Made-up people only. Names below are invented for these tests.
const INVITE_NAME = "Alex M.";

describe("scramble info on live and shared rounds", () => {
  let kv;
  let env;

  beforeEach(() => {
    kv = new Map();
    env = {
      BOARDS: {
        async get(key) {
          const row = kv.get(key);
          return row ? row.value : null;
        },
        async put(key, value, options) {
          kv.set(key, { value, expirationTtl: options && Number.isFinite(options.expirationTtl) ? options.expirationTtl : undefined });
        },
        async delete(key) {
          kv.delete(key);
        },
        async list(options = {}) {
          const prefix = typeof options.prefix === "string" ? options.prefix : "";
          const names = [...kv.keys()].filter((name) => name.startsWith(prefix)).sort();
          return { keys: names.map((name) => ({ name })), list_complete: true };
        },
      },
      FRIEND_GUESSES: createLimiterNamespace(),
    };
  });

  afterEach(() => {
    kv = new Map();
  });

  const bodies = [];
  async function invoke(pathname, { method = "POST", body, friend } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await entry.fetch(new Request(`${ORIGIN}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env, { waitUntil() {} });
    const text = await response.text();
    bodies.push(text);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, text, json };
  }

  async function mint(suffix) {
    const key = friendKey(suffix);
    const created = await invoke("/v1/friends/code", { friend: key, body: {} });
    expect(created.status).toBe(200);
    return { key, code: created.json.code, ownerId: created.json.ownerId };
  }

  async function befriend(from, to) {
    const sent = await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code } });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    const accepted = await invoke("/v1/friends/requests/accept", { friend: to.key, body: { ownerId: from.ownerId } });
    expect(accepted.json).toEqual({ status: "friends", ownerId: from.ownerId });
  }

  function round(id, playedOn, extra = {}) {
    return {
      id,
      courseName: "Pine Hollow",
      playedOn,
      gross: 84,
      toPar: 12,
      holes: [
        { hole: 1, score: 5, par: 4, fir: true, gir: false, putts: 2 },
        { hole: 2, score: 4, par: 3 },
      ],
      ...extra,
    };
  }

  function pastRounds(count, prefix = "past") {
    return Array.from({ length: count }, (_, i) => round(`${prefix}_${i}`, `2025-0${1 + (i % 9)}-1${i % 10}`));
  }

  async function fetchIds(who) {
    const res = await invoke("/v1/friends/rounds", { method: "GET", friend: who.key });
    expect(res.status).toBe(200);
    return res.json.rounds.map((row) => row.id).sort();
  }

  async function setPast(who, friend, choice, rounds) {
    return invoke("/v1/friends/past", { method: "PUT", friend: who.key, body: { ownerId: friend.ownerId, choice, rounds } });
  }


  // Made-up course and scores only.
  const LIVE = {
    courseName: "Pine Hollow GC",
    hole: 3,
    holes: [
      { hole: 1, score: 5, par: 4 },
      { hole: 2, score: 3, par: 3, putts: 1, fir: true, gir: true },
    ],
  };
  const putLive = (who, body = LIVE) => invoke("/v1/friends/live", { method: "PUT", friend: who.key, body });
  const getLive = (who) => invoke("/v1/friends/live", { method: "GET", friend: who.key });
  const stop = (who) => invoke("/v1/friends/live/stop", { friend: who.key, body: {} });

  afterEach(() => vi.useRealTimers());
  // Made-up teams only: invented friend codes from the code alphabet, invented names and notes.
  const TEAM = { size: 3, codes: ["MKPQRS23"], guests: 1 };
  const SNEAKY = ["Chris P.", "Charity scramble. Best ball off every tee."];
  const shareRound = (who, round) => invoke("/v1/friends/rounds", { method: "PUT", friend: who.key, body: { share: true, round } });
  const BAD = [
    ["names", { ...TEAM, names: ["Chris P."] }],
    ["notes", { ...TEAM, notes: "Charity scramble." }],
    ["size 1", { size: 1, codes: [], guests: 0 }],
    ["size 5", { size: 5, codes: [], guests: 1 }],
    ["string size", { size: "3", codes: [], guests: 1 }],
    ["fractional guests", { size: 3, codes: [], guests: 1.5 }],
    ["negative guests", { size: 3, codes: [], guests: -1 }],
    ["string guests", { size: 3, codes: [], guests: "1" }],
    ["too many people", { size: 2, codes: ["MKPQRS23"], guests: 1 }],
    ["too many codes", { size: 2, codes: ["MKPQRS23", "TVWXYZ45"], guests: 0 }],
    ["repeat code", { size: 4, codes: ["MKPQRS23", "MKPQRS23"], guests: 0 }],
    ["name in codes", { size: 3, codes: ["Chris P."], guests: 0 }],
    ["lowercase code", { size: 3, codes: ["mkpqrs23"], guests: 0 }],
    ["number code", { size: 3, codes: [12345678], guests: 0 }],
    ["codes not a list", { size: 3, codes: "MKPQRS23", guests: 0 }],
    ["missing guests", { size: 3, codes: [] }],
    ["null", null],
    ["array", [3]],
    ["string", "Scramble · 3"],
  ];

  it("live: a clean scramble is stored and served to friends as size, codes and guests only", async () => {
    const golfer = await mint("scr-live");
    const pal = await mint("scr-live-pal");
    await befriend(pal, golfer);
    expect((await putLive(golfer, { ...LIVE, scramble: TEAM })).json).toEqual({ ok: true });
    const row = JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value);
    expect(row.scramble).toEqual(TEAM);
    const seen = await getLive(pal);
    expect(seen.json.live[0].scramble).toEqual(TEAM);
    expect(seen.json.live[0].holes).toEqual(LIVE.holes);
  });

  it("live: a solo update (no scramble) works as before and serves no scramble", async () => {
    const golfer = await mint("scr-solo");
    const pal = await mint("scr-solo-pal");
    await befriend(pal, golfer);
    expect((await putLive(golfer)).json).toEqual({ ok: true });
    const seen = (await getLive(pal)).json.live[0];
    expect(Object.hasOwn(seen, "scramble")).toBe(false);
    // The next solo update replaces an earlier scramble row.
    await putLive(golfer, { ...LIVE, scramble: { size: 2, codes: [], guests: 1 } });
    await putLive(golfer);
    expect(Object.hasOwn((await getLive(pal)).json.live[0], "scramble")).toBe(false);
  });

  for (const [name, scramble] of BAD) {
    it(`live: refuses scramble with ${name} and stores nothing`, async () => {
      const golfer = await mint(`scr-bad-${name.replace(/\W/g, "")}`);
      const res = await putLive(golfer, { ...LIVE, scramble });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
      expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    });

    it(`shared round: refuses scramble with ${name}`, async () => {
      const golfer = await mint(`scr-pub-${name.replace(/\W/g, "")}`);
      const res = await shareRound(golfer, round("r_mock_bad", "2026-10-30", { scramble }));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
      expect(kv.has(`fr:rounds:${golfer.ownerId}`)).toBe(false);
    });
  }

  it("live: size bounds and a full team are accepted", async () => {
    const golfer = await mint("scr-sizes");
    for (const scramble of [
      { size: 2, codes: [], guests: 0 },
      { size: 2, codes: ["MKPQRS23"], guests: 0 },
      { size: 4, codes: ["MKPQRS23", "TVWXYZ45"], guests: 1 },
      { size: 4, codes: [], guests: 3 },
    ]) {
      expect((await putLive(golfer, { ...LIVE, scramble })).json).toEqual({ ok: true });
      expect(JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value).scramble).toEqual(scramble);
    }
  });

  it("live: a stored row with a bad scramble serves the round without it", async () => {
    const golfer = await mint("scr-stale");
    const pal = await mint("scr-stale-pal");
    await befriend(pal, golfer);
    await putLive(golfer);
    const key = `fr:live:${golfer.ownerId}`;
    const row = JSON.parse(kv.get(key).value);
    kv.set(key, { value: JSON.stringify({ ...row, scramble: { size: 9, codes: [], guests: 1, names: SNEAKY } }) });
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.courseName).toBe(LIVE.courseName);
    expect(Object.hasOwn(seen, "scramble")).toBe(false);
    for (const secret of SNEAKY) expect(JSON.stringify(seen).includes(secret)).toBe(false);
  });

  it("live: finished still deletes the row when scramble rides along", async () => {
    const golfer = await mint("scr-fin");
    await putLive(golfer, { ...LIVE, scramble: TEAM });
    expect((await putLive(golfer, { finished: true, scramble: TEAM })).json).toEqual({ ok: true });
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
  });

  it("shared round: scramble is stored and served to friends; rounds without it are unchanged", async () => {
    const golfer = await mint("scr-pub");
    const pal = await mint("scr-pub-pal");
    await befriend(pal, golfer);
    expect((await shareRound(golfer, round("r_mock_scr", "2026-10-30", { scramble: TEAM }))).status).toBe(200);
    expect((await shareRound(golfer, round("r_mock_solo", "2026-10-29"))).status).toBe(200);
    const res = await invoke("/v1/friends/rounds", { method: "GET", friend: pal.key });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.json.rounds.map((r) => [r.id, r]));
    expect(byId.r_mock_scr.scramble).toEqual(TEAM);
    expect(Object.hasOwn(byId.r_mock_solo, "scramble")).toBe(false);
  });

  it("past rounds: scramble passes the same allowlist", async () => {
    const golfer = await mint("scr-past");
    const pal = await mint("scr-past-pal");
    await befriend(pal, golfer);
    expect((await setPast(golfer, pal, "10", [round("p_mock_scr", "2025-06-01", { scramble: TEAM })])).status).toBe(200);
    expect((await setPast(golfer, pal, "10", [round("p_mock_bad", "2025-06-02", { scramble: { ...TEAM, notes: SNEAKY[1] } })])).status).toBe(400);
    const res = await invoke("/v1/friends/rounds", { method: "GET", friend: pal.key });
    expect(res.json.rounds.find((r) => r.id === "p_mock_scr").scramble).toEqual(TEAM);
  });
});
