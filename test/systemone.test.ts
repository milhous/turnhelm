import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { classifyTask } from "../src/route.js";
import * as systemOne from "../src/systemone.js";
import { chooseProfile } from "../src/systemone.js";

const base = {
  backend: "laya",
  layaUrl: "http://127.0.0.1:8765",
  fallbackProfile: "deep",
  hostedJev: { enabled: false },
  profiles: {
    fast: { description: "Small edits", model: "gpt-6-luna", effort: "low" },
    deep: { description: "Complex work", model: "gpt-6-sol", effort: "high" }
  }
} as const;

const environmentKeys = ["TYPESAFE_API_KEY", "LAYA_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV"] as const;
let previousEnvironment: (string | undefined)[];
beforeEach(() => {
  previousEnvironment = environmentKeys.map(key => process.env[key]);
  process.env.TYPESAFE_API_KEY = "test-typesafe-key";
  process.env.LAYA_API_KEY = "test-laya-key";
  delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
});
afterEach(() => {
  environmentKeys.forEach((key, index) => {
    const previous = previousEnvironment[index];
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  });
});

const decisionResponse = (choice = "direct") =>
  new Response(JSON.stringify({ answers: { route: { type: "choice", choice } } }));

const withFetch = async (implementation: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { await run(); } finally { globalThis.fetch = original; }
};

test("raw System One request builder is not exported", () => {
  assert.equal(Object.hasOwn(systemOne, "buildSystemOneRequest"), false);
});

const rejectedTasks: { name: string; prompt: unknown; error: RegExp }[] = [
  { name: "empty", prompt: "", error: /task must not be empty/ },
  { name: "whitespace", prompt: " \n\t　", error: /task must not be empty/ },
  { name: "2001 units", prompt: "x".repeat(2001), error: /task is not eligible for classification/ },
  { name: "non-string number", prompt: 42, error: /task must not be empty/ },
  { name: "non-string null", prompt: null, error: /task must not be empty/ },
  { name: "non-string undefined", prompt: undefined, error: /task must not be empty/ },
  { name: "Chinese continuation", prompt: "继续。", error: /task is not eligible for classification/ },
  { name: "Chinese alternate continuation", prompt: "接着做！", error: /task is not eligible for classification/ },
  { name: "Chinese plan continuation", prompt: "按刚才的方案继续", error: /task is not eligible for classification/ },
  { name: "English continuation", prompt: "continue!", error: /task is not eligible for classification/ },
  { name: "English alternate continuation", prompt: " GO ON. ", error: /task is not eligible for classification/ },
  { name: "English proceed continuation", prompt: "proceed", error: /task is not eligible for classification/ },
  { name: "overlong continuation", prompt: "continue" + "!".repeat(1993), error: /task is not eligible for classification/ },
  { name: "2001 Unicode units", prompt: "😀".repeat(1000) + "x", error: /task is not eligible for classification/ }
];

for (const backend of ["laya", "jev", "auto"] as const) {
  for (const entry of ["chooseProfile", "classifyTask"] as const) {
    for (const { name, prompt, error } of rejectedTasks) {
      test(`${entry} rejects ${name} before ${backend} fetch or fallback`, async () => {
        process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
        const config = parseConfig({ ...base, backend, hostedJev: { enabled: true } });
        let calls = 0;
        await withFetch(async () => { calls++; return decisionResponse(); }, async () => {
          await assert.rejects(() => entry === "chooseProfile"
            ? chooseProfile(config, prompt as string)
            : classifyTask(prompt as string, config), error);
        });
        assert.equal(calls, 0);
      });
    }
  }

  test(`${backend} preserves the serialized request and fails closed on redirects`, async () => {
    process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
    const config = parseConfig({ ...base, backend, hostedJev: { enabled: true } });
    const prompt = "  Rename the README heading only.\n保留原文 😀  ";
    let calls = 0;
    await withFetch(async (input, options) => {
      calls++;
      assert.equal(String(input), backend === "jev"
        ? "https://api.typesafe.ai/v1/systemone" : "http://127.0.0.1:8765/v1/systemone");
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "error");
      assert.deepEqual(options?.headers, {
        "content-type": "application/json",
        authorization: "Bearer " + (backend === "jev" ? "test-typesafe-key" : "test-laya-key")
      });
      assert.ok(options?.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(String(options?.body)), {
        state: prompt,
        model: backend === "jev" ? "jev-latest" : "typed-decisions",
        questions: { route: {
          type: "choice",
          instructions: "Choose the best route for this coding assistant request.",
          criteria: { direct: "No coding, debugging, review, or file-change work", fast: "Small edits", deep: "Complex work" }
        } }
      });
      return decisionResponse();
    }, async () => { assert.equal(await chooseProfile(config, prompt), "direct"); });
    assert.equal(calls, 1);
  });

  for (const prompt of ["x".repeat(2000), "界".repeat(2000), "😀".repeat(1000)]) {
    test(`${backend} classifies exactly 2000 UTF-16 units (${prompt.codePointAt(0)})`, async () => {
      process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
      const config = parseConfig({ ...base, backend, hostedJev: { enabled: true } });
      let calls = 0;
      await withFetch(async (_input, options) => {
        calls++;
        assert.equal(JSON.parse(String(options?.body)).state, prompt);
        return decisionResponse("fast");
      }, async () => {
        assert.equal(await chooseProfile(config, prompt), "fast");
        assert.deepEqual(await classifyTask(prompt, config), { kind: "profile", source: "classifier", profileId: "fast", profile: config.profiles.fast });
      });
      assert.equal(calls, 2);
    });
  }
}

test("auto uses successful Laya without calling Jev", async () => {
  const calls: string[] = [];
  await withFetch(async input => { calls.push(String(input)); return decisionResponse("fast"); }, async () => {
    assert.equal(await chooseProfile(parseConfig({ ...base, backend: "auto" }), "Rename one file."), "fast");
  });
  assert.equal(calls.length, 1); assert.match(calls[0], /127\.0\.0\.1/);
});

test("auto falls back to opted-in Jev after one Laya failure", async () => {
  const calls: string[] = [];
  process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
  await withFetch(async (input, options) => {
    calls.push(String(input));
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, calls.length === 1 ? "typed-decisions" : "jev-latest");
    assert.equal(body.state, "Investigate the race.");
    return calls.length === 1 ? new Response("unavailable", { status: 503 }) : decisionResponse("deep");
  }, async () => {
    assert.equal(await chooseProfile(parseConfig({ ...base, backend: "auto", hostedJev: { enabled: true } }), "Investigate the race."), "deep");
  });
  assert.equal(calls.length, 2); assert.match(calls[1], /api\.typesafe\.ai/);
});

for (const enabled of [false, true]) {
  test(`auto does not call Jev without both opt-ins (config enabled: ${enabled})`, async () => {
    if (!enabled) process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
    let calls = 0;
    await withFetch(async () => { calls++; return new Response("unavailable", { status: 503 }); }, async () => {
      await assert.rejects(() => chooseProfile(parseConfig({ ...base, backend: "auto", hostedJev: { enabled } }), "Investigate the race."));
    });
    assert.equal(calls, 1);
  });

  test(`direct Jev requires both hosted opt-ins before fetch (config enabled: ${enabled})`, async () => {
    if (!enabled) process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
    let calls = 0;
    await withFetch(async () => { calls++; return decisionResponse("deep"); }, async () => {
      await assert.rejects(() => chooseProfile(parseConfig({ ...base, backend: "jev", hostedJev: { enabled } }), "Investigate the race."), /hosted Jev is not enabled/);
    });
    assert.equal(calls, 0);
  });
}

test("auto rejects Jev fallback before fetch when its key is missing", async () => {
  const calls: string[] = [];
  process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
  delete process.env.TYPESAFE_API_KEY;
  await withFetch(async input => { calls.push(String(input)); return new Response("unavailable", { status: 503 }); }, async () => {
    await assert.rejects(() => chooseProfile(parseConfig({ ...base, backend: "auto", hostedJev: { enabled: true } }), "Investigate the race."));
  });
  assert.equal(calls.length, 1);
});

test("direct Jev rejects a missing key before fetch", async () => {
  process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
  delete process.env.TYPESAFE_API_KEY;
  let calls = 0;
  await withFetch(async () => { calls++; return decisionResponse(); }, async () => {
    await assert.rejects(() => chooseProfile(parseConfig({ ...base, backend: "jev", hostedJev: { enabled: true } }), "Investigate the race."), /TYPESAFE_API_KEY is required/);
  });
  assert.equal(calls, 0);
});

for (const [name, payload] of [
  ["unknown profile", { answers: { route: { type: "choice", choice: "missing" } } }],
  ["inherited profile", { answers: { route: { type: "choice", choice: "toString" } } }],
  ["missing route", {}],
  ["non-object response", null],
  ["array answers", { answers: [] }],
  ["invalid choice type", { answers: { route: { type: "text", choice: "fast" } } }],
  ["non-string choice", { answers: { route: { type: "choice", choice: 42 } } }]
] as const) {
  test(`classifier rejects ${name}`, async () => {
    let calls = 0;
    await withFetch(async () => { calls++; return new Response(JSON.stringify(payload)); }, async () => {
      await assert.rejects(() => classifyTask("Review the implementation.", parseConfig(base)));
    });
    assert.equal(calls, 1);
  });
}

test("classifier rejects malformed JSON", async () => {
  await withFetch(async () => new Response("not json"), async () => {
    await assert.rejects(() => classifyTask("Review the implementation.", parseConfig(base)));
  });
});
