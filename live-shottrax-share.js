var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var HOLE_COUNT = 18;
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
__name(assertPars, "assertPars");
__name2(assertPars, "assertPars");
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
__name(assertPermutation, "assertPermutation");
__name2(assertPermutation, "assertPermutation");
var GCA_CORRECTIONS = {
  // Magnolia Country Club, Magnolia AR. Printed card, verified 2026-09-27.
  // Par 36/36 = 72. Men's stroke index is Gold, Blue, and White. Ladies' stroke
  // index is the Red card. Red yardages are not on hand, so no Red teebox is added.
  "14322": {
    source: "club scorecard photo, verified 2026-09-27",
    version: "2026-09-27",
    par: [4, 4, 4, 5, 4, 4, 4, 3, 4, 5, 3, 5, 4, 4, 4, 3, 4, 4],
    handicapMen: [17, 9, 1, 13, 3, 5, 15, 11, 7, 16, 18, 14, 10, 2, 4, 12, 8, 6],
    handicapWomen: [17, 7, 3, 9, 11, 1, 13, 15, 5, 8, 16, 12, 14, 4, 2, 10, 18, 6]
  },
  // Greystone (Mountain Springs), Greystone Country Club, Cabot AR. Club scorecard
  // PDF, verified 2026-09-27. Par 36/36 = 72. Card lists Grey 7051, Blue 6509,
  // White 6038, Black 5451, Red 5218. Men's Hdcp matches the Red Hdcp row.
  // The card and the course owner both confirm hole 18 is par 5. Upstream GCA
  // lists White hole 18 as par 4; parFixes corrects that one value first.
  "14137": {
    source: "club scorecard PDF golfgreystonecc.com (greystone_scorecard.pdf), verified 2026-09-27",
    version: "2026-09-27",
    par: [4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5],
    handicapMen: [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8],
    handicapWomen: [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8],
    parFixes: [{ tee: "White", hole: 18, from: 4, to: 5 }]
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
      lower: [7, 9, 3, 17, 11, 13, 1, 5, 15, 18, 4, 6, 12, 10, 2, 16, 14, 8]
    },
    teeRows: {
      Gold: "upper",
      Blue: "upper",
      White: "upper",
      Black: "lower"
    }
  }
};
function assertParFixes(id, entry) {
  if (entry.parFixes == null) return;
  if (!Array.isArray(entry.parFixes)) {
    throw new Error(`GCA correction ${id} parFixes must be a list`);
  }
  for (const fix of entry.parFixes) {
    if (!fix || typeof fix !== "object" || Array.isArray(fix)) {
      throw new Error(`GCA correction ${id} parFixes entry is invalid`);
    }
    if (typeof fix.tee !== "string" || fix.tee.trim() === "") {
      throw new Error(`GCA correction ${id} parFixes needs a tee name`);
    }
    if (!Number.isInteger(fix.hole) || fix.hole < 1 || fix.hole > HOLE_COUNT) {
      throw new Error(`GCA correction ${id} parFixes hole must be 1..18`);
    }
    if (!Number.isInteger(fix.from) || !Number.isInteger(fix.to) || fix.from === fix.to) {
      throw new Error(`GCA correction ${id} parFixes from and to must be different integers`);
    }
    if (fix.to !== entry.par[fix.hole - 1]) {
      throw new Error(`GCA correction ${id} parFixes to must match card par for hole ${fix.hole}`);
    }
  }
}
__name(assertParFixes, "assertParFixes");
__name2(assertParFixes, "assertParFixes");
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
__name(assertOverride, "assertOverride");
__name2(assertOverride, "assertOverride");
for (const [id, entry] of Object.entries(GCA_CORRECTIONS)) {
  if (typeof entry.source !== "string" || entry.source.trim() === "") {
    throw new Error(`GCA correction ${id} needs a source`);
  }
  if (typeof entry.version !== "string" || entry.version.trim() === "") {
    throw new Error(`GCA correction ${id} needs a version`);
  }
  assertPars(`${id} par`, entry.par);
  assertParFixes(id, entry);
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
__name(teeboxEligible, "teeboxEligible");
__name2(teeboxEligible, "teeboxEligible");
function correctionMode(correction) {
  return correction.mode === "override" ? "override" : "fill";
}
__name(correctionMode, "correctionMode");
__name2(correctionMode, "correctionMode");
function nameStartsWithTee(teebox, tee) {
  if (!teebox || typeof teebox.name !== "string" || typeof tee !== "string") return false;
  const prefix = tee.toLowerCase();
  return prefix !== "" && teebox.name.toLowerCase().startsWith(prefix);
}
__name(nameStartsWithTee, "nameStartsWithTee");
__name2(nameStartsWithTee, "nameStartsWithTee");
function applyParFixes(teebox, correction, filled) {
  if (!Array.isArray(correction.parFixes) || !teebox || !Array.isArray(teebox.holes)) return;
  for (const fix of correction.parFixes) {
    if (!nameStartsWithTee(teebox, fix.tee)) continue;
    const hole = teebox.holes[fix.hole - 1];
    if (!hole || typeof hole !== "object" || Array.isArray(hole)) continue;
    if (hole.par !== fix.from) continue;
    hole.par = fix.to;
    filled.add("par");
  }
}
__name(applyParFixes, "applyParFixes");
__name2(applyParFixes, "applyParFixes");
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
__name(rowForTeebox, "rowForTeebox");
__name2(rowForTeebox, "rowForTeebox");
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
    version: correction.version
  };
  return true;
}
__name(stampCorrections, "stampCorrections");
__name2(stampCorrections, "stampCorrections");
function applyGcaScorecardCorrection(payload, courseId) {
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
__name(applyGcaScorecardCorrection, "applyGcaScorecardCorrection");
__name2(applyGcaScorecardCorrection, "applyGcaScorecardCorrection");
function applyFill(scorecard, correction) {
  const filled = /* @__PURE__ */ new Set();
  for (const teebox of scorecard.teeboxes) {
    applyParFixes(teebox, correction, filled);
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
__name(applyFill, "applyFill");
__name2(applyFill, "applyFill");
function applyOverride(scorecard, correction) {
  const filled = /* @__PURE__ */ new Set();
  for (const teebox of scorecard.teeboxes) {
    applyParFixes(teebox, correction, filled);
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
__name(applyOverride, "applyOverride");
__name2(applyOverride, "applyOverride");
var APP_STORE_ID = "6812944398";
var LIVE_BOARD_POLL_MS = 8e3;
var LIVE_PAGE_PREFIX = "/s/";
var BOARD_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
function esc(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/[<]/g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(esc, "esc");
__name2(esc, "esc");
function normalizeCode(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  let core = trimmed;
  try {
    core = decodeURIComponent(core);
  } catch (err) {
  }
  const compact = core.trim().replace(/[\s-]+/g, "");
  if (!compact) return null;
  if (compact.length <= 8) return compact.toUpperCase();
  return core.trim();
}
__name(normalizeCode, "normalizeCode");
__name2(normalizeCode, "normalizeCode");
function isLiveBoardCode(code) {
  return typeof code === "string" && BOARD_CODE_RE.test(code);
}
__name(isLiveBoardCode, "isLiveBoardCode");
__name2(isLiveBoardCode, "isLiveBoardCode");
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
__name(num, "num");
__name2(num, "num");
function str(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
__name(str, "str");
__name2(str, "str");
function parseBoard(raw) {
  let value = raw;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (err) {
        return null;
      }
      continue;
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    if (Array.isArray(value.holes)) break;
    const inner = value.payload ?? value.data ?? value.value ?? value.board;
    if (inner === void 0) return null;
    value = inner;
  }
  if (value == null || typeof value !== "object" || !Array.isArray(value.holes)) return null;
  const holes = value.holes.filter((row) => row && typeof row === "object" && num(row.hole) != null).map((row) => ({
    hole: row.hole,
    par: num(row.par),
    score: num(row.score),
    putts: num(row.putts),
    startedAt: str(row.startedAt),
    completedAt: str(row.completedAt)
  })).sort((a, b) => a.hole - b.hole);
  const live = value.live && typeof value.live === "object" && num(value.live.hole) != null ? { hole: value.live.hole, lastClubYards: str(value.live.lastClubYards) } : null;
  let group = null;
  if (value.group && typeof value.group === "object" && Array.isArray(value.group.players)) {
    const players = value.group.players.filter((p) => p && typeof p === "object" && str(p.name)).map((p) => ({
      name: p.name,
      handicap: num(p.handicap),
      holes: Array.isArray(p.holes) ? p.holes.filter((h) => h && num(h.hole) != null).map((h) => ({ hole: h.hole, score: num(h.score) })) : [],
      out: num(p.out),
      in: num(p.in),
      total: num(p.total)
    }));
    const results = Array.isArray(value.group.results) ? value.group.results.filter((r) => r && str(r.title) && Array.isArray(r.lines)).map((r) => ({ title: r.title, lines: r.lines.filter((line) => typeof line === "string") })) : [];
    if (players.length > 0) group = { players, results };
  }
  return {
    courseName: str(value.courseName),
    finished: value.finished === true,
    live,
    holes,
    updatedAt: str(value.updatedAt),
    group
  };
}
__name(parseBoard, "parseBoard");
__name2(parseBoard, "parseBoard");
function timeMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
__name(timeMs, "timeMs");
__name2(timeMs, "timeMs");
function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "\u2014";
  const totalMin = Math.round(ms / 6e4);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? m + "m" : h + "h " + String(m).padStart(2, "0") + "m";
}
__name(formatDuration, "formatDuration");
__name2(formatDuration, "formatDuration");
function formatClock(iso) {
  const ms = timeMs(iso);
  if (ms == null) return "\u2014";
  const d = new Date(ms);
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ":" + String(d.getMinutes()).padStart(2, "0") + " " + (h24 < 12 ? "AM" : "PM");
}
__name(formatClock, "formatClock");
__name2(formatClock, "formatClock");
function paceLine(holes, nowMs, finished) {
  const holeCount = holes.length;
  const thru = holes.filter((row) => row.completedAt != null || row.score != null).length;
  const allDone = finished === true || holeCount > 0 && thru >= holeCount;
  const durations = [];
  for (const row of holes) {
    const start = timeMs(row.startedAt);
    const end = timeMs(row.completedAt);
    if (start != null && end != null && end >= start) durations.push(end - start);
  }
  const avg = durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const starts = holes.map((row) => timeMs(row.startedAt)).filter((ms) => ms != null);
  const ends = holes.map((row) => timeMs(row.completedAt)).filter((ms) => ms != null);
  const firstStart = starts.length === 0 ? null : Math.min.apply(null, starts);
  const lastEnd = ends.length === 0 ? null : Math.max.apply(null, ends);
  const endMs = allDone ? lastEnd : nowMs;
  const elapsed = firstStart == null || endMs == null || endMs < firstStart ? null : endMs - firstStart;
  const remaining = allDone ? 0 : avg == null ? null : avg * Math.max(0, holeCount - thru);
  const parts = [allDone ? "Final" : "Thru " + thru];
  if (elapsed != null) parts.push(formatDuration(elapsed) + " elapsed");
  if (remaining != null && remaining > 0) parts.push("~" + formatDuration(remaining) + " left");
  return { thru, holeCount, allDone, line: parts.join(" \xB7 ") };
}
__name(paceLine, "paceLine");
__name2(paceLine, "paceLine");
function scoreTotals(holes) {
  const scored = holes.filter((row) => row.score != null);
  if (scored.length === 0) return { total: null, toPar: null };
  const total = scored.reduce((sum, row) => sum + row.score, 0);
  const parKnown = scored.every((row) => row.par != null);
  const toPar = parKnown ? scored.reduce((sum, row) => sum + row.score - row.par, 0) : null;
  return { total, toPar };
}
__name(scoreTotals, "scoreTotals");
__name2(scoreTotals, "scoreTotals");
function formatToPar(toPar) {
  if (toPar == null) return null;
  if (toPar === 0) return "E";
  return toPar > 0 ? "+" + toPar : String(toPar);
}
__name(formatToPar, "formatToPar");
__name2(formatToPar, "formatToPar");
function planView(board, nowMs) {
  if (!board) return null;
  const pace = paceLine(board.holes, nowMs, board.finished);
  const totals = scoreTotals(board.holes);
  const finished = board.finished || pace.allDone;
  return {
    courseName: board.courseName || "Round",
    finished,
    kicker: finished ? "Final" : "Live",
    total: totals.total,
    toPar: formatToPar(totals.toPar),
    pace: pace.line,
    thru: pace.thru,
    onHole: !finished && board.live ? board.live.hole : null,
    lastClubYards: !finished && board.live ? board.live.lastClubYards : null,
    showPutts: board.holes.some((row) => row.putts != null),
    holes: board.holes,
    updatedAt: board.updatedAt,
    group: board.group
  };
}
__name(planView, "planView");
__name2(planView, "planView");
function previewLine(view) {
  if (!view) return "Follow this round live, hole by hole.";
  const parts = [];
  const score = view.toPar ?? (view.total != null ? String(view.total) : null);
  if (view.finished) parts.push(score ? "Final: " + score : "Final");
  else if (score) parts.push(score + " thru " + view.thru);
  else parts.push("Live now");
  if (view.onHole != null) parts.push("On hole " + view.onHole);
  return parts.join(" \xB7 ");
}
__name(previewLine, "previewLine");
__name2(previewLine, "previewLine");
function scoreClass(score, par) {
  if (score == null || par == null) return "";
  const diff = score - par;
  if (diff <= -2) return " s-eagle";
  if (diff === -1) return " s-birdie";
  if (diff === 1) return " s-bogey";
  if (diff >= 2) return " s-double";
  return "";
}
__name(scoreClass, "scoreClass");
__name2(scoreClass, "scoreClass");
function groupCell(score) {
  return score != null && score >= 1 ? String(score) : "\u2014";
}
__name(groupCell, "groupCell");
__name2(groupCell, "groupCell");
function renderBoard(view, clock) {
  if (!view) {
    return '<section class="empty"><p class="kicker">Live board</p><h1>Waiting for the first hole</h1><p class="muted">This board has no scores yet, or it has ended. It refreshes on its own.</p></section>';
  }
  let html = '<section class="head">';
  html += '<p class="kicker' + (view.finished ? "" : " live") + '">' + esc(view.kicker) + "</p>";
  html += "<h1>" + esc(view.courseName) + "</h1>";
  html += '<p class="total">' + (view.total == null ? "\u2014" : esc(view.total));
  if (view.toPar) html += ' <span class="topar">' + esc(view.toPar) + "</span>";
  html += "</p>";
  html += '<p class="pace">' + esc(view.pace) + "</p>";
  if (view.onHole != null) {
    html += '<p class="muted">On hole ' + esc(view.onHole);
    if (view.lastClubYards) html += " \xB7 Last: " + esc(view.lastClubYards);
    html += "</p>";
  }
  html += "</section>";
  if (view.group && view.group.players.length > 1) {
    const holeSet = /* @__PURE__ */ new Set();
    for (const p of view.group.players) for (const h of p.holes) holeSet.add(h.hole);
    const cols = Array.from(holeSet).sort((a, b) => a - b);
    const full = cols.length >= 18;
    html += '<section class="card"><h2>Group</h2><div class="scroll"><table class="group"><thead><tr><th class="name"></th>';
    for (const c of cols) html += "<th>" + esc(c) + "</th>";
    if (full) html += '<th class="sum">Out</th><th class="sum">In</th>';
    html += '<th class="sum">Tot</th></tr></thead><tbody>';
    for (const p of view.group.players) {
      html += '<tr><th class="name">' + esc(p.name) + (p.handicap != null ? ' <span class="muted">' + esc(p.handicap) + "</span>" : "") + "</th>";
      for (const c of cols) {
        const cell = p.holes.find((h) => h.hole === c);
        html += "<td>" + esc(groupCell(cell ? cell.score : null)) + "</td>";
      }
      if (full) html += '<td class="sum">' + esc(groupCell(p.out)) + '</td><td class="sum">' + esc(groupCell(p.in)) + "</td>";
      html += '<td class="sum">' + esc(groupCell(p.total)) + "</td></tr>";
    }
    html += "</tbody></table></div>";
    for (const block of view.group.results || []) {
      html += '<div class="result"><h3>' + esc(block.title) + "</h3>";
      for (const line of block.lines) html += "<p>" + esc(line) + "</p>";
      html += "</div>";
    }
    html += "</section>";
  }
  if (view.holes.length > 0) {
    html += '<section class="card"><div class="scroll"><table class="holes"><thead><tr><th>Hole</th><th>Par</th><th>Score</th>';
    if (view.showPutts) html += "<th>Putts</th>";
    html += "<th>Start</th><th>Finish</th></tr></thead><tbody>";
    for (const row of view.holes) {
      const current = view.onHole === row.hole ? ' class="current"' : "";
      html += "<tr" + current + "><td>" + esc(row.hole) + "</td>";
      html += "<td>" + (row.par == null ? "\u2014" : esc(row.par)) + "</td>";
      html += '<td class="score' + scoreClass(row.score, row.par) + '">' + (row.score == null ? "\u2014" : esc(row.score)) + "</td>";
      if (view.showPutts) html += "<td>" + (row.putts == null ? "\u2014" : esc(row.putts)) + "</td>";
      html += '<td class="time">' + esc(clock(row.startedAt)) + "</td>";
      html += '<td class="time">' + esc(clock(row.completedAt)) + "</td></tr>";
    }
    html += "</tbody></table></div></section>";
  }
  if (view.updatedAt) html += '<p class="muted small">Updated ' + esc(clock(view.updatedAt)) + "</p>";
  return html;
}
__name(renderBoard, "renderBoard");
__name2(renderBoard, "renderBoard");
var BROWSER_HELPERS = [
  esc,
  num,
  str,
  parseBoard,
  timeMs,
  formatDuration,
  formatClock,
  paceLine,
  scoreTotals,
  formatToPar,
  planView,
  scoreClass,
  groupCell,
  renderBoard
];
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
__name(scriptJson, "scriptJson");
__name2(scriptJson, "scriptJson");
function clientScript(code, board) {
  return [
    ...BROWSER_HELPERS.map((fn) => fn.toString()),
    "var CODE = " + scriptJson(code) + ";",
    "var board = " + scriptJson(board) + ";",
    "var POLL_MS = " + LIVE_BOARD_POLL_MS + ";",
    `var root = document.getElementById("board");
function paint() {
  var view = planView(board, Date.now());
  root.innerHTML = renderBoard(view, formatClock);
  return view;
}
var timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(poll, POLL_MS);
}
function poll() {
  if (document.hidden) { schedule(); return; }
  fetch("/" + encodeURIComponent(CODE), { cache: "no-store", headers: { Accept: "application/json" } })
    .then(function (res) { return res.ok ? res.text() : null; })
    .then(function (text) {
      var next = text ? parseBoard(text) : null;
      if (next) board = next;
    })
    .catch(function () {})
    .then(function () {
      var view = paint();
      if (!view || !view.finished) schedule();
    });
}
document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
var first = paint();
if (!first || !first.finished) schedule();`
  ].join("\n").replace(/<\//g, "<\\/");
}
__name(clientScript, "clientScript");
__name2(clientScript, "clientScript");
var THEME_LIGHT = `--bg: #F7F4EC; --surface: #FFFFFF; --ink: #142018; --muted: #5B6B60; --line: #E3DED1;
  --brand: #0B1A12; --brand-ink: #F4F1E8; --accent: #C8F542; --live: #1F9D55;
  --birdie: #1F7A45; --eagle: #0E5A8A; --bogey: #9A5B00; --double: #B3261E;
  color-scheme: light;`;
var THEME_DARK = `--bg: #0B1A12; --surface: #13271B; --ink: #F4F1E8; --muted: #A9B8AD; --line: #24402F;
  --brand: #060F0A; --brand-ink: #F4F1E8; --accent: #C8F542; --live: #5BD68A;
  --birdie: #6FD39A; --eagle: #7CC4F2; --bogey: #F2B45C; --double: #FF8A80;
  color-scheme: dark;`;
var STYLES = `
:root { ${THEME_LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${THEME_DARK} } }
:root[data-theme="dark"] { ${THEME_DARK} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.bar { background: var(--brand); color: var(--brand-ink); padding: 14px 16px; }
.brand { color: var(--brand-ink); text-decoration: none; font-weight: 800; letter-spacing: 0.02em; }
.wrap { max-width: 40rem; margin: 0 auto; padding: 0 16px; }
main { padding: 20px 0 8px; }
h1 { font-size: 1.6rem; line-height: 1.2; margin: 0 0 6px; }
h2 { font-size: 1rem; margin: 0 0 10px; }
h3 { font-size: 0.95rem; margin: 12px 0 4px; }
p { margin: 0 0 6px; line-height: 1.45; }
.kicker { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.78rem; font-weight: 700; color: var(--muted); }
.kicker.live { color: var(--live); }
.kicker.live::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--live); margin-right: 6px; vertical-align: 1px; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .kicker.live::before { animation: none; } }
.total { font-size: 2.6rem; font-weight: 800; line-height: 1.1; margin: 8px 0 4px; font-variant-numeric: tabular-nums; }
.topar { font-size: 1.4rem; color: var(--muted); font-weight: 700; }
.pace { font-weight: 600; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; margin-top: 10px; }
.head { margin-bottom: 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px; margin-bottom: 14px; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--line); white-space: nowrap; }
thead th { font-size: 0.78rem; color: var(--muted); font-weight: 700; }
tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
td.score { font-weight: 800; }
.s-birdie { color: var(--birdie); } .s-eagle { color: var(--eagle); }
.s-bogey { color: var(--bogey); } .s-double { color: var(--double); }
tr.current td { background: color-mix(in srgb, var(--accent) 22%, transparent); }
td.time { color: var(--muted); font-size: 0.9rem; }
table.group th.name { text-align: left; position: sticky; left: 0; background: var(--surface); max-width: 9rem;
  overflow: hidden; text-overflow: ellipsis; }
.sum { font-weight: 800; }
.result p { color: var(--muted); }
.empty { padding: 24px 0; }
.cta { background: var(--brand); color: var(--brand-ink); border: 1px solid var(--line); border-radius: 16px; padding: 18px 16px; margin: 18px 0; }
.cta h2 { font-size: 1.15rem; margin: 0 0 6px; }
.cta p { color: color-mix(in srgb, var(--brand-ink) 80%, transparent); }
.btn { display: block; text-align: center; padding: 14px 16px; border-radius: 12px; font-weight: 800;
  text-decoration: none; margin-top: 12px; min-height: 48px; }
.btn.primary { background: var(--accent); color: #0B1A12; }
.btn.ghost { color: var(--brand-ink); border: 1px solid color-mix(in srgb, var(--brand-ink) 35%, transparent); }
.open { margin: 18px 0; }
.open .btn { color: var(--ink); border: 1px solid var(--line); background: var(--surface); }
footer { padding: 8px 0 32px; font-size: 0.85rem; }
`;
function storeLive(env) {
  const raw = env && typeof env.STORE_LIVE === "string" ? env.STORE_LIVE.trim().toLowerCase() : "";
  return raw === "true" || raw === "1" || raw === "yes";
}
__name(storeLive, "storeLive");
__name2(storeLive, "storeLive");
function renderLivePage({ code, board, nowMs, storeLive: storeLive2 = false, appStoreId = APP_STORE_ID, nonce }) {
  const view = planView(board, nowMs);
  const title = view ? view.kicker + " \xB7 " + view.courseName : "Live board \xB7 ShotTraxx\u2122";
  const description = previewLine(view);
  const appUrl = "https://apps.apple.com/app/id" + encodeURIComponent(appStoreId);
  const deepLink = "shottrax:///s/" + encodeURIComponent(code);
  const nonceAttr = nonce ? ' nonce="' + esc(nonce) + '"' : "";
  const brand = storeLive2 ? '<a class="brand" href="' + esc(appUrl) + '" aria-label="ShotTraxx on the App Store">ShotTraxx\u2122</a>' : '<span class="brand">ShotTraxx\u2122</span>';
  const banner = storeLive2 ? '<meta name="apple-itunes-app" content="app-id=' + esc(appStoreId) + ", app-argument=" + esc(deepLink) + '">\n' : "";
  const offer = storeLive2 ? `<section class="cta">
<h2>Track your own round</h2>
<p>ShotTraxx\u2122 marks every shot with your phone's GPS, learns your real club distances, and shows where you lose strokes.</p>
<a class="btn primary" href="${esc(appUrl)}">Get ShotTraxx\u2122 on the App Store</a>
<a class="btn ghost" href="${esc(deepLink)}">Already have it? Open in ShotTraxx\u2122</a>
</section>` : `<section class="open"><a class="btn" href="${esc(deepLink)}">Open in ShotTraxx\u2122</a></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
${banner}<meta property="og:type" content="website">
<meta property="og:site_name" content="ShotTraxx\u2122">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0B1A12">
<style${nonceAttr}>${STYLES}</style>
</head>
<body>
<header class="bar"><div class="wrap">${brand}</div></header>
<div class="wrap">
<main id="board" aria-live="polite">${renderBoard(view, () => "")}</main>
${offer}
<footer class="muted">Board ${esc(code)} \xB7 Scores only, no map or location.</footer>
</div>
<script${nonceAttr}>${clientScript(code, board)}<\/script>
</body>
</html>`;
}
__name(renderLivePage, "renderLivePage");
__name2(renderLivePage, "renderLivePage");
function notFoundPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live board \xB7 ShotTraxx\u2122</title>
<meta name="robots" content="noindex">
<style nonce="${esc(nonce)}">${STYLES}</style>
</head>
<body>
<header class="bar"><div class="wrap"><span class="brand">ShotTraxx\u2122</span></div></header>
<div class="wrap"><main><section class="empty"><p class="kicker">Live board</p>
<h1>That's not a board code</h1>
<p class="muted">Board codes are six letters and numbers. Check the link you were sent.</p></section></main></div>
</body>
</html>`;
}
__name(notFoundPage, "notFoundPage");
__name2(notFoundPage, "notFoundPage");
function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
__name(randomNonce, "randomNonce");
__name2(randomNonce, "randomNonce");
function pageHeaders(nonce) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}
__name(pageHeaders, "pageHeaders");
__name2(pageHeaders, "pageHeaders");
function livePageCode(pathname) {
  if (!pathname.startsWith(LIVE_PAGE_PREFIX)) return null;
  const segment = pathname.slice(LIVE_PAGE_PREFIX.length).replace(/\/$/, "");
  if (!segment || segment.includes("/")) return null;
  const code = normalizeCode(segment);
  return isLiveBoardCode(code) ? code : null;
}
__name(livePageCode, "livePageCode");
__name2(livePageCode, "livePageCode");
async function handleLivePage(request, env, { loadBoard, nowMs } = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(LIVE_PAGE_PREFIX)) return null;
  const nonce = randomNonce();
  const code = livePageCode(pathname);
  if (!code) {
    return new Response(request.method === "HEAD" ? null : notFoundPage(nonce), {
      status: 404,
      headers: pageHeaders(nonce)
    });
  }
  let board = null;
  try {
    board = typeof loadBoard === "function" ? parseBoard(await loadBoard(code)) : null;
  } catch {
    board = null;
  }
  const html = renderLivePage({
    code,
    board,
    nowMs: nowMs ?? Date.now(),
    storeLive: storeLive(env),
    appStoreId: env && typeof env.APP_STORE_ID === "string" && env.APP_STORE_ID.trim() || APP_STORE_ID,
    nonce
  });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: pageHeaders(nonce) });
}
__name(handleLivePage, "handleLivePage");
__name2(handleLivePage, "handleLivePage");
var OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
var OVERPASS_MIRROR = "https://overpass.private.coffee/api/interpreter";
var OSM_API_MAP = "https://api.openstreetmap.org/api/0.6/map";
var OVERPASS_USER_AGENT = "shottracker-worker/1.0 (+https://shottrax-share.bcbaird.workers.dev)";
var OSM_KV_TTL = 60 * 60 * 24 * 365;
var OSM_FRESH_MS = 30 * 24 * 60 * 60 * 1e3;
var OSM_EDGE_TTL = 60 * 60 * 24;
var OSM_NEGATIVE_TTL = 60 * 60 * 6;
var OSM_REFRESH_TTL = 60 * 60;
var OSM_BUDGET_MS = 27e3;
var OSM_PRIMARY_MS = 11e3;
var OSM_BACKOFF_MS = 400;
var OSM_API_MAX_EXTRA = 4;
var OSM_NEAR_M = 600;
var OSM_CELL_MILLIONTHS = 1e4;
var OSM_MAX_CELL_STEPS = 3;
var EARTH_M = 6371e3;
var COURSE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
var osmInflight = /* @__PURE__ */ new Map();
var GOLF_VENDORS = {
  gca: {
    prefix: "/gca/v1/",
    upstream: "https://golfcoursesapi.com/api/v1/",
    secret: "GOLF_COURSES_API_KEY",
    routes: [/^courses$/, /^courses\/[^/]+$/, /^courses\/[^/]+\/green-centers$/]
  },
  golfapi: {
    prefix: "/golfapi/v2.3/",
    upstream: "https://golfapi.io/api/v2.3/",
    secret: "GOLFAPI_KEY",
    routes: [/^courses$/, /^courses\/[^/]+$/, /^coordinates\/[^/]+$/]
  }
};
var GOLF_CACHE_SECONDS = 60 * 60 * 24;
var GCA_CLIENT_MAX_AGE = 300;
var GCA_STORE_TTL = 60 * 60 * 24 * 365;
var GCA_UPSTREAM_MS = 15e3;
var GCA_NEGATIVE_TTL = 300;
var GCA_REFRESH_DAYS_DEFAULT = 30;
var GCA_RATE_HEADERS = /* @__PURE__ */ new Set([
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after"
]);
var GOLFAPI_STORE_TTL = 60 * 60 * 24 * 365;
var GOLFAPI_BUCKET_TTL = 60 * 60 * 24 * 32;
var GOLFAPI_STATS_TTL = 60 * 60 * 24 * 40;
var GOLFAPI_QUEUE_TTL = 60 * 60 * 24 * 14;
var GOLFAPI_SET_MS = 15 * 60 * 1e3;
var GOLFAPI_SET_TTL = 15 * 60;
var GOLFAPI_SEARCH_TTL = 60 * 60 * 24 * 30;
var GOLFAPI_SEARCH_GUARD = 3;
var GOLFAPI_GIVE_UP = 5;
var GOLFAPI_LATENCY_SAMPLE = 21;
var GOLFAPI_LATENCY_KINDS = ["search", "course", "coordinates"];
var GOLFAPI_IP_PREFIX = "shottrax-golfapi-ip-v1:";
var GOLFAPI_SEARCH_PREFIX = "shottrax-golfapi-search-v1:";
var GOLFAPI_BALANCE_KEY = "gq:balance";
var RESERVED_BOARD_PREFIXES = ["osm:", "gq:", "gapi:", "gqueue:", "gca:", "cr:", "fr:"];
var GOLFAPI_REASONS = [
  "device_day",
  "device_week",
  "device_month",
  "ip_day",
  "ip_week",
  "ip_month",
  "global_day",
  "global_month",
  "floor",
  "search_device_day",
  "install_id_required"
];
function isReservedBoardKey(key) {
  if (typeof key !== "string") return false;
  if (key.startsWith("v1")) return true;
  return RESERVED_BOARD_PREFIXES.some((prefix) => key.startsWith(prefix));
}
__name(isReservedBoardKey, "isReservedBoardKey");
__name2(isReservedBoardKey, "isReservedBoardKey");
function isPaintKey(key) {
  return key.startsWith("id:") || key.startsWith("name:");
}
__name(isPaintKey, "isPaintKey");
__name2(isPaintKey, "isPaintKey");
function readConfigInt(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e6) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed <= 1e6) return parsed;
  }
  return null;
}
__name(readConfigInt, "readConfigInt");
__name2(readConfigInt, "readConfigInt");
function readGcaRefreshDays(env) {
  const parsed = readConfigInt(env && env.GCA_REFRESH_DAYS);
  return parsed == null ? GCA_REFRESH_DAYS_DEFAULT : parsed;
}
__name(readGcaRefreshDays, "readGcaRefreshDays");
__name2(readGcaRefreshDays, "readGcaRefreshDays");
function gcaRequiresInstallId(env) {
  const raw = env && env.GCA_REQUIRE_INSTALL_ID;
  if (raw === true) return true;
  if (typeof raw !== "string") return false;
  const text = raw.trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}
__name(gcaRequiresInstallId, "gcaRequiresInstallId");
__name2(gcaRequiresInstallId, "gcaRequiresInstallId");
var GOLFAPI_DEFAULTS = {
  // Hotfix after Magnolia (docs/worker-hotfix-after-magnolia.md). 500-call plan.
  // Per install id and per IP: COURSE OPENS (see golfapiOpenGate).
  deviceDay: 12,
  deviceWeek: 40,
  deviceMonth: 80,
  // Per IP: carrier NAT puts many phones behind one IP. Week/month are set so
  // they can never bind before the daily cap does (7 x 150, 31 x 150).
  ipDay: 150,
  ipWeek: 1050,
  ipMonth: 4650,
  // Overall day and month: REAL upstream calls, cron drain included.
  globalDay: 100,
  monthBudget: 450,
  billingDay: 5,
  floor: 50,
  // Saved course/coordinates copies; 7-day marker for a clean 200 with no data.
  storeTtlDays: 365,
  emptyTtlDays: 7,
  // Calls one course open may make (search, course, coordinates). That reservation
  // is checked up front. A balance at or under the floor still stops the next call,
  // including the coordinates half of a queued refill.
  openCalls: 3
};
function readGolfapiLimits(env) {
  const source = env || {};
  const deviceDay = readConfigInt(source.GOLFAPI_DEVICE_DAY) ?? GOLFAPI_DEFAULTS.deviceDay;
  const deviceWeek = readConfigInt(source.GOLFAPI_DEVICE_WEEK) ?? GOLFAPI_DEFAULTS.deviceWeek;
  const deviceMonth = readConfigInt(source.GOLFAPI_DEVICE_MONTH) ?? GOLFAPI_DEFAULTS.deviceMonth;
  const billingDay = readConfigInt(source.GOLFAPI_BILLING_DAY) ?? GOLFAPI_DEFAULTS.billingDay;
  return {
    deviceDay,
    deviceWeek,
    deviceMonth,
    ipDay: readConfigInt(source.GOLFAPI_IP_DAY) ?? GOLFAPI_DEFAULTS.ipDay,
    ipWeek: readConfigInt(source.GOLFAPI_IP_WEEK) ?? GOLFAPI_DEFAULTS.ipWeek,
    ipMonth: readConfigInt(source.GOLFAPI_IP_MONTH) ?? GOLFAPI_DEFAULTS.ipMonth,
    globalDay: readConfigInt(source.GOLFAPI_GLOBAL_DAY) ?? GOLFAPI_DEFAULTS.globalDay,
    monthBudget: readConfigInt(source.GOLFAPI_MONTHLY_BUDGET) ?? GOLFAPI_DEFAULTS.monthBudget,
    billingDay: Math.min(28, Math.max(1, billingDay)),
    floor: readConfigInt(source.GOLFAPI_FLOOR) ?? GOLFAPI_DEFAULTS.floor,
    storeTtlDays: readConfigInt(source.GOLFAPI_STORE_TTL_DAYS) ?? GOLFAPI_DEFAULTS.storeTtlDays,
    emptyTtlDays: readConfigInt(source.GOLFAPI_EMPTY_TTL_DAYS) ?? GOLFAPI_DEFAULTS.emptyTtlDays,
    openCalls: Math.max(1, readConfigInt(source.GOLFAPI_OPEN_CALLS) ?? GOLFAPI_DEFAULTS.openCalls),
    searchCap: deviceDay * GOLFAPI_SEARCH_GUARD
  };
}
__name(readGolfapiLimits, "readGolfapiLimits");
__name2(readGolfapiLimits, "readGolfapiLimits");
function pad2(value) {
  return String(value).padStart(2, "0");
}
__name(pad2, "pad2");
__name2(pad2, "pad2");
function golfapiPeriods(now) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const date = now.getUTCDate();
  const day = `${year}-${pad2(monthIndex + 1)}-${pad2(date)}`;
  const month = `${year}-${pad2(monthIndex + 1)}`;
  const thursday = new Date(Date.UTC(year, monthIndex, date));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekNo = Math.ceil(((thursday.getTime() - yearStart) / 864e5 + 1) / 7);
  return { day, week: `${isoYear}-W${pad2(weekNo)}`, month };
}
__name(golfapiPeriods, "golfapiPeriods");
__name2(golfapiPeriods, "golfapiPeriods");
function utcDay(now, offset) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
}
__name(utcDay, "utcDay");
__name2(utcDay, "utcDay");
function secondsUntil(now, nextMs) {
  return Math.max(1, Math.ceil((nextMs - now.getTime()) / 1e3));
}
__name(secondsUntil, "secondsUntil");
__name2(secondsUntil, "secondsUntil");
function retryAfterFor(reason, now, limits) {
  if (reason === "global_month") {
    const period = billingPeriod(now.getTime(), limits && limits.billingDay || GOLFAPI_DEFAULTS.billingDay);
    return Math.max(60, Math.min(secondsUntil(now, period.endMs), 86400));
  }
  if (reason === "device_week" || reason === "ip_week") {
    const weekday = now.getUTCDay() || 7;
    let add = (8 - weekday) % 7;
    if (add === 0) add = 7;
    return secondsUntil(now, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add));
  }
  if (reason === "device_month" || reason === "ip_month") {
    return secondsUntil(now, Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  return secondsUntil(now, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
__name(retryAfterFor, "retryAfterFor");
__name2(retryAfterFor, "retryAfterFor");
function clampCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), 1e9);
}
__name(clampCount, "clampCount");
__name2(clampCount, "clampCount");
function readInstallId(request) {
  const raw = request.headers.get("X-Install-Id");
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  return id;
}
__name(readInstallId, "readInstallId");
__name2(readInstallId, "readInstallId");
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
__name2(sha256Hex, "sha256Hex");
async function hashClientIp(ip) {
  return sha256Hex(GOLFAPI_IP_PREFIX + ip);
}
__name(hashClientIp, "hashClientIp");
__name2(hashClientIp, "hashClientIp");
function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
__name(normalizeName, "normalizeName");
__name2(normalizeName, "normalizeName");
async function searchToken(normalized) {
  return sha256Hex(GOLFAPI_SEARCH_PREFIX + normalized);
}
__name(searchToken, "searchToken");
__name2(searchToken, "searchToken");
async function readIpHash(request) {
  const raw = request.headers.get("CF-Connecting-IP");
  if (typeof raw !== "string") return null;
  const ip = raw.trim();
  if (!ip || ip.length > 64 || /[\s\r\n]/.test(ip)) return null;
  return hashClientIp(ip);
}
__name(readIpHash, "readIpHash");
__name2(readIpHash, "readIpHash");
function safeGolfapiId(raw) {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return null;
  return id;
}
__name(safeGolfapiId, "safeGolfapiId");
__name2(safeGolfapiId, "safeGolfapiId");
function golfapiSearchQuery(url) {
  const name = url.searchParams.get("name");
  if (typeof name === "string" && name.trim() !== "") return name;
  const q = url.searchParams.get("q");
  if (typeof q === "string" && q.trim() !== "") return q;
  return null;
}
__name(golfapiSearchQuery, "golfapiSearchQuery");
__name2(golfapiSearchQuery, "golfapiSearchQuery");
function parseGolfapiRest(rest, url) {
  if (rest === "courses") {
    if (golfapiSearchQuery(url) == null) return null;
    return { kind: "search" };
  }
  let match = /^courses\/([^/]+)$/.exec(rest);
  if (match) {
    const id = safeGolfapiId(match[1]);
    return id ? { kind: "course", id } : null;
  }
  match = /^coordinates\/([^/]+)$/.exec(rest);
  if (match) {
    const id = safeGolfapiId(match[1]);
    return id ? { kind: "coord", id } : null;
  }
  return null;
}
__name(parseGolfapiRest, "parseGolfapiRest");
__name2(parseGolfapiRest, "parseGolfapiRest");
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
__name(isPlainObject, "isPlainObject");
__name2(isPlainObject, "isPlainObject");
function readRequestsLeft(payload) {
  if (!isPlainObject(payload)) return null;
  const raw = payload.apiRequestsLeft;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
__name(readRequestsLeft, "readRequestsLeft");
__name2(readRequestsLeft, "readRequestsLeft");
function payloadHasError(payload) {
  return !isPlainObject(payload) || payload.error != null && payload.error !== false;
}
__name(payloadHasError, "payloadHasError");
__name2(payloadHasError, "payloadHasError");
function courseHasData(payload) {
  if (payloadHasError(payload)) return false;
  if (isPlainObject(payload.course) && courseHasData(payload.course)) return true;
  const id = payload.courseID ?? payload.courseId;
  if (typeof id !== "string" || id.trim() === "") return false;
  if (typeof payload.courseName === "string" && payload.courseName.trim() !== "") return true;
  if (payload.numHoles != null && payload.numHoles !== "" && Number(payload.numHoles) > 0) return true;
  if (Array.isArray(payload.tees) && payload.tees.length > 0) return true;
  if (Array.isArray(payload.parsMen) && payload.parsMen.length > 0) return true;
  if (Array.isArray(payload.pars) && payload.pars.length > 0) return true;
  return false;
}
__name(courseHasData, "courseHasData");
__name2(courseHasData, "courseHasData");
function coordHasData(payload) {
  if (payloadHasError(payload)) return false;
  return Array.isArray(payload.coordinates) && payload.coordinates.length > 0;
}
__name(coordHasData, "coordHasData");
__name2(coordHasData, "coordHasData");
function searchHasData(payload) {
  if (payloadHasError(payload)) return false;
  return Array.isArray(payload.courses);
}
__name(searchHasData, "searchHasData");
__name2(searchHasData, "searchHasData");
function searchBodyOk(text) {
  try {
    return searchHasData(JSON.parse(text));
  } catch {
    return false;
  }
}
__name(searchBodyOk, "searchBodyOk");
__name2(searchBodyOk, "searchBodyOk");
function matchingCourseId(payload, normalizedQuery) {
  if (!searchHasData(payload) || !normalizedQuery) return null;
  const hits = [];
  for (const course of payload.courses) {
    if (!isPlainObject(course)) continue;
    const names = [course.courseName, course.clubName, course.name].map(normalizeName).filter(Boolean);
    if (!names.some((name) => name === normalizedQuery)) continue;
    hits.push(safeGolfapiId(String(course.courseID ?? course.courseId ?? "")));
  }
  if (hits.length !== 1) return null;
  return hits[0];
}
__name(matchingCourseId, "matchingCourseId");
__name2(matchingCourseId, "matchingCourseId");
function bodyHasData(kind, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return false;
  }
  return kind === "course" ? courseHasData(payload) : coordHasData(payload);
}
__name(bodyHasData, "bodyHasData");
__name2(bodyHasData, "bodyHasData");
function classifyGolfapi(kind, status, text) {
  let payload = null;
  if (typeof text === "string" && text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  const left = readRequestsLeft(payload);
  if (status < 200 || status >= 300) {
    return { payload, left, outcome: "error", reason: status === 404 ? "not_found" : "non_2xx" };
  }
  if (payload == null) return { payload, left, outcome: "error", reason: "not_json" };
  if (payloadHasError(payload)) return { payload, left, outcome: "error", reason: "error_body" };
  if (golfapiLooksLikeQuota(payload) && !golfapiBodyHasData(kind, payload)) {
    const quotaText = ["message", "status", "detail", "msg"].some((field) => typeof payload[field] === "string" && GOLFAPI_QUOTA_TEXT.test(payload[field]));
    return { payload, left, outcome: "error", reason: quotaText ? "quota_text" : "message_no_data" };
  }
  if (kind === "search") {
    return searchHasData(payload) ? { payload, left, outcome: "search", reason: "ok" } : { payload, left, outcome: "empty200", reason: "missing_courses" };
  }
  const hasData = golfapiBodyHasData(kind, payload);
  return { payload, left, outcome: hasData ? "data" : "empty200", reason: hasData ? "ok" : "missing_data" };
}
__name(classifyGolfapi, "classifyGolfapi");
__name2(classifyGolfapi, "classifyGolfapi");
function courseStoreKey(id) {
  return `gapi:course:${id}`;
}
__name(courseStoreKey, "courseStoreKey");
__name2(courseStoreKey, "courseStoreKey");
function coordStoreKey(id) {
  return `gapi:coord:${id}`;
}
__name(coordStoreKey, "coordStoreKey");
__name2(coordStoreKey, "coordStoreKey");
function storeKeyFor(kind, id) {
  return kind === "course" ? courseStoreKey(id) : coordStoreKey(id);
}
__name(storeKeyFor, "storeKeyFor");
__name2(storeKeyFor, "storeKeyFor");
function emptyMarkerKey(kind, id) {
  return `gq:empty:${kind}:${id}`;
}
__name(emptyMarkerKey, "emptyMarkerKey");
__name2(emptyMarkerKey, "emptyMarkerKey");
function blankLatencyRow() {
  return { count: 0, max: 0, samples: [] };
}
__name(blankLatencyRow, "blankLatencyRow");
__name2(blankLatencyRow, "blankLatencyRow");
function blankLatency() {
  return {
    search: blankLatencyRow(),
    course: blankLatencyRow(),
    coordinates: blankLatencyRow()
  };
}
__name(blankLatency, "blankLatency");
__name2(blankLatency, "blankLatency");
function normalizeLatency(raw) {
  const latency = blankLatency();
  if (!isPlainObject(raw)) return latency;
  for (const kind of GOLFAPI_LATENCY_KINDS) {
    const row = raw[kind];
    if (!isPlainObject(row)) continue;
    latency[kind].count = clampCount(row.count);
    latency[kind].max = clampCount(row.max);
    if (Array.isArray(row.samples)) {
      latency[kind].samples = row.samples.map((value) => clampCount(value)).slice(0, GOLFAPI_LATENCY_SAMPLE);
    }
  }
  return latency;
}
__name(normalizeLatency, "normalizeLatency");
__name2(normalizeLatency, "normalizeLatency");
function noteLatency(stats, kind, ms) {
  if (!GOLFAPI_LATENCY_KINDS.includes(kind) || typeof ms !== "number" || !Number.isFinite(ms)) return;
  if (!stats.latency) stats.latency = blankLatency();
  const row = stats.latency[kind];
  const elapsed = clampCount(ms);
  row.count += 1;
  if (elapsed > row.max) row.max = elapsed;
  if (row.samples.length < GOLFAPI_LATENCY_SAMPLE) {
    row.samples.push(elapsed);
    return;
  }
  const slot = Math.floor(Math.random() * row.count);
  if (slot < GOLFAPI_LATENCY_SAMPLE) row.samples[slot] = elapsed;
}
__name(noteLatency, "noteLatency");
__name2(noteLatency, "noteLatency");
function sampleMedian(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
__name(sampleMedian, "sampleMedian");
__name2(sampleMedian, "sampleMedian");
function latencyView(stats) {
  const latency = normalizeLatency(stats && stats.latency);
  const view = {};
  for (const kind of GOLFAPI_LATENCY_KINDS) {
    view[kind] = {
      count: latency[kind].count,
      median: sampleMedian(latency[kind].samples),
      max: latency[kind].max
    };
  }
  return view;
}
__name(latencyView, "latencyView");
__name2(latencyView, "latencyView");
function blankStats() {
  return { lookups: 0, allowlistedLookups: 0, searches: 0, hits: 0, blocked: {}, latency: blankLatency() };
}
__name(blankStats, "blankStats");
__name2(blankStats, "blankStats");
async function readStats(boards, key) {
  const stats = blankStats();
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return stats;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return stats;
    stats.lookups = clampCount(parsed.lookups);
    stats.allowlistedLookups = clampCount(parsed.allowlistedLookups);
    stats.searches = clampCount(parsed.searches);
    stats.hits = clampCount(parsed.hits);
    stats.latency = normalizeLatency(parsed.latency);
    if (isPlainObject(parsed.blocked)) stats.blocked = parsed.blocked;
  } catch {
    return blankStats();
  }
  return stats;
}
__name(readStats, "readStats");
__name2(readStats, "readStats");
async function putCounter(boards, key, value, opts) {
  try {
    await boards.put(key, value, opts);
  } catch {
  }
}
__name(putCounter, "putCounter");
__name2(putCounter, "putCounter");
async function bumpStats(boards, day, mutate) {
  const key = `gq:stats:${day}`;
  const stats = await readStats(boards, key);
  mutate(stats);
  await putCounter(boards, key, JSON.stringify(stats), { expirationTtl: GOLFAPI_STATS_TTL });
  return stats;
}
__name(bumpStats, "bumpStats");
__name2(bumpStats, "bumpStats");
function blankGcaStats() {
  return { upstream: 0, rateLimited: 0, stale: 0, missingInstallId: 0 };
}
__name(blankGcaStats, "blankGcaStats");
__name2(blankGcaStats, "blankGcaStats");
async function readGcaStats(boards, key) {
  const stats = blankGcaStats();
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return stats;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return stats;
    stats.upstream = clampCount(parsed.upstream);
    stats.rateLimited = clampCount(parsed.rateLimited);
    stats.stale = clampCount(parsed.stale);
    stats.missingInstallId = clampCount(parsed.missingInstallId);
  } catch {
    return blankGcaStats();
  }
  return stats;
}
__name(readGcaStats, "readGcaStats");
__name2(readGcaStats, "readGcaStats");
async function bumpGcaStats(boards, day, mutate) {
  const key = `gca:stats:${day}`;
  const stats = await readGcaStats(boards, key);
  mutate(stats);
  await putCounter(boards, key, JSON.stringify(stats), { expirationTtl: GOLFAPI_STATS_TTL });
  return stats;
}
__name(bumpGcaStats, "bumpGcaStats");
__name2(bumpGcaStats, "bumpGcaStats");
function gcaStatsView(date, stats) {
  return {
    date,
    upstream: clampCount(stats && stats.upstream),
    rateLimited: clampCount(stats && stats.rateLimited),
    stale: clampCount(stats && stats.stale),
    missingInstallId: clampCount(stats && stats.missingInstallId)
  };
}
__name(gcaStatsView, "gcaStatsView");
__name2(gcaStatsView, "gcaStatsView");
async function recordGcaUpstream(boards, day, { status, stale }) {
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return;
  await bumpGcaStats(boards, day, (stats) => {
    stats.upstream += 1;
    if (status === 429) stats.rateLimited += 1;
    if (stale) stats.stale += 1;
  });
}
__name(recordGcaUpstream, "recordGcaUpstream");
__name2(recordGcaUpstream, "recordGcaUpstream");
async function recordGcaMissingInstall(boards, day) {
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return;
  await bumpGcaStats(boards, day, (stats) => {
    stats.missingInstallId += 1;
  });
}
__name(recordGcaMissingInstall, "recordGcaMissingInstall");
__name2(recordGcaMissingInstall, "recordGcaMissingInstall");
async function noteGolfapiInstallRequired(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return;
  const day = golfapiPeriods(/* @__PURE__ */ new Date()).day;
  await bumpStats(boards, day, (stats) => {
    stats.blocked.install_id_required = clampCount(stats.blocked.install_id_required) + 1;
  });
}
__name(noteGolfapiInstallRequired, "noteGolfapiInstallRequired");
__name2(noteGolfapiInstallRequired, "noteGolfapiInstallRequired");
function emptyBlocked() {
  const blocked = {};
  for (const reason of GOLFAPI_REASONS) blocked[reason] = 0;
  return blocked;
}
__name(emptyBlocked, "emptyBlocked");
__name2(emptyBlocked, "emptyBlocked");
function statsView(date, stats) {
  const blocked = emptyBlocked();
  if (stats && isPlainObject(stats.blocked)) {
    for (const reason of GOLFAPI_REASONS) {
      blocked[reason] = clampCount(stats.blocked[reason]);
    }
  }
  const lookups = clampCount(stats && stats.lookups);
  return {
    date,
    lookups,
    globalLookups: lookups,
    allowlistedLookups: clampCount(stats && stats.allowlistedLookups),
    searches: clampCount(stats && stats.searches),
    hits: clampCount(stats && stats.hits),
    blocked,
    latency: latencyView(stats)
  };
}
__name(statsView, "statsView");
__name2(statsView, "statsView");
function emptyBucket(now) {
  const periods = golfapiPeriods(now);
  return {
    day: periods.day,
    dayCount: 0,
    week: periods.week,
    weekCount: 0,
    month: periods.month,
    monthCount: 0,
    searchDay: periods.day,
    searchCount: 0
  };
}
__name(emptyBucket, "emptyBucket");
__name2(emptyBucket, "emptyBucket");
function normalizeBucket(raw, now) {
  const bucket = emptyBucket(now);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isPlainObject(parsed)) return bucket;
  const periods = golfapiPeriods(now);
  if (parsed.day === periods.day) bucket.dayCount = clampCount(parsed.dayCount);
  if (parsed.week === periods.week) bucket.weekCount = clampCount(parsed.weekCount);
  if (parsed.month === periods.month) bucket.monthCount = clampCount(parsed.monthCount);
  if (parsed.searchDay === periods.day) bucket.searchCount = clampCount(parsed.searchCount);
  return bucket;
}
__name(normalizeBucket, "normalizeBucket");
__name2(normalizeBucket, "normalizeBucket");
async function loadBucket(boards, key, now) {
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return emptyBucket(now);
  return normalizeBucket(raw, now);
}
__name(loadBucket, "loadBucket");
__name2(loadBucket, "loadBucket");
async function saveBucket(boards, key, bucket) {
  await putCounter(boards, key, JSON.stringify(bucket), { expirationTtl: GOLFAPI_BUCKET_TTL });
}
__name(saveBucket, "saveBucket");
__name2(saveBucket, "saveBucket");
async function readSet(boards, key, now) {
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || typeof parsed.at !== "number") return null;
    if (now.getTime() - parsed.at >= GOLFAPI_SET_MS) return null;
    const courseId = typeof parsed.courseId === "string" ? safeGolfapiId(parsed.courseId) : null;
    const calls = Number.isInteger(parsed.calls) && parsed.calls > 0 ? parsed.calls : 1;
    return { at: parsed.at, courseId, calls };
  } catch {
    return null;
  }
}
__name(readSet, "readSet");
__name2(readSet, "readSet");
async function writeSet(boards, key, set, now) {
  const elapsed = Math.floor((now.getTime() - set.at) / 1e3);
  const ttl = Math.max(60, GOLFAPI_SET_TTL - Math.max(0, elapsed));
  await putCounter(boards, key, JSON.stringify({ at: set.at, courseId: set.courseId || null, calls: set.calls || 1 }), { expirationTtl: ttl });
}
__name(writeSet, "writeSet");
__name2(writeSet, "writeSet");
function planCourse(openSet, courseId, nowMs) {
  if (!openSet || openSet.courseId && openSet.courseId !== courseId) {
    return { charge: true, next: { at: nowMs, courseId, calls: 1 } };
  }
  return { charge: false, next: { at: openSet.at, courseId: openSet.courseId || courseId, calls: (openSet.calls || 1) + 1 } };
}
__name(planCourse, "planCourse");
__name2(planCourse, "planCourse");
function planSearch(openSet, nowMs) {
  if (!openSet) return { charge: true, next: { at: nowMs, courseId: null, calls: 1 } };
  return { charge: false, next: { at: openSet.at, courseId: openSet.courseId || null, calls: (openSet.calls || 1) + 1 } };
}
__name(planSearch, "planSearch");
__name2(planSearch, "planSearch");
function isAllowlisted(env, installId) {
  if (!installId || !env || typeof env.GOLFAPI_ALLOWLIST !== "string") return false;
  return env.GOLFAPI_ALLOWLIST.split(",").some((part) => part.trim() === installId);
}
__name(isAllowlisted, "isAllowlisted");
__name2(isAllowlisted, "isAllowlisted");
function quotaFor(ident, allowlisted, openSetPlan) {
  const devPlan = ident.dev ? openSetPlan(ident.devSet) : null;
  const newOpen = !devPlan || devPlan.charge;
  if (allowlisted) {
    return {
      allowlisted: true,
      devPlan,
      ipPlan: null,
      newOpen,
      chargeDevice: false,
      chargeIp: false,
      chargeGlobal: false,
      countAllowlisted: Boolean(ident.dev) && newOpen,
      searchCount: 0
    };
  }
  return {
    allowlisted: false,
    devPlan,
    ipPlan: null,
    newOpen,
    chargeDevice: Boolean(ident.dev) && newOpen,
    chargeIp: Boolean(ident.ip) && newOpen,
    chargeGlobal: newOpen,
    countAllowlisted: false,
    searchCount: ident.dev ? ident.dev.searchCount : ident.ip ? ident.ip.searchCount : 0
  };
}
__name(quotaFor, "quotaFor");
function searchCapReason(search, allowlisted, ident, limits) {
  if (!search || allowlisted) return null;
  if ((ident.dev || ident.ip) && quotaSearchCount(ident) >= limits.searchCap) return "search_device_day";
  return null;
}
__name(searchCapReason, "searchCapReason");
__name2(searchCapReason, "searchCapReason");
function quotaSearchCount(ident) {
  if (ident.dev) return ident.dev.searchCount;
  if (ident.ip) return ident.ip.searchCount;
  return 0;
}
__name(quotaSearchCount, "quotaSearchCount");
__name2(quotaSearchCount, "quotaSearchCount");
function floorBlocks(balance, floor, need) {
  if (!balance || typeof balance.left !== "number") return false;
  if (balance.left <= floor) return true;
  return Number.isInteger(balance.left) && balance.left - need < floor;
}
__name(floorBlocks, "floorBlocks");
__name2(floorBlocks, "floorBlocks");
async function golfapiOpenGate({ boards, limits, now, quota, ident, allowlisted, search }) {
  const floorNeed = quota.newOpen ? limits.openCalls : 1;
  if (floorBlocks(await readBalance(boards), limits.floor, floorNeed)) return "floor";
  if (!quota.newOpen) {
    const capped = searchCapReason(search, allowlisted, ident, limits);
    if (capped) return capped;
    const calls = quota.devPlan && quota.devPlan.next ? quota.devPlan.next.calls : 1;
    if (calls <= limits.openCalls) return null;
    hotfixLog("golfapi_open_over_calls", { calls, openCalls: limits.openCalls });
    return golfapiSpendBlockReason(boards, limits, now, allowlisted, 1);
  }
  const spend = await golfapiSpendBlockReason(boards, limits, now, allowlisted, limits.openCalls);
  if (spend) return spend;
  if (allowlisted) return null;
  const reason = lookupBlockReason({
    chargeDevice: quota.chargeDevice,
    chargeIp: quota.chargeIp,
    chargeGlobal: quota.chargeGlobal,
    dev: ident.dev,
    ip: ident.ip,
    stats: null,
    limits
  });
  if (reason) return reason;
  return searchCapReason(search, allowlisted, ident, limits);
}
__name(golfapiOpenGate, "golfapiOpenGate");
__name2(quotaFor, "quotaFor");
function lookupBlockReason({ chargeDevice, chargeIp, chargeGlobal, dev, ip, stats, limits }) {
  if (chargeDevice && dev) {
    if (dev.dayCount >= limits.deviceDay) return "device_day";
    if (dev.weekCount >= limits.deviceWeek) return "device_week";
    if (dev.monthCount >= limits.deviceMonth) return "device_month";
  }
  if (chargeIp && ip) {
    if (ip.dayCount >= limits.ipDay) return "ip_day";
    if (ip.weekCount >= limits.ipWeek) return "ip_week";
    if (ip.monthCount >= limits.ipMonth) return "ip_month";
  }
  return null;
}
__name(lookupBlockReason, "lookupBlockReason");
__name2(lookupBlockReason, "lookupBlockReason");
async function loadIdentity(boards, installId, ipHash, now) {
  const devKey = installId ? `gq:dev:${installId}` : null;
  const ipKey = ipHash ? `gq:ip:${ipHash}` : null;
  const devSetKey = installId ? `gq:set:dev:${installId}` : null;
  const ipSetKey = ipHash ? `gq:set:ip:${ipHash}` : null;
  const dev = devKey ? await loadBucket(boards, devKey, now) : null;
  const ip = ipKey ? await loadBucket(boards, ipKey, now) : null;
  const devSet = devSetKey ? await readSet(boards, devSetKey, now) : null;
  const ipSet = ipSetKey ? await readSet(boards, ipSetKey, now) : null;
  return { devKey, ipKey, devSetKey, ipSetKey, dev, ip, devSet, ipSet };
}
__name(loadIdentity, "loadIdentity");
__name2(loadIdentity, "loadIdentity");
async function readBalance(boards) {
  const raw = await boards.get(GOLFAPI_BALANCE_KEY);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const left = typeof parsed.left === "number" && Number.isFinite(parsed.left) ? parsed.left : null;
    const at = typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0;
    const lastStatus = Number.isInteger(parsed.lastStatus) ? parsed.lastStatus : 0;
    return { left, at, lastStatus };
  } catch {
    return null;
  }
}
__name(readBalance, "readBalance");
__name2(readBalance, "readBalance");
function balanceBlocks(balance, floor) {
  return Boolean(balance && typeof balance.left === "number" && balance.left <= floor);
}
__name(balanceBlocks, "balanceBlocks");
__name2(balanceBlocks, "balanceBlocks");
async function rememberBalance(boards, status, payload) {
  const parsedLeft = readRequestsLeft(payload);
  const prev = await readBalance(boards);
  const left = parsedLeft == null ? prev ? prev.left : null : parsedLeft;
  const next = { left, at: Date.now(), lastStatus: status };
  await putCounter(boards, GOLFAPI_BALANCE_KEY, JSON.stringify(next));
  return next;
}
__name(rememberBalance, "rememberBalance");
__name2(rememberBalance, "rememberBalance");
function balanceAsOf(balance) {
  if (!balance || typeof balance.at !== "number" || balance.at <= 0) return null;
  return new Date(balance.at).toISOString();
}
__name(balanceAsOf, "balanceAsOf");
__name2(balanceAsOf, "balanceAsOf");
function publicBalance(balance) {
  if (!balance) return null;
  return {
    left: typeof balance.left === "number" ? balance.left : null,
    at: balance.at,
    lastStatus: balance.lastStatus,
    asOf: balanceAsOf(balance)
  };
}
__name(publicBalance, "publicBalance");
__name2(publicBalance, "publicBalance");
function limitedResponse(reason, queued, cors, now, limits) {
  const retryAfterSec = retryAfterFor(reason, now, limits);
  return golfJson(429, {
    error: "golfapi_limited",
    reason,
    queued,
    retryAfterSec,
    message: COURSE_MAP_UNAVAILABLE_MESSAGE
  }, cors, { "Retry-After": String(retryAfterSec) });
}
__name(limitedResponse, "limitedResponse");
__name2(limitedResponse, "limitedResponse");
async function enqueueCourse(boards, courseId) {
  const key = `gqueue:${courseId}`;
  const existing = await boards.get(key);
  if (existing != null) return;
  await boards.put(key, JSON.stringify({ attempts: 0, at: Date.now() }), { expirationTtl: GOLFAPI_QUEUE_TTL });
}
__name(enqueueCourse, "enqueueCourse");
__name2(enqueueCourse, "enqueueCourse");
async function enqueueSearch(boards, job) {
  const token = await searchToken(job.q);
  const key = `gqueue:q:${token}`;
  const existing = await boards.get(key);
  if (existing != null) return;
  await boards.put(key, JSON.stringify({
    attempts: 0,
    at: Date.now(),
    q: job.q,
    search: job.search
  }), { expirationTtl: GOLFAPI_QUEUE_TTL });
}
__name(enqueueSearch, "enqueueSearch");
__name2(enqueueSearch, "enqueueSearch");
async function rejectLimited(boards, day, reason, queued, courseId, cors, now, searchJob, env) {
  const limits = readGolfapiLimits(env);
  const stats = await bumpStats(boards, day, (stats2) => {
    stats2.blocked[reason] = clampCount(stats2.blocked[reason]) + 1;
  });
  hotfixLog("golfapi_budget_closed", { reason, day });
  if (reason === "global_day") {
    await maybeAlert(env, boards, "daily_max", day, { reason, globalDay: limits.globalDay, callsToday: await readMonthCount(boards, dayCounterKey(day)) });
  } else if (reason === "floor") {
    const balance = await readBalance(boards);
    await maybeAlert(env, boards, "reserve", day, { reason, floor: limits.floor, apiRequestsLeft: balance ? balance.left : null });
  }
  if (queued && courseId) await enqueueCourse(boards, courseId);
  if (queued && searchJob) await enqueueSearch(boards, searchJob);
  return limitedResponse(reason, Boolean(queued), cors, now, limits);
}
__name(rejectLimited, "rejectLimited");
__name2(rejectLimited, "rejectLimited");
function storedGolfResponse(text, cors) {
  return new Response(text, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${GOLF_CACHE_SECONDS}`
    }
  });
}
__name(storedGolfResponse, "storedGolfResponse");
__name2(storedGolfResponse, "storedGolfResponse");
function upstreamGolfResponse(status, text, contentType, cors, cacheable) {
  return new Response(text, {
    status,
    headers: {
      ...cors,
      "Content-Type": contentType || "application/json",
      "Cache-Control": cacheable ? `public, max-age=${GOLF_CACHE_SECONDS}` : "no-store"
    }
  });
}
__name(upstreamGolfResponse, "upstreamGolfResponse");
__name2(upstreamGolfResponse, "upstreamGolfResponse");
function edgeCache() {
  return typeof caches !== "undefined" && caches ? caches.default : null;
}
__name(edgeCache, "edgeCache");
__name2(edgeCache, "edgeCache");
function rememberGolfEdge(cache, ctx, cacheKey, response) {
  if (!cache || typeof cache.put !== "function") return void 0;
  const put = Promise.resolve(cache.put(cacheKey, response.clone())).catch(() => {
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else return put;
  return void 0;
}
__name(rememberGolfEdge, "rememberGolfEdge");
__name2(rememberGolfEdge, "rememberGolfEdge");
async function fetchGolfapiUpstream(env, pathAndQuery) {
  const key = typeof env.GOLFAPI_KEY === "string" ? env.GOLFAPI_KEY.trim() : "";
  if (!key) return { configured: false };
  const boards = boardsBinding(env);
  const limits = readGolfapiLimits(env);
  const month = boards ? await countGolfapiCall(env, boards, limits, /* @__PURE__ */ new Date()) : null;
  const started = Date.now();
  try {
    const upstream = await fetch(`https://golfapi.io/api/v2.3/${pathAndQuery}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` }
    });
    const result = {
      configured: true,
      thrown: false,
      status: upstream.status,
      text: await upstream.text(),
      contentType: upstream.headers.get("Content-Type") ?? "application/json",
      ms: Math.max(0, Date.now() - started)
    };
    await noteGolfapiCall(env, boards, limits, pathAndQuery, result, upstream.headers, month);
    return result;
  } catch {
    const ms = Math.max(0, Date.now() - started);
    hotfixLog("golfapi_call", { route: golfapiRouteLabel(pathAndQuery), thrown: true, ms, monthCount: month ? month.count : null, period: month ? month.period : null });
    return { configured: true, thrown: true, ms };
  }
}
__name(fetchGolfapiUpstream, "fetchGolfapiUpstream");
__name2(fetchGolfapiUpstream, "fetchGolfapiUpstream");
function callLatency(kind, upstream) {
  if (!upstream || typeof upstream.ms !== "number" || !Number.isFinite(upstream.ms)) return null;
  return { kind, ms: upstream.ms };
}
__name(callLatency, "callLatency");
__name2(callLatency, "callLatency");
async function recordLatency(boards, day, kind, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return;
  await bumpStats(boards, day, (stats) => noteLatency(stats, kind, ms));
}
__name(recordLatency, "recordLatency");
__name2(recordLatency, "recordLatency");
async function recordFresh(boards, periods, ident, chargeDevice, chargeIp, chargeGlobal, countSearch, extra) {
  const allowlisted = Boolean(extra && extra.allowlisted);
  const countAllowlisted = Boolean(extra && extra.countAllowlisted);
  const latency = extra && extra.latency;
  const trackSearch = countSearch && !allowlisted;
  if (ident.dev && (trackSearch || chargeDevice)) {
    if (trackSearch) ident.dev.searchCount += 1;
    if (chargeDevice) {
      ident.dev.dayCount += 1;
      ident.dev.weekCount += 1;
      ident.dev.monthCount += 1;
    }
    await saveBucket(boards, ident.devKey, ident.dev);
  }
  if (ident.ip && (trackSearch && !ident.dev || chargeIp)) {
    if (trackSearch && !ident.dev) ident.ip.searchCount += 1;
    if (chargeIp) {
      ident.ip.dayCount += 1;
      ident.ip.weekCount += 1;
      ident.ip.monthCount += 1;
    }
    await saveBucket(boards, ident.ipKey, ident.ip);
  }
  if (chargeGlobal || countSearch || countAllowlisted || latency) {
    await bumpStats(boards, periods.day, (stats) => {
      if (chargeGlobal) stats.lookups += 1;
      if (countAllowlisted) stats.allowlistedLookups += 1;
      if (countSearch) stats.searches += 1;
      if (latency) noteLatency(stats, latency.kind, latency.ms);
    });
  }
}
__name(recordFresh, "recordFresh");
__name2(recordFresh, "recordFresh");
async function commitSets(boards, ident, devPlan, ipPlan, now) {
  if (devPlan && devPlan.next) await writeSet(boards, ident.devSetKey, devPlan.next, now);
  if (ipPlan && ipPlan.next) await writeSet(boards, ident.ipSetKey, ipPlan.next, now);
}
__name(commitSets, "commitSets");
__name2(commitSets, "commitSets");
async function handleGolfapiSearch({ url, env, ctx, cors, boards, now, periods, limits, installId, ipHash, allowlisted }) {
  const normalized = normalizeName(golfapiSearchQuery(url));
  if (!normalized) return golfJson(404, { error: "unknown_route" }, cors);
  const token = await searchToken(normalized);
  const storeKey = `gapi:search:${token}`;
  const searchJob = { q: normalized, search: url.search };
  const stored = await boards.get(storeKey);
  if (typeof stored === "string" && searchBodyOk(stored)) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.hits += 1;
    });
    return storedGolfResponse(stored, cors);
  }
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached && cached.status >= 200 && cached.status < 300) {
      const text = await cached.text();
      if (searchBodyOk(text)) {
        if (golfapiTextHasData("search", text)) await boards.put(storeKey, text, { expirationTtl: GOLFAPI_SEARCH_TTL });
        await bumpStats(boards, periods.day, (stats) => {
          stats.hits += 1;
        });
        return storedGolfResponse(text, cors);
      }
    }
  }
  const ident = await loadIdentity(boards, installId, ipHash, now);
  const quota = quotaFor(ident, allowlisted, (openSet) => planSearch(openSet, now.getTime()));
  const gateReason = await golfapiOpenGate({ boards, limits, now, quota, ident, allowlisted, search: true });
  if (gateReason) {
    return rejectLimited(boards, periods.day, gateReason, true, null, cors, now, searchJob, env);
  }
  await commitSets(boards, ident, quota.devPlan, null, now);
  const upstream = await fetchGolfapiUpstream(env, `courses${url.search}`);
  if (!upstream.configured) return golfJson(503, { error: "not_configured" }, cors);
  if (upstream.thrown) {
    await recordLatency(boards, periods.day, "search", upstream.ms);
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }
  const classified = classifyGolfapi("search", upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  await recordFresh(boards, periods, ident, quota.chargeDevice, quota.chargeIp, quota.chargeGlobal, true, {
    allowlisted,
    countAllowlisted: quota.countAllowlisted,
    latency: callLatency("search", upstream)
  });
  if (classified.outcome === "search") {
    if (golfapiBodyHasData("search", classified.payload)) {
      await boards.put(storeKey, upstream.text, { expirationTtl: GOLFAPI_SEARCH_TTL });
    } else {
      hotfixLog("golfapi_lastgood_skipped", { route: "courses (search)", reason: "no_hits" });
    }
    const response = upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, true);
    await rememberGolfEdge(cache, ctx, cacheKey, response);
    return response;
  }
  if (upstream.status >= 200 && upstream.status < 300) {
    hotfixLog("golfapi_uncached_200", { route: "courses (search)", ...golfapiUncachedFields(classified) });
  }
  return upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, false);
}
__name(handleGolfapiSearch, "handleGolfapiSearch");
__name2(handleGolfapiSearch, "handleGolfapiSearch");
async function handleGolfapiLookup({ kind, id, url, env, ctx, cors, boards, now, periods, limits, installId, ipHash, allowlisted }) {
  const storeKey = storeKeyFor(kind, id);
  const stored = await boards.get(storeKey);
  if (typeof stored === "string" && bodyHasData(kind, stored)) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.hits += 1;
    });
    return storedGolfResponse(stored, cors);
  }
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached && cached.status >= 200 && cached.status < 300) {
      const text = await cached.text();
      if (golfapiTextHasData(kind, text)) {
        await boards.put(storeKey, text, { expirationTtl: golfapiStoreTtl(limits) });
        if (typeof boards.delete === "function") await boards.delete(emptyMarkerKey(kind, id));
        await bumpStats(boards, periods.day, (stats) => {
          stats.hits += 1;
        });
        return storedGolfResponse(text, cors);
      }
    }
  }
  if (await boards.get(emptyMarkerKey(kind, id)) != null) {
    await bumpStats(boards, periods.day, (stats) => {
      stats.hits += 1;
    });
    return golfJson(404, { error: "no_course_data" }, cors);
  }
  const ident = await loadIdentity(boards, installId, ipHash, now);
  const quota = quotaFor(ident, allowlisted, (openSet) => planCourse(openSet, id, now.getTime()));
  const latencyKind = kind === "course" ? "course" : "coordinates";
  const gateReason = await golfapiOpenGate({ boards, limits, now, quota, ident, allowlisted, search: false });
  if (gateReason) {
    return rejectLimited(boards, periods.day, gateReason, true, id, cors, now, null, env);
  }
  await commitSets(boards, ident, quota.devPlan, null, now);
  const stem = kind === "course" ? "courses" : "coordinates";
  const upstream = await fetchGolfapiUpstream(env, `${stem}/${id}${url.search}`);
  if (!upstream.configured) return golfJson(503, { error: "not_configured" }, cors);
  if (upstream.thrown) {
    await recordLatency(boards, periods.day, latencyKind, upstream.ms);
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }
  const classified = classifyGolfapi(kind, upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  await recordFresh(boards, periods, ident, quota.chargeDevice, quota.chargeIp, quota.chargeGlobal, false, {
    allowlisted,
    countAllowlisted: quota.countAllowlisted,
    latency: callLatency(latencyKind, upstream)
  });
  if (classified.outcome === "data") {
    await boards.put(storeKey, upstream.text, { expirationTtl: golfapiStoreTtl(limits) });
    if (typeof boards.delete === "function") await boards.delete(emptyMarkerKey(kind, id));
    const response = upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, true);
    await rememberGolfEdge(cache, ctx, cacheKey, response);
    return response;
  }
  if (classified.outcome === "empty200" || classified.reason === "error_body") {
    await writeEmptyMarker(boards, limits, kind, id);
    hotfixLog("golfapi_no_data_marker", { route: `${stem}/${id}`, days: limits.emptyTtlDays });
  } else if (upstream.status >= 200 && upstream.status < 300) {
    hotfixLog("golfapi_uncached_200", { route: `${stem}/${id}`, ...golfapiUncachedFields(classified) });
  }
  return upstreamGolfResponse(upstream.status, upstream.text, upstream.contentType, cors, false);
}
__name(handleGolfapiLookup, "handleGolfapiLookup");
__name2(handleGolfapiLookup, "handleGolfapiLookup");
async function handleGolfapi(request, url, rest, env, ctx, cors) {
  const parsed = parseGolfapiRest(rest, url);
  if (!parsed) return golfJson(404, { error: "unknown_route" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = /* @__PURE__ */ new Date();
  const installId = readInstallId(request);
  const shared = {
    url,
    env,
    ctx,
    cors,
    boards,
    now,
    periods: golfapiPeriods(now),
    limits: readGolfapiLimits(env),
    installId,
    ipHash: await readIpHash(request),
    allowlisted: isAllowlisted(env, installId)
  };
  if (parsed.kind === "search") return handleGolfapiSearch(shared);
  return handleGolfapiLookup({ ...shared, kind: parsed.kind, id: parsed.id });
}
__name(handleGolfapi, "handleGolfapi");
__name2(handleGolfapi, "handleGolfapi");
var COURSE_MAP_UNAVAILABLE_MESSAGE = "Course map isn't available right now. You can still track shots and set greens.";
var GOLFAPI_MONTH_TTL = 60 * 60 * 24 * 40;
var GOLFAPI_DAY_TTL = 60 * 60 * 24 * 3;
var GOLFAPI_ALERT_TTL = 60 * 60 * 24 * 45;
var GOLFAPI_ALERT_FROM_DEFAULT = "alerts@shottraxx.com";
var GOLFAPI_ALERT_TO_DEFAULT = "bcbaird@gmail.com";
var hotfixEmailMessageClass = null;
function hotfixLog(evt, fields) {
  try {
    console.log(JSON.stringify({ evt, at: (/* @__PURE__ */ new Date()).toISOString(), ...fields || {} }));
  } catch {
  }
}
__name(hotfixLog, "hotfixLog");
function billingPeriod(nowMs, billingDay) {
  const day = Math.min(28, Math.max(1, Number.isInteger(billingDay) ? billingDay : GOLFAPI_DEFAULTS.billingDay));
  const d = new Date(nowMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() < day) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  const startMs = Date.UTC(y, m, day);
  const endMs = Date.UTC(y, m + 1, day);
  return { id: new Date(startMs).toISOString().slice(0, 10), startMs, endMs };
}
__name(billingPeriod, "billingPeriod");
function monthCounterKey(periodId) {
  return `gq:month:${periodId}`;
}
__name(monthCounterKey, "monthCounterKey");
async function readMonthCount(boards, key) {
  try {
    return clampCount(await boards.get(key));
  } catch {
    return 0;
  }
}
__name(readMonthCount, "readMonthCount");
async function countGolfapiCall(env, boards, limits, now) {
  const period = billingPeriod(now.getTime(), limits.billingDay);
  const key = monthCounterKey(period.id);
  const count = await readMonthCount(boards, key) + 1;
  await putCounter(boards, key, String(count), { expirationTtl: GOLFAPI_MONTH_TTL });
  const dayKey = dayCounterKey(golfapiPeriods(now).day);
  const dayCount = await readMonthCount(boards, dayKey) + 1;
  await putCounter(boards, dayKey, String(dayCount), { expirationTtl: GOLFAPI_DAY_TTL });
  if (limits.monthBudget > 0 && count >= Math.ceil(limits.monthBudget * 0.8)) {
    await maybeAlert(env, boards, "monthly_80", period.id, { monthCalls: count, monthBudget: limits.monthBudget, period: period.id });
  }
  return { count, period: period.id, dayCount };
}
__name(countGolfapiCall, "countGolfapiCall");
async function golfapiSpendBlockReason(boards, limits, now, allowlisted = false, need = 1) {
  const balance = await readBalance(boards);
  if (floorBlocks(balance, limits.floor, need)) return "floor";
  if (allowlisted) return null;
  const period = billingPeriod(now.getTime(), limits.billingDay);
  if (await readMonthCount(boards, monthCounterKey(period.id)) + need > limits.monthBudget) return "global_month";
  if (await readMonthCount(boards, dayCounterKey(golfapiPeriods(now).day)) + need > limits.globalDay) return "global_day";
  return null;
}
__name(golfapiSpendBlockReason, "golfapiSpendBlockReason");
function dayCounterKey(day) {
  return `gq:day:${day}`;
}
__name(dayCounterKey, "dayCounterKey");
var GOLFAPI_QUOTA_TEXT = /quota|rate.?limit|too many requests|limit (reached|exceeded)|no (api )?requests left|insufficient (credits|requests)|subscription|unauthori[sz]ed|invalid api key|forbidden/i;
function golfapiPayloadMessage(payload) {
  if (!isPlainObject(payload)) return null;
  for (const field of ["message", "status", "detail", "msg", "error"]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 200);
  }
  return null;
}
__name(golfapiPayloadMessage, "golfapiPayloadMessage");
function golfapiUncachedFields(classified) {
  const message = golfapiPayloadMessage(classified.payload);
  return message ? { reason: classified.reason, message } : { reason: classified.reason };
}
__name(golfapiUncachedFields, "golfapiUncachedFields");
function golfapiLooksLikeQuota(payload) {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.message === "string" && payload.message.trim() !== "") return true;
  for (const field of ["status", "detail", "msg"]) {
    if (typeof payload[field] === "string" && GOLFAPI_QUOTA_TEXT.test(payload[field])) return true;
  }
  return false;
}
__name(golfapiLooksLikeQuota, "golfapiLooksLikeQuota");
function golfapiStoreTtl(limits) {
  return Math.max(60, (limits.storeTtlDays || GOLFAPI_DEFAULTS.storeTtlDays) * 86400);
}
__name(golfapiStoreTtl, "golfapiStoreTtl");
async function writeEmptyMarker(boards, limits, kind, id) {
  if (!limits.emptyTtlDays) return;
  await boards.put(emptyMarkerKey(kind, id), "1", { expirationTtl: limits.emptyTtlDays * 86400 });
}
__name(writeEmptyMarker, "writeEmptyMarker");
function golfapiRouteLabel(pathAndQuery) {
  const path = String(pathAndQuery || "").split("?")[0];
  return path === "courses" ? "courses (search)" : path;
}
__name(golfapiRouteLabel, "golfapiRouteLabel");
function readHeaderRequestsLeft(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  for (const name of ["apiRequestsLeft", "X-Api-Requests-Left"]) {
    const raw = headers.get(name);
    if (raw == null || String(raw).trim() === "") continue;
    const n = Number(String(raw).trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}
__name(readHeaderRequestsLeft, "readHeaderRequestsLeft");
async function noteGolfapiCall(env, boards, limits, pathAndQuery, result, headers, month) {
  let payload = null;
  try {
    payload = JSON.parse(result.text);
  } catch {
    payload = null;
  }
  const bodyLeft = readRequestsLeft(payload);
  const headerLeft = readHeaderRequestsLeft(headers);
  const left = bodyLeft ?? headerLeft;
  hotfixLog("golfapi_call", {
    route: golfapiRouteLabel(pathAndQuery),
    status: result.status,
    apiRequestsLeft: left,
    ...headerLeft != null && bodyLeft == null ? { apiRequestsLeftFrom: "header" } : {},
    ms: result.ms,
    monthCount: month ? month.count : null,
    monthBudget: limits.monthBudget,
    dayCount: month ? month.dayCount : null,
    period: month ? month.period : null
  });
  if (boards && left != null && left <= limits.floor) {
    const day = golfapiPeriods(/* @__PURE__ */ new Date()).day;
    await maybeAlert(env, boards, "reserve", day, { apiRequestsLeft: left, floor: limits.floor });
  }
}
__name(noteGolfapiCall, "noteGolfapiCall");
var GOLFAPI_HOLE_FIELDS = ["numHoles", "parsMen", "pars", "tees", "holes"];
function golfapiFinitePoint(row) {
  if (!isPlainObject(row)) return false;
  const rawLat = row.latitude ?? row.lat;
  const rawLng = row.longitude ?? row.lng ?? row.lon;
  if (rawLat == null || rawLng == null || rawLat === "" || rawLng === "") return false;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(lat === 0 && lng === 0);
}
__name(golfapiFinitePoint, "golfapiFinitePoint");
function golfapiSearchRowHasData(row) {
  if (!isPlainObject(row)) return false;
  if (Array.isArray(row.courses)) return row.courses.length > 0;
  return true;
}
__name(golfapiSearchRowHasData, "golfapiSearchRowHasData");
function golfapiBodyHasData(kind, payload) {
  if (kind === "search") {
    return searchHasData(payload) && payload.courses.some(golfapiSearchRowHasData);
  }
  if (kind === "coord") {
    return coordHasData(payload) && payload.coordinates.some(golfapiFinitePoint);
  }
  if (!courseHasData(payload)) return false;
  const course = isPlainObject(payload.course) && courseHasData(payload.course) ? payload.course : payload;
  for (const field of GOLFAPI_HOLE_FIELDS) {
    const value = course[field];
    if (field === "numHoles") {
      if (value != null && value !== "" && Number(value) > 0) return true;
      continue;
    }
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}
__name(golfapiBodyHasData, "golfapiBodyHasData");
function golfapiTextHasData(kind, text) {
  try {
    return golfapiBodyHasData(kind, JSON.parse(text));
  } catch {
    return false;
  }
}
__name(golfapiTextHasData, "golfapiTextHasData");
async function maybeAlert(env, boards, kind, windowId, details) {
  if (!boards || typeof boards.get !== "function") return { sent: false, reason: "no_store" };
  const flagKey = `gq:alert:${kind}:${windowId}`;
  try {
    if (await boards.get(flagKey)) return { sent: false, reason: "already_sent" };
  } catch {
    return { sent: false, reason: "store_error" };
  }
  await putCounter(boards, flagKey, (/* @__PURE__ */ new Date()).toISOString(), { expirationTtl: GOLFAPI_ALERT_TTL });
  hotfixLog("golfapi_alert", { kind, window: windowId, ...details });
  const subject = `ShotTraxx golfapi alert: ${kind}`;
  const text = [
    `golfapi limiter: ${kind} (${windowId}).`,
    "",
    ...Object.entries(details || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`),
    "",
    "New golfapi calls are held where the limit applies; stored copies still serve.",
    "Limits: GOLFAPI_* Worker vars. Runbook: docs/worker-hotfix-after-magnolia.md."
  ].join("\n");
  try {
    const sent = await sendAlertEmail(env, subject, text);
    return { sent, reason: sent ? "sent" : "logged_only" };
  } catch (err) {
    hotfixLog("golfapi_alert_send_failed", { kind, error: String(err && err.message || err) });
    return { sent: false, reason: "send_failed" };
  }
}
__name(maybeAlert, "maybeAlert");
async function sendAlertEmail(env, subject, text) {
  const source = env || {};
  const bindingName = typeof source.ALERT_EMAIL_BINDING === "string" && source.ALERT_EMAIL_BINDING.trim() || "ALERT_EMAIL";
  const binding = source[bindingName];
  const to = typeof source.ALERT_TO === "string" && source.ALERT_TO.trim() || GOLFAPI_ALERT_TO_DEFAULT;
  const from = typeof source.ALERT_FROM === "string" && source.ALERT_FROM.trim() || GOLFAPI_ALERT_FROM_DEFAULT;
  if (!binding || typeof binding.send !== "function") {
    hotfixLog("golfapi_alert_log_only", { subject, binding: bindingName });
    return false;
  }
  const EmailMessageClass = hotfixEmailMessageClass || (await import("cloudflare:email")).EmailMessage;
  const raw = [
    `From: ShotTraxx Worker <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${(/* @__PURE__ */ new Date()).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1] || "shottraxx.com"}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text
  ].join("\r\n");
  await binding.send(new EmailMessageClass(from, to, raw));
  return true;
}
__name(sendAlertEmail, "sendAlertEmail");
function __setEmailMessageClassForTests(cls) {
  hotfixEmailMessageClass = cls || null;
}
__name(__setEmailMessageClassForTests, "__setEmailMessageClassForTests");
async function listKeys(boards, prefix) {
  if (!boards || typeof boards.list !== "function") return [];
  const names = [];
  let cursor;
  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    const page = await boards.list(cursor ? { prefix, cursor } : { prefix });
    const keys = page && Array.isArray(page.keys) ? page.keys : [];
    for (const entry of keys) {
      if (entry && typeof entry.name === "string") names.push(entry.name);
    }
    if (!page || page.list_complete !== false || !page.cursor) break;
    cursor = page.cursor;
  }
  return names;
}
__name(listKeys, "listKeys");
__name2(listKeys, "listKeys");
function parseQueueRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    const attempts = Number(parsed && parsed.attempts);
    return {
      attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 0,
      at: Number(parsed && parsed.at) || 0,
      q: typeof parsed?.q === "string" ? parsed.q : "",
      search: typeof parsed?.search === "string" ? parsed.search : ""
    };
  } catch {
    return { attempts: 0, at: 0, q: "", search: "" };
  }
}
__name(parseQueueRecord, "parseQueueRecord");
__name2(parseQueueRecord, "parseQueueRecord");
async function partReady(boards, kind, id) {
  if (typeof await boards.get(storeKeyFor(kind, id)) === "string") return true;
  return await boards.get(emptyMarkerKey(kind, id)) != null;
}
__name(partReady, "partReady");
__name2(partReady, "partReady");
async function pullQueuedPart(env, boards, day, state, kind, id) {
  const stem = kind === "course" ? "courses" : "coordinates";
  const upstream = await fetchGolfapiUpstream(env, `${stem}/${id}`);
  await recordLatency(boards, day, kind === "course" ? "course" : "coordinates", upstream.ms);
  if (!upstream.configured || upstream.thrown) {
    state.failed = true;
    return;
  }
  state.fetched = true;
  const classified = classifyGolfapi(kind, upstream.status, upstream.text);
  await rememberBalance(boards, upstream.status, classified.payload);
  const limits = readGolfapiLimits(env);
  if (classified.outcome === "data") {
    await boards.put(storeKeyFor(kind, id), upstream.text, { expirationTtl: golfapiStoreTtl(limits) });
    await boards.delete(emptyMarkerKey(kind, id));
    return;
  }
  if (classified.outcome === "empty200" || classified.reason === "error_body") {
    await writeEmptyMarker(boards, limits, kind, id);
    return;
  }
  if (upstream.status === 404) return;
  if (upstream.status >= 200 && upstream.status < 300) {
    hotfixLog("golfapi_uncached_200", { route: `${stem}/${id}`, ...golfapiUncachedFields(classified), source: "queue" });
  }
  state.failed = true;
}
__name(pullQueuedPart, "pullQueuedPart");
__name2(pullQueuedPart, "pullQueuedPart");
async function refillCoursePair(env, boards, limits, day, state, courseId) {
  let courseDone = await partReady(boards, "course", courseId);
  let coordDone = await partReady(boards, "coord", courseId);
  if (!courseDone) {
    if (balanceBlocks(await readBalance(boards), limits.floor)) {
      state.stop = true;
      return;
    }
    await pullQueuedPart(env, boards, day, state, "course", courseId);
    if (state.failed) return;
    courseDone = true;
  }
  if (!coordDone) {
    if (balanceBlocks(await readBalance(boards), limits.floor)) {
      state.stop = true;
      return;
    }
    await pullQueuedPart(env, boards, day, state, "coord", courseId);
    if (state.failed) return;
    coordDone = true;
  }
  state.done = courseDone && coordDone;
}
__name(refillCoursePair, "refillCoursePair");
__name2(refillCoursePair, "refillCoursePair");
async function drainSearchItem(env, boards, limits, day, item) {
  const state = { fetched: false, failed: false, stop: false, done: false };
  const storeKey = `gapi:search:${item.token}`;
  let stored = await boards.get(storeKey);
  if (typeof stored !== "string" || !searchBodyOk(stored)) {
    const upstream = await fetchGolfapiUpstream(env, `courses${item.record.search}`);
    await recordLatency(boards, day, "search", upstream.ms);
    if (!upstream.configured || upstream.thrown) {
      state.failed = true;
      return state;
    }
    state.fetched = true;
    const classified = classifyGolfapi("search", upstream.status, upstream.text);
    await rememberBalance(boards, upstream.status, classified.payload);
    if (upstream.status === 404 || classified.outcome === "empty200") {
      state.done = true;
      return state;
    }
    if (classified.outcome !== "search") {
      state.failed = true;
      return state;
    }
    if (golfapiBodyHasData("search", classified.payload)) {
      await boards.put(storeKey, upstream.text, { expirationTtl: GOLFAPI_SEARCH_TTL });
    }
    stored = upstream.text;
  }
  let payload = null;
  try {
    payload = JSON.parse(stored);
  } catch {
    payload = null;
  }
  const courseId = matchingCourseId(payload, item.record.q);
  if (!courseId) {
    state.done = true;
    return state;
  }
  await refillCoursePair(env, boards, limits, day, state, courseId);
  return state;
}
__name(drainSearchItem, "drainSearchItem");
__name2(drainSearchItem, "drainSearchItem");
async function drainGolfapiQueue(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function" || typeof boards.delete !== "function") return;
  const secret = typeof env.GOLFAPI_KEY === "string" ? env.GOLFAPI_KEY.trim() : "";
  if (!secret) return;
  const now = /* @__PURE__ */ new Date();
  const periods = golfapiPeriods(now);
  const limits = readGolfapiLimits(env);
  const names = await listKeys(boards, "gqueue:");
  const items = [];
  for (const name of names) {
    const record = parseQueueRecord(await boards.get(name));
    if (name.startsWith("gqueue:q:")) {
      const token = name.slice("gqueue:q:".length);
      const searchOk = record.search.startsWith("?") && !/[\r\n#]/.test(record.search);
      const tokenOk = /^[0-9a-f]{64}$/.test(token) && token === await searchToken(record.q);
      if (!tokenOk || record.q !== normalizeName(record.q) || !searchOk) {
        await boards.delete(name);
        continue;
      }
      items.push({ name, kind: "search", token, record });
      continue;
    }
    const id = safeGolfapiId(name.slice("gqueue:".length));
    if (!id || name !== `gqueue:${id}`) {
      await boards.delete(name);
      continue;
    }
    items.push({ name, kind: "course", id, record });
  }
  items.sort((left, right) => left.record.at - right.record.at || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const item of items) {
    if (item.record.attempts >= GOLFAPI_GIVE_UP) continue;
    if (balanceBlocks(await readBalance(boards), limits.floor)) break;
    const budgetBlock = await golfapiSpendBlockReason(boards, limits, /* @__PURE__ */ new Date(), false, limits.openCalls);
    if (budgetBlock && budgetBlock !== "floor") break;
    const outcome = item.kind === "search" ? await drainSearchItem(env, boards, limits, periods.day, item) : await (async () => {
      const state = { fetched: false, failed: false, stop: false, done: false };
      await refillCoursePair(env, boards, limits, periods.day, state, item.id);
      return state;
    })();
    if (outcome.fetched) {
      await bumpStats(boards, periods.day, (row) => {
        row.lookups += 1;
      });
    }
    if (outcome.stop) break;
    if (outcome.failed) {
      const attempts = item.record.attempts + 1;
      const body = { attempts, at: item.record.at || Date.now() };
      if (item.kind === "search") {
        body.q = item.record.q;
        body.search = item.record.search;
      }
      await boards.put(item.name, JSON.stringify(body), { expirationTtl: GOLFAPI_QUEUE_TTL });
      continue;
    }
    if (outcome.done) await boards.delete(item.name);
  }
}
__name(drainGolfapiQueue, "drainGolfapiQueue");
__name2(drainGolfapiQueue, "drainGolfapiQueue");
async function handleGolfapiMeta(request, env, cors) {
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = /* @__PURE__ */ new Date();
  const limits = readGolfapiLimits(env);
  const balance = await readBalance(boards);
  const days = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const date = utcDay(now, offset);
    days.push(statsView(date, await readStats(boards, `gq:stats:${date}`)));
  }
  const today = { ...days[days.length - 1], globalCap: limits.globalDay };
  days[days.length - 1] = today;
  const queue = await listKeys(boards, "gqueue:");
  const period = billingPeriod(now.getTime(), limits.billingDay);
  return golfJson(200, {
    balance: publicBalance(balance),
    asOf: balanceAsOf(balance),
    generatedAt: now.toISOString(),
    globalCap: limits.globalDay,
    month: { period: period.id, calls: await readMonthCount(boards, monthCounterKey(period.id)), budget: limits.monthBudget },
    day: { date: golfapiPeriods(now).day, calls: await readMonthCount(boards, dayCounterKey(golfapiPeriods(now).day)), cap: limits.globalDay },
    today,
    days,
    queueLength: queue.length
  }, cors);
}
__name(handleGolfapiMeta, "handleGolfapiMeta");
__name2(handleGolfapiMeta, "handleGolfapiMeta");
async function handleGcaMeta(request, env, cors) {
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const now = /* @__PURE__ */ new Date();
  const days = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const date = utcDay(now, offset);
    days.push(gcaStatsView(date, await readGcaStats(boards, `gca:stats:${date}`)));
  }
  return golfJson(200, {
    refreshDays: readGcaRefreshDays(env),
    generatedAt: now.toISOString(),
    today: days[days.length - 1],
    days
  }, cors);
}
__name(handleGcaMeta, "handleGcaMeta");
__name2(handleGcaMeta, "handleGcaMeta");
function golfJson(status, body, cors, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra
    }
  });
}
__name(golfJson, "golfJson");
__name2(golfJson, "golfJson");
function matchGolfVendor(pathname) {
  for (const vendor of Object.values(GOLF_VENDORS)) {
    if (!pathname.startsWith(vendor.prefix)) continue;
    const rest = pathname.slice(vendor.prefix.length);
    if (vendor.routes.some((route) => route.test(rest))) return { vendor, rest };
    return { vendor, rest: null };
  }
  return null;
}
__name(matchGolfVendor, "matchGolfVendor");
__name2(matchGolfVendor, "matchGolfVendor");
function isJsonContentType(value) {
  const media = String(value ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}
__name(isJsonContentType, "isJsonContentType");
__name2(isJsonContentType, "isJsonContentType");
function safeGcaId(raw) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) return null;
  return raw;
}
__name(safeGcaId, "safeGcaId");
__name2(safeGcaId, "safeGcaId");
function parseGcaRest(rest) {
  if (rest === "courses") return { kind: "search" };
  let match = /^courses\/([^/]+)\/green-centers$/.exec(rest);
  if (match) {
    const id = safeGcaId(match[1]);
    return id ? { kind: "green-centers", id } : { kind: "search" };
  }
  match = /^courses\/([^/]+)$/.exec(rest);
  if (match) {
    const id = safeGcaId(match[1]);
    return id ? { kind: "course", id } : { kind: "search" };
  }
  return { kind: "search" };
}
__name(parseGcaRest, "parseGcaRest");
__name2(parseGcaRest, "parseGcaRest");
function gcaStoreKey(kind, id) {
  return kind === "green-centers" ? `gca:greens:${id}` : `gca:course:${id}`;
}
__name(gcaStoreKey, "gcaStoreKey");
__name2(gcaStoreKey, "gcaStoreKey");
function gcaRateHeaderValues(headers) {
  const values = {};
  if (!headers || typeof headers.forEach !== "function") return values;
  headers.forEach((value, name) => {
    const lower = String(name).toLowerCase();
    if (!GCA_RATE_HEADERS.has(lower) && !lower.startsWith("ratelimit-")) return;
    const text = String(value);
    values[lower] = text.length > 200 ? text.slice(0, 200) : text;
  });
  return values;
}
__name(gcaRateHeaderValues, "gcaRateHeaderValues");
__name2(gcaRateHeaderValues, "gcaRateHeaderValues");
function logGcaRateLimit(kind, status, headers) {
  const rates = gcaRateHeaderValues(headers);
  if (status !== 429 && Object.keys(rates).length === 0) return;
  console.log(JSON.stringify({ route: kind, status, ...rates }));
}
__name(logGcaRateLimit, "logGcaRateLimit");
__name2(logGcaRateLimit, "logGcaRateLimit");
function presentGcaCourseBody(kind, courseId, rawBody, contentType) {
  if (kind !== "course") return rawBody;
  if (contentType != null && contentType !== "" && !isJsonContentType(contentType)) return rawBody;
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (!applyGcaScorecardCorrection(payload, courseId)) return rawBody;
  return JSON.stringify(payload);
}
__name(presentGcaCourseBody, "presentGcaCourseBody");
__name2(presentGcaCourseBody, "presentGcaCourseBody");
function gcaClientResponse(kind, courseId, rawBody, cors, { maxAge, stale, ageSeconds, contentType } = {}) {
  const body = presentGcaCourseBody(kind, courseId, rawBody, contentType);
  const headers = {
    ...cors,
    "Content-Type": contentType || "application/json",
    "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store"
  };
  if (stale) {
    headers["X-Course-Data-Stale"] = "1";
    if (Number.isInteger(ageSeconds) && ageSeconds >= 0) headers["X-Course-Data-Age"] = String(ageSeconds);
  }
  return new Response(body, { status: 200, headers });
}
__name(gcaClientResponse, "gcaClientResponse");
__name2(gcaClientResponse, "gcaClientResponse");
function gcaRawEdgeResponse(rawBody, cors, contentType) {
  return new Response(rawBody, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": contentType || "application/json",
      "Cache-Control": `public, max-age=${GOLF_CACHE_SECONDS}`
    }
  });
}
__name(gcaRawEdgeResponse, "gcaRawEdgeResponse");
__name2(gcaRawEdgeResponse, "gcaRawEdgeResponse");
async function readGcaStored(boards, key) {
  if (!boards || typeof boards.getWithMetadata !== "function") return null;
  const row = await boards.getWithMetadata(key);
  if (!row || typeof row.value !== "string" || row.value.length === 0) return null;
  const metadata = row.metadata;
  if (!isPlainObject(metadata) || metadata.status !== 200) return null;
  if (typeof metadata.storedAt !== "number" || !Number.isFinite(metadata.storedAt)) return null;
  return { body: row.value, storedAt: metadata.storedAt };
}
__name(readGcaStored, "readGcaStored");
__name2(readGcaStored, "readGcaStored");
async function fetchGcaDurable(apiKey, upstreamUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GCA_UPSTREAM_MS);
  try {
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    const body = await response.arrayBuffer();
    return { thrown: false, response, body };
  } catch {
    return { thrown: true, response: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchGcaDurable, "fetchGcaDurable");
__name2(fetchGcaDurable, "fetchGcaDurable");
async function handleGcaEdgeOnly({ url, rest, env, ctx, cors, apiKey, route, missingInstallId }) {
  const upstreamUrl = `${GOLF_VENDORS.gca.upstream}${rest}${url.search}`;
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const day = utcDay(/* @__PURE__ */ new Date(), 0);
  const boards = env && env.BOARDS;
  if (missingInstallId) await recordGcaMissingInstall(boards, day);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
    });
  } catch {
    await recordGcaUpstream(boards, day, { status: null, stale: false });
    return golfJson(502, { error: "upstream_unreachable" }, cors);
  }
  logGcaRateLimit(route, upstream.status, upstream.headers);
  await recordGcaUpstream(boards, day, { status: upstream.status, stale: false });
  const body = await upstream.arrayBuffer();
  const ok = upstream.status >= 200 && upstream.status < 300;
  const response = new Response(body, {
    status: upstream.status,
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": ok ? `public, max-age=${GOLF_CACHE_SECONDS}` : "no-store"
    }
  });
  if (ok) {
    const put = rememberGolfEdge(cache, ctx, cacheKey, response);
    if (put) await put;
  }
  return response;
}
__name(handleGcaEdgeOnly, "handleGcaEdgeOnly");
__name2(handleGcaEdgeOnly, "handleGcaEdgeOnly");
async function handleGcaDurable({ kind, id, url, rest, env, ctx, cors, apiKey, missingInstallId }) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
    return golfJson(503, { error: "boards_not_configured" }, cors);
  }
  const storeKey = gcaStoreKey(kind, id);
  const cache = edgeCache();
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(cacheKey);
    if (cached) {
      if (cached.status >= 200 && cached.status < 300) {
        const raw = await cached.text();
        return gcaClientResponse(kind, id, raw, cors, {
          maxAge: GCA_CLIENT_MAX_AGE,
          contentType: cached.headers.get("Content-Type") || "application/json"
        });
      }
      if (cached.status === 404) return cached;
    }
  }
  if (missingInstallId) await recordGcaMissingInstall(boards, utcDay(/* @__PURE__ */ new Date(), 0));
  const copy = await readGcaStored(boards, storeKey);
  const nowMs = Date.now();
  if (copy && nowMs - copy.storedAt < readGcaRefreshDays(env) * 24 * 60 * 60 * 1e3) {
    const response = gcaClientResponse(kind, id, copy.body, cors, { maxAge: GCA_CLIENT_MAX_AGE });
    const put = rememberGolfEdge(cache, ctx, cacheKey, gcaRawEdgeResponse(copy.body, cors));
    if (put) await put;
    return response;
  }
  const outcome = await fetchGcaDurable(apiKey, `${GOLF_VENDORS.gca.upstream}${rest}${url.search}`);
  const day = utcDay(/* @__PURE__ */ new Date(), 0);
  const status = outcome.response ? outcome.response.status : null;
  if (outcome.response) logGcaRateLimit(kind, status, outcome.response.headers);
  const upstreamFailed = outcome.thrown || status === 429 || typeof status === "number" && status >= 500;
  if (upstreamFailed && copy) {
    await recordGcaUpstream(boards, day, { status, stale: true });
    const ageSeconds = Math.max(0, Math.floor((Date.now() - copy.storedAt) / 1e3));
    return gcaClientResponse(kind, id, copy.body, cors, { stale: true, ageSeconds });
  }
  await recordGcaUpstream(boards, day, { status, stale: false });
  if (outcome.thrown) return golfJson(502, { error: "upstream_unreachable" }, cors);
  if (status === 429) {
    const retry = cleanRetryAfter(outcome.response.headers.get("Retry-After")) || "30";
    return golfJson(429, { error: "rate_limited" }, cors, { "Retry-After": retry });
  }
  const text = new TextDecoder().decode(outcome.body);
  if (status >= 200 && status < 300) {
    const contentType = outcome.response.headers.get("Content-Type") || "application/json";
    await boards.put(storeKey, text, {
      expirationTtl: GCA_STORE_TTL,
      metadata: { status: 200, storedAt: Date.now() }
    });
    const response = gcaClientResponse(kind, id, text, cors, { maxAge: GCA_CLIENT_MAX_AGE, contentType });
    const put = rememberGolfEdge(cache, ctx, cacheKey, gcaRawEdgeResponse(text, cors, contentType));
    if (put) await put;
    return response;
  }
  if (status === 404) {
    const notFound = new Response(outcome.body, {
      status: 404,
      headers: {
        ...cors,
        "Content-Type": outcome.response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": copy ? "no-store" : `public, max-age=${GCA_NEGATIVE_TTL}`
      }
    });
    if (!copy) {
      const put = rememberGolfEdge(cache, ctx, cacheKey, notFound);
      if (put) await put;
    }
    return notFound;
  }
  return new Response(outcome.body, {
    status,
    headers: {
      ...cors,
      "Content-Type": outcome.response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store"
    }
  });
}
__name(handleGcaDurable, "handleGcaDurable");
__name2(handleGcaDurable, "handleGcaDurable");
async function handleGca(request, url, rest, env, ctx, cors, apiKey) {
  const missingInstallId = !readInstallId(request);
  if (missingInstallId && gcaRequiresInstallId(env)) {
    return golfJson(401, { error: "install_id_required" }, cors);
  }
  const parsed = parseGcaRest(rest);
  if (parsed.kind === "course" || parsed.kind === "green-centers") {
    return handleGcaDurable({ kind: parsed.kind, id: parsed.id, url, rest, env, ctx, cors, apiKey, missingInstallId });
  }
  return handleGcaEdgeOnly({ url, rest, env, ctx, cors, apiKey, route: "search", missingInstallId });
}
__name(handleGca, "handleGca");
__name2(handleGca, "handleGca");
function responseWithoutAllowOrigin(response) {
  if (!response.headers.has("Access-Control-Allow-Origin")) return response;
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
__name(responseWithoutAllowOrigin, "responseWithoutAllowOrigin");
__name2(responseWithoutAllowOrigin, "responseWithoutAllowOrigin");
async function handleGolfProxy(request, env, ctx, cors) {
  const url = new URL(request.url);
  const hit = matchGolfVendor(url.pathname);
  if (!hit) return null;
  if (hit.vendor.secret === "GOLFAPI_KEY") {
    if (!readInstallId(request)) {
      await noteGolfapiInstallRequired(env);
      return golfJson(401, { error: "install_id_required" }, cors);
    }
  } else if (!readInstallId(request) && gcaRequiresInstallId(env)) {
    return golfJson(401, { error: "install_id_required" }, cors);
  }
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  if (hit.rest == null) return golfJson(404, { error: "unknown_route" }, cors);
  const key = typeof env[hit.vendor.secret] === "string" ? env[hit.vendor.secret].trim() : "";
  if (!key) return golfJson(503, { error: "not_configured" }, cors);
  if (hit.vendor.secret === "GOLFAPI_KEY") {
    return handleGolfapi(request, url, hit.rest, env, ctx, cors);
  }
  return handleGca(request, url, hit.rest, env, ctx, cors, key);
}
__name(handleGolfProxy, "handleGolfProxy");
__name2(handleGolfProxy, "handleGolfProxy");
function overpassQuery(lat, lng, radiusM) {
  const r = Math.max(50, Math.min(3e3, Math.round(radiusM)));
  return `[out:json][timeout:25];
(
  way["golf"="green"](around:${r},${lat},${lng});
  way["golf"="fairway"](around:${r},${lat},${lng});
  way["golf"="tee"](around:${r},${lat},${lng});
  way["golf"="hole"](around:${r},${lat},${lng});
  way["golf"="bunker"](around:${r},${lat},${lng});
  way["golf"="water_hazard"](around:${r},${lat},${lng});
  way["golf"="lateral_water_hazard"](around:${r},${lat},${lng});
  way["golf"="cartpath"](around:${r},${lat},${lng});
  relation["golf"="green"](around:${r},${lat},${lng});
  relation["golf"="fairway"](around:${r},${lat},${lng});
  relation["golf"="tee"](around:${r},${lat},${lng});
  relation["golf"="bunker"](around:${r},${lat},${lng});
  relation["golf"="water_hazard"](around:${r},${lat},${lng});
  relation["golf"="lateral_water_hazard"](around:${r},${lat},${lng});
);
out geom;`;
}
__name(overpassQuery, "overpassQuery");
__name2(overpassQuery, "overpassQuery");
var OSM_WAY_GOLF = /* @__PURE__ */ new Set([
  "green",
  "fairway",
  "tee",
  "hole",
  "bunker",
  "water_hazard",
  "lateral_water_hazard",
  "cartpath"
]);
var OSM_RELATION_GOLF = /* @__PURE__ */ new Set([
  "green",
  "fairway",
  "tee",
  "bunker",
  "water_hazard",
  "lateral_water_hazard"
]);
function parseCoord(raw, min, max) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}
__name(parseCoord, "parseCoord");
__name2(parseCoord, "parseCoord");
function parseRadius(raw) {
  if (raw == null) return 1800;
  if (!/^\d+$/.test(raw)) return null;
  const radius = Number(raw);
  if (radius < 200 || radius > 2e3) return null;
  return radius;
}
__name(parseRadius, "parseRadius");
__name2(parseRadius, "parseRadius");
function parseOverlayRequest(url) {
  const courseId = url.searchParams.get("courseId");
  if (courseId == null || !COURSE_ID_RE.test(courseId)) return null;
  const lat = parseCoord(url.searchParams.get("lat"), -90, 90);
  const lng = parseCoord(url.searchParams.get("lng"), -180, 180);
  if (lat == null || lng == null) return null;
  const radius = parseRadius(url.searchParams.get("radius"));
  if (radius == null) return null;
  return { courseId, lat, lng, radius };
}
__name(parseOverlayRequest, "parseOverlayRequest");
__name2(parseOverlayRequest, "parseOverlayRequest");
function overlayLocationKey(lat, lng, radius) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}:${radius}`;
}
__name(overlayLocationKey, "overlayLocationKey");
__name2(overlayLocationKey, "overlayLocationKey");
function cellIndex(value) {
  const millionths = Math.round(value * 1e6);
  return Math.floor(millionths / OSM_CELL_MILLIONTHS);
}
__name(cellIndex, "cellIndex");
__name2(cellIndex, "cellIndex");
function formatCell(index) {
  const sign = index < 0 ? "-" : "";
  const abs = Math.abs(index);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}
__name(formatCell, "formatCell");
__name2(formatCell, "formatCell");
function wrapLngCell(index) {
  const span = 360 * 100;
  return ((index + 180 * 100) % span + span) % span - 180 * 100;
}
__name(wrapLngCell, "wrapLngCell");
__name2(wrapLngCell, "wrapLngCell");
function clampLatCell(index) {
  if (index < -90 * 100) return -90 * 100;
  if (index > 90 * 100) return 90 * 100;
  return index;
}
__name(clampLatCell, "clampLatCell");
__name2(clampLatCell, "clampLatCell");
function cellToken(lat, lng) {
  return `${formatCell(clampLatCell(cellIndex(lat)))},${formatCell(wrapLngCell(cellIndex(lng)))}`;
}
__name(cellToken, "cellToken");
__name2(cellToken, "cellToken");
function cellsAround(lat, lng) {
  const latSpan = OSM_NEAR_M / 111320;
  const cos = Math.cos(lat * Math.PI / 180);
  const lngSpan = OSM_NEAR_M / Math.max(111320 * Math.abs(cos), 1);
  const steps = /* @__PURE__ */ __name2((span) => Math.min(OSM_MAX_CELL_STEPS, Math.floor(span / 0.01) + 1), "steps");
  const latN = steps(latSpan);
  const lngN = steps(lngSpan);
  const baseLat = cellIndex(lat);
  const baseLng = cellIndex(lng);
  const cells = /* @__PURE__ */ new Set();
  for (let i = -latN; i <= latN; i++) {
    for (let j = -lngN; j <= lngN; j++) {
      cells.add(`${formatCell(clampLatCell(baseLat + i))},${formatCell(wrapLngCell(baseLng + j))}`);
    }
  }
  return [...cells];
}
__name(cellsAround, "cellsAround");
__name2(cellsAround, "cellsAround");
function indexKeyFor(lat, lng) {
  return `osm:v1:index:${cellToken(lat, lng)}`;
}
__name(indexKeyFor, "indexKeyFor");
__name2(indexKeyFor, "indexKeyFor");
function distanceMeters(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return EARTH_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
__name(distanceMeters, "distanceMeters");
__name2(distanceMeters, "distanceMeters");
function validIndexEntry(entry) {
  return Boolean(
    entry && typeof entry.lat === "number" && typeof entry.lng === "number" && Number.isFinite(entry.lat) && Number.isFinite(entry.lng) && typeof entry.radius === "number" && entry.radius >= 200 && entry.radius <= 2e3
  );
}
__name(validIndexEntry, "validIndexEntry");
__name2(validIndexEntry, "validIndexEntry");
function savedCenter(lat, lng) {
  return {
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4))
  };
}
__name(savedCenter, "savedCenter");
__name2(savedCenter, "savedCenter");
function remarkIsRuntimeFailure(payload) {
  if (!payload || typeof payload !== "object") return false;
  const remark = payload.remark;
  if (typeof remark !== "string") return false;
  return /runtime error|timed ?out|timeout|too busy/i.test(remark);
}
__name(remarkIsRuntimeFailure, "remarkIsRuntimeFailure");
__name2(remarkIsRuntimeFailure, "remarkIsRuntimeFailure");
function payloadHasGolf(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.elements)) return false;
  return payload.elements.some((element) => {
    if (!element || typeof element !== "object") return false;
    const tags = element.tags;
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) return false;
    return typeof tags.golf === "string" && tags.golf.trim() !== "";
  });
}
__name(payloadHasGolf, "payloadHasGolf");
__name2(payloadHasGolf, "payloadHasGolf");
function storedOverlay(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const payload = JSON.parse(text);
    if (remarkIsRuntimeFailure(payload) || !payloadHasGolf(payload)) return null;
    return text;
  } catch {
    return null;
  }
}
__name(storedOverlay, "storedOverlay");
__name2(storedOverlay, "storedOverlay");
function cleanRetryAfter(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}
__name(cleanRetryAfter, "cleanRetryAfter");
__name2(cleanRetryAfter, "cleanRetryAfter");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
__name2(sleep, "sleep");
function overlaySource(body) {
  if (typeof body !== "string" || !body.includes("osm-api")) return null;
  try {
    const payload = JSON.parse(body);
    if (payload && payload.generator === "osm-api") return "osm-api";
  } catch {
    return null;
  }
  return null;
}
__name(overlaySource, "overlaySource");
__name2(overlaySource, "overlaySource");
function overlayDataResponse(body, cors, cacheState) {
  const headers = {
    ...cors,
    "Content-Type": "application/json",
    "Cache-Control": cacheState === "STALE" ? "no-store" : `public, max-age=${OSM_EDGE_TTL}`,
    "X-Overlay-Cache": cacheState
  };
  const source = overlaySource(body);
  if (source) headers["X-Overlay-Source"] = source;
  return new Response(body, { status: 200, headers });
}
__name(overlayDataResponse, "overlayDataResponse");
__name2(overlayDataResponse, "overlayDataResponse");
function edgeCacheResponse(body, cors, fetchedAt) {
  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${OSM_EDGE_TTL}`,
      "X-Overlay-Cache": "HIT",
      "X-Overlay-Fetched-At": String(fetchedAt)
    }
  });
}
__name(edgeCacheResponse, "edgeCacheResponse");
__name2(edgeCacheResponse, "edgeCacheResponse");
function serveOutcome(outcome, cors, cacheState) {
  if (outcome.kind === "data") return overlayDataResponse(outcome.body, cors, cacheState);
  if (outcome.kind === "empty") {
    return golfJson(404, { error: "no_overlay" }, cors, {
      "X-Overlay-Cache": cacheState
    });
  }
  return golfJson(503, { error: "upstream_busy" }, cors, {
    "Retry-After": outcome.retryAfter || "30"
  });
}
__name(serveOutcome, "serveOutcome");
__name2(serveOutcome, "serveOutcome");
function presentedState(outcome, waiter) {
  const state = outcome.cacheState;
  if (waiter && state === "MISS") return "HIT";
  return state;
}
__name(presentedState, "presentedState");
__name2(presentedState, "presentedState");
async function callOverpass(url, query, timeoutMs) {
  if (timeoutMs < 200) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": OVERPASS_USER_AGENT
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal
    });
    return { response, status: response.status, text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
__name(callOverpass, "callOverpass");
__name2(callOverpass, "callOverpass");
function overpassIsDown(result) {
  if (!result) return true;
  if (result.status === 429) return true;
  return result.status >= 500 && result.status <= 599;
}
__name(overpassIsDown, "overpassIsDown");
__name2(overpassIsDown, "overpassIsDown");
function classifyAttempt(result) {
  if (!result || result.status !== 200) return null;
  let payload;
  try {
    payload = JSON.parse(result.text);
  } catch {
    return null;
  }
  if (remarkIsRuntimeFailure(payload)) return null;
  if (payloadHasGolf(payload)) return { kind: "data", body: result.text };
  return { kind: "empty" };
}
__name(classifyAttempt, "classifyAttempt");
__name2(classifyAttempt, "classifyAttempt");
function decodeXml(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|lt|gt|quot|apos|amp);/g, (all, dec, hex) => {
    if (dec || hex) {
      const code = dec ? Number(dec) : parseInt(hex, 16);
      if (!Number.isInteger(code) || code < 0 || code > 1114111) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    if (all === "&lt;") return "<";
    if (all === "&gt;") return ">";
    if (all === "&quot;") return '"';
    if (all === "&apos;") return "'";
    return "&";
  });
}
__name(decodeXml, "decodeXml");
__name2(decodeXml, "decodeXml");
function xmlAttrs(source) {
  const attrs = {};
  if (!source) return attrs;
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while (match = re.exec(source)) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}
__name(xmlAttrs, "xmlAttrs");
__name2(xmlAttrs, "xmlAttrs");
function parseOsmId(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}
__name(parseOsmId, "parseOsmId");
__name2(parseOsmId, "parseOsmId");
function parseOsmVersion(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}
__name(parseOsmVersion, "parseOsmVersion");
__name2(parseOsmVersion, "parseOsmVersion");
function parseXmlCoord(raw, min, max) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}
__name(parseXmlCoord, "parseXmlCoord");
__name2(parseXmlCoord, "parseXmlCoord");
function xmlChildAttrs(inner, name) {
  const found = [];
  if (!inner) return found;
  const re = new RegExp(`<${name}\\b([^>]*?)\\/?>`, "g");
  let match;
  while (match = re.exec(inner)) found.push(xmlAttrs(match[1]));
  return found;
}
__name(xmlChildAttrs, "xmlChildAttrs");
__name2(xmlChildAttrs, "xmlChildAttrs");
function xmlTags(inner) {
  const tags = {};
  for (const attrs of xmlChildAttrs(inner, "tag")) {
    if (!attrs.k) continue;
    tags[attrs.k] = attrs.v ?? "";
  }
  return tags;
}
__name(xmlTags, "xmlTags");
__name2(xmlTags, "xmlTags");
function xmlNdRefs(inner) {
  const refs = [];
  for (const attrs of xmlChildAttrs(inner, "nd")) {
    const id = parseOsmId(attrs.ref);
    if (id != null) refs.push(id);
  }
  return refs;
}
__name(xmlNdRefs, "xmlNdRefs");
__name2(xmlNdRefs, "xmlNdRefs");
function xmlMembers(inner) {
  const members = [];
  for (const attrs of xmlChildAttrs(inner, "member")) {
    if (attrs.type !== "node" && attrs.type !== "way" && attrs.type !== "relation") continue;
    const ref = parseOsmId(attrs.ref);
    if (ref == null) continue;
    members.push({ type: attrs.type, ref, role: attrs.role ?? "" });
  }
  return members;
}
__name(xmlMembers, "xmlMembers");
__name2(xmlMembers, "xmlMembers");
function parseOsmMapXml(xml) {
  const nodes = /* @__PURE__ */ new Map();
  const ways = [];
  const relations = [];
  if (typeof xml !== "string" || xml.length === 0) return { nodes, ways, relations };
  const re = /<(node|way|relation)\b([^>]*?)(\/?)>/g;
  let match;
  while (match = re.exec(xml)) {
    const kind = match[1];
    const attrs = xmlAttrs(match[2]);
    let inner = "";
    if (match[3] !== "/") {
      const close = `</${kind}>`;
      const end = xml.indexOf(close, re.lastIndex);
      if (end < 0) break;
      inner = xml.slice(re.lastIndex, end);
      re.lastIndex = end + close.length;
    }
    if (attrs.visible === "false") continue;
    const id = parseOsmId(attrs.id);
    if (id == null) continue;
    const version = parseOsmVersion(attrs.version);
    if (kind === "node") {
      const lat = parseXmlCoord(attrs.lat, -90, 90);
      const lon = parseXmlCoord(attrs.lon, -180, 180);
      if (lat == null || lon == null) continue;
      nodes.set(id, { lat, lon });
      continue;
    }
    const tags = xmlTags(inner);
    if (kind === "way") ways.push({ id, version, refs: xmlNdRefs(inner), tags });
    else relations.push({ id, version, members: xmlMembers(inner), tags });
  }
  return { nodes, ways, relations };
}
__name(parseOsmMapXml, "parseOsmMapXml");
__name2(parseOsmMapXml, "parseOsmMapXml");
function geometryBounds(points) {
  let minlat = Infinity;
  let minlon = Infinity;
  let maxlat = -Infinity;
  let maxlon = -Infinity;
  for (const point of points) {
    if (point.lat < minlat) minlat = point.lat;
    if (point.lon < minlon) minlon = point.lon;
    if (point.lat > maxlat) maxlat = point.lat;
    if (point.lon > maxlon) maxlon = point.lon;
  }
  if (!Number.isFinite(minlat)) return null;
  return { minlat, minlon, maxlat, maxlon };
}
__name(geometryBounds, "geometryBounds");
__name2(geometryBounds, "geometryBounds");
function wayGeometry(refs, nodes) {
  const nodeIds = [];
  const geometry = [];
  for (const ref of refs) {
    const node = nodes.get(ref);
    if (!node) continue;
    nodeIds.push(ref);
    geometry.push({ lat: node.lat, lon: node.lon });
  }
  return { nodeIds, geometry };
}
__name(wayGeometry, "wayGeometry");
__name2(wayGeometry, "wayGeometry");
function withVersion(element, version) {
  if (version == null) return element;
  const ordered = {};
  for (const [key, value] of Object.entries(element)) {
    ordered[key] = value;
    if (key === "id") ordered.version = version;
  }
  if (!Object.prototype.hasOwnProperty.call(ordered, "version")) ordered.version = version;
  return ordered;
}
__name(withVersion, "withVersion");
__name2(withVersion, "withVersion");
function wayToElement(way, nodes) {
  if (!way.tags || !OSM_WAY_GOLF.has(way.tags.golf)) return null;
  const { nodeIds, geometry } = wayGeometry(way.refs, nodes);
  if (geometry.length === 0) return null;
  const element = {
    type: "way",
    id: way.id,
    nodes: nodeIds,
    geometry,
    tags: way.tags
  };
  const bounds = geometryBounds(geometry);
  if (bounds) element.bounds = bounds;
  return withVersion(element, way.version);
}
__name(wayToElement, "wayToElement");
__name2(wayToElement, "wayToElement");
function relationToElement(relation, waysById, nodes) {
  if (!relation.tags || !OSM_RELATION_GOLF.has(relation.tags.golf)) return null;
  const members = [];
  const points = [];
  for (const member of relation.members) {
    const entry = { type: member.type, ref: member.ref, role: member.role };
    if (member.type === "way") {
      const way = waysById.get(member.ref);
      if (way) {
        const { geometry } = wayGeometry(way.refs, nodes);
        if (geometry.length > 0) {
          entry.geometry = geometry;
          points.push(...geometry);
        }
      }
    } else if (member.type === "node") {
      const node = nodes.get(member.ref);
      if (node) {
        entry.lat = node.lat;
        entry.lon = node.lon;
        points.push(node);
      }
    }
    members.push(entry);
  }
  const element = {
    type: "relation",
    id: relation.id,
    members,
    tags: relation.tags
  };
  const bounds = geometryBounds(points);
  if (bounds) element.bounds = bounds;
  return withVersion(element, relation.version);
}
__name(relationToElement, "relationToElement");
__name2(relationToElement, "relationToElement");
function compareOverlayElements(a, b) {
  if (a.type !== b.type) return a.type === "way" ? -1 : 1;
  return a.id - b.id;
}
__name(compareOverlayElements, "compareOverlayElements");
__name2(compareOverlayElements, "compareOverlayElements");
function osmMapToElements(xml) {
  const { nodes, ways, relations } = parseOsmMapXml(xml);
  const waysById = /* @__PURE__ */ new Map();
  for (const way of ways) waysById.set(way.id, way);
  const elements = [];
  for (const way of ways) {
    const element = wayToElement(way, nodes);
    if (element) elements.push(element);
  }
  for (const relation of relations) {
    const element = relationToElement(relation, waysById, nodes);
    if (element) elements.push(element);
  }
  elements.sort(compareOverlayElements);
  return elements;
}
__name(osmMapToElements, "osmMapToElements");
__name2(osmMapToElements, "osmMapToElements");
function elementGeometryCount(element) {
  if (Array.isArray(element.geometry)) return element.geometry.length;
  if (!Array.isArray(element.members)) return 0;
  let count = 0;
  for (const member of element.members) {
    if (Array.isArray(member.geometry)) count += member.geometry.length;
    else if (Number.isFinite(member.lat) && Number.isFinite(member.lon)) count += 1;
  }
  return count;
}
__name(elementGeometryCount, "elementGeometryCount");
__name2(elementGeometryCount, "elementGeometryCount");
function mergeElement(merged, element) {
  const key = `${element.type}:${element.id}`;
  const prev = merged.get(key);
  if (!prev || elementGeometryCount(element) > elementGeometryCount(prev)) merged.set(key, element);
}
__name(mergeElement, "mergeElement");
__name2(mergeElement, "mergeElement");
function osmApiDocument(elements) {
  return JSON.stringify({
    version: 0.6,
    generator: "osm-api",
    elements,
    osm3s: {
      copyright: "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL."
    }
  });
}
__name(osmApiDocument, "osmApiDocument");
__name2(osmApiDocument, "osmApiDocument");
function formatBboxCoord(value) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(7));
  if (rounded === 0) return "0";
  return String(rounded);
}
__name(formatBboxCoord, "formatBboxCoord");
__name2(formatBboxCoord, "formatBboxCoord");
function formatBboxParam(bbox) {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map(formatBboxCoord).join(",");
}
__name(formatBboxParam, "formatBboxParam");
__name2(formatBboxParam, "formatBboxParam");
function coveringBbox(lat, lng, radiusM) {
  const latDelta = radiusM / 111320;
  const cos = Math.cos(lat * Math.PI / 180);
  const lngDelta = radiusM / Math.max(111320 * Math.abs(cos), 1);
  return {
    west: Math.max(-180, lng - lngDelta),
    south: Math.max(-90, lat - latDelta),
    east: Math.min(180, lng + lngDelta),
    north: Math.min(90, lat + latDelta)
  };
}
__name(coveringBbox, "coveringBbox");
__name2(coveringBbox, "coveringBbox");
function splitBbox(bbox) {
  const midLat = (bbox.south + bbox.north) / 2;
  const midLng = (bbox.west + bbox.east) / 2;
  if (!(midLat > bbox.south && midLat < bbox.north && midLng > bbox.west && midLng < bbox.east)) return [];
  return [
    { west: bbox.west, south: bbox.south, east: midLng, north: midLat },
    { west: midLng, south: bbox.south, east: bbox.east, north: midLat },
    { west: bbox.west, south: midLat, east: midLng, north: bbox.north },
    { west: midLng, south: midLat, east: bbox.east, north: bbox.north }
  ];
}
__name(splitBbox, "splitBbox");
__name2(splitBbox, "splitBbox");
function tooManyNodes(result) {
  return Boolean(result && result.status === 400 && typeof result.text === "string" && /too many nodes/i.test(result.text));
}
__name(tooManyNodes, "tooManyNodes");
__name2(tooManyNodes, "tooManyNodes");
function osmIsLimited(result) {
  return Boolean(result && (result.status === 509 || result.status === 429));
}
__name(osmIsLimited, "osmIsLimited");
__name2(osmIsLimited, "osmIsLimited");
async function callOsmMap(bbox, timeoutMs) {
  if (timeoutMs < 200) return null;
  if (!(bbox.west < bbox.east && bbox.south < bbox.north)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OSM_API_MAP}?bbox=${formatBboxParam(bbox)}`, {
      method: "GET",
      headers: {
        Accept: "application/xml, text/xml",
        "User-Agent": OVERPASS_USER_AGENT
      },
      signal: controller.signal
    });
    return { response, status: response.status, text: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
__name(callOsmMap, "callOsmMap");
__name2(callOsmMap, "callOsmMap");
function mapCallBudget(deadline) {
  return Math.min(OSM_PRIMARY_MS, deadline - Date.now());
}
__name(mapCallBudget, "mapCallBudget");
__name2(mapCallBudget, "mapCallBudget");
function elementsHaveGolf(elements) {
  return elements.some((element) => element && element.tags && typeof element.tags.golf === "string" && element.tags.golf !== "");
}
__name(elementsHaveGolf, "elementsHaveGolf");
__name2(elementsHaveGolf, "elementsHaveGolf");
async function fetchOsmApiOverlay(lat, lng, radius) {
  const deadline = Date.now() + OSM_BUDGET_MS;
  const bbox = coveringBbox(lat, lng, radius);
  const first = await callOsmMap(bbox, mapCallBudget(deadline));
  if (osmIsLimited(first)) {
    const header = first.response ? first.response.headers.get("Retry-After") : null;
    return { kind: "limited", retryAfter: cleanRetryAfter(header) };
  }
  if (first && first.status === 200) {
    const elements2 = osmMapToElements(first.text);
    if (elementsHaveGolf(elements2)) return { kind: "data", body: osmApiDocument(elements2) };
    return { kind: "miss" };
  }
  if (!tooManyNodes(first)) return { kind: "miss" };
  const merged = /* @__PURE__ */ new Map();
  const quadrants = splitBbox(bbox).slice(0, OSM_API_MAX_EXTRA);
  for (const quad of quadrants) {
    const result = await callOsmMap(quad, mapCallBudget(deadline));
    if (osmIsLimited(result)) {
      const header = result.response ? result.response.headers.get("Retry-After") : null;
      return { kind: "limited", retryAfter: cleanRetryAfter(header) };
    }
    if (!result || result.status !== 200) continue;
    for (const element of osmMapToElements(result.text)) mergeElement(merged, element);
  }
  const elements = [...merged.values()].sort(compareOverlayElements);
  if (!elementsHaveGolf(elements)) return { kind: "miss" };
  return { kind: "data", body: osmApiDocument(elements) };
}
__name(fetchOsmApiOverlay, "fetchOsmApiOverlay");
__name2(fetchOsmApiOverlay, "fetchOsmApiOverlay");
async function fetchOverlayUpstream(query, backup) {
  const deadline = Date.now() + OSM_BUDGET_MS;
  const primaryBudget = Math.min(OSM_PRIMARY_MS, Math.max(0, deadline - Date.now()));
  const first = await callOverpass(OVERPASS_PRIMARY, query, primaryBudget);
  const firstHit = classifyAttempt(first);
  if (firstHit) return firstHit;
  const firstRetry = first && first.response ? first.response.headers.get("Retry-After") : null;
  const useMirror = overpassIsDown(first);
  const pause = Math.min(OSM_BACKOFF_MS, Math.max(0, deadline - Date.now() - 500));
  if (pause > 0) await sleep(pause);
  const remaining = deadline - Date.now();
  if (remaining < 500) {
    return { kind: "busy", retryAfter: cleanRetryAfter(firstRetry) || "30" };
  }
  const secondUrl = useMirror ? OVERPASS_MIRROR : OVERPASS_PRIMARY;
  const second = await callOverpass(secondUrl, query, remaining);
  const secondHit = classifyAttempt(second);
  if (secondHit) return secondHit;
  const secondRetry = second && second.response ? second.response.headers.get("Retry-After") : null;
  const overpassRetry = cleanRetryAfter(secondRetry) || cleanRetryAfter(firstRetry) || "30";
  if (backup && useMirror && overpassIsDown(first) && overpassIsDown(second) && Number.isFinite(backup.lat) && Number.isFinite(backup.lng) && Number.isFinite(backup.radius)) {
    try {
      const fromApi = await fetchOsmApiOverlay(backup.lat, backup.lng, backup.radius);
      if (fromApi.kind === "data") return { kind: "data", body: fromApi.body };
      if (fromApi.kind === "limited") {
        return { kind: "busy", retryAfter: fromApi.retryAfter || overpassRetry };
      }
    } catch {
    }
  }
  return { kind: "busy", retryAfter: overpassRetry };
}
__name(fetchOverlayUpstream, "fetchOverlayUpstream");
__name2(fetchOverlayUpstream, "fetchOverlayUpstream");
async function indexSavedOverlay(boards, lat, lng, radius) {
  const center = savedCenter(lat, lng);
  const key = indexKeyFor(center.lat, center.lng);
  let entries = [];
  const raw = await boards.get(key);
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.filter(validIndexEntry);
    } catch {
      entries = [];
    }
  }
  const exists = entries.some((entry) => entry.lat === center.lat && entry.lng === center.lng && entry.radius === radius);
  if (!exists) {
    entries.push({ lat: center.lat, lng: center.lng, radius });
    if (entries.length > 32) entries = entries.slice(entries.length - 32);
  }
  await boards.put(key, JSON.stringify(entries), { expirationTtl: OSM_KV_TTL });
}
__name(indexSavedOverlay, "indexSavedOverlay");
__name2(indexSavedOverlay, "indexSavedOverlay");
async function rememberEdge(cache, ctx, edgeKey, response) {
  if (!cache || typeof cache.put !== "function") return;
  const put = Promise.resolve().then(() => cache.put(edgeKey, response)).catch(() => {
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
  else await put;
}
__name(rememberEdge, "rememberEdge");
__name2(rememberEdge, "rememberEdge");
function isFresh(fetchedAt, now = Date.now()) {
  return Number.isFinite(fetchedAt) && fetchedAt > 0 && now - fetchedAt < OSM_FRESH_MS;
}
__name(isFresh, "isFresh");
__name2(isFresh, "isFresh");
function positivePutOptions(fetchedAt) {
  return { expirationTtl: OSM_KV_TTL, metadata: { fetchedAt } };
}
__name(positivePutOptions, "positivePutOptions");
__name2(positivePutOptions, "positivePutOptions");
async function readPositive(boards, dataKey) {
  if (typeof boards.getWithMetadata === "function") {
    const row = await boards.getWithMetadata(dataKey);
    if (!row || row.value == null) return null;
    const body2 = storedOverlay(row.value);
    if (!body2) return null;
    const fetchedAt = row.metadata && Number(row.metadata.fetchedAt);
    return { body: body2, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
  }
  const body = storedOverlay(await boards.get(dataKey));
  if (!body) return null;
  return { body, fetchedAt: 0 };
}
__name(readPositive, "readPositive");
__name2(readPositive, "readPositive");
async function refreshStoredOverlay({ boards, cache, edgeKey, dataKey, query, cors, lat, lng, radius }) {
  try {
    const upstream = await fetchOverlayUpstream(query);
    if (upstream.kind !== "data") return null;
    const fetchedAt = Date.now();
    await boards.put(dataKey, upstream.body, positivePutOptions(fetchedAt));
    await indexSavedOverlay(boards, lat, lng, radius).catch(() => {
    });
    if (cache && typeof cache.put === "function") {
      await Promise.resolve(cache.put(edgeKey, edgeCacheResponse(upstream.body, cors, fetchedAt))).catch(() => {
      });
    }
    return { body: upstream.body, fetchedAt };
  } catch {
    return null;
  }
}
__name(refreshStoredOverlay, "refreshStoredOverlay");
__name2(refreshStoredOverlay, "refreshStoredOverlay");
async function serveStored({
  existing,
  boards,
  cache,
  ctx,
  edgeKey,
  dataKey,
  refreshKey,
  query,
  cors,
  lat,
  lng,
  radius,
  freshState,
  staleState,
  refreshedState
}) {
  if (isFresh(existing.fetchedAt)) {
    await rememberEdge(cache, ctx, edgeKey, edgeCacheResponse(existing.body, cors, existing.fetchedAt));
    return { kind: "data", body: existing.body, cacheState: freshState };
  }
  if (await boards.get(refreshKey) != null) {
    return { kind: "data", body: existing.body, cacheState: staleState };
  }
  await boards.put(refreshKey, "1", { expirationTtl: OSM_REFRESH_TTL });
  const refresh = refreshStoredOverlay({ boards, cache, edgeKey, dataKey, query, cors, lat, lng, radius });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(refresh);
    return { kind: "data", body: existing.body, cacheState: staleState };
  }
  const updated = await refresh;
  if (updated) return { kind: "data", body: updated.body, cacheState: refreshedState };
  return { kind: "data", body: existing.body, cacheState: staleState };
}
__name(serveStored, "serveStored");
__name2(serveStored, "serveStored");
async function adoptLegacy(boards, courseId, lat, lng, radius, dataKey) {
  const legacyKey = `osm:v1:${courseId}:${overlayLocationKey(lat, lng, radius)}`;
  const legacy = await readPositive(boards, legacyKey);
  if (!legacy) return null;
  if (legacy.fetchedAt > 0) {
    await boards.put(dataKey, legacy.body, positivePutOptions(legacy.fetchedAt));
  } else {
    await boards.put(dataKey, legacy.body, { expirationTtl: OSM_KV_TTL });
  }
  await indexSavedOverlay(boards, lat, lng, radius).catch(() => {
  });
  return legacy;
}
__name(adoptLegacy, "adoptLegacy");
__name2(adoptLegacy, "adoptLegacy");
async function findNearbyOverlay(boards, lat, lng, radius) {
  const exact = savedCenter(lat, lng);
  const cells = cellsAround(lat, lng);
  const lists = await Promise.all(cells.map(async (cell) => {
    const raw = await boards.get(`osm:v1:index:${cell}`);
    if (typeof raw !== "string" || !raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(validIndexEntry) : [];
    } catch {
      return [];
    }
  }));
  const ranked = [];
  for (const entry of lists.flat()) {
    if (entry.radius !== radius) continue;
    if (entry.lat === exact.lat && entry.lng === exact.lng) continue;
    const dist = distanceMeters(lat, lng, entry.lat, entry.lng);
    if (dist > OSM_NEAR_M) continue;
    const token = overlayLocationKey(entry.lat, entry.lng, entry.radius);
    ranked.push({ entry, dist, token });
  }
  ranked.sort((a, b) => a.dist - b.dist || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  for (const item of ranked) {
    const dataKey = `osm:v1:${item.token}`;
    const existing = await readPositive(boards, dataKey);
    if (!existing) continue;
    return {
      ...existing,
      dataKey,
      refreshKey: `osm:v1:refreshing:${item.token}`,
      lat: item.entry.lat,
      lng: item.entry.lng,
      radius: item.entry.radius
    };
  }
  return null;
}
__name(findNearbyOverlay, "findNearbyOverlay");
__name2(findNearbyOverlay, "findNearbyOverlay");
async function loadOverlay({
  env,
  ctx,
  cache,
  edgeKey,
  dataKey,
  noneKey,
  refreshKey,
  query,
  cors,
  courseId,
  lat,
  lng,
  radius
}) {
  if (cache && typeof cache.match === "function") {
    const cached = await cache.match(edgeKey);
    if (cached && cached.status === 200) {
      const fetchedAt = Number(cached.headers.get("X-Overlay-Fetched-At"));
      if (isFresh(fetchedAt)) {
        const body = storedOverlay(await cached.text());
        if (body) return { kind: "data", body, cacheState: "HIT" };
      }
    }
  }
  const boards = env.BOARDS;
  const storedArgs = { boards, cache, ctx, edgeKey, cors, lat, lng, radius };
  let existing = await readPositive(boards, dataKey);
  if (!existing) existing = await adoptLegacy(boards, courseId, lat, lng, radius, dataKey);
  if (existing) {
    return serveStored({
      ...storedArgs,
      existing,
      dataKey,
      refreshKey,
      query,
      freshState: "HIT",
      staleState: "STALE",
      refreshedState: "REFRESHED"
    });
  }
  const nearby = await findNearbyOverlay(boards, lat, lng, radius).catch(() => null);
  if (nearby) {
    return serveStored({
      ...storedArgs,
      existing: nearby,
      dataKey: nearby.dataKey,
      refreshKey: nearby.refreshKey,
      query: overpassQuery(nearby.lat, nearby.lng, nearby.radius),
      lat: nearby.lat,
      lng: nearby.lng,
      radius: nearby.radius,
      freshState: "HIT-NEAR",
      staleState: "HIT-NEAR",
      refreshedState: "HIT-NEAR"
    });
  }
  if (await boards.get(noneKey) != null) return { kind: "empty", cacheState: "HIT" };
  const upstream = await fetchOverlayUpstream(query, { lat, lng, radius });
  if (upstream.kind === "data") {
    const fetchedAt = Date.now();
    await boards.put(dataKey, upstream.body, positivePutOptions(fetchedAt));
    await indexSavedOverlay(boards, lat, lng, radius).catch(() => {
    });
    await rememberEdge(cache, ctx, edgeKey, edgeCacheResponse(upstream.body, cors, fetchedAt));
    return { kind: "data", body: upstream.body, cacheState: "MISS" };
  }
  if (upstream.kind === "empty") {
    await boards.put(noneKey, "1", { expirationTtl: OSM_NEGATIVE_TTL });
    return { kind: "empty", cacheState: "MISS" };
  }
  return { kind: "busy", retryAfter: upstream.retryAfter || "30" };
}
__name(loadOverlay, "loadOverlay");
__name2(loadOverlay, "loadOverlay");
async function handleOsmOverlay(request, env, ctx, cors) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/osm/")) return null;
  if (url.pathname !== "/osm/v1/overlay") return golfJson(404, { error: "unknown_route" }, cors);
  if (request.method !== "GET") return golfJson(405, { error: "method_not_allowed" }, cors);
  const params = parseOverlayRequest(url);
  if (!params) return golfJson(400, { error: "bad_request" }, cors);
  const locationKey = overlayLocationKey(params.lat, params.lng, params.radius);
  const dataKey = `osm:v1:${locationKey}`;
  const noneKey = `osm:v1:none:${locationKey}`;
  const refreshKey = `osm:v1:refreshing:${locationKey}`;
  const boards = env && env.BOARDS;
  const boardsReady = Boolean(boards && typeof boards.get === "function" && typeof boards.put === "function");
  if (!boardsReady) return golfJson(503, { error: "boards_not_configured" }, cors);
  const pending = osmInflight.get(dataKey);
  if (pending) {
    const outcome = await pending;
    return serveOutcome(outcome, cors, presentedState(outcome, true));
  }
  const cache = typeof caches !== "undefined" && caches ? caches.default : null;
  const edgeKey = new Request(url.toString(), { method: "GET" });
  const run = loadOverlay({
    env,
    ctx,
    cache,
    edgeKey,
    dataKey,
    noneKey,
    refreshKey,
    query: overpassQuery(params.lat, params.lng, params.radius),
    cors,
    courseId: params.courseId,
    lat: params.lat,
    lng: params.lng,
    radius: params.radius
  }).catch(() => ({ kind: "busy", retryAfter: "30" }));
  osmInflight.set(dataKey, run);
  try {
    const outcome = await run;
    return serveOutcome(outcome, cors, presentedState(outcome, false));
  } finally {
    if (osmInflight.get(dataKey) === run) osmInflight.delete(dataKey);
  }
}
__name(handleOsmOverlay, "handleOsmOverlay");
__name2(handleOsmOverlay, "handleOsmOverlay");
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
__name(finiteNumber, "finiteNumber");
__name2(finiteNumber, "finiteNumber");
function hasLatLng(point) {
  return isPlainObject(point) && finiteNumber(point.lat) && finiteNumber(point.lng);
}
__name(hasLatLng, "hasLatLng");
__name2(hasLatLng, "hasLatLng");
function holeHasTeeAndGreen(hole) {
  return isPlainObject(hole) && hasLatLng(hole.tee) && hasLatLng(hole.green);
}
__name(holeHasTeeAndGreen, "holeHasTeeAndGreen");
__name2(holeHasTeeAndGreen, "holeHasTeeAndGreen");
function holeNumber(hole) {
  if (!isPlainObject(hole)) return null;
  const raw = hole.hole;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}
__name(holeNumber, "holeNumber");
__name2(holeNumber, "holeNumber");
function parsePaintRecord(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}
__name(parsePaintRecord, "parsePaintRecord");
__name2(parsePaintRecord, "parsePaintRecord");
function emptyPaintField(value) {
  if (value == null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}
__name(emptyPaintField, "emptyPaintField");
__name2(emptyPaintField, "emptyPaintField");
function numericNumHoles(record) {
  if (!isPlainObject(record) || record.numHoles == null || record.numHoles === "") return null;
  const n = typeof record.numHoles === "number" ? record.numHoles : Number(String(record.numHoles).trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
__name(numericNumHoles, "numericNumHoles");
__name2(numericNumHoles, "numericNumHoles");
function sameNumHoles(a, b) {
  const left = numericNumHoles(a);
  const right = numericNumHoles(b);
  return left != null && left === right;
}
__name(sameNumHoles, "sameNumHoles");
__name2(sameNumHoles, "sameNumHoles");
function indexPaintHoles(holes) {
  const map = /* @__PURE__ */ new Map();
  const order = [];
  if (!Array.isArray(holes)) return { map, order };
  for (const hole of holes) {
    const n = holeNumber(hole);
    if (n == null) continue;
    const prev = map.get(n);
    if (!prev) {
      map.set(n, hole);
      order.push(n);
      continue;
    }
    if (!holeHasTeeAndGreen(prev) && holeHasTeeAndGreen(hole)) map.set(n, hole);
  }
  return { map, order };
}
__name(indexPaintHoles, "indexPaintHoles");
__name2(indexPaintHoles, "indexPaintHoles");
function completeHoleCount(holes) {
  const { map } = indexPaintHoles(holes);
  let count = 0;
  for (const hole of map.values()) {
    if (holeHasTeeAndGreen(hole)) count += 1;
  }
  return count;
}
__name(completeHoleCount, "completeHoleCount");
__name2(completeHoleCount, "completeHoleCount");
function paintHasGaps(record) {
  const numHoles = numericNumHoles(record);
  if (numHoles == null) return false;
  return completeHoleCount(record.holes) < numHoles;
}
__name(paintHasGaps, "paintHasGaps");
__name2(paintHasGaps, "paintHasGaps");
function unionPaintAliases(existing, incoming) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const list of [existing, incoming]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== "string") continue;
      const alias = item.trim();
      if (!alias || alias.length > 180 || seen.has(alias)) continue;
      seen.add(alias);
      out.push(alias);
    }
  }
  return out;
}
__name(unionPaintAliases, "unionPaintAliases");
__name2(unionPaintAliases, "unionPaintAliases");
function paintAliasKeys(record, selfKey) {
  const keys = [];
  const seen = /* @__PURE__ */ new Set();
  if (!Array.isArray(record.aliases)) return keys;
  for (const item of record.aliases) {
    if (typeof item !== "string") continue;
    const alias = item.trim();
    if (!alias || alias.length > 180 || alias === selfKey || seen.has(alias)) continue;
    if (!isPaintKey(alias) || isReservedBoardKey(alias)) continue;
    seen.add(alias);
    keys.push(alias);
  }
  return keys;
}
__name(paintAliasKeys, "paintAliasKeys");
__name2(paintAliasKeys, "paintAliasKeys");
function mergePaintHoles(baseHoles, donorHoles) {
  const { map, order } = indexPaintHoles(baseHoles);
  const donor = indexPaintHoles(donorHoles);
  let changed = false;
  for (const n of donor.order) {
    const incomingHole = donor.map.get(n);
    const current = map.get(n);
    if (!current) {
      map.set(n, incomingHole);
      order.push(n);
      changed = true;
      continue;
    }
    if (holeHasTeeAndGreen(current)) continue;
    if (JSON.stringify(current) === JSON.stringify(incomingHole)) continue;
    map.set(n, incomingHole);
    changed = true;
  }
  const holes = order.map((n) => map.get(n));
  if (Array.isArray(baseHoles)) {
    for (const hole of baseHoles) {
      if (isPlainObject(hole) && holeNumber(hole) == null) holes.push(hole);
    }
  }
  return { holes, changed };
}
__name(mergePaintHoles, "mergePaintHoles");
__name2(mergePaintHoles, "mergePaintHoles");
function mergePaintRecords(existing, incoming) {
  const base = isPlainObject(existing) ? existing : {};
  const next = isPlainObject(incoming) ? incoming : {};
  const merged = { ...base };
  let fieldsChanged = false;
  for (const [field, value] of Object.entries(next)) {
    if (field === "holes" || field === "aliases") continue;
    if (emptyPaintField(merged[field]) && !emptyPaintField(value)) {
      merged[field] = value;
      fieldsChanged = true;
    }
  }
  const aliases = unionPaintAliases(base.aliases, next.aliases);
  const previousAliases = unionPaintAliases(base.aliases, []);
  const aliasesChanged = aliases.length !== previousAliases.length || aliases.some((alias, index) => alias !== previousAliases[index]);
  if (aliases.length > 0) merged.aliases = aliases;
  const holeMerge = mergePaintHoles(base.holes, next.holes);
  const beforeComplete = completeHoleCount(base.holes);
  const afterComplete = completeHoleCount(holeMerge.holes);
  const holesChanged = holeMerge.changed && afterComplete >= beforeComplete;
  if (holesChanged) merged.holes = holeMerge.holes;
  return {
    record: merged,
    added: fieldsChanged || aliasesChanged || holesChanged
  };
}
__name(mergePaintRecords, "mergePaintRecords");
__name2(mergePaintRecords, "mergePaintRecords");
function paintReplaceRequested(request) {
  const raw = request.headers.get("X-Paint-Replace");
  return typeof raw === "string" && raw.trim() === "1";
}
__name(paintReplaceRequested, "paintReplaceRequested");
__name2(paintReplaceRequested, "paintReplaceRequested");
function paintUnchangedResponse(cors) {
  return new Response(JSON.stringify({ changed: false, message: "nothing changed" }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
__name(paintUnchangedResponse, "paintUnchangedResponse");
__name2(paintUnchangedResponse, "paintUnchangedResponse");
function paintStoredResponse(body, cors) {
  return new Response(body, {
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
__name(paintStoredResponse, "paintStoredResponse");
__name2(paintStoredResponse, "paintStoredResponse");
function coursePointSame(a, b) {
  if (!paintPoint(a) && !paintPoint(b)) return true;
  if (!paintPoint(a) || !paintPoint(b)) return false;
  return a.lat === b.lat && a.lng === b.lng;
}
__name(coursePointSame, "coursePointSame");
__name2(coursePointSame, "coursePointSame");
function isHandPaintSource(source) {
  if (source == null || source === "") return true;
  if (source === "golfer_consensus" || source === "osm" || source === "golfapi" || source === "gca") return false;
  return true;
}
__name(isHandPaintSource, "isHandPaintSource");
__name2(isHandPaintSource, "isHandPaintSource");
function commitCoursePointWrite(req) {
  const existing = req.existing ?? null;
  const proposed = req.proposed ?? null;
  const requestBody = req.requestBody ?? null;
  if (requestBody && Object.prototype.hasOwnProperty.call(requestBody, "stagedBy")) {
    console.error("course-point-write refused: staged-by-from-request");
    return { ok: false, status: 400, message: "staged-by-from-request" };
  }
  if (!existing || coursePointSame(existing, proposed)) return { ok: true, point: proposed };
  if (!isHandPaintSource(req.existingSource) && !req.requireApproval) return { ok: true, point: proposed };
  const identity = req.identity ?? { name: null, source: "none" };
  const message = !identity.name || identity.source === "none" ? "no-trustworthy-identity" : "hand-move-without-approval";
  console.error("course-point-write refused: " + message);
  return { ok: false, status: 400, message, point: existing };
}
__name(commitCoursePointWrite, "commitCoursePointWrite");
__name2(commitCoursePointWrite, "commitCoursePointWrite");
function paintHoleSource(hole, record) {
  if (hole && typeof hole.source === "string" && hole.source) return hole.source;
  if (record && typeof record.source === "string") return record.source;
  return null;
}
__name(paintHoleSource, "paintHoleSource");
__name2(paintHoleSource, "paintHoleSource");
function assertPaintHolesAllowed(existing, incoming, requestBody, writer) {
  const prior = /* @__PURE__ */ new Map();
  const next = /* @__PURE__ */ new Map();
  for (const h of existing && Array.isArray(existing.holes) ? existing.holes : []) {
    const n = holeNumber(h);
    if (n != null) prior.set(n, h);
  }
  for (const h of incoming && Array.isArray(incoming.holes) ? incoming.holes : []) {
    const n = holeNumber(h);
    if (n != null) next.set(n, h);
  }
  for (const n of new Set([...prior.keys(), ...next.keys()])) {
    const left = prior.get(n) || null;
    const right = next.get(n) || null;
    for (const role of ["tee", "green"]) {
      const verdict = commitCoursePointWrite({
        courseId: incoming && incoming.key || existing && existing.key || "",
        hole: n,
        role,
        existing: left && paintPoint(left[role]) ? left[role] : null,
        proposed: right && paintPoint(right[role]) ? right[role] : null,
        existingSource: paintHoleSource(left, existing),
        proposedSource: paintHoleSource(right, incoming),
        identity: { name: null, source: "none" },
        writer,
        requestBody
      });
      if (!verdict.ok) return { ...verdict, hole: n, role };
    }
  }
  return { ok: true };
}
__name(assertPaintHolesAllowed, "assertPaintHolesAllowed");
__name2(assertPaintHolesAllowed, "assertPaintHolesAllowed");
function paintRecordChokepoint(key, existing, incoming, requestBody, writer) {
  if (key.startsWith("name:")) return assertPaintHolesAllowed(existing, incoming, requestBody, writer);
  if (writer === "putPaintRecord") return assertPaintHolesAllowed(existing, incoming, incoming, "putPaintRecord");
  return assertPaintHolesAllowed(existing, incoming, requestBody, writer);
}
__name(paintRecordChokepoint, "paintRecordChokepoint");
__name2(paintRecordChokepoint, "paintRecordChokepoint");
async function paintKeysForSave(boards, urlKey, incoming) {
  const keys = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (key) => {
    if (typeof key !== "string") return;
    const alias = key.trim();
    if (!alias || seen.has(alias)) return;
    if (!isPaintKey(alias) || isReservedBoardKey(alias)) return;
    seen.add(alias);
    keys.push(alias);
  };
  push(urlKey);
  const queue = [urlKey];
  const consider = (record) => {
    if (!record || !Array.isArray(record.aliases)) return;
    for (const alias of record.aliases) {
      const before = keys.length;
      push(alias);
      if (keys.length !== before) queue.push(keys[keys.length - 1]);
    }
  };
  consider(incoming);
  for (let i = 0; i < queue.length; i++) {
    const raw = await boards.get(queue[i]);
    consider(parsePaintRecord(raw));
  }
  return keys;
}
__name(paintKeysForSave, "paintKeysForSave");
__name2(paintKeysForSave, "paintKeysForSave");
function shortCardBlocked(record) {
  const declared = numericNumHoles(record);
  if (declared != null && Array.isArray(record.holes) && record.holes.length < declared) return false;
  return false;
}
__name(shortCardBlocked, "shortCardBlocked");
__name2(shortCardBlocked, "shortCardBlocked");
function consensusUploads(env) {
  const raw = env && env.GOLFER_CONSENSUS_ENABLED;
  if (raw === true) return true;
  const text = String(raw ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}
__name(consensusUploads, "consensusUploads");
__name2(consensusUploads, "consensusUploads");
function sharedFillKind(source, env) {
  if (source === "osm" || source === "golfapi" || source === "gca") return "vendor";
  if (source === "golfer_consensus") return consensusUploads(env) ? "consensus" : "player";
  return "player";
}
__name(sharedFillKind, "sharedFillKind");
__name2(sharedFillKind, "sharedFillKind");
function mergePaintFill(base, incoming, env) {
  const baseHoles = Array.isArray(base.holes) ? base.holes : [];
  const incomingHoles = Array.isArray(incoming.holes) ? incoming.holes : [];
  const baseBy = /* @__PURE__ */ new Map();
  for (const hole of baseHoles) {
    const n = holeNumber(hole);
    if (n != null && !baseBy.has(n)) baseBy.set(n, hole);
  }
  let adding = false;
  for (const hole of incomingHoles) {
    const n = holeNumber(hole);
    if (n != null && !baseBy.has(n)) adding = true;
  }
  const holes = [];
  let changed = false;
  for (const hole of baseHoles) {
    const n = holeNumber(hole);
    const inc = n == null ? null : incomingHoles.find((row) => holeNumber(row) === n);
    if (adding && inc && JSON.stringify(inc) !== JSON.stringify(hole)) {
      holes.push(hole);
      continue;
    }
    if (!adding && inc && JSON.stringify(inc) !== JSON.stringify(hole)) {
      holes.push(inc);
      changed = true;
      continue;
    }
    holes.push(hole);
  }
  for (const hole of incomingHoles) {
    const n = holeNumber(hole);
    if (n == null || baseBy.has(n)) continue;
    const kind = sharedFillKind(paintHoleSource(hole, incoming), env);
    if (kind === "player") continue;
    holes.push(hole);
    changed = true;
  }
  holes.sort((a, b) => (holeNumber(a) || 0) - (holeNumber(b) || 0));
  return { holes, changed };
}
__name(mergePaintFill, "mergePaintFill");
__name2(mergePaintFill, "mergePaintFill");
function incomingForCheck(existing, incoming) {
  const incomingHoles = Array.isArray(incoming.holes) ? incoming.holes : [];
  const incomingBy = /* @__PURE__ */ new Map();
  for (const hole of incomingHoles) {
    const n = holeNumber(hole);
    if (n != null && !incomingBy.has(n)) incomingBy.set(n, hole);
  }
  const holes = [];
  const seen = /* @__PURE__ */ new Set();
  const existingHoles = existing && Array.isArray(existing.holes) ? existing.holes : [];
  for (const hole of existingHoles) {
    const n = holeNumber(hole);
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    holes.push(incomingBy.has(n) ? incomingBy.get(n) : hole);
  }
  for (const hole of incomingHoles) {
    const n = holeNumber(hole);
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    holes.push(hole);
  }
  return { ...incoming, holes };
}
__name(incomingForCheck, "incomingForCheck");
__name2(incomingForCheck, "incomingForCheck");
async function putPaintRecord(boards, key, body, ttl, request, cors, env) {
  const incoming = parsePaintRecord(body);
  if (!incoming) {
    console.error("course-point-write refused: unreadable-paint-replace");
    return golfJson(400, { error: "unreadable-paint-replace" }, cors);
  }
  if (Object.prototype.hasOwnProperty.call(incoming, "stagedBy")) {
    console.error("course-point-write refused: staged-by-from-request");
    return golfJson(400, { error: "staged-by-from-request" }, cors);
  }
  if (shortCardBlocked(incoming)) {
    console.error("course-point-write refused: short-card-blocked");
    return golfJson(400, { error: "short-card-blocked" }, cors);
  }
  const keys = await paintKeysForSave(boards, key, incoming);
  const existingByKey = /* @__PURE__ */ new Map();
  for (const paintKey of keys) {
    const raw = await boards.get(paintKey);
    const existing = raw ? parsePaintRecord(raw) : null;
    if (raw && !existing) {
      console.error("course-point-write refused: unreadable-paint-replace");
      return golfJson(400, { error: "unreadable-paint-replace" }, cors);
    }
    existingByKey.set(paintKey, existing);
    if (!existing) continue;
    const verdict = paintRecordChokepoint(paintKey, existing, incomingForCheck(existing, incoming), incoming, "putPaintRecord");
    if (!verdict.ok) {
      console.error("course-point-write refused: " + verdict.message);
      return golfJson(400, { error: verdict.message, hole: verdict.hole, role: verdict.role }, cors);
    }
  }
  const base = existingByKey.get(key) || [...existingByKey.values()].find(Boolean) || null;
  let holes = Array.isArray(incoming.holes) ? incoming.holes.slice() : [];
  let changed = true;
  if (base) {
    const merged = mergePaintFill(base, incoming, env);
    holes = merged.holes;
    changed = merged.changed;
  }
  if (!changed) {
    const raw = await boards.get(key);
    return paintStoredResponse(raw || body, cors);
  }
  const template = base ? { ...base, ...incoming, holes } : { ...incoming, holes };
  let storedBody = body;
  for (const paintKey of keys) {
    const record = { ...template, key: paintKey, aliases: keys.filter((item) => item !== paintKey) };
    const nextBody = JSON.stringify(record);
    await boards.put(paintKey, nextBody, { expirationTtl: ttl });
    if (paintKey === key) storedBody = nextBody;
  }
  return paintStoredResponse(storedBody, cors);
}
__name(putPaintRecord, "putPaintRecord");
__name2(putPaintRecord, "putPaintRecord");
async function paintGetBody(boards, key, raw) {
  const record = parsePaintRecord(raw);
  if (!record || !paintHasGaps(record)) return raw;
  const aliases = paintAliasKeys(record, key).slice(0, 3);
  if (aliases.length === 0) return raw;
  let current = record;
  let changed = false;
  for (const alias of aliases) {
    const other = parsePaintRecord(await boards.get(alias));
    if (!other || !sameNumHoles(current, other)) continue;
    const holeMerge = mergePaintHoles(current.holes, other.holes);
    if (!holeMerge.changed) continue;
    if (completeHoleCount(holeMerge.holes) < completeHoleCount(current.holes)) continue;
    current = { ...current, holes: holeMerge.holes };
    changed = true;
  }
  return changed ? JSON.stringify(current) : raw;
}
__name(paintGetBody, "paintGetBody");
__name2(paintGetBody, "paintGetBody");
var PAINT_GREEN_MAX_FROM_COURSE_M = 2e3;
var PAINT_PENDING_PREFIX = "v1:paint-pending:";
var PAINT_PENDING_TTL = 60 * 60 * 24 * 180;
var PAINT_RECORD_TTL = 60 * 60 * 24 * 365;
var PAINT_PROMOTE_PATH = "/v1/paint-pending/promote";
var PAINT_SOURCES = /* @__PURE__ */ new Set(["osm", "manual_verified", "gca", "golfapi"]);
var PAINT_COURSE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
var PAINT_GET_PER_MIN_DEFAULT = 120;
var PAINT_PUT_PER_MIN_DEFAULT = 20;
var paintRateWindows = /* @__PURE__ */ new Map();
function normalizePaintKeyPart(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
__name(normalizePaintKeyPart, "normalizePaintKeyPart");
function parsePaintKey(key) {
  if (typeof key !== "string") return { kind: "none" };
  if (key.startsWith("id:")) {
    return PAINT_COURSE_KEY_RE.test(key.slice(3)) ? { kind: "ok", key } : { kind: "bad" };
  }
  if (key.startsWith("name:")) {
    const parts = key.slice(5).split("|");
    if (parts.length !== 3) return { kind: "bad" };
    const [name, city, state] = parts;
    if (!name || name.length > 120 || city.length > 80 || state.length > 40) return { kind: "bad" };
    if (parts.some((part) => part !== normalizePaintKeyPart(part))) return { kind: "bad" };
    return { kind: "ok", key };
  }
  return { kind: "none" };
}
__name(parsePaintKey, "parsePaintKey");
function paintPoint(p) {
  return isPlainObject(p) && finiteNumber(p.lat) && finiteNumber(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}
__name(paintPoint, "paintPoint");
function paintDistanceM(a, b) {
  return distanceMeters(a.lat, a.lng, b.lat, b.lng);
}
__name(paintDistanceM, "paintDistanceM");
function paintMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
__name(paintMedian, "paintMedian");
function paintCentroid(record) {
  if (!isPlainObject(record) || !Array.isArray(record.holes)) return null;
  const pts = record.holes.flatMap((h) => isPlainObject(h) ? [h.tee, h.green] : []).filter(paintPoint);
  if (pts.length === 0) return null;
  return { lat: paintMedian(pts.map((p) => p.lat)), lng: paintMedian(pts.map((p) => p.lng)) };
}
__name(paintCentroid, "paintCentroid");
function pointFromFields(obj) {
  if (!isPlainObject(obj)) return null;
  const lat = Number(obj.latitude ?? obj.lat);
  const lng = Number(obj.longitude ?? obj.lng ?? obj.lon);
  if (obj.latitude == null && obj.lat == null || obj.longitude == null && obj.lng == null && obj.lon == null) return null;
  const point = { lat, lng };
  if (!paintPoint(point) || lat === 0 && lng === 0) return null;
  return point;
}
__name(pointFromFields, "pointFromFields");
function coursePointFromBody(text) {
  let payload;
  try {
    payload = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!isPlainObject(payload)) return null;
  const candidates = [payload.course, payload.data, payload].filter(isPlainObject);
  for (const obj of candidates) {
    const point = pointFromFields(obj.location) || pointFromFields(obj) || (isPlainObject(obj.coordinates) ? pointFromFields(obj.coordinates) : null);
    if (point) return point;
  }
  return null;
}
__name(coursePointFromBody, "coursePointFromBody");
async function knownPaintLocation(boards, keys) {
  for (const key of keys.slice(0, 4)) {
    if (typeof key !== "string" || !key.startsWith("id:")) continue;
    const courseKey = key.slice(3);
    let storeKey = null;
    let source = null;
    if (courseKey.startsWith("golfapi:")) {
      const id = safeGolfapiId(courseKey.slice("golfapi:".length));
      if (id) {
        storeKey = courseStoreKey(id);
        source = "golfapi_store";
      }
    } else if (/^\d{1,12}$/.test(courseKey)) {
      storeKey = gcaStoreKey("course", courseKey);
      source = "gca_store";
    }
    if (!storeKey) continue;
    let raw = null;
    try {
      raw = await boards.get(storeKey);
    } catch {
      raw = null;
    }
    const point = typeof raw === "string" ? coursePointFromBody(raw) : null;
    if (point) return { point, source, key };
  }
  return null;
}
__name(knownPaintLocation, "knownPaintLocation");
function validatePaintPut(raw, urlKey) {
  if (!isPlainObject(raw)) return { ok: false, error: "not_object" };
  if (raw.key !== urlKey) return { ok: false, error: "key_mismatch" };
  if (!PAINT_SOURCES.has(raw.source)) return { ok: false, error: "bad_source" };
  if (typeof raw.fetchedAt !== "string" || !Number.isFinite(Date.parse(raw.fetchedAt))) return { ok: false, error: "bad_fetchedAt" };
  if (!Array.isArray(raw.holes) || raw.holes.length === 0 || raw.holes.length > 27) return { ok: false, error: "bad_holes" };
  const seen = /* @__PURE__ */ new Set();
  for (const h of raw.holes) {
    if (!isPlainObject(h) || !Number.isInteger(h.hole) || h.hole < 1 || h.hole > 18 || seen.has(h.hole)) {
      return { ok: false, error: "bad_hole" };
    }
    seen.add(h.hole);
    for (const field of ["tee", "green"]) {
      if (h[field] != null && !paintPoint(h[field])) return { ok: false, error: `bad_${field}`, hole: h.hole };
    }
  }
  const record = { ...raw };
  if (raw.aliases != null) {
    const aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
    const kept = aliases.filter((a) => typeof a === "string" && parsePaintKey(a).kind === "ok");
    if (kept.length !== aliases.length) hotfixLog("paint_aliases_dropped", { key: urlKey, dropped: aliases.length - kept.length });
    record.aliases = kept;
  }
  return { ok: true, record };
}
__name(validatePaintPut, "validatePaintPut");
function guardPaintGreens(stored, incoming, anchor) {
  if (anchor) {
    for (const h of incoming.holes) {
      if (!paintPoint(h.green)) continue;
      const meters = paintDistanceM(anchor, h.green);
      if (meters > PAINT_GREEN_MAX_FROM_COURSE_M) {
        return { error: "green_too_far", hole: h.hole, meters: Math.round(meters) };
      }
    }
  }
  const storedByHole = /* @__PURE__ */ new Map();
  if (isPlainObject(stored) && Array.isArray(stored.holes)) {
    for (const h of stored.holes) {
      const n = holeNumber(h);
      if (n != null && !storedByHole.has(n) && (paintPoint(h.green) || paintPoint(h.tee))) storedByHole.set(n, h);
    }
  }
  const pending = {};
  const flaggedHoles = [];
  const holes = [];
  for (const h of incoming.holes) {
    const prior = storedByHole.get(h.hole);
    if (!prior) {
      holes.push(h);
      continue;
    }
    const verdict = paintRecordChokepoint(
      incoming.key,
      { key: incoming.key, source: stored && stored.source, holes: [prior] },
      { key: incoming.key, source: h.source ?? incoming.source, holes: [h] },
      incoming,
      "guardPaintGreens"
    );
    if (!verdict.ok) return { error: verdict.message, hole: verdict.hole, role: verdict.role };
    holes.push(h);
  }
  const included = new Set(incoming.holes.map((h) => h.hole));
  const leftovers = [];
  if (isPlainObject(stored) && Array.isArray(stored.holes)) {
    for (const h of stored.holes) {
      const n = holeNumber(h);
      if (n == null || included.has(n)) continue;
      included.add(n);
      leftovers.push(h);
    }
  }
  if (leftovers.length > 0) {
    holes.push(...leftovers);
    holes.sort((a, b) => holeNumber(a) - holeNumber(b));
  }
  return { record: { ...incoming, holes }, pending, flaggedHoles, keptHoles: leftovers.length };
}
__name(guardPaintGreens, "guardPaintGreens");
function paintRateAllowed(op, ipHash, limitPerMin, nowMs) {
  const k = `${op}:${ipHash}`;
  const w = paintRateWindows.get(k);
  if (!w || nowMs - w.start >= 6e4) {
    paintRateWindows.set(k, { start: nowMs, n: 1 });
    if (paintRateWindows.size > 5e3) {
      for (const [key, win] of paintRateWindows) if (nowMs - win.start >= 6e4) paintRateWindows.delete(key);
    }
    return limitPerMin > 0;
  }
  w.n += 1;
  return w.n <= limitPerMin;
}
__name(paintRateAllowed, "paintRateAllowed");
function paintPutRequiresInstallId(env) {
  const raw = env && env.PAINT_PUT_REQUIRE_INSTALL_ID;
  if (raw == null) return true;
  if (raw === false) return false;
  const text = String(raw).trim().toLowerCase();
  return !(text === "0" || text === "false" || text === "no" || text === "off");
}
__name(paintPutRequiresInstallId, "paintPutRequiresInstallId");
function __resetHotfixMemoryForTests() {
  paintRateWindows.clear();
  hotfixEmailMessageClass = null;
  consumedContributionApprovals.clear();
}
__name(__resetHotfixMemoryForTests, "__resetHotfixMemoryForTests");
async function handlePaintRoute(request, env, key, ttl, cors) {
  const boards = env.BOARDS;
  const parsed = parsePaintKey(key);
  if (parsed.kind !== "ok") return golfJson(400, { error: "bad_key" }, cors);
  const op = request.method === "PUT" ? "put" : "get";
  const installId = readInstallId(request);
  const ipHash = await readIpHash(request) || "unknown";
  const ipTag = ipHash.slice(0, 16);
  if (!installId) {
    if (op === "put" && paintPutRequiresInstallId(env)) {
      hotfixLog("paint_put_no_install_id", { ip: ipTag, enforced: true });
      return golfJson(401, { error: "install_id_required" }, cors);
    }
    hotfixLog(op === "put" ? "paint_put_no_install_id" : "paint_get_no_install_id", { ip: ipTag, enforced: false });
  }
  const limit = op === "put" ? readConfigInt(env.PAINT_PUT_PER_MIN) ?? PAINT_PUT_PER_MIN_DEFAULT : readConfigInt(env.PAINT_GET_PER_MIN) ?? PAINT_GET_PER_MIN_DEFAULT;
  if (!paintRateAllowed(op, ipHash, limit, Date.now())) {
    hotfixLog("paint_rate_limited", { op, ip: ipTag });
    return golfJson(429, { error: "rate_limited" }, cors, { "Retry-After": "60" });
  }
  if (op === "get") {
    const val = await boards.get(key);
    if (!val) return new Response("{}", { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    const body2 = await paintGetBody(boards, key, val);
    return new Response(body2, { headers: { ...cors, "Content-Type": "application/json" } });
  }
  const body = await request.text();
  if (!body || body.length > 2e4) {
    return new Response("bad body", { status: 400, headers: cors });
  }
  let incoming;
  try {
    incoming = JSON.parse(body);
  } catch {
    return golfJson(400, { error: "not_json" }, cors);
  }
  const valid = validatePaintPut(incoming, key);
  if (!valid.ok) return golfJson(400, { error: valid.error, ...valid.hole ? { hole: valid.hole } : {} }, cors);
  const stored = parsePaintRecord(await boards.get(key));
  const known = await knownPaintLocation(boards, [key, ...valid.record.aliases || []]);
  const anchor = known ? known.point : paintCentroid(stored) || paintCentroid(valid.record);
  const guard = guardPaintGreens(stored, valid.record, anchor);
  if (guard.error) {
    hotfixLog("paint_put_rejected", { key, error: guard.error, hole: guard.hole, meters: guard.meters, anchor: known ? known.source : "centroid" });
    return golfJson(400, {
      error: guard.error,
      hole: guard.hole,
      ...guard.role ? { role: guard.role } : {}
    }, cors);
  }
  if (guard.flaggedHoles.length > 0) {
    const pendingKey = PAINT_PENDING_PREFIX + key;
    const prior = parsePaintRecord(await boards.get(pendingKey)) || { key, holes: {} };
    if (!isPlainObject(prior.holes)) prior.holes = {};
    const user = installId ? (await sha256Hex(`paint-iid:${installId}`)).slice(0, 24) : null;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    for (const [hole, p] of Object.entries(guard.pending)) prior.holes[hole] = { ...p, at, user };
    await boards.put(pendingKey, JSON.stringify(prior), { expirationTtl: PAINT_PENDING_TTL });
    hotfixLog("paint_green_flagged", { key, holes: guard.flaggedHoles, pending: guard.pending });
  }
  const response = await putPaintRecord(boards, key, JSON.stringify(guard.record), ttl, request, cors, env);
  if (guard.flaggedHoles.length > 0) response.headers.set("X-Paint-Flagged-Holes", guard.flaggedHoles.join(","));
  return response;
}
__name(handlePaintRoute, "handlePaintRoute");
var CONTRIBUTION_APPROVERS = /* @__PURE__ */ new Set(["Brian", "Chief of Staff", "ShotTraxx Lead"]);
var consumedContributionApprovals = /* @__PURE__ */ new Set();
function contributionPoint(point) {
  if (paintPoint(point)) return { lat: point.lat, lng: point.lng };
  if (isPlainObject(point) && Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
    const candidate = { lat: point.lat, lng: point.lon };
    return paintPoint(candidate) ? candidate : null;
  }
  return null;
}
__name(contributionPoint, "contributionPoint");
__name2(contributionPoint, "contributionPoint");
async function contributionChangeSha(change) {
  const point = (value) => {
    const parsed = contributionPoint(value);
    return parsed ? { lat: parsed.lat, lng: parsed.lng } : null;
  };
  const body = JSON.stringify({
    v: 1,
    courseId: String(change.courseId ?? ""),
    hole: change.hole,
    role: change.role,
    from: point(change.from),
    to: point(change.to)
  });
  return sha256Hex(body);
}
__name(contributionChangeSha, "contributionChangeSha");
__name2(contributionChangeSha, "contributionChangeSha");
function contributionDisplayLabel(name) {
  const key = String(name ?? "").trim().toLowerCase();
  return key === "brian" || key === "brian baird" || key === "doc" || key === "bigbaird83";
}
__name(contributionDisplayLabel, "contributionDisplayLabel");
__name2(contributionDisplayLabel, "contributionDisplayLabel");
function contributionAccount(identity) {
  if (!identity || identity.source === "none" || identity.source == null) return null;
  const account = String(identity.account ?? "").trim();
  return account || null;
}
__name(contributionAccount, "contributionAccount");
__name2(contributionAccount, "contributionAccount");
function contributionSlot(name, identity) {
  const key = String(name ?? "").trim().toLowerCase();
  if (key === "chief of staff") return "Chief of Staff";
  if (key === "shottraxx lead") return "ShotTraxx Lead";
  if (contributionDisplayLabel(name) && contributionAccount(identity) === "bigbaird83") return "Brian";
  return null;
}
__name(contributionSlot, "contributionSlot");
__name2(contributionSlot, "contributionSlot");
function sameContributionPerson(stagedBy, approver, identity) {
  const left = contributionSlot(stagedBy, identity);
  const right = contributionSlot(approver, identity);
  if (left && right) return left === right;
  return String(stagedBy ?? "") === String(approver ?? "");
}
__name(sameContributionPerson, "sameContributionPerson");
__name2(sameContributionPerson, "sameContributionPerson");
function approvalForPromote(requestBody, hole, role) {
  if (!isPlainObject(requestBody)) return null;
  if (Array.isArray(requestBody.approvals)) {
    return requestBody.approvals.find((row) => row && row.hole === hole && row.role === role) || null;
  }
  return isPlainObject(requestBody.approval) ? requestBody.approval : null;
}
__name(approvalForPromote, "approvalForPromote");
__name2(approvalForPromote, "approvalForPromote");
async function commitPromotedFill(args) {
  const existing = contributionPoint(args.existing);
  const proposed = contributionPoint(args.proposed);
  if (!proposed && !existing) return { ok: true, point: null, skipped: true };
  if (existing && !proposed) return { ok: true, point: existing, skipped: true };
  if (existing && proposed && existing.lat === proposed.lat && existing.lng === proposed.lng) {
    return { ok: true, point: existing, skipped: true };
  }
  if (existing && proposed) return { ok: false, status: 400, message: "promote-would-move" };
  const requestBody = args.requestBody || null;
  if (requestBody && Object.prototype.hasOwnProperty.call(requestBody, "stagedBy")) {
    return { ok: false, status: 400, message: "staged-by-from-request" };
  }
  const who = args.identity || { name: null, source: "none" };
  if (!who.name || who.source === "none" || who.source == null) {
    return { ok: false, status: 400, message: "no-trustworthy-identity" };
  }
  if (contributionDisplayLabel(who.name) && contributionAccount(who) !== "bigbaird83") {
    return { ok: false, status: 400, message: "brian-name-unauthenticated" };
  }
  const approverSlot = contributionSlot(who.name, who);
  if (!approverSlot || !CONTRIBUTION_APPROVERS.has(approverSlot)) {
    return { ok: false, status: 400, message: "unlisted-approver" };
  }
  const expected = await contributionChangeSha({
    courseId: args.courseId,
    hole: args.hole,
    role: args.role,
    from: null,
    to: proposed
  });
  let approval = approvalForPromote(requestBody, args.hole, args.role);
  if (!approval) return { ok: false, status: 400, message: "contribution-unapproved" };
  if (approval.sha256 !== expected) return { ok: false, status: 400, message: "wrong-sha" };
  if (approval.approver != null && contributionSlot(approval.approver, who) !== approverSlot) {
    return { ok: false, status: 400, message: "approver-not-authenticated" };
  }
  const stagedBy = approval.stagedBy;
  const ownChange = stagedBy == null || String(stagedBy).trim() === "" || sameContributionPerson(stagedBy, approverSlot, who);
  if (ownChange && contributionAccount(who) !== "bigbaird83") {
    return { ok: false, status: 400, message: "self-approval" };
  }
  const useId = String(approval.useId ?? "");
  if (!useId || consumedContributionApprovals.has(useId)) return { ok: false, status: 400, message: "replayed-approval" };
  consumedContributionApprovals.add(useId);
  const source = typeof args.pendingSource === "string" && args.pendingSource ? args.pendingSource : "manual_verified";
  return {
    ok: true,
    point: proposed,
    source,
    verifiedBy: approverSlot,
    approvalSha: approval.sha256,
    skipped: false
  };
}
__name(commitPromotedFill, "commitPromotedFill");
__name2(commitPromotedFill, "commitPromotedFill");
function applyPromotedPoint(holes, hole, role, fill) {
  const next = holes.map((row) => ({ ...row }));
  let found = false;
  for (const row of next) {
    if (holeNumber(row) !== hole) continue;
    found = true;
    row[role] = fill.point;
    row.source = fill.source;
    row.verifiedBy = fill.verifiedBy;
    row.approvalSha = fill.approvalSha;
    row.contribution = "hole-contribution";
  }
  if (!found) {
    const created = { hole, tee: null, green: null, source: fill.source, verifiedBy: fill.verifiedBy, approvalSha: fill.approvalSha, contribution: "hole-contribution" };
    created[role] = fill.point;
    next.push(created);
  }
  next.sort((a, b) => (holeNumber(a) || 0) - (holeNumber(b) || 0));
  return next;
}
__name(applyPromotedPoint, "applyPromotedPoint");
__name2(applyPromotedPoint, "applyPromotedPoint");
async function promotePendingEntry(boards, key, hole, requestBody, identity) {
  const pendingKey = PAINT_PENDING_PREFIX + key;
  const pending = parsePaintRecord(await boards.get(pendingKey));
  const entry = pending && isPlainObject(pending.holes) ? pending.holes[String(hole)] : null;
  const stored = parsePaintRecord(await boards.get(key));
  if (!entry || !stored) return { ok: false, error: "nothing_pending" };
  const holes = Array.isArray(stored.holes) ? stored.holes.slice() : [];
  const prior = holes.find((row) => holeNumber(row) === hole) || null;
  const roles = [];
  if (contributionPoint(entry.green) || contributionPoint(entry.tee)) {
    if (contributionPoint(entry.tee)) roles.push("tee");
    if (contributionPoint(entry.green)) roles.push("green");
  }
  if (roles.length === 0) return { ok: false, error: "nothing_pending" };
  let nextHoles = holes;
  const written = {};
  for (const role of roles) {
    const verdict = await commitPromotedFill({
      courseId: key,
      hole,
      role,
      existing: prior ? prior[role] : null,
      proposed: entry[role],
      pendingSource: entry.source || null,
      requestBody,
      identity,
      writer: "promotePendingGreen"
    });
    if (!verdict.ok) return { ok: false, status: verdict.status || 400, error: verdict.message };
    if (verdict.skipped) continue;
    nextHoles = applyPromotedPoint(nextHoles, hole, role, verdict);
    written[role] = verdict.point;
  }
  if (Object.keys(written).length === 0) return { ok: true, green: contributionPoint(entry.green), unchanged: true, holes: nextHoles };
  return { ok: true, green: written.green || contributionPoint(prior && prior.green), holes: nextHoles, written };
}
__name(promotePendingEntry, "promotePendingEntry");
__name2(promotePendingEntry, "promotePendingEntry");
async function writePromotedRecord(boards, key, stored, holes) {
  const keys = await paintKeysForSave(boards, key, stored);
  let storedBody = null;
  for (const paintKey of keys) {
    const record = { ...stored, holes, key: paintKey, aliases: keys.filter((item) => item !== paintKey) };
    const body = JSON.stringify(record);
    await boards.put(paintKey, body, { expirationTtl: PAINT_RECORD_TTL });
    if (paintKey === key) storedBody = body;
  }
  return storedBody;
}
__name(writePromotedRecord, "writePromotedRecord");
__name2(writePromotedRecord, "writePromotedRecord");
async function promotePendingGreen(boards, key, hole, requestBody, identity) {
  if (requestBody && requestBody.dismiss === true) return { ok: true, dismissed: true };
  const pendingKey = PAINT_PENDING_PREFIX + key;
  const result = await promotePendingEntry(boards, key, hole, requestBody, identity);
  if (!result.ok) return result;
  if (!result.written) return { ok: true, green: result.green };
  const stored = parsePaintRecord(await boards.get(key));
  await writePromotedRecord(boards, key, stored, result.holes);
  const pending = parsePaintRecord(await boards.get(pendingKey));
  if (pending && isPlainObject(pending.holes)) {
    delete pending.holes[String(hole)];
    if (Object.keys(pending.holes).length === 0) await boards.delete(pendingKey);
    else await boards.put(pendingKey, JSON.stringify(pending), { expirationTtl: PAINT_PENDING_TTL });
  }
  hotfixLog("paint_green_promoted", { key, hole, green: result.green, writer: "promotePendingGreen" });
  return { ok: true, green: result.green };
}
__name(promotePendingGreen, "promotePendingGreen");
__name2(promotePendingGreen, "promotePendingGreen");
async function promotePendingCourse(boards, key, requestBody, identity) {
  if (requestBody && requestBody.dismiss === true) return { ok: true, dismissed: true };
  const pendingKey = PAINT_PENDING_PREFIX + key;
  const pending = parsePaintRecord(await boards.get(pendingKey));
  const stored = parsePaintRecord(await boards.get(key));
  if (!pending || !isPlainObject(pending.holes) || !stored) return { ok: false, error: "nothing_pending" };
  let holes = Array.isArray(stored.holes) ? stored.holes.slice() : [];
  const promoted = [];
  for (const holeKey of Object.keys(pending.holes)) {
    const hole = Number(holeKey);
    if (!Number.isInteger(hole)) continue;
    const entry = pending.holes[holeKey];
    const prior = holes.find((row) => holeNumber(row) === hole) || null;
    for (const role of ["tee", "green"]) {
      if (!contributionPoint(entry && entry[role])) continue;
      const verdict = await commitPromotedFill({
        courseId: key,
        hole,
        role,
        existing: prior ? prior[role] : null,
        proposed: entry[role],
        pendingSource: entry.source || null,
        requestBody,
        identity,
        writer: "promotePendingGreen"
      });
      if (!verdict.ok) return { ok: false, status: verdict.status || 400, error: verdict.message };
      if (verdict.skipped) continue;
      holes = applyPromotedPoint(holes, hole, role, verdict);
      promoted.push({ hole, role });
    }
  }
  if (promoted.length === 0) return { ok: true, promoted };
  await writePromotedRecord(boards, key, stored, holes);
  await boards.delete(pendingKey);
  return { ok: true, promoted };
}
__name(promotePendingCourse, "promotePendingCourse");
__name2(promotePendingCourse, "promotePendingCourse");
async function handlePaintPendingPromote(request, env, cors) {
  if (request.method !== "POST") return golfJson(405, { error: "method_not_allowed" }, cors);
  const denied = await authorizeCourseReports(request, env, cors);
  if (denied) return denied;
  const boards = boardsBinding(env);
  if (!boards || typeof boards.delete !== "function") return golfJson(503, { error: "boards_not_configured" }, cors);
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return golfJson(400, { error: "not_json" }, cors);
  }
  const key = isPlainObject(payload) && typeof payload.key === "string" ? payload.key : "";
  const hole = isPlainObject(payload) ? payload.hole : null;
  if (parsePaintKey(key).kind !== "ok") return golfJson(400, { error: "bad_key" }, cors);
  if (!Number.isInteger(hole) || hole < 1 || hole > 18) return golfJson(400, { error: "bad_hole" }, cors);
  const result = await promotePendingGreen(boards, key, hole, payload);
  if (!result.ok) return golfJson(result.status || 404, { error: result.error }, cors);
  return golfJson(200, { ok: true, key, hole, green: result.green }, cors);
}
__name(handlePaintPendingPromote, "handlePaintPendingPromote");
var COURSE_REPORT_TTL = 60 * 60 * 24 * 180;
var COURSE_REPORT_EMAIL_TTL = 60 * 60 * 24 * 365;
var COURSE_REPORT_BODY_MAX = 4096;
var SCORECARD_PHOTO_MAX = 2 * 1024 * 1024;
var SCORECARD_PHOTO_PREFIX = "cr:photo:";
var COURSE_REPORT_IP_DAY_DEFAULT = 30;
var COURSE_REPORT_DEVICE_DAY_DEFAULT = 20;
var COURSE_REPORT_REASONS = /* @__PURE__ */ new Set([
  "hole_missing",
  "green_wrong",
  "tee_wrong",
  "wrong_par",
  "wrong_course",
  "other",
  "hole-contribution"
]);
var CONTRIBUTION_METHODS = /* @__PURE__ */ new Set(["tap-map", "im-here"]);
var CONTRIBUTION_TEES_MAX = 8;
var CONTRIBUTION_TEE_COLOR_MAX = 24;
var REVIEW_STATUSES = /* @__PURE__ */ new Set(["pending", "approved", "rejected", "used", "rewarded"]);
var REVIEW_DECISIONS = /* @__PURE__ */ new Set(["approved", "rejected", "used", "rewarded"]);
var PAR_LENGTH_YARDS = {
  3: [60, 280],
  4: [230, 520],
  5: [400, 680]
};
var METERS_PER_YARD = 0.9144;
var POOR_FIX_ACCURACY_M = 15;
var COURSE_REPORT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var COURSE_REPORT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var COURSE_REPORT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function isCourseReportPath(pathname) {
  return pathname === "/v1/course-reports" || pathname.startsWith("/v1/course-reports/");
}
__name(isCourseReportPath, "isCourseReportPath");
__name2(isCourseReportPath, "isCourseReportPath");
function readCourseReportLimits(env) {
  const source = env || {};
  return {
    ipDay: readConfigInt(source.COURSE_REPORTS_IP_DAY) ?? COURSE_REPORT_IP_DAY_DEFAULT,
    deviceDay: readConfigInt(source.COURSE_REPORTS_DEVICE_DAY) ?? COURSE_REPORT_DEVICE_DAY_DEFAULT
  };
}
__name(readCourseReportLimits, "readCourseReportLimits");
__name2(readCourseReportLimits, "readCourseReportLimits");
function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}
__name(utf8ByteLength, "utf8ByteLength");
__name2(utf8ByteLength, "utf8ByteLength");
function validClientReportId(value) {
  return typeof value === "string" && value.length <= 64 && COURSE_REPORT_UUID_RE.test(value);
}
__name(validClientReportId, "validClientReportId");
__name2(validClientReportId, "validClientReportId");
function isIsoDateTime(value) {
  if (typeof value !== "string" || value.length > 40 || !COURSE_REPORT_ISO_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}
__name(isIsoDateTime, "isIsoDateTime");
__name2(isIsoDateTime, "isIsoDateTime");
function invalidField(field) {
  return { ok: false, field };
}
__name(invalidField, "invalidField");
__name2(invalidField, "invalidField");
function readOptionalString(payload, field, max) {
  if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] == null) {
    return { ok: true, present: false };
  }
  if (typeof payload[field] !== "string") return invalidField(field);
  const text = payload[field].trim();
  if (text.length > max) return invalidField(field);
  return { ok: true, present: true, value: text };
}
__name(readOptionalString, "readOptionalString");
__name2(readOptionalString, "readOptionalString");
function parseLatLon(point) {
  if (!isPlainObject(point) || !finiteNumber(point.lat) || !finiteNumber(point.lon)) return null;
  if (point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) return null;
  return { lat: point.lat, lon: point.lon };
}
__name(parseLatLon, "parseLatLon");
__name2(parseLatLon, "parseLatLon");
function normalizeShown(shown) {
  if (!isPlainObject(shown)) return null;
  const out = {};
  if (Object.prototype.hasOwnProperty.call(shown, "par")) {
    out.par = Number.isInteger(shown.par) && shown.par >= 1 && shown.par <= 10 ? shown.par : null;
  }
  for (const name of ["green", "tee"]) {
    if (!Object.prototype.hasOwnProperty.call(shown, name)) continue;
    out[name] = parseLatLon(shown[name]);
  }
  return out;
}
__name(normalizeShown, "normalizeShown");
__name2(normalizeShown, "normalizeShown");
function invalidContribution(name) {
  return invalidField(name ? `contribution.${name}` : "contribution");
}
__name(invalidContribution, "invalidContribution");
__name2(invalidContribution, "invalidContribution");
function parseContributionTee(entry, colors) {
  if (!isPlainObject(entry) || typeof entry.color !== "string") return null;
  const color = entry.color.trim().toLowerCase();
  if (color.length < 1 || color.length > CONTRIBUTION_TEE_COLOR_MAX || colors.has(color)) return null;
  const point = parseLatLon(entry);
  if (!point) return null;
  if (typeof entry.method !== "string" || !CONTRIBUTION_METHODS.has(entry.method)) return null;
  const tee = { color, lat: point.lat, lon: point.lon, method: entry.method };
  if (Object.prototype.hasOwnProperty.call(entry, "accuracyM") && entry.accuracyM != null) {
    if (!finiteNumber(entry.accuracyM) || entry.accuracyM < 0) return null;
    tee.accuracyM = entry.accuracyM;
  }
  colors.add(color);
  return tee;
}
__name(parseContributionTee, "parseContributionTee");
__name2(parseContributionTee, "parseContributionTee");
function parseContributionTees(value) {
  if (!Array.isArray(value) || value.length > CONTRIBUTION_TEES_MAX) return null;
  const colors = /* @__PURE__ */ new Set();
  const tees = [];
  for (const entry of value) {
    const tee = parseContributionTee(entry, colors);
    if (!tee) return null;
    tees.push(tee);
  }
  return tees;
}
__name(parseContributionTees, "parseContributionTees");
__name2(parseContributionTees, "parseContributionTees");
function yardsPlausibleForPar(meters, par) {
  const band = PAR_LENGTH_YARDS[par];
  if (!band) return false;
  const yards = meters / METERS_PER_YARD;
  return yards >= band[0] && yards <= band[1];
}
__name(yardsPlausibleForPar, "yardsPlausibleForPar");
__name2(yardsPlausibleForPar, "yardsPlausibleForPar");
function parseHoleContribution(payload, reasons) {
  const required = reasons.includes("hole-contribution");
  if (!required) return { ok: true, present: false, contributorEmail: null };
  if (!isPlainObject(payload.contribution)) return invalidContribution();
  const src = payload.contribution;
  const hasPhoto = payload.photoId != null && validClientReportId(payload.photoId);
  const noGreen = src.green == null && src.greenMethod == null;
  const contribution = {};
  if (!(hasPhoto && noGreen)) {
    const green = parseLatLon(src.green);
    if (!green) return invalidContribution("green");
    if (typeof src.greenMethod !== "string" || !CONTRIBUTION_METHODS.has(src.greenMethod)) {
      return invalidContribution("greenMethod");
    }
    contribution.green = green;
    contribution.greenMethod = src.greenMethod;
  }
  if (Object.prototype.hasOwnProperty.call(src, "tee") && src.tee != null) {
    const tee = parseLatLon(src.tee);
    if (!tee) return invalidContribution("tee");
    contribution.tee = tee;
  }
  if (Object.prototype.hasOwnProperty.call(src, "tees") && src.tees != null) {
    const tees = parseContributionTees(src.tees);
    if (!tees) return invalidContribution("tees");
    if (tees.length > 0) contribution.tees = tees;
  }
  if (Object.prototype.hasOwnProperty.call(src, "par") && src.par != null) {
    if (!Number.isInteger(src.par) || src.par < 3 || src.par > 6) return invalidContribution("par");
    contribution.par = src.par;
  }
  let contributorEmail = null;
  if (Object.prototype.hasOwnProperty.call(src, "contributorEmail") && src.contributorEmail != null) {
    if (typeof src.contributorEmail !== "string") return invalidContribution("contributorEmail");
    const email = src.contributorEmail.trim().toLowerCase();
    if (email.length < 1 || email.length > 254 || !COURSE_REPORT_EMAIL_RE.test(email)) {
      return invalidContribution("contributorEmail");
    }
    contributorEmail = email;
    contribution.hadEmail = true;
  }
  return { ok: true, present: true, contribution, contributorEmail };
}
__name(parseHoleContribution, "parseHoleContribution");
__name2(parseHoleContribution, "parseHoleContribution");
function contributionHints(contribution, position) {
  const hints = {};
  const fix = isPlainObject(position) && finiteNumber(position.lat) && finiteNumber(position.lon) ? position : null;
  if (contribution.green && contribution.greenMethod === "im-here" && fix) {
    hints.greenToPositionM = Math.round(distanceMeters(
      contribution.green.lat,
      contribution.green.lon,
      fix.lat,
      fix.lon
    ));
  }
  if (fix && finiteNumber(fix.accuracyM)) {
    hints.positionAccuracyM = fix.accuracyM;
    hints.poorFix = fix.accuracyM > POOR_FIX_ACCURACY_M;
  }
  if (contribution.green && contribution.tee && Number.isInteger(contribution.par)) {
    const meters = distanceMeters(
      contribution.green.lat,
      contribution.green.lon,
      contribution.tee.lat,
      contribution.tee.lon
    );
    hints.greenToTeeM = Math.round(meters);
    hints.plausibleForPar = yardsPlausibleForPar(meters, contribution.par);
  }
  if (contribution.green && Array.isArray(contribution.tees) && contribution.tees.length > 0) {
    hints.tees = contribution.tees.map((tee) => {
      const meters = distanceMeters(
        contribution.green.lat,
        contribution.green.lon,
        tee.lat,
        tee.lon
      );
      const hint = { color: tee.color, greenToTeeM: Math.round(meters) };
      if (finiteNumber(tee.accuracyM)) {
        hint.accuracyM = tee.accuracyM;
        hint.poorFix = tee.accuracyM > POOR_FIX_ACCURACY_M;
      }
      if (Number.isInteger(contribution.par)) {
        hint.plausibleForPar = yardsPlausibleForPar(meters, contribution.par);
      }
      return hint;
    });
  }
  return hints;
}
__name(contributionHints, "contributionHints");
__name2(contributionHints, "contributionHints");
function parseCourseReport(payload) {
  if (!isPlainObject(payload)) return invalidField("body");
  if (!validClientReportId(payload.clientReportId)) return invalidField("clientReportId");
  if (!isIsoDateTime(payload.createdAt)) return invalidField("createdAt");
  if (typeof payload.courseId !== "string" || payload.courseId.length < 1 || payload.courseId.length > 180) {
    return invalidField("courseId");
  }
  if (typeof payload.courseName !== "string") return invalidField("courseName");
  const courseName = payload.courseName.trim();
  if (courseName.length < 1 || courseName.length > 200) return invalidField("courseName");
  if (!Number.isInteger(payload.holeNumber) || payload.holeNumber < 1 || payload.holeNumber > 18) {
    return invalidField("holeNumber");
  }
  if (!Array.isArray(payload.reasons)) return invalidField("reasons");
  const reasons = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of payload.reasons) {
    if (typeof item !== "string" || !COURSE_REPORT_REASONS.has(item) || seen.has(item)) continue;
    seen.add(item);
    reasons.push(item);
  }
  if (reasons.length === 0) return invalidField("reasons");
  const record = {
    clientReportId: payload.clientReportId,
    createdAt: payload.createdAt,
    courseId: payload.courseId,
    courseName,
    holeNumber: payload.holeNumber,
    reasons
  };
  if (Object.prototype.hasOwnProperty.call(payload, "note") && payload.note != null) {
    if (typeof payload.note !== "string") return invalidField("note");
    const note = payload.note.trim();
    if (note.length > 500) return invalidField("note");
    record.note = note;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "position")) {
    if (payload.position == null) {
      record.position = null;
    } else if (!isPlainObject(payload.position)) {
      return invalidField("position");
    } else {
      const point = parseLatLon(payload.position);
      if (!point) return invalidField("position");
      let accuracyM = null;
      if (Object.prototype.hasOwnProperty.call(payload.position, "accuracyM") && payload.position.accuracyM != null) {
        if (!finiteNumber(payload.position.accuracyM) || payload.position.accuracyM < 0) return invalidField("position");
        accuracyM = payload.position.accuracyM;
      }
      record.position = { lat: point.lat, lon: point.lon, accuracyM };
    }
  }
  for (const field of ["appVersion", "buildNumber", "platform"]) {
    const parsed = readOptionalString(payload, field, 32);
    if (!parsed.ok) return invalidField(field);
    if (parsed.present) record[field] = parsed.value;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "paintSource")) {
    if (payload.paintSource == null) {
      record.paintSource = null;
    } else if (typeof payload.paintSource !== "string") {
      return invalidField("paintSource");
    } else {
      const paintSource = payload.paintSource.trim().toLowerCase();
      if (paintSource.length > 32) return invalidField("paintSource");
      record.paintSource = paintSource;
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, "shown")) {
    record.shown = normalizeShown(payload.shown);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "photoId") && payload.photoId != null) {
    if (!validClientReportId(payload.photoId)) return invalidField("photoId");
    record.photoId = payload.photoId.toLowerCase();
  }
  const contribution = parseHoleContribution(payload, reasons);
  if (!contribution.ok) return contribution;
  if (contribution.present) {
    contribution.contribution.hints = contributionHints(contribution.contribution, record.position);
    record.contribution = contribution.contribution;
    record.review = {
      status: "pending",
      reviewedAt: null,
      note: null,
      usedAt: null,
      rewardedAt: null
    };
  }
  return { ok: true, record, contributorEmail: contribution.contributorEmail };
}
__name(parseCourseReport, "parseCourseReport");
__name2(parseCourseReport, "parseCourseReport");
function readCourseReportInstallId(request) {
  const raw = request.headers.get("X-Install-Id");
  if (typeof raw !== "string") return { ok: true, id: null };
  const id = raw.trim();
  if (!id) return { ok: true, id: null };
  if (id.length > 100) return { ok: false };
  return { ok: true, id };
}
__name(readCourseReportInstallId, "readCourseReportInstallId");
__name2(readCourseReportInstallId, "readCourseReportInstallId");
function readRequestCountry(request) {
  const cf = request && request.cf;
  if (!cf || typeof cf !== "object") return null;
  const country = cf.country;
  if (typeof country !== "string") return null;
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}
__name(readRequestCountry, "readRequestCountry");
__name2(readRequestCountry, "readRequestCountry");
async function timingSafeEqualText(left, right) {
  const enc = new TextEncoder();
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(left))),
    crypto.subtle.digest("SHA-256", enc.encode(String(right)))
  ]);
  const a = new Uint8Array(aBuf);
  const b = new Uint8Array(bBuf);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
__name(timingSafeEqualText, "timingSafeEqualText");
__name2(timingSafeEqualText, "timingSafeEqualText");
function courseReportsAdminToken(env) {
  if (!env || typeof env.COURSE_REPORTS_ADMIN_TOKEN !== "string") return "";
  return env.COURSE_REPORTS_ADMIN_TOKEN.trim();
}
__name(courseReportsAdminToken, "courseReportsAdminToken");
__name2(courseReportsAdminToken, "courseReportsAdminToken");
async function authorizeCourseReports(request, env, cors) {
  const secret = courseReportsAdminToken(env);
  if (!secret) return golfJson(503, { error: "not_configured" }, cors);
  const header = request.headers.get("Authorization");
  const match = typeof header === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  const presented = match ? match[1] : "";
  const matches = await timingSafeEqualText(secret, presented);
  if (!match || !matches) return golfJson(401, { error: "unauthorized" }, cors);
  return null;
}
__name(authorizeCourseReports, "authorizeCourseReports");
__name2(authorizeCourseReports, "authorizeCourseReports");
function boardsBinding(env) {
  const boards = env && env.BOARDS;
  if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") return null;
  return boards;
}
__name(boardsBinding, "boardsBinding");
__name2(boardsBinding, "boardsBinding");
function courseReportMarkerKey(clientReportId) {
  return `cr:id:${clientReportId}`;
}
__name(courseReportMarkerKey, "courseReportMarkerKey");
__name2(courseReportMarkerKey, "courseReportMarkerKey");
function courseReportEmailKey(clientReportId) {
  return `cr:email:${clientReportId}`;
}
__name(courseReportEmailKey, "courseReportEmailKey");
__name2(courseReportEmailKey, "courseReportEmailKey");
function contributionEmailWithinCap(createdAt, now) {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return false;
  return now.getTime() - createdMs < COURSE_REPORT_EMAIL_TTL * 1e3;
}
__name(contributionEmailWithinCap, "contributionEmailWithinCap");
__name2(contributionEmailWithinCap, "contributionEmailWithinCap");
function courseReportRecordKey(receivedAt, clientReportId) {
  return `cr:r:${receivedAt}:${clientReportId}`;
}
__name(courseReportRecordKey, "courseReportRecordKey");
__name2(courseReportRecordKey, "courseReportRecordKey");
async function readCourseReportCount(boards, key) {
  const raw = await boards.get(key);
  if (typeof raw !== "string" || !raw) return 0;
  return clampCount(raw);
}
__name(readCourseReportCount, "readCourseReportCount");
__name2(readCourseReportCount, "readCourseReportCount");
function courseReportCounterTtl(now) {
  return Math.max(60, retryAfterFor("course_report", now));
}
__name(courseReportCounterTtl, "courseReportCounterTtl");
__name2(courseReportCounterTtl, "courseReportCounterTtl");
async function courseReportRateLimit(boards, env, request, installId, now, cors, scope = "") {
  const limits = readCourseReportLimits(env);
  const day = now.toISOString().slice(0, 10);
  const ipHash = await readIpHash(request);
  const ipKey = ipHash ? `cr:n:${scope}ip:${ipHash}:${day}` : null;
  const devKey = installId ? `cr:n:${scope}dev:${installId}:${day}` : null;
  const ipCount = ipKey ? await readCourseReportCount(boards, ipKey) : 0;
  const devCount = devKey ? await readCourseReportCount(boards, devKey) : 0;
  if (ipKey && ipCount >= limits.ipDay || devKey && devCount >= limits.deviceDay) {
    const retryAfter = String(retryAfterFor("course_report", now));
    return {
      limited: true,
      response: golfJson(429, { error: "rate_limited" }, cors, { "Retry-After": retryAfter })
    };
  }
  return {
    limited: false,
    async commit() {
      const ttl = courseReportCounterTtl(now);
      if (ipKey) await putCounter(boards, ipKey, String(ipCount + 1), { expirationTtl: ttl });
      if (devKey) await putCounter(boards, devKey, String(devCount + 1), { expirationTtl: ttl });
    }
  };
}
__name(courseReportRateLimit, "courseReportRateLimit");
__name2(courseReportRateLimit, "courseReportRateLimit");
function readReportLimit(raw) {
  if (raw == null || raw === "") return 100;
  if (!/^\d+$/.test(raw)) return 100;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 100;
  return Math.min(500, parsed);
}
__name(readReportLimit, "readReportLimit");
__name2(readReportLimit, "readReportLimit");
function canonicalSince(raw) {
  if (raw == null || raw === "") return { ok: true, iso: null };
  if (!isIsoDateTime(raw)) return { ok: false };
  return { ok: true, iso: new Date(Date.parse(raw)).toISOString() };
}
__name(canonicalSince, "canonicalSince");
__name2(canonicalSince, "canonicalSince");
function parseStoredReport(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
__name(parseStoredReport, "parseStoredReport");
__name2(parseStoredReport, "parseStoredReport");
function readKnownFilter(raw, allowed) {
  if (raw == null || raw === "") return { ok: true, value: null };
  if (!allowed.has(raw)) return { ok: false };
  return { ok: true, value: raw };
}
__name(readKnownFilter, "readKnownFilter");
__name2(readKnownFilter, "readKnownFilter");
function reportMatchesFilters(record, { courseId, reason, status }) {
  if (courseId && record.courseId !== courseId) return false;
  if (reason && !(Array.isArray(record.reasons) && record.reasons.includes(reason))) return false;
  if (status && !(isPlainObject(record.review) && record.review.status === status)) return false;
  return true;
}
__name(reportMatchesFilters, "reportMatchesFilters");
__name2(reportMatchesFilters, "reportMatchesFilters");
async function listCourseReports(boards, { sinceIso, courseId, reason, status, limit, cursor }) {
  let pageCursor = cursor || void 0;
  for (let hop = 0; hop < 20; hop++) {
    const page = await boards.list({
      prefix: "cr:r:",
      limit,
      ...pageCursor ? { cursor: pageCursor } : {}
    });
    const keys = (page && Array.isArray(page.keys) ? page.keys : []).map((entry) => entry && typeof entry.name === "string" ? entry.name : null).filter(Boolean).sort();
    const complete = !page || page.list_complete !== false || !page.cursor;
    const last = keys[keys.length - 1];
    if (sinceIso && last && last < `cr:r:${sinceIso}` && !complete) {
      pageCursor = page.cursor;
      continue;
    }
    const reports = [];
    for (const name of keys) {
      if (sinceIso && name < `cr:r:${sinceIso}`) continue;
      const record = parseStoredReport(await boards.get(name));
      if (!record) continue;
      if (!reportMatchesFilters(record, { courseId, reason, status })) continue;
      reports.push(record);
    }
    const capped = reports.slice(0, limit);
    return { reports: capped, cursor: complete ? null : page.cursor || null };
  }
  return { reports: [], cursor: pageCursor || null };
}
__name(listCourseReports, "listCourseReports");
__name2(listCourseReports, "listCourseReports");
async function readCourseReportPayload(request, cors) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > COURSE_REPORT_BODY_MAX) {
    return { ok: false, response: golfJson(413, { error: "too_large" }, cors) };
  }
  const raw = await request.text();
  if (utf8ByteLength(raw) > COURSE_REPORT_BODY_MAX) {
    return { ok: false, response: golfJson(413, { error: "too_large" }, cors) };
  }
  try {
    return { ok: true, payload: JSON.parse(raw) };
  } catch {
    return { ok: false, response: golfJson(400, { error: "invalid_json" }, cors) };
  }
}
__name(readCourseReportPayload, "readCourseReportPayload");
__name2(readCourseReportPayload, "readCourseReportPayload");
function scorecardPhotoKey(photoId) {
  return `${SCORECARD_PHOTO_PREFIX}${photoId}`;
}
__name(scorecardPhotoKey, "scorecardPhotoKey");
__name2(scorecardPhotoKey, "scorecardPhotoKey");
function stripJpegMetadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) return null;
  const out = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 255) return null;
    while (i < bytes.length && bytes[i] === 255) i++;
    if (i >= bytes.length) return null;
    const marker = bytes[i];
    i++;
    if (marker === 217) return null;
    if (marker === 1 || marker >= 208 && marker <= 215) {
      out.push(Uint8Array.of(255, marker));
      continue;
    }
    if (i + 2 > bytes.length) return null;
    const length = bytes[i] << 8 | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) return null;
    if (marker === 218) {
      out.push(bytes.subarray(i - 2, bytes.length));
      break;
    }
    const drop = marker === 225 || marker === 237 || marker === 254;
    if (!drop) out.push(bytes.subarray(i - 2, i + length));
    i += length;
    if (i >= bytes.length) return null;
  }
  let total = 0;
  for (const part of out) total += part.length;
  if (total < 4) return null;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of out) {
    joined.set(part, at);
    at += part.length;
  }
  if (joined[total - 2] !== 255 || joined[total - 1] !== 217) return null;
  return joined;
}
__name(stripJpegMetadata, "stripJpegMetadata");
__name2(stripJpegMetadata, "stripJpegMetadata");
async function handleScorecardPhotoPost(request, env, cors) {
  const install = readCourseReportInstallId(request);
  if (!install.ok || !install.id) return golfJson(422, { error: "invalid", field: "installId" }, cors);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SCORECARD_PHOTO_MAX) {
    return golfJson(413, { error: "too_large" }, cors);
  }
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > SCORECARD_PHOTO_MAX) return golfJson(413, { error: "too_large" }, cors);
  if (raw.length < 4 || raw[0] !== 255 || raw[1] !== 216 || raw[2] !== 255) {
    return golfJson(415, { error: "not_jpeg" }, cors);
  }
  const clean = stripJpegMetadata(raw);
  if (!clean) return golfJson(415, { error: "not_jpeg" }, cors);
  const now = /* @__PURE__ */ new Date();
  const rate = await courseReportRateLimit(boards, env, request, install.id, now, cors, "photo:");
  if (rate.limited) return rate.response;
  const photoId = crypto.randomUUID();
  await boards.put(scorecardPhotoKey(photoId), clean, {
    expirationTtl: COURSE_REPORT_TTL,
    metadata: { installId: install.id, bytes: clean.length, uploadedAt: now.toISOString() }
  });
  await rate.commit();
  return golfJson(201, { ok: true, photoId }, cors);
}
__name(handleScorecardPhotoPost, "handleScorecardPhotoPost");
__name2(handleScorecardPhotoPost, "handleScorecardPhotoPost");
async function handleScorecardPhotoGet(request, env, cors, photoId) {
  const denied = await authorizeCourseReports(request, env, cors);
  if (denied) return denied;
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  const found = await boards.getWithMetadata(scorecardPhotoKey(photoId), "arrayBuffer");
  if (!found || found.value == null) return golfJson(404, { error: "not_found" }, cors);
  return new Response(found.value, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
__name(handleScorecardPhotoGet, "handleScorecardPhotoGet");
__name2(handleScorecardPhotoGet, "handleScorecardPhotoGet");
async function deleteScorecardPhoto(boards, photoId) {
  if (!boards || typeof boards.delete !== "function" || !photoId) return;
  await boards.delete(scorecardPhotoKey(photoId));
}
__name(deleteScorecardPhoto, "deleteScorecardPhoto");
__name2(deleteScorecardPhoto, "deleteScorecardPhoto");
async function handleCourseReportPost(request, env, cors) {
  const body = await readCourseReportPayload(request, cors);
  if (!body.ok) return body.response;
  const payload = body.payload;
  const parsed = parseCourseReport(payload);
  if (!parsed.ok) return golfJson(422, { error: "invalid", field: parsed.field }, cors);
  const install = readCourseReportInstallId(request);
  if (!install.ok) return golfJson(422, { error: "invalid", field: "installId" }, cors);
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  const clientReportId = parsed.record.clientReportId;
  const markerKey = courseReportMarkerKey(clientReportId);
  const existing = await boards.get(markerKey);
  if (existing != null) {
    return golfJson(200, { ok: true, id: clientReportId, duplicate: true }, cors);
  }
  if (parsed.record.photoId) {
    const photo = await boards.getWithMetadata(scorecardPhotoKey(parsed.record.photoId), "arrayBuffer");
    const owner = photo && photo.metadata && photo.metadata.installId;
    if (!photo || photo.value == null || install.id && owner && owner !== install.id) {
      return golfJson(422, { error: "invalid", field: "photoId" }, cors);
    }
  }
  const now = /* @__PURE__ */ new Date();
  const rate = await courseReportRateLimit(boards, env, request, install.id, now, cors);
  if (rate.limited) return rate.response;
  const receivedAt = now.toISOString();
  const recordKey = courseReportRecordKey(receivedAt, clientReportId);
  const record = {
    ...parsed.record,
    receivedAt,
    installId: install.id
  };
  const country = readRequestCountry(request);
  if (country) record.country = country;
  await boards.put(recordKey, JSON.stringify(record), { expirationTtl: COURSE_REPORT_TTL });
  await boards.put(markerKey, recordKey, { expirationTtl: COURSE_REPORT_TTL });
  if (parsed.contributorEmail && contributionEmailWithinCap(record.createdAt, now)) {
    await boards.put(courseReportEmailKey(clientReportId), parsed.contributorEmail, {
      expirationTtl: COURSE_REPORT_EMAIL_TTL
    });
  }
  await rate.commit();
  return golfJson(201, { ok: true, id: clientReportId }, cors);
}
__name(handleCourseReportPost, "handleCourseReportPost");
__name2(handleCourseReportPost, "handleCourseReportPost");
async function readContributionEmail(boards, clientReportId) {
  const raw = await boards.get(courseReportEmailKey(clientReportId));
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  if (!email || email.length > 254 || !COURSE_REPORT_EMAIL_RE.test(email)) return null;
  return email;
}
__name(readContributionEmail, "readContributionEmail");
__name2(readContributionEmail, "readContributionEmail");
async function deleteContributionEmail(boards, clientReportId) {
  if (!boards || typeof boards.delete !== "function") return;
  await boards.delete(courseReportEmailKey(clientReportId));
}
__name(deleteContributionEmail, "deleteContributionEmail");
__name2(deleteContributionEmail, "deleteContributionEmail");
async function presentCourseReport(boards, record) {
  if (!isPlainObject(record) || !isPlainObject(record.contribution)) return record;
  const contribution = { ...record.contribution };
  delete contribution.contributorEmail;
  if (contribution.hadEmail === true) {
    const email = await readContributionEmail(boards, record.clientReportId);
    if (email) contribution.contributorEmail = email;
  }
  return { ...record, contribution };
}
__name(presentCourseReport, "presentCourseReport");
__name2(presentCourseReport, "presentCourseReport");
async function loadCourseReport(boards, clientReportId) {
  const marker = await boards.get(courseReportMarkerKey(clientReportId));
  if (typeof marker !== "string" || !marker.startsWith("cr:r:")) return null;
  const record = parseStoredReport(await boards.get(marker));
  if (!record) return null;
  return { key: marker, record };
}
__name(loadCourseReport, "loadCourseReport");
__name2(loadCourseReport, "loadCourseReport");
async function handleCourseReportGetOne(boards, clientReportId, cors) {
  const loaded = await loadCourseReport(boards, clientReportId);
  if (!loaded) return golfJson(404, { error: "not_found" }, cors);
  return golfJson(200, await presentCourseReport(boards, loaded.record), cors);
}
__name(handleCourseReportGetOne, "handleCourseReportGetOne");
__name2(handleCourseReportGetOne, "handleCourseReportGetOne");
async function handleCourseReportsGet(request, url, env, cors, clientReportId) {
  const denied = await authorizeCourseReports(request, env, cors);
  if (denied) return denied;
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  if (clientReportId) return handleCourseReportGetOne(boards, clientReportId, cors);
  if (typeof boards.list !== "function") return golfJson(503, { error: "boards_not_configured" }, cors);
  const since = canonicalSince(url.searchParams.get("since"));
  if (!since.ok) return golfJson(422, { error: "invalid", field: "since" }, cors);
  const reason = readKnownFilter(url.searchParams.get("reason"), COURSE_REPORT_REASONS);
  if (!reason.ok) return golfJson(422, { error: "invalid", field: "reason" }, cors);
  const status = readKnownFilter(url.searchParams.get("status"), REVIEW_STATUSES);
  if (!status.ok) return golfJson(422, { error: "invalid", field: "status" }, cors);
  const courseId = url.searchParams.get("courseId");
  const listed = await listCourseReports(boards, {
    sinceIso: since.iso,
    courseId: courseId ? courseId : null,
    reason: reason.value,
    status: status.value,
    limit: readReportLimit(url.searchParams.get("limit")),
    cursor: url.searchParams.get("cursor")
  });
  const reports = [];
  for (const record of listed.reports) reports.push(await presentCourseReport(boards, record));
  return golfJson(200, { reports, cursor: listed.cursor }, cors);
}
__name(handleCourseReportsGet, "handleCourseReportsGet");
__name2(handleCourseReportsGet, "handleCourseReportsGet");
function decodeCourseReportId(raw) {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return validClientReportId(id) ? id : null;
}
__name(decodeCourseReportId, "decodeCourseReportId");
__name2(decodeCourseReportId, "decodeCourseReportId");
function courseReportRoute(pathname) {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/v1/course-reports") return { ok: true, id: null, action: null };
  const rest = path.slice("/v1/course-reports/".length);
  if (!rest) return { ok: false };
  const parts = rest.split("/");
  if (parts[0] === "scorecard-photo") {
    if (parts.length === 1) return { ok: true, id: null, action: "photo" };
    if (parts.length === 2) {
      const photoId = decodeCourseReportId(parts[1]);
      if (!photoId) return { ok: false };
      return { ok: true, id: photoId.toLowerCase(), action: "photo-get" };
    }
    return { ok: false };
  }
  if (parts.length === 1) {
    const id = decodeCourseReportId(parts[0]);
    if (!id) return { ok: false };
    return { ok: true, id, action: null };
  }
  if (parts.length === 2 && parts[1] === "review") {
    const id = decodeCourseReportId(parts[0]);
    if (!id) return { ok: false };
    return { ok: true, id, action: "review" };
  }
  return { ok: false };
}
__name(courseReportRoute, "courseReportRoute");
__name2(courseReportRoute, "courseReportRoute");
function parseCourseReportReview(payload) {
  if (!isPlainObject(payload)) return invalidField("body");
  if (typeof payload.status !== "string" || !REVIEW_DECISIONS.has(payload.status)) {
    return invalidField("status");
  }
  const decision = { ok: true, status: payload.status, noteSet: false, note: null };
  if (!Object.prototype.hasOwnProperty.call(payload, "note")) return decision;
  if (payload.note == null) {
    decision.noteSet = true;
    return decision;
  }
  if (typeof payload.note !== "string") return invalidField("note");
  const note = payload.note.trim();
  if (note.length > 500) return invalidField("note");
  decision.noteSet = true;
  decision.note = note.length ? note : null;
  return decision;
}
__name(parseCourseReportReview, "parseCourseReportReview");
__name2(parseCourseReportReview, "parseCourseReportReview");
function reviewTransitionAllowed(current, next) {
  if (current === "pending") return next === "approved" || next === "rejected";
  if (current === "approved") return next === "used";
  if (current === "used") return next === "rewarded";
  return false;
}
__name(reviewTransitionAllowed, "reviewTransitionAllowed");
__name2(reviewTransitionAllowed, "reviewTransitionAllowed");
function dropStoredContributorEmail(record) {
  if (!isPlainObject(record.contribution)) return;
  if (typeof record.contribution.contributorEmail === "string" && record.contribution.contributorEmail) {
    record.contribution.hadEmail = true;
  }
  delete record.contribution.contributorEmail;
}
__name(dropStoredContributorEmail, "dropStoredContributorEmail");
__name2(dropStoredContributorEmail, "dropStoredContributorEmail");
function applyCourseReportReview(record, decision, nowIso) {
  const previous = isPlainObject(record.review) ? record.review : {};
  const review = {
    status: decision.status,
    reviewedAt: previous.reviewedAt ?? null,
    note: previous.note ?? null,
    usedAt: previous.usedAt ?? null,
    rewardedAt: previous.rewardedAt ?? null
  };
  if (decision.status === "approved" || decision.status === "rejected") {
    review.reviewedAt = nowIso;
  }
  if (decision.status === "used") review.usedAt = nowIso;
  if (decision.status === "rewarded") review.rewardedAt = nowIso;
  if (decision.noteSet) review.note = decision.note;
  record.review = review;
  if (decision.status === "rejected" || decision.status === "rewarded") {
    dropStoredContributorEmail(record);
  }
  return record;
}
__name(applyCourseReportReview, "applyCourseReportReview");
__name2(applyCourseReportReview, "applyCourseReportReview");
async function handleCourseReportReview(request, env, cors, clientReportId) {
  const denied = await authorizeCourseReports(request, env, cors);
  if (denied) return denied;
  const boards = boardsBinding(env);
  if (!boards) return golfJson(503, { error: "boards_not_configured" }, cors);
  const body = await readCourseReportPayload(request, cors);
  if (!body.ok) return body.response;
  const decision = parseCourseReportReview(body.payload);
  if (!decision.ok) return golfJson(422, { error: "invalid", field: decision.field }, cors);
  const loaded = await loadCourseReport(boards, clientReportId);
  if (!loaded) return golfJson(404, { error: "not_found" }, cors);
  const current = isPlainObject(loaded.record.review) ? loaded.record.review.status : null;
  if (!reviewTransitionAllowed(current, decision.status)) {
    return golfJson(409, { error: "invalid_transition" }, cors);
  }
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const emailOnFile = decision.status === "used" ? await readContributionEmail(boards, clientReportId) : null;
  const record = applyCourseReportReview(loaded.record, decision, nowIso);
  if (decision.status === "used" && emailOnFile) record.rewardEligible = true;
  await boards.put(loaded.key, JSON.stringify(record), { expirationTtl: COURSE_REPORT_TTL });
  if (decision.status === "rejected" || decision.status === "rewarded") {
    await deleteContributionEmail(boards, clientReportId);
    if (record.photoId) {
      await deleteScorecardPhoto(boards, record.photoId);
      record.photoDeleted = true;
      await boards.put(loaded.key, JSON.stringify(record), { expirationTtl: COURSE_REPORT_TTL });
    }
  }
  return golfJson(200, await presentCourseReport(boards, record), cors);
}
__name(handleCourseReportReview, "handleCourseReportReview");
__name2(handleCourseReportReview, "handleCourseReportReview");
async function handleCourseReports(request, url, env, cors) {
  const parsed = courseReportRoute(url.pathname);
  if (!parsed.ok) return golfJson(404, { error: "unknown_route" }, cors);
  if (parsed.action === "photo") {
    if (request.method === "POST") return handleScorecardPhotoPost(request, env, cors);
    return golfJson(405, { error: "method_not_allowed" }, cors);
  }
  if (parsed.action === "photo-get") {
    if (request.method === "GET") return handleScorecardPhotoGet(request, env, cors, parsed.id);
    return golfJson(405, { error: "method_not_allowed" }, cors);
  }
  if (request.method === "GET") {
    if (parsed.action) return golfJson(405, { error: "method_not_allowed" }, cors);
    return handleCourseReportsGet(request, url, env, cors, parsed.id);
  }
  if (request.method === "POST" && parsed.action === "review") {
    return handleCourseReportReview(request, env, cors, parsed.id);
  }
  if (request.method === "POST" && parsed.id == null) return handleCourseReportPost(request, env, cors);
  return golfJson(405, { error: "method_not_allowed" }, cors);
}
__name(handleCourseReports, "handleCourseReports");
__name2(handleCourseReports, "handleCourseReports");
function corsHeaders(pathname) {
  const courseReports = isCourseReportPath(pathname);
  const headers = {
    "Access-Control-Allow-Methods": courseReports ? "GET,POST,OPTIONS" : "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": courseReports ? "Content-Type, X-Install-Id, Authorization" : "Content-Type, X-Install-Id"
  };
  if (!pathname.startsWith("/gca/") && !pathname.startsWith("/golfapi/")) {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}
__name(corsHeaders, "corsHeaders");
__name2(corsHeaders, "corsHeaders");
var worker_default = {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const cors = corsHeaders(requestUrl.pathname);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (requestUrl.pathname === "/meta/golfapi") {
      return handleGolfapiMeta(request, env, cors);
    }
    if (requestUrl.pathname === "/meta/gca") {
      return handleGcaMeta(request, env, cors);
    }
    const golf = await handleGolfProxy(request, env, ctx, cors);
    if (golf) return responseWithoutAllowOrigin(golf);
    const osm = await handleOsmOverlay(request, env, ctx, cors);
    if (osm) return osm;
    const page = await handleLivePage(request, env, {
      loadBoard: /* @__PURE__ */ __name2((code) => {
        if (!isLiveBoardCode(code) || isReservedBoardKey(code) || isPaintKey(code)) return null;
        const boards = env && env.BOARDS;
        return boards && typeof boards.get === "function" ? boards.get(code) : null;
      }, "loadBoard")
    });
    if (page) return page;
    if (isCourseReportPath(requestUrl.pathname)) {
      return handleCourseReports(request, requestUrl, env, cors);
    }
    if (requestUrl.pathname === PAINT_PROMOTE_PATH) {
      return handlePaintPendingPromote(request, env, cors);
    }
    if (requestUrl.pathname.startsWith("/v1/")) {
      return golfJson(404, { error: "unknown_route" }, cors);
    }
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] || "");
    if (!key || key.length > 180) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && isReservedBoardKey(key)) {
      return new Response("bad key", { status: 400, headers: cors });
    }
    const isPaint = isPaintKey(key);
    const ttl = isPaint ? 60 * 60 * 24 * 365 : 60 * 60 * 24 * 7;
    if (request.method === "GET" || request.method === "PUT") {
      const boards = env && env.BOARDS;
      if (!boards || typeof boards.get !== "function" || typeof boards.put !== "function") {
        return golfJson(503, { error: "boards_not_configured" }, cors);
      }
    }
    if (isPaint && (request.method === "GET" || request.method === "PUT")) {
      return handlePaintRoute(request, env, key, ttl, cors);
    }
    if (request.method === "GET") {
      const val = await env.BOARDS.get(key);
      if (!val) return new Response("{}", { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      const body = isPaint ? await paintGetBody(env.BOARDS, key, val) : val;
      return new Response(body, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      if (!body || body.length > 2e4) {
        return new Response("bad body", { status: 400, headers: cors });
      }
      await env.BOARDS.put(key, body, { expirationTtl: ttl });
      return new Response(body, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("no", { status: 405, headers: cors });
  },
  async scheduled(_event, env, _ctx) {
    await drainGolfapiQueue(env || {});
  }
};
export {
  __resetHotfixMemoryForTests,
  __setEmailMessageClassForTests,
  billingPeriod,
  classifyGolfapi,
  coursePointFromBody,
  worker_default as default,
  golfapiBodyHasData,
  guardPaintGreens,
  osmInflight,
  parsePaintKey,
  presentGcaCourseBody,
  promotePendingCourse,
  promotePendingGreen,
  readGolfapiLimits
};

