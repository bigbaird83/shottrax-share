export const GOLFAPI_CREDIT_FLOOR: number;
export const GOLFAPI_SEARCH_CREDITS: number;
export const GOLFAPI_COURSE_CREDITS: number;
export const GOLFAPI_COORDINATES_CREDITS: number;

export function golfApiPullCredits(args?: {
  fromSharedCard?: boolean;
  knownCourseId?: boolean;
}): number;

/** True when `balanceLeft - cost` would be below the floor. Unknown balance does not block. */
export function golfApiSpendBreaksFloor(
  balanceLeft: number | null | undefined,
  cost: number,
  floor?: number,
): boolean;
