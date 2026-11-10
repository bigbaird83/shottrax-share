/**
 * Wager keys are never left empty. A caller who may not see them gets the
 * surrounding object with those keys removed, not `wager: {}` or `wagers: []`.
 * Share payloads also drop the "$" character. The allowlist itself is not here:
 * it lives in the SharedGame object and stores install ids only.
 */

export const WAGER_KEYS = Object.freeze([
  "wager",
  "wagers",
  "sidegame",
  "sidegames",
  "side_game",
  "side_games",
  "bet",
  "bets",
]);

const WAGER_KEY_RE = /^(wagers?|sidegames?|side_games?|bets?)$/i;

export function carriesWagerKeys(value) {
  if (Array.isArray(value)) return value.some((item) => carriesWagerKeys(item));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (WAGER_KEY_RE.test(key) || carriesWagerKeys(value[key])) return true;
    }
  }
  return false;
}

/**
 * Drop wager keys at every level. An empty object or array is removed with the key,
 * not returned as `wagers: []`.
 */
export function stripWagerKeys(value) {
  if (Array.isArray(value)) return value.map((item) => stripWagerKeys(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (WAGER_KEY_RE.test(key)) continue;
      out[key] = stripWagerKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** Share image and share page text never keep a dollar sign. */
export function scrubMoney(value) {
  if (typeof value === "string") return value.replaceAll("$", "");
  if (Array.isArray(value)) return value.map((item) => scrubMoney(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key.includes("$") || WAGER_KEY_RE.test(key)) continue;
      out[key] = scrubMoney(value[key]);
    }
    return out;
  }
  return value;
}
