import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import entry from "../entry.js";

const doc = readFileSync(new URL("./friends-api.md", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const ORIGIN = "https://shottrax-share.bcbaird.workers.dev";

// An unlisted friends path stays unserved. Codes, requests, accept, block, unblock, remove, and rounds are served.
const UNPUBLISHED_FRIEND_CALLS = [
  ["POST", "/v1/friends/decline"],
];
const FRIEND_CODE_CALLS = [
  ["POST", "/v1/friends/code"],
  ["POST", "/v1/friends/code/reset"],
  ["POST", "/v1/friends/codes/lookup"],
  ["POST", "/v1/friends/requests"],
  ["POST", "/v1/friends/requests/accept"],
  ["POST", "/v1/friends/block"],
  ["POST", "/v1/friends/unblock"],
  ["POST", "/v1/friends/remove"],
  ["PUT", "/v1/friends/rounds"],
  ["GET", "/v1/friends/rounds"],
  ["GET", "/v1/friends/requests"],
  ["GET", "/v1/friends/list"],
  ["POST", "/v1/friends/code/name"],
  ["POST", "/v1/friends/code/photo"],
  ["PUT", "/v1/friends/live"],
  ["GET", "/v1/friends/live"],
  ["POST", "/v1/friends/live/stop"],
  ["PUT", "/v1/friends/past"],
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
  const response = await entry.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    body: method === "GET" || method === "OPTIONS" ? undefined : "{}",
    headers: { "X-Friend-Key": "a".repeat(32), "Content-Type": "application/json" },
  }), store.env, { waitUntil() {} });
  return { response, writes: store.writes };
}

describe("friends API contract", () => {
  it("unblock: never-blocked target is a harmless no-op", () => {
    expect(doc).toContain("Unblocking someone the caller has not blocked, or an `ownerId` that does not exist, is the same `200` `{ \"ok\": true }` with nothing written");
  });

  it("unblock: no friendship and no pending request on either side afterward", () => {
    expect(doc).toContain("Neither side has a friendship or a pending request until a new request is sent.");
  });

  it("unblock: removes only the caller's block, never the other person's", () => {
    expect(doc).toContain("It does not touch a block the other person holds on the caller.");
  });

  it("unblock: a new request from the formerly blocked person goes through", () => {
    expect(doc).toContain("a request from the person who was blocked is stored as a real pending request the caller can accept. It is no longer quietly dropped.");
  });

  it("unblock: does not consume a code guess", () => {
    expect(doc).toMatch(/### unblock[\s\S]*Does not count as a guess, does not read a code, and does not require the guess limiter\./);
  });

  it("specs unblock as the inverse of block without restoring anything", () => {
    expect(doc).toContain("`POST /v1/friends/unblock`");
    expect(doc).toContain("Deletes only the caller's stored block on that person. It does not restore a friendship, and it does not recreate a request");
    expect(doc).toContain("or an `ownerId` that does not exist, is the same `200` `{ \"ok\": true }` with nothing written");
    expect(doc).toContain("the caller sends a new request with the normal add flow, and the other person accepts it");
    expect(doc).toContain("| `unblock(id)` | `POST /v1/friends/unblock` with `{ ownerId }` |");
  });

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

  it("serves the friends routes without writing outside fr:", async () => {
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
