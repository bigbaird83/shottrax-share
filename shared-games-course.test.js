// Optional courseId / courseName on shared-game create and invite, for every
// format, so the invitee's Home can fill the course after they tap Join.
// Made-up ids only. Not deployed.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry, { FriendGuessLimiter, SharedGame } from "./entry.js";
import { friendKvKey } from "./friends.js";
import { COURSE_ID_MAX, COURSE_NAME_MAX, SHARED_FORMATS, WAGER_KEYS } from "./shared-games.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";

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
        return { toArray: () => rows };
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
    db,
    blockConcurrencyWhile(fn) {
      ready = ready.then(() => fn());
      return ready;
    },
  };
}

function namespace(Klass) {
  const objects = new Map();
  return {
    idFromName(name) {
      return { name };
    },
    get(id) {
      let obj = objects.get(id.name);
      if (!obj) {
        obj = new Klass(sqliteState(id.name), {});
        objects.set(id.name, obj);
      }
      return {
        fetch(input, init) {
          return obj.fetch(input instanceof Request ? input : new Request(input, init));
        },
      };
    },
  };
}

function key(n) {
  return `k${String(n).padStart(3, "0")}${"b".repeat(40)}`;
}

function assertNoWager(value) {
  const text = JSON.stringify(value);
  for (const name of WAGER_KEYS) expect(text).not.toContain(`"${name}"`);
}

describe("shared game course fields", () => {
  let kv;
  let env;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    kv = new Map();
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    env = {
      BOARDS: {
        async get(k) {
          return kv.has(k) ? kv.get(k) : null;
        },
        async put(k, v) {
          kv.set(k, v);
        },
        async delete(k) {
          kv.delete(k);
        },
        async list({ prefix = "" } = {}) {
          return {
            keys: [...kv.keys()].filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name })),
            list_complete: true,
          };
        },
      },
      FRIEND_GUESSES: namespace(FriendGuessLimiter),
      SHARED_GAMES: namespace(SharedGame),
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function call(pathname, { method = "POST", body, friend } = {}) {
    const headers = {};
    if (friend) headers["X-Friend-Key"] = friend;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await entry.fetch(
      new Request(`${ORIGIN}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {} },
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  async function player(n) {
    const friend = key(n);
    const res = await call("/v1/friends/code", { friend });
    expect(res.status).toBe(200);
    return { friend, ownerId: res.json.ownerId };
  }

  function befriend(a, b) {
    kv.set(friendKvKey("friend", `${a.ownerId}:${b.ownerId}`), "1");
    kv.set(friendKvKey("friend", `${b.ownerId}:${a.ownerId}`), "1");
  }

  function person(playerId, team = 1, extra = {}) {
    return { playerId, installId: `id_${playerId.slice(-6)}`, guest: false, team, ...extra };
  }

  function gameBody(host, extra = {}) {
    const format = extra.format ?? "strokePlay";
    const hostPlayer = person(host.ownerId, format === "wolf" ? null : 1);
    const others = extra.players ?? [];
    const players = [hostPlayer, ...others];
    const teams =
      format === "wolf"
        ? []
        : [{ number: 1, name: "Team 1", memberIds: players.filter((row) => row.team === 1).map((row) => row.playerId) }];
    const { players: _ignored, ...rest } = extra;
    return { gameId: extra.gameId ?? "g1", format, scoring: "gross", teams, players, ...rest };
  }

  const PUSH = { title: "Alex R invited you to a shared scorecard" };
  const COURSE = { courseId: "pine-hollow-12", courseName: "Pine Hollow" };

  it("creates a game with a course and returns the fields on create and GET", async () => {
    const host = await player(1);
    const made = await call("/v1/shared-games", { friend: host.friend, body: gameBody(host, COURSE) });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json.game.courseId).toBe(COURSE.courseId);
    expect(made.json.game.courseName).toBe(COURSE.courseName);
    assertNoWager(made.json);

    const read = await call("/v1/shared-games/g1", { method: "GET", friend: host.friend });
    expect(read.status).toBe(200);
    expect(read.json.game.courseId).toBe(COURSE.courseId);
    expect(read.json.game.courseName).toBe(COURSE.courseName);
  });

  it("create without a course keeps the old shape: course fields are omitted", async () => {
    const host = await player(1);
    const made = await call("/v1/shared-games", { friend: host.friend, body: gameBody(host) });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json.game).not.toHaveProperty("courseId");
    expect(made.json.game).not.toHaveProperty("courseName");

    const read = await call("/v1/shared-games/g1", { method: "GET", friend: host.friend });
    expect(read.status).toBe(200);
    expect(read.json.game).not.toHaveProperty("courseId");
    expect(read.json.game).not.toHaveProperty("courseName");
  });

  it("empty or whitespace course fields are treated as absent", async () => {
    const host = await player(1);
    const made = await call("/v1/shared-games", {
      friend: host.friend,
      body: gameBody(host, { courseId: "   ", courseName: "" }),
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json.game).not.toHaveProperty("courseId");
    expect(made.json.game).not.toHaveProperty("courseName");
  });

  it("trims courseId and courseName", async () => {
    const host = await player(1);
    const made = await call("/v1/shared-games", {
      friend: host.friend,
      body: gameBody(host, { courseId: "  pine-hollow-12  ", courseName: "  Pine Hollow  " }),
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json.game.courseId).toBe("pine-hollow-12");
    expect(made.json.game.courseName).toBe("Pine Hollow");
  });

  it("a non-string, over-long, or control-character course field is 400 invalid_body", async () => {
    const host = await player(1);
    const invalid = [
      { courseId: 12 },
      { courseName: true },
      { courseId: { id: "x" } },
      { courseName: ["Pine"] },
      { courseId: "x".repeat(COURSE_ID_MAX + 1) },
      { courseName: "y".repeat(COURSE_NAME_MAX + 1) },
      { courseId: "good", courseName: "Bad\nName" },
      { courseId: "id\u0001", courseName: "Pine Hollow" },
    ];
    for (const extra of invalid) {
      const res = await call("/v1/shared-games", { friend: host.friend, body: gameBody(host, extra) });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    }
    expect((await call("/v1/shared-games/g1", { method: "GET", friend: host.friend })).status).toBe(404);
  });

  it("max-length course fields are accepted", async () => {
    const host = await player(1);
    const courseId = "i".repeat(COURSE_ID_MAX);
    const courseName = "n".repeat(COURSE_NAME_MAX);
    const made = await call("/v1/shared-games", { friend: host.friend, body: gameBody(host, { courseId, courseName }) });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json.game.courseId).toBe(courseId);
    expect(made.json.game.courseName).toBe(courseName);
  });

  it("either field may be sent alone", async () => {
    const host = await player(1);
    const onlyId = await call("/v1/shared-games", {
      friend: host.friend,
      body: gameBody(host, { gameId: "only-id", courseId: "pine-hollow-12" }),
    });
    expect(onlyId.status).toBe(200);
    expect(onlyId.json.game.courseId).toBe("pine-hollow-12");
    expect(onlyId.json.game).not.toHaveProperty("courseName");

    const onlyName = await call("/v1/shared-games", {
      friend: host.friend,
      body: gameBody(host, { gameId: "only-name", courseName: "Pine Hollow" }),
    });
    expect(onlyName.status).toBe(200);
    expect(onlyName.json.game).not.toHaveProperty("courseId");
    expect(onlyName.json.game.courseName).toBe("Pine Hollow");
  });

  it("create with a course, invite without: the invites list still returns the fields", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    expect((await call("/v1/shared-games", { friend: host.friend, body: gameBody(host, COURSE) })).status).toBe(200);
    expect(
      (
        await call("/v1/shared-games/g1/invites", {
          friend: host.friend,
          body: { invitees: [{ playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2 }], push: PUSH },
        })
      ).status,
    ).toBe(200);

    const list = await call("/v1/shared-games/invites", { method: "GET", friend: jordan.friend });
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.invites).toHaveLength(1);
    expect(list.json.invites[0]).toMatchObject({
      gameId: "g1",
      format: "strokePlay",
      course: null,
      courseId: COURSE.courseId,
      courseName: COURSE.courseName,
    });
  });

  it("create without a course, invite with one: the list and later GET return the fields", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    expect((await call("/v1/shared-games", { friend: host.friend, body: gameBody(host) })).status).toBe(200);
    const invited = await call("/v1/shared-games/g1/invites", {
      friend: host.friend,
      body: {
        invitees: [{ playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2 }],
        push: PUSH,
        ...COURSE,
      },
    });
    expect(invited.status, JSON.stringify(invited.json)).toBe(200);
    expect(invited.json).toEqual({ invites: [{ playerId: jordan.ownerId, status: "sent" }] });

    const list = await call("/v1/shared-games/invites", { method: "GET", friend: jordan.friend });
    expect(list.json.invites[0]).toMatchObject({
      gameId: "g1",
      courseId: COURSE.courseId,
      courseName: COURSE.courseName,
    });

    const joined = await call(`/v1/shared-games/g1/join`, {
      friend: jordan.friend,
      body: { playerId: jordan.ownerId, joinedHole: null },
    });
    expect(joined.status).toBe(200);
    expect(joined.json.game.courseId).toBe(COURSE.courseId);
    expect(joined.json.game.courseName).toBe(COURSE.courseName);
  });

  it("an invite with a bad course field is 400 and does not store an invite", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    expect((await call("/v1/shared-games", { friend: host.friend, body: gameBody(host) })).status).toBe(200);
    for (const extra of [{ courseId: 1 }, { courseName: {} }, { courseName: "x".repeat(COURSE_NAME_MAX + 1) }]) {
      const res = await call("/v1/shared-games/g1/invites", {
        friend: host.friend,
        body: {
          invitees: [{ playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2 }],
          push: PUSH,
          ...extra,
        },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    }
    expect((await call("/v1/shared-games/invites", { method: "GET", friend: jordan.friend })).json).toEqual({
      invites: [],
    });
  });

  it("a later invite does not overwrite a course already stored on the game", async () => {
    const host = await player(1);
    const jordan = await player(2);
    befriend(host, jordan);
    expect((await call("/v1/shared-games", { friend: host.friend, body: gameBody(host, COURSE) })).status).toBe(200);
    expect(
      (
        await call("/v1/shared-games/g1/invites", {
          friend: host.friend,
          body: {
            invitees: [{ playerId: jordan.ownerId, friendId: jordan.ownerId, team: 2 }],
            push: PUSH,
            courseId: "other-id",
            courseName: "Other Course",
          },
        })
      ).status,
    ).toBe(200);
    const read = await call("/v1/shared-games/g1", { method: "GET", friend: host.friend });
    expect(read.json.game.courseId).toBe(COURSE.courseId);
    expect(read.json.game.courseName).toBe(COURSE.courseName);
    const list = await call("/v1/shared-games/invites", { method: "GET", friend: jordan.friend });
    expect(list.json.invites[0].courseId).toBe(COURSE.courseId);
    expect(list.json.invites[0].courseName).toBe(COURSE.courseName);
  });

  it("create with a course works for every format", async () => {
    const host = await player(1);
    const extras = await Promise.all([2, 3, 4].map((n) => player(n)));
    for (const format of SHARED_FORMATS) {
      const gameId = `fmt-${format}`;
      const players =
        format === "wolf"
          ? extras.map((p) => person(p.ownerId, null, { guest: true, installId: null }))
          : [];
      const body = gameBody(host, { gameId, format, players, ...COURSE });
      if (format === "wolf") {
        body.teams = [];
        body.players = [person(host.ownerId, null), ...players];
      }
      const made = await call("/v1/shared-games", { friend: host.friend, body });
      expect(made.status, `${format} ${JSON.stringify(made.json)}`).toBe(200);
      expect(made.json.game.format).toBe(format);
      expect(made.json.game.courseId).toBe(COURSE.courseId);
      expect(made.json.game.courseName).toBe(COURSE.courseName);
    }
  });

  it("adds nullable course columns to a game table created without them", async () => {
    const state = sqliteState("shared:old-course");
    state.db.exec(`
      CREATE TABLE game (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        game_id TEXT NOT NULL,
        organizer_id TEXT NOT NULL,
        format TEXT NOT NULL,
        scoring TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO game VALUES (1, 'oldg', 'org1', 'strokePlay', 'gross', '{}', 1);
      CREATE TABLE player (
        player_id TEXT PRIMARY KEY,
        install_id TEXT,
        guest INTEGER NOT NULL,
        team INTEGER,
        name TEXT
      );
      INSERT INTO player VALUES ('org1', 'org1', 0, 1, 'Host');
    `);
    const obj = new SharedGame(state, {});
    const read = await obj.fetch(
      new Request("https://shared-game.internal/game", {
        method: "POST",
        body: JSON.stringify({ op: "read", callerId: "org1" }),
      }),
    );
    const body = await read.json();
    expect(body.ok).toBe(true);
    expect(body.game.gameId).toBe("oldg");
    expect(body.game).not.toHaveProperty("courseId");
    expect(body.game).not.toHaveProperty("courseName");
    const cols = state.db.prepare("PRAGMA table_info(game)").all().map((row) => row.name);
    expect(cols).toContain("course_id");
    expect(cols).toContain("course_name");

    const invited = await obj.fetch(
      new Request("https://shared-game.internal/game", {
        method: "POST",
        body: JSON.stringify({
          op: "invite",
          callerId: "org1",
          now: 2,
          invitees: [],
          ...COURSE,
        }),
      }),
    );
    expect((await invited.json()).ok).toBe(true);
    const again = await obj.fetch(
      new Request("https://shared-game.internal/game", {
        method: "POST",
        body: JSON.stringify({ op: "read", callerId: "org1" }),
      }),
    );
    const stored = await again.json();
    expect(stored.game.courseId).toBe(COURSE.courseId);
    expect(stored.game.courseName).toBe(COURSE.courseName);
  });
});
