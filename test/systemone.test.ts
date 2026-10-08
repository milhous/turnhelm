import test from "node:test";
import assert from "node:assert/strict";
import * as systemone from "../src/systemone.js";

// The legacy hosted-Jev policy (hostedJev config flag, chooseProfile, the
// fetch-based buildSystemOneRequest/readDecision pair, auto-backend
// fallback) was removed with the project task entry. Eligibility now comes
// from ProjectConfig backends plus environment authorization
// (eligibleBackends), classification is requestTaskChoice, and the direct
// transport contract — redirect refusal, byte bounds, body cleanup, TLS
// verification, proxy isolation — is pinned by direct-transport.test.ts.
// Route-level choice validation, including own-property checks, is pinned by
// task-routing.test.ts.

test("legacy chooseProfile path no longer exists", () => {
  assert.equal(Object.hasOwn(systemone, "chooseProfile"), false, "chooseProfile must not be exported");
});

test("the raw legacy request builder stays unexported", () => {
  assert.equal(Object.hasOwn(systemone, "buildSystemOneRequest"), false);
});

test("the module surface is exactly the project task contract", () => {
  assert.deepEqual(Object.keys(systemone).sort(),
    ["directChoiceRequest", "eligibleBackends", "requestTaskChoice"]);
});

test("hosted Jev eligibility requires configuration, authorization, and a key together", () => {
  const config = {
    version: 1 as const,
    routingTimeoutMs: 4000,
    backends: {
      laya: { enabled: false, url: "http://127.0.0.1:8765" },
      jev: { enabled: true }
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
  assert.deepEqual(systemone.eligibleBackends(config, {}), []);
  assert.deepEqual(systemone.eligibleBackends(config, { TURNHELM_ALLOW_HOSTED_JEV: "1" }), []);
  assert.deepEqual(systemone.eligibleBackends(config, { TYPESAFE_API_KEY: "  " }), []);
  assert.deepEqual(
    systemone.eligibleBackends(config, { TURNHELM_ALLOW_HOSTED_JEV: "1", TYPESAFE_API_KEY: "key" }),
    ["jev"]);
});
