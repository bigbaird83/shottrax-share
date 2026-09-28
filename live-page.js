/**
 * Live board web page.
 *
 *   GET /s/{code}   HTML page anyone can open in a browser, no app needed
 *
 * The page shows the board the app PUTs to `/{code}` in BOARDS. It renders
 * once here, so Messages / WhatsApp link previews show the course and score,
 * then polls `GET /{code}` (same origin) every LIVE_BOARD_POLL_MS until the
 * round is final. Scores only: the board has no GPS and the page never asks
 * for location.
 *
 * Only real board codes render: six characters from the app's code alphabet
 * (newShareBoardCode in ShotTraxx src/domain/liveBoard.ts). Anything else under
 * /s/ is a 404 page, and worker.js also refuses reserved BOARDS keys, so the
 * page can never show overlay, course-store, GCA, or golfapi counter data.
 *
 * STORE_LIVE (Worker var, default off): "true" once ShotTraxx™ is live in the
 * App Store. Off hides the Safari App Store banner, the "Track your own round"
 * card, and the trial line. "Open in ShotTraxx™" shows either way.
 */

export const APP_STORE_ID = "6812944398";
/** Same as LIVE_BOARD_POLL_MS in ShotTraxx src/domain/liveBoard.ts. */
export const LIVE_BOARD_POLL_MS = 8000;

const LIVE_PAGE_PREFIX = "/s/";
const BOARD_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

// ---------------------------------------------------------------------------
// Pure helpers. Everything in BROWSER_HELPERS also runs in the browser
// (serialized with Function#toString), so each one uses only the others and
// plain JS: no imports, no closures over module state.
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/[<]/g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same rules as normalizeShareBoardCode in ShotTraxx src/domain/liveBoard.ts. */
function normalizeCode(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  let core = trimmed;
  try {
    core = decodeURIComponent(core);
  } catch (err) {
    // Keep the raw segment.
  }
  const compact = core.trim().replace(/[\s-]+/g, "");
  if (!compact) return null;
  if (compact.length <= 8) return compact.toUpperCase();
  return core.trim();
}

/** True only for a six-character board code the app can mint. */
export function isLiveBoardCode(code) {
  return typeof code === "string" && BOARD_CODE_RE.test(code);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The board as the app PUT it, or wrapped (`{ payload }`, `{ data }`,
 * `{ value }`, `{ board }`, or a JSON string). Same unwrapping as
 * parseSharedBoardBody in ShotTraxx src/domain/shareBoardSync.ts.
 * Anything without a `holes` array → null.
 */
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
    if (inner === undefined) return null;
    value = inner;
  }
  if (value == null || typeof value !== "object" || !Array.isArray(value.holes)) return null;
  const holes = value.holes
    .filter((row) => row && typeof row === "object" && num(row.hole) != null)
    .map((row) => ({
      hole: row.hole,
      par: num(row.par),
      score: num(row.score),
      putts: num(row.putts),
      startedAt: str(row.startedAt),
      completedAt: str(row.completedAt),
    }))
    .sort((a, b) => a.hole - b.hole);
  const live =
    value.live && typeof value.live === "object" && num(value.live.hole) != null
      ? { hole: value.live.hole, lastClubYards: str(value.live.lastClubYards) }
      : null;
  let group = null;
  if (value.group && typeof value.group === "object" && Array.isArray(value.group.players)) {
    const players = value.group.players
      .filter((p) => p && typeof p === "object" && str(p.name))
      .map((p) => ({
        name: p.name,
        handicap: num(p.handicap),
        holes: Array.isArray(p.holes)
          ? p.holes.filter((h) => h && num(h.hole) != null).map((h) => ({ hole: h.hole, score: num(h.score) }))
          : [],
        out: num(p.out),
        in: num(p.in),
        total: num(p.total),
      }));
    const results = Array.isArray(value.group.results)
      ? value.group.results
          .filter((r) => r && str(r.title) && Array.isArray(r.lines))
          .map((r) => ({ title: r.title, lines: r.lines.filter((line) => typeof line === "string") }))
      : [];
    if (players.length > 0) group = { players, results };
  }
  return {
    courseName: str(value.courseName),
    finished: value.finished === true,
    live,
    holes,
    updatedAt: str(value.updatedAt),
    group,
  };
}

function timeMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** "42m", "1h 05m". Same as formatPaceDuration in ShotTraxx src/domain/livePace.ts. */
function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h === 0 ? m + "m" : h + "h " + String(m).padStart(2, "0") + "m";
}

/** Wall clock in the viewer's browser, e.g. "2:05 PM". */
function formatClock(iso) {
  const ms = timeMs(iso);
  if (ms == null) return "—";
  const d = new Date(ms);
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ":" + String(d.getMinutes()).padStart(2, "0") + " " + (h24 < 12 ? "AM" : "PM");
}

/** Thru / elapsed / time left. Same math as planLivePace + formatLivePaceLine. */
function paceLine(holes, nowMs, finished) {
  const holeCount = holes.length;
  const thru = holes.filter((row) => row.completedAt != null || row.score != null).length;
  const allDone = finished === true || (holeCount > 0 && thru >= holeCount);
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
  return { thru, holeCount, allDone, line: parts.join(" · ") };
}

/** Posted total, and to-par only when every scored hole has a par. Same as planLiveScoreTotals. */
function scoreTotals(holes) {
  const scored = holes.filter((row) => row.score != null);
  if (scored.length === 0) return { total: null, toPar: null };
  const total = scored.reduce((sum, row) => sum + row.score, 0);
  const parKnown = scored.every((row) => row.par != null);
  const toPar = parKnown ? scored.reduce((sum, row) => sum + row.score - row.par, 0) : null;
  return { total, toPar };
}

function formatToPar(toPar) {
  if (toPar == null) return null;
  if (toPar === 0) return "E";
  return toPar > 0 ? "+" + toPar : String(toPar);
}

/** Everything the page and the link preview show. Never invents a par or a score. */
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
    group: board.group,
  };
}

/** One line for link previews: "+3 thru 12 · On hole 13". */
function previewLine(view) {
  if (!view) return "Follow this round live, hole by hole.";
  const parts = [];
  const score = view.toPar ?? (view.total != null ? String(view.total) : null);
  if (view.finished) parts.push(score ? "Final: " + score : "Final");
  else if (score) parts.push(score + " thru " + view.thru);
  else parts.push("Live now");
  if (view.onHole != null) parts.push("On hole " + view.onHole);
  return parts.join(" · ");
}

function scoreClass(score, par) {
  if (score == null || par == null) return "";
  const diff = score - par;
  if (diff <= -2) return " s-eagle";
  if (diff === -1) return " s-birdie";
  if (diff === 1) return " s-bogey";
  if (diff >= 2) return " s-double";
  return "";
}

function groupCell(score) {
  return score != null && score >= 1 ? String(score) : "—";
}

/** Board markup. `clock` formats an ISO time; the Worker passes a blank one (it has no viewer time zone). */
function renderBoard(view, clock) {
  if (!view) {
    return (
      '<section class="empty"><p class="kicker">Live board</p>' +
      "<h1>Waiting for the first hole</h1>" +
      '<p class="muted">This board has no scores yet, or it has ended. It refreshes on its own.</p></section>'
    );
  }
  let html = '<section class="head">';
  html += '<p class="kicker' + (view.finished ? "" : " live") + '">' + esc(view.kicker) + "</p>";
  html += "<h1>" + esc(view.courseName) + "</h1>";
  html += '<p class="total">' + (view.total == null ? "—" : esc(view.total));
  if (view.toPar) html += ' <span class="topar">' + esc(view.toPar) + "</span>";
  html += "</p>";
  html += '<p class="pace">' + esc(view.pace) + "</p>";
  if (view.onHole != null) {
    html += '<p class="muted">On hole ' + esc(view.onHole);
    if (view.lastClubYards) html += " · Last: " + esc(view.lastClubYards);
    html += "</p>";
  }
  html += "</section>";

  if (view.group && view.group.players.length > 1) {
    const holeSet = new Set();
    for (const p of view.group.players) for (const h of p.holes) holeSet.add(h.hole);
    const cols = Array.from(holeSet).sort((a, b) => a - b);
    const full = cols.length >= 18;
    html += '<section class="card"><h2>Group</h2><div class="scroll"><table class="group"><thead><tr><th class="name"></th>';
    for (const c of cols) html += "<th>" + esc(c) + "</th>";
    if (full) html += '<th class="sum">Out</th><th class="sum">In</th>';
    html += '<th class="sum">Tot</th></tr></thead><tbody>';
    for (const p of view.group.players) {
      html +=
        '<tr><th class="name">' +
        esc(p.name) +
        (p.handicap != null ? ' <span class="muted">' + esc(p.handicap) + "</span>" : "") +
        "</th>";
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
    html += '<th>Start</th><th>Finish</th></tr></thead><tbody>';
    for (const row of view.holes) {
      const current = view.onHole === row.hole ? ' class="current"' : "";
      html += "<tr" + current + "><td>" + esc(row.hole) + "</td>";
      html += "<td>" + (row.par == null ? "—" : esc(row.par)) + "</td>";
      html += '<td class="score' + scoreClass(row.score, row.par) + '">' + (row.score == null ? "—" : esc(row.score)) + "</td>";
      if (view.showPutts) html += "<td>" + (row.putts == null ? "—" : esc(row.putts)) + "</td>";
      html += '<td class="time">' + esc(clock(row.startedAt)) + "</td>";
      html += '<td class="time">' + esc(clock(row.completedAt)) + "</td></tr>";
    }
    html += "</tbody></table></div></section>";
  }
  if (view.updatedAt) html += '<p class="muted small">Updated ' + esc(clock(view.updatedAt)) + "</p>";
  return html;
}

const BROWSER_HELPERS = [
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
  renderBoard,
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** JSON that is safe inside a <script> element. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

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
if (!first || !first.finished) schedule();`,
  ]
    .join("\n")
    // `</` never appears raw inside the script element. `<\/` means the same in strings and regexes.
    .replace(/<\//g, "<\\/");
}

const THEME_LIGHT = `--bg: #F7F4EC; --surface: #FFFFFF; --ink: #142018; --muted: #5B6B60; --line: #E3DED1;
  --brand: #0B1A12; --brand-ink: #F4F1E8; --accent: #C8F542; --live: #1F9D55;
  --birdie: #1F7A45; --eagle: #0E5A8A; --bogey: #9A5B00; --double: #B3261E;
  color-scheme: light;`;
const THEME_DARK = `--bg: #0B1A12; --surface: #13271B; --ink: #F4F1E8; --muted: #A9B8AD; --line: #24402F;
  --brand: #060F0A; --brand-ink: #F4F1E8; --accent: #C8F542; --live: #5BD68A;
  --birdie: #6FD39A; --eagle: #7CC4F2; --bogey: #F2B45C; --double: #FF8A80;
  color-scheme: dark;`;

const STYLES = `
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

/** STORE_LIVE is on only for "true" / "1" / "yes". Unset, blank, or anything else is off. */
export function storeLive(env) {
  const raw = env && typeof env.STORE_LIVE === "string" ? env.STORE_LIVE.trim().toLowerCase() : "";
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Full HTML page. `board` is parsed (parseBoard) or null for a code with nothing stored yet. */
export function renderLivePage({ code, board, nowMs, storeLive = false, appStoreId = APP_STORE_ID, nonce }) {
  const view = planView(board, nowMs);
  const title = view ? view.kicker + " · " + view.courseName : "Live board · ShotTraxx™";
  const description = previewLine(view);
  const appUrl = "https://apps.apple.com/app/id" + encodeURIComponent(appStoreId);
  const deepLink = "shottrax:///s/" + encodeURIComponent(code);
  const nonceAttr = nonce ? ' nonce="' + esc(nonce) + '"' : "";
  const brand = storeLive
    ? '<a class="brand" href="' + esc(appUrl) + '" aria-label="ShotTraxx on the App Store">ShotTraxx™</a>'
    : '<span class="brand">ShotTraxx™</span>';
  const banner = storeLive
    ? '<meta name="apple-itunes-app" content="app-id=' + esc(appStoreId) + ", app-argument=" + esc(deepLink) + '">\n'
    : "";
  const offer = storeLive
    ? `<section class="cta">
<h2>Track your own round</h2>
<p>ShotTraxx™ marks every shot with your phone's GPS, learns your real club distances, and shows where you lose strokes. Try every Pro feature free for 14 days.</p>
<a class="btn primary" href="${esc(appUrl)}">Get ShotTraxx™ on the App Store</a>
<a class="btn ghost" href="${esc(deepLink)}">Already have it? Open in ShotTraxx™</a>
</section>`
    : `<section class="open"><a class="btn" href="${esc(deepLink)}">Open in ShotTraxx™</a></section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
${banner}<meta property="og:type" content="website">
<meta property="og:site_name" content="ShotTraxx™">
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
<footer class="muted">Board ${esc(code)} · Scores only, no map or location.</footer>
</div>
<script${nonceAttr}>${clientScript(code, board)}</script>
</body>
</html>`;
}

function notFoundPage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live board · ShotTraxx™</title>
<meta name="robots" content="noindex">
<style nonce="${esc(nonce)}">${STYLES}</style>
</head>
<body>
<header class="bar"><div class="wrap"><span class="brand">ShotTraxx™</span></div></header>
<div class="wrap"><main><section class="empty"><p class="kicker">Live board</p>
<h1>That's not a board code</h1>
<p class="muted">Board codes are six letters and numbers. Check the link you were sent.</p></section></main></div>
</body>
</html>`;
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

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
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/** `/s/{code}` → the normalized code when it is a real board code, else null. */
export function livePageCode(pathname) {
  if (!pathname.startsWith(LIVE_PAGE_PREFIX)) return null;
  const segment = pathname.slice(LIVE_PAGE_PREFIX.length).replace(/\/$/, "");
  if (!segment || segment.includes("/")) return null;
  const code = normalizeCode(segment);
  return isLiveBoardCode(code) ? code : null;
}

/**
 * Response for `GET/HEAD /s/…`, or null so the Worker's other routes run.
 * `loadBoard(code)` returns the stored board or null; it is called only with
 * a valid board code. A code with nothing stored yet still gets the page,
 * which polls until the first hole lands.
 */
export async function handleLivePage(request, env, { loadBoard, nowMs } = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(LIVE_PAGE_PREFIX)) return null;
  const nonce = randomNonce();
  const code = livePageCode(pathname);
  if (!code) {
    return new Response(request.method === "HEAD" ? null : notFoundPage(nonce), {
      status: 404,
      headers: pageHeaders(nonce),
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
    appStoreId: (env && typeof env.APP_STORE_ID === "string" && env.APP_STORE_ID.trim()) || APP_STORE_ID,
    nonce,
  });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: pageHeaders(nonce) });
}

export const __test = { normalizeCode, parseBoard, planView, previewLine, renderBoard, clientScript };
