import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const TASK = "Fix the cache invalidation between the worker and the queue.";
const AGENT_MESSAGE = "hello from worker";

const PROJECT_PROFILES = {
  fast: { model: "gpt-6-luna", effort: "low" },
  balanced: { model: "gpt-6.1-sol", effort: "medium" },
  deep: { model: "gpt-6.1-sol", effort: "high" },
  frontier: { model: "gpt-6-astra", effort: "high" },
  frontier_xhigh: { model: "gpt-6-astra", effort: "xhigh" },
  frontier_max: { model: "gpt-6-astra", effort: "max" }
};

const projectConfig = (port: number, layaEnabled = true): Record<string, unknown> => ({
  version: 1,
  routingTimeoutMs: 4000,
  backends: { laya: { enabled: layaEnabled, url: `http://127.0.0.1:${port}` }, jev: { enabled: false } },
  profiles: PROJECT_PROFILES
});

// The only executable named "codex" on the child PATH is this fixture; it
// answers the bounded preflight queries and then plays the worker role.
const CODEX_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("codex-cli 0.160.2"); process.exit(0); }
if (argv[0] === "exec" && argv[1] === "--help") {
  console.log("Usage: codex exec [OPTIONS] [TASK]");
  console.log("  --json       emit JSONL events");
  console.log("  --ephemeral  discard session state");
  console.log("  --sandbox <MODE>");
  console.log("  -            read the task from stdin");
  process.exit(0);
}
const record = (name, value) => fs.writeFileSync(path.join(__dirname, name), value);
record("argv.json", JSON.stringify(argv));
record("cwd.txt", process.cwd());
record("env.json", JSON.stringify(process.env));
fs.appendFileSync(path.join(__dirname, "runs"), "1");
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
let task = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { task += chunk; });
process.stdin.on("end", () => {
  record("task.txt", task);
  if (process.env.TEST_CODEX_RAW_STDERR) process.stderr.write(process.env.TEST_CODEX_RAW_STDERR + "\\n");
  if (process.env.TEST_CODEX_RAW_ERROR) emit({ type: "error", message: process.env.TEST_CODEX_RAW_ERROR });
  emit({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(AGENT_MESSAGE)} } });
  if (process.env.TEST_CODEX_MODE !== "failed") {
    emit({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } });
  }
  process.exit(Number(process.env.TEST_CODEX_EXIT ?? 0));
});
`;

const GIT_SCRIPT = `#!/bin/sh
if [ "$1" = "-C" ]; then echo true; exit 0; fi
exit 64
`;

// The -e entry shifts arguments by one; normalize them before importing the CLI.
const TTY_WRAPPER = `
const entry = process.argv[1];
process.argv = [process.argv[0], entry, ...process.argv.slice(2)];
process.stdin.isTTY = true;
import(entry);
`;

type Classifier = {
  choice?: string;
  mode?: "choice" | "http-error" | "invalid" | "hang";
  onRequest?: () => void | Promise<void>;
};

type RunOutcome = { code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string };

type FixtureOptions = { config?: false | { layaEnabled?: boolean }; git?: boolean; emptyPath?: boolean };

type SpawnOptions = { input?: string | undefined; env?: NodeJS.ProcessEnv; cwd?: string };

type Fixture = {
  root: string;
  port: number;
  bin: string;
  codexHome: string;
  requests: { url: string | undefined; method: string | undefined; body: string }[];
  env: NodeJS.ProcessEnv;
  run: (args: string[], options?: SpawnOptions) => Promise<RunOutcome>;
  runTty: (args: string[]) => Promise<RunOutcome>;
  spawn: (args: string[], options?: SpawnOptions) => ChildProcess;
};

const capture = (child: ChildProcess): Promise<RunOutcome> =>
  new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal, stdout, stderr }));
  });

const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

const until = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let round = 0; round < 200; round++) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail("timed out waiting for " + what);
};

async function fixture(t: TestContext, classifier: Classifier = {}, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "turnhelm-cli-root-"));
  const bin = await mkdtemp(join(tmpdir(), "turnhelm-cli-bin-"));
  const codexHome = await mkdtemp(join(tmpdir(), "turnhelm-cli-codexhome-"));
  const requests: Fixture["requests"] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", async () => {
      requests.push({ url: request.url, method: request.method, body });
      await classifier.onRequest?.();
      if (classifier.mode === "hang") {
        request.resume();
        request.on("close", () => { response.destroy(); });
        return;
      }
      response.setHeader("content-type", "application/json");
      if (classifier.mode === "http-error") {
        response.statusCode = 500;
        response.end("CLASSIFIER-BODY-SENTINEL");
        return;
      }
      if (classifier.mode === "invalid") {
        response.end(JSON.stringify({ answers: { route: { type: "choice", choice: "not-a-profile" } } }));
        return;
      }
      response.end(JSON.stringify({ answers: { route: { type: "choice", choice: classifier.choice ?? "balanced" } } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(bin, { recursive: true, force: true }),
      rm(codexHome, { recursive: true, force: true })
    ]);
  });
  await writeFile(join(bin, "codex"), CODEX_SCRIPT, { mode: 0o755 });
  if (options.git !== false) {
    await writeFile(join(bin, "git"), GIT_SCRIPT, { mode: 0o755 });
    await chmod(join(bin, "git"), 0o755);
  }
  if (options.config !== false) {
    const layaEnabled = typeof options.config === "object" ? options.config.layaEnabled !== false : true;
    await mkdir(join(root, ".turnhelm"), { recursive: true });
    await writeFile(join(root, ".turnhelm", "config.json"), JSON.stringify(projectConfig(port, layaEnabled)));
  }
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: options.emptyPath === true ? join(bin, "unused") : bin,
    LAYA_API_KEY: "dummy-laya-key",
    CODEX_HOME: codexHome
  };
  const spawnCli = (args: string[], options: SpawnOptions = {}): ChildProcess =>
    spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env: { ...baseEnv, ...options.env }
    });
  return {
    root, port, bin, codexHome, requests, env: baseEnv,
    run: (args, runOptions = {}) => {
      const child = spawnCli(args, runOptions);
      const outcome = capture(child);
      if (runOptions.input !== undefined) child.stdin?.end(runOptions.input);
      return outcome;
    },
    runTty: args => {
      const child = spawn(process.execPath, ["-e", TTY_WRAPPER, cli, ...args], { cwd: root, env: baseEnv });
      const outcome = capture(child);
      child.stdin?.end("");
      return outcome;
    },
    spawn: spawnCli
  };
}

const parseReceipt = (stderr: string): Record<string, unknown> => {
  const lines = stderr.split("\n").filter(line => line.includes("turnhelm.receipt"));
  assert.equal(lines.length, 1, "exactly one receipt line is expected: " + JSON.stringify(stderr));
  return JSON.parse(lines[0]);
};

type WorkerRecords = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  task: string;
  runs: number;
};

const workerRecords = async (f: Fixture): Promise<WorkerRecords> => {
  const read = async (name: string): Promise<string | undefined> => {
    try { return await readFile(join(f.bin, name), "utf8"); } catch { return undefined; }
  };
  const argv = await read("argv.json");
  const runs = await read("runs");
  return {
    argv: argv === undefined ? [] : JSON.parse(argv),
    cwd: (await read("cwd.txt") ?? "").trim(),
    env: JSON.parse((await read("env.json") ?? "{}")),
    task: await read("task.txt") ?? "",
    runs: runs === undefined ? 0 : runs.length
  };
};

const DOCTOR_IDS = [
  "root", "node", "codex", "git", "assets", "config", "backends", "credentials",
  "instructions", "models", "backend.laya", "backend.jev"
];

test("init --dry-run plans the owned files without writing", async t => {
  const f = await fixture(t, {}, { config: false });
  const result = await f.run(["init", "--dry-run"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  for (const path of [".turnhelm/config.json", ".agents/skills/turnhelm-routing/SKILL.md",
    ".agents/skills/turnhelm-routing/agents/openai.yaml", "AGENTS.md"]) {
    assert.ok(result.stderr.includes("planned " + path), "stderr should plan " + path);
  }
  assert.deepEqual(await readdir(f.root), []);
});

test("init applies the owned files and an identical repeat applies nothing", async t => {
  const f = await fixture(t, {}, { config: false });
  const first = await f.run(["init"]);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, "");
  for (const path of [".turnhelm/config.json", "AGENTS.md"]) {
    assert.ok(first.stderr.includes("applied " + path), "stderr should report applied " + path);
  }
  assert.ok((await readdir(join(f.root, ".agents", "skills", "turnhelm-routing"))).includes("SKILL.md"));
  const repeat = await f.run(["init"]);
  assert.equal(repeat.code, 0);
  assert.equal(repeat.stdout, "");
  assert.equal(repeat.stderr.includes("applied "), false, "a repeat applies nothing: " + JSON.stringify(repeat.stderr));
});

test("doctor --json prints stable independent checks on stdout", async t => {
  const f = await fixture(t);
  assert.equal((await f.run(["init"])).code, 0);
  const result = await f.run(["doctor", "--json"]);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as { code: number; checks: { id: string; status: string; evidence: string; next: string }[] };
  assert.equal(report.code, 0);
  assert.deepEqual(report.checks.map(check => check.id), DOCTOR_IDS);
  assert.equal(f.requests.length, 0, "offline doctor makes zero classifier requests");
});

test("plain doctor writes only to stderr and still exits zero", async t => {
  const f = await fixture(t);
  assert.equal((await f.run(["init"])).code, 0);
  const result = await f.run(["doctor"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes("[pass] config"));
});

test("run routes once, executes one read-only worker, and emits one accurate receipt", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, AGENT_MESSAGE + "\n");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/v1/systemone");
  assert.equal(f.requests[0].method, "POST");
  assert.equal((JSON.parse(f.requests[0].body) as { state: string }).state, TASK);
  const records = await workerRecords(f);
  assert.deepEqual(records.argv, ["exec", "--ephemeral", "--json", "--sandbox", "read-only",
    "--config", "agents.enabled=false", "--model", "gpt-6.1-sol", "--config", 'model_reasoning_effort="medium"', "-"]);
  assert.equal(records.cwd, realpathSync(f.root));
  assert.equal(records.task, TASK);
  for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_CONFIG", "TURNHELM_ALLOW_HOSTED_JEV"]) {
    assert.equal(key in records.env, false, key + " must be stripped from the worker");
  }
  assert.equal(records.env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(records.env.CODEX_HOME, f.codexHome);
  const receipt = parseReceipt(result.stderr);
  assert.equal(receipt.type, "turnhelm.receipt");
  assert.equal(receipt.root, realpathSync(f.root));
  const routing = receipt.routing as { status: string; routingMs: number;
    attempts: { backend: string; outcome: string; durationMs: number }[];
    requestCounts: { laya: number; jev: number } };
  assert.equal(routing.status, "selected");
  assert.equal(typeof routing.routingMs, "number");
  assert.deepEqual(routing.attempts.map(attempt => ({ backend: attempt.backend, outcome: attempt.outcome })),
    [{ backend: "laya", outcome: "success" }]);
  assert.deepEqual(routing.requestCounts, { laya: 1, jev: 0 });
  assert.deepEqual(receipt.selection, { backend: "laya", profileId: "balanced", model: "gpt-6.1-sol", effort: "medium" });
  const worker = receipt.worker as { status: string; code: number; durationMs: number; usage?: Record<string, number> };
  assert.equal(worker.status, "completed");
  assert.equal(worker.code, 0);
  assert.equal(typeof worker.durationMs, "number");
  assert.deepEqual(worker.usage, { input_tokens: 11, output_tokens: 7 });
  assert.equal(receipt.classifierUsage, "unreported");
  assert.equal(receipt.wholeRunUsageScope, "unverified");
  assert.equal(JSON.stringify(receipt).includes(TASK), false, "the receipt never carries task text");
  assert.equal(records.runs, 1);
});

test("run --write selects workspace-write", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", "--write", TASK], { input: "" });
  assert.equal(result.code, 0);
  const records = await workerRecords(f);
  assert.equal(records.argv[4], "workspace-write");
});

test("max effort is selected by difficulty alone with no max flag", async t => {
  const f = await fixture(t, { choice: "frontier_max" });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 0);
  const records = await workerRecords(f);
  assert.deepEqual(records.argv, ["exec", "--ephemeral", "--json", "--sandbox", "read-only",
    "--config", "agents.enabled=false", "--model", "gpt-6-astra", "--config", 'model_reasoning_effort="max"', "-"]);
  const receipt = parseReceipt(result.stderr);
  assert.deepEqual(receipt.selection, { backend: "laya", profileId: "frontier_max", model: "gpt-6-astra", effort: "max" });
});

test("one classification decision is sent unchanged even if the config file changes", async t => {
  const f = await fixture(t, {
    choice: "deep",
    onRequest: () => {
      const mutated = projectConfig(f.port);
      (mutated.profiles as Record<string, { model: string }>).deep.model = "mutated-model";
      return writeFile(join(f.root, ".turnhelm", "config.json"), JSON.stringify(mutated));
    }
  });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 0);
  const records = await workerRecords(f);
  assert.ok(records.argv.includes("gpt-6.1-sol"), "the worker receives the snapshotted model");
  assert.equal(records.argv.includes("mutated-model"), false);
  assert.equal(f.requests.length, 1);
});

test("a TTY run accepts one positional task without reading stdin", async t => {
  const f = await fixture(t);
  const result = await f.runTty(["run", "Fix the parser."]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, AGENT_MESSAGE + "\n");
  assert.equal(f.requests.length, 1);
});

test("a bare TTY run is a usage error", async t => {
  const f = await fixture(t);
  const result = await f.runTty(["run"]);
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 0);
});

test("-- permits a single option-like task token", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", "--", "--write"], { input: "" });
  assert.equal(result.code, 0);
  assert.equal((await workerRecords(f)).task, "--write");
});

for (const args of [
  [], ["frobnicate", "task"], ["run", "--bogus", "task"], ["init", "--json"],
  ["doctor", "extra"], ["run", "--write", "--write", "task"], ["run", "two", "positionals"],
  ["run", "--project"], ["run", "--project=", "task"], ["run", "--"], ["init", "--"]
]) {
  test(`usage errors exit 2 with zero requests: ${JSON.stringify(args)}`, async t => {
    const f = await fixture(t);
    const result = await f.run(args, { input: "" });
    assert.equal(result.code, 2);
    assert.equal(f.requests.length, 0);
  });
}

test("nonempty piped input plus a positional task is a usage error", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", TASK], { input: "Piped second task." });
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 0);
});

test("empty closed stdin without a positional task is a usage error", async t => {
  const f = await fixture(t);
  const result = await f.run(["run"], { input: "" });
  assert.equal(result.code, 2);
  assert.equal(f.requests.length, 0);
});

test("a missing project config fails before classification", async t => {
  const f = await fixture(t, {}, { config: false });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(".turnhelm/config.json"));
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
});

test("a missing codex executable is a run-prerequisite failure", async t => {
  const f = await fixture(t, {}, { emptyPath: true });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("compatible Codex executable"));
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
});

test("git availability is required even in read-only mode", async t => {
  const f = await fixture(t, {}, { git: false });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("Git work tree"));
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
});

test("no eligible classification backend fails before classification", async t => {
  const f = await fixture(t, {}, { config: { layaEnabled: false } });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("no eligible classification backend"));
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
});

test("a missing routing skill and a conflicting AGENTS block do not block a valid run", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "AGENTS.md"), "<!-- turnhelm:begin v1 -->\nown content that conflicts<!-- turnhelm:end -->\n");
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(await workerRecords(f).then(records => records.runs), 1);
  assert.equal(await readdir(join(f.root, ".agents")).then(
    () => true,
    () => false), false, "run must not invoke init or repair the skill files");
});

test("a worker terminal failure fails the run despite exit zero", async t => {
  const f = await fixture(t, {}, {});
  const result = await f.run(["run", TASK], { input: "", env: { TEST_CODEX_MODE: "failed" } });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, AGENT_MESSAGE + "\n");
  const receipt = parseReceipt(result.stderr);
  assert.deepEqual((receipt.worker as { status: string; code: number }).status, "failed");
});

test("a nonzero worker exit code is preserved", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", TASK], { input: "", env: { TEST_CODEX_EXIT: "7" } });
  assert.equal(result.code, 7);
  assert.equal((parseReceipt(result.stderr).worker as { status: string }).status, "failed");
});

test("raw worker stderr and raw error events never reach the parent", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", TASK], {
    input: "",
    env: { TEST_CODEX_RAW_STDERR: "RAW-WORKER-STDERR-SENTINEL", TEST_CODEX_RAW_ERROR: "RAW-ERROR-TEXT-SENTINEL" }
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr.includes("RAW-WORKER-STDERR-SENTINEL"), false);
  assert.equal(result.stderr.includes("RAW-ERROR-TEXT-SENTINEL"), false);
  assert.ok(result.stderr.includes("turnhelm: worker-event-error"));
  assert.equal(parseReceipt(result.stderr).type, "turnhelm.receipt");
});

test("routing exhaustion launches zero workers and emits one receipt without a selection", async t => {
  const f = await fixture(t, { mode: "invalid" });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  const receipt = parseReceipt(result.stderr);
  const routing = receipt.routing as { status: string; attempts: { backend: string; outcome: string }[];
    requestCounts: { laya: number; jev: number } };
  assert.equal(routing.status, "failed");
  assert.deepEqual(routing.attempts.map(attempt => ({ backend: attempt.backend, outcome: attempt.outcome })),
    [{ backend: "laya", outcome: "failed" }]);
  assert.deepEqual(routing.requestCounts, { laya: 1, jev: 0 });
  assert.equal("selection" in receipt, false);
  assert.deepEqual(receipt.worker, { status: "not-started" });
  assert.equal(receipt.classifierUsage, "unreported");
  assert.equal(receipt.wholeRunUsageScope, "unverified");
  assert.equal(await workerRecords(f).then(records => records.runs), 0);
});

test("a classifier HTTP failure is sanitized", async t => {
  const f = await fixture(t, { mode: "http-error" });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.includes("CLASSIFIER-BODY-SENTINEL"), false);
  assert.equal(result.stderr.includes("dummy-laya-key"), false);
  const receipt = parseReceipt(result.stderr);
  assert.equal((receipt.routing as { status: string }).status, "failed");
});

test("SIGINT during routing keeps one cancelled attempt and launches no worker", async t => {
  const f = await fixture(t, { mode: "hang" });
  const child = f.spawn(["run", TASK]);
  const pending = capture(child);
  child.stdin?.end(TASK);
  await until(() => f.requests.length === 1, "the classifier request");
  child.kill("SIGINT");
  const result = await pending;
  assert.equal(result.code, 130);
  const receipt = parseReceipt(result.stderr);
  assert.equal((receipt.routing as { status: string }).status, "cancelled");
  assert.equal((receipt.routing as { attempts: { outcome: string }[] }).attempts[0].outcome, "cancelled");
  assert.equal("selection" in receipt, false);
  assert.deepEqual(receipt.worker, { status: "not-started" });
  assert.equal(await workerRecords(f).then(records => records.runs), 0);
});

test("SIGINT while stdin is pending exits 130 with zero classifier requests", async t => {
  const f = await fixture(t);
  const child = f.spawn(["run"]);
  const pending = capture(child);
  await sleep(300);
  child.kill("SIGINT");
  const result = await pending;
  assert.equal(result.code, 130);
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
  assert.equal(await workerRecords(f).then(records => records.runs), 0);
});

test("SIGTERM while stdin is pending exits 143 with zero classifier requests", async t => {
  const f = await fixture(t);
  const child = f.spawn(["run"]);
  const pending = capture(child);
  await sleep(300);
  child.kill("SIGTERM");
  const result = await pending;
  assert.equal(result.code, 143);
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
});

test("the managed-child recursion check precedes any config read", async t => {
  const f = await fixture(t, {}, { config: false });
  const result = await f.run(["run", TASK], { input: "", env: { TURNHELM_MANAGED_CHILD: "1" } });
  assert.equal(result.code, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(result.stderr.includes("turnhelm.receipt"), false);
  assert.ok(result.stderr.includes("Turnhelm-managed child"));
});

test("a project outside the current directory resolves through --project", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", "--project", f.root, TASK], { input: "", cwd: tmpdir() });
  assert.equal(result.code, 0);
  assert.equal((await workerRecords(f)).cwd, realpathSync(f.root));
});
