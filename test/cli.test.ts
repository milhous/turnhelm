import { SANDBOX_SEMANTICS_NOTE } from "../src/codex.js";
import { executableFixture } from "./executable-fixture.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  version: 2,
  routingTimeoutMs: 4000,
  backends: {
    laya: { enabled: layaEnabled, url: `http://127.0.0.1:${port}` },
    jev: { enabled: false, transport: { mode: "direct" } }
  },
  profiles: PROJECT_PROFILES
});

// The only executable named "codex" on the child PATH is this fixture; it
// answers the bounded preflight queries and then plays the worker role.
const CODEX_SCRIPT = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (process.env.TEST_CODEX_INSPECTION_HANG === "1" && argv[0] === "--version") {
  // A live bounded inspection: record the PID, then idle until killed.
  fs.writeFileSync(path.join(__dirname, "inspection-pid"), String(process.pid));
  setInterval(() => {}, 500);
  return;
}
if (argv[0] === "--version") { console.log("codex-cli 0.160.2"); process.exit(0); }
if (argv[0] === "exec" && argv[1] === "--help") {
  console.log("Usage: codex exec [OPTIONS] [TASK]");
  console.log("  --json       emit JSONL events");
  console.log("  --ephemeral  discard session state");
  console.log("  --sandbox <MODE>");
  console.log("  -            read the task from stdin");
  console.log("  --ignore-user-config");
  console.log("  --ignore-rules");
  console.log("  --output-schema <FILE>");
  process.exit(0);
}
const record = (name, value) => fs.writeFileSync(path.join(__dirname, name), value);
record("argv.json", JSON.stringify(argv));
record("cwd.txt", process.cwd());
record("env.json", JSON.stringify(process.env));
fs.appendFileSync(path.join(__dirname, "runs"), "1");
if (process.env.CODEX_HOME !== undefined) {
  // The managed-home credential link, as the worker itself resolves it.
  try { record("authlink.txt", fs.readlinkSync(path.join(process.env.CODEX_HOME, "auth.json"))); } catch { /* no link */ }
}
const schemaFlag = argv.indexOf("--output-schema");
if (schemaFlag !== -1) {
  record("schema-arg.txt", argv[schemaFlag + 1]);
  record("schema-bytes.json", JSON.stringify(fs.readFileSync(argv[schemaFlag + 1], "utf8")));
}
if (process.env.TEST_CODEX_MODE === "hang") {
  // A live worker: signal readiness, then keep the process alive until TERM.
  record("ready", "1");
  record("pid", String(process.pid));
  setInterval(() => {}, 500);
} else {
  const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
  let task = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { task += chunk; });
  process.stdin.on("end", () => {
    record("task.txt", task);
    if (process.env.TEST_CODEX_RAW_STDERR) process.stderr.write(process.env.TEST_CODEX_RAW_STDERR + "\\n");
    if (process.env.TEST_CODEX_RAW_ERROR) emit({ type: "error", message: process.env.TEST_CODEX_RAW_ERROR });
    const message = process.env.TEST_CODEX_MESSAGE ?? ${JSON.stringify(AGENT_MESSAGE)};
    emit({ type: "item.completed", item: { type: "agent_message", text: message } });
    if (process.env.TEST_CODEX_MODE === "failed") {
      // Terminal failure without a completion event or usage snapshot.
    } else if (process.env.TEST_CODEX_OMIT_USAGE === "1") {
      emit({ type: "turn.completed" });
    } else {
      emit({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } });
    }
    if (process.env.TEST_CODEX_LINGER === "1") {
      // Terminal frames delivered; the process idles until the ladder TERMs it.
      setInterval(() => {}, 500);
    } else {
      process.exit(Number(process.env.TEST_CODEX_EXIT ?? 0));
    }
  });
}
`;

// Root's F4 repro shape: a preload that flips an env tag when the classifier
// response arrives, so a worker launched after classification can be told
// apart from one seeing the pre-classification snapshot.
const ENVFLIP_SCRIPT = `
const http = require("node:http");
const originalRequest = http.request;
http.request = function (...args) {
  const request = originalRequest.apply(this, args);
  request.on("response", () => { process.env.ROOT_SNAPSHOT_TAG = "after"; });
  return request;
};
require("node:module").syncBuiltinESMExports();
`;

// Review-fix fault injection: a --require preload that patches one builtin
// for the CLI child, selected by TURNHELM_TEST_FAULT. The patch is scoped to
// the exact production call so earlier legitimate calls (config reads, the
// preflight `codex exec --help` probe) stay on the real function.
const FAULT_PRELOAD = `
const fault = process.env.TURNHELM_TEST_FAULT;
if (fault === "symlink") {
  const fs = require("node:fs");
  fs.symlinkSync = () => { throw Object.assign(new Error("injected"), { code: "EPERM" }); };
} else if (fault === "staging") {
  const fs = require("node:fs");
  const real = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (String(args[0]).endsWith("output-schema.json")) {
      fs.writeFileSync = real;
      throw Object.assign(new Error("injected"), { code: "ENOSPC" });
    }
    return real(...args);
  };
} else if (fault === "readsync") {
  const fs = require("node:fs");
  const real = fs.readSync;
  // Scoped to the production 5-arg call (position === null): Node's own
  // readFileSync loads modules with a 4-arg readSync and must stay real, or
  // the fault fires during ESM load before the CLI runs.
  fs.readSync = (fd, buffer, offset, length, position) => {
    if (typeof fd === "number" && fd > 2 && position === null) {
      fs.readSync = real;
      throw Object.assign(new Error("injected"), { code: "EIO" });
    }
    return real(fd, buffer, offset, length, position);
  };
} else if (fault === "spawn") {
  const cp = require("node:child_process");
  const real = cp.spawn;
  cp.spawn = (...args) => {
    const argv = args[1] ?? [];
    if (String(args[0]).endsWith("codex") && argv[0] === "exec" && !argv.includes("--help")) {
      cp.spawn = real;
      throw Object.assign(new Error("injected"), { code: "EACCES" });
    }
    return real(...args);
  };
} else if (fault === "spawn-async") {
  const cp = require("node:child_process");
  const real = cp.spawn;
  cp.spawn = (...args) => {
    const argv = args[1] ?? [];
    if (String(args[0]).endsWith("codex") && argv[0] === "exec" && !argv.includes("--help")) {
      cp.spawn = real;
      // The pipes exist and ENOENT arrives as a later error event, so the
      // runner is past the spawn call: an executed-worker receipt path.
      return real("turnhelm-missing-worker-binary", argv, args[2]);
    }
    return real(...args);
  };
}
require("node:module").syncBuiltinESMExports();
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
  usage?: Record<string, unknown>;
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
  // WB-2: every default run carries a discoverable worker credential source.
  await writeFile(join(codexHome, "auth.json"), '{"token":"fixture"}');
  const requests: Fixture["requests"] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", async () => {
      requests.push({ url: request.url, method: request.method, body });
      await classifier.onRequest?.();
      if (classifier.mode === "hang") {
        // Hang means never respond; cancellation is the client's abort.
        request.resume();
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
      response.end(JSON.stringify({ answers: { route: { type: "choice", choice: classifier.choice ?? "balanced" } },
        ...(classifier.usage !== undefined ? { usage: classifier.usage } : {}) }));
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
  await executableFixture(join(bin, "codex"), CODEX_SCRIPT, "node");
  if (options.git !== false) {
    await executableFixture(join(bin, "git"), GIT_SCRIPT, "shell");
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

const readWorkerFile = (f: Fixture, name: string): Promise<string> => readFile(join(f.bin, name), "utf8");

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

test("doctor --probe sends exactly one synthetic request to the eligible backend", async t => {
  const f = await fixture(t);
  assert.equal((await f.run(["init"])).code, 0);
  const result = await f.run(["doctor", "--probe", "--json"]);
  assert.equal(result.code, 0);
  assert.equal(f.requests.length, 1, "exactly one probe for the one eligible backend");
  assert.equal(f.requests[0].url, "/v1/systemone");
  const report = JSON.parse(result.stdout) as { code: number; checks: { id: string; status: string }[] };
  assert.equal(report.code, 0);
  const byId = new Map(report.checks.map(check => [check.id, check.status]));
  assert.equal(byId.get("backend.laya"), "pass");
  assert.equal(byId.get("backend.jev"), "skipped", "disabled Jev is not probed");
  assert.equal(await workerRecords(f).then(records => records.runs), 0, "doctor never starts a worker");
});

// The owned inspection is gone within its bounded TERM-grace + close window;
// the fixture pid is only killed in finally, after the assertion had its
// chance to fail.
const assertInspectionStopped = async (bin: string): Promise<void> => {
  const pid = Number(await readFile(join(bin, "inspection-pid"), "utf8"));
  try {
    const deadline = Date.now() + 2500;
    let alive = true;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; break; }
      await sleep(50);
    }
    assert.equal(alive, false, "the owned inspection must not survive the parent signal");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
};

for (const [name, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`doctor stops the live bounded inspection on ${name}`, async t => {
    const f = await fixture(t);
    const child = f.spawn(["doctor", "--json"], { env: { TEST_CODEX_INSPECTION_HANG: "1" } });
    const pending = capture(child);
    await until(() => existsSync(join(f.bin, "inspection-pid")), "the live inspection");
    child.kill(name);
    const result = await pending;
    await assertInspectionStopped(f.bin);
    assert.equal(result.code, expectedCode);
    assert.equal(await workerRecords(f).then(records => records.runs), 0);
  });
}

for (const [name, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`doctor --probe aborts a hanging probe on ${name}`, async t => {
    const f = await fixture(t, { mode: "hang" });
    const child = f.spawn(["doctor", "--probe", "--json"]);
    const pending = capture(child);
    await until(() => f.requests.length === 1, "the probe request");
    const started = Date.now();
    child.kill(name);
    const result = await pending;
    assert.equal(result.code, expectedCode);
    assert.ok(Date.now() - started < 3500, "the probe aborts instead of running out its budget");
    const report = JSON.parse(result.stdout) as { checks: { id: string; status: string }[] };
    const byId = new Map(report.checks.map(check => [check.id, check.status]));
    assert.equal(byId.get("backend.laya"), "unverified", "the cancelled probe is reported unverified");
  });
}

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
  assert.deepEqual(records.argv, ["exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
    "--config", "agents.enabled=false", "--model", "gpt-6.1-sol", "--config", 'model_reasoning_effort="medium"', "-"]);
  assert.equal(records.cwd, realpathSync(f.root));
  // The worker instruction is byte-exact task + fixed note (argument transport).
  assert.equal(records.task, TASK + "\n\n" + SANDBOX_SEMANTICS_NOTE);
  // The journal's task identity still describes the bare consumer task.
  const journal = JSON.parse(await readFile(join(f.root, ".turnhelm", "routes.jsonl"), "utf8")) as
    { taskSha256: string; taskBytes: number };
  assert.equal(journal.taskSha256, createHash("sha256").update(TASK).digest("hex"));
  assert.equal(journal.taskBytes, Buffer.byteLength(TASK));
  for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_CONFIG", "TURNHELM_ALLOW_HOSTED_JEV"]) {
    assert.equal(key in records.env, false, key + " must be stripped from the worker");
  }
  assert.equal(records.env.TURNHELM_MANAGED_CHILD, "1");
  assert.match(records.env.CODEX_HOME, /turnhelm-worker-[^/]+$/,
    "the worker runs under a fresh managed home");
  assert.notEqual(records.env.CODEX_HOME, f.codexHome,
    "the CLI process's own CODEX_HOME never reaches the worker");
  const receipt = parseReceipt(result.stderr);
  assert.equal(receipt.type, "turnhelm.receipt");
  assert.equal(receipt.root, realpathSync(f.root));
  const routing = receipt.routing as { status: string; routingMs: number;
    attempts: { backend: string; transportMode: string; outcome: string; durationMs: number }[];
    requestCounts: { laya: number; jev: number } };
  assert.equal(routing.status, "selected");
  assert.equal(typeof routing.routingMs, "number");
  assert.deepEqual(routing.attempts.map(attempt => ({ backend: attempt.backend, transportMode: attempt.transportMode, outcome: attempt.outcome })),
    [{ backend: "laya", transportMode: "direct", outcome: "success" }]);
  assert.deepEqual(routing.requestCounts, { laya: 1, jev: 0 });
  assert.deepEqual(receipt.selection, { backend: "laya", profileId: "balanced", model: "gpt-6.1-sol", effort: "medium" });
  const worker = receipt.worker as { status: string; code: number; durationMs: number; usage?: Record<string, number>;
    payload?: { mode: string; trailerBytes?: number }; instructionNote?: string; envBoundary?: string };
  assert.equal(worker.status, "completed");
  // The terminal event starts the owned ladder; the fake's voluntary exit
  // races the TERM, and the observed code is never a status input (TS-8).
  assert.ok(worker.code === 0 || worker.code === 143, "saw " + String(worker.code));
  assert.equal(typeof worker.durationMs, "number");
  assert.deepEqual(worker.usage, { input_tokens: 11, output_tokens: 7 });
  assert.deepEqual(worker.payload, { mode: "unstructured" });
  // The receipt carries the note's version tag, never its prose.
  assert.equal(worker.instructionNote, "sandbox-semantics-v1");
  // And the environment-boundary generation tag beside it.
  assert.equal(worker.envBoundary, "host-pointers-v1");
  // WB-4: the executed-worker receipt key set, with the managed-home
  // attestation, pinned exactly — modulo the voluntary-exit/TERM race that
  // conditionally adds "signal" (the code pin above allows both outcomes).
  assert.deepEqual(Object.keys(receipt.worker as object).sort().filter(key => key !== "signal"),
    ["code", "codexHomeManaged", "durationMs", "envBoundary", "instructionNote",
      "lastEventAgeMs", "ownedShutdown", "payload", "progressEvents", "status", "usage"]);
  assert.equal(receipt.classifierUsage, "unreported");
  assert.equal(receipt.wholeRunUsageScope, "unverified");
  assert.equal(JSON.stringify(receipt).includes(TASK), false, "the receipt never carries task text");
  assert.equal(JSON.stringify(receipt).includes("Sandbox semantics"), false,
    "the receipt carries the tag, never the note prose");
  assert.equal(records.runs, 1);
});

test("a guard-passing Laya usage reaches the receipt as classifierUsage", async t => {
  const f = await fixture(t, { choice: "balanced",
    usage: { truncated: false, state_tokens_dropped: 0, input_tokens: 412, output_tokens: 0, state_tokens: 620 } });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 0);
  const receipt = parseReceipt(result.stderr);
  assert.deepEqual(receipt.classifierUsage, { input_tokens: 412, state_tokens: 620 });
});

test("an uncredentialed run is refused before classification", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const emptyHome = await mkdtemp(join(tmpdir(), "turnhelm-cli-empty-home-"));
  t.after(() => rm(emptyHome, { recursive: true, force: true }));
  const refusal = await f.run(["run", TASK], { input: "", env: { CODEX_HOME: emptyHome } });
  assert.equal(refusal.code, 1);
  assert.equal(refusal.stderr, "turnhelm: no worker credential is discoverable; provide a CODEX_HOME auth.json or export OPENAI_API_KEY.\n");
  assert.ok(!refusal.stderr.includes("turnhelm.receipt"), "no receipt is emitted");
  assert.equal(f.requests.length, 0, "the classifier is never called");
  await assert.rejects(readFile(join(f.root, ".turnhelm", "routes.jsonl")), { code: "ENOENT" },
    "no journal line is appended");
  // Either source alone unblocks the run: the fixture's auth file…
  const byFile = await f.run(["run", TASK], { input: "" });
  assert.equal(byFile.code, 0, byFile.stderr);
  // …or an exported key against a credential-file-less home.
  const byKey = await f.run(["run", TASK], { input: "", env: { CODEX_HOME: emptyHome, OPENAI_API_KEY: "TEST_OPENAI_SENTINEL" } });
  assert.equal(byKey.code, 0, byKey.stderr);
});

test("run --output-schema stages validated bytes inside the managed home", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const schema = JSON.stringify({ type: "object", properties: { selected: { type: "string" } }, marker: "validated" });
  const schemaPath = join(f.root, "schema.json");
  await writeFile(schemaPath, schema);
  const result = await f.run(["run", "--output-schema", schemaPath, TASK], { input: "" });
  assert.equal(result.code, 0, result.stderr);
  const records = await workerRecords(f);
  const flag = records.argv.indexOf("--output-schema");
  assert.ok(flag !== -1, "the worker argv carries the schema flag");
  assert.match(records.argv[flag + 1], /turnhelm-worker-[^/]+\/output-schema\.json$/,
    "the argv points inside the managed home, never at the caller's path");
  assert.equal(JSON.parse(await readWorkerFile(f, "schema-bytes.json")), schema,
    "the staged file carries the validated bytes verbatim");
  const eqForm = await f.run(["run", "--output-schema=" + schemaPath, TASK], { input: "" });
  assert.equal(eqForm.code, 0, eqForm.stderr);
  assert.equal(JSON.parse(await readWorkerFile(f, "schema-bytes.json")), schema,
    "the = form stages the same bytes");
  const duplicate = await f.run(["run", "--output-schema", schemaPath, "--output-schema", schemaPath, TASK], { input: "" });
  assert.equal(duplicate.code, 2);
  assert.ok(duplicate.stderr.startsWith("turnhelm: usage:"), "duplicates are usage errors");
});

test("an invalid output schema is a fixed usage error before any classification", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const real = join(f.root, "real-schema.json");
  await writeFile(real, '{"type":"object"}');
  const link = join(f.root, "schema-link.json");
  await symlink(real, link);
  const notUtf8 = join(f.root, "bad-utf8.json");
  await writeFile(notUtf8, Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  const oversized = join(f.root, "big.json");
  await writeFile(oversized, '{"pad":"' + "a".repeat(64 * 1024 - 9) + '"}');
  const cases: { name: string; path: string; line: string }[] = [
    { name: "missing file", path: join(f.root, "absent.json"),
      line: "turnhelm: the output schema path is not a readable regular file." },
    { name: "symlink", path: link,
      line: "turnhelm: the output schema path is not a readable regular file." },
    { name: "oversized", path: oversized,
      line: "turnhelm: the output schema exceeds the 65536-byte limit." },
    { name: "invalid UTF-8", path: notUtf8,
      line: "turnhelm: the output schema is not valid UTF-8." },
    { name: "bare true", path: join(f.root, "true.json"), line: "turnhelm: the output schema must be a single JSON object." }
  ];
  await writeFile(join(f.root, "true.json"), "true");
  await writeFile(join(f.root, "array.json"), "[1,2]");
  await writeFile(join(f.root, "number.json"), "42");
  await writeFile(join(f.root, "broken.json"), "{oops");
  cases.push(
    { name: "array", path: join(f.root, "array.json"), line: "turnhelm: the output schema must be a single JSON object." },
    { name: "number", path: join(f.root, "number.json"), line: "turnhelm: the output schema must be a single JSON object." },
    { name: "invalid JSON", path: join(f.root, "broken.json"), line: "turnhelm: the output schema must be a single JSON object." });
  for (const invalid of cases) {
    const result = await f.run(["run", "--output-schema", invalid.path, TASK], { input: "" });
    assert.equal(result.code, 2, invalid.name + " must be a usage error");
    assert.equal(result.stderr, invalid.line + "\n", invalid.name + " prints exactly the fixed diagnostic");
    assert.ok(!result.stderr.includes("turnhelm.receipt"), invalid.name + " emits no receipt");
    assert.equal(f.requests.length, 0, invalid.name + " never reaches the classifier");
    await assert.rejects(readFile(join(f.root, ".turnhelm", "routes.jsonl")), { code: "ENOENT" },
      invalid.name + " appends no journal line");
  }
});

for (const mode of ["mutate", "replace", "delete", "symlink-swap"] as const) {
  test(`the staged schema bytes the worker reads survive caller-file ${mode}`, async t => {
    const schema = JSON.stringify({ type: "object", properties: { selected: { type: "string" } }, marker: "validated" });
    let schemaPath = "";
    const f = await fixture(t, {
      choice: "balanced",
      // OC-1 TOCTOU: the tamper fires from the classifier's request hook —
      // after the CLI validated the file, before the worker exists.
      onRequest: async () => {
        if (mode === "mutate") await writeFile(schemaPath, '{"tampered":true}');
        else if (mode === "replace") { await rm(schemaPath); await writeFile(schemaPath, '{"replaced":true}'); }
        else if (mode === "delete") await rm(schemaPath);
        else { await rm(schemaPath); await symlink("/etc/hostname", schemaPath); }
      }
    });
    schemaPath = join(f.root, "schema.json");
    await writeFile(schemaPath, schema);
    const result = await f.run(["run", "--output-schema", schemaPath, TASK], { input: "" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readWorkerFile(f, "schema-bytes.json")), schema,
      "the staged bytes remain exactly the validated ones");
  });
}

// The review-fix regressions: each pins one boundary fault to its fail-closed
// shape. Shared helper: write the fault preload and run with it armed.
const faultEnv = async (f: Fixture, fault: string, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> => {
  const preload = join(f.bin, "fault.cjs");
  await writeFile(preload, FAULT_PRELOAD);
  return { TURNHELM_TEST_FAULT: fault, NODE_OPTIONS: "--require " + preload, ...extra };
};

test("a credential-symlink setup fault fails the run closed", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const result = await f.run(["run", TASK], { input: "", env: await faultEnv(f, "symlink") });
  assert.equal(result.code, 1, result.stderr);
  const receipt = parseReceipt(result.stderr);
  assert.equal((receipt.worker as { status: string }).status, "failed");
  assert.equal(await workerRecords(f).then(records => records.runs), 0, "no worker may launch without its credential link");
  assert.equal(f.requests.length, 1, "classification already spent; only the worker is refused");
  const worker = receipt.worker as { instructionNote?: string; envBoundary?: string };
  assert.equal(worker.instructionNote, undefined);
  assert.equal(worker.envBoundary, undefined);
});

test("a schema-staging fault fails closed and leaves no managed home", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const leakDir = await mkdtemp(join(tmpdir(), "turnhelm-cli-leak-"));
  t.after(() => rm(leakDir, { recursive: true, force: true }));
  const schemaPath = join(f.root, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  const result = await f.run(["run", "--output-schema", schemaPath, TASK],
    { input: "", env: await faultEnv(f, "staging", { TMPDIR: leakDir }) });
  assert.equal(result.code, 1, result.stderr);
  assert.equal((parseReceipt(result.stderr).worker as { status: string }).status, "failed");
  assert.equal(await workerRecords(f).then(records => records.runs), 0, "no worker launched");
  assert.deepEqual(await readdir(leakDir), [], "the partial home is removed, never leaked");
  const staged = parseReceipt(result.stderr).worker as { instructionNote?: string; envBoundary?: string };
  assert.equal(staged.instructionNote, undefined);
  assert.equal(staged.envBoundary, undefined);
});

test("a synchronous worker-spawn fault settles as one failed receipt with no home leaked", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const leakDir = await mkdtemp(join(tmpdir(), "turnhelm-cli-leak-"));
  t.after(() => rm(leakDir, { recursive: true, force: true }));
  const result = await f.run(["run", TASK], { input: "", env: await faultEnv(f, "spawn", { TMPDIR: leakDir }) });
  assert.equal(result.code, 1, result.stderr);
  const receipt = parseReceipt(result.stderr);
  assert.equal((receipt.worker as { status: string }).status, "failed");
  assert.deepEqual(await readdir(leakDir), [], "the managed home is destroyed on the spawn-fault path");
  // The worker never reached its stdin, so no instruction or boundary attestation.
  const worker = receipt.worker as { instructionNote?: string; envBoundary?: string };
  assert.equal(worker.instructionNote, undefined);
  assert.equal(worker.envBoundary, undefined);
});

test("an asynchronous worker-spawn fault is an executed worker carrying both attestations", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const result = await f.run(["run", TASK], { input: "", env: await faultEnv(f, "spawn-async") });
  assert.equal(result.code, 1, result.stderr);
  const receipt = parseReceipt(result.stderr);
  const worker = receipt.worker as { status: string; instructionNote?: string; envBoundary?: string; failureClass?: string };
  assert.equal(worker.status, "failed");
  // Pipes existed and the instruction was written before ENOENT arrived, so
  // both mechanism attestations ride the executed-worker receipt.
  assert.equal(worker.instructionNote, "sandbox-semantics-v1");
  assert.equal(worker.envBoundary, "host-pointers-v1");
});

test("a schema read fault is the fixed usage error, not an internal failure", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const schemaPath = join(f.root, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  const result = await f.run(["run", "--output-schema", schemaPath, TASK],
    { input: "", env: await faultEnv(f, "readsync") });
  assert.equal(result.code, 2, "a descriptor-level read fault keeps the usage-error contract");
  assert.equal(result.stderr, "turnhelm: the output schema path is not a readable regular file.\n");
  assert.equal(f.requests.length, 0);
});

test("a FIFO output schema path is a fixed usage error, never a hang", { timeout: 20_000 }, async t => {
  const f = await fixture(t, { choice: "balanced" });
  const fifo = join(f.root, "schema.fifo");
  const maker = spawn("mkfifo", [fifo]);
  await new Promise<void>((resolve, reject) => maker.on("close", code => code === 0 ? resolve() : reject(new Error("mkfifo exited " + code))));
  const child = f.spawn(["run", "--output-schema", fifo, TASK], { input: "" });
  const outcome = capture(child);
  // Raw spawn leaves stdin open; readTask waits on it, not the FIFO. Close it
  // so the watchdog observes only the schema-open behavior.
  child.stdin?.end("");
  // A blocking open would wedge the event loop past every signal handler;
  // the watchdog turns that hang into a visible failure.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const result = await outcome;
  clearTimeout(watchdog);
  assert.equal(result.code, 2, "a FIFO is rejected as a usage error instead of blocking the open");
  assert.equal(result.stderr, "turnhelm: the output schema path is not a readable regular file.\n");
  assert.equal(f.requests.length, 0);
});

test("a credential source that is not a regular file is refused", async t => {
  const f = await fixture(t);
  await rm(join(f.codexHome, "auth.json"));
  await mkdir(join(f.codexHome, "auth.json"));
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "turnhelm: no worker credential is discoverable; provide a CODEX_HOME auth.json or export OPENAI_API_KEY.\n");
  assert.equal(f.requests.length, 0, "the classifier is never called");
});

test("a whitespace-only API key is not a credential", async t => {
  const f = await fixture(t, { choice: "balanced" });
  const emptyHome = await mkdtemp(join(tmpdir(), "turnhelm-cli-empty-home-"));
  t.after(() => rm(emptyHome, { recursive: true, force: true }));
  const result = await f.run(["run", TASK], { input: "", env: { CODEX_HOME: emptyHome, OPENAI_API_KEY: "   " } });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "turnhelm: no worker credential is discoverable; provide a CODEX_HOME auth.json or export OPENAI_API_KEY.\n");
  assert.equal(f.requests.length, 0, "the classifier is never called");
});

test("a relative CODEX_HOME still links an absolute credential source", async t => {
  const f = await fixture(t, { choice: "balanced" });
  await mkdir(join(f.root, "codex-home"));
  await writeFile(join(f.root, "codex-home", "auth.json"), '{"token":"fixture"}');
  const result = await f.run(["run", TASK], { input: "", env: { CODEX_HOME: "codex-home" } });
  assert.equal(result.code, 0, result.stderr);
  const link = await readWorkerFile(f, "authlink.txt");
  assert.ok(isAbsolute(link), "the credential symlink target is absolute, got " + JSON.stringify(link));
  // The child's cwd is the physical path (macOS resolves /var symlinkage),
  // so the expectation must resolve through it too.
  assert.equal(link, resolve(realpathSync(f.root), "codex-home", "auth.json"));
});

test("run --write selects workspace-write", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", "--write", TASK], { input: "" });
  assert.equal(result.code, 0);
  const records = await workerRecords(f);
  assert.ok(records.argv.includes("workspace-write"), "the write sandbox mode is selected");
});

test("max effort is selected by difficulty alone with no max flag", async t => {
  const f = await fixture(t, { choice: "frontier_max" });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 0);
  const records = await workerRecords(f);
  assert.deepEqual(records.argv, ["exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
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
  assert.equal((await workerRecords(f)).task, "--write\n\n" + SANDBOX_SEMANTICS_NOTE);
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

test("a task piped on stdin reaches the worker byte-exact with the fixed note", async t => {
  const f = await fixture(t);
  const result = await f.run(["run"], { input: TASK });
  assert.equal(result.code, 0);
  // Stdin transport: the worker still receives task + fixed note, and the
  // classifier alone saw the bare task.
  assert.equal(f.requests.length, 1);
  assert.equal((JSON.parse(f.requests[0].body) as { state: string }).state, TASK);
  assert.equal(await workerRecords(f).then(records => records.task), TASK + "\n\n" + SANDBOX_SEMANTICS_NOTE);
  const worker = parseReceipt(result.stderr).worker as { instructionNote?: string };
  assert.equal(worker.instructionNote, "sandbox-semantics-v1");
});

test("the stall-abort flag validates strictly", async t => {
  const f = await fixture(t);
  for (const args of [
    ["--stall-abort-ms"],                                  // value is the task: non-integer
    ["--stall-abort-ms="],                                 // empty =-form value
    ["--stall-abort-ms", "abc"],                           // non-integer
    ["--stall-abort-ms", "4999"],                          // below range
    ["--stall-abort-ms", "3600001"],                       // above range
    ["--stall-abort-ms", "5000", "--stall-abort-ms", "6000"], // duplicate
    ["--stall-abort-ms", "5000.5"]                         // non-integer
  ]) {
    const result = await f.run(["run", ...args, TASK], { input: "" });
    assert.equal(result.code, 2, JSON.stringify(args) + " must be a usage error");
    assert.equal(f.requests.length, 0);
  }
  // A trailing flag with nothing after it is the missing-value form.
  const trailing = await f.run(["run", TASK, "--stall-abort-ms"], { input: "" });
  assert.equal(trailing.code, 2);
});

test("a valid stall-abort value arms without firing on a prompt worker", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", "--stall-abort-ms", "5000", TASK], { input: "" });
  assert.equal(result.code, 0);
  const worker = parseReceipt(result.stderr).worker as { status: string; abortReason?: string };
  assert.equal(worker.status, "completed");
  assert.equal(worker.abortReason, undefined);
  const eqForm = await f.run(["run", "--stall-abort-ms=5000", TASK], { input: "" });
  assert.equal(eqForm.code, 0);
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
  assert.equal(result.stdout, "");
  const receipt = parseReceipt(result.stderr);
  assert.deepEqual(receipt.worker, {
    status: "failed",
    code: 0,
    durationMs: (receipt.worker as { durationMs: number }).durationMs,
    progressEvents: 1,
    lastEventAgeMs: (receipt.worker as { lastEventAgeMs?: number }).lastEventAgeMs,
    usage: "unreported",
    ownedShutdown: false,
    codexHomeManaged: true,
    instructionNote: "sandbox-semantics-v1",
    envBoundary: "host-pointers-v1",
    failureClass: "unknown"
  });
});

test("a nonzero worker exit after the terminal event stays an observation", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", TASK], { input: "", env: { TEST_CODEX_EXIT: "7" } });
  assert.equal(result.code, 0, "a decided run exits zero regardless of the observed child code");
  const worker = parseReceipt(result.stderr).worker as { status: string; code?: number };
  assert.equal(worker.status, "completed");
  assert.ok(worker.code === 7 || worker.code === 143, "the fake's exit races the ladder's TERM, saw " + String(worker.code));
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

test("parent stdout EPIPE cancels the worker and exits 1", async t => {
  const f = await fixture(t);
  const child = f.spawn(["run", TASK]);
  const pending = capture(child);
  // The CLI writes stdout only at settlement, so the destroyed parent pipe
  // makes the final write fail.
  child.stdout?.destroy();
  child.stdin?.end("");
  const result = await pending;
  assert.equal(result.code, 1);
  assert.equal(await workerRecords(f).then(records => records.runs), 1);
  const receipt = parseReceipt(result.stderr);
  assert.equal((receipt.worker as { status: string }).status, "failed");
  assert.equal(result.stderr.includes("EPIPE"), false, "no native error text on stderr");
});

test("receipt and journal retain only finite failure fields", async t => {
  const f = await fixture(t, { mode: "http-error" });
  const result = await f.run(["run", TASK], { input: "" });
  assert.equal(result.code, 1);
  const receipt = parseReceipt(result.stderr);
  const routing = receipt.routing as { status: string;
    attempts: { backend: string; outcome: string; failure?: Record<string, unknown> }[] };
  assert.equal(routing.status, "failed");
  assert.deepEqual(routing.attempts.map(attempt => [attempt.backend, attempt.outcome, attempt.failure]),
    [["laya", "failed", { kind: "http", httpStatus: 500, code: null }]]);
  const journal = JSON.parse(await readFile(join(f.root, ".turnhelm", "routes.jsonl"), "utf8")) as
    { attempts: unknown[] };
  assert.deepEqual(journal.attempts, routing.attempts);
  const text = JSON.stringify(receipt) + JSON.stringify(journal) + result.stderr;
  assert.equal(text.includes("CLASSIFIER-BODY-SENTINEL"), false, "the classifier body must not leak");
  assert.equal(text.includes("dummy-laya-key"), false, "credentials must not leak");
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
  assert.deepEqual(receipt.worker, { status: "not-started", durationMs: 0, progressEvents: 0, usage: "unreported" });
  assert.equal(receipt.classifierUsage, "unreported");
  assert.equal(receipt.wholeRunUsageScope, "unverified");
  assert.equal(await workerRecords(f).then(records => records.runs), 0);
});

test("a completed run without usage reports it explicitly unreported", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", TASK], { input: "", env: { TEST_CODEX_OMIT_USAGE: "1" } });
  assert.equal(result.code, 0);
  const receipt = parseReceipt(result.stderr);
  // The ladder ends the decided run; code/signal are open observations, so
  // they are normalized out of the deep-equal and pinned separately (TS-8).
  const { code, signal, ...workerRest } = receipt.worker as Record<string, unknown>;
  assert.deepEqual(workerRest, {
    status: "completed",
    durationMs: (receipt.worker as { durationMs: number }).durationMs,
    progressEvents: 2,
    lastEventAgeMs: (receipt.worker as { lastEventAgeMs?: number }).lastEventAgeMs,
    usage: "unreported",
    payload: { mode: "unstructured" },
    ownedShutdown: true,
    codexHomeManaged: true,
    instructionNote: "sandbox-semantics-v1",
    envBoundary: "host-pointers-v1"
  });
  assert.ok(code === 0 || (code === 143 && signal === "SIGTERM"),
    "voluntary exit zero or the ladder's TERM, saw " + code + "/" + String(signal));
  assert.equal(receipt.classifierUsage, "unreported");
  assert.equal(receipt.wholeRunUsageScope, "unverified");
});

test("a completed run settles at the terminal event with an unchanged receipt shape", async t => {
  const f = await fixture(t);
  const result = await f.run(["run", TASK], { input: "", env: { TEST_CODEX_LINGER: "1" } });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, AGENT_MESSAGE + "\n");
  const receipt = parseReceipt(result.stderr);
  const worker = receipt.worker as Record<string, unknown>;
  // The key set is pinned exactly: terminal-event settlement adds no field (TS-7).
  assert.deepEqual(Object.keys(worker).sort(),
    ["code", "codexHomeManaged", "durationMs", "envBoundary", "instructionNote", "lastEventAgeMs", "ownedShutdown", "payload", "progressEvents", "signal", "status", "usage"]);
  assert.equal(worker.status, "completed");
  assert.equal(worker.ownedShutdown, true, "the terminal event starts the owned ladder");
  assert.equal(worker.signal, "SIGTERM");
  assert.ok(typeof worker.durationMs === "number" && worker.durationMs < 5000,
    "ladder-bounded, saw " + String(worker.durationMs));
});

test("an envelope-shaped final message yields the payload line and a bounded receipt projection", async t => {
  const trailer = "trailer prose here";
  const f = await fixture(t);
  const result = await f.run(["run", TASK], { input: "", env: { TEST_CODEX_MESSAGE: '{"count":1,"sum":2}\n' + trailer } });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"count":1,"sum":2}\n');
  const receipt = parseReceipt(result.stderr);
  const worker = receipt.worker as { status: string; payload?: { mode: string; trailerBytes?: number } };
  assert.equal(worker.status, "completed");
  assert.deepEqual(worker.payload, { mode: "extracted", trailerBytes: Buffer.byteLength(trailer, "utf8") });
  assert.equal(JSON.stringify(receipt).includes(trailer), false, "the receipt retains no trailer content");
});

for (const [name, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`a live worker cancelled by ${name} exits ${expectedCode} with one sanitized receipt`, async t => {
    const f = await fixture(t);
    const child = f.spawn(["run", TASK], { env: { TEST_CODEX_MODE: "hang" } });
    const pending = capture(child);
    child.stdin?.end("");
    await until(() => existsSync(join(f.bin, "ready")), "the live worker");
    child.kill(name);
    const result = await pending;
    assert.equal(result.code, expectedCode);
    const receipt = parseReceipt(result.stderr);
    assert.deepEqual(receipt.worker, {
      status: "cancelled",
      code: (receipt.worker as { code: number }).code,
      durationMs: (receipt.worker as { durationMs: number }).durationMs,
      // The hang fixture never emits an event: zero decoded events, no age.
      progressEvents: 0,
      usage: "unreported",
      // Cancellation runs the parent-owned ladder; the worker dies by our TERM.
      ownedShutdown: true,
      codexHomeManaged: true,
      instructionNote: "sandbox-semantics-v1",
      envBoundary: "host-pointers-v1",
      signal: "SIGTERM"
    });
    assert.equal((await workerRecords(f)).runs, 1);
    const pid = Number(await readFile(join(f.bin, "pid"), "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, "the owned worker must not survive cancellation");
  });
}

test("the worker sees the environment as it was before classification", async t => {
  const f = await fixture(t);
  const preload = join(f.bin, "envflip.js");
  await writeFile(preload, ENVFLIP_SCRIPT);
  const result = await f.run(["run", TASK], {
    input: "",
    env: { NODE_OPTIONS: `--require ${preload}`, ROOT_SNAPSHOT_TAG: "before" }
  });
  assert.equal(result.code, 0);
  assert.equal(f.requests.length, 1, "classification still runs exactly once");
  assert.equal(await workerRecords(f).then(records => records.env.ROOT_SNAPSHOT_TAG), "before");
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
  child.stdin?.end("");
  await until(() => f.requests.length === 1, "the classifier request");
  child.kill("SIGINT");
  const result = await pending;
  assert.equal(result.code, 130);
  const receipt = parseReceipt(result.stderr);
  assert.equal((receipt.routing as { status: string }).status, "cancelled");
  assert.equal((receipt.routing as { attempts: { outcome: string }[] }).attempts[0].outcome, "cancelled");
  assert.equal(receipt.classifierUsage, "unreported");
  assert.equal("selection" in receipt, false);
  assert.deepEqual(receipt.worker, { status: "not-started", durationMs: 0, progressEvents: 0, usage: "unreported" });
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
