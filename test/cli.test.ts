import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const genericError = "Turnhelm could not route this task; check config and backend availability.\n";
const profile = { description: "Complex work", model: "test-model", effort: "high" };

async function fixture(t: TestContext, choice = "direct") {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-cli-"));
  const requests: { url: string | undefined; method: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ answers: { route: { type: "choice", choice } } }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const configPath = join(directory, "config.json");
  const config = {
    backend: "laya", layaUrl: `http://127.0.0.1:${address.port}`,
    fallbackProfile: "deep", hostedJev: { enabled: false }, profiles: { deep: profile }
  };
  await writeFile(configPath, JSON.stringify(config));
  // This executable only observes the child boundary; it never invokes Codex.
  await writeFile(join(directory, "codex"), `#!${process.execPath}
let input = "";
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({
  args: process.argv.slice(2), input,
  classifierCredentialsPresent: ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_CONFIG"].some(key => key in process.env),
  codexHome: process.env.CODEX_HOME
}));
if (process.env.TEST_CODEX_SIGNAL) process.kill(process.pid, "SIGTERM");
else process.exitCode = Number(process.env.TEST_CODEX_EXIT ?? 0);
`, { mode: 0o700 });
  // Preserve NODE_V8_COVERAGE and other runner settings for child source coverage.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: directory + delimiter + (process.env.PATH ?? ""),
    TURNHELM_CONFIG: configPath, LAYA_API_KEY: "dummy-laya", TYPESAFE_API_KEY: "dummy-typesafe",
    CODEX_HOME: join(directory, "codex-home") };
  delete env.TURNHELM_ALLOW_HOSTED_JEV;
  delete env.TEST_CODEX_EXIT;
  delete env.TEST_CODEX_SIGNAL;
  return {
    requests, env, directory,
    setConfig: (value: unknown) => writeFile(configPath, JSON.stringify(value)),
    config,
    run: (args: string[], overrides: NodeJS.ProcessEnv = {}) => execute(process.execPath, [cli, ...args], {
      env: { ...env, ...overrides }, timeout: 10_000
    })
  };
}

for (const choice of ["direct", "deep"]) {
  test(`CLI route emits ${choice} JSON without starting Codex`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, choice);
    const result = await f.run(["route", "Review this change."]);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), choice === "direct"
      ? { kind: "direct", source: "classifier" }
      : { kind: "profile", source: "classifier", profileId: "deep", profile });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, "/v1/systemone");
    assert.equal(f.requests[0].method, "POST");
  });
}

for (const write of [false, true]) {
  test(`CLI Codex profile uses ${write ? "explicit workspace-write" : "read-only"} and original stdin`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, "deep");
    const prompt = ' \nReview "quoted" input.\n保留 😀; $(not-a-command)\n ';
    const result = await f.run(["codex", ...(write ? ["--write"] : []), prompt]);
    assert.equal(result.stderr, "");
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed, {
      args: ["exec", "--sandbox", write ? "workspace-write" : "read-only", "--model", "test-model", "--config", 'model_reasoning_effort="high"', "-"],
      input: prompt, classifierCredentialsPresent: false, codexHome: f.env.CODEX_HOME
    });
    assert.equal((f.requests[0].body as { state: string }).state, prompt);
  });
}

test("CLI direct Codex leaves model and effort defaults intact", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const result = await f.run(["codex", "Say hello."]);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).args, ["exec", "--sandbox", "read-only", "-"]);
});

for (const [name, prompt, source] of [
  ["overlong", "x".repeat(2001), "fallback"],
  ["padded 2001-unit", " " + "x".repeat(1999) + " ", "fallback"],
  ["continuation", "继续。", "continuation"]
]) {
  test(`CLI ${name} input stays local`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const result = await f.run(["route", prompt]);
    assert.deepEqual(JSON.parse(result.stdout), { kind: "profile", source, profileId: "deep", profile });
    assert.equal(result.stderr, "");
    assert.equal(f.requests.length, 0);
  });
}

for (const args of [[], ["unsupported", "task"], ["route", " \t\n "], ["codex", "--write"]]) {
  test(`CLI rejects invalid command ${JSON.stringify(args)} generically`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    await assert.rejects(f.run(args), { code: 1, stdout: "", stderr: genericError });
    assert.equal(f.requests.length, 0);
  });
}

test("CLI rejects invalid config without exposing its contents", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.setConfig({ ...f.config, backend: "private-invalid-value" });
  await assert.rejects(f.run(["route", "Review this change."]), { code: 1, stdout: "", stderr: genericError });
  assert.equal(f.requests.length, 0);
});

test("CLI reports Codex spawn failure generically", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const emptyPath = join(f.directory, "empty-bin");
  await mkdir(emptyPath);
  await assert.rejects(f.run(["codex", "Say hello."], { PATH: emptyPath }), { code: 1, stdout: "", stderr: genericError });
});

test("CLI preserves the Codex nonzero exit code", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(["codex", "Say hello."], { TEST_CODEX_EXIT: "7" }), error => {
    assert.equal((error as { code: number }).code, 7);
    assert.equal((error as { stderr: string }).stderr, "");
    return true;
  });
});

test("CLI maps a signal-terminated Codex to failure", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(["codex", "Say hello."], { TEST_CODEX_SIGNAL: "1" }), error => {
    assert.equal((error as { code: number }).code, 1);
    assert.equal((error as { stderr: string }).stderr, "");
    return true;
  });
});
