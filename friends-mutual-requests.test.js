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

describe("build 169: mutual requests and shared rounds", () => {
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

  const setName = (who, name) => invoke("/v1/friends/code/name", { friend: who.key, body: { name } });
  const list = async (who) => (await invoke("/v1/friends/list", { method: "GET", friend: who.key })).json;
  const requests = async (who) => (await invoke("/v1/friends/requests", { method: "GET", friend: who.key })).json;

  // Made-up people and rounds only.
  const round = (id) => ({ id, courseName: "Mock Pines GC", playedOn: "2026-10-01", gross: 80, toPar: 8, holes: [{ hole: 1, par: 4, score: 5 }] });
  const send = (from, to) => invoke("/v1/friends/requests", { friend: from.key, body: { code: to.code } });
  const accept = (who, other) => invoke("/v1/friends/requests/accept", { friend: who.key, body: { ownerId: other.ownerId } });

  it("accept clears both directions when each person sent a request", async () => {
    const owner = await mint("mu-owner");
    const pal = await mint("mu-pal");
    await send(owner, pal);
    await send(pal, owner);
    expect((await accept(owner, pal)).json).toEqual({ status: "friends", ownerId: pal.ownerId });
    expect(kv.has(`fr:req:${owner.ownerId}:${pal.ownerId}`)).toBe(false);
    expect(kv.has(`fr:req:${pal.ownerId}:${owner.ownerId}`)).toBe(false);
    expect((await requests(pal)).incoming).toEqual([]);
    expect((await requests(owner)).incoming).toEqual([]);
  });

  it("adding a new friend and setting past rounds keeps every shared round", async () => {
    const owner = await mint("mu-own3");
    const old = await mint("mu-old3");
    const pal = await mint("mu-pal3");
    await befriend(old, owner);
    for (const id of ["mock_a", "mock_b"]) {
      await invoke("/v1/friends/rounds", { method: "PUT", friend: owner.key, body: { share: true, round: round(id) } });
    }
    await befriend(pal, owner);
    for (const choice of ["none", "10"]) {
      expect((await invoke("/v1/friends/past", { method: "PUT", friend: owner.key, body: { ownerId: pal.ownerId, choice, rounds: [] } })).status).toBe(200);
    }
    for (const who of [owner, old, pal]) {
      const got = await invoke("/v1/friends/rounds", { method: "GET", friend: who.key });
      expect(got.json.rounds.map((r) => r.id)).toEqual(["mock_a", "mock_b"]);
    }
  });
});
