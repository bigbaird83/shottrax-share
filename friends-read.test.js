import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry from "./entry.js";
import worker, { FriendGuessLimiter } from "./worker.js";
import { FRIEND_CAP, FRIEND_READ_IP_LIMIT, FRIEND_READ_KEY_LIMIT } from "./friends.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const DISPLAY_NAME = "Casey Pines";

function friendKey(suffix) {
  return `${suffix}${"a".repeat(32)}`.slice(0, 43);
}

function numberedOwner(index) {
  return `n${index.toString(36).padStart(21, "0")}`;
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
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return obj.fetch(request);
        },
      };
    },
  };
}

describe("friend read routes", () => {
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

  async function call(fetchImpl, pathname, { method = "GET", body, headers, friend, ip } = {}) {
    const requestHeaders = { ...(headers || {}) };
    if (friend) requestHeaders["X-Friend-Key"] = friend;
    if (ip) requestHeaders["CF-Connecting-IP"] = ip;
    if (body !== undefined && !requestHeaders["Content-Type"]) requestHeaders["Content-Type"] = "application/json";
    const response = await fetchImpl(new Request(`${ORIGIN}${pathname}`, {
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

  function viaEntry(pathname, options) {
    return call(entry.fetch.bind(entry), pathname, options);
  }

  function viaWorker(pathname, options) {
    return call(worker.fetch.bind(worker), pathname, options);
  }

  async function mint(suffix) {
    const key = friendKey(suffix);
    const created = await viaEntry("/v1/friends/code", { method: "POST", friend: key, body: {} });
    expect(created.status).toBe(200);
    return { key, code: created.json.code, ownerId: created.json.ownerId };
  }

  async function befriend(from, to) {
    const sent = await viaEntry("/v1/friends/requests", { method: "POST", friend: from.key, body: { code: to.code } });
    expect(sent.json).toMatchObject({ status: "pending", ownerId: to.ownerId });
    const accepted = await viaEntry("/v1/friends/requests/accept", { method: "POST", friend: to.key, body: { ownerId: from.ownerId } });
    expect(accepted.json).toEqual({ status: "friends", ownerId: from.ownerId });
  }

  function putMutual(left, right) {
    kv.set(`fr:friend:${left}:${right}`, { value: "1" });
    kv.set(`fr:friend:${right}:${left}`, { value: "1" });
  }

  function countKv() {
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
    return counts;
  }

  function ownerIds(entries) {
    return entries.map((entry) => entry.ownerId);
  }

  it("returns the caller's requests and friends from the deploy entry", async () => {
    const alpha = await mint("read-alpha");
    const bravo = await mint("read-bravo");
    const charlie = await mint("read-charlie");
    const delta = await mint("read-delta");
    const sent = await viaEntry("/v1/friends/requests", { method: "POST", friend: alpha.key, body: { code: bravo.code } });
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ status: "pending", ownerId: bravo.ownerId });
    const back = await viaEntry("/v1/friends/requests", { method: "POST", friend: charlie.key, body: { code: alpha.code } });
    expect(back.json).toEqual({ status: "pending", ownerId: alpha.ownerId });
    await befriend(alpha, delta);

    const requests = await viaEntry("/v1/friends/requests", {
      friend: alpha.key,
      headers: { "X-Display-Name": DISPLAY_NAME },
    });
    expect(requests.status).toBe(200);
    expect(requests.headers.get("Content-Type")).toContain("application/json");
    expect(requests.headers.get("Cache-Control")).toBe("no-store");
    expect(requests.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(Object.keys(requests.json).sort()).toEqual(["incoming", "outgoing"]);
    expect(requests.json.incoming).toEqual([{ ownerId: charlie.ownerId }]);
    expect(requests.json.outgoing).toEqual([{ ownerId: bravo.ownerId }]);
    expect(requests.text).not.toContain(DISPLAY_NAME);
    expect(requests.text).not.toContain("pending");
    expect(requests.text).not.toContain("since");

    const friends = await viaEntry("/v1/friends/list", { friend: alpha.key });
    expect(friends.status).toBe(200);
    expect(Object.keys(friends.json)).toEqual(["friends"]);
    expect(friends.json.friends).toEqual([{ ownerId: delta.ownerId }]);
    for (const entry of friends.json.friends) expect(Object.keys(entry)).toEqual(["ownerId"]);

    const mirrored = await viaWorker("/v1/friends/requests", { friend: alpha.key });
    expect(mirrored.status).toBe(200);
    expect(mirrored.json).toEqual(requests.json);
    const mirroredFriends = await viaWorker("/v1/friends/list", { friend: alpha.key });
    expect(mirroredFriends.json).toEqual(friends.json);

    const empty = await mint("read-empty");
    expect((await viaEntry("/v1/friends/requests", { friend: empty.key })).json).toEqual({ incoming: [], outgoing: [] });
    expect((await viaEntry("/v1/friends/list", { friend: empty.key })).json).toEqual({ friends: [] });

    const wrong = await viaEntry("/v1/friends/list", { method: "POST", friend: alpha.key, body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.json).toEqual({ error: "method_not_allowed" });
  });

  it("rejects a missing or unminted friend key", async () => {
    const counts = countKv();
    for (const path of ["/v1/friends/requests", "/v1/friends/list"]) {
      const missing = await viaEntry(path);
      expect(missing.status).toBe(401);
      expect(missing.json).toEqual({ error: "friend_key_required" });
      const unminted = await viaEntry(path, { friend: friendKey(`bare-${path.slice(-4)}`) });
      expect(unminted.status).toBe(401);
      expect(unminted.json).toEqual({ error: "friend_key_required" });
    }
    expect(counts.list).toBe(0);
    expect(counts.put).toBe(0);
    expect(counts.delete).toBe(0);
  });

  it("does not return another pair's requests or friends", async () => {
    const caller = await mint("iso-caller");
    const left = await mint("iso-left");
    const right = await mint("iso-right");
    const extra = await mint("iso-extra");
    await viaEntry("/v1/friends/requests", { method: "POST", friend: left.key, body: { code: right.code } });
    await befriend(left, extra);
    kv.set(`fr:req:${caller.ownerId}:${left.ownerId}`, { value: "pending" });

    const requests = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(ownerIds(requests.json.incoming)).toEqual([left.ownerId]);
    expect(requests.json.outgoing).toEqual([]);
    expect(requests.text).not.toContain(right.ownerId);
    expect(requests.text).not.toContain(extra.ownerId);

    const friends = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(friends.json.friends).toEqual([]);
    expect(friends.text).not.toContain(left.ownerId);
    expect(friends.text).not.toContain(right.ownerId);
    expect(friends.text).not.toContain(extra.ownerId);

    const otherFriends = await viaEntry("/v1/friends/list", { friend: left.key });
    expect(ownerIds(otherFriends.json.friends)).toEqual([extra.ownerId]);
    expect(otherFriends.text).not.toContain(caller.ownerId);
    expect(otherFriends.text).not.toContain(right.ownerId);
  });

  it("hides a blocked requester from the blocker's incoming list", async () => {
    const blocker = await mint("in-blocker");
    const requester = await mint("in-requester");
    const visible = await mint("in-visible");
    kv.set(`fr:req:${blocker.ownerId}:${requester.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${blocker.ownerId}:${visible.ownerId}`, { value: "pending" });
    kv.set(`fr:block:${blocker.ownerId}:${requester.ownerId}`, { value: "1" });
    const listed = await viaEntry("/v1/friends/requests", { friend: blocker.key });
    expect(listed.status).toBe(200);
    expect(ownerIds(listed.json.incoming)).toEqual([visible.ownerId]);
    expect(listed.text).not.toContain(requester.ownerId);
    expect(listed.text).not.toContain("blocked");
  });

  it("keeps a stored outgoing request visible to a blocked sender", async () => {
    const sender = await mint("out-sender");
    const recipient = await mint("out-recipient");
    kv.set(`fr:req:${recipient.ownerId}:${sender.ownerId}`, { value: "pending" });
    kv.set(`fr:block:${recipient.ownerId}:${sender.ownerId}`, { value: "1" });
    const listed = await viaEntry("/v1/friends/requests", { friend: sender.key });
    expect(listed.json.outgoing).toEqual([{ ownerId: recipient.ownerId }]);
    expect(listed.text).not.toContain("blocked");
    const hidden = await viaEntry("/v1/friends/requests", { friend: recipient.key });
    expect(hidden.json.incoming).toEqual([]);
  });

  it("does not invent an outgoing request from a block row", async () => {
    const sender = await mint("gap-sender");
    const recipient = await mint("gap-recipient");
    await befriend(sender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: sender.ownerId },
    })).json).toEqual({ ok: true });
    const beforeSend = await viaEntry("/v1/friends/requests", { friend: sender.key });
    expect(beforeSend.json).toEqual({ incoming: [], outgoing: [] });
    expect(kv.has(`fr:out:${sender.ownerId}:${recipient.ownerId}`)).toBe(false);
    const quiet = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: sender.key,
      body: { code: recipient.code },
    });
    expect(quiet.json).toEqual({ status: "pending", ownerId: recipient.ownerId });
    expect(kv.has(`fr:req:${recipient.ownerId}:${sender.ownerId}`)).toBe(false);
    expect(kv.get(`fr:out:${sender.ownerId}:${recipient.ownerId}`).value).toBe("pending");
    const listed = await viaEntry("/v1/friends/requests", { friend: sender.key });
    expect(listed.json).toEqual({ incoming: [], outgoing: [{ ownerId: recipient.ownerId }] });
    expect(listed.text).not.toContain("blocked");
    expect(listed.text).not.toContain("fr:");
    const incoming = await viaEntry("/v1/friends/requests", { friend: recipient.key });
    expect(incoming.json.incoming).toEqual([]);
    expect(incoming.text).not.toContain(sender.ownerId);
  });

  it("hides a friend the caller blocked", async () => {
    const caller = await mint("block-caller");
    const other = await mint("block-other");
    const kept = await mint("block-kept");
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([other.ownerId, kept.ownerId]) });
    putMutual(caller.ownerId, other.ownerId);
    putMutual(caller.ownerId, kept.ownerId);
    kv.set(`fr:block:${caller.ownerId}:${other.ownerId}`, { value: "1" });
    const listed = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(ownerIds(listed.json.friends)).toEqual([kept.ownerId]);
    expect(listed.text).not.toContain(other.ownerId);
  });

  it("hides a friend who blocked the caller", async () => {
    const caller = await mint("rev-caller");
    const other = await mint("rev-other");
    const kept = await mint("rev-kept");
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([other.ownerId, kept.ownerId]) });
    putMutual(caller.ownerId, other.ownerId);
    putMutual(caller.ownerId, kept.ownerId);
    kv.set(`fr:block:${other.ownerId}:${caller.ownerId}`, { value: "1" });
    const listed = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(ownerIds(listed.json.friends)).toEqual([kept.ownerId]);
    expect(listed.text).not.toContain(other.ownerId);
  });

  it("does not list a one-sided friendship", async () => {
    const caller = await mint("side-caller");
    const forwardOnly = "a".repeat(22);
    const reverseOnly = "b".repeat(22);
    const mutual = "c".repeat(22);
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([forwardOnly, reverseOnly, mutual]) });
    kv.set(`fr:friend:${caller.ownerId}:${forwardOnly}`, { value: "1" });
    kv.set(`fr:friend:${reverseOnly}:${caller.ownerId}`, { value: "1" });
    putMutual(caller.ownerId, mutual);
    const listed = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(listed.json.friends).toEqual([{ ownerId: mutual }]);
  });

  it("does not return codes, friend keys, or raw KV keys", async () => {
    const caller = await mint("leak-caller");
    const other = await mint("leak-other");
    await viaEntry("/v1/friends/requests", { method: "POST", friend: caller.key, body: { code: other.code } });
    kv.set(`fr:req:${other.ownerId}:${caller.ownerId}`, { value: `${caller.code} fr:k:secret ${caller.key}` });
    const requests = await viaEntry("/v1/friends/requests", { friend: caller.key });
    await befriend(caller, other);
    const friends = await viaEntry("/v1/friends/list", { friend: caller.key });
    for (const result of [requests, friends]) {
      expect(result.text).not.toContain(caller.key);
      expect(result.text).not.toContain(other.key);
      expect(result.text).not.toContain(caller.code);
      expect(result.text).not.toContain(other.code);
      expect(result.text).not.toContain("fr:");
      expect(result.text).not.toContain("secret");
    }
    expect(requests.json.outgoing).toEqual([{ ownerId: other.ownerId }]);
    expect(friends.json.friends).toEqual([{ ownerId: other.ownerId }]);
  });

  it("hits the per-caller read rate limit", async () => {
    const caller = await mint("lim-key");
    for (let i = 0; i < FRIEND_READ_KEY_LIMIT; i += 1) {
      const ok = await viaEntry("/v1/friends/list", { friend: caller.key });
      expect(ok.status).toBe(200);
    }
    const counts = countKv();
    const limited = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(counts.list).toBe(0);
    expect(counts.put).toBe(0);
    expect(counts.delete).toBe(0);
    expect(counts.get).toBe(1);
    const other = await mint("lim-key-other");
    expect((await viaEntry("/v1/friends/list", { friend: other.key })).status).toBe(200);
    expect((await viaEntry("/v1/friends/requests", { friend: caller.key })).status).toBe(200);
    const lookup = await viaEntry("/v1/friends/codes/lookup", { method: "POST", friend: caller.key, body: { code: "HHHHHHHH" } });
    expect(lookup.status).toBe(404);
  });

  it("hits the per-IP request read rate limit", async () => {
    const ip = "203.0.113.77";
    const first = await mint("lim-ip");
    for (let i = 0; i < FRIEND_READ_IP_LIMIT; i += 1) {
      const ok = await viaEntry("/v1/friends/requests", { friend: first.key, ip });
      expect(ok.status).toBe(200);
    }
    const second = await mint("lim-ip-2");
    const limited = await viaEntry("/v1/friends/requests", { friend: second.key, ip });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect((await viaEntry("/v1/friends/requests", { friend: second.key })).status).toBe(200);
    expect((await viaEntry("/v1/friends/list", { friend: second.key, ip })).status).toBe(200);
  });

  it("rejects a request body", async () => {
    const caller = await mint("body-read");
    const counts = countKv();
    for (const path of ["/v1/friends/requests", "/v1/friends/list"]) {
      const small = await viaEntry(path, { friend: caller.key, headers: { "Content-Length": "2" } });
      expect(small.status).toBe(400);
      expect(small.json).toEqual({ error: "invalid_body" });
      const huge = await viaEntry(path, { friend: caller.key, headers: { "Content-Length": "3000" } });
      expect(huge.status).toBe(413);
      expect(huge.json).toEqual({ error: "payload_too_large" });
      const empty = await viaEntry(path, { friend: caller.key, headers: { "Content-Length": "0" } });
      expect(empty.status).toBe(200);
      const named = await entry.fetch({
        url: `${ORIGIN}${path}`,
        method: "GET",
        headers: new Headers({ "X-Friend-Key": caller.key, "Content-Type": "application/json" }),
        text: async () => JSON.stringify({ name: DISPLAY_NAME }),
      }, env, { waitUntil() {} });
      expect(named.status).toBe(400);
      expect(await named.json()).toEqual({ error: "invalid_body" });
      const fat = await entry.fetch({
        url: `${ORIGIN}${path}`,
        method: "GET",
        headers: new Headers({ "X-Friend-Key": caller.key }),
        text: async () => "x".repeat(3000),
      }, env, { waitUntil() {} });
      expect(fat.status).toBe(413);
      expect(await fat.json()).toEqual({ error: "payload_too_large" });
    }
    expect(counts.put).toBe(0);
    expect(counts.delete).toBe(0);
    expect((await viaEntry("/v1/friends/list", { friend: caller.key })).status).toBe(200);
  });

  it("does not write KV", async () => {
    const caller = await mint("nowrite");
    const other = await mint("nowrite-other");
    await viaEntry("/v1/friends/requests", { method: "POST", friend: caller.key, body: { code: other.code } });
    await viaEntry("/v1/friends/requests/accept", { method: "POST", friend: other.key, body: { ownerId: caller.ownerId } });
    const counts = countKv();
    const requests = await viaEntry("/v1/friends/requests", { friend: caller.key });
    const friends = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(requests.status).toBe(200);
    expect(friends.status).toBe(200);
    // Accept removed the caller's own earlier request too (build 169: no stale row after mutual sends).
    expect(requests.json.outgoing).toEqual([]);
    expect(friends.json.friends).toEqual([{ ownerId: other.ownerId }]);
    expect(counts.put).toBe(0);
    expect(counts.delete).toBe(0);
  });

  it("sorts requests and friends by ownerId", async () => {
    const caller = await mint("sort-caller");
    const low = "a".repeat(22);
    const high = "z".repeat(22);
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([high, low]) });
    putMutual(caller.ownerId, high);
    putMutual(caller.ownerId, low);
    const friends = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(ownerIds(friends.json.friends)).toEqual([low, high]);

    kv.set(`fr:req:${caller.ownerId}:${high}`, { value: "pending" });
    kv.set(`fr:req:${caller.ownerId}:${low}`, { value: "pending" });
    kv.set(`fr:req:${high}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${low}:${caller.ownerId}`, { value: "pending" });
    const boards = env.BOARDS;
    env.BOARDS = {
      ...boards,
      async list(options) {
        const page = await boards.list(options);
        return { ...page, keys: [...page.keys].reverse() };
      },
    };
    const requests = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(ownerIds(requests.json.incoming)).toEqual([low, high]);
    expect(ownerIds(requests.json.outgoing)).toEqual([low, high]);
  });

  it("caps the friend list at 50", async () => {
    const caller = await mint("cap-caller");
    const ids = Array.from({ length: FRIEND_CAP + 1 }, (_, index) => numberedOwner(index));
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify(ids) });
    for (const id of ids) putMutual(caller.ownerId, id);
    const listed = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(listed.json.friends).toHaveLength(FRIEND_CAP);
    expect(ownerIds(listed.json.friends)).toContain(numberedOwner(0));
    expect(ownerIds(listed.json.friends)).not.toContain(numberedOwner(FRIEND_CAP));
  });

  it("matches the documented KV op counts", async () => {
    const caller = await mint("ops-caller");
    const incoming = "d".repeat(22);
    const outgoing = "e".repeat(22);
    const strangerA = "f".repeat(22);
    const strangerB = "g".repeat(22);
    kv.set(`fr:req:${caller.ownerId}:${incoming}`, { value: "pending" });
    kv.set(`fr:req:${outgoing}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${strangerA}:${strangerB}`, { value: "pending" });
    const requestCounts = countKv();
    const requests = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(requests.json).toEqual({
      incoming: [{ ownerId: incoming }],
      outgoing: [{ ownerId: outgoing }],
    });
    // 4 base reads + one fr:ownname: read per returned entry.
    expect(requestCounts).toEqual({ get: 6, put: 0, delete: 0, list: 2 });

    const first = "h".repeat(22);
    const second = "j".repeat(22);
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([first, second]) });
    putMutual(caller.ownerId, first);
    putMutual(caller.ownerId, second);
    const friendCounts = countKv();
    const friends = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(ownerIds(friends.json.friends)).toEqual([first, second]);
    // 10 base reads + one fr:ownname: read per listed friend + the caller's own
    // fr:ownname: and fr:invname: backfill check (no invite name set here).
    expect(friendCounts).toEqual({ get: 14, put: 0, delete: 0, list: 0 });
  });

  it("follows the request list cursor", async () => {
    const caller = await mint("page-caller");
    const low = "k".repeat(22);
    const high = "m".repeat(22);
    kv.set(`fr:req:${caller.ownerId}:${high}`, { value: "pending" });
    kv.set(`fr:req:${low}:${caller.ownerId}`, { value: "pending" });
    const boards = env.BOARDS;
    let lists = 0;
    env.BOARDS = {
      ...boards,
      async list(options = {}) {
        lists += 1;
        const prefix = typeof options.prefix === "string" ? options.prefix : "";
        const names = [...kv.keys()].filter((name) => name.startsWith(prefix)).sort();
        const start = options.cursor ? Number(options.cursor) : 0;
        const slice = names.slice(start, start + 1);
        const next = start + slice.length;
        const done = next >= names.length;
        return {
          keys: slice.map((name) => ({ name })),
          list_complete: done,
          cursor: done ? undefined : String(next),
        };
      },
    };
    const listed = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(ownerIds(listed.json.incoming)).toEqual([high]);
    expect(ownerIds(listed.json.outgoing)).toEqual([low]);
    expect(lists).toBe(3);
  });

  it("fails closed without the guess limiter", async () => {
    const caller = await mint("nolimit");
    env.FRIEND_GUESSES = undefined;
    const counts = countKv();
    const requests = await viaEntry("/v1/friends/requests", { friend: caller.key });
    const friends = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(requests.status).toBe(503);
    expect(requests.json).toEqual({ error: "guess_limiter_not_configured" });
    expect(friends.status).toBe(503);
    expect(friends.json).toEqual({ error: "guess_limiter_not_configured" });
    expect(counts.list).toBe(0);
    expect(counts.put).toBe(0);
    expect(counts.delete).toBe(0);
    env.BOARDS = undefined;
    expect((await viaEntry("/v1/friends/list", { friend: caller.key })).json).toEqual({ error: "boards_not_configured" });
    expect((await viaEntry("/v1/friends/requests", { friend: caller.key })).json).toEqual({ error: "boards_not_configured" });
  });

  it("answers the read-route preflight without a friend key", async () => {
    const counts = countKv();
    for (const path of ["/v1/friends/requests", "/v1/friends/list"]) {
      const options = await viaEntry(path, { method: "OPTIONS" });
      expect(options.status).toBe(200);
      expect(options.text).toBe("");
      expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,PUT,OPTIONS");
      expect(options.headers.get("Access-Control-Allow-Headers")).toContain("X-Friend-Key");
    }
    expect(counts.get).toBe(0);
    expect(counts.put).toBe(0);
    expect(counts.delete).toBe(0);
    expect(counts.list).toBe(0);
  });
});
