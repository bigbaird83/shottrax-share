/**
 * Finished course-card store. MOCK holes only. No golfapi request is made.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { handleGolfProxy } from './golf-proxy.js';
import { resetCourseCardInflightForTests } from './course-card.js';

class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
}

/** MOCK. About 401 yd north of the green, inside a small outline. */
function mockCard(extra = {}) {
  return {
    source: 'golfapi',
    count: 1,
    holes: [
      {
        hole: 1,
        tee: { lat: 35.523295, lng: -92.04 },
        green: { lat: 35.52, lng: -92.04 },
        par: 4,
        yards: 401,
      },
    ],
    outline: [
      [35.51, -92.05],
      [35.51, -92.03],
      [35.53, -92.03],
      [35.53, -92.05],
    ],
    ...extra,
  };
}

function env() {
  return { GOLFAPI_KV: new FakeKV(), ALERT_ADMIN_TOKEN: 'mock-admin-token' };
}

async function call(path, init, live) {
  const response = await handleGolfProxy(
    new Request(`https://worker.test${path}`, init),
    live,
    {},
  );
  const body = await response.json();
  return { status: response.status, body };
}

test('a passing MOCK card is stored, the second read costs 0 credits, and golfapi is not called', async () => {
  resetCourseCardInflightForTests();
  const live = env();
  const put = await call('/course-card/v1/mock-course', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mockCard()),
  }, live);
  assert.equal(put.status, 200);
  assert.equal(put.body.published, true);
  assert.equal(put.body.credits, 0);
  const again = await call('/course-card/v1/mock-course', { method: 'GET' }, live);
  assert.equal(again.status, 200);
  assert.equal(again.body.credits, 0);
  assert.equal(again.body.mapped, true);
  assert.equal(again.body.card.holes[0].tee.lat, 35.523295);
  assert.equal([...live.GOLFAPI_KV.store.keys()].some((key) => key.startsWith('golfapi:')), false);
});

test('a bundled, hand-pinned, or guarded MOCK course is refused and not stored', async () => {
  resetCourseCardInflightForTests();
  for (const flag of ['bundled', 'handPinned', 'guarded']) {
    const live = env();
    const put = await call('/course-card/v1/mock-guard', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mockCard({ [flag]: true })),
    }, live);
    assert.equal(put.status, 409, flag);
    assert.equal(put.body.reason, 'hash-ok', flag);
    assert.equal(put.body.credits, 0, flag);
    assert.equal(live.GOLFAPI_KV.store.has('course-card:v1:mock-guard'), false, flag);
  }
});

test('hidden serves Not mapped yet and revert serves the previous version', async () => {
  resetCourseCardInflightForTests();
  const live = env();
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Token': 'mock-admin-token' };
  await call('/course-card/v1/mock-flag', {
    method: 'PUT',
    headers,
    body: JSON.stringify(mockCard()),
  }, live);
  await call('/course-card/v1/mock-flag', {
    method: 'PUT',
    headers,
    body: JSON.stringify(mockCard({
      holes: [{
        hole: 1,
        tee: { lat: 35.523295, lng: -92.04 },
        green: { lat: 35.52, lng: -92.04 },
        par: 4,
        yards: 390,
      }],
    })),
  }, live);
  const hidden = await call('/course-card/v1/mock-flag/flag', {
    method: 'POST',
    headers,
    body: JSON.stringify({ flag: 'hidden' }),
  }, live);
  assert.equal(hidden.body.message, 'Not mapped yet');
  const open = await call('/course-card/v1/mock-flag', { method: 'GET' }, live);
  assert.equal(open.body.mapped, false);
  assert.equal(open.body.message, 'Not mapped yet');
  const revert = await call('/course-card/v1/mock-flag/flag', {
    method: 'POST',
    headers,
    body: JSON.stringify({ flag: 'revert' }),
  }, live);
  assert.equal(revert.body.reverted, true);
  assert.equal(revert.body.card.holes[0].yards, 401);
  const noToken = await call('/course-card/v1/mock-flag/flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag: 'hidden' }),
  }, live);
  assert.equal(noToken.status, 401);
});

test('two PUTs of one MOCK course share one write', async () => {
  resetCourseCardInflightForTests();
  const live = env();
  const init = {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mockCard()),
  };
  const [a, b] = await Promise.all([
    call('/course-card/v1/mock-race', init, live),
    call('/course-card/v1/mock-race', init, live),
  ]);
  assert.equal(a.body.published, true);
  assert.equal(b.body.published, true);
  const stored = JSON.parse(live.GOLFAPI_KV.store.get('course-card:v1:mock-race'));
  assert.equal(stored.versions.length, 1);
});

test('a 64-character course id is stored and a 65-character id is rejected', async () => {
  resetCourseCardInflightForTests();
  const live = env();
  const init = (id) => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mockCard()),
  });
  const okId = 'a'.repeat(64);
  const put = await call(`/course-card/v1/${okId}`, init(okId), live);
  assert.equal(put.status, 200);
  assert.equal(put.body.published, true);
  assert.equal(live.GOLFAPI_KV.store.has(`course-card:v1:${okId}`), true);
  const badId = 'b'.repeat(65);
  const rejected = await call(`/course-card/v1/${badId}`, init(badId), live);
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body, { error: 'bad_id' });
  assert.equal(live.GOLFAPI_KV.store.has(`course-card:v1:${badId}`), false);
});

function countedHoles(n) {
  return Array.from({ length: n }, (_, i) => ({
    hole: i + 1,
    tee: { lat: 35.523295, lng: -92.04 + i * 0.0001 },
    green: { lat: 35.52, lng: -92.04 + i * 0.0001 },
    par: 4,
    yards: 401,
  }));
}

test('a card count of 36 is published and 37 is rejected', async () => {
  resetCourseCardInflightForTests();
  const live = env();
  const put = await call('/course-card/v1/count-36', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mockCard({ count: 36, holes: countedHoles(36) })),
  }, live);
  assert.equal(put.status, 200);
  assert.equal(put.body.published, true);
  const over = await call('/course-card/v1/count-37', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mockCard({ count: 37, holes: countedHoles(1) })),
  }, live);
  assert.equal(over.status, 400);
  assert.deepEqual(over.body, { error: 'bad_count' });
  assert.equal(live.GOLFAPI_KV.store.has('course-card:v1:count-37'), false);
});

test('the digest lists the MOCK course published in this window', async () => {
  resetCourseCardInflightForTests();
  const live = env();
  await call('/course-card/v1/mock-digest', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mockCard()),
  }, live);
  const denied = await call('/admin/greens-no-tees-digest', { method: 'GET' }, live);
  assert.equal(denied.status, 401);
  const digest = await call('/admin/greens-no-tees-digest', {
    method: 'GET',
    headers: { 'X-Admin-Token': 'mock-admin-token' },
  }, live);
  assert.equal(digest.status, 200);
  assert.equal(digest.body.credits, 0);
  assert.equal(digest.body.published, 1);
  assert.deepEqual(digest.body.courses, ['mock-digest']);
});
