import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import entry from "./entry.js";
import { GolfapiCounter, sendPlainEmail } from "./golf-proxy.js";
import { runGolfapiStockpile } from "./golf-stockpile.js";

const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");

const LIVE_VARS = {
  GOLFAPI_INSTALL_DAILY_PULLS: "4",
  GOLFAPI_INSTALL_DAILY_SEARCHES: "30",
  GOLFAPI_INSTALL_DAILY_CALL_BACKSTOP: "20",
  GOLFAPI_DAILY_CAP: "500",
  GOLFAPI_MONTHLY_CAP: "3500",
  GOLFAPI_CREDIT_FLOOR: "50",
  GOLFAPI_PLAN_MONTHLY: "4000",
  GOLFAPI_CYCLE_DAY: "5",
  GOLFAPI_ROLLOVER_CREDITS: "156",
  GOLFAPI_STOCKPILE_ENABLED: "false",
  GOLFAPI_STOCKPILE_DAY_HEADROOM: "30",
  GOLFAPI_STOCKPILE_RUN_CREDITS: "800",
  GOLFAPI_STOCKPILE_MAX_DAYS: "7",
  GOLFAPI_STOCKPILE_DRY_RUN: "false",
  ALERT_TO: "shottraxx@gmail.com",
  ALERT_FROM: "alerts@shottraxx.com",
  TERRAIN_INSTALL_DAILY_CAP: "54",
  TERRAIN_MAX_GRID_POINTS: "6000",
};

function memorySql() {
  const rows = new Map();
  return {
    exec(query, ...args) {
      const text = String(query);
      if (text.startsWith("CREATE")) return [];
      if (text.startsWith("SELECT")) {
        const value = rows.get(args[0]);
        const out = value == null ? [] : [{ value }];
        out.toArray = () => out;
        return out;
      }
      if (text.startsWith("INSERT")) {
        rows.set(args[0], args[1]);
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

function counterNamespace() {
  const counter = new GolfapiCounter({ storage: { sql: memorySql() } });
  return {
    idFromName(name) {
      return { name };
    },
    get() {
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          return counter.fetch(request);
        },
      };
    },
  };
}

async function reserve(counter, body) {
  const response = await counter.fetch(new Request("https://golfapi-counter.internal/", {
    method: "POST",
    body: JSON.stringify({ op: "reserve", ...body }),
  }));
  return response.json();
}

describe("live wrangler.toml", () => {
  it("declares every live binding, var, cron, and migration tag", () => {
    expect(toml).toContain('name = "shottrax-share"');
    expect(toml).toContain('main = "entry.js"');
    expect(toml).toContain('compatibility_date = "2026-09-23"');

    expect(toml).toContain('binding = "BOARDS"');
    expect(toml).toContain('id = "cfa1824a10374ab6a7fa0c97d0990e80"');
    expect(toml).toContain('binding = "GOLFAPI_KV"');
    expect(toml).toContain('id = "587c98f5372647a88bc9418aa076827a"');

    expect(toml).toContain('name = "GOLFAPI_COUNTER"');
    expect(toml).toContain('class_name = "GolfapiCounter"');
    expect(toml).toContain('tag = "v1-golfapi-counter"');
    expect(toml).toContain('new_sqlite_classes = ["GolfapiCounter"]');

    expect(toml).toContain('name = "ALERT_EMAIL"');
    expect(toml).toContain('destination_address = "shottraxx@gmail.com"');

    expect(toml).toMatch(/crons = \["0 23 \* \* \*"\]/);
    expect(toml).not.toContain("0 8 * * *");
    expect(toml.match(/crons = /g)).toHaveLength(1);

    const varsBlock = toml.split("[vars]")[1];
    expect(varsBlock).toBeTruthy();
    const parsed = {};
    for (const line of varsBlock.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+) = "(.*)"$/);
      if (match) parsed[match[1]] = match[2];
    }
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(LIVE_VARS).sort());
    expect(parsed).toEqual(LIVE_VARS);
    expect(Object.keys(parsed)).toHaveLength(18);

    expect(toml).not.toMatch(/^\s*(GOLFAPI_KEY|GOLF_COURSES_API_KEY|GOLFAPI_ALLOWLIST|COURSE_REPORTS_ADMIN_TOKEN|ALERT_ADMIN_TOKEN)\s*=/m);
    expect(toml).not.toMatch(/\[\[ratelimits\]\]/);
  });
});

describe("GolfapiCounter caps", () => {
  it("stops a new open on the daily cap and on the monthly cap", async () => {
    const daily = new GolfapiCounter({ storage: { sql: memorySql() } });
    const dayBody = {
      install: "phone-day",
      installKey: "golfapi:phone:phone-day",
      dayKey: "golfapi:day:2026-10-13",
      monthKey: "golfapi:month:2026-10-05",
      dayCap: 1,
      monthCap: 100,
      chargeTenths: 10,
      needTenths: 10,
      now: Date.UTC(2026, 9, 13, 12, 0, 0),
      retryDay: 3600,
      retryMonth: 86400,
      courseId: "day-1",
    };
    expect(await reserve(daily, dayBody)).toMatchObject({ ok: true });
    const overDay = await reserve(daily, { ...dayBody, courseId: "day-2" });
    expect(overDay.ok).toBe(false);
    expect(overDay.reason).toBe("app_daily");

    const monthly = new GolfapiCounter({ storage: { sql: memorySql() } });
    const monthBody = {
      ...dayBody,
      install: "phone-month",
      installKey: "golfapi:phone:phone-month",
      dayKey: "golfapi:day:month",
      monthKey: "golfapi:month:cap",
      dayCap: 100,
      monthCap: 1,
      courseId: "month-1",
    };
    expect(await reserve(monthly, monthBody)).toMatchObject({ ok: true });
    const overMonth = await reserve(monthly, { ...monthBody, courseId: "month-2" });
    expect(overMonth.ok).toBe(false);
    expect(overMonth.reason).toBe("app_monthly");
  });
});

describe("golfapi stockpile dry run", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call golfapi when GOLFAPI_STOCKPILE_DRY_RUN is on", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("dry run called golfapi");
    });
    vi.stubGlobal("fetch", fetchMock);
    const ns = counterNamespace();
    await ns.get().fetch(new Request("https://golfapi-counter.internal/", {
      method: "POST",
      body: JSON.stringify({
        op: "noteDemand",
        cycleId: "2026-10-05",
        day: "2026-10-30",
        reason: "phone_limit",
        courseId: "4242",
        name: "Dry Run Club",
        country: "US",
        hasGPS: 1,
      }),
    }));
    const kv = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    };
    const sent = [];
    const report = await runGolfapiStockpile({
      GOLFAPI_STOCKPILE_ENABLED: "true",
      GOLFAPI_STOCKPILE_DRY_RUN: "true",
      GOLFAPI_STOCKPILE_RUN_CREDITS: "800",
      GOLFAPI_CYCLE_DAY: "5",
      GOLFAPI_KEY: "should-not-be-used",
      GOLFAPI_COUNTER: ns,
      GOLFAPI_KV: kv,
      ALERT_EMAIL: {
        async send(message) {
          sent.push(message);
        },
      },
      ALERT_FROM: "alerts@shottraxx.com",
      ALERT_TO: "shottraxx@gmail.com",
    }, { waitUntil() {} }, {
      cron: "0 23 * * *",
      scheduledTime: Date.UTC(2026, 9, 30, 23, 0, 0),
    });

    expect(report.dryRun).toBe(true);
    expect(report.spent).toBe(0);
    expect(report.added).toBe(0);
    expect(report.wouldPull).toEqual([{ courseId: "4242", cost: 2 }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].raw).toContain("Dry run: no paid golfapi call was made.");
  });
});

describe("alert email", () => {
  it("sends through the stubbed ALERT_EMAIL binding", async () => {
    const sent = [];
    const ok = await sendPlainEmail({
      ALERT_EMAIL: {
        async send(message) {
          sent.push(message);
        },
      },
      ALERT_FROM: "alerts@shottraxx.com",
      ALERT_TO: "shottraxx@gmail.com",
    }, "ShotTraxx golfapi alert test", "hello limits");
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("alerts@shottraxx.com");
    expect(sent[0].to).toBe("shottraxx@gmail.com");
    expect(sent[0].raw).toContain("Subject: ShotTraxx golfapi alert test");
    expect(sent[0].raw).toContain("hello limits");
  });
});

describe("deploy entry routes", () => {
  it("keeps a board put on the live share module and applies the live paint rules", async () => {
    const rows = new Map();
    const boards = {
      async get(key) {
        return rows.has(key) ? rows.get(key) : null;
      },
      async put(key, value, opts) {
        rows.set(key, value);
        rows.set(`${key}:opts`, opts || null);
      },
      async delete(key) {
        rows.delete(key);
      },
      async list() {
        return { keys: [], list_complete: true };
      },
    };
    const put = await entry.fetch(new Request("https://shottrax-share.example/round1", {
      method: "PUT",
      body: '{"hole":1}',
    }), { BOARDS: boards }, { waitUntil() {} });
    expect(put.status).toBe(200);
    expect(rows.get("round1")).toBe('{"hole":1}');

    const paint = await entry.fetch(new Request("https://shottrax-share.example/id:course", {
      method: "PUT",
      body: '{"paint":1}',
    }), { BOARDS: boards }, { waitUntil() {} });
    expect(paint.status).toBe(401);
    expect(await paint.json()).toEqual({ error: "install_id_required" });
    expect(rows.has("id:course")).toBe(false);

    const meta = await entry.fetch(new Request("https://shottrax-share.example/meta/golfapi"), {
      BOARDS: boards,
    }, { waitUntil() {} });
    expect(meta.status).toBe(200);
    const body = await meta.json();
    expect(body.month).toMatchObject({ calls: 0, budget: 450 });
    expect(body.day).toMatchObject({ calls: 0, cap: 100 });
    expect(typeof body.month.period).toBe("string");
    expect(typeof body.day.date).toBe("string");
  });
});
