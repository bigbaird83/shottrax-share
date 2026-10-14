import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { GolfapiCounter, handleGolfProxy } from './golf-proxy.js';
import {
  BALANCE_PROBE_NAME,
  classifyOverlayPayload,
  coverageFromOverlayResponse,
  livePullAllowed,
  runGolfapiStockpile,
  stockpileKeys,
  stockpilePhase,
  stockpileRunsRemaining,
  stockpileSchedule,
  usStateCode,
} from './golf-stockpile.js';

const BULK_AT = Date.parse('2026-11-04T23:00:00Z');
const DAY2_AT = Date.parse('2026-11-02T23:00:00Z');

class MemorySql {
  constructor() {
    this.map = new Map();
  }
  exec(query, ...args) {
    const text = query.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE')) return [];
    if (text.startsWith('SELECT')) {
      const value = this.map.get(args[0]);
      return value == null ? [] : [{ value }];
    }
    if (text.startsWith('INSERT')) {
      this.map.set(args[0], String(args[1]));
      return [];
    }
    if (text.startsWith('DELETE')) {
      this.map.delete(args[0]);
      return [];
    }
    throw new Error(`unexpected sql ${text}`);
  }
}

class FakeCounter {
  constructor() {
    this.sql = new MemorySql();
    this.stub = new GolfapiCounter({
      storage: { sql: this.sql },
      blockConcurrencyWhile(fn) {
        return fn();
      },
    });
    this.chain = Promise.resolve();
  }
  idFromName() {
    return 'golfapi';
  }
  get() {
    return {
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const run = this.chain.then(() => this.stub.fetch(request));
        this.chain = run.then(() => undefined, () => undefined);
        return run;
      },
    };
  }
}

class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key)?.value ?? null;
  }
  async put(key, value) {
    this.store.set(key, { value: String(value) });
  }
}

function baseEnv(extra = {}) {
  const kv = new FakeKV();
  const counter = new FakeCounter();
  const sent = [];
  const env = {
    GOLFAPI_KEY: 'golf-secret',
    GOLFAPI_KV: kv,
    GOLFAPI_COUNTER: counter,
    GOLFAPI_STOCKPILE_ENABLED: 'true',
    GOLFAPI_ROLLOVER_CREDITS: '156',
    GOLFAPI_CREDIT_FLOOR: '50',
    GOLFAPI_DAILY_CAP: '150',
    GOLFAPI_MONTHLY_CAP: '450',
    GOLFAPI_STOCKPILE_DAY_HEADROOM: '30',
    GOLFAPI_STOCKPILE_RUN_CREDITS: '800',
    GOLFAPI_CYCLE_DAY: '5',
    ALERT_ADMIN_TOKEN: 'admin-secret',
    ALERT_EMAIL: {
      async send(message) {
        sent.push(message);
      },
    },
    ...extra,
  };
  return { env, kv, counter, sent };
}

async function counterOp(counter, body) {
  const response = await counter.get().fetch('https://golfapi-counter.internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function hole(n, { tee = true, green = true } = {}) {
  return {
    hole: n,
    tee: tee ? { lat: 34 + n / 100, lng: -92 } : null,
    green: green ? { lat: 34.01 + n / 100, lng: -92.01 } : null,
  };
}

function bulkEvent(at = BULK_AT) {
  return { cron: '0 23 * * *', scheduledTime: at };
}

async function seedDemand(counter, cycleId, course) {
  await counterOp(counter, {
    op: 'noteDemand',
    reason: 'phone_limit',
    cycleId,
    name: course.name,
    country: course.country || 'US',
    courseId: course.courseId,
    day: '2026-11-04',
  });
}

function watchRefunds(counter) {
  const refunds = [];
  const innerFetch = counter.stub.fetch.bind(counter.stub);
  counter.stub.fetch = async (request) => {
    const body = await request.clone().json();
    if (body.op === 'stockpileRefund') refunds.push(body.chargeTenths);
    return innerFetch(request);
  };
  return refunds;
}

function installFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return handler(url, calls);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runMonthCap(at, monthUsed, { env: envExtra = {}, courseIds = ['month-cap'] } = {}) {
  const counter = new FakeCounter();
  const charges = [];
  const innerFetch = counter.stub.fetch.bind(counter.stub);
  counter.stub.fetch = async (request) => {
    const body = await request.clone().json();
    if (body.op === 'stockpileCharge') charges.push(body);
    return innerFetch(request);
  };
  const env = {
    GOLFAPI_KEY: 'golf-secret',
    GOLFAPI_KV: new FakeKV(),
    GOLFAPI_COUNTER: counter,
    GOLFAPI_STOCKPILE_ENABLED: 'true',
    GOLFAPI_ROLLOVER_CREDITS: '156',
    GOLFAPI_CREDIT_FLOOR: '50',
    GOLFAPI_DAILY_CAP: '150',
    GOLFAPI_STOCKPILE_DAY_HEADROOM: '30',
    GOLFAPI_STOCKPILE_RUN_CREDITS: '800',
    GOLFAPI_CYCLE_DAY: '5',
    ALERT_EMAIL: { async send() {} },
    ...envExtra,
  };
  assert.equal(env.GOLFAPI_STOCKPILE_ENABLED, 'true');
  if (!Object.hasOwn(envExtra, 'GOLFAPI_MONTHLY_CAP')) {
    assert.equal(Object.hasOwn(env, 'GOLFAPI_MONTHLY_CAP'), false);
  }
  const keys = stockpileKeys(new Date(at), env);
  counter.sql.map.set(keys.monthKey, String(monthUsed));
  for (const courseId of courseIds) {
    await seedDemand(counter, keys.cycleId, { courseId, name: courseId });
  }
  const http = installFetch((url) => {
    const discovery = url.includes('city=') || url.includes('state=');
    return jsonResponse(discovery ? { courses: [], apiRequestsLeft: 400 } : {
      courses: [],
      courseID: 'month-cap',
      country: 'US',
      latitude: 34.7,
      longitude: -92.2,
      numHoles: 1,
      hasGPS: 1,
      apiRequestsLeft: 400,
      coordinates: [
        { hole: 1, poi: 1, latitude: 34.7, longitude: -92.2 },
        { hole: 1, poi: 11, latitude: 34.71, longitude: -92.21 },
      ],
    });
  });
  try {
    const result = await runGolfapiStockpile(env, {}, bulkEvent(at), { overlay: () => ({ kind: 'gap' }) });
    return { result, counter, keys, charges, calls: http.calls.length };
  } finally {
    http.restore();
  }
}

describe('golfapi stockpile', () => {
  test('the window is the last 7 nights before renewal, and the bulk is the final hours', () => {
    assert.equal(stockpilePhase(new Date('2026-10-20T23:00:00Z'), 5), 'outside');
    assert.equal(stockpilePhase(new Date('2026-10-28T23:00:00Z'), 5), 'outside');
    assert.equal(stockpilePhase(new Date('2026-10-28T23:00:00Z'), 5, 10), 'outside');
    assert.equal(stockpilePhase(new Date('2026-10-29T23:00:00Z'), 5), 'check');
    assert.equal(stockpilePhase(new Date('2026-10-29T23:00:00Z'), 5, 30), 'check');
    assert.equal(stockpilePhase(new Date('2026-11-01T23:00:00Z'), 5), 'check');
    assert.equal(stockpilePhase(new Date('2026-11-02T23:00:00Z'), 5), 'check');
    assert.equal(stockpilePhase(new Date('2026-11-04T23:00:00Z'), 5), 'check');
    assert.equal(stockpilePhase(new Date('2026-11-05T00:30:00Z'), 5), 'outside');
    assert.equal(stockpilePhase(new Date('2026-11-15T23:00:00Z'), 5), 'outside');
    assert.equal(stockpileRunsRemaining(new Date('2026-10-29T23:00:00Z'), 5), 7);
    assert.equal(usStateCode('TX'), 'TX');
    assert.equal(usStateCode('texas'), 'TX');
    assert.equal(usStateCode('XX'), '');
    assert.equal(usStateCode('ZZ'), '');
    assert.equal(livePullAllowed(157, 1, 156), true);
    assert.equal(livePullAllowed(156, 1, 156), false);
    assert.equal(livePullAllowed(156.4, 1, 156), false);
  });

  test('nothing runs until GOLFAPI_STOCKPILE_ENABLED is true, or more than the max days out', async () => {
    const off = baseEnv({ GOLFAPI_STOCKPILE_ENABLED: 'false' });
    const none = installFetch(() => {
      throw new Error('disabled stockpile must not call golfapi');
    });
    try {
      const skipped = await runGolfapiStockpile(off.env, {}, bulkEvent());
      assert.equal(skipped.skipped, 'disabled');
      assert.equal(none.calls.length, 0);
    } finally {
      none.restore();
    }

    const on = baseEnv();
    const outside = installFetch(() => {
      throw new Error('outside the window must not call golfapi');
    });
    try {
      for (const at of ['2026-10-20T23:00:00Z', '2026-10-28T23:00:00Z', '2026-11-05T00:30:00Z', '2026-11-15T12:00:00Z']) {
        const result = await runGolfapiStockpile(on.env, {}, bulkEvent(Date.parse(at)));
        assert.equal(result.skipped, 'outside');
      }
      const other = await runGolfapiStockpile(on.env, {}, {
        cron: '0 8 * * *',
        scheduledTime: Date.parse('2026-11-04T23:00:00Z'),
      });
      assert.equal(other.skipped, 'cron');
      const light = await runGolfapiStockpile(on.env, {}, {
        cron: '0 15 * * *',
        scheduledTime: Date.parse('2026-11-04T15:00:00Z'),
      });
      assert.equal(light.skipped, 'cron');
      assert.equal(outside.calls.length, 0);
    } finally {
      outside.restore();
    }
  });

  test('a pull stops on the live balance, not the cached one, and the floor sits under the rollover', async () => {
    const { env, kv, counter } = baseEnv({ GOLFAPI_STOCKPILE_RUN_CREDITS: '10' });
    const keys = stockpileKeys(new Date(BULK_AT), env);
    kv.store.set('gq:balance', { value: JSON.stringify({ left: 900 }) });
    await seedDemand(counter, keys.cycleId, { courseId: 'live-1', name: 'Live' });
    let left = 156.1;
    const http = installFetch((url) => {
      if (url.includes(BALANCE_PROBE_NAME)) {
        left = Math.round((left - 0.1) * 10) / 10;
        return jsonResponse({ courses: [], apiRequestsLeft: left });
      }
      throw new Error(`pull must not run at rollover ${url}`);
    });
    try {
      const stopped = await runGolfapiStockpile(env, {}, bulkEvent(), {
        overlay: () => ({ kind: 'gap' }),
      });
      assert.equal(stopped.stopped, 'rollover');
      assert.equal(stopped.liveLeft, 156);
      assert.equal(stopped.added, 0);
      assert.equal(http.calls.some((url) => url.includes('/courses/')), false);
      assert.equal(http.calls.some((url) => url.includes('/coordinates/')), false);
    } finally {
      http.restore();
    }

    const again = baseEnv({ GOLFAPI_STOCKPILE_RUN_CREDITS: '10' });
    const keys2 = stockpileKeys(new Date(BULK_AT), again.env);
    await seedDemand(again.counter, keys2.cycleId, { courseId: 'pair-1', name: 'Pair' });
    await seedDemand(again.counter, keys2.cycleId, { courseId: 'pair-2', name: 'Next' });
    let balance = 158.1;
    const pulls = [];
    const http2 = installFetch((url) => {
      const cost = url.includes(BALANCE_PROBE_NAME) ? 0.1 : 1;
      balance = Math.round((balance - cost) * 10) / 10;
      if (url.includes('/courses/') || url.includes('/coordinates/')) pulls.push(url);
      return jsonResponse({
        courses: [],
        courseID: 'pair-1',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 18,
        apiRequestsLeft: balance,
        coordinates: [{ hole: 1, poi: 1, latitude: 1, longitude: 2 }, { hole: 1, poi: 11, latitude: 1.1, longitude: 2 }],
      });
    });
    try {
      const spent = await runGolfapiStockpile(again.env, {}, bulkEvent(), {
        overlay: () => ({ kind: 'gap' }),
      });
      assert.equal(spent.added, 1);
      assert.equal(spent.liveLeft, 156);
      assert.equal(spent.stopped, 'rollover');
      assert.equal(pulls.some((url) => url.includes('pair-2')), false);
      assert.equal(pulls.filter((url) => url.includes('pair-1')).length, 2);
    } finally {
      http2.restore();
    }
  });

  test('23:00 UTC on day 2 runs the full job, and a nameless first hit is not pulled', async () => {
    const { env, counter, kv } = baseEnv();
    const keys = stockpileKeys(new Date(DAY2_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'day2-1', name: 'Day Two' });
    const pulls = [];
    const http = installFetch((url) => {
      if (url.includes('/courses/') || url.includes('/coordinates/')) pulls.push(url);
      return jsonResponse({
        courseID: 'day2-1',
        courseName: 'Day Two',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 1,
        apiRequestsLeft: 400,
        coordinates: [
          { hole: 1, poi: 1, latitude: 34.7, longitude: -92.2 },
          { hole: 1, poi: 11, latitude: 34.71, longitude: -92.21 },
        ],
      });
    });
    try {
      const ran = await runGolfapiStockpile(env, {}, { cron: '0 23 * * *', scheduledTime: DAY2_AT }, {
        overlay: () => ({ kind: 'gap' }),
      });
      assert.equal(ran.phase, 'run');
      assert.equal(ran.added, 1);
      assert.equal(pulls.some((url) => url.includes('/courses/day2-1')), true);
      assert.equal(pulls.some((url) => url.includes('/coordinates/day2-1')), true);
      assert.equal(kv.store.has('golfapi:us:day2-1'), true);
    } finally {
      http.restore();
    }

    const named = baseEnv();
    const keys2 = stockpileKeys(new Date(BULK_AT), named.env);
    await seedDemand(named.counter, keys2.cycleId, { name: 'Wanted Nine', country: 'US' });
    const looked = [];
    const search = installFetch((url) => {
      looked.push(url);
      if (url.includes('/courses/') || url.includes('/coordinates/')) throw new Error(`unmatched name was pulled ${url}`);
      if (url.includes('name=Wanted')) {
        return jsonResponse({
          courses: [{ courseID: 'other-1', courseName: 'Some Other Course', country: 'US', state: 'TX' }],
          apiRequestsLeft: 400,
        });
      }
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const missed = await runGolfapiStockpile(named.env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(missed.added, 0);
      assert.equal(looked.some((url) => url.includes('name=Wanted')), true);
      assert.equal(looked.some((url) => url.includes('/courses/')), false);
    } finally {
      search.restore();
    }

    const club = baseEnv();
    const clubKeys = stockpileKeys(new Date(BULK_AT), club.env);
    await seedDemand(club.counter, clubKeys.cycleId, { name: 'Wanted Nine', country: 'US' });
    const clubPulls = [];
    const clubHttp = installFetch((url) => {
      if (url.includes('/courses/club-1')) {
        clubPulls.push(url);
        return jsonResponse({
          courseID: 'club-1',
          courseName: 'Some Other Course',
          clubName: 'Wanted Nine',
          country: 'US',
          latitude: 34.7,
          longitude: -92.2,
          numHoles: 1,
          apiRequestsLeft: 390,
        });
      }
      if (url.includes('/coordinates/')) clubPulls.push(url);
      if (url.includes('name=Wanted')) {
        return jsonResponse({
          courses: [{
            courseID: 'club-1',
            courseName: 'Some Other Course',
            clubName: 'Wanted Nine',
            country: 'US',
            latitude: 34.7,
            longitude: -92.2,
            numHoles: 1,
          }],
          apiRequestsLeft: 400,
        });
      }
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const matched = await runGolfapiStockpile(club.env, {}, bulkEvent(), { overlay: () => ({ kind: 'complete' }) });
      assert.equal(matched.added, 0);
      assert.equal(clubPulls.some((url) => url.includes('/courses/club-1')), true);
      assert.equal(clubPulls.some((url) => url.includes('/coordinates/')), false);
    } finally {
      clubHttp.restore();
    }
  });

  test('a complete overlay is skipped and a hole missing a green is pulled', async () => {
    const complete = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), complete.env);
    await seedDemand(complete.counter, keys.cycleId, { courseId: 'full-1', name: 'Full' });
    const noPay = installFetch((url) => {
      if (url.includes('/coordinates/')) throw new Error(`complete overlay must not pull coordinates ${url}`);
      return jsonResponse({
        courseID: 'full-1',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 2,
        apiRequestsLeft: 400,
        courses: [],
      });
    });
    try {
      const skipped = await runGolfapiStockpile(complete.env, {}, bulkEvent(), {
        overlay: () => classifyOverlayPayload({
          numHoles: 2,
          holes: [hole(1), hole(2)],
        }),
      });
      assert.equal(skipped.added, 0);
      assert.equal(skipped.osmComplete, 1);
      assert.equal(skipped.osmUnknown, 0);
      assert.equal(skipped.skips[0].reason, 'osm_complete');
    } finally {
      noPay.restore();
    }

    const gap = baseEnv();
    const keys2 = stockpileKeys(new Date(BULK_AT), gap.env);
    await seedDemand(gap.counter, keys2.cycleId, { courseId: 'gap-1', name: 'Gap' });
    const paid = [];
    const http = installFetch((url) => {
      if (url.includes('/courses/') || url.includes('/coordinates/')) paid.push(url);
      return jsonResponse({
        courses: [],
        courseID: 'gap-1',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 2,
        apiRequestsLeft: 400,
        coordinates: [
          { hole: 1, poi: 1, latitude: 34.7, longitude: -92.2 },
          { hole: 1, poi: 11, latitude: 34.71, longitude: -92.2 },
        ],
      });
    });
    try {
      const pulled = await runGolfapiStockpile(gap.env, {}, bulkEvent(), {
        overlay: () => classifyOverlayPayload({
          numHoles: 2,
          holes: [hole(1), hole(2, { green: false })],
        }),
      });
      assert.equal(pulled.added, 1);
      assert.equal(pulled.osmComplete, 0);
      assert.equal(paid.some((url) => url.includes('/courses/gap-1')), true);
      assert.equal(paid.some((url) => url.includes('/coordinates/gap-1')), true);
    } finally {
      http.restore();
    }
  });

  test('an overlay error or no-match keeps the course detail and does not buy coordinates', async () => {
    for (const [label, overlay] of [
      ['error', () => { throw new Error('overpass down'); }],
      ['no-match', () => ({ kind: 'unknown', reason: 'no_match' })],
      ['timeout', () => new Promise(() => {})],
    ]) {
      const { env, counter } = baseEnv();
      const keys = stockpileKeys(new Date(BULK_AT), env);
      await seedDemand(counter, keys.cycleId, { courseId: `skip-${label}`, name: label });
      const http = installFetch((url) => {
        if (url.includes('/coordinates/')) throw new Error(`${label} must not pull coordinates ${url}`);
        return jsonResponse({
          courseID: `skip-${label}`,
          country: 'US',
          latitude: 34.7,
          longitude: -92.2,
          numHoles: 1,
          apiRequestsLeft: 400,
          courses: [],
        });
      });
      try {
        const skipped = await runGolfapiStockpile(env, {}, bulkEvent(), {
          overlay,
          timeoutMs: 30,
        });
        assert.equal(skipped.added, 0, label);
        assert.equal(skipped.osmUnknown, 1, label);
        assert.equal(skipped.skips[0].reason, 'osm_unknown', label);
        assert.equal(http.calls.some((url) => url.includes(`/courses/skip-${label}`)), true, label);
        assert.equal(http.calls.some((url) => url.includes('/coordinates/')), false, label);
      } finally {
        http.restore();
      }
    }
    assert.equal((await coverageFromOverlayResponse(jsonResponse({ error: 'upstream_busy' }, 503))).kind, 'unknown');
    assert.equal((await coverageFromOverlayResponse(jsonResponse({ error: 'no_overlay' }, 404))).reason, 'no_match');
  });

  test('demand is pulled before a busy state, then the big metros, and a second run does not pull again', async () => {
    const { env, counter } = baseEnv({ GOLFAPI_STOCKPILE_RUN_CREDITS: '80' });
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'demand-1', name: 'Wanted' });
    await counterOp(counter, { op: 'noteSearchStates', cycleId: keys.cycleId, states: ['TX', 'TX', 'CA'] });
    const http = installFetch((url) => {
      if (url.includes('state=TX')) {
        return jsonResponse({
          courses: [{ courseID: 'state-1', courseName: 'Texas', state: 'TX', country: 'US', numHoles: 18, latitude: 30, longitude: -97 }],
          apiRequestsLeft: 390,
        });
      }
      if (url.includes('city=New')) {
        return jsonResponse({
          courses: [{ courseID: 'metro-1', courseName: 'Metro', state: 'NY', city: 'New York', country: 'US', numHoles: 18, latitude: 40.7, longitude: -74 }],
          apiRequestsLeft: 380,
        });
      }
      if (url.includes('city=') || url.includes('state=')) {
        return jsonResponse({ courses: [], apiRequestsLeft: 400 });
      }
      return jsonResponse({
        courses: [],
        courseID: 'x',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 18,
        apiRequestsLeft: 400,
        coordinates: [
          { hole: 1, poi: 1, latitude: 34.7, longitude: -92.2 },
          { hole: 1, poi: 11, latitude: 34.71, longitude: -92.21 },
        ],
      });
    });
    try {
      const first = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      const demandAt = http.calls.findIndex((url) => url.includes('/courses/demand-1'));
      const stateAt = http.calls.findIndex((url) => url.includes('state=TX'));
      const metroAt = http.calls.findIndex((url) => url.includes('city='));
      assert.ok(demandAt >= 0 && stateAt > demandAt && metroAt > stateAt);
      assert.equal(first.added, 3);
      const before = http.calls.length;
      const second = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(second.added, 0);
      assert.equal(http.calls.slice(before).some((url) => url.includes('/courses/')), false);
      assert.equal(http.calls.slice(before).some((url) => url.includes('/coordinates/')), false);
    } finally {
      http.restore();
    }
  });

  test('an already stored course is not pulled, and the daily headroom is left for golfers', async () => {
    const stored = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), stored.env);
    await seedDemand(stored.counter, keys.cycleId, { courseId: 'have-1', name: 'Have' });
    stored.kv.store.set('golfapi:permanent:course:have-1', { value: '{"status":200,"body":"{}"}' });
    stored.kv.store.set('golfapi:permanent:coordinates:have-1', { value: '{"status":200,"body":"{}"}' });
    const http = installFetch((url) => {
      if (url.includes('/courses/') || url.includes('/coordinates/')) throw new Error(`stored course was pulled ${url}`);
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const result = await runGolfapiStockpile(stored.env, {}, bulkEvent(), {
        overlay: () => { throw new Error('overlay should not be asked'); },
      });
      assert.equal(result.added, 0);
    } finally {
      http.restore();
    }

    const crowded = baseEnv();
    const dayKey = stockpileKeys(new Date(BULK_AT), crowded.env);
    crowded.counter.sql.map.set(dayKey.dayKey, '121');
    crowded.counter.sql.map.set(dayKey.monthKey, '120');
    const blocked = installFetch(() => {
      throw new Error('headroom must not call golfapi');
    });
    try {
      const stopped = await runGolfapiStockpile(crowded.env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(stopped.stopped, 'app_daily');
      assert.equal(stopped.added, 0);
      assert.equal(blocked.calls.length, 0);
      assert.equal(crowded.counter.sql.map.get(dayKey.dayKey), '121');
      assert.equal(crowded.counter.sql.map.get(dayKey.monthKey), '120');
    } finally {
      blocked.restore();
    }
  });

  test('a held lock does no work, and the report is mailed and readable', async () => {
    const { env, counter, sent } = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'rep-1', name: 'Report' });
    await counterOp(counter, { op: 'stockpileLock', now: BULK_AT, ttlSec: 900 });
    const lockedHttp = installFetch(() => {
      throw new Error('locked run must not call golfapi');
    });
    try {
      const locked = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(locked.skipped, 'locked');
      assert.equal(lockedHttp.calls.length, 0);
    } finally {
      lockedHttp.restore();
    }
    await counterOp(counter, { op: 'stockpileUnlock' });

    const http = installFetch(() => jsonResponse({
      courses: [],
      courseID: 'rep-1',
      country: 'US',
      latitude: 34.7,
      longitude: -92.2,
      numHoles: 1,
      apiRequestsLeft: 300,
      coordinates: [
        { hole: 1, poi: 1, latitude: 34.7, longitude: -92.2 },
        { hole: 1, poi: 11, latitude: 34.71, longitude: -92.21 },
      ],
    }));
    try {
      const report = await runGolfapiStockpile(env, {}, bulkEvent(), {
        overlay: () => classifyOverlayPayload({ numHoles: 1, holes: [hole(1, { green: false })] }),
      });
      assert.equal(report.added, 1);
      assert.equal(sent.length, 1);
      assert.match(sent[0].raw, /Subject: ShotTraxx golfapi stockpile/);
      assert.match(sent[0].raw, /Courses added: 1/);
      assert.match(sent[0].raw, /Credits spent:/);
      assert.match(sent[0].raw, /OSM already complete/);
      assert.match(sent[0].raw, /OSM unknown/);
      assert.match(sent[0].raw, /Remaining expiring credits:/);
      const listed = await handleGolfProxy(new Request('https://share.test/admin/stockpile', {
        headers: { 'X-Admin-Token': 'admin-secret' },
      }), env, {});
      const body = await listed.json();
      assert.equal(listed.status, 200);
      assert.equal(body.added, 1);
      assert.equal(body.osmUnknown, 0);
      const denied = await handleGolfProxy(new Request('https://share.test/admin/stockpile'), env, {});
      assert.equal(denied.status, 401);
      const installKey = `golfapi:credit:install:stockpile:${keys.dayKey.slice(-10)}`;
      assert.equal(counter.sql.map.has(installKey), false);
    } finally {
      http.restore();
    }
  });

  test('a failed name search is not marked done, and a non-US row is skipped', async () => {
    const { env, counter, kv } = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { name: 'Wanted Nine', country: 'US' });
    await seedDemand(counter, keys.cycleId, { courseId: 'abroad-1', name: 'Abroad', country: 'CA' });
    let nameCalls = 0;
    const http = installFetch((url) => {
      if (url.includes('/courses/') || url.includes('/coordinates/')) throw new Error(`unmatched row was pulled ${url}`);
      if (url.includes('name=Wanted')) {
        nameCalls += 1;
        return jsonResponse({ courses: [], apiRequestsLeft: 400 }, 503);
      }
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(nameCalls, 2);
      const cursor = JSON.parse(kv.store.get(keys.cursorKey).value);
      assert.equal(cursor.searched.demand.includes('wanted nine|US'), false);
      assert.equal(http.calls.some((url) => url.includes('/courses/abroad-1')), false);
    } finally {
      http.restore();
    }
  });

  test('hasGPS 0 and a map-less coordinates reply are recorded no_data and never paid twice', async () => {
    const zero = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), zero.env);
    await seedDemand(zero.counter, keys.cycleId, { courseId: 'nogps-1', name: 'No GPS' });
    await seedDemand(zero.counter, keys.cycleId, { courseId: 'nocoord-1', name: 'No Coord Count' });
    const zeroHttp = installFetch((url) => {
      if (url.includes('/coordinates/')) throw new Error(`zero gps bought coordinates ${url}`);
      const noCount = url.includes('nocoord-1');
      return jsonResponse({
        courseID: noCount ? 'nocoord-1' : 'nogps-1',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        hasGPS: noCount ? 1 : 0,
        numCoordinates: noCount ? 0 : 12,
        numHoles: 18,
        apiRequestsLeft: 400,
        courses: [],
      });
    });
    try {
      const first = await runGolfapiStockpile(zero.env, {}, bulkEvent(), {
        overlay: () => { throw new Error('zero gps must not ask the overlay'); },
      });
      assert.equal(first.added, 0);
      const listed = await counterOp(zero.counter, { op: 'readDemand', cycleId: keys.cycleId });
      assert.equal(listed.no_data.some((row) => row.courseId === 'nogps-1'), true);
      assert.equal(listed.no_data.some((row) => row.courseId === 'nocoord-1'), true);
      assert.equal(zeroHttp.calls.some((url) => url.includes('/coordinates/')), false);
      const before = zeroHttp.calls.length;
      await runGolfapiStockpile(zero.env, {}, bulkEvent(), {
        overlay: () => { throw new Error('zero gps must not ask the overlay'); },
      });
      assert.equal(zeroHttp.calls.slice(before).some((url) => url.includes('/courses/nogps-1')), false);
    } finally {
      zeroHttp.restore();
    }

    const empty = baseEnv();
    const keys2 = stockpileKeys(new Date(BULK_AT), empty.env);
    await seedDemand(empty.counter, keys2.cycleId, { courseId: 'nomap-1', name: 'No Map' });
    const pulls = [];
    const http = installFetch((url) => {
      if (url.includes('/coordinates/')) {
        pulls.push(url);
        return jsonResponse({
          courseID: 'nomap-1',
          apiRequestsLeft: 390,
          coordinates: [{ hole: 1, poi: 3, latitude: 1, longitude: 2 }],
        });
      }
      if (url.includes('/courses/')) pulls.push(url);
      return jsonResponse({
        courseID: 'nomap-1',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 1,
        hasGPS: 1,
        apiRequestsLeft: 400,
        courses: [],
      });
    });
    try {
      const bought = await runGolfapiStockpile(empty.env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(bought.added, 0);
      assert.equal(pulls.some((url) => url.includes('/courses/nomap-1')), true);
      assert.equal(pulls.some((url) => url.includes('/coordinates/nomap-1')), true);
      const listed = await counterOp(empty.counter, { op: 'readDemand', cycleId: keys2.cycleId });
      assert.equal(listed.no_data.some((row) => row.courseId === 'nomap-1'), true);
      const before = pulls.length;
      await runGolfapiStockpile(empty.env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(pulls.slice(before).some((url) => url.includes('nomap-1')), false);
    } finally {
      http.restore();
    }
  });

  test('a map-less coordinates reply is not stored, and the next cycle does not pay again', async () => {
    const { env, kv, counter } = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'nomap-again', name: 'No Map Again' });
    const paid = [];
    const http = installFetch((url) => {
      if (url.includes('/courses/') || url.includes('/coordinates/')) paid.push(url);
      if (url.includes('/coordinates/nomap-again')) {
        return jsonResponse({
          apiRequestsLeft: 290,
          coordinates: [{ hole: 1, poi: 3, latitude: 1, longitude: 2 }],
        });
      }
      return jsonResponse({
        courseID: 'nomap-again',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 1,
        hasGPS: 1,
        apiRequestsLeft: 400,
        courses: [],
      });
    });
    try {
      const first = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(first.added, 0);
      assert.equal(first.stopped, null);
      assert.equal(kv.store.has('golfapi:permanent:coordinates:nomap-again'), false);
      assert.equal(kv.store.has('golfapi:nodata:nomap-again'), true);
      const listed = await counterOp(counter, { op: 'readDemand', cycleId: keys.cycleId });
      assert.equal(listed.no_data.some((row) => row.courseId === 'nomap-again'), true);
      const nextAt = Date.parse('2026-12-04T23:00:00Z');
      const nextKeys = stockpileKeys(new Date(nextAt), env);
      await seedDemand(counter, nextKeys.cycleId, { courseId: 'nomap-again', name: 'No Map Again' });
      const before = paid.length;
      await runGolfapiStockpile(env, {}, bulkEvent(nextAt), { overlay: () => ({ kind: 'gap' }) });
      const again = paid.slice(before);
      assert.equal(again.some((url) => url.includes('nomap-again')), false);
    } finally {
      http.restore();
    }
  });

  test('a quota reply mid-run stops the night, refunds the pull, and the next run retries that course', async () => {
    const firstAt = Date.parse('2026-11-03T23:00:00Z');
    const { env, kv, counter, sent } = baseEnv();
    const keys = stockpileKeys(new Date(firstAt), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'before-1', name: 'Before' });
    await seedDemand(counter, keys.cycleId, { courseId: 'before-1', name: 'Before' });
    await seedDemand(counter, keys.cycleId, { courseId: 'before-1', name: 'Before' });
    await seedDemand(counter, keys.cycleId, { courseId: 'quota-1', name: 'Quota' });
    await seedDemand(counter, keys.cycleId, { courseId: 'quota-1', name: 'Quota' });
    await seedDemand(counter, keys.cycleId, { courseId: 'after-1', name: 'After' });
    const refunds = [];
    const innerFetch = counter.stub.fetch.bind(counter.stub);
    counter.stub.fetch = async (request) => {
      const body = await request.clone().json();
      if (body.op === 'stockpileRefund') refunds.push(body.chargeTenths);
      return innerFetch(request);
    };
    let quotaPulls = 0;
    const http = installFetch((url) => {
      if (url.includes('/courses/quota-1')) {
        quotaPulls += 1;
        if (quotaPulls === 1) return jsonResponse({ message: 'quota exceeded', apiRequestsLeft: 300 });
        return jsonResponse({
          courseID: 'quota-1',
          country: 'US',
          latitude: 34.7,
          longitude: -92.2,
          numHoles: 18,
          hasGPS: 1,
          apiRequestsLeft: 300,
        });
      }
      if (url.includes('/courses/before-1') || url.includes('/courses/after-1')) {
        const id = url.includes('before-1') ? 'before-1' : 'after-1';
        return jsonResponse({
          courseID: id,
          country: 'US',
          latitude: 34.7,
          longitude: -92.2,
          numHoles: 18,
          hasGPS: 1,
          apiRequestsLeft: 400,
        });
      }
      if (url.includes('/coordinates/')) throw new Error(`coordinates were bought ${url}`);
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const first = await runGolfapiStockpile(env, {}, bulkEvent(firstAt), { overlay: () => ({ kind: 'complete' }) });
      const quotaAt = http.calls.findIndex((url) => url.includes('/courses/quota-1'));
      assert.equal(quotaAt > 0, true);
      assert.equal(http.calls.slice(quotaAt + 1).length, 0);
      assert.equal(http.calls.some((url) => url.includes('/courses/before-1')), true);
      assert.equal(http.calls.some((url) => url.includes('/courses/after-1')), false);
      assert.equal(first.stopped, 'quota');
      assert.equal(first.added, 0);
      assert.equal(first.spent, 1.1);
      assert.deepEqual(refunds, [10]);
      assert.equal(counter.sql.map.get(keys.stockpileDayKey), '1.1');
      assert.equal(counter.sql.map.get(keys.stockpileMonthKey), '1.1');
      assert.equal(kv.store.has('golfapi:nodata:quota-1'), false);
      assert.equal(kv.store.has('golfapi:permanent:course:quota-1'), false);
      assert.equal(kv.store.has('golfapi:permanent:coordinates:quota-1'), false);
      const cursor = JSON.parse(kv.store.get(keys.cursorKey).value);
      assert.equal(cursor.done.includes('quota-1'), false);
      assert.equal(cursor.skipped['quota-1'], undefined);
      const listed = await counterOp(counter, { op: 'readDemand', cycleId: keys.cycleId });
      assert.equal(listed.no_data.some((row) => row.courseId === 'quota-1'), false);
      assert.equal(sent.length, 1);
      assert.match(sent[0].raw, /Subject: ShotTraxx golfapi stockpile/);
      assert.match(sent[0].raw, /Stopped: quota/);

      const nextAt = Date.parse('2026-11-04T23:00:00Z');
      const before = http.calls.length;
      const second = await runGolfapiStockpile(env, {}, bulkEvent(nextAt), { overlay: () => ({ kind: 'complete' }) });
      const again = http.calls.slice(before);
      assert.equal(again.some((url) => url.includes('/courses/quota-1')), true);
      assert.equal(second.stopped, null);
      assert.equal(kv.store.has('golfapi:permanent:course:quota-1'), true);
      assert.equal(kv.store.has('golfapi:nodata:quota-1'), false);
    } finally {
      http.restore();
    }
  });

  test('a quota reply on a discovery search stops the night, refunds the search, and retries that state', async () => {
    const firstAt = Date.parse('2026-11-03T23:00:00Z');
    const { env, kv, counter } = baseEnv();
    const keys = stockpileKeys(new Date(firstAt), env);
    await counterOp(counter, { op: 'noteSearchStates', cycleId: keys.cycleId, states: ['TX'] });
    const refunds = watchRefunds(counter);
    let stateCalls = 0;
    const http = installFetch((url) => {
      if (url.includes('state=TX')) {
        stateCalls += 1;
        if (stateCalls === 1) return jsonResponse({ message: 'quota exceeded', apiRequestsLeft: 300, courses: [] });
        return jsonResponse({ courses: [], apiRequestsLeft: 300 });
      }
      if (stateCalls === 1 && (url.includes('city=') || url.includes('/courses/') || url.includes('/coordinates/'))) {
        throw new Error(`discovery continued after quota ${url}`);
      }
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const first = await runGolfapiStockpile(env, {}, bulkEvent(firstAt), { overlay: () => ({ kind: 'gap' }) });
      const quotaAt = http.calls.findIndex((url) => url.includes('state=TX'));
      assert.equal(quotaAt > 0, true);
      assert.equal(http.calls.slice(quotaAt + 1).length, 0);
      assert.equal(first.stopped, 'quota');
      assert.equal(first.spent, 0.1);
      assert.deepEqual(refunds, [1]);
      assert.equal(counter.sql.map.get(keys.stockpileDayKey), '0.1');
      assert.equal(counter.sql.map.get(keys.stockpileMonthKey), '0.1');
      const cursor = JSON.parse(kv.store.get(keys.cursorKey).value);
      assert.equal(cursor.searched.state.includes('TX'), false);
      assert.equal(cursor.searched.metro.length, 0);
      assert.equal(cursor.searched.demand.length, 0);

      const nextAt = Date.parse('2026-11-04T23:00:00Z');
      const before = http.calls.length;
      await runGolfapiStockpile(env, {}, bulkEvent(nextAt), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(http.calls.slice(before).some((url) => url.includes('state=TX')), true);
    } finally {
      http.restore();
    }
  });

  test('a quota reply on the balance check stops the night and refunds the probe', async () => {
    const { env, counter } = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'after-probe', name: 'After Probe' });
    const refunds = watchRefunds(counter);
    const http = installFetch((url) => {
      if (url.includes(BALANCE_PROBE_NAME)) {
        return jsonResponse({ message: 'quota exceeded', apiRequestsLeft: 300 });
      }
      throw new Error(`balance quota did not stop the run ${url}`);
    });
    try {
      const stopped = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(http.calls.length, 1);
      assert.equal(stopped.stopped, 'quota');
      assert.equal(stopped.spent, 0);
      assert.equal(stopped.added, 0);
      assert.deepEqual(refunds, [1]);
      assert.equal(counter.sql.map.get(keys.stockpileDayKey), '0');
      assert.equal(counter.sql.map.get(keys.stockpileMonthKey), '0');
    } finally {
      http.restore();
    }
  });

  test('a quota reply on coordinates stops the night, refunds the pull, and writes no marker or body', async () => {
    const { env, kv, counter } = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'coord-quota', name: 'Coord Quota' });
    const refunds = watchRefunds(counter);
    const http = installFetch((url) => {
      if (url.includes('/coordinates/coord-quota')) {
        return jsonResponse({ message: 'quota exceeded', apiRequestsLeft: 280 });
      }
      if (url.includes('/courses/coord-quota')) {
        return jsonResponse({
          courseID: 'coord-quota',
          country: 'US',
          latitude: 34.7,
          longitude: -92.2,
          numHoles: 18,
          hasGPS: 1,
          apiRequestsLeft: 400,
        });
      }
      if (url.includes('city=') || url.includes('state=') || url.includes('/courses/') || url.includes('/coordinates/')) {
        throw new Error(`coordinates quota did not stop the run ${url}`);
      }
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const stopped = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      const quotaAt = http.calls.findIndex((url) => url.includes('/coordinates/coord-quota'));
      assert.equal(quotaAt > 0, true);
      assert.equal(http.calls.slice(quotaAt + 1).length, 0);
      assert.equal(http.calls.some((url) => url.includes('/courses/coord-quota')), true);
      assert.equal(stopped.stopped, 'quota');
      assert.equal(stopped.added, 0);
      assert.equal(stopped.spent, 1.1);
      assert.deepEqual(refunds, [10]);
      assert.equal(counter.sql.map.get(keys.stockpileDayKey), '1.1');
      assert.equal(counter.sql.map.get(keys.stockpileMonthKey), '1.1');
      assert.equal(kv.store.has('golfapi:nodata:coord-quota'), false);
      assert.equal(kv.store.has('golfapi:permanent:coordinates:coord-quota'), false);
      const listed = await counterOp(counter, { op: 'readDemand', cycleId: keys.cycleId });
      assert.equal(listed.no_data.some((row) => row.courseId === 'coord-quota'), false);
    } finally {
      http.restore();
    }
  });

  test('a blank-country non-US course buys no coordinates and gets no US marker', async () => {
    const { env, kv, counter } = baseEnv();
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await counterOp(counter, {
      op: 'noteDemand',
      reason: 'phone_limit',
      cycleId: keys.cycleId,
      name: 'Unknown',
      country: '',
      courseId: 'blank-row',
      day: '2026-11-04',
    });
    await seedDemand(counter, keys.cycleId, { courseId: 'blank-body', name: 'Blank Body', country: 'US' });
    const paid = [];
    const http = installFetch((url) => {
      if (url.includes('/courses/') || url.includes('/coordinates/')) paid.push(url);
      if (url.includes('/coordinates/')) throw new Error(`coordinates were bought ${url}`);
      if (url.includes('/courses/blank-body')) {
        return jsonResponse({
          courseID: 'blank-body',
          country: '',
          latitude: 34.7,
          longitude: -92.2,
          numHoles: 18,
          apiRequestsLeft: 390,
        });
      }
      return jsonResponse({ courses: [], apiRequestsLeft: 400 });
    });
    try {
      const ran = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(ran.added, 0);
      assert.equal(paid.some((url) => url.includes('blank-row')), false);
      assert.equal(paid.some((url) => url.includes('/courses/blank-body')), true);
      assert.equal(paid.some((url) => url.includes('/coordinates/')), false);
      assert.equal(kv.store.has('golfapi:us:blank-row'), false);
      assert.equal(kv.store.has('golfapi:us:blank-body'), false);
    } finally {
      http.restore();
    }
  });

  test('a dry run lists the course it would buy and makes no paid call', async () => {
    const { env, counter } = baseEnv({ GOLFAPI_STOCKPILE_DRY_RUN: 'true' });
    const keys = stockpileKeys(new Date(BULK_AT), env);
    await seedDemand(counter, keys.cycleId, { courseId: 'dry-1', name: 'Dry' });
    const http = installFetch(() => {
      throw new Error('dry run must not call golfapi');
    });
    try {
      const listed = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(listed.dryRun, true);
      assert.deepEqual(listed.wouldPull, [{ courseId: 'dry-1', cost: 2 }]);
      assert.equal(listed.added, 0);
      assert.equal(listed.spent, 0);
      assert.equal(http.calls.length, 0);
    } finally {
      http.restore();
    }
  });

  test('seven nights split a 2000-plan leftover, and the last night lands on 156', async () => {
    const firstNight = Date.parse('2026-10-29T23:00:00Z');
    const plan = {
      now: new Date(firstNight),
      cycleDay: 5,
      liveLeft: 2156,
      rollover: 156,
      runCap: 800,
      dailyCap: 300,
      headroom: 30,
      floor: 50,
      monthCap: 1800,
      monthUsed: 0,
      dayUsed: 40,
      golferEstimate: 40,
      maxDays: 10,
    };
    const schedule = stockpileSchedule(plan);
    assert.equal(schedule.runsRemaining, 7);
    assert.equal(schedule.daysNeeded, 7);
    assert.equal(schedule.inWindow, true);
    assert.equal(schedule.todayBudget, 285.7);
    assert.equal(schedule.runs.length, 7);
    assert.equal(schedule.runs[0].budget, 285.7);
    assert.equal(schedule.finalBalance, 156);
    assert.equal(schedule.runs.reduce((sum, row) => sum + row.budget, 0), 2000);
    assert.equal(schedule.todayBudget < 800, true);
    const cappedMonth = stockpileSchedule({ ...plan, monthUsed: 1700 });
    assert.equal(cappedMonth.todayBudget, 100);
    assert.equal(cappedMonth.runs.every((row) => row.budget <= 100 && row.budget >= 0), true);
    assert.equal(cappedMonth.finalBalance, 1456);

    const { env, counter } = baseEnv({
      GOLFAPI_STOCKPILE_DRY_RUN: 'true',
      GOLFAPI_STOCKPILE_RUN_CREDITS: '800',
      GOLFAPI_DAILY_CAP: '300',
      GOLFAPI_MONTHLY_CAP: '1800',
      GOLFAPI_STOCKPILE_GOLFER_DAILY: '40',
      GOLFAPI_STOCKPILE_MAX_DAYS: '7',
    });
    const keys = stockpileKeys(new Date(firstNight), env);
    counter.sql.map.set(keys.dayKey, '40');
    counter.sql.map.set(keys.monthKey, '1700');
    const http = installFetch(() => {
      throw new Error('dry run must not call golfapi');
    });
    try {
      const listed = await runGolfapiStockpile(env, {}, bulkEvent(firstNight), { liveLeft: 2156 });
      assert.equal(http.calls.length, 0);
      assert.equal(listed.spent, 0);
      assert.equal(listed.schedule.todayBudget, 100);
      assert.equal(listed.schedule.runs.length, 7);
      assert.equal(listed.schedule.finalBalance, 1456);
      assert.equal(counter.sql.map.get(keys.dayKey), '40');
      assert.equal(counter.sql.map.get(keys.monthKey), '1700');
      assert.equal(counter.sql.map.has(keys.stockpileDayKey), false);
    } finally {
      http.restore();
    }

    const crowded = stockpileSchedule({ ...plan, dayUsed: 280, monthUsed: 1790 });
    assert.equal(crowded.inWindow, true);
    assert.equal(crowded.todayBudget, 0);
    assert.equal(crowded.runs[0].budget, 0);
    assert.equal(crowded.runs[1].budget, 10);
    assert.equal(crowded.runs.every((row) => row.budget <= 10 && row.budget >= 0), true);
    assert.equal(crowded.finalBalance, 2096);

    for (const liveLeft of [156, 140, 50]) {
      const idle = stockpileSchedule({ ...plan, liveLeft });
      assert.equal(idle.daysNeeded, 0, String(liveLeft));
      assert.equal(idle.todayBudget, 0, String(liveLeft));
      assert.equal(idle.runs.length, 0, String(liveLeft));
    }
    const atLine = baseEnv({
      GOLFAPI_STOCKPILE_DRY_RUN: 'true',
      GOLFAPI_STOCKPILE_RUN_CREDITS: '800',
      GOLFAPI_STOCKPILE_MAX_DAYS: '7',
    });
    const quiet = installFetch(() => {
      throw new Error('a balance on the rollover must not call golfapi');
    });
    try {
      const stopped = await runGolfapiStockpile(atLine.env, {}, bulkEvent(firstNight), { liveLeft: 156 });
      assert.equal(quiet.calls.length, 0);
      assert.equal(stopped.stopped, 'rollover');
      assert.equal(stopped.schedule.todayBudget, 0);
      assert.equal(stopped.added, 0);
    } finally {
      quiet.restore();
    }
  });

  test('stockpile spend leaves the golfer daily counter untouched and charges the shared month', async () => {
    const { env, counter } = baseEnv({
      GOLFAPI_DAILY_CAP: '300',
      GOLFAPI_MONTHLY_CAP: '1800',
      GOLFAPI_STOCKPILE_RUN_CREDITS: '300',
    });
    const keys = stockpileKeys(new Date(BULK_AT), env);
    counter.sql.map.set(keys.dayKey, '40');
    counter.sql.map.set(keys.monthKey, '1790');
    await seedDemand(counter, keys.cycleId, { courseId: 'own-1', name: 'Own Counter' });
    const http = installFetch((url) => {
      if (url.includes('city=') || url.includes('state=')) return jsonResponse({ error: 'stop' }, 503);
      return jsonResponse({
        courses: [],
        courseID: 'own-1',
        country: 'US',
        latitude: 34.7,
        longitude: -92.2,
        numHoles: 1,
        hasGPS: 1,
        apiRequestsLeft: 400,
        coordinates: [
          { hole: 1, poi: 1, latitude: 34.7, longitude: -92.2 },
          { hole: 1, poi: 11, latitude: 34.71, longitude: -92.21 },
        ],
      });
    });
    try {
      const ran = await runGolfapiStockpile(env, {}, bulkEvent(), { overlay: () => ({ kind: 'gap' }) });
      assert.equal(ran.added, 1);
      assert.equal(counter.sql.map.get(keys.dayKey), '40');
      assert.equal(counter.sql.map.get(keys.monthKey), '1792.1');
      assert.equal(Number(counter.sql.map.get(keys.monthKey)) <= 1800, true);
      assert.equal(counter.sql.map.get(keys.stockpileDayKey), '2.1');
      assert.equal(counter.sql.map.get(keys.stockpileMonthKey), '2.1');
    } finally {
      http.restore();
    }
  });

  test('an unset monthly cap allows month usage 449 and stops at 450', async () => {
    const at = Date.parse('2026-10-29T23:00:00.000Z');
    const plan = {
      now: new Date(at),
      cycleDay: 5,
      liveLeft: 400,
      rollover: 156,
      runCap: 800,
      dailyCap: 150,
      headroom: 30,
      floor: 50,
      maxDays: 7,
    };
    assert.equal(stockpileSchedule({ ...plan, monthCap: 450, monthUsed: 449 }).todayBudget, 1);
    assert.equal(stockpileSchedule({ ...plan, monthCap: 450, monthUsed: 450 }).todayBudget, 0);
    const overMonth = stockpileSchedule({ ...plan, monthCap: 450, monthUsed: 500 });
    assert.equal(overMonth.todayBudget, 0);
    assert.equal(overMonth.runs.every((row) => row.budget >= 0), true);

    const { env, counter } = baseEnv({ GOLFAPI_STOCKPILE_DRY_RUN: 'true' });
    delete env.GOLFAPI_MONTHLY_CAP;
    assert.equal(Object.hasOwn(env, 'GOLFAPI_MONTHLY_CAP'), false);
    const dryKeys = stockpileKeys(new Date(at), env);
    counter.sql.map.set(dryKeys.monthKey, '450');
    await seedDemand(counter, dryKeys.cycleId, { courseId: 'month-cap', name: 'Month Cap' });
    const quiet = installFetch(() => {
      throw new Error('a month at the cap must not call golfapi');
    });
    try {
      const dry = await runGolfapiStockpile(env, {}, bulkEvent(at), { liveLeft: 400, overlay: () => ({ kind: 'gap' }) });
      assert.equal(quiet.calls.length, 0);
      assert.equal(dry.stopped, 'app_monthly');
      assert.equal(dry.added, 0);
      assert.equal(dry.schedule.todayBudget, 0);
      assert.equal(counter.sql.map.get(dryKeys.monthKey), '450');
    } finally {
      quiet.restore();
    }

    const allowed = await runMonthCap(at, 449);
    assert.equal(allowed.result.schedule.todayBudget, 1);
    assert.equal(allowed.result.spent, 0.1);
    assert.equal(allowed.result.added, 0);
    assert.equal(allowed.result.stopped, 'app_monthly');
    assert.equal(allowed.counter.sql.map.get(allowed.keys.monthKey), '449.1');
    assert.equal(Number(allowed.counter.sql.map.get(allowed.keys.monthKey)) <= 450, true);
    assert.equal(allowed.charges.length > 0, true);
    assert.equal(allowed.charges.every((body) => body.monthCap === 450), true);
    assert.equal(allowed.charges.every((body) => body.monthKey === allowed.keys.monthKey), true);
    assert.equal(allowed.charges.every((body) => body.monthKey !== body.stockpileMonthKey), true);

    const blocked = await runMonthCap(at, 450);
    assert.equal(blocked.result.stopped, 'app_monthly');
    assert.equal(blocked.result.added, 0);
    assert.equal(blocked.result.spent, 0);
    assert.equal(blocked.counter.sql.map.get(blocked.keys.monthKey), '450');
    assert.equal(blocked.counter.sql.map.has(blocked.keys.stockpileDayKey), false);
    assert.equal(blocked.charges.length > 0, true);
    assert.equal(blocked.charges[0].monthCap, 450);
    assert.equal(blocked.charges[0].monthKey, blocked.keys.monthKey);
    assert.notEqual(blocked.charges[0].monthKey, blocked.charges[0].stockpileMonthKey);
  });

  test('the charge body sends monthCap and the counter refuses a charge at the cap', async () => {
    const counter = new FakeCounter();
    const monthKey = 'golfapi:credit:month:2026-10-05';
    const body = {
      golferDayKey: 'golfapi:credit:day:2026-10-29',
      stockpileDayKey: 'golfapi:stockpile:credit:day:2026-10-29',
      stockpileMonthKey: 'golfapi:stockpile:credit:month:2026-10-05',
      dayCap: 150,
      runCap: 800,
      dayHeadroomTenths: 300,
      monthCap: 450,
      monthKey,
    };
    assert.notEqual(body.monthKey, body.stockpileMonthKey);
    counter.sql.map.set(monthKey, '449');
    const onCap = await counterOp(counter, { op: 'stockpileCharge', ...body, chargeTenths: 10 });
    assert.deepEqual(onCap, { ok: true });
    assert.equal(counter.sql.map.get(body.stockpileDayKey), '1');
    assert.equal(counter.sql.map.get(body.stockpileMonthKey), '1');
    assert.equal(counter.sql.map.get(monthKey), '450');

    const refunded = await counterOp(counter, { op: 'stockpileRefund', ...body, chargeTenths: 10 });
    assert.deepEqual(refunded, { ok: true });
    assert.equal(counter.sql.map.get(monthKey), '449');
    assert.equal(counter.sql.map.get(body.stockpileDayKey), '0');
    assert.equal(counter.sql.map.get(body.stockpileMonthKey), '0');

    counter.sql.map.set(monthKey, '450');
    const over = await counterOp(counter, { op: 'stockpileCharge', ...body, chargeTenths: 1 });
    assert.deepEqual(over, { ok: false, reason: 'app_monthly' });
    assert.equal(counter.sql.map.get(body.stockpileDayKey), '0');
    assert.equal(counter.sql.map.get(body.stockpileMonthKey), '0');
    assert.equal(counter.sql.map.get(monthKey), '450');
  });

  test('GOLFAPI_MONTHLY_CAP=300 stops the stockpile at 300', async () => {
    const at = Date.parse('2026-10-29T23:00:00.000Z');
    const plan = {
      now: new Date(at),
      cycleDay: 5,
      liveLeft: 400,
      rollover: 156,
      runCap: 800,
      dailyCap: 150,
      headroom: 30,
      floor: 50,
      maxDays: 7,
    };
    assert.equal(stockpileSchedule({ ...plan, monthCap: 300, monthUsed: 300 }).todayBudget, 0);
    assert.equal(stockpileSchedule({ ...plan, monthCap: 300, monthUsed: 299 }).todayBudget, 1);
    assert.equal(stockpileSchedule({ ...plan, monthCap: 450, monthUsed: 300 }).todayBudget, 34.9);

    const { env, counter } = baseEnv({
      GOLFAPI_STOCKPILE_DRY_RUN: 'true',
      GOLFAPI_MONTHLY_CAP: '300',
    });
    const dryKeys = stockpileKeys(new Date(at), env);
    counter.sql.map.set(dryKeys.monthKey, '300');
    const quiet = installFetch(() => {
      throw new Error('a month at the configured cap must not call golfapi');
    });
    try {
      const dry = await runGolfapiStockpile(env, {}, bulkEvent(at), { liveLeft: 400, overlay: () => ({ kind: 'gap' }) });
      assert.equal(quiet.calls.length, 0);
      assert.equal(dry.stopped, 'app_monthly');
      assert.equal(dry.schedule.todayBudget, 0);
      assert.equal(counter.sql.map.get(dryKeys.monthKey), '300');
    } finally {
      quiet.restore();
    }

    const started = await runMonthCap(at, 299, { env: { GOLFAPI_MONTHLY_CAP: '300' } });
    assert.equal(started.result.schedule.todayBudget, 1);
    assert.equal(started.result.stopped, 'app_monthly');
    assert.equal(started.result.added, 0);
    assert.equal(started.counter.sql.map.get(started.keys.monthKey), '299.1');
    assert.equal(started.charges.every((body) => body.monthCap === 300), true);
    assert.equal(started.charges.every((body) => body.monthKey === started.keys.monthKey), true);
  });

  test('a golfer request at the same month usage still lands on the cap and then stops', async () => {
    const counter = new FakeCounter();
    const monthKey = 'golfapi:credit:month:2026-10-05';
    const reserveBody = {
      op: 'reserve',
      install: 'phone-a',
      courseId: 'golfer-1',
      now: Date.parse('2026-10-29T23:00:00Z'),
      installKey: 'golfapi:credit:install:phone-a:2026-10-29',
      dayKey: 'golfapi:credit:day:2026-10-29',
      monthKey,
      dayCap: 150,
      monthCap: 450,
      chargeTenths: 10,
      needTenths: 10,
      isSearch: false,
    };
    counter.sql.map.set(monthKey, '449');
    const landed = await counterOp(counter, reserveBody);
    assert.equal(landed.ok, true);
    assert.equal(counter.sql.map.get(monthKey), '450');

    const tenth = await counterOp(counter, {
      ...reserveBody,
      install: 'phone-b',
      courseId: 'golfer-2',
      chargeTenths: 1,
      needTenths: 1,
    });
    assert.equal(tenth.ok, false);
    assert.equal(tenth.reason, 'app_monthly');
    assert.equal(counter.sql.map.get(monthKey), '450');
  });

  test('a run that would cross the monthly cap stops at the cap', async () => {
    const at = Date.parse('2026-10-29T23:00:00.000Z');
    const plan = {
      now: new Date(at),
      cycleDay: 5,
      liveLeft: 400,
      rollover: 156,
      runCap: 800,
      dailyCap: 150,
      headroom: 30,
      floor: 50,
      maxDays: 7,
    };
    assert.equal(stockpileSchedule({ ...plan, monthCap: 450, monthUsed: 447 }).todayBudget, 3);
    const crossed = await runMonthCap(at, 447, { courseIds: ['cross-1', 'cross-2'] });
    assert.equal(crossed.result.schedule.todayBudget, 3);
    assert.equal(crossed.result.added, 1);
    assert.equal(crossed.result.spent, 2.1);
    assert.equal(crossed.result.stopped, 'app_monthly');
    assert.equal(crossed.counter.sql.map.get(crossed.keys.monthKey), '449.1');
    assert.equal(Number(crossed.counter.sql.map.get(crossed.keys.monthKey)) <= 450, true);
    assert.equal(crossed.counter.sql.map.get(crossed.keys.stockpileMonthKey), '2.1');
  });

  test('a stockpile charge and a golfer pull share one month total', async () => {
    const counter = new FakeCounter();
    const at = Date.parse('2026-10-29T23:00:00Z');
    const keys = stockpileKeys(new Date(at), { GOLFAPI_CYCLE_DAY: '5' });
    assert.notEqual(keys.monthKey, keys.stockpileMonthKey);
    counter.sql.map.set(keys.monthKey, '440');
    const body = {
      golferDayKey: keys.dayKey,
      stockpileDayKey: keys.stockpileDayKey,
      stockpileMonthKey: keys.stockpileMonthKey,
      dayCap: 150,
      runCap: 800,
      dayHeadroomTenths: 300,
      monthCap: 450,
      monthKey: keys.monthKey,
    };
    const charged = await counterOp(counter, { op: 'stockpileCharge', ...body, chargeTenths: 10 });
    assert.deepEqual(charged, { ok: true });
    assert.equal(counter.sql.map.get(keys.monthKey), '441');
    assert.equal(counter.sql.map.get(keys.stockpileMonthKey), '1');

    const reserved = await counterOp(counter, {
      op: 'reserve',
      install: 'phone-share',
      courseId: 'share-1',
      now: at,
      installKey: 'golfapi:credit:install:phone-share:2026-10-29',
      dayKey: keys.dayKey,
      monthKey: keys.monthKey,
      dayCap: 150,
      monthCap: 450,
      chargeTenths: 10,
      needTenths: 10,
      isSearch: false,
    });
    assert.equal(reserved.ok, true);
    assert.equal(counter.sql.map.get(keys.monthKey), '442');
    assert.equal(counter.sql.map.get(keys.dayKey), '1');
  });

  test('a missing run ceiling does not fall back to 80 or call golfapi', async () => {
    const { env } = baseEnv();
    delete env.GOLFAPI_STOCKPILE_RUN_CREDITS;
    const http = installFetch(() => {
      throw new Error('unset ceiling must not call golfapi');
    });
    try {
      const skipped = await runGolfapiStockpile(env, {}, bulkEvent());
      assert.equal(skipped.skipped, 'no_run_cap');
      assert.equal(http.calls.length, 0);
    } finally {
      http.restore();
    }
  });
});
