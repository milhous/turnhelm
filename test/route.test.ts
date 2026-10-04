import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { classifyTask, resolvePhaseARoute } from "../src/route.js";

const config = parseConfig({
  backend: "laya",
  profileMode: "explicit",
  layaUrl: "http://127.0.0.1:8765",
  fallbackProfile: "deep",
  profiles: { deep: { description: "Complex work", model: "gpt-6-sol", effort: "high" } }
});

test("auto profiles are stable and use a null-prototype map", () => {
  const auto = parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: {}
  }, {
    defaultModel: "gpt-6.1-sol",
    cached: { "gpt-6-luna": { visible: true, supportedInApi: true, efforts: ["low"] } }
  });
  assert.deepEqual(Object.keys(auto.profiles), ["fast", "balanced", "deep"]);
  assert.equal(Object.getPrototypeOf(auto.profiles), null);
  assert.equal(Object.hasOwn(auto.profiles, "frontier"), false);
});

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

const withFetch = async (implementation: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { await run(); } finally { globalThis.fetch = original; }
};

for (const backend of ["laya", "jev", "auto"] as const) {
  for (const [name, prompt, source] of [
    ["Chinese continuation", "继续。", "continuation"],
    ["English continuation", "continue!", "continuation"],
    ["2001 units", "x".repeat(2001), "fallback"],
    ["2001 Unicode units", "😀".repeat(1000) + "x", "fallback"],
    ["overlong continuation", "continue" + "!".repeat(1993), "fallback"]
  ] as const) {
    test(`${backend} routes ${name} locally with hosted Jev enabled`, async () => {
      process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
      const enabled = parseConfig({ ...config, backend, hostedJev: { enabled: true } });
      let calls = 0;
      await withFetch(async () => { calls++; return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "direct" } } })); }, async () => {
        assert.deepEqual(await resolvePhaseARoute(prompt, enabled), { kind: "profile", source, profileId: "deep", profile: enabled.profiles.deep });
        await assert.rejects(() => resolvePhaseARoute(prompt, { ...enabled, fallbackProfile: undefined }), /fallbackProfile is required for this Phase A input/);
      });
      assert.equal(calls, 0);
    });
  }

  for (const [name, prompt] of [["empty", ""], ["whitespace", " \n\t　"], ["non-string", null]] as const) {
    test(`${backend} rejects ${name} without fetching or using fallback`, async () => {
      process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
      const enabled = parseConfig({ ...config, backend, hostedJev: { enabled: true } });
      let calls = 0;
      await withFetch(async () => { calls++; return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "direct" } } })); }, async () => {
        await assert.rejects(() => resolvePhaseARoute(prompt as string, enabled), /task must not be empty/);
        await assert.rejects(() => resolvePhaseARoute(prompt as string, { ...enabled, fallbackProfile: undefined }), /task must not be empty/);
      });
      assert.equal(calls, 0);
    });
  }
}

for (const prompt of ["x".repeat(2000), "界".repeat(2000), "😀".repeat(1000), "Continue implementing the parser."]) {
  test(`eligible task uses classifier unchanged (${prompt.codePointAt(0)})`, async () => {
    let calls = 0;
    await withFetch(async (_input, options) => {
      calls++;
      assert.equal(JSON.parse(String(options?.body)).state, prompt);
      return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "direct" } } }));
    }, async () => {
      assert.deepEqual(await classifyTask(prompt, config), { kind: "direct" });
      assert.deepEqual(await resolvePhaseARoute(prompt, config), { kind: "direct", source: "classifier" });
    });
    assert.equal(calls, 2);
  });
}

test("classifier profile success keeps configured profile", async () => {
  await withFetch(async () => new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "deep" } } })), async () => {
    assert.deepEqual(await resolvePhaseARoute("Investigate this issue.", config), { kind: "profile", source: "classifier", profileId: "deep", profile: config.profiles.deep });
  });
});

test("classifier failure uses configured fallback", async () => {
  await withFetch(async () => new Response("unavailable", { status: 503 }), async () => {
    const auto = parseConfig({ ...config, backend: "auto", hostedJev: { enabled: false } });
    const result = await resolvePhaseARoute("Investigate this issue.", auto);
    assert.equal(result.source, "fallback");
    assert.equal(result.kind, "profile");
    assert.equal(result.profileId, "deep");
    await assert.rejects(() => resolvePhaseARoute("Investigate this issue.", parseConfig({ ...auto, fallbackProfile: undefined })), /routing unavailable and no fallbackProfile is configured/);
  });
});
