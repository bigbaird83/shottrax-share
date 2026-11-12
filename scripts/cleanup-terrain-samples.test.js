import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'vitest';
import {
  formatTerrainSampleCleanup,
  runTerrainSampleCleanup,
} from './cleanup-terrain-samples.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const OLD = 'terrain:samples:id_old:2026-10-22';
const TODAY = 'terrain:samples:id_today:2026-10-24';
const YESTERDAY = 'terrain:samples:id_yest:2026-10-23';
const EXACT = 'terrain:samples:id_exact:2026-10-22';
const UNPARSED = 'terrain:samples:id_bad:not-a-day';
const BLOB = 'terrain:v1:pebble:1:hash';

function memoryStore(seed) {
  const rows = new Map(seed);
  const deleted = [];
  return {
    rows,
    deleted,
    async list() {
      return {
        keys: [...rows.keys()].map((name) => ({ name })),
        list_complete: true,
      };
    },
    async delete(key) {
      deleted.push(key);
      rows.delete(key);
    },
  };
}

function assertCountsOnly(text) {
  assert.equal(text.includes('id_old'), false);
  assert.equal(text.includes('id_today'), false);
  assert.equal(text.includes('id_yest'), false);
  assert.equal(text.includes('id_exact'), false);
  assert.equal(text.includes('id_bad'), false);
  assert.equal(text.includes(BLOB), false);
  assert.match(text, /prefix=terrain:samples:/);
}

describe('terrain sample cleanup', () => {
  test('an old no-expiry counter gets deleted and the current day is kept', async () => {
    const store = memoryStore([
      [OLD, '9'],
      [TODAY, '2'],
      [YESTERDAY, '1'],
      [UNPARSED, '1'],
      [BLOB, '{}'],
    ]);
    const result = await runTerrainSampleCleanup(
      ['--binding', 'GOLFAPI_KV', '--local', '--apply'],
      { store, now: NOW },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.dryRun, false);
    assert.equal(result.summary.deleted, 1);
    assert.equal(result.summary.expired, 1);
    assert.equal(result.summary.kept, 2);
    assert.equal(result.summary.unparsed, 1);
    assert.equal(result.summary.listed, 4);
    assert.equal(store.rows.has(OLD), false);
    assert.equal(store.rows.get(TODAY), '2');
    assert.equal(store.rows.get(YESTERDAY), '1');
    assert.equal(store.rows.get(UNPARSED), '1');
    assert.equal(store.rows.get(BLOB), '{}');
    assert.deepEqual(store.deleted, [OLD]);
    assertCountsOnly(result.message);
    assert.equal(JSON.stringify(result.summary).includes('id_'), false);
  });

  test('dry-run deletes nothing', async () => {
    const store = memoryStore([
      [OLD, '9'],
      [TODAY, '2'],
    ]);
    const result = await runTerrainSampleCleanup(
      ['--binding', 'GOLFAPI_KV', '--remote'],
      { store, now: NOW },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.dryRun, true);
    assert.equal(result.summary.expired, 1);
    assert.equal(result.summary.deleted, 0);
    assert.equal(store.deleted.length, 0);
    assert.equal(store.rows.get(OLD), '9');
    assert.equal(store.rows.get(TODAY), '2');
    assert.match(result.message, /dryRun=true/);
    assert.match(result.message, /deleted=0/);
    assertCountsOnly(result.message);
  });

  test('a day that started exactly 48h ago is kept', async () => {
    const now = Date.parse('2026-10-24T00:00:00.000Z');
    const store = memoryStore([[EXACT, '3']]);
    const result = await runTerrainSampleCleanup(
      ['--binding', 'GOLFAPI_KV', '--local', '--apply'],
      { store, now },
    );
    assert.equal(result.summary.expired, 0);
    assert.equal(result.summary.deleted, 0);
    assert.equal(store.rows.has(EXACT), true);
    const later = await runTerrainSampleCleanup(
      ['--binding', 'GOLFAPI_KV', '--local', '--apply'],
      { store, now: now + 1 },
    );
    assert.equal(later.summary.deleted, 1);
    assert.equal(store.rows.has(EXACT), false);
    assertCountsOnly(later.message);
  });

  test('a paged list still keeps the current day and drops the old one', async () => {
    const rows = new Map([
      [OLD, '4'],
      [TODAY, '1'],
    ]);
    const deleted = [];
    const store = {
      async list({ cursor } = {}) {
        if (!cursor) {
          return { keys: [{ name: OLD }], list_complete: false, cursor: 'page-2' };
        }
        return { keys: [{ name: TODAY }], list_complete: true };
      },
      async delete(key) {
        deleted.push(key);
        rows.delete(key);
      },
    };
    const result = await runTerrainSampleCleanup(
      ['--binding', 'GOLFAPI_KV', '--local', '--apply'],
      { store, now: NOW },
    );
    assert.equal(result.summary.listed, 2);
    assert.deepEqual(deleted, [OLD]);
    assert.equal(rows.has(TODAY), true);
    assertCountsOnly(result.message);
  });

  test('apply without --remote or --local deletes nothing', async () => {
    const store = memoryStore([[OLD, '9']]);
    const result = await runTerrainSampleCleanup(
      ['--binding', 'GOLFAPI_KV', '--apply'],
      { store, now: NOW },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(store.deleted.length, 0);
    assert.equal(store.rows.has(OLD), true);
    assert.equal(result.message.includes(OLD), false);
  });

  test('no binding is a dry-run usage note and does not list', async () => {
    let listed = false;
    const store = {
      async list() {
        listed = true;
        return { keys: [], list_complete: true };
      },
      async delete() {
        throw new Error('must not delete');
      },
    };
    const result = await runTerrainSampleCleanup([], { store, now: NOW });
    assert.equal(result.exitCode, 0);
    assert.equal(listed, false);
    assert.match(result.message, /Dry-run is the default/);
    assert.match(result.message, /Brian's OK/);
    assert.equal(result.message.includes('id_'), false);
  });

  test('the summary formatter has no key material', () => {
    const line = formatTerrainSampleCleanup({
      prefix: 'terrain:samples:',
      listed: 2,
      expired: 1,
      kept: 1,
      unparsed: 0,
      deleted: 0,
      dryRun: true,
    });
    assert.equal(line, 'prefix=terrain:samples: listed=2 expired=1 kept=1 unparsed=0 deleted=0 dryRun=true');
  });

  test('the cleanup script is not imported by the Worker entry or the proxy', () => {
    const entry = readFileSync(new URL('../entry.js', import.meta.url), 'utf8');
    const proxy = readFileSync(new URL('../golf-proxy.js', import.meta.url), 'utf8');
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    assert.equal(entry.includes('cleanup-terrain-samples'), false);
    assert.equal(proxy.includes('cleanup-terrain-samples'), false);
    assert.equal(toml.includes('cleanup-terrain-samples'), false);
  });
});
