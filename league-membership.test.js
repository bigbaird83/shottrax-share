// Leagues W-B: no-app players (W6), rename (W7), the W1/W5 touch-ups, remove of a no-app spot,
// leave (W16), hand over and leave (W17) and the roster friend request (request-by-member).
// Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeagueRoster } from "./entry.js";
import { FRIEND_READ_KEY_LIMIT } from "./friends.js";
import { LEAGUE_MAX_PLAYERS } from "./leagues.js";
import { leagueWorld, roundBody, sqliteState } from "./league-test-harness.js";

const TOKEN = (n) => `ExponentPushToken[tok${n}]`;
const NOAPP_ID_RE = /^noapp_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{16}$/;
const APP_MEMBER_KEYS = ["joinedAt", "memberId", "name", "role"];
const NOAPP_MEMBER_KEYS = ["addedAt", "addedBy", "addedByName", "joinedAt", "kind", "memberId", "name", "role"];

let w;
beforeEach(() => {
  w = leagueWorld();
  w.install();
});
afterEach(() => {
  w.uninstall();
  vi.restoreAllMocks();
});

function addNoApp(p, leagueId, name) {
  return w.call("/v1/leagues/members/no-app", { friend: p.friend, body: { leagueId, name } });
}
function rename(p, memberId, name) {
  return w.call("/v1/leagues/members/rename", { friend: p.friend, body: { memberId, name } });
}
function members(p, leagueId) {
  return w.call(`/v1/leagues/members?league=${leagueId}`, { method: "GET", friend: p.friend });
}
function leave(p, leagueId, extra = {}) {
  return w.call("/v1/leagues/members/leave", { friend: p.friend, body: { leagueId, ...extra } });
}
function handover(p, leagueId, memberId, extra = {}) {
  return w.call("/v1/leagues/members/handover", { friend: p.friend, body: { leagueId, memberId, ...extra } });
}
function remove(p, leagueId, memberId) {
  return w.call("/v1/leagues/members/remove", { friend: p.friend, body: { leagueId, memberId } });
}
function standings(p, leagueId) {
  return w.call(`/v1/leagues/standings?league=${leagueId}`, { method: "GET", friend: p.friend });
}
function requestByMember(p, body) {
  return w.call("/v1/friends/request-by-member", { friend: p.friend, body });
}
function dumpRoster(leagueId) {
  const db = w.roster(leagueId).db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
}

/** A finished one-round league: players 1 and 2 played; returns the standings before. */
async function playedRound(setup) {
  const [a, b] = setup.people;
  const start = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, [a.ownerId, b.ownerId]) });
  expect(start.status).toBe(200);
  const roundId = start.json.round.roundId;
  await w.call("/v1/leagues/rounds/score", { friend: a.friend, body: { roundId, memberId: a.ownerId, hole: 1, strokes: 4, rev: 1 } });
  await w.call("/v1/leagues/rounds/score", { friend: b.friend, body: { roundId, memberId: b.ownerId, hole: 1, strokes: 5, rev: 1 } });
  const done = await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId } });
  expect(done.status).toBe(200);
  return roundId;
}

describe("W6 POST /v1/leagues/members/no-app", () => {
  it("any member adds a no-app player; the answer carries kind, addedBy, addedByName, addedAt", async () => {
    const setup = await w.league(2);
    const [, b] = setup.people;
    const res = await addNoApp(b, setup.league.id, "  Player   N ");
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["member"]);
    const m = res.json.member;
    expect(m.memberId).toMatch(NOAPP_ID_RE);
    expect(m.memberId.length).not.toBe(22);
    expect(m.memberId.slice(6, 28)).toBe(setup.league.id);
    expect(m).toMatchObject({ name: "Player N", role: "member", kind: "noApp", addedBy: b.ownerId, addedByName: "Player B" });
    expect(typeof m.addedAt).toBe("number");
    expect(m.joinedAt).toBe(m.addedAt);
    expect(Object.keys(m).sort()).toEqual(NOAPP_MEMBER_KEYS);
    const list = await members(b, setup.league.id);
    expect(list.json.league.players).toBe(3);
    // No KV row for a no-app player.
    expect([...w.kv.keys()].filter((k) => k.startsWith("lg:"))).toEqual([`lg:code:${setup.code}`]);
  });

  it("addedByName is the adder's current Friends name, falling back to their roster name", async () => {
    const setup = await w.league(2);
    const [, b] = setup.people;
    w.kv.set(`fr:ownname:${b.ownerId}`, "Player Bee");
    const res = await addNoApp(b, setup.league.id, "Player N");
    expect(res.json.member.addedByName).toBe("Player Bee");
    w.kv.delete(`fr:ownname:${b.ownerId}`);
    const list = await members(b, setup.league.id);
    expect(list.json.members.find((m) => m.kind === "noApp").addedByName).toBe("Player B");
  });

  it("no-app players count toward the 20: the 21st spot is 409 league_full", async () => {
    const setup = await w.league(2);
    const [a] = setup.people;
    for (let i = 0; i < LEAGUE_MAX_PLAYERS - 2; i += 1) {
      expect((await addNoApp(a, setup.league.id, `Player N${i}`)).status).toBe(200);
    }
    expect(await addNoApp(a, setup.league.id, "Player X")).toMatchObject({ status: 409, json: { error: "league_full" } });
    const n = w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM member").get().n;
    expect(n).toBe(LEAGUE_MAX_PLAYERS);
    // A full roster also refuses an app join.
    const late = await w.player(30);
    const join = await w.call("/v1/leagues/join", { friend: late.friend, body: { code: setup.code, name: "Player Z" } });
    expect(join).toMatchObject({ status: 409, json: { error: "league_full" } });
  });

  it("a blank or missing name is 400 name_required; a non-member is 403; bad bodies are 400", async () => {
    const setup = await w.league(2);
    const [a] = setup.people;
    for (const name of ["", "   ", null, 5, "x".repeat(40)]) {
      expect(await addNoApp(a, setup.league.id, name), String(name)).toMatchObject({ status: 400, json: { error: "name_required" } });
    }
    const outsider = await w.player(9);
    expect(await addNoApp(outsider, setup.league.id, "Player N")).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await w.call("/v1/leagues/members/no-app", { friend: a.friend, body: { leagueId: setup.league.id, name: "N", extra: 1 } })).toMatchObject({
      status: 400,
      json: { error: "invalid_body" },
    });
    expect(await addNoApp(a, "short", "Player N")).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await w.call("/v1/leagues/members/no-app", { body: { leagueId: setup.league.id, name: "N" } })).toMatchObject({
      status: 401,
      json: { error: "friend_key_required" },
    });
    expect(w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM member").get().n).toBe(2);
  });

  it("uses the league read bucket (keylgread:), so it is 429 after the read limit", async () => {
    const setup = await w.league(1);
    const [a] = setup.people;
    // league(1) used no league read calls.
    for (let i = 0; i < FRIEND_READ_KEY_LIMIT; i += 1) {
      const res = await addNoApp(a, setup.league.id, "");
      expect(res.status).toBe(400);
    }
    const res = await addNoApp(a, setup.league.id, "Player N");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("W7 POST /v1/leagues/members/rename", () => {
  async function withSpot() {
    const setup = await w.league(3);
    const [, b] = setup.people;
    const added = await addNoApp(b, setup.league.id, "Player N");
    return { ...setup, spot: added.json.member };
  }

  it("the adder renames a no-app player", async () => {
    const { people, spot, league } = await withSpot();
    const res = await rename(people[1], spot.memberId, "Player Nn");
    expect(res.status).toBe(200);
    expect(res.json.member).toMatchObject({ memberId: spot.memberId, name: "Player Nn", kind: "noApp", addedBy: people[1].ownerId });
    expect((await members(people[0], league.id)).json.members.find((m) => m.memberId === spot.memberId).name).toBe("Player Nn");
  });

  it("the organizer renames a no-app player", async () => {
    const { people, spot } = await withSpot();
    expect((await rename(people[0], spot.memberId, "Player O")).json.member.name).toBe("Player O");
  });

  it("another member is 403 forbidden; an app member is never renamed; blank is name_required; unknown is 404", async () => {
    const { people, spot, league } = await withSpot();
    expect(await rename(people[2], spot.memberId, "Player Q")).toMatchObject({ status: 403, json: { error: "forbidden" } });
    const outsider = await w.player(9);
    expect(await rename(outsider, spot.memberId, "Player Q")).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await rename(people[0], spot.memberId, "  ")).toMatchObject({ status: 400, json: { error: "name_required" } });
    expect(await rename(people[0], `noapp_${league.id}_${"z".repeat(16)}`, "Player Q")).toMatchObject({ status: 404, json: { error: "not_found" } });
    // An app member's id does not name a no-app spot.
    expect((await rename(people[0], people[1].ownerId, "Player Q")).status).toBe(404);
    expect(await w.call("/v1/leagues/members/rename", { friend: people[0].friend, body: { memberId: spot.memberId, name: "Q", leagueId: league.id } })).toMatchObject({
      status: 400,
      json: { error: "invalid_body" },
    });
    const row = (await members(people[0], league.id)).json.members.find((m) => m.memberId === spot.memberId);
    expect(row.name).toBe("Player N");
  });
});

describe("members list with no-app rows", () => {
  it("no-app rows carry kind/addedBy/addedByName/addedAt; app rows are unchanged", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const before = await members(a, setup.league.id);
    await addNoApp(a, setup.league.id, "Player N");
    const after = await members(a, setup.league.id);
    expect(after.json.members).toHaveLength(3);
    const app = after.json.members.filter((m) => m.kind === undefined);
    expect(app).toEqual(before.json.members);
    for (const m of app) expect(Object.keys(m).sort()).toEqual(APP_MEMBER_KEYS);
    const spot = after.json.members.find((m) => m.kind === "noApp");
    expect(Object.keys(spot).sort()).toEqual(NOAPP_MEMBER_KEYS);
    expect(spot).toMatchObject({ name: "Player N", role: "member", addedBy: a.ownerId, addedByName: "Player A" });
    expect(after.json.league.players).toBe(3);
    // A Friends name stored under a no-app id is never read (that id is not a Friends account).
    w.kv.set(`fr:ownname:${spot.memberId}`, "Player Wrong");
    expect((await members(b, setup.league.id)).json.members.find((m) => m.kind === "noApp").name).toBe("Player N");
  });
});

describe("W1 / W2 / W5 with a no-app player", () => {
  it("W1 takes kind from the roster and forces hostEnters for a no-app player", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const spot = (await addNoApp(b, setup.league.id, "Player N")).json.member;
    const res = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, [a.ownerId, b.ownerId, spot.memberId]) });
    expect(res.status).toBe(200);
    expect(res.json.round.players).toEqual([
      { memberId: a.ownerId, name: "Player A", kind: "app", groupNo: 1, courseHandicap: null, hostEnters: false },
      { memberId: b.ownerId, name: "Player B", kind: "app", groupNo: 1, courseHandicap: null, hostEnters: false },
      { memberId: spot.memberId, name: "Player N", kind: "noApp", groupNo: 1, courseHandicap: null, hostEnters: true },
    ]);
  });

  it("W2: the host writes a no-app player's cell (enteredBy host); another member cannot", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const spot = (await addNoApp(a, setup.league.id, "Player N")).json.member;
    const start = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, [a.ownerId, b.ownerId, spot.memberId]) });
    const roundId = start.json.round.roundId;
    const hostWrite = await w.call("/v1/leagues/rounds/score", { friend: a.friend, body: { roundId, memberId: spot.memberId, hole: 1, strokes: 5, rev: 1 } });
    expect(hostWrite.status).toBe(200);
    expect(hostWrite.json.cell).toMatchObject({ strokes: 5, rev: 1, enteredBy: "host", by: a.ownerId });
    const other = await w.call("/v1/leagues/rounds/score", { friend: b.friend, body: { roundId, memberId: spot.memberId, hole: 2, strokes: 5, rev: 1 } });
    expect(other.status).toBe(403);
  });

  it("W5 never pushes to a no-app player", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const spot = (await addNoApp(a, setup.league.id, "Player N")).json.member;
    w.kv.set(`fr:push:${b.ownerId}`, TOKEN(2));
    // Even if a token were stored under a no-app id, it is never used.
    w.kv.set(`fr:push:${spot.memberId}`, TOKEN(9));
    const res = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, [a.ownerId, b.ownerId, spot.memberId]) });
    expect(res.status).toBe(200);
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0].messages.map((m) => m.to)).toEqual([TOKEN(2)]);
  });
});

describe("remove (existing route) of a no-app player", () => {
  it("deletes the spot's row, keeps its round_results, and answers as before", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const spot = (await addNoApp(a, setup.league.id, "Player N")).json.member;
    const start = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, [a.ownerId, b.ownerId, spot.memberId]) });
    const roundId = start.json.round.roundId;
    await w.call("/v1/leagues/rounds/score", { friend: a.friend, body: { roundId, memberId: spot.memberId, hole: 1, strokes: 3, rev: 1 } });
    expect((await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId } })).status).toBe(200);
    const before = (await standings(a, setup.league.id)).json;
    expect(before.rows.map((r) => r.memberId)).toContain(spot.memberId);
    const res = await remove(a, setup.league.id, spot.memberId);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["removed", "league"]);
    expect(res.json.removed).toBe(spot.memberId);
    expect(res.json.league.players).toBe(2);
    const db = w.roster(setup.league.id).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM member WHERE member_id = ?").get(spot.memberId).n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM round_results WHERE member_id = ?").get(spot.memberId).n).toBe(1);
    // Past rounds stay in the standings (the row keeps its points; no roster name any more).
    const after = (await standings(a, setup.league.id)).json;
    expect(after.rows.map(({ name, ...r }) => r)).toEqual(before.rows.map(({ name, ...r }) => r));
  });
});

describe("W16 POST /v1/leagues/members/leave", () => {
  it("a member leaves: gone from members, players one fewer, past standings unchanged", async () => {
    const setup = await w.league(3);
    const [a, b] = setup.people;
    const roundId = await playedRound(setup);
    const before = (await standings(a, setup.league.id)).json;
    const res = await leave(b, setup.league.id);
    expect(res).toEqual({ status: 200, json: { left: b.ownerId }, headers: res.headers });
    const list = await members(a, setup.league.id);
    expect(list.json.members.map((m) => m.memberId)).not.toContain(b.ownerId);
    expect(list.json.league.players).toBe(2);
    const after = (await standings(a, setup.league.id)).json;
    expect(after.rows.map(({ name, ...r }) => r)).toEqual(before.rows.map(({ name, ...r }) => r));
    const db = w.roster(setup.league.id).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM round_results WHERE member_id = ?").get(b.ownerId).n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM round_cell WHERE round_id = ? AND member_id = ?").get(roundId, b.ownerId).n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM removed").get().n).toBe(0);
    // The leaver can no longer read the league.
    expect((await members(b, setup.league.id)).status).toBe(404);
  });

  it("the same code lets a leaver back in; a removed member is refused (decision 8 contrast)", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    expect((await leave(b, setup.league.id)).status).toBe(200);
    const back = await w.call("/v1/leagues/join", { friend: b.friend, body: { code: setup.code, name: "Player B" } });
    expect(back.status).toBe(200);
    expect(back.json.joined).toBe(true);
    expect((await remove(a, setup.league.id, c.ownerId)).status).toBe(200);
    const refused = await w.call("/v1/leagues/join", { friend: c.friend, body: { code: setup.code, name: "Player C" } });
    expect(refused).toMatchObject({ status: 404, json: { error: "code_not_found" } });
  });

  it("the organizer gets 403 forbidden; a non-member 404; unknown fields 400", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const before = dumpRoster(setup.league.id);
    expect(await leave(a, setup.league.id)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    const outsider = await w.player(9);
    expect(await leave(outsider, setup.league.id)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await leave(b, "A".repeat(22))).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await leave(b, setup.league.id, { extra: 1 })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await leave(b, "short")).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(dumpRoster(setup.league.id)).toBe(before);
  });

  it("a member blocked either way with the owner gets 404 (the readyMemberRead rule)", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    w.kv.set(`fr:block:${a.ownerId}:${b.ownerId}`, "1");
    expect(await leave(b, setup.league.id)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM member").get().n).toBe(2);
  });
});

describe("W17 POST /v1/leagues/members/handover", () => {
  it("hands over to an app member: new owner role, ownerId and ownerName; the caller is gone", async () => {
    const setup = await w.league(3);
    const [a, b] = setup.people;
    await playedRound(setup);
    const before = (await standings(b, setup.league.id)).json;
    const res = await handover(a, setup.league.id, b.ownerId);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["left", "league"]);
    expect(res.json.left).toBe(a.ownerId);
    expect(res.json.league).toMatchObject({ id: setup.league.id, ownerId: b.ownerId, ownerName: "Player B", players: 2 });
    const list = await members(b, setup.league.id);
    expect(list.json.members.map((m) => [m.memberId, m.role])).toEqual(
      expect.arrayContaining([[b.ownerId, "owner"]]),
    );
    expect(list.json.members.map((m) => m.memberId)).not.toContain(a.ownerId);
    expect(list.json.members.filter((m) => m.role === "owner")).toHaveLength(1);
    const after = (await standings(b, setup.league.id)).json;
    expect(after.rows.map(({ name, ...r }) => r)).toEqual(before.rows.map(({ name, ...r }) => r));
    expect(w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM removed").get().n).toBe(0);
  });

  it("the new organizer can reset, remove and save settings; the old one can't and isn't a member", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    expect((await handover(a, setup.league.id, b.ownerId)).status).toBe(200);
    const settings = {
      leagueId: setup.league.id,
      name: "Sunday Crew",
      game: "strokePlay",
      scoring: "gross",
      carryOver: false,
      homeCourse: null,
      seasonStarts: "2026-11-01",
      seasonEnds: "2027-03-31",
      roundDay: null,
    };
    // The old organizer: not a member, no organizer rights.
    expect((await members(a, setup.league.id)).status).toBe(404);
    expect((await w.call("/v1/leagues/code/reset", { friend: a.friend, body: { leagueId: setup.league.id } })).status).toBe(403);
    expect((await remove(a, setup.league.id, c.ownerId)).status).toBe(403);
    expect((await w.call("/v1/leagues/settings", { friend: a.friend, body: settings })).status).toBe(403);
    expect((await w.call(`/v1/leagues/claims?league=${setup.league.id}`, { method: "GET", friend: a.friend })).status).toBe(403);
    expect((await handover(a, setup.league.id, c.ownerId)).status).toBe(403);
    // The new organizer.
    expect((await w.call("/v1/leagues/settings", { friend: b.friend, body: settings })).status).toBe(200);
    const reset = await w.call("/v1/leagues/code/reset", { friend: b.friend, body: { leagueId: setup.league.id } });
    expect(reset.status).toBe(200);
    expect((await w.call(`/v1/leagues/claims?league=${setup.league.id}`, { method: "GET", friend: b.friend })).status).toBe(200);
    expect((await remove(b, setup.league.id, c.ownerId)).status).toBe(200);
    expect(await leave(b, setup.league.id)).toMatchObject({ status: 403, json: { error: "forbidden" } });
  });

  it("the old organizer rejoins with the current code (leaving is not removal)", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    expect((await handover(a, setup.league.id, b.ownerId)).status).toBe(200);
    const back = await w.call("/v1/leagues/join", { friend: a.friend, body: { code: setup.code, name: "Player A" } });
    expect(back.status).toBe(200);
    expect(back.json.league.ownerName).toBe("Player B");
  });

  it("refuses: no-app target 400, self 400, non-member target 404, non-organizer 403, bad body 400", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    const spot = (await addNoApp(a, setup.league.id, "Player N")).json.member;
    const before = dumpRoster(setup.league.id);
    expect(await handover(a, setup.league.id, spot.memberId)).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await handover(a, setup.league.id, a.ownerId)).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    const outsider = await w.player(9);
    expect(await handover(a, setup.league.id, outsider.ownerId)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await handover(b, setup.league.id, c.ownerId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await handover(a, "A".repeat(22), b.ownerId)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await handover(a, setup.league.id, b.ownerId, { extra: 1 })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await handover(a, setup.league.id, 5)).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(dumpRoster(setup.league.id)).toBe(before);
  });

  it("is atomic: a failure mid-transaction leaves everything unchanged", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const state = w.roster(setup.league.id);
    const before = dumpRoster(setup.league.id);
    const realExec = state.storage.sql.exec;
    state.storage.sql.exec = (query, ...bindings) => {
      if (/^\s*DELETE FROM member/i.test(String(query))) throw new Error("forced failure");
      return realExec(query, ...bindings);
    };
    await expect(handover(a, setup.league.id, b.ownerId)).rejects.toThrow();
    state.storage.sql.exec = realExec;
    expect(dumpRoster(setup.league.id)).toBe(before);
    const list = await members(a, setup.league.id);
    expect(list.json.league.ownerId).toBe(a.ownerId);
  });
});

describe("POST /v1/friends/request-by-member", () => {
  async function pair() {
    const setup = await w.league(3);
    return { ...setup, a: setup.people[0], b: setup.people[1], c: setup.people[2] };
  }

  it("accepts exactly the app body { league, memberId }; each outcome", async () => {
    const { league, b, c } = await pair();
    const body = { league: league.id, memberId: c.ownerId };
    expect(await requestByMember(b, body)).toMatchObject({ status: 200, json: { outcome: "sent" } });
    expect(w.kv.get(`fr:req:${c.ownerId}:${b.ownerId}`)).toBe("pending");
    expect(await requestByMember(b, body)).toMatchObject({ status: 200, json: { outcome: "already_sent" } });
    // They asked you: no second request.
    const back = await requestByMember(c, { league: league.id, memberId: b.ownerId });
    expect(back).toMatchObject({ status: 200, json: { outcome: "they_asked" } });
    expect(Object.keys(back.json)).toEqual(["outcome"]);
    expect(w.kv.has(`fr:req:${b.ownerId}:${c.ownerId}`)).toBe(false);
    // Accept, then already friends.
    expect((await w.call("/v1/friends/requests/accept", { friend: c.friend, body: { ownerId: b.ownerId } })).status).toBe(200);
    expect(await requestByMember(b, body)).toMatchObject({ status: 200, json: { outcome: "already_friends" } });
  });

  it("quiet block: the target blocked the caller → sent, with no request the target can accept", async () => {
    const { league, b, c } = await pair();
    w.kv.set(`fr:block:${c.ownerId}:${b.ownerId}`, "1");
    expect(await requestByMember(b, { league: league.id, memberId: c.ownerId })).toMatchObject({ status: 200, json: { outcome: "sent" } });
    expect(w.kv.has(`fr:req:${c.ownerId}:${b.ownerId}`)).toBe(false);
    expect(w.kv.get(`fr:out:${b.ownerId}:${c.ownerId}`)).toBe("pending");
    expect((await w.call("/v1/friends/requests/accept", { friend: c.friend, body: { ownerId: b.ownerId } })).status).toBe(409);
  });

  it("the caller blocked the target → 409 blocked", async () => {
    const { league, b, c } = await pair();
    w.kv.set(`fr:block:${b.ownerId}:${c.ownerId}`, "1");
    expect(await requestByMember(b, { league: league.id, memberId: c.ownerId })).toMatchObject({ status: 409, json: { error: "blocked" } });
    expect(w.kv.has(`fr:req:${c.ownerId}:${b.ownerId}`)).toBe(false);
  });

  it("non-member caller or target 404; no-app target 400; self 400; owner-block 404; bad bodies 400", async () => {
    const { league, a, b, c } = await pair();
    const outsider = await w.player(9);
    const spot = (await addNoApp(a, league.id, "Player N")).json.member;
    expect(await requestByMember(outsider, { league: league.id, memberId: c.ownerId })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await requestByMember(b, { league: league.id, memberId: outsider.ownerId })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await requestByMember(b, { league: "A".repeat(22), memberId: c.ownerId })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await requestByMember(b, { league: league.id, memberId: spot.memberId })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await requestByMember(b, { league: league.id, memberId: b.ownerId })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await requestByMember(b, { league: league.id, memberId: c.ownerId, code: "X" })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await requestByMember(b, { leagueId: league.id, memberId: c.ownerId })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await requestByMember(b, { league: "short", memberId: c.ownerId })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await requestByMember(b, { league: league.id })).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    w.kv.set(`fr:block:${a.ownerId}:${b.ownerId}`, "1");
    expect(await requestByMember(b, { league: league.id, memberId: c.ownerId })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect([...w.kv.keys()].filter((k) => k.startsWith("fr:req:"))).toEqual([]);
    expect(await w.call("/v1/friends/request-by-member", { body: { league: league.id, memberId: c.ownerId } })).toMatchObject({
      status: 401,
      json: { error: "friend_key_required" },
    });
  });

  it("uses no friend-code guess: 8+ requests do not hit the guess limit", async () => {
    const { league, b, c } = await pair();
    for (let i = 0; i < 10; i += 1) {
      expect((await requestByMember(b, { league: league.id, memberId: c.ownerId })).status).toBe(200);
    }
    // The friend-code guess bucket is still full: a code request with an unknown code is a 404, not 429.
    expect((await w.call("/v1/friends/requests", { friend: b.friend, body: { code: "AAAABBBB" } })).status).toBe(404);
  });

  it("/v1/friends/requests answers exactly as before", async () => {
    const { b, c } = await pair();
    const res = await w.call("/v1/friends/requests", { friend: b.friend, body: { code: c.code } });
    expect(res.json).toEqual({ status: "pending", ownerId: c.ownerId });
    expect((await w.call("/v1/friends/requests", { friend: b.friend, body: { code: c.code } })).json).toEqual({
      status: "pending",
      ownerId: c.ownerId,
      already: "outgoing",
    });
    expect((await w.call("/v1/friends/requests", { friend: c.friend, body: { code: b.code } })).json).toEqual({
      status: "pending",
      ownerId: b.ownerId,
      already: "incoming",
    });
  });
});

describe("rate limits", () => {
  it("W6, W7, W10–W13, W16, W17 and request-by-member all draw on the one keylgread: bucket", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const id = setup.league.id;
    const spotId = `noapp_${id}_${"z".repeat(16)}`;
    const claimId = `${id}_${"z".repeat(16)}`;
    const calls = [
      () => addNoApp(a, id, ""),
      () => rename(a, spotId, "Player Q"),
      () => leave(a, id),
      () => handover(a, id, "x".repeat(22)),
      () => requestByMember(a, { league: id, memberId: b.ownerId }),
      () => w.call("/v1/leagues/claims/approve", { friend: a.friend, body: { claimId } }),
      () => w.call("/v1/leagues/claims/decline", { friend: a.friend, body: { claimId } }),
      () => w.call("/v1/leagues/claims/cancel", { friend: a.friend, body: { claimId } }),
      () => w.call(`/v1/leagues/claims?league=${id}`, { method: "GET", friend: a.friend }),
      () => w.call("/v1/leagues/claims/mine", { method: "GET", friend: a.friend }),
    ];
    for (let i = 0; i < FRIEND_READ_KEY_LIMIT; i += 1) {
      expect((await calls[i % calls.length]()).status).not.toBe(429);
    }
    for (const call of calls) expect((await call()).status).toBe(429);
    // The bucket is the league read bucket: members is limited too.
    expect((await members(a, id)).status).toBe(429);
  });
});

describe("back-compat", () => {
  it("a league made with the old member schema gains the columns and reads every row as an app member", async () => {
    const state = sqliteState("old-members");
    const leagueId = `L${"b".repeat(21)}`;
    state.db.exec(`CREATE TABLE league (
      id INTEGER PRIMARY KEY CHECK (id = 1), league_id TEXT NOT NULL, name TEXT NOT NULL, owner_id TEXT NOT NULL,
      code TEXT NOT NULL, game TEXT NOT NULL, scoring TEXT NOT NULL, carry_over INTEGER NOT NULL, home_course TEXT,
      season_starts TEXT NOT NULL, season_ends TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    state.db.exec(`CREATE TABLE member (member_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL)`);
    state.db.exec(`INSERT INTO league VALUES (1, '${leagueId}', 'Old League', 'o1', 'ABCDEFGH', 'strokePlay', 'gross', 0, NULL, '2026-11-01', '2027-03-31', 1)`);
    state.db.exec(`INSERT INTO member VALUES ('o1', 'Player A', 'owner', 1), ('o2', 'Player B', 'member', 2)`);
    const roster = new LeagueRoster(state, {});
    const op = async (body) => (await roster.fetch(new Request("https://league-roster.internal/roster", { method: "POST", body: JSON.stringify(body) }))).json();
    const res = await op({ op: "members", callerId: "o1" });
    expect(res.ok).toBe(true);
    expect(res.members).toEqual([
      { memberId: "o1", name: "Player A", role: "owner", joinedAt: 1 },
      { memberId: "o2", name: "Player B", role: "member", joinedAt: 2 },
    ]);
    const cols = state.db.prepare("SELECT name FROM pragma_table_info('member')").all().map((c) => c.name);
    expect(cols).toEqual(["member_id", "name", "role", "joined_at", "kind", "added_by", "added_at"]);
    const rows = state.db.prepare("SELECT kind, added_by, added_at FROM member").all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { kind: null, added_by: null, added_at: null },
      { kind: null, added_by: null, added_at: null },
    ]);
    // The old rows can leave and be handed over to.
    expect(await op({ op: "handover", callerId: "o1", memberId: "o2" })).toMatchObject({ ok: true, league: { ownerId: "o2", ownerName: "Player B" } });
  });

  it("unknown league and friends routes are still 404 unknown_route", async () => {
    for (const path of ["/v1/leagues/members/quit", "/v1/leagues/claims/all", "/v1/leagues/handover", "/v1/friends/request-by-code"]) {
      expect(await w.call(path, { body: {} }), path).toMatchObject({ status: 404, json: { error: "unknown_route" } });
    }
    expect((await w.call("/v1/leagues/members/leave", { method: "GET" })).status).toBe(405);
  });
});
