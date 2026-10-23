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
  rejectShot("6 decimal places", { n: 1, club: "Dr", s: [10.123456, 20.12345] });
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
});
