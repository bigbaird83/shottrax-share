import { describe, expect, it } from "vitest";
import entry from "./entry.js";
import { resetPaintRateForTests } from "./worker.js";

const KEY = "id:course1";

function record(source) {
  return {
    v: 1,
    key: KEY,
    aliases: [],
    source,
    name: "Brittany",
    city: "Rogers",
    numHoles: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    holes: [{ hole: 1, tee: { lat: 33.1, lng: -93.2 }, green: { lat: 33.11, lng: -93.19 } }],
  };
}

function store() {
  const rows = new Map();
  return {
    rows,
    env: {
      BOARDS: {
        async get(key) {
          return rows.has(key) ? rows.get(key) : null;
        },
        async put(key, value) {
          rows.set(key, value);
        },
        async delete(key) {
          rows.delete(key);
        },
        async list() {
          return { keys: [], list_complete: true };
        },
      },
    },
  };
}

async function putPaint(source) {
  resetPaintRateForTests();
  const saved = store();
  const response = await entry.fetch(new Request(`https://shottrax-share.example/${KEY}`, {
    method: "PUT",
    headers: { "X-Install-Id": "install-0001", "Content-Type": "application/json" },
    body: JSON.stringify(record(source)),
  }), saved.env, { waitUntil() {} });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, rows: saved.rows };
}

describe("opengolf paint source", () => {
  it("stores a paint record whose source is opengolf and rejects an unknown source", async () => {
    const stored = await putPaint("opengolf");
    expect(stored.status).toBe(200);
    expect(JSON.parse(stored.rows.get(KEY)).source).toBe("opengolf");

    const rejected = await putPaint("strava");
    expect(rejected.status).toBe(400);
    expect(rejected.json).toEqual({ error: "bad_source" });
    expect(rejected.rows.has(KEY)).toBe(false);
  });
});
