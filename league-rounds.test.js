// Leagues W-A: rounds (W1–W4), the round-started push (W5) and settings (W15). Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FriendGuessLimiter, LeagueRoster } from "./entry.js";
import { FRIEND_CODE_GUESS_LIMIT, LEAGUE_LIVE_LIMIT, SHARED_GAME_WRITE_LIMIT } from "./friends.js";
import { DEFAULT_GAME_POINTS } from "./league-scoring.js";
import { HOLES_18, HOLES_FRONT, byHole, leagueWorld, roundBody, scoreAll, sqliteState } from "./league-test-harness.js";

const ROUND_ID_RE = /^[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{16}$/;
const TOKEN = (n) => `ExponentPushToken[tok${n}]`;

// The app's parseLeagueRound reads exactly these (ShotTraxx b555c794 leagueRoundsApiHttp.ts).
const ROUND_FIELDS = ["roundId", "leagueId", "hostId", "startedAt", "playedOn", "course", "holes", "game", "scoring", "carryOver", "teamsMode", "teams", "players", "cells", "finished"];
const PLAYER_FIELDS = ["memberId", "name", "kind", "groupNo", "courseHandicap", "hostEnters"];
const CELL_FIELDS = ["strokes", "rev", "enteredBy", "by", "at"];
const RESULT_FIELDS = ["memberId", "unit", "place", "net", "holes", "skins", "gamePoints", "incomplete"];

let w;
beforeEach(() => {
  w = leagueWorld();
  w.install();
});
afterEach(() => {
  w.uninstall();
  vi.restoreAllMocks();
});

async function started(count = 2, leagueExtra = {}, bodyExtra = {}) {
  const setup = await w.league(count, leagueExtra);
  const ids = setup.people.map((p) => p.ownerId);
  const res = await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body: roundBody(setup.league.id, ids, bodyExtra) });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return { ...setup, ids, round: res.json.round };
}

function score(p, roundId, memberId, hole, strokes, rev = 1) {
  return w.call("/v1/leagues/rounds/score", { friend: p.friend, body: { roundId, memberId, hole, strokes, rev } });
}

describe("W1 POST /v1/leagues/rounds", () => {
  it("starts a round with the app's round shape, the caller as host, names and kind from the roster", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    const body = roundBody(setup.league.id, [a.ownerId, b.ownerId, c.ownerId]);
    body.players[1].courseHandicap = 12;
    body.players[2].hostEnters = true;
    body.players[2].groupNo = 2;
    const res = await w.call("/v1/leagues/rounds", { friend: b.friend, body });
    expect(res.status).toBe(200);
    const round = res.json.round;
    expect(Object.keys(res.json)).toEqual(["round"]);
    for (const f of ROUND_FIELDS) expect(round, f).toHaveProperty(f);
    expect(round.history).toBeUndefined();
    expect(round.roundId).toMatch(ROUND_ID_RE);
    expect(round.roundId.slice(0, 22)).toBe(setup.league.id);
    expect(round).toMatchObject({
      leagueId: setup.league.id,
      hostId: b.ownerId,
      playedOn: "2026-11-21",
      course: "Mock Pines GC",
      holes: HOLES_18,
      game: "strokePlay",
      scoring: "gross",
      carryOver: false,
      teamsMode: null,
      teams: null,
      cells: {},
      finished: false,
    });
    expect(typeof round.startedAt).toBe("number");
    expect(round.players).toEqual([
      { memberId: a.ownerId, name: "Player A", kind: "app", groupNo: 1, courseHandicap: null, hostEnters: false },
      { memberId: b.ownerId, name: "Player B", kind: "app", groupNo: 1, courseHandicap: 12, hostEnters: false },
      { memberId: c.ownerId, name: "Player C", kind: "app", groupNo: 2, courseHandicap: null, hostEnters: true },
    ]);
    for (const p of round.players) expect(Object.keys(p).sort()).toEqual([...PLAYER_FIELDS].sort());
    // No KV row for rounds: KV keeps only lg:code:.
    expect([...w.kv.keys()].filter((k) => k.startsWith("lg:"))).toEqual([`lg:code:${setup.code}`]);
  });

  it("names and kind never come from the body", async () => {
    const setup = await w.league(2);
    const body = roundBody(setup.league.id, setup.people.map((p) => p.ownerId));
    body.players[0].name = "Someone Else";
    expect((await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body })).status).toBe(400);
    body.players[0] = { memberId: setup.people[0].ownerId, groupNo: 1, courseHandicap: null, hostEnters: false, kind: "noApp" };
    expect((await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body })).status).toBe(400);
  });

  it("snapshots the league's current game points and mode onto the round", async () => {
    const setup = await w.league(2, { gamePoints: { strokePlay: { per9: 4 } }, pointsMode: "replace" });
    const res = await w.call("/v1/leagues/rounds", {
      friend: setup.people[0].friend,
      body: roundBody(setup.league.id, setup.people.map((p) => p.ownerId)),
    });
    expect(res.json.round.pointsMode).toBe("replace");
    expect(res.json.round.gamePoints).toEqual({ ...DEFAULT_GAME_POINTS, strokePlay: { per9: 4, fullRound: 3 } });
  });

  it("a non-member gets 403 forbidden; a member blocked either way with the owner gets 404", async () => {
    const setup = await w.league(2);
    const outsider = await w.player(9);
    const body = roundBody(setup.league.id, [setup.people[0].ownerId]);
    expect(await w.call("/v1/leagues/rounds", { friend: outsider.friend, body })).toMatchObject({ status: 403, json: { error: "forbidden" } });
    const guest = setup.people[1];
    w.kv.set(`fr:block:${setup.people[0].ownerId}:${guest.ownerId}`, "1");
    expect(await w.call("/v1/leagues/rounds", { friend: guest.friend, body })).toMatchObject({ status: 404, json: { error: "not_found" } });
    w.kv.delete(`fr:block:${setup.people[0].ownerId}:${guest.ownerId}`);
    w.kv.set(`fr:block:${guest.ownerId}:${setup.people[0].ownerId}`, "1");
    expect(await w.call("/v1/leagues/rounds", { friend: guest.friend, body })).toMatchObject({ status: 404, json: { error: "not_found" } });
  });

  it("one live round per league: a second start is 409 round_live, even at the same moment", async () => {
    const setup = await w.league(2);
    const body = roundBody(setup.league.id, setup.people.map((p) => p.ownerId));
    const both = await Promise.all(setup.people.map((p) => w.call("/v1/leagues/rounds", { friend: p.friend, body })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409).json).toEqual({ error: "round_live" });
    expect(w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM league_round").get().n).toBe(1);
  });

  it("refuses each invalid field with 400 invalid_body", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people.map((p) => p.ownerId);
    const base = () => roundBody(setup.league.id, [a, b, c]);
    const cases = {
      "unknown field": (x) => ({ ...x, extra: 1 }),
      "missing field": (x) => {
        delete x.teams;
        return x;
      },
      "course blank": (x) => ({ ...x, course: "" }),
      "course padded": (x) => ({ ...x, course: " Mock " }),
      "playedOn bad": (x) => ({ ...x, playedOn: "2026-02-30" }),
      "holes 10": (x) => ({ ...x, holes: HOLES_18.slice(0, 10) }),
      "holes dup": (x) => ({ ...x, holes: [...HOLES_FRONT.slice(0, 8), HOLES_FRONT[0]] }),
      "hole 19": (x) => ({ ...x, holes: [...HOLES_FRONT.slice(0, 8), { number: 19, par: 4, strokeIndex: 1 }] }),
      "par 7": (x) => ({ ...x, holes: HOLES_FRONT.map((h, i) => (i === 0 ? { ...h, par: 7 } : h)) }),
      "par 2": (x) => ({ ...x, holes: HOLES_FRONT.map((h, i) => (i === 0 ? { ...h, par: 2 } : h)) }),
      "strokeIndex 19": (x) => ({ ...x, holes: HOLES_FRONT.map((h, i) => (i === 0 ? { ...h, strokeIndex: 19 } : h)) }),
      "strokeIndex 0": (x) => ({ ...x, holes: HOLES_FRONT.map((h, i) => (i === 0 ? { ...h, strokeIndex: 0 } : h)) }),
      "hole extra key": (x) => ({ ...x, holes: HOLES_FRONT.map((h, i) => (i === 0 ? { ...h, yards: 400 } : h)) }),
      "game wolf": (x) => ({ ...x, game: "wolf" }),
      "scoring both": (x) => ({ ...x, scoring: "both" }),
      "carryOver without skins": (x) => ({ ...x, carryOver: true }),
      "carryOver not boolean": (x) => ({ ...x, game: "skins", carryOver: "yes" }),
      "no players": (x) => ({ ...x, players: [] }),
      "21 players": (x) => ({ ...x, players: Array.from({ length: 21 }, (_, i) => ({ memberId: `m${i}`, groupNo: 1, courseHandicap: null, hostEnters: false })) }),
      "dup player": (x) => ({ ...x, players: [x.players[0], x.players[0]] }),
      "not a member": (x) => ({ ...x, players: [...x.players, { memberId: "not-a-member", groupNo: 1, courseHandicap: null, hostEnters: false }] }),
      "groupNo 0": (x) => ({ ...x, players: x.players.map((p, i) => (i === 0 ? { ...p, groupNo: 0 } : p)) }),
      "groupNo 1.5": (x) => ({ ...x, players: x.players.map((p, i) => (i === 0 ? { ...p, groupNo: 1.5 } : p)) }),
      "handicap 55": (x) => ({ ...x, players: x.players.map((p, i) => (i === 0 ? { ...p, courseHandicap: 55 } : p)) }),
      "handicap -1": (x) => ({ ...x, players: x.players.map((p, i) => (i === 0 ? { ...p, courseHandicap: -1 } : p)) }),
      "handicap 4.5": (x) => ({ ...x, players: x.players.map((p, i) => (i === 0 ? { ...p, courseHandicap: 4.5 } : p)) }),
      "hostEnters missing": (x) => ({ ...x, players: x.players.map((p, i) => (i === 0 ? { memberId: p.memberId, groupNo: 1, courseHandicap: null } : p)) }),
      "teamsMode trios": (x) => ({ ...x, teamsMode: "trios" }),
      "team member not playing": (x) => ({ ...x, game: "matchPlay", teamsMode: "pairs", teams: [{ teamNo: 1, memberIds: [a, "zz"] }, { teamNo: 2, memberIds: [b, c] }] }),
      "player on two teams": (x) => ({ ...x, game: "matchPlay", teamsMode: "pairs", teams: [{ teamNo: 1, memberIds: [a, b] }, { teamNo: 2, memberIds: [b, c] }] }),
      "teamNo not integer": (x) => ({ ...x, game: "matchPlay", teamsMode: "pairs", teams: [{ teamNo: "1", memberIds: [a] }, { teamNo: 2, memberIds: [b, c] }] }),
      "leagueId bad": (x) => ({ ...x, leagueId: "short" }),
    };
    for (const [label, make] of Object.entries(cases)) {
      const res = await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body: make(base()) });
      expect(res.status, label).toBe(400);
      expect(res.json.error, label).toBe("invalid_body");
    }
    expect(w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM league_round").get().n).toBe(0);
    // A body over 16 KB.
    const big = { ...base(), course: "x".repeat(17 * 1024) };
    expect((await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body: big })).status).toBe(413);
  });

  it("accepts 9 holes 10–18, pairs teams, and drops teams the app would not read (no teams mode)", async () => {
    const setup = await w.league(4);
    const ids = setup.people.map((p) => p.ownerId);
    const teams = [{ teamNo: 1, memberIds: [ids[0], ids[3]] }, { teamNo: 2, memberIds: [ids[1], ids[2]] }];
    const res = await w.call("/v1/leagues/rounds", {
      friend: setup.people[0].friend,
      body: roundBody(setup.league.id, ids, { holes: HOLES_18.slice(9), game: "matchPlay", teamsMode: "pairs", teams }),
    });
    expect(res.status).toBe(200);
    expect(res.json.round.teams).toEqual(teams);
    expect(res.json.round.holes.map((h) => h.number)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect((await w.call("/v1/leagues/rounds/finish", { friend: setup.people[0].friend, body: { roundId: res.json.round.roundId } })).status).toBe(200);
    const res2 = await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body: roundBody(setup.league.id, ids, { teams }) });
    expect(res2.status).toBe(200);
    expect(res2.json.round.teams).toBeNull();
  });
});

describe("W2 POST /v1/leagues/rounds/score", () => {
  it("compare-and-set: two writes on the same rev, one wins, the other gets 409 conflict with the winning cell", async () => {
    const { round, people, ids } = await started(2);
    const [a] = people;
    const both = await Promise.all([score(a, round.roundId, ids[0], 1, 4), score(a, round.roundId, ids[0], 1, 5)]);
    const won = both.find((r) => r.status === 200);
    const lost = both.find((r) => r.status === 409);
    expect(won && lost).toBeTruthy();
    expect(lost.json.error).toBe("conflict");
    expect(lost.json.cell).toEqual(won.json.cell);
    expect(Object.keys(won.json.cell)).toEqual(CELL_FIELDS);
    expect(won.json.cell).toMatchObject({ rev: 1, enteredBy: "self", by: ids[0] });
    // The next write needs rev 2; rev 1 again (current) and rev 3 are conflicts.
    expect((await score(a, round.roundId, ids[0], 1, 6, 1)).status).toBe(409);
    expect((await score(a, round.roundId, ids[0], 1, 6, 3)).status).toBe(409);
    const ok = await score(a, round.roundId, ids[0], 1, 6, 2);
    expect(ok.status).toBe(200);
    expect(ok.json.cell).toMatchObject({ strokes: 6, rev: 2 });
  });

  it("decision 4: own score only; the host writes for host-entered players; a player can't write over a host cell", async () => {
    const setup = await w.league(3);
    const [host, b, c] = setup.people;
    const ids = setup.people.map((p) => p.ownerId);
    const body = roundBody(setup.league.id, ids);
    body.players[1].hostEnters = true;
    const { json } = await w.call("/v1/leagues/rounds", { friend: host.friend, body });
    const rid = json.round.roundId;
    // Someone else's score: forbidden. The host for a non-host-entered player: forbidden.
    expect(await score(c, rid, ids[1], 1, 4)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await score(host, rid, ids[2], 1, 4)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    // The host enters for b.
    const hostCell = await score(host, rid, ids[1], 1, 5);
    expect(hostCell.status).toBe(200);
    expect(hostCell.json.cell).toMatchObject({ strokes: 5, enteredBy: "host", by: ids[0] });
    // b can't write over it.
    expect(await score(b, rid, ids[1], 1, 4, 2)).toMatchObject({ status: 403, json: { error: "host_entered" } });
    // The host changing it keeps it host-entered.
    const edit = await score(host, rid, ids[1], 1, 6, 2);
    expect(edit.json.cell).toMatchObject({ strokes: 6, rev: 2, enteredBy: "host" });
    // b can write a hole the host has not entered.
    expect((await score(b, rid, ids[1], 2, 4)).json.cell.enteredBy).toBe("self");
    // The host's own score stays self.
    expect((await score(host, rid, ids[0], 1, 4)).json.cell.enteredBy).toBe("self");
  });

  it("strokes 0 and 21 are refused (400 bad_strokes); a hole outside the round is 400 bad_hole; null clears", async () => {
    const { round, people, ids } = await started(2, {}, { holes: HOLES_FRONT });
    const [a] = people;
    expect(await score(a, round.roundId, ids[0], 1, 0)).toMatchObject({ status: 400, json: { error: "bad_strokes" } });
    expect(await score(a, round.roundId, ids[0], 1, 21)).toMatchObject({ status: 400, json: { error: "bad_strokes" } });
    expect(await score(a, round.roundId, ids[0], 1, 4.5)).toMatchObject({ status: 400, json: { error: "bad_strokes" } });
    expect(await score(a, round.roundId, ids[0], 10, 4)).toMatchObject({ status: 400, json: { error: "bad_hole" } });
    expect((await score(a, round.roundId, ids[0], 1, 20)).status).toBe(200);
    const cleared = await score(a, round.roundId, ids[0], 1, null, 2);
    expect(cleared.json.cell).toMatchObject({ strokes: null, rev: 2 });
    expect(await score(a, round.roundId, "not-in-round", 1, 4)).toMatchObject({ status: 400, json: { error: "not_in_round" } });
  });

  it("bad bodies, unknown and malformed round ids, and non-members", async () => {
    const { round, people, ids } = await started(2);
    const [a] = people;
    const post = (friend, body) => w.call("/v1/leagues/rounds/score", { friend, body });
    expect((await post(a.friend, { roundId: round.roundId, memberId: ids[0], hole: 1, strokes: 4, rev: 1, x: 1 })).status).toBe(400);
    expect((await post(a.friend, { roundId: round.roundId, memberId: ids[0], hole: "1", strokes: 4, rev: 1 })).status).toBe(400);
    expect((await post(a.friend, { roundId: round.roundId, memberId: ids[0], hole: 1, strokes: "4", rev: 1 })).status).toBe(400);
    expect((await post(a.friend, { roundId: round.roundId, memberId: ids[0], hole: 1, strokes: 4 })).status).toBe(400);
    expect(await post(a.friend, { roundId: "nope", memberId: ids[0], hole: 1, strokes: 4, rev: 1 })).toMatchObject({ status: 404, json: { error: "not_found" } });
    const otherRound = `${round.roundId.slice(0, 23)}${"Z".repeat(16)}`;
    expect(await post(a.friend, { roundId: otherRound, memberId: ids[0], hole: 1, strokes: 4, rev: 1 })).toMatchObject({ status: 404 });
    const outsider = await w.player(9);
    expect(await post(outsider.friend, { roundId: round.roundId, memberId: ids[0], hole: 1, strokes: 4, rev: 1 })).toMatchObject({ status: 403, json: { error: "forbidden" } });
  });

  it("keeps every accepted edit in history and never sends it", async () => {
    const { round, people, ids, league } = await started(2);
    const [a] = people;
    await score(a, round.roundId, ids[0], 1, 4, 1);
    await score(a, round.roundId, ids[0], 1, 5, 2);
    await score(a, round.roundId, ids[0], 1, 6, 1); // refused: conflict
    await score(a, round.roundId, ids[0], 1, null, 3);
    const history = w.roster(league.id).db.prepare("SELECT member_id, hole, strokes, rev, entered_by FROM round_history ORDER BY seq").all();
    expect(history.map((h) => ({ ...h }))).toEqual([
      { member_id: ids[0], hole: 1, strokes: 4, rev: 1, entered_by: "self" },
      { member_id: ids[0], hole: 1, strokes: 5, rev: 2, entered_by: "self" },
      { member_id: ids[0], hole: 1, strokes: null, rev: 3, entered_by: "self" },
    ]);
    const live = await w.call(`/v1/leagues/rounds?league=${league.id}`, { method: "GET", friend: a.friend });
    expect(live.json.round.history).toBeUndefined();
    expect(JSON.stringify(live.json)).not.toContain("history");
  });

  it("finishes on its own when the last score lands, then refuses writes with 409 finished", async () => {
    const { round, people, ids, league } = await started(2, {}, { holes: HOLES_FRONT });
    const [a, b] = people;
    await scoreAll(w, a.friend, round.roundId, ids[0], byHole(HOLES_FRONT, [4, 4, 3, 5, 4, 4, 3, 5, 4]));
    const last = await scoreAll(w, b.friend, round.roundId, ids[1], byHole(HOLES_FRONT, [5, 4, 3, 5, 4, 4, 3, 5, 4]));
    expect(last.every((r) => r.status === 200)).toBe(true);
    const db = w.roster(league.id).db;
    expect(db.prepare("SELECT finished FROM league_round").get().finished).toBe(1);
    const rows = db.prepare("SELECT member_id, place, net, holes, incomplete FROM round_results ORDER BY place").all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { member_id: ids[0], place: 1, net: 0, holes: 9, incomplete: 0 },
      { member_id: ids[1], place: 2, net: 1, holes: 9, incomplete: 0 },
    ]);
    expect(await score(a, round.roundId, ids[0], 1, 5, 2)).toMatchObject({ status: 409, json: { error: "finished" } });
    expect(await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: round.roundId } })).toMatchObject({ status: 409, json: { error: "finished" } });
    // A new round can start now.
    expect((await w.call("/v1/leagues/rounds", { friend: b.friend, body: roundBody(league.id, ids) })).status).toBe(200);
  });
});

describe("W3 GET /v1/leagues/rounds", () => {
  it("live round, else the latest round since `since`, else null; lastSeen set only when missing", async () => {
    let now = Date.UTC(2026, 10, 21, 15, 0, 0);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    const ids = setup.people.map((p) => p.ownerId);
    const live = (p, since) =>
      w.call(`/v1/leagues/rounds?league=${setup.league.id}${since != null ? `&since=${since}` : ""}`, { method: "GET", friend: p.friend });

    const none = await live(c);
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ round: null, lastSeen: { [c.ownerId]: now }, now });
    const firstSeenC = now;

    now += 60_000;
    const startedAt = now;
    const start = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, ids.slice(0, 2), { holes: HOLES_FRONT }) });
    const rid = start.json.round.roundId;
    now += 60_000;
    await score(b, rid, ids[1], 1, 4);
    now += 60_000;
    const during = await live(c);
    expect(during.json.round.roundId).toBe(rid);
    expect(during.json.round.cells[ids[1]]["1"]).toMatchObject({ strokes: 4, rev: 1 });
    // c's poll did not move c's lastSeen; a (start) and b (score) were set by their writes.
    expect(during.json.lastSeen).toEqual({ [a.ownerId]: startedAt, [b.ownerId]: startedAt + 60_000, [c.ownerId]: firstSeenC });
    expect(during.json.now).toBe(now);

    now += 60_000;
    await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: rid } });
    expect((await live(c)).json.round).toBeNull();
    const since = await live(c, startedAt);
    expect(since.json.round).toMatchObject({ roundId: rid, finished: true });
    expect((await live(c, startedAt + 1)).json.round).toBeNull();
  });

  it("members only: a non-member gets 403; bad queries are 400; a blocked member 404", async () => {
    const setup = await w.league(2);
    const outsider = await w.player(9);
    const path = `/v1/leagues/rounds?league=${setup.league.id}`;
    expect(await w.call(path, { method: "GET", friend: outsider.friend })).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect((await w.call(`${path}&since=abc`, { method: "GET", friend: setup.people[1].friend })).status).toBe(400);
    expect((await w.call(`${path}&x=1`, { method: "GET", friend: setup.people[1].friend })).status).toBe(400);
    expect((await w.call(`/v1/leagues/rounds?league=bad`, { method: "GET", friend: setup.people[1].friend })).status).toBe(400);
    w.kv.set(`fr:block:${setup.people[0].ownerId}:${setup.people[1].ownerId}`, "1");
    expect((await w.call(path, { method: "GET", friend: setup.people[1].friend })).status).toBe(404);
  });
});

describe("W4 POST /v1/leagues/rounds/finish", () => {
  it("host only; stores one row per player; answers the results shape; a second finish is 409", async () => {
    const { round, people, ids, league } = await started(3, {}, { holes: HOLES_FRONT });
    const [a, b] = people;
    await scoreAll(w, a.friend, round.roundId, ids[0], byHole(HOLES_FRONT, [4, 4, 3, 5, 4, 4, 3, 5, 4]));
    await scoreAll(w, b.friend, round.roundId, ids[1], byHole(HOLES_FRONT, [5, 5, 3, 5, 4, 4, 3, 5]));
    expect(await w.call("/v1/leagues/rounds/finish", { friend: b.friend, body: { roundId: round.roundId } })).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect((await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: `${league.id}_${"q".repeat(16)}` } })).status).toBe(404);
    expect((await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: "x" } })).status).toBe(404);
    const res = await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: round.roundId } });
    expect(res.status).toBe(200);
    const r = res.json.results;
    expect(r).toMatchObject({ roundId: round.roundId, playedOn: "2026-11-21", finished: true, pointsMode: "add" });
    for (const row of r.results) expect(Object.keys(row)).toEqual(RESULT_FIELDS);
    expect(r.results.map((x) => [x.memberId, x.place, x.holes, x.incomplete])).toEqual([
      [ids[0], 1, 9, false],
      [ids[1], 2, 8, true],
      [ids[2], 3, 0, true],
    ]);
    // Defaults: stroke play Per 9 = 2 and Full round = 3 to the only player who scored every hole.
    expect(r.results.map((x) => x.gamePoints)).toEqual([5, 0, 0]);
    const stored = w.roster(league.id).db.prepare("SELECT member_id, place, holes, game_points, points_mode, incomplete FROM round_results ORDER BY place").all();
    expect(stored.map((x) => ({ ...x }))).toEqual([
      { member_id: ids[0], place: 1, holes: 9, game_points: 5, points_mode: "add", incomplete: 0 },
      { member_id: ids[1], place: 2, holes: 8, game_points: 0, points_mode: "add", incomplete: 1 },
      { member_id: ids[2], place: 3, holes: 0, game_points: 0, points_mode: "add", incomplete: 1 },
    ]);
    expect(await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: round.roundId } })).toMatchObject({ status: 409, json: { error: "finished" } });
    const standings = await w.call(`/v1/leagues/standings?league=${league.id}`, { method: "GET", friend: b.friend });
    expect(standings.json.rows.map((x) => [x.memberId, x.points, x.gamePoints])).toEqual([
      [ids[0], 11, 5],
      [ids[1], 5, 0],
      [ids[2], 4, 0],
    ]);
  });
});

describe("W5 round-started push", () => {
  it("goes to every member but the starter, skipping blocked members and members without a token", async () => {
    const setup = await w.league(5);
    const [a, b, c, d, e] = setup.people;
    for (const [n, p] of [a, b, c, d].entries()) w.kv.set(`fr:push:${p.ownerId}`, TOKEN(n + 1));
    // e has no token. d is blocked by the starter (b).
    w.kv.set(`fr:block:${b.ownerId}:${d.ownerId}`, "1");
    w.kv.set(`fr:push:${e.ownerId}`, "not-a-token");
    // The starter's current Friends name wins over the roster name.
    w.kv.set(`fr:ownname:${b.ownerId}`, "Player Bee");
    const res = await w.call("/v1/leagues/rounds", {
      friend: b.friend,
      body: roundBody(setup.league.id, [a.ownerId, b.ownerId], { game: "skins", carryOver: true }),
    });
    expect(res.status).toBe(200);
    expect(w.pushes).toHaveLength(1);
    const { messages, headers } = w.pushes[0];
    expect(headers.Authorization).toBe("Bearer test-expo-token");
    expect(messages.map((m) => m.to).sort()).toEqual([TOKEN(1), TOKEN(3)].sort());
    for (const m of messages) {
      expect(m).toEqual({
        to: m.to,
        title: "Player Bee started a league round",
        body: "Saturday Crew: Skins at Mock Pines GC. Tap to follow the live leaderboard.",
        sound: "default",
        data: { kind: "league_round_start", leagueId: setup.league.id, roundId: res.json.round.roundId },
      });
    }
  });

  it("falls back to the roster name, labels each game, and a member who blocked the starter is skipped too", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    w.kv.set(`fr:push:${b.ownerId}`, TOKEN(2));
    w.kv.set(`fr:push:${c.ownerId}`, TOKEN(3));
    w.kv.set(`fr:block:${c.ownerId}:${a.ownerId}`, "1");
    w.kv.delete(`fr:ownname:${a.ownerId}`);
    const labels = { strokePlay: "Stroke play", stableford: "Stableford", matchPlay: "Match play", nassau: "Nassau" };
    for (const [game, label] of Object.entries(labels)) {
      const res = await w.call("/v1/leagues/rounds", { friend: a.friend, body: roundBody(setup.league.id, [a.ownerId, b.ownerId], { game }) });
      expect(res.status).toBe(200);
      const last = w.pushes.at(-1).messages;
      expect(last.map((m) => m.to)).toEqual([TOKEN(2)]);
      expect(last[0].title).toBe("Player A started a league round");
      expect(last[0].body).toBe(`Saturday Crew: ${label} at Mock Pines GC. Tap to follow the live leaderboard.`);
      await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: res.json.round.roundId } });
    }
  });

  it("a push failure never fails the start", async () => {
    const setup = await w.league(2);
    w.kv.set(`fr:push:${setup.people[1].ownerId}`, TOKEN(2));
    w.pushFails = true;
    const res = await w.call("/v1/leagues/rounds", { friend: setup.people[0].friend, body: roundBody(setup.league.id, [setup.people[0].ownerId]) });
    expect(res.status).toBe(200);
    expect(w.pushes).toHaveLength(1);
  });
});

describe("W15 POST /v1/leagues/settings", () => {
  // Exactly the app's leagueSettingsForWorker body (no gamePoints / pointsMode).
  const appBody = (leagueId, extra = {}) => ({
    leagueId,
    name: "Sunday Crew",
    game: "skins",
    scoring: "net",
    carryOver: true,
    homeCourse: "Mock Oaks CC",
    seasonStarts: "2026-11-01",
    seasonEnds: "2027-04-30",
    roundDay: 0,
    ...extra,
  });

  it("organizer only; updates the league and answers { league }", async () => {
    const setup = await w.league(2);
    const [owner, guest] = setup.people;
    expect(await w.call("/v1/leagues/settings", { friend: guest.friend, body: appBody(setup.league.id) })).toEqual(
      expect.objectContaining({ status: 403, json: { error: "forbidden" } }),
    );
    const outsider = await w.player(9);
    expect((await w.call("/v1/leagues/settings", { friend: outsider.friend, body: appBody(setup.league.id) })).status).toBe(403);
    const res = await w.call("/v1/leagues/settings", { friend: owner.friend, body: appBody(setup.league.id) });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["league"]);
    expect(res.json.league).toMatchObject({
      id: setup.league.id,
      name: "Sunday Crew",
      game: "skins",
      scoring: "net",
      carryOver: true,
      homeCourse: "Mock Oaks CC",
      seasonEnds: "2027-04-30",
      roundDay: 0,
      players: 2,
      gamePoints: DEFAULT_GAME_POINTS,
      pointsMode: "add",
    });
  });

  it("name_required, invalid_body, and carry-over forced off for non-skins", async () => {
    const setup = await w.league(1);
    const [owner] = setup.people;
    const post = (body) => w.call("/v1/leagues/settings", { friend: owner.friend, body });
    expect(await post(appBody(setup.league.id, { name: "  " }))).toMatchObject({ status: 400, json: { error: "name_required" } });
    for (const extra of [
      { game: "wolf" },
      { scoring: "both" },
      { carryOver: "yes" },
      { homeCourse: " padded " },
      { seasonStarts: "2027-05-01" },
      { roundDay: 7 },
      { gamePoints: { wolf: { perHole: 1 } } },
      { gamePoints: { matchPlay: { perSkin: 1 } } },
      { gamePoints: { skins: { perSkin: 21 } } },
      { gamePoints: { skins: { perSkin: 1.5 } } },
      { gamePoints: { skins: { perSkin: -1 } } },
      { gamePoints: [] },
      { pointsMode: "double" },
      { extra: 1 },
    ]) {
      expect((await post(appBody(setup.league.id, extra))).status, JSON.stringify(extra)).toBe(400);
    }
    const res = await post(appBody(setup.league.id, { game: "strokePlay", carryOver: true }));
    expect(res.status).toBe(200);
    expect(res.json.league.carryOver).toBe(false);
  });

  it("season_before_round when the season would end before a round already played (live or finished)", async () => {
    const setup = await w.league(2);
    const [owner] = setup.people;
    const ids = setup.people.map((p) => p.ownerId);
    const start = await w.call("/v1/leagues/rounds", { friend: owner.friend, body: roundBody(setup.league.id, ids, { playedOn: "2026-12-05" }) });
    const post = (seasonEnds) => w.call("/v1/leagues/settings", { friend: owner.friend, body: appBody(setup.league.id, { seasonEnds }) });
    expect(await post("2026-12-04")).toMatchObject({ status: 409, json: { error: "season_before_round" } });
    expect((await post("2026-12-05")).status).toBe(200);
    await w.call("/v1/leagues/rounds/finish", { friend: owner.friend, body: { roundId: start.json.round.roundId } });
    expect((await post("2026-12-04")).status).toBe(409);
  });

  it("today's app body leaves game points and mode unchanged; a partial gamePoints merges", async () => {
    const setup = await w.league(1, { gamePoints: { matchPlay: { per9: 2 } }, pointsMode: "replace" });
    const [owner] = setup.people;
    const custom = { ...DEFAULT_GAME_POINTS, matchPlay: { perHole: 1, per9: 2, fullRound: 0 } };
    expect(setup.league.gamePoints).toEqual(custom);
    const res = await w.call("/v1/leagues/settings", { friend: owner.friend, body: appBody(setup.league.id) });
    expect(res.json.league.gamePoints).toEqual(custom);
    expect(res.json.league.pointsMode).toBe("replace");
    const merged = await w.call("/v1/leagues/settings", {
      friend: owner.friend,
      body: appBody(setup.league.id, { gamePoints: { nassau: { fullRound: 3 } }, pointsMode: "add" }),
    });
    expect(merged.json.league.gamePoints).toEqual({ ...custom, nassau: { per9: 1, fullRound: 3 } });
    expect(merged.json.league.pointsMode).toBe("add");
  });

  it("never touches stored round_results or rounds (byte for byte)", async () => {
    const setup = await w.league(2);
    const [owner, guest] = setup.people;
    const ids = setup.people.map((p) => p.ownerId);
    const start = await w.call("/v1/leagues/rounds", { friend: owner.friend, body: roundBody(setup.league.id, ids, { holes: HOLES_FRONT }) });
    await scoreAll(w, owner.friend, start.json.round.roundId, ids[0], byHole(HOLES_FRONT, [4, 4, 3, 5, 4, 4, 3, 5, 4]));
    await scoreAll(w, guest.friend, start.json.round.roundId, ids[1], byHole(HOLES_FRONT, [5, 5, 3, 5, 4, 4, 3, 5, 4]));
    const db = w.roster(setup.league.id).db;
    const dump = () => JSON.stringify([db.prepare("SELECT * FROM round_results ORDER BY round_id, member_id").all(), db.prepare("SELECT * FROM league_round").all()]);
    const before = dump();
    const res = await w.call("/v1/leagues/settings", {
      friend: owner.friend,
      body: appBody(setup.league.id, { game: "matchPlay", carryOver: false, scoring: "gross", gamePoints: { strokePlay: { per9: 9, fullRound: 9 } }, pointsMode: "replace" }),
    });
    expect(res.status).toBe(200);
    expect(dump()).toBe(before);
  });
});

describe("rate limits", () => {
  it("each new league prefix has its own limit, not the 8-guess default", () => {
    const limitFor = (name) => new FriendGuessLimiter(sqliteState(name), {}).limit;
    expect(limitFor("keylgwrite:abc")).toBe(SHARED_GAME_WRITE_LIMIT);
    expect(limitFor("iplgwrite:abc")).toBe(SHARED_GAME_WRITE_LIMIT);
    expect(limitFor("keylglive:abc")).toBe(LEAGUE_LIVE_LIMIT);
    expect(limitFor("iplglive:abc")).toBe(LEAGUE_LIVE_LIMIT);
    expect(LEAGUE_LIVE_LIMIT).toBe(240);
    expect(SHARED_GAME_WRITE_LIMIT).toBe(240);
    expect(limitFor("keylgnope:abc")).toBe(FRIEND_CODE_GUESS_LIMIT);
  });

  it("live polls use their own bucket: 240 polls leave the member/standings budget whole", async () => {
    const setup = await w.league(1);
    const [owner] = setup.people;
    for (let i = 0; i < 61; i += 1) {
      expect((await w.call(`/v1/leagues/rounds?league=${setup.league.id}`, { method: "GET", friend: owner.friend })).status).toBe(200);
    }
    expect((await w.call(`/v1/leagues/members?league=${setup.league.id}`, { method: "GET", friend: owner.friend })).status).toBe(200);
  });
});

describe("back-compat", () => {
  it("claims answers W9 (no longer 501), the W-B routes exist, and unknown league routes are still 404", async () => {
    const setup = await w.league(1);
    const guest = await w.player(2);
    // W-B replaced the 501 stub: a body without a name is W9's 400 name_required.
    expect(await w.call("/v1/leagues/claims", { friend: guest.friend, body: { code: setup.code } })).toMatchObject({ status: 400, json: { error: "name_required" } });
    // W-B built these: an empty body is 400 invalid_body.
    for (const path of ["/v1/leagues/members/no-app", "/v1/leagues/members/rename", "/v1/leagues/claims/approve"]) {
      expect(await w.call(path, { friend: setup.people[0].friend, body: {} }), path).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    }
    for (const path of ["/v1/leagues/leave", "/v1/leagues/rounds/x"]) {
      expect(await w.call(path, { friend: setup.people[0].friend, body: {} })).toMatchObject({ status: 404, json: { error: "unknown_route" } });
    }
    expect((await w.call("/v1/leagues/rounds/score", { method: "GET", friend: setup.people[0].friend })).status).toBe(405);
  });

  it("create, preview, join, members, standings, remove and reset answer as before plus the two league fields", async () => {
    const setup = await w.league(1);
    const [owner] = setup.people;
    const guest = await w.player(2);
    const extra = { gamePoints: DEFAULT_GAME_POINTS, pointsMode: "add" };
    const leagueKeys = ["id", "name", "ownerId", "ownerName", "game", "scoring", "carryOver", "homeCourse", "seasonStarts", "seasonEnds", "roundDay", "players", "maxPlayers", "gamePoints", "pointsMode"];
    expect(Object.keys(setup.league)).toEqual(leagueKeys);
    expect(setup.league).toMatchObject(extra);
    const preview = await w.call("/v1/leagues/preview", { friend: guest.friend, body: { code: setup.code } });
    expect(Object.keys(preview.json)).toEqual(["league"]);
    expect(Object.keys(preview.json.league)).toEqual(leagueKeys.filter((k) => k !== "ownerId"));
    const join = await w.call("/v1/leagues/join", { friend: guest.friend, body: { code: setup.code, name: "Player K" } });
    expect(Object.keys(join.json)).toEqual(["league", "joined"]);
    expect(join.json.league).toMatchObject(extra);
    const members = await w.call(`/v1/leagues/members?league=${setup.league.id}`, { method: "GET", friend: owner.friend });
    expect(Object.keys(members.json)).toEqual(["league", "code", "members"]);
    expect(members.json.league).toMatchObject(extra);
    const standings = await w.call(`/v1/leagues/standings?league=${setup.league.id}`, { method: "GET", friend: owner.friend });
    expect(standings.json).toEqual({ season: { starts: "2026-11-01", ends: "2027-03-31" }, rounds: 0, rows: [] });
    const reset = await w.call("/v1/leagues/code/reset", { friend: owner.friend, body: { leagueId: setup.league.id } });
    expect(Object.keys(reset.json)).toEqual(["code", "league"]);
    expect(reset.json.league).toMatchObject(extra);
    const removed = await w.call("/v1/leagues/members/remove", { friend: owner.friend, body: { leagueId: setup.league.id, memberId: guest.ownerId } });
    expect(Object.keys(removed.json)).toEqual(["removed", "league"]);
    expect(removed.json.league).toMatchObject(extra);
  });

  it("a league and round_results made with the old schema gain the columns and read as the defaults", async () => {
    const state = sqliteState("old");
    const leagueId = `L${"a".repeat(21)}`;
    state.db.exec(`CREATE TABLE league (
      id INTEGER PRIMARY KEY CHECK (id = 1), league_id TEXT NOT NULL, name TEXT NOT NULL, owner_id TEXT NOT NULL,
      code TEXT NOT NULL, game TEXT NOT NULL, scoring TEXT NOT NULL, carry_over INTEGER NOT NULL, home_course TEXT,
      season_starts TEXT NOT NULL, season_ends TEXT NOT NULL, created_at INTEGER NOT NULL, round_day INTEGER)`);
    state.db.exec(`CREATE TABLE member (member_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL)`);
    state.db.exec(`CREATE TABLE round_results (round_id TEXT NOT NULL, played_on TEXT NOT NULL, finished INTEGER NOT NULL, member_id TEXT NOT NULL,
      unit TEXT NOT NULL, place INTEGER NOT NULL, net INTEGER, holes INTEGER NOT NULL, skins INTEGER, PRIMARY KEY (round_id, member_id))`);
    state.db.exec(`INSERT INTO league VALUES (1, '${leagueId}', 'Old League', 'o1', 'ABCDEFGH', 'strokePlay', 'gross', 0, NULL, '2026-11-01', '2027-03-31', 1, NULL)`);
    state.db.exec(`INSERT INTO member VALUES ('o1', 'Player A', 'owner', 1), ('o2', 'Player B', 'member', 2)`);
    state.db.exec(`INSERT INTO round_results VALUES ('old1', '2026-11-07', 1, 'o1', 'o1', 2, 3, 18, NULL), ('old1', '2026-11-07', 1, 'o2', 'o2', 1, 1, 18, NULL)`);
    const roster = new LeagueRoster(state, {});
    const op = async (body) => (await roster.fetch(new Request("https://league-roster.internal/roster", { method: "POST", body: JSON.stringify(body) }))).json();
    const preview = await op({ op: "preview" });
    expect(preview.league).toMatchObject({ gamePoints: DEFAULT_GAME_POINTS, pointsMode: "add" });
    const leagueCols = state.db.prepare("SELECT name FROM pragma_table_info('league')").all().map((c) => c.name);
    expect(leagueCols).toEqual(expect.arrayContaining(["game_points", "points_mode"]));
    const before = await op({ op: "standings", callerId: "o1" });
    expect(before.rounds[0]).toMatchObject({ pointsMode: "add" });
    expect(before.rounds[0].results.every((r) => r.gamePoints === undefined)).toBe(true);
    // Finishing a round here adds the three round_results columns; the old rows read as 0 and Add.
    const start = await op({
      op: "roundStart",
      callerId: "o1",
      now: 5,
      roundId: `${leagueId}_${"r".repeat(16)}`,
      start: roundBody(leagueId, ["o1", "o2"], { holes: HOLES_FRONT }),
    });
    expect(start.ok).toBe(true);
    expect((await op({ op: "roundFinish", callerId: "o1", now: 6, roundId: start.round.roundId })).ok).toBe(true);
    const cols = state.db.prepare("SELECT name FROM pragma_table_info('round_results')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["game_points", "points_mode", "incomplete"]));
    const old = state.db.prepare("SELECT game_points, points_mode, incomplete FROM round_results WHERE round_id = 'old1'").all();
    expect(old.map((r) => ({ ...r }))).toEqual([
      { game_points: null, points_mode: null, incomplete: null },
      { game_points: null, points_mode: null, incomplete: null },
    ]);
    const after = await op({ op: "standings", callerId: "o1" });
    const oldRound = after.rounds.find((r) => r.roundId === "old1");
    expect(oldRound.pointsMode).toBe("add");
    expect(oldRound.results.every((r) => r.gamePoints === undefined)).toBe(true);
  });
});
