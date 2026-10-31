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
  const limiterStub = async (who) => env.FRIEND_GUESSES.get(env.FRIEND_GUESSES.idFromName(await limiterNameForFriendKey(who.key)));
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

  // Golfer, follower pal, and teammate mate are friends with each other; outsider is no one's friend.
  async function crew(tag) {
    const golfer = await mint(`${tag}-golfer`);
    const pal = await mint(`${tag}-pal`);
    const mate = await mint(`${tag}-mate`);
    const outsider = await mint(`${tag}-out`);
    await befriend(pal, golfer);
    await befriend(mate, golfer);
    return { golfer, pal, mate, outsider };
  }

  function expectNoCodes(text, people) {
    for (const who of people) expect(text.includes(who.code)).toBe(false);
  }

  it("live: codes become friends' ownerIds on the server; followers never see a code", async () => {
    const { golfer, pal, mate, outsider } = await crew("scr-live");
    const team = { size: 4, codes: [mate.code, outsider.code], guests: 1 };
    expect((await putLive(golfer, { ...LIVE, scramble: team })).json).toEqual({ ok: true });
    const stored = kv.get(`fr:live:${golfer.ownerId}`).value;
    expect(JSON.parse(stored).scramble).toEqual({ size: 4, ownerIds: [mate.ownerId], guests: 2 });
    expectNoCodes(stored, [mate, outsider, golfer, pal]);
    const seen = await getLive(pal);
    expect(seen.json.live[0].scramble).toEqual({ size: 4, ownerIds: [mate.ownerId], guests: 2 });
    expectNoCodes(seen.text, [mate, outsider, golfer, pal]);
  });

  it("live: non-friend, unknown, reset, own and blocked codes all count as guests", async () => {
    const { golfer, pal, mate, outsider } = await crew("scr-guest");
    const old = mate.code;
    const reset = await invoke("/v1/friends/code/reset", { friend: mate.key, body: {} });
    expect(reset.status).toBe(200);
    const blocked = await mint("scr-guest-blk");
    await befriend(blocked, golfer);
    expect((await invoke("/v1/friends/block", { friend: blocked.key, body: { ownerId: golfer.ownerId } })).status).toBe(200);
    for (const codes of [[outsider.code], ["ZZZZ2345"], [old], [golfer.code], [blocked.code]]) {
      expect((await putLive(golfer, { ...LIVE, scramble: { size: 2, codes, guests: 0 } })).json).toEqual({ ok: true });
      const seen = await getLive(pal);
      expect(seen.json.live[0].scramble).toEqual({ size: 2, ownerIds: [], guests: 1 });
      expect(seen.text.includes(codes[0])).toBe(false);
    }
  });

  it("live: a one-sided friend edge is not enough to name a teammate", async () => {
    const { golfer, pal, mate } = await crew("scr-edge");
    expect(kv.delete(`fr:friend:${mate.ownerId}:${golfer.ownerId}`)).toBe(true);
    await putLive(golfer, { ...LIVE, scramble: { size: 2, codes: [mate.code], guests: 0 } });
    expect((await getLive(pal)).json.live[0].scramble).toEqual({ size: 2, ownerIds: [], guests: 1 });
  });

  it("live: a solo update (no scramble) works as before and serves no scramble", async () => {
    const { golfer, pal } = await crew("scr-solo");
    expect((await putLive(golfer)).json).toEqual({ ok: true });
    const seen = (await getLive(pal)).json.live[0];
    expect(Object.hasOwn(seen, "scramble")).toBe(false);
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
      const stored = JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value).scramble;
      expect(stored).toEqual({ size: scramble.size, ownerIds: [], guests: scramble.codes.length + scramble.guests });
    }
  });

  it("live: a stored row with a bad scramble serves the round without it", async () => {
    const golfer = await mint("scr-stale");
    const pal = await mint("scr-stale-pal");
    await befriend(pal, golfer);
    await putLive(golfer);
    const key = `fr:live:${golfer.ownerId}`;
    const row = JSON.parse(kv.get(key).value);
    kv.set(key, { value: JSON.stringify({ ...row, scramble: { size: 3, codes: ["MKPQRS23"], guests: 1, names: SNEAKY } }) });
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

  it("shared round: codes become friends' ownerIds; no code in any follower response", async () => {
    const { golfer, pal, mate, outsider } = await crew("scr-pub");
    const team = { size: 4, codes: [mate.code, outsider.code], guests: 0 };
    expect((await shareRound(golfer, round("r_mock_scr", "2026-10-30", { scramble: team }))).status).toBe(200);
    expect((await shareRound(golfer, round("r_mock_solo", "2026-10-29"))).status).toBe(200);
    const stored = kv.get(`fr:rounds:${golfer.ownerId}`).value;
    expectNoCodes(stored, [mate, outsider]);
    for (const viewer of [pal, mate, golfer]) {
      const res = await invoke("/v1/friends/rounds", { method: "GET", friend: viewer.key });
      expect(res.status).toBe(200);
      expectNoCodes(res.text, [mate, outsider, golfer, pal]);
      const byId = Object.fromEntries(res.json.rounds.map((r) => [r.id, r]));
      expect(byId.r_mock_scr.scramble).toEqual({ size: 4, ownerIds: [mate.ownerId], guests: 1 });
      expect(Object.hasOwn(byId.r_mock_solo, "scramble")).toBe(false);
    }
  });

  it("shared round: a stored round with a bad scramble is served without it", async () => {
    const { golfer, pal } = await crew("scr-pub-bad");
    expect((await shareRound(golfer, round("r_mock_x", "2026-10-30", { scramble: { size: 2, codes: [], guests: 1 } }))).status).toBe(200);
    const key = `fr:rounds:${golfer.ownerId}`;
    const rows = JSON.parse(kv.get(key).value);
    rows[0].scramble = { size: 2, codes: ["MKPQRS23"], guests: 0 };
    kv.set(key, { value: JSON.stringify(rows) });
    const res = await invoke("/v1/friends/rounds", { method: "GET", friend: pal.key });
    expect(res.json.rounds[0].id).toBe("r_mock_x");
    expect(Object.hasOwn(res.json.rounds[0], "scramble")).toBe(false);
    expect(res.text.includes("MKPQRS23")).toBe(false);
  });

  it("past rounds: codes resolve the same way and are never served", async () => {
    const { golfer, pal, mate, outsider } = await crew("scr-past");
    const team = { size: 3, codes: [mate.code, outsider.code], guests: 0 };
    expect((await setPast(golfer, pal, "10", [round("p_mock_scr", "2025-06-01", { scramble: team })])).status).toBe(200);
    expect((await setPast(golfer, pal, "10", [round("p_mock_bad", "2025-06-02", { scramble: { ...TEAM, notes: SNEAKY[1] } })])).status).toBe(400);
    const res = await invoke("/v1/friends/rounds", { method: "GET", friend: pal.key });
    expect(res.json.rounds.find((r) => r.id === "p_mock_scr").scramble).toEqual({ size: 3, ownerIds: [mate.ownerId], guests: 1 });
    expectNoCodes(res.text, [mate, outsider, golfer, pal]);
  });
  // Made-up codes from the code alphabet; none of them exist.
  const FAKE = ["MKPQRS23", "TVWXYZ45", "HJKLMN67", "ABCDEF89", "GHJKLM23", "NPQRST45", "UVWXYZ67", "BCDFGH89", "JKLMNP23"];
  const lookup = (who, code) => invoke("/v1/friends/codes/lookup", { friend: who.key, body: { code } });

  it("limiter: each scramble code takes a slot on the friend-code guess limiter", async () => {
    const golfer = await mint("scr-lim");
    // 3 codes on a live update + 3 on a shared round = 6 of the 8 per-key slots.
    const live = await putLive(golfer, { ...LIVE, scramble: { size: 4, codes: FAKE.slice(0, 3), guests: 0 } });
    expect(live.json).toEqual({ ok: true });
    const shared = await shareRound(golfer, round("r_mock_lim", "2026-10-30", { scramble: { size: 4, codes: FAKE.slice(3, 6), guests: 0 } }));
    expect(shared.status).toBe(200);
    expect((await lookup(golfer, FAKE[6])).status).toBe(404);
    expect((await lookup(golfer, FAKE[7])).status).toBe(404);
    // Spent: a plain lookup and a scramble with codes are both refused, and nothing new is stored.
    expect((await lookup(golfer, FAKE[8])).status).toBe(429);
    // Spent: the round is still stored, its code counted as a guest, with no lookup and no hash.
    const over = await shareRound(golfer, round("r_mock_over", "2026-10-31", { scramble: { size: 2, codes: [FAKE[8]], guests: 0 } }));
    expect(over.status).toBe(200);
    const rows = JSON.parse(kv.get(`fr:rounds:${golfer.ownerId}`).value);
    expect(rows.map((r) => r.id)).toEqual(["r_mock_lim", "r_mock_over"]);
    expect(rows[1].scramble).toEqual({ size: 2, ownerIds: [], guests: 1 });
    expect(Object.hasOwn(rows[1], "scrambleHash")).toBe(false);
    // A scramble with no codes, and a solo round, never touch the limiter.
    expect((await shareRound(golfer, round("r_mock_guests", "2026-10-31", { scramble: { size: 3, codes: [], guests: 2 } }))).status).toBe(200);
  });

  it("limiter: the same live team is charged once, not on every hole", async () => {
    const golfer = await mint("scr-lim-live");
    const pal = await mint("scr-lim-live-pal");
    await befriend(pal, golfer);
    const team = { size: 3, codes: FAKE.slice(0, 2), guests: 0 };
    for (let hole = 1; hole <= 6; hole += 1) {
      expect((await putLive(golfer, { ...LIVE, hole: 3, scramble: { ...team, codes: [...team.codes].reverse() } })).json).toEqual({ ok: true });
    }
    // 2 used; a new team charges again.
    expect((await putLive(golfer, { ...LIVE, scramble: { size: 4, codes: FAKE.slice(2, 5), guests: 0 } })).json).toEqual({ ok: true });
    for (const code of FAKE.slice(5, 8)) expect((await lookup(golfer, code)).status).toBe(404);
    expect((await lookup(golfer, FAKE[8])).status).toBe(429);
    // The private hash is never served.
    const seen = await getLive(pal);
    expect(Object.hasOwn(seen.json.live[0], "scrambleCodesHash")).toBe(false);
    for (const code of FAKE) expect(seen.text.includes(code)).toBe(false);
  });

  it("limiter: a missing guess limiter still stores and serves the live update, team as guests, no lookups", async () => {
    const { golfer, pal, mate } = await crew("scr-lim-none");
    const limiter = env.FRIEND_GUESSES;
    delete env.FRIEND_GUESSES;
    const reads = [];
    const get = env.BOARDS.get;
    env.BOARDS.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    const res = await putLive(golfer, { ...LIVE, scramble: { size: 3, codes: [mate.code], guests: 1 } });
    expect(res.json).toEqual({ ok: true });
    expect(reads.some((key) => key.startsWith("fr:code:"))).toBe(false);
    env.BOARDS.get = get;
    const row = JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value);
    expect(row.holes).toEqual(LIVE.holes);
    expect(row.scramble).toEqual({ size: 3, ownerIds: [], guests: 2 });
    expect(Object.hasOwn(row, "scrambleCodesHash")).toBe(false);
    env.FRIEND_GUESSES = limiter;
    const seen = await getLive(pal);
    expect(seen.json.live[0].holes).toEqual(LIVE.holes);
    expect(seen.json.live[0].scramble).toEqual({ size: 3, ownerIds: [], guests: 2 });
    // Limiter back: the next update recovers and resolves the friend.
    expect((await putLive(golfer, { ...LIVE, hole: 4, scramble: { size: 3, codes: [mate.code], guests: 1 } })).json).toEqual({ ok: true });
    expect((await getLive(pal)).json.live[0].scramble).toEqual({ size: 3, ownerIds: [mate.ownerId], guests: 1 });
  });

  it("limiter: an over-limit live update still stores and serves scores, team as guests, then recovers", async () => {
    const { golfer, pal, mate } = await crew("scr-lim-over");
    for (const code of FAKE.slice(0, KEY_LIMIT)) expect((await lookup(golfer, code)).status).toBe(404);
    const reads = [];
    const get = env.BOARDS.get;
    env.BOARDS.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    const res = await putLive(golfer, { ...LIVE, scramble: { size: 3, codes: [mate.code], guests: 0 } });
    env.BOARDS.get = get;
    expect(res.json).toEqual({ ok: true });
    expect(reads.some((key) => key.startsWith("fr:code:"))).toBe(false);
    const seen = await getLive(pal);
    expect(seen.json.live[0].holes).toEqual(LIVE.holes);
    expect(seen.json.live[0].scramble).toEqual({ size: 3, ownerIds: [], guests: 1 });
    expect(Object.hasOwn(JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value), "scrambleCodesHash")).toBe(false);
    expectNoCodes(seen.text, [mate, golfer, pal]);
    // A new window: the same team is charged and resolved on the next update.
    await (await limiterStub(golfer)).fetch("https://friend-guess.internal/limit", { method: "POST", body: JSON.stringify({ op: "reset" }) });
    expect((await putLive(golfer, { ...LIVE, hole: 4, scramble: { size: 3, codes: [mate.code], guests: 0 } })).json).toEqual({ ok: true });
    expect((await getLive(pal)).json.live[0].scramble).toEqual({ size: 3, ownerIds: [mate.ownerId], guests: 0 });
  });

  it("limiter: a reservation that does not fit spends no slots", async () => {
    const golfer = await mint("scr-lim-part");
    // 6 of 8 used; a 3-code team does not fit, and the 2 left stay free.
    for (const code of FAKE.slice(0, 6)) expect((await lookup(golfer, code)).status).toBe(404);
    expect((await putLive(golfer, { ...LIVE, scramble: { size: 4, codes: FAKE.slice(6, 9), guests: 0 } })).json).toEqual({ ok: true });
    expect((await lookup(golfer, FAKE[6])).status).toBe(404);
    expect((await lookup(golfer, FAKE[7])).status).toBe(404);
    expect((await lookup(golfer, FAKE[8])).status).toBe(429);
  });

  it("limiter: an IP refusal gives the key slots back", async () => {
    const golfer = await mint("scr-lim-ip");
    const ip = "198.51.100.7";
    const withIp = (body) =>
      entry.fetch(new Request(`${ORIGIN}/v1/friends/live`, {
        method: "PUT",
        headers: { "X-Friend-Key": golfer.key, "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify(body),
      }), env, { waitUntil() {} });
    // Fill the IP counter from other keys so 2 IP slots are left.
    let filled = 0;
    for (let k = 0; filled < IP_LIMIT - 2; k += 1) {
      const other = await mint(`scr-lim-ip-o${k}`);
      for (let i = 0; i < KEY_LIMIT - 1 && filled < IP_LIMIT - 2; i += 1, filled += 1) {
        const r = await entry.fetch(new Request(`${ORIGIN}/v1/friends/codes/lookup`, {
          method: "POST",
          headers: { "X-Friend-Key": other.key, "Content-Type": "application/json", "CF-Connecting-IP": ip },
          body: JSON.stringify({ code: FAKE[i] }),
        }), env, { waitUntil() {} });
        expect(r.status).toBe(404);
      }
    }
    expect((await withIp({ ...LIVE, scramble: { size: 4, codes: FAKE.slice(0, 3), guests: 0 } })).status).toBe(200);
    // Fill the last 2 IP slots from another key; a 1-code team is then refused on IP and refunded too.
    const last = await mint("scr-lim-ip-last");
    for (const code of FAKE.slice(0, 2)) {
      const r = await entry.fetch(new Request(`${ORIGIN}/v1/friends/codes/lookup`, {
        method: "POST",
        headers: { "X-Friend-Key": last.key, "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ code }),
      }), env, { waitUntil() {} });
      expect(r.status).toBe(404);
    }
    expect((await withIp({ ...LIVE, scramble: { size: 2, codes: [FAKE[3]], guests: 0 } })).status).toBe(200);
    // The key spent nothing: all 8 key slots are still there (no IP header on these).
    for (const code of FAKE.slice(0, KEY_LIMIT)) expect((await lookup(golfer, code)).status).toBe(404);
    expect((await lookup(golfer, FAKE[8])).status).toBe(429);
  });

  it("limiter: resharing an unchanged team spends no slots (shared and past rounds)", async () => {
    const { golfer, pal, mate } = await crew("scr-lim-reshare");
    const team = { size: 4, codes: [mate.code, FAKE[0], FAKE[1]], guests: 0 };
    for (let i = 0; i < 4; i += 1) {
      expect((await shareRound(golfer, round("r_mock_same", "2026-10-30", { scramble: { ...team, codes: [...team.codes].reverse() } }))).status).toBe(200);
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await setPast(golfer, pal, "10", [round("p_mock_same", "2025-06-01", { scramble: { size: 3, codes: [FAKE[2]], guests: 0 } })])).status).toBe(200);
    }
    // 3 + 1 used of 8.
    for (const code of FAKE.slice(3, 7)) expect((await lookup(golfer, code)).status).toBe(404);
    expect((await lookup(golfer, FAKE[7])).status).toBe(429);
    const res = await invoke("/v1/friends/rounds", { method: "GET", friend: pal.key });
    const byId = Object.fromEntries(res.json.rounds.map((r) => [r.id, r]));
    expect(byId.r_mock_same.scramble).toEqual({ size: 4, ownerIds: [mate.ownerId], guests: 2 });
    expect(Object.hasOwn(byId.r_mock_same, "scrambleHash")).toBe(false);
    expect(Object.hasOwn(byId.p_mock_same, "scrambleHash")).toBe(false);
    expect(res.text.includes("scrambleHash")).toBe(false);
  });
});
