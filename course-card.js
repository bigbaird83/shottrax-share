/**
 * Finished course card on the Worker. The first phone that passes the checks
 * writes it; every later read is this KV row and costs 0 golfapi credits.
 * Bundled, hand-pinned, and guarded courses are not written (hash-OK).
 * No golfapi call lives here.
 */
import {
  appendCardVersion,
  buildDailyDigest,
  liveCardPublishVerdict,
  readServedCard,
  setCardFlag,
} from './src/course/greensNoTeesPull.mjs';

const PREFIX = 'course-card:v1:';
const DIGEST_KEY = 'course-card:digest';
const COURSE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const inflight = new Map();

export function resetCourseCardInflightForTests() {
  inflight.clear();
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers ?? {}) },
  });
}

function kvOf(env) {
  return env?.GOLFAPI_KV ?? null;
}

function tokenOk(request, env) {
  const expected = typeof env?.ALERT_ADMIN_TOKEN === 'string' ? env.ALERT_ADMIN_TOKEN.trim() : '';
  const got = (request.headers.get('X-Admin-Token') || '').trim();
  if (!expected || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function readRow(kv, id) {
  const raw = await kv.get(PREFIX + id);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRow(kv, id, row) {
  await kv.put(PREFIX + id, JSON.stringify(row));
}

async function readDigest(kv) {
  const raw = await kv.get(DIGEST_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function pushDigest(kv, event) {
  const events = await readDigest(kv);
  events.push(event);
  await kv.put(DIGEST_KEY, JSON.stringify(events.slice(-500)));
}

function courseIdFrom(pathname) {
  const flag = pathname.match(/^\/course-card\/v1\/([^/]+)\/flag$/);
  if (flag) return { id: decodeURIComponent(flag[1]), flag: true };
  const card = pathname.match(/^\/course-card\/v1\/([^/]+)$/);
  if (card) return { id: decodeURIComponent(card[1]), flag: false };
  return null;
}

export async function handleCourseCard(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname === '/admin/greens-no-tees-digest') {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (!tokenOk(request, env)) return json(401, { error: 'unauthorized' });
    const kv = kvOf(env);
    if (!kv) return json(503, { error: 'not_configured' });
    const now = Date.now();
    return json(200, { ...buildDailyDigest(await readDigest(kv), now), credits: 0 });
  }
  const match = courseIdFrom(pathname);
  if (!match) return null;
  if (!COURSE_ID.test(match.id)) return json(400, { error: 'bad_id' });
  const kv = kvOf(env);
  if (!kv) return json(503, { error: 'not_configured' });
  if (match.flag) {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (!tokenOk(request, env)) return json(401, { error: 'unauthorized' });
    let body = null;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'bad_json' });
    }
    const store = new Map();
    const row = await readRow(kv, match.id);
    if (!row) return json(404, { error: 'not_found' });
    store.set(match.id, row);
    try {
      const served = setCardFlag(store, match.id, body?.flag);
      await writeRow(kv, match.id, store.get(match.id));
      if (body.flag === 'hidden') {
        await pushDigest(kv, { id: match.id, kind: 'hidden', at: Date.now(), flags: [] });
      }
      return json(200, { ...served, credits: 0 });
    } catch {
      return json(400, { error: 'unknown_flag' });
    }
  }
  if (request.method === 'GET') {
    const served = readServedCard(await readRow(kv, match.id));
    if (!served) return json(404, { error: 'not_found', credits: 0 });
    return json(200, { ...served, credits: 0 });
  }
  if (request.method !== 'PUT') return json(405, { error: 'method_not_allowed' });
  const existing = inflight.get(match.id);
  if (existing) return existing.then((payload) => json(payload.status, payload.body));
  const run = publish(request, env, kv, match.id).finally(() => {
    if (inflight.get(match.id) === run) inflight.delete(match.id);
  });
  inflight.set(match.id, run);
  return run.then((payload) => json(payload.status, payload.body));
}

async function publish(request, env, kv, id) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: 'bad_json' } };
  }
  const card = {
    holes: Array.isArray(body?.holes) ? body.holes : [],
    count: body?.count ?? null,
    bundled: body?.bundled === true,
    handPinned: body?.handPinned === true,
    guarded: body?.guarded === true,
    blocklisted: body?.blocklisted === true,
    sisterCourse: body?.sisterCourse === true,
    outline: Array.isArray(body?.outline) ? body.outline : null,
  };
  const verdict = liveCardPublishVerdict(card);
  if (!verdict.ok && verdict.reason === 'bad_count') {
    return { status: 400, body: { error: 'bad_count' } };
  }
  if (!verdict.ok) {
    return {
      status: verdict.reason === 'hash-ok' ? 409 : 422,
      body: {
        published: false,
        reason: verdict.reason,
        fails: verdict.fails,
        credits: 0,
      },
    };
  }
  const store = new Map();
  const prior = await readRow(kv, id);
  if (prior) store.set(id, prior);
  const version = {
    id: `${id}:${(prior?.versions?.length ?? 0) + 1}`,
    at: Date.now(),
    source: typeof body?.source === 'string' ? body.source : null,
    holes: card.holes,
    count: card.count,
    checks: { fails: verdict.fails, flags: verdict.flags },
  };
  appendCardVersion(store, id, version);
  await writeRow(kv, id, store.get(id));
  await pushDigest(kv, { id, kind: 'published', at: version.at, flags: verdict.flags });
  return { status: 200, body: { published: true, credits: 0, flags: verdict.flags, version: version.id } };
}
