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
        async put(key, value) {
          kv.set(key, { value });
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
    const later = await invoke("/v1/friends/remove", { friend: friendKey("later"), body: { ownerId: "k3mR9xQ2nB8wL4pT6vYs1A" } });
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

  it("quiet block looks like a sent request and stores nothing", async () => {
    const opener = await mint("quiet-opener");
    const inviter = await mint("quiet-inviter");
    const controlFrom = await mint("quiet-from");
    const controlTo = await mint("quiet-to");
    const blocked = await invoke("/v1/friends/block", { friend: inviter.key, body: { ownerId: opener.ownerId } });
    expect(blocked.status).toBe(200);
    expect(blocked.json).toEqual({ ok: true });

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
    const sent = await invoke("/v1/friends/requests", { friend: inviter.key, body: { code: opener.code } });
    expect(sent.json).toEqual({ status: "pending", ownerId: opener.ownerId });
    expect(kv.has(`fr:req:${opener.ownerId}:${inviter.ownerId}`)).toBe(true);

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
    kv.set(`fr:round:${left.ownerId}:round_left`, { value: "{\"id\":\"round_left\"}" });
    kv.set(`fr:round:${right.ownerId}:round_right`, { value: "{\"id\":\"round_right\"}" });
    kv.set(`fr:round:${bystander}:round_other`, { value: "{\"id\":\"round_other\"}" });
    kv.set("id:14322", { value: "{\"holes\":1}" });

    const blocked = await invoke("/v1/friends/block", { friend: left.key, body: { ownerId: right.ownerId } });
    expect(blocked.json).toEqual({ ok: true });
    expect(rows("fr:friend:")).toEqual([]);
    expect(rows("fr:req:")).toEqual([]);
    expect(kv.has(`fr:round:${left.ownerId}:round_left`)).toBe(false);
    expect(kv.has(`fr:round:${right.ownerId}:round_right`)).toBe(false);
    expect(kv.get(`fr:round:${bystander}:round_other`).value).toBe("{\"id\":\"round_other\"}");
    expect(kv.get("id:14322").value).toBe("{\"holes\":1}");
    expect(kv.has(`fr:code:${left.code}`)).toBe(true);
    expect(kv.has(`fr:code:${right.code}`)).toBe(true);

    const cleared = await invoke("/v1/friends/unblock", { friend: left.key, body: { ownerId: right.ownerId } });
    expect(cleared.json).toEqual({ ok: true });
    expect(rows("fr:friend:")).toEqual([]);
    expect(rows("fr:req:")).toEqual([]);
    expect(rows("fr:block:")).toEqual([]);
    expect(kv.has(`fr:round:${left.ownerId}:round_left`)).toBe(false);
    expect(kv.has(`fr:round:${right.ownerId}:round_right`)).toBe(false);
    expect(kv.get(`fr:round:${bystander}:round_other`).value).toBe("{\"id\":\"round_other\"}");
    const still = await invoke("/v1/friends/requests/accept", { friend: right.key, body: { ownerId: left.ownerId } });
    expect(still.status).toBe(409);
    expect(still.json).toEqual({ error: "not_friends" });
    const lookup = await invoke("/v1/friends/codes/lookup", { friend: friendKey("gone-look"), body: { code: left.code } });
    expect(lookup.status).toBe(200);
    expect(lookup.json).toEqual({ ownerId: left.ownerId });
  });

  it("unblock removes only the caller's block", async () => {
    const caller = await mint("only-caller");
    const other = await mint("only-other");
    expect((await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } })).json).toEqual({ ok: true });
    expect((await invoke("/v1/friends/block", { friend: other.key, body: { ownerId: caller.ownerId } })).json).toEqual({ ok: true });
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

    const refused = await invoke("/v1/friends/requests", { friend: other.key, body: { code: caller.code } });
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "blocked" });
  });

  it("after unblock a request from the blocked person is stored and can be accepted", async () => {
    const caller = await mint("again-caller");
    const other = await mint("again-other");
    expect((await invoke("/v1/friends/block", { friend: caller.key, body: { ownerId: other.ownerId } })).status).toBe(200);
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
    expect(repeat.json).toEqual({ status: "friends", ownerId: caller.ownerId });
    expect(rows("fr:req:")).toEqual([]);
  });

  it("unblock does not consume a code guess", async () => {
    const caller = await mint("guess-caller");
    const other = await mint("guess-other");
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
      const miss = await invoke("/v1/friends/codes/lookup", {
        friend: friendKey(`ipg${i}`),
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
    const lastIp = await invoke("/v1/friends/codes/lookup", {
      friend: friendKey("ipg-last"),
      ip,
      body: { code: "PPPPPPPP" },
    });
    expect(lastIp.status).toBe(404);
    const overIp = await invoke("/v1/friends/codes/lookup", {
      friend: friendKey("ipg-over"),
      ip,
      body: { code: "PPPPPPPP" },
    });
    expect(overIp.status).toBe(429);
    expect(overIp.json).toEqual({ error: "rate_limited" });
  });

  it("unblock does not reset the limiter, read a code, or require the limiter", async () => {
    const caller = await mint("reset-caller");
    const other = await mint("reset-other");
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

    for (let i = 0; i < KEY_LIMIT; i += 1) {
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
    expect(second.json).toEqual(first.json);
    expect(rows("fr:req:")).toEqual([`fr:req:${to.ownerId}:${from.ownerId}`]);
    const named = await invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code, name: DISPLAY_NAME } });
    expect(named.status).toBe(400);
    expect(named.json).toEqual({ error: "invalid_body" });
    expect(rows("fr:req:")).toHaveLength(1);
  });

  it("block and unblock reject a bad body before changing a block", async () => {
    const caller = await mint("body-caller");
    const other = await mint("body-other");
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
});
