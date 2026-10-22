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

describe("names on friend and request lists", () => {
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

  it("shows the accepter's invite name on the sender's friend list", async () => {
    const sender = await mint("nm-sender");
    const accepter = await mint("nm-accepter");
    expect((await setName(accepter, "Jordan Pike")).status).toBe(200);
    await befriend(sender, accepter);
    expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId, name: "Jordan Pike" }]);
  });

  it("omits name when the friend never set one or cleared it", async () => {
    const sender = await mint("nm-s2");
    const accepter = await mint("nm-a2");
    await befriend(sender, accepter);
    expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId }]);
    await setName(accepter, "Jordan Pike");
    await setName(accepter, null);
    expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId }]);
  });

  it("drops a stored name that fails validation", async () => {
    const sender = await mint("nm-s3");
    const accepter = await mint("nm-a3");
    await befriend(sender, accepter);
    for (const bad of ["x".repeat(25), " Pad", "Bell\u0007", ""]) {
      kv.set(`fr:ownname:${accepter.ownerId}`, { value: bad });
      expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId }]);
    }
  });

  it("names both sides of a pending request", async () => {
    const sender = await mint("nm-s4");
    const recipient = await mint("nm-r4");
    await setName(sender, "Sam Rivera");
    await setName(recipient, "Casey Lund");
    await invoke("/v1/friends/requests", { friend: sender.key, body: { code: recipient.code } });
    expect((await requests(recipient)).incoming).toEqual([{ ownerId: sender.ownerId, name: "Sam Rivera" }]);
    expect((await requests(sender)).outgoing).toEqual([{ ownerId: recipient.ownerId, name: "Casey Lund" }]);
  });

  it("resetting the code clears the name from lists", async () => {
    const sender = await mint("nm-s5");
    const accepter = await mint("nm-a5");
    await setName(accepter, "Jordan Pike");
    await befriend(sender, accepter);
    await invoke("/v1/friends/code/reset", { friend: accepter.key, body: {} });
    expect(kv.has(`fr:ownname:${accepter.ownerId}`)).toBe(false);
    expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId }]);
  });

  it("does not show a blocked friend's name", async () => {
    const sender = await mint("nm-s6");
    const accepter = await mint("nm-a6");
    await setName(accepter, "Jordan Pike");
    await befriend(sender, accepter);
    kv.set(`fr:block:${accepter.ownerId}:${sender.ownerId}`, { value: "1" });
    const res = await invoke("/v1/friends/list", { method: "GET", friend: sender.key });
    expect(res.text).not.toContain("Jordan Pike");
  });

  it("backfills a name saved before fr:ownname: existed on the owner's next list call", async () => {
    const sender = await mint("nm-s7");
    const accepter = await mint("nm-a7");
    await befriend(sender, accepter);
    kv.set(`fr:invname:${accepter.code}`, { value: "Jordan Pike" });
    expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId }]);
    await list(accepter);
    expect(kv.get(`fr:ownname:${accepter.ownerId}`).value).toBe("Jordan Pike");
    expect((await list(sender)).friends).toEqual([{ ownerId: accepter.ownerId, name: "Jordan Pike" }]);
  });
});
