import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        async put(key, value, options) {
          kv.set(key, {
            value,
            expirationTtl: options && Number.isFinite(options.expirationTtl) ? options.expirationTtl : undefined,
          });
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

    const other = friendKey("other");
    expect((await invoke("/v1/friends/code", { friend: other, body: {} })).status).toBe(200);
    const oldLookup = await invoke("/v1/friends/codes/lookup", { friend: other, body: { code: first.json.code } });
    expect(oldLookup.status).toBe(404);
    expect(oldLookup.json).toEqual({ error: "code_not_found" });
    const newLookup = await invoke("/v1/friends/codes/lookup", { friend: other, body: { code: reset.json.code } });
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
    const next = friendKey("next");
    expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
    expect((await invoke("/v1/friends/code", { friend: next, body: {} })).status).toBe(200);
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
    const another = await invoke("/v1/friends/codes/lookup", { friend: next, body: { code: "AAAAAAAA" } });
    expect(another.status).toBe(404);
  });

  it("holds the IP guess limit across friend keys", async () => {
    const keys = Array.from({ length: IP_LIMIT + 3 }, (_, index) => friendKey(`ip${index}`));
    for (const key of keys) {
      expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
    }
    const results = await Promise.all(
      keys.map((key) => invoke("/v1/friends/codes/lookup", {
        friend: key,
        ip: "203.0.113.10",
        body: { code: "BBBBBBBB" },
      })),
    );
    expect(results.filter((result) => result.status === 404)).toHaveLength(IP_LIMIT);
    expect(results.filter((result) => result.status === 429)).toHaveLength(3);
  });

  it("resets and blocks on the Durable Object without a distinct blocked error", async () => {
    const key = friendKey("limitops");
    expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
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
    expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
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
    const later = await invoke("/v1/friends/decline", { friend: friendKey("later"), body: { ownerId: "k3mR9xQ2nB8wL4pT6vYs1A" } });
    expect(later.status).toBe(404);
    expect(later.json).toEqual({ error: "unknown_route" });

    const key = friendKey("nobind");
    env.FRIEND_GUESSES = undefined;
    const minted = await invoke("/v1/friends/code", { friend: key });
    expect(minted.status).toBe(200);
    const codeKey = `fr:code:${minted.json.code}`;
    let codeReads = 0;
    const get = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (name) => {
      if (name === codeKey) codeReads += 1;
      return get(name);
    };
    const unbound = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: minted.json.code } });
    expect(unbound.status).toBe(503);
    expect(unbound.json).toEqual({ error: "guess_limiter_not_configured" });
    expect(codeReads).toBe(0);
    env.BOARDS = undefined;
    const noBoards = await invoke("/v1/friends/code", { friend: key });
    expect(noBoards.status).toBe(503);
    expect(noBoards.json).toEqual({ error: "boards_not_configured" });
  });

  it("does not clear the guess counter when the code is reset", async () => {
    const key = friendKey("keep");
    const minted = await invoke("/v1/friends/code", { friend: key });
    expect(minted.status).toBe(200);
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      const miss = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "EEEEEEEE" } });
      expect(miss.status).toBe(404);
    }
    const reset = await invoke("/v1/friends/code/reset", { friend: key });
    expect(reset.status).toBe(200);
    const still = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: reset.json.code } });
    expect(still.status).toBe(429);
    expect(still.json).toEqual({ error: "rate_limited" });
  });

  it("does not read a code after the guess limit is spent", async () => {
    const key = friendKey("noread");
    const minted = await invoke("/v1/friends/code", { friend: key });
    const codeKey = `fr:code:${minted.json.code}`;
    let reads = 0;
    const get = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (name) => {
      if (name === codeKey) reads += 1;
      return get(name);
    };
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      const hit = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: minted.json.code } });
      expect(hit.status).toBe(200);
    }
    const before = reads;
    const limited = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: minted.json.code } });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect(reads).toBe(before);
  });

  it("rejects an understated body by its UTF-8 size", async () => {
    const key = friendKey("bytes");
    expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
    const raw = `{"code":"${"é".repeat(2037)}"}`;
    expect(raw.length).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(2048);
    const huge = await invoke("/v1/friends/codes/lookup", {
      friend: key,
      body: raw,
      headers: { "Content-Length": "100" },
    });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "payload_too_large" });
    const miss = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "FFFFFFFF" } });
    expect(miss.status).toBe(404);
  });

  it("keeps the stored ownerId when the code is reset", async () => {
    const key = friendKey("owner");
    const first = await invoke("/v1/friends/code", { friend: key, body: {} });
    expect(first.status).toBe(200);
    const reset = await invoke("/v1/friends/code/reset", { friend: key, body: {} });
    expect(reset.status).toBe(200);
    expect(reset.json.ownerId).toBe(first.json.ownerId);
    const authKey = [...kv.keys()].find((name) => name.startsWith("fr:k:"));
    expect(JSON.parse(kv.get(authKey).value)).toEqual({
      ownerId: first.json.ownerId,
      code: reset.json.code,
    });
    expect(kv.get(`fr:code:${reset.json.code}`).value).toBe(first.json.ownerId);
  });

  it("rejects unknown fields on getCode and resetCode", async () => {
    const key = friendKey("extra");
    const extra = await invoke("/v1/friends/code", { friend: key, body: { name: "Ada" } });
    expect(extra.status).toBe(400);
    expect(extra.json).toEqual({ error: "invalid_body" });
    expect([...kv.keys()]).toEqual([]);

    const minted = await invoke("/v1/friends/code", { friend: key, body: {} });
    expect(minted.status).toBe(200);
    const reset = await invoke("/v1/friends/code/reset", { friend: key, body: { code: minted.json.code } });
    expect(reset.status).toBe(400);
    expect(reset.json).toEqual({ error: "invalid_body" });
    const again = await invoke("/v1/friends/code", { friend: key });
    expect(again.status).toBe(200);
    expect(again.json.code).toBe(minted.json.code);
  });

  it("returns the exact remaining Retry-After inside the open window", async () => {
    const limiter = new FriendGuessLimiter(sqliteState("key:retry"), {});
    const start = 1_700_000_000_000;
    async function attempt(now) {
      const response = await limiter.fetch(new Request("https://friend-guess.internal/limit", {
        method: "POST",
        body: JSON.stringify({ op: "attempt", now }),
      }));
      return response.json();
    }
    for (let i = 0; i < KEY_LIMIT; i += 1) expect(await attempt(start)).toEqual({ ok: true });
    // 1500 ms into a 3600 s window: ceil((3600000 - 1500) / 1000) = 3599.
    expect(await attempt(start + 1500)).toEqual({ ok: false, retryAfterSec: 3599 });

    const key = friendKey("retry");
    expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
    const realNow = Date.now;
    Date.now = () => start;
    try {
      for (let i = 0; i < KEY_LIMIT; i += 1) {
        const miss = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "HHHHHHHH" } });
        expect(miss.status).toBe(404);
      }
      Date.now = () => start + 1500;
      const limited = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "HHHHHHHH" } });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("3599");
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects a 32-character friend key with the install-id shape", async () => {
    // Long enough for FRIEND_KEY_RE, and only the install-id shape check rejects it.
    const shaped = `id_1234567890_${"a".repeat(18)}`;
    expect(shaped).toHaveLength(32);
    const rejected = await invoke("/v1/friends/code", { friend: shaped, body: {} });
    expect(rejected.status).toBe(401);
    expect(rejected.json).toEqual({ error: "friend_key_required" });
    expect([...kv.keys()]).toEqual([]);
    const plain = await invoke("/v1/friends/code", { friend: "a".repeat(32), body: {} });
    expect(plain.status).toBe(200);
  });

  it("binds the SQLite guess limiter and advertises PUT on friend CORS", () => {
    const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain('name = "FRIEND_GUESSES"');
    expect(toml).toContain('class_name = "FriendGuessLimiter"');
    expect(toml).toContain('tag = "v2-friend-guesses"');
    expect(toml).toMatch(/new_sqlite_classes = \["FriendGuessLimiter"\]/);
    expect(toml).not.toMatch(/^\s*new_classes\s*=/m);
    expect(toml).toContain('binding = "BOARDS"');
  });

  it("serves getCode from the deploy entry", async () => {
    const key = friendKey("entry");
    const response = await entry.fetch(new Request(`${ORIGIN}/v1/friends/code`, {
      method: "POST",
      headers: { "X-Friend-Key": key, "Content-Type": "application/json" },
      body: "{}",
    }), env, { waitUntil() {} });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toMatch(CODE_RE);
    expect(body.ownerId).toMatch(OWNER_RE);
  });

  it("answers the friends preflight without a friend key", async () => {
    const options = await invoke("/v1/friends/code", { method: "OPTIONS" });
    expect(options.status).toBe(200);
    expect(options.text).toBe("");
    expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,PUT,OPTIONS");
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("X-Friend-Key");
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("X-Install-Id");
    const unknown = await invoke("/v1/friends/decline", { method: "OPTIONS" });
    expect(unknown.status).toBe(200);
    expect(unknown.text).toBe("");
    const reports = await invoke("/v1/course-reports", { method: "OPTIONS" });
    expect(reports.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,OPTIONS");
  });

  function rows(prefix) {
    return [...kv.keys()].filter((name) => name.startsWith(prefix)).sort();
  }

  function kvSnapshot() {
    return [...kv.entries()].map(([key, row]) => `${key}=${row.value}`).sort();
  }

  async function mint(suffix) {
    const key = friendKey(suffix);
    const created = await invoke("/v1/friends/code", { friend: key, body: {} });
    expect(created.status).toBe(200);
    return { key, code: created.json.code, ownerId: created.json.ownerId };
  }

  it("quiet block looks like a sent request and stores a sender-only note", async () => {
    const opener = await mint("quiet-opener");
    const inviter = await mint("quiet-inviter");
    const controlFrom = await mint("quiet-from");
    const controlTo = await mint("quiet-to");
    await befriend(opener, inviter);
    const blocked = await invoke("/v1/friends/block", { friend: inviter.key, body: { ownerId: opener.ownerId } });
    expect(blocked.status).toBe(200);
    expect(blocked.json).toEqual({ ok: true });
    await renew(inviter);

    const real = await invoke("/v1/friends/requests", { friend: controlFrom.key, body: { code: controlTo.code } });
    const quiet = await invoke("/v1/friends/requests", {
      friend: opener.key,
      body: { code: inviter.code },
      headers: { "X-Display-Name": DISPLAY_NAME, "X-Install-Id": INSTALL_ID },
    });
    expect(quiet.status).toBe(real.status);
    expect(quiet.status).toBe(200);
    expect(Object.keys(quiet.json)).toEqual(Object.keys(real.json));
    expect(quiet.json).toEqual({ status: "pending", ownerId: inviter.ownerId });
    expect(real.json).toEqual({ status: "pending", ownerId: controlTo.ownerId });
    expect(quiet.headers.get("Content-Type")).toBe(real.headers.get("Content-Type"));
    expect(quiet.headers.get("Cache-Control")).toBe("no-store");
    expect(quiet.text).not.toContain("blocked");
    expect(quiet.text).not.toContain("error");
    expect(rows("fr:req:")).toEqual([`fr:req:${controlTo.ownerId}:${controlFrom.ownerId}`]);
    expect(kv.has(`fr:req:${inviter.ownerId}:${opener.ownerId}`)).toBe(false);
    expect(kv.get(`fr:out:${opener.ownerId}:${inviter.ownerId}`).value).toBe("pending");
    expect(kv.get(`fr:out:${opener.ownerId}:${inviter.ownerId}`).expirationTtl).toBeUndefined();

    const told = await invoke("/v1/friends/requests/accept", { friend: opener.key, body: { ownerId: inviter.ownerId } });
    expect(told.status).toBe(409);
    expect(told.json).toEqual({ error: "not_friends" });
    expect(told.text).not.toContain("blocked");
    expect(rows("fr:friend:")).toEqual([]);
    assertAnonymous(quiet.text + told.text + blocked.text);
  });

  it("opener gets 409 blocked when they have blocked the inviter", async () => {
    const opener = await mint("open-opener");
    const inviter = await mint("open-inviter");
    await befriend(inviter, opener);
    expect(kv.has(`fr:friend:${opener.ownerId}:${inviter.ownerId}`)).toBe(true);

    const blocked = await invoke("/v1/friends/block", { friend: opener.key, body: { ownerId: inviter.ownerId } });
    expect(blocked.json).toEqual({ ok: true });
    expect(kv.has(`fr:req:${opener.ownerId}:${inviter.ownerId}`)).toBe(false);
    expect(kv.has(`fr:req:${inviter.ownerId}:${opener.ownerId}`)).toBe(false);
    expect(kv.get(`fr:block:${opener.ownerId}:${inviter.ownerId}`).value).toBe("1");

    const opened = await invoke("/v1/friends/requests/accept", { friend: opener.key, body: { ownerId: inviter.ownerId } });
    expect(opened.status).toBe(409);
    expect(opened.json).toEqual({ error: "blocked" });
    expect(rows("fr:friend:")).toEqual([]);

    const again = await invoke("/v1/friends/requests", { friend: opener.key, body: { code: inviter.code } });
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "blocked" });
    expect(rows("fr:req:")).toEqual([]);
  });

  it("unblocking someone you never blocked writes nothing", async () => {
    const caller = await mint("noop-caller");
    const other = await mint("noop-other");
    const missing = "zzzzzzzzzzzzzzzzzzzzzz";
    const before = kvSnapshot();
    const unknown = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: missing } });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toEqual({ ok: true });
    expect(unknown.text).not.toContain(missing);
    expect(kvSnapshot()).toEqual(before);
    const never = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(never.status).toBe(200);
    expect(never.json).toEqual({ ok: true });
    expect(never.text).not.toContain("blocked");
    expect(kvSnapshot()).toEqual(before);
    expect(rows("fr:block:")).toEqual([]);
  });

  it("after unblock neither side is friends or has a pending request", async () => {
    const left = await mint("gone-left");
    const right = await mint("gone-right");
    const sent = await invoke("/v1/friends/requests", { friend: left.key, body: { code: right.code } });
    expect(sent.json).toEqual({ status: "pending", ownerId: right.ownerId });
    const accepted = await invoke("/v1/friends/requests/accept", { friend: right.key, body: { ownerId: left.ownerId } });
    expect(accepted.json).toEqual({ status: "friends", ownerId: left.ownerId });
    expect(kv.has(`fr:friend:${left.ownerId}:${right.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${right.ownerId}:${left.ownerId}`)).toBe(true);
    const bystander = "c".repeat(22);
    kv.set(`fr:rounds:${left.ownerId}`, { value: "[{\"id\":\"round_left\"}]" });
    kv.set(`fr:rounds:${right.ownerId}`, { value: "[{\"id\":\"round_right\"}]" });
    kv.set(`fr:rounds:${bystander}`, { value: "[{\"id\":\"round_other\"}]" });
    kv.set("id:14322", { value: "{\"holes\":1}" });

    const blocked = await invoke("/v1/friends/block", { friend: left.key, body: { ownerId: right.ownerId } });
    expect(blocked.json).toEqual({ ok: true });
    expect(rows("fr:friend:")).toEqual([]);
    expect(rows("fr:req:")).toEqual([]);
    // Build 169 (Brian, Oct 23): block ends only this friendship; the caller's rounds stay for everyone else.
    expect(kv.get(`fr:rounds:${left.ownerId}`).value).toBe("[{\"id\":\"round_left\"}]");
    expect(kv.get(`fr:rounds:${right.ownerId}`).value).toBe("[{\"id\":\"round_right\"}]");
    expect(kv.get(`fr:rounds:${bystander}`).value).toBe("[{\"id\":\"round_other\"}]");
    expect(kv.get("id:14322").value).toBe("{\"holes\":1}");
    expect(kv.has(`fr:code:${left.code}`)).toBe(true);
    expect(kv.has(`fr:code:${right.code}`)).toBe(true);

    const cleared = await invoke("/v1/friends/unblock", { friend: left.key, body: { ownerId: right.ownerId } });
    expect(cleared.json).toEqual({ ok: true });
    expect(rows("fr:friend:")).toEqual([]);
    expect(rows("fr:req:")).toEqual([]);
    expect(rows("fr:block:")).toEqual([]);
    // Build 169 (Brian, Oct 23): block ends only this friendship; the caller's rounds stay for everyone else.
    expect(kv.get(`fr:rounds:${left.ownerId}`).value).toBe("[{\"id\":\"round_left\"}]");
    expect(kv.get(`fr:rounds:${right.ownerId}`).value).toBe("[{\"id\":\"round_right\"}]");
    expect(kv.get(`fr:rounds:${bystander}`).value).toBe("[{\"id\":\"round_other\"}]");
    const still = await invoke("/v1/friends/requests/accept", { friend: right.key, body: { ownerId: left.ownerId } });
    expect(still.status).toBe(409);
    expect(still.json).toEqual({ error: "not_friends" });
    const looker = friendKey("gone-look");
    expect((await invoke("/v1/friends/code", { friend: looker, body: {} })).status).toBe(200);
    const lookup = await invoke("/v1/friends/codes/lookup", { friend: looker, body: { code: left.code } });
    expect(lookup.status).toBe(200);
    expect(lookup.json).toEqual({ ownerId: left.ownerId });
  });

  it("unblock removes only the caller's block", async () => {
    const caller = await mint("only-caller");
    const other = await mint("only-other");
    await befriend(other, caller);
    expect((await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } })).json).toEqual({ ok: true });
    kv.set(`fr:block:${other.ownerId}:${caller.ownerId}`, { value: "1" });
    const callerBlock = `fr:block:${caller.ownerId}:${other.ownerId}`;
    const otherBlock = `fr:block:${other.ownerId}:${caller.ownerId}`;
    expect(kv.get(callerBlock).value).toBe("1");
    expect(kv.get(otherBlock).value).toBe("1");

    const cleared = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(cleared.json).toEqual({ ok: true });
    expect(kv.has(callerBlock)).toBe(false);
    expect(kv.get(otherBlock).value).toBe("1");

    const quiet = await invoke("/v1/friends/requests", { friend: caller.key, body: { code: other.code } });
    expect(quiet.status).toBe(200);
    expect(quiet.json).toEqual({ status: "pending", ownerId: other.ownerId });
    expect(quiet.text).not.toContain("blocked");
    expect(kv.has(`fr:req:${other.ownerId}:${caller.ownerId}`)).toBe(false);
    await renew(caller);

    const refused = await invoke("/v1/friends/requests", { friend: other.key, body: { code: caller.code } });
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "blocked" });
  });

  it("after unblock a request from the blocked person is stored and can be accepted", async () => {
    const caller = await mint("again-caller");
    const other = await mint("again-other");
    await befriend(other, caller);
    expect((await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } })).status).toBe(200);
    await renew(caller);
    const hidden = await invoke("/v1/friends/requests", { friend: other.key, body: { code: caller.code } });
    expect(hidden.status).toBe(200);
    expect(hidden.json).toEqual({ status: "pending", ownerId: caller.ownerId });
    expect(rows("fr:req:")).toEqual([]);

    const cleared = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(cleared.json).toEqual({ ok: true });
    const sent = await invoke("/v1/friends/requests", { friend: other.key, body: { code: caller.code } });
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ status: "pending", ownerId: caller.ownerId });
    expect(kv.get(`fr:req:${caller.ownerId}:${other.ownerId}`).value).toBe("pending");
    expect(rows("fr:req:")).toEqual([`fr:req:${caller.ownerId}:${other.ownerId}`]);

    const accepted = await invoke("/v1/friends/requests/accept", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ status: "friends", ownerId: other.ownerId });
    expect(kv.has(`fr:friend:${caller.ownerId}:${other.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${other.ownerId}:${caller.ownerId}`)).toBe(true);
    expect(rows("fr:req:")).toEqual([]);

    const repeat = await invoke("/v1/friends/requests", { friend: other.key, body: { code: caller.code } });
    expect(repeat.json).toEqual({ status: "friends", ownerId: caller.ownerId, already: "friends" });
    expect(rows("fr:req:")).toEqual([]);
  });

  it("unblock does not consume a code guess", async () => {
    const caller = await mint("guess-caller");
    const other = await mint("guess-other");
    await befriend(other, caller);
    await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } });
    for (let i = 0; i < KEY_LIMIT - 1; i += 1) {
      const miss = await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "NNNNNNNN" } });
      expect(miss.status).toBe(404);
    }
    for (let i = 0; i < KEY_LIMIT + 4; i += 1) {
      const cleared = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: other.ownerId } });
      expect(cleared.status).toBe(200);
      expect(cleared.json).toEqual({ ok: true });
    }
    const eighth = await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "NNNNNNNN" } });
    expect(eighth.status).toBe(404);
    const ninth = await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "NNNNNNNN" } });
    expect(ninth.status).toBe(429);
    expect(ninth.json).toEqual({ error: "rate_limited" });

    const ip = "203.0.113.44";
    for (let i = 0; i < IP_LIMIT - 1; i += 1) {
      const friend = friendKey(`ipg${i}`);
      expect((await invoke("/v1/friends/code", { friend, body: {} })).status).toBe(200);
      const miss = await invoke("/v1/friends/codes/lookup", {
        friend,
        ip,
        body: { code: "PPPPPPPP" },
      });
      expect(miss.status).toBe(404);
    }
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const cleared = await invoke("/v1/friends/unblock", {
        friend: caller.key,
        ip,
        body: { ownerId: other.ownerId },
      });
      expect(cleared.status).toBe(200);
    }
    const lastKey = friendKey("ipg-last");
    const overKey = friendKey("ipg-over");
    expect((await invoke("/v1/friends/code", { friend: lastKey, body: {} })).status).toBe(200);
    expect((await invoke("/v1/friends/code", { friend: overKey, body: {} })).status).toBe(200);
    const lastIp = await invoke("/v1/friends/codes/lookup", {
      friend: lastKey,
      ip,
      body: { code: "PPPPPPPP" },
    });
    expect(lastIp.status).toBe(404);
    const overIp = await invoke("/v1/friends/codes/lookup", {
      friend: overKey,
      ip,
      body: { code: "PPPPPPPP" },
    });
    expect(overIp.status).toBe(429);
    expect(overIp.json).toEqual({ error: "rate_limited" });
  });

  it("unblock does not reset the limiter, read a code, or require the limiter", async () => {
    const caller = await mint("reset-caller");
    const other = await mint("reset-other");
    await befriend(other, caller);
    await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } });
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      expect((await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "QQQQQQQQ" } })).status).toBe(404);
    }
    expect((await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "QQQQQQQQ" } })).status).toBe(429);
    let codeReads = 0;
    const get = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (name) => {
      if (String(name).startsWith("fr:code:")) codeReads += 1;
      return get(name);
    };
    const cleared = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ ok: true });
    expect(codeReads).toBe(0);
    const still = await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "QQQQQQQQ" } });
    expect(still.status).toBe(429);
    expect(still.json).toEqual({ error: "rate_limited" });

    const fresh = await mint("reset-fresh");
    const target = await mint("reset-target");
    await befriend(target, fresh);
    await invoke("/v1/friends/block", { friend: fresh.key, body: { ownerId: target.ownerId } });
    env.FRIEND_GUESSES = undefined;
    codeReads = 0;
    const unbound = await invoke("/v1/friends/unblock", { friend: fresh.key, body: { ownerId: target.ownerId } });
    expect(unbound.status).toBe(200);
    expect(unbound.json).toEqual({ ok: true });
    expect(codeReads).toBe(0);
    expect(kv.has(`fr:block:${fresh.ownerId}:${target.ownerId}`)).toBe(false);
    expect(kv.has(`fr:code:${fresh.code}`)).toBe(true);
  });

  it("sendRequest spends a guess and hides a block once the caller is limited", async () => {
    const opener = await mint("hide-opener");
    const inviter = await mint("hide-inviter");
    const blockedPerson = await mint("hide-quiet");
    await befriend(inviter, opener);
    await renew(opener);
    await befriend(blockedPerson, opener);
    await invoke("/v1/friends/block", { friend: opener.key, body: { ownerId: inviter.ownerId } });
    await invoke("/v1/friends/block", { friend: opener.key, body: { ownerId: blockedPerson.ownerId } });
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      expect((await invoke("/v1/friends/codes/lookup", { friend: opener.key, body: { code: "RRRRRRRR" } })).status).toBe(404);
    }
    let codeReads = 0;
    const get = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (name) => {
      if (String(name).startsWith("fr:code:")) codeReads += 1;
      return get(name);
    };
    const limited = await invoke("/v1/friends/requests", { friend: opener.key, body: { code: inviter.code } });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect(limited.text).not.toContain("blocked");
    expect(codeReads).toBe(0);

    for (let i = 0; i < KEY_LIMIT - 1; i += 1) {
      expect((await invoke("/v1/friends/codes/lookup", { friend: blockedPerson.key, body: { code: "TTTTTTTT" } })).status).toBe(404);
    }
    const quietLimited = await invoke("/v1/friends/requests", { friend: blockedPerson.key, body: { code: opener.code } });
    expect(quietLimited.status).toBe(429);
    expect(quietLimited.json).toEqual({ error: "rate_limited" });
    expect(quietLimited.text).not.toContain("blocked");

    const own = await mint("hide-own");
    codeReads = 0;
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      const bad = await invoke("/v1/friends/requests", { friend: own.key, body: { code: own.code } });
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: "invalid_body" });
    }
    expect(codeReads).toBe(0);
    const still = await invoke("/v1/friends/codes/lookup", { friend: own.key, body: { code: "SSSSSSSS" } });
    expect(still.status).toBe(404);
  });

  it("does not store a second pending request", async () => {
    const from = await mint("dup-from");
    const to = await mint("dup-to");
    const first = await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code } });
    const second = await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code } });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ ...first.json, already: "outgoing" });
    expect(rows("fr:req:")).toEqual([`fr:req:${to.ownerId}:${from.ownerId}`]);
    const named = await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code, name: DISPLAY_NAME } });
    expect(named.status).toBe(400);
    expect(named.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:req:")).toHaveLength(1);
  });

  it("block and unblock reject a bad body before changing a block", async () => {
    const caller = await mint("body-caller");
    const other = await mint("body-other");
    await befriend(other, caller);
    expect((await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } })).status).toBe(200);
    const blockKey = `fr:block:${caller.ownerId}:${other.ownerId}`;
    const named = await invoke("/v1/friends/unblock", {
      friend: caller.key,
      body: { ownerId: other.ownerId, name: DISPLAY_NAME },
    });
    expect(named.status).toBe(400);
    expect(named.json).toEqual({ error: "invalid_body" });
    expect(kv.get(blockKey).value).toBe("1");
    const huge = await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: "x".repeat(3000) } });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "payload_too_large" });
    expect(kv.get(blockKey).value).toBe("1");
    const self = await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: caller.ownerId } });
    expect(self.status).toBe(400);
    expect(self.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:block:")).toEqual([blockKey]);
    const method = await invoke("/v1/friends/unblock", { method: "DELETE", friend: caller.key });
    expect(method.status).toBe(405);
    expect(method.json).toEqual({ error: "method_not_allowed" });
    expect(kv.get(blockKey).value).toBe("1");
    const missing = await invoke("/v1/friends/block", {});
    expect(missing.status).toBe(401);
    expect(missing.json).toEqual({ error: "friend_key_required" });
    env.BOARDS = undefined;
    const down = await invoke("/v1/friends/unblock", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(down.status).toBe(503);
    expect(down.json).toEqual({ error: "boards_not_configured" });
  });

  it("serves block and unblock from the deploy entry", async () => {
    const caller = await mint("entry-block");
    const other = await mint("entry-other");
    await befriend(other, caller);
    const response = await entry.fetch(new Request(`${ORIGIN}/v1/friends/block`, {
      method: "POST",
      headers: { "X-Friend-Key": caller.key, "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: other.ownerId }),
    }), env, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(kv.get(`fr:block:${caller.ownerId}:${other.ownerId}`).value).toBe("1");
    const cleared = await entry.fetch(new Request(`${ORIGIN}/v1/friends/unblock`, {
      method: "POST",
      headers: { "X-Friend-Key": caller.key, "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: other.ownerId }),
    }), env, { waitUntil() {} });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(kv.has(`fr:block:${caller.ownerId}:${other.ownerId}`)).toBe(false);
  });

  function baseRound(overrides = {}) {
    return {
      id: "round_7Kp2",
      courseName: "Greystone",
      playedOn: "2026-10-11",
      gross: 82,
      toPar: 10,
      holes: [
        { hole: 1, score: 4, par: 4 },
        { hole: 2, score: 6, par: 5 },
      ],
      ...overrides,
    };
  }

  function putRound(friend, round) {
    return invoke("/v1/friends/rounds", { method: "PUT", friend, body: { share: true, round } });
  }

  function fetchRounds(friend, headers) {
    return invoke("/v1/friends/rounds", { method: "GET", friend, headers });
  }

  async function befriend(from, to) {
    const sent = await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code } });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    const accepted = await invoke("/v1/friends/requests/accept", { friend: to.key, body: { ownerId: from.ownerId } });
    expect(accepted.json).toEqual({ status: "friends", ownerId: from.ownerId });
  }

  // Accept spends the code. A later invite from the same person is a new code.
  async function renew(person) {
    const reset = await invoke("/v1/friends/code/reset", { friend: person.key, body: {} });
    expect(reset.status).toBe(200);
    person.code = reset.json.code;
  }

  function roundsKey(ownerId) {
    return `fr:rounds:${ownerId}`;
  }

  function storedRounds(ownerId) {
    const row = kv.get(roundsKey(ownerId));
    if (!row) return [];
    return JSON.parse(row.value);
  }

  function hasRound(ownerId, id) {
    return storedRounds(ownerId).some((round) => round && round.id === id);
  }

  it("cancel withdraws only the caller's own sent request", async () => {
    const sender = await mint("cx-sender");
    const target = await mint("cx-target");
    const other = await mint("cx-other");
    await invoke("/v1/friends/requests", { friend: sender.key, body: { code: target.code } });
    await invoke("/v1/friends/requests", { friend: other.key, body: { code: target.code } });
    await invoke("/v1/friends/requests", { friend: target.key, body: { code: sender.code } });
    expect(kv.has(`fr:req:${target.ownerId}:${sender.ownerId}`)).toBe(true);
    const cancelled = await invoke("/v1/friends/requests/cancel", { friend: sender.key, body: { ownerId: target.ownerId } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual({ ok: true });
    expect(kv.has(`fr:req:${target.ownerId}:${sender.ownerId}`)).toBe(false);
    // The other sender's request and the reverse request are untouched.
    expect(kv.has(`fr:req:${target.ownerId}:${other.ownerId}`)).toBe(true);
    // The reverse send was merged into the sender's pending request, so it never stored a row.
    expect(kv.has(`fr:req:${sender.ownerId}:${target.ownerId}`)).toBe(false);
    const late = await invoke("/v1/friends/requests/accept", { friend: target.key, body: { ownerId: sender.ownerId } });
    expect(late.status).toBe(409);
    expect(late.json).toEqual({ error: "not_friends" });
    const again = await invoke("/v1/friends/requests/cancel", { friend: sender.key, body: { ownerId: target.ownerId } });
    expect(again.status).toBe(200);
  });

  it("cancel keeps friendships and validates its body", async () => {
    const left = await mint("cx-left");
    const right = await mint("cx-right");
    await befriend(left, right);
    const before = kvSnapshot();
    const cancelled = await invoke("/v1/friends/requests/cancel", { friend: left.key, body: { ownerId: right.ownerId } });
    expect(cancelled.status).toBe(200);
    expect(kvSnapshot()).toEqual(before);
    const empty = await invoke("/v1/friends/requests/cancel", { friend: left.key, body: {} });
    expect(empty.status).toBe(400);
    const extra = await invoke("/v1/friends/requests/cancel", { friend: left.key, body: { ownerId: right.ownerId, x: 1 } });
    expect(extra.status).toBe(400);
    const self = await invoke("/v1/friends/requests/cancel", { friend: left.key, body: { ownerId: left.ownerId } });
    expect(self.status).toBe(400);
    const nokey = await invoke("/v1/friends/requests/cancel", { body: { ownerId: right.ownerId } });
    expect(nokey.status).toBe(401);
  });

  function deleteRounds(friend, body) {
    return invoke("/v1/friends/rounds/delete", { method: "POST", friend, body });
  }

  it("deletes only the caller's named rounds, shared or past, and retries are fine", async () => {
    const caller = await mint("del-caller");
    const pal = await mint("del-pal");
    await befriend(pal, caller);
    expect((await putRound(caller.key, baseRound({ id: "round_keep" }))).status).toBe(200);
    expect((await putRound(caller.key, baseRound({ id: "round_gone", courseName: "Pine Hollow" }))).status).toBe(200);
    expect((await putRound(caller.key, baseRound({ id: "round_dup", courseName: "Pine Hollow North" }))).status).toBe(200);
    expect((await putRound(pal.key, baseRound({ id: "round_gone" }))).status).toBe(200);
    const past = await invoke("/v1/friends/past", {
      method: "PUT",
      friend: caller.key,
      body: { ownerId: pal.ownerId, choice: "10", rounds: [baseRound({ id: "round_past" })] },
    });
    expect(past.status).toBe(200);
    expect(hasRound(caller.ownerId, "round_past")).toBe(true);

    const gone = await deleteRounds(caller.key, { ids: ["round_gone", "round_dup", "round_past", "round_never"] });
    expect(gone.status).toBe(200);
    expect(gone.json).toEqual({ ok: true, removed: 3 });
    expect(storedRounds(caller.ownerId).map((round) => round.id)).toEqual(["round_keep"]);
    // The friend's round with the same id is theirs and stays.
    expect(hasRound(pal.ownerId, "round_gone")).toBe(true);
    const seen = await fetchRounds(pal.key);
    expect(seen.json.rounds.filter((round) => round.ownerId === caller.ownerId).map((round) => round.id)).toEqual(["round_keep"]);

    const again = await deleteRounds(caller.key, { ids: ["round_gone"] });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, removed: 0 });

    const last = await deleteRounds(caller.key, { ids: ["round_keep"] });
    expect(last.json).toEqual({ ok: true, removed: 1 });
    expect(kv.has(roundsKey(caller.ownerId))).toBe(false);
  });

  it("rejects bad delete bodies and missing keys without writing", async () => {
    const caller = await mint("del-bad");
    expect((await putRound(caller.key, baseRound({ id: "round_safe" }))).status).toBe(200);
    const before = kvSnapshot();
    for (const body of [{}, { ids: [] }, { ids: "round_safe" }, { ids: ["bad id!"] }, { ids: [7] }, { ids: ["round_safe"], extra: 1 }, { ids: Array.from({ length: 101 }, (_, i) => `r${i}`) }]) {
      const res = await deleteRounds(caller.key, body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    }
    const noKey = await invoke("/v1/friends/rounds/delete", { method: "POST", body: { ids: ["round_safe"] } });
    expect(noKey.status).toBe(401);
    const unknownKey = await deleteRounds(friendKey("nobody"), { ids: ["round_safe"] });
    expect(unknownKey.status).toBe(401);
    const wrongMethod = await invoke("/v1/friends/rounds/delete", { method: "GET", friend: caller.key });
    expect(wrongMethod.status).toBe(405);
    expect(kvSnapshot()).toEqual(before);
  });

  it("remove without a friendship is 409 and deletes nothing", async () => {
    const caller = await mint("rm-none");
    const other = await mint("rm-other");
    const bystander = await mint("rm-bystander");
    expect((await putRound(caller.key, baseRound({ id: "round_caller" }))).status).toBe(200);
    expect((await putRound(other.key, baseRound({ id: "round_other" }))).status).toBe(200);
    expect((await putRound(bystander.key, baseRound({ id: "round_by" }))).status).toBe(200);
    const before = kvSnapshot();
    const removed = await invoke("/v1/friends/remove", {
      friend: caller.key,
      body: { ownerId: other.ownerId },
      headers: { "X-Display-Name": DISPLAY_NAME, "X-Install-Id": INSTALL_ID },
    });
    expect(removed.status).toBe(409);
    expect(removed.json).toEqual({ error: "not_friends" });
    expect(removed.text).not.toContain("blocked");
    expect(kvSnapshot()).toEqual(before);
    const unknown = "zzzzzzzzzzzzzzzzzzzzzz";
    const missing = await invoke("/v1/friends/remove", { friend: caller.key, body: { ownerId: unknown } });
    expect(missing.status).toBe(409);
    expect(missing.json).toEqual({ error: "not_friends" });
    expect(missing.text).not.toContain(unknown);
    expect(hasRound(caller.ownerId, "round_caller")).toBe(true);
    expect(hasRound(other.ownerId, "round_other")).toBe(true);
    expect(hasRound(bystander.ownerId, "round_by")).toBe(true);
    assertAnonymous(removed.text + missing.text);
  });

  it("remove requires both friendship rows", async () => {
    const caller = await mint("rm-one");
    const other = await mint("rm-two");
    kv.set(`fr:friend:${caller.ownerId}:${other.ownerId}`, { value: "1" });
    kv.set(roundsKey(other.ownerId), { value: JSON.stringify([baseRound({ id: "round_keep", ownerId: other.ownerId })]) });
    const forwardOnly = await invoke("/v1/friends/remove", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(forwardOnly.status).toBe(409);
    expect(forwardOnly.json).toEqual({ error: "not_friends" });
    expect(kv.get(`fr:friend:${caller.ownerId}:${other.ownerId}`).value).toBe("1");
    expect(hasRound(other.ownerId, "round_keep")).toBe(true);
    kv.delete(`fr:friend:${caller.ownerId}:${other.ownerId}`);
    kv.set(`fr:friend:${other.ownerId}:${caller.ownerId}`, { value: "1" });
    const reverseOnly = await invoke("/v1/friends/remove", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(reverseOnly.status).toBe(409);
    expect(kv.get(`fr:friend:${other.ownerId}:${caller.ownerId}`).value).toBe("1");
    expect(hasRound(other.ownerId, "round_keep")).toBe(true);
  });

  it("remove ends only that friendship; everyone keeps their rounds for their other friends", async () => {
    const left = await mint("rm-left");
    const right = await mint("rm-right");
    const third = await mint("rm-third");
    const bystander = await mint("rm-watch");
    await befriend(left, right);
    await befriend(left, third);
    await renew(third);
    await befriend(right, third);
    expect((await putRound(left.key, baseRound({ id: "round_left", playedOn: "2026-10-02" }))).status).toBe(200);
    expect((await putRound(right.key, baseRound({ id: "round_right", playedOn: "2026-10-03" }))).status).toBe(200);
    expect((await putRound(third.key, baseRound({ id: "round_third", playedOn: "2026-10-04" }))).status).toBe(200);
    expect((await putRound(bystander.key, baseRound({ id: "round_by" }))).status).toBe(200);
    kv.set(`fr:req:${right.ownerId}:${left.ownerId}`, { value: "pending" });
    kv.set(`fr:block:${bystander.ownerId}:${left.ownerId}`, { value: "1" });
    const removed = await invoke("/v1/friends/remove", { friend: left.key, body: { ownerId: right.ownerId } });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ ok: true });
    expect(removed.headers.get("Cache-Control")).toBe("no-store");
    expect(kv.has(`fr:friend:${left.ownerId}:${right.ownerId}`)).toBe(false);
    expect(kv.has(`fr:friend:${right.ownerId}:${left.ownerId}`)).toBe(false);
    expect(kv.has(`fr:friend:${left.ownerId}:${third.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${third.ownerId}:${left.ownerId}`)).toBe(true);
    expect(hasRound(left.ownerId, "round_left")).toBe(true);
    expect(hasRound(right.ownerId, "round_right")).toBe(true);
    expect(hasRound(third.ownerId, "round_third")).toBe(true);
    expect(hasRound(bystander.ownerId, "round_by")).toBe(true);
    expect(kv.get(`fr:req:${right.ownerId}:${left.ownerId}`).value).toBe("pending");
    expect(kv.get(`fr:block:${bystander.ownerId}:${left.ownerId}`).value).toBe("1");
    expect(rows("fr:block:").filter((name) => name.includes(right.ownerId))).toEqual([]);
    const leftFetch = await fetchRounds(left.key);
    const rightFetch = await fetchRounds(right.key);
    const thirdFetch = await fetchRounds(third.key);
    expect(leftFetch.json.rounds.map((round) => round.id)).toEqual(["round_left", "round_third"]);
    expect(rightFetch.json.rounds.map((round) => round.id)).toEqual(["round_right", "round_third"]);
    expect(rightFetch.text).not.toContain("round_left");
    expect(thirdFetch.json.rounds.map((round) => round.id)).toEqual(["round_left", "round_right", "round_third"]);
    expect(rows("fr:round:")).toEqual([]);
  });

  it("publish rejects an unknown field and stores nothing", async () => {
    const caller = await mint("pub-unknown");
    kv.set("id:14322", { value: "{\"holes\":1}" });
    kv.set("name:greystone", { value: "{\"course\":1}" });
    const named = await putRound(caller.key, baseRound({ name: DISPLAY_NAME }));
    expect(named.status).toBe(400);
    expect(named.json).toEqual({ error: "invalid_body" });
    const noted = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: true, round: baseRound(), note: "league" },
    });
    expect(noted.status).toBe(400);
    expect(noted.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:round:")).toEqual([]);
    expect(kv.get("id:14322").value).toBe("{\"holes\":1}");
    expect(kv.get("name:greystone").value).toBe("{\"course\":1}");
    assertAnonymous(named.text);
  });

  it("publish rejects a GPS field and stores nothing", async () => {
    const caller = await mint("pub-gps");
    const fields = ["lat", "lon", "lng", "gps", "photo", "photos", "name", "playerName", "email"];
    for (const field of fields) {
      const roundLevel = await putRound(caller.key, baseRound({ [field]: "secret" }));
      expect(roundLevel.status, field).toBe(400);
      expect(roundLevel.json).toEqual({ error: "invalid_body" });
      const holeLevel = await putRound(caller.key, baseRound({
        holes: [{ hole: 1, score: 4, par: 4, [field]: field === "lat" ? 33.5 : "secret" }],
      }));
      expect(holeLevel.status, `hole ${field}`).toBe(400);
      expect(holeLevel.json).toEqual({ error: "invalid_body" });
    }
    expect(rows("fr:round:")).toEqual([]);
  });

  it("publish rejects more than 18 holes", async () => {
    const caller = await mint("pub-19");
    const holes = Array.from({ length: 19 }, (_, index) => ({ hole: index + 1, score: 4, par: 4 }));
    const published = await putRound(caller.key, baseRound({ holes }));
    expect(published.status).toBe(400);
    expect(published.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:round:")).toEqual([]);
  });

  it("publish rejects an empty hole list", async () => {
    const caller = await mint("pub-empty");
    const published = await putRound(caller.key, baseRound({ holes: [] }));
    expect(published.status).toBe(400);
    expect(published.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:round:")).toEqual([]);
  });

  it("a round may have fewer than 18 holes", async () => {
    const caller = await mint("pub-nine");
    const holes = Array.from({ length: 9 }, (_, index) => ({ hole: index + 1, score: 4, par: 4 }));
    const published = await putRound(caller.key, baseRound({ id: "round_nine", holes }));
    expect(published.status).toBe(200);
    expect(published.json).toEqual({ ok: true, id: "round_nine" });
    const stored = storedRounds(caller.ownerId).find((round) => round.id === "round_nine");
    expect(stored.holes).toHaveLength(9);
    expect(stored.holes.map((hole) => hole.hole)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(JSON.stringify(stored.holes)).not.toContain("null");
    const full = Array.from({ length: 18 }, (_, index) => ({ hole: index + 1, score: 5, par: 4 }));
    expect((await putRound(caller.key, baseRound({ id: "round_full", holes: full }))).status).toBe(200);
  });

  it("omitted fir gir putts and clubs stay omitted", async () => {
    const caller = await mint("pub-stats");
    const round = baseRound({
      id: "round_stats",
      holes: [
        { hole: 1, score: 4, par: 4, fir: true, putts: 2 },
        { hole: 2, score: 6, par: 5, fir: false, gir: true, putts: 0, clubs: ["7i", "PW"] },
      ],
    });
    const published = await putRound(caller.key, round);
    expect(published.status).toBe(200);
    const stored = storedRounds(caller.ownerId).find((round) => round.id === "round_stats");
    expect(stored.holes[0]).toEqual({ hole: 1, score: 4, par: 4, fir: true, putts: 2 });
    expect(stored.holes[0]).not.toHaveProperty("gir");
    expect(stored.holes[0]).not.toHaveProperty("clubs");
    expect(stored.holes[1]).toEqual({ hole: 2, score: 6, par: 5, fir: false, gir: true, putts: 0, clubs: ["7i", "PW"] });
    expect(JSON.stringify(stored)).not.toContain("null");
    const fetched = await fetchRounds(caller.key);
    expect(fetched.json.rounds[0].holes[0]).not.toHaveProperty("gir");
    expect(fetched.json.rounds[0].holes[0]).not.toHaveProperty("clubs");
    expect(fetched.json.rounds[0].holes[1].clubs).toEqual(["7i", "PW"]);
  });

  it("a null stat is invalid_body", async () => {
    const caller = await mint("pub-null");
    for (const extra of [{ fir: null }, { gir: null }, { putts: null }, { clubs: null }]) {
      const published = await putRound(caller.key, baseRound({ holes: [{ hole: 1, score: 4, par: 4, ...extra }] }));
      expect(published.status).toBe(400);
      expect(published.json).toEqual({ error: "invalid_body" });
    }
    expect(rows("fr:round:")).toEqual([]);
  });

  it("a client ownerId must match the friend key", async () => {
    const caller = await mint("pub-owner");
    const other = await mint("pub-owner-other");
    const mismatch = await putRound(caller.key, baseRound({ ownerId: other.ownerId }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:round:")).toEqual([]);
    const matched = await putRound(caller.key, baseRound({ ownerId: caller.ownerId, id: "round_match" }));
    expect(matched.status).toBe(200);
    const omitted = await putRound(caller.key, baseRound({ id: "round_omit" }));
    expect(omitted.status).toBe(200);
    const stored = storedRounds(caller.ownerId).find((round) => round.id === "round_omit");
    expect(stored.ownerId).toBe(caller.ownerId);
    expect(stored.ownerId).not.toBe(other.ownerId);
    expect(Object.keys(stored)).toEqual(["id", "ownerId", "courseName", "playedOn", "gross", "toPar", "holes"]);
  });

  it("share false with a round is invalid and deletes nothing", async () => {
    const caller = await mint("unshare-bad");
    expect((await putRound(caller.key, baseRound({ id: "round_keep" }))).status).toBe(200);
    const rejected = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: false, round: baseRound({ id: "round_keep" }) },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toEqual({ error: "invalid_body" });
    expect(hasRound(caller.ownerId, "round_keep")).toBe(true);
    const missing = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: false },
    });
    expect(missing.status).toBe(400);
    expect(hasRound(caller.ownerId, "round_keep")).toBe(true);
  });

  it("share true with a null round is invalid", async () => {
    const caller = await mint("pub-null-round");
    const rejected = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: true, round: null },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toEqual({ error: "invalid_body" });
    const text = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: "true", round: baseRound() },
    });
    expect(text.status).toBe(400);
    expect(rows("fr:round:")).toEqual([]);
  });

  it("unshare deletes only the caller's rounds", async () => {
    const caller = await mint("unshare-me");
    const friend = await mint("unshare-friend");
    await befriend(caller, friend);
    expect((await putRound(caller.key, baseRound({ id: "round_me" }))).status).toBe(200);
    expect((await putRound(caller.key, baseRound({ id: "round_me_2" }))).status).toBe(200);
    expect((await putRound(friend.key, baseRound({ id: "round_them" }))).status).toBe(200);
    const cleared = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: false, round: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ ok: true });
    expect(rows("fr:rounds:")).toEqual([roundsKey(friend.ownerId)]);
    expect(hasRound(friend.ownerId, "round_them")).toBe(true);
    expect(kv.has(`fr:friend:${caller.ownerId}:${friend.ownerId}`)).toBe(true);
    const alone = await mint("unshare-alone");
    expect((await putRound(alone.key, baseRound({ id: "round_alone" }))).status).toBe(200);
    const solo = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: alone.key,
      body: { share: false, round: null },
    });
    expect(solo.json).toEqual({ ok: true });
    expect(kv.has(roundsKey(alone.ownerId))).toBe(false);
  });

  it("publishing does not create a friendship", async () => {
    const from = await mint("pub-pend-from");
    const to = await mint("pub-pend-to");
    expect((await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code } })).json.status).toBe("pending");
    const published = await putRound(from.key, baseRound({ id: "round_pending" }));
    expect(published.status).toBe(200);
    expect(rows("fr:friend:")).toEqual([]);
    expect(rows("fr:req:")).toEqual([`fr:req:${to.ownerId}:${from.ownerId}`]);
    const fetched = await fetchRounds(to.key);
    expect(fetched.json).toEqual({ rounds: [] });
    const own = await fetchRounds(from.key);
    expect(own.json.rounds.map((round) => round.id)).toEqual(["round_pending"]);
  });

  it("a non-friend fetch returns only the caller's rounds", async () => {
    const caller = await mint("fetch-me");
    const stranger = await mint("fetch-stranger");
    expect((await putRound(caller.key, baseRound({ id: "round_me" }))).status).toBe(200);
    expect((await putRound(stranger.key, baseRound({ id: "round_them", playedOn: "2026-09-01" }))).status).toBe(200);
    const fetched = await fetchRounds(caller.key);
    expect(fetched.status).toBe(200);
    expect(Object.keys(fetched.json)).toEqual(["rounds"]);
    expect(fetched.json.rounds.map((round) => round.id)).toEqual(["round_me"]);
    expect(fetched.json.rounds.map((round) => round.ownerId)).toEqual([caller.ownerId]);
    expect(fetched.headers.get("Cache-Control")).toBe("no-store");
    expect(fetched.text).not.toContain(stranger.key);
    expect(fetched.text).not.toContain("round_them");
  });

  it("a one-sided friendship cannot fetch", async () => {
    const caller = await mint("fetch-side");
    const other = await mint("fetch-other-side");
    expect((await putRound(other.key, baseRound({ id: "round_hidden" }))).status).toBe(200);
    kv.set(`fr:friend:${caller.ownerId}:${other.ownerId}`, { value: "1" });
    const fetched = await fetchRounds(caller.key);
    expect(fetched.json.rounds).toEqual([]);
    expect(hasRound(other.ownerId, "round_hidden")).toBe(true);
  });

  it("only accepted friends can fetch each other's rounds", async () => {
    const left = await mint("fetch-left");
    const right = await mint("fetch-right");
    const far = await mint("fetch-far");
    expect((await putRound(left.key, baseRound({ id: "round_left", playedOn: "2026-10-03" }))).status).toBe(200);
    const before = await fetchRounds(right.key);
    expect(before.json.rounds).toEqual([]);
    await befriend(left, right);
    await befriend(right, far);
    expect((await putRound(right.key, baseRound({ id: "round_right", playedOn: "2026-10-01" }))).status).toBe(200);
    expect((await putRound(far.key, baseRound({ id: "round_far", playedOn: "2026-10-02" }))).status).toBe(200);
    const leftFetch = await fetchRounds(left.key);
    expect(leftFetch.json.rounds.map((round) => round.id)).toEqual(["round_right", "round_left"]);
    expect(leftFetch.json.rounds.map((round) => round.ownerId)).toEqual([right.ownerId, left.ownerId]);
    const rightFetch = await fetchRounds(right.key);
    expect(rightFetch.json.rounds.map((round) => round.id)).toEqual(["round_right", "round_far", "round_left"]);
    const farFetch = await fetchRounds(far.key);
    expect(farFetch.json.rounds.map((round) => round.id)).toEqual(["round_right", "round_far"]);
    expect(farFetch.text).not.toContain("round_left");
  });

  it("a block hides rounds even when the friendship row remains", async () => {
    const opener = await mint("hide-opener");
    const other = await mint("hide-other");
    await befriend(opener, other);
    expect((await putRound(opener.key, baseRound({ id: "round_opener" }))).status).toBe(200);
    expect((await putRound(other.key, baseRound({ id: "round_other" }))).status).toBe(200);
    kv.set(`fr:block:${opener.ownerId}:${other.ownerId}`, { value: "1" });
    const openerFetch = await fetchRounds(opener.key);
    const otherFetch = await fetchRounds(other.key);
    expect(openerFetch.json.rounds.map((round) => round.id)).toEqual(["round_opener"]);
    expect(otherFetch.json.rounds.map((round) => round.id)).toEqual(["round_other"]);
    expect(openerFetch.text).not.toContain("blocked");
    expect(otherFetch.text).not.toContain("blocked");
  });

  it("after block neither side can fetch the other's new round", async () => {
    const opener = await mint("blk-opener");
    const other = await mint("blk-other");
    const third = await mint("blk-third");
    await befriend(opener, other);
    await befriend(other, third);
    expect((await putRound(opener.key, baseRound({ id: "round_old_opener", playedOn: "2026-10-01" }))).status).toBe(200);
    expect((await putRound(other.key, baseRound({ id: "round_old_other", playedOn: "2026-10-02" }))).status).toBe(200);
    const blocked = await invoke("/v1/friends/block", { friend: opener.key, body: { ownerId: other.ownerId } });
    expect(blocked.json).toEqual({ ok: true });
    expect(hasRound(opener.ownerId, "round_old_opener")).toBe(true);
    expect(hasRound(other.ownerId, "round_old_other")).toBe(true);
    expect((await putRound(other.key, baseRound({ id: "round_new_other", playedOn: "2026-10-04" }))).status).toBe(200);
    expect((await putRound(opener.key, baseRound({ id: "round_new_opener", playedOn: "2026-10-03" }))).status).toBe(200);
    const openerFetch = await fetchRounds(opener.key);
    const otherFetch = await fetchRounds(other.key);
    const thirdFetch = await fetchRounds(third.key);
    expect(openerFetch.json.rounds.map((round) => round.id)).toEqual(["round_old_opener", "round_new_opener"]);
    expect(otherFetch.json.rounds.map((round) => round.id)).toEqual(["round_old_other", "round_new_other"]);
    expect(thirdFetch.json.rounds.map((round) => round.id)).toEqual(["round_old_other", "round_new_other"]);
    expect(thirdFetch.text).not.toContain("round_old_opener");
    expect(thirdFetch.text).not.toContain("round_new_opener");
    expect(kv.has(`fr:friend:${opener.ownerId}:${other.ownerId}`)).toBe(false);
    expect(kv.has(`fr:friend:${other.ownerId}:${opener.ownerId}`)).toBe(false);
    expect(kv.has(`fr:friend:${other.ownerId}:${third.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${third.ownerId}:${other.ownerId}`)).toBe(true);
  });

  it("fetch returns the full list with no cursor", async () => {
    const caller = await mint("fetch-sort");
    const friend = await mint("fetch-sort-friend");
    await befriend(caller, friend);
    expect((await putRound(caller.key, baseRound({ id: "round_late", playedOn: "2026-10-12" }))).status).toBe(200);
    expect((await putRound(caller.key, baseRound({ id: "round_aaa", playedOn: "2026-10-12" }))).status).toBe(200);
    expect((await putRound(friend.key, baseRound({ id: "round_early", playedOn: "2026-10-01" }))).status).toBe(200);
    const fetched = await fetchRounds(caller.key);
    expect(fetched.status).toBe(200);
    expect(fetched.json.rounds.map((round) => round.id)).toEqual(["round_early", "round_aaa", "round_late"]);
    expect(fetched.json).not.toHaveProperty("cursor");
    expect(fetched.text).not.toContain("cursor");
  });

  it("fetch omits a stored round that carries GPS", async () => {
    const caller = await mint("fetch-poison");
    expect((await putRound(caller.key, baseRound({ id: "round_clean" }))).status).toBe(200);
    const poisoned = storedRounds(caller.ownerId);
    poisoned.push(baseRound({ id: "round_gps", ownerId: caller.ownerId, lat: 33.5 }));
    kv.set(roundsKey(caller.ownerId), { value: JSON.stringify(poisoned) });
    const fetched = await fetchRounds(caller.key);
    expect(fetched.json.rounds.map((round) => round.id)).toEqual(["round_clean"]);
    expect(fetched.text).not.toContain("lat");
  });

  it("publish rejects a body over 8192 bytes", async () => {
    const caller = await mint("pub-size");
    const over = `{"share":true,"round":"${"a".repeat(8192)}"}`;
    expect(new TextEncoder().encode(over).length).toBeGreaterThan(8192);
    const huge = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: over,
      headers: { "Content-Length": "100" },
    });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "payload_too_large" });
    const declared = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: { share: true, round: baseRound() },
      headers: { "Content-Length": "9000" },
    });
    expect(declared.status).toBe(413);
    const under = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      body: "{\"share\":true}",
    });
    expect(under.status).toBe(400);
    expect(under.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:round:")).toEqual([]);
    const wide = `{"share":true,"round":"${"é".repeat(4090)}"}`;
    expect(wide.length).toBeLessThanOrEqual(8192);
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(8192);
    const utf8 = await invoke("/v1/friends/rounds", { method: "PUT", friend: caller.key, body: wide });
    expect(utf8.status).toBe(413);
    expect(rows("fr:round:")).toEqual([]);
  });

  it("remove rejects a body over 2048 bytes", async () => {
    const caller = await mint("rm-size");
    const other = await mint("rm-size-other");
    await befriend(caller, other);
    expect((await putRound(caller.key, baseRound({ id: "round_keep" }))).status).toBe(200);
    const huge = await invoke("/v1/friends/remove", { friend: caller.key, body: { ownerId: "x".repeat(3000) } });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "payload_too_large" });
    const named = await invoke("/v1/friends/remove", {
      friend: caller.key,
      body: { ownerId: other.ownerId, name: DISPLAY_NAME },
    });
    expect(named.status).toBe(400);
    expect(named.json).toEqual({ error: "invalid_body" });
    expect(kv.has(`fr:friend:${caller.ownerId}:${other.ownerId}`)).toBe(true);
    expect(hasRound(caller.ownerId, "round_keep")).toBe(true);
    const self = await invoke("/v1/friends/remove", { friend: caller.key, body: { ownerId: caller.ownerId } });
    expect(self.status).toBe(400);
    expect(self.json).toEqual({ error: "invalid_body" });
    const method = await invoke("/v1/friends/remove", { method: "DELETE", friend: caller.key });
    expect(method.status).toBe(405);
    expect(method.json).toEqual({ error: "method_not_allowed" });
    const missing = await invoke("/v1/friends/remove", { body: { ownerId: other.ownerId } });
    expect(missing.status).toBe(401);
    expect(missing.json).toEqual({ error: "friend_key_required" });
    expect(hasRound(caller.ownerId, "round_keep")).toBe(true);
  });

  it("the same round id replaces the previous round", async () => {
    const caller = await mint("pub-replace");
    expect((await putRound(caller.key, baseRound({ id: "round_7Kp2", gross: 82 }))).status).toBe(200);
    const again = await putRound(caller.key, baseRound({ id: "round_7Kp2", gross: 90, toPar: 18 }));
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, id: "round_7Kp2" });
    expect(rows("fr:rounds:")).toEqual([roundsKey(caller.ownerId)]);
    expect(rows("fr:round:")).toEqual([]);
    const stored = storedRounds(caller.ownerId).find((round) => round.id === "round_7Kp2");
    expect(stored.gross).toBe(90);
    expect(stored.toPar).toBe(18);
    expect(kv.get(roundsKey(caller.ownerId)).expirationTtl).toBe(365 * 24 * 60 * 60);
  });

  it("publish stores a round for one year", async () => {
    const caller = await mint("pub-ttl");
    const published = await putRound(caller.key, baseRound());
    expect(published.status).toBe(200);
    const row = kv.get(roundsKey(caller.ownerId));
    expect(row.expirationTtl).toBe(365 * 24 * 60 * 60);
    expect(row.value).not.toContain(caller.key);
    expect([...kv.keys()].filter((name) => !name.startsWith("fr:k:") && !name.startsWith("fr:code:") && !name.startsWith("fr:invat:") && !name.startsWith("fr:rounds:"))).toEqual([]);
  });

  it("duplicate hole numbers are invalid", async () => {
    const caller = await mint("pub-dup-hole");
    const published = await putRound(caller.key, baseRound({
      holes: [
        { hole: 1, score: 4, par: 4 },
        { hole: 1, score: 5, par: 4 },
      ],
    }));
    expect(published.status).toBe(400);
    expect(published.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:round:")).toEqual([]);
  });

  it("hole 19 is invalid", async () => {
    const caller = await mint("pub-hole-19");
    const published = await putRound(caller.key, baseRound({
      holes: [{ hole: 19, score: 4, par: 4 }],
    }));
    expect(published.status).toBe(400);
    expect(published.json).toEqual({ error: "invalid_body" });
    const zero = await putRound(caller.key, baseRound({ holes: [{ hole: 0, score: 4, par: 4 }] }));
    expect(zero.status).toBe(400);
    expect(rows("fr:round:")).toEqual([]);
  });

  it("clubs reject a punctuation string", async () => {
    const caller = await mint("pub-clubs");
    const named = await putRound(caller.key, baseRound({
      holes: [{ hole: 1, score: 4, par: 4, clubs: ["Pines!"] }],
    }));
    expect(named.status).toBe(400);
    expect(named.json).toEqual({ error: "invalid_body" });
    const empty = await putRound(caller.key, baseRound({
      holes: [{ hole: 1, score: 4, par: 4, clubs: [] }],
    }));
    expect(empty.status).toBe(400);
    const tooMany = await putRound(caller.key, baseRound({
      holes: [{ hole: 1, score: 4, par: 4, clubs: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }],
    }));
    expect(tooMany.status).toBe(400);
    const long = await putRound(caller.key, baseRound({
      holes: [{ hole: 1, score: 4, par: 4, clubs: ["123456789"] }],
    }));
    expect(long.status).toBe(400);
    expect(rows("fr:round:")).toEqual([]);
    const ok = await putRound(caller.key, baseRound({
      id: "round_clubs",
      holes: [{ hole: 1, score: 4, par: 4, clubs: ["Driver", "3-wood", "PW"] }],
    }));
    expect(ok.status).toBe(200);
    const stored = storedRounds(caller.ownerId).find((round) => round.id === "round_clubs");
    expect(stored.holes[0].clubs).toEqual(["Driver", "3-wood", "PW"]);
  });

  it("round field bounds follow the allowlist", async () => {
    const caller = await mint("pub-bounds");
    const bad = [
      baseRound({ gross: 0 }),
      baseRound({ gross: 201 }),
      baseRound({ gross: 82.5 }),
      baseRound({ gross: "82" }),
      baseRound({ toPar: -41 }),
      baseRound({ toPar: 201 }),
      baseRound({ courseName: "" }),
      baseRound({ courseName: " Greystone" }),
      baseRound({ courseName: "x".repeat(201) }),
      baseRound({ courseName: "Grey\u0001stone" }),
      baseRound({ courseName: "Grey\nstone" }),
      baseRound({ courseName: "Grey\u007Fstone" }),
      baseRound({ playedOn: "2026-02-31" }),
      baseRound({ playedOn: "10/11/2026" }),
      baseRound({ id: "" }),
      baseRound({ id: "a".repeat(65) }),
      baseRound({ id: "round 1" }),
      baseRound({ holes: [{ hole: 1, score: 0, par: 4 }] }),
      baseRound({ holes: [{ hole: 1, score: 21, par: 4 }] }),
      baseRound({ holes: [{ hole: 1, score: 4, par: 2 }] }),
      baseRound({ holes: [{ hole: 1, score: 4, par: 7 }] }),
      baseRound({ holes: [{ hole: 1, score: 4, par: 4, putts: -1 }] }),
      baseRound({ holes: [{ hole: 1, score: 4, par: 4, putts: 11 }] }),
    ];
    for (const round of bad) {
      const published = await putRound(caller.key, round);
      expect(published.status).toBe(400);
      expect(published.json).toEqual({ error: "invalid_body" });
    }
    expect(rows("fr:round:")).toEqual([]);
    const edges = await putRound(caller.key, baseRound({
      id: "a".repeat(64),
      courseName: "y".repeat(200),
      playedOn: "2026-02-28",
      gross: 1,
      toPar: -40,
      holes: [{ hole: 18, score: 1, par: 3, putts: 0 }],
    }));
    expect(edges.status).toBe(200);
    const high = await putRound(caller.key, baseRound({
      id: "round_high",
      gross: 200,
      toPar: 200,
      holes: [{ hole: 1, score: 20, par: 6, putts: 10 }],
    }));
    expect(high.status).toBe(200);
  });

  it("a fetch with a declared body is invalid", async () => {
    const caller = await mint("fetch-body");
    expect((await putRound(caller.key, baseRound())).status).toBe(200);
    const small = await fetchRounds(caller.key, { "Content-Length": "2" });
    expect(small.status).toBe(400);
    expect(small.json).toEqual({ error: "invalid_body" });
    const huge = await fetchRounds(caller.key, { "Content-Length": "3000" });
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "payload_too_large" });
    expect(hasRound(caller.ownerId, "round_7Kp2")).toBe(true);
    const empty = await fetchRounds(caller.key, { "Content-Length": "0" });
    expect(empty.status).toBe(200);
    expect(empty.json.rounds).toHaveLength(1);
    const method = await invoke("/v1/friends/rounds", { method: "POST", friend: caller.key, body: { share: true, round: baseRound() } });
    expect(method.status).toBe(405);
    expect(method.json).toEqual({ error: "method_not_allowed" });
    expect(rows("fr:rounds:")).toEqual([roundsKey(caller.ownerId)]);
    expect(rows("fr:round:")).toEqual([]);
  });

  it("remove publish and fetch do not use the guess limiter", async () => {
    const caller = await mint("limit-caller");
    const other = await mint("limit-other");
    await befriend(caller, other);
    for (let i = 0; i < KEY_LIMIT - 1; i += 1) {
      const miss = await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "GGGGGGGG" } });
      expect(miss.status).toBe(404);
    }
    const limited = await invoke("/v1/friends/codes/lookup", { friend: caller.key, body: { code: "GGGGGGGG" } });
    expect(limited.status).toBe(429);
    const published = await putRound(caller.key, baseRound({ id: "round_limited" }));
    expect(published.status).toBe(200);
    const fetched = await fetchRounds(caller.key);
    expect(fetched.status).toBe(200);
    expect(fetched.json.rounds.map((round) => round.id)).toEqual(["round_limited"]);
    env.FRIEND_GUESSES = undefined;
    const still = await putRound(other.key, baseRound({ id: "round_unbound" }));
    expect(still.status).toBe(200);
    const seen = await fetchRounds(caller.key);
    expect(seen.status).toBe(200);
    expect(seen.json.rounds.map((round) => round.id).sort()).toEqual(["round_limited", "round_unbound"]);
    const removed = await invoke("/v1/friends/remove", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ ok: true });
    const fresh = friendKey("no-code-yet");
    expect((await invoke("/v1/friends/remove", { friend: fresh, body: { ownerId: other.ownerId } })).status).toBe(401);
    expect((await putRound(fresh, baseRound())).status).toBe(401);
    expect((await fetchRounds(fresh)).status).toBe(401);
    env.BOARDS = undefined;
    expect((await fetchRounds(caller.key)).json).toEqual({ error: "boards_not_configured" });
    expect((await putRound(caller.key, baseRound())).json).toEqual({ error: "boards_not_configured" });
  });

  it("serves remove and rounds from the deploy entry", async () => {
    const caller = await mint("entry-round");
    const other = await mint("entry-round-other");
    await befriend(caller, other);
    const published = await entry.fetch(new Request(`${ORIGIN}/v1/friends/rounds`, {
      method: "PUT",
      headers: { "X-Friend-Key": caller.key, "Content-Type": "application/json" },
      body: JSON.stringify({ share: true, round: baseRound({ id: "round_entry" }) }),
    }), env, { waitUntil() {} });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ ok: true, id: "round_entry" });
    const fetched = await entry.fetch(new Request(`${ORIGIN}/v1/friends/rounds`, {
      method: "GET",
      headers: { "X-Friend-Key": other.key },
    }), env, { waitUntil() {} });
    expect(fetched.status).toBe(200);
    const body = await fetched.json();
    expect(body.rounds.map((round) => round.id)).toEqual(["round_entry"]);
    const options = await entry.fetch(new Request(`${ORIGIN}/v1/friends/rounds`, { method: "OPTIONS" }), env, { waitUntil() {} });
    expect(options.status).toBe(200);
    expect(await options.text()).toBe("");
    expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,PUT,OPTIONS");
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("X-Friend-Key");
    const removed = await entry.fetch(new Request(`${ORIGIN}/v1/friends/remove`, {
      method: "POST",
      headers: { "X-Friend-Key": caller.key, "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: other.ownerId }),
    }), env, { waitUntil() {} });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(hasRound(caller.ownerId, "round_entry")).toBe(true);
  });

  it("lookup requires a minted code before it spends a guess", async () => {
    const key = friendKey("need-code");
    let codeReads = 0;
    const get = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (name) => {
      if (String(name).startsWith("fr:code:")) codeReads += 1;
      return get(name);
    };
    const early = await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "AB3K7NP2" } });
    expect(early.status).toBe(401);
    expect(early.json).toEqual({ error: "friend_key_required" });
    expect(codeReads).toBe(0);
    expect((await invoke("/v1/friends/code", { friend: key, body: {} })).status).toBe(200);
    for (let i = 0; i < KEY_LIMIT; i += 1) {
      expect((await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "AB3K7NP2" } })).status).toBe(404);
    }
    expect((await invoke("/v1/friends/codes/lookup", { friend: key, body: { code: "AB3K7NP2" } })).status).toBe(429);
  });

  it("block without a friendship is 409 and writes nothing", async () => {
    const caller = await mint("blk-none");
    const other = await mint("blk-none-other");
    expect((await putRound(caller.key, baseRound({ id: "round_caller" }))).status).toBe(200);
    expect((await putRound(other.key, baseRound({ id: "round_other" }))).status).toBe(200);
    const before = kvSnapshot();
    const blocked = await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toEqual({ error: "not_friends" });
    expect(kvSnapshot()).toEqual(before);
    expect(rows("fr:block:")).toEqual([]);
    expect(hasRound(caller.ownerId, "round_caller")).toBe(true);
    expect(hasRound(other.ownerId, "round_other")).toBe(true);
  });

  it("stores the block before deleting the friendship", async () => {
    const caller = await mint("blk-order");
    const other = await mint("blk-order-other");
    await befriend(other, caller);
    const blockKey = `fr:block:${caller.ownerId}:${other.ownerId}`;
    env.BOARDS.delete = async () => {
      throw new Error("kv_down");
    };
    await expect(invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } })).rejects.toThrow("kv_down");
    expect(kv.get(blockKey).value).toBe("1");
    expect(kv.has(`fr:friend:${caller.ownerId}:${other.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${other.ownerId}:${caller.ownerId}`)).toBe(true);
  });

  it("caps shared rounds at 100 per owner", async () => {
    const caller = await mint("cap-rounds");
    for (let i = 0; i < 100; i += 1) {
      const published = await putRound(caller.key, baseRound({ id: `r${i}` }));
      expect(published.status, `round ${i}`).toBe(200);
    }
    expect(storedRounds(caller.ownerId)).toHaveLength(100);
    expect(rows("fr:rounds:")).toEqual([roundsKey(caller.ownerId)]);
    const over = await putRound(caller.key, baseRound({ id: "r100" }));
    expect(over.status).toBe(409);
    expect(over.json).toEqual({ error: "round_limit" });
    expect(storedRounds(caller.ownerId)).toHaveLength(100);
    expect(hasRound(caller.ownerId, "r100")).toBe(false);
    const replaced = await putRound(caller.key, baseRound({ id: "r0", gross: 70 }));
    expect(replaced.status).toBe(200);
    expect(storedRounds(caller.ownerId).find((round) => round.id === "r0").gross).toBe(70);
    expect(storedRounds(caller.ownerId)).toHaveLength(100);
  });

  it("caps friends at 50 on accept", async () => {
    const caller = await mint("fr-cap");
    const other = await mint("fr-cap-other");
    const extra = await mint("fr-cap-extra");
    expect((await invoke("/v1/friends/requests", { friend: other.key, body: { code: caller.code } })).status).toBe(200);
    const full = Array.from({ length: 50 }, (_, index) => `F${String(index).padStart(21, "0")}`);
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify(full) });
    const accepted = await invoke("/v1/friends/requests/accept", { friend: caller.key, body: { ownerId: other.ownerId } });
    expect(accepted.status).toBe(409);
    expect(accepted.json).toEqual({ error: "friend_limit" });
    expect(rows("fr:friend:")).toEqual([]);
    expect(JSON.parse(kv.get(`fr:friends:${caller.ownerId}`).value)).toHaveLength(50);
    expect(kv.get(`fr:req:${caller.ownerId}:${other.ownerId}`).value).toBe("pending");

    kv.delete(`fr:friends:${caller.ownerId}`);
    expect((await invoke("/v1/friends/requests", { friend: extra.key, body: { code: caller.code } })).json.status).toBe("pending");
    kv.set(`fr:friends:${extra.ownerId}`, { value: JSON.stringify(full) });
    const otherFull = await invoke("/v1/friends/requests/accept", { friend: caller.key, body: { ownerId: extra.ownerId } });
    expect(otherFull.status).toBe(409);
    expect(otherFull.json).toEqual({ error: "friend_limit" });
    expect(rows("fr:friend:")).toEqual([]);
    expect(kv.get(`fr:req:${caller.ownerId}:${extra.ownerId}`).value).toBe("pending");
  });

  it("limits getCode to 30 per IP hour", async () => {
    const ip = "203.0.113.80";
    for (let i = 0; i < 10; i += 1) {
      expect((await invoke("/v1/friends/code", { ip })).status).toBe(401);
      const bad = await invoke("/v1/friends/code", { friend: friendKey("gc-bad"), ip, body: { name: "Ada" } });
      expect(bad.status).toBe(400);
    }
    for (let i = 0; i < 30; i += 1) {
      const created = await invoke("/v1/friends/code", { friend: friendKey(`gc${i}`), ip, body: {} });
      expect(created.status, `get ${i}`).toBe(200);
    }
    expect(rows("fr:code:")).toHaveLength(30);
    const over = await invoke("/v1/friends/code", { friend: friendKey("gc-over"), ip, body: {} });
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ error: "rate_limited" });
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(rows("fr:code:")).toHaveLength(30);
    const otherIp = await invoke("/v1/friends/code", { friend: friendKey("gc-over"), ip: "203.0.113.81", body: {} });
    expect(otherIp.status).toBe(200);
    const miss = await invoke("/v1/friends/codes/lookup", { friend: friendKey("gc0"), ip, body: { code: "ZZZZZZZZ" } });
    expect(miss.status).toBe(404);
    env.FRIEND_GUESSES = undefined;
    const closed = await invoke("/v1/friends/code", { friend: friendKey("gc-closed"), ip: "203.0.113.82", body: {} });
    expect(closed.status).toBe(503);
    expect(closed.json).toEqual({ error: "guess_limiter_not_configured" });
  });

  it("limits publishRound to 60 per IP hour", async () => {
    const caller = await mint("pub-ip");
    const ip = "198.51.100.20";
    for (let i = 0; i < 60; i += 1) {
      const published = await invoke("/v1/friends/rounds", {
        method: "PUT",
        friend: caller.key,
        ip,
        body: { share: true, round: baseRound({ id: `ip_${i}` }) },
      });
      expect(published.status, `pub ${i}`).toBe(200);
    }
    const over = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      ip,
      body: { share: true, round: baseRound({ id: "ip_over" }) },
    });
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ error: "rate_limited" });
    expect(hasRound(caller.ownerId, "ip_over")).toBe(false);
    const unshare = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      ip,
      body: { share: false, round: null },
    });
    expect(unshare.status).toBe(429);
    expect(storedRounds(caller.ownerId)).toHaveLength(60);
    const otherIp = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      ip: "198.51.100.21",
      body: { share: true, round: baseRound({ id: "ip_other" }) },
    });
    expect(otherIp.status).toBe(200);
    const fresh = await mint("pub-ip-bad");
    for (let i = 0; i < 60; i += 1) {
      const bad = await invoke("/v1/friends/rounds", {
        method: "PUT",
        friend: fresh.key,
        ip: "198.51.100.22",
        body: { share: true, round: baseRound({ name: "nope" }) },
      });
      expect(bad.status).toBe(400);
    }
    const still = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: fresh.key,
      ip: "198.51.100.22",
      body: { share: true, round: baseRound({ id: "after_bad" }) },
    });
    expect(still.status).toBe(200);
    env.FRIEND_GUESSES = undefined;
    const closed = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: fresh.key,
      ip: "198.51.100.23",
      body: { share: true, round: baseRound({ id: "no_limiter" }) },
    });
    expect(closed.status).toBe(503);
    expect(closed.json).toEqual({ error: "guess_limiter_not_configured" });
    expect(hasRound(fresh.ownerId, "no_limiter")).toBe(false);
  });

  it("a full round list is rejected before the publish IP limit", async () => {
    const filler = await mint("ord-fill");
    const caller = await mint("ord-full");
    const ip = "198.51.100.40";
    const planted = Array.from({ length: 100 }, (_, index) => baseRound({ id: `planted_${index}` }));
    kv.set(roundsKey(caller.ownerId), { value: JSON.stringify(planted) });
    for (let i = 0; i < 60; i += 1) {
      const published = await invoke("/v1/friends/rounds", {
        method: "PUT",
        friend: filler.key,
        ip,
        body: { share: true, round: baseRound({ id: `fill_${i}` }) },
      });
      expect(published.status, `fill ${i}`).toBe(200);
    }
    const capped = await invoke("/v1/friends/rounds", {
      method: "PUT",
      friend: caller.key,
      ip,
      body: { share: true, round: baseRound({ id: "one_more" }) },
    });
    expect(capped.status).toBe(409);
    expect(capped.json).toEqual({ error: "round_limit" });
    expect(hasRound(caller.ownerId, "one_more")).toBe(false);
  });

  it("fetch reads 3 + 3N KV gets and does not list", async () => {
    const caller = await mint("ops-caller");
    const first = await mint("ops-a");
    const second = await mint("ops-b");
    await befriend(first, caller);
    await renew(caller);
    await befriend(second, caller);
    expect((await putRound(caller.key, baseRound({ id: "round_me", playedOn: "2026-10-03" }))).status).toBe(200);
    expect((await putRound(first.key, baseRound({ id: "round_a", playedOn: "2026-10-01" }))).status).toBe(200);
    expect((await putRound(second.key, baseRound({ id: "round_b", playedOn: "2026-10-02" }))).status).toBe(200);
    let gets = 0;
    let lists = 0;
    let puts = 0;
    let deletes = 0;
    const get = env.BOARDS.get.bind(env.BOARDS);
    const put = env.BOARDS.put.bind(env.BOARDS);
    const del = env.BOARDS.delete.bind(env.BOARDS);
    const list = env.BOARDS.list.bind(env.BOARDS);
    env.BOARDS.get = async (...args) => {
      gets += 1;
      return get(...args);
    };
    env.BOARDS.put = async (...args) => {
      puts += 1;
      return put(...args);
    };
    env.BOARDS.delete = async (...args) => {
      deletes += 1;
      return del(...args);
    };
    env.BOARDS.list = async (...args) => {
      lists += 1;
      return list(...args);
    };
    const fetched = await fetchRounds(caller.key);
    expect(fetched.status).toBe(200);
    expect(fetched.json.rounds.map((round) => round.id)).toEqual(["round_a", "round_b", "round_me"]);
    expect(gets).toBe(3 + 3 * 2);
    expect(lists).toBe(0);
    expect(puts).toBe(0);
    expect(deletes).toBe(0);

    kv.set(`fr:block:${caller.ownerId}:${second.ownerId}`, { value: "1" });
    gets = 0;
    lists = 0;
    const blocked = await fetchRounds(caller.key);
    expect(blocked.json.rounds.map((round) => round.id)).toEqual(["round_a", "round_me"]);
    expect(gets).toBe(3 + 2 * 2 + 1);
    expect(lists).toBe(0);
  });

  async function expectReserved(fetchImpl, label) {
    const counts = { get: 0, put: 0, delete: 0, list: 0 };
    const boards = env.BOARDS;
    env.BOARDS = {
      async get(key) {
        counts.get += 1;
        return boards.get(key);
      },
      async put(key, value, options) {
        counts.put += 1;
        return boards.put(key, value, options);
      },
      async delete(key) {
        counts.delete += 1;
        return boards.delete(key);
      },
      async list(options) {
        counts.list += 1;
        return boards.list(options);
      },
    };
    const proof = await fetchImpl(new Request(`${ORIGIN}/board2345`, {
      method: "PUT",
      body: "{\"ok\":true}",
    }), env, { waitUntil() {} });
    expect(proof.status, label).toBe(200);
    expect(counts.put, label).toBe(1);
    const read = await fetchImpl(new Request(`${ORIGIN}/board2345`), env, { waitUntil() {} });
    expect(read.status, label).toBe(200);
    expect(await read.text()).toBe("{\"ok\":true}");
    expect(counts.get, label).toBeGreaterThan(0);
    counts.get = 0;
    counts.put = 0;
    counts.delete = 0;
    counts.list = 0;
    const paths = [
      "/fr:code:AB3K7NP2",
      "/fr:round:k3mR9xQ2nB8wL4pT6vYs1A:round_7Kp2",
      "/fr:friend:k3mR9xQ2nB8wL4pT6vYs1A:k3mR9xQ2nB8wL4pT6vYs1B",
      "/fr%3Acode:AB3K7NP2",
      "/fr%3acode:AB3K7NP2",
      "/fr%3Around:k3mR9xQ2nB8wL4pT6vYs1A:round_7Kp2",
      "/fr%3afriend:k3mR9xQ2nB8wL4pT6vYs1A:k3mR9xQ2nB8wL4pT6vYs1B",
    ];
    for (const path of paths) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await fetchImpl(new Request(`${ORIGIN}${path}`, {
          method,
          body: method === "PUT" ? "{\"forged\":true}" : undefined,
        }), env, { waitUntil() {} });
        expect(response.status, `${label} ${method} ${path}`).toBe(400);
        expect(await response.text(), `${label} ${method} ${path}`).toBe("bad key");
      }
    }
    expect(counts, label).toEqual({ get: 0, put: 0, delete: 0, list: 0 });
    expect(kv.get("board2345").value).toBe("{\"ok\":true}");
    env.BOARDS = boards;
  }

  it("deployed entry reserves fr: for raw and percent-encoded paths", async () => {
    await expectReserved(entry.fetch.bind(entry), "entry");
  });

  it("worker.js reserves fr: for raw and percent-encoded paths", async () => {
    await expectReserved(worker.fetch.bind(worker), "worker");
  });

  it("keeps the stockpile flag false and adds no binding", () => {
    const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
    const source = readFileSync(new URL("./friends.js", import.meta.url), "utf8");
    expect(toml).toContain('GOLFAPI_STOCKPILE_ENABLED = "false"');
    expect(toml).toContain('name = "FRIEND_GUESSES"');
    expect(toml).not.toContain("FRIEND_ROUNDS");
    expect(source).not.toContain("FRIEND_ROUNDS");
    expect(source).not.toContain("wrangler deploy");
  });
});
