/**
 * Writes test/fixtures/league-round-results.golden.json from the ShotTraxx app's own
 * leagueRoundResults (bigbaird83/ShotTraxx b555c794c180cc8536f8bafa45d333cfbba9b0d0), so the
 * Worker's port (league-scoring.js) can be checked against it byte for byte.
 *
 *   git clone https://github.com/bigbaird83/ShotTraxx /tmp/shottraxx-ref
 *   git -C /tmp/shottraxx-ref checkout b555c794c180cc8536f8bafa45d333cfbba9b0d0
 *   npx tsx scripts/league-golden.mts [/tmp/shottraxx-ref]
 *
 * Read-only use of the app repo. Every round here is made up.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ref = resolve(process.argv[2] ?? '/tmp/shottraxx-ref');
const { leagueRoundResults } = await import(pathToFileURL(`${ref}/src/domain/leagueRound.ts`).href);

type Hole = { number: number; par: number | null; strokeIndex: number | null };
type Player = { memberId: string; courseHandicap: number | null; scores: (number | null)[] };

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4];
const SI = [7, 3, 15, 1, 11, 5, 17, 9, 13, 8, 18, 2, 10, 4, 14, 16, 6, 12];
const card18: Hole[] = PARS.map((par, i) => ({ number: i + 1, par, strokeIndex: SI[i] }));
const front9: Hole[] = card18.slice(0, 9);
const back9: Hole[] = card18.slice(9);
const noIndexes: Hole[] = card18.map((h) => ({ ...h, strokeIndex: null }));
const onePar: Hole[] = card18.map((h) => (h.number === 7 ? { ...h, par: null } : h));

/** Deterministic made-up scores: par plus a small offset from a seeded generator. */
function scoresFor(holes: Hole[], seed: number, spread = 2): number[] {
  let s = seed;
  return holes.map((h) => {
    s = (s * 48271) % 2147483647;
    return (h.par ?? 4) + (s % (spread + 1)) - 1 + (s % 7 === 0 ? 1 : 0);
  });
}

function round(name: string, args: {
  holes: Hole[];
  game: string;
  scoring: 'gross' | 'net';
  carryOver?: boolean;
  teamsMode?: 'pairs' | 'teams' | null;
  teams?: { teamNo: number; memberIds: string[] }[] | null;
  players: Player[];
}) {
  const cells: Record<string, Record<number, unknown>> = {};
  for (const p of args.players) {
    args.holes.forEach((h, i) => {
      const strokes = p.scores[i];
      if (strokes === undefined) return;
      (cells[p.memberId] ??= {})[h.number] = { strokes, rev: 1, enteredBy: 'self', by: p.memberId, at: 1_800_000_000_000 + i };
    });
  }
  return {
    name,
    round: {
      roundId: `${'L'.repeat(22)}_${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, 'x')}`,
      leagueId: 'L'.repeat(22),
      hostId: args.players[0]!.memberId,
      startedAt: 1_800_000_000_000,
      playedOn: '2026-11-21',
      course: 'Mock Pines GC',
      holes: args.holes,
      game: args.game,
      scoring: args.scoring,
      carryOver: args.carryOver ?? false,
      teamsMode: args.teamsMode ?? null,
      teams: args.teams ?? null,
      players: args.players.map((p, i) => ({
        memberId: p.memberId,
        name: `Player ${String.fromCharCode(65 + i)}`,
        kind: 'app',
        groupNo: Math.floor(i / 4) + 1,
        courseHandicap: p.courseHandicap,
        hostEnters: false,
      })),
      cells,
      history: [],
      finished: true,
    },
  };
}

const p = (memberId: string, courseHandicap: number | null, scores: (number | null)[]): Player => ({ memberId, courseHandicap, scores });

// Skins card: hole 2 and 3 tied (carry), hole 4 won; last hole missing for one player.
const skinsA = [4, 4, 3, 4, 5, 4, 3, 6, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4];
const skinsB = [5, 4, 3, 5, 4, 4, 3, 5, 4, 5, 3, 4, 4, 4, 5, 3, 5, null];
const skinsC = [5, 4, 3, 6, 5, 5, 4, 5, 5, 4, 3, 5, 5, 4, 4, 3, 6, 4];

const rounds = [
  round('stroke gross 2p', { holes: card18, game: 'strokePlay', scoring: 'gross', players: [p('m1', 4, scoresFor(card18, 11)), p('m2', 12, scoresFor(card18, 29))] }),
  round('stroke net 2p', { holes: card18, game: 'strokePlay', scoring: 'net', players: [p('m1', 4, scoresFor(card18, 11)), p('m2', 12, scoresFor(card18, 29))] }),
  round('net blank handicap', { holes: card18, game: 'strokePlay', scoring: 'net', players: [p('m1', 4, scoresFor(card18, 11)), p('m2', null, scoresFor(card18, 29)), p('m3', 9, scoresFor(card18, 5))] }),
  round('net no stroke index', { holes: noIndexes, game: 'strokePlay', scoring: 'net', players: [p('m1', 2, scoresFor(card18, 13)), p('m2', 8, scoresFor(card18, 17))] }),
  round('nine front net', { holes: front9, game: 'strokePlay', scoring: 'net', players: [p('m1', 5, scoresFor(front9, 3)), p('m2', 14, scoresFor(front9, 7)), p('m3', 9, scoresFor(front9, 19))] }),
  round('nine back gross', { holes: back9, game: 'strokePlay', scoring: 'gross', players: [p('m1', 5, scoresFor(back9, 3)), p('m2', 14, scoresFor(back9, 7))] }),
  round('skins carry on', { holes: card18, game: 'skins', scoring: 'gross', carryOver: true, players: [p('m1', 0, skinsA), p('m2', 0, skinsB), p('m3', 0, skinsC)] }),
  round('skins carry off', { holes: card18, game: 'skins', scoring: 'gross', carryOver: false, players: [p('m1', 0, skinsA), p('m2', 0, skinsB), p('m3', 0, skinsC)] }),
  round('skins net carry', { holes: card18, game: 'skins', scoring: 'net', carryOver: true, players: [p('m1', 2, skinsA), p('m2', 10, skinsB.map((s) => s ?? 5)), p('m3', 18, skinsC)] }),
  round('match 2p', { holes: card18, game: 'matchPlay', scoring: 'net', players: [p('m1', 6, scoresFor(card18, 41)), p('m2', 10, scoresFor(card18, 43))] }),
  round('match 4p pairs', {
    holes: card18,
    game: 'matchPlay',
    scoring: 'net',
    teamsMode: 'pairs',
    teams: [{ teamNo: 1, memberIds: ['m1', 'm4'] }, { teamNo: 2, memberIds: ['m2', 'm3'] }],
    players: [p('m1', 3, scoresFor(card18, 51)), p('m2', 8, scoresFor(card18, 53)), p('m3', 15, scoresFor(card18, 57)), p('m4', 20, scoresFor(card18, 59))],
  }),
  round('match 3 teams', {
    holes: card18,
    game: 'matchPlay',
    scoring: 'gross',
    teamsMode: 'teams',
    teams: [{ teamNo: 1, memberIds: ['m1', 'm6'] }, { teamNo: 2, memberIds: ['m2', 'm5'] }, { teamNo: 3, memberIds: ['m3', 'm4'] }],
    players: [1, 2, 3, 4, 5, 6].map((n) => p(`m${n}`, n * 3, scoresFor(card18, 60 + n * 7))),
  }),
  round('nassau teams', {
    holes: card18,
    game: 'nassau',
    scoring: 'net',
    teamsMode: 'pairs',
    teams: [{ teamNo: 1, memberIds: ['m1', 'm3'] }, { teamNo: 2, memberIds: ['m2', 'm4'] }],
    players: [p('m1', 2, scoresFor(card18, 71)), p('m2', 7, scoresFor(card18, 73)), p('m3', 12, scoresFor(card18, 79)), p('m4', 16, scoresFor(card18, 83))],
  }),
  round('nassau 2p', { holes: card18, game: 'nassau', scoring: 'gross', players: [p('m1', 0, scoresFor(card18, 91)), p('m2', 0, scoresFor(card18, 97))] }),
  round('stableford', { holes: card18, game: 'stableford', scoring: 'net', players: [p('m1', 5, scoresFor(card18, 101)), p('m2', 11, scoresFor(card18, 103)), p('m3', 18, scoresFor(card18, 107))] }),
  round('incomplete player', {
    holes: card18,
    game: 'strokePlay',
    scoring: 'gross',
    players: [p('m1', 0, scoresFor(card18, 111)), p('m2', 0, scoresFor(card18, 113).map((s, i) => (i >= 12 ? null : s))), p('m3', 0, [])],
  }),
  round('hole with no par', { holes: onePar, game: 'strokePlay', scoring: 'gross', players: [p('m1', 0, scoresFor(onePar, 121)), p('m2', 0, scoresFor(onePar, 127))] }),
  round('stroke ties', { holes: front9, game: 'strokePlay', scoring: 'gross', players: [p('m1', 0, [4, 4, 3, 5, 4, 4, 3, 5, 4]), p('m2', 0, [5, 4, 3, 4, 4, 4, 3, 5, 4]), p('m3', 0, [4, 5, 3, 5, 4, 4, 3, 5, 4])] }),
];

const fixtures = rounds.map(({ name, round: r }) => ({ name, round: r, expected: leagueRoundResults(r) }));
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/league-round-results.golden.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ source: 'bigbaird83/ShotTraxx b555c794c180cc8536f8bafa45d333cfbba9b0d0 src/domain/leagueRound.ts leagueRoundResults', fixtures }, null, 2)}\n`);
console.log(`wrote ${fixtures.length} fixtures to ${out}`);
