// Leagues W-C: game points for all five games, Add/Replace standings, and parity with the app's
// engine (golden fixtures written by scripts/league-golden.mts). Made-up data only.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GAME_POINTS, leagueGamePoints, leagueRoundResults, mergeGamePoints, resolveGamePoints } from "./league-scoring.js";
import { leagueStandings } from "./leagues.js";
import { HOLES_18, HOLES_FRONT, byHole, leagueWorld, roundBody, scoreAll } from "./league-test-harness.js";

const PARS = HOLES_18.map((h) => h.par);

/** A pure round (leagueRound.ts LeagueRound) from per-player stroke arrays over `holes`. */
function mkRound({ game, scoring = "gross", holes = HOLES_18, carryOver = false, teams = null, players }) {
  const cells = {};
  for (const p of players) {
    p.scores.forEach((strokes, i) => {
      if (strokes == null) return;
      (cells[p.id] ??= {})[holes[i].number] = { strokes, rev: 1, enteredBy: "self", by: p.id, at: 1 };
    });
  }
  return {
    roundId: `${"L".repeat(22)}_${"r".repeat(16)}`,
    leagueId: "L".repeat(22),
    hostId: players[0].id,
    startedAt: 1,
    playedOn: "2026-11-21",
    course: "Mock Pines GC",
    holes,
    game,
    scoring,
    carryOver,
    teamsMode: teams ? "pairs" : null,
    teams,
    players: players.map((p) => ({ memberId: p.id, name: p.id, kind: "app", groupNo: 1, courseHandicap: p.hcp ?? null, hostEnters: false })),
    cells,
    finished: true,
  };
}

/** Par on every hole of `holes`, then the given offsets by index. */
function card(holes, offsets = {}) {
  return holes.map((h, i) => h.par + (offsets[i] ?? 0));
}

const pts = (round, values = DEFAULT_GAME_POINTS) => Object.fromEntries(leagueGamePoints(round, values));

describe("game points: match play", () => {
  it('"win 5 holes, halve 2 = 6 pts (5 + 2 × ½)"', () => {
    // 9 holes: A wins 0–4, halves 5–6, loses 7–8.
    const a = card(HOLES_FRONT, { 0: -1, 1: -1, 2: -1, 3: -1, 4: -1 });
    const b = card(HOLES_FRONT, { 7: -1, 8: -1 });
    const round = mkRound({ game: "matchPlay", holes: HOLES_FRONT, players: [{ id: "a", scores: a }, { id: "b", scores: b }] });
    expect(pts(round)).toEqual({ a: 6, b: 3 });
  });

  it("Per 9 and Full round go to the most hole-wins; a halved hole is ½ a win; 9 holes score both", () => {
    const a = card(HOLES_FRONT, { 0: -1, 1: -1 });
    const b = card(HOLES_FRONT, { 2: -1 });
    const values = { ...DEFAULT_GAME_POINTS, matchPlay: { perHole: 0, per9: 2, fullRound: 3 } };
    const round = mkRound({ game: "matchPlay", holes: HOLES_FRONT, players: [{ id: "a", scores: a }, { id: "b", scores: b }] });
    expect(pts(round, values)).toEqual({ a: 5, b: 0 });
    // Level on wins: both lines split.
    const level = mkRound({ game: "matchPlay", holes: HOLES_FRONT, players: [{ id: "a", scores: card(HOLES_FRONT, { 0: -1 }) }, { id: "b", scores: card(HOLES_FRONT, { 1: -1 }) }] });
    expect(pts(level, values)).toEqual({ a: 2.5, b: 2.5 });
  });

  it("18 holes: front, back and full round each count; a hole counts only when every unit scored", () => {
    const values = { ...DEFAULT_GAME_POINTS, matchPlay: { perHole: 1, per9: 2, fullRound: 3 } };
    const a = card(HOLES_18, { 0: -1, 1: -1, 9: 1, 10: 1, 11: 1 });
    const b = card(HOLES_18);
    b[17] = null; // hole 18 not counted
    a[16] = 9; // a loses hole 17
    const round = mkRound({ game: "matchPlay", players: [{ id: "a", scores: a }, { id: "b", scores: b }] });
    // a: holes 1, 2 won (front 2–0); b: holes 10, 11, 12, 17 won (back 4–0); full 2 v 4 → b.
    // Halved holes: front 7 (3–9), back 4 (13–16), ½ each = 5½ each. Front 9 → a, back 9 and full → b.
    expect(pts(round, values)).toEqual({ a: 2 + 5.5 + 2, b: 4 + 5.5 + 2 + 3 });
  });

  it("teams share: every player on a team gets the team's points (best ball)", () => {
    const teams = [{ teamNo: 1, memberIds: ["a", "c"] }, { teamNo: 2, memberIds: ["b", "d"] }];
    const players = [
      { id: "a", scores: card(HOLES_FRONT, { 0: -1, 1: 2 }) },
      { id: "b", scores: card(HOLES_FRONT, { 1: 1 }) },
      { id: "c", scores: card(HOLES_FRONT, { 2: -1 }) },
      { id: "d", scores: card(HOLES_FRONT, { 3: -1 }) },
    ];
    const round = mkRound({ game: "matchPlay", holes: HOLES_FRONT, teams, players });
    // Team 1 wins holes 1 and 3; team 2 wins hole 4 (hole 2: team 1 best 4 (c), team 2 best 4 (d) halved).
    const out = pts(round);
    expect(out.a).toBe(out.c);
    expect(out.b).toBe(out.d);
    expect(out.a).toBe(2 + 6 * 0.5);
    expect(out.b).toBe(1 + 6 * 0.5);
  });

  it("3 or more individual units: a hole's lowest score wins, ties share", () => {
    const round = mkRound({
      game: "matchPlay",
      holes: HOLES_FRONT,
      players: [
        { id: "a", scores: card(HOLES_FRONT, { 0: -1, 1: -1 }) },
        { id: "b", scores: card(HOLES_FRONT, { 1: -1 }) },
        { id: "c", scores: card(HOLES_FRONT, { 2: 1 }) },
      ],
    });
    // Hole 1: a. Hole 2: a+b ½ each. Hole 3: a+b ½ each. Holes 4–9: all three ⅓ each.
    const out = pts(round);
    expect(out.a).toBeCloseTo(1 + 0.5 + 0.5 + 6 / 3, 9);
    expect(out.b).toBeCloseTo(0.5 + 0.5 + 6 / 3, 9);
    expect(out.c).toBeCloseTo(6 / 3, 9);
  });
});

describe("game points: skins", () => {
  it('"win 3 skins, one a 2-hole carry-over = 4 pts (4 × 1)"', () => {
    // Carry on. Hole 1: a. Hole 2: tie (carries). Hole 3: a (worth 2). Hole 4: a. Then b wins 5 alone.
    const a = card(HOLES_FRONT, { 0: -1, 2: -1, 3: -1 });
    const b = card(HOLES_FRONT, { 4: -1 });
    const c = card(HOLES_FRONT, { 0: 1, 2: 1, 3: 1, 4: 1 });
    const round = mkRound({ game: "skins", holes: HOLES_FRONT, carryOver: true, players: [{ id: "a", scores: a }, { id: "b", scores: b }, { id: "c", scores: c }] });
    expect(leagueRoundResults(round).results.map((r) => r.skins)).toEqual([4, 1, 0]);
    expect(pts(round)).toEqual({ a: 4, b: 1, c: 0 });
    expect(pts(round, { ...DEFAULT_GAME_POINTS, skins: { perSkin: 3 } })).toEqual({ a: 12, b: 3, c: 0 });
  });

  it("carry off: a tied hole's skin is lost; skins stop at the first missing score", () => {
    const a = card(HOLES_FRONT, { 0: -1, 2: -1, 5: -1 });
    const b = card(HOLES_FRONT, { 4: -1 });
    b[3] = null; // nothing after hole 4 is settled
    const round = mkRound({ game: "skins", holes: HOLES_FRONT, carryOver: false, players: [{ id: "a", scores: a }, { id: "b", scores: b }] });
    expect(pts(round)).toEqual({ a: 2, b: 0 });
  });
});

describe("game points: stroke play", () => {
  const values = DEFAULT_GAME_POINTS;
  it('"low front 9 + low full round = 5 pts (2 + 3). Low back 9 too = 7 pts"', () => {
    const a = card(HOLES_18, { 0: -2, 9: 1 });
    const b = card(HOLES_18);
    expect(pts(mkRound({ game: "strokePlay", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }), values)).toEqual({ a: 5, b: 2 });
    const a2 = card(HOLES_18, { 0: -2, 9: -1 });
    expect(pts(mkRound({ game: "strokePlay", players: [{ id: "a", scores: a2 }, { id: "b", scores: b }] }), values)).toEqual({ a: 7, b: 0 });
  });

  it('"Tie for low front 9 = 1 pt each (2 ÷ 2)"', () => {
    const a = card(HOLES_18, { 9: -1 });
    const b = card(HOLES_18);
    expect(pts(mkRound({ game: "strokePlay", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }), values)).toEqual({ a: 1 + 2 + 3, b: 1 });
  });

  it("a 9-hole round scores Per 9 and Full round; 2 split 3 ways stays exact", () => {
    const players = ["a", "b", "c"].map((id) => ({ id, scores: card(HOLES_FRONT) }));
    const out = pts(mkRound({ game: "strokePlay", holes: HOLES_FRONT, players }), values);
    expect(out.a).toBe(2 / 3 + 1);
    expect(out.b).toBe(out.a);
    const back = HOLES_18.slice(9);
    const solo = pts(mkRound({ game: "strokePlay", holes: back, players: [{ id: "a", scores: card(back, { 0: -1 }) }, { id: "b", scores: card(back) }] }), values);
    expect(solo).toEqual({ a: 5, b: 0 });
  });

  it("only players who scored every hole of the segment are eligible; nobody eligible, nothing awarded", () => {
    const a = card(HOLES_18, { 0: -3 });
    a[12] = null; // a missed hole 13: not eligible for back 9 or full round
    const b = card(HOLES_18, { 14: 2 });
    expect(pts(mkRound({ game: "strokePlay", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }), values)).toEqual({ a: 2, b: 2 + 3 });
    const both = [card(HOLES_FRONT), card(HOLES_FRONT)].map((s, i) => ({ id: `p${i}`, scores: s.map((x, j) => (j === i ? null : x)) }));
    expect(pts(mkRound({ game: "strokePlay", holes: HOLES_FRONT, players: both }), values)).toEqual({ p0: 0, p1: 0 });
  });

  it("net uses strokes off the low course handicap", () => {
    // b is 1 over gross on the front but gets 2 strokes on the front (stroke index 1 and 2).
    const round = mkRound({
      game: "strokePlay",
      scoring: "net",
      holes: HOLES_FRONT,
      players: [{ id: "a", hcp: 0, scores: card(HOLES_FRONT) }, { id: "b", hcp: 4, scores: card(HOLES_FRONT, { 0: 1 }) }],
    });
    expect(pts(round)).toEqual({ a: 0, b: 5 });
  });
});

describe("game points: stableford", () => {
  it('"most points front 9 + full round = 5 pts (2 + 3). Back 9 too = 7 pts"', () => {
    // Eagle on 1 (+2 points), bogey on 10 (−1): most on the front and the round, fewer on the back.
    const a = card(HOLES_18, { 0: -2, 9: 1 });
    const b = card(HOLES_18);
    expect(pts(mkRound({ game: "stableford", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 5, b: 2 });
    const a2 = card(HOLES_18, { 0: -1, 9: -1 });
    expect(pts(mkRound({ game: "stableford", players: [{ id: "a", scores: a2 }, { id: "b", scores: b }] }))).toEqual({ a: 7, b: 0 });
  });

  it('"Tie for most on the front 9 = 1 pt each (2 ÷ 2)"', () => {
    const a = card(HOLES_18, { 9: -1 });
    const b = card(HOLES_18);
    expect(pts(mkRound({ game: "stableford", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 1 + 2 + 3, b: 1 });
  });

  it("uses max(0, 2 + par − score): a blow-up hole costs no more than 0 points", () => {
    // a: one eagle (4 pts) and one 10 (0 pts) = par otherwise; b: two birdies (3 + 3).
    const a = card(HOLES_FRONT, { 0: -2, 1: 6 });
    const b = card(HOLES_FRONT, { 0: -1, 1: -1 });
    // a = 4 + 0 + 7×2 = 18; b = 3 + 3 + 7×2 = 20. In stroke play a (+4) loses too, but the scales differ.
    expect(pts(mkRound({ game: "stableford", holes: HOLES_FRONT, players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 0, b: 5 });
    // Max(0, …) matters: a 10 on a par 4 is 0, not −4.
    const c = card(HOLES_FRONT, { 0: 2, 1: 6 }); // 0 + 0 + 14 = 14
    const d = card(HOLES_FRONT, { 0: 1, 1: 1 }); // 1 + 1 + 14 = 16
    expect(pts(mkRound({ game: "stableford", holes: HOLES_FRONT, players: [{ id: "c", scores: c }, { id: "d", scores: d }] }))).toEqual({ c: 0, d: 5 });
  });

  it("a hole with no par adds no points and does not block eligibility", () => {
    const holes = HOLES_FRONT.map((h) => (h.number === 3 ? { ...h, par: null } : h));
    const a = card(HOLES_FRONT, { 0: -1 });
    a[2] = null; // no score on the no-par hole: still eligible
    const b = card(HOLES_FRONT, { 2: -3 });
    expect(pts(mkRound({ game: "stableford", holes, players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 5, b: 0 });
  });
});

describe("game points: nassau", () => {
  it('"win the front 9, halve the back 9, win overall = 2½ pts (1 + ½ + 1)"', () => {
    const a = card(HOLES_18, { 0: -1, 9: -1 });
    const b = card(HOLES_18, { 10: -1 });
    expect(pts(mkRound({ game: "nassau", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 2.5, b: 0.5 });
  });

  it("a clean sweep of one match is 3; a 9-hole Nassau scores its nine and the overall", () => {
    const a = card(HOLES_18, { 0: -1, 9: -1 });
    const b = card(HOLES_18);
    expect(pts(mkRound({ game: "nassau", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 3, b: 0 });
    const nine = mkRound({ game: "nassau", holes: HOLES_FRONT, players: [{ id: "a", scores: card(HOLES_FRONT, { 0: -1 }) }, { id: "b", scores: card(HOLES_FRONT) }] });
    expect(pts(nine)).toEqual({ a: 2, b: 0 });
  });

  it("teams: every player on the team gets the team's points", () => {
    const teams = [{ teamNo: 1, memberIds: ["a", "c"] }, { teamNo: 2, memberIds: ["b", "d"] }];
    const players = [
      { id: "a", scores: card(HOLES_18, { 0: -1 }) },
      { id: "b", scores: card(HOLES_18, { 9: -1, 10: -1 }) },
      { id: "c", scores: card(HOLES_18, { 0: 3 }) },
      { id: "d", scores: card(HOLES_18) },
    ];
    // Front: team 1 (hole 1). Back: team 2 (holes 10, 11). Overall: team 2 (2 v 1).
    const out = pts(mkRound({ game: "nassau", teams, players }));
    expect(out).toEqual({ a: 1, c: 1, b: 2, d: 2 });
  });

  it("3 teams: each pairing is its own match, so points add up across pairings", () => {
    const teams = [1, 2, 3].map((n) => ({ teamNo: n, memberIds: [`p${n}a`, `p${n}b`] }));
    const players = teams.flatMap((t) => t.memberIds.map((id) => ({ id, scores: card(HOLES_18, t.teamNo === 1 ? { 0: -1, 9: -1 } : {}) })));
    // Team 1 sweeps both of its matches (3 + 3); teams 2 and 3 halve all three segments (½ × 3 each).
    expect(pts(mkRound({ game: "nassau", teams, players }))).toEqual({ p1a: 6, p1b: 6, p2a: 1.5, p2b: 1.5, p3a: 1.5, p3b: 1.5 });
  });

  it("a missing score is skipped, not a stop; a segment with no counted hole awards nothing", () => {
    const a = card(HOLES_18, { 5: -1 });
    a[0] = null;
    const b = card(HOLES_18);
    for (let i = 9; i < 18; i += 1) b[i] = null; // no back 9 for b
    // Front: a wins hole 6 after the miss on hole 1. Back: nothing counted. Overall: a.
    expect(pts(mkRound({ game: "nassau", players: [{ id: "a", scores: a }, { id: "b", scores: b }] }))).toEqual({ a: 2, b: 0 });
  });
});

describe("game points: general", () => {
  it("a 1-unit round gives 0 in every game", () => {
    for (const game of ["matchPlay", "skins", "strokePlay", "stableford", "nassau"]) {
      expect(pts(mkRound({ game, players: [{ id: "a", scores: card(HOLES_18, { 0: -1 }) }] })), game).toEqual({ a: 0 });
    }
  });

  it("partial gamePoints merge over stored values; a stored object missing stableford and nassau resolves them to the defaults", () => {
    expect(resolveGamePoints({ matchPlay: { perHole: 2, per9: 1, fullRound: 1 }, skins: { perSkin: 2 }, strokePlay: { per9: 1, fullRound: 1 } })).toEqual({
      matchPlay: { perHole: 2, per9: 1, fullRound: 1 },
      skins: { perSkin: 2 },
      strokePlay: { per9: 1, fullRound: 1 },
      stableford: { per9: 2, fullRound: 3 },
      nassau: { per9: 1, fullRound: 1 },
    });
    expect(mergeGamePoints({ skins: { perSkin: 4 } }, { nassau: { per9: 0 } })).toEqual({ ...DEFAULT_GAME_POINTS, skins: { perSkin: 4 }, nassau: { per9: 0, fullRound: 1 } });
    for (const bad of [{ wolf: {} }, { skins: { perHole: 1 } }, { skins: { perSkin: 21 } }, { skins: 1 }, []]) expect(mergeGamePoints(null, bad)).toBeNull();
    expect(mergeGamePoints(null, { skins: { perSkin: 20 } }).skins.perSkin).toBe(20);
  });
});

describe("standings with game points", () => {
  const season = { starts: "2026-11-01", ends: "2027-03-31" };
  const row = (id, place, gamePoints) => ({ memberId: id, unit: id, place, net: null, holes: 18, skins: null, gamePoints });

  it('Add: "finish 2nd (5) + 5 game pts = 10 pts"; Replace: "finish 2nd (0) + 5 game pts = 5 pts"', () => {
    const results = [row("a", 1, 0), row("b", 2, 5)];
    const add = leagueStandings({ season, rounds: [{ roundId: "r", playedOn: "2026-11-07", finished: true, pointsMode: "add", results }] });
    expect(add.rows.find((r) => r.memberId === "b")).toMatchObject({ points: 10, gamePoints: 5 });
    const replace = leagueStandings({ season, rounds: [{ roundId: "r", playedOn: "2026-11-07", finished: true, pointsMode: "replace", results }] });
    expect(replace.rows.find((r) => r.memberId === "b")).toMatchObject({ points: 5, gamePoints: 5 });
    expect(replace.rows.find((r) => r.memberId === "a")).toMatchObject({ points: 0, gamePoints: 0 });
  });

  it("3 tied for 5th = 4/3 exactly (to 1e-9), not 1.5, and they share the rank", () => {
    const results = [row("a", 1, 0), row("b", 2, 0), row("c", 3, 0), row("d", 4, 0), row("e", 5, 0), row("f", 5, 0), row("g", 5, 0)];
    const table = leagueStandings({ season, rounds: [{ roundId: "r", playedOn: "2026-11-07", finished: true, pointsMode: "add", results }] });
    const tied = table.rows.filter((r) => ["e", "f", "g"].includes(r.memberId));
    for (const r of tied) {
      expect(Math.abs(r.points - 4 / 3)).toBeLessThan(1e-9);
      expect(r.rank).toBe(5);
      expect(r.tied).toBe(true);
    }
  });

  it("points equal within 1e-9 share a rank (exact thirds adding up differently)", () => {
    const rounds = [
      { roundId: "1", playedOn: "2026-11-07", finished: true, pointsMode: "replace", results: [row("a", 1, 0.1), row("b", 1, 0.2)] },
      { roundId: "2", playedOn: "2026-11-14", finished: true, pointsMode: "replace", results: [row("a", 1, 0.2), row("b", 1, 0.1)] },
    ];
    const table = leagueStandings({ season, rounds });
    expect(table.rows.map((r) => [r.rank, r.tied])).toEqual([
      [1, true],
      [1, true],
    ]);
  });
});

describe("game points end to end (decision 23)", () => {
  let w;
  beforeEach(() => {
    w = leagueWorld();
    w.install();
  });
  afterEach(() => {
    w.uninstall();
    vi.restoreAllMocks();
  });

  async function playNine(setup, game, a, b, extra = {}) {
    const [p1, p2] = setup.people;
    const ids = [p1.ownerId, p2.ownerId];
    const start = await w.call("/v1/leagues/rounds", { friend: p1.friend, body: roundBody(setup.league.id, ids, { game, holes: HOLES_FRONT, ...extra }) });
    expect(start.status).toBe(200);
    const rid = start.json.round.roundId;
    await scoreAll(w, p1.friend, rid, ids[0], byHole(HOLES_FRONT, a));
    return { rid, ids, finishLast: () => scoreAll(w, p2.friend, rid, ids[1], byHole(HOLES_FRONT, b)) };
  }

  const settings = (leagueId, extra) => ({
    leagueId,
    name: "Saturday Crew",
    game: "strokePlay",
    scoring: "gross",
    carryOver: false,
    homeCourse: "Mock Pines GC",
    seasonStarts: "2026-11-01",
    seasonEnds: "2027-03-31",
    roundDay: null,
    ...extra,
  });

  it("a round keeps the values and mode it started with, even when settings change while it is live", async () => {
    const setup = await w.league(2);
    const [owner] = setup.people;
    const play = await playNine(setup, "strokePlay", card(HOLES_FRONT, { 0: -1 }), card(HOLES_FRONT));
    // While live: switch to Replace and change stroke play's values.
    const change = await w.call("/v1/leagues/settings", {
      friend: owner.friend,
      body: settings(setup.league.id, { gamePoints: { strokePlay: { per9: 10, fullRound: 10 } }, pointsMode: "replace" }),
    });
    expect(change.status).toBe(200);
    await play.finishLast();
    const db = w.roster(setup.league.id).db;
    const stored = db.prepare("SELECT member_id, game_points, points_mode FROM round_results ORDER BY member_id").all().map((r) => ({ ...r }));
    expect(stored).toEqual(
      [
        { member_id: play.ids[0], game_points: 5, points_mode: "add" },
        { member_id: play.ids[1], game_points: 0, points_mode: "add" },
      ].sort((x, y) => (x.member_id < y.member_id ? -1 : 1)),
    );
    const table = await w.call(`/v1/leagues/standings?league=${setup.league.id}`, { method: "GET", friend: owner.friend });
    expect(table.json.rows.map((r) => [r.memberId, r.points, r.gamePoints])).toEqual([
      [play.ids[0], 6 + 5, 5],
      [play.ids[1], 5, 0],
    ]);
  });

  it("a league switched Add → Replace after a finished round keeps that round on Add", async () => {
    const setup = await w.league(2);
    const [owner] = setup.people;
    const play = await playNine(setup, "strokePlay", card(HOLES_FRONT), card(HOLES_FRONT, { 0: -1 }));
    await play.finishLast();
    const path = `/v1/leagues/standings?league=${setup.league.id}`;
    const before = await w.call(path, { method: "GET", friend: owner.friend });
    expect(before.json.rows.map((r) => [r.memberId, r.points])).toEqual([
      [play.ids[1], 6 + 5],
      [play.ids[0], 5],
    ]);
    expect((await w.call("/v1/leagues/settings", { friend: owner.friend, body: settings(setup.league.id, { pointsMode: "replace" }) })).status).toBe(200);
    const after = await w.call(path, { method: "GET", friend: owner.friend });
    expect(after.json).toEqual(before.json);
    // The next round is on Replace: only game points count for it.
    const next = await playNine(setup, "strokePlay", card(HOLES_FRONT, { 0: -1 }), card(HOLES_FRONT));
    await next.finishLast();
    const third = await w.call(path, { method: "GET", friend: owner.friend });
    expect(Object.fromEntries(third.json.rows.map((r) => [r.memberId, r.points]))).toEqual({ [play.ids[1]]: 11, [play.ids[0]]: 5 + 5 });
  });

  it("Nassau 2½ is stored as 5/2 exactly (a number, not a display string)", async () => {
    const setup = await w.league(2);
    const [owner, guest] = setup.people;
    const ids = [owner.ownerId, guest.ownerId];
    const start = await w.call("/v1/leagues/rounds", { friend: owner.friend, body: roundBody(setup.league.id, ids, { game: "nassau" }) });
    const rid = start.json.round.roundId;
    await scoreAll(w, owner.friend, rid, ids[0], byHole(HOLES_18, card(HOLES_18, { 0: -1, 9: -1 })));
    await scoreAll(w, guest.friend, rid, ids[1], byHole(HOLES_18, card(HOLES_18, { 10: -1 })));
    const db = w.roster(setup.league.id).db;
    const row = db.prepare("SELECT game_points, typeof(game_points) AS t FROM round_results WHERE member_id = ?").get(ids[0]);
    expect(row.game_points).toBe(5 / 2);
    expect(row.t).toBe("real");
    const live = await w.call(`/v1/leagues/rounds?league=${setup.league.id}&since=0`, { method: "GET", friend: guest.friend });
    expect(live.json.round).toMatchObject({ finished: true, pointsMode: "add", gamePoints: DEFAULT_GAME_POINTS });
  });
});

describe("parity with the app's leagueRoundResults (golden fixtures)", () => {
  const golden = JSON.parse(readFileSync(new URL("./test/fixtures/league-round-results.golden.json", import.meta.url), "utf8"));
  const strip = (r) => ({ ...r, results: r.results.map(({ gamePoints, ...rest }) => rest) });

  it("has at least 12 made-up rounds covering the required cases", () => {
    expect(golden.fixtures.length).toBeGreaterThanOrEqual(12);
    const names = golden.fixtures.map((f) => f.name);
    for (const n of ["stroke gross 2p", "stroke net 2p", "net blank handicap", "nine front net", "nine back gross", "skins carry on", "skins carry off", "match 2p", "match 4p pairs", "match 3 teams", "nassau teams", "stableford", "incomplete player", "hole with no par"]) {
      expect(names).toContain(n);
    }
  });

  for (const fixture of golden.fixtures) {
    it(`matches the app: ${fixture.name}`, () => {
      expect(strip(leagueRoundResults(fixture.round))).toEqual(strip(fixture.expected));
      expect(JSON.stringify(strip(leagueRoundResults(fixture.round)))).toBe(JSON.stringify(strip(fixture.expected)));
    });
  }
});
