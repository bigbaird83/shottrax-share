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
import { buildLists, findSignalFiles } from './import-lists.mjs';

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

  test('a duplicate id across folders is emitted once when copies differ only in apiRequestsLeft', () => {
    pair('national/IN/a', '700', courseBody('700', { apiRequestsLeft: '10.0' }), coordBody('700', { apiRequestsLeft: '9.0' }), 1_700_000_000);
    pair('national/MI/b', '700', courseBody('700', { apiRequestsLeft: '8.0' }), coordBody('700', { apiRequestsLeft: '7.0' }), 1_700_000_500);
    pair('z', '701', courseBody('701'), coordBody('701'), 1_700_000_000);
    pair('a', '701', courseBody('701'), coordBody('701'), 1_700_000_000);
    const first = plan();
    const second = plan();
    assert.equal(first.bulkText, second.bulkText);
    assert.deepEqual(keysOf(first), [
      'golfapi:permanent:coordinates:700',
      'golfapi:permanent:coordinates:701',
      'golfapi:permanent:course:700',
      'golfapi:permanent:course:701',
      'golfapi:us:700',
      'golfapi:us:701',
    ]);
    const credits = (id) => JSON.parse(JSON.parse(first.bulk.find((r) => r.key === `golfapi:permanent:course:${id}`).value).body).apiRequestsLeft;
    assert.equal(credits('700'), '8.0', 'newest copy');
    assert.equal(first.report.duplicates.count, 4);
    const d700 = first.report.duplicates.items.find((d) => d.id === '700' && d.kind === 'course');
    assert.equal(d700.chosen, 'national/MI/b/700.courses.json');
    assert.deepEqual(d700.others, ['national/IN/a/700.courses.json']);
  });

  test('duplicate copies that differ beyond apiRequestsLeft are a hard error', () => {
    pair('national/IN/a', '710', courseBody('710', { clubName: 'Old' }));
    pair('national/MI/b', '710', courseBody('710', { clubName: 'New' }));
    assert.throws(() => plan(), /duplicate course bodies for 710 differ beyond apiRequestsLeft/);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const moved = coordBody('711');
    moved.coordinates[0].latitude += 0.0001;
    pair('national/IN/a', '711', courseBody('711'), coordBody('711'));
    pair('national/MI/b', '711', courseBody('711'), moved);
    assert.throws(() => plan(), /duplicate coordinates bodies for 711/);
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

  test('15% is hole-level: one good tee passes the hole, every tee off fails it', () => {
    // Back tee 450 yd (18% over Blue 380, 32% over Red 340); front tee 340 fits Red.
    const oneGood = only('860', courseBody('860'), coordBody('860', {}, { 3: { backYards: 450, frontYards: 340 } }));
    assert.equal(oneGood.report.valid, 1);
    rmSync(join(dir, 't'), { recursive: true });
    // Both tees more than 15% off every card yardage (back 460, front 200 vs 380 / 340).
    const allOff = only('861', courseBody('861'), coordBody('861', {}, { 3: { backYards: 460, frontYards: 200 }, 7: { backYards: 470, frontYards: 190 } }));
    assert.equal(allOff.report.skipped.oct28_card_yards_15pct, 1);
    const fail = allOff.report.checkFailures.oct28_card_yards_15pct[0];
    assert.deepEqual(fail.holes.map((h) => h.hole), [3, 7]);
    const measured = Object.fromEntries(fail.holes[0].tees.map((t) => [t.role, t.yards]));
    assert.ok(Math.abs(measured.back - 460) <= 2 && Math.abs(measured.front - 200) <= 2, JSON.stringify(measured));
    assert.deepEqual(fail.holes[0].card, [{ name: 'Blue', yards: 380 }, { name: 'Red', yards: 340 }]);
    rmSync(join(dir, 't'), { recursive: true });
    // Single-tee hole: only the back tee exists and it is 18% off.
    const lone = coordBody('862');
    lone.coordinates = lone.coordinates.filter((r) => !(r.hole === 5 && r.poi === 11));
    for (const r of lone.coordinates) if (r.hole === 5 && r.poi === 12) r.latitude -= (70 * 0.9144) / 111_320;
    assert.equal(only('862', courseBody('862'), lone).report.skipped.oct28_card_yards_15pct, 1);
  });

  test('card yardage is read for the same hole number (length1 is hole 1)', () => {
    const card = courseBody('865', { parsMen: [3, ...Array(17).fill(4)] });
    card.tees[0].length1 = 160;
    card.tees[1].length1 = 130;
    const coords = coordBody('865', {}, { 1: { backYards: 160, frontYards: 130 } });
    assert.equal(only('865', card, coords).report.valid, 1);
  });

  test('2-tee order rule: a swapped back/front pair fails even when both fit', () => {
    // Hole 2 card Blue 400 / Red 300; the 400-yd point is labelled front and the 300-yd point back.
    const card = courseBody('863');
    card.tees[0].length2 = 400;
    card.tees[1].length2 = 300;
    const inOrder = coordBody('863', {}, { 2: { backYards: 400, frontYards: 300 } });
    assert.equal(only('863', card, inOrder).report.valid, 1);
    rmSync(join(dir, 't'), { recursive: true });
    const swapped = coordBody('863', {}, { 2: { backYards: 400, frontYards: 300 } });
    for (const r of swapped.coordinates) if (r.hole === 2 && (r.poi === 11 || r.poi === 12)) r.poi = r.poi === 11 ? 12 : 11;
    assert.equal(only('863', card, swapped).report.skipped.oct28_card_yards_15pct, 1);
  });

  test('report.md lists failing holes with measured and card yards', () => {
    pair('t', '864', courseBody('864'), coordBody('864', {}, { 3: { backYards: 460, frontYards: 200 } }));
    const io = cliFiles({ allow: ['864'] });
    try {
      const log = console.log;
      console.log = () => {};
      try {
        main(io.args());
      } finally {
        console.log = log;
      }
      const md = readFileSync(join(io.dir, 'report.md'), 'utf8');
      assert.match(md, /## 15% card-yardage failures by course/);
      assert.match(md, /- 864 Club 864: 1 failing hole\(s\)/);
      assert.match(md, /h3: measured (front 2\d\d, back 4\d\d|back 4\d\d, front 2\d\d) yd; card Blue 380, Red 340/);
    } finally {
      io.cleanup();
    }
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

// ---- --mode server-cache (Brian, Nov 17 2026) through the real list builder. ----

const SC = {
  ready: '0129000000000000001',
  partialPar: '0129000000000000002',
  trim: '0129000000000000003',
  readyCardFail: '0129000000000000004',
  noTee: '0129000000000000005',
  readyNoTee: '0129000000000000006',
  zeroGps: '0129000000000000007',
  missingPair: '0129000000000000008',
  noGreens: '0129000000000000009',
  rejected: '0129000000000000010',
  unusable: '0129000000000000011',
  conflict: '0129000000000000012',
  fillMissing: '0129000000000000013',
  wrongCourse: '0129000000000000014',
  twoIdA: '0129000000000000015',
  twoIdB: '0129000000000000016',
  unreviewed: '0129000000000000017',
  halfStored: '0129000000000000018',
  prose: '0129000000000000019',
  km2: '0129000000000000020',
  excluded: '0129000000000000021',
  errorBody: '0129000000000000022',
};
const SC_TABLE = `# ZZ national golfapi pull: validation
## Per-course table
| Course (OSM) | golfapi club / course, city | golfapi id | Verdict |
|---|---|---|---|
| A | A GC | ${SC.ready} | import-ready |
| B | B GC | ${SC.partialPar} | partial (back-9 pars wrong) |
| C | C GC | ${SC.trim} | trim-to-9 |
| D | D GC | ${SC.readyCardFail} | import-ready |
| E | E GC | ${SC.noTee} | partial (greens only) |
| F | F GC | ${SC.readyNoTee} | import-ready |
| G | G GC | ${SC.zeroGps} | partial |
| H | H GC | ${SC.missingPair} | partial |
| I | I GC | ${SC.noGreens} | import-after-trim (9) |
| J | J GC | ${SC.rejected} | rejected |
| K | K GC | ${SC.unusable} | unusable |
| L | L GC | ${SC.conflict} | partial |
| M | M GC | ${SC.fillMissing} | import-ready (fill missing only) |
| N | N GC | ${SC.wrongCourse} | partial, wrong course |
| O | O GC | ${SC.twoIdA} + ${SC.twoIdB} | partial |
| P | P GC | ${SC.halfStored} | partial |
| Q | Q GC | ${SC.km2} | partial |
| R | R GC | ${SC.excluded} | exclude (duplicate row) |
| S | S GC | ${SC.errorBody} | partial |

### Partial courses
- ${SC.prose}: partial, greens look fine.
`;
const SC_CONFLICT = `| Course | id | Bucket |\n|---|---|---|\n| L again | ${SC.conflict} | rejected |\n`;

function serverCacheFixture() {
  const root = join(dir, 'signal');
  mkdirSync(join(root, 'national'), { recursive: true });
  mkdirSync(join(root, 'raw/national/ZZ'), { recursive: true });
  writeFileSync(join(root, 'national/ZZ-validation.md'), SC_TABLE);
  writeFileSync(join(root, 'national/ZZ-older-validation.md'), SC_CONFLICT);
  writeFileSync(join(root, 'raw/national/ZZ/validate-2km.json'), JSON.stringify([{ id: SC.km2, result: 'REJECTED: green center 6.1 km from OSM' }]));

  const copiedNine = coordBody(SC.trim);
  const front = copiedNine.coordinates.filter((r) => r.hole <= 9);
  copiedNine.coordinates = [...front, ...front.map((r) => ({ ...r, hole: r.hole + 9 }))];
  const allHoles = (opts) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i + 1, opts]));
  const longCard = courseBody(SC.readyCardFail);
  for (const t of longCard.tees) for (let n = 1; n <= 18; n += 1) t[`length${n}`] = 600;

  pair('raw', SC.ready);
  pair('raw', SC.partialPar, courseBody(SC.partialPar, { parsMen: [3, ...Array(17).fill(4)] }));
  pair('raw', SC.trim, courseBody(SC.trim), copiedNine);
  pair('raw', SC.readyCardFail, longCard);
  pair('raw', SC.noTee, courseBody(SC.noTee), coordBody(SC.noTee, {}, allHoles({ tees: false })));
  pair('raw', SC.readyNoTee, courseBody(SC.readyNoTee), coordBody(SC.readyNoTee, {}, allHoles({ tees: false })));
  pair('raw', SC.zeroGps, courseBody(SC.zeroGps, { hasGPS: '0' }));
  put(`raw/${SC.missingPair}.courses.json`, pyText(courseBody(SC.missingPair)));
  pair('raw', SC.noGreens, courseBody(SC.noGreens), coordBody(SC.noGreens, {}, allHoles({ green: false })));
  pair('raw', SC.errorBody, courseBody(SC.errorBody, { error: 'Course not found' }));
  for (const id of ['rejected', 'unusable', 'conflict', 'fillMissing', 'wrongCourse', 'twoIdA', 'twoIdB', 'unreviewed', 'halfStored', 'prose', 'km2', 'excluded']) pair('raw', SC[id]);
  return root;
}
function planMode(mode, existing = []) {
  const root = join(dir, 'signal');
  const lists = buildLists({ ...findSignalFiles(root), root, mode });
  const result = planImport({
    scan: scanRaw(join(dir, 'raw')),
    existing: new Set(existing),
    allow: new Set(Object.keys(lists.allow)),
    reject: new Map(Object.entries(lists.reject)),
    reviewEvidence: new Map(Object.entries(lists.allow)),
    mode,
  });
  return { lists, result, ids: new Set(result.bulk.map((r) => r.key.split(':').pop())) };
}

describe('--mode server-cache', () => {
  test('partial, trim-to-9, Oct 28 failures and no-tee courses are written in server-cache mode only', () => {
    serverCacheFixture();
    const server = planMode('server-cache');
    const strict = planMode('default');
    const included = [SC.ready, SC.partialPar, SC.trim, SC.readyCardFail, SC.noTee, SC.readyNoTee, SC.halfStored];
    assert.deepEqual([...server.ids].sort(), included.sort());
    assert.deepEqual([...strict.ids], [SC.ready], 'default mode is the strict #66 behavior');
    assert.equal(strict.result.report.skipped.trim_to_9, undefined, 'the default list never even allows the trim row');
    assert.equal(strict.result.report.skipped.coordinates_no_usable_map, 1, 'default keeps the no-tee skip (import-ready no-tee row)');
    assert.equal(strict.result.report.skipped.oct28_card_yards_15pct, 1);
    assert.deepEqual(server.result.report.writtenByVerdict, { 'import-ready': 3, partial: 3, 'trim-to-9': 1 });
    assert.deepEqual(server.result.report.noTeeIncluded.map((r) => r.id).sort(), [SC.noTee, SC.readyNoTee]);
    assert.equal(server.result.report.skipped.oct28_card_yards_15pct, undefined);
  });

  test('trim-to-9 bodies are stored byte-identical, not trimmed', () => {
    serverCacheFixture();
    const { result } = planMode('server-cache');
    for (const kind of ['courses', 'coordinates']) {
      const disk = readFileSync(join(dir, `raw/${SC.trim}.${kind}.json`), 'utf8');
      const key = `golfapi:permanent:${kind === 'courses' ? 'course' : 'coordinates'}:${SC.trim}`;
      assert.equal(JSON.parse(result.bulk.find((r) => r.key === key).value).body, disk);
    }
  });

  test('zero GPS, missing pair, no greens and error bodies stay out', () => {
    serverCacheFixture();
    const { result, ids } = planMode('server-cache');
    for (const id of [SC.zeroGps, SC.missingPair, SC.noGreens, SC.errorBody]) assert.equal(ids.has(id), false, id);
    assert.equal(result.report.skipped.zero_gps, 1);
    assert.equal(result.report.skipped.missing_pair, 1);
    assert.equal(result.report.skipped.coordinates_no_usable_map, 1);
    assert.equal(result.report.skipped.error_field, 1);
  });

  test('rejected, unusable, excluded, conflict, fill-missing, 2-id, prose, validate-2km and unreviewed ids stay out', () => {
    serverCacheFixture();
    const { lists, result, ids } = planMode('server-cache');
    for (const id of ['rejected', 'unusable', 'excluded', 'conflict', 'fillMissing', 'wrongCourse', 'twoIdA', 'twoIdB', 'prose', 'km2', 'unreviewed']) {
      assert.equal(ids.has(SC[id]), false, id);
    }
    assert.ok(lists.allowAlsoRejected.includes(SC.conflict), 'an id on an allow-type and a reject-type row is conflict-blocked');
    assert.ok(lists.allowAlsoRejected.includes(SC.km2));
    assert.deepEqual(lists.fillMissing, [SC.fillMissing]);
    assert.equal(lists.allow[SC.prose], undefined, 'prose never allows');
    assert.equal(lists.reject[SC.prose], undefined, 'a trim/partial word in prose no longer rejects');
    assert.equal(result.report.skipped.not_allowlisted, 2, 'prose id and the unreviewed id');
  });

  test('an existing key is never rewritten', () => {
    serverCacheFixture();
    const stored = [`golfapi:permanent:course:${SC.halfStored}`, `golfapi:permanent:course:${SC.ready}`, `golfapi:permanent:coordinates:${SC.ready}`, `golfapi:us:${SC.ready}`];
    const { result } = planMode('server-cache', stored);
    const keys = new Set(result.bulk.map((r) => r.key));
    for (const key of stored) assert.equal(keys.has(key), false, key);
    assert.equal(result.report.skipped.already_stored, 1);
    // halfStored has its course stored: only coordinates and the US marker are written.
    assert.deepEqual([...keys].filter((k) => k.endsWith(SC.halfStored)).sort(), [`golfapi:permanent:coordinates:${SC.halfStored}`, `golfapi:us:${SC.halfStored}`]);
  });

  test('main refuses lists built for the other mode', () => {
    pair('t', '0129000000000000099');
    const io = cliFiles({ allow: ['0129000000000000099'] });
    try {
      assert.throws(() => main(io.args({ mode: 'server-cache' })), /built for mode default, not server-cache/);
      const scList = { kind: 'allowlist', mode: 'server-cache', ids: { '0129000000000000099': [{ source: 'x-validation.md', verdict: 'partial' }] } };
      writeFileSync(io.allowlist, JSON.stringify(scList));
      assert.throws(() => main(io.args()), /built for mode server-cache, not default/);
      writeFileSync(io.rejects, JSON.stringify({ kind: 'rejects', mode: 'server-cache', ids: {} }));
      assert.throws(() => main(io.args({ mode: 'bogus' })), /unknown --mode bogus/);
      const log = console.log;
      console.log = () => {};
      try {
        main(io.args({ mode: 'server-cache' }));
      } finally {
        console.log = log;
      }
      const report = JSON.parse(readFileSync(io.report, 'utf8'));
      assert.equal(report.mode, 'server-cache');
      assert.deepEqual(report.writtenByVerdict, { partial: 1 });
      // A server-cache allowlist row without a Signal verdict is not imported.
      writeFileSync(io.allowlist, JSON.stringify({ ...scList, ids: { '0129000000000000099': [{ source: 'x-validation.md' }] } }));
      console.log = () => {};
      try {
        main(io.args({ mode: 'server-cache' }));
      } finally {
        console.log = log;
      }
      const noVerdict = JSON.parse(readFileSync(io.report, 'utf8'));
      assert.equal(noVerdict.keysToWrite.total, 0);
      assert.equal(noVerdict.skipped.no_signal_verdict, 1);
    } finally {
      io.cleanup();
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
