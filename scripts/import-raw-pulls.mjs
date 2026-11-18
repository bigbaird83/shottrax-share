#!/usr/bin/env node
/**
 * DRY RUN ONLY: turn raw golfapi pull files into a `wrangler kv bulk put` file
 * for GOLFAPI_KV, plus a report and an undo list. This script never writes to
 * KV. The only remote call it can make is the read-only
 * `wrangler kv key list` behind --list-remote.
 *
 * The Worker serves a stored copy at 0 credits from
 *   golfapi:permanent:course:{id}       (GET /golfapi/v2.3/courses/{id})
 *   golfapi:permanent:coordinates:{id}  (GET /golfapi/v2.3/coordinates/{id})
 * when the value is the envelope golf-stockpile.js writes:
 *   JSON.stringify({ status, contentType: 'application/json', body: <raw text> })
 * (serveStored in golf-proxy.js requires `typeof body === 'string'`).
 * US courses also get `golfapi:us:{id}` = '1' (markUs in golf-stockpile.js).
 *
 * Never overwrite: a key already in GOLFAPI_KV is never in the output. Golfer
 * corrections live under other keys (course-corrections.js), so they are not
 * touched either.
 *
 * Usage:
 *   node scripts/import-raw-pulls.mjs --raw <dir> (--existing <keys.txt> | --list-remote)
 *     --out <bulk.json> --report <report.json> [--report-md <report.md>] [--undo <delete-keys.json>]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Thunderbird Country Club, Heber Springs AR. Never import it: the app paints
 * only a partial, hand-filtered golfapi seed for this course (ShotTraxx
 * src/course/thunderbirdLock.ts THUNDERBIRD_GOLFAPI_COURSE_ID; the #696 bulk
 * import skipped it too). Matched by id, and by name + city as a backstop.
 */
export const THUNDERBIRD_GOLFAPI_COURSE_ID = '011141520629948893391';
export const SKIP_IDS = new Map([[THUNDERBIRD_GOLFAPI_COURSE_ID, 'thunderbird']]);

/** Cloudflare KV limits. */
export const KV_VALUE_LIMIT_BYTES = 25 * 1024 * 1024;
export const KV_KEY_LIMIT_BYTES = 512;
export const MAX_SANE_HOLES = 36;

const FILE_RE = /^(.+)\.(courses|coordinates)\.json$/;
const KINDS = { courses: 'course', coordinates: 'coordinates' };

export function permanentKey(kind, id) {
  return `golfapi:permanent:${kind}:${id}`;
}
export function usKey(id) {
  return `golfapi:us:${id}`;
}
export function noDataKey(id) {
  return `golfapi:nodata:${id}`;
}

/** Same envelope as golf-stockpile.js pullOne (status, contentType, body). */
export function envelope(text) {
  return JSON.stringify({ status: 200, contentType: 'application/json', body: text });
}

// ---- Validation, mirrored from golf-stockpile.js / golf-proxy.js (not imported, so no Worker change). ----

function countryBlank(value) {
  return value == null || String(value).trim() === '';
}
/** golf-stockpile.js countryIsUs */
export function countryIsUs(value) {
  if (countryBlank(value)) return false;
  const raw = String(value).toLowerCase().replace(/\./g, '').replace(/[^a-z]/g, '');
  return raw === 'us' || raw === 'usa' || raw === 'unitedstates' || raw === 'unitedstatesofamerica';
}
function explicitZero(value) {
  return value === 0 || value === '0';
}
/** golf-stockpile.js zeroGps */
export function zeroGps(row) {
  if (!row) return false;
  return explicitZero(row.hasGPS) || explicitZero(row.numCoordinates);
}
const GOLFAPI_QUOTA_TEXT = /quota|rate.?limit|too many requests|limit (reached|exceeded)|no (api )?requests left|insufficient (credits|requests)|subscription|unauthori[sz]ed|invalid api key|forbidden/i;
/** golf-stockpile.js looksLikeQuota */
export function looksLikeQuota(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.message === 'string' && payload.message.trim() !== '') return true;
  for (const field of ['status', 'detail', 'msg']) {
    if (typeof payload[field] === 'string' && GOLFAPI_QUOTA_TEXT.test(payload[field])) return true;
  }
  return false;
}
function nonZeroPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
/** golf-stockpile.js coordsHaveMap, but a 0,0 point never counts as a tee or green. */
export function coordsHaveMap(payload) {
  const rows = [];
  if (Array.isArray(payload)) rows.push(...payload);
  else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.coordinates)) rows.push(...payload.coordinates);
    if (payload.hole != null) rows.push(payload);
  }
  const holes = new Map();
  for (const node of rows) {
    if (!node || typeof node !== 'object') continue;
    const hole = Number(node.hole);
    const poi = Number(node.poi);
    const lat = Number(node.latitude ?? node.lat);
    const lng = Number(node.longitude ?? node.lng);
    if (!Number.isInteger(hole) || hole < 1 || !nonZeroPoint(lat, lng)) continue;
    const row = holes.get(hole) || { tee: false, green: false };
    if (poi === 1) row.green = true;
    if (poi === 11 || poi === 12) row.tee = true;
    holes.set(hole, row);
  }
  for (const row of holes.values()) {
    if (row.tee && row.green) return true;
  }
  return false;
}
function errorField(payload) {
  return payload.error != null && payload.error !== false;
}
function bodyId(payload) {
  const raw = payload.courseID ?? payload.courseId;
  return raw == null ? '' : String(raw).trim();
}
export function isThunderbirdIdentity(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const name = `${payload.clubName || ''} ${payload.courseName || ''}`.toLowerCase();
  const city = String(payload.city || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return name.includes('thunderbird') && city === 'heber springs';
}

function parseObject(text) {
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { reason: 'parse_error' };
    return { payload };
  } catch {
    return { reason: 'parse_error' };
  }
}

/** Returns { ok: true, payload } or { ok: false, reason }. */
export function validateCourse(text, id) {
  const parsed = parseObject(text);
  if (!parsed.payload) return { ok: false, reason: parsed.reason };
  const payload = parsed.payload;
  if (errorField(payload)) return { ok: false, reason: 'error_field', payload };
  if (looksLikeQuota(payload)) return { ok: false, reason: 'quota_body', payload };
  if (bodyId(payload) !== id) return { ok: false, reason: 'id_mismatch', payload };
  if (isThunderbirdIdentity(payload)) return { ok: false, reason: 'thunderbird', payload };
  if (!countryIsUs(payload.country ?? payload.countryCode)) return { ok: false, reason: 'non_us', payload };
  const lat = Number(payload.latitude ?? payload.lat);
  const lng = Number(payload.longitude ?? payload.lng);
  if (zeroGps(payload) || !nonZeroPoint(lat, lng)) return { ok: false, reason: 'zero_gps', payload };
  const holes = Number(payload.numHoles);
  if (!Number.isInteger(holes) || holes < 1 || holes > MAX_SANE_HOLES) return { ok: false, reason: 'bad_num_holes', payload };
  return { ok: true, payload };
}

export function validateCoordinates(text, id) {
  const parsed = parseObject(text);
  if (!parsed.payload) return { ok: false, reason: parsed.reason };
  const payload = parsed.payload;
  if (errorField(payload)) return { ok: false, reason: 'error_field', payload };
  if (looksLikeQuota(payload)) return { ok: false, reason: 'quota_body', payload };
  if (bodyId(payload) !== id) return { ok: false, reason: 'id_mismatch', payload };
  if (zeroGps(payload)) return { ok: false, reason: 'zero_gps', payload };
  if (!coordsHaveMap(payload)) return { ok: false, reason: 'no_usable_map', payload };
  return { ok: true, payload };
}

// ---- Scan ----

/** Walks dir; returns Map id -> { courses: [file], coordinates: [file] }. Other files are ignored. */
export function scanRaw(rawDir) {
  const root = resolve(rawDir);
  const ids = new Map();
  const ignored = { files: 0, byExt: {} };
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = FILE_RE.exec(entry.name);
      if (!match) {
        ignored.files += 1;
        const ext = extname(entry.name) || entry.name;
        ignored.byExt[ext] = (ignored.byExt[ext] || 0) + 1;
        continue;
      }
      const [, id, kind] = match;
      const st = statSync(full);
      if (!ids.has(id)) ids.set(id, { courses: [], coordinates: [] });
      ids.get(id)[kind].push({ path: full, rel: relative(root, full), mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  walk(root);
  return { ids, ignored };
}

/** Newest mtime wins; ties go to the lexically first relative path. */
export function pickFile(files) {
  if (!files || files.length === 0) return null;
  return [...files].sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))[0];
}

// ---- Plan ----

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

/**
 * Pure planning step. `scan` is scanRaw's result, `existing` a Set of key names
 * already in GOLFAPI_KV, `readText(file)` returns the file's text.
 */
export function planImport({ scan, existing, readText = (file) => readFileSync(file.path, 'utf8') }) {
  const bulk = [];
  const skipped = {};
  const skippedIds = {};
  const partial = [];
  const duplicates = [];
  const keysByType = { course: 0, coordinates: 0, us: 0 };
  let bothPresent = 0;
  let valid = 0;
  let idsWithWrites = 0;
  const skip = (id, reason) => {
    bump(skipped, reason);
    (skippedIds[reason] ||= []).push(id);
  };

  const ids = [...scan.ids.keys()].sort();
  for (const id of ids) {
    const files = scan.ids.get(id);
    for (const kind of ['courses', 'coordinates']) {
      if (files[kind].length > 1) {
        const chosen = pickFile(files[kind]);
        duplicates.push({
          id,
          kind: KINDS[kind],
          chosen: chosen.rel,
          others: files[kind].filter((f) => f !== chosen).map((f) => f.rel),
        });
      }
    }
    const courseFile = pickFile(files.courses);
    const coordFile = pickFile(files.coordinates);
    if (courseFile && coordFile) bothPresent += 1;

    if (SKIP_IDS.has(id)) {
      skip(id, SKIP_IDS.get(id));
      continue;
    }
    if (existing.has(noDataKey(id))) {
      skip(id, 'nodata');
      continue;
    }
    const courseStored = existing.has(permanentKey('course', id));
    const coordStored = existing.has(permanentKey('coordinates', id));
    if (courseStored && coordStored) {
      skip(id, 'already_stored');
      continue;
    }
    if (!courseFile || !coordFile) {
      skip(id, 'missing_pair');
      continue;
    }
    const courseText = readText(courseFile);
    const coordText = readText(coordFile);
    const course = validateCourse(courseText, id);
    if (!course.ok) {
      skip(id, course.reason);
      continue;
    }
    const coords = validateCoordinates(coordText, id);
    if (!coords.ok) {
      skip(id, `coordinates_${coords.reason}`);
      continue;
    }
    valid += 1;

    const writes = [];
    if (!courseStored) {
      writes.push({ key: permanentKey('course', id), value: envelope(courseText) });
      keysByType.course += 1;
    }
    if (!coordStored) {
      writes.push({ key: permanentKey('coordinates', id), value: envelope(coordText) });
      keysByType.coordinates += 1;
    }
    if (!existing.has(usKey(id))) {
      writes.push({ key: usKey(id), value: '1' });
      keysByType.us += 1;
    }
    if (courseStored || coordStored) {
      partial.push({
        id,
        alreadyStored: courseStored ? 'course' : 'coordinates',
        writing: courseStored ? 'coordinates' : 'course',
      });
    }
    if (writes.length) idsWithWrites += 1;
    bulk.push(...writes);
  }

  let totalValueBytes = 0;
  let largest = { key: null, bytes: 0 };
  const overLimit = [];
  const keyTooLong = [];
  for (const row of bulk) {
    const bytes = Buffer.byteLength(row.value, 'utf8');
    totalValueBytes += bytes;
    if (bytes > largest.bytes) largest = { key: row.key, bytes };
    if (bytes > KV_VALUE_LIMIT_BYTES) overLimit.push({ key: row.key, bytes });
    if (Buffer.byteLength(row.key, 'utf8') > KV_KEY_LIMIT_BYTES) keyTooLong.push(row.key);
  }
  const bulkText = JSON.stringify(bulk);

  // Every key in the bulk file is new (existing keys are excluded), so
  // deleting these keys can undo this import ONLY if no later writer changed
  // them. A snapshot is not an atomic no-overwrite guarantee; refresh it and
  // review concurrent-writer risks before any separately approved write.
  const deleteKeys = bulk.map((row) => row.key);

  return {
    bulk,
    bulkText,
    deleteKeys,
    report: {
      idsScanned: ids.length,
      idsWithCourseBody: ids.filter((id) => scan.ids.get(id).courses.length).length,
      idsWithCoordinatesBody: ids.filter((id) => scan.ids.get(id).coordinates.length).length,
      bothBodiesPresent: bothPresent,
      valid,
      idsWithWrites,
      skipped,
      skippedIds,
      partialExisting: partial,
      duplicates: { count: duplicates.length, items: duplicates },
      ignoredFiles: scan.ignored,
      existingKeysConsidered: existing.size,
      keysToWrite: { ...keysByType, total: bulk.length },
      bulkFileBytes: Buffer.byteLength(bulkText, 'utf8'),
      totalValueBytes,
      largestValue: largest,
      kvValueLimitBytes: KV_VALUE_LIMIT_BYTES,
      valuesOverLimit: overLimit,
      keysOverLimit: keyTooLong,
    },
  };
}

// ---- Existing keys ----

export function parseExistingKeys(text) {
  const trimmed = text.trim();
  if (!trimmed) return new Set();
  if (trimmed.startsWith('[')) {
    const rows = JSON.parse(trimmed);
    return new Set(rows.map((row) => (typeof row === 'string' ? row : row.name)).filter(Boolean));
  }
  return new Set(trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

/** The one remote command this script runs. Read-only. */
export const LIST_REMOTE_ARGS = ['wrangler', 'kv', 'key', 'list', '--binding', 'GOLFAPI_KV', '--remote', '--prefix', 'golfapi:'];

function listRemote() {
  const text = execFileSync('npx', LIST_REMOTE_ARGS, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return parseExistingKeys(text);
}

// ---- CLI ----

function shellPath(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}
export function commands(outPath, undoPath) {
  return {
    write: `npx wrangler kv bulk put --binding GOLFAPI_KV --remote ${shellPath(outPath)}`,
    undo: `npx wrangler kv bulk delete --binding GOLFAPI_KV --remote ${shellPath(undoPath)}`,
  };
}

function markdown(report, meta) {
  const lines = [];
  lines.push('# GOLFAPI_KV import dry run (NO KV WRITE)', '');
  lines.push('Snapshot only: refresh existing keys immediately before a separately approved write. KV bulk put is not conditional; concurrent writes could otherwise be overwritten. Undo also needs review for later writers. Name searches remain paid; this only stocks course/coordinates copies.', '');
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push(`Raw dir: ${meta.raw}`);
  lines.push(`Existing keys: ${meta.existingSource} (${report.existingKeysConsidered} keys)`, '');
  lines.push('## Counts', '');
  lines.push(`- IDs scanned: ${report.idsScanned}`);
  lines.push(`- IDs with a course body: ${report.idsWithCourseBody}`);
  lines.push(`- IDs with a coordinates body: ${report.idsWithCoordinatesBody}`);
  lines.push(`- Both bodies present: ${report.bothBodiesPresent}`);
  lines.push(`- Valid: ${report.valid}`);
  lines.push(`- IDs with at least one key to write: ${report.idsWithWrites}`);
  lines.push(`- Duplicates across folders (id+kind): ${report.duplicates.count}`, '');
  lines.push('## Skipped by reason', '');
  for (const [reason, n] of Object.entries(report.skipped).sort()) lines.push(`- ${reason}: ${n}`);
  if (!Object.keys(report.skipped).length) lines.push('- none');
  lines.push('', '## Keys to write', '');
  lines.push(`- golfapi:permanent:course: ${report.keysToWrite.course}`);
  lines.push(`- golfapi:permanent:coordinates: ${report.keysToWrite.coordinates}`);
  lines.push(`- golfapi:us: ${report.keysToWrite.us}`);
  lines.push(`- total: ${report.keysToWrite.total}`);
  lines.push(`- bulk file bytes: ${report.bulkFileBytes}`);
  lines.push(`- largest value: ${report.largestValue.bytes} bytes (${report.largestValue.key})`);
  lines.push(`- values over the 25 MiB KV limit: ${report.valuesOverLimit.length}`);
  if (report.partialExisting.length) {
    lines.push('', '## One key already stored (writing only the missing one)', '');
    for (const row of report.partialExisting) lines.push(`- ${row.id}: has ${row.alreadyStored}, writing ${row.writing}`);
  }
  if (report.duplicates.count) {
    lines.push('', '## Duplicates (newest mtime chosen)', '');
    for (const d of report.duplicates.items) lines.push(`- ${d.id} ${d.kind}: chose ${d.chosen}; also ${d.others.join(', ')}`);
  }
  lines.push('', '## Commands (NOT RUN; each needs Brian\'s OK)', '');
  lines.push('Write:', '', '```', meta.commands.write, '```', '');
  lines.push(`Undo candidate (deletes the ${report.keysToWrite.total} planned new keys; verify no later writes first):`, '', '```', meta.commands.undo, '```', '');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list-remote' || arg === '--assume-empty-existing') args[arg.slice(2)] = true;
    else if (arg.startsWith('--')) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.raw || !args.out || !args.report) {
    throw new Error('usage: --raw <dir> (--existing <file> | --list-remote | --assume-empty-existing) --out <bulk.json> --report <report.json>');
  }
  let existing;
  let existingSource;
  if (args.existing) {
    existing = parseExistingKeys(readFileSync(args.existing, 'utf8'));
    existingSource = `file ${resolve(args.existing)}`;
  } else if (args['list-remote']) {
    existing = listRemote();
    existingSource = 'read-only wrangler kv key list --remote --prefix golfapi:';
  } else if (args['assume-empty-existing']) {
    existing = new Set();
    existingSource = 'ASSUMED EMPTY (no remote list) - do not bulk put from this output';
  } else {
    throw new Error('need --existing <file>, --list-remote, or --assume-empty-existing');
  }
  const out = resolve(args.out);
  const undo = resolve(args.undo || join(dirname(out), `${basename(out, '.json')}.delete-keys.json`));
  const reportPath = resolve(args.report);
  const mdPath = resolve(args['report-md'] || reportPath.replace(/\.json$/, '') + '.md');

  const scan = scanRaw(args.raw);
  const plan = planImport({ scan, existing });
  const meta = {
    generatedAt: new Date().toISOString(),
    raw: resolve(args.raw),
    existingSource,
    out,
    undo,
    commands: commands(out, undo),
    dryRun: true,
    note: 'Dry run. No KV write was made. The bulk put needs Brian\'s separate OK.',
  };
  writeFileSync(out, plan.bulkText);
  writeFileSync(undo, JSON.stringify(plan.deleteKeys));
  writeFileSync(reportPath, JSON.stringify({ ...meta, ...plan.report }, null, 2));
  writeFileSync(mdPath, markdown(plan.report, meta));
  const r = plan.report;
  console.log(`dry run: ${r.idsScanned} ids, ${r.valid} valid, ${r.keysToWrite.total} keys to write (${r.keysToWrite.course} course, ${r.keysToWrite.coordinates} coordinates, ${r.keysToWrite.us} us)`);
  console.log(`skipped: ${JSON.stringify(r.skipped)}`);
  console.log(`bulk: ${out} (${r.bulkFileBytes} bytes)`);
  console.log(`report: ${reportPath} / ${mdPath}`);
  console.log(`NOT RUN: ${meta.commands.write}`);
  return { plan, meta };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
