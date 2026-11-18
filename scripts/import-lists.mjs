#!/usr/bin/env node
/**
 * Builds the allowlist and reject list for import-raw-pulls.mjs from Signal
 * Lab's validation files on the box. Read-only on those files. It never makes
 * a verdict of its own; it only copies what the files already say:
 *
 * - ALLOW: an id on a markdown table row (exactly one id on the row) whose
 *   bucket/verdict cell says import-ready and nothing else (no trim, partial,
 *   reject, unusable, exclude, duplicate, "do not", "fill missing only").
 *   Prose mentions never allow.
 * - REJECT (always wins): every other id on a bucket/verdict table row; every
 *   id in prose under a heading or on a line that names a non-import bucket;
 *   validate-2km.json rows whose result is not "accepted"; and the fixed list
 *   in ALWAYS_REJECT (Signal Lab's #66 gate comment). Jacksonville CC IL
 *   (012141520779052713789) is no longer in ALWAYS_REJECT (Brian, Nov 17
 *   8:00 PM CT, rematch-nov17.md: the ID is the right body for Jacksonville
 *   CC; it was listed only because The Links of Jacksonville was wrong).
 *   Beavercreek GC OH (012141521001279406018) is no longer in ALWAYS_REJECT
 *   (Brian, Nov 17 7:43 PM CT: upload every course Signal Lab has not rejected
 *   or marked unusable; rematch-pulls-nov17-validation.md marks it import-ready).
 *
 * --mode server-cache (Brian, Nov 17 2026: "upload every course Signal Lab
 * hasn't rejected or marked unusable, including partial and 9-hole ones";
 * 7:58 PM CT: "Yes, include the 153 fill-missing-only courses"; 8:00 PM CT:
 * "Yes, include the 19 Signal cleared as partial"):
 * a table row also ALLOWS when its verdict cell starts with partial, trim to 9
 * or import-after-trim, or is import-ready (fill missing only), as long as the
 * cell names no reject-type word (SERVER_REJECT_WORDS) and does not contain
 * "unusable" anywhere. Trim/partial words in a heading or in prose no longer
 * reject; every reject-type word still does. 2-id rows, validate-2km rejects
 * (except the accepted-partial lift below) and ALWAYS_REJECT stay rejects,
 * prose still never allows, and an id on both an allow-type and a reject-type
 * row stays out. Each allowed id carries its verdict (import-ready, partial,
 * trim-to-9, fill-missing).
 *
 * "unusable" anywhere in a verdict cell is REJECT in both modes (Signal Lab,
 * Nov 17: e.g. "partial (unusable)", "trim to 9 - unusable").
 *
 * validate-2km "accepted-partial" is a reject in default mode. In server-cache
 * it is lifted only when Signal's row for that id is partial and no other
 * reject remains. Greenbriar MI 012141520859173562416 is hard-excluded by id.
 *
 * The default mode is unchanged except for the Jacksonville and Beavercreek
 * ALWAYS_REJECT removals (a reject on any other id, and every other
 * ALWAYS_REJECT entry, still wins).
 *
 * Usage:
 *   node scripts/import-lists.mjs --signal-root /workspace/golfapi-pulls \
 *     --allow-out allowlist.json --reject-out rejects.json [--mode server-cache]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ID_RE = /(?<!\d)(0\d{14,21})(?!\d)/g;

/** Signal Lab #66 gate (Nov 17, 2026), plus Thunderbird. Always rejected. */
export const ALWAYS_REJECT = Object.freeze({
  '0121263749725147': 'Naples Grande GC (FL): corrupt coordinates, holes in Maine',
  '012141520689264205787': 'Banyan GC (FL): rejected, already a pack course',
  '012141520817542047754': 'Doe Valley GC (KY): rejected, greens 7-8 km from OSM shape',
  '012141520818586616898': 'Henderson CC (KY): rejected, greens 7-8 km from OSM shape',
  '012141521021948968089': 'Sleepy Hollow GC (OH): rejected, ~64 km from OSM shape',
  '01214152102065792916': 'Salem Hills G&CC (OH): rejected, 6.6 km from OSM shape',
  '012141520862542102642': 'Kensington Metropark GC (MI): validate-2km REJECTED',
  '012141520853259289762': 'Charlevoix CC (MI): validate-2km REJECTED',
  '012141520916526104341': 'Mid Pines Inn (NC): validate-2km REJECTED',
  '012141520954148858651': 'Colonial Park GC (NM): validate-2km REJECTED',
  '0121696819121415659': 'Waynesboro CC (PA): validate-2km REJECTED',
  '01214152105285044350': 'Hailwood GC (PA): validate-2km REJECTED',
  '012141520627797959416': 'Monticello CC (AR): unusable, 9 of 18 holes, not the card',
  '012141520788518928722': 'Stonewolf GC (IL): unusable, back 9 copied, front scrambled',
  '012141521038540432179': 'Hawks Creek GC (TX): unusable, back 9 copied, holes swapped',
  '01214152103323769690': 'Oklahoma City G&CC (OK): unusable, wrong course',
  '011141520625780263856': 'Delta CC (AR): bundled on main, protected/exclude',
  '012141520629437545788': 'The Course at Eagle Mountain (AR): bundled on main, protected/exclude',
  '011141520629948893391': 'Thunderbird CC Heber Springs (AR): app-only partial seed, never import',
});

const NOT_IMPORT_WORDS = /\b(trim|partial|reject|rejected|unusable|exclude|excluded|duplicate|do not|don't|wrong|not pulled|verify|mixed|second shape|hold)\b/i;
/** server-cache mode: NOT_IMPORT_WORDS without trim/partial, plus bundled/protected. */
export const SERVER_REJECT_WORDS = /\b(reject|rejected|unusable|exclude|excluded|duplicate|do not|don't|wrong|not pulled|verify|mixed|second shape|hold|bundled|protected)\b/i;
const WRONG_HOLE_DATA = /\bwrong (holes?|pars?|tees?)\b|\b(holes?|pars?|tees?) (are |is )?wrong\b/g;
export const MODES = Object.freeze(['default', 'server-cache']);
export const FILL_MISSING_RE = /fill[- ]missing/i;
/** "unusable" anywhere in verdict wording is a reject in both modes. */
export const UNUSABLE_RE = /unusable/i;
/** validate-2km result/reason for the 19 Signal-cleared partials. */
export const ACCEPTED_PARTIAL_RE = /(?:^|validate-2km:\s*)accepted-partial\b/i;
/** Greenbriar Golf Club (MI). Hard-excluded in server-cache even with a partial row + accepted-partial. */
export const GREENBRIAR_MI_ID = '012141520859173562416';
export const JACKSONVILLE_CC_IL_ID = '012141520779052713789';
export const BEAVERCREEK_OH_ID = '012141521001279406018';

export function isAcceptedPartialReason(reason) {
  return /validate-2km:\s*accepted-partial\b/i.test(String(reason || ''));
}

function isBlockText(text, mode) {
  if (UNUSABLE_RE.test(text)) return true;
  return (mode === 'default' ? NOT_IMPORT_WORDS : SERVER_REJECT_WORDS).test(text);
}

export function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`unknown --mode ${mode} (expected ${MODES.join(' or ')})`);
  return mode;
}
const BUCKET_HEADER = /bucket|verdict|class|validated|status|result/i;

function cleanCell(cell) {
  return cell.replace(/\*/g, '').replace(/`/g, '').trim();
}

/** import-ready with no other bucket word. "import-ready (fill missing only)" counts. */
export function bucketAllows(cell) {
  const text = cleanCell(cell).toLowerCase();
  if (!/^import[- ]ready\b/.test(text)) return false;
  // "fill missing only" is a hole-fill verdict, not a whole-course copy in default mode.
  if (/fill[- ]missing/.test(text)) return false;
  if (UNUSABLE_RE.test(text)) return false;
  return !NOT_IMPORT_WORDS.test(text);
}

/**
 * The verdict a bucket cell allows, or null. Default mode: only a clean
 * import-ready cell. server-cache mode: import-ready, partial, trim-to-9 or
 * import-ready (fill missing only). "unusable" anywhere is never allowed.
 * A fill-missing cell that also names a reject-type word is still rejected.
 */
export function allowedVerdict(cell, mode = 'default') {
  const text = cleanCell(cell).toLowerCase();
  if (UNUSABLE_RE.test(text)) return null;
  if (mode === 'default') return bucketAllows(cell) ? 'import-ready' : null;
  assertMode(mode);
  // "pars wrong" / "tees on the wrong hole" describe why a row is partial;
  // "wrong course" (or any other reject-type word) still blocks.
  const blockText = text.replace(WRONG_HOLE_DATA, ' ');
  if (SERVER_REJECT_WORDS.test(blockText)) return null;
  if (FILL_MISSING_RE.test(text)) return /^import[- ]ready\b/.test(text) ? 'fill-missing' : null;
  if (/^import[- ]ready\b/.test(text)) return 'import-ready';
  if (/^(trim[- ]to[- ](9|nine)\b|import[- ]after[- ]trim\b)/.test(text)) return 'trim-to-9';
  if (/^partial\b/.test(text)) return 'partial';
  return null;
}

function idsIn(text) {
  return [...new Set(String(text).match(ID_RE) || [])];
}

/** Parse one markdown file into allow and reject entries. */
export function parseValidationMarkdown(text, source, mode = 'default') {
  assertMode(mode);
  const allow = [];
  const reject = [];
  const lines = text.split(/\r?\n/);
  let heading = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    if (line.startsWith('|') && /^\|?[\s:|-]+$/.test(next) && next.includes('-')) {
      const header = line.trim().replace(/^\||\|$/g, '').split('|').map(cleanCell);
      let bucketAt = -1;
      for (let j = header.length - 1; j >= 0; j -= 1) {
        if (BUCKET_HEADER.test(header[j])) {
          bucketAt = j;
          break;
        }
      }
      i += 2;
      for (; i < lines.length && lines[i].startsWith('|'); i += 1) {
        const row = lines[i];
        const ids = idsIn(row);
        if (ids.length === 0) continue;
        const cells = row.trim().replace(/^\||\|$/g, '').split('|');
        const bucket = bucketAt >= 0 && bucketAt < cells.length ? cleanCell(cells[bucketAt]) : '';
        const verdict = bucketAt >= 0 ? allowedVerdict(bucket, mode) : null;
        if (verdict && ids.length === 1 && !isBlockText(heading, mode)) {
          allow.push({ id: ids[0], source, bucket, verdict, row: cleanCell(row) });
        } else if (bucketAt >= 0 && (bucket || isBlockText(heading, mode))) {
          // A verdict row that does not allow (or names 2+ ids): reject.
          const why = ids.length > 1 && verdict ? `ambiguous row (${ids.length} ids): ${bucket}` : bucket || heading;
          for (const id of ids) reject.push({ id, source, reason: why.slice(0, 160) });
        } else if (isBlockText(row, mode) || isBlockText(heading, mode)) {
          for (const id of ids) reject.push({ id, source, reason: `table note: ${cleanCell(row).slice(0, 140)}` });
        }
      }
      i -= 1;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      heading = line.replace(/^#+\s*/, '');
      continue;
    }
    const ids = idsIn(line);
    if (ids.length === 0) continue;
    if (isBlockText(heading, mode) || isBlockText(line, mode)) {
      for (const id of ids) reject.push({ id, source, reason: `prose: ${(isBlockText(heading, mode) ? heading : line).replace(/\*/g, '').slice(0, 140)}` });
    }
  }
  return { allow, reject };
}

/** validate-2km.json rows: anything but "accepted" is a reject. Accepted rows are NOT allowed. */
export function parseValidate2km(rows, source) {
  const reject = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.id) continue;
    const result = String(row.result || '');
    if (result !== 'accepted') reject.push({ id: String(row.id), source, reason: `validate-2km: ${result}`.slice(0, 160) });
  }
  return reject;
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'main-wt' || entry.name.startsWith('.')) continue;
      walkFiles(full, out);
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Signal Lab files under the pulls root: *-validation.md, *-review.md, validate-2km.json. */
export function findSignalFiles(root) {
  const all = walkFiles(resolve(root));
  return {
    markdown: all.filter((f) => /-(validation|review)\.md$/.test(f)).sort(),
    validate2km: all.filter((f) => /validate-2km\.json$/.test(f)).sort(),
  };
}

/** One label per id when its allow rows disagree: the most cautious one. No verdict, no label (fail closed). */
const VERDICT_RANK = ['partial', 'trim-to-9', 'fill-missing', 'import-ready'];
export function verdictFor(rows) {
  const seen = new Set((rows || []).map((r) => r.verdict).filter(Boolean));
  return VERDICT_RANK.find((v) => seen.has(v)) || null;
}

export function buildLists({ markdown = [], validate2km = [], root = '/', mode = 'default' }) {
  assertMode(mode);
  const allowById = new Map();
  const rejectById = new Map();
  const fillMissingSeen = new Set();
  const addReject = (entry) => {
    if (!rejectById.has(entry.id)) rejectById.set(entry.id, []);
    rejectById.get(entry.id).push({ source: entry.source, reason: entry.reason });
  };
  const sources = [];
  for (const file of markdown) {
    const rel = relative(root, file);
    sources.push({ path: file, mtime: statSync(file).mtime.toISOString(), kind: 'markdown' });
    const parsed = parseValidationMarkdown(readFileSync(file, 'utf8'), rel, mode);
    for (const a of parsed.allow) {
      if (a.verdict === 'fill-missing' || FILL_MISSING_RE.test(a.bucket || '')) fillMissingSeen.add(a.id);
      if (!allowById.has(a.id)) allowById.set(a.id, []);
      const entry = { source: a.source, bucket: a.bucket, row: a.row };
      // Oct 28 outline / right-course evidence exists only on import-ready rows.
      if (a.verdict === 'import-ready') entry.checks = { outline: 'import-ready', rightCourse: 'import-ready' };
      if (mode !== 'default') entry.verdict = a.verdict;
      allowById.get(a.id).push(entry);
    }
    for (const r of parsed.reject) {
      if (FILL_MISSING_RE.test(r.reason)) fillMissingSeen.add(r.id);
      addReject(r);
    }
  }
  for (const file of validate2km) {
    const rel = relative(root, file);
    sources.push({ path: file, mtime: statSync(file).mtime.toISOString(), kind: 'validate-2km' });
    for (const r of parseValidate2km(JSON.parse(readFileSync(file, 'utf8')), rel)) addReject(r);
  }
  for (const [id, reason] of Object.entries(ALWAYS_REJECT)) addReject({ id, source: 'ALWAYS_REJECT (Signal Lab #66 gate)', reason });
  const acceptedPartialIncluded = [];
  if (mode === 'server-cache') {
    // Hard-exclude is not an ALWAYS_REJECT change; Signal's gate checks that
    // only Jacksonville CC IL and Beavercreek GC OH were removed from that list.
    addReject({
      id: GREENBRIAR_MI_ID,
      source: 'hard-exclude (Greenbriar MI, Signal Lab #67)',
      reason: 'Greenbriar Golf Club (MI): hard-excluded; accepted-partial greens 3/18, tees 0/18',
    });
    // Greenbriar's hard-exclude reason above keeps it out of this lift.
    for (const [id, rows] of [...rejectById.entries()]) {
      if (!rows.every((r) => isAcceptedPartialReason(r.reason))) continue;
      if (verdictFor(allowById.get(id)) !== 'partial') continue;
      rejectById.delete(id);
      acceptedPartialIncluded.push(id);
    }
    acceptedPartialIncluded.sort();
  }
  const allow = {};
  for (const [id, rows] of [...allowById.entries()].sort()) if (!rejectById.has(id)) allow[id] = rows;
  const reject = Object.fromEntries([...rejectById.entries()].sort());
  const allowAlsoRejected = [...allowById.keys()].filter((id) => rejectById.has(id)).sort();
  const fillMissing = [...fillMissingSeen].sort();
  return { mode, allow, reject, allowAlsoRejected, fillMissing, acceptedPartialIncluded, sources };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args['signal-root'] || !args['allow-out'] || !args['reject-out']) {
    throw new Error('usage: --signal-root <dir> --allow-out <allowlist.json> --reject-out <rejects.json>');
  }
  const root = resolve(args['signal-root']);
  const files = findSignalFiles(root);
  if (files.markdown.length === 0) throw new Error(`no Signal Lab validation files under ${root}`);
  const mode = assertMode(args.mode || 'default');
  const lists = buildLists({ ...files, root, mode });
  const generatedAt = new Date().toISOString();
  const modeField = mode === 'default' ? {} : { mode };
  writeFileSync(args['allow-out'], JSON.stringify({ generatedAt, root, kind: 'allowlist', ...modeField, sources: lists.sources, allowAlsoRejected: lists.allowAlsoRejected, ...(mode === 'default' ? {} : { acceptedPartialIncluded: lists.acceptedPartialIncluded }), ids: lists.allow }, null, 2));
  writeFileSync(args['reject-out'], JSON.stringify({ generatedAt, root, kind: 'rejects', ...modeField, sources: lists.sources, ...(mode === 'default' ? {} : { fillMissing: lists.fillMissing, acceptedPartialIncluded: lists.acceptedPartialIncluded }), ids: lists.reject }, null, 2));
  console.log(`${mode === 'default' ? '' : `[${mode}] `}allow ${Object.keys(lists.allow).length}, reject ${Object.keys(lists.reject).length}, allow-also-rejected ${lists.allowAlsoRejected.length}, fill-missing ${lists.fillMissing.length}, accepted-partial-included ${lists.acceptedPartialIncluded.length}, from ${lists.sources.length} files`);
  return lists;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
