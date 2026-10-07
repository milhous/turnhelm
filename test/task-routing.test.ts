import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectConfig, PROFILE_IDS } from "../src/config.js";
import { eligibleBackends, requestTaskChoice, type RequestSpec, type TaskBackend } from "../src/systemone.js";
import { routeTask } from "../src/route.js";
import { decisionReply, fakeEnv, fixtureConfig } from "./fixtures.js";

const jevEnabled = () => {
  const base = fixtureConfig();
  return parseProjectConfig({ ...base, backends: { ...base.backends, jev: { enabled: true } } });
};

const layaDisabled = () => {
  const base = fixtureConfig();
  return parseProjectConfig({ ...base, backends: { laya: { enabled: false, url: base.backends.laya.url }, jev: { enabled: true } } });
};

const noBackends = () => {
  const base = fixtureConfig();
  return parseProjectConfig({ ...base, backends: { laya: { enabled: false, url: base.backends.laya.url }, jev: { enabled: false } } });
};

const countingRequest = (log: string[], reply: (backend: TaskBackend) => unknown) => async (spec: RequestSpec) => {
  log.push(spec.backend);
  return reply(spec.backend);
};

test("normal max is selected by one Laya request", async () => {
  const c = fixtureConfig();
  let calls = 0;
  const r = await routeTask("Prove the coupled transaction invariants", c, {
    env: fakeEnv,
    request: async s => { calls++; assert.equal(s.backend, "laya"); return decisionReply("frontier_max"); }
  });
  assert.ok(r.status === "selected");
  assert.equal(calls, 1);
  assert.equal(r.decision.profile.effort, "max");
  assert.equal(r.decision.profile, c.profiles.frontier_max);
  assert.ok(Object.isFrozen(r.decision));
});

test("one authorized Jev attempt follows one Laya failure", async () => {
  const base = fixtureConfig();
  const c = parseProjectConfig({ ...base, backends: { ...base.backends, jev: { enabled: true } } });
  const calls: string[] = [];
  const r = await routeTask("Investigate cross-module invariants", c, {
    env: fakeEnv, request: async s => {
      calls.push(s.backend);
      if (s.backend === "laya") throw new Error("TEST_PRIVATE_SENTINEL");
      return decisionReply("deep");
    }
  });
  assert.ok(r.status === "selected");
  assert.deepEqual(calls, ["laya", "jev"]);
  assert.equal(r.decision.backend, "jev");
  assert.deepEqual(r.decision.attempts.map(a => a.outcome), ["failed", "success"]);
});

test("invalid route fails with evidence, not fallback", async () => {
  const r = await routeTask("Fix cache invalidation", fixtureConfig(), {
    env: fakeEnv, request: async () => ({ answers: { route: "fast" } })
  });
  assert.ok(r.status === "failed");
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].outcome, "failed");
  assert.ok(!("decision" in r));
});

test("user cancellation records the initiated request and never tries Jev", async () => {
  const ac = new AbortController();
  const base = fixtureConfig();
  const c = parseProjectConfig({ ...base, backends: { ...base.backends, jev: { enabled: true } } });
  const calls: string[] = [];
  const r = await routeTask("Fix cache invalidation", c, {
    env: fakeEnv, signal: ac.signal, request: async s => {
      calls.push(s.backend); ac.abort(); throw new Error("TEST_PRIVATE_SENTINEL");
    }
  });
  assert.ok(r.status === "cancelled");
  assert.deepEqual(calls, ["laya"]);
  assert.equal(r.attempts[0].outcome, "cancelled");
});

test("already-aborted routing records no attempts and sends no request", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const r = await routeTask("Fix cache invalidation", fixtureConfig(), {
    env: fakeEnv, signal: ac.signal, request: async () => { calls++; return decisionReply(); }
  });
  assert.ok(r.status === "cancelled");
  assert.equal(r.attempts.length, 0);
  assert.equal(calls, 0);
});

for (const id of PROFILE_IDS) {
  test(`selects ${id} from the fixed decision set`, async () => {
    const c = fixtureConfig();
    const r = await routeTask("Prove the coupled invariants", c, {
      env: fakeEnv, request: async () => decisionReply(id)
    });
    assert.ok(r.status === "selected");
    assert.equal(r.decision.profileId, id);
    assert.equal(r.decision.profile, c.profiles[id]);
    assert.ok(Object.isFrozen(r.decision));
    assert.ok(Object.isFrozen(r.decision.attempts));
    assert.ok(Object.isFrozen(r.decision.attempts[0]));
  });
}

test("a sole Laya backend is selected without Jev evidence", async () => {
  const calls: string[] = [];
  const r = await routeTask("Prove the invariants", fixtureConfig(), {
    env: fakeEnv, request: countingRequest(calls, () => decisionReply("balanced"))
  });
  assert.ok(r.status === "selected");
  assert.deepEqual(calls, ["laya"]);
  assert.equal(r.decision.attempts.length, 1);
});

test("a sole hosted Jev backend routes without contacting Laya", async () => {
  const calls: string[] = [];
  const r = await routeTask("Prove the invariants", layaDisabled(), {
    env: fakeEnv, request: countingRequest(calls, () => decisionReply("deep"))
  });
  assert.ok(r.status === "selected");
  assert.deepEqual(calls, ["jev"]);
  assert.equal(r.decision.backend, "jev");
});

test("no eligible backend fails with zero attempts and no requests", async () => {
  let calls = 0;
  const r = await routeTask("Prove the invariants", layaDisabled(), {
    env: {}, request: async () => { calls++; return decisionReply(); }
  });
  assert.ok(r.status === "failed");
  assert.equal(r.attempts.length, 0);
  assert.equal(calls, 0);
  assert.ok(Object.isFrozen(r.attempts));
});

test("eligibility follows configuration and hosted authorization", () => {
  const base = fixtureConfig();
  assert.deepEqual(eligibleBackends(base, fakeEnv), ["laya"]);
  assert.deepEqual(eligibleBackends(jevEnabled(), fakeEnv), ["laya", "jev"]);
  assert.deepEqual(eligibleBackends(jevEnabled(), { ...fakeEnv, TURNHELM_ALLOW_HOSTED_JEV: "0" }), ["laya"]);
  assert.deepEqual(eligibleBackends(jevEnabled(), { LAYA_API_KEY: "k", TURNHELM_ALLOW_HOSTED_JEV: "1" }), ["laya"]);
  assert.deepEqual(eligibleBackends(jevEnabled(), { ...fakeEnv, TYPESAFE_API_KEY: "" }), ["laya"]);
  assert.deepEqual(eligibleBackends(jevEnabled(), { ...fakeEnv, TYPESAFE_API_KEY: "   " }), ["laya"]);
  assert.deepEqual(eligibleBackends(layaDisabled(), fakeEnv), ["jev"]);
  assert.deepEqual(eligibleBackends(noBackends(), fakeEnv), []);
  assert.deepEqual(eligibleBackends(noBackends(), {}), []);
});

test("hosted Jev stays ineligible when only the key is missing", async () => {
  const calls: string[] = [];
  const r = await routeTask("Prove the invariants", jevEnabled(), {
    env: { LAYA_API_KEY: "k", TURNHELM_ALLOW_HOSTED_JEV: "1" },
    request: countingRequest(calls, () => decisionReply())
  });
  assert.ok(r.status === "selected");
  assert.deepEqual(calls, ["laya"]);
});

test("local task validation rejects before any request", async () => {
  for (const [name, task] of [
    ["blank", "   "], ["continuation", "continue"], ["nul-containing", "a\0b"], ["oversized", "x".repeat(8193)]
  ] as const) {
    let calls = 0;
    await assert.rejects(
      () => routeTask(task, fixtureConfig(), { env: fakeEnv, request: async () => { calls++; return decisionReply(); } }),
      Error
    );
    assert.equal(calls, 0, name);
  }
});

test("a Laya timeout leaves Jev only the remaining total budget", async () => {
  const base = fixtureConfig();
  const c = parseProjectConfig({ ...base, routingTimeoutMs: 400, backends: { ...base.backends, jev: { enabled: true } } });
  const delays: number[] = [];
  const stalled = async (spec: RequestSpec) => {
    const began = performance.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("stalled request observed its supplied signal"));
        if (spec.signal.aborted) { onAbort(); return; }
        spec.signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      delays.push(performance.now() - began);
    }
    throw new Error("unreachable after abort");
  };
  const r = await routeTask("Prove the invariants", c, { env: fakeEnv, request: stalled });
  assert.ok(r.status === "failed");
  assert.deepEqual(r.attempts.map(a => a.outcome), ["timeout", "timeout"]);
  assert.ok(delays[0] >= 80 && delays[0] < 350, "laya share capped near min(1000, total/4)");
  assert.ok(delays[1] >= 280 && delays[1] < 1500, "jev receives the total remainder, not another laya share");
});

test("a final failure retains both attempts with their outcomes", async () => {
  const base = fixtureConfig();
  const c = parseProjectConfig({ ...base, routingTimeoutMs: 400, backends: { ...base.backends, jev: { enabled: true } } });
  const stalled = async (spec: RequestSpec) => {
    await new Promise<void>((resolve, reject) => {
      if (spec.signal.aborted) { reject(new Error("stalled request observed its supplied signal")); return; }
      spec.signal.addEventListener("abort", () => reject(new Error("stalled request observed its supplied signal")), { once: true });
    });
    throw new Error("unreachable after abort");
  };
  const r = await routeTask("Prove the invariants", c, {
    env: fakeEnv, request: async s => s.backend === "laya" ? stalled(s) : Promise.reject(new Error("TEST_PRIVATE_SENTINEL"))
  });
  assert.ok(r.status === "failed");
  assert.deepEqual(r.attempts.map(a => a.outcome), ["timeout", "failed"]);
  assert.ok(Object.isFrozen(r.attempts));
  assert.ok(Object.isFrozen(r.attempts[0]));
  assert.ok(r.attempts.every(a => Number.isFinite(a.durationMs) && a.durationMs >= 0));
  assert.ok(!("decision" in r));
});

const boundedSignal = AbortSignal.timeout(5000);
const call = (reply: unknown, backend: TaskBackend = "laya", env: NodeJS.ProcessEnv = fakeEnv) =>
  requestTaskChoice(fixtureConfig(), "Prove the invariants", backend, env, boundedSignal, async () => reply);

test("rejects answer envelopes that are not choice replies", async () => {
  await assert.rejects(() => call(undefined), /no route/);
  await assert.rejects(() => call(null), /no route/);
  await assert.rejects(() => call([]), /no route/);
  await assert.rejects(() => call("fast"), /no route/);
  await assert.rejects(() => call({}), /no route/);
  await assert.rejects(() => call({ answers: null }), /no route/);
  await assert.rejects(() => call({ answers: [] }), /no route/);
  await assert.rejects(() => call({ answers: "fast" }), /no route/);
  await assert.rejects(() => call({ answers: {} }), /no route/);
  await assert.rejects(() => call({ answers: { route: "fast" } }), /no route/);
  await assert.rejects(() => call({ answers: { route: null } }), /no route/);
  await assert.rejects(() => call({ answers: { route: ["fast"] } }), /no route/);
});

test("rejects invalid or inherited choices at the route level", async () => {
  await assert.rejects(() => call({ answers: { route: {} } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: { choice: "fast" } } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: { type: "direct", choice: "fast" } } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: { type: "choice" } } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: { type: "choice", choice: 7 } } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: { type: "choice", choice: "gpt-6" } } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: { type: "choice", choice: "direct" } } }), /invalid choice/);
  await assert.rejects(() => call({ answers: { route: Object.create({ type: "choice", choice: "fast" }) } }), /invalid choice/);
  await assert.rejects(() => call({ answers: Object.create({ route: { type: "choice", choice: "fast" } }) }), /no route/);
});

test("accepts only own-property choice replies", async () => {
  for (const id of PROFILE_IDS) {
    assert.equal(await call(decisionReply(id)), id);
  }
});

test("the Laya request carries the task, model, six criteria and credentials", async () => {
  let seen: RequestSpec | undefined;
  await requestTaskChoice(fixtureConfig(), "Prove the coupled invariants", "laya", fakeEnv, boundedSignal,
    async spec => { seen = spec; return decisionReply("fast"); });
  assert.ok(seen);
  assert.equal(seen.backend, "laya");
  assert.equal(seen.url.href, "http://127.0.0.1:8765/v1/systemone");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(seen.headers.authorization, "Bearer TEST_LAYA_SENTINEL");
  const body = JSON.parse(String(seen.body));
  assert.equal(body.state, "Prove the coupled invariants");
  assert.equal(body.model, "typed-decisions");
  assert.equal(body.questions.route.type, "choice");
  assert.ok(typeof body.questions.route.instructions === "string" && body.questions.route.instructions.length > 0);
  assert.deepEqual(Object.keys(body.questions.route.criteria), [...PROFILE_IDS]);
  for (const id of PROFILE_IDS) assert.equal(typeof body.questions.route.criteria[id], "string");
});

test("the Jev request targets the fixed hosted origin with its own model", async () => {
  let seen: RequestSpec | undefined;
  await requestTaskChoice(fixtureConfig(), "Prove the coupled invariants", "jev", fakeEnv, boundedSignal,
    async spec => { seen = spec; return decisionReply("deep"); });
  assert.ok(seen);
  assert.equal(seen.backend, "jev");
  assert.equal(seen.url.href, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.headers.authorization, "Bearer TEST_JEV_SENTINEL");
  assert.equal(JSON.parse(String(seen.body)).model, "jev-latest");
});

test("an optional Laya credential is omitted when absent", async () => {
  let seen: RequestSpec | undefined;
  await requestTaskChoice(fixtureConfig(), "Prove the invariants", "laya", {}, boundedSignal,
    async spec => { seen = spec; return decisionReply(); });
  assert.ok(seen);
  assert.equal("authorization" in seen.headers, false);
});

test("hosted Jev requires a nonblank key", async () => {
  await assert.rejects(() => call(decisionReply(), "jev", {}), /TYPESAFE_API_KEY/);
  await assert.rejects(() => call(decisionReply(), "jev", { TYPESAFE_API_KEY: "  " }), /TYPESAFE_API_KEY/);
});
