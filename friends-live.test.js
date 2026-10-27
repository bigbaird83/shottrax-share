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

describe("live rounds for friends", () => {
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

  it("friends see the live row; non-friends, pending and the owner do not", async () => {
    const golfer = await mint("live-golfer");
    const pal = await mint("live-pal");
    const stranger = await mint("live-stranger");
    const pending = await mint("live-pending");
    await befriend(pal, golfer);
    const asked = await invoke("/v1/friends/requests", { friend: pending.key, body: { code: golfer.code } });
    expect(asked.status).toBe(200);
    expect((await putLive(golfer)).json).toEqual({ ok: true });
    const seen = await getLive(pal);
    expect(seen.status).toBe(200);
    expect(seen.json.live).toHaveLength(1);
    expect(seen.json.live[0]).toMatchObject({ ownerId: golfer.ownerId, courseName: "Pine Hollow GC", hole: 3, toPar: 1 });
    expect(seen.json.live[0].holes).toEqual(LIVE.holes);
    expect((await getLive(stranger)).json).toEqual({ live: [] });
    expect((await getLive(pending)).json).toEqual({ live: [] });
    expect((await getLive(golfer)).json).toEqual({ live: [] });
  });

  it("switch off / stop deletes the row, so friends no longer see it", async () => {
    const golfer = await mint("live-off");
    const pal = await mint("live-off-pal");
    await befriend(pal, golfer);
    await putLive(golfer);
    expect((await getLive(pal)).json.live).toHaveLength(1);
    expect((await stop(golfer)).json).toEqual({ ok: true });
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    expect((await getLive(pal)).json).toEqual({ live: [] });
  });

  it("carries no GPS: position fields are refused and never stored or returned", async () => {
    const golfer = await mint("live-gps");
    const pal = await mint("live-gps-pal");
    await befriend(pal, golfer);
    for (const bad of [
      { ...LIVE, lat: 34.7, lng: -92.3 },
      { ...LIVE, position: { lat: 1, lng: 2 } },
      { ...LIVE, holes: [{ hole: 1, score: 5, par: 4, lat: 34.7, lng: -92.3 }] },
      { ...LIVE, holes: [{ hole: 1, score: 5, par: 4, tee: { lat: 1, lng: 2 } }] },
    ]) {
      expect((await putLive(golfer, bad)).status).toBe(400);
    }
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    await putLive(golfer);
    const text = (await getLive(pal)).text;
    expect(text).not.toMatch(/lat|lng|latitude|longitude|position|gps/i);
    expect(kv.get(`fr:live:${golfer.ownerId}`).value).not.toMatch(/lat|lng|gps/i);
  });

  it("enforces the 30-minute expiry from the last update", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T16:00:00Z"));
    const golfer = await mint("live-exp");
    const pal = await mint("live-exp-pal");
    await befriend(pal, golfer);
    await putLive(golfer);
    expect(kv.get(`fr:live:${golfer.ownerId}`).expirationTtl).toBe(1800);
    vi.setSystemTime(new Date("2026-10-21T16:29:59Z"));
    expect((await getLive(pal)).json.live).toHaveLength(1);
    await putLive(golfer, { ...LIVE, hole: 4 });
    vi.setSystemTime(new Date("2026-10-21T16:59:00Z"));
    expect((await getLive(pal)).json.live[0].hole).toBe(4);
    vi.setSystemTime(new Date("2026-10-21T17:00:01Z"));
    expect((await getLive(pal)).json).toEqual({ live: [] });
  });

  it("a removed or blocked friend stops seeing it", async () => {
    const golfer = await mint("live-rm");
    const pal = await mint("live-rm-pal");
    await befriend(pal, golfer);
    await putLive(golfer);
    expect((await getLive(pal)).json.live).toHaveLength(1);
    const removed = await invoke("/v1/friends/remove", { friend: golfer.key, body: { ownerId: pal.ownerId } });
    expect(removed.status).toBe(200);
    expect((await getLive(pal)).json).toEqual({ live: [] });
  });

  it("a blocked friend stops seeing it, whichever side blocks", async () => {
    for (const side of ["golfer", "pal"]) {
      const golfer = await mint(`live-blk-${side}`);
      const pal = await mint(`live-blk-${side}-pal`);
      await befriend(pal, golfer);
      await putLive(golfer);
      expect((await getLive(pal)).json.live).toHaveLength(1);
      const [blocker, other] = side === "golfer" ? [golfer, pal] : [pal, golfer];
      const blocked = await invoke("/v1/friends/block", { friend: blocker.key, body: { ownerId: other.ownerId } });
      expect(blocked.status).toBe(200);
      expect((await getLive(pal)).json).toEqual({ live: [] });
    }
  });

  it("a block row alone hides the live row, even if friend edges were left behind", async () => {
    for (const side of ["golfer", "pal"]) {
      const golfer = await mint(`live-blkrow-${side}`);
      const pal = await mint(`live-blkrow-${side}-pal`);
      await befriend(pal, golfer);
      await putLive(golfer);
      expect((await getLive(pal)).json.live).toHaveLength(1);
      const [blocker, other] = side === "golfer" ? [golfer, pal] : [pal, golfer];
      // Simulates a partial write: the block is stored but the friend edges are still there.
      kv.set(`fr:block:${blocker.ownerId}:${other.ownerId}`, { value: "1" });
      expect((await getLive(pal)).json).toEqual({ live: [] });
    }
  });

  it("a one-sided friend edge is not enough: the golfer's edge back to the caller is required", async () => {
    const golfer = await mint("live-one");
    const pal = await mint("live-one-pal");
    await befriend(pal, golfer);
    await putLive(golfer);
    expect((await getLive(pal)).json.live).toHaveLength(1);
    // The pal's friend list still names the golfer, but the golfer's edge back is gone.
    expect(kv.delete(`fr:friend:${golfer.ownerId}:${pal.ownerId}`)).toBe(true);
    expect((await getLive(pal)).json).toEqual({ live: [] });
  });

  it("validates the body and needs a friend key", async () => {
    const golfer = await mint("live-val");
    expect((await invoke("/v1/friends/live", { method: "PUT", body: LIVE })).status).toBe(401);
    expect((await invoke("/v1/friends/live", { method: "GET" })).status).toBe(401);
    expect((await putLive(golfer, { ...LIVE, hole: 19 })).status).toBe(400);
    expect((await putLive(golfer, { ...LIVE, holes: [{ hole: 1, score: 5, par: 4 }, { hole: 1, score: 4, par: 4 }] })).status).toBe(400);
    expect((await putLive(golfer, { ...LIVE, courseName: "" })).status).toBe(400);
    expect((await putLive(golfer, { ...LIVE, holes: [] })).status).toBe(200);
  });

  // Made-up clubs and yards only (Brian OK 2026-10-22 9:26 AM CT).
  // Coordinates are made up (not a real course).
  const SHOTS = [
    { n: 1, club: "Dr", yd: 248, s: [10.12345, 20.12345], e: [10.12545, 20.12445], res: "fairway" },
    { n: 2, club: "7i", yd: 162, s: [10.12545, 20.12445], e: [10.12671, 20.12512] },
    { n: 3, club: "PW", res: "green" },
    { n: 4, club: "Putt", res: "missed" },
    { n: 5, club: "Putt", res: "holed" },
  ];
  const WITH_SHOTS = {
    courseName: "Mock Pines GC",
    hole: 2,
    holes: [{ hole: 1, score: 5, par: 4, clubs: ["Dr", "7i", "PW"], shots: SHOTS }],
    shots: [{ n: 1, club: "3w", yd: 220 }],
  };

  it("live shots: stored only in the live: row with its TTL and returned only to accepted friends", async () => {
    const golfer = await mint("shot-golfer");
    const pal = await mint("shot-pal");
    const stranger = await mint("shot-stranger");
    await befriend(pal, golfer);
    expect((await putLive(golfer, WITH_SHOTS)).json).toEqual({ ok: true });
    const stored = kv.get(`fr:live:${golfer.ownerId}`);
    expect(stored.expirationTtl).toBe(30 * 60);
    expect(JSON.parse(stored.value).holes[0].shots).toEqual(SHOTS);
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.holes[0].shots).toEqual(SHOTS);
    expect(seen.holes[0].clubs).toEqual(["Dr", "7i", "PW"]);
    expect(seen.shots).toEqual([{ n: 1, club: "3w", yd: 220 }]);
    expect((await getLive(stranger)).json).toEqual({ live: [] });
    expect((await getLive(golfer)).json).toEqual({ live: [] });
    const others = [...kv.keys()].filter((k) => k !== `fr:live:${golfer.ownerId}`);
    for (const key of others) expect(String(kv.get(key).value)).not.toMatch(/"shots"/);
  });

  it("live shots: the body limit is 24 KB", async () => {
    const golfer = await mint("shot-big");
    // Every field valid, 18 holes x 15 widest shots is about 31 KB: over the limit.
    const holes = Array.from({ length: 18 }, (_, i) => ({
      hole: i + 1, score: 15, par: 4, clubs: Array(8).fill("Dr 12345"),
      shots: Array.from({ length: 15 }, (_, j) => ({ n: j + 1, club: "Dr 12345", yd: 700, s: [-10.12345, -120.12345], e: [-10.12345, -120.12345], res: "fairway" })),
    }));
    const over = await invoke("/v1/friends/live", { method: "PUT", friend: golfer.key, body: { courseName: "M".repeat(200), hole: 18, holes } });
    expect(over.status).toBe(413);
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    const big = await invoke("/v1/friends/live", { method: "PUT", friend: golfer.key, body: { ...WITH_SHOTS, courseName: "M".repeat(200) } });
    expect(big.status).toBe(200);
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(true);
  });

  it("live shots: 18 holes x 10 shots at the widest field values fits under the limit", async () => {
    const golfer = await mint("shot-full");
    const holes = Array.from({ length: 18 }, (_, i) => ({
      hole: i + 1, score: 15, par: 4, clubs: Array(8).fill("Dr 12345"),
      shots: Array.from({ length: 10 }, (_, j) => ({ n: j + 1, club: "Dr 12345", yd: 700, s: [-10.12345, -120.12345], e: [-10.12345, -120.12345], res: "fairway" })),
    }));
    expect((await putLive(golfer, { courseName: "M".repeat(200), hole: 18, holes })).status).toBe(200);
  });

  const rejectShot = (name, shot) =>
    it(`live shots: rejects ${name}`, async () => {
      const golfer = await mint(`shot-bad-${name.replace(/\W+/g, "-")}`.slice(0, 30));
      const body = { courseName: "Mock Pines GC", hole: 2, holes: [{ hole: 1, score: 5, par: 4, shots: [shot] }] };
      expect((await putLive(golfer, body)).status).toBe(400);
      expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    });
  rejectShot("an unknown shot field", { n: 1, club: "Dr", note: "x" });
  rejectShot("lat/lng fields on a shot", { n: 1, club: "Dr", lat: 10.1, lng: 20.1 });
  rejectShot("a latitude out of range", { n: 1, club: "Dr", s: [90.5, 20.1] });
  rejectShot("a longitude out of range", { n: 1, club: "Dr", e: [10.1, 180.5] });
  rejectShot("a point that is not a pair", { n: 1, club: "Dr", s: [10.1] });
  rejectShot("a point with strings", { n: 1, club: "Dr", s: ["10.1", "20.1"] });
  rejectShot("an object point", { n: 1, club: "Dr", e: { lat: 10.1, lng: 20.1 } });
  rejectShot("coordinates on a putt", { n: 1, club: "Putt", s: [10.1, 20.1] });
  rejectShot("a missing n", { club: "Dr" });
  rejectShot("n of 0", { n: 0 });
  rejectShot("n of 16", { n: 16 });
  rejectShot("a fractional n", { n: 1.5 });
  rejectShot("a club off the allowlist", { n: 1, club: "Way too long club" });
  rejectShot("a non-string club", { n: 1, club: 7 });
  rejectShot("negative yards", { n: 1, club: "Dr", yd: -1 });
  rejectShot("yards over 700", { n: 1, club: "Dr", yd: 701 });
  rejectShot("fractional yards", { n: 1, club: "Dr", yd: 248.5 });
  rejectShot("yards on a putt", { n: 1, club: "Putt", yd: 9 });
  rejectShot("an unknown result", { n: 1, club: "Dr", res: "trees" });
  rejectShot("a shot that is not an object", "Dr 248");
  rejectShot("a shot that is an array", [1, "Dr"]);

  it("live shots: rejects more than 15 shots, repeats, empty or non-array lists", async () => {
    const golfer = await mint("shot-list");
    const hole = (shots) => ({ courseName: "Mock Pines GC", hole: 2, holes: [{ hole: 1, score: 5, par: 4, shots }] });
    expect((await putLive(golfer, hole(Array.from({ length: 16 }, (_, j) => ({ n: (j % 15) + 1 }))))).status).toBe(400);
    expect((await putLive(golfer, hole([{ n: 1 }, { n: 1 }]))).status).toBe(400);
    expect((await putLive(golfer, hole([]))).status).toBe(400);
    expect((await putLive(golfer, hole({ n: 1 }))).status).toBe(400);
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
  });

  it("live shots: current-hole shots are refused when that hole is already scored, or say Holed", async () => {
    const golfer = await mint("shot-cur");
    expect((await putLive(golfer, { courseName: "Mock Pines GC", hole: 1, holes: [{ hole: 1, score: 5, par: 4 }], shots: [{ n: 1 }] })).status).toBe(400);
    expect((await putLive(golfer, { courseName: "Mock Pines GC", hole: 2, holes: [], shots: [{ n: 1, club: "Putt", res: "holed" }] })).status).toBe(400);
    expect((await putLive(golfer, { courseName: "Mock Pines GC", hole: 2, holes: [], shots: "x" })).status).toBe(400);
  });

  it("live shots: published rounds and past rounds still refuse shots", async () => {
    const golfer = await mint("shot-pub");
    const pal = await mint("shot-pub-pal");
    await befriend(pal, golfer);
    const base = { id: "r-mock-1", courseName: "Mock Pines GC", playedOn: "2026-10-20", gross: 5, toPar: 1, holes: [{ hole: 1, score: 5, par: 4 }] };
    expect((await setPast(golfer, pal, "10", [base])).status).toBe(200);
    const withShots = { ...base, holes: [{ hole: 1, score: 5, par: 4, shots: SHOTS }] };
    expect((await setPast(golfer, pal, "10", [withShots])).status).toBe(400);
  });

  // Made-up course, clubs, yards, and coordinates. These lock the follower rules
  // on top of the live-shot allowlist: club averages does not hide a shot,
  // round stats gate fir/gir/putts, practice/test is refused, finish and a
  // 30-minute-stale read delete the row (and every shot location with it).
  const RULE_SHOT = {
    n: 1,
    club: "Dr",
    yd: 248,
    s: [10.12345, 20.12345],
    e: [10.12545, 20.12445],
    res: "fairway",
  };

  it("live rules: serves per-shot club, yards, and lat/lon when club averages are off", async () => {
    const golfer = await mint("rule-club");
    const pal = await mint("rule-club-pal");
    await befriend(pal, golfer);
    const body = {
      courseName: "Mock Pines GC",
      hole: 2,
      clubAverages: false,
      holes: [{ hole: 1, score: 5, par: 4, clubs: ["Dr", "7i"], shots: [RULE_SHOT] }],
    };
    expect((await putLive(golfer, body)).status).toBe(200);
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.holes[0].shots).toEqual([RULE_SHOT]);
    expect(seen.holes[0].shots[0]).toMatchObject({ club: "Dr", yd: 248, s: [10.12345, 20.12345], e: [10.12545, 20.12445] });
    expect(seen.holes[0].clubs).toEqual(["Dr", "7i"]);
    expect(JSON.stringify(seen.holes[0].shots)).toMatch(/"club":"Dr"/);
  });

  it("live rules: rounds shot lat/lon to 5 decimals on write and serves the rounded value", async () => {
    const golfer = await mint("rule-rnd");
    const pal = await mint("rule-rnd-pal");
    await befriend(pal, golfer);
    const noisy = {
      n: 1,
      club: "7i",
      yd: 162,
      s: [10.123450000001, -20.123450000001],
      e: [10.12345, 20.123450000001],
      res: "rough",
    };
    const rounded = {
      n: 1,
      club: "7i",
      yd: 162,
      s: [10.12345, -20.12345],
      e: [10.12345, 20.12345],
      res: "rough",
    };
    expect((await putLive(golfer, {
      courseName: "Mock Pines GC",
      hole: 2,
      holes: [{ hole: 1, score: 5, par: 4, shots: [noisy] }],
    })).status).toBe(200);
    const storedShot = JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value).holes[0].shots[0];
    expect(storedShot).toEqual(rounded);
    expect(storedShot.s).not.toEqual(noisy.s);
    expect(storedShot.e).not.toEqual(noisy.e);
    const seen = (await getLive(pal)).json.live[0].holes[0].shots[0];
    expect(seen).toEqual(rounded);
  });

  // Brian decided Oct 23, 2026, 10:02 AM CT: a live shot lat/lon with 6 or more
  // decimal places is accepted and rounded to 5 on write. Followers get that
  // rounded value. Half-way cases use Math.round (half toward +∞):
  // 10.123455 -> 10.12346 and -10.123455 -> -10.12345.
  // This replaces the #45 test that rejected 6 decimal places.
  it("live rules: accepts 6 or more lat/lon decimals and serves them rounded to 5", async () => {
    const golfer = await mint("rule-six");
    const pal = await mint("rule-six-pal");
    await befriend(pal, golfer);
    const cases = [
      { name: "6 decimals", s: [10.123456, 20.123456], e: [10.123454, -20.123454], wantS: [10.12346, 20.12346], wantE: [10.12345, -20.12345] },
      { name: "7 decimals", s: [10.1234567, -20.9876543], e: [-10.1234567, 20.9876543], wantS: [10.12346, -20.98765], wantE: [-10.12346, 20.98765] },
      { name: "many decimals", s: [10.1234567890123, -120.123456789], e: [-10.1234567890123, 120.123456789], wantS: [10.12346, -120.12346], wantE: [-10.12346, 120.12346] },
      { name: "negative values", s: [-10.123456, -20.123456], e: [-33.333336, -44.444444], wantS: [-10.12346, -20.12346], wantE: [-33.33334, -44.44444] },
      { name: "positive half toward +infinity", s: [10.123455, 20.123445], e: [0.000005, 179.999995], wantS: [10.12346, 20.12345], wantE: [0.00001, 180] },
      { name: "negative half toward +infinity", s: [-10.123455, -20.123455], e: [-89.999995, -179.999995], wantS: [-10.12345, -20.12345], wantE: [-89.99999, -179.99999] },
    ];
    const shots = cases.map((row, index) => ({ n: index + 1, club: "Dr", yd: 200, s: row.s, e: row.e, res: "fairway" }));
    expect((await putLive(golfer, {
      courseName: "Mock Pines GC",
      hole: 2,
      holes: [{ hole: 1, score: 5, par: 4, shots }],
    })).status).toBe(200);
    const stored = JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value).holes[0].shots;
    const seen = (await getLive(pal)).json.live[0].holes[0].shots;
    cases.forEach((row, index) => {
      expect(stored[index].s, `${row.name} stored s`).toEqual(row.wantS);
      expect(stored[index].e, `${row.name} stored e`).toEqual(row.wantE);
      expect(stored[index].s, `${row.name} stored raw s`).not.toEqual(row.s);
      expect(stored[index].e, `${row.name} stored raw e`).not.toEqual(row.e);
      expect(seen[index].s, `${row.name} served s`).toEqual(row.wantS);
      expect(seen[index].e, `${row.name} served e`).toEqual(row.wantE);
    });
    const before = kv.get(`fr:live:${golfer.ownerId}`).value;
    for (const shot of [
      { n: 1, club: "Dr", s: [90.000005, 0] },
      { n: 1, club: "Dr", e: [0, 180.000005] },
      { n: 1, club: "Dr", s: ["10.123456", 20] },
    ]) {
      const refused = await putLive(golfer, {
        courseName: "Mock Pines GC",
        hole: 2,
        holes: [{ hole: 1, score: 5, par: 4, shots: [shot] }],
      });
      expect(refused.status).toBe(400);
      expect(kv.get(`fr:live:${golfer.ownerId}`).value).toBe(before);
    }
  });

  it("live rules: omits putts, fir, and gir when round stats are off", async () => {
    const golfer = await mint("rule-stat");
    const pal = await mint("rule-stat-pal");
    await befriend(pal, golfer);
    const body = {
      courseName: "Mock Pines GC",
      hole: 3,
      roundStats: false,
      holes: [
        { hole: 1, score: 5, par: 4, fir: true, gir: false, putts: 2, shots: [RULE_SHOT] },
        { hole: 2, score: 3, par: 3, putts: 1, fir: true, gir: true },
      ],
    };
    expect((await putLive(golfer, body)).status).toBe(200);
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.holes).toEqual([
      { hole: 1, score: 5, par: 4, shots: [RULE_SHOT] },
      { hole: 2, score: 3, par: 3 },
    ]);
    expect(seen.holes[0].shots[0]).toMatchObject({ club: "Dr", yd: 248 });
    expect(JSON.stringify(seen)).not.toMatch(/"fir"|"gir"|"putts"/);
  });

  it("live rules: serves putts, fir, and gir when round stats are on", async () => {
    const golfer = await mint("rule-stat-on");
    const pal = await mint("rule-stat-on-pal");
    await befriend(pal, golfer);
    const holes = [
      { hole: 1, score: 5, par: 4, fir: true, gir: false, putts: 2 },
      { hole: 2, score: 3, par: 3, putts: 1, fir: false, gir: true },
    ];
    expect((await putLive(golfer, { courseName: "Mock Pines GC", hole: 3, roundStats: true, holes })).status).toBe(200);
    expect((await getLive(pal)).json.live[0].holes).toEqual(holes);
  });

  it("live rules: rejects practice and test rounds and stores nothing", async () => {
    const golfer = await mint("rule-prac");
    const pal = await mint("rule-prac-pal");
    await befriend(pal, golfer);
    const practiceShot = { n: 1, club: "Dr", yd: 10, s: [12.34567, 98.76543], e: [12.34568, 98.76544] };
    for (const roundKind of ["practice", "Practice", "test", "Test"]) {
      const refused = await putLive(golfer, {
        courseName: "Mock Pines GC",
        hole: 2,
        roundKind,
        holes: [{ hole: 1, score: 5, par: 4, shots: [practiceShot] }],
      });
      expect(refused.status, roundKind).toBe(400);
      expect(refused.json, roundKind).toEqual({ error: "practice_or_test" });
      expect(kv.has(`fr:live:${golfer.ownerId}`), roundKind).toBe(false);
    }
    expect((await putLive(golfer, { ...LIVE, roundKind: "round" })).status).toBe(200);
    const before = kv.get(`fr:live:${golfer.ownerId}`).value;
    const again = await putLive(golfer, {
      courseName: "Mock Pines GC",
      hole: 4,
      roundKind: "practice",
      holes: [{ hole: 1, score: 4, par: 4, fir: true, putts: 2, shots: [practiceShot] }],
    });
    expect(again.status).toBe(400);
    expect(again.json).toEqual({ error: "practice_or_test" });
    expect(kv.get(`fr:live:${golfer.ownerId}`).value).toBe(before);
    expect(before).not.toMatch(/12\.34567/);
    expect((await getLive(pal)).json.live[0].courseName).toBe("Pine Hollow GC");
    expect(JSON.stringify([...kv.values()])).not.toMatch(/12\.34567/);
  });

  it("live rules: deletes the live row and shot locations when the round finishes", async () => {
    const golfer = await mint("rule-fin");
    const pal = await mint("rule-fin-pal");
    await befriend(pal, golfer);
    const shot = { n: 1, club: "3w", yd: 220, s: [13.13131, -98.11111], e: [13.13132, -98.11112], res: "fairway" };
    expect((await putLive(golfer, {
      courseName: "Mock Pines GC",
      hole: 2,
      holes: [{ hole: 1, score: 5, par: 4, shots: [shot] }],
    })).status).toBe(200);
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(true);
    const done = await putLive(golfer, { finished: true });
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ ok: true });
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    expect((await getLive(pal)).json).toEqual({ live: [] });
    expect(JSON.stringify([...kv.values()])).not.toMatch(/13\.13131|13\.13132/);
  });

  it("live rules: deletes shot locations 30 minutes after the last update", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    const golfer = await mint("rule-ttl");
    const pal = await mint("rule-ttl-pal");
    await befriend(pal, golfer);
    const shot = { n: 1, club: "PW", yd: 90, s: [14.14141, -97.22222], e: [14.14142, -97.22223], res: "green" };
    expect((await putLive(golfer, {
      courseName: "Mock Pines GC",
      hole: 2,
      holes: [{ hole: 1, score: 4, par: 4, shots: [shot] }],
    })).status).toBe(200);
    expect(kv.get(`fr:live:${golfer.ownerId}`).expirationTtl).toBe(30 * 60);
    vi.setSystemTime(new Date("2026-10-23T12:30:00.000Z"));
    expect((await getLive(pal)).json.live).toHaveLength(1);
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(true);
    vi.setSystemTime(new Date("2026-10-23T12:30:01.000Z"));
    expect((await getLive(pal)).json).toEqual({ live: [] });
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    expect(JSON.stringify([...kv.values()])).not.toMatch(/14\.14141|14\.14142/);
  });

  // Made-up data. #47 rules and #49 skippedHoles together after the main merge.
  it("live rules: skippedHoles is kept with round stats off, and a practice round with skippedHoles stores nothing", async () => {
    const golfer = await mint("rule-skip");
    const pal = await mint("rule-skip-pal");
    await befriend(pal, golfer);
    const body = {
      courseName: "Mock Pines GC",
      hole: 4,
      roundStats: false,
      skippedHoles: [3, 2],
      holes: [{ hole: 1, score: 5, par: 4, fir: true, gir: false, putts: 2, shots: [{ n: 1, club: "Dr", yd: 240, s: [11.1, 21.1], e: [11.2, 21.2], res: "fairway" }] }],
    };
    expect((await putLive(golfer, { ...body, roundKind: "practice" })).json).toEqual({ error: "practice_or_test" });
    expect(kv.has(`fr:live:${golfer.ownerId}`)).toBe(false);
    expect((await putLive(golfer, body)).status).toBe(200);
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.skippedHoles).toEqual([2, 3]);
    expect(seen.holes[0]).not.toHaveProperty("putts");
    expect(seen.holes[0]).not.toHaveProperty("fir");
    expect(seen.holes[0].shots[0]).toMatchObject({ club: "Dr", yd: 240, s: [11.1, 21.1] });
  });

  // Brian decided Oct 24, 2026: live rounds show the hole clubs list even with
  // club averages off. Made-up course and clubs.
  it("live rules: serves the hole clubs list when club averages are off", async () => {
    const golfer = await mint("rule-holeclubs");
    const pal = await mint("rule-holeclubs-pal");
    await befriend(pal, golfer);
    expect((await putLive(golfer, {
      courseName: "Mock Pines GC",
      hole: 3,
      clubAverages: false,
      holes: [{ hole: 1, score: 4, par: 4, clubs: ["3w", "9i", "Putt"] }, { hole: 2, score: 3, par: 3, clubs: ["8i"] }],
    })).status).toBe(200);
    expect(JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value).holes.map((h) => h.clubs)).toEqual([["3w", "9i", "Putt"], ["8i"]]);
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.holes.map((h) => h.clubs)).toEqual([["3w", "9i", "Putt"], ["8i"]]);
  });

  // Brian's rule: live sharing is on by default; the phone's PUT is the opt-in.
  // The server keeps no share flag, so a PUT with no setting fields is stored
  // and served in full. Made-up course and data.
  it("live rules: a PUT with no share or setting fields is stored and served in full", async () => {
    const golfer = await mint("rule-default");
    const pal = await mint("rule-default-pal");
    await befriend(pal, golfer);
    const hole = { hole: 1, score: 5, par: 4, fir: true, gir: false, putts: 2, clubs: ["Dr", "8i"], shots: [{ n: 1, club: "Dr", yd: 230, s: [12.1, 22.1], e: [12.2, 22.2], res: "fairway" }] };
    expect((await putLive(golfer, { courseName: "Mock Pines GC", hole: 2, holes: [hole] })).json).toEqual({ ok: true });
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.holes[0]).toEqual(hole);
  });

  // Skipped holes (Brian Baird OK 2026-10-23 11:55 PM CT). Made-up course and scores only.
  it("skipped holes: stored and returned to accepted friends only, merged and sorted", async () => {
    const golfer = await mint("skip-golfer");
    const pal = await mint("skip-pal");
    const stranger = await mint("skip-stranger");
    await befriend(pal, golfer);
    expect((await putLive(golfer, { ...LIVE, hole: 6, skippedHoles: [5, 3, 5, 4] })).json).toEqual({ ok: true });
    expect(JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value).skippedHoles).toEqual([3, 4, 5]);
    const seen = (await getLive(pal)).json.live[0];
    expect(seen.skippedHoles).toEqual([3, 4, 5]);
    expect(seen.toPar).toBe(1);
    expect((await getLive(stranger)).json).toEqual({ live: [] });
  });

  it("skipped holes: older apps that leave it out get no skippedHoles field back", async () => {
    const golfer = await mint("skip-old");
    const pal = await mint("skip-old-pal");
    await befriend(pal, golfer);
    expect((await putLive(golfer)).status).toBe(200);
    const seen = (await getLive(pal)).json.live[0];
    expect(Object.hasOwn(seen, "skippedHoles")).toBe(false);
    expect(Object.hasOwn(JSON.parse(kv.get(`fr:live:${golfer.ownerId}`).value), "skippedHoles")).toBe(false);
    expect((await putLive(golfer, { ...LIVE, skippedHoles: [] })).status).toBe(200);
    expect(Object.hasOwn((await getLive(pal)).json.live[0], "skippedHoles")).toBe(false);
  });

  for (const [name, skippedHoles] of [
    ["hole 0", [0]],
    ["hole 19", [19]],
    ["a fraction", [3.5]],
    ["a string", ["3"]],
    ["null entry", [null]],
    ["a non-array", 3],
    ["an object", { 3: true }],
    ["more than 18 entries", Array.from({ length: 19 }, () => 4)],
  ]) {
    it(`skipped holes: rejects ${name}`, async () => {
      const golfer = await mint(`skip-bad-${name.replace(/\W/g, "")}`);
      expect((await putLive(golfer, { ...LIVE, skippedHoles })).status).toBe(400);
    });
  }

  it("skipped holes: a hole cannot be both scored and skipped, and current-hole shots cannot sit on a skipped hole", async () => {
    const golfer = await mint("skip-clash");
    expect((await putLive(golfer, { ...LIVE, skippedHoles: [2] })).status).toBe(400);
    expect((await putLive(golfer, { ...LIVE, hole: 3, skippedHoles: [3], shots: [{ n: 1, club: "3w", yd: 220 }] })).status).toBe(400);
    expect((await putLive(golfer, { ...LIVE, hole: 3, skippedHoles: [3] })).status).toBe(200);
  });

  it("skipped holes: a stored row with bad or scored skipped entries returns only the clean, unscored ones", async () => {
    const golfer = await mint("skip-stored");
    const pal = await mint("skip-stored-pal");
    await befriend(pal, golfer);
    const base = { courseName: "Pine Hollow GC", hole: 4, holes: LIVE.holes, updatedAt: Date.now() };
    kv.set(`fr:live:${golfer.ownerId}`, { value: JSON.stringify({ ...base, skippedHoles: [2, 3] }) });
    expect((await getLive(pal)).json.live[0].skippedHoles).toEqual([3]);
    kv.set(`fr:live:${golfer.ownerId}`, { value: JSON.stringify({ ...base, skippedHoles: [3, 99] }) });
    const bad = (await getLive(pal)).json.live[0];
    expect(Object.hasOwn(bad, "skippedHoles")).toBe(false);
    expect(bad.holes).toEqual(LIVE.holes);
  });
});
