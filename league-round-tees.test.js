// W1 per-player tees (Brian, Nov 26 2026): an optional players[].teeName, display only. The host's
// phone works out each course handicap from the player's own tee; scoring never reads the name.
// Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEAGUE_TEE_NAME_MAX } from "./leagues.js";
import { HOLES_FRONT, byHole, leagueWorld, roundBody, scoreAll } from "./league-test-harness.js";

const BASE_PLAYER_KEYS = ["courseHandicap", "groupNo", "hostEnters", "kind", "memberId", "name"];

let w;
beforeEach(() => {
  w = leagueWorld();
  w.install();
});
afterEach(() => {
  w.uninstall();
  vi.restoreAllMocks();
});

function start(p, body) {
  return w.call("/v1/leagues/rounds", { friend: p.friend, body });
}
function live(p, leagueId) {
  return w.call(`/v1/leagues/rounds?league=${leagueId}`, { method: "GET", friend: p.friend });
}
function storedPlayers(leagueId) {
  return JSON.parse(w.roster(leagueId).db.prepare("SELECT players FROM league_round").get().players);
}
/** The tee as a reader sees it: absent reads as null. */
const teeOf = (p) => p.teeName ?? null;

describe("W1 players[].teeName", () => {
  it("is accepted, trimmed, stored and returned per player on the live read; two players, two tees", async () => {
    const setup = await w.league(3);
    const [a, b, c] = setup.people;
    const body = roundBody(setup.league.id, [a.ownerId, b.ownerId, c.ownerId]);
    body.players[0].teeName = "  Blue ";
    body.players[1].teeName = "Red";
    body.players[1].courseHandicap = 14;
    const res = await start(a, body);
    expect(res.status).toBe(200);
    expect(res.json.round.players.map(teeOf)).toEqual(["Blue", "Red", null]);
    const read = await live(b, setup.league.id);
    expect(read.status).toBe(200);
    expect(read.json.round.players.map((p) => [p.memberId, teeOf(p), p.courseHandicap])).toEqual([
      [a.ownerId, "Blue", null],
      [b.ownerId, "Red", 14],
      [c.ownerId, null, null],
    ]);
    expect(Object.keys(read.json.round.players[0]).sort()).toEqual([...BASE_PLAYER_KEYS, "teeName"].sort());
    expect(storedPlayers(setup.league.id).map(teeOf)).toEqual(["Blue", "Red", null]);
  });

  it("absent or null reads as null, and the player's shape is exactly as before", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const body = roundBody(setup.league.id, [a.ownerId, b.ownerId]);
    body.players[1].teeName = null;
    const res = await start(a, body);
    expect(res.status).toBe(200);
    for (const p of (await live(a, setup.league.id)).json.round.players) {
      expect(teeOf(p)).toBeNull();
      expect(Object.keys(p).sort()).toEqual(BASE_PLAYER_KEYS);
    }
    for (const p of storedPlayers(setup.league.id)) expect(p).not.toHaveProperty("teeName");
  });

  it(`a ${LEAGUE_TEE_NAME_MAX}-character name is fine; 25 characters, "", blanks, numbers and objects are 400 invalid_body`, async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    const withTee = (teeName) => {
      const body = roundBody(setup.league.id, [a.ownerId, b.ownerId]);
      body.players[0].teeName = teeName;
      return body;
    };
    for (const bad of ["x".repeat(LEAGUE_TEE_NAME_MAX + 1), "", "   ", 7, true, { name: "Blue" }, ["Blue"], "Bl\nue"]) {
      expect(await start(a, withTee(bad)), JSON.stringify(bad)).toMatchObject({ status: 400, json: { error: "invalid_body" } });
    }
    expect(w.roster(setup.league.id).db.prepare("SELECT COUNT(*) AS n FROM league_round").get().n).toBe(0);
    // 24 characters after trimming.
    const ok = await start(a, withTee(`  ${"x".repeat(LEAGUE_TEE_NAME_MAX)}  `));
    expect(ok.status).toBe(200);
    expect(ok.json.round.players[0].teeName).toBe("x".repeat(LEAGUE_TEE_NAME_MAX));
  });

  it("does not change courseHandicap's 0–54 range", async () => {
    const setup = await w.league(2);
    const [a, b] = setup.people;
    for (const courseHandicap of [-1, 55, 1.5]) {
      const body = roundBody(setup.league.id, [a.ownerId, b.ownerId]);
      body.players[0] = { ...body.players[0], teeName: "Blue", courseHandicap };
      expect((await start(a, body)).status, String(courseHandicap)).toBe(400);
    }
    const body = roundBody(setup.league.id, [a.ownerId, b.ownerId]);
    body.players[0] = { ...body.players[0], teeName: "Blue", courseHandicap: 54 };
    expect((await start(a, body)).status).toBe(200);
  });

  it("finish results and standings are identical with and without tee names", async () => {
    async function play(tees) {
      const world = leagueWorld();
      world.install();
      try {
        const setup = await world.league(3, { scoring: "net" });
        const ids = setup.people.map((p) => p.ownerId);
        const body = roundBody(setup.league.id, ids, { holes: HOLES_FRONT, scoring: "net" });
        body.players.forEach((p, i) => {
          p.courseHandicap = [2, 9, 18][i];
          if (tees) p.teeName = tees[i];
        });
        const [a, b, c] = setup.people;
        const res = await world.call("/v1/leagues/rounds", { friend: a.friend, body });
        expect(res.status).toBe(200);
        const roundId = res.json.round.roundId;
        await scoreAll(world, a.friend, roundId, ids[0], byHole(HOLES_FRONT, [4, 4, 3, 5, 4, 4, 3, 5, 4]));
        await scoreAll(world, b.friend, roundId, ids[1], byHole(HOLES_FRONT, [5, 5, 4, 6, 5, 4, 3, 5, 5]));
        await scoreAll(world, c.friend, roundId, ids[2], byHole(HOLES_FRONT, [6, 5, 4, 6, 5, 5, 4, 6, 5]));
        // Everyone scored every hole, so the round finished on its own with the last score.
        const done = await world.call("/v1/leagues/rounds/finish", { friend: a.friend, body: { roundId } });
        expect(done).toMatchObject({ status: 409, json: { error: "finished" } });
        const stored = world.roster(setup.league.id).db.prepare("SELECT * FROM round_results ORDER BY member_id").all();
        const standings = await world.call(`/v1/leagues/standings?league=${setup.league.id}`, { method: "GET", friend: a.friend });
        // Ids differ per world; compare by player position.
        const pos = (id) => ids.indexOf(id);
        const results = stored
          .map((r) => ({ ...r, round_id: null, member_id: pos(r.member_id), unit: pos(r.unit) }))
          .sort((x, y) => x.member_id - y.member_id);
        // Rows tied on points come back in member-id order, which is random per world: sort by position.
        const rows = standings.json.rows.map((r) => ({ ...r, memberId: pos(r.memberId) })).sort((x, y) => x.memberId - y.memberId);
        const table = { ...standings.json, rows };
        return { results, table };
      } finally {
        world.uninstall();
      }
    }
    const without = await play(null);
    const withTees = await play(["Blue", "White", "Red"]);
    expect(without.results).toHaveLength(3);
    expect(without.results.some((r) => r.game_points > 0)).toBe(true);
    expect(withTees).toEqual(without);
  });
});
