import { beforeEach, describe, expect, it } from "vitest";
import worker from "./worker.js";
import { handleLivePage, isLiveBoardCode, livePageCode, renderLivePage, storeLive, __test } from "./live-page.js";

const { normalizeCode, parseBoard, planView, previewLine, renderBoard, clientScript } = __test;

const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";
const NOW = Date.parse("2026-09-28T18:00:00Z");

function hole(n, extra = {}) {
  return {
    hole: n,
    club: null,
    pinToPinYards: null,
    score: null,
    approximate: false,
    par: 4,
    putts: null,
    startedAt: null,
    completedAt: null,
    ...extra,
  };
}

function board(extra = {}) {
  return {
    v: 1,
    token: "BK3MCQ",
    courseName: "Greystone CC",
    finished: false,
    live: { hole: 3, score: null, lastClubYards: "7 Iron · 152 yd" },
    holes: [
      hole(1, { score: 5, putts: 2, startedAt: "2026-09-28T17:00:00Z", completedAt: "2026-09-28T17:12:00Z" }),
      hole(2, { par: 3, score: 2, putts: 1, startedAt: "2026-09-28T17:12:00Z", completedAt: "2026-09-28T17:24:00Z" }),
      hole(3, { startedAt: "2026-09-28T17:24:00Z" }),
      hole(4),
    ],
    updatedAt: "2026-09-28T17:25:00Z",
    ...extra,
  };
}

function page(extra = {}, opts = {}) {
  return renderLivePage({ code: "BK3MCQ", board: parseBoard(board(extra)), nowMs: NOW, nonce: "n", ...opts });
}

describe("live board page: codes", () => {
  it("routes only /s/{six-character board code}", () => {
    expect(livePageCode("/s/bk3mcq")).toBe("BK3MCQ");
    expect(livePageCode("/s/BK3MCQ/")).toBe("BK3MCQ");
    expect(livePageCode("/s/bk3%20mcq")).toBe("BK3MCQ");
    expect(livePageCode("/BK3MCQ")).toBe(null);
    expect(livePageCode("/s/")).toBe(null);
    expect(livePageCode("/s/BK3MCQ/extra")).toBe(null);
    // Not in the code alphabet, wrong length, or a reserved / paint key.
    for (const bad of ["BK3MC", "BK3MCQQ", "BK0MCQ", "round9", "gq:balance", "gca:course:14322", "id:14322", "osm:v1:x"]) {
      expect(livePageCode(`/s/${encodeURIComponent(bad)}`), bad).toBe(null);
    }
    expect(isLiveBoardCode("BK3MCQ")).toBe(true);
    expect(isLiveBoardCode("bk3mcq")).toBe(false);
    expect(normalizeCode(" bk3-mcq ")).toBe("BK3MCQ");
  });
});

describe("live board page: board data", () => {
  it("unwraps host shapes and drops junk", () => {
    const raw = board();
    expect(parseBoard(JSON.stringify({ value: JSON.stringify(raw) })).courseName).toBe("Greystone CC");
    expect(parseBoard({ payload: raw }).holes.length).toBe(4);
    expect(parseBoard("<html>")).toBe(null);
    expect(parseBoard(null)).toBe(null);
    expect(parseBoard({ nope: true })).toBe(null);
    expect(parseBoard("keep-me")).toBe(null);
    const odd = parseBoard({ holes: [{ hole: 2, score: "x", par: 3 }, null, { hole: 1, score: 4, par: 4 }] });
    expect(odd.holes.map((row) => [row.hole, row.score])).toEqual([
      [1, 4],
      [2, null],
    ]);
  });

  it("matches the app: to-par only with pars, pace, live hole", () => {
    const view = planView(parseBoard(board()), NOW);
    expect(view.total).toBe(7);
    expect(view.toPar).toBe("E");
    expect(view.kicker).toBe("Live");
    expect(view.onHole).toBe(3);
    expect(view.pace).toBe("Thru 2 · 1h 00m elapsed · ~24m left");
    expect(previewLine(view)).toBe("E thru 2 · On hole 3");

    const noPar = planView(parseBoard(board({ holes: [hole(1, { par: null, score: 5 }), hole(2)] })), NOW);
    expect(noPar.toPar).toBe(null);
    expect(previewLine(noPar)).toBe("5 thru 1 · On hole 3");

    const done = planView(parseBoard(board({ finished: true })), NOW);
    expect(done.kicker).toBe("Final");
    expect(done.onHole).toBe(null);
    expect(previewLine(done)).toBe("Final: E");
    expect(previewLine(null)).toBe("Follow this round live, hole by hole.");
  });

  it("group table shows Out and In only for 18 holes", () => {
    const players = (n) => [
      {
        name: "A",
        holes: Array.from({ length: n }, (_, i) => ({ hole: i + 1, score: 4 })),
        out: 36,
        in: n >= 18 ? 36 : null,
        total: 4 * n,
      },
      { name: "B", holes: [{ hole: 1, score: 5 }], out: null, in: null, total: 5 },
    ];
    const nine = renderBoard(planView(parseBoard(board({ group: { players: players(9) } })), NOW), () => "");
    expect(nine).not.toMatch(/>Out</);
    const full = renderBoard(planView(parseBoard(board({ group: { players: players(18) } })), NOW), () => "");
    expect(full).toMatch(/>Out<\/th><th class="sum">In</);
  });
});

describe("live board page: HTML", () => {
  it("escapes every stored string, since anyone can PUT a board", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = page({
      courseName: evil,
      live: { hole: 3, lastClubYards: evil },
      group: {
        players: [
          { name: evil, holes: [{ hole: 1, score: 4 }], out: null, in: null, total: 4 },
          { name: "Sam", holes: [{ hole: 1, score: 5 }], out: null, in: null, total: 5 },
        ],
        results: [{ title: evil, lines: [evil] }],
      },
    });
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
    const script = html.slice(html.indexOf("<script") + 8, html.lastIndexOf("</script>"));
    expect(script).not.toMatch(/<\//);
  });

  it("STORE_LIVE off (default): no App Store banner, offer card, or trial; Open in ShotTraxx™ stays", () => {
    const html = page();
    expect(html).toMatch(/<title>Live · Greystone CC<\/title>/);
    expect(html).toMatch(/property="og:description" content="E thru 2 · On hole 3"/);
    expect(html).toMatch(/property="og:site_name" content="ShotTraxx™"/);
    expect(html).not.toMatch(/apple-itunes-app/);
    expect(html).not.toMatch(/Track your own round/);
    expect(html).not.toMatch(/14 days/);
    expect(html).not.toMatch(/apps\.apple\.com/);
    expect(html).toMatch(/href="shottrax:\/\/\/s\/BK3MCQ">Open in ShotTraxx™</);
    expect(html).toMatch(/<script nonce="n">/);
    expect(html).not.toMatch(/lat|lng|geolocation/i);
  });

  it("STORE_LIVE on: banner, offer card with the trial, and both buttons", () => {
    const html = page({}, { storeLive: true });
    expect(html).toMatch(/name="apple-itunes-app" content="app-id=6812944398, app-argument=shottrax:\/\/\/s\/BK3MCQ"/);
    expect(html).toMatch(/Track your own round/);
    expect(html).toMatch(/free for 14 days/);
    expect(html).toMatch(/href="https:\/\/apps\.apple\.com\/app\/id6812944398">Get ShotTraxx™ on the App Store</);
    expect(html).toMatch(/Already have it\? Open in ShotTraxx™</);
  });

  it("every visible ShotTraxx carries ™; URLs and VoiceOver labels do not", () => {
    for (const html of [page(), page({}, { storeLive: true })]) {
      const visible = html
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<style[\s\S]*?<\/style>/g, "")
        .replace(/(href|content|aria-label)="[^"]*"/g, (attr) => (attr.startsWith("content") && /ShotTraxx/.test(attr) ? attr : ""));
      expect(visible).not.toMatch(/ShotTraxx(?!™)/);
    }
    expect(page({}, { storeLive: true })).toMatch(/aria-label="ShotTraxx on the App Store"/);
  });

  it("STORE_LIVE reads true / 1 / yes only", () => {
    expect(storeLive({})).toBe(false);
    expect(storeLive(undefined)).toBe(false);
    expect(storeLive({ STORE_LIVE: "" })).toBe(false);
    expect(storeLive({ STORE_LIVE: "false" })).toBe(false);
    expect(storeLive({ STORE_LIVE: "true" })).toBe(true);
    expect(storeLive({ STORE_LIVE: " 1 " })).toBe(true);
    expect(storeLive({ STORE_LIVE: "Yes" })).toBe(true);
  });
});

describe("live board page: browser script", () => {
  function runScript(script, { pathname = "/s/BK3MCQ", fetch = () => new Promise(() => {}) } = {}) {
    const state = { html: "", timers: [], urls: [] };
    const root = {
      set innerHTML(value) {
        state.html = value;
      },
    };
    const env = {
      document: { getElementById: () => root, hidden: false, addEventListener() {} },
      setTimeout: (fn, ms) => state.timers.push({ fn, ms }),
      clearTimeout() {},
      location: { pathname },
      fetch: (url, init) => {
        state.urls.push(String(url));
        return fetch(url, init);
      },
    };
    new Function(...Object.keys(env), script)(...Object.values(env));
    return state;
  }

  it("is valid JS, renders the board, and polls GET /{code}", () => {
    const state = runScript(clientScript("BK3MCQ", parseBoard(board())));
    expect(state.html).toMatch(/Greystone CC/);
    expect(state.html).toMatch(/Thru 2/);
    expect(state.timers.map((t) => t.ms)).toEqual([8000]);
    state.timers[0].fn();
    expect(state.urls).toEqual(["/BK3MCQ"]);
  });

  it("does not poll once the round is final", () => {
    const state = runScript(clientScript("BK3MCQ", parseBoard(board({ finished: true }))));
    expect(state.html).toMatch(/Final/);
    expect(state.timers).toEqual([]);
  });
});

describe("live board page: handler", () => {
  it("serves the page for GET, a 404 page for a bad code, and null for other routes", async () => {
    const seen = [];
    const loadBoard = async (code) => {
      seen.push(code);
      return code === "BK3MCQ" ? JSON.stringify(board()) : null;
    };
    const res = await handleLivePage(new Request(`${ORIGIN}/s/bk3mcq`), {}, { loadBoard, nowMs: NOW });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
    expect(await res.text()).toMatch(/Greystone CC/);

    const empty = await handleLivePage(new Request(`${ORIGIN}/s/ZZZZZZ`), {}, { loadBoard, nowMs: NOW });
    expect(empty.status).toBe(200);
    expect(await empty.text()).toMatch(/Waiting for the first hole/);

    const bad = await handleLivePage(new Request(`${ORIGIN}/s/gq%3Abalance`), {}, { loadBoard });
    expect(bad.status).toBe(404);
    expect(await bad.text()).toMatch(/not a board code/);

    const broken = await handleLivePage(new Request(`${ORIGIN}/s/AAAAAA`), {}, {
      loadBoard: async () => {
        throw new Error("kv down");
      },
    });
    expect(await broken.text()).toMatch(/Waiting for the first hole/);

    expect(await handleLivePage(new Request(`${ORIGIN}/BK3MCQ`), {}, { loadBoard })).toBe(null);
    expect(await handleLivePage(new Request(`${ORIGIN}/s/BK3MCQ`, { method: "PUT", body: "{}" }), {}, { loadBoard })).toBe(null);
    expect(seen).toEqual(["BK3MCQ", "ZZZZZZ"]);
  });
});

describe("live board page: worker route", () => {
  let kv;
  let env;

  beforeEach(() => {
    kv = new Map();
    env = {
      BOARDS: {
        async get(key) {
          return kv.has(key) ? kv.get(key) : null;
        },
        async put(key, value) {
          kv.set(key, value);
        },
      },
    };
  });

  function invoke(path, init) {
    return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil() {} });
  }

  it("renders a stored board and keeps GET/PUT /{code} working", async () => {
    const put = await invoke("/BK3MCQ", { method: "PUT", body: JSON.stringify(board()) });
    expect(put.status).toBe(200);
    const res = await invoke("/s/bk3mcq");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Greystone CC/);
    expect(html).not.toMatch(/apple-itunes-app/);
    const json = await invoke("/BK3MCQ");
    expect(JSON.parse(await json.text()).courseName).toBe("Greystone CC");

    env.STORE_LIVE = "true";
    expect(await (await invoke("/s/BK3MCQ")).text()).toMatch(/apple-itunes-app/);
  });

  it("never reads reserved, paint, or non-code keys", async () => {
    const secret = JSON.stringify({ holes: [{ hole: 1, score: 99, par: 4 }], courseName: "SECRET" });
    for (const key of ["gq:balance", "gapi:course:abc", "gqueue:abc", "osm:v1:secret", "gca:course:14322", "id:14322", "name:magnolia", "round9"]) {
      kv.set(key, secret);
    }
    const reads = [];
    const get = env.BOARDS.get;
    env.BOARDS.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    for (const key of ["gq:balance", "gapi:course:abc", "gqueue:abc", "osm:v1:secret", "gca:course:14322", "id:14322", "name:magnolia", "round9"]) {
      const res = await invoke(`/s/${encodeURIComponent(key)}`);
      expect(res.status, key).toBe(404);
      expect(await res.text()).not.toMatch(/SECRET/);
    }
    expect(reads).toEqual([]);
  });

  it("renders the waiting page when BOARDS is not bound", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/s/BK3MCQ`), {}, { waitUntil() {} });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Waiting for the first hole/);
  });
});
