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

describe("invite name and past rounds", () => {
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

  it("stores the invite name with the code and owner, not in the URL or the auth row", async () => {
    const sharer = await mint("name-sharer");
    const opener = await mint("name-opener");
    const set = await invoke("/v1/friends/code/name", { friend: sharer.key, body: { name: `  ${INVITE_NAME} ` } });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ ok: true });
    expect(kv.get(`fr:invname:${sharer.code}`).value).toBe(INVITE_NAME);
    expect(kv.get(`fr:ownname:${sharer.ownerId}`).value).toBe(INVITE_NAME);
    const authRow = [...kv.entries()].find(([name]) => name.startsWith("fr:k:"));
    for (const [name, row] of kv.entries()) {
      if (name !== `fr:invname:${sharer.code}` && name !== `fr:ownname:${sharer.ownerId}`) expect(row.value).not.toContain(INVITE_NAME);
    }
    expect(authRow[1].value).not.toContain(INVITE_NAME);
    // The code call (what the phone builds the link from) never carries the name.
    const again = await invoke("/v1/friends/code", { friend: sharer.key, body: {} });
    expect(again.json).toEqual({ code: sharer.code, ownerId: sharer.ownerId });
    expect(again.text).not.toContain(INVITE_NAME);
    const lookup = await invoke("/v1/friends/codes/lookup", { friend: opener.key, body: { code: sharer.code } });
    expect(lookup.json).toEqual({ ownerId: sharer.ownerId, name: INVITE_NAME });
    // Rounds never carry it. Friend and request lists do (friends-names.test.js).
    await befriend(opener, sharer);
    const rounds = await invoke("/v1/friends/rounds", { method: "GET", friend: opener.key });
    expect(rounds.text).not.toContain(INVITE_NAME);
    const listed = await invoke("/v1/friends/list", { method: "GET", friend: opener.key });
    expect(listed.json.friends).toEqual([{ ownerId: sharer.ownerId, name: INVITE_NAME }]);
  });

  it("resetting the code deletes the stored name; the new code has none", async () => {
    const sharer = await mint("reset-sharer");
    const opener = await mint("reset-opener");
    await invoke("/v1/friends/code/name", { friend: sharer.key, body: { name: INVITE_NAME } });
    const reset = await invoke("/v1/friends/code/reset", { friend: sharer.key, body: {} });
    expect(reset.status).toBe(200);
    expect(kv.has(`fr:invname:${sharer.code}`)).toBe(false);
    expect(kv.has(`fr:invname:${reset.json.code}`)).toBe(false);
    expect([...kv.values()].some((row) => row.value.includes(INVITE_NAME))).toBe(false);
    const oldLookup = await invoke("/v1/friends/codes/lookup", { friend: opener.key, body: { code: sharer.code } });
    expect(oldLookup.status).toBe(404);
    const newLookup = await invoke("/v1/friends/codes/lookup", { friend: opener.key, body: { code: reset.json.code } });
    expect(newLookup.json).toEqual({ ownerId: sharer.ownerId });
  });

  it("validates the invite name: 24 characters, no control characters, null or blank clears", async () => {
    const sharer = await mint("valid-sharer");
    const say = (body) => invoke("/v1/friends/code/name", { friend: sharer.key, body });
    expect((await say({ name: "x".repeat(24) })).status).toBe(200);
    expect(kv.get(`fr:invname:${sharer.code}`).value).toBe("x".repeat(24));
    expect((await say({ name: "x".repeat(25) })).status).toBe(400);
    expect((await say({ name: "Al\u0007ex" })).status).toBe(400);
    expect((await say({ name: 7 })).status).toBe(400);
    expect((await say({})).status).toBe(400);
    expect((await say({ name: "Alex", extra: 1 })).status).toBe(400);
    expect(kv.get(`fr:invname:${sharer.code}`).value).toBe("x".repeat(24));
    expect((await say({ name: "   " })).status).toBe(200);
    expect(kv.has(`fr:invname:${sharer.code}`)).toBe(false);
    await say({ name: "Alex" });
    expect((await say({ name: null })).status).toBe(200);
    expect(kv.has(`fr:invname:${sharer.code}`)).toBe(false);
    expect(kv.has(`fr:ownname:${sharer.ownerId}`)).toBe(false);
    expect((await invoke("/v1/friends/code/name", { body: { name: "Alex" } })).status).toBe(401);
    expect((await invoke("/v1/friends/code/name", { friend: friendKey("nobody"), body: { name: "Alex" } })).status).toBe(401);
  });

  it("applies the past-rounds limit and a lower pick deletes the rest", async () => {
    const owner = await mint("past-owner");
    const friend = await mint("past-friend");
    await befriend(friend, owner);
    const twelve = pastRounds(12);
    expect((await setPast(owner, friend, "10", twelve)).status).toBe(400);
    expect((await setPast(owner, friend, "none", twelve.slice(0, 1))).status).toBe(400);
    expect((await setPast(owner, friend, "25", twelve)).status).toBe(200);
    expect(await fetchIds(friend)).toEqual(twelve.map((row) => row.id).sort());
    const ten = twelve.slice(0, 10);
    expect((await setPast(owner, friend, "10", ten)).status).toBe(200);
    expect(await fetchIds(friend)).toEqual(ten.map((row) => row.id).sort());
    const stored = JSON.parse(kv.get(`fr:rounds:${owner.ownerId}`).value);
    expect(stored.map((row) => row.id).sort()).toEqual(ten.map((row) => row.id).sort());
    expect((await setPast(owner, friend, "none", [])).status).toBe(200);
    expect(await fetchIds(friend)).toEqual([]);
    expect(kv.has(`fr:rounds:${owner.ownerId}`)).toBe(false);
    const all = pastRounds(101, "all");
    expect((await setPast(owner, friend, "all", all)).status).toBe(400);
    expect((await setPast(owner, friend, "all", all.slice(0, 100))).status).toBe(200);
    expect((await fetchIds(friend)).length).toBe(100);
    expect((await setPast(owner, friend, "5", [])).status).toBe(400);
    expect((await setPast(owner, friend, 10, [])).status).toBe(400);
  });

  it("past rounds reach only the friend they were given to and keep normally shared rounds", async () => {
    const owner = await mint("aud-owner");
    const jamie = await mint("aud-jamie");
    const riley = await mint("aud-riley");
    await befriend(jamie, owner);
    await befriend(riley, owner);
    const shared = round("shared_1", "2026-10-12");
    expect((await invoke("/v1/friends/rounds", { method: "PUT", friend: owner.key, body: { share: true, round: shared } })).status).toBe(200);
    expect((await setPast(owner, jamie, "10", [round("old_1", "2025-04-01"), shared])).status).toBe(200);
    expect(await fetchIds(jamie)).toEqual(["old_1", "shared_1"]);
    expect(await fetchIds(riley)).toEqual(["shared_1"]);
    expect((await setPast(owner, riley, "10", [round("old_1", "2025-04-01")])).status).toBe(200);
    expect((await setPast(owner, jamie, "none", [])).status).toBe(200);
    // Jamie's None leaves Riley's pick and the normal share alone.
    expect(await fetchIds(jamie)).toEqual(["shared_1"]);
    expect(await fetchIds(riley)).toEqual(["old_1", "shared_1"]);
    // Owner still sees their own rounds.
    expect(await fetchIds(owner)).toEqual(["old_1", "shared_1"]);
  });

  it("never returns either side's choice or audience", async () => {
    const owner = await mint("hide-owner");
    const friend = await mint("hide-friend");
    await befriend(friend, owner);
    await setPast(owner, friend, "25", [round("old_h", "2025-02-02")]);
    await setPast(friend, owner, "10", [round("old_f", "2025-03-03")]);
    for (const who of [owner, friend]) {
      for (const path of ["/v1/friends/rounds", "/v1/friends/list", "/v1/friends/requests"]) {
        const res = await invoke(path, { method: "GET", friend: who.key });
        expect(res.status).toBe(200);
        expect(res.text).not.toMatch(/"choice"|"to"|"limit"|"past"/);
        expect(res.text).not.toContain(who === owner ? friend.ownerId + "\"]" : owner.ownerId + "\"]");
      }
    }
    const set = await setPast(owner, friend, "10", []);
    expect(set.json).toEqual({ ok: true });
    expect((await invoke("/v1/friends/past", { method: "GET", friend: friend.key })).status).toBe(405);
  });

  it("refuses past rounds for a non-friend, for yourself, and with a spoofed audience", async () => {
    const owner = await mint("nf-owner");
    const stranger = await mint("nf-stranger");
    expect((await setPast(owner, stranger, "10", [round("x_1", "2025-01-01")])).status).toBe(409);
    expect((await setPast(owner, owner, "10", [])).status).toBe(400);
    const friend = await mint("nf-friend");
    await befriend(friend, owner);
    expect((await setPast(owner, friend, "10", [round("x_1", "2025-01-01", { to: [stranger.ownerId] })])).status).toBe(400);
    expect((await invoke("/v1/friends/rounds", { method: "PUT", friend: owner.key, body: { share: true, round: round("x_2", "2025-01-01", { to: [friend.ownerId] }) } })).status).toBe(400);
    expect(kv.has(`fr:rounds:${owner.ownerId}`)).toBe(false);
  });

  it("removing a friend takes back past rounds both ways", async () => {
    const owner = await mint("rm-owner");
    const friend = await mint("rm-friend");
    const other = await mint("rm-other");
    await befriend(friend, owner);
    await befriend(other, owner);
    await setPast(owner, friend, "10", [round("o_1", "2025-01-01")]);
    await setPast(owner, other, "10", [round("o_2", "2025-01-02")]);
    await setPast(friend, owner, "10", [round("f_1", "2025-01-03")]);
    expect((await invoke("/v1/friends/remove", { friend: friend.key, body: { ownerId: owner.ownerId } })).status).toBe(200);
    const left = JSON.parse(kv.get(`fr:rounds:${owner.ownerId}`).value);
    expect(left.map((row) => row.id)).toEqual(["o_2"]);
    expect(kv.has(`fr:rounds:${friend.ownerId}`)).toBe(false);
    expect(await fetchIds(other)).toEqual(["o_2"]);
  });

  it("sends and stores no GPS in any friends payload", async () => {
    const owner = await mint("gps-owner");
    const friend = await mint("gps-friend");
    await befriend(friend, owner);
    await invoke("/v1/friends/code/name", { friend: owner.key, body: { name: INVITE_NAME } });
    expect((await setPast(owner, friend, "10", [round("g_1", "2025-01-01", { lat: 34.7, lng: -92.3 })])).status).toBe(400);
    const gpsHole = round("g_2", "2025-01-01");
    gpsHole.holes[0] = { ...gpsHole.holes[0], lat: 34.7, lng: -92.3 };
    expect((await setPast(owner, friend, "10", [gpsHole])).status).toBe(400);
    expect((await setPast(owner, friend, "10", [round("g_3", "2025-01-01")])).status).toBe(200);
    await invoke("/v1/friends/codes/lookup", { friend: friend.key, body: { code: owner.code } });
    await fetchIds(friend);
    const everything = [...bodies, ...[...kv.values()].map((row) => row.value)].join("\n");
    expect(everything).not.toMatch(/"(lat|lng|latitude|longitude|gps|coords?)"/i);
  });
});
