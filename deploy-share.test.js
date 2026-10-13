import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'vitest';
import { GolfapiCounter, pinsFromUrl, terrainPinHash } from './golf-proxy.js';
import { stockpileKeys } from './golf-stockpile.js';
import worker from './entry.js';
import live from './live-shottrax-share.js';

const COURSE_ID = '012141520625312276771';
const COURSE_BODY = JSON.stringify({
  courseID: COURSE_ID,
  clubName: 'Chenal Country Club',
  courseName: 'Chenal Country Club',
  country: 'US',
  numHoles: 18,
});
const COORD_BODY = JSON.stringify({
  courseID: COURSE_ID,
  coordinates: [
    { hole: 1, poi: 1, latitude: 34.1, longitude: -92.2 },
    { hole: 1, poi: 11, latitude: 34.11, longitude: -92.2 },
  ],
});
const SEARCH_BODY = JSON.stringify({ courses: [{ courseID: COURSE_ID, courseName: 'Pebble' }] });

class FakeKV {
  constructor() {
    this.store = new Map();
    this.puts = [];
    this.gets = [];
  }
  async get(key) {
    this.gets.push(key);
    return this.store.get(key)?.value ?? null;
  }
  async put(key, value, options) {
    const row = { value: String(value), options: options ?? null };
    this.store.set(key, row);
    this.puts.push({ key, value: row.value });
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix } = {}) {
    const keys = [...this.store.keys()]
      .filter((name) => (prefix ? name.startsWith(prefix) : true))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

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

class FakeCounterNamespace {
  constructor() {
    this.sql = new MemorySql();
    this.stub = new GolfapiCounter({
      storage: { sql: this.sql },
      blockConcurrencyWhile(fn) {
        return fn();
      },
    });
  }
  idFromName() {
    return 'golfapi';
  }
  get() {
    return {
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return this.stub.fetch(request);
      },
    };
  }
}

class OverlayBoards {
  constructor() {
    this.store = new Map();
    this.meta = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async getWithMetadata(key) {
    if (!this.store.has(key)) return { value: null, metadata: null };
    return { value: this.store.get(key), metadata: this.meta.get(key) || null };
  }
  async put(key, value, options) {
    this.store.set(key, String(value));
    if (options && options.metadata) this.meta.set(key, options.metadata);
  }
  async delete(key) {
    this.store.delete(key);
    this.meta.delete(key);
  }
  async list() {
    return { keys: [...this.store.keys()].map((name) => ({ name })), list_complete: true };
  }
}

function throwingBoards() {
  const boom = () => {
    throw new Error('BOARDS must not be touched');
  };
  return { get: boom, put: boom, delete: boom, list: boom };
}

function envelope(body) {
  return JSON.stringify({ status: 200, contentType: 'application/json', body });
}

function seedPermanent(kv) {
  kv.store.set(`golfapi:permanent:course:${COURSE_ID}`, { value: envelope(COURSE_BODY) });
  kv.store.set(`golfapi:permanent:coordinates:${COURSE_ID}`, { value: envelope(COORD_BODY) });
  kv.store.set('golfapi:permanent:search:country=US&name=Pebble', { value: envelope(SEARCH_BODY) });
}

function baseEnv(extra = {}) {
  const kv = extra.GOLFAPI_KV || new FakeKV();
  const counter = extra.GOLFAPI_COUNTER || new FakeCounterNamespace();
  return {
    env: {
      GOLFAPI_KEY: 'golf-secret',
      GOLF_COURSES_API_KEY: 'gca-secret',
      GOLFAPI_KV: kv,
      GOLFAPI_COUNTER: counter,
      GOLFAPI_ALLOWLIST: '',
      GOLFAPI_INSTALL_DAILY_PULLS: '4',
      GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP: '20',
      GOLFAPI_DAILY_CAP: '150',
      GOLFAPI_MONTHLY_CAP: '450',
      GOLFAPI_CREDIT_FLOOR: '50',
      TERRAIN_INSTALL_DAILY_CAP: '54',
      TERRAIN_MAX_GRID_POINTS: '6000',
      ...extra,
    },
    kv,
    counter,
  };
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`https://shottrax-share.bcbaird.workers.dev${path}`, { method, headers, body });
}

async function entryFetch(path, env, init) {
  return worker.fetch(request(path, init), env, {});
}

function installFetchRecorder() {
  const calls = [];
  const previous = globalThis.fetch;
  const previousCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {},
    },
  };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, method: init?.method || 'GET' });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
      if (previousCaches === undefined) delete globalThis.caches;
      else globalThis.caches = previousCaches;
    },
  };
}

function credit(counter, key) {
  const raw = counter.sql.map.get(key);
  return raw == null ? 0 : Number(raw);
}

describe('shottrax-share deploy wrapper', { concurrency: 1 }, () => {
  test('a migrated course, coordinates, and search serve at zero credits', async () => {
    const recorder = installFetchRecorder();
    const { env, kv, counter } = baseEnv();
    seedPermanent(kv);
    try {
      const headers = { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' };
      const course = await entryFetch(`/golfapi/v2.3/courses/${COURSE_ID}`, env, { headers });
      const coords = await entryFetch(`/golfapi/v2.3/coordinates/${COURSE_ID}`, env, { headers });
      const search = await entryFetch('/golfapi/v2.3/courses?country=US&name=Pebble', env, { headers });
      assert.equal(course.status, 200);
      assert.equal(await course.text(), COURSE_BODY);
      assert.equal(coords.status, 200);
      assert.equal(await coords.text(), COORD_BODY);
      assert.equal(search.status, 200);
      assert.equal(await search.text(), SEARCH_BODY);
      assert.equal(course.headers.get('Cache-Control'), 'public, max-age=86400');
      assert.equal(course.headers.get('X-ShotTraxx-Golfapi-Exempt'), '0');
      assert.equal(recorder.calls.some((call) => call.url.includes('golfapi.io')), false);
      assert.equal(kv.puts.length, 0);
      const day = new Date().toISOString().slice(0, 10);
      assert.equal(credit(counter, `golfapi:credit:day:${day}`), 0);
      assert.equal(credit(counter, `golfapi:pull:id_phone:${day}`), 0);
    } finally {
      recorder.restore();
    }
  });

  test('migrated gq:balance is the key the module uses for the 50-credit floor', async () => {
    const recorder = installFetchRecorder();
    const { env, kv } = baseEnv();
    kv.store.set('gq:balance', { value: JSON.stringify({ left: 50 }) });
    try {
      const blocked = await entryFetch(`/golfapi/v2.3/courses/${COURSE_ID}`, env, {
        headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' },
      });
      assert.equal(blocked.status, 429);
      const body = await blocked.json();
      assert.equal(body.error, 'golfapi_limited');
      assert.equal(body.reason, 'floor');
      assert.equal(recorder.calls.some((call) => call.url.includes('golfapi.io')), false);
      kv.store.set('gq:balance', { value: JSON.stringify({ left: 51 }) });
      recorder.calls.length = 0;
      const allowed = await entryFetch('/golfapi/v2.3/courses?country=US&name=Augusta', env, {
        headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(recorder.calls.some((call) => call.url.startsWith('https://golfapi.io/')), true);
    } finally {
      recorder.restore();
    }
  });

  test('build 151 and current golfapi paths are answered by the module', async () => {
    const recorder = installFetchRecorder();
    const { env, kv } = baseEnv();
    seedPermanent(kv);
    const liveFetch = live.fetch;
    let liveCalls = 0;
    live.fetch = async function counted(...args) {
      liveCalls += 1;
      return liveFetch.apply(this, args);
    };
    try {
      const headers = { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'USA' };
      const paths = [
        '/golfapi/v2.3/courses?country=US&name=Pebble',
        `/golfapi/v2.3/courses/${COURSE_ID}`,
        `/golfapi/v2.3/coordinates/${COURSE_ID}`,
        '/golfapi/v2.3/status',
      ];
      for (const path of paths) {
        const response = await entryFetch(path, env, { headers });
        assert.equal(response.status, 200, path);
        const payload = await response.json();
        if (path.endsWith('/status')) {
          assert.equal(payload.exempt, false);
          assert.equal(payload.dailyPulls, 4);
          assert.equal(response.headers.get('Cache-Control'), 'no-store');
        }
        assert.notEqual(payload.error, 'install_id_required');
      }
      assert.equal(liveCalls, 0);
    } finally {
      live.fetch = liveFetch;
      recorder.restore();
    }
  });

  test('non-PR paths and a null module answer fall through to live.fetch', async () => {
    const recorder = installFetchRecorder();
    const boards = new FakeKV();
    boards.store.set('ZZZZZZ', { value: '{"ok":true}' });
    boards.store.set('golfapi', { value: '{"via":"live-golfapi"}' });
    boards.store.set('terrain', { value: '{"via":"live-terrain"}' });
    const { env } = baseEnv({ BOARDS: boards });
    try {
      const cases = [
        ['/ZZZZZZ', 'GET'],
        ['/s/ABCDEF', 'GET'],
        ['/meta/gca', 'GET'],
        ['/meta/golfapi', 'GET'],
        ['/v1/course-reports', 'GET'],
        ['/v1/nope', 'GET'],
        ['/osm/v1/overlay?courseId=abc&lat=34.7&lng=-92.2&radius=200', 'GET'],
        ['/gca/v1/courses?name=pebble', 'GET'],
        ['/golfapi/other', 'GET'],
        ['/terrain/nope', 'GET'],
        ['/golfapi/v2.3/courses', 'OPTIONS'],
        ['/s/ABCDEF', 'OPTIONS'],
      ];
      for (const [path, method] of cases) {
        const viaEntry = await worker.fetch(request(path, { method, headers: { 'X-Install-Id': 'id_phone' } }), env, {});
        const viaLive = await live.fetch(request(path, { method, headers: { 'X-Install-Id': 'id_phone' } }), env, {});
        assert.equal(viaEntry.status, viaLive.status, path);
        assert.equal(viaEntry.headers.get('content-type'), viaLive.headers.get('content-type'), path);
        const stable = (text) =>
          text.replace(/nonce="[^"]+"/g, 'nonce=""').replace(/"generatedAt":"[^"]+"/g, '"generatedAt":""');
        const entryBody = stable(await viaEntry.text());
        const liveBody = stable(await viaLive.text());
        assert.equal(entryBody, liveBody, path);
      }
      const putBody = '{"holes":[]}';
      const putEntry = await worker.fetch(request('/BOARD01', { method: 'PUT', body: putBody }), env, {});
      const putLive = await live.fetch(request('/BOARD01', { method: 'PUT', body: putBody }), env, {});
      assert.equal(putEntry.status, putLive.status);
      assert.equal(await putEntry.text(), await putLive.text());
      assert.equal(await (await entryFetch('/golfapi/other', env)).text(), '{"via":"live-golfapi"}');
      assert.equal(await (await entryFetch('/terrain/nope', env)).text(), '{"via":"live-terrain"}');
    } finally {
      recorder.restore();
    }
  });

  test('live routes reached through the wrapper never call golfapi.io', async () => {
    const recorder = installFetchRecorder();
    const boards = new FakeKV();
    boards.store.set('gapi:course:1', { value: COURSE_BODY });
    const { env } = baseEnv({
      BOARDS: boards,
      GOLFAPI_KEY: 'live-would-spend-this',
      COURSE_REPORTS_ADMIN_TOKEN: 'admin-token',
    });
    const liveFetch = live.fetch;
    let inLive = false;
    const liveUrls = [];
    live.fetch = async function marked(request, ...rest) {
      inLive = true;
      try {
        return await liveFetch.call(this, request, ...rest);
      } finally {
        inLive = false;
      }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (inLive) liveUrls.push(url);
      return originalFetch(input, init);
    };
    try {
      assert.equal(typeof worker.scheduled, 'function');
      const paths = [
        ['/ZZZZZZ', 'GET'],
        ['/BOARDKEY', 'PUT', '{"a":1}'],
        ['/s/ABCDEF', 'GET'],
        ['/id:chenalcc', 'GET'],
        ['/id:chenalcc', 'PUT', '{"key":"id:chenalcc"}'],
        ['/name:chenal|little rock|ar', 'GET'],
        ['/v1/course-reports', 'GET'],
        ['/v1/course-reports', 'POST', '{}'],
        ['/v1/course-reports/photo', 'POST', '{}'],
        ['/osm/v1/overlay?courseId=chenal&lat=34.7465&lng=-92.2896&radius=400', 'GET'],
        ['/osm/v1/other', 'GET'],
        ['/meta/golfapi', 'GET'],
        ['/meta/gca', 'GET'],
        ['/gca/v1/courses?name=pebble', 'GET'],
        ['/gca/v1/courses/123', 'GET'],
        ['/gca/v1/courses/123/green-centers', 'GET'],
        ['/v1/paint-pending/promote', 'POST', '{"key":"id:chenalcc","hole":1}'],
        ['/v1/unknown', 'GET'],
        ['/golfapi', 'GET'],
        ['/golfapi/other', 'GET'],
        ['/golfapi/v2.3/', 'GET'],
        ['/golfapi/v2.3//', 'GET'],
        ['/golfapi/v2.3/not-a-route', 'GET'],
        ['/terrain/nope', 'GET'],
        ['/terrain/v1', 'GET'],
        ['/golfapi/v2.3/courses', 'OPTIONS'],
        ['/terrain/v1/pebble/1', 'OPTIONS'],
        ['/gca/v1/courses', 'OPTIONS'],
        ['/admin/alert-test', 'OPTIONS'],
        ['/s/ABCDEF', 'OPTIONS'],
      ];
      for (const [path, method, body] of paths) {
        const response = await worker.fetch(
          request(path, {
            method,
            body,
            headers: {
              'X-Install-Id': 'id_phone',
              'X-ShotTraxx-Storefront': 'US',
              Authorization: 'Bearer admin-token',
              'Content-Type': 'application/json',
            },
          }),
          env,
          {},
        );
        await response.arrayBuffer();
      }
      const spent = liveUrls.filter((url) => url.includes('golfapi.io'));
      assert.deepEqual(spent, []);
      assert.ok(liveUrls.some((url) => url.includes('golfcoursesapi.com')));
    } finally {
      live.fetch = liveFetch;
      recorder.restore();
    }
  });

  test('the module does not read or write BOARDS', async () => {
    const src = readFileSync(new URL('./golf-proxy.js', import.meta.url), 'utf8');
    assert.equal(src.includes('BOARDS'), false);
    const recorder = installFetchRecorder();
    const { env, kv } = baseEnv({ BOARDS: throwingBoards(), TERRAIN_KV: undefined });
    seedPermanent(kv);
    const query = new URLSearchParams({
      teeLat: '34.74',
      teeLng: '-92.28',
      frontLat: '34.74008',
      frontLng: '-92.28',
      centerLat: '34.74012',
      centerLng: '-92.28',
      backLat: '34.74016',
      backLng: '-92.28',
    }).toString();
    const terrainPath = `/terrain/v1/pebble/1?${query}`;
    const hash = await terrainPinHash(pinsFromUrl(new URL(`https://share.test${terrainPath}`)));
    kv.store.set(`terrain:v1:${encodeURIComponent('pebble')}:1:${hash}`, {
      value: JSON.stringify({ stepM: 10, pinHash: hash }),
    });
    try {
      const course = await entryFetch(`/golfapi/v2.3/courses/${COURSE_ID}`, env, {
        headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' },
      });
      assert.equal(course.status, 200);
      const terrain = await entryFetch(terrainPath, env, {
        headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' },
      });
      assert.equal(terrain.status, 200);
      assert.equal((await terrain.json()).stepM, 10);
      assert.ok(kv.gets.some((key) => key.startsWith('golfapi:permanent:')));
      assert.ok(kv.gets.some((key) => key.startsWith('terrain:v1:')));
    } finally {
      recorder.restore();
    }
  });

  test('the stockpile cron replaces the old queue drain and stays disabled by default', () => {
    assert.equal(typeof worker.scheduled, 'function');
    const tomlText = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
    assert.match(tomlText, /^crons = \["0 23 \* \* \*"\]$/m);
    assert.match(tomlText, /GOLFAPI_STOCKPILE_ENABLED = "false"/);
    assert.match(tomlText, /GOLFAPI_ROLLOVER_CREDITS = "156"/);
    assert.match(tomlText, /GOLFAPI_STOCKPILE_RUN_CREDITS = "800"/);
    assert.match(tomlText, /GOLFAPI_STOCKPILE_MAX_DAYS = "7"/);
    assert.match(tomlText, /GOLFAPI_STOCKPILE_DRY_RUN = "false"/);
    assert.doesNotMatch(tomlText, /0 8 \* \* \*/);
    assert.match(tomlText, /^name = "shottrax-share"/m);
    assert.match(tomlText, /587c98f5372647a88bc9418aa076827a/);
    assert.doesNotMatch(tomlText, /REPLACE_WITH_NEW_GOLFAPI_KV_ID/);
    assert.match(tomlText, /cfa1824a10374ab6a7fa0c97d0990e80/);
  });

  test('entry stockpile buys a course that has no lat, then coordinates only for an overlay gap', async () => {
    const boards = new OverlayBoards();
    const sent = [];
    const { env, kv, counter } = baseEnv({
      BOARDS: boards,
      GOLFAPI_STOCKPILE_ENABLED: 'true',
      GOLFAPI_ROLLOVER_CREDITS: '156',
      GOLFAPI_CREDIT_FLOOR: '50',
      GOLFAPI_DAILY_CAP: '150',
      GOLFAPI_MONTHLY_CAP: '450',
      GOLFAPI_STOCKPILE_DAY_HEADROOM: '30',
      GOLFAPI_STOCKPILE_RUN_CREDITS: '80',
      GOLFAPI_CYCLE_DAY: '5',
      ALERT_EMAIL: {
        async send(message) {
          sent.push(message);
        },
      },
    });
    const when = Date.parse('2026-11-04T23:00:00Z');
    const keys = stockpileKeys(new Date(when), env);
    await counter.get().fetch('https://golfapi-counter.internal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'noteDemand',
        reason: 'phone_limit',
        cycleId: keys.cycleId,
        name: 'Gap Entry',
        country: 'US',
        courseId: 'gap-entry-1',
        day: '2026-11-04',
      }),
    });
    const lat = 34.7465;
    const lng = -92.2896;
    const overlayKey = `osm:v1:${lat.toFixed(4)},${lng.toFixed(4)}:1800`;
    boards.store.set(overlayKey, JSON.stringify({
      elements: [{
        type: 'node',
        tags: { golf: 'tee', ref: '1' },
        geometry: [{ lat, lon: lng }],
      }],
    }));
    boards.meta.set(overlayKey, { fetchedAt: Date.now() });
    const previous = globalThis.fetch;
    const previousCaches = globalThis.caches;
    const calls = [];
    globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes('overpass')) throw new Error(`overlay refreshed from overpass ${url}`);
      const paid = url.includes('/courses/') || url.includes('/coordinates/');
      return new Response(JSON.stringify({
        courses: [],
        courseID: 'gap-entry-1',
        courseName: 'Gap Entry',
        country: 'US',
        latitude: lat,
        longitude: lng,
        numHoles: 1,
        hasGPS: 1,
        apiRequestsLeft: paid ? 398 : 400,
        coordinates: [
          { hole: 1, poi: 1, latitude: lat, longitude: lng },
          { hole: 1, poi: 11, latitude: lat + 0.001, longitude: lng },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const report = await worker.scheduled({ cron: '0 23 * * *', scheduledTime: when }, env, {});
      assert.equal(report.added, 1);
      assert.equal(calls.some((url) => url.includes('golfapi.io') && url.includes('/courses/gap-entry-1')), true);
      assert.equal(calls.some((url) => url.includes('golfapi.io') && url.includes('/coordinates/gap-entry-1')), true);
      assert.equal(calls.some((url) => url.includes('overpass')), false);
      assert.equal(kv.store.has('golfapi:us:gap-entry-1'), true);
      assert.equal(kv.store.has('golfapi:permanent:course:gap-entry-1'), true);
      assert.equal(kv.store.has('golfapi:permanent:coordinates:gap-entry-1'), true);
      assert.equal(sent.length, 1);
      assert.match(sent[0].raw, /Subject: ShotTraxx golfapi stockpile/);
      assert.match(sent[0].raw, /Courses added: 1/);
    } finally {
      globalThis.fetch = previous;
      if (previousCaches === undefined) delete globalThis.caches;
      else globalThis.caches = previousCaches;
    }
  });

  test('an 08:00 cron and a dry run make no paid golfapi call', async () => {
    const boards = new OverlayBoards();
    const sent = [];
    const { env, counter } = baseEnv({
      BOARDS: boards,
      GOLFAPI_STOCKPILE_ENABLED: 'true',
      GOLFAPI_ROLLOVER_CREDITS: '156',
      GOLFAPI_DAILY_CAP: '150',
      GOLFAPI_MONTHLY_CAP: '450',
      GOLFAPI_CYCLE_DAY: '5',
      GOLFAPI_STOCKPILE_RUN_CREDITS: '80',
      GOLFAPI_STOCKPILE_MAX_DAYS: '10',
      GOLFAPI_STOCKPILE_DRY_RUN: 'true',
      ALERT_EMAIL: {
        async send(message) {
          sent.push(message);
        },
      },
    });
    const when = Date.parse('2026-11-04T23:00:00Z');
    const keys = stockpileKeys(new Date(when), env);
    await counter.get().fetch('https://golfapi-counter.internal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'noteDemand',
        reason: 'phone_limit',
        cycleId: keys.cycleId,
        name: 'Dry Entry',
        country: 'US',
        courseId: 'dry-entry-1',
        day: '2026-11-04',
      }),
    });
    const lat = 34.7465;
    const lng = -92.2896;
    env.GOLFAPI_KV.store.set('golfapi:permanent:course:dry-entry-1', {
      value: JSON.stringify({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          courseID: 'dry-entry-1',
          country: 'US',
          latitude: lat,
          longitude: lng,
          numHoles: 1,
          hasGPS: 1,
        }),
      }),
    });
    const overlayKey = `osm:v1:${lat.toFixed(4)},${lng.toFixed(4)}:1800`;
    boards.store.set(overlayKey, JSON.stringify({
      elements: [{
        type: 'node',
        tags: { golf: 'tee', ref: '1' },
        geometry: [{ lat, lon: lng }],
      }],
    }));
    boards.meta.set(overlayKey, { fetchedAt: Date.now() });
    const previous = globalThis.fetch;
    const previousCaches = globalThis.caches;
    const calls = [];
    globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      throw new Error(`paid call ${url}`);
    };
    try {
      const morning = { ...env, BOARDS: undefined, GOLFAPI_STOCKPILE_DRY_RUN: 'false' };
      const drained = await worker.scheduled({ cron: '0 8 * * *', scheduledTime: when }, morning, {});
      assert.equal(calls.some((url) => url.includes('golfapi.io')), false);
      assert.equal(drained.skipped, 'cron');
      const listed = await worker.scheduled({ cron: '0 23 * * *', scheduledTime: when }, env, {});
      assert.equal(listed.dryRun, true);
      assert.deepEqual(listed.wouldPull, [{ courseId: 'dry-entry-1', cost: 1 }]);
      assert.equal(listed.spent, 0);
      assert.equal(calls.some((url) => url.includes('golfapi.io')), false);
      assert.equal(sent.length, 1);
      assert.match(sent[0].raw, /Would pull: dry-entry-1 \(1\)/);
      assert.match(sent[0].raw, /Dry run: no paid golfapi call was made/);
    } finally {
      globalThis.fetch = previous;
      if (previousCaches === undefined) delete globalThis.caches;
      else globalThis.caches = previousCaches;
    }
  });

  test('a disabled stockpile cron does not call golfapi or the live queue', async () => {
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 200 });
    };
    try {
      await worker.scheduled({
        cron: '0 23 * * *',
        scheduledTime: Date.parse('2026-11-04T23:00:00Z'),
      }, { GOLFAPI_STOCKPILE_ENABLED: 'false', GOLFAPI_KEY: 'would-spend' }, {});
      assert.deepEqual(calls, []);
    } finally {
      globalThis.fetch = previous;
    }
  });

  test('module GET and error responses carry live CORS; OPTIONS stays on live', async () => {
    const recorder = installFetchRecorder();
    const { env, kv } = baseEnv();
    kv.store.set('gq:balance', { value: JSON.stringify({ left: 40 }) });
    try {
      const samples = [
        ['/golfapi/v2.3/status', 'GET'],
        ['/golfapi/v2.3/status', 'POST'],
        [`/golfapi/v2.3/courses/${COURSE_ID}`, 'GET'],
        ['/terrain/v1/not-a-pair', 'GET'],
        ['/admin/demand', 'GET'],
        ['/admin/alert-test', 'GET'],
      ];
      for (const [path, method] of samples) {
        const response = await entryFetch(path, env, {
          method,
          headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' },
        });
        const preflight = await live.fetch(request(path, { method: 'OPTIONS' }), env, {});
        for (const name of [
          'access-control-allow-methods',
          'access-control-allow-headers',
          'access-control-allow-origin',
        ]) {
          assert.equal(response.headers.get(name), preflight.headers.get(name), `${method} ${path} ${name}`);
        }
        if (path.startsWith('/golfapi/')) assert.equal(response.headers.get('access-control-allow-origin'), null);
        else assert.equal(response.headers.get('access-control-allow-origin'), '*');
        await response.arrayBuffer();
      }
      const limited = await entryFetch(`/golfapi/v2.3/courses/${COURSE_ID}`, env, {
        headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'US' },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after') != null, true);
      assert.equal(limited.headers.get('content-type'), 'application/json');
      const options = await entryFetch('/golfapi/v2.3/status', env, { method: 'OPTIONS' });
      const liveOptions = await live.fetch(request('/golfapi/v2.3/status', { method: 'OPTIONS' }), env, {});
      assert.equal(options.status, liveOptions.status);
      assert.equal(options.headers.get('access-control-allow-methods'), 'GET,PUT,OPTIONS');
      assert.equal(options.headers.get('access-control-allow-origin'), null);
      assert.equal(await options.text(), await liveOptions.text());
    } finally {
      recorder.restore();
    }
  });


});
