import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executableFixture } from "./executable-fixture.js";
import { fakeEnv, fixtureConfig } from "./fixtures.js";
import { initProject } from "../src/init.js";
import { doctorProject } from "../src/doctor.js";
import { parseProjectConfig } from "../src/config.js";
import { isSupportedNode, MIN_NODE_VERSION } from "../src/runtime.js";
import { ClassifierRequestError, choiceRequest, requestTaskChoice, type ChoiceRequest, type RequestSpec } from "../src/systemone.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// Every fixture codex invocation is logged, including the bounded preflight
// queries: an unsupported runtime must start none of them.
const CODEX_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "codex-invocations"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "--version") { console.log("codex-cli 0.160.2"); process.exit(0); }
if (process.argv[2] === "exec" && process.argv[3] === "--help") {
  console.log("Usage: codex exec [OPTIONS] [TASK]");
  console.log("  --json       emit JSONL events");
  console.log("  --ephemeral  discard session state");
  console.log("  --sandbox <MODE>");
  console.log("  -            read the task from stdin");
  process.exit(0);
}
console.error("fixture codex never runs tasks");
process.exit(1);
`;

const GIT_SCRIPT = `#!/bin/sh
if [ "$1" = "-C" ]; then echo true; exit 0; fi
exit 64
`;

// The -e entry shifts arguments by one; normalize them, inject the version
// fact, then import the CLI exactly as a real invocation would parse it.
const CLI_CHILD = `
const cli = process.argv[1];
const args = process.argv.slice(2);
Object.defineProperty(process.versions, "node", { value: "24.4.1" });
process.argv = [process.argv[0], cli, ...args];
import(require("node:url").pathToFileURL(cli).href);
`;

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBin(t: TestContext): Promise<string> {
  const dir = await tempDir(t, "turnhelm-runtime-bin-");
  await executableFixture(join(dir, "codex"), CODEX_SCRIPT, "node");
  await executableFixture(join(dir, "git"), GIT_SCRIPT, "shell");
  return dir;
}

// A project initialized from the shipped v2 templates with an eligible Laya.
async function preparedProject(t: TestContext): Promise<string> {
  const root = await tempDir(t, "turnhelm-runtime-project-");
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  return root;
}

async function doctorEnv(t: TestContext, bin: string): Promise<NodeJS.ProcessEnv> {
  return { ...fakeEnv, PATH: bin, CODEX_HOME: await tempDir(t, "turnhelm-runtime-codexhome-") };
}

async function snapshot(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else files.set(relative, (await readFile(join(dir, entry.name))).length);
    }
  }
  await walk(root, "");
  return files;
}

const withNodeVersion = async <T>(version: string, run: () => Promise<T>): Promise<T> => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  assert.ok(descriptor !== undefined && descriptor.configurable, "process.versions.node must be configurable to simulate versions");
  Object.defineProperty(process.versions, "node", { ...descriptor, value: version });
  try {
    return await run();
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
  }
};

const runCli = (args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", CLI_CHILD, cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin?.end();
  });

test("unsupported runtime performs no work", async (t) => {
  assert.deepEqual([...MIN_NODE_VERSION], [24, 5, 0]);
  assert.ok(Object.isFrozen(MIN_NODE_VERSION));
  for (const [version, expected] of [
    ["22.8.0", false], ["24.0.0", false], ["24.4.1", false], ["24.4.99", false],
    ["24.5", false], ["not-a-version", false],
    ["24.5.0", true], ["24.5.1", true], ["24.11.0", true], ["25.0.0", true]
  ] as const) {
    assert.equal(isSupportedNode(version), expected, version);
  }
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
  assert.equal(pkg.engines.node, ">=" + MIN_NODE_VERSION.join("."));

  // Transport: the refusal precedes Agent/request/socket creation, so the
  // listening fixture observes zero requests and the failure is typed/fixed.
  let served = 0;
  const server = createServer((request, response) => {
    served += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as AddressInfo;
  const spec: RequestSpec = {
    backend: "laya",
    url: new URL(`http://127.0.0.1:${address.port}/v1/systemone`),
    body: "{\"probe\":true}",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5000),
    transport: { mode: "direct" }
  };
  await withNodeVersion("24.4.1", async () => {
    const error = await choiceRequest(spec)
      .then(() => assert.fail("expected the transport to refuse"), (failure: unknown) => failure);
    assert.ok(error instanceof ClassifierRequestError, "the refusal is a typed transport failure");
    assert.equal(error.message, "classifier request refused on an unsupported runtime");
    assert.ok(Object.isFrozen(error.failure));
    assert.deepEqual(error.failure, { kind: "request", httpStatus: null, code: null });
  });
  assert.equal(served, 0, "an unsupported runtime must dial nothing");

  // Library doctor: structured node failure with the probe refused and no
  // project writes, even with an injected probe request.
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  const specs: RequestSpec[] = [];
  const request: ChoiceRequest = spec => {
    specs.push(spec);
    return Promise.resolve({ answers: { route: { type: "choice", choice: "fast" } } });
  };
  const before = await snapshot(root);
  const result = await withNodeVersion("24.4.1",
    async () => doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request }));
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("node")?.status, "fail");
  assert.equal(byId.get("node")?.next, "upgrade node to " + MIN_NODE_VERSION.join(".") + " or newer");
  assert.equal(byId.get("backend.laya")?.status, "unverified", "the probe must be refused, not skipped as unauthorized");
  assert.equal(specs.length, 0, "an unsupported runtime must send no probe request");
  assert.deepEqual(await snapshot(root), before, "doctor must write nothing on an unsupported runtime");
  assert.equal(result.code, 1);
});

test("an unsupported CLI runtime refuses before dispatch without tools, requests, or writes", async (t) => {
  let served = 0;
  const server = createServer((request, response) => {
    served += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ answers: { route: { type: "choice", choice: "balanced" } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as AddressInfo;
  const bin = await fakeBin(t);
  const env: NodeJS.ProcessEnv = { PATH: bin, LAYA_API_KEY: "dummy-laya-key", CODEX_HOME: await tempDir(t, "turnhelm-runtime-codexhome-") };

  const runRoot = await tempDir(t, "turnhelm-runtime-run-");
  const config = JSON.parse(JSON.stringify(fixtureConfig())) as Record<string, unknown>;
  (config.backends as Record<string, unknown>).laya = {
    enabled: true, url: `http://127.0.0.1:${address.port}`
  };
  await mkdir(join(runRoot, ".turnhelm"), { recursive: true });
  await writeFile(join(runRoot, ".turnhelm", "config.json"), JSON.stringify(config));

  const runChild = await runCli(["run", "--project", runRoot, "Fix the parser."], env);
  assert.equal(runChild.code, 1);
  assert.ok(runChild.stderr.includes("node " + MIN_NODE_VERSION.join(".") + " or newer is required"),
    "the fixed runtime diagnostic must be printed: " + JSON.stringify(runChild.stderr));
  assert.equal(runChild.stderr.includes("turnhelm.receipt"), false, "no classification receipt exists");
  assert.equal(served, 0, "the classifier is never dialed");
  await assert.rejects(() => readFile(join(bin, "codex-invocations")), { code: "ENOENT" },
    "not even a preflight tool inspection may run");

  const initRoot = await tempDir(t, "turnhelm-runtime-init-");
  const initChild = await runCli(["init", "--project", initRoot], env);
  assert.equal(initChild.code, 1);
  assert.deepEqual(await readdir(initRoot), [], "init writes nothing on an unsupported runtime");

  const doctorChild = await runCli(["doctor", "--probe", "--json", "--project", runRoot], env);
  assert.equal(doctorChild.code, 1);
  assert.equal(doctorChild.stdout, "", "the doctor never runs or reports checks");
  assert.equal(served, 0, "probe mode still sends no request");
  await assert.rejects(() => readFile(join(bin, "codex-invocations")), { code: "ENOENT" });
});

test("enabled http-connect Jev carries its frozen policy to the request boundary", async () => {
  const base = fixtureConfig();
  const proxied = parseProjectConfig({
    ...base,
    backends: { ...base.backends, jev: { enabled: true, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" } } }
  });
  const specs: RequestSpec[] = [];
  const request: ChoiceRequest = spec => {
    specs.push(spec);
    return Promise.resolve({ answers: { route: { type: "choice", choice: "fast" } } });
  };
  const choice = await requestTaskChoice(proxied, "Investigate cross-module invariants", "jev", fakeEnv, AbortSignal.timeout(500), request);
  assert.equal(choice.profileId, "fast");
  assert.equal(specs.length, 1, "the seam is reached once with the frozen policy");
  assert.equal(specs[0].url.href, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(specs[0].transport, { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" });
  assert.ok(Object.isFrozen(specs[0].transport), "the policy stays frozen at the boundary");

  // The explicit direct policy keeps reaching the request boundary unchanged.
  const direct = parseProjectConfig({
    ...base,
    backends: { ...base.backends, jev: { enabled: true, transport: { mode: "direct" } } }
  });
  let reached = 0;
  const directChoice = await requestTaskChoice(direct, "Investigate cross-module invariants", "jev", fakeEnv,
    AbortSignal.timeout(500), async () => {
      reached += 1;
      return { answers: { route: { type: "choice", choice: "fast" } } };
    });
  assert.equal(directChoice.profileId, "fast");
  assert.equal(reached, 1);
});
