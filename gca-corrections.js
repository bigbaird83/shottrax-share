/**
 * Hand-checked scorecard fills for Golf Course API course detail.
 * Applied only to successful JSON `courses/{id}` bodies, and only where the
 * upstream value is missing. A teebox is skipped unless its 18 upstream pars
 * agree with this card wherever those pars are present.
 */

const HOLE_COUNT = 18;

function assertPars(label, values) {
  if (!Array.isArray(values) || values.length !== HOLE_COUNT) {
    throw new Error(`${label} must list par for holes 1..18`);
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 3 || value > 5) {
      throw new Error(`${label} must list par for holes 1..18`);
    }
  }
}

function assertPermutation(label, values) {
  if (!Array.isArray(values) || values.length !== HOLE_COUNT) {
    throw new Error(`${label} must be a permutation of 1..18`);
  }
  const seen = new Array(HOLE_COUNT + 1).fill(false);
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > HOLE_COUNT || seen[value]) {
      throw new Error(`${label} must be a permutation of 1..18`);
    }
    seen[value] = true;
  }
}

export const GCA_CORRECTIONS = {
  // Magnolia Country Club, Magnolia AR. Printed card, verified 2026-09-27.
  // Par 36/36 = 72. Men's stroke index is Gold, Blue, and White. Ladies' stroke
  // index is the Red card. Red yardages are not on hand, so no Red teebox is added.
  "14322": {
    source: "club scorecard photo, verified 2026-09-27",
    par: [4, 4, 4, 5, 4, 4, 4, 3, 4, 5, 3, 5, 4, 4, 4, 3, 4, 4],
    handicapMen: [17, 9, 1, 13, 3, 5, 15, 11, 7, 16, 18, 14, 10, 2, 4, 12, 8, 6],
    handicapWomen: [17, 7, 3, 9, 11, 1, 13, 15, 5, 8, 16, 12, 14, 4, 2, 10, 18, 6],
  },
};

for (const [id, entry] of Object.entries(GCA_CORRECTIONS)) {
  if (typeof entry.source !== "string" || entry.source.trim() === "") {
    throw new Error(`GCA correction ${id} needs a source`);
  }
  assertPars(`${id} par`, entry.par);
  assertPermutation(`${id} handicapMen`, entry.handicapMen);
  assertPermutation(`${id} handicapWomen`, entry.handicapWomen);
}

function teeboxEligible(teebox, expectedPar) {
  if (!teebox || typeof teebox !== "object" || Array.isArray(teebox)) return false;
  const holes = teebox.holes;
  if (!Array.isArray(holes) || holes.length !== HOLE_COUNT) return false;
  for (let i = 0; i < HOLE_COUNT; i++) {
    const hole = holes[i];
    if (!hole || typeof hole !== "object" || Array.isArray(hole)) return false;
    const par = hole.par;
    if (par == null || par === 0) continue;
    if (par !== expectedPar[i]) return false;
  }
  return true;
}

/**
 * Fill missing scorecard fields on a parsed `courses/{id}` body.
 * Returns whether any hole value was written.
 */
export function applyGcaScorecardCorrection(payload, courseId) {
  const correction = GCA_CORRECTIONS[courseId];
  if (!correction || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const scorecard = data.scorecard;
  if (!scorecard || typeof scorecard !== "object" || Array.isArray(scorecard)) return false;
  if (!Array.isArray(scorecard.teeboxes)) return false;

  const filled = new Set();
  for (const teebox of scorecard.teeboxes) {
    if (!teeboxEligible(teebox, correction.par)) continue;
    for (let i = 0; i < HOLE_COUNT; i++) {
      const hole = teebox.holes[i];
      if (hole.par == null || hole.par === 0) {
        hole.par = correction.par[i];
        filled.add("par");
      }
      if (hole.handicap == null) {
        hole.handicap = correction.handicapMen[i];
        filled.add("handicap");
      }
      if (hole.handicap_women == null) {
        hole.handicap_women = correction.handicapWomen[i];
        filled.add("handicap_women");
      }
    }
  }
  if (filled.size === 0) return false;

  const fields = [];
  if (filled.has("par")) fields.push("par");
  if (filled.has("handicap")) fields.push("handicap");
  if (filled.has("handicap_women")) fields.push("handicap_women");
  scorecard.corrections = { source: correction.source, fields };
  return true;
}
