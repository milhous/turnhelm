import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectConfig } from "../src/config.js";
import { fixtureConfig } from "./fixtures.js";

const editable = () => JSON.parse(JSON.stringify(fixtureConfig()));

test("six fixed profiles include ungated Astra high/xhigh/max", () => {
  const c = fixtureConfig();
  assert.deepEqual(Object.keys(c.profiles), ["fast", "balanced", "deep", "frontier", "frontier_xhigh", "frontier_max"]);
  assert.equal(c.profiles.frontier.effort, "high");
  assert.equal(c.profiles.frontier_xhigh.effort, "xhigh");
  assert.equal(c.profiles.frontier_max.effort, "max");
  assert.ok(Object.isFrozen(c.profiles.frontier_max));
});

test("reject legacy format, unknown max setting and missing profile", () => {
  assert.throws(() => parseProjectConfig({ backend: "laya", profiles: {} }));
  const c = JSON.parse(JSON.stringify(fixtureConfig()));
  assert.throws(() => parseProjectConfig({ ...c, allowMax: false }));
  delete c.profiles.frontier_max;
  assert.throws(() => parseProjectConfig(c));
});

test("freezes the snapshot and every nested value", () => {
  const c = fixtureConfig();
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.backends));
  assert.ok(Object.isFrozen(c.backends.laya));
  assert.ok(Object.isFrozen(c.backends.jev));
  assert.ok(Object.isFrozen(c.profiles));
  for (const profile of Object.values(c.profiles)) assert.ok(Object.isFrozen(profile));
});

test("rejects unknown fields at every schema level", () => {
  assert.throws(() => parseProjectConfig({ ...editable(), extra: true }));
  const backends = editable();
  (backends.backends as Record<string, unknown>).codex = { enabled: false };
  assert.throws(() => parseProjectConfig(backends));
  const laya = editable();
  (laya.backends.laya as Record<string, unknown>).apiKey = "x";
  assert.throws(() => parseProjectConfig(laya));
  const jev = editable();
  (jev.backends.jev as Record<string, unknown>).url = "http://127.0.0.1:1";
  assert.throws(() => parseProjectConfig(jev));
  const profile = editable();
  (profile.profiles.fast as Record<string, unknown>).description = "x";
  assert.throws(() => parseProjectConfig(profile));
});

test("rejects every legacy root field as unknown configuration", () => {
  for (const key of ["backend", "layaUrl", "profileMode", "fallbackProfile", "hostedJev", "allowMax", "codex"]) {
    assert.throws(() => parseProjectConfig({ ...editable(), [key]: true }));
  }
});

test("requires required fields to be own properties at every level", () => {
  const c = editable();
  assert.throws(() => parseProjectConfig(Object.create(c)));
  const laya = editable();
  laya.backends.laya = Object.create(laya.backends.laya);
  assert.throws(() => parseProjectConfig(laya));
  const jev = editable();
  jev.backends.jev = Object.create(jev.backends.jev);
  assert.throws(() => parseProjectConfig(jev));
  const profile = editable();
  profile.profiles.fast = Object.create(profile.profiles.fast);
  assert.throws(() => parseProjectConfig(profile));
  const inherited = Object.assign(Object.create({ version: 1 }), {
    routingTimeoutMs: c.routingTimeoutMs, backends: c.backends, profiles: c.profiles
  });
  assert.throws(() => parseProjectConfig(inherited));
});

test("requires version 1 and a bounded integer timeout", () => {
  const c = editable();
  assert.throws(() => parseProjectConfig({ ...c, version: 2 }));
  assert.throws(() => parseProjectConfig({ ...c, version: "1" }));
  const noVersion = editable();
  delete (noVersion as Record<string, unknown>).version;
  assert.throws(() => parseProjectConfig(noVersion));
  assert.throws(() => parseProjectConfig({ ...c, routingTimeoutMs: "4000" }));
  assert.throws(() => parseProjectConfig({ ...c, routingTimeoutMs: 99.5 }));
  const noTimeout = editable();
  delete (noTimeout as Record<string, unknown>).routingTimeoutMs;
  assert.throws(() => parseProjectConfig(noTimeout));
});

test("accepts timeout endpoints 100 and 30000 and rejects values outside them", () => {
  const c = editable();
  assert.equal(parseProjectConfig({ ...c, routingTimeoutMs: 100 }).routingTimeoutMs, 100);
  assert.equal(parseProjectConfig({ ...c, routingTimeoutMs: 30000 }).routingTimeoutMs, 30000);
  assert.throws(() => parseProjectConfig({ ...c, routingTimeoutMs: 99 }));
  assert.throws(() => parseProjectConfig({ ...c, routingTimeoutMs: 30001 }));
});

test("requires exactly the six own profile IDs in any key order", () => {
  const c = editable();
  const reordered = editable();
  const { fast, balanced, deep, frontier, frontier_xhigh, frontier_max } = reordered.profiles;
  reordered.profiles = { frontier_max, frontier_xhigh, frontier, deep, balanced, fast };
  assert.deepEqual(Object.keys(parseProjectConfig(reordered).profiles), Object.keys(c.profiles));
  const extra = editable();
  (extra.profiles as Record<string, unknown>).direct = extra.profiles.fast;
  assert.throws(() => parseProjectConfig(extra));
  const swapped = editable();
  delete (swapped.profiles as Record<string, unknown>).fast;
  (swapped.profiles as Record<string, unknown>).direct = swapped.profiles.balanced;
  assert.throws(() => parseProjectConfig(swapped));
  assert.throws(() => parseProjectConfig({ ...c, profiles: {} }));
});

test("bounds model and effort identifiers", () => {
  const c = editable();
  const profiles = {
    ...c.profiles,
    fast: { model: "x".repeat(200), effort: "max" }
  };
  assert.equal(parseProjectConfig({ ...c, profiles }).profiles.fast.model, "x".repeat(200));
  const long = { ...c.profiles, fast: { model: "x".repeat(201), effort: "low" } };
  assert.throws(() => parseProjectConfig({ ...c, profiles: long }));
  const spaced = { ...c.profiles, fast: { model: "gpt 6", effort: "low" } };
  assert.throws(() => parseProjectConfig({ ...c, profiles: spaced }));
  const empty = { ...c.profiles, fast: { model: "", effort: "low" } };
  assert.throws(() => parseProjectConfig({ ...c, profiles: empty }));
  const shouting = { ...c.profiles, fast: { model: "gpt-6-luna", effort: "MAX" } };
  assert.throws(() => parseProjectConfig({ ...c, profiles: shouting }));
  const invented = { ...c.profiles, fast: { model: "gpt-6-luna", effort: "critical" } };
  assert.throws(() => parseProjectConfig({ ...c, profiles: invented }));
});

test("accepts loopback origins only, without credentials, path, query or fragment", () => {
  const c = editable();
  const withLaya = (url: string) => parseProjectConfig({
    ...c, backends: { ...c.backends, laya: { enabled: true, url } }
  });
  assert.equal(withLaya("http://127.0.0.1:8765").backends.laya.url, "http://127.0.0.1:8765");
  assert.equal(withLaya("http://[::1]:8765").backends.laya.url, "http://[::1]:8765");
  for (const url of [
    "http://user:pass@127.0.0.1:8765",
    "http://127.0.0.1:8765/v1",
    "http://127.0.0.1:8765/?x=1",
    "http://127.0.0.1:8765#f",
    "https://127.0.0.1:8765",
    "http://example.com:8765",
    "http://0.0.0.0:8765",
    "not a url"
  ]) {
    assert.throws(() => withLaya(url), /laya url/);
  }
});

test("requires typed backend settings", () => {
  const c = editable();
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, jev: {} } }));
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, jev: { enabled: "no" } } }));
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, laya: { enabled: true } } }));
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, laya: { enabled: 1, url: "http://127.0.0.1:8765" } } }));
});
