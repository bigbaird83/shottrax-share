// One-time copy of live golfapi bodies into the PR #461 key format.
// READS shottrax-boards (gapi:course:*, gapi:coord:*, gq:balance) and WRITES the new
// GOLFAPI_KV namespace. Never writes or deletes anything in shottrax-boards.
// Usage: node migrate-golfapi-kv.mjs <NEW_GOLFAPI_KV_ID> [--write]   (default = dry run)
import { pathToFileURL } from 'node:url';
import { golfapiBodyHasData } from './live-shottrax-share.js';

export const ACCOUNT_ID = '8fc71078dc68e90e9c5971f343d61307';
export const SRC_NAMESPACE_ID = 'cfa1824a10374ab6a7fa0c97d0990e80';

const COURSE_PREFIX = 'gapi:course:';
const COORD_PREFIX = 'gapi:coord:';

function cloudflareErrorBody(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.success === false) return true;
  return Array.isArray(payload.errors);
}

export function rowForLiveKey(key, text) {
  if (typeof text !== 'string' || !text) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (cloudflareErrorBody(payload)) return null;
  const course = key.startsWith(COURSE_PREFIX);
  const coord = key.startsWith(COORD_PREFIX);
  if (!course && !coord) return null;
  const id = key.slice((course ? COURSE_PREFIX : COORD_PREFIX).length);
  if (!id) return null;
  // Live kind names: "course" and "coord" (not "coordinates").
  if (!golfapiBodyHasData(course ? 'course' : 'coord', payload)) return null;
  const dest = course ? `golfapi:permanent:course:${id}` : `golfapi:permanent:coordinates:${id}`;
  return {
    key: dest,
    value: JSON.stringify({ status: 200, contentType: 'application/json', body: text }),
  };
}

export function balanceRow(text) {
  try {
    if (typeof JSON.parse(text).left === 'number') return { key: 'gq:balance', value: text };
  } catch {
    // Missing or non-JSON balance is left behind. The module treats that as unknown.
  }
  return null;
}

export async function migrateGolfapiKv({
  dst,
  write = false,
  fetchImpl = globalThis.fetch,
  src = SRC_NAMESPACE_ID,
  account = ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN || '',
  log = () => {},
} = {}) {
  if (!dst || dst === src) throw new Error('need a NEW destination namespace id (not shottrax-boards)');
  const headers = { Authorization: `Bearer ${token}` };
  const base = (ns) => `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}`;

  async function keys(prefix) {
    const out = [];
    let cursor = '';
    do {
      const url = `${base(src)}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetchImpl(url, { headers });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.success === false) {
        throw new Error(`kv keys failed ${res.status} ${prefix}`);
      }
      out.push(...(body.result || []).map((item) => item.name));
      cursor = body.result_info?.cursor || '';
    } while (cursor);
    return out;
  }

  async function get(key) {
    const res = await fetchImpl(`${base(src)}/values/${encodeURIComponent(key)}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`kv get failed ${res.status} ${key}`);
    return res.text();
  }

  const rows = [];
  for (const key of [...(await keys(COURSE_PREFIX)), ...(await keys(COORD_PREFIX))]) {
    const text = await get(key);
    const row = rowForLiveKey(key, text);
    if (!row) {
      log(`skip ${key}`);
      continue;
    }
    rows.push(row);
  }
  const balance = balanceRow(await get('gq:balance'));
  if (balance) rows.push(balance);

  log(`${rows.length} rows${write ? '' : ' (dry run, nothing written)'}`);
  for (const row of rows) log(`  ${row.key} ${row.value.length}`);
  if (write) {
    const res = await fetchImpl(`${base(dst)}/bulk`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    const written = await res.json().catch(() => null);
    if (!res.ok || !written || written.success !== true) {
      throw new Error(`kv bulk put failed ${res.status}`);
    }
    log(JSON.stringify(written));
  }
  return rows;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  try {
    const dst = process.argv[2];
    const write = process.argv.includes('--write');
    await migrateGolfapiKv({ dst, write, log: (line) => console.log(line) });
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
