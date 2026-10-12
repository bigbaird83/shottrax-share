import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      return obj;
    },
  };
}

describe("friend codes", () => {
  /** @type {Map<string, { value: string }>} */
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
        async put(key, value) {
          kv.set(key, { value });
        },
        async delete(key) {
          kv.delete(key);
        },
      },
      FRIEND_GUESSES: createLimiterNamespace(),
    };
  });

  afterEach(() => {
    kv = new Map();
  });

  async function invoke(pathname, { method = "POST", body, headers, friend, ip } = {}) {
    const requestHeaders = { ...(headers || {}) };
    if (friend) requestHeaders["X-Friend-Key"] = friend;
    if (ip) requestHeaders["CF-Connecting-IP"] = ip;
    if (body !== undefined && !requestHeaders["Content-Type"]) requestHeaders["Content-Type"] = "application/json";
    const response = await worker.fetch(new Request(`${ORIGIN}${pathname}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), env, { waitUntil() {} });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, text, json, headers: response.headers };
  }

  function assertAnonymous(extraText = "") {
    const blobs = [extraText, ...[...kv.entries()].map(([key, row]) => `${key}\n${row.value}`)];
    for (const blob of blobs) {
      expect(blob).not.toContain(DISPLAY_NAME);
      expect(blob).not.toContain(INSTALL_ID);
      expect(blob.toLowerCase()).not.toContain("\"name\"");
    }
  }

  it("mints one code for a friend key and resets the old code immediately", async () => {
    const key = friendKey("mint");
    const first = await invoke("/v1/friends/code", { friend: key, headers: { "X-Display-Name": DISPLAY_NAME, "X-Install-Id": INSTALL_ID } });
    expect(first.status).toBe(200);
    expect(first.json.code).toMatch(CODE_RE);
    expect(first.json.ownerId).toMatch(OWNER_RE);
    expect(Object.keys(first.json).sort()).toEqual(["code", "ownerId"]);
    expect(first.text).not.toContain(key);

    const again = await invoke("/v1/friends/code", { friend: key });
    expect(again.json).toEqual(first.json);
    const keysAfterMint = [...kv.keys()];

    const lookup = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: first.json.code.toLowerCase().slice(0, 4) + "-" + first.json.code.slice(4) } });
    expect(lookup.status).toBe(200);
    expect(lookup.json).toEqual({ ownerId: first.json.ownerId });

    const reset = await invoke("/v1/friends/code/reset", { friend: key, body: {} });
    expect(reset.status).toBe(200);
    expect(reset.json.ownerId).toBe(first.json.ownerId);
    expect(reset.json.code).toMatch(CODE_RE);
    expect(reset.json.code).not.toBe(first.json.code);

    const oldLookup = await invoke("/v1/friends/codes/lookup", { friend: friendKey("other"), body: { code: first.json.code } });
    expect(oldLookup.status).toBe(404);
    expect(oldLookup.json).toEqual({ error: "code_not_found" });
    const newLookup = await invoke("/v1/friends/codes/lookup", { friend: friendKey("other"), body: { code: reset.json.code } });
    expect(newLookup.status).toBe(200);
    expect(newLookup.json).toEqual({ ownerId: first.json.ownerId });
    expect(kv.has(`fr:code:${first.json.code}`)).toBe(false);
    expect(kv.get(`fr:code:${reset.json.code}`).value).toBe(first.json.ownerId);
    expect(keysAfterMint.every((name) => name.startsWith("fr:"))).toBe(true);
    assertAnonymous(first.text + reset.text + lookup.text);
    expect([...kv.keys()].every((name) => name.startsWith("fr:"))).toBe(true);
    for (const row of kv.values()) expect(row.value).not.toContain(key);
  });

  it("holds the guess limit under parallel lookups", async () => {
    const key = friendKey("burst");
    const results = await Promise.all(
      Array.from({ length: KEY_LIMIT + 12 }, () => invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "AAAAAAAA" } })),
    );
    const misses = results.filter((result) => result.status === 404);
    const limited = results.filter((result) => result.status === 429);
    expect(misses).toHaveLength(KEY_LIMIT);
    expect(limited).toHaveLength(12);
    for (const result of misses) expect(result.json).toEqual({ error: "code_not_found" });
    for (const result of limited) {
      expect(result.json).toEqual({ error: "rate_limited" });
      expect(result.text).not.toContain("blocked");
      expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
    const another = await invoke("/v1/friends/codes/lookup", { friend: friendKey("next"), body: { code: "AAAAAAAA" } });
    expect(another.status).toBe(404);
  });

  it("holds the IP guess limit across friend keys", async () => {
    const results = await Promise.all(
      Array.from({ length: IP_LIMIT + 3 }, (_, index) => invoke("/v1/friends/codes/lookup", {
        friend: friendKey(`ip${index}`),
        ip: "203.0.113.10",
        body: { code: "BBBBBBBB" },
      })),
    );
    expect(results.filter((result) => result.status === 404)).toHaveLength(IP_LIMIT);
    expect(results.filter((result) => result.status === 429)).toHaveLength(3);
  });

  it("resets and blocks on the Durable Object without a distinct blocked error", async () => {
    const key = friendKey("limitops");
    const name = await limiterNameForFriendKey(key);
    const stub = env.FRIEND_GUESSES.get(env.FRIEND_GUESSES.idFromName(name));
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      const allowed = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "CCCCCCCC" } });
      expect(allowed.status).toBe(404);
    }
    const capped = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "CCCCCCCC" } });
    expect(capped.json).toEqual({ error: "rate_limited" });

    const reset = await stub.fetch("https://friend-guess.internal/limit", {
      method: "POST",
      body: JSON.stringify({ op: "reset", now: Date.now() }),
    });
    expect((await reset.json()).ok).toBe(true);
    const afterReset = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "CCCCCCCC" } });
    expect(afterReset.status).toBe(404);

    const blocked = await stub.fetch("https://friend-guess.internal/limit", {
      method: "POST",
      body: JSON.stringify({ op: "block", now: Date.now() }),
    });
    expect((await blocked.json()).ok).toBe(true);
    const afterBlock = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "CCCCCCCC" } });
    expect(afterBlock.status).toBe(429);
    expect(afterBlock.json).toEqual({ error: "rate_limited" });
    expect(afterBlock.text).not.toContain("blocked");
  });

  it("rolls the Durable Object window and counts exactly inside one object", async () => {
    const limiter = new FriendGuessLimiter(sqliteState("key:window"), {});
    const start = 1_700_000_000_000;
    async function attempt(now) {
      const response = await limiter.fetch(new Request("https://friend-guess.internal/limit", {
        method: "POST",
        body: JSON.stringify({ op: "attempt", now }),
      }));
      return response.json();
    }
    const burst = await Promise.all(Array.from({ length: KEY_LIMIT + 5 }, () => attempt(start)));
    expect(burst.filter((row) => row.ok === true)).toHaveLength(KEY_LIMIT);
    expect(burst.filter((row) => row.ok === false)).toHaveLength(5);
    const later = await attempt(start + WINDOW_MS);
    expect(later).toEqual({ ok: true });
  });

  it("does not store a name or touch the course cache", async () => {
    kv.set("id:14322", { value: "{\"holes\":1}" });
    kv.set("osm:v1:33.1900,-93.2100:1800", { value: "{\"elements\":[]}" });
    const before = new Map([...kv.entries()].map(([key, row]) => [key, row.value]));
    const key = friendKey("cache");
    const created = await invoke("/v1/friends/code", {
      friend: key,
      headers: { "X-Display-Name": DISPLAY_NAME, "X-Install-Id": INSTALL_ID },
    });
    expect(created.status).toBe(200);
    await invoke("/v1/friends/code/reset", { friend: key });
    await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: created.json.code, name: DISPLAY_NAME } });
    expect(kv.get("id:14322").value).toBe(before.get("id:14322"));
    expect(kv.get("osm:v1:33.1900,-93.2100:1800").value).toBe(before.get("osm:v1:33.1900,-93.2100:1800"));
    const friendKeys = [...kv.keys()].filter((name) => !before.has(name));
    expect(friendKeys.length).toBeGreaterThan(0);
    expect(friendKeys.every((name) => name.startsWith("fr:"))).toBe(true);
    for (const prefix of ["id:", "name:", "osm:", "gq:", "gapi:", "gqueue:", "gca:", "cr:"]) {
      expect(friendKeys.filter((name) => name.startsWith(prefix))).toEqual([]);
    }
    assertAnonymous();
    const authKey = [...kv.keys()].find((name) => name.startsWith("fr:k:"));
    const board = await invoke(`/${encodeURIComponent(authKey)}`, { method: "GET" });
    expect(board.status).toBe(400);
    expect(board.text).toBe("bad key");
    expect(kv.get(authKey).value).not.toContain(DISPLAY_NAME);
  });

  it("rejects a bad body without consuming a guess", async () => {
    const key = friendKey("body");
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      const bad = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "DDDDDDDD", name: DISPLAY_NAME } });
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: "invalid_body" });
    }
    const shape = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "OOOOOOOO" } });
    expect(shape.json).toEqual({ error: "invalid_body" });
    const huge = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "D".repeat(3000) } });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "payload_too_large" });
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      const miss = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "DDDDDDDD" } });
      expect(miss.status).toBe(404);
    }
    const limited = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "DDDDDDDD" } });
    expect(limited.status).toBe(429);
    assertAnonymous();
  });

  it("requires a random friend key and the limiter binding", async () => {
    const missing = await invoke("/v1/friends/code", {});
    expect(missing.status).toBe(401);
    expect(missing.json).toEqual({ error: "friend_key_required" });
    const install = await invoke("/v1/friends/code", { friend: INSTALL_ID });
    expect(install.status).toBe(401);
    const same = friendKey("same");
    const echoed = await invoke("/v1/friends/code", { friend: same, headers: { "X-Install-Id": same } });
    expect(echoed.status).toBe(401);
    const early = await invoke("/v1/friends/code/reset", { friend: friendKey("early") });
    expect(early.status).toBe(401);
    const method = await invoke("/v1/friends/code", { method: "GET", friend: friendKey("get") });
    expect(method.status).toBe(405);
    expect(method.json).toEqual({ error: "method_not_allowed" });
    const later = await invoke("/v1/friends/requests", { friend: friendKey("later"), body: { code: "AAAAAAAA" } });
    expect(later.status).toBe(404);
    expect(later.json).toEqual({ error: "unknown_route" });

    const key = friendKey("nobind");
    env.FRIEND_GUESSES = undefined;
    const minted = await invoke("/v1/friends/code", { friend: key });
    expect(minted.status).toBe(200);
    const unbound = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: minted.json.code } });
    expect(unbound.status).toBe(503);
    expect(unbound.json).toEqual({ error: "guess_limiter_not_configured" });
    env.BOARDS = undefined;
    const noBoards = await invoke("/v1/friends/code", { friend: key });
    expect(noBoards.status).toBe(503);
    expect(noBoards.json).toEqual({ error: "boards_not_configured" });
  });
});
