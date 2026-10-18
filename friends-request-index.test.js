import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry from "./entry.js";
import worker, { FriendGuessLimiter } from "./worker.js";
import { FRIEND_CAP, FRIEND_READ_KEY_LIMIT } from "./friends.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const OWNER_RE = /^[A-Za-z0-9_-]{22}$/;

function friendKey(suffix) {
  return `${suffix}${"a".repeat(32)}`.slice(0, 43);
}

function ownerId(label) {
  return `${label}${"x".repeat(22)}`.slice(0, 22);
}

function reqKey(recipient, requester) {
  return `fr:req:${recipient}:${requester}`;
}

function noteKey(sender, recipient) {
  return `fr:out:${sender}:${recipient}`;
}

function indexKey(owner) {
  return `fr:reqix:${owner}`;
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

function compareOwner(left, right) {
  if (left.ownerId < right.ownerId) return -1;
  if (left.ownerId > right.ownerId) return 1;
  return 0;
}

function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.ownerId)) continue;
    seen.add(entry.ownerId);
    out.push(entry);
  }
  return out;
}

function rowValue(store, key) {
  const row = store.get(key);
  return row && typeof row.value === "string" ? row.value : "";
}

function hasValue(store, key) {
  return rowValue(store, key).length > 0;
}

// The pre-index scan. Independent of listRequests, so a body change fails this.
function legacyRequests(store, callerId) {
  const incoming = [];
  const outgoing = [];
  for (const [name, row] of store) {
    if (!name.startsWith("fr:req:")) continue;
    const parts = name.slice("fr:req:".length).split(":");
    if (parts.length !== 2 || !OWNER_RE.test(parts[0]) || !OWNER_RE.test(parts[1]) || parts[0] === parts[1]) continue;
    if (typeof row.value !== "string" || row.value.length === 0) continue;
    if (parts[0] === callerId) {
      if (hasValue(store, `fr:block:${callerId}:${parts[1]}`)) continue;
      incoming.push({ ownerId: parts[1] });
    } else if (parts[1] === callerId) {
      outgoing.push({ ownerId: parts[0] });
    }
  }
  const notePrefix = `fr:out:${callerId}:`;
  for (const [name, row] of store) {
    if (!name.startsWith(notePrefix)) continue;
    const recipient = name.slice(notePrefix.length);
    if (!OWNER_RE.test(recipient) || recipient === callerId) continue;
    if (typeof row.value !== "string" || row.value.length === 0) continue;
    outgoing.push({ ownerId: recipient });
  }
  return JSON.stringify({
    incoming: dedupe(incoming).sort(compareOwner),
    outgoing: dedupe(outgoing).sort(compareOwner),
  });
}

function legacyFriends(store, callerId) {
  let ids = [];
  const raw = rowValue(store, `fr:friends:${callerId}`);
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set();
        for (const item of parsed) {
          if (typeof item !== "string" || !OWNER_RE.test(item) || item === callerId || seen.has(item)) continue;
          seen.add(item);
          ids.push(item);
        }
      }
    } catch {
      ids = [];
    }
  }
  const friends = [];
  for (const otherId of ids.slice(0, FRIEND_CAP)) {
    if (!hasValue(store, `fr:friend:${callerId}:${otherId}`)) continue;
    if (!hasValue(store, `fr:friend:${otherId}:${callerId}`)) continue;
    if (hasValue(store, `fr:block:${callerId}:${otherId}`)) continue;
    if (hasValue(store, `fr:block:${otherId}:${callerId}`)) continue;
    friends.push({ ownerId: otherId });
  }
  return JSON.stringify({ friends: dedupe(friends).sort(compareOwner) });
}

function parseIndex(store, owner) {
  const raw = rowValue(store, indexKey(owner));
  if (raw.length === 0) return null;
  return JSON.parse(raw);
}

describe("friend request index and accept note cleanup", () => {
  /** @type {Map<string, { value: string, expirationTtl?: number }>} */
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

  async function call(pathname, { method = "GET", body, headers, friend, ip } = {}) {
    const requestHeaders = { ...(headers || {}) };
    if (friend) requestHeaders["X-Friend-Key"] = friend;
    if (ip) requestHeaders["CF-Connecting-IP"] = ip;
    if (body !== undefined && !requestHeaders["Content-Type"]) requestHeaders["Content-Type"] = "application/json";
    const response = await entry.fetch(new Request(`${ORIGIN}${pathname}`, {
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

  async function mint(suffix) {
    const key = friendKey(suffix);
    const created = await call("/v1/friends/code", { method: "POST", friend: key, body: {} });
    expect(created.status).toBe(200);
    return { key, code: created.json.code, ownerId: created.json.ownerId };
  }

  async function befriend(from, to) {
    const sent = await call("/v1/friends/requests", { method: "POST", friend: from.key, body: { code: to.code } });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    const accepted = await call("/v1/friends/requests/accept", { method: "POST", friend: to.key, body: { ownerId: from.ownerId } });
    expect(accepted.json).toEqual({ status: "friends", ownerId: from.ownerId });
  }

  function putMutual(left, right) {
    kv.set(`fr:friend:${left}:${right}`, { value: "1" });
    kv.set(`fr:friend:${right}:${left}`, { value: "1" });
  }

  function watchKv() {
    const seen = { get: [], put: [], delete: [], list: [], ops: [] };
    const boards = env.BOARDS;
    env.BOARDS = {
      async get(key) {
        seen.get.push(key);
        seen.ops.push(`get ${key}`);
        return boards.get(key);
      },
      async put(key, value, options) {
        seen.put.push({ key, value, options });
        seen.ops.push(`put ${key}`);
        return boards.put(key, value, options);
      },
      async delete(key) {
        seen.delete.push(key);
        seen.ops.push(`delete ${key}`);
        return boards.delete(key);
      },
      async list(options) {
        seen.list.push(options);
        seen.ops.push(`list ${options && options.prefix}`);
        return boards.list(options);
      },
    };
    return {
      seen,
      restore() {
        env.BOARDS = boards;
      },
    };
  }

  it("accept deletes the caller's own stale note and drops that person from outgoing", async () => {
    const caller = await mint("note-caller");
    const requester = await mint("note-requester");
    await befriend(caller, requester);
    expect((await call("/v1/friends/block", {
      method: "POST",
      friend: requester.key,
      body: { ownerId: caller.ownerId },
    })).json).toEqual({ ok: true });
    const quiet = await call("/v1/friends/requests", {
      method: "POST",
      friend: caller.key,
      body: { code: requester.code },
    });
    expect(quiet.json).toEqual({ status: "pending", ownerId: requester.ownerId });
    expect(kv.get(noteKey(caller.ownerId, requester.ownerId)).value).toBe("pending");
    expect(kv.has(reqKey(requester.ownerId, caller.ownerId))).toBe(false);

    expect((await call("/v1/friends/unblock", {
      method: "POST",
      friend: requester.key,
      body: { ownerId: caller.ownerId },
    })).json).toEqual({ ok: true });
    const sent = await call("/v1/friends/requests", {
      method: "POST",
      friend: requester.key,
      body: { code: caller.code },
    });
    expect(sent.json).toEqual({ status: "pending", ownerId: caller.ownerId });
    kv.set(noteKey(requester.ownerId, caller.ownerId), { value: "pending" });
    expect(kv.get(noteKey(caller.ownerId, requester.ownerId)).value).toBe("pending");

    const before = await call("/v1/friends/requests", { friend: caller.key });
    expect(before.json.outgoing).toEqual([{ ownerId: requester.ownerId }]);
    expect(before.json.incoming).toEqual([{ ownerId: requester.ownerId }]);

    const watched = watchKv();
    const accepted = await call("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    watched.restore();
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ status: "friends", ownerId: requester.ownerId });
    expect(accepted.text).toBe(`{"status":"friends","ownerId":"${requester.ownerId}"}`);

    const callerNote = noteKey(caller.ownerId, requester.ownerId);
    const requesterNote = noteKey(requester.ownerId, caller.ownerId);
    const pendingKey = reqKey(caller.ownerId, requester.ownerId);
    expect(watched.seen.get).not.toContain(callerNote);
    expect(watched.seen.get).not.toContain(requesterNote);
    const confirmed = watched.seen.ops.indexOf(`get ${pendingKey}`);
    const callerDelete = watched.seen.ops.indexOf(`delete ${callerNote}`);
    const requesterDelete = watched.seen.ops.indexOf(`delete ${requesterNote}`);
    const reqDelete = watched.seen.ops.indexOf(`delete ${pendingKey}`);
    expect(confirmed).toBeGreaterThanOrEqual(0);
    expect(callerDelete).toBeGreaterThan(confirmed);
    expect(requesterDelete).toBeGreaterThan(confirmed);
    expect(reqDelete).toBeGreaterThan(callerDelete);
    expect(reqDelete).toBeGreaterThan(requesterDelete);
    expect(kv.has(callerNote)).toBe(false);
    expect(kv.has(requesterNote)).toBe(false);
    expect(kv.has(pendingKey)).toBe(false);

    const after = await call("/v1/friends/requests", { friend: caller.key });
    expect(after.text).toBe('{"incoming":[],"outgoing":[]}');
    expect(after.json.outgoing).toEqual([]);
    const requesterList = await call("/v1/friends/requests", { friend: requester.key });
    expect(requesterList.json.outgoing).toEqual([]);
    const friends = await call("/v1/friends/list", { friend: caller.key });
    expect(friends.text).toBe(JSON.stringify({ friends: [{ ownerId: requester.ownerId }] }));
  });

  it("accept deletes the caller note key even when that note is absent", async () => {
    const caller = await mint("blind-caller");
    const requester = await mint("blind-requester");
    const sent = await call("/v1/friends/requests", {
      method: "POST",
      friend: requester.key,
      body: { code: caller.code },
    });
    expect(sent.json.status).toBe("pending");
    expect(kv.has(noteKey(caller.ownerId, requester.ownerId))).toBe(false);
    const watched = watchKv();
    const accepted = await call("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    watched.restore();
    expect(accepted.status).toBe(200);
    const callerNote = noteKey(caller.ownerId, requester.ownerId);
    expect(watched.seen.delete).toContain(callerNote);
    expect(watched.seen.get).not.toContain(callerNote);
    expect(watched.seen.ops.indexOf(`delete ${callerNote}`)).toBeGreaterThan(watched.seen.ops.indexOf(`get ${reqKey(caller.ownerId, requester.ownerId)}`));
    expect((await call("/v1/friends/requests", { friend: caller.key })).json.outgoing).toEqual([]);
  });

  it("a failed accept leaves the caller's stale note in place", async () => {
    const caller = await mint("fail-caller");
    const requester = await mint("fail-requester");
    const callerNote = noteKey(caller.ownerId, requester.ownerId);
    kv.set(callerNote, { value: "pending" });
    const missing = await call("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(missing.status).toBe(409);
    expect(missing.json).toEqual({ error: "not_friends" });
    expect(kv.get(callerNote).value).toBe("pending");
    expect((await call("/v1/friends/requests", { friend: caller.key })).json.outgoing).toEqual([{ ownerId: requester.ownerId }]);

    kv.set(`fr:block:${caller.ownerId}:${requester.ownerId}`, { value: "1" });
    kv.set(reqKey(caller.ownerId, requester.ownerId), { value: "pending" });
    const blocked = await call("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toEqual({ error: "blocked" });
    expect(kv.get(callerNote).value).toBe("pending");
    expect(kv.get(reqKey(caller.ownerId, requester.ownerId)).value).toBe("pending");
    kv.delete(`fr:block:${caller.ownerId}:${requester.ownerId}`);

    const filler = Array.from({ length: FRIEND_CAP }, (_, index) => ownerId(`f${index}`));
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify(filler) });
    const limited = await call("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(limited.status).toBe(409);
    expect(limited.json).toEqual({ error: "friend_limit" });
    expect(kv.get(callerNote).value).toBe("pending");
    expect(kv.get(reqKey(caller.ownerId, requester.ownerId)).value).toBe("pending");
    expect(kv.has(`fr:friend:${caller.ownerId}:${requester.ownerId}`)).toBe(false);
    const still = await call("/v1/friends/requests", { friend: caller.key });
    expect(still.json.outgoing).toEqual([{ ownerId: requester.ownerId }]);
    expect(still.text).not.toContain("blocked");
  });

  it("send writes both request indexes and a repeat does not list", async () => {
    const caller = await mint("idx-caller");
    const other = await mint("idx-other");
    const stranger = ownerId("stranger");
    kv.set(reqKey(stranger, ownerId("else")), { value: "pending" });
    const watched = watchKv();
    const sent = await call("/v1/friends/requests", {
      method: "POST",
      friend: caller.key,
      body: { code: other.code },
    });
    watched.restore();
    expect(sent.json).toEqual({ status: "pending", ownerId: other.ownerId });
    expect(watched.seen.list.map((options) => options.prefix)).toEqual(["fr:req:"]);
    const callerIndex = parseIndex(kv, caller.ownerId);
    const otherIndex = parseIndex(kv, other.ownerId);
    expect(callerIndex).toEqual({ incoming: [], outgoing: [other.ownerId] });
    expect(otherIndex).toEqual({ incoming: [caller.ownerId], outgoing: [] });
    expect(Object.keys(callerIndex).sort()).toEqual(["incoming", "outgoing"]);
    expect(kv.get(indexKey(caller.ownerId)).expirationTtl).toBeUndefined();
    expect(kv.get(reqKey(other.ownerId, caller.ownerId)).value).toBe("pending");
    expect(kv.get(reqKey(other.ownerId, caller.ownerId)).expirationTtl).toBeUndefined();
    expect(kv.has(indexKey(stranger))).toBe(false);
    expect(callerIndex.outgoing).not.toContain(stranger);

    const again = watchKv();
    const repeat = await call("/v1/friends/requests", {
      method: "POST",
      friend: caller.key,
      body: { code: other.code },
    });
    again.restore();
    expect(repeat.text).toBe(sent.text);
    expect(again.seen.list).toEqual([]);
    expect(again.seen.put).toEqual([]);
    expect(kv.get(reqKey(other.ownerId, caller.ownerId)).value).toBe("pending");
  });

  it("a new request does not scan fr:req when both indexes already exist", async () => {
    const left = await mint("pair-left");
    const right = await mint("pair-right");
    const third = await mint("pair-third");
    expect((await call("/v1/friends/requests", { method: "POST", friend: left.key, body: { code: right.code } })).status).toBe(200);
    expect((await call("/v1/friends/requests", { method: "POST", friend: third.key, body: { code: right.code } })).status).toBe(200);
    const watched = watchKv();
    const sent = await call("/v1/friends/requests", { method: "POST", friend: left.key, body: { code: third.code } });
    watched.restore();
    expect(sent.json).toEqual({ status: "pending", ownerId: third.ownerId });
    expect(watched.seen.list).toEqual([]);
    expect(parseIndex(kv, left.ownerId).outgoing).toEqual([right.ownerId, third.ownerId]);
    expect(parseIndex(kv, third.ownerId).incoming).toEqual([left.ownerId]);
    expect(parseIndex(kv, third.ownerId).outgoing).toEqual([right.ownerId]);
    const listed = await call("/v1/friends/requests", { friend: left.key });
    expect(listed.json.outgoing.map((entry) => entry.ownerId).sort()).toEqual([right.ownerId, third.ownerId].sort());
  });

  it("a request with no index is still listed", async () => {
    const caller = await mint("pre-caller");
    const incoming = ownerId("prein");
    const outgoing = ownerId("preout");
    kv.set(reqKey(caller.ownerId, incoming), { value: "pending" });
    kv.set(reqKey(outgoing, caller.ownerId), { value: "pending" });
    kv.set(reqKey(ownerId("sa"), ownerId("sb")), { value: "pending" });
    expect(kv.has(indexKey(caller.ownerId))).toBe(false);
    const watched = watchKv();
    const listed = await call("/v1/friends/requests", { friend: caller.key });
    watched.restore();
    expect(listed.text).toBe(legacyRequests(kv, caller.ownerId));
    expect(listed.json).toEqual({
      incoming: [{ ownerId: incoming }],
      outgoing: [{ ownerId: outgoing }],
    });
    expect(watched.seen.list.map((options) => options.prefix).sort()).toEqual(["fr:req:", `fr:out:${caller.ownerId}:`].sort());
    expect(watched.seen.put).toEqual([]);
    expect(watched.seen.delete).toEqual([]);
    expect(kv.has(indexKey(caller.ownerId))).toBe(false);
  });

  it("a later send still lists a request that predates the index", async () => {
    const caller = await mint("back-caller");
    const other = await mint("back-other");
    const oldIncoming = ownerId("oldin");
    const oldOutgoing = ownerId("oldout");
    kv.set(reqKey(caller.ownerId, oldIncoming), { value: "pending" });
    kv.set(reqKey(oldOutgoing, caller.ownerId), { value: "pending" });
    const before = await call("/v1/friends/requests", { friend: caller.key });
    expect(before.text).toBe(legacyRequests(kv, caller.ownerId));
    const sent = await call("/v1/friends/requests", { method: "POST", friend: caller.key, body: { code: other.code } });
    expect(sent.json).toEqual({ status: "pending", ownerId: other.ownerId });
    const listed = await call("/v1/friends/requests", { friend: caller.key });
    expect(listed.text).toBe(legacyRequests(kv, caller.ownerId));
    expect(listed.json.incoming).toEqual([{ ownerId: oldIncoming }]);
    expect(listed.json.outgoing.map((entry) => entry.ownerId).sort()).toEqual([oldOutgoing, other.ownerId].sort());
    expect(parseIndex(kv, caller.ownerId).incoming).toContain(oldIncoming);
    expect(parseIndex(kv, caller.ownerId).outgoing).toEqual(expect.arrayContaining([oldOutgoing, other.ownerId]));
    expect(parseIndex(kv, other.ownerId).incoming).toContain(caller.ownerId);
  });

  it("an unusable index falls back to the scan", async () => {
    const caller = await mint("bad-index");
    const incoming = ownerId("badin");
    kv.set(reqKey(caller.ownerId, incoming), { value: "pending" });
    kv.set(indexKey(caller.ownerId), { value: "not-json" });
    const garbage = await call("/v1/friends/requests", { friend: caller.key });
    expect(garbage.text).toBe(legacyRequests(kv, caller.ownerId));
    expect(garbage.json.incoming).toEqual([{ ownerId: incoming }]);
    kv.set(indexKey(caller.ownerId), { value: JSON.stringify({ incoming: [], outgoing: [], name: "Ada" }) });
    const extra = await call("/v1/friends/requests", { friend: caller.key });
    expect(extra.text).toBe(garbage.text);
    expect(kv.get(indexKey(caller.ownerId)).value).toContain("Ada");
  });

  it("accept removes the pair from both request indexes", async () => {
    const caller = await mint("acc-caller");
    const dropped = await mint("acc-drop");
    const kept = await mint("acc-kept");
    expect((await call("/v1/friends/requests", { method: "POST", friend: dropped.key, body: { code: caller.code } })).status).toBe(200);
    expect((await call("/v1/friends/requests", { method: "POST", friend: kept.key, body: { code: caller.code } })).status).toBe(200);
    const accepted = await call("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: dropped.ownerId },
    });
    expect(accepted.json).toEqual({ status: "friends", ownerId: dropped.ownerId });
    expect(kv.has(reqKey(caller.ownerId, dropped.ownerId))).toBe(false);
    expect(kv.get(reqKey(caller.ownerId, kept.ownerId)).value).toBe("pending");
    expect(parseIndex(kv, caller.ownerId).incoming).toEqual([kept.ownerId]);
    expect(parseIndex(kv, dropped.ownerId).outgoing).toEqual([]);
    expect(parseIndex(kv, kept.ownerId).outgoing).toEqual([caller.ownerId]);
    const listed = await call("/v1/friends/requests", { friend: caller.key });
    expect(listed.text).toBe(JSON.stringify({ incoming: [{ ownerId: kept.ownerId }], outgoing: [] }));
  });

  it("block removes both request directions from the indexes", async () => {
    const caller = await mint("blk-caller");
    const other = await mint("blk-other");
    const kept = await mint("blk-kept");
    expect((await call("/v1/friends/requests", { method: "POST", friend: caller.key, body: { code: other.code } })).status).toBe(200);
    expect((await call("/v1/friends/requests", { method: "POST", friend: other.key, body: { code: caller.code } })).status).toBe(200);
    expect((await call("/v1/friends/requests", { method: "POST", friend: caller.key, body: { code: kept.code } })).status).toBe(200);
    putMutual(caller.ownerId, other.ownerId);
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([other.ownerId]) });
    kv.set(`fr:friends:${other.ownerId}`, { value: JSON.stringify([caller.ownerId]) });
    const watched = watchKv();
    const blocked = await call("/v1/friends/block", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: other.ownerId },
    });
    watched.restore();
    expect(blocked.json).toEqual({ ok: true });
    expect(kv.has(reqKey(other.ownerId, caller.ownerId))).toBe(false);
    expect(kv.has(reqKey(caller.ownerId, other.ownerId))).toBe(false);
    expect(kv.get(reqKey(kept.ownerId, caller.ownerId)).value).toBe("pending");
    expect(parseIndex(kv, caller.ownerId).incoming).not.toContain(other.ownerId);
    expect(parseIndex(kv, caller.ownerId).outgoing).toEqual([kept.ownerId]);
    expect(parseIndex(kv, other.ownerId).incoming).not.toContain(caller.ownerId);
    expect(parseIndex(kv, other.ownerId).outgoing).not.toContain(caller.ownerId);
    expect(parseIndex(kv, kept.ownerId).incoming).toEqual([caller.ownerId]);
    const listed = await call("/v1/friends/requests", { friend: caller.key });
    expect(listed.json).toEqual({ incoming: [], outgoing: [{ ownerId: kept.ownerId }] });

    const quiet = await mint("blk-quiet");
    const target = await mint("blk-target");
    await befriend(quiet, target);
    const beforeQuietBlock = kv.get(indexKey(quiet.ownerId)).value;
    const quietWatched = watchKv();
    expect((await call("/v1/friends/block", {
      method: "POST",
      friend: target.key,
      body: { ownerId: quiet.ownerId },
    })).json).toEqual({ ok: true });
    quietWatched.restore();
    expect(quietWatched.seen.get.some((key) => key.startsWith("fr:reqix:"))).toBe(false);
    expect(quietWatched.seen.put.some((item) => item.key.startsWith("fr:reqix:"))).toBe(false);
    expect(kv.get(indexKey(quiet.ownerId)).value).toBe(beforeQuietBlock);
  });

  it("quiet send, remove, unblock, and a refused block do not write fr:reqix", async () => {
    const sender = await mint("quiet-sender");
    const recipient = await mint("quiet-recipient");
    await befriend(sender, recipient);
    expect((await call("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: sender.ownerId },
    })).json).toEqual({ ok: true });
    const before = [...kv.keys()].filter((name) => name.startsWith("fr:reqix:")).sort();
    const quiet = await call("/v1/friends/requests", {
      method: "POST",
      friend: sender.key,
      body: { code: recipient.code },
    });
    expect(quiet.json).toEqual({ status: "pending", ownerId: recipient.ownerId });
    expect([...kv.keys()].filter((name) => name.startsWith("fr:reqix:")).sort()).toEqual(before);
    expect(kv.has(reqKey(recipient.ownerId, sender.ownerId))).toBe(false);

    const indexes = new Map([...kv.entries()].filter(([name]) => name.startsWith("fr:reqix:")));
    expect((await call("/v1/friends/unblock", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: sender.ownerId },
    })).json).toEqual({ ok: true });
    expect((await call("/v1/friends/remove", {
      method: "POST",
      friend: sender.key,
      body: { ownerId: recipient.ownerId },
    })).status).toBe(409);
    const stranger = await mint("quiet-stranger");
    expect((await call("/v1/friends/block", {
      method: "POST",
      friend: sender.key,
      body: { ownerId: stranger.ownerId },
    })).json).toEqual({ error: "not_friends" });
    const reset = await call("/v1/friends/code/reset", { method: "POST", friend: sender.key, body: {} });
    expect(reset.status).toBe(200);
    for (const [name, row] of indexes) expect(kv.get(name).value).toBe(row.value);
  });

  it("indexed and pre-index reads return the same body", async () => {
    const caller = await mint("same-caller");
    const otherCaller = await mint("same-other");
    const visible = ownerId("vis");
    const blockedRequester = ownerId("blk");
    const outgoingReal = ownerId("out");
    const blockedOutgoing = ownerId("bout");
    const quiet = ownerId("qnote");
    const both = ownerId("both");
    const emptyIncoming = ownerId("empty");
    const strangerA = ownerId("sta");
    const strangerB = ownerId("stb");
    const mutual = ownerId("mut");
    const hiddenFriend = ownerId("hid");
    const oneSided = ownerId("one");
    const kept = ownerId("kept");

    kv.set(reqKey(caller.ownerId, visible), { value: "pending" });
    kv.set(reqKey(caller.ownerId, blockedRequester), { value: "pending" });
    kv.set(reqKey(caller.ownerId, emptyIncoming), { value: "" });
    kv.set(reqKey(outgoingReal, caller.ownerId), { value: "pending" });
    kv.set(reqKey(blockedOutgoing, caller.ownerId), { value: "pending" });
    kv.set(reqKey(both, caller.ownerId), { value: "pending" });
    kv.set(reqKey(strangerA, strangerB), { value: "pending" });
    kv.set(reqKey(caller.ownerId, caller.ownerId), { value: "pending" });
    kv.set(noteKey(caller.ownerId, quiet), { value: "pending" });
    kv.set(noteKey(caller.ownerId, both), { value: "pending" });
    kv.set(noteKey(caller.ownerId, "not-an-owner"), { value: "pending" });
    kv.set(noteKey(caller.ownerId, emptyIncoming), { value: "" });
    kv.set(`fr:block:${caller.ownerId}:${blockedRequester}`, { value: "1" });
    kv.set(`fr:block:${blockedOutgoing}:${caller.ownerId}`, { value: "1" });
    kv.set(reqKey(otherCaller.ownerId, visible), { value: "pending" });
    kv.set(noteKey(otherCaller.ownerId, quiet), { value: "pending" });
    kv.set(`fr:block:${otherCaller.ownerId}:${blockedRequester}`, { value: "1" });
    kv.set(reqKey(otherCaller.ownerId, blockedRequester), { value: "pending" });

    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([hiddenFriend, mutual, oneSided, kept, mutual]) });
    putMutual(caller.ownerId, mutual);
    putMutual(caller.ownerId, hiddenFriend);
    putMutual(caller.ownerId, kept);
    kv.set(`fr:friend:${caller.ownerId}:${oneSided}`, { value: "1" });
    kv.set(`fr:block:${hiddenFriend}:${caller.ownerId}`, { value: "1" });

    const requests = await call("/v1/friends/requests", { friend: caller.key });
    const friends = await call("/v1/friends/list", { friend: caller.key });
    const otherRequests = await call("/v1/friends/requests", { friend: otherCaller.key });
    const otherFriends = await call("/v1/friends/list", { friend: otherCaller.key });
    expect(requests.status).toBe(200);
    expect(friends.status).toBe(200);
    expect(requests.text).toBe(legacyRequests(kv, caller.ownerId));
    expect(friends.text).toBe(legacyFriends(kv, caller.ownerId));
    expect(otherRequests.text).toBe(legacyRequests(kv, otherCaller.ownerId));
    expect(otherFriends.text).toBe(legacyFriends(kv, otherCaller.ownerId));
    expect(requests.text).not.toContain(blockedRequester);
    expect(requests.text).not.toContain("blocked");
    expect(requests.text).not.toContain("fr:");
    expect(requests.text).toContain(quiet);
    expect(requests.text).toContain(blockedOutgoing);
    expect(requests.json.outgoing.filter((entry) => entry.ownerId === both)).toHaveLength(1);
    expect(Object.keys(requests.json).sort()).toEqual(["incoming", "outgoing"]);
    expect(Object.keys(friends.json)).toEqual(["friends"]);
    for (const entry of [...requests.json.incoming, ...requests.json.outgoing, ...friends.json.friends]) {
      expect(Object.keys(entry)).toEqual(["ownerId"]);
    }
    expect(kv.has(indexKey(caller.ownerId))).toBe(false);

    const incoming = [];
    const outgoing = [];
    for (const name of [...kv.keys()].filter((name) => name.startsWith("fr:req:")).sort()) {
      const parts = name.slice("fr:req:".length).split(":");
      if (parts.length !== 2 || !OWNER_RE.test(parts[0]) || !OWNER_RE.test(parts[1]) || parts[0] === parts[1]) continue;
      if (parts[0] === caller.ownerId) incoming.push(parts[1]);
      if (parts[1] === caller.ownerId) outgoing.push(parts[0]);
    }
    kv.set(indexKey(caller.ownerId), { value: JSON.stringify({ incoming, outgoing }) });

    const watched = watchKv();
    const indexed = await call("/v1/friends/requests", { friend: caller.key });
    const indexedFriends = await call("/v1/friends/list", { friend: caller.key });
    watched.restore();
    expect(indexed.text).toBe(requests.text);
    expect(indexedFriends.text).toBe(friends.text);
    expect(watched.seen.list.map((options) => options.prefix)).toEqual([`fr:out:${caller.ownerId}:`]);
    expect(watched.seen.list.some((options) => options.prefix === "fr:req:")).toBe(false);
    expect(watched.seen.get).not.toContain(reqKey(strangerA, strangerB));
    expect(watched.seen.get).not.toContain(indexKey(otherCaller.ownerId));
    expect(watched.seen.put).toEqual([]);
    expect(watched.seen.delete).toEqual([]);
    expect(indexed.text).not.toContain(blockedRequester);
    expect(indexed.text).toContain(quiet);

    const stillPreIndex = await call("/v1/friends/requests", { friend: otherCaller.key });
    expect(stillPreIndex.text).toBe(otherRequests.text);
    expect(stillPreIndex.text).not.toContain(blockedRequester);
    expect(stillPreIndex.text).toContain(quiet);
    expect(kv.has(indexKey(otherCaller.ownerId))).toBe(false);
  });

  it("an indexed read hides a blocked requester and keeps a quiet note", async () => {
    const caller = await mint("filter-caller");
    const requester = await mint("filter-req");
    const visible = await mint("filter-vis");
    const noted = ownerId("filternote");
    expect((await call("/v1/friends/requests", { method: "POST", friend: requester.key, body: { code: caller.code } })).status).toBe(200);
    expect((await call("/v1/friends/requests", { method: "POST", friend: visible.key, body: { code: caller.code } })).status).toBe(200);
    kv.set(`fr:block:${caller.ownerId}:${requester.ownerId}`, { value: "1" });
    kv.set(noteKey(caller.ownerId, noted), { value: "pending" });
    const listed = await call("/v1/friends/requests", { friend: caller.key });
    expect(listed.text).toBe(legacyRequests(kv, caller.ownerId));
    expect(listed.json.incoming).toEqual([{ ownerId: visible.ownerId }]);
    expect(listed.text).not.toContain(requester.ownerId);
    expect(listed.json.outgoing).toEqual([{ ownerId: noted }]);
    expect(listed.text).not.toContain("blocked");
    const sender = await call("/v1/friends/requests", { friend: requester.key });
    expect(sender.json.outgoing).toEqual([{ ownerId: caller.ownerId }]);
    expect(sender.text).toBe(legacyRequests(kv, requester.ownerId));
  });

  it("matches indexed and fallback KV counts and leaves listFriends alone", async () => {
    const caller = await mint("ops-caller");
    const incoming = ownerId("opsin");
    const blocked = ownerId("opsblk");
    const emptyIn = ownerId("opse");
    const outgoing = ownerId("opsout");
    const emptyOut = ownerId("opsz");
    const noted = ownerId("opsnote");
    const emptyNote = ownerId("opsen");
    kv.set(reqKey(caller.ownerId, incoming), { value: "pending" });
    kv.set(reqKey(caller.ownerId, blocked), { value: "pending" });
    kv.set(reqKey(caller.ownerId, emptyIn), { value: "" });
    kv.set(reqKey(outgoing, caller.ownerId), { value: "pending" });
    kv.set(reqKey(emptyOut, caller.ownerId), { value: "" });
    kv.set(reqKey(ownerId("opssa"), ownerId("opssb")), { value: "pending" });
    kv.set(`fr:block:${caller.ownerId}:${blocked}`, { value: "1" });
    kv.set(noteKey(caller.ownerId, noted), { value: "pending" });
    kv.set(noteKey(caller.ownerId, emptyNote), { value: "" });
    kv.set(noteKey(caller.ownerId, "bad"), { value: "pending" });

    const fallback = watchKv();
    const fallbackBody = await call("/v1/friends/requests", { friend: caller.key });
    fallback.restore();
    expect(fallbackBody.text).toBe(legacyRequests(kv, caller.ownerId));
    // 2 + I + B + O + Q = 2 + 3 + 2 + 2 + 2, and P + S = 2 lists.
    expect(fallback.seen.get).toHaveLength(2 + 3 + 2 + 2 + 2);
    expect(fallback.seen.list).toHaveLength(2);
    expect(fallback.seen.put).toEqual([]);
    expect(fallback.seen.delete).toEqual([]);

    kv.set(indexKey(caller.ownerId), {
      value: JSON.stringify({
        incoming: [incoming, blocked, emptyIn, "not-an-owner", caller.ownerId],
        outgoing: [outgoing, emptyOut],
      }),
    });
    const indexed = watchKv();
    const indexedBody = await call("/v1/friends/requests", { friend: caller.key });
    indexed.restore();
    expect(indexedBody.text).toBe(fallbackBody.text);
    expect(indexed.seen.get).toHaveLength(2 + 3 + 2 + 2 + 2);
    expect(indexed.seen.list).toHaveLength(1);
    expect(indexed.seen.list[0].prefix).toBe(`fr:out:${caller.ownerId}:`);
    expect(indexed.seen.get).not.toContain(reqKey(ownerId("opssa"), ownerId("opssb")));
    expect(indexed.seen.get).not.toContain(noteKey(caller.ownerId, "bad"));
    expect(indexed.seen.put).toEqual([]);
    expect(indexed.seen.delete).toEqual([]);

    const friend = ownerId("opsfriend");
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([friend]) });
    putMutual(caller.ownerId, friend);
    const friendsWatched = watchKv();
    const friends = await call("/v1/friends/list", { friend: caller.key });
    friendsWatched.restore();
    expect(friends.text).toBe(legacyFriends(kv, caller.ownerId));
    expect(friends.text).toBe(JSON.stringify({ friends: [{ ownerId: friend }] }));
    expect(friendsWatched.seen.get).toHaveLength(2 + 4);
    expect(friendsWatched.seen.list).toEqual([]);
    expect(friendsWatched.seen.get.some((key) => key.startsWith("fr:reqix:"))).toBe(false);
    expect(friendsWatched.seen.put).toEqual([]);
    expect(friendsWatched.seen.delete).toEqual([]);
  });

  it("does not spend the read limit on the index when the caller is already limited", async () => {
    const caller = await mint("lim-idx");
    kv.set(reqKey(caller.ownerId, ownerId("limin")), { value: "pending" });
    for (let i = 0; i < FRIEND_READ_KEY_LIMIT; i += 1) {
      expect((await call("/v1/friends/requests", { friend: caller.key })).status).toBe(200);
    }
    const watched = watchKv();
    const limited = await call("/v1/friends/requests", { friend: caller.key });
    watched.restore();
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(watched.seen.get).toHaveLength(1);
    expect(watched.seen.get.some((key) => key.startsWith("fr:reqix:"))).toBe(false);
    expect(watched.seen.list).toEqual([]);
    expect(watched.seen.put).toEqual([]);
    expect(watched.seen.delete).toEqual([]);
    expect((await call("/v1/friends/list", { friend: caller.key })).status).toBe(200);
  });

  it("reserves fr:reqix on board paths", async () => {
    const raw = `/fr:reqix:${"a".repeat(22)}`;
    const encoded = `/${encodeURIComponent(`fr:reqix:${"b".repeat(22)}`)}`;
    const watched = watchKv();
    for (const path of [raw, encoded]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await call(path, { method, body: method === "PUT" ? { forged: true } : undefined });
        expect(response.status, `${method} ${path}`).toBe(400);
        expect(response.text, `${method} ${path}`).toBe("bad key");
      }
    }
    watched.restore();
    expect(watched.seen).toEqual({ get: [], put: [], delete: [], list: [], ops: [] });
  });

  it("documents the request index and the acceptor note delete", () => {
    const contract = readFileSync(new URL("./docs/friends-api.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    expect(contract).toContain("`fr:reqix:<ownerId>`");
    expect(contract).toContain("`fr:out:<caller>:<requester>`");
    expect(contract).toContain("is an open question");
    expect(contract).toContain("No cap was added");
    expect(contract).toContain("`2 + I + B + O + Q` gets and `S` lists");
    expect(contract).toContain("`2 + N + P + 2M` gets and no list");
    expect(readme).toContain("`fr:reqix:<caller>`");
    expect(readme).toContain("`fr:out:<caller>:<requester>`");
  });
});
