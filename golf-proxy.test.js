import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'vitest';
import {
  DOC_GOLFAPI_ALLOWLIST_ID,
  GolfapiCounter,
  buildTerrainGrid,
  golfapiCycleId,
  handleGolfProxy,
  holeCorridor,
  pinsFromUrl,
  resetTerrainInflightForTests,
  terrainPinHash,
  terrainPinKey,
  usTerritoryAt,
} from './golf-proxy.js';

const FEET_PER_METER = 3.280839895013123;
const DOC = DOC_GOLFAPI_ALLOWLIST_ID;

class FakeKV {
  constructor() {
    this.store = new Map();
    this.puts = [];
    this.listCalls = 0;
  }
  async get(key) {
    return this.store.get(key)?.value ?? null;
  }
  async put(key, value, options) {
    const row = { value: String(value), options: options ?? null };
    this.store.set(key, row);
    this.puts.push({ key, value: row.value, options: row.options ? { ...row.options } : null });
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix } = {}) {
    this.listCalls = (this.listCalls || 0) + 1;
    const keys = [...this.store.keys()]
      .filter((name) => (prefix ? name.startsWith(prefix) : true))
      .map((name) => ({ name }));
    return { keys };
  }
}

class MemorySql {
  constructor() {
    this.map = new Map();
    this.queries = [];
  }
  exec(query, ...args) {
    const text = query.replace(/\s+/g, ' ').trim();
    this.queries.push({ text, args: [...args] });
    if (text.startsWith('CREATE')) return [];
    if (text.startsWith('SELECT key FROM state WHERE key LIKE')) {
      const prefix = String(args[0] ?? '').replace(/%+$/, '');
      return [...this.map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key }));
    }
    if (text.includes('WHERE key >=') && text.includes('AND key <')) {
      const lo = String(args[0]);
      const hi = String(args[1]);
      return [...this.map.keys()].filter((key) => key >= lo && key < hi).map((key) => ({ key }));
    }
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
  constructor(env) {
    this.sql = new MemorySql();
    this.stub = new GolfapiCounter({
      storage: { sql: this.sql },
      blockConcurrencyWhile(fn) {
        return fn();
      },
    }, env);
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
        this.chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
  }
}

class FakeCache {
  constructor() {
    this.entries = new Map();
    this.puts = [];
  }
  async match(request) {
    const hit = this.entries.get(request.url);
    if (!hit) return undefined;
    return new Response(hit.body, { status: hit.status, headers: hit.headers });
  }
  async put(request, response) {
    const body = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    this.entries.set(request.url, { body, status: response.status, headers });
    this.puts.push({ url: request.url, headers, body });
  }
}

function installFakes() {
  const kv = new FakeKV();
  const terrain = new FakeKV();
  const cache = new FakeCache();
  const counter = new FakeCounterNamespace();
  const calls = [];
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: cache };
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  resetTerrainInflightForTests();
  return {
    kv,
    terrain,
    cache,
    counter,
    calls,
    restore() {
      globalThis.fetch = previousFetch;
      if (previousCaches === undefined) delete globalThis.caches;
      else globalThis.caches = previousCaches;
      resetTerrainInflightForTests();
    },
  };
}

function baseEnv(fake, extra = {}) {
  return {
    GOLFAPI_KEY: 'golf-secret',
    GOLF_COURSES_API_KEY: 'gca-secret',
    GOLFAPI_KV: fake.kv,
    TERRAIN_KV: fake.terrain,
    GOLFAPI_COUNTER: fake.counter,
    GOLFAPI_ALLOWLIST: '',
    TERRAIN_INSTALL_DAILY_CAP: '54',
    GOLFAPI_INSTALL_DAILY_PULLS: '4',
    GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP: '20',
    GOLFAPI_DAILY_CAP: '150',
    GOLFAPI_MONTHLY_CAP: '450',
    TERRAIN_LOCK_WAIT_MS: '0',
    ...extra,
  };
}

function usHeaders(id = 'id_phone', storefront = 'USA') {
  return { 'X-Install-Id': id, 'X-ShotTraxx-Storefront': storefront };
}

async function proxy(path, env, headers = {}, method = 'GET', ctx) {
  return handleGolfProxy(new Request(`https://share.test${path}`, { method, headers }), env, ctx);
}

function golfJson(fake, payload, status = 200) {
  globalThis.fetch = async (input, init) => {
    fake.calls.push({ url: String(input), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function permanentPuts(kv) {
  return kv.puts.filter((put) => put.key.startsWith('golfapi:permanent:'));
}

function assertForever(put) {
  assert.equal(put.options, null, put.key);
}

function creditPuts(kv) {
  return kv.puts.filter((put) => put.key.startsWith('golfapi:credit:'));
}

function creditKey(install, kind, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (kind === 'install') return `golfapi:credit:install:${install}:${day}`;
  if (kind === 'pull') return `golfapi:pull:${install}:${day}`;
  if (kind === 'search') return `golfapi:search:${install}:${day}`;
  if (kind === 'day') return `golfapi:credit:day:${day}`;
  return `golfapi:credit:month:${golfapiCycleId(now, 5)}`;
}

function usableCourse(id, name = 'Mapped') {
  return {
    courseID: id,
    clubName: name,
    country: 'US',
    coordinates: [
      { hole: 1, poi: 1, latitude: 34.1, longitude: -92.2 },
      { hole: 1, poi: 11, latitude: 34.11, longitude: -92.2 },
    ],
  };
}

function alertCapture() {
  const sent = [];
  const pending = [];
  return {
    sent,
    binding: {
      async send(message) {
        sent.push(message);
      },
    },
    ctx: {
      waitUntil(promise) {
        pending.push(promise);
      },
    },
    async flush() {
      await Promise.all(pending.splice(0));
    },
  };
}

async function counterOp(fake, body) {
  const response = await fake.counter.get().fetch('https://golfapi-counter.internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function counterValue(fake, key) {
  const raw = fake.counter.sql.map.get(key);
  return raw == null ? 0 : Number(raw);
}

function seedCredits(fake, install, n, now = new Date()) {
  for (const key of [creditKey(install, 'install', now), creditKey(install, 'day', now), creditKey(install, 'month', now)]) {
    fake.counter.sql.map.set(key, String(n));
  }
}

async function bodyOf(response) {
  return response.json();
}

describe('golf proxy worker', { concurrency: 1 }, () => {
  test('US and territory points are inside the bounding polygons; other countries are not', () => {
    assert.equal(usTerritoryAt(34.7465, -92.2896), 'conus');
    assert.equal(usTerritoryAt(25.7617, -80.1918), 'conus');
    assert.equal(usTerritoryAt(47.6062, -122.3321), 'conus');
    assert.equal(usTerritoryAt(32.7157, -117.1611), 'conus');
    assert.equal(usTerritoryAt(24.5551, -81.78), 'conus');
    assert.equal(usTerritoryAt(42.3314, -83.0458), 'conus');
    assert.equal(usTerritoryAt(61.2181, -149.9003), 'alaska');
    assert.equal(usTerritoryAt(52.0, 177.0), 'aleutians');
    assert.equal(usTerritoryAt(21.3069, -157.8583), 'hawaii');
    assert.equal(usTerritoryAt(18.4655, -66.1057), 'puerto-rico');
    assert.equal(usTerritoryAt(18.3419, -64.9307), 'usvi');
    assert.equal(usTerritoryAt(13.4757, 144.7489), 'guam');
    assert.equal(usTerritoryAt(15.185, 145.7467), 'nmi');
    assert.equal(usTerritoryAt(-14.2756, -170.702), 'american-samoa');
    assert.equal(usTerritoryAt(56.3439, -2.8024), null);
    assert.equal(usTerritoryAt(43.6532, -79.3832), null);
    assert.equal(usTerritoryAt(19.4326, -99.1332), null);
    assert.equal(usTerritoryAt(49.2827, -123.1207), null);
  });

  test('a KV hit costs no credit and does not count toward a cap of zero', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'c1', country: 'US', clubName: 'Pebble' });
      const env = baseEnv(fake);
      const first = await proxy('/golfapi/v2.3/courses/c1', env, usHeaders());
      assert.equal(first.status, 200);
      assert.equal(fake.calls.length, 1);
      assert.equal(creditPuts(fake.kv).length, 0);

      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('kv hit must not fetch');
      };
      const blockedCaps = baseEnv(fake, {
        GOLFAPI_DAILY_CAP: '0',
        GOLFAPI_MONTHLY_CAP: '0',
      });
      const second = await proxy('/golfapi/v2.3/courses/c1', blockedCaps, usHeaders('id_other', 'US'));
      assert.equal(second.status, 200);
      assert.equal((await bodyOf(second)).courseID, 'c1');
      assert.equal(fake.calls.length, 0);
      assert.equal(creditPuts(fake.kv).length, 0);
    } finally {
      fake.restore();
    }
  });

  test('successful course, coordinates, and name-search copies are stored with no expiration', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('/courses?')) {
          return new Response(JSON.stringify({ courses: [{ courseID: 'us-9', country: 'USA' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/coordinates/')) {
          return new Response(JSON.stringify({ coordinates: [{ hole: 1 }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courseID: 'us-9', country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = usHeaders();
      assert.equal((await proxy('/golfapi/v2.3/courses?name=Pebble&country=US', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses/us-9', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/coordinates/us-9', env, headers)).status, 200);

      const stored = permanentPuts(fake.kv);
      assert.equal(stored.length, 3);
      for (const put of stored) assertForever(put);
      const usFlag = fake.kv.puts.filter((put) => put.key === 'golfapi:us:us-9');
      assert.ok(usFlag.length >= 1);
      for (const put of usFlag) assertForever(put);
      const searchIds = [...fake.kv.store.keys()].filter((key) => key.startsWith('golfapi:us-search:'));
      assert.equal(searchIds.length, 0);
      assert.equal(fake.kv.listCalls, 0);
      assert.equal(creditPuts(fake.kv).length, 0);
    } finally {
      fake.restore();
    }
  });

  test('a zero-hit search expires in 7 days and a search hit stays permanent', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        const body = url.includes('name=Riverview')
          ? { courses: [] }
          : { courses: [{ courseID: 'rv-1', courseName: 'Riverview', country: 'US' }] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = usHeaders();
      assert.equal((await proxy('/golfapi/v2.3/courses?name=Riverview%20Course&country=US', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses?name=Pebble&country=US', env, headers)).status, 200);
      const stored = permanentPuts(fake.kv);
      const empty = stored.find((put) => put.key === 'golfapi:permanent:search:country=US&name=Riverview+Course');
      const hit = stored.find((put) => put.key === 'golfapi:permanent:search:country=US&name=Pebble');
      assert.ok(empty);
      assert.deepEqual(empty.options, { expirationTtl: 604800 });
      assert.equal(JSON.parse(empty.value).emptySearchTtl, 604800);
      assert.ok(hit);
      assertForever(hit);
      assert.equal(JSON.parse(hit.value).emptySearchTtl, undefined);
      assert.equal(fake.cache.puts[0].headers['x-shottraxx-golfapi-empty-search'], '604800');
      assert.equal(fake.cache.puts[1].headers['x-shottraxx-golfapi-empty-search'], undefined);
    } finally {
      fake.restore();
    }
  });

  test('a stored zero-hit search is served at 0 credits inside the 7 day window', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courses: [], apiRequestsLeft: 400 });
      const env = baseEnv(fake);
      const path = '/golfapi/v2.3/courses?name=Riverview%20Course&country=US';
      const first = await proxy(path, env, usHeaders());
      assert.equal(first.status, 200);
      assert.deepEqual(await bodyOf(first), { courses: [], apiRequestsLeft: 400 });
      const before = {
        install: counterValue(fake, creditKey('id_phone', 'install')),
        day: counterValue(fake, creditKey('id_phone', 'day')),
        month: counterValue(fake, creditKey('id_phone', 'month')),
      };
      assert.equal(before.install, 0.1);
      assert.equal(first.headers.get('X-ShotTraxx-Golfapi-Empty-Search'), '604800');
      assert.match(first.headers.get('Cache-Control'), /max-age=604800/);
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('stored zero-hit must not fetch');
      };
      const second = await proxy(path, env, usHeaders());
      assert.equal(second.status, 200);
      assert.deepEqual(await bodyOf(second), { courses: [], apiRequestsLeft: 400 });
      assert.equal(second.headers.get('X-ShotTraxx-Golfapi-Empty-Search'), '604800');
      const repeatAge = Number(second.headers.get('Cache-Control').match(/max-age=(\d+)/)[1]);
      assert.equal(repeatAge <= 604800 && repeatAge > 604000, true);
      assert.equal(second.headers.get('Cache-Control').includes('86400'), false);
      assert.equal(fake.calls.length, 0);
      assert.equal(counterValue(fake, creditKey('id_phone', 'install')), before.install);
      assert.equal(counterValue(fake, creditKey('id_phone', 'day')), before.day);
      assert.equal(counterValue(fake, creditKey('id_phone', 'month')), before.month);

      fake.kv.store.delete('golfapi:permanent:search:country=US&name=Riverview+Course');
      const fromEdge = await proxy(path, env, usHeaders());
      assert.equal(fromEdge.status, 200);
      assert.deepEqual(await bodyOf(fromEdge), { courses: [], apiRequestsLeft: 400 });
      assert.equal(fake.calls.length, 0);
      assert.equal(counterValue(fake, creditKey('id_phone', 'install')), before.install);
    } finally {
      fake.restore();
    }
  });

  test('a stored empty search writes an edge copy with the 7-day empty-search header', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courses: [] });
      const env = baseEnv(fake);
      const path = '/golfapi/v2.3/courses?name=Riverview%20Course&country=US';
      const first = await proxy(path, env, usHeaders());
      assert.equal(first.headers.get('X-ShotTraxx-Golfapi-Empty-Search'), '604800');
      fake.cache.entries.clear();
      fake.cache.puts.length = 0;
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('stored empty search must not fetch');
      };
      const repeat = await proxy(path, env, usHeaders());
      assert.equal(repeat.status, 200);
      assert.equal(repeat.headers.get('X-ShotTraxx-Golfapi-Empty-Search'), '604800');
      assert.equal(repeat.headers.get('Cache-Control').includes('86400'), false);
      assert.equal(fake.calls.length, 0);
      assert.equal(fake.cache.puts.length, 1);
      assert.equal(fake.cache.puts[0].headers['x-shottraxx-golfapi-empty-search'], '604800');
      const age = Number(fake.cache.puts[0].headers['cache-control'].match(/max-age=(\d+)/)[1]);
      assert.equal(age <= 604800 && age > 604000, true);
      assert.equal(fake.cache.puts[0].headers['cache-control'].includes('86400'), false);
    } finally {
      fake.restore();
    }
  });

  test('a stored empty search uses the row remaining life instead of a 24h max-age', async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake);
      const until = Date.now() + 2500;
      await fake.kv.put('golfapi:permanent:search:country=US&name=Short', JSON.stringify({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ courses: [] }),
        emptySearchTtl: 604800,
        emptySearchUntil: until,
      }));
      globalThis.fetch = async () => {
        throw new Error('remaining empty search must not fetch');
      };
      const response = await proxy('/golfapi/v2.3/courses?name=Short&country=US', env, usHeaders());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-ShotTraxx-Golfapi-Empty-Search'), '604800');
      const age = Number(response.headers.get('Cache-Control').match(/max-age=(\d+)/)[1]);
      assert.equal(age <= 3 && age >= 1, true);
      assert.equal(fake.cache.puts[0].headers['x-shottraxx-golfapi-empty-search'], '604800');
      assert.equal(fake.cache.puts[0].headers['cache-control'].includes('86400'), false);
    } finally {
      fake.restore();
    }
  });

  test('the 4th repeat of an empty search makes 0 golfapi calls and costs 0', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courses: [] });
      const env = baseEnv(fake);
      const headers = usHeaders('id_fourth');
      const path = '/golfapi/v2.3/courses?name=Fourth&country=US';
      assert.equal((await proxy(path, env, headers)).status, 200);
      for (let n = 1; n <= 3; n += 1) {
        assert.equal((await proxy(path, env, headers)).status, 200);
      }
      const before = {
        calls: fake.calls.length,
        install: counterValue(fake, creditKey('id_fourth', 'install')),
        day: counterValue(fake, creditKey('id_fourth', 'day')),
        month: counterValue(fake, creditKey('id_fourth', 'month')),
        search: counterValue(fake, creditKey('id_fourth', 'search')),
      };
      assert.equal(before.calls, 1);
      assert.equal(before.install, 0.1);
      assert.equal(before.day, 0.1);
      assert.equal(before.month, 0.1);
      assert.equal(before.search, 1);
      const fourth = await proxy(path, env, headers);
      assert.equal(fourth.status, 200);
      assert.deepEqual(await bodyOf(fourth), { courses: [] });
      assert.equal(fake.calls.length, before.calls);
      assert.equal(counterValue(fake, creditKey('id_fourth', 'install')), before.install);
      assert.equal(counterValue(fake, creditKey('id_fourth', 'day')), before.day);
      assert.equal(counterValue(fake, creditKey('id_fourth', 'month')), before.month);
      assert.equal(counterValue(fake, creditKey('id_fourth', 'search')), before.search);
    } finally {
      fake.restore();
    }
  });

  test('a stored search, empty or not, never counts toward the 30 searches a day or any credit counter', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        const courses = url.includes('name=CachedHit')
          ? [{ courseID: 'ch-1', courseName: 'Cached Hit', country: 'US' }]
          : [];
        return new Response(JSON.stringify({ courses }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = usHeaders('id_cached');
      const emptyPath = '/golfapi/v2.3/courses?name=CachedEmpty&country=US';
      const hitPath = '/golfapi/v2.3/courses?name=CachedHit&country=US';
      assert.equal((await proxy(emptyPath, env, headers)).status, 200);
      assert.equal((await proxy(hitPath, env, headers)).status, 200);
      assert.equal(fake.calls.length, 2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'search')), 2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'install')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'day')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'month')), 0.2);

      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('stored search must not fetch');
      };
      for (let n = 0; n < 4; n += 1) {
        assert.equal((await proxy(emptyPath, env, headers)).status, 200);
        assert.equal((await proxy(hitPath, env, headers)).status, 200);
      }
      fake.kv.store.delete('golfapi:permanent:search:country=US&name=CachedEmpty');
      fake.kv.store.delete('golfapi:permanent:search:country=US&name=CachedHit');
      assert.equal((await proxy(emptyPath, env, headers)).status, 200);
      assert.equal((await proxy(hitPath, env, headers)).status, 200);
      assert.equal(fake.calls.length, 0);
      assert.equal(counterValue(fake, creditKey('id_cached', 'search')), 2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'install')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'day')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_cached', 'month')), 0.2);

      golfJson(fake, { courses: [{ courseID: 'live-1', courseName: 'Live', country: 'US' }] });
      assert.equal((await proxy('/golfapi/v2.3/courses?name=LiveOnly&country=US', env, headers)).status, 200);
      assert.equal(fake.calls.length, 1);
      assert.equal(counterValue(fake, creditKey('id_cached', 'search')), 3);
      assert.equal(counterValue(fake, creditKey('id_cached', 'install')), 0.3);
      assert.equal(counterValue(fake, creditKey('id_cached', 'day')), 0.3);
      assert.equal(counterValue(fake, creditKey('id_cached', 'month')), 0.3);
    } finally {
      fake.restore();
    }
  });

  test('search credits, the 30-search cap, and cached searches', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        const courses = url.includes('name=Hit') ? [{ courseID: 'hit-1', courseName: 'Hit', country: 'US' }] : [];
        return new Response(JSON.stringify({ courses }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = usHeaders('id_search');
      const emptyPath = '/golfapi/v2.3/courses?name=Empty&country=US';
      const hitPath = '/golfapi/v2.3/courses?name=Hit&country=US';
      assert.equal((await proxy(emptyPath, env, headers)).status, 200);
      assert.equal(counterValue(fake, creditKey('id_search', 'install')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_search', 'day')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_search', 'month')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_search', 'search')), 1);
      for (let n = 0; n < 4; n += 1) {
        assert.equal((await proxy(emptyPath, env, headers)).status, 200);
      }
      assert.equal(fake.calls.length, 1);
      assert.equal(counterValue(fake, creditKey('id_search', 'install')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_search', 'day')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_search', 'month')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_search', 'search')), 1);

      assert.equal((await proxy(hitPath, env, headers)).status, 200);
      for (let n = 0; n < 4; n += 1) {
        assert.equal((await proxy(hitPath, env, headers)).status, 200);
      }
      assert.equal(fake.calls.length, 2);
      assert.equal(counterValue(fake, creditKey('id_search', 'install')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_search', 'day')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_search', 'month')), 0.2);
      assert.equal(counterValue(fake, creditKey('id_search', 'search')), 2);

      for (let n = 0; n < 28; n += 1) {
        assert.equal((await proxy(`/golfapi/v2.3/courses?name=S${n}&country=US`, env, headers)).status, 200);
      }
      assert.equal(counterValue(fake, creditKey('id_search', 'search')), 30);
      assert.equal(counterValue(fake, creditKey('id_search', 'install')), 3);
      const callsAtCap = fake.calls.length;
      for (let n = 0; n < 4; n += 1) {
        assert.equal((await proxy(emptyPath, env, headers)).status, 200);
        assert.equal((await proxy(hitPath, env, headers)).status, 200);
      }
      assert.equal(fake.calls.length, callsAtCap);
      assert.equal(counterValue(fake, creditKey('id_search', 'search')), 30);
      assert.equal(counterValue(fake, creditKey('id_search', 'install')), 3);

      const refused = await proxy('/golfapi/v2.3/courses?name=Blocked&country=US', env, headers);
      const body = await bodyOf(refused);
      assert.equal(refused.status, 429);
      assert.equal(body.error, 'golfapi_limited');
      assert.equal(body.message, 'golfapi_limited');
      assert.equal(body.reason, 'phone_limit');
      assert.equal(fake.calls.length, callsAtCap);
      assert.equal(counterValue(fake, creditKey('id_search', 'search')), 30);
      assert.equal(counterValue(fake, creditKey('id_search', 'install')), 3);
      const cycleId = golfapiCycleId(new Date(), 5);
      const demand = await counterOp(fake, { op: 'readDemand', cycleId });
      const row = demand.pull_candidates.find((item) => item.name === 'Blocked');
      assert.ok(row);
      assert.equal(row.country, 'US');
      assert.equal(row.courseId, null);
      assert.ok(row.reasons.includes('phone_limit'));
      assert.equal(JSON.stringify(demand).includes('id_search'), false);
    } finally {
      fake.restore();
    }
  });

  test('a course open of 3 searches and 2 pulls costs 2.3, and the backstop refuses at 20 credits', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('/coordinates/')) {
          return new Response(JSON.stringify(usableCourse('open-1')), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/courses/')) {
          return new Response(JSON.stringify({ courseID: 'open-1', courseName: 'Open', country: 'US', numHoles: 18 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courses: [{ courseID: 'open-1', courseName: 'Open', country: 'US' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = usHeaders('id_open');
      for (const name of ['One', 'Two', 'Three']) {
        assert.equal((await proxy(`/golfapi/v2.3/courses?name=${name}&country=US`, env, headers)).status, 200);
      }
      assert.equal((await proxy('/golfapi/v2.3/courses/open-1', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/coordinates/open-1', env, headers)).status, 200);
      assert.equal(counterValue(fake, creditKey('id_open', 'install')), 2.3);
      assert.equal(counterValue(fake, creditKey('id_open', 'day')), 2.3);
      assert.equal(counterValue(fake, creditKey('id_open', 'month')), 2.3);

      seedCredits(fake, 'id_stop', 20);
      const stopped = await proxy('/golfapi/v2.3/courses/stop-1', env, usHeaders('id_stop'));
      const stoppedBody = await bodyOf(stopped);
      assert.equal(stopped.status, 429);
      assert.equal(stoppedBody.reason, 'phone_limit');
      assert.equal(stoppedBody.error, 'golfapi_limited');
      assert.equal(counterValue(fake, creditKey('id_stop', 'install')), 20);
    } finally {
      fake.restore();
    }
  });

  test('an exempt install bypasses the search cap and the credit backstop, not the floor', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courses: [{ courseID: 'ex-1', courseName: 'Exempt', country: 'US' }] });
      const env = baseEnv(fake, { GOLFAPI_ALLOWLIST: DOC });
      seedCredits(fake, DOC, 20);
      fake.counter.sql.map.set(creditKey(DOC, 'search'), '30');
      const allowed = await proxy('/golfapi/v2.3/courses?name=Exempt&country=US', env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'US',
      });
      assert.equal(allowed.status, 200);
      assert.equal(fake.calls.length, 1);
      await fake.kv.put('gq:balance', JSON.stringify({ left: 50, at: 1, lastStatus: 200 }));
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('floor must not fetch');
      };
      const floored = await proxy('/golfapi/v2.3/courses?name=Exempt2&country=US', env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'US',
      });
      assert.equal(floored.status, 429);
      assert.equal((await bodyOf(floored)).reason, 'floor');
      assert.equal(fake.calls.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('overlapping searches refund the failed tenth, and a failed pull refunds exactly 1', async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake);
      const overlap = usHeaders('id_overlap');
      fake.counter.sql.map.set(creditKey('id_overlap', 'month'), '100');
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let entered = 0;
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        entered += 1;
        await gate;
        if (url.includes('name=Fail')) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          courses: [{ courseID: 'ok-1', courseName: 'Ok', country: 'US' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const pending = Promise.all([
        proxy('/golfapi/v2.3/courses?name=Ok&country=US', env, overlap),
        proxy('/golfapi/v2.3/courses?name=Fail&country=US', env, overlap),
      ]);
      const started = Date.now();
      while (entered < 2) {
        if (Date.now() - started > 1000) throw new Error(`searches never overlapped, entered ${entered}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      release();
      const [ok, failed] = await pending;
      assert.equal(ok.status, 200);
      assert.equal(failed.status, 503);
      assert.equal(counterValue(fake, creditKey('id_overlap', 'install')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_overlap', 'day')), 0.1);
      assert.equal(counterValue(fake, creditKey('id_overlap', 'month')), 100.1);
      assert.equal(counterValue(fake, creditKey('id_overlap', 'search')), 1);

      const both = usHeaders('id_both');
      fake.counter.sql.map.delete(creditKey('id_both', 'day'));
      fake.counter.sql.map.set(creditKey('id_both', 'month'), '100');
      entered = 0;
      let releaseBoth;
      const bothGate = new Promise((resolve) => {
        releaseBoth = resolve;
      });
      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        entered += 1;
        await bothGate;
        return new Response(JSON.stringify({ error: 'down' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const bothPending = Promise.all([
        proxy('/golfapi/v2.3/courses?name=One&country=US', env, both),
        proxy('/golfapi/v2.3/courses?name=Two&country=US', env, both),
      ]);
      while (entered < 2) await new Promise((resolve) => setImmediate(resolve));
      releaseBoth();
      const [firstFail, secondFail] = await bothPending;
      assert.equal(firstFail.status, 503);
      assert.equal(secondFail.status, 503);
      assert.equal(counterValue(fake, creditKey('id_both', 'install')), 0);
      assert.equal(counterValue(fake, creditKey('id_both', 'day')), 0);
      assert.equal(counterValue(fake, creditKey('id_both', 'month')), 100);
      assert.equal(counterValue(fake, creditKey('id_both', 'search')), 0);

      const pull = usHeaders('id_pullfail');
      seedCredits(fake, 'id_pullfail', 5);
      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        return new Response(JSON.stringify({ message: 'missing' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const missed = await proxy('/golfapi/v2.3/courses/missing-pull', env, pull);
      assert.equal(missed.status, 404);
      assert.equal(counterValue(fake, creditKey('id_pullfail', 'install')), 5);
      assert.equal(counterValue(fake, creditKey('id_pullfail', 'day')), 5);
      assert.equal(counterValue(fake, creditKey('id_pullfail', 'month')), 5);
    } finally {
      fake.restore();
    }
  });

  test('a 503 search and a network-error search do not count toward the daily search cap', async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake);
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('name=Down')) {
          return new Response(JSON.stringify({ error: 'down' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('socket hang up');
      };
      const down = await proxy('/golfapi/v2.3/courses?name=Down&country=US', env, usHeaders('id_503'));
      assert.equal(down.status, 503);
      assert.equal(counterValue(fake, creditKey('id_503', 'search')), 0);
      assert.equal(counterValue(fake, creditKey('id_503', 'month')), 0);
      const offline = await proxy('/golfapi/v2.3/courses?name=Offline&country=US', env, usHeaders('id_net'));
      assert.equal(offline.status, 502);
      assert.equal(counterValue(fake, creditKey('id_net', 'search')), 0);
      assert.equal(counterValue(fake, creditKey('id_net', 'month')), 0);
    } finally {
      fake.restore();
    }
  });

  test('search error, non-200, and quota bodies are never stored', async () => {
    const fake = installFakes();
    try {
      const cases = [
        ['Err', { error: 'not_found' }, 200],
        ['Down', { courses: [] }, 503],
        ['Left', { apiRequestsLeft: 400 }, 200],
        ['Quota', { message: 'quota exceeded', apiRequestsLeft: 400 }, 200],
      ];
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        const found = cases.find(([name]) => url.includes(`name=${name}`));
        return new Response(JSON.stringify(found[1]), {
          status: found[2],
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      for (const [name] of cases) {
        const response = await proxy(`/golfapi/v2.3/courses?name=${name}&country=US`, env, usHeaders());
        assert.equal(response.status, cases.find(([label]) => label === name)[2]);
      }
      assert.equal(permanentPuts(fake.kv).length, 0);
      assert.equal(fake.cache.puts.length, 0);
      assert.equal(fake.calls.length, cases.length);
    } finally {
      fake.restore();
    }
  });

  test('an old permanent empty search and an old edge empty search are fetched again', async () => {
    const fake = installFakes();
    try {
      const empty = JSON.stringify({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ courses: [] }),
      });
      await fake.kv.put('golfapi:permanent:search:country=US&name=Riverview+Course', empty);
      const edgePath = '/golfapi/v2.3/courses?name=Old%20Edge&country=US';
      const edgeUrl = new Request(new URL(`https://share.test${edgePath}`).toString(), { method: 'GET' }).url;
      fake.cache.entries.set(edgeUrl, {
        body: JSON.stringify({ courses: [] }),
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' },
      });
      fake.kv.puts.length = 0;
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        const id = url.includes('Old') ? 'old-edge' : 'rv-1';
        return new Response(JSON.stringify({ courses: [{ courseID: id, courseName: 'Riverview', country: 'US' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = usHeaders();
      const fromKv = await proxy('/golfapi/v2.3/courses?name=Riverview%20Course&country=US', env, headers);
      const fromEdge = await proxy(edgePath, env, headers);
      assert.equal((await bodyOf(fromKv)).courses[0].courseID, 'rv-1');
      assert.equal((await bodyOf(fromEdge)).courses[0].courseID, 'old-edge');
      assert.equal(fake.calls.length, 2);
      const rewritten = permanentPuts(fake.kv).find((put) => put.key.endsWith('name=Riverview+Course'));
      assertForever(rewritten);
      assert.equal(JSON.parse(rewritten.value).emptySearchTtl, undefined);
    } finally {
      fake.restore();
    }
  });

  test('an allowlisted install bypasses storefront and every credit cap', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'anywhere', country: 'JP' });
      const env = baseEnv(fake, {
        GOLFAPI_ALLOWLIST: `other, ${DOC}`,
        GOLFAPI_DAILY_CAP: '0',
        GOLFAPI_MONTHLY_CAP: '0',
        GOLFAPI_INSTALL_DAILY_PULLS: '0',
        GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP: '0',
      });
      const response = await proxy('/golfapi/v2.3/courses/anywhere?country=JP', env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'GBR',
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-ShotTraxx-Golfapi-Exempt'), '1');
      assert.equal(fake.calls.length, 1);
      assert.equal(creditPuts(fake.kv).length, 0);
      assert.equal((await proxy('/golfapi/v2.3/status', env, { 'X-Install-Id': DOC })).status, 200);
    } finally {
      fake.restore();
    }
  });

  test("Doc's install is not exempt until GOLFAPI_ALLOWLIST lists it", async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake, { GOLFAPI_ALLOWLIST: '' });
      const status = await proxy('/golfapi/v2.3/status', env, { 'X-Install-Id': DOC });
      assert.deepEqual(await bodyOf(status), { exempt: false, dailyPulls: 4 });
      globalThis.fetch = async () => {
        throw new Error('must not forward');
      };
      const refused = await proxy('/golfapi/v2.3/courses/c1', env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'CAN',
      });
      assert.equal(refused.status, 429);
      assert.match(JSON.stringify(await bodyOf(refused)), /golfapi_limited/);
    } finally {
      fake.restore();
    }
  });

  test('a present non-US storefront is refused even for country=US and a known US id', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courses: [{ courseID: 'us-1' }] });
      const env = baseEnv(fake);
      assert.equal(
        (await proxy('/golfapi/v2.3/courses?country=US&name=Pebble', env, usHeaders())).status,
        200,
      );
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('must not forward');
      };
      const headers = { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'GBR' };
      const storedSearch = await proxy('/golfapi/v2.3/courses?country=US&name=Pebble', env, headers);
      assert.equal(storedSearch.status, 200);
      const detail = await proxy('/golfapi/v2.3/courses/us-1', env, headers);
      const blank = await proxy('/golfapi/v2.3/courses?country=US&name=Other', env, {
        'X-Install-Id': 'id_phone',
        'X-ShotTraxx-Storefront': '',
      });
      for (const response of [detail, blank]) {
        assert.equal(response.status, 429);
        const body = await bodyOf(response);
        assert.equal(body.error, 'golfapi_limited');
        assert.equal(body.message, 'golfapi_limited');
        assert.equal(body.reason, 'storefront');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
      }
      assert.equal(fake.calls.length, 0);
      assert.equal(fake.cache.puts.length, 1);
    } finally {
      fake.restore();
    }
  });

  test('a field build with no storefront header and country=US may search, then read that id', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('/courses?')) {
          return new Response(JSON.stringify({ courses: [{ courseID: 'field-1', clubName: 'Oak' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/coordinates/')) {
          return new Response(JSON.stringify({ coordinates: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courseID: 'field-1', country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      const headers = { 'X-Install-Id': 'id_field_149' };
      const search = await proxy('/golfapi/v2.3/courses?country=US&name=Oak%20Hills', env, headers);
      assert.equal(search.status, 200);
      assert.equal(search.headers.get('X-ShotTraxx-Storefront'), null);
      const detail = await proxy('/golfapi/v2.3/courses/field-1', env, headers);
      const coords = await proxy('/golfapi/v2.3/coordinates/field-1', env, headers);
      assert.equal(detail.status, 200);
      assert.equal(coords.status, 200);
      assert.equal(fake.calls.length, 3);
      const searchRecords = [...fake.kv.store.keys()].filter((key) => key.startsWith('golfapi:us-search:'));
      assert.equal(searchRecords.length, 0);
      assert.equal(fake.kv.listCalls, 0);
      const phoneIds = JSON.parse(fake.counter.sql.map.get('golfapi:us-phone:id_field_149'));
      assert.ok(phoneIds.ids.includes('field-1'));
      assert.equal(fake.kv.store.has('golfapi:us:field-1'), true);
      assert.equal(
        [...fake.kv.store.keys()].filter((key) => key.startsWith('golfapi:us:') && !key.startsWith('golfapi:us-search:')).length,
        1,
      );

      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('must not forward');
      };
      const unknown = await proxy('/golfapi/v2.3/courses/not-yet-known', env, headers);
      const japan = await proxy('/golfapi/v2.3/courses?country=JP&name=Fuji', env, headers);
      assert.equal(unknown.status, 429);
      assert.equal(japan.status, 429);
      assert.match(JSON.stringify(await bodyOf(unknown)), /golfapi_limited/);
      assert.equal(fake.calls.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('a US storefront may pull a course outside the US', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'jp-1', country: 'JP' });
      const response = await proxy(
        '/golfapi/v2.3/courses?country=JP&name=Fuji',
        baseEnv(fake),
        usHeaders('id_phone', 'US'),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-ShotTraxx-Golfapi-Exempt'), '0');
      assert.match(fake.calls[0].url, /country=JP/);
      assert.equal(fake.kv.store.has('golfapi:us:jp-1'), false);
    } finally {
      fake.restore();
    }
  });

  test('the 5th course pull is refused and only that phone is blocked', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        const id = String(input).split('/').pop();
        fake.calls.push(String(input));
        return new Response(JSON.stringify(usableCourse(id)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake);
      for (const id of ['a', 'b', 'c', 'd']) {
        assert.equal((await proxy(`/golfapi/v2.3/courses/${id}`, env, usHeaders('id_a'))).status, 200);
      }
      assert.equal(counterValue(fake, creditKey('id_a', 'pull')), 4);
      const fifth = await proxy('/golfapi/v2.3/courses/e', env, usHeaders('id_a'));
      const fifthBody = await bodyOf(fifth);
      assert.equal(fifth.status, 429);
      assert.equal(fifthBody.error, 'golfapi_limited');
      assert.equal(fifthBody.reason, 'phone_limit');
      assert.equal(fake.calls.length, 4);
      assert.equal((await proxy('/golfapi/v2.3/courses/f', env, usHeaders('id_b'))).status, 200);
      assert.equal(counterValue(fake, creditKey('id_b', 'pull')), 1);
    } finally {
      fake.restore();
    }
  });

  test('app-wide daily and monthly caps count paid calls across installs', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        return new Response(JSON.stringify({ courseID: 'x' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const daily = baseEnv(fake, { GOLFAPI_DAILY_CAP: '4', GOLFAPI_MONTHLY_CAP: '50' });
      assert.equal((await proxy('/golfapi/v2.3/courses/d1', daily, usHeaders('id_a'))).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses/d2', daily, usHeaders('id_b'))).status, 200);
      const dayBlock = await proxy('/golfapi/v2.3/courses/d3', daily, usHeaders('id_c'));
      assert.equal(dayBlock.status, 429);
      const dayBody = await bodyOf(dayBlock);
      assert.equal(dayBody.reason, 'app_daily');
      assert.match(JSON.stringify(dayBody), /golfapi_limited/);
      assert.equal(fake.calls.length, 2);
    } finally {
      fake.restore();
    }
  });

  test('app-wide monthly cap counts paid calls across installs', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        return new Response(JSON.stringify({ courseID: 'm' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const monthly = baseEnv(fake, { GOLFAPI_DAILY_CAP: '50', GOLFAPI_MONTHLY_CAP: '4' });
      assert.equal((await proxy('/golfapi/v2.3/courses/m1', monthly, usHeaders('id_a'))).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses/m2', monthly, usHeaders('id_b'))).status, 200);
      const monthBlock = await proxy('/golfapi/v2.3/courses/m3', monthly, usHeaders('id_c'));
      assert.equal(monthBlock.status, 429);
      assert.equal((await bodyOf(monthBlock)).reason, 'app_monthly');
      assert.equal(fake.calls.length, 2);
    } finally {
      fake.restore();
    }
  });

  test('status is answered here, no-store, and never cached or forwarded', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async () => {
        throw new Error('status must not forward');
      };
      const env = baseEnv(fake, { GOLFAPI_ALLOWLIST: DOC });
      const exempt = await proxy('/golfapi/v2.3/status', env, { 'X-Install-Id': DOC, 'X-ShotTraxx-Storefront': 'USA' });
      const plain = await proxy('/golfapi/v2.3/status', env, { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'USA' });
      assert.deepEqual(await bodyOf(exempt), { exempt: true, dailyPulls: 4 });
      assert.deepEqual(await bodyOf(plain), { exempt: false, dailyPulls: 4 });
      assert.equal(exempt.headers.get('Cache-Control'), 'no-store');
      assert.equal(plain.headers.get('Cache-Control'), 'no-store');
      assert.equal(fake.cache.puts.length, 0);
      assert.equal(fake.kv.puts.length, 0);
      assert.equal(fake.calls.length, 0);
      await proxy('/golfapi/v2.3/status', env, { 'X-Install-Id': DOC });
      assert.equal(fake.cache.puts.length, 0);
      assert.equal(fake.kv.puts.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('the exempt header is added after the lookup and is never stored', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'c1', country: 'US' });
      const env = baseEnv(fake, { GOLFAPI_ALLOWLIST: DOC });
      const exempt = await proxy('/golfapi/v2.3/courses/c1', env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'USA',
      });
      assert.equal(exempt.headers.get('X-ShotTraxx-Golfapi-Exempt'), '1');
      assert.equal(fake.cache.puts.length, 1);
      assert.equal(fake.cache.puts[0].headers['x-shottraxx-golfapi-exempt'], undefined);
      const stored = permanentPuts(fake.kv);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].value.includes('X-ShotTraxx-Golfapi-Exempt'), false);
      assertForever(stored[0]);

      fake.cache.entries.clear();
      globalThis.fetch = async () => {
        throw new Error('second read is a KV hit');
      };
      const again = await proxy('/golfapi/v2.3/courses/c1', env, usHeaders('id_phone', 'US'));
      assert.equal(again.status, 200);
      assert.equal(again.headers.get('X-ShotTraxx-Golfapi-Exempt'), '0');
      assert.equal(stored[0].value.includes('X-ShotTraxx-Golfapi-Exempt'), false);
      assert.equal(fake.cache.puts.length, 1);
    } finally {
      fake.restore();
    }
  });

  test('an upstream miss is not stored and does not spend a credit', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { message: 'not found' }, 404);
      const response = await proxy('/golfapi/v2.3/courses/missing', baseEnv(fake), usHeaders());
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('X-ShotTraxx-Golfapi-Exempt'), '0');
      assert.equal(permanentPuts(fake.kv).length, 0);
      assert.equal(creditPuts(fake.kv).length, 0);
      assert.equal(fake.cache.puts.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('GCA still proxies with its own secret and does not spend a golfapi credit', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input, init) => {
        fake.calls.push({ url: String(input), auth: init.headers.Authorization });
        return new Response(JSON.stringify({ id: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const response = await proxy('/gca/v1/courses/14109', baseEnv(fake), { 'X-Install-Id': 'id_phone' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-ShotTraxx-Golfapi-Exempt'), null);
      assert.equal(fake.calls[0].auth, 'Bearer gca-secret');
      assert.match(fake.calls[0].url, /^https:\/\/golfcoursesapi\.com\/api\/v1\/courses\/14109$/);
      assert.equal(creditPuts(fake.kv).length, 0);
      assert.equal(permanentPuts(fake.kv).length, 0);
      assert.equal((await proxy('/share-code', baseEnv(fake))), null);
    } finally {
      fake.restore();
    }
  });

  test('the credit floor blocks an allowlisted install', async () => {
    const fake = installFakes();
    try {
      await fake.kv.put('gq:balance', JSON.stringify({ left: 50, at: 1, lastStatus: 200 }));
      globalThis.fetch = async () => {
        throw new Error('floor must not fetch');
      };
      const env = baseEnv(fake, {
        GOLFAPI_ALLOWLIST: DOC,
        GOLFAPI_DAILY_CAP: '0',
        GOLFAPI_MONTHLY_CAP: '0',
        GOLFAPI_CREDIT_FLOOR: '50',
      });
      const response = await proxy('/golfapi/v2.3/courses/anywhere', env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'GBR',
      });
      assert.equal(response.status, 429);
      const body = await bodyOf(response);
      assert.equal(body.error, 'golfapi_limited');
      assert.equal(body.message, 'golfapi_limited');
      assert.equal(body.reason, 'floor');
      assert.equal(fake.calls.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('the credit floor blocks a US-storefront install', async () => {
    const fake = installFakes();
    try {
      await fake.kv.put('gq:balance', JSON.stringify({ left: 49, at: 1, lastStatus: 200 }));
      globalThis.fetch = async () => {
        throw new Error('floor must not fetch');
      };
      const response = await proxy('/golfapi/v2.3/courses/c1', baseEnv(fake), usHeaders());
      assert.equal(response.status, 429);
      const body = await bodyOf(response);
      assert.equal(body.error, 'golfapi_limited');
      assert.equal(body.reason, 'floor');
      assert.equal(fake.calls.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('an unknown golfapi balance allows the paid call', async () => {
    const fake = installFakes();
    try {
      assert.equal(await fake.kv.get('gq:balance'), null);
      golfJson(fake, { courseID: 'c1', country: 'US', apiRequestsLeft: 400 });
      const response = await proxy('/golfapi/v2.3/courses/c1', baseEnv(fake), usHeaders());
      assert.equal(response.status, 200);
      assert.equal(fake.calls.length, 1);
    } finally {
      fake.restore();
    }
  });

  test('a cached hit is served when the balance is at the floor', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'c1', country: 'US', clubName: 'Pebble', apiRequestsLeft: 200 });
      const env = baseEnv(fake);
      const first = await proxy('/golfapi/v2.3/courses/c1', env, usHeaders());
      assert.equal(first.status, 200);
      assert.equal(fake.calls.length, 1);

      await fake.kv.put('gq:balance', JSON.stringify({ left: 50, at: 1, lastStatus: 200 }));
      globalThis.fetch = async () => {
        throw new Error('cached hit must not fetch');
      };
      const fromKv = await proxy('/golfapi/v2.3/courses/c1', env, usHeaders('id_other', 'US'));
      assert.equal(fromKv.status, 200);
      assert.equal((await bodyOf(fromKv)).courseID, 'c1');

      fake.kv.store.delete('golfapi:permanent:course:c1');
      const fromEdge = await proxy('/golfapi/v2.3/courses/c1', env, usHeaders('id_third', 'USA'));
      assert.equal(fromEdge.status, 200);
      assert.equal((await bodyOf(fromEdge)).courseID, 'c1');
      assert.equal(fake.calls.length, 1);
    } finally {
      fake.restore();
    }
  });

  test('stored=1 serves KV and does not call golfapi on a miss', async () => {
    const fake = installFakes();
    try {
      await fake.kv.put(
        'golfapi:permanent:course:c1',
        JSON.stringify({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ courseID: 'c1', clubName: 'Stored' }),
        }),
      );
      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        throw new Error('stored hit must not fetch');
      };
      const hit = await proxy('/golfapi/v2.3/courses/c1?stored=1', baseEnv(fake), usHeaders());
      assert.equal(hit.status, 200);
      assert.equal((await bodyOf(hit)).courseID, 'c1');
      assert.equal(fake.calls.some((url) => String(url).includes('golfapi.io')), false);

      fake.kv.store.delete('golfapi:permanent:course:c1');
      fake.calls.length = 0;
      const missed = await proxy('/golfapi/v2.3/courses/c1?stored=1', baseEnv(fake), usHeaders());
      assert.equal(missed.status, 404);
      assert.equal((await bodyOf(missed)).error, 'not_stored');
      assert.equal(fake.calls.some((url) => String(url).includes('golfapi.io')), false);
    } finally {
      fake.restore();
    }
  });

  test('the last-seen balance updates from a golfapi reply', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'c1', country: 'US', apiRequestsLeft: '80' });
      const response = await proxy('/golfapi/v2.3/courses/c1', baseEnv(fake), usHeaders());
      assert.equal(response.status, 200);
      const stored = JSON.parse(fake.kv.store.get('gq:balance').value);
      assert.equal(stored.left, 80);
      assert.equal(stored.lastStatus, 200);
      assert.equal(typeof stored.at, 'number');
      const put = fake.kv.puts.find((row) => row.key === 'gq:balance');
      assert.equal(put.options, null);

      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        return new Response(JSON.stringify({ courseID: 'c2', country: 'US' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Requests-Left': '61',
          },
        });
      };
      const second = await proxy('/golfapi/v2.3/courses/c2', baseEnv(fake), usHeaders());
      assert.equal(second.status, 200);
      assert.equal(JSON.parse(fake.kv.store.get('gq:balance').value).left, 61);
    } finally {
      fake.restore();
    }
  });

  test('a phone at 18, 19, or 20 calls is refused before any paid call, and 17 completes the open', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'open-1', country: 'US' });
      const env = baseEnv(fake);
      for (const [install, n] of [['id_18', 18], ['id_19', 19], ['id_20', 20]]) {
        seedCredits(fake, install, n);
        const response = await proxy('/golfapi/v2.3/courses/open-1', env, usHeaders(install));
        const payload = await bodyOf(response);
        assert.equal(response.status, 429);
        assert.equal(payload.error, 'golfapi_limited');
        assert.equal(payload.message, 'golfapi_limited');
        assert.equal(payload.reason, 'phone_limit');
        assert.equal(payload.error.includes('20'), false);
        assert.equal(payload.message.includes('backstop'), false);
        assert.equal(typeof payload.retryAfterSec, 'number');
        assert.equal(counterValue(fake, creditKey(install, 'install')), n);
      }
      assert.equal(fake.calls.length, 0);

      seedCredits(fake, 'id_17', 17);
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('/courses?')) {
          return new Response(JSON.stringify({ courses: [{ courseID: 'open-1', country: 'US' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/coordinates/')) {
          return new Response(JSON.stringify({ coordinates: [{ hole: 1 }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courseID: 'open-1', country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const headers = usHeaders('id_17');
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=Open', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses/open-1', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/coordinates/open-1', env, headers)).status, 200);
      assert.equal(fake.calls.length, 3);
      assert.equal(counterValue(fake, creditKey('id_17', 'install')), 19.1);
      assert.equal(counterValue(fake, creditKey('id_17', 'day')), 19.1);
      assert.equal(counterValue(fake, creditKey('id_17', 'month')), 19.1);
      assert.equal(counterValue(fake, creditKey('id_17', 'pull')), 0);

      const seedOpen = (install, courseId) => {
        fake.counter.sql.map.set(`golfapi:open:${install}:${courseId}`, JSON.stringify({
          at: Date.now(),
          courseId,
          calls: 2,
          held: 2,
          spent: 2,
          installKey: creditKey(install, 'install'),
          dayKey: creditKey(install, 'day'),
          monthKey: creditKey(install, 'month'),
        }));
      };
      seedCredits(fake, 'id_mid19', 19);
      seedOpen('id_mid19', 'mid-1');
      golfJson(fake, { courseID: 'mid-1', country: 'US' });
      const before = fake.calls.length;
      assert.equal((await proxy('/golfapi/v2.3/courses/mid-1', env, usHeaders('id_mid19'))).status, 200);
      assert.equal(counterValue(fake, creditKey('id_mid19', 'install')), 20);
      assert.equal(counterValue(fake, creditKey('id_mid19', 'day')), 20);
      assert.equal(counterValue(fake, creditKey('id_mid19', 'month')), 20);
      globalThis.fetch = async () => {
        throw new Error('a full backstop must not fetch');
      };
      const past = await proxy('/golfapi/v2.3/coordinates/mid-1', env, usHeaders('id_mid19'));
      const pastBody = await bodyOf(past);
      assert.equal(past.status, 429);
      assert.equal(pastBody.reason, 'phone_limit');
      assert.equal(pastBody.error, 'golfapi_limited');
      assert.equal(counterValue(fake, creditKey('id_mid19', 'install')), 20);
      assert.equal(fake.calls.length, before + 1);

      seedCredits(fake, 'id_mid20', 20);
      seedOpen('id_mid20', 'mid-2');
      const full = await proxy('/golfapi/v2.3/courses/mid-2', env, usHeaders('id_mid20'));
      assert.equal(full.status, 429);
      assert.equal((await bodyOf(full)).reason, 'phone_limit');
      assert.equal(counterValue(fake, creditKey('id_mid20', 'install')), 20);
      assert.equal(fake.calls.length, before + 1);
    } finally {
      fake.restore();
    }
  });

  test('concurrent opens never exceed a cap', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async (input) => {
        fake.calls.push(String(input));
        const id = String(input).split('/').pop();
        return new Response(JSON.stringify({ courseID: id, country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake, {
        GOLFAPI_DAILY_CAP: '6',
        GOLFAPI_MONTHLY_CAP: '6',
      });
      const responses = await Promise.all(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => proxy(`/golfapi/v2.3/courses/${id}`, env, usHeaders('id_race'))),
      );
      const ok = responses.filter((response) => response.status === 200);
      assert.equal(ok.length, 4);
      assert.equal(responses.filter((response) => response.status === 429).length, 2);
      assert.equal(counterValue(fake, creditKey('id_race', 'install')), 4);
      assert.equal(counterValue(fake, creditKey('id_race', 'day')), 4);
      assert.equal(counterValue(fake, creditKey('id_race', 'month')), 4);
      assert.equal(fake.calls.length, 4);
    } finally {
      fake.restore();
    }
  });

  test('a new open charges 1 after room for 3, a failure refunds 1, and a stored copy charges 0', async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake);
      const pair = usHeaders('id_pair');
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('/courses?')) {
          return new Response(JSON.stringify({ courses: [{ courseID: 'pair-1', clubName: 'Pair', country: 'US' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courseID: 'pair-1', clubName: 'Pair', country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=Pair', env, pair)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses/pair-1', env, pair)).status, 200);
      assert.equal(counterValue(fake, creditKey('id_pair', 'install')), 1.1);
      assert.equal(counterValue(fake, creditKey('id_pair', 'day')), 1.1);
      assert.equal(counterValue(fake, creditKey('id_pair', 'month')), 1.1);
      fake.counter.sql.map.delete(creditKey('id_pair', 'day'));
      fake.counter.sql.map.delete(creditKey('id_pair', 'month'));

      const full = usHeaders('id_full');
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=Full', env, full)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses/full-1', env, full)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/coordinates/full-1', env, full)).status, 200);
      assert.equal(counterValue(fake, creditKey('id_full', 'install')), 2.1);
      assert.equal(counterValue(fake, creditKey('id_full', 'day')), 2.1);
      assert.equal(counterValue(fake, creditKey('id_full', 'month')), 2.1);
      fake.counter.sql.map.delete(creditKey('id_full', 'day'));
      fake.counter.sql.map.delete(creditKey('id_full', 'month'));

      golfJson(fake, { message: 'missing' }, 404);
      const putsBeforeMiss = permanentPuts(fake.kv).length;
      const missed = await proxy('/golfapi/v2.3/courses/missing', env, usHeaders('id_fail'));
      assert.equal(missed.status, 404);
      assert.equal(counterValue(fake, creditKey('id_fail', 'install')), 0);
      assert.equal(counterValue(fake, creditKey('id_fail', 'day')), 0);
      assert.equal(counterValue(fake, creditKey('id_fail', 'month')), 0);
      assert.equal(permanentPuts(fake.kv).length, putsBeforeMiss);

      golfJson(fake, { courseID: 'c1', country: 'US' });
      assert.equal((await proxy('/golfapi/v2.3/courses/c1', env, usHeaders('id_hit'))).status, 200);
      assert.equal(counterValue(fake, creditKey('id_hit', 'install')), 1);
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('cache hit must not fetch');
      };
      const cached = await proxy('/golfapi/v2.3/courses/c1', env, usHeaders('id_hit'));
      assert.equal(cached.status, 200);
      assert.equal(fake.calls.length, 0);
      assert.equal(counterValue(fake, creditKey('id_hit', 'install')), 1);
      assert.equal(counterValue(fake, creditKey('id_hit', 'day')), 1);

      golfJson(fake, { courseID: 'c2', country: 'US' });
      assert.equal((await proxy('/golfapi/v2.3/courses/c2', env, usHeaders('id_part'))).status, 200);
      assert.equal(counterValue(fake, creditKey('id_part', 'install')), 1);
      golfJson(fake, { message: 'no coordinates' }, 404);
      const failedNext = await proxy('/golfapi/v2.3/coordinates/c2', env, usHeaders('id_part'));
      assert.equal(failedNext.status, 404);
      assert.equal(counterValue(fake, creditKey('id_part', 'install')), 1);
      assert.equal(counterValue(fake, creditKey('id_part', 'day')), 2);
    } finally {
      fake.restore();
    }
  });

  test('a stored course is served to a non-US storefront and to a build with no header', async () => {
    const fake = installFakes();
    try {
      golfJson(fake, { courseID: 'jp-9', country: 'JP' });
      const env = baseEnv(fake);
      assert.equal((await proxy('/golfapi/v2.3/courses/jp-9', env, usHeaders())).status, 200);
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('stored copy must not fetch');
      };
      const abroad = await proxy('/golfapi/v2.3/courses/jp-9', env, usHeaders('id_gb', 'GBR'));
      assert.equal(abroad.status, 200);
      assert.equal((await bodyOf(abroad)).courseID, 'jp-9');
      const field = await proxy('/golfapi/v2.3/courses/jp-9', env, { 'X-Install-Id': 'id_149' });
      assert.equal(field.status, 200);
      assert.equal((await bodyOf(field)).courseID, 'jp-9');
      assert.equal(fake.calls.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('a 150-credit day plus 54 terrain samples stays under 1000 KV writes', async () => {
    const fake = installFakes();
    fake.counter = new FakeCounterNamespace({ TERRAIN_KV: fake.terrain });
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('nationalmap')) {
          const params = new URLSearchParams(new Request(url).method ? undefined : undefined);
          void params;
          const body = fake._usgsBody;
          const geometry = JSON.parse(new URLSearchParams(body).get('geometry') || '{"points":[]}');
          return new Response(
            JSON.stringify({
              samples: Array.from({ length: geometry.points.length }, (_, index) => ({ locationId: index, value: 1 })),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const id = url.split('/').pop().split('?')[0];
        if (url.includes('/courses?')) {
          return new Response(JSON.stringify({ courses: [{ courseID: id, country: 'US' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courseID: id, country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        fake._usgsBody = init && typeof init.body === 'string' ? init.body : '';
        return realFetch(input, init);
      };
      const env = baseEnv(fake, {
        GOLFAPI_DAILY_CAP: '150',
        GOLFAPI_MONTHLY_CAP: '450',
      });
      fake.kv.puts.length = 0;
      for (let n = 0; n < 50; n += 1) {
        const headers = usHeaders(`id_day_${n}`);
        const name = `Course${n}`;
        assert.equal((await proxy(`/golfapi/v2.3/courses?country=US&name=${name}`, env, headers)).status, 200);
        assert.equal((await proxy(`/golfapi/v2.3/courses/day-${n}`, env, headers)).status, 200);
        assert.equal((await proxy(`/golfapi/v2.3/coordinates/day-${n}`, env, headers)).status, 200);
      }
      const golfWrites = fake.kv.puts.length;
      assert.ok(golfWrites < 1000, `golfapi writes ${golfWrites}`);
      assert.equal(fake.kv.puts.filter((put) => put.key.startsWith('golfapi:credit:')).length, 0);
      const perOpen = golfWrites / 50;
      assert.ok(perOpen < 20, `writes per open ${perOpen}`);

      usgsMock(fake);
      fake.terrain.puts.length = 0;
      for (let n = 0; n < 54; n += 1) {
        const course = `t${Math.floor(n / 18)}`;
        const hole = (n % 18) + 1;
        const response = await proxy(`/terrain/v1/${course}/${hole}?${terrainQuery()}`, env, usHeaders('id_terrain'));
        assert.equal(response.status, 200, `sample ${n}`);
      }
      const blobs = fake.terrain.puts.filter((put) => put.key.startsWith('terrain:v1:'));
      const samples = fake.terrain.puts.filter((put) => put.key.startsWith('terrain:samples:'));
      assert.equal(blobs.length, 54);
      for (const put of blobs) assertForever(put);
      assert.equal(samples.length, 54);
      for (const put of samples) assert.deepEqual(put.options, { expirationTtl: 172800 });
      assert.equal(fake.terrain.puts.length, blobs.length + samples.length);
      assert.equal(fake.kv.puts.filter((put) => put.key.startsWith('terrain:')).length, 0);
      assert.ok(golfWrites + fake.terrain.puts.length < 1000);
      const blocked = await proxy(`/terrain/v1/extra/1?${terrainQuery()}`, env, usHeaders('id_terrain'));
      assert.equal(blocked.status, 429);
    } finally {
      fake.restore();
    }
  });

  test('pinsFromUrl and the 6-decimal pin hash are exported', async () => {
    const url = new URL(
      'https://share.test/terrain/v1/pebble/1?teeLat=34.74&teeLng=-92.28&frontLat=34.74008&frontLng=-92.28&centerLat=34.74012&centerLng=-92.28&backLat=34.74016&backLng=-92.28',
    );
    const pins = pinsFromUrl(url);
    assert.equal(pins.tee.lat, 34.74);
    assert.equal(pins.front.lng, -92.28);
    assert.equal(pins.center.lat, 34.74012);
    assert.equal(pins.back.lat, 34.74016);
    const key = terrainPinKey(pins);
    assert.equal(key.split('|').length, 4);
    assert.match(key, /34\.740000,-92\.280000\|/);
    const hash = await terrainPinHash(pins);
    assert.equal(hash.length, 64);
  });

  test('header names in the module match the app contract', () => {
    const src = readFileSync(new URL('./golf-proxy.js', import.meta.url), 'utf8');
    assert.match(src, /X-Install-Id/);
    assert.match(src, /X-ShotTraxx-Storefront/);
    assert.match(src, /X-ShotTraxx-Golfapi-Exempt/);
    assert.match(src, /The app flag only decides whether the phone asks/);
    assert.match(src, /kept out of every cache/);
    assert.match(src, /Those caps stay authoritative/);
    assert.match(src, /const DEFAULT_INSTALL_PULLS = 4/);
    assert.match(src, /const DEFAULT_CALL_BACKSTOP = 20/);
    assert.doesNotMatch(src, /GOLFAPI_INSTALL_DAILY_CAP/);
    assert.match(src, /const DEFAULT_APP_DAILY = 150/);
    assert.match(src, /const DEFAULT_PLAN_MONTHLY = 500/);
    assert.match(src, /const DEFAULT_CYCLE_DAY = 5/);
    assert.match(src, /GOLFAPI_PLAN_MONTHLY=2000/);
    assert.match(src, /const DEFAULT_APP_MONTHLY = 450/);
    assert.match(src, /const DEFAULT_TERRAIN_DAILY = 54/);
    assert.match(src, /export const MAX_GRID_POINTS = 6000/);
    assert.match(src, /const DEFAULT_CREDIT_FLOOR = 50/);
    assert.match(src, /GOLFAPI_DAILY_CAP=300/);
    assert.match(src, /GOLFAPI_MONTHLY_CAP=1800/);
    assert.match(src, /GOLFAPI_CREDIT_FLOOR/);
  });

  test('a stored copy, a failure, and a course with no map do not count as pulls', async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake);
      golfJson(fake, usableCourse('kept', 'Kept Hills'));
      assert.equal((await proxy('/golfapi/v2.3/courses/kept', env, usHeaders('id_keep'))).status, 200);
      assert.equal(counterValue(fake, creditKey('id_keep', 'pull')), 1);
      fake.calls.length = 0;
      globalThis.fetch = async () => {
        throw new Error('stored copy must not fetch');
      };
      assert.equal((await proxy('/golfapi/v2.3/courses/kept', env, usHeaders('id_keep'))).status, 200);
      assert.equal(fake.calls.length, 0);
      assert.equal(counterValue(fake, creditKey('id_keep', 'pull')), 1);

      golfJson(fake, { message: 'missing' }, 404);
      assert.equal((await proxy('/golfapi/v2.3/courses/miss', env, usHeaders('id_miss'))).status, 404);
      assert.equal(counterValue(fake, creditKey('id_miss', 'pull')), 0);
      assert.equal(counterValue(fake, creditKey('id_miss', 'install')), 0);

      golfJson(fake, { courseID: 'blank', clubName: 'Blank Hills', country: 'US' });
      const thin = await proxy('/golfapi/v2.3/courses/blank?name=TYPEDQUERY', env, usHeaders('id_blank'));
      assert.equal(thin.status, 200);
      assert.equal(counterValue(fake, creditKey('id_blank', 'pull')), 0);
      const demand = await counterOp(fake, { op: 'readDemand', cycleId: golfapiCycleId(new Date(), 5) });
      assert.equal(demand.no_data.some((row) => row.courseId === 'blank'), false);
      const known = JSON.parse(fake.counter.sql.map.get('golfapi:known:blank'));
      assert.equal(known.name, 'Blank Hills');
      const stored = [...fake.counter.sql.map.entries()]
        .filter(([key]) => key.startsWith('golfapi:demand:') || key.startsWith('golfapi:known:'))
        .map(([, value]) => value)
        .join('\n');
      assert.equal(stored.includes('TYPEDQUERY'), false);
      assert.equal(stored.includes('id_blank'), false);
    } finally {
      fake.restore();
    }
  });

  test('no_data is logged only for coordinates with no tee and green', async () => {
    const fake = installFakes();
    try {
      const env = baseEnv(fake);
      const cycleId = golfapiCycleId(new Date(), 5);
      const headers = usHeaders('id_nodata');
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('/courses?')) {
          return new Response(JSON.stringify({
            courses: [{ courseID: 'search-1', clubName: 'Search Hills', country: 'US' }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/courses/detail-9')) {
          return new Response(JSON.stringify({ courseID: 'detail-9', clubName: 'Detail Hills', country: 'US' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/coordinates/empty-9')) {
          return new Response(JSON.stringify({ coordinates: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/coordinates/mapped-9')) {
          return new Response(JSON.stringify(usableCourse('mapped-9', 'Mapped Hills')), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      };
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=Search', env, headers)).status, 200);
      let listed = await counterOp(fake, { op: 'readDemand', cycleId });
      assert.deepEqual(listed.no_data, []);
      assert.deepEqual(listed.pull_candidates, []);
      assert.equal(JSON.parse(fake.counter.sql.map.get('golfapi:known:search-1')).name, 'Search Hills');

      assert.equal((await proxy('/golfapi/v2.3/courses/detail-9', env, headers)).status, 200);
      listed = await counterOp(fake, { op: 'readDemand', cycleId });
      assert.deepEqual(listed.no_data, []);
      assert.equal(JSON.parse(fake.counter.sql.map.get('golfapi:known:detail-9')).name, 'Detail Hills');

      assert.equal((await proxy('/golfapi/v2.3/coordinates/empty-9', env, headers)).status, 200);
      listed = await counterOp(fake, { op: 'readDemand', cycleId });
      assert.equal(listed.no_data.length, 1);
      assert.equal(listed.no_data[0].courseId, 'empty-9');
      assert.equal(listed.no_data[0].count, 1);

      assert.equal((await proxy('/golfapi/v2.3/coordinates/mapped-9', env, headers)).status, 200);
      listed = await counterOp(fake, { op: 'readDemand', cycleId });
      assert.equal(listed.no_data.length, 1);
      assert.equal(listed.no_data.some((row) => row.courseId === 'mapped-9'), false);
      assert.equal(counterValue(fake, creditKey('id_nodata', 'pull')), 1);
    } finally {
      fake.restore();
    }
  });

  test('a no-header course check does not list KV, even with 1001 search records', async () => {
    const fake = installFakes();
    try {
      for (let n = 0; n < 1001; n += 1) {
        const ids = n === 500 ? ['hidden-id'] : [`other-${n}`];
        fake.kv.store.set(`golfapi:us-search:${n}`, { value: JSON.stringify({ ids }), options: null });
      }
      golfJson(fake, usableCourse('shown-id', 'Shown'));
      const env = baseEnv(fake);
      const headers = { 'X-Install-Id': 'id_field' };
      const hidden = await proxy('/golfapi/v2.3/courses/hidden-id', env, headers);
      assert.equal(hidden.status, 429);
      assert.equal(fake.kv.listCalls, 0);
      assert.equal(fake.calls.length, 0);

      await counterOp(fake, {
        op: 'rememberPhoneIds',
        install: 'id_field',
        ids: ['shown-id'],
        now: Date.now(),
      });
      const shown = await proxy('/golfapi/v2.3/courses/shown-id', env, headers);
      assert.equal(shown.status, 200);
      assert.equal(fake.kv.listCalls, 0);

      fake.kv.store.set('golfapi:us:flagged', { value: '1', options: null });
      golfJson(fake, usableCourse('flagged', 'Flagged'));
      const flagged = await proxy('/golfapi/v2.3/courses/flagged', env, { 'X-Install-Id': 'id_other_field' });
      assert.equal(flagged.status, 200);
      assert.equal(fake.kv.listCalls, 0);

      await counterOp(fake, {
        op: 'rememberPhoneIds',
        install: 'id_stale',
        ids: ['stale-1'],
        now: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
      globalThis.fetch = async () => {
        throw new Error('expired phone ids must not fetch');
      };
      const stale = await proxy('/golfapi/v2.3/courses/stale-1', env, { 'X-Install-Id': 'id_stale' });
      assert.equal(stale.status, 429);
      assert.equal(fake.kv.listCalls, 0);

      const many = Array.from({ length: 201 }, (_, n) => `cap-${n}`);
      const remembered = await counterOp(fake, {
        op: 'rememberPhoneIds',
        install: 'id_cap',
        ids: many,
        now: Date.now(),
      });
      assert.equal(remembered.count, 200);
      const saved = JSON.parse(fake.counter.sql.map.get('golfapi:us-phone:id_cap'));
      assert.equal(saved.ids.includes('cap-0'), true);
      assert.equal(saved.ids.includes('cap-200'), false);
    } finally {
      fake.restore();
    }
  });

  test('demand log splits reasons, drops the typed query, and requires the admin token', async () => {
    const fake = installFakes();
    try {
      const install = 'id_demand_phone_9f3a';
      globalThis.fetch = async (input) => {
        const url = String(input);
        fake.calls.push(url);
        if (url.includes('ZZTOPSECRET')) {
          return new Response(JSON.stringify({
            courses: [{ courseID: 'pebble-1', clubName: 'Pebble Beach', country: 'US' }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('QQQUERYPHONE')) {
          return new Response(JSON.stringify({
            courses: [{ courseID: 'phone-2', clubName: 'Phone Course', country: 'US' }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('ALSOSECRET')) {
          return new Response(JSON.stringify({ courses: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/coordinates/')) {
          return new Response(JSON.stringify({ coordinates: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/courses/detail-1')) {
          return new Response(JSON.stringify({ courseID: 'detail-1', clubName: 'Detail Only', country: 'US' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ courseID: 'x', country: 'US' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake, { ALERT_ADMIN_TOKEN: 'secret-token' });
      const headers = usHeaders(install);
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=ZZTOPSECRET', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=QQQUERYPHONE', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/courses?country=US&name=ALSOSECRET', env, headers)).status, 200);
      const cycleId = golfapiCycleId(new Date(), 5);
      const afterSearch = await counterOp(fake, { op: 'readDemand', cycleId });
      assert.deepEqual(afterSearch.pull_candidates, []);
      assert.deepEqual(afterSearch.no_data, []);
      assert.equal((await proxy('/golfapi/v2.3/courses/detail-1', env, headers)).status, 200);
      const afterDetail = await counterOp(fake, { op: 'readDemand', cycleId });
      assert.deepEqual(afterDetail.no_data, []);
      assert.equal(afterDetail.pull_candidates.some((row) => row.courseId === 'detail-1'), false);
      assert.equal((await proxy('/golfapi/v2.3/coordinates/pebble-1', env, headers)).status, 200);
      assert.equal((await proxy('/golfapi/v2.3/coordinates/phone-2', env, headers)).status, 200);

      const abroad = await proxy('/golfapi/v2.3/courses/pebble-1', env, {
        'X-Install-Id': install,
        'X-ShotTraxx-Storefront': 'GBR',
      });
      assert.equal(abroad.status, 429);
      assert.equal((await bodyOf(abroad)).reason, 'storefront');

      env.GOLFAPI_DAILY_CAP = '0';
      const capped = await proxy('/golfapi/v2.3/courses/pebble-1', env, headers);
      assert.equal(capped.status, 429);
      assert.equal((await bodyOf(capped)).reason, 'app_daily');
      env.GOLFAPI_DAILY_CAP = '150';

      for (const [key, value] of fake.counter.sql.map.entries()) {
        if (!key.startsWith('golfapi:open:')) continue;
        const open = JSON.parse(value);
        open.at = Date.now() - 20 * 60 * 1000;
        fake.counter.sql.map.set(key, JSON.stringify(open));
      }
      fake.counter.sql.map.set(creditKey(install, 'pull'), '4');
      const limited = await proxy('/golfapi/v2.3/courses/phone-2', env, headers);
      assert.equal(limited.status, 429);
      assert.equal((await bodyOf(limited)).reason, 'phone_limit');

      await fake.kv.put('gq:balance', JSON.stringify({ left: 40, at: 1, lastStatus: 200 }));
      const floored = await proxy('/golfapi/v2.3/courses/phone-2', env, headers);
      assert.equal(floored.status, 429);
      assert.equal((await bodyOf(floored)).reason, 'floor');

      const bad = await proxy('/admin/demand', env, { 'X-Admin-Token': 'nope' });
      assert.equal(bad.status, 401);
      const missing = await proxy('/admin/demand', env, {});
      assert.equal(missing.status, 401);
      globalThis.fetch = async () => {
        throw new Error('demand admin must not call golfapi');
      };
      const ok = await proxy('/admin/demand', env, { 'X-Admin-Token': 'secret-token' });
      assert.equal(ok.status, 200);
      const listed = await bodyOf(ok);
      const pebble = listed.pull_candidates.find((row) => row.courseId === 'pebble-1');
      const phone = listed.pull_candidates.find((row) => row.courseId === 'phone-2');
      assert.ok(pebble);
      assert.equal(pebble.name, 'Pebble Beach');
      assert.equal(pebble.country, 'US');
      assert.ok(pebble.count >= 2);
      assert.ok(pebble.reasons.includes('non_us'));
      assert.ok(pebble.reasons.includes('app_cap'));
      assert.equal(pebble.reasons.includes('no_data'), false);
      assert.ok(phone);
      assert.equal(phone.name, 'Phone Course');
      assert.ok(phone.reasons.includes('phone_limit'));
      assert.ok(phone.reasons.includes('app_cap'));
      assert.ok(listed.pull_candidates[0].count >= listed.pull_candidates[1].count);
      const pebbleBlank = listed.no_data.filter((row) => row.courseId === 'pebble-1');
      const phoneBlank = listed.no_data.filter((row) => row.courseId === 'phone-2');
      assert.equal(pebbleBlank.length, 1);
      assert.equal(pebbleBlank[0].name, 'Pebble Beach');
      assert.equal(pebbleBlank[0].count, 1);
      assert.equal(phoneBlank.length, 1);
      assert.equal(phoneBlank[0].count, 1);
      assert.equal(listed.no_data.some((row) => row.courseId === 'detail-1'), false);
      assert.equal(listed.no_data.some((row) => row.courseId === 'never-logged'), false);
      const dumped = JSON.stringify(listed);
      assert.equal(dumped.includes('ZZTOPSECRET'), false);
      assert.equal(dumped.includes('QQQUERYPHONE'), false);
      assert.equal(dumped.includes('ALSOSECRET'), false);
      assert.equal(dumped.includes(install), false);
      const raw = [...fake.counter.sql.map.entries()]
        .filter(([key]) => key.startsWith('golfapi:demand:') || key.startsWith('golfapi:known:'))
        .map(([, value]) => value)
        .join('\n');
      assert.equal(raw.includes('ZZTOPSECRET'), false);
      assert.equal(raw.includes('QQQUERYPHONE'), false);
      assert.equal(raw.includes('ALSOSECRET'), false);
      assert.equal(raw.includes(install), false);

      const nextCycle = await counterOp(fake, { op: 'readDemand', cycleId: '2026-11-05' });
      assert.deepEqual(nextCycle.pull_candidates, []);
      assert.deepEqual(nextCycle.no_data, []);

      const post = await proxy('/admin/demand', env, { 'X-Admin-Token': 'secret-token' }, 'POST');
      assert.equal(post.status, 405);
    } finally {
      fake.restore();
    }
  });

  test('the demand log keeps the top 500 rows for the billing cycle', async () => {
    const fake = installFakes();
    try {
      const cycleId = '2026-10-05';
      for (let n = 0; n < 501; n += 1) {
        await counterOp(fake, {
          op: 'noteDemand',
          cycleId,
          day: '2026-10-09',
          reason: 'no_data',
          courseId: `row-${n}`,
          name: `Course ${n}`,
          country: 'US',
        });
      }
      const rows = JSON.parse(fake.counter.sql.map.get(`golfapi:demand:${cycleId}`));
      assert.equal(rows.length, 500);
    } finally {
      fake.restore();
    }
  });
});

function terrainQuery(overrides = {}) {
  const pins = {
    teeLat: '34.74',
    teeLng: '-92.28',
    frontLat: '34.74008',
    frontLng: '-92.28',
    centerLat: '34.74012',
    centerLng: '-92.28',
    backLat: '34.74016',
    backLng: '-92.28',
    ...overrides,
  };
  return new URLSearchParams(pins).toString();
}

function usgsMock(fake, gate) {
  const state = { batches: 0, started: null };
  let resolveStarted;
  state.started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('/arcgis/rest/services/3DEPElevation/')) {
      throw new Error(`unexpected fetch ${url}`);
    }
    assert.equal(init.method, 'POST');
    const params = new URLSearchParams(init.body);
    const geometry = JSON.parse(params.get('geometry'));
    const n = geometry.points.length;
    state.batches += 1;
    fake.calls.push(url);
    if (gate && state.batches === 1) {
      resolveStarted();
      await gate.promise;
    }
    return new Response(
      JSON.stringify({
        samples: Array.from({ length: n }, (_, index) => ({ locationId: index, value: 10 })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return state;
}

describe('terrain route', { concurrency: 1 }, () => {
  test('a non-US box is 404 and is not sampled', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async () => {
        throw new Error('must not sample');
      };
      const scotland = terrainQuery({
        teeLat: '56.34',
        teeLng: '-2.802',
        frontLat: '56.34008',
        frontLng: '-2.802',
        centerLat: '56.34012',
        centerLng: '-2.802',
        backLat: '56.34016',
        backLng: '-2.802',
      });
      const response = await proxy(`/terrain/v1/st-andrews/1?${scotland}`, baseEnv(fake), usHeaders());
      assert.equal(response.status, 404);
      assert.equal((await bodyOf(response)).error, 'terrain_unavailable');
      assert.equal(fake.calls.length, 0);
      assert.equal(fake.terrain.puts.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('an oversize box is refused before any USGS call', async () => {
    const fake = installFakes();
    try {
      globalThis.fetch = async () => {
        throw new Error('must not sample');
      };
      const wide = terrainQuery({
        teeLat: '36',
        teeLng: '-95',
        frontLat: '36.01',
        frontLng: '-94.98',
        centerLat: '36.02',
        centerLng: '-94.97',
        backLat: '36.025',
        backLng: '-94.965',
      });
      const pins = pinsFromUrl(new URL(`https://share.test/terrain/v1/wide/1?${wide}`));
      assert.equal(buildTerrainGrid(holeCorridor(pins)), null);
      const response = await proxy(`/terrain/v1/wide/1?${wide}`, baseEnv(fake), usHeaders());
      assert.equal(response.status, 400);
      assert.equal((await bodyOf(response)).error, 'terrain_too_large');
      assert.equal(fake.calls.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('a new sample counts toward the per-install daily limit and a stored copy is free', async () => {
    const fake = installFakes();
    try {
      const state = usgsMock(fake);
      const env = baseEnv(fake, { TERRAIN_INSTALL_DAILY_CAP: '1' });
      const first = await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders('id_a'));
      assert.equal(first.status, 200);
      assert.match(first.headers.get('Cache-Control'), /max-age=31536000/);
      const blob = await bodyOf(first);
      assert.equal(blob.stepM, 10);
      assert.equal(blob.heightsFt.length, blob.cols * blob.rows);
      assert.equal(blob.originLng, blob.originLon);
      assert.ok(Math.abs(blob.heightsFt[0] - 10 * FEET_PER_METER) < 1e-6);
      assert.ok(Math.abs(blob.greenCenterFt - 10 * FEET_PER_METER) < 1e-6);
      assert.equal(typeof blob.greenFrontFt, 'number');
      assert.equal(typeof blob.greenBackFt, 'number');
      const batches = state.batches;
      assert.ok(batches >= 1);

      const secondHole = await proxy(`/terrain/v1/pebble/2?${terrainQuery()}`, env, usHeaders('id_a'));
      assert.equal(secondHole.status, 429);
      assert.equal((await bodyOf(secondHole)).error, 'terrain_limited');
      assert.equal(state.batches, batches);

      globalThis.fetch = async () => {
        throw new Error('stored copy must not sample');
      };
      const again = await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders('id_a'));
      assert.equal(again.status, 200);
      assert.equal((await bodyOf(again)).pinHash, blob.pinHash);
      const terrainBlobs = fake.terrain.puts.filter((put) => put.key.startsWith('terrain:v1:'));
      assert.equal(terrainBlobs.length, 1);
      assertForever(terrainBlobs[0]);
    } finally {
      fake.restore();
    }
  });

  test('a re-pin is a new key and the old copy stays stored', async () => {
    const fake = installFakes();
    try {
      usgsMock(fake);
      const env = baseEnv(fake);
      const first = await bodyOf(await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders()));
      const moved = terrainQuery({ teeLat: '34.741' });
      const second = await bodyOf(await proxy(`/terrain/v1/pebble/1?${moved}`, env, usHeaders()));
      assert.notEqual(first.pinHash, second.pinHash);
      const blobs = fake.terrain.puts.filter((put) => put.key.startsWith('terrain:v1:'));
      assert.equal(new Set(blobs.map((put) => put.key)).size, 2);
      for (const put of blobs) assertForever(put);
      assert.ok(fake.terrain.store.has(`terrain:v1:${encodeURIComponent('pebble')}:1:${first.pinHash}`));
    } finally {
      fake.restore();
    }
  });

  test('a concurrent request for the same key does not start a second USGS round', async () => {
    const fake = installFakes();
    let release;
    const gate = {};
    gate.promise = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const state = usgsMock(fake, gate);
      const env = baseEnv(fake, { TERRAIN_LOCK_WAIT_MS: '0' });
      const path = `/terrain/v1/pebble/3?${terrainQuery()}`;
      const first = proxy(path, env, usHeaders());
      await state.started;
      const second = await proxy(path, env, usHeaders('id_b'));
      assert.equal(second.status, 503);
      assert.equal((await bodyOf(second)).error, 'terrain_pending');
      assert.ok(Number(second.headers.get('Retry-After')) >= 1);
      assert.equal(state.batches, 1);
      release();
      const done = await first;
      assert.equal(done.status, 200);
      const oneRound = state.batches;
      assert.ok(oneRound >= 1);
      const again = await proxy(path, env, usHeaders('id_c'));
      assert.equal(again.status, 200);
      assert.equal(state.batches, oneRound);
    } finally {
      release?.();
      fake.restore();
    }
  });

  test('exempt skips the sample cap and a non-US storefront cannot sample', async () => {
    const fake = installFakes();
    try {
      usgsMock(fake);
      const env = baseEnv(fake, { GOLFAPI_ALLOWLIST: DOC, TERRAIN_INSTALL_DAILY_CAP: '1' });
      assert.equal((await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders('id_a'))).status, 200);
      const blocked = await proxy(`/terrain/v1/pebble/2?${terrainQuery()}`, env, usHeaders('id_a'));
      assert.equal(blocked.status, 429);
      const exempt = await proxy(`/terrain/v1/pebble/2?${terrainQuery()}`, env, {
        'X-Install-Id': DOC,
        'X-ShotTraxx-Storefront': 'GBR',
      });
      assert.equal(exempt.status, 200);
      globalThis.fetch = async () => {
        throw new Error('must not sample');
      };
      const abroad = await proxy(`/terrain/v1/pebble/4?${terrainQuery()}`, env, {
        'X-Install-Id': 'id_abroad',
        'X-ShotTraxx-Storefront': 'CAN',
      });
      assert.equal(abroad.status, 404);
      const noHeader = await proxy(`/terrain/v1/pebble/5?${terrainQuery()}`, env, { 'X-Install-Id': 'id_field' });
      assert.equal(noHeader.status, 404);
      const noInstall = await proxy(`/terrain/v1/pebble/6?${terrainQuery()}`, env, {
        'X-ShotTraxx-Storefront': 'USA',
      });
      assert.equal(noInstall.status, 401);
    } finally {
      fake.restore();
    }
  });

  test('the sampling lock is written with a short TTL', async () => {
    const fake = installFakes();
    let release;
    const gate = {};
    gate.promise = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const state = usgsMock(fake, gate);
      const path = `/terrain/v1/pebble/7?${terrainQuery()}`;
      const pending = proxy(path, baseEnv(fake), usHeaders());
      await state.started;
      const lock = [...fake.counter.sql.map.entries()].find(([key]) => key.startsWith('terrain:lock:'));
      assert.ok(lock);
      assert.equal(JSON.parse(lock[1]).ttl >= 120, true);
      assert.equal(fake.terrain.puts.some((put) => put.key.startsWith('terrain:sampling:')), false);
      release();
      assert.equal((await pending).status, 200);
    } finally {
      release?.();
      fake.restore();
    }
  });

  test('the per-install terrain sample counter put uses a 48h expirationTtl', async () => {
    function assertSampleTtl(options) {
      assert.deepEqual(options, { expirationTtl: 172800 });
    }
    // A missing TTL, a wrong TTL, or any extra option must fail. 172800 is the only pass.
    for (const bad of [
      undefined,
      null,
      {},
      { expirationTtl: 86400 },
      { expirationTtl: 172801 },
      { expirationTtl: 172800, expiration: 1 },
    ]) {
      assert.throws(() => assertSampleTtl(bad));
    }
    assert.doesNotThrow(() => assertSampleTtl({ expirationTtl: 172800 }));

    const fake = installFakes();
    fake.counter = new FakeCounterNamespace({ TERRAIN_KV: fake.terrain });
    try {
      usgsMock(fake);
      const env = baseEnv(fake, { TERRAIN_INSTALL_DAILY_CAP: '1' });
      const day = new Date().toISOString().slice(0, 10);
      const sampleKey = `terrain:samples:id_ttl:${day}`;
      const first = await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders('id_ttl'));
      assert.equal(first.status, 200);
      const samplePuts = () => fake.terrain.puts.filter((put) => put.key.startsWith('terrain:samples:'));
      const written = samplePuts();
      assert.equal(written.length, 1);
      assert.equal(written[0].key, sampleKey);
      assert.equal(written[0].value, '1');
      assertSampleTtl(written[0].options);
      const blobs = fake.terrain.puts.filter((put) => put.key.startsWith('terrain:v1:'));
      assert.equal(blobs.length, 1);
      assert.equal(blobs[0].options, null);

      const blocked = await proxy(`/terrain/v1/pebble/2?${terrainQuery()}`, env, usHeaders('id_ttl'));
      assert.equal(blocked.status, 429);
      assert.equal((await bodyOf(blocked)).error, 'terrain_limited');
      assert.equal(samplePuts().length, 1);

      const kvKey = `terrain:samples:id_kv:${day}`;
      fake.terrain.store.set(kvKey, { value: '1', options: { expirationTtl: 172800 } });
      fake.counter.sql.map.set(kvKey, '0');
      const preferKv = await proxy(`/terrain/v1/pebble/8?${terrainQuery()}`, env, usHeaders('id_kv'));
      assert.equal(preferKv.status, 429);

      fake.terrain.puts.length = 0;
      globalThis.fetch = async () => {
        throw new Error('usgs down');
      };
      const failed = await proxy(`/terrain/v1/pebble/3?${terrainQuery()}`, env, usHeaders('id_abort'));
      assert.equal(failed.status, 502);
      const abortPuts = samplePuts();
      assert.deepEqual(abortPuts.map((put) => put.value), ['1', '0']);
      for (const put of abortPuts) {
        assert.equal(put.key, `terrain:samples:id_abort:${day}`);
        assertSampleTtl(put.options);
      }
      assert.equal(fake.terrain.puts.some((put) => put.key.startsWith('terrain:v1:')), false);
    } finally {
      fake.restore();
    }
  });

  test('a same-day SQLite sample count still enforces the cap when KV has no copy', async () => {
    const fake = installFakes();
    fake.counter = new FakeCounterNamespace({ TERRAIN_KV: fake.terrain });
    try {
      const day = new Date().toISOString().slice(0, 10);
      const key = `terrain:samples:id_sql:${day}`;
      fake.counter.sql.map.set(key, '1');
      globalThis.fetch = async () => {
        throw new Error('must not sample');
      };
      const env = baseEnv(fake, { TERRAIN_INSTALL_DAILY_CAP: '1' });
      const blocked = await proxy(`/terrain/v1/pebble/9?${terrainQuery()}`, env, usHeaders('id_sql'));
      assert.equal(blocked.status, 429);
      assert.equal((await bodyOf(blocked)).error, 'terrain_limited');
      assert.equal(fake.terrain.puts.some((put) => put.key.startsWith('terrain:samples:')), false);
      assert.equal(fake.counter.sql.map.get(key), '1');
    } finally {
      fake.restore();
    }
  });

  test('the per-install terrain sample count stays in SQLite and the 54 cap is unchanged', async () => {
    const fake = installFakes();
    fake.counter = new FakeCounterNamespace({ GOLFAPI_KV: fake.kv });
    try {
      usgsMock(fake);
      const env = baseEnv(fake, { TERRAIN_KV: undefined });
      delete env.TERRAIN_INSTALL_DAILY_CAP;
      const day = new Date().toISOString().slice(0, 10);
      const install = 'id_sqlcap';
      const sampleKey = `terrain:samples:${install}:${day}`;

      const first = await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders(install));
      assert.equal(first.status, 200);
      assert.equal(fake.counter.sql.map.get(sampleKey), '1');
      assert.equal(fake.kv.puts.some((put) => put.key.startsWith('terrain:samples:')), false);
      assert.equal(fake.terrain.puts.some((put) => put.key.startsWith('terrain:samples:')), false);
      const blobs = fake.kv.puts.filter((put) => put.key.startsWith('terrain:v1:'));
      assert.equal(blobs.length, 1);
      assert.equal(blobs[0].options, null);

      fake.kv.store.set(sampleKey, { value: '0', options: { expirationTtl: 172800 } });
      fake.counter.sql.map.set(sampleKey, '54');
      const blocked = await proxy(`/terrain/v1/pebble/2?${terrainQuery()}`, env, usHeaders(install));
      assert.equal(blocked.status, 429);
      assert.equal((await bodyOf(blocked)).error, 'terrain_limited');
      assert.equal(fake.counter.sql.map.get(sampleKey), '54');

      fake.kv.store.set(sampleKey, { value: '54', options: { expirationTtl: 172800 } });
      fake.counter.sql.map.set(sampleKey, '0');
      const allowed = await proxy(`/terrain/v1/pebble/3?${terrainQuery()}`, env, usHeaders(install));
      assert.equal(allowed.status, 200);
      assert.equal(fake.counter.sql.map.get(sampleKey), '1');
      assert.equal(fake.kv.puts.some((put) => put.key.startsWith('terrain:samples:')), false);

      fake.counter.sql.map.set(sampleKey, '5');
      fake.kv.store.set(sampleKey, { value: '1', options: null });
      const refunded = await counterOp(fake, {
        op: 'terrainAbort',
        lockKey: 'lock-refund',
        sampleKey,
        counted: true,
      });
      assert.equal(refunded.ok, true);
      assert.equal(fake.counter.sql.map.get(sampleKey), '4');
      assert.equal(fake.kv.puts.some((put) => put.key.startsWith('terrain:samples:')), false);

      globalThis.fetch = async () => {
        throw new Error('usgs down');
      };
      const failed = await proxy(`/terrain/v1/pebble/4?${terrainQuery()}`, env, usHeaders('id_abort'));
      assert.equal(failed.status, 502);
      assert.equal(fake.counter.sql.map.get(`terrain:samples:id_abort:${day}`), '0');
      assert.equal(fake.kv.puts.some((put) => put.key.startsWith('terrain:samples:')), false);
      assert.equal(fake.kv.puts.some((put) => put.key.startsWith('terrain:v1:') && put.key.includes('/4')), false);

      usgsMock(fake);
      const other = 'id_fiftyfour';
      const otherKey = `terrain:samples:${other}:${day}`;
      for (let n = 0; n < 54; n += 1) {
        const course = `c${Math.floor(n / 18)}`;
        const hole = (n % 18) + 1;
        const response = await proxy(`/terrain/v1/${course}/${hole}?${terrainQuery()}`, env, usHeaders(other));
        assert.equal(response.status, 200, `sample ${n}`);
      }
      assert.equal(fake.counter.sql.map.get(otherKey), '54');
      const over = await proxy(`/terrain/v1/extra/1?${terrainQuery()}`, env, usHeaders(other));
      assert.equal(over.status, 429);
      assert.equal((await bodyOf(over)).error, 'terrain_limited');
      assert.equal(fake.counter.sql.map.get(otherKey), '54');
      assert.equal(fake.kv.puts.some((put) => put.key.startsWith('terrain:samples:')), false);
      assert.equal(fake.terrain.puts.some((put) => put.key.startsWith('terrain:samples:')), false);
    } finally {
      fake.restore();
    }
  });

  test('an unparsed sample row is deleted and does not re-arm the alarm', async () => {
    const sql = new MemorySql();
    const storage = {
      sql,
      alarmAt: null,
      setAlarmCalls: 0,
      async getAlarm() {
        return this.alarmAt;
      },
      async setAlarm(at) {
        this.setAlarmCalls += 1;
        this.alarmAt = at;
      },
    };
    const counter = new GolfapiCounter({
      storage,
      blockConcurrencyWhile(fn) {
        return fn();
      },
    });
    sql.map.set('terrain:samples:id_bad:not-a-day', '1');
    sql.map.set('golfapi:known:keep', 'stay');
    await counter.alarm();
    assert.equal(sql.map.has('terrain:samples:id_bad:not-a-day'), false);
    assert.equal(sql.map.get('golfapi:known:keep'), 'stay');
    assert.equal(storage.setAlarmCalls, 0);
    assert.equal(storage.alarmAt, null);
  });

  test('the sample alarm is the first row UTC midnight plus 48h', async () => {
    function assertDeletionAlarm(at, dayStart) {
      assert.equal(at, dayStart + 172800 * 1000 + 1);
    }
    const dayStart = Date.parse('2026-10-22T00:00:00.000Z');
    assert.throws(() => assertDeletionAlarm(dayStart + 49 * 60 * 60 * 1000, dayStart));
    assert.throws(() => assertDeletionAlarm(dayStart + 172800 * 1000, dayStart));
    assert.throws(() => assertDeletionAlarm(dayStart + 172800 * 1000 + 2, dayStart));
    assert.doesNotThrow(() => assertDeletionAlarm(dayStart + 172800 * 1000 + 1, dayStart));

    const sql = new MemorySql();
    const storage = {
      sql,
      alarmAt: null,
      setAlarmCalls: 0,
      async getAlarm() {
        return this.alarmAt;
      },
      async setAlarm(at) {
        this.setAlarmCalls += 1;
        this.alarmAt = at;
      },
    };
    const counter = new GolfapiCounter({
      storage,
      blockConcurrencyWhile(fn) {
        return fn();
      },
    }, { GOLFAPI_KV: new FakeKV() });
    const earlyKey = 'terrain:samples:phone:2026-10-22';
    const laterKey = 'terrain:samples:phone:2026-10-24';
    const begun = await counter.terrainBegin({
      lockKey: 'lock-early',
      now: Date.parse('2026-10-24T23:00:00.000Z'),
      ttlSec: 120,
      sampleKey: earlyKey,
      cap: 54,
      exempt: false,
    });
    assert.equal(begun.ok, true);
    assert.equal(sql.map.get(earlyKey), '1');
    assert.equal(storage.setAlarmCalls, 1);
    assertDeletionAlarm(storage.alarmAt, dayStart);

    const laterStart = Date.parse('2026-10-24T00:00:00.000Z');
    const again = await counter.terrainBegin({
      lockKey: 'lock-later',
      now: Date.parse('2026-10-24T23:30:00.000Z'),
      ttlSec: 120,
      sampleKey: laterKey,
      cap: 54,
      exempt: false,
    });
    assert.equal(again.counted, true);
    assert.equal(sql.map.get(laterKey), '1');
    assert.equal(storage.setAlarmCalls, 1);
    assert.equal(storage.alarmAt, dayStart + 172800 * 1000 + 1);

    storage.alarmAt = dayStart + 10 * 24 * 60 * 60 * 1000;
    storage.setAlarmCalls = 0;
    await counter.armTerrainSampleAlarm();
    assert.equal(storage.setAlarmCalls, 1);
    assertDeletionAlarm(storage.alarmAt, dayStart);
  });

  test('sample counters use GOLFAPI_KV when TERRAIN_KV is unset', async () => {
    const fake = installFakes();
    fake.counter = new FakeCounterNamespace({ GOLFAPI_KV: fake.kv });
    try {
      usgsMock(fake);
      const env = baseEnv(fake, { TERRAIN_KV: undefined });
      const day = new Date().toISOString().slice(0, 10);
      const response = await proxy(`/terrain/v1/pebble/1?${terrainQuery()}`, env, usHeaders('id_fallback'));
      assert.equal(response.status, 200);
      const samples = fake.kv.puts.filter((put) => put.key.startsWith('terrain:samples:'));
      const blobs = fake.kv.puts.filter((put) => put.key.startsWith('terrain:v1:'));
      assert.equal(samples.length, 1);
      assert.equal(samples[0].key, `terrain:samples:id_fallback:${day}`);
      assert.deepEqual(samples[0].options, { expirationTtl: 172800 });
      assert.equal(blobs.length, 1);
      assert.equal(blobs[0].options, null);
      assert.equal(fake.terrain.puts.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('a Durable Object request deletes sample rows older than 48h', async () => {
    function assertRowExpired(ageMs) {
      assert.equal(ageMs > 172800 * 1000, true);
    }
    assert.throws(() => assertRowExpired(0));
    assert.throws(() => assertRowExpired(86400 * 1000));
    assert.throws(() => assertRowExpired(172800 * 1000));
    assert.throws(() => assertRowExpired(172800 * 1000 - 1));
    assert.doesNotThrow(() => assertRowExpired(172800 * 1000 + 1));
    assert.doesNotThrow(() => assertRowExpired(3 * 86400 * 1000));

    const fake = installFakes();
    try {
      const now = Date.now();
      const dayStart = (ms) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());
      const dayKey = (ms) => `terrain:samples:id_auto:${new Date(dayStart(ms)).toISOString().slice(0, 10)}`;
      const rows = [];
      for (let i = 0; i <= 6; i += 1) {
        const at = now - i * 24 * 60 * 60 * 1000;
        const key = dayKey(at);
        if (rows.some((row) => row.key === key)) continue;
        rows.push({ key, age: now - dayStart(at) });
        fake.counter.sql.map.set(key, '1');
      }
      fake.counter.sql.map.set('golfapi:known:keep', 'stay');
      const expired = rows.filter((row) => row.age > 172800 * 1000);
      const kept = rows.filter((row) => row.age <= 172800 * 1000);
      assert.ok(expired.length >= 1);
      assert.ok(kept.length >= 1);

      await counterOp(fake, { op: 'readUsage', dayKey: 'golfapi:credit:day:unused', monthKey: 'golfapi:credit:month:unused' });
      for (const row of expired) assert.equal(fake.counter.sql.map.has(row.key), false, row.key);
      for (const row of kept) assert.equal(fake.counter.sql.map.get(row.key), '1', row.key);
      assert.equal(fake.counter.sql.map.get('golfapi:known:keep'), 'stay');

      const fresh = `terrain:samples:id_new:${new Date(dayStart(now)).toISOString().slice(0, 10)}`;
      fake.counter.sql.map.set(fresh, '3');
      await counterOp(fake, { op: 'readUsage', dayKey: 'golfapi:credit:day:unused', monthKey: 'golfapi:credit:month:unused' });
      assert.equal(fake.counter.sql.map.get(fresh), '3');
    } finally {
      fake.restore();
    }
  });

  test('the sample sweep is an indexed range and runs at most once an hour', async () => {
    function assertSweepSkipped(elapsedMs) {
      assert.equal(elapsedMs < 60 * 60 * 1000, true);
    }
    assert.throws(() => assertSweepSkipped(60 * 60 * 1000));
    assert.throws(() => assertSweepSkipped(60 * 60 * 1000 + 1));
    assert.doesNotThrow(() => assertSweepSkipped(0));
    assert.doesNotThrow(() => assertSweepSkipped(60 * 60 * 1000 - 1));

    const fake = installFakes();
    try {
      const t0 = Date.parse('2026-10-24T12:00:00.000Z');
      const oldKey = 'terrain:samples:id_hour:2026-10-22';
      const again = 'terrain:samples:id_hour2:2026-10-22';
      const edgeKey = 'terrain:samples;';
      const sweepKey = 'golfapi:terrain-sample-sweep';
      const usage = (now) => counterOp(fake, {
        op: 'readUsage',
        now,
        dayKey: 'golfapi:credit:day:unused',
        monthKey: 'golfapi:credit:month:unused',
      });
      fake.counter.sql.map.set(oldKey, '4');
      fake.counter.sql.map.set(edgeKey, 'nope');
      fake.counter.sql.map.set('golfapi:known:keep', 'stay');
      fake.counter.sql.queries.length = 0;

      await usage(t0);
      assert.equal(fake.counter.sql.map.has(oldKey), false);
      assert.equal(fake.counter.sql.map.get(edgeKey), 'nope');
      assert.equal(fake.counter.sql.map.get('golfapi:known:keep'), 'stay');
      assert.equal(fake.counter.sql.map.get(sweepKey), String(t0));
      const ranges = fake.counter.sql.queries.filter((query) => query.text.includes('key >='));
      assert.equal(ranges.length, 1);
      assert.match(ranges[0].text, /SELECT key FROM state WHERE key >= \? AND key < \?/);
      assert.doesNotMatch(ranges[0].text, /LIKE|key <=/);
      assert.deepEqual(ranges[0].args, ['terrain:samples:', 'terrain:samples;']);

      fake.counter.sql.map.set(again, '5');
      fake.counter.sql.queries.length = 0;
      await usage(t0 + 60 * 60 * 1000 - 1);
      assert.equal(fake.counter.sql.map.get(again), '5');
      assert.equal(fake.counter.sql.queries.some((query) => query.text.includes('key >=')), false);

      fake.counter.sql.map.delete(sweepKey);
      await usage(t0 + 30 * 60 * 1000);
      assert.equal(fake.counter.sql.map.get(again), '5');

      fake.counter.sql.map.set(sweepKey, String(t0));
      const second = new GolfapiCounter({
        storage: { sql: fake.counter.sql },
        blockConcurrencyWhile(fn) {
          return fn();
        },
      });
      const skipped = await second.fetch(new Request('https://golfapi-counter.internal/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'readUsage',
          now: t0 + 30 * 60 * 1000,
          dayKey: 'golfapi:credit:day:unused',
          monthKey: 'golfapi:credit:month:unused',
        }),
      }));
      assert.equal((await skipped.json()).ok, true);
      assert.equal(fake.counter.sql.map.get(again), '5');

      await usage(t0 + 60 * 60 * 1000);
      assert.equal(fake.counter.sql.map.has(again), false);
      assert.equal(fake.counter.sql.map.get(sweepKey), String(t0 + 60 * 60 * 1000));
      assert.equal(fake.counter.sql.map.get(edgeKey), 'nope');
      assert.equal(fake.counter.sql.map.get('golfapi:known:keep'), 'stay');
    } finally {
      fake.restore();
    }
  });

  test('a sample write sets a 49h alarm that sweeps with no further requests', async () => {
    function assertAlarmDelay(ms) {
      assert.equal(ms, 49 * 60 * 60 * 1000);
    }
    assert.throws(() => assertAlarmDelay(48 * 60 * 60 * 1000));
    assert.throws(() => assertAlarmDelay(48 * 60 * 60 * 1000 + 1));
    assert.throws(() => assertAlarmDelay(0));
    assert.throws(() => assertAlarmDelay(49 * 60 * 60 * 1000 - 1));
    assert.throws(() => assertAlarmDelay(50 * 60 * 60 * 1000));
    assert.doesNotThrow(() => assertAlarmDelay(49 * 60 * 60 * 1000));

    const source = readFileSync(new URL('./golf-proxy.js', import.meta.url), 'utf8');
    const handlers = source.match(/^\s*(?:async\s+)?alarm\s*\(/gm) || [];
    assert.equal(handlers.length, 1);

    const sql = new MemorySql();
    const storage = {
      sql,
      alarmAt: 12345,
      setAlarmCalls: 0,
      async getAlarm() {
        return this.alarmAt;
      },
      async setAlarm(at) {
        this.setAlarmCalls += 1;
        this.alarmAt = at;
      },
    };
    const ctx = {
      storage,
      blockConcurrencyWhile(fn) {
        return fn();
      },
    };
    const counter = new GolfapiCounter(ctx);
    const hour = 60 * 60 * 1000;
    const delay = 49 * hour;

    await counter.writeSample('terrain:samples:id_alarm:2026-10-24', 2);
    assert.equal(storage.setAlarmCalls, 0);
    assert.equal(storage.alarmAt, 12345);
    assert.equal(sql.map.get('terrain:samples:id_alarm:2026-10-24'), '2');

    storage.alarmAt = null;
    const before = Date.now();
    await counter.writeSample('terrain:samples:id_alarm:2026-10-24', 3);
    const after = Date.now();
    assert.equal(storage.setAlarmCalls, 1);
    assert.equal(sql.map.get('terrain:samples:id_alarm:2026-10-24'), '3');
    assert.equal(storage.alarmAt >= before + delay, true);
    assert.equal(storage.alarmAt <= after + delay, true);
    assertAlarmDelay(delay);

    const kv = new FakeKV();
    const kvCounter = new GolfapiCounter(ctx, { TERRAIN_KV: kv });
    storage.alarmAt = 12345;
    storage.setAlarmCalls = 0;
    await kvCounter.writeSample('terrain:samples:id_kv:2026-10-24', 1);
    assert.equal(storage.setAlarmCalls, 0);
    assert.equal(storage.alarmAt, 12345);
    assert.deepEqual(kv.puts[0].options, { expirationTtl: 172800 });
    storage.alarmAt = null;
    const kvBefore = Date.now();
    await kvCounter.writeSample('terrain:samples:id_kv:2026-10-24', 4);
    const kvAfter = Date.now();
    assert.equal(storage.setAlarmCalls, 1);
    assert.equal(storage.alarmAt >= kvBefore + delay, true);
    assert.equal(storage.alarmAt <= kvAfter + delay, true);

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const old = new Date(now - 3 * 24 * hour).toISOString().slice(0, 10);
    const oldKey = `terrain:samples:id_alarm:${old}`;
    const todayKey = `terrain:samples:id_alarm:${today}`;
    sql.map.set(oldKey, '9');
    sql.map.set(todayKey, '2');
    sql.map.set('golfapi:known:keep', 'stay');
    storage.alarmAt = null;
    storage.setAlarmCalls = 0;
    await counter.alarm();
    assert.equal(sql.map.has(oldKey), false);
    assert.equal(sql.map.get(todayKey), '2');
    assert.equal(sql.map.get('golfapi:known:keep'), 'stay');
    assert.equal(storage.setAlarmCalls, 1);
    assert.equal(storage.alarmAt >= now + delay, true);
    assert.equal(storage.alarmAt < now + delay + 5000, true);

    sql.map.clear();
    sql.map.set(oldKey, '9');
    storage.alarmAt = null;
    storage.setAlarmCalls = 0;
    await counter.alarm();
    assert.equal(sql.map.has(oldKey), false);
    assert.equal(storage.setAlarmCalls, 0);
    assert.equal(storage.alarmAt, null);

    sql.map.clear();
    sql.map.set('terrain:samples:id_alarm:not-a-day', '1');
    storage.alarmAt = null;
    storage.setAlarmCalls = 0;
    await counter.alarm();
    assert.equal(sql.map.get('terrain:samples:id_alarm:not-a-day'), '1');
    assert.equal(storage.setAlarmCalls, 1);
  });

  test('cleanup drops stored sample counters whose day is more than 48h old', async () => {
    const fake = installFakes();
    try {
      const now = Date.parse('2026-10-24T12:00:00.000Z');
      const oldKey = 'terrain:samples:id_old:2026-10-22';
      const todayKey = 'terrain:samples:id_today:2026-10-24';
      const yesterdayKey = 'terrain:samples:id_y:2026-10-23';
      const blob = 'terrain:v1:pebble:1:abc';
      fake.counter.sql.map.set(oldKey, '4');
      fake.counter.sql.map.set(todayKey, '2');
      fake.counter.sql.map.set(yesterdayKey, '1');
      fake.counter.sql.map.set(blob, '{}');
      const dry = await counterOp(fake, { op: 'cleanupTerrainSamples', now, apply: false });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.deleted, 0);
      assert.equal(dry.expired, 1);
      assert.equal(dry.listed, 3);
      assert.equal(fake.counter.sql.map.has(oldKey), true);
      assert.equal(JSON.stringify(dry).includes('id_old'), false);
      const applied = await counterOp(fake, { op: 'cleanupTerrainSamples', now, apply: true });
      assert.equal(applied.deleted, 1);
      assert.equal(applied.dryRun, false);
      assert.equal(fake.counter.sql.map.has(oldKey), false);
      assert.equal(fake.counter.sql.map.get(todayKey), '2');
      assert.equal(fake.counter.sql.map.get(yesterdayKey), '1');
      assert.equal(fake.counter.sql.map.get(blob), '{}');
      assert.equal(JSON.stringify(applied).includes('id_'), false);
    } finally {
      fake.restore();
    }
  });

  test('the billing cycle runs from the 5th through the 4th, not the calendar month', () => {
    assert.equal(golfapiCycleId(new Date('2026-10-05T00:00:00Z'), 5), '2026-10-05');
    assert.equal(golfapiCycleId(new Date('2026-10-09T12:00:00Z'), 5), '2026-10-05');
    assert.equal(golfapiCycleId(new Date('2026-11-01T00:00:00Z'), 5), '2026-10-05');
    assert.equal(golfapiCycleId(new Date('2026-11-04T23:59:00Z'), 5), '2026-10-05');
    assert.equal(golfapiCycleId(new Date('2026-11-05T00:00:00Z'), 5), '2026-11-05');
    assert.equal(golfapiCycleId(new Date('2026-10-04T00:00:00Z'), 5), '2026-09-05');
    assert.equal(golfapiCycleId(new Date('2026-01-04T00:00:00Z'), 5), '2025-12-05');
  });

  test('75% of the plan sends once, and extra credits do not skew the percent', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      const cycle = golfapiCycleId(new Date(), 5);
      fake.counter.sql.map.set(`golfapi:cycle-start:${cycle}`, '656');
      globalThis.fetch = async () => {
        fake.calls.push('golfapi');
        return new Response(JSON.stringify({ courses: [], apiRequestsLeft: 281 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake, {
        ALERT_EMAIL: box.binding,
        ALERT_TO: 'shottraxx@gmail.com',
        ALERT_FROM: 'alerts@shottraxx.com',
        GOLFAPI_PLAN_MONTHLY: '500',
      });
      const first = await proxy('/golfapi/v2.3/courses?name=pine&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(first.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 1);
      assert.match(box.sent[0].raw, /crossed 75%/);
      assert.match(box.sent[0].raw, /375\/500/);
      assert.match(box.sent[0].raw, /apiRequestsLeft 281/);
      assert.match(box.sent[0].raw, /Worker count this cycle: 0\.1\/450/);
      assert.match(box.sent[0].raw, /Today: 0\.1\/150/);
      assert.match(box.sent[0].raw, /Credits left before the floor: 231/);
      assert.equal(box.sent[0].to, 'shottraxx@gmail.com');
      assert.equal(box.sent[0].from, 'alerts@shottraxx.com');
      assert.equal(fake.calls.length, 1);
      assert.equal(counterValue(fake, `golfapi:credit:month:${cycle}`), 0.1);
      assert.equal(counterValue(fake, `golfapi:credit:month:${new Date().toISOString().slice(0, 7)}`), 0);

      const again = await proxy('/golfapi/v2.3/courses?name=oak&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(again.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 1);
      assert.equal(fake.counter.sql.map.get(`golfapi:alert:sent:${cycle}:75`), '1');
    } finally {
      fake.restore();
    }
  });

  test('90% and 95% each send once', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      const cycle = golfapiCycleId(new Date(), 5);
      fake.counter.sql.map.set(`golfapi:cycle-start:${cycle}`, '656');
      const lefts = [281, 206, 181, 100];
      let n = 0;
      globalThis.fetch = async () => {
        fake.calls.push('golfapi');
        const left = lefts[n];
        n += 1;
        return new Response(JSON.stringify({ courses: [], apiRequestsLeft: left }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake, { ALERT_EMAIL: box.binding, GOLFAPI_PLAN_MONTHLY: '500' });
      const names = ['a', 'b', 'c', 'd'];
      for (const name of names) {
        const res = await proxy(`/golfapi/v2.3/courses?name=${name}&country=US`, env, usHeaders(), 'GET', box.ctx);
        assert.equal(res.status, 200);
        await box.flush();
      }
      const subjects = box.sent.map((message) => message.raw.match(/Subject: ([^\r]+)/)[1]);
      assert.deepEqual(subjects, [
        'ShotTraxx golfapi usage crossed 75%',
        'ShotTraxx golfapi usage crossed 90%',
        'ShotTraxx golfapi usage crossed 95%',
      ]);
      assert.equal(fake.calls.length, 4);
    } finally {
      fake.restore();
    }
  });

  test('a jump from 70% to 96% sends 75, 90, and 95 once in order', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      const cycle = golfapiCycleId(new Date(), 5);
      fake.counter.sql.map.set(`golfapi:cycle-start:${cycle}`, '656');
      const lefts = [306, 176];
      let n = 0;
      globalThis.fetch = async () => {
        const left = lefts[n];
        n += 1;
        return new Response(JSON.stringify({ courses: [], apiRequestsLeft: left }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const env = baseEnv(fake, { ALERT_EMAIL: box.binding, GOLFAPI_PLAN_MONTHLY: '500' });
      const low = await proxy('/golfapi/v2.3/courses?name=low&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(low.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 0);
      const high = await proxy('/golfapi/v2.3/courses?name=high&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(high.status, 200);
      await box.flush();
      const pcts = box.sent.map((message) => message.raw.match(/crossed (\d+)%/)[1]);
      assert.deepEqual(pcts, ['75', '90', '95']);
    } finally {
      fake.restore();
    }
  });

  test('alert flags and the start balance reset on the 5th, not the 1st', async () => {
    const fake = installFakes();
    try {
      const october = golfapiCycleId(new Date('2026-11-01T12:00:00Z'), 5);
      assert.equal(october, '2026-10-05');
      const monthKey = `golfapi:credit:month:${october}`;
      const dayKey = 'golfapi:credit:day:2026-11-01';
      const opened = await counterOp(fake, {
        op: 'noteBalance',
        cycleId: october,
        monthKey,
        dayKey,
        left: 656,
        planMonthly: 500,
        now: Date.parse('2026-11-01T12:00:00Z'),
      });
      assert.deepEqual(opened.alerts, []);
      const crossed = await counterOp(fake, {
        op: 'noteBalance',
        cycleId: october,
        monthKey,
        dayKey,
        left: 281,
        planMonthly: 500,
        now: Date.parse('2026-11-04T12:00:00Z'),
      });
      assert.deepEqual(crossed.alerts, [75]);
      assert.equal(crossed.used, 375);
      const november = golfapiCycleId(new Date('2026-11-05T00:00:00Z'), 5);
      assert.equal(november, '2026-11-05');
      const reset = await counterOp(fake, {
        op: 'noteBalance',
        cycleId: november,
        monthKey: `golfapi:credit:month:${november}`,
        dayKey: 'golfapi:credit:day:2026-11-05',
        left: 700,
        planMonthly: 500,
        now: Date.parse('2026-11-05T00:30:00Z'),
      });
      assert.deepEqual(reset.alerts, []);
      assert.equal(reset.used, 0);
      assert.equal(reset.start, 700);
      const next = await counterOp(fake, {
        op: 'noteBalance',
        cycleId: november,
        monthKey: `golfapi:credit:month:${november}`,
        dayKey: 'golfapi:credit:day:2026-11-05',
        left: 325,
        planMonthly: 500,
        now: Date.parse('2026-11-05T01:00:00Z'),
      });
      assert.equal(next.used, 375);
      assert.deepEqual(next.alerts, [75]);
      assert.equal(fake.counter.sql.map.get('golfapi:cycle-start:2026-10-05'), '656');
      assert.equal(fake.counter.sql.map.get('golfapi:alert:try:2026-11-05:75') != null, true);
      assert.equal(fake.counter.sql.map.get('golfapi:alert:try:2026-10-05:90') ?? null, null);
    } finally {
      fake.restore();
    }
  });

  test('with no start balance, the worker cycle count is the fallback', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      const cycle = golfapiCycleId(new Date(), 5);
      fake.counter.sql.map.set(`golfapi:credit:month:${cycle}`, '374.9');
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ courses: [], apiRequestsLeft: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const env = baseEnv(fake, { ALERT_EMAIL: box.binding, GOLFAPI_PLAN_MONTHLY: '500' });
      const res = await proxy('/golfapi/v2.3/courses?name=fallback&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(res.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 1);
      assert.match(box.sent[0].raw, /no start-of-cycle balance yet/);
      assert.match(box.sent[0].raw, /375\/500/);
      assert.match(box.sent[0].raw, /Worker count this cycle: 375\/450/);
      const again = await proxy('/golfapi/v2.3/courses?name=fallback-2&country=US', env, usHeaders('id_other'), 'GET', box.ctx);
      assert.equal(again.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 1);
    } finally {
      fake.restore();
    }
  });

  test('a missing email binding does not throw and retries after an hour', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      const cycle = golfapiCycleId(new Date(), 5);
      fake.counter.sql.map.set(`golfapi:cycle-start:${cycle}`, '656');
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ courses: [], apiRequestsLeft: 281 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const env = baseEnv(fake, { GOLFAPI_PLAN_MONTHLY: '500' });
      const first = await proxy('/golfapi/v2.3/courses?name=one&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(first.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 0);
      assert.equal(fake.counter.sql.map.get(`golfapi:alert:sent:${cycle}:75`), undefined);
      assert.ok(fake.counter.sql.map.get(`golfapi:alert:try:${cycle}:75`));

      const second = await proxy('/golfapi/v2.3/courses?name=two&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(second.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 0);

      fake.counter.sql.map.set(`golfapi:alert:try:${cycle}:75`, String(Date.now() - 2 * 60 * 60 * 1000));
      env.ALERT_EMAIL = box.binding;
      const third = await proxy('/golfapi/v2.3/courses?name=three&country=US', env, usHeaders(), 'GET', box.ctx);
      assert.equal(third.status, 200);
      await box.flush();
      assert.equal(box.sent.length, 1);
      assert.equal(fake.counter.sql.map.get(`golfapi:alert:sent:${cycle}:75`), '1');
    } finally {
      fake.restore();
    }
  });

  test('concurrent crossings claim each threshold once', async () => {
    const fake = installFakes();
    try {
      const cycle = golfapiCycleId(new Date(), 5);
      fake.counter.sql.map.set(`golfapi:cycle-start:${cycle}`, '656');
      const body = {
        op: 'noteBalance',
        cycleId: cycle,
        monthKey: `golfapi:credit:month:${cycle}`,
        dayKey: 'golfapi:credit:day:2026-10-09',
        left: 176,
        planMonthly: 500,
        now: Date.now(),
      };
      const [a, b] = await Promise.all([counterOp(fake, body), counterOp(fake, body)]);
      const lengths = [a.alerts.length, b.alerts.length].sort((x, y) => x - y);
      assert.deepEqual(lengths, [0, 3]);
      const claimed = a.alerts.length === 3 ? a.alerts : b.alerts;
      assert.deepEqual(claimed, [75, 90, 95]);
    } finally {
      fake.restore();
    }
  });

  test('the admin alert route rejects a bad token and sends with a good one', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      globalThis.fetch = async () => {
        throw new Error('alert route must not call golfapi');
      };
      const env = baseEnv(fake, {
        ALERT_ADMIN_TOKEN: 'secret-token',
        ALERT_EMAIL: box.binding,
        ALERT_TO: 'shottraxx@gmail.com',
        ALERT_FROM: 'alerts@shottraxx.com',
      });
      const bad = await proxy('/admin/alert-test', env, { 'X-Admin-Token': 'nope' }, 'POST');
      assert.equal(bad.status, 401);
      assert.equal(box.sent.length, 0);
      const missing = await proxy('/admin/alert-test', env, {}, 'POST');
      assert.equal(missing.status, 401);
      const ok = await proxy('/admin/alert-test', env, { 'X-Admin-Token': 'secret-token' }, 'POST');
      assert.equal(ok.status, 200);
      assert.equal((await bodyOf(ok)).ok, true);
      assert.equal(box.sent.length, 1);
      assert.match(box.sent[0].raw, /This is a test email/);
      assert.match(box.sent[0].raw, /375\/500/);
      assert.match(box.sent[0].raw, /apiRequestsLeft 281/);
      assert.match(box.sent[0].raw, /0\/450/);
      assert.equal(box.sent[0].to, 'shottraxx@gmail.com');
      assert.equal(fake.calls.length, 0);
      assert.equal(counterValue(fake, creditKey('none', 'month')), 0);
      const get = await proxy('/admin/alert-test', env, { 'X-Admin-Token': 'secret-token' });
      assert.equal(get.status, 405);
    } finally {
      fake.restore();
    }
  });

  test('alert-test is limited after the token check, and an install id is not a token', async () => {
    const fake = installFakes();
    const box = alertCapture();
    try {
      globalThis.fetch = async () => {
        throw new Error('alert route must not call golfapi');
      };
      const env = baseEnv(fake, { GOLFAPI_ALLOWLIST: DOC, ALERT_EMAIL: box.binding });
      assert.equal((await proxy('/admin/alert-test', env, {}, 'POST')).status, 401);
      assert.equal((await proxy('/admin/demand', env, {})).status, 401);
      assert.equal((await proxy('/admin/alert-test', env, { 'X-Install-Id': DOC }, 'POST')).status, 401);
      assert.equal((await proxy('/admin/demand', env, { 'X-Install-Id': DOC })).status, 401);
      env.ALERT_ADMIN_TOKEN = '   ';
      assert.equal((await proxy('/admin/alert-test', env, { 'X-Admin-Token': DOC }, 'POST')).status, 401);
      assert.equal((await proxy('/admin/demand', env, { 'X-Admin-Token': DOC })).status, 401);
      const alertKeys = () => [...fake.counter.sql.map.keys()].filter((key) => key.startsWith('golfapi:alert-test:'));
      assert.deepEqual(alertKeys(), []);
      assert.equal(box.sent.length, 0);
      assert.equal(fake.kv.puts.length, 0);

      env.ALERT_ADMIN_TOKEN = 'secret-token';
      for (let n = 0; n < 4; n += 1) {
        assert.equal((await proxy('/admin/alert-test', env, { 'X-Admin-Token': 'nope' }, 'POST')).status, 401);
      }
      assert.deepEqual(alertKeys(), []);
      const get = await proxy('/admin/alert-test', env, {});
      assert.equal(get.status, 405);
      assert.deepEqual(alertKeys(), []);

      const send = () => proxy('/admin/alert-test', env, { 'X-Admin-Token': 'secret-token' }, 'POST');
      const first = await send();
      assert.equal(first.status, 200);
      assert.equal(fake.counter.sql.map.get('golfapi:alert-test:count'), '1');
      const second = await send();
      assert.equal(second.status, 429);
      const secondBody = await bodyOf(second);
      assert.equal(secondBody.error, 'alert_test_limited');
      const gap = Number(second.headers.get('Retry-After'));
      assert.equal(secondBody.retryAfterSec, gap);
      assert.equal(gap <= 600, true);
      assert.equal(gap >= 1, true);
      assert.equal(fake.counter.sql.map.get('golfapi:alert-test:count'), '1');
      assert.equal((await proxy('/admin/alert-test', env, { 'X-Admin-Token': 'nope' }, 'POST')).status, 401);
      assert.equal(fake.counter.sql.map.get('golfapi:alert-test:count'), '1');

      const rewind = () => {
        fake.counter.sql.map.set('golfapi:alert-test:last', String(Date.now() - 11 * 60 * 1000));
      };
      for (let n = 2; n <= 5; n += 1) {
        rewind();
        const sent = await send();
        assert.equal(sent.status, 200, `send ${n}`);
        assert.equal(fake.counter.sql.map.get('golfapi:alert-test:count'), String(n));
      }
      rewind();
      const sixth = await send();
      assert.equal(sixth.status, 429);
      const sixthBody = await bodyOf(sixth);
      assert.equal(sixthBody.error, 'alert_test_limited');
      const now = new Date();
      const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const untilDay = Math.max(1, Math.ceil((nextUtcDay - Date.now()) / 1000));
      const dayWait = Number(sixth.headers.get('Retry-After'));
      assert.equal(sixthBody.retryAfterSec, dayWait);
      assert.equal(Math.abs(dayWait - untilDay) < 5, true);
      assert.equal(fake.counter.sql.map.get('golfapi:alert-test:count'), '5');
      assert.equal(box.sent.length, 5);
      assert.equal(fake.calls.length, 0);
      assert.equal(fake.kv.puts.length, 0);
    } finally {
      fake.restore();
    }
  });

  test('a state tally waits in the background and cannot fail or delay the search', async () => {
    const fake = installFakes();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const original = fake.counter.stub.fetch.bind(fake.counter.stub);
    fake.counter.stub.fetch = async (request) => {
      const body = await request.clone().json().catch(() => ({}));
      if (body.op === 'noteSearchStates') {
        await gate;
        throw new Error('state tally down');
      }
      return original(request);
    };
    golfJson(fake, {
      courses: [{ courseID: 'tx-1', courseName: 'Texas Nine', state: 'TX', country: 'US' }],
      apiRequestsLeft: 100,
    });
    const pending = [];
    const ctx = {
      waitUntil(promise) {
        pending.push(promise);
      },
    };
    try {
      const response = await Promise.race([
        proxy('/golfapi/v2.3/courses?country=US&state=TX', baseEnv(fake), usHeaders(), 'GET', ctx),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('search waited on the state tally')), 500);
        }),
      ]);
      assert.equal(response.status, 200);
      assert.equal(pending.length, 1);
      release();
      await pending[0];
      assert.equal(response.status, 200);
    } finally {
      release();
      fake.restore();
    }
  });
});
