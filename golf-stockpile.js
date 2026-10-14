/**
 * End-of-cycle golfapi stockpile. Spends expiring plan credits on courses
 * OSM does not already cover. Disabled until GOLFAPI_STOCKPILE_ENABLED is true.
 *
 * golfapi spends the monthly allowance before the never-expire balance, so the
 * stop line is GOLFAPI_ROLLOVER_CREDITS (the never-expire balance). The 50-credit
 * floor sits under that balance; this job does not treat the floor as extra
 * headroom on top of the rollover. The window is the last 7 nights before
 * renewal at 23:00 UTC. GOLFAPI_STOCKPILE_MAX_DAYS is 7 and is clamped
 * there. Each of those nights spends
 * (live balance - rollover) / nights still left in the window, including
 * tonight. GOLFAPI_STOCKPILE_RUN_CREDITS is only a high safety ceiling
 * (800 in the toml, no code default). Stockpile spend is counted on its own
 * GolfapiCounter keys, not on the golfer daily or monthly caps.
 */

export const STOCKPILE_CRON = '0 23 * * *';
export const STOCKPILE_CRONS_TEXT = '["0 23 * * *"]';
export const BALANCE_PROBE_NAME = '__shottraxx_stockpile_balance';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROLLOVER = 156;
const DEFAULT_FLOOR = 50;
const DEFAULT_HEADROOM = 30;
const DEFAULT_MAX_DAYS = 7;
const MAX_WINDOW_NIGHTS = 7;
const DEFAULT_CYCLE_DAY = 5;
const SEARCH_TENTHS = 1;
const PULL_TENTHS = 10;
const SEARCH_CAP_TENTHS = 50;
const LOCK_TTL_SEC = 900;

export const STOCKPILE_METROS = [
  { city: 'New York', state: 'NY' },
  { city: 'Los Angeles', state: 'CA' },
  { city: 'Chicago', state: 'IL' },
  { city: 'Dallas', state: 'TX' },
  { city: 'Houston', state: 'TX' },
  { city: 'Washington', state: 'DC' },
  { city: 'Philadelphia', state: 'PA' },
  { city: 'Miami', state: 'FL' },
  { city: 'Atlanta', state: 'GA' },
  { city: 'Boston', state: 'MA' },
  { city: 'Phoenix', state: 'AZ' },
  { city: 'San Francisco', state: 'CA' },
  { city: 'Seattle', state: 'WA' },
  { city: 'Minneapolis', state: 'MN' },
  { city: 'Denver', state: 'CO' },
];

const STATE_BY_NAME = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

const US_STATE_CODES = new Set(Object.values(STATE_BY_NAME));

export function usStateCode(value) {
  if (value == null) return '';
  const text = String(value).trim().toLowerCase().replace(/\./g, '');
  if (!text) return '';
  if (/^[a-z]{2}$/.test(text)) {
    const code = text.toUpperCase();
    return US_STATE_CODES.has(code) ? code : '';
  }
  return STATE_BY_NAME[text] || '';
}

export function stockpileDryRun(env) {
  const raw = String(env?.GOLFAPI_STOCKPILE_DRY_RUN ?? 'false').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function countryBlank(value) {
  return value == null || String(value).trim() === '';
}

function countryIsUs(value) {
  if (countryBlank(value)) return false;
  const raw = String(value).toLowerCase().replace(/\./g, '').replace(/[^a-z]/g, '');
  return raw === 'us' || raw === 'usa' || raw === 'unitedstates' || raw === 'unitedstatesofamerica';
}

function countryKnownNonUs(value) {
  return !countryBlank(value) && !countryIsUs(value);
}

function namesMatch(wanted, got) {
  const a = String(wanted || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const b = String(got || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return a.length > 0 && a === b;
}

function namesMatchCourse(wanted, course) {
  if (!course) return false;
  return namesMatch(wanted, course.courseName) || namesMatch(wanted, course.clubName) || namesMatch(wanted, course.name);
}

function explicitZero(value) {
  return value === 0 || value === '0';
}

function zeroGps(row) {
  if (!row) return false;
  return explicitZero(row.hasGPS) || explicitZero(row.numCoordinates);
}

export function stockpileEnabled(env) {
  const raw = String(env?.GOLFAPI_STOCKPILE_ENABLED ?? 'false').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function envNumber(env, name, fallback) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

function cycleDayOf(env) {
  const day = envNumber(env, 'GOLFAPI_CYCLE_DAY', DEFAULT_CYCLE_DAY);
  return Math.min(28, Math.max(1, Math.trunc(day)));
}

/** UTC instant the next golfapi cycle starts. Cycle day 5 resets at 00:00 UTC on the 5th. */
export function nextCycleStartMs(now, cycleDay = DEFAULT_CYCLE_DAY) {
  const day = Math.min(28, Math.max(1, Number(cycleDay) || DEFAULT_CYCLE_DAY));
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() >= day) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return Date.UTC(year, month, day);
}

/** 23:00 UTC slots from this check through the last one before the cycle reset. */
export function stockpileRunSlots(now, cycleDay = DEFAULT_CYCLE_DAY) {
  const end = nextCycleStartMs(now, cycleDay);
  const slots = [];
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 0, 0);
  if (t < now.getTime()) t += DAY_MS;
  while (t < end && slots.length < 62) {
    slots.push(t);
    t += DAY_MS;
  }
  return slots;
}

export function stockpileRunsRemaining(now, cycleDay = DEFAULT_CYCLE_DAY) {
  return stockpileRunSlots(now, cycleDay).length;
}

function windowNights(maxDays) {
  const n = Math.trunc(Number(maxDays));
  const raw = Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DAYS;
  return Math.min(MAX_WINDOW_NIGHTS, Math.max(1, raw));
}

/**
 * 'check' means this 23:00 UTC run is one of the last 7 nights before renewal.
 * A higher GOLFAPI_STOCKPILE_MAX_DAYS is clamped to 7. Further out is 'outside'
 * and does not call golfapi.
 */
export function stockpilePhase(now, cycleDay = DEFAULT_CYCLE_DAY, maxDays = DEFAULT_MAX_DAYS) {
  const runs = stockpileRunsRemaining(now, cycleDay);
  const window = windowNights(maxDays);
  if (runs <= 0 || runs > window) return 'outside';
  return 'check';
}

export function stockpileDaysLeft(now, cycleDay = DEFAULT_CYCLE_DAY) {
  return stockpileRunsRemaining(now, cycleDay);
}

function roundCredit(n) {
  return Math.round(Number(n) * 10) / 10;
}

function optionalNumber(env, name) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Dry projection of the nightly budgets.
 * The window is the last 7 23:00 UTC nights before renewal. `maxDays` is
 * clamped to 7. A night in that window spends
 * (balance - rollover) / nights still left, including tonight, and never more
 * than runCap. A night spends 0 when golfers are already at the monthly cap,
 * or when they have under `headroom` credits of daily room left. The monthly
 * cap closes the night; it does not shrink a night that still has room.
 */
export function stockpileSchedule({
  now,
  cycleDay = DEFAULT_CYCLE_DAY,
  liveLeft,
  rollover = DEFAULT_ROLLOVER,
  runCap,
  dailyCap,
  headroom = DEFAULT_HEADROOM,
  floor = DEFAULT_FLOOR,
  monthCap = Number.POSITIVE_INFINITY,
  monthUsed = 0,
  dayUsed = 0,
  golferEstimate = 0,
  maxDays = DEFAULT_MAX_DAYS,
}) {
  const slots = stockpileRunSlots(now, cycleDay);
  const runsRemaining = slots.length;
  const surplus = creditsAboveRollover(liveLeft, rollover);
  const estimate = Math.max(0, Number(golferEstimate) || 0);
  const cap = Number(runCap);
  const window = windowNights(maxDays);
  const canSpend = Number(liveLeft) > Number(floor) && surplus >= 1;
  const daysNeeded = canSpend ? window : 0;
  const inWindow = canSpend && runsRemaining > 0 && runsRemaining <= window;
  const startIndex = canSpend ? Math.max(0, runsRemaining - window) : runsRemaining;
  const perDay = window;
  const monthLimit = Number(monthCap);
  const monthSpent = Math.max(0, Number(monthUsed) || 0);
  const monthHasRoom = !Number.isFinite(monthLimit) || monthSpent < monthLimit;
  const runs = [];
  let balance = roundCredit(liveLeft);
  for (let i = startIndex; i < runsRemaining; i += 1) {
    const daysStill = runsRemaining - i;
    const used = i === 0 ? Math.max(0, Number(dayUsed) || 0) : estimate;
    const above = creditsAboveRollover(balance, rollover);
    let budget = 0;
    const golfersHaveRoom = Number(dailyCap) - used >= Number(headroom);
    if (monthHasRoom && golfersHaveRoom && balance > Number(floor) && above >= 1 && Number.isFinite(cap) && cap > 0) {
      budget = Math.min(above / daysStill, cap, above);
      budget = roundCredit(Math.max(0, budget));
      if (balance - budget < Number(rollover)) budget = roundCredit(Math.max(0, balance - Number(rollover)));
    }
    const balanceAfter = roundCredit(Math.max(0, balance - budget));
    runs.push({ at: new Date(slots[i]).toISOString(), budget, balanceAfter });
    balance = balanceAfter;
  }
  const today = inWindow && startIndex === 0 ? runs[0] : null;
  return {
    runsRemaining,
    daysNeeded,
    inWindow,
    perDay,
    startAt: runs[0] ? runs[0].at : null,
    todayBudget: today ? today.budget : 0,
    finalBalance: runs.length ? runs[runs.length - 1].balanceAfter : roundCredit(liveLeft),
    runs,
  };
}

export function creditsAboveRollover(liveLeft, rollover) {
  if (liveLeft == null || !Number.isFinite(Number(liveLeft))) return 0;
  return Math.max(0, Math.round((Number(liveLeft) - Number(rollover)) * 10) / 10);
}

/** A pull is allowed only when the live balance would stay at or above the rollover. */
export function livePullAllowed(liveLeft, cost, rollover) {
  if (liveLeft == null || !Number.isFinite(Number(liveLeft))) return false;
  const next = Math.round((Number(liveLeft) - Number(cost)) * 10) / 10;
  return next >= Number(rollover);
}

function pointOk(point) {
  return !!point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
}

function holeNumber(hole) {
  const n = Number(hole?.hole ?? hole?.ref);
  if (!Number.isInteger(n) || n < 1 || n > 18) return null;
  return n;
}

function classifyHoleMap(map, expected) {
  const count = Number(expected);
  if (!Number.isInteger(count) || count < 1) {
    if (map.size === 0) return { kind: 'unknown', reason: 'no_match' };
    for (const hole of map.values()) {
      if (!pointOk(hole.tee) || !pointOk(hole.green)) return { kind: 'gap' };
    }
    return { kind: 'unknown', reason: 'no_match' };
  }
  for (let n = 1; n <= count; n += 1) {
    const hole = map.get(n);
    if (!hole || !pointOk(hole.tee) || !pointOk(hole.green)) return { kind: 'gap' };
  }
  return { kind: 'complete' };
}

function overpassRef(tags) {
  if (!tags || typeof tags !== 'object') return null;
  for (const key of ['ref', 'hole', 'hole_number', 'holeNumber']) {
    const n = Number(tags[key]);
    if (Number.isInteger(n) && n >= 1 && n <= 18) return n;
  }
  return null;
}

function classifyOverpass(elements, expected) {
  const map = new Map();
  let numbered = false;
  for (const element of elements) {
    const tags = element?.tags;
    const kind = typeof tags?.golf === 'string' ? tags.golf.trim().toLowerCase() : '';
    if (kind !== 'tee' && kind !== 'green') continue;
    const ref = overpassRef(tags);
    if (ref == null) continue;
    numbered = true;
    const hole = map.get(ref) || { hole: ref, tee: null, green: null };
    const geometry = Array.isArray(element.geometry) ? element.geometry[0] : null;
    const point = geometry && Number.isFinite(Number(geometry.lat)) && Number.isFinite(Number(geometry.lon))
      ? { lat: Number(geometry.lat), lng: Number(geometry.lon) }
      : { lat: 0, lng: 0 };
    if (kind === 'tee') hole.tee = point;
    if (kind === 'green') hole.green = point;
    map.set(ref, hole);
  }
  if (!numbered) return { kind: 'unknown', reason: 'no_match' };
  return classifyHoleMap(map, expected);
}

/** complete = tee and green on every hole. gap = pay. unknown = skip, never pay. */
export function classifyOverlayPayload(payload, expectedHoles) {
  if (!payload || typeof payload !== 'object') return { kind: 'unknown', reason: 'error' };
  if (payload.error != null && payload.error !== false) {
    if (payload.error === 'no_overlay' || payload.error === 'unknown_route') {
      return { kind: 'unknown', reason: 'no_match' };
    }
    return { kind: 'unknown', reason: 'error' };
  }
  const expected = expectedHoles || payload.numHoles;
  if (Array.isArray(payload.holes)) {
    const map = new Map();
    for (const hole of payload.holes) {
      const n = holeNumber(hole);
      if (n == null) continue;
      map.set(n, hole);
    }
    return classifyHoleMap(map, expected);
  }
  if (Array.isArray(payload.elements)) return classifyOverpass(payload.elements, expected);
  return { kind: 'unknown', reason: 'no_match' };
}

export async function coverageFromOverlayResponse(response, expectedHoles) {
  if (!response) return { kind: 'unknown', reason: 'error' };
  if (response.status === 404) return { kind: 'unknown', reason: 'no_match' };
  if (response.status !== 200) return { kind: 'unknown', reason: 'error' };
  try {
    return classifyOverlayPayload(await response.json(), expectedHoles);
  } catch {
    return { kind: 'unknown', reason: 'error' };
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function adminTokenOk(request, env) {
  const expected = typeof env?.ALERT_ADMIN_TOKEN === 'string' ? env.ALERT_ADMIN_TOKEN.trim() : '';
  const got = (request.headers.get('X-Admin-Token') || '').trim();
  if (!expected || got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function counterStub(env) {
  const ns = env && env.GOLFAPI_COUNTER;
  if (!ns || typeof ns.get !== 'function') return null;
  const id = typeof ns.idFromName === 'function' ? ns.idFromName('golfapi') : 'golfapi';
  return ns.get(id);
}

async function counterFetch(env, body) {
  const stub = counterStub(env);
  if (!stub || typeof stub.fetch !== 'function') return null;
  const response = await stub.fetch('https://golfapi-counter.internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

function cycleIdOf(now, cycleDay) {
  const day = Math.min(28, Math.max(1, Number(cycleDay) || DEFAULT_CYCLE_DAY));
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() < day) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function stockpileKeys(now, env) {
  const cycleDay = cycleDayOf(env);
  const cycleId = cycleIdOf(now, cycleDay);
  return {
    dayKey: `golfapi:credit:day:${utcDay(now)}`,
    monthKey: `golfapi:credit:month:${cycleId}`,
    stockpileDayKey: `golfapi:stockpile:credit:day:${utcDay(now)}`,
    stockpileMonthKey: `golfapi:stockpile:credit:month:${cycleId}`,
    cycleId,
    cycleDay,
    cursorKey: `golfapi:stockpile:cursor:${cycleId}`,
  };
}

function readLeft(payload, headers) {
  const raw = payload && payload.apiRequestsLeft;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return n;
  }
  if (headers && typeof headers.get === 'function') {
    for (const name of ['apiRequestsLeft', 'X-Api-Requests-Left']) {
      const header = headers.get(name);
      if (header == null || String(header).trim() === '') continue;
      const n = Number(String(header).trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function blankReport(phase, now, keys, rollover) {
  return {
    at: now.toISOString(),
    cycleId: keys.cycleId,
    phase,
    skipped: null,
    stopped: null,
    added: 0,
    spent: 0,
    osmComplete: 0,
    osmUnknown: 0,
    skips: [],
    liveLeft: null,
    remaining: null,
    rollover,
    dryRun: false,
    wouldPull: [],
  };
}

function rememberSkip(report, course, reason) {
  if (reason === 'osm_complete') report.osmComplete += 1;
  else report.osmUnknown += 1;
  if (report.skips.length < 100) {
    report.skips.push({
      courseId: course.courseId || null,
      name: course.name || '',
      reason,
    });
  }
}

function tenths(credits) {
  return Math.round(Number(credits) * 10);
}

async function emailReport(env, report) {
  const { sendPlainEmail } = await import('./golf-proxy.js');
  const remaining = report.remaining == null ? 'unknown' : String(report.remaining);
  const would = (report.wouldPull || []).map((row) => `${row.courseId} (${row.cost})`).join(', ') || 'none';
  const plan = report.schedule
    ? `Plan start ${report.schedule.startAt || 'none'}, tonight ${report.schedule.todayBudget}, lands at ${report.schedule.finalBalance}.`
    : '';
  const text = [
    `ShotTraxx golfapi stockpile (${report.phase}).`,
    report.dryRun ? 'Dry run: no paid golfapi call was made.' : '',
    plan,
    `Courses added: ${report.added}`,
    `Credits spent: ${report.spent}`,
    `Skipped, OSM already complete: ${report.osmComplete}`,
    `Skipped, OSM unknown: ${report.osmUnknown}`,
    `Would pull: ${would}`,
    `Remaining expiring credits: ${remaining}`,
    `Live apiRequestsLeft: ${report.liveLeft == null ? 'unknown' : report.liveLeft}`,
    `Never-expire balance kept: ${report.rollover}`,
    report.stopped ? `Stopped: ${report.stopped}` : 'Stopped: finished',
  ].filter(Boolean).join('\n');
  return sendPlainEmail(env, 'ShotTraxx golfapi stockpile', text);
}

function courseRow(row) {
  if (!row || typeof row !== 'object') return null;
  const idRaw = row.courseID ?? row.courseId;
  const courseId = idRaw == null ? '' : String(idRaw).trim();
  if (!courseId) return null;
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  const holes = Number(row.numHoles);
  return {
    courseId,
    courseName: row.courseName || '',
    clubName: row.clubName || '',
    name: row.courseName || row.clubName || row.name || '',
    city: row.city || '',
    state: usStateCode(row.state),
    country: row.country || '',
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    numHoles: Number.isInteger(holes) && holes > 0 ? holes : null,
    hasGPS: row.hasGPS,
    numCoordinates: row.numCoordinates,
  };
}

async function golfGet(env, path) {
  const key = typeof env.GOLFAPI_KEY === 'string' ? env.GOLFAPI_KEY.trim() : '';
  if (!key) return { error: 'not_configured' };
  const response = await fetch(`https://golfapi.io/api/v2.3/${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { response, text, payload, status: response.status };
}

async function judgeOverlay(course, hooks) {
  if (!hooks || typeof hooks.overlay !== 'function') return { kind: 'unknown', reason: 'error' };
  const timeoutMs = hooks.timeoutMs || 8000;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      Promise.resolve(hooks.overlay(course)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  } catch {
    return { kind: 'unknown', reason: 'error' };
  }
  if (!result) return { kind: 'unknown', reason: 'error' };
  if (result.kind === 'complete' || result.kind === 'gap' || result.kind === 'unknown') return result;
  if (typeof result.json === 'function' || typeof result.status === 'number') {
    return coverageFromOverlayResponse(result, course.numHoles);
  }
  return classifyOverlayPayload(result, course.numHoles);
}

export async function handleStockpileAdmin(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  if (!adminTokenOk(request, env)) return json(401, { error: 'unauthorized' });
  const listed = await counterFetch(env, { op: 'readStockpileReport' });
  return json(200, (listed && listed.report) || {
    added: 0,
    spent: 0,
    osmComplete: 0,
    osmUnknown: 0,
    skips: [],
    remaining: null,
  });
}

export async function runGolfapiStockpile(env, ctx, event = {}, hooks = {}) {
  const now = new Date(typeof event.scheduledTime === 'number' ? event.scheduledTime : Date.now());
  const keys = stockpileKeys(now, env || {});
  const maxDays = envNumber(env, 'GOLFAPI_STOCKPILE_MAX_DAYS', DEFAULT_MAX_DAYS);
  const phase = stockpilePhase(now, keys.cycleDay, maxDays);
  if (!stockpileEnabled(env)) return { skipped: 'disabled', phase };
  const cron = typeof event.cron === 'string' ? event.cron : '';
  if (cron !== STOCKPILE_CRON) return { skipped: 'cron', phase };
  if (phase === 'outside') return { skipped: 'outside', phase };
  const runCap = optionalNumber(env, 'GOLFAPI_STOCKPILE_RUN_CREDITS');
  if (runCap == null) return { skipped: 'no_run_cap', phase };

  const locked = await counterFetch(env, { op: 'stockpileLock', now: now.getTime(), ttlSec: LOCK_TTL_SEC });
  if (!locked || locked.ok === false) return { skipped: 'locked', phase };

  const rollover = envNumber(env, 'GOLFAPI_ROLLOVER_CREDITS', DEFAULT_ROLLOVER);
  const floor = envNumber(env, 'GOLFAPI_CREDIT_FLOOR', DEFAULT_FLOOR);
  const headroom = envNumber(env, 'GOLFAPI_STOCKPILE_DAY_HEADROOM', DEFAULT_HEADROOM);
  const dayCap = envNumber(env, 'GOLFAPI_DAILY_CAP', 150);
  const monthCap = envNumber(env, 'GOLFAPI_MONTHLY_CAP', 450);
  const report = blankReport(phase, now, keys, rollover);
  const chargeBody = {
    golferDayKey: keys.dayKey,
    stockpileDayKey: keys.stockpileDayKey,
    stockpileMonthKey: keys.stockpileMonthKey,
    dayCap,
    runCap,
    dayHeadroomTenths: tenths(headroom),
    monthCap,
    monthKey: keys.monthKey,
  };

  const kv = env.GOLFAPI_KV;
  const dryRun = stockpileDryRun(env);
  report.dryRun = dryRun;
  let searchTenths = 0;
  let pullCredits = 0;
  let pullBudget = 0;

  const finish = async () => {
    report.remaining = report.liveLeft == null ? null : creditsAboveRollover(report.liveLeft, rollover);
    await counterFetch(env, { op: 'saveStockpileReport', report });
    await emailReport(env, report);
    await counterFetch(env, { op: 'stockpileUnlock' });
    return report;
  };

  try {
    const usage = await counterFetch(env, { op: 'readUsage', dayKey: keys.dayKey, monthKey: keys.monthKey });
    const dayUsed = usage && Number.isFinite(Number(usage.day)) ? Number(usage.day) : 0;
    const monthUsed = usage && Number.isFinite(Number(usage.month)) ? Number(usage.month) : 0;
    const configuredEstimate = optionalNumber(env, 'GOLFAPI_STOCKPILE_GOLFER_DAILY');
    const golferEstimate = configuredEstimate == null ? dayUsed : configuredEstimate;
    const applySchedule = (liveLeft) => {
      const schedule = stockpileSchedule({
        now,
        cycleDay: keys.cycleDay,
        liveLeft,
        rollover,
        runCap,
        dailyCap: dayCap,
        headroom,
        floor,
        monthCap,
        monthUsed,
        dayUsed,
        golferEstimate,
        maxDays,
      });
      report.schedule = schedule;
      report.liveLeft = liveLeft;
      if (!schedule.inWindow || schedule.todayBudget < 1) {
        if (Number(liveLeft) <= floor) report.stopped = 'floor';
        else if (schedule.inWindow && Number(monthUsed) >= Number(monthCap)) report.stopped = 'app_monthly';
        else if (!schedule.inWindow && schedule.daysNeeded <= 0) report.stopped = 'rollover';
        else if (!schedule.inWindow) report.stopped = 'not_yet';
        else report.stopped = 'app_daily';
        return false;
      }
      pullBudget = schedule.todayBudget;
      report.phase = 'run';
      return true;
    };

    if (!dryRun && dayCap - dayUsed < headroom) {
      report.stopped = 'app_daily';
      return finish();
    }

    if (dryRun) {
      const hooked = hooks && Number.isFinite(Number(hooks.liveLeft)) ? Number(hooks.liveLeft) : null;
      if (hooked == null) pullBudget = Number.POSITIVE_INFINITY;
      else if (!applySchedule(hooked)) return finish();
    } else {
    const probed = await spend(env, chargeBody, SEARCH_TENTHS, report);
    if (!probed) {
      report.stopped = report.stopped || 'cap';
      return finish();
    }
    searchTenths += SEARCH_TENTHS;
    let probe;
    try {
      probe = await golfGet(env, `courses?country=US&name=${encodeURIComponent(BALANCE_PROBE_NAME)}`);
    } catch {
      await refund(env, chargeBody, SEARCH_TENTHS, report);
      report.stopped = 'golfapi_error';
      return finish();
    }
    if (probe.error || !probe.response || probe.response.status !== 200 || (probe.payload && probe.payload.error)) {
      await refund(env, chargeBody, SEARCH_TENTHS, report);
      report.stopped = probe.error || 'golfapi_error';
      return finish();
    }
    const left = readLeft(probe.payload, probe.response.headers);
    if (looksLikeQuota(probe.payload)) {
      await refund(env, chargeBody, SEARCH_TENTHS, report);
      report.stopped = 'quota';
      if (left != null) report.liveLeft = left;
      return finish();
    }
    if (left == null) {
      report.stopped = 'golfapi_error';
      return finish();
    }
    report.liveLeft = left;
    if (kv) await kv.put('gq:balance', JSON.stringify({ left, at: now.getTime(), lastStatus: 200 }));
    if (left <= floor) {
      report.stopped = 'floor';
      return finish();
    }
    if (!livePullAllowed(left, 1, rollover)) {
      report.stopped = 'rollover';
      return finish();
    }

    if (!applySchedule(left)) return finish();
    }

    const cursor = await readCursor(kv, keys.cursorKey);
    const demand = (await counterFetch(env, { op: 'readDemand', cycleId: keys.cycleId })) || {
      pull_candidates: [],
      no_data: [],
    };
    const blocked = new Set(
      (demand.no_data || []).map((row) => (row && row.courseId ? String(row.courseId) : '')).filter(Boolean),
    );
    const stateRows = dryRun
      ? { states: [] }
      : ((await counterFetch(env, { op: 'readStateCounts', cycleId: keys.cycleId })) || { states: [] });
    const queue = [];
    for (const row of demand.pull_candidates || []) {
      if (row && row.courseId && blocked.has(String(row.courseId))) continue;
      queue.push({ source: 'demand', row });
    }
    for (const row of stateRows.states || []) queue.push({ source: 'state', state: row.state });
    if (!dryRun) {
      for (const metro of STOCKPILE_METROS) queue.push({ source: 'metro', ...metro });
    }

    const haltPulls = () => {
      if (report.stopped) return true;
      if (pullCredits < pullBudget) return false;
      if (report.liveLeft != null && report.liveLeft <= floor) report.stopped = 'floor';
      else if (!livePullAllowed(report.liveLeft, 1, rollover)) report.stopped = 'rollover';
      else report.stopped = 'run_cap';
      return true;
    };

    for (const item of queue) {
      if (haltPulls()) break;
      const courses = await resolveItem(env, item, cursor, chargeBody, report, () => searchTenths, (n) => {
        searchTenths += n;
      }, dryRun);
      if (report.stopped) break;
      for (const course of courses) {
        if (haltPulls()) break;
        await stockpileOne(env, kv, course, keys, now, cursor, chargeBody, report, rollover, floor, hooks, dryRun, () => {
          pullCredits += 1;
          return pullCredits <= pullBudget;
        });
        await writeCursor(kv, keys.cursorKey, cursor);
        if (report.stopped) break;
      }
    }
    await writeCursor(kv, keys.cursorKey, cursor);
    return finish();
  } catch {
    report.stopped = report.stopped || 'golfapi_error';
    return finish();
  }
}

async function spend(env, chargeBody, chargeTenths, report) {
  const charged = await counterFetch(env, { op: 'stockpileCharge', ...chargeBody, chargeTenths });
  if (!charged || charged.ok === false) {
    report.stopped = charged?.reason || 'cap';
    return false;
  }
  report.spent = Math.round((report.spent + chargeTenths / 10) * 10) / 10;
  return true;
}

async function refund(env, chargeBody, chargeTenths, report) {
  await counterFetch(env, { op: 'stockpileRefund', ...chargeBody, chargeTenths });
  report.spent = Math.max(0, Math.round((report.spent - chargeTenths / 10) * 10) / 10);
}

async function readCursor(kv, key) {
  const empty = { done: [], partial: [], skipped: {}, searched: { demand: [], state: [], metro: [] } };
  if (!kv) return empty;
  const raw = await kv.get(key);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    return {
      done: Array.isArray(parsed.done) ? parsed.done : [],
      partial: Array.isArray(parsed.partial) ? parsed.partial : [],
      skipped: parsed.skipped && typeof parsed.skipped === 'object' ? parsed.skipped : {},
      searched: parsed.searched || empty.searched,
    };
  } catch {
    return empty;
  }
}

async function writeCursor(kv, key, cursor) {
  if (!kv) return;
  await kv.put(key, JSON.stringify(cursor));
}

function permanentKey(kind, id) {
  return `golfapi:permanent:${kind}:${id}`;
}

async function courseStored(kv, id) {
  if (!kv) return false;
  return Boolean(await kv.get(permanentKey('course', id)));
}

async function coordStored(kv, id) {
  if (!kv) return false;
  return Boolean(await kv.get(permanentKey('coordinates', id)));
}

async function bothStored(kv, id) {
  return (await courseStored(kv, id)) && (await coordStored(kv, id));
}

function demandCourse(row) {
  return {
    courseId: String(row.courseId),
    name: row.name || '',
    country: row.country || '',
    state: usStateCode(row.state),
    lat: null,
    lng: null,
    numHoles: Number.isInteger(Number(row.numHoles)) ? Number(row.numHoles) : null,
    hasGPS: row.hasGPS,
    numCoordinates: row.numCoordinates,
  };
}

async function resolveItem(env, item, cursor, chargeBody, report, searchTenths, addSearch, dryRun) {
  if (item.source === 'demand') {
    const row = item.row || {};
    if (countryKnownNonUs(row.country)) return [];
    if (row.courseId) return [demandCourse(row)];
    if (dryRun || !row.name) return [];
    const token = `${String(row.name).trim().toLowerCase()}|US`;
    if (cursor.searched.demand.includes(token)) return [];
    const found = await searchCourses(env, chargeBody, report, searchTenths, addSearch, queryFor({
      name: row.name || '',
      country: 'US',
    }));
    if (found.searched) cursor.searched.demand.push(token);
    return found.courses.filter((course) => !countryKnownNonUs(course.country) && namesMatchCourse(row.name, course)).slice(0, 1);
  }
  if (dryRun) return [];
  if (item.source === 'state') {
    const state = usStateCode(item.state);
    if (!state || cursor.searched.state.includes(state)) return [];
    const found = await searchCourses(env, chargeBody, report, searchTenths, addSearch, `country=US&state=${encodeURIComponent(state)}`);
    if (found.searched) cursor.searched.state.push(state);
    return found.courses.filter((course) => !countryKnownNonUs(course.country));
  }
  const metroKey = `${item.city}|${item.state}`;
  if (cursor.searched.metro.includes(metroKey)) return [];
  const found = await searchCourses(
    env,
    chargeBody,
    report,
    searchTenths,
    addSearch,
    `country=US&city=${encodeURIComponent(item.city)}&state=${encodeURIComponent(item.state)}`,
  );
  if (found.searched) cursor.searched.metro.push(metroKey);
  return found.courses.filter((course) => !countryKnownNonUs(course.country));
}

function queryFor(parts) {
  const params = new URLSearchParams();
  if (parts.name) params.set('name', parts.name);
  if (parts.country) params.set('country', parts.country);
  if (parts.state) params.set('state', parts.state);
  if (parts.city) params.set('city', parts.city);
  return params.toString();
}

async function searchCourses(env, chargeBody, report, searchTenths, addSearch, query) {
  if (searchTenths() + SEARCH_TENTHS > SEARCH_CAP_TENTHS) {
    report.stopped = report.stopped || 'search_cap';
    return { courses: [], searched: false };
  }
  if (!(await spend(env, chargeBody, SEARCH_TENTHS, report))) return { courses: [], searched: false };
  addSearch(SEARCH_TENTHS);
  let got;
  try {
    got = await golfGet(env, `courses?${query}`);
  } catch {
    await refund(env, chargeBody, SEARCH_TENTHS, report);
    report.stopped = 'golfapi_error';
    return { courses: [], searched: false };
  }
  if (!got.response || got.response.status !== 200 || (got.payload && got.payload.error)) {
    await refund(env, chargeBody, SEARCH_TENTHS, report);
    report.stopped = 'golfapi_error';
    return { courses: [], searched: false };
  }
  const left = readLeft(got.payload, got.response.headers);
  if (looksLikeQuota(got.payload)) {
    await refund(env, chargeBody, SEARCH_TENTHS, report);
    report.stopped = 'quota';
    if (left != null) report.liveLeft = left;
    return { courses: [], searched: false };
  }
  if (left != null) report.liveLeft = left;
  const rows = Array.isArray(got.payload?.courses) ? got.payload.courses : [];
  return { courses: rows.map(courseRow).filter(Boolean), searched: true };
}

function locationOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const lat = Number(body.latitude ?? body.lat);
  const lng = Number(body.longitude ?? body.lng);
  const holes = Number(body.numHoles);
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    numHoles: Number.isInteger(holes) && holes > 0 ? holes : null,
    hasGPS: body.hasGPS,
    numCoordinates: body.numCoordinates,
    country: body.country || body.countryCode || '',
    name: body.courseName || body.clubName || body.name || '',
  };
}

async function readStoredJson(kv, kind, id) {
  if (!kv) return null;
  const raw = await kv.get(permanentKey(kind, id));
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw);
    return JSON.parse(envelope.body);
  } catch {
    return null;
  }
}

function coordsHaveMap(payload) {
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
    if (!Number.isInteger(hole) || hole < 1 || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
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

async function recordNoData(env, keys, now, course) {
  await counterFetch(env, {
    op: 'noteCourses',
    cycleId: keys.cycleId,
    day: utcDay(now),
    reason: 'no_data',
    courses: [{
      courseId: course.courseId || '',
      name: course.name || '',
      country: countryIsUs(course.country) ? course.country : (course.country || ''),
    }],
  });
}

async function markNoData(kv, id) {
  if (!kv || !id) return;
  const key = `golfapi:nodata:${id}`;
  if (await kv.get(key)) return;
  await kv.put(key, '1');
}

async function hasNoData(kv, id) {
  if (!kv || !id) return false;
  return Boolean(await kv.get(`golfapi:nodata:${id}`));
}

async function hasUsMarker(kv, id) {
  if (!kv || !id) return false;
  return Boolean(await kv.get(`golfapi:us:${id}`));
}

async function rememberNoData(env, kv, keys, now, course, cursor) {
  await markNoData(kv, course.courseId);
  await recordNoData(env, keys, now, course);
  if (cursor && course.courseId) cursor.skipped[course.courseId] = 'no_data';
}

async function markUs(kv, id) {
  if (!kv || !id) return;
  const key = `golfapi:us:${id}`;
  if (await kv.get(key)) return;
  await kv.put(key, '1');
}

async function stockpileOne(env, kv, course, keys, now, cursor, chargeBody, report, rollover, floor, hooks, dryRun, countPull) {
  const id = course.courseId;
  if (!id || cursor.done.includes(id) || cursor.skipped[id]) return;
  if (await hasNoData(kv, id)) {
    cursor.skipped[id] = 'no_data';
    return;
  }
  if (!countryIsUs(course.country)) {
    if (!(countryBlank(course.country) && await hasUsMarker(kv, id))) return;
  }
  if (zeroGps(course)) {
    await rememberNoData(env, kv, keys, now, course, cursor);
    return;
  }
  if (await bothStored(kv, id)) {
    const stored = locationOf(await readStoredJson(kv, 'course', id));
    if (stored && countryIsUs(stored.country)) await markUs(kv, id);
    cursor.done.push(id);
    return;
  }

  let details = locationOf(await readStoredJson(kv, 'course', id));
  if (!details) {
    if (dryRun) {
      report.wouldPull.push({ courseId: id, cost: 2 });
      return;
    }
    const bought = await pullOne(env, kv, `courses/${encodeURIComponent(id)}`, 'course', id, chargeBody, report, rollover, floor, countPull);
    if (bought === 'nodata') {
      await rememberNoData(env, kv, keys, now, course, cursor);
      return;
    }
    if (bought !== 'ok') return;
    details = locationOf(await readStoredJson(kv, 'course', id));
  }
  if (!details || !countryIsUs(details.country)) {
    cursor.skipped[id] = 'non_us';
    return;
  }
  await markUs(kv, id);
  if (zeroGps(details)) {
    await rememberNoData(env, kv, keys, now, { ...course, name: details.name || course.name, country: details.country }, cursor);
    return;
  }

  const lat = details && details.lat != null ? details.lat : null;
  const lng = details && details.lng != null ? details.lng : null;
  if (lat == null || lng == null) {
    rememberSkip(report, course, 'osm_unknown');
    cursor.skipped[id] = 'osm_unknown';
    return;
  }
  if (await coordStored(kv, id)) {
    cursor.done.push(id);
    return;
  }
  const coverage = await judgeOverlay({
    ...course,
    lat,
    lng,
    numHoles: (details && details.numHoles) || course.numHoles,
  }, hooks);
  if (coverage.kind === 'complete') {
    rememberSkip(report, course, 'osm_complete');
    cursor.skipped[id] = 'osm_complete';
    cursor.done.push(id);
    return;
  }
  if (coverage.kind !== 'gap') {
    rememberSkip(report, course, 'osm_unknown');
    cursor.skipped[id] = 'osm_unknown';
    return;
  }
  if (dryRun) {
    report.wouldPull.push({ courseId: id, cost: 1 });
    return;
  }
  const coords = await pullOne(env, kv, `coordinates/${encodeURIComponent(id)}`, 'coordinates', id, chargeBody, report, rollover, floor, countPull);
  if (coords === 'nodata') {
    await rememberNoData(env, kv, keys, now, course, cursor);
    return;
  }
  if (coords !== 'ok') return;
  if (!coordsHaveMap(await readStoredJson(kv, 'coordinates', id))) {
    await rememberNoData(env, kv, keys, now, course, cursor);
    return;
  }
  report.added += 1;
  cursor.done.push(id);
  cursor.partial = (cursor.partial || []).filter((item) => item !== id);
}

const GOLFAPI_QUOTA_TEXT = /quota|rate.?limit|too many requests|limit (reached|exceeded)|no (api )?requests left|insufficient (credits|requests)|subscription|unauthori[sz]ed|invalid api key|forbidden/i;

function looksLikeQuota(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.message === 'string' && payload.message.trim() !== '') return true;
  for (const field of ['status', 'detail', 'msg']) {
    if (typeof payload[field] === 'string' && GOLFAPI_QUOTA_TEXT.test(payload[field])) return true;
  }
  return false;
}

function courseHasStockpileData(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const holes = Number(payload.numHoles);
  if (Number.isInteger(holes) && holes > 0) return true;
  const lat = Number(payload.latitude ?? payload.lat);
  const lng = Number(payload.longitude ?? payload.lng);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function paidPayloadKeepable(payload, kind) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.error != null && payload.error !== false) return false;
  if (looksLikeQuota(payload)) return false;
  if (kind === 'coordinates') return coordsHaveMap(payload);
  return courseHasStockpileData(payload);
}

async function pullOne(env, kv, path, kind, id, chargeBody, report, rollover, floor, countPull) {
  if (report.liveLeft != null && report.liveLeft <= floor) {
    report.stopped = 'floor';
    return 'stop';
  }
  if (!livePullAllowed(report.liveLeft, 1, rollover)) {
    report.stopped = 'rollover';
    return 'stop';
  }
  if (!countPull()) {
    report.stopped = report.stopped || 'run_cap';
    return 'stop';
  }
  if (!(await spend(env, chargeBody, PULL_TENTHS, report))) return 'stop';
  let got;
  try {
    got = await golfGet(env, path);
  } catch {
    await refund(env, chargeBody, PULL_TENTHS, report);
    report.stopped = 'golfapi_error';
    return 'stop';
  }
  const left = got.response ? readLeft(got.payload, got.response.headers) : null;
  // Quota is not an empty course. Refund this pull's exact credit and stop
  // the night: no nodata marker, no stored body, and no further pulls.
  if (looksLikeQuota(got.payload)) {
    await refund(env, chargeBody, PULL_TENTHS, report);
    report.stopped = 'quota';
    if (left != null) report.liveLeft = left;
    return 'stop';
  }
  if (!got.response || got.response.status < 200 || got.response.status >= 300 || (got.payload && got.payload.error)) {
    await refund(env, chargeBody, PULL_TENTHS, report);
    report.stopped = 'golfapi_error';
    if (left != null) report.liveLeft = left;
    return 'stop';
  }
  if (left == null) {
    await refund(env, chargeBody, PULL_TENTHS, report);
    report.stopped = 'golfapi_error';
    return 'stop';
  }
  report.liveLeft = left;
  if (kv) {
    await kv.put('gq:balance', JSON.stringify({ left, at: Date.now(), lastStatus: got.response.status }));
  }
  if (!paidPayloadKeepable(got.payload, kind)) {
    await markNoData(kv, id);
    return 'nodata';
  }
  if (kv) {
    await kv.put(permanentKey(kind, id), JSON.stringify({
      status: got.response.status,
      contentType: 'application/json',
      body: got.text,
    }));
  }
  if (left <= floor) report.stopped = 'floor';
  return 'ok';
}
