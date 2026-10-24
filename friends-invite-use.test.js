import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker, { FriendGuessLimiter } from "./worker.js";
import { FRIEND_CODE_GUESS_LIMIT } from "./friends.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_CUTOVER_MS = Date.parse("2026-10-24T19:49:00.000Z");
const NOT_AVAILABLE = { error: "code_not_found" };
const SOURCE = readFileSync(new URL("./friends.js", import.meta.url), "utf8");

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

function headerMap(headers) {
  const out = {};
  for (const [key, value] of headers) out[key] = value;
  return out;
}

describe("single-use invites", () => {
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

  async function invoke(pathname, { method = "POST", body, friend } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await worker.fetch(new Request(`${ORIGIN}${pathname}`, {
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

  async function mint(suffix) {
    const key = friendKey(suffix);
    const minted = await invoke("/v1/friends/code", { friend: key, body: {} });
    expect(minted.status).toBe(200);
    return { key, code: minted.json.code, ownerId: minted.json.ownerId };
  }

  function send(person, ownerOrCode) {
    const code = typeof ownerOrCode === "string" ? ownerOrCode : ownerOrCode.code;
    return invoke("/v1/friends/requests", { friend: person.key, body: { code } });
  }

  function lookup(person, code) {
    return invoke("/v1/friends/codes/lookup", { friend: person.key, body: { code } });
  }

  function accept(owner, requester) {
    return invoke("/v1/friends/requests/accept", { friend: owner.key, body: { ownerId: requester.ownerId } });
  }

  function decline(owner, requester) {
    return invoke("/v1/friends/requests/decline", { friend: owner.key, body: { ownerId: requester.ownerId } });
  }

  function list(person) {
    return invoke("/v1/friends/requests", { method: "GET", friend: person.key });
  }

  function friendsOf(person) {
    return invoke("/v1/friends/list", { method: "GET", friend: person.key });
  }

  function acceptLink(person, ownerOrCode) {
    const code = typeof ownerOrCode === "string" ? ownerOrCode : ownerOrCode.code;
    return invoke("/v1/friends/codes/accept", { friend: person.key, body: { code } });
  }

  function reqKey(owner, requester) {
    return `fr:req:${owner.ownerId}:${requester.ownerId}`;
  }

  function spyInviteOps() {
    const ops = [];
    const ns = env.FRIEND_GUESSES;
    const inner = ns.get.bind(ns);
    env.FRIEND_GUESSES = {
      idFromName: ns.idFromName.bind(ns),
      get(id) {
        const stub = inner(id);
        return {
          fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init);
            const watched = request.clone();
            return watched.json().then((body) => {
              if (String(id.name).startsWith("inv:")) ops.push({ name: id.name, op: body && body.op });
              return stub.fetch(request);
            });
          },
        };
      },
    };
    return ops;
  }

  it("records the legacy deploy cutover and the one-line hold switch", () => {
    expect(SOURCE).toContain("2026-10-24T19:49:00.000Z");
    expect(SOURCE).toMatch(/FRIEND_DECLINE_HOLDS_SENDER\s*=\s*true/);
    expect(LEGACY_CUTOVER_MS).toBe(1792871340000);
  });

  it("redeems a code once inside the durable object", async () => {
    const ns = env.FRIEND_GUESSES;
    const stub = ns.get(ns.idFromName("inv:AB3K7NP2"));
    async function redeem() {
      const response = await stub.fetch("https://friend-guess.internal/limit", {
        method: "POST",
        body: JSON.stringify({ op: "redeem" }),
      });
      return response.json();
    }
    const [left, right] = await Promise.all([redeem(), redeem()]);
    expect([left, right].filter((row) => row && row.ok === true)).toHaveLength(1);
    expect([left, right].filter((row) => row && row.ok === false)).toHaveLength(1);
    expect((await redeem()).ok).toBe(false);
  });

  it("does not consume a code on lookup, and the same person cannot duplicate a request", async () => {
    env.FRIEND_NOW_MS = 1_700_000_000_000;
    const owner = await mint("later-owner");
    const bob = await mint("later-bob");
    const carol = await mint("later-carol");
    expect((await lookup(bob, owner.code)).status).toBe(200);
    env.FRIEND_NOW_MS += 6 * 24 * 60 * 60 * 1000;
    expect((await lookup(bob, owner.code)).json.ownerId).toBe(owner.ownerId);
    expect((await lookup(carol, owner.code)).status).toBe(200);
    const first = await send(bob, owner);
    const second = await send(bob, owner);
    expect(first.json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect(second.json).toEqual({ status: "pending", ownerId: owner.ownerId, already: "outgoing" });
    expect([...kv.keys()].filter((key) => key === reqKey(owner, bob))).toHaveLength(1);
    expect((await send(carol, owner)).json).toEqual({ status: "pending", ownerId: owner.ownerId });
  });

  it("uses the code when the first accept wins, including two at once", async () => {
    const owner = await mint("race-owner");
    const bob = await mint("race-bob");
    const carol = await mint("race-carol");
    const dave = await mint("race-dave");
    await send(bob, owner);
    await send(carol, owner);
    const ops = spyInviteOps();
    const [left, right] = await Promise.all([accept(owner, bob), accept(owner, carol)]);
    const wins = [left, right].filter((row) => row.status === 200);
    const losses = [left, right].filter((row) => row.status === 409);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(wins[0].json).toEqual({ status: "friends", ownerId: wins[0].json.ownerId });
    expect([bob.ownerId, carol.ownerId]).toContain(wins[0].json.ownerId);
    expect(losses[0].json).toEqual({ error: "not_friends" });
    expect(ops.filter((op) => op.op === "redeem").length).toBeGreaterThanOrEqual(1);
    expect(ops.every((op) => op.name.startsWith("inv:"))).toBe(true);
    expect([...kv.keys()].filter((key) => key.startsWith("fr:friend:"))).toHaveLength(2);
    const miss = await lookup(dave, "23456789");
    const used = await lookup(dave, owner.code);
    expect(used.status).toBe(miss.status);
    expect(used.text).toBe(miss.text);
    expect(used.json).toEqual(NOT_AVAILABLE);
    const own = await lookup(owner, owner.code);
    expect(own.status).toBe(200);
    expect(own.json.ownerId).toBe(owner.ownerId);
  });

  it("fails a later accept after the code is used, and keeps already-friends distinct", async () => {
    env.FRIEND_NOW_MS = 1_710_000_000_000;
    const owner = await mint("used-owner");
    const bob = await mint("used-bob");
    const carol = await mint("used-carol");
    const stranger = await mint("used-stranger");
    await send(bob, owner);
    await send(carol, owner);
    expect((await accept(owner, bob)).status).toBe(200);
    expect((await accept(owner, carol)).json).toEqual({ error: "not_friends" });
    expect([...kv.keys()].filter((key) => key.startsWith(`fr:friend:${owner.ownerId}:`))).toEqual([
      `fr:friend:${owner.ownerId}:${bob.ownerId}`,
    ]);
    const again = await send(bob, owner);
    expect(again.json).toEqual({ status: "friends", ownerId: owner.ownerId, already: "friends" });
    env.FRIEND_NOW_MS += WEEK_MS;
    expect((await send(bob, owner)).json).toEqual({ status: "friends", ownerId: owner.ownerId, already: "friends" });
    expect((await send(stranger, owner)).json).toEqual(NOT_AVAILABLE);
    expect((await invoke("/v1/friends/requests", { friend: owner.key, body: { code: owner.code } })).json).toEqual({
      error: "invalid_body",
    });
  });

  it("closes a new code at 7 days and one second on either side of that instant", async () => {
    env.FRIEND_NOW_MS = 1_720_000_000_000;
    const owner = await mint("edge-owner");
    const pal = await mint("edge-pal");
    await invoke("/v1/friends/code/name", { friend: owner.key, body: { name: "Alex M." } });
    const created = 1_720_000_000_000;
    env.FRIEND_NOW_MS = created + WEEK_MS - 1000;
    const open = await lookup(pal, owner.code);
    expect(open.status).toBe(200);
    expect(open.json.ownerId).toBe(owner.ownerId);
    expect(open.json.name).toBe("Alex M.");
    env.FRIEND_NOW_MS = created + WEEK_MS;
    const expired = await lookup(pal, owner.code);
    const miss = await lookup(pal, "23456789");
    expect(expired.status).toBe(404);
    expect(expired.text).toBe(miss.text);
    expect(expired.json).toEqual(NOT_AVAILABLE);
    expect(expired.text).not.toContain("Alex");
    env.FRIEND_NOW_MS = created + WEEK_MS + 1000;
    expect((await lookup(pal, owner.code)).text).toBe(miss.text);
    const own = await lookup(owner, owner.code);
    expect(own.status).toBe(200);
    expect(own.json.ownerId).toBe(owner.ownerId);
  });

  it("keeps a legacy code working until 7 days after deploy, then the same not-available answer", async () => {
    env.FRIEND_NOW_MS = LEGACY_CUTOVER_MS;
    const owner = await mint("legacy-owner");
    kv.delete(`fr:invat:${owner.code}`);
    expect(kv.get(`fr:code:${owner.code}`).value).toBe(owner.ownerId);
    const pal = await mint("legacy-pal");
    const other = await mint("legacy-other");
    const stranger = await mint("legacy-stranger");
    env.FRIEND_NOW_MS = LEGACY_CUTOVER_MS + WEEK_MS - 1000;
    expect((await lookup(pal, owner.code)).status).toBe(200);
    expect((await send(pal, owner)).json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect((await send(other, owner)).json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect((await accept(owner, pal)).status).toBe(200);
    expect((await accept(owner, other)).status).toBe(200);
    env.FRIEND_NOW_MS = LEGACY_CUTOVER_MS + WEEK_MS;
    const past = await lookup(stranger, owner.code);
    const miss = await lookup(stranger, "23456789");
    expect(past.status).toBe(miss.status);
    expect(past.text).toBe(miss.text);
    expect(past.json).toEqual(NOT_AVAILABLE);
  });

  it("spends the 8-guess limit the same way for used, expired, legacy-past, and unknown codes", async () => {
    env.FRIEND_NOW_MS = 1_730_000_000_000;
    const expiredOwner = await mint("guess-expired");
    const usedOwner = await mint("guess-used");
    const legacyOwner = await mint("guess-legacy");
    kv.delete(`fr:invat:${legacyOwner.code}`);
    const friend = await mint("guess-friend");
    await send(friend, usedOwner);
    expect((await accept(usedOwner, friend)).status).toBe(200);
    const expiredAt = 1_730_000_000_000 + WEEK_MS;
    const samples = [];
    async function sample(person, code) {
      const row = await lookup(person, code);
      samples.push(row.text);
      return row;
    }
    const missKey = await mint("guess-miss");
    const expiredKey = await mint("guess-expkey");
    const usedKey = await mint("guess-usedkey");
    const legacyKey = await mint("guess-legkey");
    env.FRIEND_NOW_MS = 1_730_000_000_000 + 60_000;
    expect((await sample(usedKey, usedOwner.code)).json).toEqual(NOT_AVAILABLE);
    env.FRIEND_NOW_MS = expiredAt;
    expect((await sample(missKey, "23456789")).json).toEqual(NOT_AVAILABLE);
    expect((await sample(expiredKey, expiredOwner.code)).json).toEqual(NOT_AVAILABLE);
    env.FRIEND_NOW_MS = LEGACY_CUTOVER_MS + WEEK_MS;
    expect((await sample(legacyKey, legacyOwner.code)).json).toEqual(NOT_AVAILABLE);
    expect(new Set(samples).size).toBe(1);

    async function rest(person, code, now) {
      env.FRIEND_NOW_MS = now;
      for (let i = 1; i < FRIEND_CODE_GUESS_LIMIT; i += 1) {
        expect((await lookup(person, code)).status).toBe(404);
      }
      const limited = await lookup(person, code);
      expect(limited.status).toBe(429);
      expect(limited.json).toEqual({ error: "rate_limited" });
      return limited.json;
    }
    const missLimited = await rest(missKey, "23456789", expiredAt);
    const expiredLimited = await rest(expiredKey, expiredOwner.code, expiredAt);
    const usedLimited = await rest(usedKey, usedOwner.code, 1_730_000_000_000 + 60_000);
    const legacyLimited = await rest(legacyKey, legacyOwner.code, LEGACY_CUTOVER_MS + WEEK_MS);
    expect(expiredLimited).toEqual(missLimited);
    expect(usedLimited).toEqual(missLimited);
    expect(legacyLimited).toEqual(missLimited);

    const owner = await mint("guess-own");
    for (let i = 0; i < FRIEND_CODE_GUESS_LIMIT; i += 1) {
      const own = await send(owner, owner);
      expect(own.status).toBe(400);
      expect(own.json).toEqual({ error: "invalid_body" });
    }
    expect((await lookup(owner, "23456789")).status).toBe(404);
  });

  it("decline deletes the pending rows, notifies nobody, and only the recipient can do it", async () => {
    env.FRIEND_NOW_MS = 1_740_000_000_000;
    const owner = await mint("dec-owner");
    const bob = await mint("dec-bob");
    const carol = await mint("dec-carol");
    const stranger = await mint("dec-stranger");
    await send(bob, owner);
    kv.set(`fr:out:${bob.ownerId}:${owner.ownerId}`, { value: "pending" });
    expect((await list(bob)).json.outgoing).toEqual([{ ownerId: owner.ownerId }]);
    const declined = await decline(owner, bob);
    expect(declined.status).toBe(200);
    expect(declined.json).toEqual({ ok: true });
    expect(declined.text.toLowerCase()).not.toContain("declin");
    expect(kv.has(reqKey(owner, bob))).toBe(false);
    expect(kv.has(`fr:out:${bob.ownerId}:${owner.ownerId}`)).toBe(false);
    expect([...kv.keys()].filter((key) => key.startsWith("fr:friend:"))).toEqual([]);
    expect([...kv.keys()].filter((key) => key.startsWith("fr:block:"))).toEqual([]);
    expect((await list(bob)).json).toEqual({ incoming: [], outgoing: [] });
    expect((await list(owner)).json).toEqual({ incoming: [], outgoing: [] });
    const friends = await invoke("/v1/friends/list", { method: "GET", friend: bob.key });
    expect(friends.json).toEqual({ friends: [] });
    const visible = `${declined.text}\n${friends.text}\n${(await list(bob)).text}`;
    expect(visible.toLowerCase()).not.toContain("declin");
    expect(visible).not.toContain("fr:hold");
    expect((await decline(owner, bob)).json).toEqual({ error: "not_friends" });

    await send(carol, owner);
    expect((await decline(bob, carol)).json).toEqual({ error: "not_friends" });
    expect((await decline(stranger, carol)).json).toEqual({ error: "not_friends" });
    expect(kv.has(reqKey(owner, carol))).toBe(true);
    expect((await accept(owner, carol)).status).toBe(200);
    expect(kv.has(`fr:friend:${owner.ownerId}:${carol.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${owner.ownerId}:${bob.ownerId}`)).toBe(false);
  });

  it("matches a normal send byte for byte when the same sender tries again, and lists nothing", async () => {
    env.FRIEND_NOW_MS = 1_750_000_000_000;
    const owner = await mint("byte-owner");
    const bob = await mint("byte-bob");
    const first = await send(bob, owner);
    expect(first.json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect((await decline(owner, bob)).status).toBe(200);
    const again = await send(bob, owner);
    expect(again.status).toBe(first.status);
    expect(again.text).toBe(first.text);
    expect(headerMap(again.headers)).toEqual(headerMap(first.headers));
    expect(kv.has(reqKey(owner, bob))).toBe(false);
    expect((await list(bob)).json).toEqual({ incoming: [], outgoing: [] });
    expect((await list(owner)).json.incoming).toEqual([]);
  });

  it("leaves decline, cancel, and expiry with the same list bytes", async () => {
    env.FRIEND_NOW_MS = 1_760_000_000_000;
    const created = env.FRIEND_NOW_MS;
    const declinedOwner = await mint("same-dec-owner");
    const cancelledOwner = await mint("same-can-owner");
    const expiredOwner = await mint("same-exp-owner");
    const declinedSender = await mint("same-dec-sender");
    const cancelledSender = await mint("same-can-sender");
    const expiredSender = await mint("same-exp-sender");
    await send(declinedSender, declinedOwner);
    await send(cancelledSender, cancelledOwner);
    await send(expiredSender, expiredOwner);
    expect((await decline(declinedOwner, declinedSender)).status).toBe(200);
    expect((await invoke("/v1/friends/requests/cancel", {
      friend: cancelledSender.key,
      body: { ownerId: cancelledOwner.ownerId },
    })).json).toEqual({ ok: true });
    env.FRIEND_NOW_MS = created + WEEK_MS;
    const declinedList = await list(declinedSender);
    const cancelledList = await list(cancelledSender);
    const expiredList = await list(expiredSender);
    expect(declinedList.json).toEqual({ incoming: [], outgoing: [] });
    expect(cancelledList.text).toBe(declinedList.text);
    expect(expiredList.text).toBe(declinedList.text);
    expect(declinedList.text.toLowerCase()).not.toContain("declin");
    expect(declinedList.text).not.toContain(declinedOwner.ownerId);
    expect(expiredList.text).not.toContain(expiredOwner.ownerId);
  });

  it("drops only that sender until the code clock ends, and a new code works", async () => {
    env.FRIEND_NOW_MS = 1_770_000_000_000;
    const created = env.FRIEND_NOW_MS;
    const owner = await mint("hold-owner");
    const bob = await mint("hold-bob");
    const carol = await mint("hold-carol");
    const first = await send(bob, owner);
    expect((await decline(owner, bob)).status).toBe(200);
    env.FRIEND_NOW_MS = created + WEEK_MS - 1000;
    const held = await send(bob, owner);
    expect(held.text).toBe(first.text);
    expect(headerMap(held.headers)).toEqual(headerMap(first.headers));
    expect(kv.has(reqKey(owner, bob))).toBe(false);
    const carolSent = await send(carol, owner);
    expect(carolSent.json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect(kv.get(reqKey(owner, carol)).value).toBe("pending");
    env.FRIEND_NOW_MS = created + WEEK_MS;
    const expiredSend = await send(bob, owner);
    const miss = await send(carol, "23456789");
    expect(expiredSend.status).toBe(404);
    expect(expiredSend.text).toBe(miss.text);
    env.FRIEND_NOW_MS = created + WEEK_MS + 1000;
    const reset = await invoke("/v1/friends/code/reset", { friend: owner.key, body: {} });
    expect(reset.status).toBe(200);
    owner.code = reset.json.code;
    env.FRIEND_NOW_MS = created + WEEK_MS + 2000;
    const fresh = await send(bob, owner);
    expect(fresh.json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect(kv.get(reqKey(owner, bob)).value).toBe("pending");
    expect((await list(bob)).json.outgoing).toEqual([{ ownerId: owner.ownerId }]);
    expect((await accept(owner, bob)).status).toBe(200);
  });

  it("stores a real request again when the hold switch is off", async () => {
    env.FRIEND_DECLINE_HOLDS_SENDER = false;
    const owner = await mint("switch-owner");
    const bob = await mint("switch-bob");
    await send(bob, owner);
    expect((await decline(owner, bob)).status).toBe(200);
    expect(kv.has(reqKey(owner, bob))).toBe(false);
    const again = await send(bob, owner);
    expect(again.json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect(kv.get(reqKey(owner, bob)).value).toBe("pending");
    expect((await list(bob)).json.outgoing).toEqual([{ ownerId: owner.ownerId }]);
    expect((await list(owner)).json.incoming).toEqual([{ ownerId: bob.ownerId }]);
  });

  it("keeps block, remove, and the unlisted old path on their current answers", async () => {
    const owner = await mint("keep-owner");
    const pal = await mint("keep-pal");
    const old = await invoke("/v1/friends/decline", { friend: owner.key, body: { ownerId: pal.ownerId } });
    expect(old.status).toBe(404);
    expect(old.json).toEqual({ error: "unknown_route" });
    expect((await invoke("/v1/friends/block", { friend: owner.key, body: { ownerId: pal.ownerId } })).json).toEqual({
      error: "not_friends",
    });
    expect([...kv.keys()].filter((key) => key.startsWith("fr:block:"))).toEqual([]);
    await send(pal, owner);
    expect((await accept(owner, pal)).status).toBe(200);
    expect((await invoke("/v1/friends/remove", { friend: owner.key, body: { ownerId: pal.ownerId } })).json).toEqual({
      ok: true,
    });
    expect([...kv.keys()].filter((key) => key.startsWith("fr:friend:"))).toEqual([]);
    expect((await send(pal, owner)).json).toEqual(NOT_AVAILABLE);
    const owner2 = await mint("keep-owner2");
    const pal2 = await mint("keep-pal2");
    await send(pal2, owner2);
    expect((await accept(owner2, pal2)).status).toBe(200);
    expect((await invoke("/v1/friends/block", { friend: owner2.key, body: { ownerId: pal2.ownerId } })).json).toEqual({
      ok: true,
    });
    expect(kv.get(`fr:block:${owner2.ownerId}:${pal2.ownerId}`).value).toBe("1");
    expect(kv.has(`fr:friend:${owner2.ownerId}:${pal2.ownerId}`)).toBe(false);
  });

  it("adds both people when the invited person accepts the link", async () => {
    env.FRIEND_NOW_MS = 1_780_000_000_000;
    const owner = await mint("link-owner");
    const pal = await mint("link-pal");
    const stranger = await mint("link-stranger");
    const accepted = await acceptLink(pal, owner);
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ status: "friends", ownerId: owner.ownerId });
    expect(accepted.text.toLowerCase()).not.toContain("push");
    expect(accepted.text.toLowerCase()).not.toContain("block");
    expect(kv.has(`fr:friend:${owner.ownerId}:${pal.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${pal.ownerId}:${owner.ownerId}`)).toBe(true);
    expect((await friendsOf(owner)).json).toEqual({ friends: [{ ownerId: pal.ownerId }] });
    expect((await friendsOf(pal)).json).toEqual({ friends: [{ ownerId: owner.ownerId }] });
    expect((await list(owner)).json).toEqual({ incoming: [], outgoing: [] });
    expect((await list(pal)).json).toEqual({ incoming: [], outgoing: [] });
    expect((await friendsOf(owner)).text.toLowerCase()).not.toContain("push");
    const miss = await acceptLink(stranger, "23456789");
    const again = await acceptLink(stranger, owner);
    expect(again.status).toBe(miss.status);
    expect(again.text).toBe(miss.text);
    expect(again.json).toEqual(NOT_AVAILABLE);
    expect([...kv.keys()].filter((key) => key.startsWith("fr:friend:"))).toHaveLength(2);
    const repeat = await acceptLink(pal, owner);
    expect(repeat.json).toEqual({ status: "friends", ownerId: owner.ownerId, already: "friends" });
  });

  it("lets one of two simultaneous link accepts win, and writes one pair of friend rows", async () => {
    const owner = await mint("race-link-owner");
    const bob = await mint("race-link-bob");
    const carol = await mint("race-link-carol");
    const ops = spyInviteOps();
    const [left, right] = await Promise.all([acceptLink(bob, owner), acceptLink(carol, owner)]);
    const wins = [left, right].filter((row) => row.status === 200);
    const losses = [left, right].filter((row) => row.status === 404);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(wins[0].json).toEqual({ status: "friends", ownerId: owner.ownerId });
    expect(losses[0].json).toEqual(NOT_AVAILABLE);
    expect(ops.filter((op) => op.op === "redeem").length).toBeGreaterThanOrEqual(1);
    expect(ops.every((op) => op.name.startsWith("inv:"))).toBe(true);
    const friendKeys = [...kv.keys()].filter((key) => key.startsWith("fr:friend:")).sort();
    expect(friendKeys).toHaveLength(2);
    const winnerId = wins[0].json.ownerId === owner.ownerId
      ? (kv.has(`fr:friend:${owner.ownerId}:${bob.ownerId}`) ? bob.ownerId : carol.ownerId)
      : wins[0].json.ownerId;
    expect(friendKeys).toEqual([
      `fr:friend:${owner.ownerId}:${winnerId}`,
      `fr:friend:${winnerId}:${owner.ownerId}`,
    ].sort());
  });

  it("drops leftover requests in both directions when the link is accepted", async () => {
    const owner = await mint("stale-owner");
    const pal = await mint("stale-pal");
    expect((await send(pal, owner)).json).toEqual({ status: "pending", ownerId: owner.ownerId });
    kv.set(`fr:req:${pal.ownerId}:${owner.ownerId}`, { value: "pending" });
    kv.set(`fr:rcode:${pal.ownerId}:${owner.ownerId}`, { value: `${owner.code}:${1_790_000_000_000 + WEEK_MS}` });
    kv.set(`fr:out:${pal.ownerId}:${owner.ownerId}`, { value: "pending" });
    kv.set(`fr:out:${owner.ownerId}:${pal.ownerId}`, { value: "pending" });
    const accepted = await acceptLink(pal, owner);
    expect(accepted.json).toEqual({ status: "friends", ownerId: owner.ownerId });
    expect(kv.has(`fr:req:${owner.ownerId}:${pal.ownerId}`)).toBe(false);
    expect(kv.has(`fr:req:${pal.ownerId}:${owner.ownerId}`)).toBe(false);
    expect(kv.has(`fr:rcode:${owner.ownerId}:${pal.ownerId}`)).toBe(false);
    expect(kv.has(`fr:rcode:${pal.ownerId}:${owner.ownerId}`)).toBe(false);
    expect(kv.has(`fr:out:${pal.ownerId}:${owner.ownerId}`)).toBe(false);
    expect(kv.has(`fr:out:${owner.ownerId}:${pal.ownerId}`)).toBe(false);
    expect((await list(owner)).json).toEqual({ incoming: [], outgoing: [] });
    expect((await list(pal)).json).toEqual({ incoming: [], outgoing: [] });
  });

  it("does not add a blocked pair, and does not say blocked when the owner blocked the invited person", async () => {
    const owner = await mint("block-link-owner");
    const pal = await mint("block-link-pal");
    const carol = await mint("block-link-carol");
    const missKey = await mint("block-link-miss");
    kv.set(`fr:block:${owner.ownerId}:${pal.ownerId}`, { value: "1" });
    const hidden = await acceptLink(pal, owner);
    const miss = await acceptLink(missKey, "23456789");
    expect(hidden.status).toBe(miss.status);
    expect(hidden.text).toBe(miss.text);
    expect(hidden.json).toEqual(NOT_AVAILABLE);
    expect(hidden.text.toLowerCase()).not.toContain("block");
    expect([...kv.keys()].filter((key) => key.startsWith("fr:friend:"))).toEqual([]);
    expect((await acceptLink(carol, owner)).json).toEqual({ status: "friends", ownerId: owner.ownerId });
    expect(kv.has(`fr:friend:${owner.ownerId}:${pal.ownerId}`)).toBe(false);

    const owner2 = await mint("block-link-owner2");
    const pal2 = await mint("block-link-pal2");
    const carol2 = await mint("block-link-carol2");
    kv.set(`fr:block:${pal2.ownerId}:${owner2.ownerId}`, { value: "1" });
    const known = await acceptLink(pal2, owner2);
    expect(known.status).toBe(409);
    expect(known.json).toEqual({ error: "blocked" });
    expect(kv.has(`fr:friend:${owner2.ownerId}:${pal2.ownerId}`)).toBe(false);
    expect((await acceptLink(carol2, owner2)).json).toEqual({ status: "friends", ownerId: owner2.ownerId });
  });

  it("keeps send-then-owner-accept working for an old build", async () => {
    const owner = await mint("old-path-owner");
    const pal = await mint("old-path-pal");
    const sent = await send(pal, owner);
    expect(sent.json).toEqual({ status: "pending", ownerId: owner.ownerId });
    expect([...kv.keys()].filter((key) => key.startsWith("fr:friend:"))).toEqual([]);
    const alone = await accept(owner, pal);
    expect(alone.status).toBe(200);
    expect(alone.json).toEqual({ status: "friends", ownerId: pal.ownerId });
    expect(kv.has(`fr:friend:${owner.ownerId}:${pal.ownerId}`)).toBe(true);
    expect(kv.has(`fr:friend:${pal.ownerId}:${owner.ownerId}`)).toBe(true);
    expect(kv.has(reqKey(owner, pal))).toBe(false);
    const owner2 = await mint("old-path-owner2");
    const pal2 = await mint("old-path-pal2");
    expect((await accept(owner2, pal2)).json).toEqual({ error: "not_friends" });
    expect(kv.has(`fr:friend:${owner2.ownerId}:${pal2.ownerId}`)).toBe(false);
    expect((await acceptLink(pal2, owner2)).json).toEqual({ status: "friends", ownerId: owner2.ownerId });
  });

  it("still holds a declined sender off that code without burning it", async () => {
    const owner = await mint("hold-link-owner");
    const pal = await mint("hold-link-pal");
    const carol = await mint("hold-link-carol");
    const missKey = await mint("hold-link-miss");
    await send(pal, owner);
    expect((await decline(owner, pal)).json).toEqual({ ok: true });
    const held = await acceptLink(pal, owner);
    const miss = await acceptLink(missKey, "23456789");
    expect(held.text).toBe(miss.text);
    expect(held.json).toEqual(NOT_AVAILABLE);
    expect(kv.has(`fr:friend:${owner.ownerId}:${pal.ownerId}`)).toBe(false);
    expect((await acceptLink(carol, owner)).json).toEqual({ status: "friends", ownerId: owner.ownerId });
    expect(kv.has(`fr:friend:${owner.ownerId}:${pal.ownerId}`)).toBe(false);
    expect(kv.has(`fr:friend:${owner.ownerId}:${carol.ownerId}`)).toBe(true);
  });

  it("rejects the caller's own code before spending a guess", async () => {
    const owner = await mint("own-link-owner");
    for (let i = 0; i < FRIEND_CODE_GUESS_LIMIT; i += 1) {
      const own = await acceptLink(owner, owner);
      expect(own.status).toBe(400);
      expect(own.json).toEqual({ error: "invalid_body" });
    }
    expect((await lookup(owner, "23456789")).status).toBe(404);
    expect((await lookup(owner, "23456789")).json).toEqual(NOT_AVAILABLE);
  });
});
