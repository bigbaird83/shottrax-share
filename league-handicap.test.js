// Member handicaps (ShotTraxx docs/leagues/net-handicaps.md): POST /v1/leagues/members/handicap and
// the two optional members-list fields. Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./entry.js";
import { validHandicapIndex } from "./leagues.js";
import { ORIGIN, leagueWorld, roundBody } from "./league-test-harness.js";

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

function setIndex(p, body) {
  return w.call("/v1/leagues/members/handicap", { friend: p.friend, body });
}
function members(p, leagueId) {
  return w.call(`/v1/leagues/members?league=${leagueId}`, { method: "GET", friend: p.friend });
}
function memberOf(list, memberId) {
  return list.json.members.find((m) => m.memberId === memberId);
}
function handicapRows(leagueId) {
  return w.roster(leagueId).db.prepare("SELECT * FROM member_handicap ORDER BY member_id").all();
}

describe("POST /v1/leagues/members/handicap", () => {
  it("a member sets their own index and another member sees it in the members list", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    const before = Date.now();
    const res = await setIndex(b, { leagueId: setup.league.id, index: 12.4 });
    expect(res.status).toBe(200);
    // Brian, Nov 26 2026: how old a shared handicap is is never exposed.
    expect(Object.keys(res.json)).toEqual(["memberId", "handicapIndex"]);
    expect(res.json).not.toHaveProperty("handicapAt");
    expect(res.json).toMatchObject({ memberId: b.ownerId, handicapIndex: 12.4 });
    const list = await members(c, setup.league.id);
    expect(list.status).toBe(200);
    const row = memberOf(list, b.ownerId);
    expect(row).toEqual({ memberId: b.ownerId, name: "Player B", role: "member", joinedAt: row.joinedAt, handicapIndex: 12.4 });
    for (const m of list.json.members) expect(m).not.toHaveProperty("handicapAt");
    // Members without an index have neither key: their rows are exactly as before.
    expect(Object.keys(memberOf(list, a.ownerId)).sort()).toEqual(APP_MEMBER_KEYS);
    expect(Object.keys(memberOf(list, c.ownerId)).sort()).toEqual(APP_MEMBER_KEYS);
    // set_at is still stored, just never sent.
    const rows = handicapRows(setup.league.id);
    expect(rows).toEqual([{ member_id: b.ownerId, idx: 12.4, set_at: expect.any(Number) }]);
    expect(rows[0].set_at).toBeGreaterThanOrEqual(before);
  });

  it("a later set overwrites the earlier one (one row per member)", async () => {
    const setup = await w.league(2);
    const [, b] = setup.people;
    await setIndex(b, { leagueId: setup.league.id, index: 20 });
    const res = await setIndex(b, { leagueId: setup.league.id, index: 18.7 });
    expect(res.json.handicapIndex).toBe(18.7);
    expect(handicapRows(setup.league.id)).toHaveLength(1);
    expect(memberOf(await members(b, setup.league.id), b.ownerId).handicapIndex).toBe(18.7);
  });

  it("null withdraws: the answer is null/null and both fields disappear from the list", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    await setIndex(b, { leagueId: setup.league.id, index: 9.1 });
    const res = await setIndex(b, { leagueId: setup.league.id, index: null });
    expect(res).toMatchObject({ status: 200, json: { memberId: b.ownerId, handicapIndex: null } });
    expect(Object.keys(res.json)).toEqual(["memberId", "handicapIndex"]);
    const row = memberOf(await members(a, setup.league.id), b.ownerId);
    expect(Object.keys(row).sort()).toEqual(APP_MEMBER_KEYS);
    expect(handicapRows(setup.league.id)).toEqual([]);
    // Withdrawing with nothing stored is fine too.
    expect((await setIndex(b, { leagueId: setup.league.id, index: null })).status).toBe(200);
  });

  it("a plus index (negative), 0, 54.0 and -54.0 are accepted; the organizer can publish their own", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    expect((await setIndex(b, { leagueId: setup.league.id, index: -1.2 })).json.handicapIndex).toBe(-1.2);
    expect(memberOf(await members(a, setup.league.id), b.ownerId).handicapIndex).toBe(-1.2);
    for (const index of [0, 54, 54.0, -54, 0.1, 36.5]) {
      expect((await setIndex(b, { leagueId: setup.league.id, index })).json, String(index)).toMatchObject({ handicapIndex: index });
    }
    expect((await setIndex(a, { leagueId: setup.league.id, index: 3.3 })).json).toMatchObject({ memberId: a.ownerId, handicapIndex: 3.3 });
  });

  it("bad bodies are 400 invalid_body and write nothing", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const id = setup.league.id;
    const bad = {
      "54.1": { leagueId: id, index: 54.1 },
      "-54.1": { leagueId: id, index: -54.1 },
      "12.34": { leagueId: id, index: 12.34 },
      "0.05": { leagueId: id, index: 0.05 },
      'string "12"': { leagueId: id, index: "12" },
      "boolean": { leagueId: id, index: true },
      "object": { leagueId: id, index: { v: 1 } },
      "missing index": { leagueId: id },
      "extra memberId": { leagueId: id, index: 10, memberId: a.ownerId },
      "missing leagueId": { index: 10 },
      "bad leagueId": { leagueId: "short", index: 10 },
    };
    for (const [label, body] of Object.entries(bad)) {
      expect(await setIndex(b, body), label).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    }
    // JSON has no NaN; 1e999 in the raw text parses to Infinity.
    const raw = await entry.fetch(
      new Request(`${ORIGIN}/v1/leagues/members/handicap`, {
        method: "POST",
        headers: { "X-Friend-Key": b.friend, "Content-Type": "application/json" },
        body: `{"leagueId":"${id}","index":1e999}`,
      }),
      w.env,
      { waitUntil() {} },
    );
    expect(raw.status).toBe(400);
    expect(await raw.json()).toEqual({ error: "invalid_body" });
    expect(handicapRows(id)).toEqual([]);
  });

  it("a non-member is 403 forbidden; no key is 401; an unknown league is 404", async () => {
    const setup = await w.league(2);
    const outsider = await w.player(9);
    expect(await setIndex(outsider, { leagueId: setup.league.id, index: 10 })).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await w.call("/v1/leagues/members/handicap", { body: { leagueId: setup.league.id, index: 10 } })).toMatchObject({
      status: 401,
      json: { error: "friend_key_required" },
    });
    expect(await setIndex(setup.people[0], { leagueId: "A".repeat(22), index: 10 })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(handicapRows(setup.league.id)).toEqual([]);
  });

  it("GET is 405", async () => {
    const setup = await w.league(1);
    const res = await w.call("/v1/leagues/members/handicap", { method: "GET", friend: setup.people[0].friend });
    expect(res.status).toBe(405);
  });
});

describe("validHandicapIndex", () => {
  it("accepts null and -54.0..54.0 with at most one decimal; refuses everything else", () => {
    for (const v of [null, 0, -0, 0.1, -1.2, 12.4, 54, -54, 53.9, 36.5]) expect(validHandicapIndex(v), String(v)).toBe(true);
    for (const v of [NaN, Infinity, -Infinity, 54.1, -54.1, 12.34, 0.05, 1e-7, "12", undefined, true, {}, []]) {
      expect(validHandicapIndex(v), String(v)).toBe(false);
    }
  });
});

describe("member handicap cleanup", () => {
  it("leave deletes the row; rejoining with the same code shows no index", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    await setIndex(b, { leagueId: setup.league.id, index: 15 });
    await setIndex(a, { leagueId: setup.league.id, index: 4 });
    expect((await w.call("/v1/leagues/members/leave", { friend: b.friend, body: { leagueId: setup.league.id } })).status).toBe(200);
    expect(handicapRows(setup.league.id).map((r) => r.member_id)).toEqual([a.ownerId]);
    const join = await w.call("/v1/leagues/join", { friend: b.friend, body: { code: setup.code, name: "Player B" } });
    expect(join.status).toBe(200);
    expect(Object.keys(memberOf(await members(a, setup.league.id), b.ownerId)).sort()).toEqual(APP_MEMBER_KEYS);
    expect(memberOf(await members(a, setup.league.id), a.ownerId).handicapIndex).toBe(4);
  });

  it("remove deletes the row; rejoining with the new code shows no index", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    await setIndex(b, { leagueId: setup.league.id, index: 22.2 });
    const removed = await w.call("/v1/leagues/members/remove", { friend: a.friend, body: { leagueId: setup.league.id, memberId: b.ownerId } });
    expect(removed.status).toBe(200);
    expect(handicapRows(setup.league.id)).toEqual([]);
    const reset = await w.call("/v1/leagues/code/reset", { friend: a.friend, body: { leagueId: setup.league.id } });
    expect(reset.status).toBe(200);
    const join = await w.call("/v1/leagues/join", { friend: b.friend, body: { code: reset.json.code, name: "Player B" } });
    expect(join.status).toBe(200);
    expect(Object.keys(memberOf(await members(a, setup.league.id), b.ownerId)).sort()).toEqual(APP_MEMBER_KEYS);
  });

  it("hand over and leave deletes only the leaving organizer's row", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    await setIndex(a, { leagueId: setup.league.id, index: 5.5 });
    await setIndex(b, { leagueId: setup.league.id, index: 7.5 });
    const res = await w.call("/v1/leagues/members/handover", { friend: a.friend, body: { leagueId: setup.league.id, memberId: b.ownerId } });
    expect(res.status).toBe(200);
    expect(handicapRows(setup.league.id)).toEqual([{ member_id: b.ownerId, idx: 7.5, set_at: expect.any(Number) }]);
    expect(memberOf(await members(b, setup.league.id), b.ownerId)).toMatchObject({ role: "owner", handicapIndex: 7.5 });
  });

  it("a no-app spot never shows an index; nobody can set one for it", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const added = await w.call("/v1/leagues/members/no-app", { friend: a.friend, body: { leagueId: setup.league.id, name: "Player N" } });
    expect(added.status).toBe(200);
    await setIndex(a, { leagueId: setup.league.id, index: 10 });
    await setIndex(b, { leagueId: setup.league.id, index: 11 });
    // There is no memberId field: the organizer can't set another member's or a spot's index.
    expect(await setIndex(a, { leagueId: setup.league.id, index: 10, memberId: added.json.member.memberId })).toMatchObject({ status: 400 });
    const list = await members(b, setup.league.id);
    const spot = memberOf(list, added.json.member.memberId);
    expect(Object.keys(spot).sort()).toEqual(NOAPP_MEMBER_KEYS);
    expect(handicapRows(setup.league.id).map((r) => r.member_id).sort()).toEqual([a.ownerId, b.ownerId].sort());
  });

  it("a claim approve leaves the claimer's own row as it is", async () => {
    const setup = await w.league(1);
    const [a] = setup.people;
    const added = await w.call("/v1/leagues/members/no-app", { friend: a.friend, body: { leagueId: setup.league.id, name: "Player N" } });
    const spotId = added.json.member.memberId;
    const c = await w.player(3);
    const claim = await w.call("/v1/leagues/claims", { friend: c.friend, body: { code: setup.code, spotMemberId: spotId, name: "Player C" } });
    expect(claim.status).toBe(200);
    // The claimer joins while the claim is pending and publishes an index; approve merges the spot in.
    expect((await w.call("/v1/leagues/join", { friend: c.friend, body: { code: setup.code, name: "Player C" } })).status).toBe(200);
    await setIndex(c, { leagueId: setup.league.id, index: 8.8 });
    const approve = await w.call("/v1/leagues/claims/approve", { friend: a.friend, body: { claimId: claim.json.claim.claimId } });
    expect(approve.status).toBe(200);
    const list = await members(a, setup.league.id);
    expect(memberOf(list, spotId)).toBeUndefined();
    expect(memberOf(list, c.ownerId)).toMatchObject({ handicapIndex: 8.8 });
    expect(handicapRows(setup.league.id).map((r) => r.member_id)).toEqual([c.ownerId]);
  });
});

describe("W1 round start does not read member handicaps", () => {
  it("snapshots whatever courseHandicap the host sends, not the published index", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    await setIndex(a, { leagueId: setup.league.id, index: 30.1 });
    await setIndex(b, { leagueId: setup.league.id, index: -2 });
    const body = roundBody(setup.league.id, [a.ownerId, b.ownerId]);
    body.players[1].courseHandicap = 7;
    const res = await w.call("/v1/leagues/rounds", { friend: a.friend, body });
    expect(res.status).toBe(200);
    expect(res.json.round.players.map((p) => p.courseHandicap)).toEqual([null, 7]);
    const stored = JSON.parse(w.roster(setup.league.id).db.prepare("SELECT players FROM league_round").get().players);
    expect(stored.map((p) => p.courseHandicap)).toEqual([null, 7]);
    // A later change to the index does not touch the started round.
    await setIndex(b, { leagueId: setup.league.id, index: 40 });
    const live = await w.call(`/v1/leagues/rounds?league=${setup.league.id}`, { method: "GET", friend: a.friend });
    expect(live.status).toBe(200);
    expect(live.json.round.players.map((p) => p.courseHandicap)).toEqual([null, 7]);
  });
});
