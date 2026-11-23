// Leagues W-B: Brian's answers to the PR #71 open questions (Nov 23 2026). Made-up data only.
// 1. Remove, leave and hand-over are allowed anytime, including during a live round.
// 2. Removing a no-app spot with a pending claim cancels the claim, clears the claimer's
//    lg:claim: pointer when it names that claim, and pushes to the claimer only.
// 3. A claimer who joined while their claim was pending keeps the claim; approving merges the
//    spot into their member row; declining leaves their joined spot alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEAGUE_MAX_PLAYERS } from "./leagues.js";
import { leagueWorld, roundBody } from "./league-test-harness.js";

const TOKEN = (n) => `ExponentPushToken[tok${n}]`;

let w;
beforeEach(() => {
  w = leagueWorld();
  w.install();
});
afterEach(() => {
  w.uninstall();
  vi.restoreAllMocks();
});

const post = (p, path, body) => w.call(path, { friend: p.friend, body });
const get = (p, path) => w.call(path, { method: "GET", friend: p.friend });
const addNoApp = (p, leagueId, name) => post(p, "/v1/leagues/members/no-app", { leagueId, name });
const claim = (p, code, spotMemberId, name = "Player K") => post(p, "/v1/leagues/claims", { code, spotMemberId, name });
const act = (p, action, claimId) => post(p, `/v1/leagues/claims/${action}`, { claimId });
const remove = (p, leagueId, memberId) => post(p, "/v1/leagues/members/remove", { leagueId, memberId });
const join = (p, code, name) => post(p, "/v1/leagues/join", { code, name });
const members = (p, leagueId) => get(p, `/v1/leagues/members?league=${leagueId}`);

function table(leagueId, sql, ...args) {
  return w.roster(leagueId).db.prepare(sql).all(...args).map((r) => ({ ...r }));
}

describe("1. remove, leave and hand-over during a live round", () => {
  it("all three are allowed while a round is live, and the round is not touched", async () => {
    const setup = await w.league(4);
    const [a, b, c, d] = setup.people;
    const id = setup.league.id;
    const spot = (await addNoApp(a, id, "Player N")).json.member;
    const ids = [a.ownerId, b.ownerId, c.ownerId, d.ownerId, spot.memberId];
    const start = await post(a, "/v1/leagues/rounds", roundBody(id, ids));
    expect(start.status).toBe(200);
    const roundId = start.json.round.roundId;
    for (const [p, m] of [[a, a.ownerId], [b, b.ownerId], [c, c.ownerId], [a, spot.memberId]]) {
      expect((await post(p, "/v1/leagues/rounds/score", { roundId, memberId: m, hole: 1, strokes: 4, rev: 1 })).status).toBe(200);
    }
    const roundBefore = table(id, "SELECT * FROM league_round");
    const cellsBefore = table(id, "SELECT * FROM round_cell ORDER BY member_id, hole");
    const historyBefore = table(id, "SELECT * FROM round_history ORDER BY seq");

    expect((await remove(a, id, c.ownerId)).status).toBe(200);
    expect((await remove(a, id, spot.memberId)).status).toBe(200);
    expect((await post(b, "/v1/leagues/members/leave", { leagueId: id })).status).toBe(200);
    const handed = await post(a, "/v1/leagues/members/handover", { leagueId: id, memberId: d.ownerId });
    expect(handed.status).toBe(200);
    expect(handed.json.league).toMatchObject({ ownerId: d.ownerId, players: 1 });

    // The live round is exactly as it was: still live, same players, cells and history.
    expect(table(id, "SELECT * FROM league_round")).toEqual(roundBefore);
    expect(roundBefore[0].finished).toBe(0);
    expect(table(id, "SELECT * FROM round_cell ORDER BY member_id, hole")).toEqual(cellsBefore);
    expect(table(id, "SELECT * FROM round_history ORDER BY seq")).toEqual(historyBefore);
    const live = await get(d, `/v1/leagues/rounds?league=${id}`);
    expect(live.status).toBe(200);
    expect(live.json.round.roundId).toBe(roundId);
    expect(live.json.round.players.map((p) => p.memberId)).toEqual(ids);
  });
});

describe("2. removing a no-app spot that has a pending claim", () => {
  async function pending() {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const id = setup.league.id;
    const n = (await addNoApp(b, id, "Player N")).json.member;
    const m = (await addNoApp(b, id, "Player M")).json.member;
    w.kv.set(`fr:push:${a.ownerId}`, TOKEN(1));
    w.kv.set(`fr:push:${b.ownerId}`, TOKEN(2));
    const k = await w.player(11);
    w.kv.set(`fr:push:${k.ownerId}`, TOKEN(11));
    const c = (await claim(k, setup.code, n.memberId)).json.claim;
    w.pushes.length = 0; // the W14 push to the organizer
    return { ...setup, a, b, id, n, m, k, c };
  }

  it("cancels the claim, clears the claimer's pointer, and keeps the remove answer as before", async () => {
    const { a, id, n, k, c } = await pending();
    expect(w.kv.get(`lg:claim:${k.ownerId}`)).toBe(c.claimId);
    const res = await remove(a, id, n.memberId);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["removed", "league"]);
    expect(res.json.removed).toBe(n.memberId);
    const list = await get(a, `/v1/leagues/claims?league=${id}`);
    expect(list.json.claims).toEqual([{ ...c, status: "cancelled" }]);
    expect(table(id, "SELECT COUNT(*) AS n FROM claim WHERE status = 'pending'")).toEqual([{ n: 0 }]);
    expect(w.kv.has(`lg:claim:${k.ownerId}`)).toBe(false);
    expect((await get(k, "/v1/leagues/claims/mine")).json).toEqual({ claim: null, league: null });
  });

  it("the claimer is free to claim again: no already_pending", async () => {
    const { a, id, n, m, k, code } = await pending();
    expect((await remove(a, id, n.memberId)).status).toBe(200);
    const again = await claim(k, code, m.memberId);
    expect(again.status).toBe(200);
    expect(again.json.claim.status).toBe("pending");
  });

  it("pushes to the claimer only, once, with the claim's ids", async () => {
    const { a, id, n, k, c } = await pending();
    expect((await remove(a, id, n.memberId)).status).toBe(200);
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0].messages).toEqual([
      {
        to: TOKEN(11),
        // Brian, Nov 23 2026, 2:17 PM CT: the title is the league name only.
        title: "Saturday Crew",
        body: "The organizer removed Player N's spot, so your claim was cancelled.",
        sound: "default",
        data: { kind: "league_claim_cancelled", leagueId: id, claimId: c.claimId },
      },
    ]);
  });

  it("cancels the claim but leaves a pointer that names a different claim alone", async () => {
    const { a, id, n, k, c } = await pending();
    const other = `${"Q".repeat(22)}_${"q".repeat(16)}`;
    w.kv.set(`lg:claim:${k.ownerId}`, other);
    expect((await remove(a, id, n.memberId)).status).toBe(200);
    expect(table(id, "SELECT status FROM claim WHERE claim_id = ?", c.claimId)).toEqual([{ status: "cancelled" }]);
    expect(w.kv.get(`lg:claim:${k.ownerId}`)).toBe(other);
  });

  it("a declined or cancelled claim is not touched and nobody is pushed; with no valid token the claim is cancelled without a push", async () => {
    const { a, id, n, m, k, c, code } = await pending();
    expect((await act(a, "decline", c.claimId)).status).toBe(200);
    expect((await remove(a, id, n.memberId)).status).toBe(200);
    expect(table(id, "SELECT status FROM claim")).toEqual([{ status: "declined" }]);
    expect(w.pushes).toHaveLength(0);
    expect(w.kv.get(`lg:claim:${k.ownerId}`)).toBe(c.claimId);
    // A pending claim on M, but no valid token: the claim is still cancelled, with no push.
    const c2 = (await claim(k, code, m.memberId)).json.claim;
    w.pushes.length = 0;
    w.kv.set(`fr:push:${k.ownerId}`, "not-a-token");
    expect((await remove(a, id, m.memberId)).status).toBe(200);
    expect(table(id, "SELECT status FROM claim WHERE claim_id = ?", c2.claimId)).toEqual([{ status: "cancelled" }]);
    expect(w.pushes).toHaveLength(0);
  });

  it("a push failure never fails the remove", async () => {
    const { a, id, n, c } = await pending();
    w.pushFails = true;
    expect((await remove(a, id, n.memberId)).status).toBe(200);
    expect(table(id, "SELECT status FROM claim WHERE claim_id = ?", c.claimId)).toEqual([{ status: "cancelled" }]);
    expect(w.pushes).toHaveLength(1);
  });

  // Brian, Nov 23 2026, 2:17 PM CT: this push is sent even when the two are blocked either way.
  for (const way of ["claimer blocked organizer", "organizer blocked claimer"]) {
    it(`blocked either way (${way}): the claim is cancelled and the claimer still gets the push`, async () => {
      const { a, id, n, k, c } = await pending();
      const pair = way === "claimer blocked organizer" ? `${k.ownerId}:${a.ownerId}` : `${a.ownerId}:${k.ownerId}`;
      w.kv.set(`fr:block:${pair}`, "1");
      expect((await remove(a, id, n.memberId)).status).toBe(200);
      expect(table(id, "SELECT status FROM claim WHERE claim_id = ?", c.claimId)).toEqual([{ status: "cancelled" }]);
      expect(w.kv.has(`lg:claim:${k.ownerId}`)).toBe(false);
      expect(w.pushes).toHaveLength(1);
      expect(w.pushes[0].messages).toEqual([
        {
          to: TOKEN(11),
          title: "Saturday Crew",
          body: "The organizer removed Player N's spot, so your claim was cancelled.",
          sound: "default",
          data: { kind: "league_claim_cancelled", leagueId: id, claimId: c.claimId },
        },
      ]);
    });
  }

  it("the other league pushes keep their block skip: W5 sends nothing across a block", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const id = setup.league.id;
    w.kv.set(`fr:push:${a.ownerId}`, TOKEN(1));
    w.kv.set(`fr:push:${b.ownerId}`, TOKEN(2));
    const n = (await addNoApp(a, id, "Player N")).json.member;
    w.kv.set(`fr:block:${b.ownerId}:${a.ownerId}`, "1");
    // W5: B blocked A, the starter, so B gets nothing.
    expect((await post(a, "/v1/leagues/rounds", roundBody(id, [a.ownerId, n.memberId]))).status).toBe(200);
    expect(w.pushes).toHaveLength(0);
  });
});

describe("3. the claimer joins while their claim is pending", () => {
  /** League with N (no-app, in a finished host-entered round); K claims N, then joins with the code. */
  async function joinedWhilePending(extraSpots = 0) {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const id = setup.league.id;
    const n = (await addNoApp(b, id, "Player N")).json.member;
    for (let i = 0; i < extraSpots; i += 1) expect((await addNoApp(a, id, `Player S${i}`)).status).toBe(200);
    const start = await post(a, "/v1/leagues/rounds", roundBody(id, [a.ownerId, b.ownerId, n.memberId]));
    const roundId = start.json.round.roundId;
    for (const [p, m, s] of [[a, a.ownerId, 4], [b, b.ownerId, 5], [a, n.memberId, 3]]) {
      expect((await post(p, "/v1/leagues/rounds/score", { roundId, memberId: m, hole: 1, strokes: s, rev: 1 })).status).toBe(200);
    }
    expect((await post(a, "/v1/leagues/rounds/finish", { roundId })).status).toBe(200);
    const k = await w.player(11);
    const c = (await claim(k, setup.code, n.memberId, "Player K")).json.claim;
    const joined = await join(k, setup.code, "Player Kay");
    expect(joined.status).toBe(200);
    expect(joined.json.joined).toBe(true);
    return { ...setup, a, b, id, n, k, c, roundId };
  }

  it("the claim stays pending after the join, and the organizer can still approve it", async () => {
    const { a, id, k, c } = await joinedWhilePending();
    expect((await get(a, `/v1/leagues/claims?league=${id}`)).json.claims).toEqual([c]);
    expect((await get(k, "/v1/leagues/claims/mine")).json.claim).toEqual(c);
    expect(await act(a, "approve", c.claimId)).toMatchObject({ status: 200, json: { claim: { ...c, status: "approved" } } });
  });

  it("approve merges the spot into the joined member: one row, the spot's results, cells and history, host cells kept", async () => {
    const { a, b, id, n, k, c, roundId } = await joinedWhilePending();
    const kRow = table(id, "SELECT * FROM member WHERE member_id = ?", k.ownerId)[0];
    const standingsBefore = (await get(a, `/v1/leagues/standings?league=${id}`)).json;
    const spotRow = standingsBefore.rows.find((r) => r.memberId === n.memberId);
    const historyBefore = table(id, "SELECT hole, strokes, rev, entered_by, by_id FROM round_history WHERE member_id = ? ORDER BY seq", n.memberId);
    const playersBefore = (await members(a, id)).json.league.players;

    const res = await act(a, "approve", c.claimId);
    expect(res.status).toBe(200);
    expect(res.json.claim).toEqual({ ...c, status: "approved" });

    // No duplicate: K once (their joined row as it was), N gone.
    expect(table(id, "SELECT * FROM member WHERE member_id = ?", k.ownerId)).toEqual([kRow]);
    for (const t of ["member", "round_results", "round_cell", "round_history", "last_seen"]) {
      expect(table(id, `SELECT COUNT(*) AS n FROM ${t} WHERE member_id = ?`, n.memberId), t).toEqual([{ n: 0 }]);
    }
    const list = (await members(a, id)).json;
    expect(list.members.filter((m) => m.memberId === k.ownerId)).toHaveLength(1);
    expect(list.league.players).toBe(playersBefore - 1);
    // Cells and history moved; host-entered cells stay host.
    expect(table(id, "SELECT hole, strokes, entered_by, by_id FROM round_cell WHERE member_id = ?", k.ownerId)).toEqual([
      { hole: 1, strokes: 3, entered_by: "host", by_id: a.ownerId },
    ]);
    expect(table(id, "SELECT hole, strokes, rev, entered_by, by_id FROM round_history WHERE member_id = ? ORDER BY seq", k.ownerId)).toEqual(historyBefore);
    const players = JSON.parse(table(id, "SELECT players FROM league_round WHERE round_id = ?", roundId)[0].players);
    expect(players.map((p) => p.memberId)).toEqual([a.ownerId, b.ownerId, k.ownerId]);
    // Standings: K's row carries the spot's points.
    const after = (await get(k, `/v1/leagues/standings?league=${id}`)).json;
    const { memberId: _x, name: _y, ...spotRest } = spotRow;
    const { memberId: _z, name, ...kRest } = after.rows.find((r) => r.memberId === k.ownerId);
    expect(kRest).toEqual(spotRest);
    expect(name).toBe("Player Kay");
  });

  it("the merge never trips the 20-player cap: approve works in a full league and frees a place", async () => {
    // 2 app members + N + 16 more spots = 19; K joins = 20.
    const { a, id, k, c } = await joinedWhilePending(LEAGUE_MAX_PLAYERS - 4);
    expect((await members(a, id)).json.league.players).toBe(LEAGUE_MAX_PLAYERS);
    const res = await act(a, "approve", c.claimId);
    expect(res.status).toBe(200);
    expect(table(id, "SELECT COUNT(*) AS n FROM member")).toEqual([{ n: LEAGUE_MAX_PLAYERS - 1 }]);
    expect(table(id, "SELECT COUNT(*) AS n FROM member WHERE member_id = ?", k.ownerId)).toEqual([{ n: 1 }]);
  });

  it("decline leaves the joined spot alone and the no-app spot unclaimed", async () => {
    const { a, id, n, k, c } = await joinedWhilePending();
    const before = table(id, "SELECT * FROM member ORDER BY member_id");
    const res = await act(a, "decline", c.claimId);
    expect(res.json.claim).toEqual({ ...c, status: "declined" });
    expect(table(id, "SELECT * FROM member ORDER BY member_id")).toEqual(before);
    const list = (await members(k, id)).json.members;
    expect(list.find((m) => m.memberId === k.ownerId)).toMatchObject({ name: "Player Kay", role: "member" });
    expect(list.find((m) => m.memberId === n.memberId)).toMatchObject({ kind: "noApp", name: "Player N" });
  });
});

describe("4. approve when the claimer and the spot played the same round (Brian, Nov 23, 2:17 PM CT)", () => {
  /**
   * A and N play round R1 (N only, besides A). K claims N, joins, and plays R2 with A and N
   * (N host-entered by A). Hole 1: R1 A 5, N 3. R2 A 5, K 4, N 3.
   */
  async function sharedRound() {
    const setup = await w.league(2);
    const [a] = setup.people;
    const id = setup.league.id;
    const n = (await addNoApp(a, id, "Player N")).json.member;
    const play = async (ids, strokes) => {
      const start = await post(a, "/v1/leagues/rounds", roundBody(id, ids.map((x) => x.id)));
      expect(start.status).toBe(200);
      const roundId = start.json.round.roundId;
      for (const [i, x] of ids.entries()) {
        expect((await post(x.by, "/v1/leagues/rounds/score", { roundId, memberId: x.id, hole: 1, strokes: strokes[i], rev: 1 })).status).toBe(200);
      }
      // A second edit of N's cell, so N has more than one history row in the round.
      expect((await post(a, "/v1/leagues/rounds/score", { roundId, memberId: n.memberId, hole: 1, strokes: 3, rev: 2 })).status).toBe(200);
      expect((await post(a, "/v1/leagues/rounds/finish", { roundId })).status).toBe(200);
      return roundId;
    };
    const r1 = await play([{ id: a.ownerId, by: a }, { id: n.memberId, by: a }], [5, 3]);
    const k = await w.player(11);
    const c = (await claim(k, setup.code, n.memberId, "Player K")).json.claim;
    expect((await join(k, setup.code, "Player Kay")).status).toBe(200);
    const r2 = await play([{ id: a.ownerId, by: a }, { id: k.ownerId, by: k }, { id: n.memberId, by: a }], [5, 4, 3]);
    return { ...setup, a, id, n, k, c, r1, r2 };
  }

  it("approve merges instead of 409: the claimer's own entries in the shared round are kept, the spot's dropped", async () => {
    const { a, id, n, k, c, r1, r2 } = await sharedRound();
    const kR2 = {
      results: table(id, "SELECT * FROM round_results WHERE round_id = ? AND member_id = ?", r2, k.ownerId),
      cells: table(id, "SELECT * FROM round_cell WHERE round_id = ? AND member_id = ?", r2, k.ownerId),
      history: table(id, "SELECT round_id, member_id, hole, strokes, rev, entered_by, by_id, at FROM round_history WHERE round_id = ? AND member_id = ? ORDER BY seq", r2, k.ownerId),
    };
    const nR1 = {
      cells: table(id, "SELECT hole, strokes, rev, entered_by, by_id, at FROM round_cell WHERE round_id = ? AND member_id = ?", r1, n.memberId),
      history: table(id, "SELECT hole, strokes, rev, entered_by, by_id, at FROM round_history WHERE round_id = ? AND member_id = ? ORDER BY seq", r1, n.memberId),
    };
    const kRow = table(id, "SELECT * FROM member WHERE member_id = ?", k.ownerId);

    const res = await act(a, "approve", c.claimId);
    expect(res.status).toBe(200);
    expect(res.json.claim).toEqual({ ...c, status: "approved" });

    // Nothing left under the spot's id; one member row for K, as it was.
    for (const t of ["member", "round_results", "round_cell", "round_history", "last_seen"]) {
      expect(table(id, `SELECT COUNT(*) AS n FROM ${t} WHERE member_id = ?`, n.memberId), t).toEqual([{ n: 0 }]);
    }
    expect(table(id, "SELECT * FROM member WHERE member_id = ?", k.ownerId)).toEqual(kRow);
    // R2 (shared): K's own results, cells and history exactly as before; the spot's are gone.
    expect(table(id, "SELECT * FROM round_results WHERE round_id = ? AND member_id = ?", r2, k.ownerId)).toEqual(kR2.results);
    expect(table(id, "SELECT * FROM round_cell WHERE round_id = ? AND member_id = ?", r2, k.ownerId)).toEqual(kR2.cells);
    expect(
      table(id, "SELECT round_id, member_id, hole, strokes, rev, entered_by, by_id, at FROM round_history WHERE round_id = ? AND member_id = ? ORDER BY seq", r2, k.ownerId),
    ).toEqual(kR2.history);
    expect(kR2.cells[0]).toMatchObject({ strokes: 4, entered_by: "self" });
    const p2 = JSON.parse(table(id, "SELECT players FROM league_round WHERE round_id = ?", r2)[0].players);
    expect(p2.map((p) => p.memberId)).toEqual([a.ownerId, k.ownerId]);
    expect(p2[1]).toMatchObject({ kind: "app", hostEnters: false });
    // R1 (spot only): moved to K as in W10, host-entered cells stay host.
    expect(table(id, "SELECT hole, strokes, rev, entered_by, by_id, at FROM round_cell WHERE round_id = ? AND member_id = ?", r1, k.ownerId)).toEqual(nR1.cells);
    expect(nR1.cells[0]).toMatchObject({ entered_by: "host", by_id: a.ownerId });
    expect(table(id, "SELECT hole, strokes, rev, entered_by, by_id, at FROM round_history WHERE round_id = ? AND member_id = ? ORDER BY seq", r1, k.ownerId)).toEqual(nR1.history);
    const p1 = JSON.parse(table(id, "SELECT players FROM league_round WHERE round_id = ?", r1)[0].players);
    expect(p1.map((p) => [p.memberId, p.kind, p.hostEnters])).toEqual([[a.ownerId, "app", false], [k.ownerId, "app", true]]);
  });

  it("standings recompute: the shared round is scored without the spot, the spot-only round goes to the claimer", async () => {
    const { a, id, k, c, people } = await sharedRound();
    expect((await act(a, "approve", c.claimId)).status).toBe(200);
    const st = (await get(k, `/v1/leagues/standings?league=${id}`)).json;
    expect(st.rounds).toBe(2);
    const rows = Object.fromEntries(st.rows.map((r) => [r.memberId, { rounds: r.rounds, points: r.points, rank: r.rank }]));
    // R1: N (now K) 1st of 2 = 6, A 2nd = 5. R2 without N: K 1st = 6, A 2nd = 5.
    expect(rows).toEqual({
      [k.ownerId]: { rounds: 2, points: 12, rank: 1 },
      [a.ownerId]: { rounds: 2, points: 10, rank: 2 },
    });
    // B never played: no row.
    expect(st.rows.some((r) => r.memberId === people[1].ownerId)).toBe(false);
  });

  it("works in a full league (no cap check) and leaves one row per member", async () => {
    const { a, id, k, c } = await sharedRound();
    for (let i = 0; (await members(a, id)).json.league.players < LEAGUE_MAX_PLAYERS; i += 1) {
      expect((await addNoApp(a, id, `Player S${i}`)).status).toBe(200);
    }
    expect((await act(a, "approve", c.claimId)).status).toBe(200);
    expect(table(id, "SELECT COUNT(*) AS n FROM member")).toEqual([{ n: LEAGUE_MAX_PLAYERS - 1 }]);
    expect(table(id, "SELECT COUNT(*) AS n FROM member WHERE member_id = ?", k.ownerId)).toEqual([{ n: 1 }]);
  });

  it("a former member who played alongside the spot (left before claiming) merges the same way", async () => {
    const setup = await w.league(3);
    const [a, , cc] = setup.people;
    const id = setup.league.id;
    const n = (await addNoApp(a, id, "Player N")).json.member;
    const start = await post(a, "/v1/leagues/rounds", roundBody(id, [a.ownerId, cc.ownerId, n.memberId]));
    const roundId = start.json.round.roundId;
    expect((await post(cc, "/v1/leagues/rounds/score", { roundId, memberId: cc.ownerId, hole: 1, strokes: 4, rev: 1 })).status).toBe(200);
    expect((await post(a, "/v1/leagues/rounds/score", { roundId, memberId: n.memberId, hole: 1, strokes: 3, rev: 1 })).status).toBe(200);
    expect((await post(a, "/v1/leagues/rounds/finish", { roundId })).status).toBe(200);
    expect((await post(cc, "/v1/leagues/members/leave", { leagueId: id })).status).toBe(200);
    const c = (await claim(cc, setup.code, n.memberId, "Player C")).json.claim;
    const res = await act(a, "approve", c.claimId);
    expect(res).toMatchObject({ status: 200, json: { claim: { status: "approved" } } });
    expect(table(id, "SELECT hole, strokes, entered_by FROM round_cell WHERE member_id = ?", cc.ownerId)).toEqual([{ hole: 1, strokes: 4, entered_by: "self" }]);
    expect(table(id, "SELECT COUNT(*) AS n FROM round_results WHERE member_id = ?", cc.ownerId)).toEqual([{ n: 1 }]);
    expect(table(id, "SELECT member_id, name, kind FROM member WHERE member_id = ?", cc.ownerId)).toEqual([{ member_id: cc.ownerId, name: "Player C", kind: null }]);
    expect(table(id, "SELECT COUNT(*) AS n FROM member WHERE kind = 'noApp'")).toEqual([{ n: 0 }]);
  });
});
