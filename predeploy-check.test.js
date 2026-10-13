import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARDS_KV_ID, GOLFAPI_KV_PLACEHOLDER, checkWrangler } from "./predeploy-check.mjs";

const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");

function withGolfapiId(id) {
  return toml.replace(
    /binding = "GOLFAPI_KV"\nid = "[^"]*"/,
    `binding = "GOLFAPI_KV"\nid = "${id}"`,
  );
}

describe("predeploy-check", () => {
  it("accepts the committed wrangler.toml", () => {
    expect(checkWrangler(toml)).toEqual([]);
  });

  it("rejects a placeholder, an empty id, and the boards namespace", () => {
    expect(checkWrangler(withGolfapiId(GOLFAPI_KV_PLACEHOLDER)).join("\n")).toContain(GOLFAPI_KV_PLACEHOLDER);
    expect(checkWrangler(withGolfapiId("")).join("\n")).toContain("empty");
    expect(checkWrangler(withGolfapiId(BOARDS_KV_ID)).join("\n")).toContain(BOARDS_KV_ID);
  });
});
