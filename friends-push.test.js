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

describe("friend live-round alerts", () => {
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
  async function invoke(pathname, { method = "POST", body, friend, device } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (device !== undefined) headers["X-Device-Token"] = device;
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
  // Made-up tokens only.
  const TOKEN_A = "ExponentPushToken[madeupAAAAAAAAAAAAAAAA]";
  const TOKEN_B = "ExponentPushToken[madeupBBBBBBBBBBBBBBBB]";
  const OPEN = { courseName: "Pine Hollow GC", hole: 1, holes: [] };
  const TEE = { ...OPEN, shots: [{ n: 1, club: "Dr", yd: 250, res: "fairway" }] };
  const putLive = (who, body) => invoke("/v1/friends/live", { method: "PUT", friend: who.key, body });
  const register = (who, token) => invoke("/v1/friends/push", { method: "PUT", friend: who.key, body: { token } });
  const unregister = (who) => invoke("/v1/friends/push/remove", { friend: who.key, body: {} });

  let sends;
  beforeEach(() => {
    sends = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      sends.push({ url: String(url), messages: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const tokensSent = () => sends.flatMap((s) => s.messages.map((m) => m.to)).sort();

  it("registers, replaces and removes a token linked to the friend code", async () => {
    const me = await mint("me");
    expect((await register(me, TOKEN_A)).json).toEqual({ ok: true });
    expect(kv.get(`fr:push:${me.ownerId}`).value).toBe(TOKEN_A);
    await register(me, TOKEN_B);
    expect(kv.get(`fr:push:${me.ownerId}`).value).toBe(TOKEN_B);
    expect((await unregister(me)).json).toEqual({ ok: true });
    expect(kv.has(`fr:push:${me.ownerId}`)).toBe(false);
  });

  it("after a device claim only the active phone may set or remove the push token", async () => {
    // Made-up device tokens only.
    const PHONE_A = "phoneA".padEnd(40, "a");
    const PHONE_B = "phoneB".padEnd(40, "b");
    const me = await mint("me");
    expect((await invoke("/v1/friends/device/claim", { friend: me.key, device: PHONE_A, body: {} })).status).toBe(200);
    for (const device of [undefined, PHONE_B]) {
      const put = await invoke("/v1/friends/push", { method: "PUT", friend: me.key, device, body: { token: TOKEN_A } });
      expect(put.status).toBe(409);
      expect(put.json.error).toBe("device_not_active");
      expect(kv.has(`fr:push:${me.ownerId}`)).toBe(false);
    }
    expect((await invoke("/v1/friends/push", { method: "PUT", friend: me.key, device: PHONE_A, body: { token: TOKEN_A } })).json).toEqual({ ok: true });
    for (const device of [undefined, PHONE_B]) {
      const removed = await invoke("/v1/friends/push/remove", { friend: me.key, device, body: {} });
      expect(removed.status).toBe(409);
      expect(kv.get(`fr:push:${me.ownerId}`).value).toBe(TOKEN_A);
    }
    expect((await invoke("/v1/friends/push/remove", { friend: me.key, device: PHONE_A, body: {} })).json).toEqual({ ok: true });
    expect(kv.has(`fr:push:${me.ownerId}`)).toBe(false);
  });

  it("refuses a bad token, an extra field, or no key", async () => {
    const me = await mint("me");
    expect((await register(me, "not-a-token")).status).toBe(400);
    expect((await invoke("/v1/friends/push", { method: "PUT", friend: me.key, body: { token: TOKEN_A, extra: 1 } })).status).toBe(400);
    expect((await invoke("/v1/friends/push", { method: "PUT", body: { token: TOKEN_A } })).status).toBe(401);
    expect((await invoke("/v1/friends/push", { method: "PUT", friend: friendKey("nobody"), body: { token: TOKEN_A } })).status).toBe(401);
    expect(kv.has(`fr:push:${me.ownerId}`)).toBe(false);
  });

  it("sends one alert per round at the first tee shot, not at round open", async () => {
    const golfer = await mint("golfer");
    const pal = await mint("pal");
    await befriend(golfer, pal);
    await invoke("/v1/friends/code/name", { friend: golfer.key, body: { name: INVITE_NAME } });
    await register(pal, TOKEN_A);

    expect((await putLive(golfer, { ...OPEN, roundId: "r1" })).status).toBe(200);
    expect(sends).toEqual([]);

    expect((await putLive(golfer, { ...TEE, roundId: "r1" })).status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(sends[0].url).toBe("https://exp.host/--/api/v2/push/send");
    expect(sends[0].messages).toEqual([expect.objectContaining({
      to: TOKEN_A,
      title: `${INVITE_NAME} is live on the course`,
      body: "Started a round at Pine Hollow GC. Tap to follow along.",
    })]);

    await putLive(golfer, { ...TEE, roundId: "r1" });
    await putLive(golfer, { courseName: "Pine Hollow GC", hole: 2, holes: [{ hole: 1, score: 4, par: 4, shots: [{ n: 1, club: "Dr", yd: 250 }] }], roundId: "r1" });
    expect(sends).toHaveLength(1);

    await putLive(golfer, { ...TEE, roundId: "r2" });
    expect(sends).toHaveLength(2);
  });

  it("a scored hole with no marked shot, or a later shot only, does not send", async () => {
    const golfer = await mint("golfer");
    const pal = await mint("pal");
    await befriend(golfer, pal);
    await register(pal, TOKEN_A);
    expect((await putLive(golfer, { courseName: "Pine Hollow GC", hole: 2, holes: [{ hole: 1, score: 4, par: 4 }], roundId: "r1" })).status).toBe(200);
    expect((await putLive(golfer, { ...OPEN, shots: [{ n: 2, club: "7i", yd: 150 }], roundId: "r1" })).status).toBe(200);
    expect(sends).toEqual([]);
    expect(kv.has(`fr:pushsent:${golfer.ownerId}:r1`)).toBe(false);
    // A tee shot on a sent hole counts too, once.
    await putLive(golfer, { courseName: "Pine Hollow GC", hole: 2, holes: [{ hole: 1, score: 4, par: 4, shots: [{ n: 1, club: "Dr", yd: 240 }] }], roundId: "r1" });
    await putLive(golfer, { ...TEE, hole: 2, holes: [{ hole: 1, score: 4, par: 4 }], roundId: "r1" });
    expect(sends).toHaveLength(1);
  });

  it("skips opted-out, blocked and non-friend players", async () => {
    const golfer = await mint("golfer");
    const on = await mint("on");
    const off = await mint("off");
    const blocker = await mint("blocker");
    const blocked = await mint("blocked");
    const stranger = await mint("stranger");
    for (const p of [on, off, blocker, blocked]) await befriend(golfer, p);
    for (const p of [on, off, blocker, blocked, stranger]) await register(p, `ExponentPushToken[madeup${p.ownerId.slice(0, 8).replace(/[^A-Za-z0-9]/g, "x")}]`);
    await unregister(off);
    expect((await invoke("/v1/friends/block", { friend: blocker.key, body: { ownerId: golfer.ownerId } })).status).toBe(200);
    expect((await invoke("/v1/friends/block", { friend: golfer.key, body: { ownerId: blocked.ownerId } })).status).toBe(200);

    await putLive(golfer, { ...TEE, roundId: "r1" });
    expect(tokensSent()).toEqual([kv.get(`fr:push:${on.ownerId}`).value]);
    expect(sends[0].messages[0].title).toBe("A friend is live on the course");
  });

  it("never alerts for practice or test rounds, or without a roundId", async () => {
    const golfer = await mint("golfer");
    const pal = await mint("pal");
    await befriend(golfer, pal);
    await register(pal, TOKEN_A);
    expect((await putLive(golfer, { ...TEE, roundId: "r1", roundKind: "practice" })).status).toBe(400);
    expect((await putLive(golfer, TEE)).status).toBe(200);
    expect((await putLive(golfer, { ...TEE, roundId: "bad id!" })).status).toBe(400);
    expect(sends).toEqual([]);
  });

  it("a failed send does not fail the live update and is not retried for that round", async () => {
    const golfer = await mint("golfer");
    const pal = await mint("pal");
    await befriend(golfer, pal);
    await register(pal, TOKEN_A);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect((await putLive(golfer, { ...TEE, roundId: "r1" })).status).toBe(200);
    expect(kv.get(`fr:pushsent:${golfer.ownerId}:r1`).expirationTtl).toBe(7 * 24 * 60 * 60);
  });
});
