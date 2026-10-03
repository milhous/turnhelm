import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCodexArgs, codexEnvironment } from "../src/codex.js";

const execute = promisify(execFile);

async function runIsolated(t: TestContext, exitCode?: number) {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-stdin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (exitCode !== undefined) {
    await writeFile(join(directory, "codex"), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 });
  }
  const moduleUrl = new URL("../src/codex.js", import.meta.url).href;
  // The only executable on PATH is our temporary fixture; no real Codex can run.
  return execute(process.execPath, ["--input-type=module", "--eval", `
    import { runCodex } from ${JSON.stringify(moduleUrl)};
    try {
      const code = await runCodex({ kind: "direct", source: "classifier" }, "x".repeat(100 * 1024), false);
      console.log(JSON.stringify({ code }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  `], { env: { ...process.env, PATH: directory }, timeout: 10_000 });
}

for (const exitCode of [7, 0]) {
  test(`early Codex exit ${exitCode} controls failed stdin transfer`, { timeout: 20_000 }, async t => {
    const result = await runIsolated(t, exitCode);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { code: exitCode || 1 });
  });
}

test("missing Codex is a generic controlled rejection", { timeout: 20_000 }, async t => {
  const result = await runIsolated(t);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { error: "Codex could not start" });
});

test("profile route uses one-run model and effort", () => {
  assert.deepEqual(
    buildCodexArgs({
      kind: "profile",
      source: "classifier",
      profileId: "deep",
      profile: { description: "x", model: "gpt-6-sol", effort: "high" }
    }, false),
    ["exec", "--sandbox", "read-only", "--model", "gpt-6-sol", "--config", 'model_reasoning_effort="high"', "-"]
  );
});

test("classifier keys do not reach Codex", () => {
  const env = codexEnvironment({
    TYPESAFE_API_KEY: "x",
    LAYA_API_KEY: "y",
    TURNHELM_CONFIG: "z",
    CODEX_HOME: "/tmp/codex"
  });
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
});
