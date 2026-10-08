import test from "node:test";
import assert from "node:assert/strict";
import * as config from "../src/config.js";

// Legacy global-config surface (RawConfig materialization, parseConfig,
// loadConfig) was removed with the project task entry; no compatibility
// aliases are retained. The new project config parser is pinned by
// project-config.test.ts, which also rejects every legacy root field.

test("legacy global config exports no longer exist", () => {
  for (const name of ["parseRawConfig", "materializeExplicit", "materializeAuto",
    "materializeConfig", "parseConfig", "loadConfig"]) {
    assert.equal(Object.hasOwn(config, name), false, name + " must not be exported");
  }
});

test("the module surface is exactly the project task contract", () => {
  assert.deepEqual(Object.keys(config).sort(), ["PROFILE_IDS", "parseProjectConfig", "readProjectConfig"]);
});

test("six fixed profiles are the only routing targets", () => {
  assert.deepEqual([...config.PROFILE_IDS],
    ["fast", "balanced", "deep", "frontier", "frontier_xhigh", "frontier_max"]);
});
