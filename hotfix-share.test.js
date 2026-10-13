import { afterEach, describe, expect, it, vi } from "vitest";
import live, { __resetHotfixMemoryForTests, __setEmailMessageClassForTests } from "./live-shottrax-share.js";

const ORIGIN = "https://shottrax-share.example";
const INSTALL = "install-0001";
const COURSE_ID = "14322";
const COURSE_BODY = JSON.stringify({
  courseID: COURSE_ID,
  courseName: "Magnolia",
  numHoles: 18,
});

function boardsFrom(seed = {}) {
  const rows = new Map(Object.entries(seed));
  const writes = [];
  return {
    rows,
    writes,
    binding: {
      async get(key) {
        return rows.has(key) ? rows.get(key) : null;
      },
      async put(key, value) {
        writes.push(key);
        rows.set(key, String(value));
      },
      async delete(key) {
        writes.push(key);
        rows.delete(key);
      },
      async list() {
        return { keys: [...rows.keys()].map((name) => ({ name })), list_complete: true };
      },
    },
  };
}

function shareEnv(store, extra = {}) {
  return {
    BOARDS: store.binding,
    GOLFAPI_KEY: "golf-secret",
    ...extra,
  };
}

async function shareGet(path, env) {
  const response = await live.fetch(new Request(`${ORIGIN}${path}`, {
    headers: { "X-Install-Id": INSTALL },
  }), env, { waitUntil() {} });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

describe("live share golfapi hotfix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetHotfixMemoryForTests();
  });

  it("stops a new open when the balance would fall through the credit floor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = boardsFrom({
      "gq:balance": JSON.stringify({ left: 50, at: Date.now(), lastStatus: 200 }),
    });
    const blocked = await shareGet(`/golfapi/v2.3/courses/${COURSE_ID}`, shareEnv(store));
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({ error: "golfapi_limited", reason: "floor" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves a stored course body without calling golfapi", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = boardsFrom({
      [`gapi:course:${COURSE_ID}`]: COURSE_BODY,
    });
    const hit = await shareGet(`/golfapi/v2.3/courses/${COURSE_ID}`, shareEnv(store));
    expect(hit.status).toBe(200);
    expect(hit.text).toBe(COURSE_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.writes.some((key) => key.startsWith("gapi:"))).toBe(false);
  });

  it("sends one reserve alert when the floor closes the gate", async () => {
    const sent = [];
    class EmailMessage {
      constructor(from, to, raw) {
        this.from = from;
        this.to = to;
        this.raw = raw;
      }
    }
    __setEmailMessageClassForTests(EmailMessage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = boardsFrom({
      "gq:balance": JSON.stringify({ left: 50, at: Date.now(), lastStatus: 200 }),
    });
    const env = shareEnv(store, {
      ALERT_EMAIL: {
        async send(message) {
          sent.push(message);
        },
      },
      ALERT_FROM: "alerts@shottraxx.com",
      ALERT_TO: "shottraxx@gmail.com",
    });
    const first = await shareGet(`/golfapi/v2.3/courses/${COURSE_ID}`, env);
    expect(first.status).toBe(429);
    expect(first.json.reason).toBe("floor");
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("alerts@shottraxx.com");
    expect(sent[0].to).toBe("shottraxx@gmail.com");
    expect(sent[0].raw).toContain("Subject: ShotTraxx golfapi alert: reserve");
    expect(fetchMock).not.toHaveBeenCalled();

    const second = await shareGet(`/golfapi/v2.3/courses/${COURSE_ID}`, env);
    expect(second.status).toBe(429);
    expect(sent).toHaveLength(1);
  });
});
