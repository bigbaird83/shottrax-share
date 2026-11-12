/**
 * GET /v1/course-corrections and the checked-in src/course-corrections.json.
 * Route checks use MOCK course ids and values; the last block validates the real file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import entry from "./entry.js";
import {
  COURSE_CORRECTIONS_MAX_AGE,
  courseCorrectionsErrors,
  courseCorrectionsEtag,
  handleCourseCorrections,
} from "./course-corrections.js";

const INSTALL = "mock-install-0001";
const FILE = JSON.parse(readFileSync(new URL("./src/course-corrections.json", import.meta.url), "utf8"));

function mockDoc(extra = {}) {
  return {
    v: 1,
    version: 7,
    courses: {
      "local:opengolf:mock-0001": {
        par: [4, 4, 3, 5, 4, 4, 3, 5, 4],
        strokeIndex: [1, 3, 9, 5, 7, 2, 8, 4, 6],
        note: "MOCK card, test, Jan 1 2026",
      },
    },
    ...extra,
  };
}

function get(path, headers = {}) {
  return entry.fetch(new Request(`https://shottrax-share.example${path}`, { headers }), {}, { waitUntil() {} });
}

describe("GET /v1/course-corrections", () => {
  test("returns the checked-in file with its version, an ETag on that version, and about an hour of cache", async () => {
    const res = await get("/v1/course-corrections", { "X-Install-Id": INSTALL });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/json");
    assert.equal(res.headers.get("ETag"), `"cc-v${FILE.version}"`);
    assert.equal(res.headers.get("Cache-Control"), `private, max-age=${COURSE_CORRECTIONS_MAX_AGE}`);
    assert.equal(COURSE_CORRECTIONS_MAX_AGE, 3600);
    const body = await res.json();
    assert.deepEqual(body, FILE);
    assert.equal(body.v, 1);
    assert.ok(Number.isInteger(body.version));
  });

  test("the same ETag is a 304 with no body; a different ETag gets the document", async () => {
    const etag = `"cc-v${FILE.version}"`;
    const same = await get("/v1/course-corrections", { "X-Install-Id": INSTALL, "If-None-Match": etag });
    assert.equal(same.status, 304);
    assert.equal(same.headers.get("ETag"), etag);
    assert.equal(await same.text(), "");
    const older = await get("/v1/course-corrections", { "X-Install-Id": INSTALL, "If-None-Match": '"cc-v0"' });
    assert.equal(older.status, 200);
    assert.deepEqual(await older.json(), FILE);
  });

  test("no key is refused exactly like the app's paint route", async () => {
    const boards = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("no write expected");
      },
      async list() {
        return { keys: [], list_complete: true };
      },
    };
    const corrections = await get("/v1/course-corrections");
    const paint = await entry.fetch(
      new Request("https://shottrax-share.example/id:mock-course", { method: "PUT", body: '{"paint":1}' }),
      { BOARDS: boards },
      { waitUntil() {} },
    );
    assert.equal(corrections.status, 401);
    assert.equal(corrections.status, paint.status);
    assert.deepEqual(await corrections.json(), await paint.json());

    const bad = await get("/v1/course-corrections", { "X-Install-Id": "short" });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: "install_id_required" });
    assert.equal(bad.headers.get("ETag"), null);
  });

  test("only GET and HEAD are served", async () => {
    const res = handleCourseCorrections(
      new Request("https://worker.test/v1/course-corrections", { method: "POST", headers: { "X-Install-Id": INSTALL } }),
      mockDoc(),
    );
    assert.equal(res.status, 405);
  });

  test("a MOCK document is served with its own version as the ETag", async () => {
    const res = handleCourseCorrections(
      new Request("https://worker.test/v1/course-corrections", { headers: { "X-Install-Id": INSTALL } }),
      mockDoc(),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ETag"), '"cc-v7"');
    assert.equal(courseCorrectionsEtag(mockDoc()), '"cc-v7"');
    assert.deepEqual(await res.json(), mockDoc());
  });

  test("an invalid document is never served", async () => {
    const doc = mockDoc();
    doc.courses["local:opengolf:mock-0001"].par[0] = 7;
    const res = handleCourseCorrections(
      new Request("https://worker.test/v1/course-corrections", { headers: { "X-Install-Id": INSTALL } }),
      doc,
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "not_configured" });
  });
});

describe("course corrections validation", () => {
  test("a MOCK 9-hole document passes", () => {
    assert.deepEqual(courseCorrectionsErrors(mockDoc()), []);
  });

  test("par 7, par 2 and a non-integer par fail", () => {
    for (const bad of [7, 2, 4.5, "4", null]) {
      const doc = mockDoc();
      doc.courses["local:opengolf:mock-0001"].par[3] = bad;
      assert.ok(courseCorrectionsErrors(doc).length > 0, `par ${bad} should fail`);
    }
  });

  test("a par list that is not 9 or 18 holes fails", () => {
    const doc = mockDoc();
    doc.courses["local:opengolf:mock-0001"].par.push(4);
    assert.ok(courseCorrectionsErrors(doc).length > 0);
  });

  test("a stroke index that repeats, skips, or has the wrong length fails", () => {
    const repeat = mockDoc();
    repeat.courses["local:opengolf:mock-0001"].strokeIndex[1] = 1;
    assert.ok(courseCorrectionsErrors(repeat).length > 0);
    const outOfRange = mockDoc();
    outOfRange.courses["local:opengolf:mock-0001"].strokeIndex[1] = 10;
    assert.ok(courseCorrectionsErrors(outOfRange).length > 0);
    const short = mockDoc();
    short.courses["local:opengolf:mock-0001"].strokeIndex.pop();
    assert.ok(courseCorrectionsErrors(short).length > 0);
  });

  test("a missing note, a bad version, an override that is not true, or an unknown key fails", () => {
    const noNote = mockDoc();
    delete noNote.courses["local:opengolf:mock-0001"].note;
    assert.ok(courseCorrectionsErrors(noNote).length > 0);
    assert.ok(courseCorrectionsErrors(mockDoc({ version: 0 })).length > 0);
    assert.ok(courseCorrectionsErrors(mockDoc({ version: "2" })).length > 0);
    assert.ok(courseCorrectionsErrors(mockDoc({ v: 2 })).length > 0);
    const falseOverride = mockDoc();
    falseOverride.courses["local:opengolf:mock-0001"].override = false;
    assert.ok(courseCorrectionsErrors(falseOverride).length > 0);
    const extra = mockDoc();
    extra.courses["local:opengolf:mock-0001"].yards = [];
    assert.ok(courseCorrectionsErrors(extra).length > 0);
    assert.ok(courseCorrectionsErrors(mockDoc({ extra: 1 })).length > 0);
  });

  test("override: true passes", () => {
    const doc = mockDoc();
    doc.courses["local:opengolf:mock-0001"].override = true;
    assert.deepEqual(courseCorrectionsErrors(doc), []);
  });
});

describe("src/course-corrections.json", () => {
  test("the checked-in file passes validation", () => {
    assert.deepEqual(courseCorrectionsErrors(FILE), []);
  });

  test("every entry has par 3..6, a stroke index 1..n once each when present, and a note", () => {
    for (const [id, entry] of Object.entries(FILE.courses)) {
      assert.ok(entry.par.length === 9 || entry.par.length === 18, id);
      for (const par of entry.par) assert.ok(Number.isInteger(par) && par >= 3 && par <= 6, id);
      if (entry.strokeIndex) {
        assert.deepEqual([...entry.strokeIndex].sort((a, b) => a - b), entry.par.map((_, i) => i + 1), id);
      }
      assert.ok(entry.note.trim().length > 0, id);
    }
  });

  test("Querbes Park, Shreveport LA is par 71 from the club card", () => {
    const querbes = FILE.courses["local:opengolf:489e906e-6e38-4fed-a232-043803aa8de5"];
    assert.deepEqual(querbes.par, [4, 4, 3, 4, 4, 4, 5, 4, 3, 4, 5, 4, 3, 4, 4, 5, 3, 4]);
    assert.equal(querbes.par.reduce((a, b) => a + b, 0), 71);
    assert.deepEqual(querbes.strokeIndex, [15, 5, 17, 1, 7, 11, 9, 13, 3, 4, 14, 10, 16, 18, 6, 2, 12, 8]);
    assert.equal(querbes.note, "club scorecard, Brian, Nov 12 2026");
    assert.equal(querbes.override, undefined);
  });
});
