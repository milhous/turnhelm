import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, codexEnvironment } from "../src/codex.js";

test("profile route uses one-run model and effort", () => {
  assert.deepEqual(
    buildCodexArgs({
      kind: "profile",
      source: "classifier",
      profileId: "deep",
      profile: { description: "x", model: "gpt-6-sol", effort: "high" }
    }, false),
    ["exec", "--sandbox", "read-only", "--model", "gpt-6-sol", "--config", 'model_reasoning_effort="high"', "-"]
  );
});

test("classifier keys do not reach Codex", () => {
  const env = codexEnvironment({
    TYPESAFE_API_KEY: "x",
    LAYA_API_KEY: "y",
    TURNHELM_CONFIG: "z",
    CODEX_HOME: "/tmp/codex"
  });
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
});
