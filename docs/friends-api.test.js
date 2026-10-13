import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../worker.js";

const doc = readFileSync(new URL("./friends-api.md", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";

// Requests, accept, remove, block, and rounds stay unserved until a later step.
// getCode, resetCode, and lookup are served once friend codes land (#24).
const UNPUBLISHED_FRIEND_CALLS = [
  ["POST", "/v1/friends/requests"],
  ["POST", "/v1/friends/requests/accept"],
  ["POST", "/v1/friends/remove"],
  ["POST", "/v1/friends/block"],
  ["PUT", "/v1/friends/rounds"],
  ["GET", "/v1/friends/rounds"],
];
const FRIEND_CODE_CALLS = [
  ["POST", "/v1/friends/code"],
  ["POST", "/v1/friends/code/reset"],
  ["POST", "/v1/friends/codes/lookup"],
];

function boards() {
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
      },
    },
  };
}

async function call(path, method) {
  const store = boards();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    body: method === "GET" || method === "OPTIONS" ? undefined : "{}",
    headers: { "X-Friend-Key": "a".repeat(32), "Content-Type": "application/json" },
  }), store.env, { waitUntil() {} });
  return { response, writes: store.writes };
}

describe("friends API contract", () => {
  it("allows PUT on the friends CORS preflight", () => {
    expect(doc).toContain("CORS for `/v1/friends` allows `GET, POST, PUT, OPTIONS`");
    expect(doc).toContain("headers `Content-Type` and `X-Friend-Key`");
  });

  it("404s only an unlisted /v1/friends path", () => {
    expect(doc).toContain("A path under `/v1/friends` that this document does not list is `404`");
    expect(doc).toContain("Existing `/v1/course-reports` is unchanged");
    expect(doc).not.toContain("A path under `/v1/` that this document does not list");
  });

  it("keeps OPTIONS as an unauthenticated preflight", () => {
    expect(doc).toContain("`OPTIONS` is the CORS preflight: status `200`, empty body, no friend key, and no KV read or write");
  });

  it("allows a partial hole list", () => {
    expect(doc).toContain("A nine-hole round does not have to include holes 10–18");
    expect(doc).not.toContain("run from 1 to 18");
  });

  it("deletes a league round on unshare", () => {
    expect(doc).toContain("until `remove`, `block`, or unshare (`share: false` with `round: null`) deletes it");
  });

  it("does not spend a guess on the caller's own code", () => {
    expect(doc).toContain("That check is made before the guess limiter and does not consume a guess");
  });

  it("does not store a second pending request", () => {
    expect(doc).toContain("A pending request that is already stored returns the same `200` pending body and does not store a second row");
  });

  it("encodes ownerId as 22 unpadded base64url characters", () => {
    expect(doc).toContain("22 unpadded base64url characters");
  });

  it("has no decline call", () => {
    expect(doc).toContain("There is no decline call");
  });

  it("returns the full round list with no cursor", () => {
    expect(doc).toContain("The response is the full list. There is no cursor.");
  });

  it("adds no binding", () => {
    expect(wrangler).toContain('binding = "BOARDS"');
    expect(wrangler).not.toMatch(/\[\[ratelimits\]\]/);
    // The golf proxy and, once friend codes ship, FriendGuessLimiter are sqlite
    // classes. This contract does not add a Workers rate-limit binding.
    if (wrangler.includes("FriendGuessLimiter")) {
      expect(wrangler).toContain('name = "FRIEND_GUESSES"');
      expect(wrangler).toContain('new_sqlite_classes = ["FriendGuessLimiter"]');
      expect(wrangler).toContain('tag = "v2-friend-guesses"');
    } else {
      expect(wrangler).not.toContain("FRIEND_GUESSES");
    }
  });

  it("does not serve the friends routes and does not write KV", async () => {
    for (const [method, path] of UNPUBLISHED_FRIEND_CALLS) {
      const { response, writes } = await call(path, method);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json(), `${method} ${path}`).toEqual({ error: "unknown_route" });
      expect(writes, `${method} ${path}`).toEqual([]);
    }
    for (const [method, path] of FRIEND_CODE_CALLS) {
      const { response, writes } = await call(path, method);
      if (response.status === 404) {
        expect(await response.json(), `${method} ${path}`).toEqual({ error: "unknown_route" });
        expect(writes, `${method} ${path}`).toEqual([]);
      } else {
        expect(writes.every((key) => key.startsWith("fr:")), `${method} ${path}`).toBe(true);
      }
    }
    const preflight = await call("/v1/friends/rounds", "OPTIONS");
    expect(preflight.response.status).toBe(200);
    expect(await preflight.response.text()).toBe("");
    expect(preflight.writes).toEqual([]);

    const report = await call("/v1/course-reports", "POST");
    expect(report.response.status).not.toBe(404);
    expect((await report.response.json()).error).not.toBe("unknown_route");
  });
});
