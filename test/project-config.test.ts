import test from "node:test";
import assert from "node:assert/strict";
import { parseJevTransport, parseProjectConfig } from "../src/config.js";
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
  const inherited = Object.assign(Object.create({ version: 2 }), {
    routingTimeoutMs: c.routingTimeoutMs, backends: c.backends, profiles: c.profiles
  });
  assert.throws(() => parseProjectConfig(inherited));
});

test("requires version 2 and a bounded integer timeout", () => {
  const c = editable();
  assert.equal(parseProjectConfig({ ...c, version: 2 }).version, 2);
  assert.throws(() => parseProjectConfig({ ...c, version: 1 }), /config version must be 2/);
  assert.throws(() => parseProjectConfig({ ...c, version: "2" }));
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
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, jev: { enabled: "no", transport: { mode: "direct" } } } }));
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, laya: { enabled: true } } }));
  assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, laya: { enabled: 1, url: "http://127.0.0.1:8765" } } }));
});

test("requires explicit v2 Jev transport", () => {
  const c = editable();
  // The shipped default: Jev disabled with an explicit direct transport.
  assert.deepEqual(parseProjectConfig(c).backends.jev,
    { enabled: false, transport: { mode: "direct" } });
  // The old Jev shape (no transport) is rejected whether enabled or disabled.
  for (const enabled of [true, false]) {
    assert.throws(() => parseProjectConfig({ ...c, backends: { ...c.backends, jev: { enabled } } }));
  }
  const withTransport = (transport: unknown) => parseProjectConfig({
    ...c, backends: { ...c.backends, jev: { enabled: true, transport } }
  });
  assert.throws(() => withTransport(undefined));
  assert.throws(() => withTransport(null));
  assert.throws(() => withTransport("direct"));
  assert.throws(() => withTransport({}));
  assert.throws(() => withTransport({ mode: null }));
  assert.throws(() => withTransport({ mode: "socks5" }));
  // Direct is exactly mode; proxy is exactly mode and proxyUrl.
  assert.throws(() => withTransport({ mode: "direct", proxyUrl: "http://127.0.0.1:7890" }));
  assert.throws(() => withTransport({ mode: "direct", extra: true }));
  assert.throws(() => withTransport({ mode: "http-connect" }));
  assert.throws(() => withTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:7890", extra: true }));
  // Required fields must be own properties, not inherited.
  assert.throws(() => withTransport(Object.create({ mode: "direct" })));
  assert.throws(() => withTransport(Object.assign(Object.create({ proxyUrl: "http://127.0.0.1:7890" }), { mode: "http-connect" })));
  // A bad transport on a disabled backend is equally rejected.
  assert.throws(() => parseProjectConfig({
    ...c, backends: { ...c.backends, jev: { enabled: false, transport: { mode: "http-connect" } } }
  }));
  // Successful parse results are frozen.
  const parsed = parseProjectConfig(c);
  assert.ok(Object.isFrozen(parsed.backends.jev));
  assert.ok(Object.isFrozen(parsed.backends.jev.transport));
  assert.ok(Object.isFrozen(parseJevTransport({ mode: "direct" })));
  assert.ok(Object.isFrozen(parseJevTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" })));
});

test("retains default proxy ports", () => {
  assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:80/" }),
    { mode: "http-connect", proxyUrl: "http://127.0.0.1:80" });
  assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://[::1]:7890/" }),
    { mode: "http-connect", proxyUrl: "http://[::1]:7890" });
  assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" }),
    { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" });
  assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:1" }),
    { mode: "http-connect", proxyUrl: "http://127.0.0.1:1" });
  assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:65535" }),
    { mode: "http-connect", proxyUrl: "http://127.0.0.1:65535" });
  assert.deepEqual(parseJevTransport({ mode: "direct" }), { mode: "direct" });
  // The explicit port, including the HTTP default :80, survives a full
  // project-config parse; only the optional trailing slash is canonicalized.
  const c = editable();
  const proxy = parseProjectConfig({
    ...c,
    backends: { ...c.backends, jev: { enabled: true, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1:80/" } } }
  });
  assert.deepEqual(proxy.backends.jev.transport, { mode: "http-connect", proxyUrl: "http://127.0.0.1:80" });
});

test("rejects malformed proxy policy without echoing input", () => {
  const bad = (proxyUrl: unknown) => assert.throws(
    () => parseJevTransport({ mode: "http-connect", proxyUrl }),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^jev transport/, "fixed wording, never a native URL error");
      assert.equal(error.message.includes(String(proxyUrl)), false, "the message must not echo the input");
      return true;
    });
  for (const url of [
    "http://localhost:7890", // DNS name
    "http://127.0.0.2:7890", // a loopback address other than 127.0.0.1
    "http://0.0.0.0:7890",
    "http://[::2]:7890",
    "http://[0:0:0:0:0:0:0:1]:7890", // an alias spelling of ::1
    "http://example.com:7890",
    "http://user:pass@127.0.0.1:7890", // credentials
    "http://@127.0.0.1:7890", // empty-user userinfo
    " http://127.0.0.1:7890", // whitespace
    "http://127.0.0.1:7890 ",
    "http://127%2E0%2E0%2E1:7890", // percent encoding
    "http://127.0.0.1:7890/?x=1", // query
    "http://127.0.0.1:7890/proxy", // path
    "http://127.0.0.1:7890#f", // fragment
    "https://127.0.0.1:7890", // non-HTTP scheme
    "http://127.0.0.1:0", // port 0
    "http://127.0.0.1:65536", // port over the range
    "http://127.0.0.1:007", // leading-zero port
    "http://127.0.0.1", // missing port
    "http://127.0.0.1:7890//", // extra path content
    "http://" + "0".repeat(300) // oversized
  ]) {
    bad(url);
  }
  bad(42);
  bad(null);
  bad(undefined);
  bad({});
  bad(["http://127.0.0.1:7890"]);
});
