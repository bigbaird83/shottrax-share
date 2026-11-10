/**
 * Never-expire golfapi credits. Every live spend must leave at least this many.
 * A shared-card read costs 0. A name search is 0.1, a course or coordinates
 * pull is 1, so a full pull is 2.1 (2 when the course id is already known).
 * This module never calls golfapi.
 */

export const GOLFAPI_CREDIT_FLOOR = 156;

export const GOLFAPI_SEARCH_CREDITS = 0.1;
export const GOLFAPI_COURSE_CREDITS = 1;
export const GOLFAPI_COORDINATES_CREDITS = 1;

function roundCredits(value) {
  return Math.round(Number(value) * 10) / 10;
}

/** Credits one live pull spends. A shared card is 0. A known id skips the search. */
export function golfApiPullCredits({ fromSharedCard = false, knownCourseId = false } = {}) {
  if (fromSharedCard) return 0;
  const search = knownCourseId ? 0 : GOLFAPI_SEARCH_CREDITS;
  return roundCredits(search + GOLFAPI_COURSE_CREDITS + GOLFAPI_COORDINATES_CREDITS);
}

/**
 * True when this spend would leave fewer than `floor` credits.
 * Landing on the floor is allowed. A balance that has never been seen does not block.
 */
export function golfApiSpendBreaksFloor(balanceLeft, cost, floor = GOLFAPI_CREDIT_FLOOR) {
  if (balanceLeft == null || !Number.isFinite(Number(balanceLeft))) return false;
  const next = roundCredits(Number(balanceLeft) - Number(cost || 0));
  return next < Number(floor);
}
