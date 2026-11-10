/**
 * Greens-no-tees pull, queue, and fill. MOCK coordinates only. No golfapi.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  CREDIT_FLOOR,
  GOLFER_LIVE_DAILY_CREDIT_CAP,
  GOLFAPI_PULL_ENDPOINTS,
  PHONE_PULLS_PER_DAY,
  appendCardVersion,
  buildDailyDigest,
  claimCoursePull,
  golfApiCreditsForPull,
  golfApiEndpointsForPull,
  holeNumbersForTeeFill,
  liveCardPublishVerdict,
  livePullBlockedByCap,
  mergeMissingHoles,
  readServedCard,
  resetGreensNoTeesPullsForTests,
  runGreensNoTeesPull,
  setCardFlag,
} from './greensNoTeesPull.mjs';

/** MOCK course. Not a real club. Tee sits about 401 yd north of the green. */
const MOCK_GREEN = { lat: 35.52, lng: -92.04 };
const MOCK_TEE = { lat: 35.523295, lng: -92.04 };

function mockHole(hole: number, tee: { lat: number; lng: number } | null, yards = 401, par = 4) {
  const shift = (hole - 1) * 0.004;
  return {
    hole,
    tee: tee ? { lat: tee.lat + shift, lng: tee.lng } : null,
    green: { lat: MOCK_GREEN.lat + shift, lng: MOCK_GREEN.lng },
    par,
    yards,
    source: 'mock',
  };
}

function eighteen(withTee: boolean) {
  return Array.from({ length: 18 }, (_, i) => mockHole(i + 1, withTee ? MOCK_TEE : null));
}

function sources(impl: {
  osm?: (missing: number[]) => Promise<{ holes: ReturnType<typeof mockHole>[]; count?: number } | null>;
  gca?: (missing: number[]) => Promise<{ holes: ReturnType<typeof mockHole>[]; count?: number } | null>;
  golfapi?: (missing: number[]) => Promise<{ holes: ReturnType<typeof mockHole>[]; count?: number } | null>;
}) {
  return impl;
}

test('golfapi credits stay 2.1 with search, 2 with a known id, and 0 from the shared card', () => {
  assert.equal(GOLFER_LIVE_DAILY_CREDIT_CAP, 150);
  assert.equal(PHONE_PULLS_PER_DAY, 4);
  assert.equal(CREDIT_FLOOR, 156);
  assert.equal(golfApiCreditsForPull({ knownCourseId: false }), 2.1);
  assert.equal(golfApiCreditsForPull({ knownCourseId: true }), 2);
  assert.equal(golfApiCreditsForPull({ fromSharedCard: true, knownCourseId: false }), 0);
  assert.deepEqual(golfApiEndpointsForPull({ knownCourseId: false }), [
    GOLFAPI_PULL_ENDPOINTS.search,
    GOLFAPI_PULL_ENDPOINTS.course,
    GOLFAPI_PULL_ENDPOINTS.coordinates,
  ]);
  assert.deepEqual(golfApiEndpointsForPull({ knownCourseId: true }), [
    GOLFAPI_PULL_ENDPOINTS.course,
    GOLFAPI_PULL_ENDPOINTS.coordinates,
  ]);
  assert.deepEqual(golfApiEndpointsForPull({ fromSharedCard: true }), []);
  const proxy = readFileSync(new URL('../../golf-proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /const DEFAULT_APP_DAILY = 150;/);
});

test('one tee missing asks the next source for that hole only and keeps the good holes', async () => {
  resetGreensNoTeesPullsForTests();
  const holes = eighteen(true).map((hole) => (hole.hole === 4 ? { ...hole, tee: null } : hole));
  const asked: Record<string, number[][]> = { osm: [], gca: [], golfapi: [] };
  const result = await runGreensNoTeesPull({
    courseId: 'mock-one-tee',
    holes,
    count: 18,
    sources: sources({
      osm: async (missing) => {
        asked.osm.push(missing);
        return null;
      },
      gca: async (missing) => {
        asked.gca.push(missing);
        return { holes: [mockHole(4, MOCK_TEE)], count: 18 };
      },
      golfapi: async (missing) => {
        asked.golfapi.push(missing);
        throw new Error('golfapi must not be asked when GCA fills the missing tee');
      },
    }),
  });
  assert.deepEqual(asked.osm, [[4]]);
  assert.deepEqual(asked.gca, [[4]]);
  assert.deepEqual(asked.golfapi, []);
  assert.equal(result.filled, true);
  assert.equal(result.published, true);
  assert.equal(result.credits, 0);
  assert.equal(result.holes.find((hole) => hole.hole === 1)?.tee?.lat, holes[0]?.tee?.lat);
  assert.ok(result.holes.find((hole) => hole.hole === 4)?.tee);
});

test('a complete OSM card does not call GCA or golfapi', async () => {
  resetGreensNoTeesPullsForTests();
  const calls: string[] = [];
  const result = await runGreensNoTeesPull({
    courseId: 'mock-osm-complete',
    count: 18,
    sources: sources({
      osm: async () => {
        calls.push('osm');
        return { holes: eighteen(true), count: 18 };
      },
      gca: async () => {
        calls.push('gca');
        return { holes: eighteen(true) };
      },
      golfapi: async () => {
        calls.push('golfapi');
        return { holes: eighteen(true) };
      },
    }),
  });
  assert.deepEqual(calls, ['osm']);
  assert.equal(result.filled, true);
  assert.equal(result.credits, 0);
  assert.deepEqual(result.endpoints, []);
});

test('OSM partial then GCA fill does not call golfapi', async () => {
  resetGreensNoTeesPullsForTests();
  const calls: string[] = [];
  const result = await runGreensNoTeesPull({
    courseId: 'mock-gca-fills',
    count: 18,
    sources: sources({
      osm: async () => {
        calls.push('osm');
        return { holes: eighteen(true).filter((hole) => hole.hole !== 7), count: 18 };
      },
      gca: async (missing) => {
        calls.push('gca');
        assert.deepEqual(missing, [7]);
        return { holes: [mockHole(7, MOCK_TEE)] };
      },
      golfapi: async () => {
        calls.push('golfapi');
        return null;
      },
    }),
  });
  assert.deepEqual(calls, ['osm', 'gca']);
  assert.equal(result.holes.find((hole) => hole.hole === 7)?.tee != null, true);
  assert.equal(result.credits, 0);
});

test('every source missing tees queues greens-only and does not invent a tee', async () => {
  resetGreensNoTeesPullsForTests();
  const result = await runGreensNoTeesPull({
    courseId: 'mock-all-miss',
    holes: eighteen(false),
    count: 18,
    knownCourseId: true,
    sources: sources({
      osm: async () => ({ holes: eighteen(false) }),
      gca: async () => ({ holes: eighteen(false) }),
      golfapi: async () => null,
    }),
  });
  assert.equal(result.queued, true);
  assert.equal(result.reason, 'no_data');
  assert.equal(result.filled, false);
  assert.equal(result.published, false);
  assert.equal(result.holes.every((hole) => hole.tee == null), true);
  assert.equal(result.credits, 2);
  assert.deepEqual(result.endpoints, [GOLFAPI_PULL_ENDPOINTS.course, GOLFAPI_PULL_ENDPOINTS.coordinates]);
});

test('a source throw moves on, and all three throwing queues without throwing', async () => {
  resetGreensNoTeesPullsForTests();
  const calls: string[] = [];
  const result = await runGreensNoTeesPull({
    courseId: 'mock-all-throw',
    holes: [mockHole(1, null)],
    count: 1,
    sources: sources({
      osm: async () => {
        calls.push('osm');
        throw new Error('MOCK osm down');
      },
      gca: async () => {
        calls.push('gca');
        throw new Error('MOCK gca down');
      },
      golfapi: async () => {
        calls.push('golfapi');
        throw new Error('MOCK golfapi down');
      },
    }),
  });
  assert.deepEqual(calls, ['osm', 'gca', 'golfapi']);
  assert.equal(result.queued, true);
  assert.equal(result.reason, 'failed');
  assert.equal(result.holes[0]?.tee, null);
});

test('the shared card is served to the second phone at 0 credits and golfapi is not called', async () => {
  resetGreensNoTeesPullsForTests();
  const store = new Map<string, { holes: ReturnType<typeof mockHole>[]; count: number }>();
  let golfapi = 0;
  const first = await runGreensNoTeesPull({
    courseId: 'mock-shared',
    count: 9,
    knownCourseId: false,
    readShared: async (id) => store.get(id) ?? null,
    writeShared: async (id, card) => {
      store.set(id, { holes: card.holes, count: card.count ?? 9 });
    },
    sources: sources({
      osm: async () => null,
      gca: async () => null,
      golfapi: async () => {
        golfapi += 1;
        return { holes: Array.from({ length: 9 }, (_, i) => mockHole(i + 1, MOCK_TEE)), count: 9 };
      },
    }),
  });
  assert.equal(first.published, true);
  assert.equal(first.credits, 2.1);
  assert.equal(golfapi, 1);
  const second = await runGreensNoTeesPull({
    courseId: 'mock-shared',
    count: 9,
    readShared: async (id) => store.get(id) ?? null,
    sources: sources({
      osm: async () => {
        throw new Error('second phone must not rebuild');
      },
      gca: async () => {
        throw new Error('second phone must not call GCA');
      },
      golfapi: async () => {
        throw new Error('second phone must not call golfapi');
      },
    }),
  });
  assert.equal(second.fromShared, true);
  assert.equal(second.credits, 0);
  assert.deepEqual(second.endpoints, []);
  assert.equal(golfapi, 1);
});

test('two phones pulling the same MOCK course at once share one golfapi call', async () => {
  resetGreensNoTeesPullsForTests();
  const inflight = new Map();
  let golfapi = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pull = () =>
    runGreensNoTeesPull({
      courseId: 'mock-dedupe',
      count: 1,
      inflight,
      caps: { phonePullsToday: 0, appCreditsToday: 0, balanceLeft: 400 },
      sources: sources({
        golfapi: async () => {
          golfapi += 1;
          await gate;
          return { holes: [mockHole(1, MOCK_TEE)], count: 1 };
        },
      }),
    });
  const first = pull();
  const second = pull();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(golfapi, 1);
  release?.();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.filled, true);
  assert.equal(b.filled, true);
  assert.equal(golfapi, 1);
  assert.equal(inflight.size, 0);
});

test('a failed pull does not stick the dedupe lock', async () => {
  const inflight = new Map();
  const key = 'mock-dedupe-fail';
  await assert.rejects(claimCoursePull(inflight, key, async () => {
    throw new Error('MOCK fail');
  }));
  assert.equal(inflight.has(key), false);
  const again = await claimCoursePull(inflight, key, async () => 'ok');
  assert.equal(again, 'ok');
});

test('caps queue the pull and do not call golfapi: 5th phone pull, app cap, and the floor', async () => {
  resetGreensNoTeesPullsForTests();
  assert.equal(livePullBlockedByCap({ phonePullsToday: 4, creditsThisPull: 2 }), 'phone_limit');
  assert.equal(livePullBlockedByCap({ phonePullsToday: 3, appCreditsToday: 149, creditsThisPull: 2.1 }), 'app_cap');
  assert.equal(livePullBlockedByCap({ balanceLeft: 156, creditsThisPull: 1 }), 'floor');
  assert.equal(livePullBlockedByCap({ balanceLeft: 156, creditsThisPull: 2.1 }), 'floor');
  assert.equal(livePullBlockedByCap({ balanceLeft: 157, creditsThisPull: 2.1 }), 'floor');
  assert.equal(livePullBlockedByCap({ balanceLeft: 157, creditsThisPull: 1 }), null);
  assert.equal(livePullBlockedByCap({ balanceLeft: 158.1, creditsThisPull: 2.1 }), null);
  assert.equal(livePullBlockedByCap({ phonePullsToday: 3, appCreditsToday: 147, balanceLeft: 400, creditsThisPull: 2.1 }), null);
  for (const [label, caps, reason] of [
    ['phone', { phonePullsToday: 4, appCreditsToday: 0, balanceLeft: 400 }, 'phone_limit'],
    ['app', { phonePullsToday: 0, appCreditsToday: 149, balanceLeft: 400 }, 'app_cap'],
    ['floor-156', { phonePullsToday: 0, appCreditsToday: 0, balanceLeft: 156 }, 'floor'],
    ['floor-157', { phonePullsToday: 0, appCreditsToday: 0, balanceLeft: 157 }, 'floor'],
  ] as const) {
    let golfapi = 0;
    const result = await runGreensNoTeesPull({
      courseId: `mock-cap-${label}`,
      holes: eighteen(false),
      count: 18,
      caps,
      sources: sources({
        osm: async () => null,
        gca: async () => null,
        golfapi: async () => {
          golfapi += 1;
          return { holes: eighteen(true) };
        },
      }),
    });
    assert.equal(golfapi, 0, label);
    assert.equal(result.queued, true, label);
    assert.equal(result.reason, reason, label);
    assert.equal(result.credits, 0, label);
    assert.equal(result.holes.every((hole) => hole.tee == null), true, label);
  }

  let spent = 0;
  const allowed = await runGreensNoTeesPull({
    courseId: 'mock-floor-158',
    holes: eighteen(false),
    count: 18,
    caps: { phonePullsToday: 0, appCreditsToday: 0, balanceLeft: 158.1 },
    sources: sources({
      osm: async () => null,
      gca: async () => null,
      golfapi: async () => {
        spent += 1;
        return { holes: eighteen(true) };
      },
    }),
  });
  assert.equal(spent, 1);
  assert.equal(allowed.reason, null);
  assert.equal(allowed.filled, true);
});

test('a card that fails 15%, a missing tee, the guard, the outline, or the wrong course is not published', () => {
  const outline = [
    [35.5, -92.1],
    [35.5, -91.9],
    [35.55, -91.9],
    [35.55, -92.1],
  ];
  const ok = liveCardPublishVerdict({ holes: [mockHole(1, MOCK_TEE)], count: 1, outline });
  assert.equal(ok.ok, true);
  const far = mockHole(1, { lat: 35.9, lng: -92.04 }, 260);
  const scorecard = liveCardPublishVerdict({ holes: [far], count: 1 });
  assert.equal(scorecard.ok, false);
  assert.equal(scorecard.reason, 'scorecard');
  const missing = liveCardPublishVerdict({ holes: [mockHole(1, null)], count: 1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-tee');
  const guarded = liveCardPublishVerdict({ holes: [mockHole(1, MOCK_TEE)], count: 1, guarded: true });
  assert.equal(guarded.reason, 'hash-ok');
  const outside = {
    hole: 1,
    tee: { lat: 35.5633, lng: -92.0 },
    green: { lat: 35.56, lng: -92.0 },
    par: 4,
    yards: 401,
  };
  const outlineFail = liveCardPublishVerdict({ holes: [outside], count: 1, outline });
  assert.equal(outlineFail.ok, false);
  assert.equal(outlineFail.reason, 'outline');
  const wrong = liveCardPublishVerdict({ holes: [mockHole(1, MOCK_TEE)], count: 1, sisterCourse: true });
  assert.equal(wrong.reason, 'wrong-course');
});

test('a pull that would change a bundled, hand-pinned, or guarded course is refused', async () => {
  resetGreensNoTeesPullsForTests();
  for (const flag of ['bundled', 'handPinned', 'guarded'] as const) {
    let called = 0;
    const result = await runGreensNoTeesPull({
      courseId: `mock-${flag}`,
      [flag]: true,
      holes: eighteen(false),
      count: 18,
      sources: sources({
        golfapi: async () => {
          called += 1;
          return { holes: eighteen(true) };
        },
      }),
    });
    assert.equal(called, 0, flag);
    assert.equal(result.reason, 'hash-ok', flag);
    assert.equal(result.published, false, flag);
  }
});

test('hidden serves Not mapped yet, revert serves the previous card, and every publish is kept', () => {
  const store = new Map();
  appendCardVersion(store, 'mock-course', { id: 'v1', holes: [mockHole(1, MOCK_TEE, 380)] });
  appendCardVersion(store, 'mock-course', { id: 'v2', holes: [mockHole(1, MOCK_TEE, 401)] });
  const row = store.get('mock-course');
  assert.equal(row.versions.length, 2);
  assert.equal(readServedCard(row)?.card.id, 'v2');
  assert.equal(setCardFlag(store, 'mock-course', 'hidden')?.message, 'Not mapped yet');
  assert.equal(setCardFlag(store, 'mock-course', 'hidden')?.mapped, false);
  const reverted = setCardFlag(store, 'mock-course', 'revert');
  assert.equal(reverted?.card.id, 'v1');
  assert.equal(reverted?.reverted, true);
  assert.equal(store.get('mock-course').versions.length, 2);
});

test('the digest lists every course published in the last 24 h, plus flags', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const digest = buildDailyDigest(
    [
      { id: 'mock-a', kind: 'published', at: now - 1000, flags: [] },
      { id: 'mock-b', kind: 'published', at: now - 2000, flags: [{ hole: 4, reason: 'neighbor' }] },
      { id: 'mock-c', kind: 'queued', at: now - 3000, flags: [] },
      { id: 'mock-d', kind: 'hidden', at: now - 4000, flags: [] },
      { id: 'mock-old', kind: 'published', at: now - day - 1, flags: [{ hole: 1, reason: 'neighbor' }] },
    ],
    now,
  );
  assert.equal(digest.published, 2);
  assert.equal(digest.queued, 1);
  assert.equal(digest.hidden, 1);
  assert.deepEqual(digest.courses, ['mock-a', 'mock-b']);
  assert.deepEqual(digest.flagged, [{ id: 'mock-b', flags: [{ hole: 4, reason: 'neighbor' }] }]);
});

test('merge does not invent a tee when the next source has none', () => {
  const kept = [mockHole(1, null)];
  const merged = mergeMissingHoles(kept, [{ hole: 1, tee: null, green: MOCK_GREEN, par: 4, yards: 401 }], [1]);
  assert.equal(merged[0]?.tee, null);
  assert.deepEqual(merged[0]?.green, kept[0]?.green);
  assert.deepEqual(holeNumbersForTeeFill(merged, 1), [1]);
  assert.deepEqual(holeNumbersForTeeFill([mockHole(1, MOCK_TEE)], 1), []);
});
