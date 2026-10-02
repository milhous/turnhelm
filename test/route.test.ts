import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { resolvePhaseARoute } from "../src/route.js";

const config = parseConfig({
  backend: "laya",
  layaUrl: "http://127.0.0.1:8765",
  fallbackProfile: "deep",
  profiles: { deep: { description: "Complex work", model: "gpt-6-sol", effort: "high" } }
});

test("short continuation uses Phase A fallback", async () => {
  const result = await resolvePhaseARoute("继续", config);
  assert.equal(result.kind, "profile");
  assert.equal(result.source, "continuation");
  assert.equal(result.profileId, "deep");
});

test("long input uses Phase A fallback before a backend call", async () => {
  const result = await resolvePhaseARoute("x".repeat(2001), config);
  assert.equal(result.source, "fallback");
});
