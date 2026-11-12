import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// Made-up people only. Not real photos: a JPEG header followed by filler.
function fakeJpeg(size, seed = 0) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < size; i++) bytes[i] = (i + seed) % 251;
  return Buffer.from(bytes).toString("base64");
}

async function versionOf(data) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

describe("friend photo sync", () => {
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

  async function invoke(pathname, { method = "POST", body, friend, ip } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (ip) headers["CF-Connecting-IP"] = ip;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await entry.fetch(new Request(`${ORIGIN}${pathname}`, {
      method,
      headers,
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

  const setPhoto = (who, photo) => invoke("/v1/friends/code/photo", { friend: who.key, body: { photo } });
  const list = (who) => invoke("/v1/friends/list", { method: "GET", friend: who.key });
  const photos = (who, ownerIds, ip) => invoke("/v1/friends/photos", { friend: who.key, body: { ownerIds }, ip });
  const photoVOf = (res, ownerId) => res.json.friends.find((row) => row.ownerId === ownerId).photoV;

  it("setting a photo writes ownphoto and ownphotov, and list shows photoV", async () => {
    const owner = await mint("ps-owner");
    const friend = await mint("ps-friend");
    await befriend(friend, owner);
    const data = fakeJpeg(2048);
    expect((await setPhoto(owner, { type: "image/jpeg", data })).status).toBe(200);
    expect(JSON.parse(kv.get(`fr:ownphoto:${owner.ownerId}`).value)).toEqual({ type: "image/jpeg", data });
    const v = kv.get(`fr:ownphotov:${owner.ownerId}`).value;
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(v).toBe(await versionOf(data));
    const listed = await list(friend);
    expect(listed.status).toBe(200);
    expect(listed.json.friends).toEqual([{ ownerId: owner.ownerId, photoV: v }]);
    // The list carries no image data.
    expect(listed.text).not.toContain(data.slice(0, 16));
  });

  it("a friend with no photo has no photoV", async () => {
    const owner = await mint("ps-none-o");
    const friend = await mint("ps-none-f");
    await befriend(friend, owner);
    expect((await list(friend)).json.friends).toEqual([{ ownerId: owner.ownerId }]);
  });

  it("a new photo gives a new version and null gives none", async () => {
    const owner = await mint("ps-ver-o");
    const friend = await mint("ps-ver-f");
    await befriend(friend, owner);
    await setPhoto(owner, { type: "image/jpeg", data: fakeJpeg(1024, 1) });
    const first = photoVOf(await list(friend), owner.ownerId);
    await setPhoto(owner, { type: "image/jpeg", data: fakeJpeg(1024, 2) });
    const second = photoVOf(await list(friend), owner.ownerId);
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
    // The same photo again keeps the same version.
    await setPhoto(owner, { type: "image/jpeg", data: fakeJpeg(1024, 2) });
    expect(photoVOf(await list(friend), owner.ownerId)).toBe(second);
    expect((await setPhoto(owner, null)).status).toBe(200);
    expect(kv.has(`fr:ownphoto:${owner.ownerId}`)).toBe(false);
    expect(kv.get(`fr:ownphotov:${owner.ownerId}`).value).toBe("none");
    expect(photoVOf(await list(friend), owner.ownerId)).toBe("none");
    const got = await photos(friend, [owner.ownerId]);
    expect(got.json).toEqual({ photos: [{ ownerId: owner.ownerId, photoV: "none", photo: null }] });
  });

  it("/photos returns the photo to a mutual friend", async () => {
    const owner = await mint("ps-mut-o");
    const friend = await mint("ps-mut-f");
    await befriend(friend, owner);
    const data = fakeJpeg(4096);
    await setPhoto(owner, { type: "image/jpeg", data });
    const got = await photos(friend, [owner.ownerId]);
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ photos: [{ ownerId: owner.ownerId, photoV: await versionOf(data), photo: { type: "image/jpeg", data } }] });
    // Repeated ids are answered once; the caller's own id is left out.
    const twice = await photos(friend, [owner.ownerId, owner.ownerId, friend.ownerId]);
    expect(twice.json.photos.map((row) => row.ownerId)).toEqual([owner.ownerId]);
  });

  it("/photos leaves out non-friends, one-way rows, removed and blocked people", async () => {
    const owner = await mint("ps-hide-o");
    const stranger = await mint("ps-hide-s");
    const oneWay = await mint("ps-hide-1");
    const blockedByOwner = await mint("ps-hide-b");
    const blocker = await mint("ps-hide-x");
    const removed = await mint("ps-hide-r");
    await setPhoto(owner, { type: "image/jpeg", data: fakeJpeg(512) });
    // Only the caller's direction exists.
    kv.set(`fr:friend:${oneWay.ownerId}:${owner.ownerId}`, { value: "1" });
    kv.set(`fr:friends:${oneWay.ownerId}`, { value: JSON.stringify([owner.ownerId]) });
    expect((await photos(stranger, [owner.ownerId])).json).toEqual({ photos: [] });
    expect((await photos(oneWay, [owner.ownerId])).json).toEqual({ photos: [] });
    // Only the other direction exists.
    const otherWay = await mint("ps-hide-2");
    kv.set(`fr:friend:${owner.ownerId}:${otherWay.ownerId}`, { value: "1" });
    expect((await photos(otherWay, [owner.ownerId])).json).toEqual({ photos: [] });
    // The owner blocks a friend: that friend gets nothing.
    await befriend(blockedByOwner, owner);
    expect((await photos(blockedByOwner, [owner.ownerId])).json.photos).toHaveLength(1);
    expect((await invoke("/v1/friends/block", { friend: owner.key, body: { ownerId: blockedByOwner.ownerId } })).status).toBe(200);
    expect((await photos(blockedByOwner, [owner.ownerId])).json).toEqual({ photos: [] });
    // The block alone hides it, even with both friend rows put back.
    kv.set(`fr:friend:${blockedByOwner.ownerId}:${owner.ownerId}`, { value: "1" });
    kv.set(`fr:friend:${owner.ownerId}:${blockedByOwner.ownerId}`, { value: "1" });
    expect((await photos(blockedByOwner, [owner.ownerId])).json).toEqual({ photos: [] });
    // A friend who blocked the owner does not get it either, even with both friend rows put back.
    await befriend(blocker, owner);
    expect((await invoke("/v1/friends/block", { friend: blocker.key, body: { ownerId: owner.ownerId } })).status).toBe(200);
    kv.set(`fr:friend:${blocker.ownerId}:${owner.ownerId}`, { value: "1" });
    kv.set(`fr:friend:${owner.ownerId}:${blocker.ownerId}`, { value: "1" });
    expect((await photos(blocker, [owner.ownerId])).json).toEqual({ photos: [] });
    // A removed friend gets nothing.
    await befriend(removed, owner);
    expect((await invoke("/v1/friends/remove", { friend: owner.key, body: { ownerId: removed.ownerId } })).status).toBe(200);
    expect((await photos(removed, [owner.ownerId])).json).toEqual({ photos: [] });
  });

  it("/photos refuses 6 ids, a bad id, an empty list, unknown fields and a missing key", async () => {
    const caller = await mint("ps-bad");
    const ids = Array.from({ length: 6 }, (_, i) => `${String.fromCharCode(97 + i)}`.repeat(22));
    expect((await photos(caller, ids)).status).toBe(400);
    expect((await photos(caller, ids.slice(0, 5))).status).toBe(200);
    expect((await photos(caller, ["short"])).status).toBe(400);
    expect((await photos(caller, [42])).status).toBe(400);
    expect((await photos(caller, [])).status).toBe(400);
    expect((await photos(caller, "a".repeat(22))).status).toBe(400);
    expect((await invoke("/v1/friends/photos", { friend: caller.key, body: { ownerIds: [ids[0]], extra: 1 } })).status).toBe(400);
    expect((await invoke("/v1/friends/photos", { friend: caller.key, body: {} })).status).toBe(400);
    expect((await invoke("/v1/friends/photos", { body: { ownerIds: [ids[0]] } })).status).toBe(401);
    expect((await invoke("/v1/friends/photos", { friend: friendKey("ps-unminted"), body: { ownerIds: [ids[0]] } })).status).toBe(401);
    expect((await invoke("/v1/friends/photos", { friend: caller.key, body: JSON.stringify({ ownerIds: [ids[0]], pad: "x".repeat(1100) }) })).status).toBe(413);
    expect((await invoke("/v1/friends/photos", { method: "GET", friend: caller.key })).status).toBe(405);
  });

  it("keeps the 413 and 415 limits and writes nothing on a refused photo", async () => {
    const owner = await mint("ps-cap");
    expect((await setPhoto(owner, { type: "image/png", data: fakeJpeg(100) })).status).toBe(415);
    expect((await setPhoto(owner, { type: "image/jpeg", data: fakeJpeg(64 * 1024 + 3) })).status).toBe(413);
    expect(kv.has(`fr:ownphoto:${owner.ownerId}`)).toBe(false);
    expect(kv.has(`fr:ownphotov:${owner.ownerId}`)).toBe(false);
    expect((await setPhoto(owner, { type: "image/jpeg", data: fakeJpeg(64 * 1024) })).status).toBe(200);
    expect(JSON.parse(kv.get(`fr:ownphoto:${owner.ownerId}`).value).data).toBe(fakeJpeg(64 * 1024));
  });

  it("a code reset keeps ownphoto, so friends keep seeing the photo", async () => {
    const owner = await mint("ps-reset-o");
    const friend = await mint("ps-reset-f");
    await befriend(friend, owner);
    const data = fakeJpeg(800);
    await setPhoto(owner, { type: "image/jpeg", data });
    const v = await versionOf(data);
    const reset = await invoke("/v1/friends/code/reset", { friend: owner.key, body: {} });
    expect(reset.status).toBe(200);
    // The invite copy still goes with the old code.
    expect(kv.has(`fr:invphoto:${owner.code}`)).toBe(false);
    expect(JSON.parse(kv.get(`fr:ownphoto:${owner.ownerId}`).value)).toEqual({ type: "image/jpeg", data });
    expect(kv.get(`fr:ownphotov:${owner.ownerId}`).value).toBe(v);
    expect(photoVOf(await list(friend), owner.ownerId)).toBe(v);
    expect((await photos(friend, [owner.ownerId])).json.photos[0].photo).toEqual({ type: "image/jpeg", data });
  });

  it("backfills a photo saved before ownphotov existed, once, on the owner's list call", async () => {
    const owner = await mint("ps-back-o");
    const friend = await mint("ps-back-f");
    await befriend(friend, owner);
    const data = fakeJpeg(600);
    // An invite photo stored by the old Worker: no owner rows yet.
    kv.set(`fr:invphoto:${owner.code}`, { value: JSON.stringify({ type: "image/jpeg", data }) });
    expect((await list(friend)).json.friends).toEqual([{ ownerId: owner.ownerId }]);
    let puts = 0;
    const put = env.BOARDS.put;
    env.BOARDS.put = async (key, value) => {
      puts += 1;
      return put(key, value);
    };
    expect((await list(owner)).status).toBe(200);
    expect(puts).toBe(2);
    expect(kv.get(`fr:ownphotov:${owner.ownerId}`).value).toBe(await versionOf(data));
    expect(JSON.parse(kv.get(`fr:ownphoto:${owner.ownerId}`).value)).toEqual({ type: "image/jpeg", data });
    // Once: a second list writes nothing.
    puts = 0;
    expect((await list(owner)).status).toBe(200);
    expect(puts).toBe(0);
    expect(photoVOf(await list(friend), owner.ownerId)).toBe(await versionOf(data));
    // A removal after the backfill is not undone by it.
    await setPhoto(owner, null);
    await list(owner);
    expect(kv.get(`fr:ownphotov:${owner.ownerId}`).value).toBe("none");
  });

  it("rate limits /photos per key with 429 and Retry-After, on its own counter", async () => {
    const caller = await mint("ps-rate");
    const id = "b".repeat(22);
    for (let i = 0; i < 60; i++) expect((await photos(caller, [id])).status).toBe(200);
    const limited = await photos(caller, [id]);
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The list keeps its own budget.
    expect((await list(caller)).status).toBe(200);
    // A bad body does not consume a call.
    const other = await mint("ps-rate-2");
    for (let i = 0; i < 5; i++) expect((await photos(other, ["bad"])).status).toBe(400);
    for (let i = 0; i < 60; i++) expect((await photos(other, [id])).status).toBe(200);
    expect((await photos(other, [id])).status).toBe(429);
  });

  it("rate limits /photos per IP", async () => {
    const id = "c".repeat(22);
    const ip = "203.0.113.9";
    for (let i = 0; i < 60; i++) {
      const who = await mint(`ps-ip-${i}`);
      expect((await photos(who, [id], ip)).status).toBe(200);
    }
    const last = await mint("ps-ip-last");
    expect((await photos(last, [id], ip)).status).toBe(429);
  });

  it("the KV allowlist accepts the new kinds and still refuses others", () => {
    const src = readFileSync(new URL("./friends.js", import.meta.url), "utf8");
    expect(src).toContain('kind !== "ownphoto" &&');
    expect(src).toContain('kind !== "ownphotov" &&');
  });
});
