import test from "node:test";
import assert from "node:assert/strict";
import * as route from "../src/route.js";

// The legacy classifier/fallback decision path (classifyTask,
// resolvePhaseARoute, direct/fallback RouteDecision kinds, the 2000 UTF-16
// local policy) was removed with the project task entry. Routing is now
// routeTask over ProjectConfig; its selection, failover, cancellation, and
// budget contracts are pinned by task-routing.test.ts and task-input.test.ts.

test("legacy classifier and fallback decision exports no longer exist", () => {
  for (const name of ["classifyTask", "resolvePhaseARoute"]) {
    assert.equal(Object.hasOwn(route, name), false, name + " must not be exported");
  }
});

test("the module surface is exactly the project task contract", () => {
  assert.deepEqual(Object.keys(route).sort(), ["routeTask"]);
});

test("failed routing exposes attempts and timing but never a fallback decision", async () => {
  const config = {
    version: 1 as const,
    routingTimeoutMs: 100,
    backends: {
      laya: { enabled: true, url: "http://127.0.0.1:1" },
      jev: { enabled: false }
    },
    profiles: {
      fast: { model: "gpt-6-luna", effort: "low" as const },
      balanced: { model: "gpt-6.1-sol", effort: "medium" as const },
      deep: { model: "gpt-6.1-sol", effort: "high" as const },
      frontier: { model: "gpt-6-astra", effort: "high" as const },
      frontier_xhigh: { model: "gpt-6-astra", effort: "xhigh" as const },
      frontier_max: { model: "gpt-6-astra", effort: "max" as const }
    }
  };
  const result = await route.routeTask("Review the boundary between the worker and the queue.", config, {
    env: { LAYA_API_KEY: "test-key" }
  });
  assert.equal(result.status, "failed");
  assert.ok(!("decision" in result), "a failed routing must not carry a route decision");
  assert.ok(result.attempts.length > 0);
  assert.equal(typeof result.routingMs, "number");
});
