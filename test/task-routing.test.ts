import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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

test("the shipped sole-Laya budget admits a 5.5s CPU inference response", async () => {
  let calls = 0;
  const r = await routeTask("Review the coupled documentation and routing constraints", fixtureConfig(), {
    env: {}, request: async spec => {
      calls++;
      assert.equal(spec.backend, "laya");
      await delay(5500, undefined, { signal: spec.signal });
      return decisionReply("frontier");
    }
  });
  assert.equal(calls, 1);
  assert.ok(r.status === "selected");
  assert.equal(r.decision.profileId, "frontier");
  assert.equal(r.decision.attempts[0].outcome, "success");
});

test("reported Laya truncation fails closed instead of selecting a profile", async () => {
  for (const usage of [
    { input_tokens: 1024, output_tokens: 0, state_tokens: 1543, state_tokens_dropped: 668, truncated: true, truncated_questions: ["route"] },
    { input_tokens: 1692, output_tokens: 0, state_tokens: 1543, state_tokens_dropped: 0, truncated: true, truncated_questions: ["route"] },
    { input_tokens: 1024, output_tokens: 0, state_tokens: 1543, state_tokens_dropped: 668, truncated: false, truncated_questions: ["route"] }
  ]) {
    let calls = 0;
    const r = await routeTask("Review the full documentation requirement", fixtureConfig(), {
      env: {}, request: async () => {
        calls++;
        return { answers: { route: { type: "choice", choice: "frontier" } }, usage };
      }
    });
    assert.equal(calls, 1);
    assert.ok(r.status === "failed");
    assert.equal(r.attempts[0].outcome, "failed");
    assert.ok(!("decision" in r));
  }
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

// A stalled fake owns a finite REFERENCED guard while it waits on the supplied
// signal: the routing deadline is an unref'd AbortSignal.timeout, so Node
// 22.8's test runner drains the event loop and cancels a test whose pending
// promise holds no loop reference. The guard is cleared and the listener
// removed when the signal settles the request; if the routing deadline never
// settles, the guard rejects and the test fails on its real timing/outcome
// assertions. It never synthesizes a reply or an abort.
const STALLED_GUARD_MS = 5000;
const stalledRequest = (spec: RequestSpec, guardMs: number = STALLED_GUARD_MS): Promise<void> =>
  new Promise((_, reject) => {
    const onAbort = (): void => reject(new Error("stalled request observed its supplied signal"));
    const guard = setTimeout(() => {
      spec.signal.removeEventListener("abort", settle);
      reject(new Error("TEST_GUARD: stalled request outlived its guard; the routing deadline never settled"));
    }, guardMs);
    const settle = (): void => { clearTimeout(guard); onAbort(); };
    if (spec.signal.aborted) { clearTimeout(guard); onAbort(); return; }
    spec.signal.addEventListener("abort", settle, { once: true });
  });

test("a Laya timeout leaves Jev only the remaining total budget", async () => {
  const base = fixtureConfig();
  const c = parseProjectConfig({ ...base, routingTimeoutMs: 400, backends: { ...base.backends, jev: { enabled: true } } });
  const delays: number[] = [];
  const stalled = async (spec: RequestSpec) => {
    const began = performance.now();
    try {
      await stalledRequest(spec);
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
    await stalledRequest(spec);
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

test("stalledRequest leaves zero abort listeners on every settlement path", async () => {
  const spec = (signal: AbortSignal): RequestSpec => ({
    backend: "laya",
    url: new URL("http://127.0.0.1:8765/v1/systemone"),
    body: "{}",
    headers: {},
    signal
  });
  // Guard-fired settlement, forced through a 10 ms guard instead of the real 5 s.
  const guarded = new AbortController();
  await assert.rejects(
    () => stalledRequest(spec(guarded.signal), 10),
    /TEST_GUARD: stalled request outlived its guard/
  );
  assert.equal(getEventListeners(guarded.signal, "abort").length, 0, "guard path must detach its abort listener");
  // Supplied-signal settlement; the 10 s guard never fires, so this test
  // completing also demonstrates the guard timer was cleared.
  const aborted = new AbortController();
  const settled = assert.rejects(
    () => stalledRequest(spec(aborted.signal), 10_000),
    /stalled request observed its supplied signal/
  );
  aborted.abort();
  await settled;
  assert.equal(getEventListeners(aborted.signal, "abort").length, 0, "abort path must leave no abort listener");
});

test("a reply landing after caller cancellation is cancelled, never selected", async () => {
  const ac = new AbortController();
  const c = jevEnabled();
  const calls: string[] = [];
  const r = await routeTask("Fix cache invalidation", c, {
    env: fakeEnv, signal: ac.signal,
    request: async s => { calls.push(s.backend); ac.abort(); return decisionReply("fast"); }
  });
  assert.ok(r.status === "cancelled");
  assert.deepEqual(calls, ["laya"]);
  assert.equal(r.attempts[0].outcome, "cancelled");
  assert.ok(!("decision" in r));
});

test("a reply landing past its deadlines is timeout evidence, never selected or failed over", async () => {
  const c = jevEnabled();
  const parsed = parseProjectConfig({ ...JSON.parse(JSON.stringify(c)), routingTimeoutMs: 100 });
  const calls: string[] = [];
  const busy = async (spec: RequestSpec) => {
    calls.push(spec.backend);
    const until = performance.now() + 150;
    while (performance.now() < until) { /* block the loop so deadline timers cannot fire */ }
    return decisionReply("fast");
  };
  const r = await routeTask("Prove the invariants", parsed, { env: fakeEnv, request: busy });
  assert.ok(r.status === "failed");
  assert.deepEqual(calls, ["laya"]);
  assert.equal(r.attempts[0].outcome, "timeout");
  assert.ok(!("decision" in r));
});

const EXPECTED_CRITERIA = {
  fast: "Small localized work with clear requirements and acceptance checks.",
  balanced: "Routine implementation and debugging with bounded scope.",
  deep: "Difficult but bounded debugging, review, and multistep reasoning.",
  frontier: "Very difficult work with ambiguity and interacting cross-system constraints.",
  frontier_xhigh: "Demanding reasoning requiring detailed argument and verification across several constraints.",
  frontier_max: "Exceptional problems requiring the greatest single-worker reasoning depth."
};
const EXPECTED_INSTRUCTIONS = "Choose the lightest profile that meets the task's requirements, judged by uncertainty, coupled constraints, required verification, and the consequences of an incorrect result; never by prompt length, file count, or keywords such as security, architecture, or deep analysis.";

test("a late throwing failure past its budget is timeout evidence", async () => {
  const c = parseProjectConfig({ ...JSON.parse(JSON.stringify(fixtureConfig())), routingTimeoutMs: 100 });
  const r = await routeTask("Prove the invariants", c, {
    env: fakeEnv,
    request: async () => {
      const until = performance.now() + 150;
      while (performance.now() < until) { /* block so deadline timers cannot fire */ }
      throw new Error("TEST_PRIVATE_SENTINEL");
    }
  });
  assert.ok(r.status === "failed");
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].outcome, "timeout");
  assert.ok(!("decision" in r));
});

test("a late invalid choice past its budget is timeout evidence", async () => {
  const c = parseProjectConfig({ ...JSON.parse(JSON.stringify(fixtureConfig())), routingTimeoutMs: 100 });
  const r = await routeTask("Prove the invariants", c, {
    env: fakeEnv,
    request: async () => {
      const until = performance.now() + 150;
      while (performance.now() < until) { /* block so deadline timers cannot fire */ }
      return {};
    }
  });
  assert.ok(r.status === "failed");
  assert.equal(r.attempts[0].outcome, "timeout");
});

test("an elapsed-budget Laya failure keeps its share and still fails over", async () => {
  const base = fixtureConfig();
  const c = parseProjectConfig({ ...base, routingTimeoutMs: 400, backends: { ...base.backends, jev: { enabled: true } } });
  const calls: string[] = [];
  const r = await routeTask("Prove the invariants", c, {
    env: fakeEnv,
    request: async s => {
      calls.push(s.backend);
      if (s.backend === "laya") {
        const until = performance.now() + 150;
        while (performance.now() < until) { /* block past the min(1000, total/4) share */ }
        throw new Error("TEST_PRIVATE_SENTINEL");
      }
      return decisionReply("deep");
    }
  });
  assert.ok(r.status === "selected");
  assert.deepEqual(calls, ["laya", "jev"]);
  assert.deepEqual(r.decision.attempts.map(a => a.outcome), ["timeout", "success"]);
});

test("caller cancellation outranks a late failure", async () => {
  const ac = new AbortController();
  const r = await routeTask("Prove the invariants", fixtureConfig(), {
    env: fakeEnv, signal: ac.signal,
    request: async () => {
      ac.abort();
      const until = performance.now() + 150;
      while (performance.now() < until) { /* block so deadline timers cannot fire */ }
      throw new Error("TEST_PRIVATE_SENTINEL");
    }
  });
  assert.ok(r.status === "cancelled");
  assert.equal(r.attempts[0].outcome, "cancelled");
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
    assert.equal((await call(decisionReply(id))).profileId, id);
  }
});

test("declared Laya truncation metadata must contain its own valid flags", async () => {
  for (const usage of [
    null, [], {}, { truncated: false }, { state_tokens_dropped: 0 },
    { truncated: "false", state_tokens_dropped: 0 },
    { truncated: false, state_tokens_dropped: "0" },
    Object.create({ truncated: false, state_tokens_dropped: 0 })
  ]) {
    await assert.rejects(() => call({ answers: { route: { type: "choice", choice: "frontier" } }, usage }));
  }
});

test("a complete Laya usage report allows the full-task choice", async () => {
  assert.equal((await call({
    answers: { route: { type: "choice", choice: "frontier" } },
    usage: { input_tokens: 1692, output_tokens: 0, state_tokens: 1543, state_tokens_dropped: 0, truncated: false, truncated_questions: [] }
  })).profileId, "frontier");
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
  assert.equal(body.max_len, 8192);
  assert.equal(body.questions.route.type, "choice");
  assert.equal(body.questions.route.instructions, EXPECTED_INSTRUCTIONS);
  assert.deepEqual(Object.keys(body.questions.route.criteria), [...PROFILE_IDS]);
  assert.deepEqual(body.questions.route.criteria, EXPECTED_CRITERIA);
});

test("the Jev request targets the fixed hosted origin with its own model", async () => {
  let seen: RequestSpec | undefined;
  await requestTaskChoice(fixtureConfig(), "Prove the coupled invariants", "jev", fakeEnv, boundedSignal,
    async spec => { seen = spec; return decisionReply("deep"); });
  assert.ok(seen);
  assert.equal(seen.backend, "jev");
  assert.equal(seen.url.href, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.headers.authorization, "Bearer TEST_JEV_SENTINEL");
  const body = JSON.parse(String(seen.body));
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body), ["state", "model", "questions"]);
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
