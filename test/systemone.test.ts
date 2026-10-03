import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { buildSystemOneRequest, chooseProfile } from "../src/systemone.js";

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

const config = parseConfig(base);

const withFetch = async (implementation: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { await run(); } finally { globalThis.fetch = original; }
};

test("Laya uses the coding-task checkpoint", () => {
  const request = buildSystemOneRequest(config, "Rename the README heading only.");
  assert.equal(request.model, "typed-decisions");
});

test("Jev uses its hosted alias", () => {
  const request = buildSystemOneRequest({ ...config, backend: "jev" }, "Classify this task.");
  assert.equal(request.model, "jev-latest");
});

test("auto uses successful Laya without calling Jev", async () => {
  const calls: string[] = [];
  await withFetch(async input => { calls.push(String(input)); return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } } }), { status: 200 }); }, async () => {
    assert.equal(await chooseProfile(parseConfig({ ...base, backend: "auto" }), "Rename one file."), "fast");
  });
  assert.equal(calls.length, 1); assert.match(calls[0], /127\.0\.0\.1/);
});

test("auto falls back to opted-in Jev after one Laya failure", async () => {
  const calls: string[] = []; const previous = process.env.TURNHELM_ALLOW_HOSTED_JEV; process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
  try { await withFetch(async input => { calls.push(String(input)); if (calls.length === 1) return new Response("unavailable", { status: 503 }); return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "deep" } } }), { status: 200 }); }, async () => {
    assert.equal(await chooseProfile(parseConfig({ ...base, backend: "auto", hostedJev: { enabled: true } }), "Investigate the race."), "deep");
  }); } finally { if (previous === undefined) delete process.env.TURNHELM_ALLOW_HOSTED_JEV; else process.env.TURNHELM_ALLOW_HOSTED_JEV = previous; }
  assert.equal(calls.length, 2); assert.match(calls[1], /api\.typesafe\.ai/);
});

test("auto does not call Jev without both opt-ins", async () => {
  let calls = 0; const previous = process.env.TURNHELM_ALLOW_HOSTED_JEV; delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
  try { await withFetch(async () => { calls++; return new Response("unavailable", { status: 503 }); }, async () => { await assert.rejects(() => chooseProfile(parseConfig({ ...base, backend: "auto", hostedJev: { enabled: true } }), "Investigate the race.")); }); }
  finally { if (previous === undefined) delete process.env.TURNHELM_ALLOW_HOSTED_JEV; else process.env.TURNHELM_ALLOW_HOSTED_JEV = previous; }
  assert.equal(calls, 1);
});

test("direct Jev requires both hosted opt-ins before fetch", async () => {
  let calls = 0; const previous = process.env.TURNHELM_ALLOW_HOSTED_JEV; delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
  try { await withFetch(async () => { calls++; return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "deep" } } }), { status: 200 }); }, async () => { await assert.rejects(() => chooseProfile(parseConfig({ ...base, backend: "jev", hostedJev: { enabled: true } }), "Investigate the race.")); }); }
  finally { if (previous === undefined) delete process.env.TURNHELM_ALLOW_HOSTED_JEV; else process.env.TURNHELM_ALLOW_HOSTED_JEV = previous; }
  assert.equal(calls, 0);
});
