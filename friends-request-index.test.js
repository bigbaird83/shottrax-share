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
    const seen = { get: [], put: [], delete: [], list: [], ops: [] };
    const boards = env.BOARDS;
    env.BOARDS = {
      async get(key) {
        seen.get.push(key);
        seen.ops.push({ op: "get", key });
        return boards.get(key);
      },
      async put(key, value, options) {
        seen.put.push(key);
        seen.ops.push({ op: "put", key });
        return boards.put(key, value, options);
      },
      async delete(key) {
        seen.delete.push(key);
        seen.ops.push({ op: "delete", key });
        return boards.delete(key);
      },
      async list(options) {
        seen.list.push(options && options.prefix);
        seen.ops.push({ op: "list", key: options && options.prefix });
        return boards.list(options);
      },
    };
    return seen;
  }

  function opAt(seen, op, key) {
    return seen.ops.findIndex((item) => item.op === op && item.key === key);
  }

  function plantFriends(left, right) {
    kv.set(`fr:friend:${left}:${right}`, { value: "1" });
    kv.set(`fr:friend:${right}:${left}`, { value: "1" });
    kv.set(`fr:friends:${left}`, { value: JSON.stringify([right]) });
    kv.set(`fr:friends:${right}`, { value: JSON.stringify([left]) });
  }

  function plantReady(ownerId) {
    kv.set(`fr:ridx:ready:${ownerId}`, { value: "1" });
  }

  function plantPair(recipientOwnerId, requesterOwnerId) {
    kv.set(`fr:ridx:in:${recipientOwnerId}:${requesterOwnerId}`, { value: "1" });
    kv.set(`fr:ridx:out:${requesterOwnerId}:${recipientOwnerId}`, { value: "1" });
  }

  function indexOf(ownerId) {
    const incoming = [];
    const outgoing = [];
    const inPrefix = `fr:ridx:in:${ownerId}:`;
    const outPrefix = `fr:ridx:out:${ownerId}:`;
    for (const name of [...kv.keys()].sort()) {
      if (name.startsWith(inPrefix) && OWNER_ID_RE.test(name.slice(inPrefix.length))) incoming.push(name.slice(inPrefix.length));
      else if (name.startsWith(outPrefix) && OWNER_ID_RE.test(name.slice(outPrefix.length))) outgoing.push(name.slice(outPrefix.length));
    }
    incoming.sort();
    outgoing.sort();
    return { in: incoming, out: outgoing };
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

  it("writes the mock pair keys on create and the route reads those keys", async () => {
    const from = await mint("idx-from");
    const to = await mint("idx-to");
    const legacy = mockOwner("LegacyIn");
    const reqKey = `fr:req:${to.ownerId}:${from.ownerId}`;
    const inKey = `fr:ridx:in:${to.ownerId}:${from.ownerId}`;
    const outKey = `fr:ridx:out:${from.ownerId}:${to.ownerId}`;
    const legacyIn = `fr:ridx:in:${from.ownerId}:${legacy}`;
    const fromReady = `fr:ridx:ready:${from.ownerId}`;
    const blob = `fr:ridx:${from.ownerId}`;
    kv.set(`fr:req:${from.ownerId}:${legacy}`, { value: "pending" });
    kv.set(blob, { value: JSON.stringify({ in: [], out: [] }) });

    const before = await viaEntry("/v1/friends/requests", { friend: from.key });
    expect(before.json).toEqual(legacyRequests(from.ownerId));
    expect(before.text).toBe(JSON.stringify({ incoming: [{ ownerId: legacy }], outgoing: [] }));

    const creating = watchKv();
    const sent = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    expect(indexOf(from.ownerId).in).toEqual([legacy]);
    expect(indexOf(from.ownerId).out).toEqual([to.ownerId]);
    expect(indexOf(to.ownerId)).toEqual({ in: [from.ownerId], out: [] });
    expect(kv.get(fromReady).value).toBe("1");
    expect(kv.get(`fr:ridx:ready:${to.ownerId}`).value).toBe("1");
    expect(kv.has(blob)).toBe(false);
    expect(opAt(creating, "put", inKey)).toBeGreaterThanOrEqual(0);
    expect(opAt(creating, "put", inKey)).toBeLessThan(opAt(creating, "put", reqKey));
    expect(opAt(creating, "put", outKey)).toBeLessThan(opAt(creating, "put", reqKey));
    expect(opAt(creating, "put", legacyIn)).toBeLessThan(opAt(creating, "put", fromReady));
    expect(opAt(creating, "delete", blob)).toBeGreaterThanOrEqual(0);
    expect(opAt(creating, "delete", blob)).toBeLessThan(opAt(creating, "put", fromReady));

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
    expect(seen.list).toContain(`fr:ridx:in:${from.ownerId}:`);
    expect(seen.list).toContain(`fr:ridx:out:${from.ownerId}:`);
    expect(seen.list).toContain(`fr:out:${from.ownerId}:`);
    expect(seen.put).toEqual([]);
    expect(seen.delete).toEqual([]);
  });

  it("falls back to the mock fr:req scan when the ready marker is missing and lists an unindexed row", async () => {
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
    expect(kv.has(`fr:ridx:ready:${caller.ownerId}`)).toBe(false);

    plantReady(caller.ownerId);
    plantPair(caller.ownerId, incoming);
    plantPair(outgoing, caller.ownerId);
    const indexedSeen = watchKv();
    const indexed = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(indexed.text).toBe(fallback.text);
    expect(indexedSeen.list).not.toContain("fr:req:");
    expect(indexedSeen.list).toContain(`fr:ridx:in:${caller.ownerId}:`);
    expect(indexedSeen.list).toContain(`fr:ridx:out:${caller.ownerId}:`);
    expect(indexedSeen.put).toEqual([]);
    expect(indexedSeen.delete).toEqual([]);

    // Partial pair keys and no ready marker. The outgoing row has no index
    // key and must still be listed. An empty marker is the same as missing.
    kv.delete(`fr:ridx:ready:${caller.ownerId}`);
    kv.delete(`fr:ridx:out:${caller.ownerId}:${outgoing}`);
    kv.delete(`fr:ridx:in:${outgoing}:${caller.ownerId}`);
    kv.set(`fr:ridx:ready:${caller.ownerId}`, { value: "" });
    const partialSeen = watchKv();
    const partial = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(partial.text).toBe(fallback.text);
    expect(partial.json.outgoing.map((entry) => entry.ownerId)).toContain(outgoing);
    expect(partialSeen.list).toContain("fr:req:");
    expect(partialSeen.put).toEqual([]);
    expect(partialSeen.delete).toEqual([]);

    kv.delete(`fr:ridx:ready:${caller.ownerId}`);
    kv.set(`fr:ridx:${caller.ownerId}`, { value: "not-an-index" });
    const ignored = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(ignored.text).toBe(fallback.text);
    expect(ignored.text).toContain(outgoing);
    expect(kv.get(`fr:ridx:${caller.ownerId}`).value).toBe("not-an-index");
  });

  it("removes the mock pair keys on accept, backfilling older rows", async () => {
    const caller = await mint("acc-idx-caller");
    const requester = await mint("acc-idx-req");
    const kept = mockOwner("KeptIn");
    plantReady(caller.ownerId);
    plantReady(requester.ownerId);
    plantPair(caller.ownerId, requester.ownerId);
    kv.set(`fr:ridx:in:${caller.ownerId}:${kept}`, { value: "1" });
    kv.set(`fr:ridx:out:${requester.ownerId}:${kept}`, { value: "1" });
    kv.set(`fr:req:${caller.ownerId}:${requester.ownerId}`, { value: "pending" });
    const seen = watchKv();
    const accepted = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: caller.key,
      body: { ownerId: requester.ownerId },
    });
    expect(accepted.json).toEqual({ status: "friends", ownerId: requester.ownerId });
    expect(indexOf(caller.ownerId)).toEqual({ in: [kept], out: [] });
    expect(indexOf(requester.ownerId)).toEqual({ in: [], out: [kept] });
    expect(seen.list).not.toContain("fr:req:");

    const freshCaller = await mint("acc-fill-caller");
    const freshRequester = await mint("acc-fill-req");
    const older = mockOwner("OlderIn");
    const blob = `fr:ridx:${freshCaller.ownerId}`;
    kv.set(blob, { value: JSON.stringify({ in: [freshRequester.ownerId], out: [] }) });
    kv.set(`fr:req:${freshCaller.ownerId}:${freshRequester.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${freshCaller.ownerId}:${older}`, { value: "pending" });
    kv.set(`fr:req:${older}:${freshRequester.ownerId}`, { value: "pending" });
    const filling = watchKv();
    expect((await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: freshCaller.key,
      body: { ownerId: freshRequester.ownerId },
    })).status).toBe(200);
    expect(indexOf(freshCaller.ownerId)).toEqual({ in: [older], out: [] });
    expect(indexOf(freshRequester.ownerId)).toEqual({ in: [], out: [older] });
    expect(kv.get(`fr:ridx:ready:${freshCaller.ownerId}`).value).toBe("1");
    expect(kv.get(`fr:ridx:ready:${freshRequester.ownerId}`).value).toBe("1");
    expect(kv.has(blob)).toBe(false);
    const callerReady = `fr:ridx:ready:${freshCaller.ownerId}`;
    expect(opAt(filling, "put", `fr:ridx:in:${freshCaller.ownerId}:${older}`)).toBeLessThan(opAt(filling, "put", callerReady));
    expect(opAt(filling, "delete", blob)).toBeLessThan(opAt(filling, "put", callerReady));
    const after = await viaEntry("/v1/friends/requests", { friend: freshCaller.key });
    expect(after.json).toEqual({ incoming: [{ ownerId: older }], outgoing: [] });
  });

  it("declines a mock incoming request on block and updates both indexes", async () => {
    const caller = await mint("dec-caller");
    const other = await mint("dec-other");
    const kept = mockOwner("DecKept");
    plantFriends(caller.ownerId, other.ownerId);
    plantReady(caller.ownerId);
    plantReady(other.ownerId);
    kv.set(`fr:req:${caller.ownerId}:${other.ownerId}`, { value: "pending" });
    plantPair(caller.ownerId, other.ownerId);
    kv.set(`fr:ridx:in:${caller.ownerId}:${kept}`, { value: "1" });
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
    expect(kv.get(`fr:ridx:ready:${bareCaller.ownerId}`).value).toBe("1");
  });

  it("cancels a mock outgoing request on block and updates both indexes", async () => {
    const caller = await mint("can-caller");
    const other = await mint("can-other");
    const kept = mockOwner("CanKept");
    plantFriends(caller.ownerId, other.ownerId);
    plantReady(caller.ownerId);
    plantReady(other.ownerId);
    kv.set(`fr:req:${other.ownerId}:${caller.ownerId}`, { value: "pending" });
    plantPair(other.ownerId, caller.ownerId);
    kv.set(`fr:ridx:out:${caller.ownerId}:${kept}`, { value: "1" });
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
    expect(kv.get(`fr:ridx:ready:${bareCaller.ownerId}`).value).toBe("1");
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
    kv.delete(`fr:ridx:ready:${caller.ownerId}`);

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

    plantReady(caller.ownerId);
    plantPair(caller.ownerId, incoming);
    plantPair(outgoing, caller.ownerId);
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

  it("keeps both mock sends when two requests hit the same recipient together", async () => {
    const recipient = await mint("race-to");
    const left = await mint("race-left");
    const right = await mint("race-right");
    const stable = mockOwner("RaceStable");
    plantReady(recipient.ownerId);
    plantReady(left.ownerId);
    plantReady(right.ownerId);
    kv.set(`fr:req:${recipient.ownerId}:${stable}`, { value: "pending" });
    kv.set(`fr:ridx:in:${recipient.ownerId}:${stable}`, { value: "1" });
    const leftIn = `fr:ridx:in:${recipient.ownerId}:${left.ownerId}`;
    const rightIn = `fr:ridx:in:${recipient.ownerId}:${right.ownerId}`;
    const boards = env.BOARDS;
    let entered = 0;
    let release;
    const both = new Promise((resolve) => {
      release = resolve;
    });
    env.BOARDS = {
      ...boards,
      async put(key, value, options) {
        if (key === leftIn || key === rightIn) {
          entered += 1;
          if (entered === 2) release();
          await both;
        }
        return boards.put(key, value, options);
      },
    };
    const [leftSent, rightSent] = await Promise.all([
      viaEntry("/v1/friends/requests", { method: "POST", friend: left.key, body: { code: recipient.code } }),
      viaEntry("/v1/friends/requests", { method: "POST", friend: right.key, body: { code: recipient.code } }),
    ]);
    expect(leftSent.json).toEqual({ status: "pending", ownerId: recipient.ownerId });
    expect(rightSent.json).toEqual({ status: "pending", ownerId: recipient.ownerId });
    expect(kv.get(leftIn).value).toBe("1");
    expect(kv.get(rightIn).value).toBe("1");
    expect(kv.has(`fr:req:${recipient.ownerId}:${left.ownerId}`)).toBe(true);
    expect(kv.has(`fr:req:${recipient.ownerId}:${right.ownerId}`)).toBe(true);
    const listed = await viaEntry("/v1/friends/requests", { friend: recipient.key });
    expect(listed.json.incoming.map((entry) => entry.ownerId).sort()).toEqual(
      [left.ownerId, right.ownerId, stable].sort(),
    );
  });

  it("stores no mock request when the index put fails", async () => {
    const from = await mint("fail-idx-from");
    const to = await mint("fail-idx-to");
    const boards = env.BOARDS;
    env.BOARDS = {
      ...boards,
      async put(key, value, options) {
        if (key.startsWith("fr:ridx:")) throw new Error("mock index put failed");
        return boards.put(key, value, options);
      },
    };
    await expect(viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    })).rejects.toThrow(/mock index put failed/);
    expect(kv.has(`fr:req:${to.ownerId}:${from.ownerId}`)).toBe(false);
    expect([...kv.keys()].some((name) => name.startsWith("fr:ridx:"))).toBe(false);

    env.BOARDS = boards;
    const parked = mockOwner("ParkedIn");
    kv.set(`fr:req:${from.ownerId}:${parked}`, { value: "pending" });
    const listed = await viaEntry("/v1/friends/requests", { friend: from.key });
    expect(listed.json).toEqual({ incoming: [{ ownerId: parked }], outgoing: [] });
    expect(kv.has(`fr:ridx:ready:${from.ownerId}`)).toBe(false);
  });

  it("repairs mock pair keys on a repeat send and does not index an already-friends reply", async () => {
    const from = await mint("repair-from");
    const to = await mint("repair-to");
    const reqKey = `fr:req:${to.ownerId}:${from.ownerId}`;
    const inKey = `fr:ridx:in:${to.ownerId}:${from.ownerId}`;
    const outKey = `fr:ridx:out:${from.ownerId}:${to.ownerId}`;
    plantReady(from.ownerId);
    plantReady(to.ownerId);
    kv.set(reqKey, { value: "pending" });
    const repair = watchKv();
    const again = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(again.json).toEqual({ status: "pending", ownerId: to.ownerId });
    expect(kv.get(reqKey).value).toBe("pending");
    expect(kv.get(inKey).value).toBe("1");
    expect(kv.get(outKey).value).toBe("1");
    expect(repair.put).toEqual([inKey, outKey]);
    expect(repair.list).not.toContain("fr:req:");
    const listed = await viaEntry("/v1/friends/requests", { friend: to.key });
    expect(listed.json.incoming).toEqual([{ ownerId: from.ownerId }]);

    const friendFrom = await mint("friends-from");
    const friendTo = await mint("friends-to");
    plantFriends(friendFrom.ownerId, friendTo.ownerId);
    const noted = `fr:out:${friendFrom.ownerId}:${friendTo.ownerId}`;
    kv.set(noted, { value: "pending" });
    const friends = watchKv();
    const already = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: friendFrom.key,
      body: { code: friendTo.code },
    });
    expect(already.json).toEqual({ status: "friends", ownerId: friendTo.ownerId });
    expect(friends.put.filter((key) => key.startsWith("fr:ridx:"))).toEqual([]);
    expect(friends.delete).toContain(noted);
    expect([...kv.keys()].some((name) => name.startsWith(`fr:ridx:`) && name.includes(friendFrom.ownerId))).toBe(false);
  });

  it("uses 3 mock puts and 1 delete for a new request once both owners are ready", async () => {
    const from = await mint("writes-from");
    const to = await mint("writes-to");
    plantReady(from.ownerId);
    plantReady(to.ownerId);
    const inKey = `fr:ridx:in:${to.ownerId}:${from.ownerId}`;
    const outKey = `fr:ridx:out:${from.ownerId}:${to.ownerId}`;
    const reqKey = `fr:req:${to.ownerId}:${from.ownerId}`;
    const note = `fr:out:${from.ownerId}:${to.ownerId}`;
    const first = watchKv();
    const sent = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    expect(first.put).toEqual([inKey, outKey, reqKey]);
    expect(first.delete).toEqual([note]);
    expect(first.list).not.toContain("fr:req:");

    const repeat = watchKv();
    const again = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(again.json).toEqual({ status: "pending", ownerId: to.ownerId });
    expect(repeat.put).toEqual([]);
    expect(repeat.delete).toEqual([note]);
  });

  it("lists every mock row when a backfill stops before the ready marker", async () => {
    const from = await mint("part-from");
    const to = await mint("part-to");
    const priorIn = mockOwner("PartIn");
    const priorOut = mockOwner("PartOut");
    const inKey = `fr:ridx:in:${from.ownerId}:${priorIn}`;
    const outKey = `fr:ridx:out:${from.ownerId}:${priorOut}`;
    const ready = `fr:ridx:ready:${from.ownerId}`;
    const blob = `fr:ridx:${from.ownerId}`;
    kv.set(`fr:req:${from.ownerId}:${priorIn}`, { value: "pending" });
    kv.set(`fr:req:${priorOut}:${from.ownerId}`, { value: "pending" });
    kv.set(blob, { value: JSON.stringify({ in: [priorIn], out: [] }) });
    const boards = env.BOARDS;
    let callerPairPuts = 0;
    env.BOARDS = {
      ...boards,
      async put(key, value, options) {
        if (key.startsWith(`fr:ridx:in:${from.ownerId}:`) || key.startsWith(`fr:ridx:out:${from.ownerId}:`)) {
          callerPairPuts += 1;
          if (callerPairPuts >= 2) throw new Error("mock partial backfill");
        }
        if (key === ready) throw new Error("ready marker written during a partial backfill");
        return boards.put(key, value, options);
      },
    };
    await expect(viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    })).rejects.toThrow(/mock partial backfill/);
    expect(kv.has(ready)).toBe(false);
    expect(kv.has(`fr:req:${to.ownerId}:${from.ownerId}`)).toBe(false);
    expect(kv.get(blob).value).toContain(priorIn);
    const stored = [inKey, outKey].filter((key) => kv.has(key));
    const missing = [inKey, outKey].filter((key) => !kv.has(key));
    expect(stored).toHaveLength(1);
    expect(missing).toHaveLength(1);

    env.BOARDS = boards;
    const during = await viaEntry("/v1/friends/requests", { friend: from.key });
    expect(during.json).toEqual(legacyRequests(from.ownerId));
    expect(during.json.incoming.map((entry) => entry.ownerId)).toContain(priorIn);
    expect(during.json.outgoing.map((entry) => entry.ownerId)).toContain(priorOut);
    expect(kv.has(ready)).toBe(false);
    expect(kv.has(blob)).toBe(true);

    const finishing = watchKv();
    const sent = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    expect(kv.get(ready).value).toBe("1");
    expect(kv.has(inKey)).toBe(true);
    expect(kv.has(outKey)).toBe(true);
    expect(kv.has(blob)).toBe(false);
    const readyAt = opAt(finishing, "put", ready);
    const reqKey = `fr:req:${to.ownerId}:${from.ownerId}`;
    expect(opAt(finishing, "put", missing[0])).toBeGreaterThanOrEqual(0);
    expect(opAt(finishing, "put", missing[0])).toBeLessThan(readyAt);
    expect(opAt(finishing, "delete", blob)).toBeLessThan(readyAt);
    expect(readyAt).toBeLessThan(opAt(finishing, "put", reqKey));
    const afterSeen = watchKv();
    const after = await viaEntry("/v1/friends/requests", { friend: from.key });
    expect(after.json).toEqual(legacyRequests(from.ownerId));
    expect(after.json.outgoing.map((entry) => entry.ownerId)).toContain(to.ownerId);
    expect(afterSeen.list).not.toContain("fr:req:");
  });

  it("keeps a mock request that a lagged pair-key list does not show yet", async () => {
    const from = await mint("lag-from");
    const to = await mint("lag-to");
    const stable = mockOwner("LagStable");
    const sent = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: from.key,
      body: { code: to.code },
    });
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    const inKey = `fr:ridx:in:${to.ownerId}:${from.ownerId}`;
    const outKey = `fr:ridx:out:${from.ownerId}:${to.ownerId}`;
    const reqKey = `fr:req:${to.ownerId}:${from.ownerId}`;
    expect(kv.get(`fr:ridx:ready:${to.ownerId}`).value).toBe("1");
    expect(kv.get(inKey).value).toBe("1");
    kv.set(`fr:req:${to.ownerId}:${stable}`, { value: "pending" });
    kv.set(`fr:ridx:in:${to.ownerId}:${stable}`, { value: "1" });
    const boards = env.BOARDS;
    let hide = true;
    env.BOARDS = {
      ...boards,
      async list(options = {}) {
        const page = await boards.list(options);
        if (!hide) return page;
        const prefix = typeof options.prefix === "string" ? options.prefix : "";
        if (!prefix.startsWith("fr:ridx:")) return page;
        return {
          ...page,
          keys: page.keys.filter((item) => item.name !== inKey && item.name !== outKey),
        };
      },
    };
    const lagged = await viaEntry("/v1/friends/requests", { friend: to.key });
    expect(lagged.json.incoming).toEqual([{ ownerId: stable }]);
    expect(kv.get(inKey).value).toBe("1");
    expect(kv.get(reqKey).value).toBe("pending");
    expect(kv.has(outKey)).toBe(true);
    hide = false;
    const caughtUp = await viaEntry("/v1/friends/requests", { friend: to.key });
    expect(caughtUp.json.incoming.map((entry) => entry.ownerId).sort()).toEqual([from.ownerId, stable].sort());
  });
});
