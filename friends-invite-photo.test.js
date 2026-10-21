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


// Made-up people only. Names below are invented for these tests.
const INVITE_NAME = "Alex M.";

describe("invite photo", () => {
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
  async function invoke(pathname, { method = "POST", body, friend } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await worker.fetch(new Request(`${ORIGIN}${pathname}`, {
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


  // Made-up image bytes: a JPEG header followed by filler. Not a real photo.
  function fakeJpeg(size) {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    for (let i = 4; i < size; i++) bytes[i] = i % 251;
    return Buffer.from(bytes).toString("base64");
  }
  const setPhoto = (who, photo) => invoke("/v1/friends/code/photo", { friend: who.key, body: { photo } });
  const lookup = (who, code) => invoke("/v1/friends/codes/lookup", { friend: who.key, body: { code } });

  it("stores the photo with the code, not in a URL, and returns it only on lookup", async () => {
    const sharer = await mint("ph-sharer");
    const opener = await mint("ph-opener");
    const data = fakeJpeg(2048);
    const set = await setPhoto(sharer, { type: "image/jpeg", data });
    expect(set.status).toBe(200);
    expect(JSON.parse(kv.get(`fr:invphoto:${sharer.code}`).value)).toEqual({ type: "image/jpeg", data });
    for (const [name] of kv.entries()) expect(name).not.toContain(data.slice(0, 16));
    const got = await invoke("/v1/friends/code", { friend: sharer.key, body: {} });
    expect(got.text).not.toContain(data.slice(0, 16));
    const found = await lookup(opener, sharer.code);
    expect(found.status).toBe(200);
    expect(found.json).toEqual({ ownerId: sharer.ownerId, photo: { type: "image/jpeg", data } });
  });

  it("enforces the JPEG type and 64 KB cap", async () => {
    const sharer = await mint("ph-cap");
    expect((await setPhoto(sharer, { type: "image/png", data: fakeJpeg(100) })).status).toBe(415);
    expect((await setPhoto(sharer, { type: "image/jpeg", data: Buffer.from("not a jpeg at all").toString("base64") })).status).toBe(400);
    expect((await setPhoto(sharer, { type: "image/jpeg", data: "!!!!" })).status).toBe(400);
    expect((await setPhoto(sharer, { type: "image/jpeg", data: fakeJpeg(64 * 1024), extra: 1 })).status).toBe(400);
    expect((await setPhoto(sharer, { type: "image/jpeg", data: fakeJpeg(64 * 1024) })).status).toBe(200);
    expect((await setPhoto(sharer, { type: "image/jpeg", data: fakeJpeg(64 * 1024 + 3) })).status).toBe(413);
    expect(JSON.parse(kv.get(`fr:invphoto:${sharer.code}`).value).data).toBe(fakeJpeg(64 * 1024));
  });

  it("null deletes the photo and reset deletes it from the server", async () => {
    const sharer = await mint("ph-reset");
    const opener = await mint("ph-reset-op");
    await setPhoto(sharer, { type: "image/jpeg", data: fakeJpeg(512) });
    expect((await setPhoto(sharer, null)).status).toBe(200);
    expect(kv.has(`fr:invphoto:${sharer.code}`)).toBe(false);
    await setPhoto(sharer, { type: "image/jpeg", data: fakeJpeg(512) });
    const old = sharer.code;
    const reset = await invoke("/v1/friends/code/reset", { friend: sharer.key, body: {} });
    expect(reset.status).toBe(200);
    expect(kv.has(`fr:invphoto:${old}`)).toBe(false);
    expect(kv.has(`fr:invphoto:${reset.json.code}`)).toBe(false);
    expect((await lookup(opener, reset.json.code)).json).toEqual({ ownerId: sharer.ownerId });
  });
});
