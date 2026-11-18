import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

// A fixture course that passes every Oct 28 check: 18 par-4 holes, back tee
// (poi 12) 380 yd and front tee (poi 11) 340 yd from the green, matching the
// card's Blue 380 / Red 340, all within ~2.5 km of the clubhouse.
const BASE = { lat: 34.84, lng: -92.39 };
const YD = 0.9144;
function north(p, yards) {
  return { lat: p.lat + (yards * YD) / 111_320, lng: p.lng };
}
function east(p, meters) {
  return { lat: p.lat, lng: p.lng + meters / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}
function holeTee(n) {
  return east(BASE, (n - 9.5) * 250);
}
function courseBody(id, extra = {}) {
  const blue = { teeName: 'Blue' };
  const red = { teeName: 'Red' };
  for (let n = 1; n <= 18; n += 1) {
    blue[`length${n}`] = 380;
    red[`length${n}`] = 340;
  }
  return {
    apiRequestsLeft: '4498.6',
    clubName: `Club ${id}`,
    city: 'Maumelle',
    state: 'AR',
    country: 'USA',
    latitude: String(BASE.lat - 0.005),
    longitude: String(BASE.lng),
    courseID: id,
    numHoles: '18',
    hasGPS: '1',
    measure: 'y',
    parsMen: Array(18).fill(4),
    tees: [blue, red],
    ...extra,
  };
}
function holeRows(n, { backYards = 380, frontYards = 340, green = true, tees = true } = {}) {
  const back = holeTee(n);
  const g = north(back, backYards);
  const front = north(back, backYards - frontYards);
  const rows = [];
  if (green) {
    rows.push({ poi: 1, location: 1, sideFW: 2, hole: n, latitude: north(g, -10).lat, longitude: g.lng });
    rows.push({ poi: 1, location: 2, sideFW: 2, hole: n, latitude: g.lat, longitude: g.lng });
    rows.push({ poi: 1, location: 3, sideFW: 2, hole: n, latitude: north(g, 10).lat, longitude: g.lng });
  }
  if (tees) {
    rows.push({ poi: 11, location: 2, sideFW: 2, hole: n, latitude: front.lat, longitude: front.lng });
    rows.push({ poi: 12, location: 2, sideFW: 2, hole: n, latitude: back.lat, longitude: back.lng });
  }
  return rows;
}
function coordBody(id, extra = {}, holeOpts = {}) {
  const coordinates = [];
  for (let n = 1; n <= 18; n += 1) coordinates.push(...holeRows(n, holeOpts[n] || {}));
  return { apiRequestsLeft: '4497.6', courseID: id, numCoordinates: coordinates.length, coordinates, ...extra };
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
/** Every scanned id is allowlisted unless `allow` is given. */
function plan(existing = [], { allow, reject = {}, reviewEvidence } = {}) {
  const scan = scanRaw(dir);
  return planImport({
    scan,
    existing: new Set(existing),
    allow: new Set(allow ?? scan.ids.keys()),
    reject: new Map(Object.entries(reject)),
    reviewEvidence: reviewEvidence ?? new Map([...scan.ids.keys()].map((id) => [id, [{ source: 'test-validation.md', checks: { outline: 'import-ready', rightCourse: 'import-ready' } }]])),
  });
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
    assert.deepEqual([...parseExistingKeys('golfapi:a\ngolfapi:b\r\n\n')], ['golfapi:a', 'golfapi:b']);
    assert.deepEqual([...parseExistingKeys('[{"name":"golfapi:a"},{"name":"golfapi:b"}]')], ['golfapi:a', 'golfapi:b']);
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
    pair('t', '801');
    const io = cliFiles({ allow: ['800', '801'], reject: { 801: [{ source: 'x', reason: 'rejected' }] } });
    try {
      const logs = [];
      const log = console.log;
      console.log = (...a) => logs.push(a.join(' '));
      try {
        main(io.args());
      } finally {
        console.log = log;
      }
      const bulk = JSON.parse(readFileSync(io.bulk, 'utf8'));
      assert.deepEqual(bulk.map((r) => r.key).sort(), ['golfapi:permanent:coordinates:800', 'golfapi:permanent:course:800', 'golfapi:us:800']);
      assert.deepEqual(JSON.parse(readFileSync(join(io.dir, 'bulk.delete-keys.json'), 'utf8')).sort(), bulk.map((r) => r.key).sort());
      const report = JSON.parse(readFileSync(io.report, 'utf8'));
      assert.equal(report.dryRun, true);
      assert.equal(report.keysToWrite.total, 3);
      assert.equal(report.skipped.rejected, 1);
      assert.match(readFileSync(join(io.dir, 'report.md'), 'utf8'), /NOT RUN/);
      assert.ok(logs.some((l) => l.startsWith('NOT RUN: npx wrangler kv bulk put')));
    } finally {
      io.cleanup();
    }
  });
});

/** Temp allowlist / rejects / existing files and output paths for main(). */
function cliFiles({ allow = [], reject = {}, existing = 'golfapi:permanent:search:x\n' } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'raw-pulls-out-'));
  const paths = {
    dir: out,
    allowlist: join(out, 'allowlist.json'),
    rejects: join(out, 'rejects.json'),
    existing: join(out, 'existing.txt'),
    bulk: join(out, 'bulk.json'),
    report: join(out, 'report.json'),
  };
  writeFileSync(paths.allowlist, JSON.stringify({ kind: 'allowlist', ids: Object.fromEntries(allow.map((id) => [id, [{ source: 'test-validation.md', bucket: 'import-ready', checks: { outline: 'import-ready', rightCourse: 'import-ready' } }]])) }));
  writeFileSync(paths.rejects, JSON.stringify({ kind: 'rejects', ids: reject }));
  if (existing != null) writeFileSync(paths.existing, existing);
  return {
    ...paths,
    args(overrides = {}) {
      const opts = { raw: join(dir, 't'), allowlist: paths.allowlist, rejects: paths.rejects, existing: paths.existing, out: paths.bulk, report: paths.report, ...overrides };
      const argv = [];
      for (const [k, v] of Object.entries(opts)) {
        if (v === undefined) continue;
        if (v === true) argv.push(`--${k}`);
        else argv.push(`--${k}`, v);
      }
      return argv;
    },
    cleanup() {
      rmSync(out, { recursive: true, force: true });
    },
  };
}

describe('fail closed', () => {
  function assertNoOutput(io) {
    assert.equal(existsSync(io.bulk), false, 'no bulk file');
    assert.equal(existsSync(join(io.dir, 'bulk.delete-keys.json')), false, 'no undo file');
    assert.equal(existsSync(io.report), false, 'no report');
  }

  test('a missing allowlist or reject list is an error and writes nothing', () => {
    pair('t', '810');
    const io = cliFiles({ allow: ['810'] });
    try {
      assert.throws(() => main(io.args({ allowlist: undefined })), /--allowlist is required/);
      assertNoOutput(io);
      assert.throws(() => main(io.args({ allowlist: join(io.dir, 'nope.json') })), /cannot read --allowlist/);
      assertNoOutput(io);
      assert.throws(() => main(io.args({ rejects: undefined })), /--rejects is required/);
      assertNoOutput(io);
      writeFileSync(io.rejects, JSON.stringify({ kind: 'allowlist', ids: {} }));
      assert.throws(() => main(io.args()), /not an import-lists rejects file/);
      assertNoOutput(io);
    } finally {
      io.cleanup();
    }
  });

  test('a missing, empty or failed key listing is an error and writes nothing', () => {
    pair('t', '820');
    const io = cliFiles({ allow: ['820'], existing: null });
    try {
      assert.throws(() => main(io.args()), /ENOENT/);
      assertNoOutput(io);
      assert.throws(() => main(io.args({ existing: undefined })), /need --existing <file> or --list-remote/);
      assertNoOutput(io);
      // The old fail-open flag is gone: it no longer stands in for a listing.
      assert.throws(() => main(io.args({ existing: undefined, 'assume-empty-existing': true })), /need --existing/);
      assertNoOutput(io);
      writeFileSync(io.existing, '\n');
      assert.throws(() => main(io.args()), /listing is empty/);
      assertNoOutput(io);
      const failing = () => {
        throw new Error('wrangler: not authenticated');
      };
      assert.throws(() => main(io.args({ existing: undefined, 'list-remote': true }), { run: failing }), /key listing failed/);
      assertNoOutput(io);
      assert.throws(() => main(io.args({ existing: undefined, 'list-remote': true }), { run: () => '[]' }), /listing is empty/);
      assertNoOutput(io);
      assert.throws(() => main(io.args({ existing: undefined, 'list-remote': true }), { run: () => 'Not authenticated' }), /invalid key listing/);
      assertNoOutput(io);
      const calls = [];
      main(io.args({ existing: undefined, 'list-remote': true }), {
        run: (cmd, args) => {
          calls.push([cmd, ...args]);
          return '[{"name":"golfapi:permanent:search:x"}]';
        },
      });
      assert.deepEqual(calls, [['npx', ...LIST_REMOTE_ARGS]]);
      assert.equal(JSON.parse(readFileSync(io.bulk, 'utf8')).length, 3);
    } finally {
      io.cleanup();
    }
  });
});

describe('allowlist and rejects', () => {
  test('only allowlisted ids are imported; the default (empty) allowlist imports nothing', () => {
    pair('t', '830');
    pair('t', '831');
    const some = plan([], { allow: ['830'] });
    assert.deepEqual(keysOf(some), ['golfapi:permanent:coordinates:830', 'golfapi:permanent:course:830', 'golfapi:us:830']);
    assert.equal(some.report.skipped.not_allowlisted, 1);
    const none = plan([], { allow: [] });
    assert.equal(none.bulk.length, 0);
    assert.equal(none.report.skipped.not_allowlisted, 2);
  });

  test('the reject list wins over the allowlist, and ALWAYS_REJECT applies without a reject file', () => {
    pair('t', '840');
    pair('t', '0121263749725147'); // Naples Grande, in ALWAYS_REJECT
    const result = plan([], {
      allow: ['840', '0121263749725147'],
      reject: { 840: [{ source: 'OH-validation.md', reason: 'trim to 9' }] },
    });
    assert.equal(result.bulk.length, 0);
    assert.equal(result.report.skipped.rejected, 2);
    assert.deepEqual(result.report.rejectedByKind, { trim_to_9: 1, signal_gate_list: 1 });
  });
});

describe("Brian's Oct 28 checks", () => {
  function only(id, course, coords) {
    pair('t', id, course, coords);
    return plan();
  }

  test('a hole with no tee or no green fails the course', () => {
    assert.equal(only('850', courseBody('850'), coordBody('850', {}, { 7: { tees: false } })).report.skipped.oct28_missing_tee_or_green, 1);
    rmSync(join(dir, 't'), { recursive: true });
    assert.equal(only('851', courseBody('851'), coordBody('851', {}, { 18: { green: false } })).report.skipped.oct28_missing_tee_or_green, 1);
  });

  test('a 9-hole course must have every hole 1-9, and an 18 every hole 1-18', () => {
    const nine = courseBody('852', { numHoles: '9' });
    const result = only('852', nine, coordBody('852'));
    assert.equal(result.report.valid, 1);
    rmSync(join(dir, 't'), { recursive: true });
    const short = coordBody('853');
    short.coordinates = short.coordinates.filter((r) => r.hole <= 17);
    assert.equal(only('853', courseBody('853'), short).report.skipped.oct28_missing_tee_or_green, 1);
  });

  test('a tee more than 15% off the card fails; inside 15% passes', () => {
    // 380-yd card, back tee measured 450 yd (18% long), front tee still fits Red.
    const off = only('860', courseBody('860'), coordBody('860', {}, { 3: { backYards: 450, frontYards: 340 } }));
    assert.equal(off.report.skipped.oct28_card_yards_15pct, 1);
    assert.equal(off.report.checkFailures.oct28_card_yards_15pct[0].hole, 3);
    rmSync(join(dir, 't'), { recursive: true });
    const near = only('861', courseBody('861'), coordBody('861', {}, { 3: { backYards: 420, frontYards: 340 } }));
    assert.equal(near.report.valid, 1);
  });

  test('hole length must fit par (par 3 over 280 yd, par 5 under 380 yd)', () => {
    const par3 = courseBody('870', { parsMen: [3, ...Array(17).fill(4)] });
    assert.equal(only('870', par3, coordBody('870')).report.skipped.oct28_par_length, 1);
    rmSync(join(dir, 't'), { recursive: true });
    const noPar = courseBody('871', { parsMen: [0, ...Array(17).fill(4)] });
    assert.equal(only('871', noPar, coordBody('871')).report.skipped.oct28_par_missing, 1);
  });

  test('outline and right-course need Signal import-ready evidence, not a bare id', () => {
    pair('t', '880');
    const outlineMissing = plan([], { reviewEvidence: new Map() });
    assert.equal(outlineMissing.bulk.length, 0);
    assert.equal(outlineMissing.report.skipped.oct28_outline_unverified, 1);
    const identityMissing = plan([], { reviewEvidence: new Map([['880', [{ source: 'test-validation.md', checks: { outline: 'import-ready' } }]]]) });
    assert.equal(identityMissing.bulk.length, 0);
    assert.equal(identityMissing.report.skipped.oct28_right_course_unverified, 1);
    const signalPass = plan();
    assert.equal(signalPass.report.valid, 1);
    assert.equal(signalPass.report.acceptedEvidence['880'][0].source, 'test-validation.md');
  });

  test('a tee-to-green span outside 5-700 yd fails', () => {
    const span = courseBody('885');
    for (const t of span.tees) t.length4 = 0; // no card yardage on hole 4, so only the span rule applies
    assert.equal(only('885', span, coordBody('885', {}, { 4: { backYards: 900, frontYards: 860 } })).report.skipped.oct28_tee_green_span, 1);
  });

  test('a back nine copied onto the front nine is trim_to_9 and is excluded, not trimmed', () => {
    const copied = coordBody('890');
    const front = copied.coordinates.filter((r) => r.hole <= 9);
    copied.coordinates = [...front, ...front.map((r) => ({ ...r, hole: r.hole + 9 }))];
    const result = only('890', courseBody('890'), copied);
    assert.equal(result.report.skipped.trim_to_9, 1);
    assert.equal(result.bulk.length, 0);
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
