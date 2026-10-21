import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./entry.js";
import worker, { FriendGuessLimiter } from "./worker.js";
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
    const response = await worker.fetch(new Request(`${ORIGIN}${pathname}`, {
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
});
