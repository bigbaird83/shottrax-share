import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry from "./entry.js";
import worker, { FriendGuessLimiter } from "./worker.js";

// Every friend key, owner id, and KV row in this file is mock data.
const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const OWNER_ID_RE = /^[A-Za-z0-9_-]{22}$/;

function friendKey(suffix) {
  return `${suffix}${"a".repeat(32)}`.slice(0, 43);
}

function mockOwner(tag) {
  const raw = `mock${tag}`.replace(/[^A-Za-z0-9]/g, "");
  if (raw.length > 22) throw new Error(`mock owner too long: ${raw}`);
  return raw.padEnd(22, "0");
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

describe("friend request index", () => {
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

  async function call(fetchImpl, pathname, { method = "GET", body, friend } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(new Request(`${ORIGIN}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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

  function watchKv() {
    const seen = { get: [], put: [], delete: [], list: [] };
    const boards = env.BOARDS;
    env.BOARDS = {
      async get(key) {
        seen.get.push(key);
        return boards.get(key);
      },
      async put(key, value, options) {
        seen.put.push(key);
        return boards.put(key, value, options);
      },
      async delete(key) {
        seen.delete.push(key);
        return boards.delete(key);
      },
      async list(options) {
        seen.list.push(options && options.prefix);
        return boards.list(options);
      },
    };
    return seen;
  }

  function plantFriends(left, right) {
    kv.set(`fr:friend:${left}:${right}`, { value: "1" });
    kv.set(`fr:friend:${right}:${left}`, { value: "1" });
    kv.set(`fr:friends:${left}`, { value: JSON.stringify([right]) });
    kv.set(`fr:friends:${right}`, { value: JSON.stringify([left]) });
  }

  function indexOf(ownerId) {
    const row = kv.get(`fr:ridx:${ownerId}`);
    return row ? JSON.parse(row.value) : null;
  }

  // The pre-index read: every fr:req: key, plus this caller's fr:out: notes.
  function legacyRequests(callerId) {
    const incoming = [];
    const outgoing = [];
    for (const name of [...kv.keys()].sort()) {
      if (!name.startsWith("fr:req:") || name.startsWith("fr:ridx:")) continue;
      const parts = name.slice("fr:req:".length).split(":");
      if (parts.length !== 2 || !OWNER_ID_RE.test(parts[0]) || !OWNER_ID_RE.test(parts[1])) continue;
      const [recipient, requester] = parts;
      if (recipient === requester) continue;
      const raw = kv.get(name);
      if (!raw || typeof raw.value !== "string" || raw.value.length === 0) continue;
      if (recipient === callerId) {
        const block = kv.get(`fr:block:${callerId}:${requester}`);
        if (block && typeof block.value === "string" && block.value.length > 0) continue;
        incoming.push({ ownerId: requester });
      } else if (requester === callerId) {
        outgoing.push({ ownerId: recipient });
      }
    }
    const notePrefix = `fr:out:${callerId}:`;
    for (const name of [...kv.keys()].sort()) {
      if (!name.startsWith(notePrefix)) continue;
      const recipient = name.slice(notePrefix.length);
      if (!OWNER_ID_RE.test(recipient) || recipient === callerId) continue;
      const raw = kv.get(name);
      if (!raw || typeof raw.value !== "string" || raw.value.length === 0) continue;
      outgoing.push({ ownerId: recipient });
    }
    const dedupe = (entries) => {
      const seen = new Set();
      const out = [];
      for (const entry of entries) {
        if (seen.has(entry.ownerId)) continue;
        seen.add(entry.ownerId);
        out.push(entry);
      }
      return out.sort((left, right) => (left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0));
    };
    return { incoming: dedupe(incoming), outgoing: dedupe(outgoing) };
  }

  it("deletes the mock stale outgoing note on accept, including when it is already absent", async () => {
    const caller = await mint("accept-caller");
    const requester = await mint("accept-requester");
    const other = mockOwner("OtherNote");
    const stale = `fr:out:${caller.ownerId}:${requester.ownerId}`;
    const requesterNote = `fr:out:${requester.ownerId}:${caller.ownerId}`;
    const kept = `fr:out:${caller.ownerId}:${other}`;
    kv.set(`fr:req:${caller.ownerId}:${requester.ownerId}`, { value: "pending" });
    kv.set(stale, { value: "pending" });
    kv.set(requesterNote, { value: "pending" });
    kv.set(kept, { value: "pending" });

    const seen = watchKv();
    const accepted = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ status: "friends", ownerId: requester.ownerId });
    expect(kv.has(stale)).toBe(false);
    expect(kv.has(requesterNote)).toBe(false);
    expect(kv.get(kept).value).toBe("pending");
    expect(kv.has(`fr:req:${caller.ownerId}:${requester.ownerId}`)).toBe(false);
    expect(seen.get).not.toContain(stale);
    expect(seen.get).not.toContain(requesterNote);
    expect(seen.delete).toContain(stale);
    expect(seen.delete).toContain(requesterNote);
    const staleAt = seen.delete.indexOf(stale);
    const rowAt = seen.delete.indexOf(`fr:req:${caller.ownerId}:${requester.ownerId}`);
    expect(staleAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThan(staleAt);

    const againCaller = await mint("accept-absent-caller");
    const againRequester = await mint("accept-absent-requester");
    const absent = `fr:out:${againCaller.ownerId}:${againRequester.ownerId}`;
    kv.set(`fr:req:${againCaller.ownerId}:${againRequester.ownerId}`, { value: "pending" });
    expect(kv.has(absent)).toBe(false);
    const absentSeen = watchKv();
    const absentAccept = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: againCaller.key,
      body: { ownerId: againRequester.ownerId },
    });
    expect(absentAccept.status).toBe(200);
    expect(absentAccept.json).toEqual({ status: "friends", ownerId: againRequester.ownerId });
    expect(kv.has(absent)).toBe(false);
    expect(kv.has(`fr:friend:${againCaller.ownerId}:${againRequester.ownerId}`)).toBe(true);
    expect(absentSeen.get).not.toContain(absent);
    expect(absentSeen.delete).toContain(absent);
  });

  it("does not delete the mock stale note when accept fails", async () => {
    const caller = await mint("fail-caller");
    const requester = await mint("fail-requester");
    const stale = `fr:out:${caller.ownerId}:${requester.ownerId}`;
    kv.set(stale, { value: "pending" });
    const missing = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(missing.status).toBe(409);
    expect(missing.json).toEqual({ error: "not_friends" });
    expect(kv.get(stale).value).toBe("pending");

    kv.set(`fr:block:${caller.ownerId}:${requester.ownerId}`, { value: "1" });
    kv.set(`fr:req:${caller.ownerId}:${requester.ownerId}`, { value: "pending" });
    const blocked = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toEqual({ error: "blocked" });
    expect(kv.get(stale).value).toBe("pending");
    expect(kv.get(`fr:req:${caller.ownerId}:${requester.ownerId}`).value).toBe("pending");
  });

  it("writes the mock index on create and the route reads that index", async () => {
    const from = await mint("idx-from");
    const to = await mint("idx-to");
    const legacy = mockOwner("LegacyIn");
    kv.set(`fr:req:${from.ownerId}:${legacy}`, { value: "pending" });

    const before = await viaEntry("/v1/friends/requests", { friend: from.key });
    expect(before.json).toEqual(legacyRequests(from.ownerId));
    expect(before.text).toBe(JSON.stringify({ incoming: [{ ownerId: legacy }], outgoing: [] }));

    const sent = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    expect(indexOf(from.ownerId)).toEqual({ in: [legacy], out: [to.ownerId] });
    expect(indexOf(to.ownerId)).toEqual({ in: [from.ownerId], out: [] });

    const seen = watchKv();
    const listed = await viaEntry("/v1/friends/requests", { friend: from.key });
    const mirrored = await viaWorker("/v1/friends/requests", { friend: from.key });
    expect(listed.json).toEqual(legacyRequests(from.ownerId));
    expect(listed.text).toBe(JSON.stringify({
      incoming: [{ ownerId: legacy }],
      outgoing: [{ ownerId: to.ownerId }],
    }));
    expect(mirrored.text).toBe(listed.text);
    expect(seen.list).not.toContain("fr:req:");
    expect(seen.list).toContain(`fr:out:${from.ownerId}:`);
    expect(seen.put).toEqual([]);
    expect(seen.delete).toEqual([]);
  });

  it("falls back to the mock fr:req scan when the index is missing and ignores a partial index", async () => {
    const caller = await mint("fall-caller");
    const incoming = mockOwner("FallIn");
    const outgoing = mockOwner("FallOut");
    const hidden = mockOwner("FallHide");
    const noted = mockOwner("FallNote");
    kv.set(`fr:req:${caller.ownerId}:${incoming}`, { value: "pending" });
    kv.set(`fr:req:${outgoing}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${hidden}:${mockOwner("Stranger")}`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:${noted}`, { value: "pending" });
    kv.set(`fr:block:${caller.ownerId}:${mockOwner("Blocked")}`, { value: "1" });
    kv.set(`fr:req:${caller.ownerId}:${mockOwner("Blocked")}`, { value: "pending" });

    const fallbackSeen = watchKv();
    const fallback = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(fallback.text).toBe(JSON.stringify(legacyRequests(caller.ownerId)));
    expect(fallback.json).toEqual({
      incoming: [{ ownerId: incoming }],
      outgoing: [{ ownerId: noted }, { ownerId: outgoing }].sort((left, right) => (left.ownerId < right.ownerId ? -1 : 1)),
    });
    expect(fallbackSeen.list).toContain("fr:req:");
    expect(fallbackSeen.put).toEqual([]);
    expect(fallbackSeen.delete).toEqual([]);
    expect(kv.has(`fr:ridx:${caller.ownerId}`)).toBe(false);

    kv.set(`fr:ridx:${caller.ownerId}`, {
      value: JSON.stringify({ in: [incoming], out: [outgoing, noted] }),
    });
    const indexedSeen = watchKv();
    const indexed = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(indexed.text).toBe(fallback.text);
    expect(indexedSeen.list).not.toContain("fr:req:");
    expect(indexedSeen.put).toEqual([]);
    expect(indexedSeen.delete).toEqual([]);

    kv.set(`fr:ridx:${caller.ownerId}`, { value: JSON.stringify({ in: [incoming], out: [] }) });
    const partial = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(partial.json.incoming).toEqual([{ ownerId: incoming }]);
    expect(partial.json.outgoing).toEqual([{ ownerId: noted }]);
    expect(partial.text).not.toContain(outgoing);

    kv.set(`fr:ridx:${caller.ownerId}`, { value: "not-an-index" });
    const corrupt = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(corrupt.text).toBe(fallback.text);
    expect(kv.get(`fr:ridx:${caller.ownerId}`).value).toBe("not-an-index");
  });

  it("removes the mock pair from the index on accept, backfilling older rows", async () => {
    const caller = await mint("acc-idx-caller");
    const requester = await mint("acc-idx-req");
    const kept = mockOwner("KeptIn");
    kv.set(`fr:ridx:${caller.ownerId}`, {
      value: JSON.stringify({ in: [requester.ownerId, kept], out: [] }),
    });
    kv.set(`fr:ridx:${requester.ownerId}`, {
      value: JSON.stringify({ in: [], out: [caller.ownerId, kept] }),
    });
    kv.set(`fr:req:${caller.ownerId}:${requester.ownerId}`, { value: "pending" });
    const accepted = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(accepted.json).toEqual({ status: "friends", ownerId: requester.ownerId });
    expect(indexOf(caller.ownerId)).toEqual({ in: [kept], out: [] });
    expect(indexOf(requester.ownerId)).toEqual({ in: [], out: [kept] });

    const freshCaller = await mint("acc-fill-caller");
    const freshRequester = await mint("acc-fill-req");
    const older = mockOwner("OlderIn");
    kv.delete(`fr:ridx:${freshCaller.ownerId}`);
    kv.delete(`fr:ridx:${freshRequester.ownerId}`);
    kv.set(`fr:req:${freshCaller.ownerId}:${freshRequester.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${freshCaller.ownerId}:${older}`, { value: "pending" });
    kv.set(`fr:req:${older}:${freshRequester.ownerId}`, { value: "pending" });
    expect((await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: freshCaller.key,
      body: { ownerId: freshRequester.ownerId },
    })).status).toBe(200);
    expect(indexOf(freshCaller.ownerId)).toEqual({ in: [older], out: [] });
    expect(indexOf(freshRequester.ownerId)).toEqual({ in: [], out: [older] });
    const after = await viaEntry("/v1/friends/requests", { friend: freshCaller.key });
    expect(after.json).toEqual({ incoming: [{ ownerId: older }], outgoing: [] });
  });

  it("declines a mock incoming request on block and updates both indexes", async () => {
    const caller = await mint("dec-caller");
    const other = await mint("dec-other");
    const kept = mockOwner("DecKept");
    plantFriends(caller.ownerId, other.ownerId);
    kv.set(`fr:req:${caller.ownerId}:${other.ownerId}`, { value: "pending" });
    kv.set(`fr:ridx:${caller.ownerId}`, {
      value: JSON.stringify({ in: [other.ownerId, kept], out: [] }),
    });
    kv.set(`fr:ridx:${other.ownerId}`, {
      value: JSON.stringify({ in: [], out: [caller.ownerId] }),
    });
    const seen = watchKv();
    const blocked = await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: other.ownerId },
    });
    expect(blocked.json).toEqual({ ok: true });
    expect(kv.has(`fr:req:${caller.ownerId}:${other.ownerId}`)).toBe(false);
    expect(indexOf(caller.ownerId)).toEqual({ in: [kept], out: [] });
    expect(indexOf(other.ownerId)).toEqual({ in: [], out: [] });
    expect(seen.list).not.toContain("fr:req:");

    const bareCaller = await mint("dec-bare-caller");
    const bareOther = await mint("dec-bare-other");
    const older = mockOwner("DecOlder");
    plantFriends(bareCaller.ownerId, bareOther.ownerId);
    kv.delete(`fr:ridx:${bareCaller.ownerId}`);
    kv.delete(`fr:ridx:${bareOther.ownerId}`);
    kv.set(`fr:req:${bareCaller.ownerId}:${bareOther.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${bareCaller.ownerId}:${older}`, { value: "pending" });
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: bareCaller.key,
      body: { ownerId: bareOther.ownerId },
    })).json).toEqual({ ok: true });
    expect(kv.has(`fr:req:${bareCaller.ownerId}:${bareOther.ownerId}`)).toBe(false);
    expect(indexOf(bareCaller.ownerId).in).toEqual([older]);
    expect(indexOf(bareCaller.ownerId).in).not.toContain(bareOther.ownerId);
    expect(indexOf(bareOther.ownerId).out).not.toContain(bareCaller.ownerId);
  });

  it("cancels a mock outgoing request on block and updates both indexes", async () => {
    const caller = await mint("can-caller");
    const other = await mint("can-other");
    const kept = mockOwner("CanKept");
    plantFriends(caller.ownerId, other.ownerId);
    kv.set(`fr:req:${other.ownerId}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:ridx:${caller.ownerId}`, {
      value: JSON.stringify({ in: [], out: [other.ownerId, kept] }),
    });
    kv.set(`fr:ridx:${other.ownerId}`, {
      value: JSON.stringify({ in: [caller.ownerId], out: [] }),
    });
    const seen = watchKv();
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: other.ownerId },
    })).json).toEqual({ ok: true });
    expect(kv.has(`fr:req:${other.ownerId}:${caller.ownerId}`)).toBe(false);
    expect(indexOf(caller.ownerId)).toEqual({ in: [], out: [kept] });
    expect(indexOf(other.ownerId)).toEqual({ in: [], out: [] });
    expect(seen.list).not.toContain("fr:req:");

    const bareCaller = await mint("can-bare-caller");
    const bareOther = await mint("can-bare-other");
    const older = mockOwner("CanOlder");
    plantFriends(bareCaller.ownerId, bareOther.ownerId);
    kv.delete(`fr:ridx:${bareCaller.ownerId}`);
    kv.delete(`fr:ridx:${bareOther.ownerId}`);
    kv.set(`fr:req:${bareOther.ownerId}:${bareCaller.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${older}:${bareCaller.ownerId}`, { value: "pending" });
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: bareCaller.key,
      body: { ownerId: bareOther.ownerId },
    })).json).toEqual({ ok: true });
    expect(indexOf(bareCaller.ownerId).out).toEqual([older]);
    expect(indexOf(bareCaller.ownerId).out).not.toContain(bareOther.ownerId);
    expect(indexOf(bareOther.ownerId).in).not.toContain(bareCaller.ownerId);
  });

  it("keeps both mock read-only responses identical to the pre-index bodies", async () => {
    const caller = await mint("read-caller");
    const friend = await mint("read-friend");
    const hidden = mockOwner("ReadHide");
    const incoming = mockOwner("ReadIn");
    const outgoing = mockOwner("ReadOut");
    const noted = mockOwner("ReadNote");
    plantFriends(caller.ownerId, friend.ownerId);
    plantFriends(caller.ownerId, hidden);
    kv.set(`fr:friends:${caller.ownerId}`, { value: JSON.stringify([hidden, friend.ownerId]) });
    kv.set(`fr:block:${caller.ownerId}:${hidden}`, { value: "1" });
    kv.set(`fr:req:${caller.ownerId}:${incoming}`, { value: "pending" });
    kv.set(`fr:req:${outgoing}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:${noted}`, { value: "pending" });
    kv.delete(`fr:ridx:${caller.ownerId}`);

    const requestsBefore = await viaEntry("/v1/friends/requests", { friend: caller.key });
    const friendsBefore = await viaEntry("/v1/friends/list", { friend: caller.key });
    expect(requestsBefore.status).toBe(200);
    expect(friendsBefore.status).toBe(200);
    expect(requestsBefore.text).toBe(JSON.stringify(legacyRequests(caller.ownerId)));
    expect(friendsBefore.text).toBe(JSON.stringify({ friends: [{ ownerId: friend.ownerId }] }));
    expect(Object.keys(requestsBefore.json).sort()).toEqual(["incoming", "outgoing"]);
    expect(Object.keys(friendsBefore.json)).toEqual(["friends"]);
    for (const entry of [...requestsBefore.json.incoming, ...requestsBefore.json.outgoing, ...friendsBefore.json.friends]) {
      expect(Object.keys(entry)).toEqual(["ownerId"]);
    }
    expect(requestsBefore.text).not.toContain("pending");
    expect(requestsBefore.text).not.toContain("fr:");
    expect(friendsBefore.text).not.toContain("since");
    expect(friendsBefore.text).not.toContain(hidden);

    kv.set(`fr:ridx:${caller.ownerId}`, {
      value: JSON.stringify({ in: [incoming], out: [outgoing] }),
    });
    const requestsAfter = await viaEntry("/v1/friends/requests", { friend: caller.key });
    const friendsAfter = await viaEntry("/v1/friends/list", { friend: caller.key });
    const requestsWorker = await viaWorker("/v1/friends/requests", { friend: caller.key });
    const friendsWorker = await viaWorker("/v1/friends/list", { friend: caller.key });
    expect(requestsAfter.text).toBe(requestsBefore.text);
    expect(friendsAfter.text).toBe(friendsBefore.text);
    expect(requestsWorker.text).toBe(requestsBefore.text);
    expect(friendsWorker.text).toBe(friendsBefore.text);
    expect(requestsAfter.headers.get("Cache-Control")).toBe("no-store");
    expect(friendsAfter.headers.get("Content-Type")).toContain("application/json");
  });
});
