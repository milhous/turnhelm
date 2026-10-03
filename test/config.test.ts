import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

const base = {
  backend: "laya",
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
