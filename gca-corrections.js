/**
 * Hand-checked scorecard corrections for Golf Course API course detail.
 * Applied only to successful JSON `courses/{id}` bodies. A teebox is skipped
 * unless its 18 upstream pars agree with this card wherever those pars are
 * present (null and 0 are not a disagreement).
 *
 * The default mode fills only missing par, handicap, and handicap_women.
 * mode "override" replaces handicap and handicap_women on tees named in
 * teeRows, and does not write par, yardage, rating, slope, names, or teeboxes.
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
    version: "2026-09-27",
    par: [4, 4, 4, 5, 4, 4, 4, 3, 4, 5, 3, 5, 4, 4, 4, 3, 4, 4],
    handicapMen: [17, 9, 1, 13, 3, 5, 15, 11, 7, 16, 18, 14, 10, 2, 4, 12, 8, 6],
    handicapWomen: [17, 7, 3, 9, 11, 1, 13, 15, 5, 8, 16, 12, 14, 4, 2, 10, 18, 6],
  },
  // Greystone (Mountain Springs), Greystone Country Club, Cabot AR. Club scorecard
  // PDF, verified 2026-09-27. Par 36/36 = 72. Card lists Grey 7051, Blue 6509,
  // White 6038, Black 5451, Red 5218. Men's Hdcp matches the Red Hdcp row.
  // Upstream GCA lists White hole 18 as par 4 while the card has par 5, so the
  // existing par-agreement check will leave the White teebox unfilled.
  "14137": {
    source: "club scorecard PDF golfgreystonecc.com (greystone_scorecard.pdf), verified 2026-09-27",
    version: "2026-09-27",
    par: [4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5],
    handicapMen: [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8],
    handicapWomen: [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8],
  },
  // Cypress Creek at Greystone, Cabot AR. Club scorecard photo, verified 2026-09-27.
  // Par 36/36 = 72. Upper HANDICAP is Gold 7392, Blue 6820, White 6303. Lower
  // HANDICAP is Black 5709, Green 5218, Orange 4081, Red 3592, Purple 2934.
  // The card prints one index per tee, so both handicap fields get that row.
  // Upstream copied Mountain Springs' index onto every tee, so this overrides.
  // Upstream's Black/Senior teebox mixes the card's Black rating (65.6/113) with
  // Green's yardage (5218); yardage and ratings are left unchanged.
  "14229": {
    source: "club scorecard photo (Cypress Creek at Greystone), verified 2026-09-27",
    version: "2026-09-27",
    mode: "override",
    par: [4, 4, 5, 3, 4, 4, 5, 4, 3, 4, 5, 4, 3, 4, 4, 3, 4, 5],
    rows: {
      upper: [11, 9, 1, 17, 5, 13, 7, 3, 15, 16, 6, 2, 14, 10, 4, 12, 8, 18],
      lower: [7, 9, 3, 17, 11, 13, 1, 5, 15, 18, 4, 6, 12, 10, 2, 16, 14, 8],
    },
    teeRows: {
      Gold: "upper",
      Blue: "upper",
      White: "upper",
      Black: "lower",
    },
  },
};

function assertOverride(id, entry) {
  const rows = entry.rows;
  if (!rows || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length === 0) {
    throw new Error(`GCA correction ${id} needs rows`);
  }
  for (const [name, values] of Object.entries(rows)) {
    assertPermutation(`${id} rows.${name}`, values);
  }
  const teeRows = entry.teeRows;
  if (!teeRows || typeof teeRows !== "object" || Array.isArray(teeRows) || Object.keys(teeRows).length === 0) {
    throw new Error(`GCA correction ${id} needs teeRows`);
  }
  for (const [teeName, rowName] of Object.entries(teeRows)) {
    if (teeName.trim() === "") {
      throw new Error(`GCA correction ${id} teeRows needs a tee name`);
    }
    if (typeof rowName !== "string" || !Object.prototype.hasOwnProperty.call(rows, rowName)) {
      throw new Error(`GCA correction ${id} teeRows.${teeName} must reference an existing row`);
    }
  }
}

for (const [id, entry] of Object.entries(GCA_CORRECTIONS)) {
  if (typeof entry.source !== "string" || entry.source.trim() === "") {
    throw new Error(`GCA correction ${id} needs a source`);
  }
  if (typeof entry.version !== "string" || entry.version.trim() === "") {
    throw new Error(`GCA correction ${id} needs a version`);
  }
  assertPars(`${id} par`, entry.par);
  const mode = entry.mode ?? "fill";
  if (mode === "fill") {
    assertPermutation(`${id} handicapMen`, entry.handicapMen);
    assertPermutation(`${id} handicapWomen`, entry.handicapWomen);
    continue;
  }
  if (mode !== "override") {
    throw new Error(`GCA correction ${id} mode must be fill or override`);
  }
  assertOverride(id, entry);
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

function correctionMode(correction) {
  return correction.mode === "override" ? "override" : "fill";
}

function rowForTeebox(teebox, correction) {
  if (!teebox || typeof teebox.name !== "string") return null;
  const name = teebox.name.toLowerCase();
  let best = null;
  for (const [teeName, rowName] of Object.entries(correction.teeRows)) {
    const prefix = teeName.toLowerCase();
    if (prefix === "" || !name.startsWith(prefix)) continue;
    if (best == null || prefix.length > best.prefix.length) best = { prefix, rowName };
  }
  if (best == null) return null;
  return correction.rows[best.rowName];
}

function stampCorrections(scorecard, correction, filled) {
  if (filled.size === 0) return false;
  const fields = [];
  if (filled.has("par")) fields.push("par");
  if (filled.has("handicap")) fields.push("handicap");
  if (filled.has("handicap_women")) fields.push("handicap_women");
  scorecard.corrections = {
    source: correction.source,
    fields,
    mode: correctionMode(correction),
    version: correction.version,
  };
  return true;
}

/**
 * Apply a scorecard correction to a parsed `courses/{id}` body.
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
  if (correctionMode(correction) === "override") return applyOverride(scorecard, correction);
  return applyFill(scorecard, correction);
}

function applyFill(scorecard, correction) {
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
  return stampCorrections(scorecard, correction, filled);
}

function applyOverride(scorecard, correction) {
  const filled = new Set();
  for (const teebox of scorecard.teeboxes) {
    const row = rowForTeebox(teebox, correction);
    if (!row || !teeboxEligible(teebox, correction.par)) continue;
    for (let i = 0; i < HOLE_COUNT; i++) {
      const hole = teebox.holes[i];
      hole.handicap = row[i];
      hole.handicap_women = row[i];
    }
    filled.add("handicap");
    filled.add("handicap_women");
  }
  return stampCorrections(scorecard, correction, filled);
}
