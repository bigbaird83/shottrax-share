/**
 * One-time cleanup for `terrain:samples:` counters.
 *
 * Dry-run is the default. It prints counts only and does not delete.
 * Output never includes key values past the prefix `terrain:samples:`.
 *
 * Not imported by the Worker, not run by deploy, and not on a cron.
 * Running it against live KV (--remote) needs Brian's OK, alongside the deploy.
 * A dry-run with --remote still reads live KV.
 *
 *   node scripts/cleanup-terrain-samples.js --binding GOLFAPI_KV --remote
 *   node scripts/cleanup-terrain-samples.js --binding GOLFAPI_KV --remote --apply
 *
 * Pass --remote or --local. Neither is assumed, so --apply alone touches nothing.
 * On the live Worker the counter namespace is GOLFAPI_KV (TERRAIN_KV is unset).
 * Rows already stored in GolfapiCounter SQLite are not in that namespace.
 * The same 48-hour rule deletes those rows only when the counter op
 * cleanupTerrainSamples is invoked with apply:true. This script does not
 * call that op, and nothing in deploy calls it either.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  TERRAIN_SAMPLE_PREFIX,
  cleanupTerrainSampleStore,
  formatTerrainSampleCleanup,
} from '../golf-proxy.js';

export { formatTerrainSampleCleanup };

const execFileAsync = promisify(execFile);

const USAGE = [
  'One-time cleanup for terrain:samples: keys whose UTC day started more than 48 hours ago.',
  'Dry-run is the default. It prints counts only and does not delete.',
  'Output never includes key values beyond the prefix terrain:samples:.',
  'This script is not part of deploy.',
  'Running it against live KV needs Brian\'s OK, alongside the deploy.',
  '',
  '  node scripts/cleanup-terrain-samples.js --binding GOLFAPI_KV --remote',
  '  node scripts/cleanup-terrain-samples.js --binding GOLFAPI_KV --remote --apply',
  '',
  'Pass --remote or --local. Neither is assumed.',
  '--remote reads live KV even on a dry-run.',
].join('\n');

export function parseCleanupArgs(argv) {
  const options = {
    apply: false,
    binding: '',
    remote: false,
    local: false,
    help: false,
    unknown: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply') options.apply = true;
    else if (token === '--dry-run') options.apply = false;
    else if (token === '--remote') options.remote = true;
    else if (token === '--local') options.local = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--binding') options.binding = argv[++i] || '';
    else if (token.startsWith('--binding=')) options.binding = token.slice('--binding='.length);
    else options.unknown = token;
  }
  return options;
}

export function redactSampleKeys(text) {
  return String(text).replace(/terrain:samples:[^\s"]+/g, 'terrain:samples:…');
}

function wranglerBin() {
  return fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
}

function repoRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

async function wrangler(args) {
  try {
    const result = await execFileAsync(process.execPath, [wranglerBin(), ...args], {
      cwd: repoRoot(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout || '';
  } catch (error) {
    const message = error && error.message ? error.message : 'wrangler failed';
    throw new Error(redactSampleKeys(message));
  }
}

function keyNamesFromList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('could not read the key list');
  }
  if (!Array.isArray(parsed)) throw new Error('could not read the key list');
  const names = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry.name === 'string') names.push(entry.name);
    else if (entry && typeof entry.key === 'string') names.push(entry.key);
  }
  return names;
}

export function wranglerStore({ binding, remote }) {
  const where = remote ? '--remote' : '--local';
  return {
    async list({ prefix }) {
      const stdout = await wrangler([
        'kv', 'key', 'list',
        '--binding', binding,
        '--prefix', prefix || TERRAIN_SAMPLE_PREFIX,
        where,
      ]);
      return {
        keys: keyNamesFromList(stdout).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async delete(key) {
      await wrangler([
        'kv', 'key', 'delete', key,
        '--binding', binding,
        where,
      ]);
    },
  };
}

/**
 * @param {string[]} argv
 * @param {{ store?: { list: Function, delete: Function }, now?: number }} [deps]
 */
export async function runTerrainSampleCleanup(argv, deps = {}) {
  const options = parseCleanupArgs(argv);
  if (options.unknown) {
    return { exitCode: 1, message: `unknown argument. ${USAGE}` };
  }
  if (options.help || !options.binding) return { exitCode: 0, message: USAGE };
  if (options.remote && options.local) {
    return { exitCode: 1, message: 'pass only one of --remote or --local' };
  }
  if (!options.remote && !options.local) {
    return {
      exitCode: 1,
      message: 'Pass --remote or --local. Live KV (--remote) needs Brian\'s OK, alongside the deploy.',
    };
  }
  const store = deps.store || wranglerStore(options);
  const summary = await cleanupTerrainSampleStore(store, {
    now: typeof deps.now === 'number' ? deps.now : Date.now(),
    apply: options.apply,
  });
  return { exitCode: 0, message: formatTerrainSampleCleanup(summary), summary };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  runTerrainSampleCleanup(process.argv.slice(2))
    .then((result) => {
      if (result.message) console.log(result.message);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(redactSampleKeys(error && error.message ? error.message : 'cleanup failed'));
      process.exitCode = 1;
    });
}
