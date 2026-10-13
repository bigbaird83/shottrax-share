import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import entry from "./entry.js";
import { GolfapiCounter, handleGolfProxy } from "./golf-proxy.js";
import { stockpilePhase, stockpileRunSlots, stockpileSchedule } from "./golf-stockpile.js";
import live, {
  __resetHotfixMemoryForTests,
  billingPeriod,
  readGolfapiLimits,
} from "./live-shottrax-share.js";

const ORIGIN = "https://shottrax-share.example";
const COURSE_BODY = JSON.stringify({
  courseID: "14322",
  courseName: "Magnolia",
  numHoles: 18,
});
const SEVENTH_NIGHT = new Date("2026-10-29T23:00:00Z");
const EIGHTH_NIGHT = new Date("2026-10-28T23:00:00Z");

function memorySql() {
  const rows = new Map();
  return {
    exec(query, ...args) {
      const text = String(query).replace(/\s+/g, " ").trim();
      if (text.startsWith("CREATE")) return [];
      if (text.startsWith("SELECT")) {
        const value = rows.get(args[0]);
        return value == null ? [] : [{ value }];
      }
      if (text.startsWith("INSERT")) {
        rows.set(args[0], String(args[1]));
        return [];
      }
      if (text.startsWith("DELETE")) {
        rows.delete(args[0]);
        return [];
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
}

function counter() {
  return new GolfapiCounter({ storage: { sql: memorySql() } });
}

class MemoryKv {
  constructor() {
    this.store = new Map();
    this.puts = [];
  }
  async get(key) {
    return this.store.get(key)?.value ?? null;
  }
  async put(key, value, options) {
    const row = { value: String(value), options: options ?? null };
    this.store.set(key, row);
    this.puts.push({ key, value: row.value, options: row.options });
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list() {
    return { keys: [...this.store.keys()].map((name) => ({ name })), list_complete: true };
  }
}

class MemoryCounter {
  constructor() {
    this.sql = memorySql();
    this.stub = new GolfapiCounter({ storage: { sql: this.sql } });
  }
  idFromName() {
    return "golfapi";
  }
  get() {
    return {
      fetch: (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return this.stub.fetch(request);
      },
    };
  }
}

function proxyEnv(kv, extra = {}) {
  return {
    GOLFAPI_KEY: "golf-secret",
    GOLFAPI_KV: kv,
    GOLFAPI_COUNTER: new MemoryCounter(),
    GOLFAPI_ALLOWLIST: "",
    GOLFAPI_INSTALL_DAILY_PULLS: "4",
    GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP: "20",
    GOLFAPI_INSTALL_DAILY_SEARCHES: "30",
    GOLFAPI_DAILY_CAP: "150",
    GOLFAPI_MONTHLY_CAP: "450",
    ...extra,
  };
}

function boardsFrom(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  return {
    async get(key) {
      return rows.has(key) ? rows.get(key) : null;
    },
    async put(key, value) {
      rows.set(key, String(value));
    },
    async delete(key) {
      rows.delete(key);
    },
    async list() {
      return { keys: [...rows.keys()].map((name) => ({ name })), list_complete: true };
    },
  };
}

async function shareCourse(env, installId) {
  const response = await live.fetch(new Request(`${ORIGIN}/golfapi/v2.3/courses/14322`, {
    headers: { "X-Install-Id": installId },
  }), env, { waitUntil() {} });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const limits = readGolfapiLimits({});
const openNeed = limits.openCalls;

describe("surviving mutant boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetHotfixMemoryForTests();
  });

  it("allows a phone spend that lands on the credit cap and blocks the next tenth", () => {
    const installKey = "golfapi:credit:install:id_cap";
    const body = {
      callCap: 3,
      installKey,
      dayKey: "golfapi:credit:day:2026-10-13",
      monthKey: "golfapi:credit:month:2026-10-05",
      dayCap: 150,
      monthCap: 450,
      retryDay: 100,
    };
    const atCap = counter();
    atCap.putCredits(installKey, 9);
    expect(atCap.room(body, 21)).toBeNull();

    const over = counter();
    over.putCredits(installKey, 10);
    expect(over.room(body, 21)).toEqual({ ok: false, reason: "phone_limit", retryAfterSec: 100 });
  });

  it("caches a course hit for one day and a zero-hit search for seven days", async () => {
    const previousFetch = globalThis.fetch;
    const kv = new MemoryKv();
    const env = proxyEnv(kv);
    const headers = { "X-Install-Id": "id_phone_1", "X-ShotTraxx-Storefront": "USA" };
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        courseID: "14322",
        clubName: "Magnolia",
        country: "US",
        coordinates: [
          { hole: 1, poi: 1, latitude: 34.1, longitude: -92.2 },
          { hole: 1, poi: 11, latitude: 34.11, longitude: -92.2 },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      const course = await handleGolfProxy(new Request(`${ORIGIN}/golfapi/v2.3/courses/14322`, { headers }), env, {});
      expect(course.status).toBe(200);
      expect(course.headers.get("Cache-Control")).toBe("public, max-age=86400");

      globalThis.fetch = async () => new Response(JSON.stringify({ courses: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const search = await handleGolfProxy(
        new Request(`${ORIGIN}/golfapi/v2.3/courses?country=US&name=Nowhere`, { headers }),
        env,
        {},
      );
      expect(search.status).toBe(200);
      expect(search.headers.get("Cache-Control")).toBe("public, max-age=604800");
      expect(search.headers.get("X-ShotTraxx-Golfapi-Empty-Search")).toBe("604800");
      const empty = kv.puts.find((put) => put.key.includes("search"));
      expect(empty?.options).toEqual({ expirationTtl: 604800 });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps every stockpile night at or above the rollover", () => {
    const plan = {
      now: SEVENTH_NIGHT,
      cycleDay: 5,
      liveLeft: 2156,
      rollover: 156,
      runCap: 800,
      dailyCap: 300,
      headroom: 30,
      floor: 50,
      maxDays: 7,
      dayUsed: 40,
      golferEstimate: 40,
    };
    const schedule = stockpileSchedule(plan);
    expect(schedule.todayBudget).toBe(285.7);
    expect(schedule.finalBalance).toBe(156);
    expect(schedule.runs.every((row) => row.balanceAfter >= 156)).toBe(true);
    const src = readFileSync(new URL("./golf-stockpile.js", import.meta.url), "utf8");
    expect(src).toContain(
      "if (balance - budget < Number(rollover)) budget = roundCredit(Math.max(0, balance - Number(rollover)));",
    );
  });

  it("clamps a longer stockpile setting to the last 7 nights", () => {
    expect(stockpilePhase(EIGHTH_NIGHT, 5, 30)).toBe("outside");
    expect(stockpilePhase(SEVENTH_NIGHT, 5, 30)).toBe("check");
    const schedule = stockpileSchedule({
      now: SEVENTH_NIGHT,
      cycleDay: 5,
      liveLeft: 2156,
      rollover: 156,
      runCap: 800,
      dailyCap: 300,
      headroom: 30,
      floor: 50,
      maxDays: 30,
    });
    expect(schedule.daysNeeded).toBe(7);
    expect(schedule.inWindow).toBe(true);
  });

  it("runs the stockpile handler on the 23:00 cron and skips every other cron", async () => {
    const morning = await entry.scheduled({ cron: "0 8 * * *" }, {}, {});
    expect(morning).toEqual({ skipped: "cron" });
    const night = await entry.scheduled({ cron: "0 23 * * *" }, { GOLFAPI_STOCKPILE_ENABLED: "false" }, {});
    expect(night.skipped).toBe("disabled");
  });

  it("sends /golfapi/ to the golf proxy", async () => {
    const response = await entry.fetch(new Request(`${ORIGIN}/golfapi/v2.3/status`), {}, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exempt: false, dailyPulls: 4 });
  });

  it("blocks the credit floor only once the open would fall through it", async () => {
    const floor = limits.floor;
    const blockedLeft = floor + openNeed - 1;
    const allowedLeft = floor + openNeed;
    const fetchMock = vi.fn(async () => new Response(COURSE_BODY, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const blocked = await shareCourse({
      BOARDS: boardsFrom({ "gq:balance": JSON.stringify({ left: blockedLeft, at: 1, lastStatus: 200 }) }),
      GOLFAPI_KEY: "golf-secret",
    }, "install-floor-low");
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({ error: "golfapi_limited", reason: "floor" });
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await shareCourse({
      BOARDS: boardsFrom({ "gq:balance": JSON.stringify({ left: allowedLeft, at: 1, lastStatus: 200 }) }),
      GOLFAPI_KEY: "golf-secret",
    }, "install-floor-ok1");
    expect(allowed.status).toBe(200);
    expect(allowed.json.courseID).toBe("14322");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("allows a stockpile charge after 120 golfer pulls against the live daily cap", () => {
    const { env, body, box } = stockpileChargeBox(120);
    expect(env.GOLFAPI_STOCKPILE_ENABLED).toBe("true");
    expect(env.GOLFAPI_DAILY_CAP).toBe("150");
    expect(env.GOLFAPI_STOCKPILE_DAY_HEADROOM).toBe("30");
    expect(box.stockpileCharge(body)).toEqual({ ok: true });
    expect(box.creditTenths(body.stockpileDayKey)).toBe(10);
  });

  it("refuses a stockpile charge after 121 golfer pulls and pulls nothing", () => {
    const { env, body, box } = stockpileChargeBox(121);
    expect(env.GOLFAPI_STOCKPILE_ENABLED).toBe("true");
    expect(box.stockpileCharge(body)).toEqual({ ok: false, reason: "app_daily" });
    expect(box.creditTenths(body.stockpileDayKey)).toBe(0);
    expect(box.creditTenths(body.stockpileMonthKey)).toBe(0);
  });

  it("allows a stockpile charge that lands on exactly runCap", () => {
    const { env, body, box } = stockpileChargeBox(0);
    const runCap = Number(env.GOLFAPI_STOCKPILE_RUN_CREDITS);
    expect(env.GOLFAPI_STOCKPILE_ENABLED).toBe("true");
    expect(box.stockpileCharge({ ...body, chargeTenths: runCap * 10 })).toEqual({ ok: true });
    expect(box.creditAmount(body.stockpileDayKey)).toBe(runCap);
  });

  it("refuses a stockpile charge of runCap plus a tenth", () => {
    const { env, body, box } = stockpileChargeBox(0);
    const runCap = Number(env.GOLFAPI_STOCKPILE_RUN_CREDITS);
    expect(env.GOLFAPI_STOCKPILE_ENABLED).toBe("true");
    expect(box.stockpileCharge({ ...body, chargeTenths: runCap * 10 + 1 })).toEqual({ ok: false, reason: "run_cap" });
    expect(box.creditTenths(body.stockpileDayKey)).toBe(0);
    expect(box.creditTenths(body.stockpileMonthKey)).toBe(0);
  });

  it("gives an empty-search row max-age 0 when it expires at this instant", async () => {
    const kv = new MemoryKv();
    const now = Date.now();
    await kv.put("golfapi:permanent:search:country=US&name=Expired", JSON.stringify({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ courses: [] }),
      emptySearchTtl: 604800,
      emptySearchUntil: now,
    }));
    const previousFetch = globalThis.fetch;
    let fetched = 0;
    try {
      globalThis.fetch = async () => {
        fetched += 1;
        return new Response("should-not-fetch", { status: 500 });
      };
      const response = await handleGolfProxy(
        new Request(`${ORIGIN}/golfapi/v2.3/courses?country=US&name=Expired&stored=1`),
        proxyEnv(kv),
        {},
      );
      expect(response.status).toBe(404);
      expect(fetched).toBe(0);
      const src = readFileSync(new URL("./golf-proxy.js", import.meta.url), "utf8");
      expect(src).toContain("if (remaining <= 0) return 0;");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("keeps today's 23:00 slot when the faked clock is just before 23:00 UTC", () => {
    const slots = slotsAt("2026-10-29T22:59:59.000Z");
    expect(slots[0]).toBe(Date.parse("2026-10-29T23:00:00.000Z"));
    expect(slots.length).toBe(7);
  });

  it("moves the first stockpile slot to the next day when the faked clock is just after 23:00 UTC", () => {
    const before = slotsAt("2026-10-29T22:59:59.000Z");
    const after = slotsAt("2026-10-29T23:00:01.000Z");
    expect(after[0]).toBe(Date.parse("2026-10-30T23:00:00.000Z"));
    expect(after.length).toBe(before.length - 1);
  });

  it("blocks the monthly budget only once the next open would pass it", async () => {
    const budget = limits.monthBudget;
    const period = billingPeriod(Date.now(), limits.billingDay);
    const monthKey = `gq:month:${period.id}`;
    const balance = JSON.stringify({ left: floorSafe(), at: 1, lastStatus: 200 });
    const fetchMock = vi.fn(async () => new Response(COURSE_BODY, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const atBudget = await shareCourse({
      BOARDS: boardsFrom({
        "gq:balance": balance,
        [monthKey]: String(budget - openNeed),
      }),
      GOLFAPI_KEY: "golf-secret",
    }, "install-month-ok1");
    expect(atBudget.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const over = await shareCourse({
      BOARDS: boardsFrom({
        "gq:balance": balance,
        [monthKey]: String(budget - openNeed + 1),
      }),
      GOLFAPI_KEY: "golf-secret",
    }, "install-month-over");
    expect(over.status).toBe(429);
    expect(over.json).toMatchObject({ error: "golfapi_limited", reason: "global_month" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function floorSafe() {
  return limits.floor + openNeed + 100;
}

function stockpileEnv() {
  return {
    GOLFAPI_STOCKPILE_ENABLED: "true",
    GOLFAPI_DAILY_CAP: "150",
    GOLFAPI_STOCKPILE_DAY_HEADROOM: "30",
    GOLFAPI_STOCKPILE_RUN_CREDITS: "800",
    GOLFAPI_CYCLE_DAY: "5",
  };
}

function stockpileChargeBox(golferPulls) {
  const env = stockpileEnv();
  const box = counter();
  const golferDayKey = "golfapi:credit:day:2026-10-29";
  const body = {
    golferDayKey,
    stockpileDayKey: "golfapi:stockpile:credit:day:2026-10-29",
    stockpileMonthKey: "golfapi:stockpile:credit:month:2026-10-05",
    dayCap: Number(env.GOLFAPI_DAILY_CAP),
    dayHeadroomTenths: Number(env.GOLFAPI_STOCKPILE_DAY_HEADROOM) * 10,
    runCap: Number(env.GOLFAPI_STOCKPILE_RUN_CREDITS),
    chargeTenths: 10,
  };
  box.putCredits(golferDayKey, golferPulls * 10);
  return { env, body, box };
}

function slotsAt(iso) {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(iso));
  try {
    const env = stockpileEnv();
    expect(env.GOLFAPI_STOCKPILE_ENABLED).toBe("true");
    return stockpileRunSlots(new Date(), Number(env.GOLFAPI_CYCLE_DAY));
  } finally {
    vi.useRealTimers();
  }
}
