// Leagues W-B: preview spots (W8), claims (W9–W13) and the claim push (W14). Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leagueWorld, roundBody } from "./league-test-harness.js";

const TOKEN = (n) => `ExponentPushToken[tok${n}]`;
const CLAIM_ID_RE = /^[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{16}$/;
const CLAIM_KEYS = ["claimId", "leagueId", "spotMemberId", "spotName", "claimerId", "claimerName", "status", "createdAt"];
const SPOT_KEYS = ["memberId", "name", "addedByName", "addedAt"];

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
function preview(p, code) {
  return w.call("/v1/leagues/preview", { friend: p.friend, body: { code } });
}
function claim(p, code, spotMemberId, name = "Player K") {
  return w.call("/v1/leagues/claims", { friend: p.friend, body: { code, spotMemberId, name } });
}
function act(p, action, claimId) {
  return w.call(`/v1/leagues/claims/${action}`, { friend: p.friend, body: { claimId } });
}
function list(p, leagueId) {
  return w.call(`/v1/leagues/claims?league=${leagueId}`, { method: "GET", friend: p.friend });
}
function mine(p) {
  return w.call("/v1/leagues/claims/mine", { method: "GET", friend: p.friend });
}
function members(p, leagueId) {
  return w.call(`/v1/leagues/members?league=${leagueId}`, { method: "GET", friend: p.friend });
}
function dumpRoster(leagueId) {
  const db = w.roster(leagueId).db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
}

/** League of players 1 and 2 with two no-app spots added by player 2. */
async function withSpots() {
  const setup = await w.league(2);
  const [a, b] = setup.people;
  const n = (await addNoApp(b, setup.league.id, "Player N")).json.member;
  const m = (await addNoApp(a, setup.league.id, "Player M")).json.member;
  return { ...setup, a, b, n, m };
}

describe("W8 preview spots", () => {
  it("lists unclaimed no-app spots without a pending claim, in roster order", async () => {
    const { code, n, m } = await withSpots();
    const k = await w.player(11);
    const res = await preview(k, code);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["league", "spots"]);
    expect(res.json.spots).toEqual([
      { memberId: n.memberId, name: "Player N", addedByName: "Player B", addedAt: n.addedAt },
      { memberId: m.memberId, name: "Player M", addedByName: "Player A", addedAt: m.addedAt },
    ]);
    for (const s of res.json.spots) expect(Object.keys(s)).toEqual(SPOT_KEYS);
    expect(res.json.league.players).toBe(4);
    expect(res.json.league.ownerId).toBeUndefined();
    // A pending claim takes the spot off the list.
    expect((await claim(k, code, n.memberId)).status).toBe(200);
    const other = await w.player(12);
    expect((await preview(other, code)).json.spots.map((s) => s.memberId)).toEqual([m.memberId]);
  });

  it("a league with no claimable spot answers { league } only, as before", async () => {
    const setup = await w.league(2);
    const k = await w.player(11);
    const res = await preview(k, setup.code);
    expect(Object.keys(res.json)).toEqual(["league"]);
  });

  it("a preview body without spots still has the app's league shape (shape check)", async () => {
    const setup = await w.league(1);
    const k = await w.player(11);
    const res = await preview(k, setup.code);
    const spots = Array.isArray(res.json.spots) ? res.json.spots : [];
    expect(spots).toEqual([]);
    expect(res.json.league).toMatchObject({ id: setup.league.id, name: "Saturday Crew", ownerName: "Player A", players: 1, maxPlayers: 20 });
  });
});

describe("W9 POST /v1/leagues/claims", () => {
  it("stores a pending claim with the contract shape; the claimer is not a member", async () => {
    const { code, league, a, n } = await withSpots();
    const k = await w.player(11);
    const res = await claim(k, code, n.memberId, "  Player   K ");
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["claim"]);
    const c = res.json.claim;
    expect(Object.keys(c)).toEqual(CLAIM_KEYS);
    expect(c.claimId).toMatch(CLAIM_ID_RE);
    expect(c.claimId.slice(0, 22)).toBe(league.id);
    expect(c).toMatchObject({ leagueId: league.id, spotMemberId: n.memberId, spotName: "Player N", claimerId: k.ownerId, claimerName: "Player K", status: "pending" });
    expect(typeof c.createdAt).toBe("number");
    const roster = await members(a, league.id);
    expect(roster.json.members.map((x) => x.memberId)).not.toContain(k.ownerId);
    expect(roster.json.league.players).toBe(4);
    expect((await members(k, league.id)).status).toBe(404);
    // The KV pointer for /claims/mine.
    expect(w.kv.get(`lg:claim:${k.ownerId}`)).toBe(c.claimId);
  });

  it("refusals: already_pending (one per person, across leagues), spot_pending, already_member, name_required, invalid_body", async () => {
    const { code, b, n, m } = await withSpots();
    const k = await w.player(11);
    const j = await w.player(12);
    expect((await claim(k, code, n.memberId)).status).toBe(200);
    expect(await claim(k, code, m.memberId)).toMatchObject({ status: 409, json: { error: "already_pending" } });
    expect(await claim(j, code, n.memberId)).toMatchObject({ status: 409, json: { error: "spot_pending" } });
    expect(await claim(b, code, m.memberId)).toMatchObject({ status: 409, json: { error: "already_member" } });
    expect(await claim(j, code, m.memberId, "  ")).toMatchObject({ status: 400, json: { error: "name_required" } });
    // Not a spot: an app member's id, or an unknown id.
    expect(await claim(j, code, b.ownerId)).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await claim(j, code, "nobody")).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    expect(await w.call("/v1/leagues/claims", { friend: j.friend, body: { code, spotMemberId: m.memberId, name: "J", extra: 1 } })).toMatchObject({
      status: 400,
      json: { error: "invalid_body" },
    });
    // A second league: K's claim in the first is still pending.
    const other = await w.player(20);
    const made = await w.call("/v1/leagues", { friend: other.friend, body: { name: "Other", yourName: "Player O", game: "strokePlay", scoring: "gross", carryOver: false, homeCourse: null, seasonStarts: "2026-11-01", seasonEnds: "2027-03-31" } });
    const spot2 = (await addNoApp(other, made.json.league.id, "Player S")).json.member;
    expect(await claim(k, made.json.code, spot2.memberId)).toMatchObject({ status: 409, json: { error: "already_pending" } });
    // After a cancel, K can claim again.
    const pending = (await mine(k)).json.claim;
    expect((await act(k, "cancel", pending.claimId)).status).toBe(200);
    expect((await claim(k, made.json.code, spot2.memberId)).status).toBe(200);
  });

  it("the code the caller was removed under is 404; an unknown code is 404", async () => {
    const { code, league, a, n } = await withSpots();
    const k = await w.player(11);
    expect((await w.call("/v1/leagues/join", { friend: k.friend, body: { code, name: "Player K" } })).status).toBe(200);
    expect((await w.call("/v1/leagues/members/remove", { friend: a.friend, body: { leagueId: league.id, memberId: k.ownerId } })).status).toBe(200);
    const res = await claim(k, code, n.memberId);
    expect(res.status).toBe(404);
    expect(await claim(k, "AAAABBBB", n.memberId)).toMatchObject({ status: 404 });
    expect(w.roster(league.id).db.prepare("SELECT COUNT(*) AS n FROM claim").get().n).toBe(0);
  });
});

describe("W10 POST /v1/leagues/claims/approve", () => {
  /** A finished round and a live round both with the no-app spot N, host-entered; then K claims N. */
  async function claimedWithRounds() {
    const s = await withSpots();
    const { a, b, n, league } = s;
    const r1 = await w.call("/v1/leagues/rounds", {
      friend: a.friend,
      body: roundBody(league.id, [a.ownerId, b.ownerId, n.memberId], { game: "matchPlay", teamsMode: "pairs", teams: [{ teamNo: 1, memberIds: [a.ownerId, n.memberId] }, { teamNo: 2, memberIds: [b.ownerId] }] }),
    });
    expect(r1.status).toBe(200);
    const done = r1.json.round.roundId;
    for (const [p, id, s1] of [[a, a.ownerId, 4], [b, b.ownerId, 6], [a, n.memberId, 3]]) {
      expect((await w.call("/v1/leagues/rounds/score", { friend: p.friend, body: { roundId: done, memberId: id, hole: 1, strokes: s1, rev: 1 } })).status).toBe(200);
    }
    // A second edit of the spot's cell (history keeps both).
    expect((await w.call("/v1/leagues/rounds/score", { friend: a.friend, body: { roundId: done, memberId: n.memberId, hole: 1, strokes: 2, rev: 2 } })).status).toBe(200);
    expect((await w.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId: done } })).status).toBe(200);
    const r2 = await w.call("/v1/leagues/rounds", { friend: b.friend, body: roundBody(league.id, [b.ownerId, n.memberId]) });
    const live = r2.json.round.roundId;
    expect((await w.call("/v1/leagues/rounds/score", { friend: b.friend, body: { roundId: live, memberId: n.memberId, hole: 1, strokes: 5, rev: 1 } })).status).toBe(200);
    const k = await w.player(11);
    const c = (await claim(k, s.code, n.memberId, "Player K")).json.claim;
    return { ...s, k, c, done, live };
  }

  it("moves roster, round_results (so points), cells, history, last_seen and round players/teams to the claimer", async () => {
    const { a, k, c, n, league, done, live } = await claimedWithRounds();
    const db = w.roster(league.id).db;
    const standingsBefore = (await w.call(`/v1/leagues/standings?league=${league.id}`, { method: "GET", friend: a.friend })).json;
    const spotRow = standingsBefore.rows.find((r) => r.memberId === n.memberId);
    expect(spotRow).toBeTruthy();
    const historyBefore = db.prepare("SELECT seq, hole, strokes, rev, entered_by, by_id FROM round_history WHERE member_id = ? ORDER BY seq").all(n.memberId);
    expect(historyBefore).toHaveLength(3);
    const joinedAt = db.prepare("SELECT joined_at FROM member WHERE member_id = ?").get(n.memberId).joined_at;
    db.prepare("INSERT INTO last_seen (member_id, at) VALUES (?, 1)").run(n.memberId);
    const unitBefore = db.prepare("SELECT unit FROM round_results WHERE member_id = ?").get(n.memberId).unit;

    const res = await act(a, "approve", c.claimId);
    expect(res.status).toBe(200);
    expect(res.json.claim).toEqual({ ...c, status: "approved" });

    const ids = (sql, id) => db.prepare(sql).all(id).length;
    for (const table of ["member", "round_results", "round_cell", "round_history", "last_seen"]) {
      expect(ids(`SELECT 1 FROM ${table} WHERE member_id = ?`, n.memberId), table).toBe(0);
    }
    const member = db.prepare("SELECT * FROM member WHERE member_id = ?").get(k.ownerId);
    expect({ ...member }).toEqual({ member_id: k.ownerId, name: "Player K", role: "member", joined_at: joinedAt, kind: null, added_by: null, added_at: null });
    // A team unit stays the team; a unit that was the spot's own id becomes the claimer's.
    const unitAfter = db.prepare("SELECT unit FROM round_results WHERE member_id = ?").get(k.ownerId).unit;
    expect(unitAfter).toBe(unitBefore === n.memberId ? k.ownerId : unitBefore);
    expect(db.prepare("SELECT round_id FROM round_cell WHERE member_id = ? ORDER BY round_id").all(k.ownerId).map((r) => r.round_id).sort()).toEqual([done, live].sort());
    const historyAfter = db.prepare("SELECT seq, hole, strokes, rev, entered_by, by_id FROM round_history WHERE member_id = ? ORDER BY seq").all(k.ownerId);
    expect(historyAfter.map((r) => ({ ...r }))).toEqual(historyBefore.map((r) => ({ ...r })));
    expect(db.prepare("SELECT at FROM last_seen WHERE member_id = ?").get(k.ownerId).at).toBe(1);
    for (const row of db.prepare("SELECT players, teams FROM league_round").all()) {
      expect(row.players).not.toContain(n.memberId);
      if (row.teams) expect(row.teams).not.toContain(n.memberId);
    }
    const finished = JSON.parse(db.prepare("SELECT players, teams FROM league_round WHERE round_id = ?").get(done).players);
    expect(finished.find((p) => p.memberId === k.ownerId)).toMatchObject({ name: "Player N", kind: "app", hostEnters: true });
    expect(JSON.parse(db.prepare("SELECT teams FROM league_round WHERE round_id = ?").get(done).teams)[0].memberIds).toEqual([a.ownerId, k.ownerId]);

    // Members list: the row is an app member now (no kind key), in the same place.
    const list = (await members(a, league.id)).json;
    const row = list.members.find((m) => m.memberId === k.ownerId);
    expect(Object.keys(row).sort()).toEqual(["joinedAt", "memberId", "name", "role"]);
    expect(list.league.players).toBe(4);
    // The claimer is a member and reads the standings: their row has the spot's points.
    const after = (await w.call(`/v1/leagues/standings?league=${league.id}`, { method: "GET", friend: k.friend })).json;
    const mineRow = after.rows.find((r) => r.memberId === k.ownerId);
    const { memberId: _a, name: _b, ...spotRest } = spotRow;
    const { memberId: _c, name, ...mineRest } = mineRow;
    expect(mineRest).toEqual(spotRest);
    expect(name).toBe("Player K");
    // The live round shows the claimer in the spot's place; the host-entered cell moved with it.
    const sheet = (await w.call(`/v1/leagues/rounds?league=${league.id}`, { method: "GET", friend: k.friend })).json;
    expect(sheet.round.players.map((p) => p.memberId)).toContain(k.ownerId);
    expect(sheet.round.cells[k.ownerId][1]).toMatchObject({ strokes: 5, enteredBy: "host" });
  });

  it("host-entered cells stay enteredBy host", async () => {
    const { a, c, k, league } = await claimedWithRounds();
    expect((await act(a, "approve", c.claimId)).status).toBe(200);
    const db = w.roster(league.id).db;
    const cells = db.prepare("SELECT entered_by, by_id FROM round_cell WHERE member_id = ?").all(k.ownerId);
    expect(cells.length).toBe(2);
    for (const cell of cells) expect(cell.entered_by).toBe("host");
    const hist = db.prepare("SELECT entered_by FROM round_history WHERE member_id = ?").all(k.ownerId);
    for (const h of hist) expect(h.entered_by).toBe("host");
  });

  it("approve after the spot was removed is 403 (the remove cancelled the claim, Brian Nov 23) and changes nothing", async () => {
    const { a, c, n, league } = await claimedWithRounds();
    expect((await w.call("/v1/leagues/members/remove", { friend: a.friend, body: { leagueId: league.id, memberId: n.memberId } })).status).toBe(200);
    const before = dumpRoster(league.id);
    expect(await act(a, "approve", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(dumpRoster(league.id)).toBe(before);
  });

  it("approve of a pending claim whose spot row is gone is 404 and changes nothing", async () => {
    const { a, c, n, league } = await claimedWithRounds();
    // Only reachable outside the remove route (which cancels the claim): drop the spot row directly.
    w.roster(league.id).db.prepare("DELETE FROM member WHERE member_id = ?").run(n.memberId);
    const before = dumpRoster(league.id);
    expect(await act(a, "approve", c.claimId)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(dumpRoster(league.id)).toBe(before);
  });

  it("only the organizer approves (403); an unknown claim is 404", async () => {
    const { b, c, k, league } = await claimedWithRounds();
    const before = dumpRoster(league.id);
    expect(await act(b, "approve", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await act(k, "approve", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await act(b, "approve", `${league.id}_${"z".repeat(16)}`)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await act(b, "approve", "nope")).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(dumpRoster(league.id)).toBe(before);
  });
});

describe("W11 / W12 / W13", () => {
  it("decline: organizer only; the spot stays unclaimed and is claimable again", async () => {
    const { a, b, code, n, league } = await withSpots();
    const k = await w.player(11);
    const c = (await claim(k, code, n.memberId)).json.claim;
    expect(await act(b, "decline", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await act(k, "decline", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    const res = await act(a, "decline", c.claimId);
    expect(res.status).toBe(200);
    expect(res.json.claim).toEqual({ ...c, status: "declined" });
    const roster = (await members(a, league.id)).json.members;
    expect(roster.find((m) => m.memberId === n.memberId)).toMatchObject({ kind: "noApp", name: "Player N" });
    expect((await preview(k, code)).json.spots.map((s) => s.memberId)).toContain(n.memberId);
    // The same person may try again.
    expect((await claim(k, code, n.memberId)).status).toBe(200);
    // A declined claim can't be approved.
    expect((await act(a, "approve", c.claimId)).status).toBe(403);
  });

  it("cancel: the claimer only", async () => {
    const { a, code, n } = await withSpots();
    const k = await w.player(11);
    const c = (await claim(k, code, n.memberId)).json.claim;
    expect(await act(a, "cancel", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    const res = await act(k, "cancel", c.claimId);
    expect(res.json.claim).toEqual({ ...c, status: "cancelled" });
    expect(await act(k, "cancel", c.claimId)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await w.call("/v1/leagues/claims/cancel", { friend: k.friend, body: { claimId: c.claimId, extra: 1 } })).toMatchObject({ status: 400 });
  });

  it("the organizer's list puts pending first; members and outsiders get 403", async () => {
    const { a, b, code, n, m, league } = await withSpots();
    const k = await w.player(11);
    const j = await w.player(12);
    const first = (await claim(k, code, n.memberId)).json.claim;
    expect((await act(a, "decline", first.claimId)).status).toBe(200);
    const second = (await claim(j, code, m.memberId)).json.claim;
    const res = await list(a, league.id);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json)).toEqual(["claims"]);
    expect(res.json.claims.map((c) => [c.claimId, c.status])).toEqual([
      [second.claimId, "pending"],
      [first.claimId, "declined"],
    ]);
    for (const c of res.json.claims) expect(Object.keys(c)).toEqual(CLAIM_KEYS);
    expect(await list(b, league.id)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await list(k, league.id)).toMatchObject({ status: 403, json: { error: "forbidden" } });
  });

  it("mine: the caller's latest claim and its league, or nulls", async () => {
    const { a, code, n, m, league } = await withSpots();
    const k = await w.player(11);
    expect(await mine(k)).toMatchObject({ status: 200, json: { claim: null, league: null } });
    const first = (await claim(k, code, n.memberId)).json.claim;
    expect((await act(a, "decline", first.claimId)).status).toBe(200);
    const declined = await mine(k);
    expect(declined.json.claim).toEqual({ ...first, status: "declined" });
    const second = (await claim(k, code, m.memberId)).json.claim;
    const res = await mine(k);
    expect(Object.keys(res.json)).toEqual(["claim", "league"]);
    expect(res.json.claim).toEqual(second);
    expect(res.json.league).toMatchObject({ id: league.id, name: "Saturday Crew", ownerName: "Player A" });
    expect(res.json.league.ownerId).toBeUndefined();
    expect((await w.call("/v1/leagues/claims/mine?x=1", { method: "GET", friend: k.friend })).status).toBe(400);
  });
});

describe("W14 claim push", () => {
  it("one push to the organizer only, with the exact title, body and data", async () => {
    const { a, b, code, n, league } = await withSpots();
    w.kv.set(`fr:push:${a.ownerId}`, TOKEN(1));
    w.kv.set(`fr:push:${b.ownerId}`, TOKEN(2));
    const k = await w.player(11);
    w.kv.set(`fr:push:${k.ownerId}`, TOKEN(11));
    const c = (await claim(k, code, n.memberId, "Player K")).json.claim;
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0].headers.Authorization).toBe("Bearer test-expo-token");
    expect(w.pushes[0].messages).toEqual([
      {
        to: TOKEN(1),
        title: "Saturday Crew: claim request",
        body: "Player K wants to claim Player N's spot. Tap to review.",
        sound: "default",
        data: { kind: "league_claim_request", leagueId: league.id, claimId: c.claimId },
      },
    ]);
  });

  it("goes to the new organizer after a hand-over", async () => {
    const { a, b, code, n, league } = await withSpots();
    w.kv.set(`fr:push:${a.ownerId}`, TOKEN(1));
    w.kv.set(`fr:push:${b.ownerId}`, TOKEN(2));
    expect((await w.call("/v1/leagues/members/handover", { friend: a.friend, body: { leagueId: league.id, memberId: b.ownerId } })).status).toBe(200);
    const k = await w.player(11);
    expect((await claim(k, code, n.memberId)).status).toBe(200);
    expect(w.pushes.map((p) => p.messages.map((x) => x.to))).toEqual([[TOKEN(2)]]);
  });

  it("none on a block either way, none without a valid token, and a push failure never fails W9", async () => {
    const { a, code, n, m } = await withSpots();
    w.kv.set(`fr:push:${a.ownerId}`, "not-a-token");
    const k = await w.player(11);
    expect((await claim(k, code, n.memberId)).status).toBe(200);
    expect(w.pushes).toHaveLength(0);
    w.kv.set(`fr:push:${a.ownerId}`, TOKEN(1));
    w.pushFails = true;
    const j = await w.player(12);
    expect((await claim(j, code, m.memberId)).status).toBe(200);
    expect(w.pushes).toHaveLength(1);
  });

  it("no push when the organizer blocked the claimer or the claimer blocked the organizer", async () => {
    const { a, code, n, m } = await withSpots();
    w.kv.set(`fr:push:${a.ownerId}`, TOKEN(1));
    const k = await w.player(11);
    const j = await w.player(12);
    // The W9 code lookup already refuses a blocked caller (as join); the push check is the second guard.
    w.kv.set(`fr:block:${a.ownerId}:${k.ownerId}`, "1");
    expect((await claim(k, code, n.memberId)).status).toBe(404);
    w.kv.set(`fr:block:${j.ownerId}:${a.ownerId}`, "1");
    expect((await claim(j, code, m.memberId)).status).toBe(404);
    expect(w.pushes).toHaveLength(0);
  });
});
