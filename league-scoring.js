/**
 * League round scoring, a pure module (no I/O). A port of the ShotTraxx app's engine at
 * bigbaird83/ShotTraxx b555c794c180cc8536f8bafa45d333cfbba9b0d0, kept as close to the TS as
 * JS allows so places, net and skins match the app byte for byte (test/fixtures/
 * league-round-results.golden.json is written by the app's own leagueRoundResults).
 *
 * Sources (src/domain/…):
 * - handicap.ts: strokesReceived
 * - groupGames.ts: validScore, validPar, roundStrokes, strokesOffLow, allStrokeIndexes, netAvailable,
 *   netBlockReason, scoreTable, strokesByHole, parCoverage, placeRows, strokePlay, byHoleNumber,
 *   strokeOnHole, skins, and the parts of planGroupGames that leagueRoundResults uses.
 * - leagueRound.ts: gameUsesTeams, scoreWriteRefusal, applyScoreWrite, holesPlayed, everyoneFinished,
 *   teamBestBall, teamMatchPoints, leagueRoundResults.
 * - leagues.ts roundPoints is leagues.js roundPoints (unchanged from PR 1).
 *
 * League rounds have no mid-round joiners (no joinedHole), so the joiner paths of planGroupGames
 * (play order, holesBothPlay) reduce to hole-number order with every player on every hole.
 *
 * Game points (W-C) are new here: leagueGamePoints. Approved rules: Match/Skins/Stroke (Brian,
 * Nov 11 2026, mockup league-game-points) and Stableford/Nassau (Brian, Nov 22 2026, mockup
 * league-game-points-stableford-nassau-1122). Ties stay exact (no rounding to halves).
 */

/** Same ids as the app's GroupGameId. */
export const GAME_POINT_LINES = Object.freeze({
  matchPlay: Object.freeze(["perHole", "per9", "fullRound"]),
  skins: Object.freeze(["perSkin"]),
  strokePlay: Object.freeze(["per9", "fullRound"]),
  stableford: Object.freeze(["per9", "fullRound"]),
  nassau: Object.freeze(["per9", "fullRound"]),
});

/** Approved defaults: Match 1 / 0 / 0, Skins 1, Stroke 2 / 3, Stableford 2 / 3, Nassau 1 / 1. */
export const DEFAULT_GAME_POINTS = Object.freeze({
  matchPlay: Object.freeze({ perHole: 1, per9: 0, fullRound: 0 }),
  skins: Object.freeze({ perSkin: 1 }),
  strokePlay: Object.freeze({ per9: 2, fullRound: 3 }),
  stableford: Object.freeze({ per9: 2, fullRound: 3 }),
  nassau: Object.freeze({ per9: 1, fullRound: 1 }),
});

/** Placeholder cap for one line's value (not from a mockup; flagged for Brian). */
export const GAME_POINTS_MAX = 20;
export const POINTS_MODES = Object.freeze(["add", "replace"]);
export const DEFAULT_POINTS_MODE = "add";
/** Points compare equal within this (ties stay exact; 2 split 3 ways is 2/3). */
export const POINTS_EPSILON = 1e-9;

// ---------------------------------------------------------------------------------------------
// handicap.ts

/** handicap.ts strokesReceived: strokes per hole, hardest stroke index first. */
export function strokesReceived(holes, courseHcp) {
  const out = new Map();
  for (const hole of holes) out.set(hole.number, 0);
  if (courseHcp == null || courseHcp <= 0 || holes.length === 0) return out;
  const ranked = [...holes].sort((a, b) => {
    const sa = a.strokeIndex ?? Number.MAX_SAFE_INTEGER;
    const sb = b.strokeIndex ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || a.number - b.number;
  });
  const base = Math.floor(courseHcp / holes.length);
  const extra = courseHcp % holes.length;
  ranked.forEach((hole, rank) => out.set(hole.number, base + (rank < extra ? 1 : 0)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// groupGames.ts

/** groupGames.ts validScore. */
function validScore(n) {
  return n != null && Number.isInteger(n) && n >= 1 && n <= 20;
}

/** groupGames.ts validPar. */
export function validPar(n) {
  return n != null && Number.isInteger(n) && n >= 3 && n <= 6;
}

/** groupGames.ts roundStrokes: halved (rounded, .5 up) on a 9-hole round. */
export function roundStrokes(strokes, holeCount) {
  const whole = Math.max(0, Math.round(strokes));
  return holeCount === 9 ? Math.round(whole / 2) : whole;
}

/** groupGames.ts strokesOffLow. Null when any handicap is blank. */
export function strokesOffLow(players) {
  if (players.some((p) => p.handicap == null)) return null;
  const low = Math.min(...players.map((p) => p.handicap));
  return Object.fromEntries(players.map((p) => [p.id, p.handicap - low]));
}

/** groupGames.ts allStrokeIndexes. */
function allStrokeIndexes(holes) {
  return holes.length > 0 && holes.every((h) => h.strokeIndex != null && h.strokeIndex >= 1);
}

/** groupGames.ts netAvailable. */
export function netAvailable(holes, players) {
  const off = strokesOffLow(players);
  if (!off) return false;
  const anyStrokes = Object.values(off).some((n) => roundStrokes(n, holes.length) > 0);
  return !anyStrokes || allStrokeIndexes(holes);
}

/** groupGames.ts netBlockReason. */
export function netBlockReason(holes, players, settings) {
  if (!settings.net) return null;
  if (players.some((p) => p.handicap == null)) return "handicap";
  if (netAvailable(holes, players)) {
    const fullStrokes = settings.stableford && players.some((p) => roundStrokes(p.handicap ?? 0, holes.length) > 0);
    return fullStrokes && !allStrokeIndexes(holes) ? "stroke_index" : null;
  }
  return "stroke_index";
}

/** groupGames.ts scoreTable: per player, hole → { gross, net } for scored holes. */
function scoreTable(holes, players, strokes) {
  const siHoles = holes.map((h) => ({ number: h.number, par: h.par, score: null, strokeIndex: h.strokeIndex }));
  const out = new Map();
  for (const player of players) {
    const given = strokes?.[player.id] ?? 0;
    const perHole = given > 0 ? strokesReceived(siHoles, roundStrokes(given, holes.length)) : null;
    const row = new Map();
    for (const hole of holes) {
      const gross = player.scores[hole.number];
      if (!validScore(gross)) continue;
      row.set(hole.number, { gross, net: gross - (perHole?.get(hole.number) ?? 0) });
    }
    out.set(player.id, row);
  }
  return out;
}

/** groupGames.ts strokesByHole. */
export function strokesByHole(holes, strokes) {
  const siHoles = holes.map((h) => ({ number: h.number, par: h.par, score: null, strokeIndex: h.strokeIndex }));
  return strokesReceived(siHoles, roundStrokes(strokes, holes.length));
}

/** groupGames.ts parCoverage. */
export function parCoverage(holes) {
  const withPar = holes.filter((h) => validPar(h.par)).length;
  return withPar === 0 ? "none" : withPar === holes.length ? "all" : "some";
}

/** groupGames.ts placeRows: ties share a place. */
function placeRows(rows, key) {
  const sorted = [...rows].sort((a, b) => key(a) - key(b));
  sorted.forEach((row, i) => {
    row.place = i > 0 && key(sorted[i - 1]) === key(row) ? sorted[i - 1].place : i + 1;
  });
  return sorted;
}

/** groupGames.ts strokePlay. To par counts only holes with a par (kept as the app has it). */
function strokePlay(holes, players, table, useNet) {
  const par = new Map(holes.map((h) => [h.number, h.par]));
  const rows = players.map((player) => {
    const scored = [...(table.get(player.id) ?? new Map()).entries()];
    const withPar = scored.filter(([n]) => validPar(par.get(n) ?? null));
    const parSum = withPar.reduce((sum, [n]) => sum + par.get(n), 0);
    return {
      playerId: player.id,
      name: player.name,
      thru: scored.length,
      gross: scored.reduce((sum, [, s]) => sum + s.gross, 0),
      net: scored.reduce((sum, [, s]) => sum + s.net, 0),
      toPar: withPar.length ? withPar.reduce((sum, [, s]) => sum + s.gross, 0) - parSum : null,
      netToPar: withPar.length ? withPar.reduce((sum, [, s]) => sum + s.net, 0) - parSum : null,
      place: 0,
    };
  });
  const byStrokes = parCoverage(holes) === "none";
  const key = (r) => (byStrokes ? (r.thru > 0 ? (useNet ? r.net : r.gross) : null) : useNet ? r.netToPar : r.toPar);
  const ranked = rows.map((r) => ({ ...r, ranked: key(r) != null }));
  return placeRows(ranked, (r) => key(r) ?? Number.MAX_SAFE_INTEGER);
}

/** groupGames.ts byHoleNumber. */
function byHoleNumber(holes) {
  return [...holes].sort((a, b) => a.number - b.number);
}

/** groupGames.ts strokeOnHole: strokes off the low of the players on this hole. */
function strokeOnHole(holes, field, playerId, holeNumber) {
  const off = strokesOffLow(field);
  if (!off) return 0;
  const given = off[playerId] ?? 0;
  if (given <= 0) return 0;
  return strokesByHole(holes, given).get(holeNumber) ?? 0;
}

/**
 * groupGames.ts skins. Holes settle in order and stop at the first hole where anyone is missing
 * a score. With carry-over a tied hole's skin rides on, so a carry counts one per hole it covers.
 * League rounds have no joiners, so `plays` is always true and the sequence is hole-number order.
 */
function skins(holes, players, useNet, carry, sequence) {
  const won = Object.fromEntries(players.map((p) => [p.id, 0]));
  const rows = [];
  let pot = 0;
  let waitingOn = null;
  for (const [i, hole] of sequence.entries()) {
    const field = players;
    if (field.length < 2) continue;
    const grosses = field.map((player) => {
      const gross = player.scores[hole.number];
      return validScore(gross) ? gross : null;
    });
    if (grosses.some((gross) => gross == null)) {
      const started =
        grosses.some((gross) => gross != null) ||
        sequence.slice(i + 1).some((later) => players.some((player) => validScore(player.scores[later.number])));
      if (started) {
        waitingOn = { holeNumber: hole.number, playerIds: field.filter((_, index) => grosses[index] == null).map((p) => p.id) };
      }
      break;
    }
    pot += 1;
    const values = field.map((player, index) => {
      const gross = grosses[index];
      return useNet ? gross - strokeOnHole(holes, field, player.id, hole.number) : gross;
    });
    const best = Math.min(...values);
    const winners = field.filter((_, index) => values[index] === best);
    if (winners.length === 1) {
      won[winners[0].id] += pot;
      rows.push({ number: hole.number, winnerId: winners[0].id, value: pot });
      pot = 0;
    } else {
      rows.push({ number: hole.number, winnerId: null, value: pot });
      if (!carry) pot = 0;
    }
  }
  return { won, holes: rows, carrying: carry ? pot : 0, waitingOn };
}

/**
 * The parts of groupGames.ts planGroupGames that leagueRoundResults uses: net (with net-blocked →
 * gross), stroke play rows and places, and skins. Stableford, match play and Nassau are off there.
 */
export function planLeagueGroupGames({ holes, players, settings }) {
  const blocked = netBlockReason(holes, players, { net: settings.net, stableford: false });
  const useNet = settings.net && blocked == null;
  const groupTable = scoreTable(holes, players, useNet ? strokesOffLow(players) : null);
  const numbered = byHoleNumber(holes);
  return {
    net: useNet,
    netBlocked: blocked != null,
    netBlockReason: blocked,
    table: groupTable,
    strokePlay: strokePlay(holes, players, groupTable, useNet),
    skins: settings.skins && players.length >= 2 ? skins(holes, players, useNet, settings.skinsCarry, numbered) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// leagueRound.ts

/** leagueRound.ts gameUsesTeams. */
export function gameUsesTeams(game, playerCount) {
  return (game === "matchPlay" || game === "nassau") && playerCount > 2;
}

/** leagueRound.ts scoreWriteRefusal (decision 4). */
export function scoreWriteRefusal(round, write) {
  if (round.finished) return "finished";
  const player = round.players.find((p) => p.memberId === write.memberId);
  if (!player) return "not_in_round";
  if (!round.holes.some((h) => h.number === write.hole)) return "bad_hole";
  const cell = round.cells[write.memberId]?.[write.hole];
  const actorIsHost = write.actorId === round.hostId;
  if (write.actorId === write.memberId) {
    if (cell?.enteredBy === "host" && !actorIsHost) return "host_entered";
    return null;
  }
  if (actorIsHost && player.hostEnters) return null;
  return "forbidden";
}

/** leagueRound.ts applyScoreWrite: compare-and-set, rev must be current + 1. */
export function applyScoreWrite(round, write) {
  const current = round.cells[write.memberId]?.[write.hole] ?? null;
  const refused = scoreWriteRefusal(round, write);
  if (refused) return { ok: false, reason: refused, cell: current };
  if (write.strokes != null && !(Number.isInteger(write.strokes) && write.strokes >= 1 && write.strokes <= 20)) {
    return { ok: false, reason: "bad_strokes", cell: current };
  }
  const currentRev = current?.rev ?? 0;
  if (write.rev !== currentRev + 1) return { ok: false, reason: "conflict", cell: current };
  const enteredBy = write.actorId === write.memberId ? "self" : "host";
  const cell = {
    strokes: write.strokes,
    rev: write.rev,
    enteredBy: current?.enteredBy === "host" && write.actorId === round.hostId ? "host" : enteredBy,
    by: write.actorId,
    at: write.at,
  };
  return {
    ok: true,
    cell,
    round: {
      ...round,
      cells: { ...round.cells, [write.memberId]: { ...(round.cells[write.memberId] ?? {}), [write.hole]: cell } },
      history: [...(round.history ?? []), { ...cell, memberId: write.memberId, hole: write.hole }],
    },
  };
}

/** leagueRound.ts scoresOf. */
function scoresOf(round, memberId) {
  const row = round.cells[memberId] ?? {};
  return Object.fromEntries(Object.entries(row).map(([hole, cell]) => [Number(hole), cell.strokes]));
}

/** leagueRound.ts groupPlayers. */
function groupPlayers(round) {
  return round.players.map((p) => ({ id: p.memberId, name: p.name, handicap: p.courseHandicap, scores: scoresOf(round, p.memberId) }));
}

/** leagueRound.ts holesPlayed. */
export function holesPlayed(round, memberId) {
  return Object.values(round.cells[memberId] ?? {}).filter((c) => c.strokes != null).length;
}

/** leagueRound.ts everyoneFinished (decision 9). */
export function everyoneFinished(round) {
  return round.players.length > 0 && round.players.every((p) => holesPlayed(round, p.memberId) >= round.holes.length);
}

/**
 * leagueRound.ts teamBestBall: each player's net (strokes off the low course handicap in the round,
 * in a Net league; handicaps only, as the app has it), the team's lowest on each hole. A hole counts
 * only when every team has a score on it.
 */
export function teamBestBall(round) {
  const out = new Map();
  const teams = round.teams ?? [];
  const players = groupPlayers(round);
  const off = round.scoring === "net" ? strokesOffLow(players) : null;
  const strokesFor = new Map(players.map((p) => [p.id, off ? strokesByHole(round.holes, off[p.id] ?? 0) : null]));
  const holes = [...round.holes].sort((a, b) => a.number - b.number);
  const raw = new Map();
  for (const team of teams) {
    const row = new Map();
    for (const hole of holes) {
      const nets = team.memberIds
        .map((id) => {
          const strokes = round.cells[id]?.[hole.number]?.strokes;
          return strokes == null ? null : strokes - (strokesFor.get(id)?.get(hole.number) ?? 0);
        })
        .filter((n) => n != null);
      row.set(hole.number, nets.length ? Math.min(...nets) : null);
    }
    raw.set(team.teamNo, row);
  }
  for (const team of teams) {
    out.set(
      team.teamNo,
      holes.map((hole) => {
        const everyTeam = teams.every((t) => raw.get(t.teamNo)?.get(hole.number) != null);
        return { number: hole.number, net: everyTeam ? (raw.get(team.teamNo)?.get(hole.number) ?? null) : null };
      }),
    );
  }
  return out;
}

/** leagueRound.ts teamMatchPoints (finish places for Pairs/Teams). */
export function teamMatchPoints(round) {
  const best = teamBestBall(round);
  const teams = round.teams ?? [];
  const points = new Map(teams.map((t) => [t.teamNo, 0]));
  const segments = round.game === "nassau" ? [(n) => n <= 9, (n) => n >= 10, () => true] : [() => true];
  for (let i = 0; i < teams.length; i += 1) {
    for (let j = i + 1; j < teams.length; j += 1) {
      const a = best.get(teams[i].teamNo) ?? [];
      const b = best.get(teams[j].teamNo) ?? [];
      for (const inSegment of segments) {
        let lead = 0;
        for (const hole of a) {
          if (!inSegment(hole.number)) continue;
          const other = b.find((h) => h.number === hole.number);
          if (hole.net == null || other?.net == null) continue;
          if (hole.net < other.net) lead += 1;
          else if (other.net < hole.net) lead -= 1;
        }
        const ta = teams[i].teamNo;
        const tb = teams[j].teamNo;
        if (lead > 0) points.set(ta, points.get(ta) + 1);
        else if (lead < 0) points.set(tb, points.get(tb) + 1);
        else {
          points.set(ta, points.get(ta) + 0.5);
          points.set(tb, points.get(tb) + 0.5);
        }
      }
    }
  }
  return points;
}

/** The Pairs/Teams branch of leagueRoundResults. */
function scoredAsTeams(round) {
  return Boolean(round.teams && round.teams.length >= 2 && gameUsesTeams(round.game, round.players.length));
}

/**
 * leagueRound.ts leagueRoundResults (screen 7, contract W4). `gamePoints` is filled from
 * leagueGamePoints when a snapshot of point values is given (the app's PR 3 engine leaves it 0).
 */
export function leagueRoundResults(round, gamePointValues = null) {
  const players = groupPlayers(round);
  const result = planLeagueGroupGames({
    holes: round.holes,
    players,
    settings: { net: round.scoring === "net", skins: round.game === "skins", skinsCarry: round.carryOver },
  });
  const skinsWon = result.skins?.won ?? null;
  const strokeRow = new Map(result.strokePlay.map((r) => [r.playerId, r]));
  const toPar = (id) => {
    const r = strokeRow.get(id);
    return r ? (result.net ? r.netToPar : r.toPar) : null;
  };
  let placeOf;
  if (scoredAsTeams(round)) {
    const pts = teamMatchPoints(round);
    const ordered = [...pts.entries()].sort((a, b) => b[1] - a[1]);
    const teamPlace = new Map();
    for (const [teamNo, p] of ordered) teamPlace.set(teamNo, 1 + ordered.filter(([, q]) => q > p).length);
    const teamOf = new Map(round.teams.flatMap((t) => t.memberIds.map((id) => [id, t.teamNo])));
    placeOf = (id) => {
      const teamNo = teamOf.get(id) ?? 0;
      return { unit: `team-${teamNo}`, place: teamPlace.get(teamNo) ?? round.players.length };
    };
  } else {
    placeOf = (id) => {
      const r = strokeRow.get(id);
      return { unit: id, place: r && r.ranked ? r.place : round.players.length };
    };
  }
  const gamePoints = gamePointValues ? leagueGamePoints(round, gamePointValues) : null;
  return {
    roundId: round.roundId,
    playedOn: round.playedOn,
    finished: round.finished,
    results: round.players.map((p) => {
      const { unit, place } = placeOf(p.memberId);
      return {
        memberId: p.memberId,
        unit,
        place,
        net: toPar(p.memberId),
        holes: holesPlayed(round, p.memberId),
        skins: skinsWon ? (skinsWon[p.memberId] ?? 0) : null,
        gamePoints: gamePoints ? (gamePoints.get(p.memberId) ?? 0) : 0,
        incomplete: holesPlayed(round, p.memberId) < round.holes.length,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Game points (W-C). New in the Worker; scored at finish from the round's own snapshot.

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Resolved point values: stored values over the defaults. A game missing from `stored` gets its defaults. */
export function resolveGamePoints(stored) {
  const out = {};
  for (const [game, lines] of Object.entries(GAME_POINT_LINES)) {
    const src = isPlainObject(stored) && isPlainObject(stored[game]) ? stored[game] : {};
    out[game] = {};
    for (const line of lines) {
      const v = src[line];
      out[game][line] = validPointValue(v) ? v : DEFAULT_GAME_POINTS[game][line];
    }
  }
  return out;
}

function validPointValue(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= GAME_POINTS_MAX;
}

/**
 * A partial gamePoints object merged over `base` (resolved). Null when the patch is not a valid
 * partial: a game other than the five, an unknown line, or a value that is not an integer 0–20.
 */
export function mergeGamePoints(base, patch) {
  if (!isPlainObject(patch)) return null;
  const out = resolveGamePoints(base);
  for (const [game, lines] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(GAME_POINT_LINES, game) || !isPlainObject(lines)) return null;
    for (const [line, value] of Object.entries(lines)) {
      if (!GAME_POINT_LINES[game].includes(line) || !validPointValue(value)) return null;
      out[game][line] = value;
    }
  }
  return out;
}

export function resolvePointsMode(stored) {
  return stored === "replace" ? "replace" : DEFAULT_POINTS_MODE;
}

/**
 * The round's units and each unit's score per hole, the same units the finish places use:
 * a team in a Pairs/Teams round (best ball from teamBestBall, so a hole has a score only when
 * every team has one), otherwise each player (the engine's gross or net off the low course
 * handicap, gross when net is blocked).
 */
function gameUnits(round) {
  const holes = byHoleNumber(round.holes);
  if (scoredAsTeams(round)) {
    const best = teamBestBall(round);
    return {
      holes,
      units: round.teams.map((t) => {
        const byHole = new Map((best.get(t.teamNo) ?? []).map((h) => [h.number, h.net]));
        return { id: `team-${t.teamNo}`, memberIds: [...t.memberIds], score: (n) => byHole.get(n) ?? null };
      }),
    };
  }
  const players = groupPlayers(round);
  const plan = planLeagueGroupGames({ holes: round.holes, players, settings: { net: round.scoring === "net", skins: false, skinsCarry: false } });
  return {
    holes,
    useNet: plan.net,
    units: round.players.map((p) => {
      const row = plan.table.get(p.memberId) ?? new Map();
      return {
        id: p.memberId,
        memberIds: [p.memberId],
        score: (n) => {
          const s = row.get(n);
          return s ? (plan.net ? s.net : s.gross) : null;
        },
      };
    }),
  };
}

/** Front = holes 1–9, back = holes 10–18 (the same split as teamMatchPoints). Only nines with holes. */
function nines(holes) {
  return [holes.filter((h) => h.number <= 9), holes.filter((h) => h.number >= 10)].filter((list) => list.length > 0);
}

/** `value` shared equally among `winners` (unit ids), added into `points`. */
function share(points, winners, value) {
  if (winners.length === 0 || value === 0) return;
  for (const id of winners) points.set(id, (points.get(id) ?? 0) + value / winners.length);
}

/** Unit ids with the best value (`better(a, b)` true when a beats b). */
function bestOf(entries, better) {
  let best = [];
  for (const [id, v] of entries) {
    if (best.length === 0 || better(v, best[0][1])) best = [[id, v]];
    else if (!better(best[0][1], v)) best.push([id, v]);
  }
  return best.map(([id]) => id);
}

function matchPlayPoints(units, holes, values, points) {
  // A hole counts only when every unit has a score on it.
  const counted = holes.filter((h) => units.every((u) => u.score(h.number) != null));
  const wins = new Map(units.map((u) => [u.id, new Map()]));
  for (const hole of counted) {
    const scores = units.map((u) => [u.id, u.score(hole.number)]);
    const winners = bestOf(scores, (a, b) => a < b);
    share(points, winners, values.perHole);
    // A halved hole is ½ a win each (1 ÷ the units sharing it).
    for (const id of winners) wins.get(id).set(hole.number, 1 / winners.length);
  }
  const segmentWinners = (list) => {
    const inSeg = new Set(list.map((h) => h.number));
    if (!counted.some((h) => inSeg.has(h.number))) return [];
    const totals = units.map((u) => [u.id, [...wins.get(u.id).entries()].filter(([n]) => inSeg.has(n)).reduce((s, [, w]) => s + w, 0)]);
    return bestOf(totals, (a, b) => a > b + POINTS_EPSILON);
  };
  for (const nine of nines(holes)) share(points, segmentWinners(nine), values.per9);
  share(points, segmentWinners(holes), values.fullRound);
}

/** Stroke play and Stableford: individual, a player must have scored every hole of the segment that counts. */
function segmentBest(units, list, { counts, total, lowWins }) {
  const countedHoles = list.filter(counts);
  if (countedHoles.length === 0) return [];
  const eligible = units.filter((u) => countedHoles.every((h) => u.score(h.number) != null));
  if (eligible.length === 0) return [];
  const totals = eligible.map((u) => [u.id, countedHoles.reduce((s, h) => s + total(u.score(h.number), h), 0)]);
  return bestOf(totals, lowWins ? (a, b) => a < b : (a, b) => a > b);
}

function strokePlayPoints(units, holes, values, points) {
  const opts = { counts: () => true, total: (score) => score, lowWins: true };
  for (const nine of nines(holes)) share(points, segmentBest(units, nine, opts), values.per9);
  share(points, segmentBest(units, holes, opts), values.fullRound);
}

/** Stableford points per hole as groupGames.ts stableford: max(0, 2 + par − score). No valid par: skipped. */
function stablefordPoints(units, holes, values, points) {
  const opts = { counts: (h) => validPar(h.par), total: (score, h) => Math.max(0, 2 + h.par - score), lowWins: false };
  for (const nine of nines(holes)) share(points, segmentBest(units, nine, opts), values.per9);
  share(points, segmentBest(units, holes, opts), values.fullRound);
}

/** Every pair of units plays its own match per segment (the teamMatchPoints loop). */
function nassauPoints(units, holes, values, points) {
  const segments = [
    [(n) => n <= 9, values.per9],
    [(n) => n >= 10, values.per9],
    [() => true, values.fullRound],
  ];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      for (const [inSegment, value] of segments) {
        let lead = 0;
        let counted = 0;
        for (const hole of holes) {
          if (!inSegment(hole.number)) continue;
          const av = a.score(hole.number);
          const bv = b.score(hole.number);
          if (av == null || bv == null) continue;
          counted += 1;
          if (av < bv) lead += 1;
          else if (bv < av) lead -= 1;
        }
        if (counted === 0) continue;
        if (lead > 0) share(points, [a.id], value);
        else if (lead < 0) share(points, [b.id], value);
        else share(points, [a.id, b.id], value);
      }
    }
  }
}

/**
 * Game points per member for one finished round, from the round's own snapshot of point values.
 * Every player on a team gets the team's points. Fewer than 2 units score nothing. Exact (no rounding).
 */
export function leagueGamePoints(round, values) {
  const resolved = resolveGamePoints(values);
  const out = new Map(round.players.map((p) => [p.memberId, 0]));
  const { units, holes } = gameUnits(round);
  if (units.length < 2) return out;
  const points = new Map(units.map((u) => [u.id, 0]));
  if (round.game === "matchPlay") matchPlayPoints(units, holes, resolved.matchPlay, points);
  else if (round.game === "strokePlay") strokePlayPoints(units, holes, resolved.strokePlay, points);
  else if (round.game === "stableford") stablefordPoints(units, holes, resolved.stableford, points);
  else if (round.game === "nassau") nassauPoints(units, holes, resolved.nassau, points);
  else if (round.game === "skins") {
    const plan = planLeagueGroupGames({
      holes: round.holes,
      players: groupPlayers(round),
      settings: { net: round.scoring === "net", skins: true, skinsCarry: round.carryOver },
    });
    for (const [id, won] of Object.entries(plan.skins?.won ?? {})) points.set(id, won * resolved.skins.perSkin);
  }
  for (const unit of units) {
    for (const memberId of unit.memberIds) {
      if (out.has(memberId)) out.set(memberId, out.get(memberId) + (points.get(unit.id) ?? 0));
    }
  }
  return out;
}
