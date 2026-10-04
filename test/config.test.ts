import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

const base = {
  backend: "laya",
  profileMode: "explicit",
  hostedJev: { enabled: false },
  layaUrl: "http://127.0.0.1:8765",
  fallbackProfile: "deep",
  profiles: {
    fast: { description: "Small localized edits", model: "gpt-6-luna", effort: "low" },
    deep: { description: "Complex debugging and review", model: "gpt-6-sol", effort: "high" }
  }
};

test("accepts a loopback backend and four-or-fewer profiles", () => {
  assert.equal(parseConfig(base).profiles.deep.effort, "high");
});

test("rejects public Laya URLs", () => {
  assert.throws(() => parseConfig({ ...base, layaUrl: "http://0.0.0.0:8765" }), /loopback/);
});

test("rejects an unknown fallback", () => {
  assert.throws(() => parseConfig({ ...base, fallbackProfile: "missing" }), /fallbackProfile/);
});

test("rejects unsafe profile IDs and long descriptions", () => {
  assert.throws(() => parseConfig({ ...base, profiles: { "bad-id": base.profiles.deep } }), /profile ID/);
  assert.throws(() => parseConfig({ ...base, profiles: { x: { ...base.profiles.deep, description: "x".repeat(81) } } }), /description/);
});


test("accepts auto mode with hosted Jev disabled", () => {
  const config = parseConfig({ ...base, backend: "auto" });
  assert.equal(config.backend, "auto");
  assert.equal(config.hostedJev.enabled, false);
});

test("defaults hosted Jev to disabled", () => {
  const { hostedJev, ...withoutHosted } = base;
  const config = parseConfig(withoutHosted);
  assert.equal(config.hostedJev.enabled, false);
});

test("rejects malformed hostedJev", () => {
  assert.throws(() => parseConfig({ ...base, hostedJev: { enabled: "yes" } }), /hostedJev/);
});

test("auto mode emits only available stable roles", () => {
  const config = parseConfig({
    backend: "auto",
    profileMode: "auto",
    layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false },
    profiles: {},
    fallbackProfile: undefined
  }, {
    defaultModel: "gpt-6.1-sol",
    cached: {
      "gpt-6-luna": { visible: true, supportedInApi: true, efforts: ["low", "medium", "high", "xhigh", "max"] }
    }
  });
  assert.deepEqual(Object.keys(config.profiles), ["fast", "balanced", "deep"]);
  assert.equal(config.profiles.fast.model, "gpt-6-luna");
  assert.equal(config.profiles.deep.effort, "high");
  assert.equal(config.fallbackProfile, "balanced");
  assert.equal(config.profiles.fast.description, "Small localized edits");
  assert.equal(config.profiles.balanced.description, "Balanced implementation and routine debugging");
  assert.equal(config.profiles.deep.description, "Complex debugging and review");
});

test("auto mode ignores hidden cached models", () => {
  const config = parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: {}
  }, {
    defaultModel: "gpt-6.1-sol",
    cached: { "gpt-6-luna": { visible: false, supportedInApi: true, efforts: ["low"] } }
  });
  assert.deepEqual(Object.keys(config.profiles), ["balanced", "deep"]);
});

test("auto mode rejects an override with an unsupported effort", () => {
  assert.throws(() => parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false },
    profiles: { frontier: { description: "x", model: "gpt-6-astra", effort: "none" } }
  }, { defaultModel: "gpt-6-astra", cached: {} }), /effort/);
});

test("auto mode rejects arbitrary profile IDs", () => {
  assert.throws(() => parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: { custom: { description: "x", model: "gpt-6-luna", effort: "low" } }
  }, { defaultModel: "gpt-6-luna", cached: {} }), /profile ID/);
});

test("auto mode has no silent role when no official model is available", () => {
  assert.throws(() => parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: {}
  }, { cached: {} }), /no available profiles/);
});

test("auto mode chooses balanced then fast as the fallback", () => {
  const balanced = parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: {}
  }, { defaultModel: "gpt-6.1-sol", cached: {} });
  assert.equal(balanced.fallbackProfile, "balanced");
  const fast = parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: {}
  }, { cached: { "gpt-6-luna": { visible: true, supportedInApi: true, efforts: ["low"] } } });
  assert.equal(fast.fallbackProfile, "fast");
});

test("explicit mode still accepts safe synthetic model fixtures", () => {
  const config = parseConfig({
    backend: "auto", profileMode: "explicit", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: { test: { description: "x", model: "provider-test", effort: "custom" } }
  }, { cached: {} });
  assert.equal(config.profiles.test.model, "provider-test");
});

test("auto mode accepts an available official override", () => {
  const config = parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: { deep: { description: "Custom", model: "gpt-6-astra", effort: "max" } }
  }, { defaultModel: "gpt-6-astra", cached: {} });
  assert.deepEqual(config.profiles.deep, { description: "Custom", model: "gpt-6-astra", effort: "max" });
});

test("auto mode rejects unavailable official override", () => {
  assert.throws(() => parseConfig({
    backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
    hostedJev: { enabled: false }, profiles: { fast: { description: "x", model: "gpt-6-luna", effort: "low" } }
  }, { cached: {} }), /not available/);
});

test("rejects invalid profile mode", () => {
  assert.throws(() => parseConfig({ ...base, profileMode: "guess" }), /profileMode/);
});

test("explicit mode validates fallback profile", () => {
  assert.throws(() => parseConfig({ ...base, fallbackProfile: "unknown" }), /fallbackProfile/);
});

test("auto mode rejects fallback unavailable by emission and invalid fallback identifiers", () => {
  const onlyFast = { cached: { "gpt-6-luna": { visible: true, supportedInApi: true, efforts: ["low"] } } };
  const auto = { backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765", hostedJev: { enabled: false }, profiles: {} };
  assert.throws(() => parseConfig({ ...auto, fallbackProfile: "deep" }, onlyFast), /fallbackProfile/);
  assert.throws(() => parseConfig({ ...auto, fallbackProfile: "bad id" }, onlyFast), /fallbackProfile/);
  assert.equal(parseConfig(auto, onlyFast).fallbackProfile, "fast");
});
