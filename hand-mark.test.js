import { beforeEach, describe, expect, it } from "vitest";
import live, {
  __resetHotfixMemoryForTests,
  promotePendingCourse,
  promotePendingGreen,
} from "./live-shottrax-share.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const TOKEN = "admin-token";
const INSTALL = "id_handmark";

function memoryBoards() {
  const kv = new Map();
  const writes = [];
  return {
    kv,
    writes,
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async put(key, value, opts) {
      writes.push(key);
      kv.set(key, { value, opts });
    },
    async delete(key) {
      writes.push(`delete:${key}`);
      kv.delete(key);
    },
  };
}

function boardsEnv(boards, extra = {}) {
  return {
    BOARDS: {
      async get(key) {
        const row = await boards.get(key);
        return row && typeof row === "object" && "value" in row ? row.value : row;
      },
      async put(key, value, opts) {
        return boards.put(key, value, opts);
      },
      async delete(key) {
        return boards.delete(key);
      },
    },
    COURSE_REPORTS_ADMIN_TOKEN: TOKEN,
    ...extra,
  };
}

function point(lat, lng) {
  return { lat, lng };
}

function hole(n, tee, green, extra = {}) {
  return { hole: n, tee, green, ...extra };
}

function paintBody(key, holes, extra = {}) {
  return {
    v: 1,
    key,
    source: extra.source ?? "manual_verified",
    fetchedAt: extra.fetchedAt ?? "2026-10-21T00:00:00.000Z",
    numHoles: extra.numHoles ?? 18,
    aliases: extra.aliases ?? [],
    holes,
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalPoint(value) {
  if (!value || typeof value !== "object") return null;
  if (Number.isFinite(value.lat) && Number.isFinite(value.lng)) return { lat: value.lat, lng: value.lng };
  if (Number.isFinite(value.lat) && Number.isFinite(value.lon)) return { lat: value.lat, lng: value.lon };
  return null;
}

async function changeSha(change) {
  const body = JSON.stringify({
    v: 1,
    courseId: String(change.courseId ?? ""),
    hole: change.hole,
    role: change.role,
    from: canonicalPoint(change.from),
    to: canonicalPoint(change.to),
  });
  return sha256Hex(body);
}

const BRIAN = { name: "Brian", source: "user", account: "bigbaird83" };
const CHIEF = { name: "Chief of Staff", source: "user", account: "chief-of-staff" };
const LEAD = { name: "ShotTraxx Lead", source: "user", account: "shottraxx-lead" };

function raw(boards, key) {
  const row = boards.kv.get(key);
  return row ? row.value : undefined;
}

function stored(boards, key) {
  const text = raw(boards, key);
  return text ? JSON.parse(text) : null;
}

async function putPaint(env, key, body, headers = {}) {
  const response = await live.fetch(new Request(`${ORIGIN}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Id": INSTALL,
      ...headers,
    },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

describe("hand-marked course points", () => {
  let boards;
  let env;

  beforeEach(() => {
    __resetHotfixMemoryForTests();
    boards = memoryBoards();
    env = boardsEnv(boards);
  });

  it("saves a short card with fewer holes than numHoles", async () => {
    const key = "id:shortcard";
    const holes = [1, 2, 3, 4, 5].map((n) => hole(
      n,
      point(34.74 + n * 0.001, -92.28),
      point(34.742 + n * 0.001, -92.278),
    ));
    const body = paintBody(key, holes, { numHoles: 9 });
    const response = await putPaint(env, key, body);
    expect(response.status).toBe(200);
    const saved = stored(boards, key);
    expect(saved.numHoles).toBe(9);
    expect(saved.holes).toHaveLength(5);
    expect(saved.holes.map((row) => row.hole)).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a move of a hand-marked point on an id: key and leaves the record", async () => {
    const key = "id:handgreen";
    const original = hole(1, point(34.74, -92.28), point(34.742, -92.278));
    const created = await putPaint(env, key, paintBody(key, [original]));
    expect(created.status).toBe(200);
    const before = raw(boards, key);
    const moved = hole(1, point(34.74, -92.28), point(34.746, -92.274));
    const response = await putPaint(env, key, paintBody(key, [moved]));
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("no-trustworthy-identity");
    expect(response.json.hole).toBe(1);
    expect(response.json.role).toBe("green");
    expect(raw(boards, key)).toBe(before);
  });

  it("refuses a move of an unknown-source point and of a hand-marked tee on a name: key", async () => {
    const key = "name:magnolia|magnolia|ar";
    boards.kv.set(key, {
      value: JSON.stringify(paintBody(key, [hole(3, point(34.74, -92.28), point(34.742, -92.278))], { source: "club_card" })),
    });
    const before = raw(boards, key);
    const response = await putPaint(env, key, paintBody(key, [hole(3, point(34.745, -92.275), point(34.742, -92.278))]));
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("no-trustworthy-identity");
    expect(response.json.role).toBe("tee");
    expect(raw(boards, key)).toBe(before);
  });

  it("fills a missing green and does not apply X-Paint-Replace over a hand point", async () => {
    const key = "id:fillgreen";
    const kept = hole(1, point(34.74, -92.28), point(34.742, -92.278));
    const blank = hole(2, point(34.743, -92.279), null);
    expect((await putPaint(env, key, paintBody(key, [kept, blank]))).status).toBe(200);
    const filled = hole(2, point(34.743, -92.279), point(34.744, -92.277));
    const response = await putPaint(env, key, paintBody(key, [kept, filled]));
    expect(response.status).toBe(200);
    const saved = stored(boards, key);
    expect(saved.holes.find((row) => row.hole === 1).green).toEqual(kept.green);
    expect(saved.holes.find((row) => row.hole === 2).green).toEqual(filled.green);

    const before = raw(boards, key);
    const replaced = await putPaint(env, key, paintBody(key, [hole(1, point(34.741, -92.279), point(34.748, -92.272))]), {
      "X-Paint-Replace": "1",
    });
    expect(replaced.status).toBe(400);
    expect(replaced.json.error).toBe("no-trustworthy-identity");
    expect(raw(boards, key)).toBe(before);
  });

  it("adds a vendor hole and does not publish a player-only hole or a fr: alias", async () => {
    const idKey = "id:vendorfill";
    const nameKey = "name:vendor|little rock|ar";
    const first = hole(1, point(34.74, -92.28), point(34.742, -92.278));
    const created = await putPaint(env, idKey, paintBody(idKey, [first], {
      source: "osm",
      aliases: [nameKey, "fr:code:AB3K7NP2"],
    }));
    expect(created.status).toBe(200);
    expect(boards.kv.has("fr:code:AB3K7NP2")).toBe(false);
    expect(stored(boards, idKey).aliases).toEqual([nameKey]);
    expect(stored(boards, nameKey).key).toBe(nameKey);
    expect(raw(boards, nameKey)).not.toContain("fr:");

    const vendorHole = hole(2, point(34.743, -92.279), point(34.745, -92.277));
    const added = await putPaint(env, idKey, paintBody(idKey, [first, vendorHole], { source: "osm", aliases: [nameKey] }));
    expect(added.status).toBe(200);
    expect(stored(boards, idKey).holes.map((row) => row.hole)).toEqual([1, 2]);
    expect(stored(boards, nameKey).holes.map((row) => row.hole)).toEqual([1, 2]);

    const before = raw(boards, idKey);
    const playerHole = hole(3, point(34.746, -92.276), point(34.748, -92.274));
    const local = await putPaint(env, idKey, paintBody(idKey, [first, vendorHole, playerHole], {
      source: "manual_verified",
      aliases: [nameKey],
    }));
    expect(local.status).toBe(200);
    expect(stored(boards, idKey).holes.map((row) => row.hole)).toEqual([1, 2]);
    expect(raw(boards, idKey)).toBe(before);
  });

  it("refuses stagedBy on the paint body and an unreadable existing record", async () => {
    const key = "id:staged";
    const body = paintBody(key, [hole(1, point(34.74, -92.28), point(34.742, -92.278))]);
    const staged = await putPaint(env, key, { ...body, stagedBy: "Brian" });
    expect(staged.status).toBe(400);
    expect(staged.json.error).toBe("staged-by-from-request");
    expect(boards.kv.has(key)).toBe(false);

    boards.kv.set(key, { value: "not-json" });
    const broken = await putPaint(env, key, body);
    expect(broken.status).toBe(400);
    expect(broken.json.error).toBe("unreadable-paint-replace");
    expect(raw(boards, key)).toBe("not-json");
  });

  it("does not treat a bearer token as an approver", async () => {
    const key = "id:bearer";
    const pendingKey = `v1:paint-pending:${key}`;
    boards.kv.set(key, {
      value: JSON.stringify(paintBody(key, [hole(1, point(34.74, -92.28), point(34.742, -92.278))])),
    });
    boards.kv.set(pendingKey, {
      value: JSON.stringify({
        key,
        holes: { 1: { green: point(34.746, -92.274), source: "manual_verified" } },
      }),
    });
    const before = raw(boards, key);
    const sha = await changeSha({ courseId: key, hole: 1, role: "green", from: null, to: point(34.746, -92.274) });
    const response = await live.fetch(new Request(`${ORIGIN}/v1/paint-pending/promote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key,
        hole: 1,
        approver: "Brian",
        approval: { approver: "Brian", sha256: sha, useId: "bearer-1", stagedBy: "someone-else" },
      }),
    }), env, { waitUntil() {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "promote-would-move" });
    expect(raw(boards, key)).toBe(before);

    boards.kv.set(key, {
      value: JSON.stringify(paintBody(key, [hole(1, point(34.74, -92.28), null)])),
    });
    const fill = await live.fetch(new Request(`${ORIGIN}/v1/paint-pending/promote`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        hole: 1,
        approval: { approver: "bigbaird83", sha256: sha, useId: "bearer-2", stagedBy: "Brian" },
      }),
    }), env, { waitUntil() {} });
    expect(fill.status).toBe(400);
    expect(await fill.json()).toMatchObject({ error: "no-trustworthy-identity" });
    expect(stored(boards, key).holes[0].green).toBeNull();
  });

  it("lets bigbaird83 self-approve a missing point and refuses a forged approver", async () => {
    const key = "id:self";
    const green = point(34.744, -92.276);
    boards.kv.set(key, { value: JSON.stringify(paintBody(key, [hole(4, point(34.74, -92.28), null)])) });
    boards.kv.set(`v1:paint-pending:${key}`, {
      value: JSON.stringify({ key, holes: { 4: { green, source: "manual_verified" } } }),
    });
    const sha = await changeSha({ courseId: key, hole: 4, role: "green", from: null, to: green });
    const forged = await promotePendingGreen(boardsEnv(boards).BOARDS, key, 4, {
      approval: { approver: "Brian", sha256: sha, useId: "forge-1", stagedBy: "player-1" },
    }, { name: "Chief of Staff", source: "user", account: "chief-of-staff" });
    expect(forged).toMatchObject({ ok: false, error: "approver-not-authenticated" });
    expect(stored(boards, key).holes[0].green).toBeNull();

    const approved = await promotePendingGreen(boardsEnv(boards).BOARDS, key, 4, {
      approval: { approver: "Brian", sha256: sha, useId: "brian-1", stagedBy: "bigbaird83" },
    }, BRIAN);
    expect(approved.ok).toBe(true);
    const saved = stored(boards, key);
    expect(saved.holes[0].green).toEqual(green);
    expect(saved.holes[0].verifiedBy).toBe("Brian");
    expect(JSON.stringify(saved)).not.toMatch(/reward/i);
    expect([...boards.kv.keys()].some((name) => name.startsWith("cr:"))).toBe(false);
  });

  it("lets Chief of Staff and ShotTraxx Lead approve someone else and not themselves", async () => {
    const key = "id:staff";
    const tee = point(34.741, -92.279);
    const green = point(34.744, -92.276);
    boards.kv.set(key, {
      value: JSON.stringify(paintBody(key, [hole(2, null, null)], { aliases: ["name:staff|cabot|ar"] })),
    });
    boards.kv.set(`v1:paint-pending:${key}`, {
      value: JSON.stringify({
        key,
        holes: { 2: { tee, green: { lat: green.lat, lon: green.lng }, source: "manual_verified" } },
      }),
    });
    const teeSha = await changeSha({ courseId: key, hole: 2, role: "tee", from: null, to: tee });
    const greenSha = await changeSha({ courseId: key, hole: 2, role: "green", from: null, to: green });
    const self = await promotePendingGreen(boardsEnv(boards).BOARDS, key, 2, {
      approvals: [
        { hole: 2, role: "tee", approver: "Chief of Staff", sha256: teeSha, useId: "cos-self-tee", stagedBy: "Chief of Staff" },
        { hole: 2, role: "green", approver: "Chief of Staff", sha256: greenSha, useId: "cos-self-green", stagedBy: "Chief of Staff" },
      ],
    }, CHIEF);
    expect(self).toMatchObject({ ok: false, error: "self-approval" });
    expect(stored(boards, key).holes[0].tee).toBeNull();

    const leadSelf = await promotePendingGreen(boardsEnv(boards).BOARDS, key, 2, {
      approvals: [
        { hole: 2, role: "tee", approver: "ShotTraxx Lead", sha256: teeSha, useId: "lead-self", stagedBy: "ShotTraxx Lead" },
      ],
    }, LEAD);
    expect(leadSelf).toMatchObject({ ok: false, error: "self-approval" });

    const approved = await promotePendingCourse(boardsEnv(boards).BOARDS, key, {
      approvals: [
        { hole: 2, role: "tee", approver: "Chief of Staff", sha256: teeSha, useId: "cos-tee", stagedBy: "player-2" },
        { hole: 2, role: "green", approver: "Chief of Staff", sha256: greenSha, useId: "cos-green", stagedBy: "player-2" },
      ],
    }, CHIEF);
    expect(approved).toEqual({ ok: true, promoted: [{ hole: 2, role: "tee" }, { hole: 2, role: "green" }] });
    const saved = stored(boards, key);
    expect(saved.holes[0].tee).toEqual(tee);
    expect(saved.holes[0].green).toEqual(green);
    expect(saved.holes[0].verifiedBy).toBe("Chief of Staff");
    expect(JSON.stringify(saved)).not.toMatch(/reward/i);
    expect(stored(boards, "name:staff|cabot|ar").holes[0].green).toEqual(green);
    expect(boards.kv.has(`v1:paint-pending:${key}`)).toBe(false);
    expect([...boards.kv.keys()].some((name) => String(name).startsWith("fr:"))).toBe(false);
  });

  it("refuses a bad sha, a replay, a top-level stagedBy, and a dismiss that writes nothing", async () => {
    const key = "id:guards";
    const green = point(34.744, -92.276);
    const nameKey = "name:guards|rogers|ar";
    boards.kv.set(key, {
      value: JSON.stringify(paintBody(key, [hole(7, point(34.74, -92.28), null)], { aliases: [nameKey, "fr:round:abc"] })),
    });
    boards.kv.set(`v1:paint-pending:${key}`, {
      value: JSON.stringify({ key, holes: { 7: { green, source: "manual_verified" } } }),
    });
    const sha = await changeSha({ courseId: key, hole: 7, role: "green", from: null, to: green });
    const api = boardsEnv(boards).BOARDS;
    const wrong = await promotePendingGreen(api, key, 7, {
      approval: { approver: "ShotTraxx Lead", sha256: "0".repeat(64), useId: "bad-sha", stagedBy: "player-7" },
    }, LEAD);
    expect(wrong).toMatchObject({ ok: false, error: "wrong-sha" });

    const named = await promotePendingGreen(api, key, 7, {
      stagedBy: "ShotTraxx Lead",
      approval: { approver: "ShotTraxx Lead", sha256: sha, useId: "staged-field", stagedBy: "player-7" },
    }, LEAD);
    expect(named).toMatchObject({ ok: false, error: "staged-by-from-request" });

    const impersonator = await promotePendingGreen(api, key, 7, {
      approval: { approver: "Brian", sha256: sha, useId: "doc-1", stagedBy: "player-7" },
    }, { name: "doc", source: "user", account: "not-brian" });
    expect(impersonator).toMatchObject({ ok: false, error: "brian-name-unauthenticated" });

    const dismissed = await promotePendingGreen(api, key, 7, { dismiss: true }, LEAD);
    expect(dismissed).toEqual({ ok: true, dismissed: true });
    expect(boards.kv.has(`v1:paint-pending:${key}`)).toBe(true);
    expect(stored(boards, key).holes[0].green).toBeNull();

    const first = await promotePendingGreen(api, key, 7, {
      approval: { approver: "ShotTraxx Lead", sha256: sha, useId: "once", stagedBy: "player-7" },
    }, LEAD);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(stored(boards, key))).not.toMatch(/reward/i);
    expect(boards.kv.has("fr:round:abc")).toBe(false);

    const again = point(34.745, -92.275);
    boards.kv.set(key, {
      value: JSON.stringify(paintBody(key, [hole(7, point(34.74, -92.28), null)], { aliases: [nameKey, "fr:round:abc"] })),
    });
    boards.kv.set(`v1:paint-pending:${key}`, {
      value: JSON.stringify({ key, holes: { 7: { green: again, source: "manual_verified" } } }),
    });
    const replaySha = await changeSha({ courseId: key, hole: 7, role: "green", from: null, to: again });
    const before = raw(boards, key);
    const replay = await promotePendingGreen(api, key, 7, {
      approval: { approver: "ShotTraxx Lead", sha256: replaySha, useId: "once", stagedBy: "player-8" },
    }, LEAD);
    expect(replay).toMatchObject({ ok: false, error: "replayed-approval" });
    expect(raw(boards, key)).toBe(before);
    expect(stored(boards, nameKey).holes[0].green).toEqual(green);
  });
});
