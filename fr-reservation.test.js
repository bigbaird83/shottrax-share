import { describe, expect, it } from "vitest";
import entry from "./entry.js";

function store() {
  const writes = [];
  return {
    writes,
    env: {
      BOARDS: {
        async get() {
          return null;
        },
        async put(key) {
          writes.push(key);
        },
        async delete(key) {
          writes.push(key);
        },
        async list() {
          return { keys: [], list_complete: true };
        },
      },
      GOLFAPI_KV: {
        async get() {
          return null;
        },
        async put(key) {
          writes.push(`kv:${key}`);
        },
      },
      GOLFAPI_KEY: "golf-secret",
    },
  };
}

async function get(path) {
  const saved = store();
  const response = await entry.fetch(new Request(`https://shottrax-share.example${path}`, {
    headers: { "X-Install-Id": "install-0001" },
  }), saved.env, { waitUntil() {} });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    json,
    writes: saved.writes,
    origin: response.headers.get("Access-Control-Allow-Origin"),
  };
}

describe("fr: golfapi reservation", () => {
  it("rejects an fr: course, coordinates id, or search before the proxy", async () => {
    const course = await get("/golfapi/v2.3/courses/fr%3Asecret");
    expect(course.status).toBe(404);
    expect(course.json).toEqual({ error: "unknown_route" });
    expect(course.origin).toBeNull();
    expect(course.writes).toEqual([]);

    const nested = await get("/golfapi/v2.3/courses/fr%253Asecret");
    expect(nested.status).toBe(404);
    expect(nested.json).toEqual({ error: "unknown_route" });
    expect(nested.writes).toEqual([]);

    const coords = await get("/golfapi/v2.3/coordinates/fr%3Asecret");
    expect(coords.status).toBe(404);
    expect(coords.json).toEqual({ error: "unknown_route" });
    expect(coords.writes).toEqual([]);

    const search = await get(`/golfapi/v2.3/courses?name=${encodeURIComponent("fr:secret")}`);
    expect(search.status).toBe(404);
    expect(search.json).toEqual({ error: "unknown_route" });
    expect(search.writes).toEqual([]);

    const plain = await get("/golfapi/v2.3/courses/14322");
    expect(plain.status).not.toBe(404);
    expect(plain.json).not.toEqual({ error: "unknown_route" });
  });
});
