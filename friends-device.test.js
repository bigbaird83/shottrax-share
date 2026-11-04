import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter } from "./entry.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";

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

// Made-up course, scores, keys and device tokens only.
const PHONE_A = "devA_" + "1".repeat(40);
const PHONE_B = "devB_" + "2".repeat(40);
const LIVE = { courseName: "Pine Hollow GC", hole: 3, holes: [{ hole: 1, score: 5, par: 4 }, { hole: 2, score: 3, par: 3 }] };

describe("two-phone guard: active device per friend key", () => {
  let kv;
  let env;

  beforeEach(() => {
    kv = new Map();
    env = {
      BOARDS: {
        async get(key) { return kv.has(key) ? kv.get(key) : null; },
        async put(key, value) { kv.set(key, value); },
        async delete(key) { kv.delete(key); },
        async list(options = {}) {
          const prefix = typeof options.prefix === "string" ? options.prefix : "";
          return { keys: [...kv.keys()].filter((n) => n.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
        },
      },
      FRIEND_GUESSES: createLimiterNamespace(),
    };
  });

  async function invoke(pathname, { method = "POST", body, friend, device } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (device !== undefined) headers["X-Device-Token"] = device;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await entry.fetch(new Request(`${ORIGIN}${pathname}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { waitUntil() {} });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  }

  async function mint(suffix) {
    const key = friendKey(suffix);
    const created = await invoke("/v1/friends/code", { friend: key, body: {} });
    expect(created.status).toBe(200);
    return { key, ownerId: created.json.ownerId };
  }
  const claim = (who, device) => invoke("/v1/friends/device/claim", { friend: who.key, device, body: {} });
  const put = (who, device, body = LIVE) => invoke("/v1/friends/live", { method: "PUT", friend: who.key, device, body });
  const liveKey = (who) => `fr:live:${who.ownerId}`;

  it("an unclaimed key keeps working with no device token (older apps)", async () => {
    const me = await mint("u");
    expect((await put(me)).status).toBe(200);
    expect(kv.has(liveKey(me))).toBe(true);
    expect((await invoke("/v1/friends/live/stop", { friend: me.key })).status).toBe(200);
    expect(kv.has(liveKey(me))).toBe(false);
    const read = await invoke("/v1/friends/device", { method: "GET", friend: me.key });
    expect(read.json).toEqual({ claimed: false, active: true });
    expect([...kv.keys()].some((k) => k.startsWith("fr:device:"))).toBe(false);
  });

  it("claim stores only a hash of the token and is idempotent", async () => {
    const me = await mint("c");
    const first = await claim(me, PHONE_A);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, active: true, moved: false });
    expect(Number.isFinite(first.json.claimedAt)).toBe(true);
    const stored = kv.get(`fr:device:${me.ownerId}`);
    expect(stored).not.toContain(PHONE_A);
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual(["claimedAt", "tokenHash"]);
    const again = await claim(me, PHONE_A);
    expect(again.json).toEqual({ ok: true, active: true, moved: false, claimedAt: first.json.claimedAt });
    expect(kv.get(`fr:device:${me.ownerId}`)).toBe(stored);
  });

  it("after a claim only the active token may write, start, finish, or stop live rounds", async () => {
    const me = await mint("g");
    await claim(me, PHONE_A);
    expect((await put(me, PHONE_A)).status).toBe(200);
    const before = kv.get(liveKey(me));
    for (const device of [undefined, PHONE_B, "short", ""]) {
      const update = await put(me, device, { ...LIVE, hole: 4 });
      expect(update.status, String(device)).toBe(409);
      expect(update.json.error).toBe("device_not_active");
      expect(Object.keys(update.json).sort()).toEqual(["claimedAt", "error"]);
      expect((await put(me, device, { finished: true })).status).toBe(409);
      expect((await invoke("/v1/friends/live/stop", { friend: me.key, device })).status).toBe(409);
      expect(kv.get(liveKey(me))).toBe(before);
    }
    expect((await put(me, PHONE_A, { finished: true })).status).toBe(200);
    expect(kv.has(liveKey(me))).toBe(false);
  });

  it("moving to a new phone locks out the old one and drops its live row", async () => {
    const me = await mint("m");
    await claim(me, PHONE_A);
    await put(me, PHONE_A);
    const moved = await claim(me, PHONE_B);
    expect(moved.json).toMatchObject({ ok: true, active: true, moved: true });
    expect(kv.has(liveKey(me))).toBe(false);
    expect((await put(me, PHONE_A)).json.error).toBe("device_not_active");
    expect((await put(me, PHONE_B)).status).toBe(200);
    expect((await invoke("/v1/friends/device", { method: "GET", friend: me.key, device: PHONE_A })).json)
      .toEqual({ claimed: true, active: false, claimedAt: moved.json.claimedAt });
    expect((await invoke("/v1/friends/device", { method: "GET", friend: me.key, device: PHONE_B })).json)
      .toEqual({ claimed: true, active: true, claimedAt: moved.json.claimedAt });
  });

  it("one key's claim never affects another key", async () => {
    const me = await mint("x");
    const other = await mint("y");
    await claim(me, PHONE_A);
    expect((await put(other)).status).toBe(200);
  });

  it("claim refuses a missing key, unknown key, bad token, or extra fields with nothing written", async () => {
    const me = await mint("r");
    const keysBefore = [...kv.keys()].sort();
    expect((await invoke("/v1/friends/device/claim", { device: PHONE_A, body: {} })).status).toBe(401);
    expect((await invoke("/v1/friends/device/claim", { friend: friendKey("z"), device: PHONE_A, body: {} })).status).toBe(401);
    for (const device of [undefined, "short", "bad token with spaces 0123456789abcdef", "x".repeat(129)]) {
      const res = await claim(me, device);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "device_token_required" });
    }
    expect((await invoke("/v1/friends/device/claim", { friend: me.key, device: PHONE_A, body: { deviceToken: PHONE_A } })).json)
      .toEqual({ error: "invalid_body" });
    expect([...kv.keys()].sort()).toEqual(keysBefore);
  });

  it("a corrupt device row fails closed", async () => {
    const me = await mint("k");
    kv.set(`fr:device:${me.ownerId}`, "not json");
    expect((await put(me, PHONE_A)).json.error).toBe("device_not_active");
    expect((await claim(me, PHONE_A)).status).toBe(200);
    expect((await put(me, PHONE_A)).status).toBe(200);
  });

  it("CORS preflight allows the X-Device-Token header", async () => {
    const res = await entry.fetch(new Request(`${ORIGIN}/v1/friends/device/claim`, { method: "OPTIONS" }), env, { waitUntil() {} });
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Device-Token");
  });
});
