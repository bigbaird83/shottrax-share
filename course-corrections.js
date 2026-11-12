/**
 * GET /v1/course-corrections
 *
 * Hand-checked course pars (and optionally the men's stroke index) that the
 * app applies when a course loads, so a wrong or blank par is fixed without
 * an app build. The data is the checked-in file src/course-corrections.json,
 * so every change is reviewed in git and goes live with a Worker deploy.
 *
 * Document: { v: 1, version: <int>, courses: { "<course id>": {
 *   par: [9 or 18 ints 3..6], strokeIndex?: [1..n, each once],
 *   override?: true, note: "source + date" } } }
 *
 * The app fills only a par that is 0 or missing, unless the entry sets
 * override: true. Bump `version` on every edit; the ETag is the version.
 *
 * Same key as the app's paint and GCA routes: a valid X-Install-Id, or
 * 401 { error: "install_id_required" }.
 */
import COURSE_CORRECTIONS from "./src/course-corrections.json";

export const COURSE_CORRECTIONS_PATH = "/v1/course-corrections";
/** About an hour. Phones also wait 6 hours between launch checks. */
export const COURSE_CORRECTIONS_MAX_AGE = 3600;

const INSTALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
const COURSE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ENTRY_KEYS = new Set(["par", "strokeIndex", "override", "note"]);
const DOC_KEYS = new Set(["v", "version", "courses"]);

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function checkPars(id, par, errors) {
  if (!Array.isArray(par) || (par.length !== 9 && par.length !== 18)) {
    errors.push(`${id} par must list 9 or 18 holes`);
    return;
  }
  par.forEach((value, i) => {
    if (!Number.isInteger(value) || value < 3 || value > 6) {
      errors.push(`${id} par for hole ${i + 1} must be 3..6`);
    }
  });
}

function checkStrokeIndex(id, strokeIndex, holes, errors) {
  if (!Array.isArray(strokeIndex) || strokeIndex.length !== holes) {
    errors.push(`${id} strokeIndex must list ${holes} holes`);
    return;
  }
  const seen = new Set();
  for (const value of strokeIndex) {
    if (!Number.isInteger(value) || value < 1 || value > holes || seen.has(value)) {
      errors.push(`${id} strokeIndex must use 1..${holes} once each`);
      return;
    }
    seen.add(value);
  }
}

/**
 * Every problem in a corrections document. Empty means valid.
 * One bad entry makes the whole document invalid.
 */
export function courseCorrectionsErrors(doc) {
  const errors = [];
  if (!isRecord(doc)) return ["document must be an object"];
  for (const key of Object.keys(doc)) {
    if (!DOC_KEYS.has(key)) errors.push(`unknown key ${key}`);
  }
  if (doc.v !== 1) errors.push("v must be 1");
  if (!Number.isInteger(doc.version) || doc.version < 1) errors.push("version must be a positive integer");
  if (!isRecord(doc.courses)) {
    errors.push("courses must be an object");
    return errors;
  }
  for (const [id, entry] of Object.entries(doc.courses)) {
    if (!COURSE_ID.test(id)) errors.push(`course id ${JSON.stringify(id)} is not valid`);
    if (!isRecord(entry)) {
      errors.push(`${id} must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) errors.push(`${id} has unknown key ${key}`);
    }
    checkPars(id, entry.par, errors);
    if (entry.strokeIndex !== undefined && Array.isArray(entry.par)) {
      checkStrokeIndex(id, entry.strokeIndex, entry.par.length, errors);
    }
    if (entry.override !== undefined && entry.override !== true) {
      errors.push(`${id} override must be true or left out`);
    }
    if (typeof entry.note !== "string" || entry.note.trim() === "") {
      errors.push(`${id} needs a note (source + date)`);
    }
  }
  return errors;
}

export function courseCorrectionsEtag(doc) {
  return `"cc-v${doc.version}"`;
}

function etagMatches(header, etag) {
  if (typeof header !== "string" || header.trim() === "") return false;
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === etag || tag === "*");
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(headers ?? {}) },
  });
}

export function isCourseCorrectionsPath(pathname) {
  return pathname === COURSE_CORRECTIONS_PATH || pathname === `${COURSE_CORRECTIONS_PATH}/`;
}

/**
 * The route. `doc` is only for tests; the live Worker serves the checked-in file.
 * A file that fails validation is never served (503), so phones keep their last good copy.
 */
export function handleCourseCorrections(request, doc = COURSE_CORRECTIONS) {
  const installId = (request.headers.get("X-Install-Id") ?? "").trim();
  if (!INSTALL_ID.test(installId)) return json(401, { error: "install_id_required" });
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
  if (courseCorrectionsErrors(doc).length > 0) return json(503, { error: "not_configured" });
  const etag = courseCorrectionsEtag(doc);
  const headers = {
    ETag: etag,
    "Cache-Control": `private, max-age=${COURSE_CORRECTIONS_MAX_AGE}`,
  };
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  const body = request.method === "HEAD" ? null : JSON.stringify(doc);
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
