import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GCA_CORRECTIONS } from "./gca-corrections.js";
import worker, { osmInflight, presentGcaCourseBody } from "./worker.js";

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const PRIMARY = "https://overpass-api.de/api/interpreter";
const MIRROR = "https://overpass.private.coffee/api/interpreter";
const USER_AGENT = "shottracker-worker/1.0 (+https://shottrax-share.bcbaird.workers.dev)";
const COURSE_ID = "2fa21943-abaa-43a4-a90f-cb06c82216b4";
const DATA_KEY = "osm:v1:33.1941,-93.2077:1800";
const NONE_KEY = "osm:v1:none:33.1941,-93.2077:1800";
const REFRESH_KEY = "osm:v1:refreshing:33.1941,-93.2077:1800";
const INDEX_KEY = "osm:v1:index:33.19,-93.21";
const GCA_ID = "14322";
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
        async getWithMetadata(key) {
          const row = kv.get(key);
          if (!row) return { value: null, metadata: null };
          return { value: row.value, metadata: row.metadata ?? null };
        },
        async put(key, value, opts) {
          kv.set(key, { value, opts, metadata: opts?.metadata ?? null });
        },
        async delete(key) {
          kv.delete(key);
        },
        async list({ prefix } = {}) {
          const keys = [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
          return { keys: keys.map((name) => ({ name })), list_complete: true };
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

  async function invoke(url, { method = "GET", body, env: envOverride, ctx, headers, cf } = {}) {
    const waits = [];
    const execCtx = ctx === undefined ? { waitUntil(promise) { waits.push(promise); } } : ctx;
    const request = new Request(url, { method, body, headers });
    if (cf) Object.defineProperty(request, "cf", { value: cf });
    const response = await worker.fetch(
      request,
      envOverride === undefined ? env : envOverride,
      execCtx,
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
      opts: { expirationTtl: 365 * DAY },
    });
    expect(kv.get(DATA_KEY).metadata.fetchedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(kv.has(NONE_KEY)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const storedEdge = [...edge.values()][0];
    expect(storedEdge.headers.get("Cache-Control")).toBe("public, max-age=86400");

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

  function seedOverlay(body, fetchedAt) {
    kv.set(DATA_KEY, {
      value: body,
      metadata: { fetchedAt },
      opts: { expirationTtl: 365 * DAY, metadata: { fetchedAt } },
    });
  }

  it("does not call Overpass for an overlay younger than 30 days", async () => {
    const fetchedAt = Date.now() - 2 * DAY * 1000;
    seedOverlay(MAGNOLIA_BODY, fetchedAt);
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.get(DATA_KEY).metadata.fetchedAt).toBe(fetchedAt);
  });

  it("serves a stale overlay as STALE when Overpass returns 504", async () => {
    const fetchedAt = Date.now() - 31 * DAY * 1000;
    seedOverlay(MAGNOLIA_BODY, fetchedAt);
    kv.set(NONE_KEY, { value: "1", metadata: null, opts: { expirationTtl: 6 * 60 * 60 } });
    mockOverpass(async (url) => {
      if (url === PRIMARY) return new Response("gateway", { status: 504, headers: { "Retry-After": "45" } });
      return new Response("gateway", { status: 504 });
    });
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Overlay-Cache")).toBe("STALE");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY).value).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY).metadata.fetchedAt).toBe(fetchedAt);
    expect(edge.size).toBe(0);
  });

  it("keeps a stale overlay when the refresh is empty", async () => {
    const fetchedAt = Date.now() - 31 * DAY * 1000;
    seedOverlay(MAGNOLIA_BODY, fetchedAt);
    mockOverpass(async () => overpassOk('{"elements":[]}'));
    const response = await invoke(magnoliaUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Overlay-Cache")).toBe("STALE");
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.get(DATA_KEY).value).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY).metadata.fetchedAt).toBe(fetchedAt);
    expect(kv.has(NONE_KEY)).toBe(false);
    expect(edge.size).toBe(0);
  });

  it("serves STALE immediately when upstream is busy and skips another refresh within the hour", async () => {
    const fetchedAt = Date.now() - 31 * DAY * 1000;
    seedOverlay(MAGNOLIA_BODY, fetchedAt);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    mockOverpass(async () => {
      calls += 1;
      await gate;
      return new Response("gateway", { status: 504 });
    });
    const waits = [];
    const started = Date.now();
    const response = await worker.fetch(new Request(magnoliaUrl()), env, {
      waitUntil(promise) { waits.push(promise); },
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Overlay-Cache")).toBe("STALE");
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(calls).toBe(1);
    expect(kv.get(REFRESH_KEY)?.opts?.expirationTtl).toBe(3600);

    const second = await worker.fetch(new Request(magnoliaUrl()), env, {
      waitUntil(promise) { waits.push(promise); },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Overlay-Cache")).toBe("STALE");
    expect(await second.text()).toBe(MAGNOLIA_BODY);
    expect(calls).toBe(1);

    const refused = await invoke(`${ORIGIN}/${encodeURIComponent(REFRESH_KEY)}`);
    expect(refused.status).toBe(400);

    release();
    await Promise.all(waits);
    expect(kv.get(DATA_KEY).value).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY).metadata.fetchedAt).toBe(fetchedAt);
  });

  it("applies a background refresh so the next request is HIT", async () => {
    const fetchedAt = Date.now() - 31 * DAY * 1000;
    const refreshed = '{"elements":[{"type":"way","id":10,"tags":{"golf":"fairway"}}]}';
    seedOverlay(MAGNOLIA_BODY, fetchedAt);
    mockOverpass(async () => overpassOk(refreshed));
    const first = await invoke(magnoliaUrl());
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Overlay-Cache")).toBe("STALE");
    expect(await first.text()).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY).value).toBe(refreshed);
    expect(kv.get(DATA_KEY).opts.expirationTtl).toBe(365 * DAY);
    expect(kv.get(DATA_KEY).metadata.fetchedAt).toBeGreaterThan(fetchedAt);
    expect(kv.has(NONE_KEY)).toBe(false);

    const second = await invoke(magnoliaUrl());
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await second.text()).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("awaits a stale refresh when waitUntil is unavailable", async () => {
    const fetchedAt = Date.now() - 31 * DAY * 1000;
    const refreshed = '{"elements":[{"type":"way","id":11,"tags":{"golf":"green"}}]}';
    seedOverlay(MAGNOLIA_BODY, fetchedAt);
    mockOverpass(async () => overpassOk(refreshed));
    const response = await invoke(magnoliaUrl(), { ctx: null });
    expect(response.headers.get("X-Overlay-Cache")).toBe("REFRESHED");
    expect(await response.text()).toBe(refreshed);
    expect(kv.get(DATA_KEY).value).toBe(refreshed);
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
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, PRIMARY]);
    expect(kv.size).toBe(0);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const down = await invoke(magnoliaUrl());
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "upstream_busy" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, MIRROR]);
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
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, MIRROR]);
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

  it("reuses a stored overlay for a different courseId at the same place", async () => {
    mockOverpass(async () => overpassOk());
    const first = await invoke(magnoliaUrl());
    expect(first.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(kv.has(DATA_KEY)).toBe(true);
    expect([...kv.keys()].some((key) => key.includes(COURSE_ID))).toBe(false);

    edge.clear();
    const second = await invoke(magnoliaUrl({ courseId: GCA_ID }));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await second.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the nearest saved overlay within 600 m", async () => {
    mockOverpass(async () => overpassOk());
    const stored = await invoke(magnoliaUrl());
    expect(stored.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(JSON.parse(kv.get(INDEX_KEY).value)).toEqual([
      { lat: 33.1941, lng: -93.2077, radius: 1800 },
    ]);

    edge.clear();
    // GCA pin for Magnolia, about 563 m from the rounded OpenGolf pin.
    const near = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.1958",
      lng: "-93.2134",
      radius: "1800",
    }));
    expect(near.status).toBe(200);
    expect(near.headers.get("X-Overlay-Cache")).toBe("HIT-NEAR");
    expect(await near.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fartherBody = '{"elements":[{"type":"way","id":10,"tags":{"golf":"fairway"}}]}';
    const fetchedAt = Date.now();
    kv.set("osm:v1:33.1985,-93.2077:1800", {
      value: fartherBody,
      metadata: { fetchedAt },
      opts: { expirationTtl: 365 * DAY, metadata: { fetchedAt } },
    });
    kv.set(INDEX_KEY, {
      value: JSON.stringify([
        { lat: 33.1941, lng: -93.2077, radius: 1800 },
        { lat: 33.1985, lng: -93.2077, radius: 1800 },
      ]),
    });
    edge.clear();
    const picked = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.1950",
      lng: "-93.2077",
      radius: "1800",
    }));
    expect(picked.headers.get("X-Overlay-Cache")).toBe("HIT-NEAR");
    expect(await picked.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an overlay beyond 600 m or for a different radius", async () => {
    mockOverpass(async () => overpassOk());
    await invoke(magnoliaUrl());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    edge.clear();

    const far = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.2000",
      lng: "-93.2077",
      radius: "1800",
    }));
    expect(far.status).toBe(200);
    expect(far.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(await far.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    edge.clear();
    const otherRadius = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.1958",
      lng: "-93.2134",
      radius: "1600",
    }));
    expect(otherRadius.status).toBe(200);
    expect(otherRadius.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(kv.has("osm:v1:33.1958,-93.2134:1600")).toBe(true);
    expect(kv.has("osm:v1:33.1958,-93.2134:1800")).toBe(false);
  });

  it("does not let a negative marker answer for a nearby location", async () => {
    kv.set(NONE_KEY, { value: "1", opts: { expirationTtl: 6 * 60 * 60 } });
    const exact = await invoke(magnoliaUrl());
    expect(exact.status).toBe(404);
    expect(exact.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(fetchMock).not.toHaveBeenCalled();

    mockOverpass(async () => overpassOk());
    const neighbor = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.1958",
      lng: "-93.2134",
      radius: "1800",
    }));
    expect(neighbor.status).toBe(200);
    expect(neighbor.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(await neighbor.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    const fetchedAt = Date.now();
    kv.set(DATA_KEY, {
      value: MAGNOLIA_BODY,
      metadata: { fetchedAt },
      opts: { expirationTtl: 365 * DAY, metadata: { fetchedAt } },
    });
    kv.set(INDEX_KEY, {
      value: JSON.stringify([{ lat: 33.1941, lng: -93.2077, radius: 1800 }]),
    });
    kv.set("osm:v1:none:33.1958,-93.2134:1800", { value: "1", opts: { expirationTtl: 6 * 60 * 60 } });
    const reused = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.1958",
      lng: "-93.2134",
      radius: "1800",
    }));
    expect(reused.status).toBe(200);
    expect(reused.headers.get("X-Overlay-Cache")).toBe("HIT-NEAR");
    expect(await reused.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns HIT-NEAR when this pin has a negative marker but a saved overlay is within 600 m", async () => {
    const fetchedAt = Date.now();
    kv.set(DATA_KEY, {
      value: MAGNOLIA_BODY,
      metadata: { fetchedAt },
      opts: { expirationTtl: 365 * DAY, metadata: { fetchedAt } },
    });
    kv.set(INDEX_KEY, {
      value: JSON.stringify([{ lat: 33.1941, lng: -93.2077, radius: 1800 }]),
    });
    kv.set("osm:v1:none:33.1965,-93.2100:1800", {
      value: "1",
      opts: { expirationTtl: 6 * 60 * 60 },
    });
    const response = await invoke(overlayUrl({
      courseId: GCA_ID,
      lat: "33.1965",
      lng: "-93.2100",
      radius: "1800",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Overlay-Cache")).toBe("HIT-NEAR");
    expect(await response.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adopts a legacy courseId key only for that same courseId", async () => {
    const fetchedAt = Date.now() - 2 * DAY * 1000;
    const legacyKey = `osm:v1:${COURSE_ID}:33.1941,-93.2077:1800`;
    const legacyRow = {
      value: MAGNOLIA_BODY,
      metadata: { fetchedAt },
      opts: { expirationTtl: 365 * DAY, metadata: { fetchedAt } },
    };
    kv.set(legacyKey, legacyRow);
    mockOverpass(async () => overpassOk());
    const otherCourse = await invoke(magnoliaUrl({ courseId: GCA_ID }));
    expect(otherCourse.status).toBe(200);
    expect(otherCourse.headers.get("X-Overlay-Cache")).toBe("MISS");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    kv.set(legacyKey, legacyRow);
    const adopted = await invoke(magnoliaUrl());
    expect(adopted.status).toBe(200);
    expect(adopted.headers.get("X-Overlay-Cache")).toBe("HIT");
    expect(await adopted.text()).toBe(MAGNOLIA_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.get(DATA_KEY)?.value).toBe(MAGNOLIA_BODY);
    expect(kv.get(DATA_KEY)?.metadata?.fetchedAt).toBe(fetchedAt);
  });

  it("uses the mirror when the primary attempt times out", async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      let abortedAt = 0;
      mockOverpass((url, init) => {
        if (url === PRIMARY) {
          return new Promise((resolve, reject) => {
            const fail = () => {
              abortedAt = Date.now();
              reject(new Error("The operation was aborted"));
            };
            if (init.signal?.aborted) fail();
            else init.signal?.addEventListener("abort", fail, { once: true });
          });
        }
        expect(url).toBe(MIRROR);
        expect(init.headers["User-Agent"]).toBe(USER_AGENT);
        expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
        return Promise.resolve(overpassOk());
      });
      const pending = invoke(magnoliaUrl());
      await vi.advanceTimersByTimeAsync(10_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(abortedAt).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(abortedAt - started).toBe(11_000);
      await vi.advanceTimersByTimeAsync(399);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Overlay-Cache")).toBe("MISS");
      expect(await response.text()).toBe(MAGNOLIA_BODY);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PRIMARY, MIRROR]);
      expect(kv.get(DATA_KEY)?.value).toBe(MAGNOLIA_BODY);
    } finally {
      vi.useRealTimers();
    }
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
    const golfapi = await invoke(`${ORIGIN}/golfapi/v2.3/coordinates/abc`, {
      headers: { "X-Install-Id": "install-0001" },
    });
    expect(golfapi.status).toBe(200);
    expect(await golfapi.json()).toEqual({ ok: true });

    fetchMock.mockResolvedValue(new Response("nope", { status: 403, headers: { "Content-Type": "text/plain" } }));
    const forbidden = await invoke(`${ORIGIN}/gca/v1/courses/abc`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("nope");

    const unknown = await invoke(`${ORIGIN}/gca/v1/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_route" });

    const unconfigured = await invoke(`${ORIGIN}/golfapi/v2.3/courses`, {
      env: { BOARDS: env.BOARDS },
      headers: { "X-Install-Id": "install-0001" },
    });
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

  const INSTALL = "install-0001";
  const OTHER_INSTALL = "install-0002";
  const CLIENT_IP = "203.0.113.10";

  function coursePayload(id, left = 80) {
    return JSON.stringify({
      apiRequestsLeft: String(left),
      courseID: id,
      courseName: "Magnolia",
      numHoles: 18,
    });
  }

  function coordPayload(id, left = 79) {
    return JSON.stringify({
      apiRequestsLeft: String(left),
      courseID: id,
      numCoordinates: 1,
      coordinates: [{ hole: 1, latitude: 33.19, longitude: -93.2 }],
    });
  }

  function golfHeaders(install, ip = CLIENT_IP) {
    const headers = {};
    if (install) headers["X-Install-Id"] = install;
    if (ip) headers["CF-Connecting-IP"] = ip;
    return headers;
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function stats() {
    const row = kv.get(`gq:stats:${todayKey()}`);
    return row ? JSON.parse(row.value) : { lookups: 0, searches: 0, hits: 0, blocked: {} };
  }

  function mockGolfApi(handler) {
    fetchMock.mockImplementation(async (url, init) => {
      expect(init.headers.Authorization).toBe("Bearer golf-secret");
      return handler(String(url), init);
    });
  }

  function jsonResponse(body, status = 200) {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function golfGet(path, { install = INSTALL, ip = CLIENT_IP, env: envOverride, headers } = {}) {
    return invoke(`${ORIGIN}${path}`, {
      headers: headers ?? golfHeaders(install, ip),
      env: envOverride,
    });
  }

  async function runDrain(envOverride = env) {
    await worker.scheduled({ cron: "0 8 * * *" }, envOverride, { waitUntil() {} });
  }

  it("serves a stored golfapi course for free and does not count it", async () => {
    mockGolfApi(async (url) => {
      if (url.endsWith("/courses/pebble")) return jsonResponse(coursePayload("pebble", 80));
      if (url.endsWith("/coordinates/pebble")) return jsonResponse(coordPayload("pebble", 79));
      throw new Error(url);
    });

    const course = await golfGet("/golfapi/v2.3/courses/pebble");
    expect(course.status).toBe(200);
    expect(course.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Install-Id");
    const coords = await golfGet("/golfapi/v2.3/coordinates/pebble");
    expect(coords.status).toBe(200);
    expect(await coords.json()).toMatchObject({ courseID: "pebble" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stats().lookups).toBe(1);
    expect(stats().hits).toBe(0);
    expect(kv.get("gapi:course:pebble").opts.expirationTtl).toBe(365 * DAY);
    expect(kv.get("gapi:coord:pebble").opts.expirationTtl).toBe(365 * DAY);
    expect(JSON.stringify([...kv.keys()])).not.toContain(CLIENT_IP);

    fetchMock.mockClear();
    const again = await golfGet("/golfapi/v2.3/courses/pebble");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ courseName: "Magnolia" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats().lookups).toBe(1);
    expect(stats().hits).toBe(1);

    kv.delete("gapi:course:pebble");
    const fromEdge = await golfGet("/golfapi/v2.3/courses/pebble");
    expect(fromEdge.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.get("gapi:course:pebble")?.value).toContain("Magnolia");
    expect(stats().lookups).toBe(1);
    expect(stats().hits).toBe(2);
  });

  it("queues the 4th device lookup while that IP is still under its limit", async () => {
    let n = 0;
    mockGolfApi(async (url) => {
      n += 1;
      return jsonResponse(coursePayload(url.split("/").pop(), 100 - n));
    });
    for (const id of ["c1", "c2", "c3"]) {
      expect((await golfGet(`/golfapi/v2.3/courses/${id}`)).status).toBe(200);
    }
    const blocked = await golfGet("/golfapi/v2.3/courses/c4");
    const body = await blocked.json();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe(String(body.retryAfterSec));
    expect(body.error).toBe("golfapi_limited");
    expect(body.reason).toBe("device_day");
    expect(body.queued).toBe(true);
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(86400);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stats().lookups).toBe(3);
    expect(stats().blocked.device_day).toBe(1);
    expect(kv.has("gqueue:c4")).toBe(true);

    const again = await golfGet("/golfapi/v2.3/courses/c4");
    expect((await again.json()).reason).toBe("device_day");
    expect([...kv.keys()].filter((key) => key.startsWith("gqueue:"))).toEqual(["gqueue:c4"]);

    const other = await golfGet("/golfapi/v2.3/courses/c5", { install: OTHER_INSTALL });
    expect(other.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stats().lookups).toBe(4);
  });

  it("enforces weekly and monthly lookup limits", async () => {
    mockGolfApi(async (url) => {
      const id = url.split("/").pop();
      if (url.includes("/coordinates/")) return jsonResponse(coordPayload(id));
      return jsonResponse(coursePayload(id));
    });
    const weekEnv = { ...env, GOLFAPI_DEVICE_WEEK: "1" };
    expect((await golfGet("/golfapi/v2.3/courses/w1", { env: weekEnv })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/coordinates/w1", { env: weekEnv })).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const weekBlocked = await golfGet("/golfapi/v2.3/courses/w2", { env: weekEnv });
    expect(weekBlocked.status).toBe(429);
    expect((await weekBlocked.json()).reason).toBe("device_week");

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    const monthEnv = { ...env, GOLFAPI_DEVICE_MONTH: "1" };
    expect((await golfGet("/golfapi/v2.3/courses/m1", { env: monthEnv })).status).toBe(200);
    const monthBlocked = await golfGet("/golfapi/v2.3/courses/m2", { env: monthEnv });
    const monthBody = await monthBlocked.json();
    expect(monthBlocked.status).toBe(429);
    expect(monthBody.reason).toBe("device_month");
    expect(monthBody.queued).toBe(true);
  });

  it("applies the IP limit across spoofed install ids", async () => {
    mockGolfApi(async (url) => jsonResponse(coursePayload(url.split("/").pop())));
    const tight = { ...env, GOLFAPI_DEVICE_DAY: "1" };
    expect((await golfGet("/golfapi/v2.3/courses/s1", { install: "spoof-aaa", env: tight })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses/s2", { install: "spoof-bbb", env: tight })).status).toBe(200);
    const spoofed = await golfGet("/golfapi/v2.3/courses/s3", { install: "spoof-ccc", env: tight });
    expect(spoofed.status).toBe(429);
    expect((await spoofed.json()).reason).toBe("ip_day");
    expect(JSON.stringify([...kv.entries()])).not.toContain(CLIENT_IP);
    expect([...kv.keys()].some((key) => /^gq:ip:[0-9a-f]{64}$/.test(key))).toBe(true);
  });

  it("accepts the app install id and keys device state on it", async () => {
    const appId = "id_1790517745797_pfjtwbfa";
    mockGolfApi(async (url) => jsonResponse(coursePayload(url.split("/").pop())));
    expect((await golfGet("/golfapi/v2.3/courses/pebble", { install: appId })).status).toBe(200);
    expect(JSON.parse(kv.get(`gq:dev:${appId}`).value).dayCount).toBe(1);
    expect(JSON.parse(kv.get(`gq:set:dev:${appId}`).value).courseId).toBe("pebble");

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    const listed = { ...env, GOLFAPI_ALLOWLIST: appId, GOLFAPI_GLOBAL_DAY: "0" };
    expect((await golfGet("/golfapi/v2.3/courses/listed", { install: appId, env: listed })).status).toBe(200);
    expect(stats().allowlistedLookups).toBe(1);
    expect(stats().lookups).toBe(0);
    expect([...kv.keys()].some((key) => key.startsWith("gq:ip:"))).toBe(false);

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    const rejected = ["id_1790", "a".repeat(65), "id_1790517745797_pfjtwbfa!", "id 1790517745797", "id.17905177"];
    for (const [index, bad] of rejected.entries()) {
      fetchMock.mockClear();
      const response = await golfGet(`/golfapi/v2.3/courses/bad${index}`, { install: bad });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "install_id_required" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(kv.has(`gq:dev:${bad}`)).toBe(false);
      expect(kv.has(`gq:set:dev:${bad}`)).toBe(false);
    }
    expect([...kv.keys()].some((key) => key.startsWith("gq:dev:"))).toBe(false);
    expect([...kv.keys()].some((key) => key.startsWith("gqueue:"))).toBe(false);
    expect(stats().blocked.install_id_required).toBe(rejected.length);
    expect(stats().lookups).toBe(0);
  });

  it("serves golfapi for the app install id and rejects a missing id before upstream", async () => {
    const appId = "id_1790517745797_pfjtwbfa";
    mockGolfApi(async () => jsonResponse(coursePayload("pebble")));
    kv.set("gapi:course:stored", { value: coursePayload("stored") });

    const missing = await golfGet("/golfapi/v2.3/courses/stored", { install: null });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "install_id_required" });
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats()).toMatchObject({
      lookups: 0,
      searches: 0,
      hits: 0,
      blocked: { install_id_required: 1 },
    });
    expect([...kv.keys()].filter((key) => key !== "gapi:course:stored" && !key.startsWith("gq:stats:"))).toEqual([]);
    expect(kv.has("gqueue:stored")).toBe(false);

    const invalid = await golfGet("/golfapi/v2.3/courses/stored", { install: "nope" });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "install_id_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats().blocked.install_id_required).toBe(2);
    expect(stats().hits).toBe(0);

    const ok = await golfGet("/golfapi/v2.3/courses/pebble", { install: appId });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await ok.json()).toMatchObject({ courseID: "pebble" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const golfOptions = await invoke(`${ORIGIN}/golfapi/v2.3/courses/pebble`, { method: "OPTIONS" });
    expect(golfOptions.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const gcaOptions = await invoke(`${ORIGIN}/gca/v1/courses/14322`, { method: "OPTIONS" });
    expect(gcaOptions.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const gcaMissing = await invoke(`${ORIGIN}/gca/v1/nope`);
    expect(gcaMissing.status).toBe(404);
    expect(gcaMissing.headers.get("Access-Control-Allow-Origin")).toBeNull();

    await invoke(`${ORIGIN}/boardcors`, { method: "PUT", body: "{\"ok\":1}" });
    const board = await invoke(`${ORIGIN}/boardcors`);
    expect(board.status).toBe(200);
    expect(await board.json()).toEqual({ ok: 1 });
    expect(board.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const meta = await invoke(`${ORIGIN}/meta/gca`);
    expect(meta.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("stops fresh lookups at the global daily cap", async () => {
    mockGolfApi(async (url) => jsonResponse(coursePayload(url.split("/").pop())));
    const capEnv = { ...env, GOLFAPI_GLOBAL_DAY: "1", GOLFAPI_DEVICE_DAY: "5" };
    expect((await golfGet("/golfapi/v2.3/courses/g1", { env: capEnv })).status).toBe(200);
    const blocked = await golfGet("/golfapi/v2.3/courses/g2", { install: OTHER_INSTALL, env: capEnv });
    const body = await blocked.json();
    expect(blocked.status).toBe(429);
    expect(body.reason).toBe("global_day");
    expect(body.queued).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stats().lookups).toBe(1);
  });

  it("refuses fresh golfapi calls at the balance floor of 10", async () => {
    mockGolfApi(async () => jsonResponse(coursePayload("floor", 40)));
    kv.set("gq:balance", { value: JSON.stringify({ left: 10, at: 1, lastStatus: 200 }) });
    const blocked = await golfGet("/golfapi/v2.3/courses/floor");
    const body = await blocked.json();
    expect(blocked.status).toBe(429);
    expect(body.reason).toBe("floor");
    expect(body.queued).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.has("gqueue:floor")).toBe(true);

    kv.set("gq:balance", { value: JSON.stringify({ left: 10.5, at: 1, lastStatus: 200 }) });
    kv.delete("gqueue:floor");
    expect((await golfGet("/golfapi/v2.3/courses/floor")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    kv.set("gq:balance", { value: JSON.stringify({ left: 9, at: 1, lastStatus: 200 }) });
    const search = await golfGet("/golfapi/v2.3/courses?q=magnolia");
    const searchBody = await search.json();
    expect(search.status).toBe(429);
    expect(searchBody.reason).toBe("floor");
    expect(searchBody.queued).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const queuedSearch = [...kv.keys()].filter((key) => key.startsWith("gqueue:"));
    expect(queuedSearch).toHaveLength(1);
    expect(queuedSearch[0].startsWith("gqueue:q:")).toBe(true);
  });

  it("caps fresh searches at 3x the device day, including inside an open set", async () => {
    mockGolfApi(async (url) => {
      if (url.includes("/courses?")) {
        return jsonResponse({
          apiRequestsLeft: "70",
          numCourses: 1,
          courses: [{ courseID: "abc", courseName: "Somewhere" }],
        });
      }
      return jsonResponse(coursePayload(url.split("/").pop(), 60));
    });
    const searchEnv = { ...env, GOLFAPI_DEVICE_DAY: "1", GOLFAPI_SEARCH_DEVICE_DAY: "100" };
    expect((await golfGet("/golfapi/v2.3/courses?q=one", { env: searchEnv })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?q=two", { env: searchEnv })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?q=three", { env: searchEnv })).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(3);

    const blocked = await golfGet("/golfapi/v2.3/courses?q=four", { env: searchEnv });
    const body = await blocked.json();
    expect(blocked.status).toBe(429);
    expect(body.reason).toBe("search_device_day");
    expect(body.queued).toBe(true);
    const again = await golfGet("/golfapi/v2.3/courses?q=Four", { env: searchEnv });
    expect(again.status).toBe(429);
    const queued = [...kv.keys()].filter((key) => key.startsWith("gqueue:q:"));
    expect(queued).toHaveLength(1);
    expect(JSON.parse(kv.get(queued[0]).value).q).toBe("four");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect((await golfGet("/golfapi/v2.3/courses/pebble", { env: searchEnv })).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const other = await golfGet("/golfapi/v2.3/courses/other", { env: searchEnv });
    expect(other.status).toBe(429);
    expect((await other.json()).reason).toBe("device_day");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not store an error body or a 200 with no course data", async () => {
    mockGolfApi(async (url) => {
      if (url.endsWith("/courses/missing")) {
        return jsonResponse({ error: "Course not found", apiRequestsLeft: "50" });
      }
      if (url.endsWith("/coordinates/missing")) {
        return jsonResponse({ apiRequestsLeft: "49", courseID: "missing", coordinates: [] });
      }
      if (url.endsWith("/coordinates/abc")) return jsonResponse({ ok: true });
      throw new Error(url);
    });
    const missing = await golfGet("/golfapi/v2.3/courses/missing");
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ error: "Course not found", apiRequestsLeft: "50" });
    expect(kv.has("gapi:course:missing")).toBe(false);
    expect(edge.size).toBe(0);

    const emptyCoords = await golfGet("/golfapi/v2.3/coordinates/missing");
    expect(emptyCoords.status).toBe(200);
    expect(kv.has("gapi:coord:missing")).toBe(false);
    expect(edge.size).toBe(0);
    expect(JSON.parse(kv.get("gq:balance").value).left).toBe(49);

    fetchMock.mockClear();
    const repeat = await golfGet("/golfapi/v2.3/courses/missing");
    expect(repeat.status).toBe(404);
    expect(await repeat.json()).toEqual({ error: "no_course_data" });
    expect(fetchMock).not.toHaveBeenCalled();

    const plain = await golfGet("/golfapi/v2.3/coordinates/abc");
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ ok: true });
    expect(kv.has("gapi:coord:abc")).toBe(false);
    expect([...edge.keys()].some((key) => key.includes("/coordinates/abc"))).toBe(false);
  });

  it("blocks reserved prefixes on public routes and still accepts board and paint keys", async () => {
    const reserved = [
      "gq:balance",
      "gq:stats:2026-01-01",
      "gapi:course:abc",
      "gqueue:abc",
      "osm:v1:secret",
      "gca:course:14322",
      "gca:greens:14322",
      "gca:stats:2026-01-01",
      "v1",
      "v1board",
      "cr:id:secret",
      "cr:r:2026-01-01T00:00:00.000Z:secret",
    ];
    for (const key of reserved) {
      kv.set(key, { value: "keep-me", opts: { expirationTtl: 60 } });
      const encoded = `${ORIGIN}/${encodeURIComponent(key)}`;
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await invoke(encoded, { method, body: method === "PUT" ? "{\"x\":1}" : undefined });
        expect(response.status, `${method} ${key}`).toBe(400);
        expect(await response.text()).toBe("bad key");
      }
      expect(kv.get(key)).toEqual({ value: "keep-me", opts: { expirationTtl: 60 } });
    }

    const paint = await invoke(`${ORIGIN}/id:${GCA_ID}`, { method: "PUT", body: "{\"paint\":1}" });
    expect(paint.status).toBe(200);
    expect(kv.get(`id:${GCA_ID}`)?.opts).toEqual({ expirationTtl: 365 * DAY });
    const named = await invoke(`${ORIGIN}/name:magnolia`, { method: "PUT", body: "{\"paint\":2}" });
    expect(named.status).toBe(200);
    expect(kv.get("name:magnolia")?.opts).toEqual({ expirationTtl: 365 * DAY });
    const board = await invoke(`${ORIGIN}/round9`, { method: "DELETE" });
    expect(board.status).toBe(405);
    expect(await board.text()).toBe("no");

    const clubs = await invoke(`${ORIGIN}/golfapi/v2.3/clubs`, {
      headers: { "X-Install-Id": "install-0001" },
    });
    expect(clubs.status).toBe(404);
    const bare = await invoke(`${ORIGIN}/golfapi/v2.3/courses`, {
      headers: { "X-Install-Id": "install-0001" },
    });
    expect(bare.status).toBe(404);
    expect(await bare.json()).toEqual({ error: "unknown_route" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("overrides golfapi limits from vars and ignores invalid values", async () => {
    mockGolfApi(async (url) => jsonResponse(coursePayload(url.split("/").pop(), 20)));
    const brokenDay = { ...env, GOLFAPI_DEVICE_DAY: "nope", GOLFAPI_DEVICE_WEEK: "1" };
    expect((await golfGet("/golfapi/v2.3/courses/cfg1", { env: brokenDay })).status).toBe(200);
    const weekBlocked = await golfGet("/golfapi/v2.3/courses/cfg2", { env: brokenDay });
    expect((await weekBlocked.json()).reason).toBe("device_week");

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    const oneDay = { ...env, GOLFAPI_DEVICE_DAY: "1", GOLFAPI_IP_DAY: "5" };
    expect((await golfGet("/golfapi/v2.3/courses/cfg3", { env: oneDay })).status).toBe(200);
    expect((await (await golfGet("/golfapi/v2.3/courses/cfg4", { env: oneDay })).json()).reason).toBe("device_day");

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    const ipOverride = { ...env, GOLFAPI_DEVICE_DAY: "5", GOLFAPI_IP_DAY: "1" };
    expect((await golfGet("/golfapi/v2.3/courses/ipcfg", { env: ipOverride })).status).toBe(200);
    expect((await (await golfGet("/golfapi/v2.3/courses/ipcfg2", { env: ipOverride })).json()).reason).toBe("ip_day");

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    kv.set("gq:balance", { value: JSON.stringify({ left: 5, at: 1, lastStatus: 200 }) });
    const floorBlocked = await golfGet("/golfapi/v2.3/courses/cfg5", { env: { ...env, GOLFAPI_FLOOR: "5" } });
    expect((await floorBlocked.json()).reason).toBe("floor");
    expect(fetchMock).not.toHaveBeenCalled();
    kv.set("gq:balance", { value: JSON.stringify({ left: 6, at: 1, lastStatus: 200 }) });
    expect((await golfGet("/golfapi/v2.3/courses/cfg5", { env: { ...env, GOLFAPI_FLOOR: "5" } })).status).toBe(200);

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    mockGolfApi(async () => jsonResponse({ apiRequestsLeft: "50", numCourses: 0, courses: [] }));
    const ignoredSearchVars = { ...env, GOLFAPI_SEARCH_GLOBAL_DAY: "1", GOLFAPI_SEARCH_DEVICE_DAY: "10" };
    expect((await golfGet("/golfapi/v2.3/courses?q=one", { env: ignoredSearchVars })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?q=two", { env: ignoredSearchVars })).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(2);
  });

  it("keeps an open 15 minute set free and treats an expired set as closed", async () => {
    async function sha256Hex(text) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    async function seedSets(courseId, at) {
      const value = JSON.stringify({ at, courseId });
      kv.set(`gq:set:dev:${INSTALL}`, { value });
      kv.set(`gq:set:ip:${await sha256Hex(`shottrax-golfapi-ip-v1:${CLIENT_IP}`)}`, { value });
    }
    kv.set(`gq:dev:${INSTALL}`, {
      value: JSON.stringify({ day: todayKey(), dayCount: 3 }),
    });
    await seedSets("pebble", Date.now());
    mockGolfApi(async () => jsonResponse(coursePayload("pebble")));
    expect((await golfGet("/golfapi/v2.3/courses/pebble")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stats().lookups).toBe(0);
    expect(JSON.parse(kv.get(`gq:dev:${INSTALL}`).value).dayCount).toBe(3);

    fetchMock.mockClear();
    const other = await golfGet("/golfapi/v2.3/courses/other");
    expect(other.status).toBe(429);
    expect((await other.json()).reason).toBe("device_day");
    expect(fetchMock).not.toHaveBeenCalled();

    kv.clear();
    edge.clear();
    fetchMock.mockClear();
    kv.set(`gq:dev:${INSTALL}`, {
      value: JSON.stringify({ day: todayKey(), dayCount: 3 }),
    });
    await seedSets("pebble", Date.now() - 16 * 60 * 1000);
    const expired = await golfGet("/golfapi/v2.3/courses/pebble");
    expect(expired.status).toBe(429);
    expect((await expired.json()).reason).toBe("device_day");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports /meta/golfapi without secrets, install ids, or IPs", async () => {
    mockGolfApi(async (url) => {
      if (url.includes("/courses?")) {
        return jsonResponse({ apiRequestsLeft: "33.5", numCourses: 1, courses: [{ courseID: "m", courseName: "M" }] });
      }
      return jsonResponse(coursePayload("meta", 40));
    });
    const limited = { ...env, GOLFAPI_DEVICE_DAY: "1" };
    expect((await golfGet("/golfapi/v2.3/courses/meta", { env: limited })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses/meta", { env: limited })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?q=meta", { env: limited })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses/other", { env: limited })).status).toBe(429);

    const meta = await invoke(`${ORIGIN}/meta/golfapi`);
    expect(meta.status).toBe(200);
    expect(meta.headers.get("Cache-Control")).toBe("no-store");
    const body = await meta.json();
    expect(body.balance).toEqual({
      left: 33.5,
      at: expect.any(Number),
      lastStatus: 200,
      asOf: expect.any(String),
    });
    expect(body.asOf).toBe(new Date(body.balance.at).toISOString());
    expect(body.balance.asOf).toBe(body.asOf);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.queueLength).toBe(1);
    expect(body.days).toHaveLength(30);
    expect(body.days[0].date < body.days[29].date).toBe(true);
    expect(body.days[29]).toEqual(body.today);
    expect(body.globalCap).toBe(100);
    expect(body.today).toMatchObject({
      date: todayKey(),
      lookups: 1,
      globalLookups: 1,
      globalCap: 100,
      allowlistedLookups: 0,
      searches: 1,
      hits: 1,
    });
    expect(body.days[0].globalLookups).toBe(0);
    expect(body.days[0].allowlistedLookups).toBe(0);
    expect(body.today.latency).toEqual({
      search: { count: 1, median: expect.any(Number), max: expect.any(Number) },
      course: { count: 1, median: expect.any(Number), max: expect.any(Number) },
      coordinates: { count: 0, median: null, max: 0 },
    });
    expect(body.today.latency.search.max).toBeGreaterThanOrEqual(body.today.latency.search.median);
    expect(JSON.stringify(body.today.latency)).not.toContain("samples");
    expect(body.today.blocked.device_day).toBe(1);
    expect(body.today.blocked.floor).toBe(0);
    expect(Object.keys(body.today.blocked).sort()).toEqual([
      "device_day",
      "device_month",
      "device_week",
      "floor",
      "global_day",
      "install_id_required",
      "ip_day",
      "ip_month",
      "ip_week",
      "search_device_day",
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("golf-secret");
    expect(text).not.toContain(INSTALL);
    expect(text).not.toContain(CLIENT_IP);
    expect(text).not.toContain("GOLFAPI_KEY");
    expect(text).not.toContain("Bearer");

    const post = await invoke(`${ORIGIN}/meta/golfapi`, { method: "PUT", body: "{}" });
    expect(post.status).toBe(405);
    const down = await invoke(`${ORIGIN}/meta/golfapi`, { env: {} });
    expect(down.status).toBe(503);
  });

  it("drains queued courses under the cap and above the floor", async () => {
    kv.set("gqueue:ready", { value: JSON.stringify({ attempts: 0, at: 1 }) });
    kv.set("gqueue:later", { value: JSON.stringify({ attempts: 0, at: 2 }) });
    kv.set("gq:balance", { value: JSON.stringify({ left: 30, at: 1, lastStatus: 200 }) });
    const calls = [];
    mockGolfApi(async (url) => {
      calls.push(url);
      if (url.endsWith("/courses/ready")) return jsonResponse(coursePayload("ready", 28));
      if (url.endsWith("/coordinates/ready")) return jsonResponse(coordPayload("ready", 27));
      throw new Error(`should not fetch ${url}`);
    });
    await runDrain({ ...env, GOLFAPI_GLOBAL_DAY: "1" });
    expect(calls).toEqual([
      "https://golfapi.io/api/v2.3/courses/ready",
      "https://golfapi.io/api/v2.3/coordinates/ready",
    ]);
    expect(kv.has("gqueue:ready")).toBe(false);
    expect(kv.has("gqueue:later")).toBe(true);
    expect(kv.get("gapi:course:ready")?.value).toContain("Magnolia");
    expect(kv.get("gapi:coord:ready")?.value).toContain("coordinates");
    expect(stats().lookups).toBe(1);

    fetchMock.mockClear();
    const free = await golfGet("/golfapi/v2.3/courses/ready");
    expect(free.status).toBe(200);
    expect(await free.json()).toMatchObject({ courseID: "ready" });
    expect(fetchMock).not.toHaveBeenCalled();

    kv.set("gq:balance", { value: JSON.stringify({ left: 10, at: 1, lastStatus: 200 }) });
    await runDrain({ ...env, GOLFAPI_GLOBAL_DAY: "1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.has("gqueue:later")).toBe(true);

    kv.set("gq:balance", { value: JSON.stringify({ left: 30, at: 1, lastStatus: 200 }) });
    await runDrain({ ...env, GOLFAPI_GLOBAL_DAY: "1" });
    expect(fetchMock).not.toHaveBeenCalled();

    kv.set(`gq:stats:${todayKey()}`, {
      value: JSON.stringify({ lookups: 0, searches: 0, hits: 0, blocked: {} }),
    });
    mockGolfApi(async () => new Response("nope", { status: 500, headers: { "Content-Type": "text/plain" } }));
    await runDrain(env);
    expect(JSON.parse(kv.get("gqueue:later").value).attempts).toBe(1);
    expect(kv.has("gapi:course:later")).toBe(false);
    expect(stats().lookups).toBe(1);

    kv.set("gqueue:later", { value: JSON.stringify({ attempts: 5, at: 2 }) });
    fetchMock.mockClear();
    await runDrain(env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(kv.get("gqueue:later").value).attempts).toBe(5);

    kv.set("gqueue:empty", { value: JSON.stringify({ attempts: 0, at: 3 }) });
    kv.set(`gq:stats:${todayKey()}`, {
      value: JSON.stringify({ lookups: 0, searches: 0, hits: 0, blocked: {} }),
    });
    kv.set("gq:balance", { value: JSON.stringify({ left: 20, at: 1, lastStatus: 200 }) });
    mockGolfApi(async () => jsonResponse({ error: "missing", apiRequestsLeft: "19" }));
    await runDrain(env);
    expect(kv.has("gqueue:empty")).toBe(false);
    expect(kv.has("gapi:course:empty")).toBe(false);
    expect(kv.has("gapi:coord:empty")).toBe(false);
    expect(JSON.parse(kv.get("gq:balance").value).left).toBe(19);
  });

  it("stops a queue refill before coordinates once balance reaches the floor", async () => {
    kv.set("gqueue:split", { value: JSON.stringify({ attempts: 0, at: 1 }) });
    kv.set("gq:balance", { value: JSON.stringify({ left: 11, at: 1, lastStatus: 200 }) });
    const calls = [];
    mockGolfApi(async (url) => {
      calls.push(url);
      if (url.endsWith("/courses/split")) return jsonResponse(coursePayload("split", 10));
      throw new Error(url);
    });
    await runDrain();
    expect(calls).toEqual(["https://golfapi.io/api/v2.3/courses/split"]);
    expect(kv.has("gapi:course:split")).toBe(true);
    expect(kv.has("gapi:coord:split")).toBe(false);
    expect(JSON.parse(kv.get("gqueue:split").value).attempts).toBe(0);
    expect(stats().lookups).toBe(1);
  });

  it("does not call golfapi when the key or the board namespace is missing", async () => {
    kv.set("gqueue:abc", { value: JSON.stringify({ attempts: 0, at: 1 }) });
    await runDrain({ BOARDS: env.BOARDS });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.has("gqueue:abc")).toBe(true);

    const response = await invoke(`${ORIGIN}/golfapi/v2.3/courses/abc`, {
      env: { GOLFAPI_KEY: "golf-secret" },
      headers: { "X-Install-Id": "install-0001" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "boards_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();

    const options = await invoke(`${ORIGIN}/golfapi/v2.3/courses/abc`, { method: "OPTIONS" });
    expect(options.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Install-Id");
  });

  it("counts a fresh search and the first course id as one lookup", async () => {
    mockGolfApi(async (url) => {
      if (url.includes("/courses?")) {
        return jsonResponse({
          apiRequestsLeft: "70",
          numCourses: 1,
          courses: [{ courseID: "pebble", courseName: "Magnolia" }],
        });
      }
      const id = url.split("/").pop();
      if (url.includes("/coordinates/")) return jsonResponse(coordPayload(id, 60));
      return jsonResponse(coursePayload(id, 65));
    });
    expect((await golfGet("/golfapi/v2.3/courses?q=Magnolia")).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?q=magnolia")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const searchKeys = [...kv.keys()].filter((key) => key.startsWith("gapi:search:"));
    expect(searchKeys).toHaveLength(1);
    expect(kv.get(searchKeys[0]).opts.expirationTtl).toBe(30 * DAY);
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(1);
    expect(stats().hits).toBe(1);

    expect((await golfGet("/golfapi/v2.3/coordinates/pebble")).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses/pebble")).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect((await golfGet("/golfapi/v2.3/courses/other")).status).toBe(200);
    expect(stats().lookups).toBe(2);
  });

  async function searchTokenFor(text) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`shottrax-golfapi-search-v1:${text}`),
    );
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function searchPayload(courseID, courseName, left = "70") {
    return {
      apiRequestsLeft: left,
      numCourses: 1,
      courses: [{ courseID, courseName }],
    };
  }

  it("accepts a name= golfapi search, counts it, and serves the repeat from the store", async () => {
    const calls = [];
    mockGolfApi(async (url) => {
      calls.push(url);
      if (url.includes("name=Oak")) {
        return jsonResponse(searchPayload("oak", "Oak Marsh"));
      }
      if (url.includes("q=Pebble")) return jsonResponse(searchPayload("pebble", "Pebble"));
      throw new Error(url);
    });

    const first = await golfGet("/golfapi/v2.3/courses?country=US&name=Oak%20Marsh");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ courses: [{ courseID: "oak", courseName: "Oak Marsh" }] });
    expect(calls).toEqual(["https://golfapi.io/api/v2.3/courses?country=US&name=Oak%20Marsh"]);
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(1);
    const oakToken = await searchTokenFor("oak marsh");
    expect(kv.get(`gapi:search:${oakToken}`)?.opts.expirationTtl).toBe(30 * DAY);

    calls.length = 0;
    fetchMock.mockClear();
    const repeat = await golfGet("/golfapi/v2.3/courses?country=US&name=oak%20marsh");
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ courses: [{ courseID: "oak" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(1);
    expect(stats().hits).toBe(1);

    const preferred = await golfGet("/golfapi/v2.3/courses?name=Oak%20Marsh&q=other");
    expect(preferred.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats().hits).toBe(2);

    const byQ = await golfGet("/golfapi/v2.3/courses?q=Pebble");
    expect(byQ.status).toBe(200);
    expect(calls).toEqual(["https://golfapi.io/api/v2.3/courses?q=Pebble"]);
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(2);
    expect(kv.has(`gapi:search:${await searchTokenFor("pebble")}`)).toBe(true);

    const blankName = await golfGet("/golfapi/v2.3/courses?name=%20&q=Pebble");
    expect(blankName.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stats().hits).toBe(3);

    for (const path of [
      "/golfapi/v2.3/courses",
      "/golfapi/v2.3/courses?country=US",
      "/golfapi/v2.3/courses?name=",
      "/golfapi/v2.3/courses?name=%20&q=",
    ]) {
      const missing = await golfGet(path);
      expect(missing.status, path).toBe(404);
      expect(await missing.json()).toEqual({ error: "unknown_route" });
    }
    expect(stats().searches).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("queues a limited name= search and the drain replays name=", async () => {
    const searchEnv = { ...env, GOLFAPI_DEVICE_DAY: "1" };
    mockGolfApi(async (url) => {
      if (!url.includes("/courses?")) throw new Error(url);
      return jsonResponse(searchPayload("x", "Somewhere", "70"));
    });
    expect((await golfGet("/golfapi/v2.3/courses?name=one", { env: searchEnv })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?name=two", { env: searchEnv })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses?q=three", { env: searchEnv })).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(stats().searches).toBe(3);

    const blocked = await golfGet("/golfapi/v2.3/courses?country=US&name=Oak%20Marsh", { env: searchEnv });
    const body = await blocked.json();
    expect(blocked.status).toBe(429);
    expect(body.reason).toBe("search_device_day");
    expect(body.queued).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const queued = [...kv.keys()].filter((key) => key.startsWith("gqueue:q:"));
    expect(queued).toEqual([`gqueue:q:${await searchTokenFor("oak marsh")}`]);
    expect(JSON.parse(kv.get(queued[0]).value)).toMatchObject({
      attempts: 0,
      q: "oak marsh",
      search: "?country=US&name=Oak%20Marsh",
    });

    const calls = [];
    mockGolfApi(async (url) => {
      calls.push(url);
      if (url.includes("/courses?")) {
        return jsonResponse(searchPayload("oak", "Oak Marsh", "30"));
      }
      if (url.endsWith("/courses/oak")) return jsonResponse(coursePayload("oak", 28));
      if (url.endsWith("/coordinates/oak")) return jsonResponse(coordPayload("oak", 27));
      throw new Error(url);
    });
    await runDrain(searchEnv);
    expect(calls).toEqual([
      "https://golfapi.io/api/v2.3/courses?country=US&name=Oak%20Marsh",
      "https://golfapi.io/api/v2.3/courses/oak",
      "https://golfapi.io/api/v2.3/coordinates/oak",
    ]);
    expect(kv.has(queued[0])).toBe(false);
    expect(kv.get(`gapi:search:${await searchTokenFor("oak marsh")}`)?.opts.expirationTtl).toBe(30 * DAY);
    expect(kv.has("gapi:course:oak")).toBe(true);
    expect(kv.has("gapi:coord:oak")).toBe(true);
  });

  it("does not open a set when the search is already stored", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("shottrax-golfapi-search-v1:magnolia"),
    );
    const token = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    kv.set(`gapi:search:${token}`, {
      value: JSON.stringify({
        apiRequestsLeft: "40",
        numCourses: 1,
        courses: [{ courseID: "pebble", courseName: "Magnolia" }],
      }),
    });
    mockGolfApi(async (url) => {
      const id = url.split("/").pop();
      if (url.includes("/coordinates/")) return jsonResponse(coordPayload(id));
      return jsonResponse(coursePayload(id));
    });
    expect((await golfGet("/golfapi/v2.3/courses?q=Magnolia")).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...kv.keys()].some((key) => key.startsWith("gq:set:"))).toBe(false);
    expect(stats().lookups).toBe(0);
    expect(stats().hits).toBe(1);

    expect((await golfGet("/golfapi/v2.3/courses/pebble")).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect((await golfGet("/golfapi/v2.3/coordinates/pebble")).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drains a queued search and follows a unique normalized name", async () => {
    kv.set("gq:balance", { value: JSON.stringify({ left: 9, at: 1, lastStatus: 200 }) });
    const blocked = await golfGet("/golfapi/v2.3/courses?country=US&q=Magnolia");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).queued).toBe(true);
    expect((await golfGet("/golfapi/v2.3/courses?q=magnolia")).status).toBe(429);
    const queued = [...kv.keys()].filter((key) => key.startsWith("gqueue:"));
    expect(queued).toHaveLength(1);
    expect(JSON.parse(kv.get(queued[0]).value)).toMatchObject({
      attempts: 0,
      q: "magnolia",
      search: "?country=US&q=Magnolia",
    });
    kv.set("gqueue:q:nope", { value: JSON.stringify({ attempts: 0, at: 5, q: "nope", search: "?q=nope" }) });

    kv.set("gq:balance", { value: JSON.stringify({ left: 40, at: 1, lastStatus: 200 }) });
    const calls = [];
    mockGolfApi(async (url) => {
      calls.push(url);
      if (url.includes("/courses?")) {
        return jsonResponse({
          apiRequestsLeft: "30",
          numCourses: 1,
          courses: [{ courseID: "pebble", courseName: "Magnolia" }],
        });
      }
      if (url.endsWith("/courses/pebble")) return jsonResponse(coursePayload("pebble", 28));
      if (url.endsWith("/coordinates/pebble")) return jsonResponse(coordPayload("pebble", 27));
      throw new Error(url);
    });
    await runDrain();
    expect(calls).toEqual([
      "https://golfapi.io/api/v2.3/courses?country=US&q=Magnolia",
      "https://golfapi.io/api/v2.3/courses/pebble",
      "https://golfapi.io/api/v2.3/coordinates/pebble",
    ]);
    expect(kv.has(queued[0])).toBe(false);
    expect(kv.has("gqueue:q:nope")).toBe(false);
    const token = queued[0].slice("gqueue:q:".length);
    expect(kv.get(`gapi:search:${token}`)?.opts.expirationTtl).toBe(30 * DAY);
    expect(kv.get("gapi:course:pebble")?.opts.expirationTtl).toBe(365 * DAY);
    expect(kv.get("gapi:coord:pebble")?.value).toContain("coordinates");
    expect(stats().lookups).toBe(1);

    fetchMock.mockClear();
    expect((await golfGet("/golfapi/v2.3/courses?q=magnolia")).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats().lookups).toBe(1);
  });

  it("stores only the search when the queued name is not a single match", async () => {
    async function enqueue(path) {
      kv.set("gq:balance", { value: JSON.stringify({ left: 9, at: 1, lastStatus: 200 }) });
      expect((await golfGet(path)).status).toBe(429);
      kv.set("gq:balance", { value: JSON.stringify({ left: 40, at: 1, lastStatus: 200 }) });
    }

    await enqueue("/golfapi/v2.3/courses?q=Pine");
    const calls = [];
    mockGolfApi(async (url) => {
      calls.push(url);
      return jsonResponse({
        apiRequestsLeft: "30",
        numCourses: 2,
        courses: [
          { courseID: "a", courseName: "Pine" },
          { courseID: "b", clubName: "Pine" },
        ],
      });
    });
    await runDrain();
    expect(calls).toEqual(["https://golfapi.io/api/v2.3/courses?q=Pine"]);
    expect([...kv.keys()].some((key) => key.startsWith("gapi:course:"))).toBe(false);
    expect([...kv.keys()].some((key) => key.startsWith("gapi:search:"))).toBe(true);
    expect([...kv.keys()].some((key) => key.startsWith("gqueue:"))).toBe(false);
    expect(stats().lookups).toBe(1);

    kv.clear();
    edge.clear();
    calls.length = 0;
    await enqueue("/golfapi/v2.3/courses?q=Missing");
    mockGolfApi(async (url) => {
      calls.push(url);
      return jsonResponse({
        apiRequestsLeft: "22",
        numCourses: 1,
        courses: [{ courseID: "zzz", courseName: "Other" }],
      });
    });
    await runDrain();
    expect(calls).toEqual(["https://golfapi.io/api/v2.3/courses?q=Missing"]);
    expect([...kv.keys()].some((key) => key.startsWith("gapi:course:"))).toBe(false);
    expect([...kv.keys()].some((key) => key.startsWith("gqueue:"))).toBe(false);
    expect(stats().lookups).toBe(1);
  });

  it("leaves a queued search in place when the floor hits before course details", async () => {
    kv.set("gq:balance", { value: JSON.stringify({ left: 9, at: 1, lastStatus: 200 }) });
    expect((await golfGet("/golfapi/v2.3/courses?q=Magnolia")).status).toBe(429);
    const queued = [...kv.keys()].filter((key) => key.startsWith("gqueue:q:"));
    kv.set("gq:balance", { value: JSON.stringify({ left: 40, at: 1, lastStatus: 200 }) });
    mockGolfApi(async () => jsonResponse({
      apiRequestsLeft: "10",
      numCourses: 1,
      courses: [{ courseID: "pebble", courseName: "Magnolia" }],
    }));
    await runDrain();
    expect(kv.has(queued[0])).toBe(true);
    expect(JSON.parse(kv.get(queued[0]).value).attempts).toBe(0);
    expect(kv.has("gapi:search:" + queued[0].slice("gqueue:q:".length))).toBe(true);
    expect(kv.has("gapi:course:pebble")).toBe(false);
    expect(stats().lookups).toBe(1);

    const calls = [];
    kv.set("gq:balance", { value: JSON.stringify({ left: 30, at: 1, lastStatus: 200 }) });
    mockGolfApi(async (url) => {
      calls.push(url);
      if (url.endsWith("/courses/pebble")) return jsonResponse(coursePayload("pebble", 20));
      if (url.endsWith("/coordinates/pebble")) return jsonResponse(coordPayload("pebble", 19));
      throw new Error(url);
    });
    await runDrain();
    expect(calls).toEqual([
      "https://golfapi.io/api/v2.3/courses/pebble",
      "https://golfapi.io/api/v2.3/coordinates/pebble",
    ]);
    expect(kv.has(queued[0])).toBe(false);
    expect(stats().lookups).toBe(2);
  });

  it("does not count allowlisted installs toward the global cap or IP counters", async () => {
    const owner = "owner-allow-1";
    const otherListed = "someone-else";
    const envAllow = {
      ...env,
      GOLFAPI_GLOBAL_DAY: "1",
      GOLFAPI_DEVICE_DAY: "1",
      GOLFAPI_IP_DAY: "1",
      GOLFAPI_ALLOWLIST: ` ${otherListed}, ${owner} `,
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`shottrax-golfapi-ip-v1:${CLIENT_IP}`),
    );
    const ipHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const cappedBucket = JSON.stringify({
      day: todayKey(),
      dayCount: 5,
      searchDay: todayKey(),
      searchCount: 9,
    });
    kv.set(`gq:stats:${todayKey()}`, {
      value: JSON.stringify({ lookups: 1, searches: 0, hits: 0, blocked: {} }),
    });
    kv.set(`gq:dev:${owner}`, { value: cappedBucket });
    kv.set(`gq:ip:${ipHash}`, { value: cappedBucket });
    kv.set(`gq:set:ip:${ipHash}`, { value: JSON.stringify({ at: Date.now(), courseId: "kept" }) });

    mockGolfApi(async (url) => {
      if (url.includes("/courses?")) {
        return jsonResponse({ apiRequestsLeft: "80", numCourses: 0, courses: [] });
      }
      return jsonResponse(coursePayload(url.split("/").pop(), 70));
    });
    for (const query of ["one", "two", "three", "four"]) {
      expect((await golfGet(`/golfapi/v2.3/courses?q=${query}`, { install: owner, env: envAllow })).status).toBe(200);
    }
    expect((await golfGet("/golfapi/v2.3/courses/a1", { install: owner, env: envAllow })).status).toBe(200);
    expect((await golfGet("/golfapi/v2.3/courses/a2", { install: owner, env: envAllow })).status).toBe(200);
    expect(stats().lookups).toBe(1);
    expect(stats().allowlistedLookups).toBe(2);
    expect(stats().searches).toBe(4);
    expect(JSON.parse(kv.get(`gq:dev:${owner}`).value).dayCount).toBe(5);
    expect(JSON.parse(kv.get(`gq:dev:${owner}`).value).searchCount).toBe(9);
    expect(JSON.parse(kv.get(`gq:ip:${ipHash}`).value).dayCount).toBe(5);
    expect(JSON.parse(kv.get(`gq:ip:${ipHash}`).value).searchCount).toBe(9);
    expect(JSON.parse(kv.get(`gq:set:ip:${ipHash}`).value).courseId).toBe("kept");

    const blocked = await golfGet("/golfapi/v2.3/courses/n1", { env: envAllow });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).reason).toBe("global_day");
    expect(stats().lookups).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const meta = await invoke(`${ORIGIN}/meta/golfapi`, { env: envAllow });
    const body = await meta.json();
    expect(body.globalCap).toBe(1);
    expect(body.today.globalCap).toBe(1);
    expect(body.today.globalLookups).toBe(1);
    expect(body.today.allowlistedLookups).toBe(2);
    expect(body.days).toHaveLength(30);
    expect(body.days[29].allowlistedLookups).toBe(2);
    expect(body.days[0].allowlistedLookups).toBe(0);
    const text = JSON.stringify(body);
    expect(text).not.toContain(owner);
    expect(text).not.toContain(otherListed);
    expect(text).not.toContain("GOLFAPI_ALLOWLIST");

    kv.set("gq:balance", { value: JSON.stringify({ left: 10, at: 1, lastStatus: 200 }) });
    fetchMock.mockClear();
    const floored = await golfGet("/golfapi/v2.3/courses/floor", { install: owner, env: envAllow });
    const floorBody = await floored.json();
    expect(floored.status).toBe(429);
    expect(floorBody.reason).toBe("floor");
    expect(floorBody.queued).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats().allowlistedLookups).toBe(2);
    expect(stats().lookups).toBe(1);
  });

  it("reports fetch time count, median, and max without the raw sample", async () => {
    kv.set(`gq:stats:${todayKey()}`, {
      value: JSON.stringify({
        lookups: 0,
        searches: 0,
        hits: 0,
        blocked: {},
        latency: {
          search: { count: 4, max: 900, samples: [40, 10, 30, 20] },
          course: { count: 21, max: 10, samples: Array(21).fill(10) },
          coordinates: { count: 0, max: 0, samples: [] },
        },
      }),
    });
    mockGolfApi(async () => jsonResponse(coursePayload("timed", 40)));
    expect((await golfGet("/golfapi/v2.3/courses/timed")).status).toBe(200);

    const meta = await invoke(`${ORIGIN}/meta/golfapi`);
    const body = await meta.json();
    expect(body.globalCap).toBe(100);
    expect(body.today.latency.search).toEqual({ count: 4, median: 25, max: 900 });
    expect(body.today.latency.coordinates).toEqual({ count: 0, median: null, max: 0 });
    expect(body.today.latency.course.count).toBe(22);
    expect(body.today.latency.course.max).toBeGreaterThanOrEqual(10);
    expect(body.today.latency.course.median).toEqual(expect.any(Number));
    expect(JSON.stringify(body.latency || body.today.latency)).not.toContain("samples");
    const stored = stats().latency.course;
    expect(stored.count).toBe(22);
    expect(stored.samples).toHaveLength(21);

    const overridden = await invoke(`${ORIGIN}/meta/golfapi`, { env: { ...env, GOLFAPI_GLOBAL_DAY: "25" } });
    expect((await overridden.json()).globalCap).toBe(25);
    const invalid = await invoke(`${ORIGIN}/meta/golfapi`, { env: { ...env, GOLFAPI_GLOBAL_DAY: "nope" } });
    expect((await invalid.json()).globalCap).toBe(100);
  });

  // Printed Magnolia Country Club card, verified 2026-09-27. Front/back par 36/36.
  const MAGNOLIA_PAR = [4, 4, 4, 5, 4, 4, 4, 3, 4, 5, 3, 5, 4, 4, 4, 3, 4, 4];
  const MAGNOLIA_MEN = [17, 9, 1, 13, 3, 5, 15, 11, 7, 16, 18, 14, 10, 2, 4, 12, 8, 6];
  const MAGNOLIA_WOMEN = [17, 7, 3, 9, 11, 1, 13, 15, 5, 8, 16, 12, 14, 4, 2, 10, 18, 6];
  const MAGNOLIA_SOURCE = "club scorecard photo, verified 2026-09-27";
  const SCORECARD_VERSION = "2026-09-27";

  function scorecardCorrection(source, fields, mode = "fill") {
    return { source, fields, mode, version: SCORECARD_VERSION };
  }

  function permutationOf1to18(values) {
    expect(values).toHaveLength(18);
    expect([...values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  }

  function scorecardHoles(overrides = {}) {
    return MAGNOLIA_PAR.map((par, index) => ({
      par,
      yardage: 300 + index,
      handicap: null,
      handicap_women: null,
      ...(overrides[index] ?? {}),
    }));
  }

  function magnoliaScorecard(teeboxes) {
    return JSON.stringify({
      data: {
        club_name: "Magnolia Country Club",
        scorecard: {
          teeboxes,
        },
      },
    });
  }

  function upstreamMagnolia() {
    return magnoliaScorecard([
      { name: "Gold", course_rating: 73, slope_rating: 127, total_yards: 6780, holes: scorecardHoles() },
      { name: "Blue", course_rating: 71.5, slope_rating: 124, total_yards: 6455, holes: scorecardHoles() },
      { name: "White", course_rating: 69, slope_rating: 120, total_yards: 5893, holes: scorecardHoles() },
    ]);
  }

  function scorecardResponse(body, status = 200, contentType = "application/json") {
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }

  it("stores Magnolia stroke indexes as permutations of 1..18", () => {
    const card = GCA_CORRECTIONS[GCA_ID];
    expect(card.mode ?? "fill").toBe("fill");
    expect(card.version).toBe(SCORECARD_VERSION);
    expect(card.source).toBe(MAGNOLIA_SOURCE);
    expect(card.par).toEqual(MAGNOLIA_PAR);
    expect(card.par.slice(0, 9).reduce((sum, par) => sum + par, 0)).toBe(36);
    expect(card.par.slice(9).reduce((sum, par) => sum + par, 0)).toBe(36);
    permutationOf1to18(card.handicapMen);
    permutationOf1to18(card.handicapWomen);
    expect(card.handicapMen).toEqual(MAGNOLIA_MEN);
    expect(card.handicapWomen).toEqual(MAGNOLIA_WOMEN);
  });

  it("fills Magnolia men's and women's stroke index on Gold, Blue, and White", async () => {
    const raw = upstreamMagnolia();
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const json = await response.json();
    expect(json.data.scorecard.teeboxes.map((tee) => tee.name)).toEqual(["Gold", "Blue", "White"]);
    for (const tee of json.data.scorecard.teeboxes) {
      expect(tee.holes.map((hole) => hole.par)).toEqual(MAGNOLIA_PAR);
      expect(tee.holes.map((hole) => hole.handicap)).toEqual(MAGNOLIA_MEN);
      expect(tee.holes.map((hole) => hole.handicap_women)).toEqual(MAGNOLIA_WOMEN);
      expect(tee.holes.map((hole) => hole.yardage)).toEqual(MAGNOLIA_PAR.map((_, index) => 300 + index));
    }
    expect(json.data.scorecard.teeboxes[0].total_yards).toBe(6780);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(MAGNOLIA_SOURCE, ["handicap", "handicap_women"]),
    );
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/${GCA_ID}`).clone().text()).toBe(raw);
  });

  it("does not overwrite an upstream par, handicap, or handicap_women", async () => {
    const raw = magnoliaScorecard([
      {
        name: "Gold",
        holes: scorecardHoles({
          0: { handicap: 9 },
          1: { handicap_women: 4 },
          2: { handicap: 0 },
          3: { par: 0 },
          4: { par: null },
        }),
      },
    ]);
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const json = await (await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`)).json();
    const holes = json.data.scorecard.teeboxes[0].holes;
    expect(holes[0].handicap).toBe(9);
    expect(holes[0].handicap_women).toBe(MAGNOLIA_WOMEN[0]);
    expect(holes[0].par).toBe(4);
    expect(holes[1].handicap_women).toBe(4);
    expect(holes[1].handicap).toBe(MAGNOLIA_MEN[1]);
    expect(holes[2].handicap).toBe(0);
    expect(holes[2].par).toBe(MAGNOLIA_PAR[2]);
    expect(holes[3].par).toBe(MAGNOLIA_PAR[3]);
    expect(holes[4].par).toBe(MAGNOLIA_PAR[4]);
    expect(holes.map((hole) => hole.handicap)).toEqual([9, 9, 0, 13, 3, 5, 15, 11, 7, 16, 18, 14, 10, 2, 4, 12, 8, 6]);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(MAGNOLIA_SOURCE, ["par", "handicap", "handicap_women"]),
    );
  });

  it("skips a teebox when an upstream par disagrees with the card", async () => {
    const mismatched = scorecardHoles({ 2: { par: 5 } });
    const raw = magnoliaScorecard([
      { name: "Gold", holes: mismatched },
      { name: "White", holes: scorecardHoles() },
      { name: "Short", holes: scorecardHoles().slice(0, 9) },
    ]);
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const json = await (await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`)).json();
    const [gold, white, short] = json.data.scorecard.teeboxes;
    expect(gold.holes.map((hole) => hole.par)).toEqual(mismatched.map((hole) => hole.par));
    expect(gold.holes.every((hole) => hole.handicap == null && hole.handicap_women == null)).toBe(true);
    expect(white.holes.map((hole) => hole.handicap)).toEqual(MAGNOLIA_MEN);
    expect(white.holes.map((hole) => hole.handicap_women)).toEqual(MAGNOLIA_WOMEN);
    expect(short.holes).toHaveLength(9);
    expect(short.holes.every((hole) => hole.handicap == null)).toBe(true);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(MAGNOLIA_SOURCE, ["handicap", "handicap_women"]),
    );

    const onlyMismatch = magnoliaScorecard([{ name: "Gold", holes: mismatched }]);
    fetchMock.mockResolvedValue(scorecardResponse(onlyMismatch));
    kv.delete(`gca:course:${GCA_ID}`);
    const skipped = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}?x=1`);
    expect(await skipped.text()).toBe(onlyMismatch);
  });

  it("leaves non-listed ids and green-centers byte-identical", async () => {
    const marked = '{"data":{"scorecard":{"teeboxes":[{"holes":[{"par":4,"handicap":null,"handicap_women":null}]}] }},"keep":true}';
    const cases = [
      [`${ORIGIN}/gca/v1/courses/99999`, marked],
      [`${ORIGIN}/gca/v1/courses/${GCA_ID}/green-centers`, marked],
      [`${ORIGIN}/gca/v1/courses?q=magnolia`, marked],
      [`${ORIGIN}/golfapi/v2.3/courses/${GCA_ID}`, marked],
      [`${ORIGIN}/gca/v1/courses/${GCA_ID}`, "not-json"],
    ];
    for (const [url, body] of cases) {
      const contentType = body === "not-json" ? "text/plain" : "application/json";
      fetchMock.mockResolvedValue(scorecardResponse(body, 200, contentType));
      const headers = url.includes("/golfapi/") ? { "X-Install-Id": "install-0001" } : undefined;
      const response = await invoke(url, { headers });
      expect(await response.text()).toBe(body);
    }

    edge.delete(`${ORIGIN}/gca/v1/courses/${GCA_ID}`);
    kv.delete(`gca:course:${GCA_ID}`);
    fetchMock.mockResolvedValue(scorecardResponse(marked, 403));
    const forbidden = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe(marked);

    edge.set(`${ORIGIN}/gca/v1/courses/99999`, scorecardResponse(marked));
    edge.set(`${ORIGIN}/gca/v1/courses/${GCA_ID}/green-centers`, scorecardResponse(marked));
    const calls = fetchMock.mock.calls.length;
    const cachedCourse = await invoke(`${ORIGIN}/gca/v1/courses/99999`);
    const cachedGreens = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}/green-centers`);
    expect(await cachedCourse.text()).toBe(marked);
    expect(await cachedGreens.text()).toBe(marked);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("corrects a course body that is already in the edge cache", async () => {
    const raw = upstreamMagnolia();
    const url = `${ORIGIN}/gca/v1/courses/${GCA_ID}`;
    edge.set(url, scorecardResponse(raw, 200, "application/json; charset=utf-8"));
    const response = await invoke(url);
    expect(fetchMock).not.toHaveBeenCalled();
    const json = await response.json();
    expect(json.data.scorecard.teeboxes).toHaveLength(3);
    for (const tee of json.data.scorecard.teeboxes) {
      expect(tee.holes.map((hole) => hole.handicap)).toEqual(MAGNOLIA_MEN);
      expect(tee.holes.map((hole) => hole.handicap_women)).toEqual(MAGNOLIA_WOMEN);
    }
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(MAGNOLIA_SOURCE, ["handicap", "handicap_women"]),
    );
    expect(await edge.get(url).clone().text()).toBe(raw);

    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const fresh = await invoke(`${url}?fresh=1`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const again = await invoke(`${url}?fresh=1`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const freshJson = await fresh.json();
    const againJson = await again.json();
    expect(againJson).toEqual(freshJson);
    expect(againJson.data.scorecard.teeboxes[1].holes.map((hole) => hole.handicap)).toEqual(MAGNOLIA_MEN);
    expect(await edge.get(`${url}?fresh=1`).clone().text()).toBe(raw);
  });

  const COURSE_RAW = '{"id":14322,"name":"Magnolia","holes":18}';
  const GREENS_RAW = '{"id":14322,"greens":[{"hole":1,"lat":33.19,"lng":-93.21}]}';
  const COURSE_NEXT = '{"id":14322,"name":"Magnolia","holes":18,"updated":true}';

  function gcaStats() {
    const row = kv.get(`gca:stats:${todayKey()}`);
    return row ? JSON.parse(row.value) : { upstream: 0, rateLimited: 0, stale: 0, missingInstallId: 0 };
  }

  function seedGca(key, body, storedAt) {
    kv.set(key, {
      value: body,
      metadata: { status: 200, storedAt },
      opts: { expirationTtl: 365 * DAY, metadata: { status: 200, storedAt } },
    });
  }

  function mockGca(responder) {
    fetchMock.mockImplementation(async (url, init) => {
      expect(init.headers.Authorization).toBe("Bearer gca-secret");
      expect(init.headers.Accept).toBe("application/json");
      return responder(String(url), init);
    });
  }

  it("limits GCA course-detail client caching to five minutes and keeps the edge copy for a day", async () => {
    const url = `${ORIGIN}/gca/v1/courses/10001`;
    const raw = '{"id":"10001","name":"Plain"}';
    edge.set(url, new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
    }));
    const edgeHit = await invoke(url);
    expect(edgeHit.status).toBe(200);
    expect(edgeHit.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await edgeHit.text()).toBe(raw);
    expect(edge.get(url).headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(fetchMock).not.toHaveBeenCalled();

    edge.clear();
    seedGca("gca:course:10001", raw, Date.now() - 1000);
    const fromKv = await invoke(url);
    expect(fromKv.status).toBe(200);
    expect(fromKv.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await fromKv.text()).toBe(raw);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(edge.get(url).headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await edge.get(url).text()).toBe(raw);

    edge.clear();
    kv.delete("gca:course:10001");
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const upstream = await invoke(url);
    expect(upstream.status).toBe(200);
    expect(upstream.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await upstream.text()).toBe(raw);
    expect(edge.get(url).headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await edge.get(url).text()).toBe(raw);
  });

  it("serves a fresh GCA KV copy without calling upstream and rewarms the edge cache", async () => {
    const storedAt = Date.now() - 29 * DAY * 1000;
    seedGca("gca:course:14322", COURSE_RAW, storedAt);
    seedGca("gca:greens:14322", GREENS_RAW, storedAt);
    const course = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(course.status).toBe(200);
    expect(course.headers.get("X-Course-Data-Stale")).toBeNull();
    expect(await course.text()).toBe(COURSE_RAW);
    const greens = await invoke(`${ORIGIN}/gca/v1/courses/14322/green-centers`);
    expect(greens.status).toBe(200);
    expect(await greens.text()).toBe(GREENS_RAW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/14322`).text()).toBe(COURSE_RAW);
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/14322/green-centers`).text()).toBe(GREENS_RAW);
    expect(gcaStats()).toEqual({ upstream: 0, rateLimited: 0, stale: 0, missingInstallId: 2 });
    expect(presentGcaCourseBody("course", "14322", COURSE_RAW)).toBe(COURSE_RAW);
  });

  it("refreshes an old GCA copy on 2xx and serves it stale on 429, 5xx, and timeout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const storedAt = Date.now() - 30 * DAY * 1000;
    seedGca("gca:course:14322", COURSE_RAW, storedAt);
    mockGca(async (url) => {
      expect(url).toBe("https://golfcoursesapi.com/api/v1/courses/14322?pin=1");
      return new Response(COURSE_NEXT, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "77",
          "X-RateLimit-Reset": "60",
          "RateLimit-Remaining": "77",
        },
      });
    });
    const refreshed = await invoke(`${ORIGIN}/gca/v1/courses/14322?pin=1`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("X-Course-Data-Stale")).toBeNull();
    expect(await refreshed.text()).toBe(COURSE_NEXT);
    expect(kv.get("gca:course:14322").value).toBe(COURSE_NEXT);
    expect(kv.get("gca:course:14322").metadata).toMatchObject({ status: 200 });
    expect(kv.get("gca:course:14322").metadata.storedAt).toBeGreaterThan(storedAt);
    expect(kv.get("gca:course:14322").opts.expirationTtl).toBe(365 * DAY);
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/14322?pin=1`).text()).toBe(COURSE_NEXT);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      route: "course",
      status: 200,
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "77",
      "x-ratelimit-reset": "60",
      "ratelimit-remaining": "77",
    });
    expect(gcaStats()).toEqual({ upstream: 1, rateLimited: 0, stale: 0, missingInstallId: 1 });

    edge.clear();
    fetchMock.mockClear();
    log.mockClear();
    const oldAt = Date.now() - 40 * DAY * 1000;
    seedGca("gca:course:14322", COURSE_RAW, oldAt);
    const expectedAge = Math.floor((Date.now() - oldAt) / 1000);
    mockGca(async () => new Response("slow down", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "120" },
    }));
    const limited = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(limited.status).toBe(200);
    expect(limited.headers.get("X-Course-Data-Stale")).toBe("1");
    const age = Number(limited.headers.get("X-Course-Data-Age"));
    expect(age).toBeGreaterThanOrEqual(expectedAge);
    expect(age).toBeLessThanOrEqual(expectedAge + 2);
    expect(await limited.text()).toBe(COURSE_RAW);
    expect(kv.get("gca:course:14322").value).toBe(COURSE_RAW);
    expect(kv.get("gca:course:14322").metadata.storedAt).toBe(oldAt);
    expect(edge.size).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ route: "course", status: 429, "retry-after": "120" });

    fetchMock.mockClear();
    mockGca(async () => new Response("busy", { status: 503, headers: { "Content-Type": "text/plain" } }));
    const failed = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(failed.status).toBe(200);
    expect(failed.headers.get("X-Course-Data-Stale")).toBe("1");
    expect(await failed.text()).toBe(COURSE_RAW);
    expect(kv.get("gca:course:14322").value).toBe(COURSE_RAW);
    expect(edge.size).toBe(0);

    fetchMock.mockClear();
    vi.useFakeTimers();
    try {
      const timeoutAt = Date.now() - 31 * DAY * 1000;
      seedGca("gca:greens:14322", GREENS_RAW, timeoutAt);
      mockGca((url, init) => {
        expect(url).toBe("https://golfcoursesapi.com/api/v1/courses/14322/green-centers");
        return new Promise((resolve, reject) => {
          const fail = () => reject(new Error("The operation was aborted"));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener("abort", fail, { once: true });
        });
      });
      const pending = invoke(`${ORIGIN}/gca/v1/courses/14322/green-centers`);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const timedOut = await pending;
      expect(timedOut.status).toBe(200);
      expect(timedOut.headers.get("X-Course-Data-Stale")).toBe("1");
      expect(timedOut.headers.get("X-Course-Data-Age")).toBe(String(31 * DAY + 15));
      expect(await timedOut.text()).toBe(GREENS_RAW);
      expect(kv.get("gca:greens:14322").value).toBe(GREENS_RAW);
      expect(kv.get("gca:greens:14322").metadata.storedAt).toBe(timeoutAt);
    } finally {
      vi.useRealTimers();
      log.mockRestore();
    }
  });

  it("passes Retry-After on a GCA 429 when nothing is stored and never stores errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGca(async () => new Response("slow down", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "45" },
    }));
    const limited = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("45");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(kv.has("gca:course:14322")).toBe(false);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ route: "course", status: 429, "retry-after": "45" });

    fetchMock.mockClear();
    mockGca(async () => new Response("slow down", { status: 429, headers: { "Content-Type": "text/plain" } }));
    const fallback = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(fallback.status).toBe(429);
    expect(fallback.headers.get("Retry-After")).toBe("30");
    expect(await fallback.json()).toEqual({ error: "rate_limited" });
    expect(kv.has("gca:course:14322")).toBe(false);

    fetchMock.mockClear();
    mockGca(async () => new Response("busy", { status: 502, headers: { "Content-Type": "text/plain" } }));
    const failed = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe("busy");
    expect(kv.has("gca:course:14322")).toBe(false);
    expect(edge.size).toBe(0);

    fetchMock.mockClear();
    mockGca(async () => {
      throw new Error("network");
    });
    const thrown = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(thrown.status).toBe(502);
    expect(await thrown.json()).toEqual({ error: "upstream_unreachable" });
    expect(kv.has("gca:course:14322")).toBe(false);

    fetchMock.mockClear();
    mockGca(async () => new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } }));
    const missing = await invoke(`${ORIGIN}/gca/v1/courses/99999`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("missing");
    expect(kv.has("gca:course:99999")).toBe(false);
    fetchMock.mockClear();
    const missingAgain = await invoke(`${ORIGIN}/gca/v1/courses/99999`);
    expect(missingAgain.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.has("gca:course:99999")).toBe(false);

    const courseKeys = [...kv.keys()].filter((key) => key.startsWith("gca:course:") || key.startsWith("gca:greens:"));
    expect(courseKeys).toEqual([]);
    expect(gcaStats().rateLimited).toBe(2);
    expect(gcaStats().stale).toBe(0);
    expect(gcaStats().upstream).toBe(5);
    log.mockRestore();
  });

  it("leaves GCA search on the edge cache and out of the course store", async () => {
    mockGca(async (url) => {
      expect(url).toBe("https://golfcoursesapi.com/api/v1/courses?q=magnolia");
      return new Response('{"courses":[{"id":"m"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const search = await invoke(`${ORIGIN}/gca/v1/courses?q=magnolia`);
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ courses: [{ id: "m" }] });
    fetchMock.mockClear();
    const again = await invoke(`${ORIGIN}/gca/v1/courses?q=magnolia`);
    expect(again.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...kv.keys()].filter((key) => key.startsWith("gca:course:") || key.startsWith("gca:greens:"))).toEqual([]);

    edge.clear();
    mockGca(async () => new Response("slow down", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "9" },
    }));
    const limited = await invoke(`${ORIGIN}/gca/v1/courses?q=other`);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("slow down");
    expect(kv.has("gca:course:other")).toBe(false);
    expect([...kv.keys()].some((key) => key.startsWith("gq:"))).toBe(false);
  });

  it("counts GCA upstream calls, 429s, and stale serves for /meta/gca", async () => {
    mockGca(async (url) => {
      if (url.endsWith("/courses/fresh")) {
        return new Response('{"id":"fresh"}', { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("no", { status: 429, headers: { "Retry-After": "30" } });
    });
    expect((await invoke(`${ORIGIN}/gca/v1/courses/fresh`)).status).toBe(200);
    expect((await invoke(`${ORIGIN}/gca/v1/courses/missing`)).status).toBe(429);
    seedGca("gca:course:old", COURSE_RAW, Date.now() - 31 * DAY * 1000);
    const stale = await invoke(`${ORIGIN}/gca/v1/courses/old`);
    expect(stale.headers.get("X-Course-Data-Stale")).toBe("1");
    expect(gcaStats()).toEqual({ upstream: 3, rateLimited: 2, stale: 1, missingInstallId: 3 });
    expect(kv.get(`gca:stats:${todayKey()}`).opts.expirationTtl).toBe(40 * DAY);

    const meta = await invoke(`${ORIGIN}/meta/gca`);
    expect(meta.status).toBe(200);
    expect(meta.headers.get("Cache-Control")).toBe("no-store");
    const body = await meta.json();
    expect(body.refreshDays).toBe(30);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.days).toHaveLength(30);
    expect(body.today).toEqual({
      date: todayKey(),
      upstream: 3,
      rateLimited: 2,
      stale: 1,
      missingInstallId: 3,
    });
    expect(body.days[29]).toEqual(body.today);
    expect(body.days[0].upstream).toBe(0);
    const text = JSON.stringify(body);
    expect(text).not.toContain("gca-secret");
    expect(text).not.toContain("Bearer");

    const overridden = await invoke(`${ORIGIN}/meta/gca`, { env: { ...env, GCA_REFRESH_DAYS: "7" } });
    expect((await overridden.json()).refreshDays).toBe(7);
    const invalid = await invoke(`${ORIGIN}/meta/gca`, { env: { ...env, GCA_REFRESH_DAYS: "nope" } });
    expect((await invalid.json()).refreshDays).toBe(30);

    const weekEnv = { ...env, GCA_REFRESH_DAYS: "1" };
    seedGca("gca:course:week", COURSE_RAW, Date.now() - 2 * 60 * 60 * 1000);
    fetchMock.mockClear();
    const stillFresh = await invoke(`${ORIGIN}/gca/v1/courses/week`, { env: weekEnv });
    expect(stillFresh.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    seedGca("gca:course:week", COURSE_RAW, Date.now() - 2 * DAY * 1000);
    edge.clear();
    mockGca(async () => new Response(COURSE_NEXT, { status: 200, headers: { "Content-Type": "application/json" } }));
    const due = await invoke(`${ORIGIN}/gca/v1/courses/week`, { env: weekEnv });
    expect(due.status).toBe(200);
    expect(await due.text()).toBe(COURSE_NEXT);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const post = await invoke(`${ORIGIN}/meta/gca`, { method: "PUT", body: "{}" });
    expect(post.status).toBe(405);
    const down = await invoke(`${ORIGIN}/meta/gca`, { env: {} });
    expect(down.status).toBe(503);
    const courseDown = await invoke(`${ORIGIN}/gca/v1/courses/14322`, { env: { GOLF_COURSES_API_KEY: "gca-secret" } });
    expect(courseDown.status).toBe(503);
    expect(await courseDown.json()).toEqual({ error: "boards_not_configured" });
  });

  it("serves GCA without an install id until GCA_REQUIRE_INSTALL_ID is on", async () => {
    const appId = "id_1790517745797_pfjtwbfa";
    seedGca("gca:course:14322", COURSE_RAW, Date.now() - 1000);
    const fromKv = await invoke(`${ORIGIN}/gca/v1/courses/14322`);
    expect(fromKv.status).toBe(200);
    expect(await fromKv.text()).toBe(COURSE_RAW);
    expect(fromKv.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gcaStats().missingInstallId).toBe(1);

    let kvOps = 0;
    for (const method of ["get", "getWithMetadata", "put", "delete", "list"]) {
      const original = env.BOARDS[method].bind(env.BOARDS);
      env.BOARDS[method] = async (...args) => {
        kvOps += 1;
        return original(...args);
      };
    }
    const edgeHit = await invoke(`${ORIGIN}/gca/v1/courses/14322`, {
      env: { ...env, GCA_REQUIRE_INSTALL_ID: "nope" },
    });
    expect(edgeHit.status).toBe(200);
    expect(await edgeHit.text()).toBe(COURSE_RAW);
    expect(gcaStats().missingInstallId).toBe(1);
    expect(kvOps).toBe(0);

    const named = await invoke(`${ORIGIN}/gca/v1/courses/14322`, {
      headers: { "X-Install-Id": appId },
    });
    expect(named.status).toBe(200);
    expect(gcaStats().missingInstallId).toBe(1);

    mockGca(async () => new Response('{"id":"upstream"}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const upstream = await invoke(`${ORIGIN}/gca/v1/courses/upstream`);
    expect(upstream.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gcaStats().missingInstallId).toBe(2);

    const upstreamId = await invoke(`${ORIGIN}/gca/v1/courses/with-id`, {
      headers: { "X-Install-Id": appId },
    });
    expect(upstreamId.status).toBe(200);
    expect(gcaStats().missingInstallId).toBe(2);

    const closed = {
      ...env,
      GCA_REQUIRE_INSTALL_ID: "true",
      BOARDS: {
        async get() { throw new Error("kv read"); },
        async getWithMetadata() { throw new Error("kv read"); },
        async put() { throw new Error("kv write"); },
        async delete() { throw new Error("kv write"); },
        async list() { throw new Error("kv list"); },
      },
    };
    fetchMock.mockClear();
    const denied = await invoke(`${ORIGIN}/gca/v1/courses/14322`, { env: closed });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "install_id_required" });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await invoke(`${ORIGIN}/gca/v1/courses/14322`, {
      env: { ...env, GCA_REQUIRE_INSTALL_ID: "true" },
      headers: { "X-Install-Id": appId },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe(COURSE_RAW);
    expect(gcaStats().missingInstallId).toBe(2);
  });

  function expectMagnoliaFilled(json) {
    expect(json.data.scorecard.teeboxes).toHaveLength(3);
    for (const tee of json.data.scorecard.teeboxes) {
      expect(tee.holes.map((hole) => hole.handicap)).toEqual(MAGNOLIA_MEN);
      expect(tee.holes.map((hole) => hole.handicap_women)).toEqual(MAGNOLIA_WOMEN);
    }
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(MAGNOLIA_SOURCE, ["handicap", "handicap_women"]),
    );
  }

  it("fills Magnolia stroke indexes from a fresh KV copy and leaves that copy raw", async () => {
    const raw = upstreamMagnolia();
    seedGca(`gca:course:${GCA_ID}`, raw, Date.now() - 2 * DAY * 1000);
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Course-Data-Stale")).toBeNull();
    expectMagnoliaFilled(await response.json());
    expect(kv.get(`gca:course:${GCA_ID}`).value).toBe(raw);
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/${GCA_ID}`).text()).toBe(raw);
  });

  it("fills Magnolia stroke indexes when a stale KV copy is served on 429", async () => {
    const raw = upstreamMagnolia();
    seedGca(`gca:course:${GCA_ID}`, raw, Date.now() - 40 * DAY * 1000);
    fetchMock.mockResolvedValue(new Response("slow down", {
      status: 429,
      headers: { "Content-Type": "text/plain", "Retry-After": "30" },
    }));
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Course-Data-Stale")).toBe("1");
    expectMagnoliaFilled(await response.json());
    expect(kv.get(`gca:course:${GCA_ID}`).value).toBe(raw);
    expect(edge.size).toBe(0);
  });

  it("stores the raw Magnolia upstream body in KV", async () => {
    const raw = upstreamMagnolia();
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${GCA_ID}`);
    expectMagnoliaFilled(await response.json());
    expect(kv.get(`gca:course:${GCA_ID}`).value).toBe(raw);
    expect(kv.get(`gca:course:${GCA_ID}`).value).not.toContain("corrections");
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/${GCA_ID}`).text()).toBe(raw);
  });

  // Club scorecard PDF golfgreystonecc.com, verified 2026-09-27. Front/back par 36/36.
  // The card and the course owner both confirm hole 18 is par 5. Upstream White
  // lists par 4, and parFixes rewrites that one hole before the stroke index fills.
  const GREYSTONE_ID = "14137";
  const GREYSTONE_PAR = [4, 3, 4, 4, 5, 3, 4, 4, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5];
  const GREYSTONE_MEN = [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8];
  const GREYSTONE_WOMEN = [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8];
  const GREYSTONE_SOURCE = "club scorecard PDF golfgreystonecc.com (greystone_scorecard.pdf), verified 2026-09-27";

  function greystoneHoles(pars, overrides = {}) {
    return pars.map((par, index) => ({
      par,
      yardage: 300 + index,
      handicap: null,
      handicap_women: null,
      ...(overrides[index] ?? {}),
    }));
  }

  function greystoneScorecard(teeboxes) {
    return JSON.stringify({
      data: {
        club_name: "Greystone Country Club",
        scorecard: {
          teeboxes,
        },
      },
    });
  }

  function upstreamGreystone(overridesByTee = {}) {
    const whitePar = GREYSTONE_PAR.map((par, index) => (index === 17 ? 4 : par));
    return greystoneScorecard([
      { name: "Grey", total_yards: 7051, holes: greystoneHoles(GREYSTONE_PAR, overridesByTee.Grey) },
      { name: "Blue", total_yards: 6509, holes: greystoneHoles(GREYSTONE_PAR, overridesByTee.Blue) },
      { name: "White", total_yards: 6038, holes: greystoneHoles(whitePar, overridesByTee.White) },
      { name: "Black", total_yards: 5451, holes: greystoneHoles(GREYSTONE_PAR, overridesByTee.Black) },
    ]);
  }

  it("stores Greystone stroke indexes as permutations of 1..18", () => {
    const card = GCA_CORRECTIONS[GREYSTONE_ID];
    expect(card.mode ?? "fill").toBe("fill");
    expect(card.version).toBe(SCORECARD_VERSION);
    expect(card.source).toBe(GREYSTONE_SOURCE);
    expect(card.par).toEqual(GREYSTONE_PAR);
    expect(card.par.slice(0, 9).reduce((sum, par) => sum + par, 0)).toBe(36);
    expect(card.par.slice(9).reduce((sum, par) => sum + par, 0)).toBe(36);
    permutationOf1to18(card.handicapMen);
    permutationOf1to18(card.handicapWomen);
    expect(card.handicapMen).toEqual(GREYSTONE_MEN);
    expect(card.handicapWomen).toEqual(GREYSTONE_WOMEN);
    expect(card.parFixes).toEqual([{ tee: "White", hole: 18, from: 4, to: 5 }]);
  });

  it("fills Greystone stroke index on every tee after correcting White hole 18", async () => {
    const body = JSON.parse(upstreamGreystone());
    body.data.scorecard.teeboxes[2].name = "WHITE";
    body.data.scorecard.teeboxes[2].course_rating = 69.1;
    body.data.scorecard.teeboxes[2].slope_rating = 122;
    const raw = JSON.stringify(body);
    const upstreamWhite = body.data.scorecard.teeboxes[2];
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${GREYSTONE_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const json = await response.json();
    expect(json.data.scorecard.teeboxes.map((tee) => tee.name)).toEqual(["Grey", "Blue", "WHITE", "Black"]);
    const [grey, blue, white, black] = json.data.scorecard.teeboxes;
    for (const tee of [grey, blue, white, black]) {
      expect(tee.holes.map((hole) => hole.par)).toEqual(GREYSTONE_PAR);
      expect(tee.holes.map((hole) => hole.handicap)).toEqual(GREYSTONE_MEN);
      expect(tee.holes.map((hole) => hole.handicap_women)).toEqual(GREYSTONE_WOMEN);
      expect(tee.holes.map((hole) => hole.yardage)).toEqual(GREYSTONE_PAR.map((_, index) => 300 + index));
    }
    expect(white.holes[17].par).toBe(5);
    expect(white.holes.slice(0, 17).map((hole) => hole.par)).toEqual(upstreamWhite.holes.slice(0, 17).map((hole) => hole.par));
    expect(white.holes.map((hole) => hole.yardage)).toEqual(upstreamWhite.holes.map((hole) => hole.yardage));
    expect(white.course_rating).toBe(69.1);
    expect(white.slope_rating).toBe(122);
    expect(white.total_yards).toBe(6038);
    expect([grey, blue, white, black].map((tee) => tee.total_yards)).toEqual([7051, 6509, 6038, 5451]);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(GREYSTONE_SOURCE, ["par", "handicap", "handicap_women"]),
    );
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/${GREYSTONE_ID}`).clone().text()).toBe(raw);
    expect(kv.get(`gca:course:${GREYSTONE_ID}`).value).toBe(raw);
    expect(kv.get(`gca:course:${GREYSTONE_ID}`).value).not.toContain("corrections");
  });

  it("does not overwrite an upstream Greystone handicap or handicap_women", async () => {
    const raw = upstreamGreystone({
      Grey: {
        0: { handicap: 9 },
        1: { handicap_women: 4 },
        2: { handicap: 0 },
      },
      White: {
        0: { handicap: 7 },
        5: { handicap_women: 2 },
      },
    });
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const json = await (await invoke(`${ORIGIN}/gca/v1/courses/${GREYSTONE_ID}`)).json();
    const [grey, blue, white, black] = json.data.scorecard.teeboxes;
    expect(grey.holes[0].handicap).toBe(9);
    expect(grey.holes[0].handicap_women).toBe(GREYSTONE_WOMEN[0]);
    expect(grey.holes[0].par).toBe(GREYSTONE_PAR[0]);
    expect(grey.holes[1].handicap_women).toBe(4);
    expect(grey.holes[1].handicap).toBe(GREYSTONE_MEN[1]);
    expect(grey.holes[2].handicap).toBe(0);
    expect(grey.holes[2].handicap_women).toBe(GREYSTONE_WOMEN[2]);
    expect(grey.holes.map((hole) => hole.par)).toEqual(GREYSTONE_PAR);
    expect(grey.holes.map((hole) => hole.handicap)).toEqual([9, 17, 0, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8]);
    expect(grey.holes.map((hole) => hole.handicap_women)).toEqual([13, 4, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8]);
    expect(blue.holes.map((hole) => hole.handicap)).toEqual(GREYSTONE_MEN);
    expect(blue.holes.map((hole) => hole.handicap_women)).toEqual(GREYSTONE_WOMEN);
    expect(black.holes.map((hole) => hole.handicap)).toEqual(GREYSTONE_MEN);
    expect(black.holes.map((hole) => hole.handicap_women)).toEqual(GREYSTONE_WOMEN);
    expect(white.holes.map((hole) => hole.par)).toEqual(GREYSTONE_PAR);
    expect(white.holes[17].par).toBe(5);
    expect(white.holes.map((hole) => hole.yardage)).toEqual(GREYSTONE_PAR.map((_, index) => 300 + index));
    expect(white.holes[0].handicap).toBe(7);
    expect(white.holes[0].handicap_women).toBe(GREYSTONE_WOMEN[0]);
    expect(white.holes[5].handicap).toBe(GREYSTONE_MEN[5]);
    expect(white.holes[5].handicap_women).toBe(2);
    expect(white.holes.map((hole) => hole.handicap)).toEqual([7, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8]);
    expect(white.holes.map((hole) => hole.handicap_women)).toEqual([13, 17, 5, 9, 7, 2, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8]);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(GREYSTONE_SOURCE, ["par", "handicap", "handicap_women"]),
    );
    expect(kv.get(`gca:course:${GREYSTONE_ID}`).value).toBe(raw);
  });

  it("does not change Greystone when White hole 18 is already par 5", async () => {
    const filled = (pars) => greystoneHoles(pars).map((hole, index) => ({
      ...hole,
      handicap: GREYSTONE_MEN[index],
      handicap_women: GREYSTONE_WOMEN[index],
    }));
    const raw = greystoneScorecard([
      { name: "Grey", course_rating: 73.8, slope_rating: 133, total_yards: 7051, holes: filled(GREYSTONE_PAR) },
      { name: "Blue", course_rating: 71.6, slope_rating: 128, total_yards: 6509, holes: filled(GREYSTONE_PAR) },
      { name: "WHITE", course_rating: 69.1, slope_rating: 122, total_yards: 6038, holes: filled(GREYSTONE_PAR) },
      { name: "Black", course_rating: 67.2, slope_rating: 115, total_yards: 5451, holes: filled(GREYSTONE_PAR) },
    ]);
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${GREYSTONE_ID}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
    expect(kv.get(`gca:course:${GREYSTONE_ID}`).value).toBe(raw);
  });

  it("skips the Greystone White par fix when hole 18 is neither 4 nor 5", async () => {
    const whitePar = GREYSTONE_PAR.map((par, index) => (index === 17 ? 3 : par));
    const body = JSON.parse(greystoneScorecard([
      { name: "Grey", course_rating: 73.8, slope_rating: 133, total_yards: 7051, holes: greystoneHoles(GREYSTONE_PAR) },
      { name: "Blue", course_rating: 71.6, slope_rating: 128, total_yards: 6509, holes: greystoneHoles(GREYSTONE_PAR) },
      { name: "White", course_rating: 69.1, slope_rating: 122, total_yards: 6038, holes: greystoneHoles(whitePar) },
      { name: "Black", course_rating: 67.2, slope_rating: 115, total_yards: 5451, holes: greystoneHoles(GREYSTONE_PAR) },
    ]));
    const raw = JSON.stringify(body);
    const upstream = body.data.scorecard.teeboxes;
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const json = await (await invoke(`${ORIGIN}/gca/v1/courses/${GREYSTONE_ID}`)).json();
    const [grey, blue, white, black] = json.data.scorecard.teeboxes;
    for (const tee of [grey, blue, black]) {
      expect(tee.holes.map((hole) => hole.par)).toEqual(GREYSTONE_PAR);
      expect(tee.holes.map((hole) => hole.handicap)).toEqual(GREYSTONE_MEN);
      expect(tee.holes.map((hole) => hole.handicap_women)).toEqual(GREYSTONE_WOMEN);
      expect(tee.holes.map((hole) => hole.yardage)).toEqual(GREYSTONE_PAR.map((_, index) => 300 + index));
    }
    expect(white.holes.map((hole) => hole.par)).toEqual(whitePar);
    expect(white.holes[17].par).toBe(3);
    expect(white.holes.every((hole) => hole.handicap == null && hole.handicap_women == null)).toBe(true);
    expect(white.holes.map((hole) => hole.yardage)).toEqual(upstream[2].holes.map((hole) => hole.yardage));
    expect(white.course_rating).toBe(upstream[2].course_rating);
    expect(white.slope_rating).toBe(upstream[2].slope_rating);
    expect(white.total_yards).toBe(upstream[2].total_yards);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(GREYSTONE_SOURCE, ["handicap", "handicap_women"]),
    );
  });

  // Club scorecard photo, Cypress Creek at Greystone, verified 2026-09-27.
  // Upstream copied the Mountain Springs index onto every tee. White is "White/ Middle".
  const CYPRESS_ID = "14229";
  const CYPRESS_PAR = [4, 4, 5, 3, 4, 4, 5, 4, 3, 4, 5, 4, 3, 4, 4, 3, 4, 5];
  const CYPRESS_UPPER = [11, 9, 1, 17, 5, 13, 7, 3, 15, 16, 6, 2, 14, 10, 4, 12, 8, 18];
  const CYPRESS_LOWER = [7, 9, 3, 17, 11, 13, 1, 5, 15, 18, 4, 6, 12, 10, 2, 16, 14, 8];
  const MOUNTAIN_SPRINGS_INDEX = [13, 17, 5, 9, 7, 15, 11, 3, 1, 10, 6, 16, 14, 4, 12, 18, 2, 8];
  const CYPRESS_SOURCE = "club scorecard photo (Cypress Creek at Greystone), verified 2026-09-27";

  function cypressHoles(pars, handicap, handicapWomen = handicap) {
    return pars.map((par, index) => ({
      par,
      yardage: 280 + index,
      handicap: handicap[index],
      handicap_women: handicapWomen[index],
    }));
  }

  function cypressTee(name, rating, slope, yards, pars = CYPRESS_PAR, handicap = MOUNTAIN_SPRINGS_INDEX, handicapWomen = handicap) {
    return {
      name,
      course_rating: rating,
      slope_rating: slope,
      total_yards: yards,
      holes: cypressHoles(pars, handicap, handicapWomen),
    };
  }

  function teeScorecardIdentity(tee) {
    return JSON.stringify({
      name: tee.name,
      course_rating: tee.course_rating,
      slope_rating: tee.slope_rating,
      total_yards: tee.total_yards,
      holes: tee.holes.map((hole) => ({ par: hole.par, yardage: hole.yardage })),
    });
  }

  it("stores Cypress Creek stroke rows as permutations of 1..18", () => {
    const card = GCA_CORRECTIONS[CYPRESS_ID];
    expect(card.mode).toBe("override");
    expect(card.version).toBe(SCORECARD_VERSION);
    expect(card.source).toBe(CYPRESS_SOURCE);
    expect(card.par).toEqual(CYPRESS_PAR);
    expect(card.par.slice(0, 9).reduce((sum, par) => sum + par, 0)).toBe(36);
    expect(card.par.slice(9).reduce((sum, par) => sum + par, 0)).toBe(36);
    permutationOf1to18(card.rows.upper);
    permutationOf1to18(card.rows.lower);
    expect(card.rows.upper).toEqual(CYPRESS_UPPER);
    expect(card.rows.lower).toEqual(CYPRESS_LOWER);
    expect(card.teeRows).toEqual({ Gold: "upper", Blue: "upper", White: "upper", Black: "lower" });
  });

  it("overrides the copied Cypress Creek stroke index and leaves other tees and fields unchanged", async () => {
    const unmappedMen = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const unmappedWomen = [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const mismatchedPar = CYPRESS_PAR.map((par, index) => (index === 17 ? 4 : par));
    const teeboxes = [
      cypressTee("Gold/Championship", 74.5, 135, 7392),
      cypressTee("Blue/Back", 72.1, 130, 6820),
      cypressTee("White/ Middle", 69.8, 126, 6303),
      cypressTee("Black/Senior", 65.6, 113, 5218),
      cypressTee("Green/Forward", 64.4, 110, 5218, CYPRESS_PAR, unmappedMen, unmappedWomen),
      cypressTee("Gold/Mismatch", 74.5, 135, 7392, mismatchedPar),
    ];
    teeboxes[0].holes[0].par = 0;
    const raw = JSON.stringify({
      data: {
        club_name: "Greystone Country Club",
        scorecard: { teeboxes },
      },
    });
    const before = JSON.parse(raw).data.scorecard.teeboxes;
    fetchMock.mockResolvedValue(scorecardResponse(raw));
    const response = await invoke(`${ORIGIN}/gca/v1/courses/${CYPRESS_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const json = await response.json();
    const tees = json.data.scorecard.teeboxes;
    expect(tees.map((tee) => tee.name)).toEqual(before.map((tee) => tee.name));
    for (let i = 0; i < tees.length; i++) {
      expect(teeScorecardIdentity(tees[i])).toBe(teeScorecardIdentity(before[i]));
    }
    const [gold, blue, white, black, green, mismatch] = tees;
    for (const tee of [gold, blue, white]) {
      expect(tee.holes.map((hole) => hole.handicap)).toEqual(CYPRESS_UPPER);
      expect(tee.holes.map((hole) => hole.handicap_women)).toEqual(CYPRESS_UPPER);
    }
    expect(gold.holes[0].par).toBe(0);
    expect(black.holes.map((hole) => hole.handicap)).toEqual(CYPRESS_LOWER);
    expect(black.holes.map((hole) => hole.handicap_women)).toEqual(CYPRESS_LOWER);
    expect(black.course_rating).toBe(65.6);
    expect(black.slope_rating).toBe(113);
    expect(black.total_yards).toBe(5218);
    expect(green.holes.map((hole) => hole.handicap)).toEqual(unmappedMen);
    expect(green.holes.map((hole) => hole.handicap_women)).toEqual(unmappedWomen);
    expect(mismatch.holes.map((hole) => hole.par)).toEqual(mismatchedPar);
    expect(mismatch.holes.map((hole) => hole.handicap)).toEqual(MOUNTAIN_SPRINGS_INDEX);
    expect(mismatch.holes.map((hole) => hole.handicap_women)).toEqual(MOUNTAIN_SPRINGS_INDEX);
    expect(json.data.scorecard.corrections).toEqual(
      scorecardCorrection(CYPRESS_SOURCE, ["handicap", "handicap_women"], "override"),
    );
    expect(await edge.get(`${ORIGIN}/gca/v1/courses/${CYPRESS_ID}`).clone().text()).toBe(raw);
    expect(kv.get(`gca:course:${CYPRESS_ID}`).value).toBe(raw);
    expect(kv.get(`gca:course:${CYPRESS_ID}`).value).not.toContain("corrections");

    const onlyMismatch = JSON.stringify({
      data: {
        scorecard: {
          teeboxes: [cypressTee("Gold/Championship", 74.5, 135, 7392, mismatchedPar)],
        },
      },
    });
    fetchMock.mockResolvedValue(scorecardResponse(onlyMismatch));
    kv.delete(`gca:course:${CYPRESS_ID}`);
    edge.delete(`${ORIGIN}/gca/v1/courses/${CYPRESS_ID}`);
    const skipped = await invoke(`${ORIGIN}/gca/v1/courses/${CYPRESS_ID}?x=1`);
    expect(await skipped.text()).toBe(onlyMismatch);
  });

  function paintUrl(key) {
    return `${ORIGIN}/${encodeURIComponent(key)}`;
  }

  function paintPoint(lat, lng) {
    return { lat, lng };
  }

  function paintHole(hole, lat, extra = {}) {
    const row = {
      hole,
      tee: paintPoint(lat, -93.2),
      green: paintPoint(lat + 0.01, -93.19),
      par: 4,
      yards: 300 + hole,
    };
    return { ...row, ...extra };
  }

  function paintRecord(key, holes, extra = {}) {
    return {
      v: 1,
      key,
      aliases: extra.aliases ?? [],
      source: extra.source ?? "opengolf",
      name: extra.name ?? "Brittany",
      city: extra.city ?? "Rogers",
      numHoles: extra.numHoles ?? 9,
      nineByTwo: extra.nineByTwo ?? false,
      fetchedAt: extra.fetchedAt ?? "2026-01-01T00:00:00.000Z",
      ...("fillAttemptedAt" in extra ? { fillAttemptedAt: extra.fillAttemptedAt } : {}),
      holes,
    };
  }

  function holesByNumber(holes) {
    return Object.fromEntries(holes.map((hole) => [hole.hole, hole]));
  }

  function countedComplete(holes) {
    const seen = new Set();
    let count = 0;
    for (const hole of holes) {
      if (!hole?.tee || !hole?.green) continue;
      if (!Number.isFinite(hole.tee.lat) || !Number.isFinite(hole.green.lat)) continue;
      if (seen.has(hole.hole)) continue;
      seen.add(hole.hole);
      count += 1;
    }
    return count;
  }

  const BRITTANY_ID = "id:local:opengolf:11111111-2222-4333-8444-555555555555";
  const BRITTANY_NAME = "name:brittany|rogers|ar";

  it("keeps a 9-hole Brittany record when a 5-hole partial is PUT", async () => {
    const existingHoles = Array.from({ length: 9 }, (_, index) => paintHole(index + 1, 33 + index * 0.01));
    const existing = paintRecord(BRITTANY_ID, existingHoles, { aliases: [BRITTANY_NAME] });
    kv.set(BRITTANY_ID, { value: JSON.stringify(existing), opts: { expirationTtl: 365 * DAY } });

    const partial = paintRecord(BRITTANY_ID, [
      paintHole(2, 10.02),
      paintHole(3, 10.03),
      paintHole(4, 10.04),
      paintHole(5, 10.05),
      paintHole(15, 10.15),
    ], {
      aliases: [BRITTANY_NAME],
      name: "Wrong",
      city: "",
      numHoles: 5,
      fetchedAt: "2026-09-01T00:00:00.000Z",
    });
    const response = await invoke(paintUrl(BRITTANY_ID), { method: "PUT", body: JSON.stringify(partial) });
    expect(response.status).toBe(200);
    const stored = JSON.parse(kv.get(BRITTANY_ID).value);
    const byHole = holesByNumber(stored.holes);
    for (let hole = 1; hole <= 9; hole += 1) {
      expect(byHole[hole].tee.lat).toBe(existingHoles[hole - 1].tee.lat);
      expect(byHole[hole].green.lng).toBe(existingHoles[hole - 1].green.lng);
    }
    expect(byHole[15].tee.lat).toBe(10.15);
    expect(countedComplete(stored.holes)).toBe(10);
    expect(stored.numHoles).toBe(9);
    expect(stored.name).toBe("Brittany");
    expect(stored.city).toBe("Rogers");
    expect(stored.fetchedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(stored.aliases).toEqual([BRITTANY_NAME]);
    expect(JSON.parse(await response.text())).toEqual(stored);
  });

  it("fills a blank hole on PUT and leaves complete holes alone", async () => {
    const existingHoles = Array.from({ length: 9 }, (_, index) => paintHole(index + 1, 33 + index * 0.01));
    existingHoles[6] = { hole: 7, tee: paintPoint(33.06, -93.2), par: 3, yards: 160 };
    const existing = paintRecord(BRITTANY_ID, existingHoles, { city: "", aliases: [BRITTANY_NAME] });
    kv.set(BRITTANY_ID, { value: JSON.stringify(existing), opts: { expirationTtl: 365 * DAY } });

    const incomingHole = paintHole(7, 41.07, { par: 5, yards: 510, source: "name" });
    const partial = paintRecord(BRITTANY_ID, [paintHole(2, 12), incomingHole], {
      aliases: [BRITTANY_NAME],
      city: "Rogers",
    });
    const response = await invoke(paintUrl(BRITTANY_ID), { method: "PUT", body: JSON.stringify(partial) });
    expect(response.status).toBe(200);
    const stored = JSON.parse(kv.get(BRITTANY_ID).value);
    const byHole = holesByNumber(stored.holes);
    expect(byHole[2].tee.lat).toBe(existingHoles[1].tee.lat);
    expect(byHole[7]).toEqual(incomingHole);
    expect(countedComplete(stored.holes)).toBe(9);
    expect(stored.city).toBe("Rogers");
    expect(stored.name).toBe("Brittany");
    expect(JSON.parse(await response.text())).toEqual(stored);
  });

  it("skips a paint PUT that adds nothing", async () => {
    const existingHoles = Array.from({ length: 9 }, (_, index) => paintHole(index + 1, 33 + index * 0.01));
    const existing = paintRecord(BRITTANY_ID, existingHoles, { aliases: [BRITTANY_NAME] });
    const row = { value: JSON.stringify(existing), opts: { expirationTtl: 365 * DAY } };
    kv.set(BRITTANY_ID, row);
    const partial = paintRecord(BRITTANY_ID, [2, 3, 4, 5].map((hole) => paintHole(hole, 10 + hole)), {
      aliases: [BRITTANY_NAME],
      name: "Other",
      numHoles: 5,
    });
    const response = await invoke(paintUrl(BRITTANY_ID), { method: "PUT", body: JSON.stringify(partial) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: false, message: "nothing changed" });
    expect(kv.get(BRITTANY_ID)).toBe(row);
  });

  it("stores the incoming paint record when X-Paint-Replace is 1", async () => {
    const existingHoles = Array.from({ length: 9 }, (_, index) => paintHole(index + 1, 33 + index * 0.01));
    kv.set(BRITTANY_ID, {
      value: JSON.stringify(paintRecord(BRITTANY_ID, existingHoles, { aliases: [BRITTANY_NAME] })),
      opts: { expirationTtl: 365 * DAY },
    });
    const partial = paintRecord(BRITTANY_ID, [2, 3, 4, 5, 15].map((hole) => paintHole(hole, 10 + hole / 100)), {
      aliases: [BRITTANY_NAME],
      numHoles: 9,
    });
    const body = JSON.stringify(partial);
    const response = await invoke(paintUrl(BRITTANY_ID), {
      method: "PUT",
      body,
      headers: { "X-Paint-Replace": "1" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(kv.get(BRITTANY_ID).value).toBe(body);
    expect(countedComplete(JSON.parse(kv.get(BRITTANY_ID).value).holes)).toBe(5);
  });

  it("fills paint gaps from an alias on GET and does not write", async () => {
    const partialHoles = [2, 3, 4, 5, 15].map((hole) => paintHole(hole, 33 + hole * 0.01));
    const nameHoles = Array.from({ length: 9 }, (_, index) => paintHole(index + 1, 40 + index * 0.01));
    const extraKey = "name:brittany|extra|ar";
    const ignoredKey = "id:local:opengolf:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const unreadKey = "name:brittany|unread|ar";
    const stored = paintRecord(BRITTANY_ID, partialHoles, {
      aliases: [BRITTANY_NAME, extraKey, ignoredKey, unreadKey],
      numHoles: 9,
    });
    const row = { value: JSON.stringify(stored), opts: { expirationTtl: 365 * DAY } };
    kv.set(BRITTANY_ID, row);
    kv.set(BRITTANY_NAME, {
      value: JSON.stringify(paintRecord(BRITTANY_NAME, nameHoles, { numHoles: 9, aliases: [BRITTANY_ID] })),
      opts: { expirationTtl: 365 * DAY },
    });
    kv.set(extraKey, { value: "not-json", opts: { expirationTtl: 365 * DAY } });
    kv.set(ignoredKey, {
      value: JSON.stringify(paintRecord(ignoredKey, [paintHole(12, 50.12)], { numHoles: 18 })),
      opts: { expirationTtl: 365 * DAY },
    });
    kv.set(unreadKey, {
      value: JSON.stringify(paintRecord(unreadKey, [paintHole(12, 51.12)], { numHoles: 9 })),
      opts: { expirationTtl: 365 * DAY },
    });
    const gets = [];
    const read = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (key) => {
      gets.push(key);
      return read(key);
    };

    const response = await invoke(paintUrl(BRITTANY_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    const byHole = holesByNumber(body.holes);
    for (const hole of [2, 3, 4, 5, 15]) {
      expect(byHole[hole].tee.lat).toBe(33 + hole * 0.01);
    }
    for (const hole of [1, 6, 7, 8, 9]) {
      expect(byHole[hole].tee.lat).toBe(40 + (hole - 1) * 0.01);
    }
    expect(byHole[12]).toBeUndefined();
    expect(body.numHoles).toBe(9);
    expect(body.name).toBe("Brittany");
    expect(body.aliases).toEqual(stored.aliases);
    expect(countedComplete(body.holes)).toBe(10);
    expect(kv.get(BRITTANY_ID)).toBe(row);
    expect(gets).toEqual([BRITTANY_ID, BRITTANY_NAME, extraKey, ignoredKey]);
  });

  it("returns a gappy paint record unchanged when it has no aliases", async () => {
    const stored = paintRecord(BRITTANY_ID, [paintHole(1, 33.01), paintHole(2, 33.02)], { aliases: [], numHoles: 9 });
    delete stored.aliases;
    const raw = JSON.stringify(stored);
    const row = { value: raw, opts: { expirationTtl: 365 * DAY } };
    kv.set(BRITTANY_ID, row);
    const gets = [];
    const read = env.BOARDS.get.bind(env.BOARDS);
    env.BOARDS.get = async (key) => {
      gets.push(key);
      return read(key);
    };
    const response = await invoke(paintUrl(BRITTANY_ID));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
    expect(gets).toEqual([BRITTANY_ID]);
    expect(kv.get(BRITTANY_ID)).toBe(row);
  });

  it("ignores an alias paint record with a different numHoles", async () => {
    const partialHoles = [2, 3, 4, 5, 15].map((hole) => paintHole(hole, 33 + hole * 0.01));
    const stored = paintRecord(BRITTANY_ID, partialHoles, { aliases: [BRITTANY_NAME], numHoles: 9 });
    const raw = JSON.stringify(stored);
    const row = { value: raw, opts: { expirationTtl: 365 * DAY } };
    kv.set(BRITTANY_ID, row);
    const eighteen = Array.from({ length: 18 }, (_, index) => paintHole(index + 1, 40 + index * 0.01));
    kv.set(BRITTANY_NAME, {
      value: JSON.stringify(paintRecord(BRITTANY_NAME, eighteen, { numHoles: 18 })),
      opts: { expirationTtl: 365 * DAY },
    });
    const response = await invoke(paintUrl(BRITTANY_ID));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
    expect(kv.get(BRITTANY_ID)).toBe(row);
    expect(kv.get(BRITTANY_NAME).value).toContain('"numHoles":18');
  });

  it("still replaces a live board when the same key is PUT twice", async () => {
    const first = await invoke(`${ORIGIN}/round1`, { method: "PUT", body: '{"hole":1}' });
    expect(first.status).toBe(200);
    const second = await invoke(`${ORIGIN}/round1`, { method: "PUT", body: '{"hole":2}' });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('{"hole":2}');
    expect(kv.get("round1").value).toBe('{"hole":2}');
  });

  const REPORT_ID = "A1B2C3D4-E5F6-4789-8ABC-DEF012345678";
  const REPORT_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const REPORT_IP = "203.0.113.44";
  const REPORT_TTL = 180 * DAY;

  function reportBody(overrides = {}, omit = []) {
    const body = {
      clientReportId: REPORT_ID,
      createdAt: "2026-09-28T18:16:00Z",
      courseId: "id:14322",
      courseName: "Magnolia",
      holeNumber: 7,
      reasons: ["green_wrong"],
      ...overrides,
    };
    for (const key of omit) delete body[key];
    return body;
  }

  function postReport(body, { headers, env: envOverride, raw, cf } = {}) {
    return invoke(`${ORIGIN}/v1/course-reports`, {
      method: "POST",
      body: raw == null ? JSON.stringify(body) : raw,
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": REPORT_IP, ...headers },
      env: envOverride,
      cf,
    });
  }

  function reportRecords() {
    return [...kv.keys()].filter((key) => key.startsWith("cr:r:")).sort();
  }

  it("stores a new course report and ignores unknown fields and reasons", async () => {
    const created = await postReport(reportBody({
      courseId: "id:" + "c".repeat(177),
      courseName: "  Magnolia  ",
      reasons: ["nope", "green_wrong", "green_wrong", "other", "made_up"],
      note: "  pin is in the bunker  ",
      position: { lat: 33.19, lon: -93.2, accuracyM: 5, extra: true },
      appVersion: "1.2.3",
      buildNumber: "88",
      platform: "ios",
      paintSource: "  GCA  ",
      shown: { par: 4, green: { lat: 33.2, lon: -93.1, extra: 1 }, tee: null, ignored: true },
      futureField: { ok: true },
    }), {
      headers: { "X-Install-Id": "dev-1" },
      cf: { country: "us" },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true, id: REPORT_ID });
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(created.headers.get("Content-Type")).toContain("application/json");

    const keys = reportRecords();
    expect(keys).toHaveLength(1);
    const recordKey = keys[0];
    const stored = JSON.parse(kv.get(recordKey).value);
    expect(recordKey).toBe(`cr:r:${stored.receivedAt}:${REPORT_ID}`);
    expect(stored.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(stored.createdAt).toBe("2026-09-28T18:16:00Z");
    expect(stored).toEqual({
      clientReportId: REPORT_ID,
      createdAt: "2026-09-28T18:16:00Z",
      courseId: "id:" + "c".repeat(177),
      courseName: "Magnolia",
      holeNumber: 7,
      reasons: ["green_wrong", "other"],
      note: "pin is in the bunker",
      position: { lat: 33.19, lon: -93.2, accuracyM: 5 },
      appVersion: "1.2.3",
      buildNumber: "88",
      platform: "ios",
      paintSource: "gca",
      shown: { par: 4, green: { lat: 33.2, lon: -93.1 }, tee: null },
      receivedAt: stored.receivedAt,
      installId: "dev-1",
      country: "US",
    });
    expect(kv.get(`cr:id:${REPORT_ID}`)).toEqual({
      value: recordKey,
      opts: { expirationTtl: REPORT_TTL },
      metadata: null,
    });
    expect(kv.get(recordKey).opts).toEqual({ expirationTtl: REPORT_TTL });
    expect(JSON.stringify([...kv.entries()])).not.toContain(REPORT_IP);
    expect(stored.courseId).toHaveLength(180);

    const options = await invoke(`${ORIGIN}/v1/course-reports`, { method: "OPTIONS" });
    expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,OPTIONS");
    expect(options.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Install-Id, Authorization");
    const boardOptions = await invoke(`${ORIGIN}/round1`, { method: "OPTIONS" });
    expect(boardOptions.headers.get("Access-Control-Allow-Methods")).toBe("GET,PUT,OPTIONS");
    expect(boardOptions.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Install-Id");
  });

  it("returns 200 for a duplicate course report and does not write again", async () => {
    const first = await postReport(reportBody(), { headers: { "X-Install-Id": "dev-1" } });
    expect(first.status).toBe(201);
    const before = new Map(kv);
    const again = await postReport(reportBody({
      note: "a different note must not replace the stored report",
      holeNumber: 3,
    }), { headers: { "X-Install-Id": "dev-1" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, id: REPORT_ID, duplicate: true });
    expect(kv.size).toBe(before.size);
    for (const [key, row] of before) {
      expect(kv.get(key)).toEqual(row);
    }
    expect(reportRecords()).toHaveLength(1);
  });

  it("rejects course report JSON that cannot be parsed with 400", async () => {
    const bad = await postReport(null, { raw: "{" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_json" });
    const empty = await postReport(null, { raw: "" });
    expect(empty.status).toBe(400);
    expect(kv.size).toBe(0);

    const boundary = await postReport(null, { raw: "x".repeat(4096) });
    expect(boundary.status).toBe(400);
    expect(kv.size).toBe(0);
  });

  it("rejects an oversized course report with 413", async () => {
    const over = await postReport(null, { raw: "x".repeat(4097) });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "too_large" });
    expect(kv.size).toBe(0);
  });

  it("returns 422 for each invalid course report field and drops nothing", async () => {
    const cases = [
      ["clientReportId missing", reportBody({}, ["clientReportId"]), "clientReportId"],
      ["clientReportId bad", reportBody({ clientReportId: "not-a-uuid" }), "clientReportId"],
      ["clientReportId long", reportBody({ clientReportId: `${"a".repeat(65)}` }), "clientReportId"],
      ["createdAt missing", reportBody({}, ["createdAt"]), "createdAt"],
      ["createdAt bad", reportBody({ createdAt: "yesterday" }), "createdAt"],
      ["createdAt date only", reportBody({ createdAt: "2026-09-28" }), "createdAt"],
      ["courseId missing", reportBody({}, ["courseId"]), "courseId"],
      ["courseId empty", reportBody({ courseId: "" }), "courseId"],
      ["courseId long", reportBody({ courseId: `id:${"a".repeat(178)}` }), "courseId"],
      ["courseName missing", reportBody({}, ["courseName"]), "courseName"],
      ["courseName blank", reportBody({ courseName: "   " }), "courseName"],
      ["courseName long", reportBody({ courseName: "a".repeat(201) }), "courseName"],
      ["holeNumber missing", reportBody({}, ["holeNumber"]), "holeNumber"],
      ["holeNumber zero", reportBody({ holeNumber: 0 }), "holeNumber"],
      ["holeNumber high", reportBody({ holeNumber: 19 }), "holeNumber"],
      ["holeNumber fraction", reportBody({ holeNumber: 1.5 }), "holeNumber"],
      ["holeNumber string", reportBody({ holeNumber: "7" }), "holeNumber"],
      ["reasons missing", reportBody({}, ["reasons"]), "reasons"],
      ["reasons empty", reportBody({ reasons: [] }), "reasons"],
      ["reasons unknown", reportBody({ reasons: ["not_a_reason"] }), "reasons"],
      ["reasons type", reportBody({ reasons: "green_wrong" }), "reasons"],
      ["note long", reportBody({ note: "n".repeat(501) }), "note"],
      ["note type", reportBody({ note: 12 }), "note"],
      ["position lat", reportBody({ position: { lat: 90.1, lon: 0, accuracyM: 1 } }), "position"],
      ["position lon", reportBody({ position: { lat: 0, lon: -180.1, accuracyM: 1 } }), "position"],
      ["position accuracy", reportBody({ position: { lat: 0, lon: 0, accuracyM: -1 } }), "position"],
      ["position type", reportBody({ position: "here" }), "position"],
      ["position lat null", reportBody({ position: { lat: null, lon: 0, accuracyM: 1 } }), "position"],
      ["appVersion long", reportBody({ appVersion: "a".repeat(33) }), "appVersion"],
      ["buildNumber long", reportBody({ buildNumber: "b".repeat(33) }), "buildNumber"],
      ["platform long", reportBody({ platform: "p".repeat(33) }), "platform"],
      ["paintSource long", reportBody({ paintSource: "s".repeat(33) }), "paintSource"],
      ["paintSource type", reportBody({ paintSource: 1 }), "paintSource"],
      ["shown par low", reportBody({ shown: { par: 2 } }), "shown"],
      ["shown par high", reportBody({ shown: { par: 7 } }), "shown"],
      ["shown green", reportBody({ shown: { green: { lat: 91, lon: 0 } } }), "shown"],
      ["shown tee", reportBody({ shown: { tee: "nope" } }), "shown"],
      ["shown type", reportBody({ shown: [] }), "shown"],
    ];
    for (const [label, body, field] of cases) {
      const response = await postReport(body);
      expect(response.status, label).toBe(422);
      expect(await response.json(), label).toEqual({ error: "invalid", field });
    }
    const longInstall = await postReport(reportBody(), {
      headers: { "X-Install-Id": "i".repeat(101) },
    });
    expect(longInstall.status).toBe(422);
    expect(await longInstall.json()).toEqual({ error: "invalid", field: "installId" });
    expect(kv.size).toBe(0);
  });

  it("returns 429 after the IP daily limit with Retry-After", async () => {
    for (let n = 0; n < 30; n += 1) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const response = await postReport(reportBody({ clientReportId: id }));
      expect(response.status, id).toBe(201);
    }
    const limited = await postReport(reportBody({ clientReportId: REPORT_ID_2 }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    const retryAfter = Number(limited.headers.get("Retry-After"));
    const now = new Date();
    const expected = Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000));
    expect(retryAfter).toBeGreaterThan(0);
    expect(Math.abs(retryAfter - expected)).toBeLessThanOrEqual(2);
    expect(reportRecords()).toHaveLength(30);
    const counter = [...kv.keys()].find((key) => key.startsWith("cr:n:ip:"));
    expect(counter).toBeTruthy();
    expect(kv.get(counter).value).toBe("30");
    expect(counter).not.toContain(REPORT_IP);
  });

  it("does not count a duplicate toward the IP or device daily cap", async () => {
    env.COURSE_REPORTS_IP_DAY = "1";
    env.COURSE_REPORTS_DEVICE_DAY = "1";
    const headers = { "X-Install-Id": "dev-1" };
    expect((await postReport(reportBody(), { headers })).status).toBe(201);
    const replay = await postReport(reportBody({ note: "ignored" }), { headers });
    expect(replay.status).toBe(200);
    expect((await replay.json()).duplicate).toBe(true);
    const blocked = await postReport(reportBody({ clientReportId: REPORT_ID_2 }), { headers });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toMatch(/^\d+$/);
    const replayWhileLimited = await postReport(reportBody(), { headers });
    expect(replayWhileLimited.status).toBe(200);
    expect(reportRecords()).toEqual([expect.stringContaining(REPORT_ID)]);
    expect([...kv.keys()].filter((key) => key.startsWith("cr:n:")).map((key) => kv.get(key).value)).toEqual(["1", "1"]);
  });

  it("caps new course reports per install id from COURSE_REPORTS_DEVICE_DAY", async () => {
    env.COURSE_REPORTS_DEVICE_DAY = "1";
    env.COURSE_REPORTS_IP_DAY = "nope";
    const first = await postReport(reportBody(), { headers: { "X-Install-Id": "phone-a" } });
    expect(first.status).toBe(201);
    const second = await postReport(reportBody({ clientReportId: REPORT_ID_2 }), {
      headers: { "X-Install-Id": "phone-a" },
    });
    expect(second.status).toBe(429);
    const otherDevice = await postReport(reportBody({
      clientReportId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }), { headers: { "X-Install-Id": "phone-b" } });
    expect(otherDevice.status).toBe(201);
    expect(reportRecords()).toHaveLength(2);
  });

  it("rejects board GET and PUT of v1 and cr: keys and unknown /v1 routes", async () => {
    kv.set("v1", { value: "board-secret", opts: { expirationTtl: 60 } });
    kv.set("cr:id:secret", { value: "cr:r:secret", opts: { expirationTtl: 60 } });
    for (const key of ["v1", "cr:id:secret"]) {
      const url = `${ORIGIN}/${encodeURIComponent(key)}`;
      for (const method of ["GET", "PUT"]) {
        const response = await invoke(url, { method, body: method === "PUT" ? "{}" : undefined });
        expect(response.status, `${method} ${key}`).toBe(400);
        expect(await response.text(), `${method} ${key}`).toBe("bad key");
      }
    }
    expect(kv.get("v1").value).toBe("board-secret");
    expect(kv.get("cr:id:secret").value).toBe("cr:r:secret");

    const unknown = await invoke(`${ORIGIN}/v1/nope`, { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_route" });
    const put = await invoke(`${ORIGIN}/v1/course-reports`, { method: "PUT", body: "{}" });
    expect(put.status).toBe(405);
    expect(await put.json()).toEqual({ error: "method_not_allowed" });
    expect(kv.has("v1/course-reports")).toBe(false);

    const unbound = await postReport(reportBody(), { env: {} });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: "boards_not_configured" });
  });

  it("serves admin course reports only with the bearer token", async () => {
    const closed = await invoke(`${ORIGIN}/v1/course-reports`);
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: "not_configured" });
    const closedOne = await invoke(`${ORIGIN}/v1/course-reports/${REPORT_ID}`);
    expect(closedOne.status).toBe(503);

    env.COURSE_REPORTS_ADMIN_TOKEN = "admin-secret";
    const missing = await invoke(`${ORIGIN}/v1/course-reports`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    const wrong = await invoke(`${ORIGIN}/v1/course-reports`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
    const notBearer = await invoke(`${ORIGIN}/v1/course-reports/${REPORT_ID}`, {
      headers: { Authorization: "Basic admin-secret" },
    });
    expect(notBearer.status).toBe(401);

    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldKey = `cr:r:2020-01-01T00:00:00.000Z:${oldId}`;
    const oldRecord = {
      clientReportId: oldId,
      createdAt: "2020-01-01T00:00:00Z",
      courseId: "id:old",
      courseName: "Old Course",
      holeNumber: 1,
      reasons: ["hole_missing"],
      receivedAt: "2020-01-01T00:00:00.000Z",
      installId: null,
    };
    kv.set(oldKey, { value: JSON.stringify(oldRecord), opts: { expirationTtl: REPORT_TTL } });
    kv.set(`cr:id:${oldId}`, { value: oldKey, opts: { expirationTtl: REPORT_TTL } });
    const created = await postReport(reportBody({ courseId: "name:magnolia", courseName: "Magnolia" }));
    expect(created.status).toBe(201);

    function adminGet(path) {
      return invoke(`${ORIGIN}${path}`, { headers: { Authorization: "Bearer admin-secret" } });
    }

    const listed = await adminGet("/v1/course-reports?since=2024-01-01T00:00:00Z&courseId=name:magnolia");
    expect(listed.status).toBe(200);
    const page = await listed.json();
    expect(page.cursor).toBeNull();
    expect(page.reports).toHaveLength(1);
    expect(page.reports[0].clientReportId).toBe(REPORT_ID);
    expect(page.reports[0].courseId).toBe("name:magnolia");

    const onlyOld = await adminGet("/v1/course-reports?courseId=id:old");
    expect((await onlyOld.json()).reports).toEqual([oldRecord]);
    const none = await adminGet("/v1/course-reports?since=2024-01-01T00:00:00.000Z&courseId=id:old");
    expect(await none.json()).toEqual({ reports: [], cursor: null });

    const all = await adminGet("/v1/course-reports");
    const allBody = await all.json();
    expect(allBody.reports.map((row) => row.clientReportId)).toEqual([oldId, REPORT_ID]);

    const one = await adminGet(`/v1/course-reports/${oldId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(oldRecord);
    const absent = await adminGet(`/v1/course-reports/${REPORT_ID_2}`);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "not_found" });

    const seen = [];
    env.BOARDS.list = async (opts) => {
      seen.push(opts);
      return { keys: [{ name: oldKey }], list_complete: false, cursor: "next-cursor" };
    };
    const passed = await adminGet("/v1/course-reports?limit=9999&cursor=page-2");
    expect(seen[0]).toEqual({ prefix: "cr:r:", limit: 500, cursor: "page-2" });
    expect((await passed.json()).cursor).toBe("next-cursor");
    const defaults = [];
    env.BOARDS.list = async (opts) => {
      defaults.push(opts);
      return { keys: [], list_complete: true };
    };
    await adminGet("/v1/course-reports?limit=0");
    expect(defaults[0].limit).toBe(100);
    expect(defaults[0].cursor).toBeUndefined();
  });
});
