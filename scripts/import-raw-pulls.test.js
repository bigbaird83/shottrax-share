import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { GolfapiCounter, handleGolfProxy } from '../golf-proxy.js';
import {
  LIST_REMOTE_ARGS,
  THUNDERBIRD_GOLFAPI_COURSE_ID,
  commands,
  main,
  parseExistingKeys,
  planImport,
  scanRaw,
} from './import-raw-pulls.mjs';

function courseBody(id, extra = {}) {
  return {
    apiRequestsLeft: '4498.6',
    clubName: `Club ${id}`,
    city: 'Maumelle',
    state: 'AR',
    country: 'USA',
    latitude: '34.84',
    longitude: '-92.39',
    courseID: id,
    numHoles: '18',
    hasGPS: '1',
    ...extra,
  };
}
function coordBody(id, extra = {}) {
  return {
    apiRequestsLeft: '4497.6',
    courseID: id,
    numCoordinates: 2,
    coordinates: [
      { poi: 1, hole: 1, latitude: 34.8466, longitude: -92.3949 },
      { poi: 11, hole: 1, latitude: 34.8444, longitude: -92.3966 },
    ],
    ...extra,
  };
}
/** Python-style spacing, like the files on disk. */
function pyText(value) {
  return JSON.stringify(value, null, 0).replace(/":/g, '": ').replace(/,"/g, ', "');
}

let dir;
function put(rel, text, mtimeSec) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  if (mtimeSec != null) utimesSync(full, mtimeSec, mtimeSec);
}
function pair(folder, id, course = courseBody(id), coords = coordBody(id), mtimeSec) {
  put(`${folder}/${id}.courses.json`, typeof course === 'string' ? course : pyText(course), mtimeSec);
  put(`${folder}/${id}.coordinates.json`, typeof coords === 'string' ? coords : pyText(coords), mtimeSec);
}
function plan(existing = []) {
  return planImport({ scan: scanRaw(dir), existing: new Set(existing) });
}
function keysOf(result) {
  return result.bulk.map((row) => row.key).sort();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raw-pulls-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('import-raw-pulls dry run', () => {
  test('a valid pair becomes two envelopes plus a US marker, body text exactly as on disk', () => {
    pair('national/AR/ar-x', '100');
    const result = plan();
    assert.deepEqual(keysOf(result), [
      'golfapi:permanent:coordinates:100',
      'golfapi:permanent:course:100',
      'golfapi:us:100',
    ]);
    const disk = readFileSync(join(dir, 'national/AR/ar-x/100.courses.json'), 'utf8');
    const row = result.bulk.find((r) => r.key === 'golfapi:permanent:course:100');
    const env = JSON.parse(row.value);
    assert.deepEqual(Object.keys(env), ['status', 'contentType', 'body']);
    assert.equal(env.status, 200);
    assert.equal(env.contentType, 'application/json');
    assert.equal(env.body, disk);
    assert.equal(result.bulk.find((r) => r.key === 'golfapi:us:100').value, '1');
    assert.equal(result.report.valid, 1);
    assert.deepEqual(result.report.keysToWrite, { course: 1, coordinates: 1, us: 1, total: 3 });
    assert.deepEqual(result.deleteKeys.sort(), keysOf(result));
  });

  test('other files are ignored', () => {
    pair('tier1', '100');
    put('tier1/search-abc.json', '{"courses":[]}');
    put('tier1/run.out', 'x');
    put('notes.md', '# hi');
    put('.pull.lock', '1');
    put('national/SC/sc-a/matches.json', '[]');
    const result = plan();
    assert.equal(result.report.idsScanned, 1);
    assert.equal(result.report.ignoredFiles.files, 5);
  });

  test('a missing pair is skipped', () => {
    put('tier1/200.courses.json', pyText(courseBody('200')));
    put('tier1/201.coordinates.json', pyText(coordBody('201')));
    const result = plan();
    assert.equal(result.bulk.length, 0);
    assert.equal(result.report.skipped.missing_pair, 2);
  });

  test('parse errors, error fields, quota bodies and zero GPS are skipped', () => {
    pair('t', '300', '{"courseID": "300", ');
    pair('t', '301', courseBody('301'), '{not json');
    pair('t', '302', courseBody('302', { error: 'Course not found' }));
    pair('t', '303', courseBody('303'), coordBody('303', { error: 'boom' }));
    pair('t', '304', courseBody('304', { hasGPS: '0' }));
    pair('t', '305', courseBody('305', { latitude: 0, longitude: 0 }));
    pair('t', '306', courseBody('306'), coordBody('306', { numCoordinates: 0, coordinates: [] }));
    pair('t', '307', courseBody('307'), coordBody('307', {
      coordinates: [
        { poi: 1, hole: 1, latitude: 0, longitude: 0 },
        { poi: 11, hole: 1, latitude: 0, longitude: 0 },
      ],
    }));
    pair('t', '308', courseBody('308', { message: 'Quota exceeded' }));
    pair('t', '309', courseBody('309', { error: false }));
    const result = plan();
    assert.deepEqual(result.report.skipped, {
      parse_error: 1,
      coordinates_parse_error: 1,
      error_field: 1,
      coordinates_error_field: 1,
      zero_gps: 2,
      coordinates_zero_gps: 1,
      coordinates_no_usable_map: 1,
      quota_body: 1,
    });
    // error: false is not an error.
    assert.deepEqual(keysOf(result), [
      'golfapi:permanent:coordinates:309',
      'golfapi:permanent:course:309',
      'golfapi:us:309',
    ]);
  });

  test('bad hole counts, non-US courses and mismatched ids are skipped', () => {
    pair('t', '400', courseBody('400', { numHoles: '0' }));
    pair('t', '401', courseBody('401', { numHoles: '99' }));
    pair('t', '402', courseBody('402', { country: 'Canada' }));
    pair('t', '403', courseBody('999'));
    const result = plan();
    assert.deepEqual(result.report.skipped, { bad_num_holes: 2, non_us: 1, id_mismatch: 1 });
    assert.equal(result.bulk.length, 0);
  });

  test('an existing permanent key is never overwritten', () => {
    pair('t', '500');
    pair('t', '501');
    pair('t', '502');
    const result = plan([
      'golfapi:permanent:course:500',
      'golfapi:permanent:coordinates:500',
      'golfapi:permanent:course:501',
      'golfapi:permanent:coordinates:502',
      'golfapi:us:502',
    ]);
    const keys = keysOf(result);
    for (const k of ['golfapi:permanent:course:500', 'golfapi:permanent:coordinates:500', 'golfapi:permanent:course:501', 'golfapi:permanent:coordinates:502', 'golfapi:us:502']) {
      assert.equal(keys.includes(k), false, k);
    }
    assert.deepEqual(keys, [
      'golfapi:permanent:coordinates:501',
      'golfapi:permanent:course:502',
      'golfapi:us:501',
    ].sort());
    assert.equal(result.report.skipped.already_stored, 1);
    assert.deepEqual(result.report.partialExisting, [
      { id: '501', alreadyStored: 'course', writing: 'coordinates' },
      { id: '502', alreadyStored: 'coordinates', writing: 'course' },
    ]);
  });

  test('a half-stored id with an invalid missing body writes nothing', () => {
    pair('t', '510', courseBody('510'), coordBody('510', { error: 'x' }));
    const result = plan(['golfapi:permanent:course:510']);
    assert.equal(result.bulk.length, 0);
    assert.equal(result.report.skipped.coordinates_error_field, 1);
  });

  test('nodata ids and Thunderbird Heber Springs are skipped', () => {
    pair('t', '600');
    pair('national/AR/ar-searcy', THUNDERBIRD_GOLFAPI_COURSE_ID, courseBody(THUNDERBIRD_GOLFAPI_COURSE_ID, {
      clubName: 'Thunderbird Country Club',
      city: 'Heber Springs',
    }));
    pair('t', '601', courseBody('601', { clubName: 'Thunderbird Country Club', city: 'Heber Springs' }));
    pair('t', '602', courseBody('602', { clubName: 'Thunderbird Golf Club', city: 'Phoenix' }));
    const result = plan(['golfapi:nodata:600']);
    assert.equal(result.report.skipped.nodata, 1);
    assert.equal(result.report.skipped.thunderbird, 2);
    assert.deepEqual(result.report.skippedIds.thunderbird.sort(), ['601', THUNDERBIRD_GOLFAPI_COURSE_ID].sort());
    assert.deepEqual(keysOf(result), [
      'golfapi:permanent:coordinates:602',
      'golfapi:permanent:course:602',
      'golfapi:us:602',
    ]);
  });

  test('duplicate ids pick the newest file, ties by path, and are reported', () => {
    pair('national/IN/a', '700', courseBody('700', { clubName: 'Old' }), coordBody('700'), 1_700_000_000);
    pair('national/MI/b', '700', courseBody('700', { clubName: 'New' }), coordBody('700'), 1_700_000_500);
    pair('z', '701', courseBody('701', { clubName: 'Z' }), coordBody('701'), 1_700_000_000);
    pair('a', '701', courseBody('701', { clubName: 'A' }), coordBody('701'), 1_700_000_000);
    const first = plan();
    const second = plan();
    assert.equal(first.bulkText, second.bulkText);
    const name = (id) => JSON.parse(JSON.parse(first.bulk.find((r) => r.key === `golfapi:permanent:course:${id}`).value).body).clubName;
    assert.equal(name('700'), 'New');
    assert.equal(name('701'), 'A');
    assert.equal(first.report.duplicates.count, 4);
    const d700 = first.report.duplicates.items.find((d) => d.id === '700' && d.kind === 'course');
    assert.equal(d700.chosen, 'national/MI/b/700.courses.json');
    assert.deepEqual(d700.others, ['national/IN/a/700.courses.json']);
  });

  test('existing key list reads plain lines or wrangler JSON', () => {
    assert.deepEqual([...parseExistingKeys('a\nb\r\n\n')], ['a', 'b']);
    assert.deepEqual([...parseExistingKeys('[{"name":"a"},{"name":"b"}]')], ['a', 'b']);
    assert.equal(parseExistingKeys('').size, 0);
  });

  test('the only remote command is the read-only key list; write commands are text only', () => {
    assert.deepEqual(LIST_REMOTE_ARGS.slice(0, 4), ['wrangler', 'kv', 'key', 'list']);
    assert.equal(LIST_REMOTE_ARGS.includes('put'), false);
    const src = readFileSync(new URL('./import-raw-pulls.mjs', import.meta.url), 'utf8');
    assert.equal((src.match(/execFileSync\(/g) || []).length, 1);
    const cmd = commands('/x/bulk.json', '/x/del.json');
    assert.match(cmd.write, /^npx wrangler kv bulk put --binding GOLFAPI_KV --remote \/x\/bulk\.json$/);
    assert.match(cmd.undo, /^npx wrangler kv bulk delete --binding GOLFAPI_KV --remote \/x\/del\.json$/);
  });

  test('main writes bulk, undo list and reports without any KV access', () => {
    pair('t', '800');
    const existing = join(dir, 'existing.txt');
    writeFileSync(existing, 'golfapi:permanent:search:x\n');
    const outDir = mkdtempSync(join(tmpdir(), 'raw-pulls-out-'));
    try {
      const logs = [];
      const log = console.log;
      console.log = (...a) => logs.push(a.join(' '));
      try {
        main(['--raw', join(dir, 't'), '--existing', existing, '--out', join(outDir, 'bulk.json'), '--report', join(outDir, 'report.json')]);
      } finally {
        console.log = log;
      }
      const bulk = JSON.parse(readFileSync(join(outDir, 'bulk.json'), 'utf8'));
      assert.equal(bulk.length, 3);
      assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'bulk.delete-keys.json'), 'utf8')).sort(), bulk.map((r) => r.key).sort());
      const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
      assert.equal(report.dryRun, true);
      assert.equal(report.keysToWrite.total, 3);
      assert.match(readFileSync(join(outDir, 'report.md'), 'utf8'), /NOT RUN/);
      assert.ok(logs.some((l) => l.startsWith('NOT RUN: npx wrangler kv bulk put')));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ---- The real Worker serves an imported envelope byte-for-byte at 0 credits. ----

class FakeKV {
  constructor(rows = []) {
    this.store = new Map(rows.map((r) => [r.key, r.value]));
    this.puts = [];
  }
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async put(key, value) {
    this.store.set(key, String(value));
    this.puts.push(key);
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix } = {}) {
    return { keys: [...this.store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
  }
}
class MemorySql {
  constructor() {
    this.map = new Map();
  }
  exec(query, ...args) {
    const text = query.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT')) {
      const value = this.map.get(args[0]);
      return value == null ? [] : [{ value }];
    }
    if (text.startsWith('INSERT')) this.map.set(args[0], String(args[1]));
    if (text.startsWith('DELETE')) this.map.delete(args[0]);
    return [];
  }
}
function counterNamespace() {
  const stub = new GolfapiCounter({ storage: { sql: new MemorySql() }, blockConcurrencyWhile: (fn) => fn() });
  return { idFromName: () => 'golfapi', get: () => ({ fetch: (input, init) => stub.fetch(input instanceof Request ? input : new Request(input, init)) }) };
}

describe('imported envelopes through the Worker', () => {
  test('course and coordinates are served from KV with the exact disk text and no golfapi call', async () => {
    pair('t', '900');
    const result = plan();
    const kv = new FakeKV(result.bulk);
    const env = {
      GOLFAPI_KEY: 'golf-secret',
      GOLFAPI_KV: kv,
      TERRAIN_KV: new FakeKV(),
      GOLFAPI_COUNTER: counterNamespace(),
      GOLFAPI_ALLOWLIST: '',
      GOLFAPI_INSTALL_DAILY_PULLS: '4',
      GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP: '20',
      GOLFAPI_DAILY_CAP: '150',
      GOLFAPI_MONTHLY_CAP: '450',
    };
    const previousFetch = globalThis.fetch;
    const previousCaches = globalThis.caches;
    const calls = [];
    globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      throw new Error('stored copy must not fetch');
    };
    try {
      for (const [path, file] of [['courses/900', '900.courses.json'], ['coordinates/900', '900.coordinates.json']]) {
        const response = await handleGolfProxy(new Request(`https://share.test/golfapi/v2.3/${path}`, {
          headers: { 'X-Install-Id': 'id_phone', 'X-ShotTraxx-Storefront': 'USA' },
        }), env);
        assert.equal(response.status, 200, path);
        assert.equal(await response.text(), readFileSync(join(dir, 't', file), 'utf8'), path);
      }
      assert.equal(calls.some((url) => url.includes('golfapi.io')), false);
      assert.equal(kv.puts.some((key) => key.startsWith('golfapi:permanent:')), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousCaches === undefined) delete globalThis.caches;
      else globalThis.caches = previousCaches;
    }
  });
});
