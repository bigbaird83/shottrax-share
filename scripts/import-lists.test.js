import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { ALWAYS_REJECT, GREENBRIAR_MI_ID, JACKSONVILLE_CC_IL_ID, allowedVerdict, bucketAllows, buildLists, findSignalFiles, main, parseValidate2km, parseValidationMarkdown } from './import-lists.mjs';

const TABLE = `# OH national golfapi pull: validation (read-only)
## Counts
| Bucket | n |
|---|---|
| **import-ready** | **2** |

### rejected (1)
- **Salem Golf Club** → Salem Hills (01214152102065792916): 6.64 km. Confirmed.

### Import-ready with notes (1)
- Hyde Park (0121000000000000003): h4 tee flag.

## Per-course table
| Course (OSM) | golfapi club (id) | Greens vs OSM | Bucket |
|---|---|---|---|
| A (way/1) | A GC (0121000000000000001) | 18/18 in | import-ready |
| B (way/2) | B GC (0121000000000000002) | 18/18 in | **trim to 9** |
| C (way/3) | C GC (0121000000000000003) | 9/18 in | import-ready |
| D (way/4) | D GC (0121000000000000004) | 0/18 in | partial |
| E (way/5) | E GC (0121000000000000005) + (0121000000000000006) | 18/18 | import-ready (fill missing only) |
| F (way/6) | F GC (0121000000000000007) | 18/18 | trim to 9, then import-ready |
| G (way/7) | G GC (0121000000000000008) | 18/18 | import-ready (fill missing only) |
`;

describe('import-lists: Signal Lab verdicts only', () => {
  test('bucketAllows takes only a clean import-ready cell', () => {
    assert.equal(bucketAllows('import-ready'), true);
    assert.equal(bucketAllows('**import-ready (fill missing only)**'), false);
    assert.equal(bucketAllows('import-ready (fill-missing only)'), false);
    assert.equal(bucketAllows('import-ready (way/419135913)'), true);
    assert.equal(bucketAllows('trim to 9, then import-ready'), false);
    assert.equal(bucketAllows('import-ready after trim'), false);
    assert.equal(bucketAllows('already pulled, import-ready via way/1'), false);
    assert.equal(bucketAllows('partial'), false);
  });

  test('table rows allow or reject by their bucket; prose never allows', () => {
    const { allow, reject } = parseValidationMarkdown(TABLE, 'OH-validation.md');
    assert.deepEqual(allow.map((a) => a.id).sort(), ['0121000000000000001', '0121000000000000003']);
    const rejected = new Set(reject.map((r) => r.id));
    // ...008 is "import-ready (fill missing only)": a hole-fill verdict, so a reject.
    for (const id of ['01214152102065792916', '0121000000000000002', '0121000000000000004', '0121000000000000005', '0121000000000000006', '0121000000000000007', '0121000000000000008']) {
      assert.ok(rejected.has(id), id);
    }
    // Prose under "Import-ready with notes" neither allows nor rejects.
    assert.equal(rejected.has('0121000000000000003'), false);
  });

  test('validate-2km: only non-accepted rows become rejects; accepted rows are not allowed', () => {
    const rows = [
      { id: '0121000000000000010', result: 'accepted' },
      { id: '0121000000000000011', result: 'REJECTED: green center 6.1 km from OSM' },
      { id: '0121000000000000012', result: 'accepted-partial greens 9/18' },
      { id: null, result: 'not found' },
    ];
    assert.deepEqual(parseValidate2km(rows, 'x').map((r) => r.id), ['0121000000000000011', '0121000000000000012']);
  });

  test('buildLists: reject wins over allow, ALWAYS_REJECT is always on, validate-2km accepted adds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'signal-'));
    try {
      mkdirSync(join(root, 'national'), { recursive: true });
      mkdirSync(join(root, 'raw/national/MI'), { recursive: true });
      writeFileSync(join(root, 'national/OH-validation.md'), TABLE);
      writeFileSync(join(root, 'national/AL-validation.md'), `| Course | id | Bucket |\n|---|---|---|\n| X | 0121000000000000001 | rejected |\n| Naples | 0121263749725147 | import-ready |\n`);
      writeFileSync(join(root, 'raw/national/MI/validate-2km.json'), JSON.stringify([{ id: '0121000000000000020', result: 'accepted' }]));
      writeFileSync(join(root, 'notes.md'), '| a | b | Bucket |\n|---|---|---|\n| x | 0121000000000000030 | import-ready |\n');
      const files = findSignalFiles(root);
      assert.equal(files.markdown.length, 2, 'only *-validation.md / *-review.md files are Signal sources');
      const lists = buildLists({ ...files, root });
      assert.deepEqual(Object.keys(lists.allow).sort(), ['0121000000000000003']);
      assert.ok(lists.reject['0121000000000000008'], 'fill missing only is rejected');
      assert.ok(lists.reject['0121000000000000001']);
      assert.ok(lists.reject['0121263749725147']);
      assert.deepEqual(lists.allowAlsoRejected, ['0121000000000000001', '0121263749725147']);
      for (const id of Object.keys(ALWAYS_REJECT)) assert.ok(lists.reject[id], id);
      assert.equal(lists.allow['0121000000000000020'], undefined);

      const out = mkdtempSync(join(tmpdir(), 'signal-out-'));
      const log = console.log;
      console.log = () => {};
      try {
        main(['--signal-root', root, '--allow-out', join(out, 'a.json'), '--reject-out', join(out, 'r.json')]);
      } finally {
        console.log = log;
        }
      const a = JSON.parse(readFileSync(join(out, 'a.json'), 'utf8'));
      const r = JSON.parse(readFileSync(join(out, 'r.json'), 'utf8'));
      assert.equal(a.kind, 'allowlist');
      assert.equal(r.kind, 'rejects');
      assert.equal(a.sources.length, 3);
      rmSync(out, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('server-cache verdicts: import-ready, partial, trim-to-9, fill-missing; reject-type words and prose never allow', () => {
    const sc = (c) => allowedVerdict(c, 'server-cache');
    assert.equal(sc('import-ready'), 'import-ready');
    assert.equal(sc('**partial**'), 'partial');
    assert.equal(sc('partial (greens only)'), 'partial');
    assert.equal(sc('partial (back-9 pars wrong)'), 'partial');
    assert.equal(sc('partial. vendor-9 copies, plus tees on the wrong hole: h3'), 'partial');
    assert.equal(sc('trim-to-9'), 'trim-to-9');
    assert.equal(sc('trim to 9, then import-ready'), 'trim-to-9');
    assert.equal(sc('import-after-trim (9; vendor 9)'), 'trim-to-9');
    assert.equal(sc('import-ready (fill missing only)'), 'fill-missing');
    assert.equal(sc('**import-ready (fill-missing only)**'), 'fill-missing');
    for (const cell of ['rejected', 'unusable', 'unusable (reject)', 'exclude (duplicate row)', 'protected/exclude', 'partial, wrong course', 'partial, excluded', 'partial (bundled on main)', 'trim-to-9 (hold)', 'partial (duplicate of the Summit)', 'partial (greens only), verify location', 'trim to 9 + h7 tee fix: do not import', 'not pulled (in worker kv)', 'already pulled, import-ready via way/1', 'one course mapped twice', 'partial (fill missing only)']) {
      assert.equal(sc(cell), null, cell);
    }
    // Default mode is unchanged: only a clean import-ready cell. Fill-missing stays out.
    assert.equal(allowedVerdict('partial'), null);
    assert.equal(allowedVerdict('trim-to-9'), null);
    assert.equal(allowedVerdict('import-ready (fill missing only)'), null);
    assert.equal(bucketAllows('import-ready (fill missing only)'), false);
    assert.equal(allowedVerdict('import-ready'), 'import-ready');
    assert.throws(() => allowedVerdict('x', 'loose'), /unknown --mode/);

    const { allow, reject } = parseValidationMarkdown(TABLE, 'OH-validation.md', 'server-cache');
    assert.deepEqual(allow.map((a) => [a.id, a.verdict]).sort(), [
      ['0121000000000000001', 'import-ready'],
      ['0121000000000000002', 'trim-to-9'],
      ['0121000000000000003', 'import-ready'],
      ['0121000000000000004', 'partial'],
      ['0121000000000000007', 'trim-to-9'],
      ['0121000000000000008', 'fill-missing'],
    ]);
    const rejected = new Set(reject.map((r) => r.id));
    // ...005/...006 are a 2-id fill-missing row, so still rejected.
    for (const id of ['01214152102065792916', '0121000000000000005', '0121000000000000006']) assert.ok(rejected.has(id), id);
    assert.equal(rejected.has('0121000000000000008'), false);
  });

  test('fill-missing is allowed in server-cache, excluded in strict, and a fill-missing plus reject row stays out', () => {
    const fill = '| Course | id | Bucket |\n|---|---|---|\n| G | 0121000000000000008 | import-ready (fill missing only) |\n| H | 0121000000000000009 | import-ready (fill missing only) |\n';
    const plusReject = '| Course | id | Bucket |\n|---|---|---|\n| H | 0121000000000000009 | rejected |\n';
    const { allow: scAllow, reject: scReject } = parseValidationMarkdown(fill, 'a-validation.md', 'server-cache');
    assert.deepEqual(scAllow.map((a) => [a.id, a.verdict]), [['0121000000000000008', 'fill-missing'], ['0121000000000000009', 'fill-missing']]);
    const { allow: defAllow, reject: defReject } = parseValidationMarkdown(fill, 'a-validation.md');
    assert.deepEqual(defAllow, []);
    assert.deepEqual(defReject.map((r) => r.id).sort(), ['0121000000000000008', '0121000000000000009']);

    const root = mkdtempSync(join(tmpdir(), 'signal-fm-'));
    try {
      mkdirSync(join(root, 'national'), { recursive: true });
      writeFileSync(join(root, 'national/A-validation.md'), fill);
      writeFileSync(join(root, 'national/B-validation.md'), plusReject);
      const server = buildLists({ ...findSignalFiles(root), root, mode: 'server-cache' });
      const strict = buildLists({ ...findSignalFiles(root), root, mode: 'default' });
      assert.equal(server.allow['0121000000000000008'][0].verdict, 'fill-missing');
      assert.equal(server.allow['0121000000000000009'], undefined);
      assert.ok(server.reject['0121000000000000009']);
      assert.deepEqual(server.allowAlsoRejected, ['0121000000000000009']);
      assert.equal(strict.allow['0121000000000000008'], undefined);
      assert.ok(strict.reject['0121000000000000008']);
      assert.ok(strict.reject['0121000000000000009']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('any verdict wording that contains unusable is REJECT in both modes', () => {
    for (const cell of ['unusable', 'partial (unusable)', 'trim to 9 - unusable', 'import-ready (unusable)', 'partial (unusablemap)', 'trim-to-9 (courseunusable)']) {
      assert.equal(allowedVerdict(cell, 'server-cache'), null, cell);
      assert.equal(allowedVerdict(cell, 'default'), null, cell);
      assert.equal(bucketAllows(cell), false, cell);
    }
    const md = `| Course | id | Bucket |\n|---|---|---|\n| U | 0121000000000000040 | partial (unusable) |\n| V | 0121000000000000041 | trim to 9 - unusable |\n| W | 0121000000000000042 | partial (unusablemap) |\n`;
    for (const mode of ['default', 'server-cache']) {
      const { allow, reject } = parseValidationMarkdown(md, 'U-validation.md', mode);
      assert.deepEqual(allow, [], mode);
      assert.deepEqual(reject.map((r) => r.id).sort(), ['0121000000000000040', '0121000000000000041', '0121000000000000042'], mode);
    }
  });

  test('server-cache lifts validate-2km accepted-partial only when Signal\'s row is partial; Greenbriar stays out', () => {
    const root = mkdtempSync(join(tmpdir(), 'signal-ap-'));
    try {
      mkdirSync(join(root, 'national'), { recursive: true });
      mkdirSync(join(root, 'raw/national/MI'), { recursive: true });
      writeFileSync(join(root, 'national/MI-validation.md'), `| Course | id | Verdict |\n|---|---|---|\n| Partial ok | 0121000000000000050 | partial (greens only) |\n| Ready not partial | 0121000000000000051 | import-ready |\n| Greenbriar | ${GREENBRIAR_MI_ID} | partial |\n| Partial plus reject | 0121000000000000052 | partial |\n`);
      writeFileSync(join(root, 'national/MI-extra-validation.md'), `| Course | id | Verdict |\n|---|---|---|\n| Partial plus reject | 0121000000000000052 | rejected |\n`);
      writeFileSync(join(root, 'raw/national/MI/validate-2km.json'), JSON.stringify([
        { id: '0121000000000000050', result: 'accepted-partial greens 9/18' },
        { id: '0121000000000000051', result: 'accepted-partial greens 9/18' },
        { id: GREENBRIAR_MI_ID, result: 'accepted-partial greens 3/18' },
        { id: '0121000000000000052', result: 'accepted-partial greens 9/18' },
        { id: '0121000000000000053', result: 'REJECTED: green center 6.1 km from OSM' },
      ]));
      const server = buildLists({ ...findSignalFiles(root), root, mode: 'server-cache' });
      const strict = buildLists({ ...findSignalFiles(root), root, mode: 'default' });
      assert.equal(server.allow['0121000000000000050'][0].verdict, 'partial');
      assert.deepEqual(server.acceptedPartialIncluded, ['0121000000000000050']);
      assert.equal(server.allow['0121000000000000051'], undefined, 'accepted-partial stays out when Signal\'s row is not partial');
      assert.ok(server.reject['0121000000000000051']);
      assert.equal(server.allow[GREENBRIAR_MI_ID], undefined);
      assert.ok(server.reject[GREENBRIAR_MI_ID], 'Greenbriar MI is hard-excluded');
      assert.equal(server.allow['0121000000000000052'], undefined, 'accepted-partial plus another reject still stays out');
      assert.ok(server.reject['0121000000000000053']);
      for (const id of ['0121000000000000050', '0121000000000000051', GREENBRIAR_MI_ID, '0121000000000000052']) {
        assert.equal(strict.allow[id], undefined, id);
        assert.ok(strict.reject[id], id);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ALWAYS_REJECT drops only Jacksonville CC IL; every other gate id stays', () => {
    assert.equal(ALWAYS_REJECT[JACKSONVILLE_CC_IL_ID], undefined);
    const expected = [
      '0121263749725147',
      '012141520689264205787',
      '012141520817542047754',
      '012141520818586616898',
      '012141521021948968089',
      '01214152102065792916',
      '012141520862542102642',
      '012141520853259289762',
      '012141520916526104341',
      '012141520954148858651',
      '0121696819121415659',
      '01214152105285044350',
      '012141520627797959416',
      '012141520788518928722',
      '012141521038540432179',
      '01214152103323769690',
      '011141520625780263856',
      '012141520629437545788',
      '011141520629948893391',
      '012141521001279406018',
    ];
    assert.deepEqual(Object.keys(ALWAYS_REJECT).sort(), expected.sort());
    const root = mkdtempSync(join(tmpdir(), 'signal-jax-'));
    try {
      mkdirSync(join(root, 'national'), { recursive: true });
      writeFileSync(join(root, 'national/IL-validation.md'), `| Course | id | Bucket |\n|---|---|---|\n| Jacksonville CC | ${JACKSONVILLE_CC_IL_ID} | import-ready |\n| Naples | 0121263749725147 | import-ready |\n`);
      const server = buildLists({ ...findSignalFiles(root), root, mode: 'server-cache' });
      const strict = buildLists({ ...findSignalFiles(root), root, mode: 'default' });
      assert.ok(server.allow[JACKSONVILLE_CC_IL_ID], 'Jacksonville CC IL can be allowed once ALWAYS_REJECT no longer names it');
      assert.ok(strict.allow[JACKSONVILLE_CC_IL_ID]);
      assert.ok(server.reject['0121263749725147']);
      assert.ok(strict.reject['0121263749725147']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no Signal Lab files is an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'signal-empty-'));
    try {
      assert.throws(() => main(['--signal-root', root, '--allow-out', join(root, 'a'), '--reject-out', join(root, 'r')]), /no Signal Lab validation files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
