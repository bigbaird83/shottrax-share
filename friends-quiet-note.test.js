import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter } from "./entry.js";
import { FRIEND_CAP, FRIEND_CODE_GUESS_LIMIT, FRIEND_IP_GUESS_LIMIT, ROUND_CAP } from "./friends.js";

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
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return obj.fetch(request);
        },
      };
    },
  };
}

function roundBody(id) {
  return {
    id,
    courseName: "Pine Test",
    playedOn: "2026-10-11",
    gross: 80,
    toPar: 8,
    holes: [{ hole: 1, score: 4, par: 4 }],
  };
}

describe("quiet-block sender note", () => {
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

  async function mint(suffix) {
    const key = friendKey(suffix);
    const created = await viaEntry("/v1/friends/code", { method: "POST", friend: key, body: {} });
    expect(created.status).toBe(200);
    return { key, code: created.json.code, ownerId: created.json.ownerId };
  }

  function send(from, to) {
    return viaEntry("/v1/friends/requests", { method: "POST", friend: from.key, body: { code: to.code } });
  }

  async function befriend(from, to) {
    const sent = await send(from, to);
    expect(sent.json).toEqual({ status: "pending", ownerId: to.ownerId });
    const accepted = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: to.key,
      body: { ownerId: from.ownerId },
    });
    expect(accepted.json).toEqual({ status: "friends", ownerId: from.ownerId });
  }

  function noteKey(sender, recipient) {
    return `fr:out:${sender.ownerId}:${recipient.ownerId}`;
  }

  function reqKey(recipient, requester) {
    return `fr:req:${recipient.ownerId}:${requester.ownerId}`;
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
        seen.put.push({ key, value, options });
        return boards.put(key, value, options);
      },
      async delete(key) {
        seen.delete.push(key);
        return boards.delete(key);
      },
      async list(options) {
        seen.list.push(options);
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

  function ownerIds(entries) {
    return entries.map((entry) => entry.ownerId);
  }

  it("sender outgoing list and send response match a real pending request byte for byte", async () => {
    const recipient = await mint("byte-recipient");
    const second = await mint("byte-second");
    const realSender = await mint("byte-real");
    const quietSender = await mint("byte-quiet");
    await befriend(quietSender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });

    const realSend = await send(realSender, recipient);
    const quietSend = await send(quietSender, recipient);
    expect(quietSend.status).toBe(realSend.status);
    expect(quietSend.text).toBe(realSend.text);
    expect(quietSend.headers.get("Content-Type")).toBe(realSend.headers.get("Content-Type"));
    expect(quietSend.headers.get("Cache-Control")).toBe(realSend.headers.get("Cache-Control"));
    expect(quietSend.text).toBe(`{"status":"pending","ownerId":"${recipient.ownerId}"}`);
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.get(noteKey(quietSender, recipient)).expirationTtl).toBeUndefined();
    expect(kv.has(reqKey(recipient, quietSender))).toBe(false);
    expect(kv.get(reqKey(recipient, realSender)).value).toBe("pending");

    const realSecond = await send(realSender, second);
    const quietSecond = await send(quietSender, second);
    expect(quietSecond.text).toBe(realSecond.text);

    const realList = await viaEntry("/v1/friends/requests", { friend: realSender.key });
    const quietList = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    expect(quietList.status).toBe(realList.status);
    expect(quietList.text).toBe(realList.text);
    expect(quietList.headers.get("Content-Type")).toBe(realList.headers.get("Content-Type"));
    expect(quietList.headers.get("Cache-Control")).toBe(realList.headers.get("Cache-Control"));
    const ids = ownerIds(quietList.json.outgoing);
    expect(ids).toEqual([...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    expect(ids).toEqual([recipient.ownerId, second.ownerId].sort());
    expect(Object.keys(quietList.json.outgoing[0])).toEqual(["ownerId"]);

    const again = await send(quietSender, recipient);
    expect(again.text).toBe(quietSend.text);
    expect([...kv.keys()].filter((name) => name.startsWith(`fr:out:${quietSender.ownerId}:`))).toEqual([
      noteKey(quietSender, recipient),
    ]);
  });

  it("blocker incoming and friends lists stay unchanged", async () => {
    const recipient = await mint("same-recipient");
    const quietSender = await mint("same-quiet");
    const kept = await mint("same-kept");
    const otherRequester = await mint("same-other");
    await befriend(kept, recipient);
    await befriend(quietSender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });
    expect((await send(otherRequester, recipient)).json.status).toBe("pending");

    const beforeRequests = await viaEntry("/v1/friends/requests", { friend: recipient.key });
    const beforeFriends = await viaEntry("/v1/friends/list", { friend: recipient.key });
    expect(ownerIds(beforeRequests.json.incoming)).toEqual([otherRequester.ownerId]);
    expect(ownerIds(beforeFriends.json.friends)).toEqual([kept.ownerId]);

    const quiet = await send(quietSender, recipient);
    expect(quiet.text).toBe(`{"status":"pending","ownerId":"${recipient.ownerId}"}`);
    const afterRequests = await viaEntry("/v1/friends/requests", { friend: recipient.key });
    const afterFriends = await viaEntry("/v1/friends/list", { friend: recipient.key });
    expect(afterRequests.text).toBe(beforeRequests.text);
    expect(afterFriends.text).toBe(beforeFriends.text);
    expect(afterRequests.text).not.toContain(quietSender.ownerId);
    expect(afterFriends.text).not.toContain(quietSender.ownerId);

    const senderList = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    expect(senderList.json.outgoing).toEqual([{ ownerId: recipient.ownerId }]);
    const senderFriends = await viaEntry("/v1/friends/list", { friend: quietSender.key });
    expect(senderFriends.json).toEqual({ friends: [] });
  });

  it("note grants no accept, rounds, or friend-list access", async () => {
    const recipient = await mint("nope-recipient");
    const quietSender = await mint("nope-quiet");
    const kept = await mint("nope-kept");
    await befriend(kept, recipient);
    await befriend(quietSender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });
    expect((await send(quietSender, recipient)).json.status).toBe("pending");
    const note = noteKey(quietSender, recipient);
    expect(kv.get(note).value).toBe("pending");

    const published = await viaEntry("/v1/friends/rounds", {
      method: "PUT",
      friend: recipient.key,
      body: { share: true, round: roundBody("round_recipient") },
    });
    expect(published.status).toBe(200);
    const senderRound = await viaEntry("/v1/friends/rounds", {
      method: "PUT",
      friend: quietSender.key,
      body: { share: true, round: roundBody("round_sender") },
    });
    expect(senderRound.status).toBe(200);

    const senderRounds = await viaEntry("/v1/friends/rounds", { friend: quietSender.key });
    const recipientRounds = await viaEntry("/v1/friends/rounds", { friend: recipient.key });
    const keptRounds = await viaEntry("/v1/friends/rounds", { friend: kept.key });
    expect(senderRounds.json.rounds.map((round) => round.id)).toEqual(["round_sender"]);
    expect(recipientRounds.json.rounds.map((round) => round.id)).toEqual(["round_recipient"]);
    expect(keptRounds.json.rounds.map((round) => round.id)).toContain("round_recipient");
    expect(senderRounds.text).not.toContain("round_recipient");
    expect(recipientRounds.text).not.toContain("round_sender");

    const watched = watchKv();
    const recipientAccept = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    });
    const senderAccept = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: quietSender.key,
      body: { ownerId: recipient.ownerId },
    });
    const senderFriends = await viaEntry("/v1/friends/list", { friend: quietSender.key });
    const recipientFriends = await viaEntry("/v1/friends/list", { friend: recipient.key });
    const senderFetch = await viaEntry("/v1/friends/rounds", { friend: quietSender.key });
    const blockerList = await viaEntry("/v1/friends/requests", { friend: recipient.key });
    watched.restore();

    expect(recipientAccept.status).toBe(409);
    expect(recipientAccept.json).toEqual({ error: "blocked" });
    expect(senderAccept.status).toBe(409);
    expect(senderAccept.json).toEqual({ error: "not_friends" });
    expect(senderFriends.json.friends).toEqual([]);
    expect(ownerIds(recipientFriends.json.friends)).toEqual([kept.ownerId]);
    expect(blockerList.json.incoming).toEqual([]);
    expect(kv.has(`fr:friend:${recipient.ownerId}:${quietSender.ownerId}`)).toBe(false);
    expect(kv.has(`fr:friend:${quietSender.ownerId}:${recipient.ownerId}`)).toBe(false);
    expect(kv.get(note).value).toBe("pending");
    expect(kv.has(reqKey(recipient, quietSender))).toBe(false);
    expect(watched.seen.get).not.toContain(note);
    expect(watched.seen.list.map((options) => options && options.prefix)).not.toContain(`fr:out:${quietSender.ownerId}:`);
    expect(senderFetch.text).not.toContain("round_recipient");

    const senderList = watchKv();
    const listed = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    senderList.restore();
    expect(listed.json.outgoing).toEqual([{ ownerId: recipient.ownerId }]);
    expect(senderList.seen.get).toContain(note);
  });

  it("quiet send shares the code-guess cap and rate limit with a real send", async () => {
    const quiet = await mint("cap-quiet");
    const real = await mint("cap-real");
    const quietTargets = [];
    for (let i = 0; i < FRIEND_CODE_GUESS_LIMIT; i += 1) {
      const target = await mint(`cap-q${i}`);
      kv.set(`fr:block:${target.ownerId}:${quiet.ownerId}`, { value: "1" });
      quietTargets.push(target);
    }
    const realTargets = [];
    for (let i = 0; i < FRIEND_CODE_GUESS_LIMIT; i += 1) {
      realTargets.push(await mint(`cap-r${i}`));
    }

    for (let i = 0; i < FRIEND_CODE_GUESS_LIMIT; i += 1) {
      const quietSent = await send(quiet, quietTargets[i]);
      const realSent = await send(real, realTargets[i]);
      expect(quietSent.status).toBe(200);
      expect(realSent.status).toBe(200);
      expect(quietSent.text).toBe(`{"status":"pending","ownerId":"${quietTargets[i].ownerId}"}`);
      expect(realSent.text).toBe(`{"status":"pending","ownerId":"${realTargets[i].ownerId}"}`);
      expect(kv.get(noteKey(quiet, quietTargets[i])).value).toBe("pending");
      expect(kv.get(reqKey(realTargets[i], real)).value).toBe("pending");
      expect(kv.has(reqKey(quietTargets[i], quiet))).toBe(false);
    }
    const quietList = await viaEntry("/v1/friends/requests", { friend: quiet.key });
    const realList = await viaEntry("/v1/friends/requests", { friend: real.key });
    expect(quietList.json.outgoing).toHaveLength(FRIEND_CODE_GUESS_LIMIT);
    expect(realList.json.outgoing).toHaveLength(FRIEND_CODE_GUESS_LIMIT);
    expect(ownerIds(quietList.json.outgoing)).toEqual(
      quietTargets.map((target) => target.ownerId).sort(),
    );

    const quietNinth = await mint("cap-q9");
    const realNinth = await mint("cap-r9");
    kv.set(`fr:block:${quietNinth.ownerId}:${quiet.ownerId}`, { value: "1" });
    let quietCodeReads = 0;
    const boards = env.BOARDS;
    env.BOARDS = {
      ...boards,
      async get(key) {
        if (String(key).startsWith("fr:code:")) quietCodeReads += 1;
        return boards.get(key);
      },
    };
    const quietOver = await send(quiet, quietNinth);
    env.BOARDS = boards;
    const realOver = await send(real, realNinth);
    expect(quietOver.status).toBe(realOver.status);
    expect(quietOver.status).toBe(429);
    expect(quietOver.json).toEqual(realOver.json);
    expect(quietOver.json).toEqual({ error: "rate_limited" });
    const quietRetry = Number(quietOver.headers.get("Retry-After"));
    const realRetry = Number(realOver.headers.get("Retry-After"));
    expect(quietRetry).toBeGreaterThan(0);
    expect(Math.abs(quietRetry - realRetry)).toBeLessThanOrEqual(2);
    expect(kv.has(noteKey(quiet, quietNinth))).toBe(false);
    expect(kv.has(reqKey(realNinth, real))).toBe(false);
    expect(quietCodeReads).toBe(0);

    const mixed = await mint("cap-mixed");
    for (let i = 0; i < FRIEND_CODE_GUESS_LIMIT - 1; i += 1) {
      const target = await mint(`cap-m${i}`);
      expect((await send(mixed, target)).status).toBe(200);
    }
    const mixedBlocked = await mint("cap-mblock");
    kv.set(`fr:block:${mixedBlocked.ownerId}:${mixed.ownerId}`, { value: "1" });
    const eighth = await send(mixed, mixedBlocked);
    expect(eighth.status).toBe(200);
    expect(kv.get(noteKey(mixed, mixedBlocked)).value).toBe("pending");
    const mixedNext = await mint("cap-mnext");
    const ninth = await send(mixed, mixedNext);
    expect(ninth.status).toBe(429);
    expect(ninth.json).toEqual({ error: "rate_limited" });
    expect(kv.has(reqKey(mixedNext, mixed))).toBe(false);

    const full = await mint("cap-full");
    const blockedFull = await mint("cap-full-b");
    kv.set(`fr:friends:${full.ownerId}`, {
      value: JSON.stringify(Array.from({ length: FRIEND_CAP }, (_, index) => `F${String(index).padStart(21, "0")}`)),
    });
    kv.set(`fr:rounds:${full.ownerId}`, {
      value: JSON.stringify(Array.from({ length: ROUND_CAP }, (_, index) => ({ id: `r${index}` }))),
    });
    kv.set(`fr:block:${blockedFull.ownerId}:${full.ownerId}`, { value: "1" });
    const atCaps = await send(full, blockedFull);
    expect(atCaps.status).toBe(200);
    expect(atCaps.json).toEqual({ status: "pending", ownerId: blockedFull.ownerId });
    expect(kv.get(noteKey(full, blockedFull)).value).toBe("pending");
    const open = await mint("cap-open");
    const realAtCaps = await send(full, open);
    expect(realAtCaps.status).toBe(200);
    expect(kv.get(reqKey(open, full)).value).toBe("pending");

    const ip = "203.0.113.91";
    for (let i = 0; i < FRIEND_IP_GUESS_LIMIT - 1; i += 1) {
      const looker = await mint(`ipq${i}`);
      const miss = await viaEntry("/v1/friends/codes/lookup", {
        method: "POST",
        friend: looker.key,
        ip,
        body: { code: "NNNNNNNN" },
      });
      expect(miss.status).toBe(404);
    }
    const ipQuiet = await mint("ipq-quiet");
    const ipTarget = await mint("ipq-target");
    kv.set(`fr:block:${ipTarget.ownerId}:${ipQuiet.ownerId}`, { value: "1" });
    const ipSent = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: ipQuiet.key,
      ip,
      body: { code: ipTarget.code },
    });
    expect(ipSent.status).toBe(200);
    expect(kv.get(noteKey(ipQuiet, ipTarget)).value).toBe("pending");
    const ipReal = await mint("ipq-real");
    const ipOther = await mint("ipq-other");
    const ipOver = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: ipReal.key,
      ip,
      body: { code: ipOther.code },
    });
    expect(ipOver.status).toBe(429);
    expect(ipOver.json).toEqual({ error: "rate_limited" });
    expect(kv.has(reqKey(ipOther, ipReal))).toBe(false);

    const otherIp = "203.0.113.92";
    for (let i = 0; i < FRIEND_IP_GUESS_LIMIT - 1; i += 1) {
      const looker = await mint(`ipr${i}`);
      expect((await viaEntry("/v1/friends/codes/lookup", {
        method: "POST",
        friend: looker.key,
        ip: otherIp,
        body: { code: "PPPPPPPP" },
      })).status).toBe(404);
    }
    const otherReal = await mint("ipr-real");
    const otherTo = await mint("ipr-to");
    expect((await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: otherReal.key,
      ip: otherIp,
      body: { code: otherTo.code },
    })).status).toBe(200);
    const otherQuiet = await mint("ipr-quiet");
    const otherBlocked = await mint("ipr-blocked");
    kv.set(`fr:block:${otherBlocked.ownerId}:${otherQuiet.ownerId}`, { value: "1" });
    const otherOver = await viaEntry("/v1/friends/requests", {
      method: "POST",
      friend: otherQuiet.key,
      ip: otherIp,
      body: { code: otherBlocked.code },
    });
    expect(otherOver.status).toBe(429);
    expect(otherOver.json).toEqual(ipOver.json);
    expect(kv.has(noteKey(otherQuiet, otherBlocked))).toBe(false);
  });

  it("note has no TTL and is not removed by decline, reset, unblock, or remove", async () => {
    const recipient = await mint("life-recipient");
    const quietSender = await mint("life-quiet");
    const realFrom = await mint("life-from");
    const realTo = await mint("life-to");
    await befriend(quietSender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });

    const puts = [];
    const boards = env.BOARDS;
    env.BOARDS = {
      ...boards,
      async put(key, value, options) {
        puts.push({ key, value, expirationTtl: options && options.expirationTtl });
        return boards.put(key, value, options);
      },
    };
    const quiet = await send(quietSender, recipient);
    const real = await send(realFrom, realTo);
    env.BOARDS = boards;
    expect(quiet.text).toBe(`{"status":"pending","ownerId":"${recipient.ownerId}"}`);
    expect(real.text).toBe(`{"status":"pending","ownerId":"${realTo.ownerId}"}`);
    const quietPut = puts.find((item) => item.key === noteKey(quietSender, recipient));
    const realPut = puts.find((item) => item.key === reqKey(realTo, realFrom));
    expect(quietPut).toEqual({ key: noteKey(quietSender, recipient), value: "pending", expirationTtl: undefined });
    expect(realPut).toEqual({ key: reqKey(realTo, realFrom), value: "pending", expirationTtl: undefined });
    expect(kv.get(noteKey(quietSender, recipient)).expirationTtl).toBe(kv.get(reqKey(realTo, realFrom)).expirationTtl);

    const before = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    const realBefore = await viaEntry("/v1/friends/requests", { friend: realFrom.key });
    const declined = await viaEntry("/v1/friends/decline", {
      method: "POST",
      friend: quietSender.key,
      body: { ownerId: recipient.ownerId },
    });
    const realDeclined = await viaEntry("/v1/friends/decline", {
      method: "POST",
      friend: realFrom.key,
      body: { ownerId: realTo.ownerId },
    });
    expect(declined.status).toBe(404);
    expect(declined.json).toEqual({ error: "unknown_route" });
    expect(realDeclined.status).toBe(404);
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.get(reqKey(realTo, realFrom)).value).toBe("pending");

    const reset = await viaEntry("/v1/friends/code/reset", { method: "POST", friend: quietSender.key, body: {} });
    const realReset = await viaEntry("/v1/friends/code/reset", { method: "POST", friend: realFrom.key, body: {} });
    expect(reset.status).toBe(200);
    expect(realReset.status).toBe(200);
    quietSender.code = reset.json.code;
    realFrom.code = realReset.json.code;
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.get(reqKey(realTo, realFrom)).value).toBe("pending");

    const removed = await viaEntry("/v1/friends/remove", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    });
    const realRemoved = await viaEntry("/v1/friends/remove", {
      method: "POST",
      friend: realTo.key,
      body: { ownerId: realFrom.ownerId },
    });
    expect(removed.status).toBe(409);
    expect(removed.json).toEqual({ error: "not_friends" });
    expect(realRemoved.status).toBe(409);
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.get(reqKey(realTo, realFrom)).value).toBe("pending");

    const senderBlock = await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: quietSender.key,
      body: { ownerId: recipient.ownerId },
    });
    const realBlock = await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: realFrom.key,
      body: { ownerId: realTo.ownerId },
    });
    expect(senderBlock.status).toBe(409);
    expect(realBlock.status).toBe(409);
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.get(reqKey(realTo, realFrom)).value).toBe("pending");

    const cleared = await viaEntry("/v1/friends/unblock", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    });
    const realUnblock = await viaEntry("/v1/friends/unblock", {
      method: "POST",
      friend: realTo.key,
      body: { ownerId: realFrom.ownerId },
    });
    expect(cleared.json).toEqual({ ok: true });
    expect(realUnblock.json).toEqual({ ok: true });
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.has(reqKey(recipient, quietSender))).toBe(false);
    expect(kv.get(reqKey(realTo, realFrom)).value).toBe("pending");
    const after = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    const realAfter = await viaEntry("/v1/friends/requests", { friend: realFrom.key });
    expect(after.text).toBe(before.text);
    expect(realAfter.text).toBe(realBefore.text);
  });

  it("unblock does not make the note acceptable and a fresh send does", async () => {
    const recipient = await mint("fresh-recipient");
    const quietSender = await mint("fresh-quiet");
    const control = await mint("fresh-control");
    await befriend(quietSender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });
    const quiet = await send(quietSender, recipient);
    expect(quiet.text).toBe(`{"status":"pending","ownerId":"${recipient.ownerId}"}`);
    const listed = await viaEntry("/v1/friends/requests", { friend: quietSender.key });

    expect((await viaEntry("/v1/friends/unblock", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });
    expect(kv.has(`fr:block:${recipient.ownerId}:${quietSender.ownerId}`)).toBe(false);
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.has(reqKey(recipient, quietSender))).toBe(false);
    const still = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    expect(still.text).toBe(listed.text);

    const early = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    });
    expect(early.status).toBe(409);
    expect(early.json).toEqual({ error: "not_friends" });
    expect(kv.get(noteKey(quietSender, recipient)).value).toBe("pending");
    expect(kv.has(`fr:friend:${recipient.ownerId}:${quietSender.ownerId}`)).toBe(false);
    expect((await viaEntry("/v1/friends/requests", { friend: quietSender.key })).text).toBe(listed.text);

    const controlSend = await send(control, recipient);
    const fresh = await send(quietSender, recipient);
    expect(fresh.status).toBe(200);
    expect(fresh.text).toBe(controlSend.text);
    expect(fresh.text).toBe(quiet.text);
    expect(kv.has(noteKey(quietSender, recipient))).toBe(false);
    expect(kv.get(reqKey(recipient, quietSender)).value).toBe("pending");
    const afterFresh = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    expect(afterFresh.text).toBe(listed.text);
    expect(afterFresh.json.outgoing).toEqual([{ ownerId: recipient.ownerId }]);

    const accepted = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ status: "friends", ownerId: quietSender.ownerId });
    expect(kv.has(noteKey(quietSender, recipient))).toBe(false);
    expect(kv.has(reqKey(recipient, quietSender))).toBe(false);
    expect(kv.has(`fr:friend:${recipient.ownerId}:${quietSender.ownerId}`)).toBe(true);
    const done = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    expect(done.json.outgoing).toEqual([]);
    const friends = await viaEntry("/v1/friends/list", { friend: quietSender.key });
    expect(friends.json.friends).toEqual([{ ownerId: recipient.ownerId }]);
  });

  it("responses do not contain raw KV keys", async () => {
    const recipient = await mint("leak-recipient");
    const quietSender = await mint("leak-quiet");
    await befriend(quietSender, recipient);
    expect((await viaEntry("/v1/friends/block", {
      method: "POST",
      friend: recipient.key,
      body: { ownerId: quietSender.ownerId },
    })).json).toEqual({ ok: true });
    kv.set(noteKey(quietSender, recipient), { value: `pending ${quietSender.key} fr:k:secret` });
    const quiet = await send(quietSender, recipient);
    const listed = await viaEntry("/v1/friends/requests", { friend: quietSender.key });
    const friends = await viaEntry("/v1/friends/list", { friend: quietSender.key });
    const rounds = await viaEntry("/v1/friends/rounds", { friend: quietSender.key });
    const accept = await viaEntry("/v1/friends/requests/accept", {
      method: "POST",
      friend: quietSender.key,
      body: { ownerId: recipient.ownerId },
    });
    for (const result of [quiet, listed, friends, rounds, accept]) {
      expect(result.text).not.toContain("fr:");
      expect(result.text).not.toContain(noteKey(quietSender, recipient));
      expect(result.text).not.toContain(quietSender.key);
      expect(result.text).not.toContain(recipient.key);
      expect(result.text).not.toContain(quietSender.code);
      expect(result.text).not.toContain(recipient.code);
      expect(result.text).not.toContain("secret");
    }
    for (const result of [listed, friends, rounds, accept]) {
      expect(result.text).not.toContain("pending");
    }
    expect(listed.json).toEqual({ incoming: [], outgoing: [{ ownerId: recipient.ownerId }] });
    expect(quiet.json).toEqual({ status: "pending", ownerId: recipient.ownerId });
  });

  it("outgoing notes sort with real requests by ownerId", async () => {
    const caller = await mint("sort-note");
    const low = "a".repeat(22);
    const mid = "m".repeat(22);
    const high = "z".repeat(22);
    kv.set(`fr:req:${high}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${low}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:${mid}`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:not-an-owner`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:out:${"b".repeat(22)}:${mid}`, { value: "pending" });
    const boards = env.BOARDS;
    env.BOARDS = {
      ...boards,
      async list(options) {
        const page = await boards.list(options);
        return { ...page, keys: [...page.keys].reverse() };
      },
    };
    const listed = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(ownerIds(listed.json.outgoing)).toEqual([low, mid, high]);
    expect(listed.text).not.toContain("not-an-owner");
    expect(listed.text).not.toContain("fr:");
  });

  it("blocked send uses 5 gets and 1 put and a repeat does not put again", async () => {
    const recipient = await mint("ops-recipient");
    const quietSender = await mint("ops-quiet");
    kv.set(`fr:block:${recipient.ownerId}:${quietSender.ownerId}`, { value: "1" });
    const first = watchKv();
    const sent = await send(quietSender, recipient);
    first.restore();
    expect(sent.json).toEqual({ status: "pending", ownerId: recipient.ownerId });
    expect(first.seen.get).toHaveLength(5);
    expect(first.seen.put).toHaveLength(1);
    expect(first.seen.put[0].key).toBe(noteKey(quietSender, recipient));
    expect(first.seen.put[0].value).toBe("pending");
    expect(first.seen.put[0].options).toBeUndefined();
    expect(first.seen.delete).toEqual([]);
    expect(first.seen.list).toEqual([]);
    expect(first.seen.get.some((key) => key.startsWith("fr:req:"))).toBe(false);
    expect(first.seen.get.some((key) => key.startsWith("fr:friend"))).toBe(false);
    expect(first.seen.get.some((key) => key.startsWith("fr:rounds:"))).toBe(false);

    const second = watchKv();
    const again = await send(quietSender, recipient);
    second.restore();
    expect(again.text).toBe(sent.text);
    expect(second.seen.get).toHaveLength(5);
    expect(second.seen.put).toEqual([]);
    expect(second.seen.delete).toEqual([]);
    expect(second.seen.list).toEqual([]);
  });

  it("requests read counts fr:req pages and the caller's note pages", async () => {
    const caller = await mint("ops-read");
    const incoming = "d".repeat(22);
    const outgoing = "e".repeat(22);
    const noted = "h".repeat(22);
    const emptyNote = "j".repeat(22);
    const strangerA = "f".repeat(22);
    const strangerB = "g".repeat(22);
    kv.set(`fr:req:${caller.ownerId}:${incoming}`, { value: "pending" });
    kv.set(`fr:req:${outgoing}:${caller.ownerId}`, { value: "pending" });
    kv.set(`fr:req:${strangerA}:${strangerB}`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:${noted}`, { value: "pending" });
    kv.set(`fr:out:${caller.ownerId}:${emptyNote}`, { value: "" });
    kv.set(`fr:out:${caller.ownerId}:bad`, { value: "pending" });
    kv.set(`fr:out:${strangerA}:${noted}`, { value: "pending" });
    const counts = watchKv();
    const listed = await viaEntry("/v1/friends/requests", { friend: caller.key });
    counts.restore();
    expect(listed.json).toEqual({
      incoming: [{ ownerId: incoming }],
      outgoing: [{ ownerId: noted }, { ownerId: outgoing }].sort((left, right) => (left.ownerId < right.ownerId ? -1 : 1)),
    });
    // + one fr:ownname: read per returned entry (1 incoming, 2 outgoing).
    expect(counts.seen.get).toHaveLength(1 + 1 + 1 + 1 + 2 + 3);
    expect(counts.seen.get).not.toContain(`fr:out:${caller.ownerId}:bad`);
    expect(counts.seen.get).not.toContain(`fr:out:${strangerA}:${noted}`);
    expect(counts.seen.get).toContain(`fr:out:${caller.ownerId}:${emptyNote}`);
    expect(counts.seen.put).toEqual([]);
    expect(counts.seen.delete).toEqual([]);
    expect(counts.seen.list).toHaveLength(2);
    expect(counts.seen.list.map((options) => options.prefix).sort()).toEqual([
      "fr:req:",
      `fr:out:${caller.ownerId}:`,
    ].sort());

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
    const paged = await viaEntry("/v1/friends/requests", { friend: caller.key });
    expect(ownerIds(paged.json.outgoing)).toEqual([emptyNote, noted, outgoing].filter((id) => id !== emptyNote).sort());
    expect(ownerIds(paged.json.outgoing)).toEqual([noted, outgoing].sort());
    expect(lists).toBe(3 + 3);
  });

  it("reserves fr:out on board paths", async () => {
    const raw = `/fr:out:${"a".repeat(22)}:${"b".repeat(22)}`;
    const encoded = `/${encodeURIComponent(`fr:out:${"c".repeat(22)}:${"d".repeat(22)}`)}`;
    const watched = watchKv();
    for (const path of [raw, encoded]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await viaEntry(path, { method, body: method === "PUT" ? { forged: true } : undefined });
        expect(response.status, `${method} ${path}`).toBe(400);
        expect(response.text, `${method} ${path}`).toBe("bad key");
      }
    }
    watched.restore();
    expect(watched.seen).toEqual({ get: [], put: [], delete: [], list: [] });
  });

  it("documents the quiet-block write path", () => {
    const contract = readFileSync(new URL("./docs/friends-api.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
    expect(contract).toContain("`fr:out:<sender>:<recipient>` = `pending`");
    expect(contract).toContain("5 gets and 1 put");
    expect(contract).toContain("`1 + I + B + O + Q` gets and `P + S` lists");
    expect(contract).toContain("No `expirationTtl`");
    expect(contract).toContain("Unblock does not delete the note and does not copy it to `fr:req:`");
    expect(contract).toContain("A fresh `sendRequest` is required");
    expect(contract).toContain("No new cap was added");
    expect(readme).toContain("`fr:out:<sender>:<recipient>` = `pending`");
    expect(readme).toContain("A fresh send after unblock replaces it with `fr:req:`");
  });
});
