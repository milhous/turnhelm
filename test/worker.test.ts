import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROFILE_IDS, type ProfileId, type ProjectConfig } from "../src/config.js";
import type { TaskDecision } from "../src/route.js";
import { buildWorkerArgs, subprocessEnvironment, workerEnvironment } from "../src/codex.js";
import { MAX_EVENT_BYTES } from "../src/codex-events.js";
import { executableFixture } from "./executable-fixture.js";
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
// Scenarios that never call finish() leave stdin unread, which is what the
// failed-stdin-delivery regressions need.
const FAKE_PREAMBLE = `
const fs = require("node:fs");
const path = require("node:path");
const here = __dirname;
fs.writeFileSync(path.join(here, "boot"), String(Date.now()));
fs.writeFileSync(path.join(here, "runs"), (fs.existsSync(path.join(here, "runs")) ? fs.readFileSync(path.join(here, "runs"), "utf8") : "") + "1");
fs.writeFileSync(path.join(here, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(here, "cwd.txt"), process.cwd());
fs.writeFileSync(path.join(here, "env.json"), JSON.stringify({
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  ZDOTDIR: process.env.ZDOTDIR,
  TURNHELM_MANAGED_CHILD: process.env.TURNHELM_MANAGED_CHILD,
  LAYA_API_KEY: Object.hasOwn(process.env, "LAYA_API_KEY"),
  TYPESAFE_API_KEY: Object.hasOwn(process.env, "TYPESAFE_API_KEY"),
  TURNHELM_ALLOW_HOSTED_JEV: Object.hasOwn(process.env, "TURNHELM_ALLOW_HOSTED_JEV"),
  TURNHELM_CONFIG: Object.hasOwn(process.env, "TURNHELM_CONFIG")
}));
const ready = () => fs.writeFileSync(path.join(here, "ready"), "1");
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const finish = body => {
  let taskText = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { taskText += chunk; });
  process.stdin.on("end", () => { fs.writeFileSync(path.join(here, "task.txt"), taskText); body(); });
};
`;

const stubbornChild = `process.on('SIGTERM', function () {}); setInterval(function () {}, 500);`;

type Gate = "abort-ready" | "abort-received" | "epipe-received" | "abort-diag-late" | "abort-after-shutdown";

type OutputMode = "stdout" | "blocker" | "abort-in-write" | "abort-late-error" | "accepted-delay" | "accepted-error" | "accepted-stall";

type DiagMode = "stall" | "error" | "delay" | "delay-error" | "slow";

type TailSpec = { target: "output" | "diag"; hwm: 0 | 65536; action: "destroy-error" | "destroy-quiet"; delayMs?: number };

type WorkerScenario = {
  script?: string;
  bootstrap?: string;
  task?: string;
  taskRepeat?: number;
  profileId?: ProfileId;
  write?: boolean;
  parentEnv?: Record<string, string>;
  abortBeforeCall?: boolean;
  gate?: Gate;
  output?: OutputMode;
  drainDelayMs?: number;
  diag?: DiagMode;
  tailDelayMs?: number;
  lingerMs?: number;
  tail?: TailSpec;
  lateDestroy?: "error" | "quiet";
  trackFrameConcat?: boolean;
  trackKills?: boolean;
  settlementGuardMs?: number;
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
  emitted?: string;
  outputAcked?: boolean;
  diagAcked?: boolean;
  diagWrites?: number;
  diagMaxLength?: number;
  diagFinalLength?: number;
  tailWrites?: number;
  lateErrBefore?: number;
  lateErrAfter?: number;
  harnessError?: string;
  maxFrameConcatBytes?: number;
  abortAfterShutdownReached?: boolean;
  outputErrBefore?: number;
  outputErrAfter?: number;
  ownedShutdown?: boolean;
  failureClass?: string;
  errorSha256?: string;
  signal?: string;
  postSettleKills?: number;
};

async function runWorker(t: TestContext, scenario: WorkerScenario): Promise<{ recorded: Recorded; stdout: string; stderr: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (scenario.script !== undefined) {
    await executableFixture(join(directory, "codex"), (scenario.bootstrap ?? "") + FAKE_PREAMBLE + scenario.script, "node");
  }
  const root = join(directory, "root");
  await mkdir(root, { recursive: true });
  const moduleUrl = new URL("../src/codex.js", import.meta.url).href;
  const resultFile = join(directory, "result.json");
  const blocker = scenario.output !== undefined && scenario.output !== "stdout";
  const inner = `
    import { access, writeFile } from "node:fs/promises";
    import { writeFileSync } from "node:fs";
    import { Writable } from "node:stream";
    import { setTimeout as sleep } from "node:timers/promises";
    import childProcesses from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { executeWorker } from ${JSON.stringify(moduleUrl)};
    const decision = ${JSON.stringify(decision(scenario.profileId ?? "balanced"))};
    const resultFile = ${JSON.stringify(resultFile)};
    const controller = new AbortController();
    ${scenario.abortBeforeCall ? "controller.abort();" : ""}
    let received = 0;
    let pending = 0;
    let maxPending = 0;
    let captured = "";
    let outputAcked = false;
    let diagWrites = 0;
    let diagMaxLength = 0;
    let diagFinalLength = 0;
    let diagAcked = false;
    let diagSink;
    let output;
    let storedCb = null;
    let outputErrBefore;
    let outputErrAfter;
    let tailWrites = 0;
    let lateErrBefore;
    let lateErrAfter;
    let maxFrameConcatBytes = 0;
    let abortAfterShutdownReached = false;
    const originalSpawn = childProcesses.spawn;
    const originalKill = process.kill;
    let ownedPid;
    ${scenario.gate === "abort-after-shutdown" ? `
    let childClosed = false, groupGone = false, abortQueued = false;
    const maybeAbort = () => {
      if (!childClosed || !groupGone || abortQueued) return;
      abortQueued = true;
      // Run after executeWorker's close/discharge handlers, not on a timer guess.
      setImmediate(() => { abortAfterShutdownReached = true; controller.abort(); });
    };` : ""}
    childProcesses.spawn = (...args) => {
      const child = originalSpawn(...args);
      if (args[2]?.detached && child.pid !== undefined) {
        ownedPid = child.pid;
        writeFileSync(${JSON.stringify(join(directory, "owned.pid"))}, String(ownedPid));
        ${scenario.gate === "abort-after-shutdown" ? 'child.once("close", () => { childClosed = true; maybeAbort(); });' : ""}
      }
      return child;
    };
    syncBuiltinESMExports();
    ${scenario.gate === "abort-after-shutdown" ? `
    process.kill = (pid, sig) => {
      try { return originalKill.call(process, pid, sig); }
      catch (error) {
        if (pid === -ownedPid && sig === 0 && error.code === "ESRCH") { groupGone = true; maybeAbort(); }
        throw error;
      }
    };` : ""}
    ${scenario.trackFrameConcat ? `
    const originalConcat = Buffer.concat;
    Buffer.concat = function (chunks, length) {
      const combined = originalConcat(chunks, length);
      maxFrameConcatBytes = Math.max(maxFrameConcatBytes, combined.length);
      return combined;
    };` : ""}
    ${scenario.trackKills ? `
    // Counts group-signal ATTEMPTS after settlement; a stray post-settle
    // deadline callback would land here even when the group is already gone
    // (ESRCH) because the count precedes the delegation.
    let settledFlag = false;
    let postSettleKills = 0;
    process.kill = (pid, sig) => {
      if (settledFlag && pid === -ownedPid && sig !== 0) postSettleKills += 1;
      return originalKill.call(process, pid, sig);
    };` : ""}
    ${scenario.tail ? `
    let tailSink;
    tailSink = new Writable({
      highWaterMark: ${scenario.tail.hwm},
      write(_chunk, _encoding, callback) {
        tailWrites += 1;
        // Deliberately never calls callback nor drains; the sink then destroys
        // itself, so this write's callback can never arrive.
        setTimeout(() => { tailSink.destroy(${scenario.tail.action === "destroy-error" ? 'new Error("PRIVATE_EPIPE")' : ""}); }, ${scenario.tail.delayMs ?? 20});
      }
    });` : ""}
    ${scenario.tail?.target === "output" ? "output = tailSink;" : blocker ? `
    output = new Writable({
      highWaterMark: ${scenario.output === "accepted-delay" || scenario.output === "accepted-error" || scenario.output === "accepted-stall" ? 65536 : 0},
      write(chunk, _encoding, callback) {
        captured += chunk.toString();
        received += 1;
        pending += 1;
        maxPending = Math.max(maxPending, pending);
        ${scenario.output === "abort-in-write"
          ? "controller.abort(); // Deliberately never calls callback and never drains."
          : scenario.output === "abort-late-error"
            ? "storedCb = callback; controller.abort(); // Deliberately never acks this write."
            : scenario.output === "accepted-delay"
            ? `setTimeout(() => { pending -= 1; outputAcked = true; callback(); }, ${scenario.tailDelayMs ?? 500});`
            : scenario.output === "accepted-error"
              ? `setTimeout(() => { pending -= 1; callback(new Error("PRIVATE_LATE_EPIPE")); }, ${scenario.tailDelayMs ?? 500});`
              : scenario.output === "accepted-stall"
                ? "// Accepted write whose completion callback never arrives."
              : `setTimeout(() => { pending -= 1; callback(); }, ${scenario.drainDelayMs ?? 30});`}
      }
    });` : "output = process.stdout;"}
    ${scenario.tail?.target === "diag" ? "diagSink = tailSink;" : ""}
    ${scenario.diag === "stall" ? `
    diagSink = new Writable({
      highWaterMark: 0,
      write(_chunk, _encoding, callback) {
        diagWrites += 1;
        diagMaxLength = Math.max(diagMaxLength, diagSink.writableLength);
        // Deliberately never calls callback: the diagnostics sink stays stalled.
      }
    });` : ""}
    ${scenario.diag === "error" ? `
    diagSink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("PRIVATE_DIAGNOSTIC_EPIPE"));
      }
    });` : ""}
    ${scenario.diag === "delay" ? `
    diagSink = new Writable({
      highWaterMark: 65536,
      write(_chunk, _encoding, callback) {
        diagWrites += 1;
        diagMaxLength = Math.max(diagMaxLength, diagSink.writableLength);
        setTimeout(() => { diagAcked = true; callback(); }, ${scenario.tailDelayMs ?? 500});
      }
    });` : ""}
    ${scenario.diag === "delay-error" ? `
    diagSink = new Writable({
      highWaterMark: 65536,
      write(_chunk, _encoding, callback) {
        diagWrites += 1;
        setTimeout(() => { callback(new Error("PRIVATE_LATE_EPIPE")); }, ${scenario.tailDelayMs ?? 500});
      }
    });` : ""}
    ${scenario.diag === "slow" ? `
    diagSink = new Writable({
      highWaterMark: 0,
      write(_chunk, _encoding, callback) {
        diagWrites += 1;
        diagMaxLength = Math.max(diagMaxLength, diagSink.writableLength);
        setTimeout(() => { callback(); }, ${scenario.tailDelayMs ?? 500});
      }
    });` : ""}
    let bootPoll;
    const gateController = new AbortController();
    const gateSleep = milliseconds => sleep(milliseconds, undefined, { signal: gateController.signal }).catch(error => {
      if (error.name !== "AbortError") throw error;
    });
    const stopObservation = () => {
      clearTimeout(guard);
      clearInterval(bootPoll);
      bootPoll = undefined;
      gateController.abort();
    };
    const restore = () => {
      childProcesses.spawn = originalSpawn;
      syncBuiltinESMExports();
      ${scenario.trackKills ? "" : "process.kill = originalKill;"}
      ${scenario.trackFrameConcat ? "Buffer.concat = originalConcat;" : ""}
    };
    const killOwned = () => {
      if (ownedPid === undefined) return;
      try { originalKill.call(process, -ownedPid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const watchdog = phase => {
      stopObservation();
      restore();
      killOwned();
      process.stderr.write("worker " + phase + " watchdog\\n");
      process.exit(89);
    };
    // 6s admits the deterministic 3s bootstrap plus startup scheduling, under the 20s outer guard.
    let guard = setTimeout(() => watchdog("startup"), 6000);
    bootPoll = setInterval(async () => {
      try { await access(${JSON.stringify(join(directory, "boot"))}); }
      catch { return; }
      // An in-flight poll must not rearm a guard after genuine early settlement.
      if (bootPoll === undefined) return;
      clearInterval(bootPoll);
      bootPoll = undefined;
      clearTimeout(guard);
      guard = setTimeout(() => watchdog("settlement"), ${scenario.settlementGuardMs ?? 2500});
    }, 10);
    ${scenario.gate === "abort-ready" ? `
    const waitReady = async () => {
      for (let i = 0; i < 3000 && !gateController.signal.aborted; i++) {
        try { await access(${JSON.stringify(join(directory, "ready"))}); return; } catch { /* poll until the fake signals readiness. */ }
        await gateSleep(10);
      }
      if (!gateController.signal.aborted) throw new Error("fake worker never became ready");
    };` : ""}
    try {
      const running = executeWorker(decision, ${scenario.taskRepeat !== undefined ? `"x".repeat(${scenario.taskRepeat})` : JSON.stringify(scenario.task ?? "the original task")}, {
        executable: "codex",
        root: ${JSON.stringify(root)},
        write: ${scenario.write ?? false},
        env: process.env,
        signal: controller.signal,
        output,
        ...(diagSink ? { diagnostics: diagSink } : {})
      }).finally(stopObservation);
      ${scenario.gate && scenario.gate !== "abort-after-shutdown" ? "await Promise.race([running, (async () => {" : ""}
      ${scenario.gate === "abort-ready" ? "await waitReady(); if (!gateController.signal.aborted) controller.abort();" : ""}
      ${scenario.gate === "abort-received" ? "while (received < 1 && !gateController.signal.aborted) await gateSleep(10); if (!gateController.signal.aborted) controller.abort();" : ""}
      ${scenario.gate === "abort-diag-late" ? `
      while (diagWrites < 1 && !gateController.signal.aborted) await gateSleep(10);
      // The child closes first; no drain ever arrives; cancellation must still resolve.
      await gateSleep(400);
      if (!gateController.signal.aborted) controller.abort();` : ""}
      ${scenario.gate === "epipe-received" ? "while (received < 1 && !gateController.signal.aborted) await gateSleep(10); if (!gateController.signal.aborted) output.destroy(new Error(\"EPIPE\"));" : ""}
      ${scenario.gate && scenario.gate !== "abort-after-shutdown" ? "})()]);" : ""}
      const result = await running;
      ${scenario.trackKills ? "settledFlag = true;" : ""}
      stopObservation();
      restore();
      if (storedCb) {
        outputErrBefore = output.listenerCount("error");
        storedCb(new Error("PRIVATE_LATE_ACK"));
        await new Promise(resolve => setTimeout(resolve, 50));
        outputErrAfter = output.listenerCount("error");
      }
      diagFinalLength = diagSink ? diagSink.writableLength : 0;
      ${scenario.lateDestroy ? `
      {
        // The run has settled; a known sink failure arrives afterwards.
        const lateSink = ${scenario.diag === "stall" ? "diagSink" : "output"};
        lateErrBefore = lateSink.listenerCount("error");
        lateSink.destroy(${scenario.lateDestroy === "error" ? 'new Error("PRIVATE_LATE_CLOSE")' : ""});
        await new Promise(resolve => setTimeout(resolve, 50));
        lateErrAfter = lateSink.listenerCount("error");
      }` : ""}
      await writeFile(resultFile, JSON.stringify({ ...result, received, maxPending, emitted: captured, outputAcked, diagAcked, diagWrites, diagMaxLength, diagFinalLength, outputErrBefore, outputErrAfter, tailWrites, lateErrBefore, lateErrAfter, ...(${scenario.trackFrameConcat ?? false} ? { maxFrameConcatBytes } : {}), ...(${scenario.trackKills ?? false} ? { postSettleKills } : {}), ...(${scenario.gate === "abort-after-shutdown"} ? { abortAfterShutdownReached } : {}) }));
      ${scenario.lingerMs ? `setTimeout(() => {}, ${scenario.lingerMs});` : ""}
    } catch (error) {
      stopObservation();
      killOwned();
      await writeFile(resultFile, JSON.stringify({ harnessError: error instanceof Error ? error.message : String(error) }));
    } finally {
      stopObservation();
      restore();
    }
  `;
  const run = await execute(process.execPath, ["--input-type=module", "--eval", inner], {
    env: {
      // Parent additions may only introduce keys; the fixed entries below stay authoritative.
      ...(scenario.parentEnv ?? {}),
      PATH: directory,
      CODEX_HOME: join(directory, "codex-home"),
      LAYA_API_KEY: "TEST_LAYA_SENTINEL",
      TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TURNHELM_CONFIG: "/synthetic/turnhelm.json"
    },
    timeout: 20_000
  }).catch(async error => {
    // The outer exec timeout may kill the harness before its watchdog runs.
    const pid = Number(await readFile(join(directory, "owned.pid"), "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ESRCH") throw cleanupError; }
    }
    throw error;
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
    NODE_V8_COVERAGE: "/tmp/node-coverage-shared",
    BASH_ENV: "/tmp/host-bashenv",
    ENV: "/tmp/host-shenv",
    CODEX_HOME: "/tmp/codex",
    PATH: "/bin"
  });
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.NODE_V8_COVERAGE, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.ENV, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.PATH, "/bin");
});

test("worker environment additionally marks the managed child", () => {
  const env = workerEnvironment({ TYPESAFE_API_KEY: "TEST_JEV_SENTINEL", CODEX_HOME: "/tmp/codex" }, "/consumer/root");
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(env.ZDOTDIR, join("/consumer/root", ".turnhelm"),
    "the managed child's zsh lookup redirects to the turnhelm-owned root");
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
});

test("fake worker records only safe environment evidence", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
fs.writeFileSync(path.join(here, "parent-canary-present.json"), JSON.stringify(Object.hasOwn(process.env, "TURNHELM_TEST_PARENT_CANARY")));
finish(() => emit({ type: "turn.completed" }));
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(JSON.parse(await fakeFile(directory, "parent-canary-present.json")), false);
  assert.deepEqual(JSON.parse(await fakeFile(directory, "env.json")), {
    PATH: directory,
    CODEX_HOME: join(directory, "codex-home"),
    ZDOTDIR: join(directory, "root", ".turnhelm"),
    TURNHELM_MANAGED_CHILD: "1",
    LAYA_API_KEY: false,
    TYPESAFE_API_KEY: false,
    TURNHELM_ALLOW_HOSTED_JEV: false,
    TURNHELM_CONFIG: false
  });
});

test("worker descendant zsh never sources host startup files", { timeout: 30_000 }, async t => {
  // The observed leak path: zsh sources $ZDOTDIR/.zshenv even non-interactively
  // and falls back to HOME, so a worker's zsh descendant re-exported a stripped
  // key from the host .zshenv. An owned fake home pins the mechanism without
  // touching or reading any real startup file.
  const home = await mkdtemp(join(tmpdir(), "turnhelm-zshhome-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // The availability probe must not execute host startup files either: point its
  // zsh lookup at the still-empty owned home (a missing file there is a skip).
  const probe = await execute("/bin/zsh", ["-c", "print -r -- ok"],
    { env: { PATH: process.env.PATH, ZDOTDIR: home } }).catch(error => error);
  if ((probe as NodeJS.ErrnoException).code === "ENOENT") t.skip("/bin/zsh is not available");
  await writeFile(join(home, ".zshenv"), "export TURNHELM_TEST_ZSHENV_MARKER=leaked\n");
  const { recorded, directory } = await runWorker(t, {
    parentEnv: { HOME: home },
    script: `
finish(() => {
  const spawnSync = require("node:child_process").spawnSync;
  const zsh = spawnSync("/bin/zsh", ["-c", "print -r -- \\$TURNHELM_TEST_ZSHENV_MARKER"], { encoding: "utf8" });
  fs.writeFileSync(path.join(here, "zshenv-marker.txt"), JSON.stringify({
    status: zsh.error ? "error:" + zsh.error.code : zsh.status,
    stdout: String(zsh.stdout ?? "")
  }));
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  const evidence = JSON.parse(await fakeFile(directory, "zshenv-marker.txt")) as { status: number | string; stdout: string };
  // A zsh that never ran proves nothing: the descendant probe must exit cleanly
  // for the leak check below to be evidence of isolation.
  assert.equal(evidence.status, 0, "the descendant zsh must actually execute for this regression to mean anything");
  assert.ok(!evidence.stdout.includes("leaked"),
    "a worker descendant zsh must not source the host .zshenv, saw: " + JSON.stringify(evidence.stdout));
});

test("fake worker never forwards an unrelated synthetic parent canary", { timeout: 30_000 }, async () => {
  const { stdout, stderr } = await execute(process.execPath, [
    "--test", "--test-reporter=tap", "--test-name-pattern=^fake worker records only safe environment evidence$", fileURLToPath(import.meta.url)
  ], {
    env: {
      TURNHELM_TEST_PARENT_CANARY: "TEST_UNRELATED_PARENT_SENTINEL",
      LAYA_API_KEY: "TEST_LAYA_SENTINEL",
      TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TURNHELM_CONFIG: "/synthetic/turnhelm.json"
    },
    timeout: 20_000
  });
  assert.match(stdout, /^ok \d+ - fake worker records only safe environment evidence$/m);
  assert.equal(stderr, "");
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
    maxPending: 0,
    emitted: "",
    outputAcked: false,
    diagAcked: false,
    diagWrites: 0,
    diagMaxLength: 0,
    diagFinalLength: 0,
    tailWrites: 0,
    ownedShutdown: false
  });
  assert.equal(await fakeFile(directory, "argv.json"), JSON.stringify(buildWorkerArgs(decision("balanced"), true)));
  assert.equal(await fakeFile(directory, "cwd.txt"), await realpath(join(directory, "root")));
  assert.equal(await fakeFile(directory, "task.txt"), task);
  assert.equal(await fakeFile(directory, "runs"), "1");
  const env = JSON.parse(await fakeFile(directory, "env.json")) as Record<string, string | boolean>;
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(env.LAYA_API_KEY, false);
  assert.equal(env.TYPESAFE_API_KEY, false);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, false);
  assert.equal(env.TURNHELM_CONFIG, false);
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

test("turn.failed stops the owned group even though the leader would exit zero", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });
fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
finish(() => {
  emit({ type: "turn.failed", message: "rate limit exceeded for key" });
  emit({ type: "turn.completed", usage: { input_tokens: 99 } });
  setTimeout(() => process.exit(0), 200);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  // The leader's own exit code stands; the cleanup ladder only targets the group.
  assert.equal(recorded.code, 0);
  assert.equal(recorded.ownedShutdown, true, "a surviving group forces the cleanup ladder");
  assert.equal(recorded.failureClass, "rate-limit");
  assert.equal(await fakeFile(directory, "runs"), "1");
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("turn.failed then leader close within grace records its own exit code without a ladder", { timeout: 30_000 }, async t => {
  const message = "upstream usage limit reached on the billing account";
  const { recorded, directory } = await runWorker(t, {
    trackKills: true,
    lingerMs: 5500,
    script: `
finish(() => {
  emit({ type: "turn.failed", message: ${JSON.stringify(message)} });
  setTimeout(() => process.exit(7), 100);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 7, "the leader's own exit code is recorded");
  assert.equal(recorded.ownedShutdown, false, "an already-gone group is discharged silently");
  assert.equal(recorded.failureClass, "usage-limit");
  assert.equal(recorded.errorSha256, createHash("sha256").update(message, "utf8").digest("hex"));
  // The inner harness lingers past the 5 s deadline: no group signal may be
  // attempted after settlement (the deadline timer must be disposed).
  assert.equal(recorded.postSettleKills, 0, "no post-settlement ladder attempt");
  await waitForExit(Number(await readFile(join(directory, "owned.pid"), "utf8")));
});

test("failure deadline expiry escalates a still-alive leader", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    settlementGuardMs: 9000,
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "stream disconnected before completion" });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 143, "the deadline ladder TERMs the lingering leader");
  assert.equal(recorded.signal, "SIGTERM");
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.failureClass, "stream-disconnected");
  assert.ok((recorded.durationMs ?? 0) >= 4900, "the deadline waits the full grace before escalating, saw " + String(recorded.durationMs));
});

test("failure deadline expiry escalates an exited leader whose descendant holds inherited stdio", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    settlementGuardMs: 9000,
    script: `
const { spawn } = require("node:child_process");
finish(() => {
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: ["inherit", "inherit", "inherit"] });
  fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
  emit({ type: "turn.failed", message: "request timed out after 60000ms" });
  process.exit(0);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 0);
  assert.equal(recorded.ownedShutdown, true, "expiry discharges regardless of leader liveness");
  assert.equal(recorded.failureClass, "timeout");
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("repeated failed events start one deadline and keep the first failure class", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    settlementGuardMs: 9000,
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "rate limit exceeded" });
  setTimeout(() => emit({ type: "turn.failed", message: "request timed out" }), 700);
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.failureClass, "rate-limit", "the first failure event wins attribution");
  assert.equal(recorded.code, 143);
  // One deadline from the FIRST failed event: escalation lands near 5 s, not 5.7 s.
  assert.ok((recorded.durationMs ?? 0) < 5400, "the deadline must not restart, saw " + String(recorded.durationMs));
  assert.ok((recorded.durationMs ?? 0) >= 4900, "escalation still waits the grace, saw " + String(recorded.durationMs));
});

test("caller cancellation during the grace supersedes immediately", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    gate: "abort-ready",
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "upstream overloaded" });
  ready();
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.error, undefined);
  assert.equal(recorded.ownedShutdown, true, "cancellation runs the ladder without waiting");
  assert.ok((recorded.durationMs ?? 0) < 3000, "cancellation must not wait out the deadline, saw " + String(recorded.durationMs));
});

test("a transport failure during the grace supersedes immediately with its own cause", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    output: "blocker",
    gate: "epipe-received",
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "upstream overloaded" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "partial" } });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "output", "the transport cause wins over the pending deadline");
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.failureClass, "overloaded");
  assert.ok((recorded.durationMs ?? 0) < 3000, "a broken pipe must not wait out the deadline, saw " + String(recorded.durationMs));
});

test("signal death records the observed death signal", { timeout: 30_000 }, async t => {
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGKILL", 137]] as const) {
    const { recorded } = await runWorker(t, {
      script: `
finish(() => { process.kill(process.pid, ${JSON.stringify(sig)}); });
`
    });
    assert.equal(recorded.status, "failed", sig);
    assert.equal(recorded.error, "worker", sig);
    assert.equal(recorded.code, code, sig);
    assert.equal(recorded.signal, sig, sig);
    assert.equal(recorded.ownedShutdown, false, sig);
    assert.equal(recorded.failureClass, "unknown", sig);
  }
});

test("an eventless failure carries failureClass unknown and ownedShutdown false", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => { process.exit(3); });
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 3);
  assert.equal(recorded.failureClass, "unknown");
  assert.equal(recorded.ownedShutdown, false);
  assert.equal(recorded.errorSha256, undefined);
});

test("the failed dispatch writes exactly one class-only diagnostic line", { timeout: 30_000 }, async t => {
  const message = "password=p@ss.word! leaked into rate limit exceeded";
  const { recorded, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.failed", message: ${JSON.stringify(message)} });
  setTimeout(() => process.exit(5), 100);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(stderr, "turnhelm: worker-failed: rate-limit\n");
  forbid(stderr, "password=p@ss.word!");
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
  forbid(JSON.stringify(recorded) + stdout, "TEST_PRIVATE_ERROR_SENTINEL", "TEST_PRIVATE_STACK_SENTINEL");
  assert.equal(stderr, "turnhelm: worker-event-error\n");
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
  assert.equal(stderr, "turnhelm: tool-progress\n");
});

test("an async diagnostics sink error is a sanitized output failure that stops the group", { timeout: 30_000 }, async t => {
  const outcome = await runWorker(t, {
    diag: "error",
    script: `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });
fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
finish(() => {
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
  setInterval(() => {}, 500);
});
`
  }).then(
    value => ({ kind: "settled" as const, value }),
    error => ({ kind: "crashed" as const, error })
  );
  if (outcome.kind === "crashed") {
    const error = outcome.error as NodeJS.ErrnoException & { code?: number | null; stderr?: string };
    assert.fail("diagnostics sink error crashed the harness: exit " + error.code
      + ", raw error text on stderr: " + String(error.stderr ?? "").includes("PRIVATE_DIAGNOSTIC_EPIPE"));
  }
  const { recorded, stderr, directory } = outcome.value;
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "output");
  forbid(JSON.stringify(recorded) + stderr, "PRIVATE_DIAGNOSTIC_EPIPE", "TEST_PRIVATE_ERROR_SENTINEL");
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("an abort resolves a stalled diagnostics sink with a bounded queue", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    diag: "stall",
    gate: "abort-diag-late",
    script: `
finish(() => {
  for (let i = 0; i < 10000; i++) emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL_" + i });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.ok((recorded.diagWrites ?? 0) <= 8, "diagnostic writes must be bounded, saw " + recorded.diagWrites);
  assert.ok((recorded.diagFinalLength ?? 0) <= 256, "retained diagnostic bytes must be bounded, saw " + recorded.diagFinalLength);
  forbid(JSON.stringify(recorded) + stderr, "TEST_PRIVATE_ERROR_SENTINEL");
});

test("one diagnostic event is written exactly once under a slow drain", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    diag: "slow",
    tailDelayMs: 5,
    script: `
finish(() => {
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  setTimeout(() => { emit({ type: "turn.completed" }); }, 350);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.diagWrites, 1, "one fixed-category event must surface exactly once, saw " + recorded.diagWrites);
  assert.equal(stderr, "");
  forbid(JSON.stringify(recorded) + stderr, "TEST_PRIVATE_ERROR_SENTINEL");
});

test("settlement waits for an accepted message write to complete", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    output: "accepted-delay",
    tailDelayMs: 500,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "tail" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.outputAcked, true, "the result must not settle before the accepted write completes");
  assert.ok((recorded.durationMs ?? 0) >= 400);
});

test("a late message-write error is a sanitized output failure, not a crash", { timeout: 30_000 }, async t => {
  const outcome = await runWorker(t, {
    output: "accepted-error",
    tailDelayMs: 500,
    lingerMs: 900,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "tail" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
});
`
  }).then(
    value => ({ kind: "settled" as const, value }),
    error => ({ kind: "crashed" as const, error })
  );
  if (outcome.kind === "crashed") {
    const error = outcome.error as NodeJS.ErrnoException & { code?: number | null; stderr?: string };
    assert.fail("late message-write error crashed the harness: exit " + error.code
      + ", raw error text on stderr: " + String(error.stderr ?? "").includes("PRIVATE_LATE_EPIPE"));
  }
  const { recorded, stderr } = outcome.value;
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "output");
  assert.equal(recorded.code, 0);
  forbid(JSON.stringify(recorded) + stderr, "PRIVATE_LATE_EPIPE");
});

test("settlement waits for an accepted diagnostics write to complete", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    diag: "delay",
    tailDelayMs: 500,
    script: `
finish(() => {
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.diagAcked, true, "the result must not settle before the accepted write completes");
  assert.equal(stderr, "");
});

test("a late diagnostics-write error is a sanitized output failure, not a crash", { timeout: 30_000 }, async t => {
  const outcome = await runWorker(t, {
    diag: "delay-error",
    tailDelayMs: 500,
    lingerMs: 900,
    script: `
finish(() => {
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  emit({ type: "turn.completed" });
});
`
  }).then(
    value => ({ kind: "settled" as const, value }),
    error => ({ kind: "crashed" as const, error })
  );
  if (outcome.kind === "crashed") {
    const error = outcome.error as NodeJS.ErrnoException & { code?: number | null; stderr?: string };
    assert.fail("late diagnostics-write error crashed the harness: exit " + error.code
      + ", raw error text on stderr: " + String(error.stderr ?? "").includes("PRIVATE_LATE_EPIPE"));
  }
  const { recorded, stderr } = outcome.value;
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "output");
  assert.equal(recorded.code, 0);
  forbid(JSON.stringify(recorded) + stderr, "PRIVATE_LATE_EPIPE");
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

test("garbage accounting after a valid snapshot keeps the run and earlier usage", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 6 } });
  emit({ type: "turn.completed", usage: [] });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { input_tokens: 6 });
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
    // 4 MiB is an empirically verified stress size for the supported probe
    // matrix, not a portable limit: Node warns child stdio pipes are not
    // necessarily Unix pipes and their capacity is platform-specific. On every
    // tested runtime (macOS Node 26.5 and 22.8, Linux Node 24 CI + container)
    // this write stayed pending until the non-reading child exited, then
    // failed EPIPE. It is built inside the harness child because shipping it
    // through runWorker would place 4 MiB into a single --eval argv element,
    // exceeding the per-string execve limit (E2BIG).
    const { recorded } = await runWorker(t, { script: `process.exitCode = ${exitCode};\n`, taskRepeat: 4 * 1024 * 1024 });
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.error, "stdin");
    assert.equal(recorded.code, exitCode);
  });
}

test("stdout backpressure queues one message at the sink while stderr drains", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "blocker",
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
  for (let i = 0; i < 20; i++) assert.ok((recorded.emitted ?? "").includes("message-" + i + "\n"));
  forbid(JSON.stringify(recorded) + stderr, "TEST_PRIVATE_STDERR_SENTINEL");
});

test("cancellation interrupts a stalled drain wait", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "blocker",
    gate: "abort-received",
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
    output: "blocker",
    gate: "epipe-received",
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

test("an abort raised inside a sink write still resolves the run", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    output: "abort-in-write",
    script: `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });
fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "racing" } });
  emit({ type: "turn.completed", usage: { input_tokens: 5 } });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.received, 1);
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("a late error ack after a settled cancelled run detaches owned sink listeners", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "abort-late-error",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "racing" } });
  emit({ type: "turn.completed", usage: { input_tokens: 5 } });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.outputErrBefore, 1, "the sink must own its error listener while the write is unacked");
  assert.equal(recorded.outputErrAfter, 0, "the late error ack must detach owned listeners from the sink");
  assert.equal(recorded.harnessError, undefined);
  forbid(stderr, "PRIVATE_LATE_ACK");
});

test("a TERM-ignoring worker is killed within the grace window", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    gate: "abort-ready",
    script: `
process.on("SIGTERM", () => {});
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "stubborn" } });
  ready();
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
    gate: "abort-ready",
    script: `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });
fs.writeFileSync(path.join(here, "descendant.pid"), String(child.pid));
ready();
finish(() => {
  setTimeout(() => {}, 5000);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

for (const [target, hwm, action] of [
  ["output", 0, "destroy-error"],
  ["output", 65536, "destroy-error"],
  ["output", 0, "destroy-quiet"],
  ["output", 65536, "destroy-quiet"],
  ["diag", 0, "destroy-error"],
  ["diag", 65536, "destroy-error"],
  ["diag", 0, "destroy-quiet"],
  ["diag", 65536, "destroy-quiet"]
] as const) {
  test(`a destroyed ${target} sink (hwm ${hwm}, ${action}) settles bounded as an output failure`, { timeout: 30_000 }, async t => {
    const { recorded, stderr } = await runWorker(t, {
      tail: { target, hwm, action },
      script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  emit({ type: "turn.completed" });
  setTimeout(() => {}, 10000);
});
`
    });
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.error, "output");
    assert.equal(recorded.tailWrites, 1);
    assert.ok((recorded.durationMs ?? 0) < 5000, "settlement must be bounded, took " + recorded.durationMs + "ms");
    forbid(JSON.stringify(recorded) + stderr, "PRIVATE_EPIPE", "TEST_PRIVATE_ERROR_SENTINEL");
  });
}

for (const [target, action] of [
  ["output", "destroy-error"],
  ["output", "destroy-quiet"],
  ["diag", "destroy-error"],
  ["diag", "destroy-quiet"]
] as const) {
  test(`a late failed ${target} sink (${action}) settles a prior protocol failure`, { timeout: 30_000 }, async t => {
    const { recorded, stderr } = await runWorker(t, {
      tail: { target, hwm: 65536, action, delayMs: 250 },
      script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  process.stdout.write("{bad-json}\\n");
  setTimeout(() => {}, 10000);
});
`
    });
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.error, "protocol", "the first cause must be preserved, saw " + recorded.error);
    assert.equal(recorded.tailWrites, 1);
    assert.ok((recorded.durationMs ?? 0) < 5000, "settlement must be bounded, took " + recorded.durationMs + "ms");
    forbid(JSON.stringify(recorded) + stderr, "PRIVATE_EPIPE", "TEST_PRIVATE_ERROR_SENTINEL");
  });
}

for (const [target, mode] of [
  ["output", "error"],
  ["output", "quiet"],
  ["diag", "error"],
  ["diag", "quiet"]
] as const) {
  test(`a settled cancelled run releases listeners on a late known ${target} sink ${mode} close`, { timeout: 30_000 }, async t => {
    const outcome = await runWorker(t, {
      ...(target === "output" ? { output: "abort-in-write" as const } : { diag: "stall" as const, gate: "abort-diag-late" as const }),
      lateDestroy: mode,
      script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  setTimeout(() => {}, 10000);
});
`
    }).then(
      value => ({ kind: "settled" as const, value }),
      error => ({ kind: "crashed" as const, error })
    );
    if (outcome.kind === "crashed") {
      const error = outcome.error as NodeJS.ErrnoException & { code?: number | null; stderr?: string };
      assert.fail("late known sink failure crashed the harness: exit " + error.code
        + ", raw error text on stderr: " + String(error.stderr ?? "").includes("PRIVATE_LATE_CLOSE"));
    }
    const { recorded, stderr } = outcome.value;
    assert.equal(recorded.status, "cancelled");
    assert.equal(recorded.lateErrBefore, 1, "the in-flight sink must still own its error listener at settlement");
    assert.equal(recorded.lateErrAfter, 0, "the late known failure must release the listener");
    forbid(JSON.stringify(recorded) + stderr, "PRIVATE_LATE_CLOSE", "TEST_PRIVATE_ERROR_SENTINEL");
  });
}

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
    `], { env: { PATH: directory }, timeout: 20_000 });
  assert.equal(result.stderr, "");
  const recorded = JSON.parse(await readFile(resultFile, "utf8")) as Recorded;
  assert.equal(recorded.harnessError, undefined);
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "spawn");
});

for (const target of ["message", "diag"] as const) {
  test(`late caller cancellation settles a prior protocol failure with pending ${target} output`, { timeout: 30_000 }, async t => {
    const { recorded } = await runWorker(t, {
      ...(target === "message"
        ? { output: "accepted-stall" as const }
        : { diag: "stall" as const }),
      gate: "abort-after-shutdown",
      script: `finish(() => {
        emit(${target === "message" ? '{type:"item.completed",item:{type:"agent_message",text:"accepted"}}' : '{type:"error",message:"PRIVATE_PROTOCOL_CONTEXT"}'});
        process.stdout.write("invalid-json\\n");
      });`
    });
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.abortAfterShutdownReached, true, "child close and group discharge must precede cancellation");
    assert.equal(recorded.error, "protocol", "late cancellation must retain the first failure cause");
    assert.equal(target === "message" ? recorded.received : recorded.diagWrites, 1, "the sink must retain an unacknowledged write");
  });
}

test("shutdown drains worker stdout without accumulating discarded frames", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    trackFrameConcat: true,
    script: `process.on("SIGTERM", () => {});
      finish(() => {
        process.stdout.write("invalid-json\\n");
        setTimeout(() => {
          let chunks = 0;
          const flood = () => {
            if (chunks++ === 40) return;
            process.stdout.write(Buffer.alloc(65536, 120), () => setImmediate(flood));
          };
          flood();
        }, 50);
        setInterval(() => {}, 500);
      });`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "protocol");
  assert.ok(recorded.maxFrameConcatBytes! <= MAX_EVENT_BYTES,
    "discarded shutdown bytes must not grow the retained protocol buffer: " + recorded.maxFrameConcatBytes);
});

test("an already-aborted signal cancels before spawning", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, { abortBeforeCall: true });
  assert.equal(recorded.status, "cancelled");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await readFile(join(directory, "runs"), "utf8").then(() => "spawned", () => "absent"), "absent");
});

// A pre-boot pause must not consume the scenario's unchanged settlement budget.
test("worker harness separates slow bootstrap from settlement", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    bootstrap: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n",
    script: "finish(() => emit({ type: 'turn.completed' }));"
  });
  assert.equal(recorded.status, "completed");
});

for (const phase of ["startup", "settlement"] as const) {
  // Killing just the harness would orphan both the detached worker and descendant.
  test(`worker harness ${phase} watchdog rejects and removes the owned group`, { timeout: 30_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), "turnhelm-watchdog-"));
    t.after(async () => {
      for (const name of ["leader", "descendant"]) {
        const pid = Number(await readFile(join(dir, name), "utf8").catch(() => ""));
        if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      }
      await rm(dir, { recursive: true, force: true });
    });
    const stalled = `
const fixtureFs = require('node:fs');
const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubbornChild)}], { stdio: 'ignore' });
fixtureFs.writeFileSync(${JSON.stringify(join(dir, "leader"))}, String(process.pid));
fixtureFs.writeFileSync(${JSON.stringify(join(dir, "descendant"))}, String(descendant.pid));
fixtureFs.writeFileSync(${JSON.stringify(join(dir, "started"))}, String(Date.now()));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;
    const outcome = await runWorker(t, {
      ...(phase === "startup" ? { bootstrap: stalled + "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n" } : {}),
      script: phase === "startup" ? "" : stalled
    }).then(() => ({ code: 0, stderr: "" }), error => error as { code: number; stderr: string });
    assert.equal(outcome.code, 89, 'watchdog must remain a visible harness failure');
    assert.ok(outcome.stderr.includes(`worker ${phase} watchdog`), 'wrong observation budget fired');
    const elapsed = Date.now() - Number(await readFile(join(dir, "started"), "utf8"));
    assert.ok(elapsed >= (phase === "startup" ? 5000 : 2400));
    assert.ok(elapsed < (phase === "startup" ? 8000 : 4500), 'must fail at stage budget, not outer timeout');
    await waitForExit(Number(await readFile(join(dir, "leader"), "utf8")));
    await waitForExit(Number(await readFile(join(dir, "descendant"), "utf8")));
  });
}

// execFile can fail before either stage watchdog (its stdout capture is bounded).
test("outer harness exec error removes the detached worker group", { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "turnhelm-outer-error-"));
  t.after(async () => {
    for (const name of ["leader", "descendant"]) {
      const pid = Number(await readFile(join(dir, name), "utf8").catch(() => ""));
      if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
    await rm(dir, { recursive: true, force: true });
  });
  const outcome = await runWorker(t, {
    script: `
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubbornChild)}], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(join(dir, "leader"))}, String(process.pid));
fs.writeFileSync(${JSON.stringify(join(dir, "descendant"))}, String(child.pid));
finish(() => {
  for (let i = 0; i < 40; i++) emit({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(65536) } });
  setInterval(() => {}, 1000);
});`
  }).then(() => ({ code: "success" }), error => error as { code: string });
  assert.equal(outcome.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  await waitForExit(Number(await readFile(join(dir, "leader"), "utf8")));
  await waitForExit(Number(await readFile(join(dir, "descendant"), "utf8")));
});

// A pending ready gate must not hide executeWorker's pre-spawn cancellation.
test("pending gate accepts preaborted worker settlement without spawning", { timeout: 30_000 }, async t => {
  const { recorded, stderr, directory } = await runWorker(t, { abortBeforeCall: true, gate: "abort-ready" });
  assert.equal(recorded.status, "cancelled");
  assert.equal(stderr, "");
  for (const name of ["runs", "owned.pid", "boot", "ready"]) {
    await assert.rejects(readFile(join(directory, name)), { code: "ENOENT" });
  }
});

// A booted child that exits before output must retain its actual failed result.
test("pending gate accepts booted worker settlement before output", { timeout: 30_000 }, async t => {
  const { recorded, stderr, directory } = await runWorker(t, { gate: "abort-received", script: "process.exitCode = 7;" });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 7);
  assert.equal(stderr, "");
  assert.equal(await fakeFile(directory, "runs"), "1");
  await readFile(join(directory, "boot"));
  await waitForExit(Number(await fakeFile(directory, "owned.pid")));
});

test("an end-to-end hostile worker failure yields class-only attribution in the receipt", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-worker-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const root = join(directory, "root");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  // One local classify call answers a fixed balanced choice; no real backend.
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ answers: { route: { type: "choice", choice: "balanced" } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const taskSentence = "Fix the pago row before the nightly cutoff lands.";
  const hostile = `upstream rate limit exceeded while password=p@ss.word! and Bearer tok_9f3a81c4d2 were live ${taskSentence}`;
  const hostileSha = createHash("sha256").update(hostile, "utf8").digest("hex");
  await executableFixture(join(bin, "codex"), [
    `#!${process.execPath}`,
    "const argv = process.argv.slice(2);",
    'if (argv[0] === "--version") { console.log("codex-cli 0.160.2"); process.exit(0); }',
    'if (argv[0] === "exec" && argv[1] === "--help") { console.log("--json\\n--ephemeral\\n--sandbox <MODE>\\n-"); process.exit(0); }',
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", () => {});",
    "process.stdin.on(\"end\", () => {",
    `  process.stdout.write(JSON.stringify({ type: "error", message: ${JSON.stringify(hostile)} }) + "\\n");`,
    `  process.stdout.write(JSON.stringify({ type: "turn.failed", message: ${JSON.stringify(hostile)} }) + "\\n");`,
    "  process.exit(9);",
    "});"
  ].join("\n"), "node");
  await executableFixture(join(bin, "git"), "#!/bin/sh\nif [ \"$1\" = \"-C\" ]; then echo true; exit 0; fi\nexit 64\n", "shell");
  await writeFile(join(root, ".turnhelm", "config.json"), JSON.stringify({
    version: 1,
    routingTimeoutMs: 4000,
    backends: { laya: { enabled: true, url: `http://127.0.0.1:${port}` }, jev: { enabled: false } },
    profiles: {
      fast: { model: "gpt-6-luna", effort: "low" },
      balanced: { model: "gpt-6.1-sol", effort: "medium" },
      deep: { model: "gpt-6.1-sol", effort: "high" },
      frontier: { model: "gpt-6-astra", effort: "high" },
      frontier_xhigh: { model: "gpt-6-astra", effort: "xhigh" },
      frontier_max: { model: "gpt-6-astra", effort: "max" }
    }
  }));
  const run = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)), "run", taskSentence
    ], {
      cwd: root,
      env: { PATH: bin, LAYA_API_KEY: "dummy-laya-key", CODEX_HOME: join(directory, "codex-home") }
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.stdin?.end();
    const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", code => { clearTimeout(guard); resolve({ code: code ?? -1, stdout, stderr }); });
  });
  assert.equal(run.code, 9, "the worker's own exit code propagates: " + run.stderr);
  const receiptLines = run.stderr.split("\n").filter(line => line.includes("turnhelm.receipt"));
  assert.equal(receiptLines.length, 1, "exactly one receipt line");
  const receipt = JSON.parse(receiptLines[0]) as { worker: Record<string, unknown> };
  assert.equal(receipt.worker.status, "failed");
  assert.equal(receipt.worker.code, 9);
  assert.equal(typeof receipt.worker.ownedShutdown, "boolean", "every executed-worker receipt carries the boolean");
  assert.equal(receipt.worker.ownedShutdown, false);
  assert.equal(receipt.worker.failureClass, "rate-limit");
  assert.equal(receipt.worker.errorSha256, hostileSha);
  const canaries = ["password=p@ss.word!", "Bearer tok_9f3a81c4d2", taskSentence];
  const surfaces = run.stdout + run.stderr;
  for (const canary of canaries) {
    assert.ok(!surfaces.includes(canary), "canary leaked: " + canary);
    assert.ok(!JSON.stringify(receipt).includes(canary), "canary leaked into the receipt: " + canary);
  }
  for (let i = 0; i + 20 <= hostile.length; i++) {
    const window = hostile.slice(i, i + 20);
    assert.ok(!surfaces.includes(window), `20-char window at ${i} of the raw message leaked`);
  }
  assert.ok(surfaces.includes("turnhelm: worker-failed: rate-limit"), "the class-only diagnostic line is present");
});
