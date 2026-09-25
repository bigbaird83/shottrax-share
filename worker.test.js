import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const FROM = "35.103644,-92.397951";
const TO = "35.104004,-92.396001";
const FROM_ROUNDED = { lat: 35.10364, lng: -92.39795 };
const TO_ROUNDED = { lat: 35.104, lng: -92.396 };

describe("playslike lookup", { concurrency: false }, () => {
  let restoreFetch = null;

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    restoreFetch = null;
    delete globalThis.caches;
  });

  test("USGS success returns both elevations, delta, and wind", async () => {
    const calls = mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") {
        assert.equal(u.searchParams.get("wkid"), "4326");
        assert.equal(u.searchParams.get("units"), "Meters");
        assert.equal(u.searchParams.get("includeDate"), "false");
        const lat = Number(u.searchParams.get("y"));
        const lng = Number(u.searchParams.get("x"));
        if (near(lat, FROM_ROUNDED.lat) && near(lng, FROM_ROUNDED.lng)) {
          return json({ value: "100.5" });
        }
        if (near(lat, TO_ROUNDED.lat) && near(lng, TO_ROUNDED.lng)) {
          return json({ value: "90.25" });
        }
        throw new Error(`unexpected usgs point ${lat},${lng}`);
      }
      if (u.pathname === "/v1/elevation") {
        throw new Error("open-meteo elevation should not be called when USGS covers both points");
      }
      if (u.pathname === "/v1/forecast") {
        assert.equal(u.searchParams.get("current"), "wind_speed_10m,wind_direction_10m,wind_gusts_10m");
        assert.equal(u.searchParams.get("wind_speed_unit"), "mph");
        assert.ok(near(Number(u.searchParams.get("latitude")), TO_ROUNDED.lat));
        assert.ok(near(Number(u.searchParams.get("longitude")), TO_ROUNDED.lng));
        return json(windPayload());
      }
      throw new Error(`unexpected url ${href}`);
    });

    const res = await plays({ from: FROM, to: TO });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(res.body.from, { ...FROM_ROUNDED, elevation_m: 100.5 });
    assert.deepEqual(res.body.to, { ...TO_ROUNDED, elevation_m: 90.25 });
    assert.equal(res.body.elevation_delta_m, 90.25 - 100.5);
    assert.equal(res.body.elevation_source, "usgs");
    assert.equal(res.body.elevation_error, undefined);
    assert.deepEqual(res.body.wind, {
      speed_mph: 2.9,
      gust_mph: 7.2,
      from_deg: 4,
      from_deg_meaning: "meteorological degrees the wind comes from",
      source: "open-meteo",
      observed_at: "2026-09-25T12:45",
    });
    assert.equal(res.body.wind_error, undefined);
    assert.equal(calls.filter((c) => c.includes("epqs.nationalmap.gov")).length, 2);
  });

  test("elevation delta is to minus from without binary dust", async () => {
    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") {
        const lat = Number(u.searchParams.get("y"));
        if (near(lat, 35.1036)) return json({ value: "96.806419373" });
        if (near(lat, 35.104)) return json({ value: "95.598861694" });
        throw new Error(`unexpected usgs ${lat}`);
      }
      if (u.pathname === "/v1/forecast") return json(windPayload());
      throw new Error(`unexpected url ${href}`);
    });
    const res = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" });
    assert.equal(res.status, 200);
    assert.equal(res.body.from.elevation_m, 96.806419373);
    assert.equal(res.body.to.elevation_m, 95.598861694);
    assert.equal(res.body.elevation_delta_m, -1.207557679);
    assert.equal(res.body.elevation_source, "usgs");
  });

  test("USGS sentinel falls back to Open-Meteo for both points", async () => {
    const misses = [-1000000, "-1000000", -501, "n/a"];
    for (const miss of misses) {
      const omCalls = [];
      mockFetch(async (href) => {
        const u = new URL(href);
        if (u.hostname === "epqs.nationalmap.gov") {
          const lat = Number(u.searchParams.get("y"));
          if (near(lat, 35.1036)) return json({ value: miss });
          if (near(lat, 35.104)) return json({ value: 150 });
          throw new Error(`unexpected usgs ${lat}`);
        }
        if (u.pathname === "/v1/elevation") {
          const lat = Number(u.searchParams.get("latitude"));
          omCalls.push(lat);
          if (near(lat, 35.1036)) return json({ elevation: [40] });
          if (near(lat, 35.104)) return json({ elevation: [30] });
          throw new Error(`unexpected elevation ${lat}`);
        }
        if (u.pathname === "/v1/forecast") return json(windPayload());
        throw new Error(`unexpected url ${href}`);
      });

      const res = await plays({ from: "35.10360,-92.39790", to: "35.10400,-92.39600" });
      assert.equal(res.status, 200, `miss ${miss}`);
      assert.equal(res.body.elevation_source, "open-meteo", `miss ${miss}`);
      assert.equal(res.body.from.elevation_m, 40, `miss ${miss}`);
      assert.equal(res.body.to.elevation_m, 30, `miss ${miss}`);
      assert.equal(res.body.elevation_delta_m, -10, `miss ${miss}`);
      assert.equal(res.body.elevation_error, undefined);
      assert.equal(omCalls.length, 2, `miss ${miss}`);
      assert.ok(omCalls.some((lat) => near(lat, 35.1036)));
      assert.ok(omCalls.some((lat) => near(lat, 35.104)));
    }
  });

  test("total elevation failure gives nulls and keeps wind", async () => {
    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") throw timeoutError();
      if (u.pathname === "/v1/elevation") return json({ error: true }, 503);
      if (u.pathname === "/v1/forecast") return json(windPayload());
      throw new Error(`unexpected url ${href}`);
    });

    const res = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" });
    assert.equal(res.status, 200);
    assert.equal(res.body.from.elevation_m, null);
    assert.equal(res.body.to.elevation_m, null);
    assert.equal(res.body.elevation_delta_m, null);
    assert.equal(res.body.elevation_source, null);
    assert.equal(res.body.elevation_error, "usgs:timeout;open-meteo:upstream_error");
    assert.equal(res.body.wind.source, "open-meteo");
    assert.equal(res.body.wind_error, undefined);
  });

  test("a single Open-Meteo elevation does not fill the other point", async () => {
    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") {
        const lat = Number(u.searchParams.get("y"));
        return json({ value: near(lat, 35.1036) ? -1000000 : 150 });
      }
      if (u.pathname === "/v1/elevation") {
        const lat = Number(u.searchParams.get("latitude"));
        if (near(lat, 35.1036)) return json({ elevation: [40] });
        return json({ elevation: [null] });
      }
      if (u.pathname === "/v1/forecast") return json(windPayload());
      throw new Error(`unexpected url ${href}`);
    });

    const res = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" });
    assert.equal(res.status, 200);
    assert.equal(res.body.from.elevation_m, null);
    assert.equal(res.body.to.elevation_m, null);
    assert.equal(res.body.elevation_delta_m, null);
    assert.equal(res.body.elevation_source, null);
    assert.equal(res.body.elevation_error, "usgs:no_data;open-meteo:no_data");
    assert.ok(res.body.wind);
  });

  test("wind failure gives wind null and still returns elevation", async () => {
    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") {
        const lat = Number(u.searchParams.get("y"));
        return json({ value: near(lat, 35.1036) ? "10" : "20" });
      }
      if (u.pathname === "/v1/forecast") {
        const err = new TypeError("network down");
        throw err;
      }
      throw new Error(`unexpected url ${href}`);
    });

    const res = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" });
    assert.equal(res.status, 200);
    assert.equal(res.body.wind, null);
    assert.equal(res.body.wind_error, "upstream_error");
    assert.equal(res.body.elevation_source, "usgs");
    assert.equal(res.body.from.elevation_m, 10);
    assert.equal(res.body.to.elevation_m, 20);
    assert.equal(res.body.elevation_delta_m, 10);
    assert.equal(res.body.elevation_error, undefined);
  });

  test("502 only when elevation and wind both fail", async () => {
    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov" || u.pathname === "/v1/elevation" || u.pathname === "/v1/forecast") {
        throw new TypeError("down");
      }
      throw new Error(`unexpected url ${href}`);
    });

    const res = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.body.from.elevation_m, null);
    assert.equal(res.body.to.elevation_m, null);
    assert.equal(res.body.elevation_delta_m, null);
    assert.equal(res.body.elevation_source, null);
    assert.equal(res.body.wind, null);
    assert.equal(res.body.elevation_error, "usgs:upstream_error;open-meteo:upstream_error");
    assert.equal(res.body.wind_error, "upstream_error");
  });

  test("bad coords return 400 and do not call upstream", async () => {
    const calls = mockFetch(async () => {
      throw new Error("upstream should not be called");
    });
    const cases = [
      {},
      { from: "35.1036,-92.3979" },
      { to: "35.1040,-92.3960" },
      { from: "91,-92", to: "35,-92" },
      { from: "-90.0001,-92", to: "35,-92" },
      { from: "35,180.1", to: "35,-92" },
      { from: "35,-180.1", to: "35,-92" },
      { from: "abc,1", to: "35,-92" },
      { from: "35,abc", to: "35,-92" },
      { from: "35", to: "35,-92" },
      { from: "35,-92,0", to: "35,-92" },
      { from: "", to: "35,-92" },
      { from: "  , -92", to: "35,-92" },
      { from: "NaN,0", to: "35,-92" },
      { from: "Infinity,0", to: "35,-92" },
    ];
    for (const query of cases) {
      const res = await plays(query);
      assert.equal(res.status, 400, JSON.stringify(query));
      assert.deepEqual(res.body, { error: "bad_coords" });
    }
    assert.equal(calls.length, 0);

    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") return json({ value: "1" });
      if (u.pathname === "/v1/forecast") return json(windPayload());
      throw new Error(`unexpected url ${href}`);
    });
    const edge = await plays({ from: "90,180", to: "-90,-180" });
    assert.equal(edge.status, 400);
    assert.deepEqual(edge.body, { error: "too_far" });
    const poles = await plays({ from: "90,180", to: "90,180" });
    assert.equal(poles.status, 200);
    assert.equal(poles.body.from.lat, 90);
    assert.equal(poles.body.from.lng, 180);
  });

  test("too_far returns 400 and does not call upstream", async () => {
    const calls = mockFetch(async () => {
      throw new Error("upstream should not be called");
    });
    const res = await plays({ from: "35,-92", to: "36,-92" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "too_far" });
    assert.equal(calls.length, 0);

    const farther = await plays({ from: "0,0", to: "0,1" });
    assert.equal(farther.status, 400);
    assert.deepEqual(farther.body, { error: "too_far" });
  });

  test("non-GET returns 405 and does not touch boards", async () => {
    const env = {
      BOARDS: {
        async get() {
          throw new Error("boards get");
        },
        async put() {
          throw new Error("boards put");
        },
      },
    };
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await worker.fetch(new Request(`https://shottrax.example/playslike/v1?from=${FROM}&to=${TO}`, {
        method,
        body: method === "DELETE" ? undefined : "{}",
      }), env, {});
      assert.equal(res.status, 405, method);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    }
  });

  test("edge cache keeps elevation 30 days and wind 10 minutes", async () => {
    const mem = new Map();
    globalThis.caches = {
      default: {
        async match(request) {
          const hit = mem.get(request.url);
          if (!hit) return undefined;
          return new Response(hit.body, {
            status: 200,
            headers: { "Content-Type": "application/json", "Cache-Control": hit.cacheControl },
          });
        },
        async put(request, response) {
          mem.set(request.url, {
            body: await response.text(),
            cacheControl: response.headers.get("cache-control"),
          });
        },
      },
    };
    const pending = [];
    const ctx = { waitUntil(p) { pending.push(p); } };
    let usgs = 0;
    let wind = 0;
    mockFetch(async (href) => {
      const u = new URL(href);
      if (u.hostname === "epqs.nationalmap.gov") {
        usgs += 1;
        return json({ value: "10" });
      }
      if (u.pathname === "/v1/elevation") throw new Error("open-meteo elevation should not be called");
      if (u.pathname === "/v1/forecast") {
        wind += 1;
        return json(windPayload());
      }
      throw new Error(`unexpected url ${href}`);
    });

    const first = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" }, ctx);
    await Promise.all(pending);
    assert.equal(first.status, 200);
    assert.equal(first.body.elevation_source, "usgs");
    const second = await plays({ from: "35.1036,-92.3979", to: "35.1040,-92.3960" }, ctx);
    assert.equal(second.status, 200);
    assert.equal(second.body.from.elevation_m, 10);
    assert.equal(second.body.wind.speed_mph, 2.9);
    assert.equal(usgs, 2);
    assert.equal(wind, 1);

    const keys = [...mem.keys()];
    assert.ok(keys.includes("https://playslike.invalid/v1/elev/usgs/35.10360,-92.39790"));
    assert.ok(keys.includes("https://playslike.invalid/v1/elev/usgs/35.10400,-92.39600"));
    assert.ok(keys.includes("https://playslike.invalid/v1/wind/35.10,-92.40"));
    assert.equal(mem.get("https://playslike.invalid/v1/elev/usgs/35.10360,-92.39790").cacheControl, "public, max-age=2592000");
    assert.equal(mem.get("https://playslike.invalid/v1/wind/35.10,-92.40").cacheControl, "public, max-age=600");
  });

  test("share-board and golf proxy behavior stays in front of boards", async () => {
    let key = null;
    const board = await worker.fetch(new Request("https://shottrax.example/abc"), {
      BOARDS: {
        async get(k) {
          key = k;
          return "{\"ok\":true}";
        },
        async put() {
          throw new Error("put");
        },
      },
    }, {});
    assert.equal(board.status, 200);
    assert.equal(key, "abc");
    assert.equal(await board.text(), "{\"ok\":true}");

    const golf = await worker.fetch(new Request("https://shottrax.example/gca/v1/nope"), {
      GOLF_COURSES_API_KEY: "secret",
      BOARDS: {
        async get() {
          throw new Error("boards");
        },
        async put() {
          throw new Error("boards");
        },
      },
    }, {});
    assert.equal(golf.status, 404);
    assert.deepEqual(await golf.json(), { error: "unknown_route" });
  });

  function mockFetch(handler) {
    if (restoreFetch) restoreFetch();
    const previous = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      calls.push(href);
      return handler(href, init);
    };
    restoreFetch = () => {
      globalThis.fetch = previous;
    };
    return calls;
  }
});

function near(a, b) {
  return Math.abs(a - b) < 1e-9;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function windPayload() {
  return {
    current_units: {
      wind_speed_10m: "mp/h",
      wind_direction_10m: "°",
      wind_gusts_10m: "mp/h",
    },
    current: {
      time: "2026-09-25T12:45",
      wind_speed_10m: 2.9,
      wind_direction_10m: 4,
      wind_gusts_10m: 7.2,
    },
  };
}

function timeoutError() {
  const err = new Error("timeout");
  err.name = "TimeoutError";
  return err;
}

async function plays(query, ctx = {}) {
  const url = new URL("https://shottrax.example/playslike/v1");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const res = await worker.fetch(new Request(url), {}, ctx);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
