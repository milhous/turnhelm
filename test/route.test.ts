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

test("classifier failure uses configured fallback", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    const auto = parseConfig({ ...config, backend: "auto", hostedJev: { enabled: false } });
    const result = await resolvePhaseARoute("Investigate this issue.", auto);
    assert.equal(result.source, "fallback");
    assert.equal(result.kind, "profile");
    assert.equal(result.profileId, "deep");
    await assert.rejects(() => resolvePhaseARoute("Investigate this issue.", parseConfig({ ...auto, fallbackProfile: undefined })));
  } finally { globalThis.fetch = original; }
});
