import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROFILE_IDS, type ProfileId, type ProjectConfig } from "../src/config.js";
import type { TaskDecision } from "../src/route.js";
import { buildWorkerArgs, subprocessEnvironment, workerEnvironment } from "../src/codex.js";
import { fixtureConfig } from "./fixtures.js";

const execute = promisify(execFile);
const config: ProjectConfig = fixtureConfig();

const decision = (profileId: ProfileId): TaskDecision => ({
  backend: "laya",
  profileId,
  profile: config.profiles[profileId],
  attempts: [],
  routingMs: 1
});

// The only executable on PATH is our temporary Node fixture; no real Codex can run.
const FAKE_PREAMBLE = `
const fs = require("node:fs");
const path = require("node:path");
const here = __dirname;
fs.writeFileSync(path.join(here, "runs"), (fs.existsSync(path.join(here, "runs")) ? fs.readFileSync(path.join(here, "runs"), "utf8") : "") + "1");
fs.writeFileSync(path.join(here, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(here, "cwd.txt"), process.cwd());
fs.writeFileSync(path.join(here, "env.json"), JSON.stringify(process.env));
let taskText = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { taskText += chunk; });
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const finish = body => process.stdin.on("end", () => { fs.writeFileSync(path.join(here, "task.txt"), taskText); body(); });
`;

const stubbornChild = `process.on('SIGTERM', function () {}); setInterval(function () {}, 500);`;

type OutputMode = "stdout" | "blocker-drain" | "blocker-stall" | "blocker-epipe";

type WorkerScenario = {
  script?: string;
  task?: string;
  profileId?: ProfileId;
  write?: boolean;
  abortBeforeCall?: boolean;
  abortAfterMs?: number;
  output?: OutputMode;
  drainDelayMs?: number;
};

type Recorded = {
  code?: number;
  status?: string;
  durationMs?: number;
  usageScope?: string;
  usage?: Record<string, number>;
  error?: string;
  received?: number;
  maxPending?: number;
  harnessError?: string;
};

async function runWorker(t: TestContext, scenario: WorkerScenario): Promise<{ recorded: Recorded; stdout: string; stderr: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (scenario.script !== undefined) {
    await writeFile(join(directory, "codex"), "#!" + process.execPath + "\n" + FAKE_PREAMBLE + scenario.script, { mode: 0o700 });
  }
  const root = join(directory, "root");
  await mkdir(root, { recursive: true });
  const moduleUrl = new URL("../src/codex.js", import.meta.url).href;
  const resultFile = join(directory, "result.json");
  const output = scenario.output ?? "stdout";
  const inner = `
    import { writeFile } from "node:fs/promises";
    import { Writable } from "node:stream";
    import { executeWorker } from ${JSON.stringify(moduleUrl)};
    const decision = ${JSON.stringify(decision(scenario.profileId ?? "balanced"))};
    const controller = new AbortController();
    ${scenario.abortBeforeCall ? "controller.abort();" : ""}
    ${scenario.abortAfterMs !== undefined ? `const abortTimer = setTimeout(() => controller.abort(), ${scenario.abortAfterMs}); abortTimer.unref();` : ""}
    let received = 0;
    let pending = 0;
    let maxPending = 0;
    let output;
    ${output === "stdout" ? "output = process.stdout;" : `
    output = new Writable({
      highWaterMark: 0,
      write(_chunk, _encoding, callback) {
        received += 1;
        pending += 1;
        maxPending = Math.max(maxPending, pending);
        ${output === "blocker-drain" ? `setTimeout(() => { pending -= 1; callback(); }, ${scenario.drainDelayMs ?? 30});` : ""}
      }
    });
    ${output === "blocker-epipe" ? `setTimeout(() => output.destroy(new Error("EPIPE")), 300);` : ""}`}
    try {
      const result = await executeWorker(decision, ${JSON.stringify(scenario.task ?? "the original task")}, {
        executable: "codex",
        root: ${JSON.stringify(root)},
        write: ${scenario.write ?? false},
        env: process.env,
        signal: controller.signal,
        output
      });
      await writeFile(resultFile, JSON.stringify({ ...result, received, maxPending }));
    } catch (error) {
      await writeFile(resultFile, JSON.stringify({ harnessError: error instanceof Error ? error.message : String(error) }));
    }
  `;
  const run = await execute(process.execPath, ["--input-type=module", "--eval", inner], {
    env: { ...process.env, PATH: directory, CODEX_HOME: join(directory, "codex-home") },
    timeout: 20_000
  });
  const recorded = JSON.parse(await readFile(resultFile, "utf8")) as Recorded;
  assert.equal(recorded.harnessError, undefined);
  return { recorded, stdout: run.stdout, stderr: run.stderr, directory };
}

const fakeFile = async (directory: string, name: string): Promise<string> => readFile(join(directory, name), "utf8");

const forbid = (haystack: string, ...needles: string[]): void => {
  for (const needle of needles) assert.ok(!haystack.includes(needle), "raw source leaked: " + needle);
};

const waitForExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const alive = await new Promise<boolean>(resolve => {
      try {
        process.kill(pid, 0);
        resolve(true);
      } catch (error) {
        resolve((error as NodeJS.ErrnoException).code !== "ESRCH");
      }
    });
    if (!alive) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("owned group member survived the TERM-then-KILL grace");
};

for (const profileId of PROFILE_IDS) {
  test(`buildWorkerArgs pins ${profileId} model and effort exactly for both sandboxes`, () => {
    const decisionValue = decision(profileId);
    assert.deepEqual(buildWorkerArgs(decisionValue, false), [
      "exec", "--ephemeral", "--json", "--sandbox", "read-only",
      "--config", "agents.enabled=false", "--model", decisionValue.profile.model,
      "--config", `model_reasoning_effort=${JSON.stringify(decisionValue.profile.effort)}`, "-"
    ]);
    assert.deepEqual(buildWorkerArgs(decisionValue, true), [
      "exec", "--ephemeral", "--json", "--sandbox", "workspace-write",
      "--config", "agents.enabled=false", "--model", decisionValue.profile.model,
      "--config", `model_reasoning_effort=${JSON.stringify(decisionValue.profile.effort)}`, "-"
    ]);
  });
}

test("subprocess environment strips classifier credentials while preserving Codex auth", () => {
  const env = subprocessEnvironment({
    LAYA_API_KEY: "TEST_LAYA_SENTINEL",
    TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
    TURNHELM_ALLOW_HOSTED_JEV: "1",
    TURNHELM_CONFIG: "/tmp/turnhelm.json",
    CODEX_HOME: "/tmp/codex",
    PATH: "/bin"
  });
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.PATH, "/bin");
});

test("worker environment additionally marks the managed child", () => {
  const env = workerEnvironment({ TYPESAFE_API_KEY: "TEST_JEV_SENTINEL", CODEX_HOME: "/tmp/codex" });
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
});

test("one worker run binds decision, root, stdin task, and sanitized environment", { timeout: 30_000 }, async t => {
  const task = "Fix the pago row\n第二行 ✓";
  const { recorded, stdout, stderr, directory } = await runWorker(t, {
    profileId: "balanced",
    task,
    write: true,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 5 } });
});
`
  });
  assert.equal(typeof recorded.durationMs, "number");
  assert.deepEqual({ ...recorded, durationMs: 0 }, {
    code: 0,
    status: "completed",
    durationMs: 0,
    usage: { input_tokens: 12, output_tokens: 5 },
    usageScope: "unverified",
    received: 0,
    maxPending: 0
  });
  assert.equal(await fakeFile(directory, "argv.json"), JSON.stringify(buildWorkerArgs(decision("balanced"), true)));
  assert.equal(await fakeFile(directory, "cwd.txt"), join(directory, "root"));
  assert.equal(await fakeFile(directory, "task.txt"), task);
  assert.equal(await fakeFile(directory, "runs"), "1");
  const env = JSON.parse(await fakeFile(directory, "env.json")) as Record<string, string>;
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.CODEX_HOME, join(directory, "codex-home"));
  assert.equal(env.PATH, directory);
  assert.ok(stdout.includes("worker result\n"));
  assert.equal(stderr, "");
});

test("exit zero without a completion is a worker failure", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, { script: "finish(() => {});\n" });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 0);
});

test("turn.failed stops the owned group even when the leader exits zero", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
finish(() => {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });
  fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
  emit({ type: "turn.failed" });
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 0);
  assert.equal(await fakeFile(directory, "runs"), "1");
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("an error event is a fixed diagnostic and cannot undo a later completion", { timeout: 30_000 }, async t => {
  const { recorded, stdout, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL", stack: "TEST_PRIVATE_STACK_SENTINEL" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "recovered" } });
  emit({ type: "turn.completed", usage: { input_tokens: 4 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.error, undefined);
  assert.deepEqual(recorded.usage, { input_tokens: 4 });
  forbid(JSON.stringify(recorded) + stdout + stderr, "TEST_PRIVATE_ERROR_SENTINEL", "TEST_PRIVATE_STACK_SENTINEL");
  assert.equal(stderr, "");
});

test("tool progress never relays commands or outputs", { timeout: 30_000 }, async t => {
  const { recorded, stdout, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "command_execution", command: "cat TEST_PRIVATE_TOOL_SENTINEL", aggregated_output: "TEST_PRIVATE_OUTPUT_SENTINEL", exit_code: 0 } });
  emit({ type: "turn.completed", usage: { output_tokens: 2 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { output_tokens: 2 });
  forbid(JSON.stringify(recorded) + stdout + stderr, "TEST_PRIVATE_TOOL_SENTINEL", "TEST_PRIVATE_OUTPUT_SENTINEL");
});

test("repeated completions keep the latest usage snapshot, never a sum", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  emit({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { input_tokens: 20, output_tokens: 8 });
});

test("input-only and output-only snapshots are retained without mixing fields", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 7 } });
  emit({ type: "turn.completed", usage: { output_tokens: 9 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { output_tokens: 9 });
});

test("valid usage is retained when a later completion has only invalid counters", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: -1 } });
  emit({ type: "turn.completed", usage: { input_tokens: -5 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { input_tokens: 10 });
  assert.equal(recorded.usageScope, "unverified");
});

test("worker stderr is drained and never relayed", { timeout: 30_000 }, async t => {
  const { recorded, stdout, stderr } = await runWorker(t, {
    script: `
finish(() => {
  process.stderr.write("TEST_PRIVATE_STDERR_SENTINEL\\n");
  process.stderr.write("y".repeat(1024 * 1024));
  emit({ type: "item.completed", item: { type: "agent_message", text: "drained" } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.ok(stdout.includes("drained\n"));
  assert.equal(stderr, "");
  forbid(JSON.stringify(recorded) + stdout + stderr, "TEST_PRIVATE_STDERR_SENTINEL");
});

test("frames split across LF and UTF-8 boundaries reassemble", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  const payload = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "héllo wörld" } }));
  const splitAt = payload.indexOf(0xc3) + 1;
  process.stdout.write(payload.subarray(0, splitAt));
  setTimeout(() => {
    process.stdout.write(payload.subarray(splitAt));
    process.stdout.write(Buffer.from([0x0a]));
    setTimeout(() => {
      emit({ type: "turn.completed", usage: { input_tokens: 1 } });
    }, 20);
  }, 20);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.ok(stdout.includes("héllo wörld\n"));
});

test("an exact 1 MiB frame is ignored without failing the run", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  const prefix = JSON.stringify({ type: "future.event" });
  process.stdout.write(prefix + " ".repeat(1048576 - Buffer.byteLength(prefix)) + "\\n");
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.error, undefined);
});

test("an oversized frame fails the run without a rerun", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
process.stdout.write("x".repeat(1048577));
setTimeout(() => {}, 10000);
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "protocol");
  assert.equal(await fakeFile(directory, "runs"), "1");
});

test("malformed JSON fails the run without a rerun", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
finish(() => {
  process.stdout.write("{not json}\\n");
  setTimeout(() => {}, 10000);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "protocol");
  assert.equal(await fakeFile(directory, "runs"), "1");
});

test("a nonempty truncated final frame fails the run without a rerun", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
finish(() => {
  process.stdout.write("partial frame without newline");
  process.stdout.end();
  setTimeout(() => {}, 10000);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "protocol");
  assert.equal(await fakeFile(directory, "runs"), "1");
});

test("nonzero exit is a worker failure even with a completion", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
  process.exitCode = 3;
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 3);
});

test("the result settles at close, not when stdio ends", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "early output" } });
  emit({ type: "turn.completed", usage: { input_tokens: 2 } });
  process.stdout.end();
  setTimeout(() => { process.exitCode = 0; }, 400);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.ok((recorded.durationMs ?? 0) >= 300);
});

for (const exitCode of [7, 0]) {
  test(`early exit ${exitCode} without reading stdin is a failed stdin delivery`, { timeout: 30_000 }, async t => {
    const { recorded } = await runWorker(t, { script: `process.exitCode = ${exitCode};\n`, task: "x".repeat(100 * 1024) });
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.error, "stdin");
    assert.equal(recorded.code, exitCode);
  });
}

test("stdout backpressure queues one message at the sink while stderr drains", { timeout: 30_000 }, async t => {
  const { recorded, stdout, stderr } = await runWorker(t, {
    output: "blocker-drain",
    drainDelayMs: 30,
    script: `
finish(() => {
  process.stderr.write("TEST_PRIVATE_STDERR_SENTINEL\\n");
  process.stderr.write("y".repeat(512 * 1024));
  for (let i = 0; i < 20; i++) emit({ type: "item.completed", item: { type: "agent_message", text: "message-" + i } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.received, 20);
  assert.equal(recorded.maxPending, 1);
  for (let i = 0; i < 20; i++) assert.ok(stdout.includes("message-" + i + "\n"));
  forbid(JSON.stringify(recorded) + stdout + stderr, "TEST_PRIVATE_STDERR_SENTINEL");
});

test("cancellation interrupts a stalled drain wait", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "blocker-stall",
    abortAfterMs: 300,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  setInterval(() => {}, 1000);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.received, 1);
  assert.equal(recorded.maxPending, 1);
  assert.equal(stderr, "");
});

test("an output EPIPE interrupts the drain wait as an output failure", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    output: "blocker-epipe",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  setInterval(() => {}, 1000);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "output");
});

test("a TERM-ignoring worker is killed within the grace window", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    abortAfterMs: 200,
    script: `
process.on("SIGTERM", () => {});
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "stubborn" } });
  setInterval(() => {}, 250);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.code, 137);
  assert.ok((recorded.durationMs ?? 0) >= 900);
});

test("a leader exiting before a TERM-ignoring descendant cannot cancel the escalation", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    abortAfterMs: 100,
    script: `
finish(() => {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });
  fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
  setTimeout(() => {}, 300);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("a missing executable is a sanitized spawn failure", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {});
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "spawn");
  assert.equal(stderr, "");
});

test("descriptor-exhausted spawn fails without an unhandled process error", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-worker-fd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/codex.js", import.meta.url).href;
  const resultFile = join(directory, "result.json");
  const result = await execute("/bin/sh", ["-c", 'ulimit -n 64 && exec "$@"', "turnhelm-worker-fd",
    process.execPath, "--input-type=module", "--eval", `
      import { openSync, closeSync } from "node:fs";
      import { writeFile } from "node:fs/promises";
      import { executeWorker } from ${JSON.stringify(moduleUrl)};
      // Initialize lazy stdio handles before exhausting the local FD table.
      process.stdout.write("");
      process.stderr.write("");
      const descriptors = [];
      let recorded;
      try {
        try {
          while (true) descriptors.push(openSync("/dev/null", "r"));
        } catch (error) {
          if (error.code !== "EMFILE") throw error;
        }
        try {
          recorded = await executeWorker(${JSON.stringify(decision("fast"))}, "test task", {
            executable: "codex", root: ${JSON.stringify(directory)}, write: false,
            env: process.env, output: process.stdout
          });
        } catch (error) {
          recorded = { harnessError: error instanceof Error ? error.message : String(error) };
        }
      } finally {
        for (const descriptor of descriptors) closeSync(descriptor);
      }
      await writeFile(${JSON.stringify(resultFile)}, JSON.stringify(recorded));
    `], { env: { ...process.env, PATH: directory }, timeout: 20_000 });
  assert.equal(result.stderr, "");
  const recorded = JSON.parse(await readFile(resultFile, "utf8")) as Recorded;
  assert.equal(recorded.harnessError, undefined);
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "spawn");
});

test("an already-aborted signal cancels before spawning", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, { abortBeforeCall: true });
  assert.equal(recorded.status, "cancelled");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await readFile(join(directory, "runs"), "utf8").then(() => "spawned", () => "absent"), "absent");
});
