// Required immediately before `wrangler deploy` of worker/deploy-share.
// Exits non-zero when the toml still cannot be deployed onto shottrax-share.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BOARDS_KV_ID = 'cfa1824a10374ab6a7fa0c97d0990e80';
export const GOLFAPI_KV_PLACEHOLDER = 'REPLACE_WITH_NEW_GOLFAPI_KV_ID';
export const STOCKPILE_CRONS = '["0 23 * * *"]';

function kvBlocks(text) {
  const parts = text.split(/\[\[kv_namespaces\]\]/);
  parts.shift();
  return parts.map((part) => part.split(/\n\s*\[/)[0]);
}

export function golfapiKvId(text) {
  for (const body of kvBlocks(text)) {
    const binding = /binding\s*=\s*"([^"]*)"/.exec(body);
    if (!binding || binding[1] !== 'GOLFAPI_KV') continue;
    const id = /id\s*=\s*"([^"]*)"/.exec(body);
    return id ? id[1] : '';
  }
  return null;
}

/** @returns {string[]} problems. Empty means the toml may be deployed. */
export function checkWrangler(text) {
  const errors = [];
  const name = /^\s*name\s*=\s*"([^"]*)"/m.exec(text);
  if (!name || name[1] !== 'shottrax-share') {
    errors.push(`name must be shottrax-share (got ${name ? JSON.stringify(name[1]) : 'missing'})`);
  }
  const main = /^\s*main\s*=\s*"([^"]*)"/m.exec(text);
  if (!main || main[1] !== 'entry.js') {
    errors.push(`main must be entry.js (got ${main ? JSON.stringify(main[1]) : 'missing'})`);
  }
  const crons = /^\s*crons\s*=\s*(.*?)\s*$/m.exec(text);
  if (!crons || crons[1] !== STOCKPILE_CRONS) {
    errors.push(`crons must be ${STOCKPILE_CRONS} (got ${crons ? crons[1] : 'missing'})`);
  }
  const id = golfapiKvId(text);
  if (id == null || id === '') {
    errors.push('GOLFAPI_KV id is empty');
  } else if (id === GOLFAPI_KV_PLACEHOLDER) {
    errors.push(`GOLFAPI_KV id is still the placeholder ${GOLFAPI_KV_PLACEHOLDER}`);
  } else if (id === BOARDS_KV_ID) {
    errors.push(`GOLFAPI_KV id must not equal the BOARDS namespace ${BOARDS_KV_ID}`);
  }
  return errors;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  const file = process.argv[2] || 'wrangler.toml';
  const errors = checkWrangler(readFileSync(file, 'utf8'));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
}
