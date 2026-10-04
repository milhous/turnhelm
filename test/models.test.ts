import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OFFICIAL_MODEL_CAPABILITIES, isSupportedEffort, readCodexSignals } from "../src/models.js";

 test("official matrix exposes exact model-specific efforts", () => {
  assert.deepEqual(OFFICIAL_MODEL_CAPABILITIES["gpt-6-astra"].efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(OFFICIAL_MODEL_CAPABILITIES["gpt-6.1-sol"].efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(OFFICIAL_MODEL_CAPABILITIES["gpt-6-luna"].efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(isSupportedEffort("gpt-6-astra", "none"), false);
  assert.equal(isSupportedEffort("gpt-6-luna", "none"), true);
});

test("reads only visible API-backed cache models and default model", async t => {
  const home = await mkdtemp(join(tmpdir(), "turnhelm-models-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "models_cache.json"), JSON.stringify({
    models: [
      { slug: "gpt-6-luna", visibility: "visible", supported_in_api: true, supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "bogus" }] },
      { slug: "gpt-6-astra", visibility: "hidden", supported_in_api: true, supported_reasoning_levels: [{ effort: "xhigh" }] },
      { slug: "gpt-6.1-sol", visibility: "visible", supported_in_api: false, supported_reasoning_levels: [{ effort: "high" }] },
      { slug: "private-secret", visibility: "visible", supported_in_api: true, supported_reasoning_levels: [{ effort: "max" }], token: "do-not-return" }
    ], secret: "do-not-return"
  }));
  await writeFile(join(home, "config.toml"), `# comment\nmodel = "gpt-6.1-sol"\napi_key = "do-not-return"\n`);
  const signals = readCodexSignals({ CODEX_HOME: home });
  assert.equal(signals.defaultModel, "gpt-6.1-sol");
  assert.deepEqual(signals.cached["gpt-6-luna"], { visible: true, supportedInApi: true, efforts: ["none", "low"] });
  assert.deepEqual(signals.cached["gpt-6-astra"], { visible: false, supportedInApi: true, efforts: ["xhigh"] });
  assert.equal(signals.cached["gpt-6.1-sol"], undefined);
  assert.equal(signals.cached["private-secret"], undefined);
  assert.equal(JSON.stringify(signals).includes("do-not-return"), false);
  assert.equal(JSON.stringify(signals).includes(home), false);
});

test("ignores absent, oversized, malformed, and schema-incompatible metadata", async t => {
  const absent = await mkdtemp(join(tmpdir(), "turnhelm-models-"));
  t.after(() => rm(absent, { recursive: true, force: true }));
  assert.deepEqual(readCodexSignals({ CODEX_HOME: absent }), { cached: {} });
  await writeFile(join(absent, "models_cache.json"), "x".repeat(1024 * 1024 + 1));
  await writeFile(join(absent, "config.toml"), "x".repeat(1024 * 1024 + 1));
  assert.deepEqual(readCodexSignals({ CODEX_HOME: absent }), { cached: {} });
  await writeFile(join(absent, "models_cache.json"), "not json");
  await writeFile(join(absent, "config.toml"), "model = [\"gpt-6-astra\"]");
  assert.deepEqual(readCodexSignals({ CODEX_HOME: absent }), { cached: {} });
  await writeFile(join(absent, "models_cache.json"), JSON.stringify({ models: [{ slug: 4, visibility: "visible", supported_in_api: true, supported_reasoning_levels: "bad" }] }));
  assert.deepEqual(readCodexSignals({ CODEX_HOME: absent }), { cached: {} });
  assert.deepEqual(readCodexSignals({ CODEX_HOME: join(absent, "missing") }), { cached: {} });
});

test("uses temporary HOME/.codex when CODEX_HOME is not set", async t => {
  const home = await mkdtemp(join(tmpdir(), "turnhelm-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codex = join(home, ".codex");
  await mkdir(codex);
  await writeFile(join(codex, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6-luna", visibility: "visible", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }] }
  ] }));
  await writeFile(join(codex, "config.toml"), 'model = "gpt-6.1-sol"\n');
  assert.deepEqual(readCodexSignals({ HOME: home }), {
    defaultModel: "gpt-6.1-sol",
    cached: { "gpt-6-luna": { visible: true, supportedInApi: true, efforts: ["low"] } }
  });
});

test("reads only the root-level active model assignment from bounded TOML", async t => {
  const home = await mkdtemp(join(tmpdir(), "turnhelm-toml-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const writeConfig = (value: string) => writeFile(join(home, "config.toml"), value);
  await writeConfig('[profiles.not_selected]\nmodel = "gpt-6-astra"\n');
  assert.equal(readCodexSignals({ CODEX_HOME: home }).defaultModel, undefined);
  await writeConfig('developer_instructions = """\nmodel = "gpt-6-astra"\n"""\n');
  assert.equal(readCodexSignals({ CODEX_HOME: home }).defaultModel, undefined);
  await writeConfig('"developer_instructions" = """\nmodel = "gpt-6-astra"\n"""\nmodel = "gpt-6-luna"\n');
  assert.equal(readCodexSignals({ CODEX_HOME: home }).defaultModel, "gpt-6-luna");
  await writeConfig('developer_instructions = """one line"""\nmodel = "gpt-6-luna"\n');
  assert.equal(readCodexSignals({ CODEX_HOME: home }).defaultModel, "gpt-6-luna");
  await writeConfig('model = "gpt-6-luna"\n[profiles.selected]\nmodel = "gpt-6-astra"\n');
  assert.equal(readCodexSignals({ CODEX_HOME: home }).defaultModel, "gpt-6-luna");
  await writeConfig('model = "gpt-6-luna"\nmodel = "gpt-6-astra"\n');
  assert.equal(readCodexSignals({ CODEX_HOME: home }).defaultModel, undefined);
});

test("ignores non-regular Codex metadata paths", async t => {
  const home = await mkdtemp(join(tmpdir(), "turnhelm-nonfile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "models_cache.json"));
  await mkdir(join(home, "config.toml"));
  assert.deepEqual(readCodexSignals({ CODEX_HOME: home }), { cached: {} });
});
