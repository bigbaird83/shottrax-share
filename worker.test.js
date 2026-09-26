import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { osmInflight } from "./worker.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const PRIMARY = "https://overpass-api.de/api/interpreter";
const MIRROR = "https://overpass.private.coffee/api/interpreter";
const USER_AGENT = "shottracker-worker/1.0 (+https://shottrax-share.bcbaird.workers.dev)";
const COURSE_ID = "2fa21943-abaa-43a4-a90f-cb06c82216b4";
const DATA_KEY = `osm:v1:${COURSE_ID}:33.1941,-93.2077:1800`;
const NONE_KEY = `osm:v1:none:${COURSE_ID}:33.1941,-93.2077:1800`;
const DAY = 60 * 60 * 24;

const MAGNOLIA_BODY =
  '{"version":0.6,"generator":"Overpass","elements":[{"type":"way","id":1,"tags":{"golf":"green","name":"1"},"geometry":[{"lat":33.19,"lon":-93.2}]}],"osm3s":{"copyright":"ODbL"}}';

const MAGNOLIA_QUERY = `[out:json][timeout:25];
(
  way["golf"="green"](around:1800,33.1940935,-93.2077463);
  way["golf"="fairway"](around:1800,33.1940935,-93.2077463);
  way["golf"="tee"](around:1800,33.1940935,-93.2077463);
  way["golf"="hole"](around:1800,33.1940935,-93.2077463);
  way["golf"="bunker"](around:1800,33.1940935,-93.2077463);
  way["golf"="water_hazard"](around:1800,33.1940935,-93.2077463);
  way["golf"="lateral_water_hazard"](around:1800,33.1940935,-93.2077463);
  way["golf"="cartpath"](around:1800,33.1940935,-93.2077463);
  relation["golf"="green"](around:1800,33.1940935,-93.2077463);
  relation["golf"="fairway"](around:1800,33.1940935,-93.2077463);
  relation["golf"="tee"](around:1800,33.1940935,-93.2077463);
  relation["golf"="bunker"](around:1800,33.1940935,-93.2077463);
  relation["golf"="water_hazard"](around:1800,33.1940935,-93.2077463);
  relation["golf"="lateral_water_hazard"](around:1800,33.1940935,-93.2077463);
);
out geom;`;

function overlayUrl(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) search.set(key, String(value));
  }
  const qs = search.toString();
  return `${ORIGIN}/osm/v1/overlay${qs ? `?${qs}` : ""}`;
}

function magnoliaUrl(extra = {}) {
  return overlayUrl({
    courseId: COURSE_ID,
    lat: "33.1940935",
    lng: "-93.2077463",
    radius: "1800",
    ...extra,
  });
}

function postedQuery(init) {
  return new URLSearchParams(init.body).get("data");
}

describe("shottrax-share worker", () => {
  /** @type {Map<string, { value: string, opts?: object }>} */
  let kv;
  /** @type {Map<string, Response>} */
  let edge;
  let env;
  let fetchMock;

  beforeEach(() => {
    osmInflight.clear();
    kv = new Map();
    edge = new Map();
    env = {
      BOARDS: {
        async get(key) {
          const row = kv.get(key);
          return row ? row.value : null;
        },
        async put(key, value, opts) {
          kv.set(key, { value, opts });
        },
      },
      GOLF_COURSES_API_KEY: "gca-secret",
      GOLFAPI_KEY: "golf-secret",
    };
    globalThis.caches = {
      default: {
        async match(request) {
          const found = edge.get(request.url);
          return found ? found.clone() : undefined;
        },
        async put(request, response) {
          edge.set(request.url, response.clone());
        },
      },
    };
    fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    osmInflight.clear();
    vi.unstubAllGlobals();
    delete globalThis.caches;
  });

  async function invoke(url, { method = "GET", body, env: envOverride } = {}) {
    const waits = [];
    const response = await worker.fetch(
      new Request(url, { method, body }),
      envOverride === undefined ? env : envOverride,
      { waitUntil(promise) { waits.push(promise); } },
    );
    await Promise.all(waits);
    return response;
  }

  function mockOverpass(responder) {
    fetchMock.mockImplementation(async (url, init) => responder(String(url), init));
  }

  function overpassOk(body = MAGNOLIA_BODY) {
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  it("rejects bad overlay params with 400 and does not call upstream", async () => {
    const cases = [
      ["missing courseId", { lat: "33", lng: "-93" }],
      ["empty courseId", { courseId: "", lat: "33", lng: "-93" }],
      ["long courseId", { courseId: "a".repeat(129), lat: "33", lng: "-93" }],
      ["courseId slash", { courseId: "abc/def", lat: "33", lng: "-93" }],
      ["courseId space", { courseId: "abc def", lat: "33", lng: "-93" }],
      ["missing lat", { courseId: "abc", lng: "-93" }],
      ["lat high", { courseId: "abc", lat: "90.1", lng: "0" }],
      ["lat low", { courseId: "abc", lat: "-90.1", lng: "0" }],
      ["lng high", { courseId: "abc", lat: "0", lng: "180.1" }],
      ["lng not a number", { courseId: "abc", lat: "0", lng: "nope" }],
      ["radius low", { courseId: "abc", lat: "0", lng: "0", radius: "199" }],
      ["radius high", { courseId: "abc", lat: "0", lng: "0", radius: "2001" }],
      ["radius fraction", { courseId: "abc", lat: "0", lng: "0", radius: "1800.5" }],
    ];
    for (const [label, params] of cases) {
      const response = await invoke(overlayUrl(params));
      expect(response.status, label).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.size).toBe(0);
  });

  it("accepts boundary coordinates and radius", async () => {
    mockOverpass(async () => overpassOk());
    const low = await invoke(overlayUrl({
      courseId: "Ab.9_c:D-e",
      lat: "-90",
      lng: "180",
      radius: "200",
    }));
    expect(low.status).toBe(200);
    const high = await invoke(overlayUrl({
      courseId: "a".repeat(128),
      lat: "90",
      lng: "-180",
      radius: "2000",
    }));
    expect(high.status).toBe(200);
    const omitted = await invoke(overlayUrl({
      courseId: COURSE_ID,
      lat: "33.1940935",
      lng: "-93.2077463",
    }));
    expect(omitted.status).toBe(200);
    expect(postedQuery(fetchMock.mock.calls[2][1])).toContain("around:1800,33.1940935,-93.2077463");
    expect(kv.has(DATA_KEY)).toBe(true);
  });

  it("misses then hits from KV without a second Overpass call", async () => {
    mockOverpass(async (url, init) => {
      expect(url).toBe(PRIMARY);
      expect(init.method).toBe("POST");
      expect(init.headers["User-Agent"]).toBe(USER_AGENT);
      expect(postedQuery(init)).toBe(MAGNOLIA_QUERY);
      expect(postedQuery(init)).not.toContain("node(");
      return overpassOk();
    });

    const url = magnoliaUrl({ data: "[out:json];node(1);out;" });
    const miss = await invoke(url);
    expect(miss.status).toBe(200);
    expect(miss.headers.get("Content-Type")).toBe("application/json");
    expect(miss.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(miss.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await miss.text()).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY)).toMatchObject({
      value: MAGNOLIA_BODY,
      opts: { expirationTtl: 30 * DAY },
    });
    expect(kv.has(NONE_KEY)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    edge.clear();
    const hit = await invoke(url);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await hit.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const nearby = await invoke(overlayUrl({
      courseId: COURSE_ID,
      lat: "33.1940944",
      lng: "-93.2077463",
      radius: "1800",
    }));
    expect(nearby.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await nearby.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves an edge hit without KV or Overpass", async () => {
    mockOverpass(async () => overpassOk());
    const url = magnoliaUrl();
    expect((await invoke(url)).headers.get("X-Overlay-Cache")).toBe("MISS");
    kv.delete(DATA_KEY);
    const hit = await invoke(url);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await hit.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the mirror after 429 and caches that success", async () => {
    mockOverpass(async (url) => {
      if (url === PRIMARY) return new Response("slow down", { status: 429, headers: { "Retry-After": "9" } });
      expect(url).toBe(MIRROR);
      return overpassOk();
    });
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kv.get(DATA_KEY)?.value).toBe(MAGNOLIA_BODY);
  });

  it("returns 503 on 504 and stores nothing", async () => {
    mockOverpass(async (url) => {
      if (url === PRIMARY) {
        return new Response("gateway", { status: 504, headers: { "Retry-After": "45" } });
      }
      return new Response("gateway", { status: 504 });
    });
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream_busy" });
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, MIRROR]);
    expect(kv.size).toBe(0);
    expect(edge.size).toBe(0);
  });

  it("returns 503 on 429 and stores nothing", async () => {
    mockOverpass(async () => new Response("busy", { status: 429 }));
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream_busy" });
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, MIRROR]);
    expect(kv.size).toBe(0);
    expect(edge.size).toBe(0);
  });

  it("treats a remark timeout as failure even when golf elements are present", async () => {
    const body = JSON.stringify({
      remark: 'runtime error: Query timed out in "query" at line 1 after 25 seconds.',
      elements: [{ type: "way", tags: { golf: "green" } }],
    });
    mockOverpass(async (url) => {
      expect(url).toBe(PRIMARY);
      return new Response(body, { status: 200 });
    });
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream_busy" });
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kv.size).toBe(0);
    expect(edge.size).toBe(0);
  });

  it("returns 503 on bad JSON and on network errors and stores nothing", async () => {
    mockOverpass(async () => new Response("not-json", { status: 200 }));
    const bad = await invoke(magnoliaUrl());
    expect(bad.status).toBe(503);
    expect(kv.size).toBe(0);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const down = await invoke(magnoliaUrl());
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "upstream_busy" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => call[0] === PRIMARY)).toBe(true);
    expect(kv.size).toBe(0);
    expect(edge.size).toBe(0);
  });

  it("retries a fast network error once and caches the success", async () => {
    let calls = 0;
    mockOverpass(async () => {
      calls += 1;
      if (calls === 1) throw new Error("reset");
      return overpassOk();
    });
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(calls).toBe(2);
    expect(kv.get(DATA_KEY)?.value).toBe(MAGNOLIA_BODY);
  });

  it("returns 404 for an empty overlay and never a 200", async () => {
    mockOverpass(async () => overpassOk('{"elements":[]}'));
    const first = await invoke(magnoliaUrl());
    expect(first.status).toBe(404);
    expect(await first.json()).toEqual({ error: "no_overlay" });
    expect(first.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.has(DATA_KEY)).toBe(false);
    expect(kv.get(NONE_KEY)).toMatchObject({ value: "1", opts: { expirationTtl: 6 * 60 * 60 } });

    const second = await invoke(magnoliaUrl());
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "no_overlay" });
    expect(second.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    mockOverpass(async () => overpassOk('{"elements":[{"type":"way","tags":{"highway":"service"}}]}'));
    const untagged = await invoke(magnoliaUrl());
    expect(untagged.status).toBe(404);
    expect(await untagged.json()).toEqual({ error: "no_overlay" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never serves a negative marker as overlay data", async () => {
    kv.set(NONE_KEY, { value: MAGNOLIA_BODY });
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_overlay" });
    expect(fetchMock).not.toHaveBeenCalled();

    kv.clear();
    kv.set(DATA_KEY, { value: "1" });
    mockOverpass(async () => overpassOk());
    const repaired = await invoke(magnoliaUrl());
    expect(repaired.status).toBe(200);
    expect(await repaired.text()).toBe(MAGNOLIA_BODY);
  });

  it("collapses concurrent identical misses into one upstream call", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    mockOverpass(async () => {
      await gate;
      return overpassOk();
    });
    const url = magnoliaUrl();
    const first = invoke(url);
    const second = invoke(url);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const states = [left.headers.get("X-Overlay-Cache"), right.headers.get("X-Overlay-Cache")].sort();
    expect(states).toEqual(["HIT", "MISS"]);
    expect(await left.text()).toBe(MAGNOLIA_BODY);
    expect(await right.text()).toBe(MAGNOLIA_BODY);
  });

  it("refuses board GET and PUT for osm: keys", async () => {
    kv.set(DATA_KEY, { value: MAGNOLIA_BODY, opts: { expirationTtl: 30 * DAY } });
    const encoded = `${ORIGIN}/${encodeURIComponent(DATA_KEY)}`;
    const get = await invoke(encoded);
    expect(get.status).toBe(400);
    expect(await get.text()).toBe("bad key");
    const put = await invoke(encoded, { method: "PUT", body: '{"overwrite":true}' });
    expect(put.status).toBe(400);
    expect(await put.text()).toBe("bad key");
    expect(kv.get(DATA_KEY)).toEqual({ value: MAGNOLIA_BODY, opts: { expirationTtl: 30 * DAY } });

    const unbound = await invoke(`${ORIGIN}/osm:secret`, { env: {} });
    expect(unbound.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps board and golf vendor routes working", async () => {
    const put = await invoke(`${ORIGIN}/round1`, { method: "PUT", body: '{"hole":1}' });
    expect(put.status).toBe(200);
    expect(await put.text()).toBe('{"hole":1}');
    expect(kv.get("round1")?.opts).toEqual({ expirationTtl: 7 * DAY });
    const got = await invoke(`${ORIGIN}/round1`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('{"hole":1}');

    await invoke(`${ORIGIN}/id:course`, { method: "PUT", body: '{"paint":1}' });
    expect(kv.get("id:course")?.opts).toEqual({ expirationTtl: 365 * DAY });
    await invoke(`${ORIGIN}/name:magnolia`, { method: "PUT", body: '{"paint":2}' });
    expect(kv.get("name:magnolia")?.opts).toEqual({ expirationTtl: 365 * DAY });

    const missing = await invoke(`${ORIGIN}/missing-board`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("{}");

    const root = await invoke(`${ORIGIN}/`);
    expect(root.status).toBe(400);
    expect(await root.text()).toBe("bad key");

    const post = await invoke(`${ORIGIN}/round1`, { method: "POST", body: "{}" });
    expect(post.status).toBe(405);
    expect(await post.text()).toBe("no");

    const unbound = await invoke(`${ORIGIN}/round1`, { env: {} });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: "boards_not_configured" });

    fetchMock.mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://golfcoursesapi.com/api/v1/courses?q=magnolia");
      expect(init.headers.Authorization).toBe("Bearer gca-secret");
      return new Response('{"courses":[{"id":"m"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const gca = await invoke(`${ORIGIN}/gca/v1/courses?q=magnolia`);
    expect(gca.status).toBe(200);
    expect(await gca.json()).toEqual({ courses: [{ id: "m" }] });
    const gcaHit = await invoke(`${ORIGIN}/gca/v1/courses?q=magnolia`);
    expect(gcaHit.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://golfapi.io/api/v2.3/coordinates/abc");
      expect(init.headers.Authorization).toBe("Bearer golf-secret");
      return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const golfapi = await invoke(`${ORIGIN}/golfapi/v2.3/coordinates/abc`);
    expect(golfapi.status).toBe(200);
    expect(await golfapi.json()).toEqual({ ok: true });

    fetchMock.mockResolvedValue(new Response("nope", { status: 403, headers: { "Content-Type": "text/plain" } }));
    const forbidden = await invoke(`${ORIGIN}/gca/v1/courses/abc`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("nope");

    const unknown = await invoke(`${ORIGIN}/gca/v1/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_route" });

    const unconfigured = await invoke(`${ORIGIN}/golfapi/v2.3/courses`, { env: { BOARDS: env.BOARDS } });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "not_configured" });

    const overlayDown = await invoke(magnoliaUrl(), { env: {} });
    expect(overlayDown.status).toBe(503);
    expect(await overlayDown.json()).toEqual({ error: "boards_not_configured" });

    const overlayPost = await invoke(magnoliaUrl(), { method: "PUT", body: "{}" });
    expect(overlayPost.status).toBe(405);
    expect(await overlayPost.json()).toEqual({ error: "method_not_allowed" });

    const unknownOsm = await invoke(`${ORIGIN}/osm/v1/other`);
    expect(unknownOsm.status).toBe(404);
    expect(await unknownOsm.json()).toEqual({ error: "unknown_route" });

    const options = await invoke(magnoliaUrl(), { method: "OPTIONS" });
    expect(options.status).toBe(200);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
