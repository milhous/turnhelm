import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROFILE_IDS, type ProfileId, type ProjectConfig } from "../src/config.js";
import type { TaskDecision } from "../src/route.js";
import { buildWorkerArgs, SANDBOX_SEMANTICS_NOTE, subprocessEnvironment, workerEnvironment } from "../src/codex.js";
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
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  ZDOTDIR: process.env.ZDOTDIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
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

type Gate = "abort-ready" | "abort-received" | "epipe-received" | "abort-then-epipe" | "abort-diag-late" | "abort-after-shutdown" | "abort-after-frame";

type OutputMode = "stdout" | "blocker" | "abort-in-write" | "abort-late-error" | "throw" | "accepted-delay" | "accepted-error" | "accepted-stall";

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
  outerMaxBufferBytes?: number;
  auth?: boolean;
  schemaBytes?: string;
  poisonTmpdir?: boolean;
  stallAbortMs?: number;
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
  payload?: { mode: string; trailerBytes?: number };
  errorSha256?: string;
  signal?: string;
  postSettleKills?: number;
  progressEvents?: number;
  lastEventAgeMs?: number;
  codexHomeManaged?: boolean;
  instructionNote?: string;
  abortReason?: string;
};

async function runWorker(t: TestContext, scenario: WorkerScenario): Promise<{ recorded: Recorded; stdout: string; stderr: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (scenario.script !== undefined) {
    await executableFixture(join(directory, "codex"), (scenario.bootstrap ?? "") + FAKE_PREAMBLE + scenario.script, "node");
  }
  const root = join(directory, "root");
  await mkdir(root, { recursive: true });
  // The managed home must land in an owned sandbox (os.tmpdir() re-reads TMPDIR
  // per call), so lifecycle assertions scope exactly this run's homes; a
  // poisoned nonexistent TMPDIR is the fail-closed mkdtemp seam.
  const tmpSandbox = join(directory, "tmp");
  await mkdir(tmpSandbox, { recursive: true });
  if (scenario.auth) {
    await mkdir(join(directory, "codex-home"), { recursive: true });
    await writeFile(join(directory, "codex-home", "auth.json"), '{"token":"fixture"}');
  }
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
            : scenario.output === "throw"
              ? 'throw new Error("PRIVATE_SYNC_EPIPE");'
              : scenario.output === "accepted-delay"
            ? `setTimeout(() => { pending -= 1; outputAcked = true; callback(); }, ${scenario.tailDelayMs ?? 500});`
            : scenario.output === "accepted-error"
              ? `setTimeout(() => { pending -= 1; callback(new Error("PRIVATE_LATE_EPIPE")); }, ${scenario.tailDelayMs ?? 500});`
              : scenario.output === "accepted-stall"
                ? "// Accepted write whose completion callback never arrives."
              : `setTimeout(() => { pending -= 1; callback(); }, ${scenario.drainDelayMs ?? 30});`}
      }
    })` : "output = process.stdout;"}
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
    ${scenario.gate === "abort-after-frame" ? `
    const waitFramed = async () => {
      for (let i = 0; i < 3000 && !gateController.signal.aborted; i++) {
        try { await access(${JSON.stringify(join(directory, "framed"))}); return; } catch { /* poll until the fake emitted its frame. */ }
        await gateSleep(10);
      }
      if (!gateController.signal.aborted) throw new Error("fake worker never emitted its frame marker");
    };` : ""}
    try {
      const running = executeWorker(decision, ${scenario.taskRepeat !== undefined ? `"x".repeat(${scenario.taskRepeat})` : JSON.stringify(scenario.task ?? "the original task")}, {
        executable: "codex",
        root: ${JSON.stringify(root)},
        write: ${scenario.write ?? false},
        ${scenario.schemaBytes !== undefined ? `schemaBytes: Buffer.from(${JSON.stringify(scenario.schemaBytes)}),` : ""}
        env: process.env,
        signal: controller.signal,
        output,
        ...(diagSink ? { diagnostics: diagSink } : {}),
        ${scenario.stallAbortMs !== undefined ? `stallAbortMs: ${scenario.stallAbortMs},` : ""}
      }).finally(stopObservation);
      ${scenario.gate && scenario.gate !== "abort-after-shutdown" ? "await Promise.race([running, (async () => {" : ""}
      ${scenario.gate === "abort-ready" ? "await waitReady(); if (!gateController.signal.aborted) controller.abort();" : ""}
      ${scenario.gate === "abort-after-frame" ? "await waitFramed(); if (!gateController.signal.aborted) controller.abort();" : ""}
      ${scenario.gate === "abort-received" ? "while (received < 1 && !gateController.signal.aborted) await gateSleep(10); if (!gateController.signal.aborted) controller.abort();" : ""}
      ${scenario.gate === "abort-diag-late" ? `
      while (diagWrites < 1 && !gateController.signal.aborted) await gateSleep(10);
      // The child closes first; no drain ever arrives; cancellation must still resolve.
      await gateSleep(400);
      if (!gateController.signal.aborted) controller.abort();` : ""}
      ${scenario.gate === "epipe-received" ? "while (received < 1 && !gateController.signal.aborted) await gateSleep(10); if (!gateController.signal.aborted) output.destroy(new Error(\"EPIPE\"));" : ""}
      ${scenario.gate === "abort-then-epipe" ? `
      while (received < 1 && !gateController.signal.aborted) await gateSleep(10);
      if (!gateController.signal.aborted) controller.abort();
      // The sink breaks after the abort but before the trapped group closes.
      await gateSleep(50);
      if (!gateController.signal.aborted) output.destroy(new Error("EPIPE"));` : ""}
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
      // Sample post-settlement signals after the linger window, not before it:
      // a late ladder attempt must land in postSettleKills, not after the read.
      ${scenario.lingerMs ? `await sleep(${scenario.lingerMs});` : ""}
      await writeFile(resultFile, JSON.stringify({ ...result, received, maxPending, emitted: captured, outputAcked, diagAcked, diagWrites, diagMaxLength, diagFinalLength, outputErrBefore, outputErrAfter, tailWrites, lateErrBefore, lateErrAfter, ...(${scenario.trackFrameConcat ?? false} ? { maxFrameConcatBytes } : {}), ...(${scenario.trackKills ?? false} ? { postSettleKills } : {}), ...(${scenario.gate === "abort-after-shutdown"} ? { abortAfterShutdownReached } : {}) }));
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
      TMPDIR: scenario.poisonTmpdir === true ? join(directory, "tmp-poisoned") : tmpSandbox,
      LAYA_API_KEY: "TEST_LAYA_SENTINEL",
      TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TURNHELM_CONFIG: "/synthetic/turnhelm.json"
    },
    timeout: 20_000,
    ...(scenario.outerMaxBufferBytes !== undefined ? { maxBuffer: scenario.outerMaxBufferBytes } : {})
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
  test(`buildWorkerArgs pins ${profileId} model, effort, and isolation flags exactly`, () => {
    const decisionValue = decision(profileId);
    assert.deepEqual(buildWorkerArgs(decisionValue, false), [
      "exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
      "--config", "agents.enabled=false", "--model", decisionValue.profile.model,
      "--config", `model_reasoning_effort=${JSON.stringify(decisionValue.profile.effort)}`, "-"
    ]);
    assert.deepEqual(buildWorkerArgs(decisionValue, true), [
      "exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write",
      "--config", "agents.enabled=false", "--model", decisionValue.profile.model,
      "--config", `model_reasoning_effort=${JSON.stringify(decisionValue.profile.effort)}`, "-"
    ]);
    // WB-1/OC-1: the staged schema path is passed through only on explicit
    // supply, pointing at the managed home — never the caller's own path.
    assert.deepEqual(buildWorkerArgs(decisionValue, true, "/managed/output-schema.json"), [
      "exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write",
      "--config", "agents.enabled=false", "--model", decisionValue.profile.model,
      "--config", `model_reasoning_effort=${JSON.stringify(decisionValue.profile.effort)}`,
      "--output-schema", "/managed/output-schema.json", "-"
    ]);
  });
}

test("subprocess environment strips classifier credentials while preserving Codex auth", () => {
  const env = subprocessEnvironment({
    LAYA_API_KEY: "TEST_LAYA_SENTINEL",
    TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
    TURNHELM_ALLOW_HOSTED_JEV: "1",
    TURNHELM_CONFIG: "/tmp/turnhelm.json",
    BASH_ENV: "/tmp/host-bashenv",
    ENV: "/tmp/host-shenv",
    CODEX_HOME: "/tmp/codex",
    PATH: "/bin"
  });
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.ENV, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.PATH, "/bin");
});

test("worker children do not inherit coverage instrumentation across the boundary", async () => {
  const sentinel = "/tmp/turnhelm-test-coverage-sentinel";
  const probe = "process.stdout.write(process.env.NODE_V8_COVERAGE ?? \"absent\")";
  const run = (env: NodeJS.ProcessEnv): Promise<string> =>
    execute(process.execPath, ["-e", probe], { encoding: "utf8", env }).then(out => out.stdout);
  // Node reinserts the PARENT's value into any child env lacking the own
  // property, so the parent must carry the sentinel for the boundary to mean
  // anything; delete-based stripping forwards the parent's value through.
  const previous = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = sentinel;
  try {
    // Negative: across the boundary the child observes nothing (not even "").
    assert.equal(
      await run(workerEnvironment({ PATH: process.env.PATH ?? "", NODE_V8_COVERAGE: sentinel }, "/managed/home")),
      "absent");
    // Positive controls: an explicit own property still forwards; and an env
    // lacking the key — the measured harness spawn shape (CG-AC-02) — still
    // receives the parent's value by Node's reinsertion, so an over-reaching
    // override at a measured site fails here, not only at the thresholds.
    assert.equal(await run({ PATH: process.env.PATH ?? "", NODE_V8_COVERAGE: sentinel }), sentinel);
    assert.equal(await run({ PATH: process.env.PATH ?? "" }), sentinel);
  } finally {
    if (previous === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previous;
  }
});

test("worker environment additionally marks the managed child", () => {
  const env = workerEnvironment({ TYPESAFE_API_KEY: "TEST_JEV_SENTINEL", CODEX_HOME: "/tmp/codex", HOME: "/tmp/host-home" }, "/managed/home");
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(env.HOME, "/managed/home",
    "the managed child's HOME-derived discovery resolves inside the managed home");
  assert.equal(env.ZDOTDIR, "/managed/home",
    "the managed child's zsh lookup redirects to the managed home, never a host ZDOTDIR");
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, "/managed/home",
    "the managed home overrides any inherited CODEX_HOME value");
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
  const observedEnv = JSON.parse(await fakeFile(directory, "env.json")) as Record<string, string | boolean>;
  assert.equal(observedEnv.PATH, directory);
  assert.equal(observedEnv.HOME, observedEnv.CODEX_HOME,
    "HOME is the run's managed home, closing HOME-derived host dotfile discovery");
  assert.equal(observedEnv.ZDOTDIR, observedEnv.CODEX_HOME,
    "the zsh lookup redirects to the managed home, never the host or project root");
  assert.equal(observedEnv.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(observedEnv.LAYA_API_KEY, false);
  assert.equal(observedEnv.TYPESAFE_API_KEY, false);
  assert.equal(observedEnv.TURNHELM_ALLOW_HOSTED_JEV, false);
  assert.equal(observedEnv.TURNHELM_CONFIG, false);
  assert.equal(dirname(String(observedEnv.CODEX_HOME)), join(directory, "tmp"),
    "CODEX_HOME is a fresh managed home under tmpdir(), never the inherited value");
  assert.match(basename(String(observedEnv.CODEX_HOME)), /^turnhelm-worker-/);
});

test("hermetic HOME closes host dotfile discovery while other env passes through", { timeout: 30_000 }, async t => {
  // The hostile host home carries dotfiles on the claimed-closed discovery
  // paths; the worker must resolve them inside the managed home instead.
  const hostileHome = await mkdtemp(join(tmpdir(), "turnhelm-hostile-home-"));
  t.after(() => rm(hostileHome, { recursive: true, force: true }));
  await mkdir(join(hostileHome, ".config", "fish"), { recursive: true });
  await mkdir(join(hostileHome, ".agents"), { recursive: true });
  await writeFile(join(hostileHome, ".gitconfig"), "[user]\nname = HOST_IDENTITY\n");
  const { recorded, directory } = await runWorker(t, {
    parentEnv: { HOME: hostileHome, XDG_CONFIG_HOME: "/tmp/host-xdg-override" },
    script: `
fs.writeFileSync(path.join(here, "home-resolution.json"), JSON.stringify({
  home: process.env.HOME,
  gitconfig: require("node:fs").existsSync(path.join(process.env.HOME ?? "", ".gitconfig")),
  agentsDir: require("node:fs").existsSync(path.join(process.env.HOME ?? "", ".agents")),
  xdg: process.env.XDG_CONFIG_HOME
}));
finish(() => emit({ type: "turn.completed" }));
`
  });
  assert.equal(recorded.status, "completed");
  const resolution = JSON.parse(await fakeFile(directory, "home-resolution.json")) as {
    home: string; gitconfig: boolean; agentsDir: boolean; xdg: string;
  };
  assert.equal(dirname(resolution.home), join(directory, "tmp"),
    "HOME is a fresh managed home under tmpdir(), never the hostile host home");
  assert.equal(resolution.gitconfig, false, "the host .gitconfig is not reachable through $HOME");
  assert.equal(resolution.agentsDir, false, "the host $HOME/.agents discovery path finds nothing");
  // Scoped closure only: explicit override variables keep passing through as
  // documented residuals — the redirect does not scrub the environment.
  assert.equal(resolution.xdg, "/tmp/host-xdg-override");
});

test("a surviving descendant keeps the stripped key set and managed marker after leader exit", { timeout: 30_000 }, async t => {
  // AF-2: an owned home (with its own startup file) means nothing host is
  // read; the sentinel descendant is node, so the .zshenv is ownership
  // hygiene, not a leak probe. The descendant outlives the worker and pins
  // what the process chain carries across the leader's death.
  const home = await mkdtemp(join(tmpdir(), "turnhelm-sentinel-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".zshenv"), "export TURNHELM_TEST_SENTINEL_MARKER=leaked\n");
  const { recorded, directory } = await runWorker(t, {
    // The startup-file keys ride the parent env so their null samples below
    // demonstrate stripping in-chain, not mere absence.
    parentEnv: { HOME: home, BASH_ENV: "/tmp/host-bashenv", ENV: "/tmp/host-shenv" },
    script: `
const KEYS = ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV", "TURNHELM_CONFIG",
  "BASH_ENV", "ENV", "TURNHELM_MANAGED_CHILD", "CODEX_HOME", "ZDOTDIR", "HOME"];
fs.writeFileSync(path.join(here, "leader.json"), JSON.stringify({ pid: process.pid, codexHome: process.env.CODEX_HOME }));
const descendantSource = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const dir = ' + JSON.stringify(here) + ';',
  'const KEYS = ' + JSON.stringify(KEYS) + ';',
  'const sample = function () {',
  '  return Object.fromEntries(KEYS.map(function (key) {',
  '    return [key, Object.hasOwn(process.env, key) ? process.env[key] : null];',
  '  }));',
  '};',
  'const before = sample();',
  'fs.writeFileSync(path.join(dir, "descendant-ready.json"), JSON.stringify({ pid: process.pid }));',
  '(function poll() {',
  '  try { process.kill(process.ppid, 0); setTimeout(poll, 25); }',
  '  catch (error) { fs.writeFileSync(path.join(dir, "descendant-samples.json"),',
  '    JSON.stringify({ before: before, after: sample() })); }',
  '})();',
  'setInterval(function () {}, 500);'
].join("\\n");
fs.writeFileSync(path.join(here, "descendant.js"), descendantSource);
const descendant = require("node:child_process").spawn(process.execPath, [path.join(here, "descendant.js")],
  { detached: true, stdio: "ignore" });
descendant.unref();
(function waitReady() {
  if (fs.existsSync(path.join(here, "descendant-ready.json"))) finish(() => emit({ type: "turn.completed" }));
  else setTimeout(waitReady, 25);
})();
`
  });
  assert.equal(recorded.status, "completed", "the worker completes normally while the descendant survives");
  const leader = JSON.parse(await fakeFile(directory, "leader.json")) as { pid: number; codexHome: string };
  // The descendant's death is registered before any assertion can abandon it;
  // the leader only settles after descendant-ready.json exists, so no poll is
  // needed to read it here.
  const descendant = JSON.parse(await fakeFile(directory, "descendant-ready.json")) as { pid: number };
  t.after(() => { try { process.kill(descendant.pid, "SIGKILL"); } catch { /* already gone */ } });
  const samplesPath = join(directory, "descendant-samples.json");
  const deadline = Date.now() + 15_000;
  let samplesRaw: string | null = null;
  while (Date.now() < deadline) {
    samplesRaw = await readFile(samplesPath, "utf8").catch(() => null);
    if (samplesRaw !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(samplesRaw !== null, "the descendant samples after the leader exits");
  const samples = JSON.parse(samplesRaw) as { before: Record<string, string | null>; after: Record<string, string | null> };
  assert.notEqual(descendant.pid, leader.pid, "the survivor is a separate process");
  for (const [name, sample] of [["before", samples.before], ["after", samples.after]] as const) {
    for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV", "TURNHELM_CONFIG", "BASH_ENV", "ENV"]) {
      assert.equal(sample[key], null, name + " sample: " + key + " stays stripped");
    }
    assert.equal(sample.TURNHELM_MANAGED_CHILD, "1", name + " sample: the managed-child marker persists");
    assert.equal(sample.CODEX_HOME, leader.codexHome, name + " sample: the managed home is the leader's");
    assert.equal(sample.ZDOTDIR, leader.codexHome,
      name + " sample: the zsh lookup stays redirected to the managed home");
    assert.equal(sample.HOME, leader.codexHome,
      name + " sample: HOME-derived discovery stays inside the managed home");
  }
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
  // t.skip flags the test but does not halt this body: without the return,
  // the descendant probe below runs anyway and turns the skip into a failure
  // wherever /bin/zsh is absent (CI's ubuntu runner).
  if ((probe as NodeJS.ErrnoException).code === "ENOENT") return t.skip("/bin/zsh is not available");
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
  // The decision starts the owned ladder, so the code is the ladder's TERM or
  // a raced voluntary exit-zero — both are honest observations of the group end.
  const { code, signal, ...normalized } = { ...recorded, durationMs: 0, lastEventAgeMs: 0 };
  assert.deepEqual(normalized, {
    status: "completed",
    durationMs: 0,
    progressEvents: 2,
    lastEventAgeMs: 0,
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
    ownedShutdown: true,
    codexHomeManaged: true,
    instructionNote: "sandbox-semantics-v1",
    payload: { mode: "unstructured" }
  });
  assert.ok(code === 0 || (code === 143 && signal === "SIGTERM"),
    "voluntary exit zero or the ladder's TERM, saw " + code + "/" + String(signal));
  assert.equal(await fakeFile(directory, "argv.json"), JSON.stringify(buildWorkerArgs(decision("balanced"), true)));
  assert.equal(await fakeFile(directory, "cwd.txt"), await realpath(join(directory, "root")));
  // The worker instruction is byte-exact task + fixed note; validation saw
  // the bare task only.
  assert.equal(await fakeFile(directory, "task.txt"), task + "\n\n" + SANDBOX_SEMANTICS_NOTE);
  assert.equal(await fakeFile(directory, "runs"), "1");
  const env = JSON.parse(await fakeFile(directory, "env.json")) as Record<string, string | boolean>;
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
  assert.equal(env.LAYA_API_KEY, false);
  assert.equal(env.TYPESAFE_API_KEY, false);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, false);
  assert.equal(env.TURNHELM_CONFIG, false);
  assert.equal(dirname(String(env.CODEX_HOME)), join(directory, "tmp"),
    "the worker env carries the managed home, not the inherited one");
  assert.equal(env.PATH, directory);
  assert.ok(stdout.includes("worker result\n"));
  assert.equal(stderr, "");
});

test("the stall watchdog aborts a silent worker after the first decoded frame", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    stallAbortMs: 300,
    script: `
finish(() => {
  emit({ type: "item.started", item: { type: "reasoning" } });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.abortReason, "stall");
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.progressEvents, 1);
  assert.ok(recorded.lastEventAgeMs !== undefined && recorded.lastEventAgeMs >= 300,
    "the stall age is at least the threshold, saw " + String(recorded.lastEventAgeMs));
  assert.equal(recorded.signal, "SIGTERM");
  assert.equal(recorded.code, 143);
});

test("a worker with zero decoded frames never stall-aborts", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    stallAbortMs: 300,
    gate: "abort-ready",
    script: `
finish(() => {
  setTimeout(() => { ready(); setInterval(() => {}, 500); }, 700);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.abortReason, undefined, "no decoded frame is unknown evidence, never stall evidence");
  assert.equal(recorded.ownedShutdown, true);
});

test("a later decoded frame extends the stall deadline", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    stallAbortMs: 500,
    script: `
finish(() => {
  // Every gap stays under the 500ms threshold while the cumulative run
  // crosses it twice over — only a per-frame re-arm survives this.
  let frames = 0;
  const tick = () => {
    frames += 1;
    emit({ type: "item.updated", item: { type: "reasoning", status: "in_progress" } });
    if (frames < 4) setTimeout(tick, 400);
    else {
      emit({ type: "turn.completed", usage: { input_tokens: 3 } });
      process.exit(0);
    }
  };
  setTimeout(tick, 400);
});
`
  });
  assert.equal(recorded.status, "completed", "each sub-threshold gap re-arms the deadline");
  assert.equal(recorded.abortReason, undefined);
  assert.equal(recorded.progressEvents, 5);
});

test("the watchdog never fires after the terminal event decided the run", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    stallAbortMs: 300,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
  emit({ type: "turn.completed", usage: { input_tokens: 3 } });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.abortReason, undefined, "a decided run is not stall-abortable");
  assert.equal(recorded.ownedShutdown, true);
});

test("a caller signal during armed silence outranks the watchdog", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    stallAbortMs: 5000,
    gate: "abort-after-frame",
    script: `
finish(() => {
  emit({ type: "item.started", item: { type: "reasoning" } });
  fs.writeFileSync(path.join(here, "framed"), "1");
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.abortReason, undefined, "the caller's abort records no stall reason");
  assert.equal(recorded.ownedShutdown, true);
});

test("worker executes under a fresh managed CODEX_HOME holding only staged contents", { timeout: 30_000 }, async t => {
  const schema = JSON.stringify({ type: "object", properties: { selected: { type: "string" } } });
  const { recorded, directory } = await runWorker(t, {
    auth: true,
    schemaBytes: schema,
    script: `
finish(() => {
  fs.writeFileSync(path.join(here, "home-capture.json"), JSON.stringify({
    home: process.env.CODEX_HOME,
    listing: fs.readdirSync(process.env.CODEX_HOME).sort(),
    authTarget: (() => { try { return fs.readlinkSync(path.join(process.env.CODEX_HOME, "auth.json")); } catch { return null; } })(),
    schemaBytes: fs.readFileSync(path.join(process.env.CODEX_HOME, "output-schema.json"), "utf8")
  }));
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.codexHomeManaged, true);
  const capture = JSON.parse(await fakeFile(directory, "home-capture.json")) as { home: string; listing: string[]; authTarget: string | null; schemaBytes: string };
  assert.equal(dirname(capture.home), join(directory, "tmp"), "the managed home is a fresh directory under tmpdir()");
  assert.match(basename(capture.home), /^turnhelm-worker-/, "the home is a private mkdtemp directory");
  assert.notEqual(capture.home, join(directory, "codex-home"), "the inherited CODEX_HOME value never reaches the worker");
  assert.deepEqual(capture.listing, ["auth.json", "output-schema.json"]);
  assert.equal(capture.authTarget, join(directory, "codex-home", "auth.json"),
    "the credential is a symlink to the parent-derived source");
  assert.equal(capture.schemaBytes, schema, "the staged schema carries the validated bytes verbatim");
});

test("managed CODEX_HOME stays empty without a credential source or staged schema", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
finish(() => {
  fs.writeFileSync(path.join(here, "home-capture.json"), JSON.stringify(fs.readdirSync(process.env.CODEX_HOME).sort()));
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  const listing = JSON.parse(await fakeFile(directory, "home-capture.json")) as string[];
  assert.deepEqual(listing, [], "no credential source and no schema stage nothing into the home");
});

test("the managed CODEX_HOME is destroyed after failed, cancelled, and spawn-error settlements", { timeout: 60_000 }, async t => {
  const assertHomeRemoved = async (scenario: WorkerScenario): Promise<Recorded> => {
    const { recorded, directory } = await runWorker(t, scenario);
    if (scenario.script !== undefined) {
      const env = JSON.parse(await fakeFile(directory, "env.json")) as { CODEX_HOME?: string };
      assert.equal(dirname(String(env.CODEX_HOME)), join(directory, "tmp"),
        "the run must actually have used a managed home before its removal can mean anything");
    } else {
      assert.equal(recorded.codexHomeManaged, true, "the spawn path still entered the managed home");
    }
    assert.deepEqual(await readdir(join(directory, "tmp")), [],
      "no managed home survives settlement: " + String(recorded.status));
    return recorded;
  };
  const failed = await assertHomeRemoved({
    // The leader exits on its own within the failure grace; settlement then
    // lands at close, exactly like the turn.failed regressions above.
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "upstream overloaded" });
  setTimeout(() => process.exit(0), 200);
});
`
  });
  assert.equal(failed.status, "failed");
  const cancelled = await assertHomeRemoved({
    gate: "abort-ready",
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "upstream overloaded" });
  ready();
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(cancelled.status, "cancelled");
  const spawnError = await assertHomeRemoved({});
  assert.equal(spawnError.status, "failed");
  assert.equal(spawnError.error, "spawn");
});

test("managed home removal waits for owned-shutdown discharge, not settlement start", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    script: `
process.on("SIGTERM", function () {});
finish(() => {
  emit({ type: "turn.completed" });
  setInterval(function () {
    if (!fs.existsSync(process.env.CODEX_HOME)) {
      fs.writeFileSync(path.join(here, "home-gone-while-alive.json"), "1");
      process.exit(0);
    }
  }, 20);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.ownedShutdown, true, "the stubborn worker is taken by the ladder");
  const env = JSON.parse(await fakeFile(directory, "env.json")) as { CODEX_HOME?: string };
  assert.equal(dirname(String(env.CODEX_HOME)), join(directory, "tmp"), "the run used a managed home");
  // The worker stayed alive through TERM and many poll ticks; removal at
  // decision time instead of post-discharge would have been observed here.
  assert.equal(await readFile(join(directory, "home-gone-while-alive.json"), "utf8").catch(() => ""), "",
    "the home must not vanish while the owned group is still alive");
  assert.deepEqual(await readdir(join(directory, "tmp")), []);
});

test("worker home creation failure fails closed as the spawn class", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    poisonTmpdir: true,
    script: `finish(() => emit({ type: "turn.completed" }));`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "spawn");
  assert.equal(recorded.failureClass, "unknown");
  assert.equal(recorded.ownedShutdown, false);
  assert.equal(recorded.codexHomeManaged, undefined, "no home was ever established");
  assert.equal(await readFile(join(directory, "runs"), "utf8").catch(() => ""), "",
    "the worker never started, let alone ran under an inherited home");
});

test("credential symlink writes through and removal never touches the source", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    auth: true,
    script: `
finish(() => {
  fs.appendFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "-refreshed");
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  const env = JSON.parse(await fakeFile(directory, "env.json")) as { CODEX_HOME?: string };
  assert.equal(dirname(String(env.CODEX_HOME)), join(directory, "tmp"),
    "the append went through the managed home's symlink, not the inherited path");
  // The write landed in the real parent-side credential file, and that file
  // still reads back after the home's recursive removal: rmSync unlinks the
  // symlink, never following it to the target.
  assert.equal(await fakeFile(directory, join("codex-home", "auth.json")), '{"token":"fixture"}-refreshed');
  assert.deepEqual(await readdir(join(directory, "tmp")), []);
});

test("stdout carries exactly the final agent message of a completed run", { timeout: 30_000 }, async t => {
  const { recorded, stdout, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "progress narration" } });
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "worker result\n");
  forbid(stdout + stderr + JSON.stringify(recorded), "progress narration");
});

// PE-1: the structured payload contract at the emission phase. Classification
// precedes the single sink write; stdout is byte-exact per mode, and the
// projection is content-free (mode, trailerBytes only).
test("an envelope-shaped final message emits exactly its payload line", { timeout: 30_000 }, async t => {
  const trailer = "备注：未访问网络，冻结检查通过。";
  const { recorded, stdout, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "progress narration" } });
  emit({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify('{"count":8,"sum":8}\n' + trailer)} } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, '{"count":8,"sum":8}\n');
  forbid(stdout + stderr + JSON.stringify(recorded), trailer, "progress narration");
  assert.deepEqual(recorded.payload, { mode: "extracted", trailerBytes: Buffer.byteLength(trailer, "utf8") });
});

test("a whole-message JSON final message emits verbatim with payload mode strict", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: '{"count":8,"sum":8}' } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, '{"count":8,"sum":8}\n');
  assert.deepEqual(recorded.payload, { mode: "strict" });
});

test("a conflicting second structured answer emits verbatim with payload mode conflict", { timeout: 30_000 }, async t => {
  const message = '{"count":8,"sum":8}\n{"count":9,"sum":9}';
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(message)} } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, message + "\n");
  assert.deepEqual(recorded.payload, { mode: "conflict" });
});

test("a completed run with zero agent messages writes nothing to stdout", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, { script: "finish(() => emit({ type: 'turn.completed' }));" });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "");
  assert.equal(recorded.payload, undefined, "a zero-message completion attaches no payload projection");
});

test("an empty-string final message writes exactly one newline", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "" } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "\n");
  assert.deepEqual(recorded.payload, { mode: "unstructured" });
});

test("a strict trailing-newline message keeps its newline and gains the emitter's", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify("{}\n")} } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  // PE-01's pinned shape: the strict message "{}\n" is emitted verbatim and the
  // emitter appends its own single newline — "{}\n\n" on stdout, deliberate.
  assert.equal(stdout, "{}\n\n");
  assert.deepEqual(recorded.payload, { mode: "strict" });
});

test("a message decoded after the terminal event is dropped; the pre-terminal message is final", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "before" } });
  emit({ type: "turn.completed" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "after" } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "before\n");
});

test("a repeated completion changes nothing", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "settled answer" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
  emit({ type: "turn.completed", usage: { input_tokens: 2 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "settled answer\n");
});

test("a failed frame after the terminal event is dropped and the run completes", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "answer" } });
  emit({ type: "turn.completed" });
  emit({ type: "turn.failed", message: "upstream usage limit reached" });
});
`
  });
  assert.equal(recorded.status, "completed", "post-terminal native noise cannot rewrite a decided verdict");
  assert.equal(recorded.error, undefined);
  assert.equal(stdout, "answer\n");
});

test("a maximal agent-message frame passes through unclipped", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    // The ~1 MiB message rides the outer exec's capture; explicit headroom
    // keeps future harness chatter from failing as ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
    outerMaxBufferBytes: 2 * 1024 * 1024,
    script: `
finish(() => {
  const text = "z".repeat(1048576 - 68); // frame stays just under MAX_EVENT_BYTES after the 67-byte JSON envelope
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "z".repeat(1048576 - 68) + "\n");
  // Classification is bounded native parsing: the maximal frame classifies
  // without a second write or clipping.
  assert.deepEqual(recorded.payload, { mode: "unstructured" });
});

// TS-1..TS-3: a clean run settles at the decoded terminal event; the owned
// TERM→KILL ladder then bounds teardown instead of waiting for voluntary exit
// (the sealed 2026-10-15 diagnostic observed a 28 s completion-to-exit gap).
test("terminal-event settlement bounds the completed run's wait", { timeout: 30_000 }, async t => {
  const { recorded, stdout, directory } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 10000);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "worker result\n");
  assert.equal(recorded.ownedShutdown, true, "the terminal event starts the owned ladder");
  assert.equal(recorded.signal, "SIGTERM", "the ladder TERMs the lingering leader");
  assert.ok(recorded.code === 143 || recorded.code === 0, "the recorded code is the ladder's TERM or a raced voluntary exit");
  assert.ok((recorded.durationMs ?? 0) < 5000, "ladder-bounded, not linger-bounded, saw " + String(recorded.durationMs));
  await waitForExit(Number(await readFile(join(directory, "owned.pid"), "utf8")));
});

test("terminal-event settlement is race-free against voluntary exit", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 50);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "worker result\n");
  assert.equal(recorded.ownedShutdown, true, "the decision precedes close; the ladder still discharges");
});

test("terminal frame before stdin ack still decides", { timeout: 30_000 }, async t => {
  // A task larger than the pipe buffer pins the ordering deterministically:
  // the parent's stdin end-callback cannot fire until the fake drains, and the
  // fake emits the terminal frame before draining — no sleep race.
  const { recorded } = await runWorker(t, {
    taskRepeat: 200_000,
    script: `
emit({ type: "turn.completed" });
process.stdin.resume();
setTimeout(() => process.exit(0), 8000);
`
  });
  assert.equal(recorded.status, "completed", "the stdin-ack trigger decides the run the frame alone could not");
  assert.equal(recorded.ownedShutdown, true);
  assert.ok((recorded.durationMs ?? 0) < 5000, "ladder-bounded, saw " + String(recorded.durationMs));
});

test("TERM-ignoring group escalates and still completes", { timeout: 30_000 }, async t => {
  const { recorded, directory } = await runWorker(t, {
    bootstrap: stubbornChild,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.signal, "SIGKILL", "a TERM-trapping group forces the second rung");
  assert.ok((recorded.durationMs ?? 0) >= 1000, "the KILL lands at the TERM grace, saw " + String(recorded.durationMs));
  assert.ok((recorded.durationMs ?? 0) < 5000);
  await waitForExit(Number(await readFile(join(directory, "owned.pid"), "utf8")));
});

test("post-terminal frames are dropped and the terminal snapshot is final", { timeout: 30_000 }, async t => {
  // The SIGTERM trap keeps the fake alive past the ladder's first rung so the
  // post-terminal frames really reach the parent's dropped-frame path.
  const { recorded, stdout } = await runWorker(t, {
    bootstrap: stubbornChild,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "message A" } });
  emit({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } });
  setTimeout(() => {
    emit({ type: "item.completed", item: { type: "agent_message", text: "message B" } });
    emit({ type: "turn.completed", usage: { input_tokens: 99, output_tokens: 98 } });
    process.stdout.write("{malformed\\n");
  }, 100);
});
`
  });
  assert.equal(recorded.status, "completed", "post-terminal noise cannot rewrite the verdict");
  assert.equal(stdout, "message A\n", "the payload derives from message A only");
  assert.deepEqual(recorded.usage, { input_tokens: 11, output_tokens: 7 }, "usage freezes at the terminal frame");
  assert.equal(recorded.failureClass, undefined);
  assert.equal(recorded.progressEvents, 2, "only pre-terminal frames count");
});

test("zero-message terminal event completes without emission", { timeout: 30_000 }, async t => {
  const { recorded, stdout, directory } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 6000);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "");
  assert.equal(recorded.ownedShutdown, true);
  assert.ok((recorded.durationMs ?? 0) < 5000, "ladder-bounded, saw " + String(recorded.durationMs));
  await waitForExit(Number(await readFile(join(directory, "owned.pid"), "utf8")));
});

test("blocked sink at emission still flushes exactly once", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    output: "accepted-delay",
    tailDelayMs: 500,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 8000);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.outputAcked, true, "settlement waits for the drain");
  assert.equal(recorded.received, 1, "exactly one emission");
  assert.equal(recorded.emitted, "worker result\n");
  assert.ok((recorded.durationMs ?? 0) >= 400, "the run settled only after the drain, saw " + String(recorded.durationMs));
  assert.ok((recorded.durationMs ?? 0) < 5000);
});

test("sink write throws synchronously at emission after decision", { timeout: 30_000 }, async t => {
  // The sink's write() throws before any callback could exist: the emitMessage
  // catch must own it as an output failure — after the decision, before any
  // signal — and never let native error text reach a receipt or stderr.
  const { recorded, stderr } = await runWorker(t, {
    output: "throw",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 10000);
});
`
  });
  assert.equal(recorded.status, "failed", "a sink failure at emission is never a completed run");
  assert.equal(recorded.error, "output");
  assert.equal(recorded.ownedShutdown, true);
  forbid(JSON.stringify(recorded) + stderr, "PRIVATE_SYNC_EPIPE");
});

test("sink destroyed at emission after decision fails as output", { timeout: 30_000 }, async t => {
  // The destroy lands the moment the emission reaches the sink — after the
  // decision, before any signal could matter — and must still own the failure.
  const { recorded } = await runWorker(t, {
    gate: "epipe-received",
    output: "blocker",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 10000);
});
`
  });
  assert.equal(recorded.status, "failed", "a sink failure at emission is never a completed run");
  assert.equal(recorded.error, "output");
  assert.equal(recorded.ownedShutdown, true);
});

test("late payload ack error fails the decided run", { timeout: 30_000 }, async t => {
  // The write is accepted at the decision, the ladder starts, and the ack
  // errors 500 ms later — still pre-settlement, still first-cause "output".
  const { recorded } = await runWorker(t, {
    output: "accepted-error",
    tailDelayMs: 500,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed" });
  setTimeout(() => process.exit(0), 10000);
});
`
  });
  assert.equal(recorded.status, "failed", "an accepted-then-errored write must not upgrade to completed");
  assert.equal(recorded.error, "output");
  assert.equal(recorded.ownedShutdown, true, "the ladder already started when the ack error landed");
});

test("operator abort in the post-decision window cancels", { timeout: 30_000 }, async t => {
  // The abort is raised inside the sink's write of the emission — strictly
  // after the decision and before settlement, with no timer or file poll to
  // race — and the operator still outranks the delivered verdict. The child
  // never exits voluntarily, so the ladder's SIGTERM is the only end.
  const { recorded, directory } = await runWorker(t, {
    output: "abort-in-write",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "verdict" } });
  emit({ type: "turn.completed" });
  setInterval(() => {}, 1000);
});
`
  });
  assert.equal(recorded.status, "cancelled", "operator intent outranks the delivered verdict");
  assert.equal(recorded.emitted, "verdict\n", "the flushed verdict stays honest in the sink");
  assert.equal(recorded.ownedShutdown, true);
  // The abort joins the decision's own ladder; SIGTERM ends the non-trapping
  // group — the exit code stays an observation (spec TS-8), never a status input.
  assert.equal(recorded.signal, "SIGTERM");
  await waitForExit(Number(await readFile(join(directory, "owned.pid"), "utf8")));
});

test("exit zero without a completion is a worker failure", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, { script: "finish(() => {});\n" });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.code, 0);
  assert.equal(stdout, "");
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

test("a reported failure is terminal for the stall watchdog even at the floor value", { timeout: 30_000 }, async t => {
  // turn.failed is a terminal frame: at stallAbortMs 5000 — exactly the
  // failure-grace deadline — the watchdog must not preempt the failure
  // ladder and reclassify an explicitly failed worker as a stall.
  const { recorded } = await runWorker(t, {
    settlementGuardMs: 9000,
    stallAbortMs: 5000,
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "stream disconnected before completion" });
  setInterval(() => {}, 500);
});
`
  });
  assert.equal(recorded.status, "failed", "the reported failure keeps its class");
  assert.equal(recorded.error, "worker");
  assert.equal(recorded.failureClass, "stream-disconnected");
  assert.equal(recorded.abortReason, undefined, "no stall reason rides a run the worker already failed");
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.code, 143);
  assert.equal(recorded.signal, "SIGTERM");
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
  // No message write exists mid-run to break the output sink, so the sink
  // that can fail during a failed turn's grace is the diagnostics sink: its
  // error on the worker-failed line must still supersede the deadline.
  const { recorded } = await runWorker(t, {
    diag: "error",
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "upstream overloaded" });
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

test("decoded-event counters count every successfully decoded kind", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "counted" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
  process.stdout.write(JSON.stringify({ type: "future.event" }) + "\\n");
  emit({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "file", exit_code: 0 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.progressEvents, 2, "only the message and terminal frames count; post-terminal kinds are dropped");
  assert.equal(typeof recorded.lastEventAgeMs, "number");
});

test("a settlement gap after decode quiescence makes lastEventAgeMs positive", { timeout: 30_000 }, async t => {
  // The gap must start after the parent DECODED the frames, not after the
  // child emitted them: a descheduled parent decodes everything at close and
  // the age collapses to zero. The final-message write happens only at
  // settlement, so a sink that accepts it but drains late holds the run open
  // after the last decode — the drain gap lands between decode and finish.
  const { recorded } = await runWorker(t, {
    output: "blocker",
    drainDelayMs: 300,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "gap" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
  process.exit(0);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.progressEvents, 2, "both frames decode before the settlement gap");
  assert.ok(recorded.lastEventAgeMs !== undefined && recorded.lastEventAgeMs > 0,
    "the blocked final write holds settlement past the last decode: saw " + recorded.lastEventAgeMs);
});

test("a malformed frame after the terminal event is dropped and the run completes", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "counted" } });
  emit({ type: "turn.completed" });
  process.stdout.write("{not json}\\n");
  process.stdout.write(JSON.stringify({ type: "future.event" }) + "\\n");
  setTimeout(() => {}, 10000);
});
`
  });
  assert.equal(recorded.status, "completed", "post-terminal garbage is native noise, not a protocol failure");
  assert.equal(recorded.error, undefined);
  assert.equal(recorded.progressEvents, 2, "only the pre-terminal frames count");
  assert.equal(stdout, "counted\n");
});

test("a pre-start abort carries zero decoded events and no age", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, { abortBeforeCall: true });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.progressEvents, 0);
  assert.equal(recorded.lastEventAgeMs, undefined);
});

test("a sink error after the abort cannot relabel the cancelled run", { timeout: 30_000 }, async t => {
  // The group traps SIGTERM, so the run is still unsettled when the output
  // sink breaks 50 ms after the abort — inside the post-abort window, before
  // the KILL closes the child. The operator's cancellation (spec TS-6)
  // outranks that late output failure; the receipt keeps status cancelled.
  const { recorded, directory } = await runWorker(t, {
    gate: "abort-then-epipe",
    output: "blocker",
    bootstrap: stubbornChild,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  emit({ type: "turn.completed" });
  setInterval(() => {}, 1000);
});
`
  });
  assert.equal(recorded.status, "cancelled", "the abort outranks a sink failure inside the post-abort window");
  assert.equal(recorded.error, undefined);
  assert.equal(recorded.failureClass, undefined);
  assert.equal(recorded.ownedShutdown, true);
  assert.equal(recorded.signal, "SIGKILL");
  await waitForExit(Number(await readFile(join(directory, "owned.pid"), "utf8")));
});

test("a cancelled post-decision run keeps its delivered answer and cancelled status", { timeout: 30_000 }, async t => {
  // The abort fires only once the sink has received the emission — a
  // parent-observed event, so the decision strictly precedes the cancellation
  // with no boot-time race. The write lands in the sink; the cancellation then
  // supersedes its pending drain, exactly as it interrupts any other stall.
  const { recorded } = await runWorker(t, {
    gate: "abort-received",
    output: "accepted-delay",
    tailDelayMs: 300,
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  emit({ type: "turn.completed" });
  setInterval(() => {}, 1000);
});
`
  });
  assert.equal(recorded.status, "cancelled", "operator intent outranks the delivered verdict");
  assert.ok((recorded.progressEvents ?? 0) >= 1, "the decoded message before cancellation still counts, saw " + recorded.progressEvents);
  assert.equal(typeof recorded.lastEventAgeMs, "number");
  assert.equal(recorded.emitted, "held\n", "the delivered verdict stays in the sink; the exit code carries the stop");
  assert.equal(recorded.outputAcked, false, "the cancellation interrupted the pending drain instead of waiting for it");
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

test("repeated failed turns write exactly one diagnostic line with the first class", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.failed", message: "rate limit exceeded" });
  emit({ type: "turn.failed", message: "request timed out after 60000ms" });
  setTimeout(() => process.exit(5), 100);
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.failureClass, "rate-limit", "the first failure event wins attribution");
  assert.equal(stderr, "turnhelm: worker-failed: rate-limit\n");
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

test("worker activity never relays commands or outputs", { timeout: 30_000 }, async t => {
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
  assert.equal(stderr, "turnhelm: worker-activity\n");
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
  // The ladder TERMs the lingering fake; its own exit zero may race the signal.
  assert.ok(recorded.code === 0 || recorded.code === 143, "attribution is the pin, not the race, saw " + recorded.code);
  // Emission may have initiated, but a failed run attaches no payload projection.
  assert.equal(recorded.payload, undefined);
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
  // The ladder TERMs the lingering fake; its own exit zero may race the signal.
  assert.ok(recorded.code === 0 || recorded.code === 143, "attribution is the pin, not the race, saw " + recorded.code);
  // Emission may have initiated, but a failed run attaches no payload projection.
  assert.equal(recorded.payload, undefined);
  forbid(JSON.stringify(recorded) + stderr, "PRIVATE_LATE_EPIPE");
});

test("usage freezes at the terminal frame, never a sum or a replacement", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  emit({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { input_tokens: 10, output_tokens: 5 });
});

test("the first usage snapshot is final; later completions cannot mix fields", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 7 } });
  emit({ type: "turn.completed", usage: { output_tokens: 9 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.usage, { input_tokens: 7 });
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

test("nonzero exit after the terminal event is an observation, not a failure", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
  process.exitCode = 3;
});
`
  });
  assert.equal(recorded.status, "completed", "a decided run stays completed regardless of the observed exit code");
  assert.deepEqual(recorded.usage, { input_tokens: 1 });
  // The voluntary nonzero exit races the ladder's TERM; both end a decided run.
  assert.ok(recorded.code === 3 || recorded.code === 143, "saw " + recorded.code);
  assert.equal(stdout, "");
});

test("the result settles at the terminal event, not at close", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
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
  assert.equal(stdout, "early output\n");
  // The ladder is the discriminator: close-settled semantics never started one
  // on a clean voluntary exit, so ownedShutdown would stay false there.
  assert.equal(recorded.ownedShutdown, true);
  assert.ok((recorded.durationMs ?? 0) < 600, "the ladder bounds the wait; the 400 ms voluntary exit never gates it, saw " + String(recorded.durationMs));
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

test("the final write backpressures one message at the sink while stderr drains", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "blocker",
    drainDelayMs: 30,
    script: `
finish(() => {
  process.stderr.write("TEST_PRIVATE_STDERR_SENTINEL\\n");
  process.stderr.write("y".repeat(512 * 1024));
  for (let i = 0; i < 20; i++) emit({ type: "item.completed", item: { type: "agent_message", text: "message-" + i } });
  emit({ type: "turn.completed" });
  process.exit(0);
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.received, 1);
  assert.equal(recorded.maxPending, 1);
  assert.equal(recorded.emitted, "message-19\n");
  forbid(JSON.stringify(recorded) + stderr, "TEST_PRIVATE_STDERR_SENTINEL");
});

test("cancellation interrupts a stalled drain wait", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "accepted-stall",
    gate: "abort-received",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  emit({ type: "turn.completed" });
  process.exit(0);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.received, 1);
  assert.equal(recorded.maxPending, 1);
  // Bytes were delivered before the abort, but a cancelled run attaches no
  // payload projection — non-transactional delivery, receipt is the authority.
  assert.equal(recorded.payload, undefined);
  assert.equal(stderr, "");
});

test("an output EPIPE interrupts the drain wait as an output failure", { timeout: 30_000 }, async t => {
  const { recorded } = await runWorker(t, {
    output: "blocker",
    gate: "epipe-received",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  emit({ type: "turn.completed" });
  process.exit(0);
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
  process.exit(0);
});
`
  });
  assert.equal(recorded.status, "cancelled");
  assert.equal(recorded.received, 1);
  assert.equal(recorded.payload, undefined);
  await waitForExit(Number(await fakeFile(directory, "descendant.pid")));
});

test("a late error ack after a settled cancelled run detaches owned sink listeners", { timeout: 30_000 }, async t => {
  const { recorded, stderr } = await runWorker(t, {
    output: "abort-late-error",
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "racing" } });
  emit({ type: "turn.completed", usage: { input_tokens: 5 } });
  process.exit(0);
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
  process.exit(0);
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
      script: target === "output" ? `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "held" } });
  emit({ type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL" });
  emit({ type: "turn.completed" });
  process.exit(0);
});
` : `
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

for (const target of ["diag"] as const) {
  test(`late caller cancellation settles a prior protocol failure with pending ${target} output`, { timeout: 30_000 }, async t => {
    const { recorded } = await runWorker(t, {
      diag: "stall" as const,
      gate: "abort-after-shutdown",
      script: `finish(() => {
        emit({type:"error",message:"PRIVATE_PROTOCOL_CONTEXT"});
        process.stdout.write("invalid-json\\n");
      });`
    });
    assert.equal(recorded.status, "failed");
    assert.equal(recorded.abortAfterShutdownReached, true, "child close and group discharge must precede cancellation");
    assert.equal(recorded.error, "protocol", "late cancellation must retain the first failure cause");
    assert.equal(recorded.diagWrites, 1, "the sink must retain an unacknowledged write");
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
    outerMaxBufferBytes: 64 * 1024,
    script: `
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(stubbornChild)}], { stdio: 'ignore' });
child.unref();
fs.writeFileSync(${JSON.stringify(join(dir, "leader"))}, String(process.pid));
fs.writeFileSync(${JSON.stringify(join(dir, "descendant"))}, String(child.pid));
finish(() => {
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(700 * 1024) } });
  emit({ type: 'turn.completed' });
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
  await mkdir(join(directory, "codex-home"), { recursive: true });
  // WB-2: the real CLI refuses an uncredentialed run; this e2e stages one.
  await writeFile(join(directory, "codex-home", "auth.json"), '{"token":"fixture"}');
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
    'if (argv[0] === "exec" && argv[1] === "--help") { console.log("--json\\n--ephemeral\\n--sandbox <MODE>\\n-\\n--ignore-user-config\\n--ignore-rules\\n--output-schema <FILE>"); process.exit(0); }',
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
    version: 2,
    routingTimeoutMs: 4000,
    backends: {
      laya: { enabled: true, url: `http://127.0.0.1:${port}` },
      jev: { enabled: false, transport: { mode: "direct" } }
    },
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

// EV-1: the lifecycle CLI tests share one staging shape — a local classify
// server answering a fixed choice, a mode-driven fake codex, and the same
// config/credential staging as the hostile-worker e2e above. The fake answer
// text doubles as the content-free canary.
const LIFECYCLE_CANARY_TEXT = "lifecycle-canary-final-answer-4f9d2c";
const LIFECYCLE_RATE_LIMIT_TEXT = "upstream rate limit exceeded while the caller waited";
const LIFECYCLE_ACTIVITY_REASONING = "lifecycle-activity-reasoning-9a1b";
const LIFECYCLE_ACTIVITY_COMMAND = "lifecycle-activity-command-77c2";
const LIFECYCLE_ACTIVITY_OUTPUT = "lifecycle-activity-output-3fd8";
const LIFECYCLE_ACTIVITY_PATH = "/lifecycle-activity/path-5e07";
const LIFECYCLE_ACTIVITY_MCP = "lifecycle-activity-mcp-secret-b1d4";
type FakeWorkerMode = "single-message" | "stall" | "event-flood" | "rate-fail" | "protocol-fail" | "activity";

const stageLifecycleCli = async (t: TestContext, mode: FakeWorkerMode): Promise<{ root: string; spawnCli: (args: string[]) => ChildProcess }> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const root = join(directory, "root");
  await mkdir(bin, { recursive: true });
  await mkdir(join(directory, "codex-home"), { recursive: true });
  await writeFile(join(directory, "codex-home", "auth.json"), '{"token":"fixture"}');
  await mkdir(join(root, ".turnhelm"), { recursive: true });
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
  const frames: string[] = [];
  if (mode === "event-flood") {
    for (let index = 0; index < 100; index += 1) {
      // Maximally populated valid activity details; the exit code distinguishes frames.
      frames.push(JSON.stringify({ type: "item.completed", item: {
        type: "command_execution", status: "completed", exit_code: index,
        command: LIFECYCLE_ACTIVITY_COMMAND, aggregated_output: LIFECYCLE_ACTIVITY_OUTPUT
      } }));
    }
  }
  if (mode === "activity") {
    frames.push(
      JSON.stringify({ type: "item.started", item: { type: "reasoning", summary: LIFECYCLE_ACTIVITY_REASONING } }),
      JSON.stringify({ type: "item.updated", item: { type: "reasoning", status: "in_progress" } }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: LIFECYCLE_ACTIVITY_COMMAND } }),
      JSON.stringify({ type: "item.updated", item: { type: "command_execution", status: "in_progress", command: LIFECYCLE_ACTIVITY_COMMAND } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 13, command: LIFECYCLE_ACTIVITY_COMMAND, aggregated_output: LIFECYCLE_ACTIVITY_OUTPUT } }),
      JSON.stringify({ type: "item.completed", item: { type: "file_change", status: "completed", path: LIFECYCLE_ACTIVITY_PATH } }),
      JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", arguments: { secret: LIFECYCLE_ACTIVITY_MCP } } }),
      JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", status: "failed", exit_code: 3, arguments: { secret: LIFECYCLE_ACTIVITY_MCP } } })
    );
  }
  frames.push(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: LIFECYCLE_CANARY_TEXT } }));
  if (mode !== "stall") frames.push(JSON.stringify({ type: "turn.completed" }));
  if (mode === "rate-fail") {
    frames.length = 0;
    frames.push(JSON.stringify({ type: "error", message: LIFECYCLE_RATE_LIMIT_TEXT }));
    frames.push(JSON.stringify({ type: "turn.failed", message: LIFECYCLE_RATE_LIMIT_TEXT }));
  }
  if (mode === "protocol-fail") {
    frames.length = 0;
    frames.push("!!!not-a-json-frame");
  }
  await executableFixture(join(bin, "codex"), [
    `#!${process.execPath}`,
    "const argv = process.argv.slice(2);",
    'if (argv[0] === "--version") { console.log("codex-cli 0.160.2"); process.exit(0); }',
    'if (argv[0] === "exec" && argv[1] === "--help") { console.log("--json\\n--ephemeral\\n--sandbox <MODE>\\n-\\n--ignore-user-config\\n--ignore-rules\\n--output-schema <FILE>"); process.exit(0); }',
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", () => {});",
    "process.stdin.on(\"end\", () => {",
    `  ${JSON.stringify(frames)}.forEach(frame => process.stdout.write(frame + "\\n"));`,
    ...(mode === "stall" ? [
      "  require(\"node:fs\").writeFileSync(require(\"node:path\").join(process.cwd(), \"stalled-worker.pid\"), String(process.pid));",
      "  setInterval(() => {}, 1000);"
    ] : [
      "  process.exit(0);"
    ]),
    "});"
  ].join("\n"), "node");
  await executableFixture(join(bin, "git"), "#!/bin/sh\nif [ \"$1\" = \"-C\" ]; then echo true; exit 0; fi\nexit 64\n", "shell");
  await writeFile(join(root, ".turnhelm", "config.json"), JSON.stringify({
    version: 2,
    routingTimeoutMs: 4000,
    backends: {
      laya: { enabled: true, url: `http://127.0.0.1:${port}` },
      jev: { enabled: false, transport: { mode: "direct" } }
    },
    profiles: {
      fast: { model: "gpt-6-luna", effort: "low" },
      balanced: { model: "gpt-6.1-sol", effort: "medium" },
      deep: { model: "gpt-6.1-sol", effort: "high" },
      frontier: { model: "gpt-6-astra", effort: "high" },
      frontier_xhigh: { model: "gpt-6-astra", effort: "xhigh" },
      frontier_max: { model: "gpt-6-astra", effort: "max" }
    }
  }));
  const spawnCli = (args: string[]): ChildProcess => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)), "run", ...args, "Summarize the pending pago row in one line."
    ], { cwd: root, env: { PATH: bin, LAYA_API_KEY: "dummy-laya-key", CODEX_HOME: join(directory, "codex-home") } });
    const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
    t.after(() => { clearTimeout(guard); child.kill("SIGKILL"); });
    return child;
  };
  return { root, spawnCli };
};

const collectRun = (child: ChildProcess): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.stdin?.end();
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });

const receiptOf = (stderr: string): Record<string, unknown> => {
  const receiptLines = stderr.split("\n").filter(line => line.includes("turnhelm.receipt"));
  assert.equal(receiptLines.length, 1, "exactly one receipt line");
  return JSON.parse(receiptLines[0]) as Record<string, unknown>;
};

test("a completed run's receipt carries a bounded content-free lifecycle", { timeout: 30_000 }, async t => {
  const { spawnCli } = await stageLifecycleCli(t, "single-message");
  const run = await collectRun(spawnCli(["--lifecycle"]));
  assert.equal(run.code, 0, "the run completes: " + run.stderr);
  const lifecycle = ((receiptOf(run.stderr).worker as Record<string, unknown>).lifecycle ?? null) as
    { events: { kind: string }[]; overflow: boolean } | null;
  assert.ok(lifecycle !== null, "the receipt worker object carries a lifecycle projection");
  assert.ok(lifecycle.events.length > 0, "the ring is non-empty");
  assert.equal(lifecycle.events[0].kind, "spawned", "the ring begins at spawn");
  assert.equal(lifecycle.events.at(-1)?.kind, "settle", "the ring ends at settlement");
  assert.ok(!JSON.stringify(lifecycle).includes(LIFECYCLE_CANARY_TEXT), "the lifecycle projection stays content-free");
});

test("a reported worker failure rides the lifecycle timeline with its class", { timeout: 30_000 }, async t => {
  const { spawnCli } = await stageLifecycleCli(t, "rate-fail");
  const run = await collectRun(spawnCli(["--lifecycle"]));
  assert.notEqual(run.code, 0, "the reported failure fails the run");
  const lifecycle = ((receiptOf(run.stderr).worker as Record<string, unknown>).lifecycle ?? null) as
    { events: { kind: string; detail?: { class?: string } }[]; overflow: boolean } | null;
  assert.ok(lifecycle !== null, "the receipt worker object carries a lifecycle projection");
  const failure = lifecycle.events.find(event => event.kind === "failure");
  assert.ok(failure !== undefined, "the timeline keeps the failure milestone");
  assert.equal(failure.detail?.class, "rate-limit",
    "the observed failure class from the frozen taxonomy rides the event, never the raw text");
  assert.equal(lifecycle.events.at(-1)?.kind, "settle", "the ring still ends at settlement");
  assert.ok(!JSON.stringify(lifecycle).includes(LIFECYCLE_RATE_LIMIT_TEXT),
    "the class projection stays content-free: no failure prose");
});

test("a transport failure rides the lifecycle timeline with its cause", { timeout: 30_000 }, async t => {
  const { spawnCli } = await stageLifecycleCli(t, "protocol-fail");
  const run = await collectRun(spawnCli(["--lifecycle"]));
  assert.notEqual(run.code, 0, "the protocol failure fails the run");
  const lifecycle = ((receiptOf(run.stderr).worker as Record<string, unknown>).lifecycle ?? null) as
    { events: { kind: string; detail?: { class?: string } }[]; overflow: boolean } | null;
  assert.ok(lifecycle !== null, "the receipt worker object carries a lifecycle projection");
  const failure = lifecycle.events.find(event => event.kind === "failure");
  assert.ok(failure !== undefined, "the timeline keeps the failure milestone");
  assert.equal(failure.detail?.class, "protocol",
    "the parent-observed transport cause rides the event");
  assert.equal(lifecycle.events.at(-1)?.kind, "settle", "the ring still ends at settlement");
});

test("the lifecycle journal outlives an outer kill before settlement", { timeout: 30_000 }, async t => {
  const { root, spawnCli } = await stageLifecycleCli(t, "stall");
  const child = spawnCli(["--lifecycle"]);
  // The positional task rides argv; stdin still ends so readTask's non-TTY
  // collectInput completes instead of holding the CLI before classification.
  child.stdin?.end();
  const journalPath = join(root, ".turnhelm", "lifecycle.jsonl");
  const sawEvent = (text: string): boolean => text.split("\n").some(line => {
    if (line === "") return false;
    try {
      const entry = JSON.parse(line) as { type?: string; pid?: number; kind?: string };
      return entry.type === "turnhelm.worker-lifecycle" && entry.pid === child.pid && entry.kind === "event";
    } catch {
      return false;
    }
  });
  const deadline = Date.now() + 15_000;
  let journaled = "";
  while (Date.now() < deadline) {
    journaled = await readFile(journalPath, "utf8").catch(() => "");
    if (sawEvent(journaled)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.on("close", resolve));
  }
  // The stalled fake worker never exits on its own; stop it now.
  const workerPid = Number(await readFile(join(root, "stalled-worker.pid"), "utf8").catch(() => ""));
  if (Number.isInteger(workerPid) && workerPid > 0) {
    try { process.kill(workerPid, "SIGKILL"); } catch { /* the stalled fake is already gone */ }
  }
  const text = await readFile(journalPath, "utf8").catch(() => "");
  assert.ok(sawEvent(text), "a decoded event was journaled before the kill");
  const kinds = text.split("\n").filter(line => line !== "").map(line => {
    try { return JSON.parse(line) as { pid?: number; kind?: string }; } catch { return { pid: undefined, kind: undefined }; }
  }).filter(entry => entry.pid === child.pid).map(entry => entry.kind);
  assert.ok(kinds.includes("spawned"), "spawned is journaled before the kill");
  assert.ok(kinds.includes("event"), "the decoded event is journaled for this CLI pid");
  assert.ok(!kinds.includes("settle"), "a killed run journals no settlement");
});

test("the stall-abort flag drives the owned ladder and lands on the receipt timeline", { timeout: 30_000 }, async t => {
  const { root, spawnCli } = await stageLifecycleCli(t, "stall");
  const child = spawnCli(["--lifecycle", "--stall-abort-ms", "5000"]);
  child.stdin?.end();
  const run = await collectRun(child);
  // The ladder's TERM ends the stalled fake; workerExit keeps the observed 143.
  assert.equal(run.code, 143);
  const worker = receiptOf(run.stderr).worker as Record<string, unknown> as {
    status: string; abortReason?: string; ownedShutdown: boolean; signal?: string; progressEvents: number;
    lifecycle?: { events: { kind: string }[]; overflow: boolean };
  };
  assert.equal(worker.status, "cancelled");
  assert.equal(worker.abortReason, "stall");
  assert.equal(worker.ownedShutdown, true);
  assert.equal(worker.signal, "SIGTERM");
  assert.equal(worker.progressEvents, 1);
  const kinds = (worker.lifecycle?.events ?? []).map(event => event.kind);
  assert.ok(kinds.includes("stall-abort"), "the stall is on the timeline");
  assert.ok(kinds.indexOf("stall-abort") < kinds.indexOf("shutdown-term"),
    "the stall record precedes the ladder");
  assert.equal(kinds.at(-1), "settle");
  assert.ok(!kinds.includes("abort"), "no caller abort happened");
  // The stalled fake dies by the ladder; clean up any straggler defensively.
  const workerPid = Number(await readFile(join(root, "stalled-worker.pid"), "utf8").catch(() => ""));
  if (Number.isInteger(workerPid) && workerPid > 0) {
    try { process.kill(workerPid, "SIGKILL"); } catch { /* the ladder already took it */ }
  }
});

test("an event flood trips the overflow marker without losing the settlement tail", { timeout: 30_000 }, async t => {
  const { root, spawnCli } = await stageLifecycleCli(t, "event-flood");
  const child = spawnCli(["--lifecycle"]);
  const run = await collectRun(child);
  assert.equal(run.code, 0, "the run completes: " + run.stderr);
  const receiptLine = run.stderr.split("\n").filter(line => line.includes("turnhelm.receipt"))[0] ?? "";
  assert.ok(Buffer.byteLength(receiptLine, "utf8") < 65536, "the maximally populated 64-entry receipt stays under the line cap");
  const lifecycle = ((receiptOf(run.stderr).worker as Record<string, unknown>).lifecycle ?? null) as
    { events: { kind: string; detail?: { itemExitCode?: number } }[]; overflow: boolean } | null;
  assert.ok(lifecycle !== null, "the receipt worker object carries a lifecycle projection");
  assert.equal(lifecycle.overflow, true, "the decoded frames overflow the 64-entry ring");
  assert.equal(lifecycle.events.length, 64, "the ring keeps exactly the capacity");
  assert.equal(lifecycle.events[0].kind, "spawned", "the head keeps the spawn");
  assert.equal(lifecycle.events.at(-1)?.kind, "settle", "the settlement tail survives the flood");
  // One journal append per decoded frame; concurrent best-effort appends may
  // interleave, so the counts are order-independent (the ring, recorded
  // synchronously, is the ordered evidence — journal order is approximate).
  const journal = await readFile(join(root, ".turnhelm", "lifecycle.jsonl"), "utf8");
  const journaled = journal.split("\n").filter(line => line !== "")
    .map(line => JSON.parse(line) as { type?: string; pid?: number; kind?: string; detail?: { itemExitCode?: number } })
    .filter(entry => entry.type === "turnhelm.worker-lifecycle" && entry.pid === child.pid);
  assert.ok(journaled.length > 64, "the journal saw every recorded event: " + journaled.length);
  assert.equal(journaled.filter(entry => entry.kind === "event").length, 102, "one event append per decoded frame");
  const journalCodes = journaled
    .filter(entry => entry.kind === "event" && entry.detail?.itemExitCode !== undefined)
    .map(entry => entry.detail?.itemExitCode).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(journalCodes, Array.from({ length: 100 }, (_, index) => index),
    "each decoded activity frame is appended exactly once");
  // The ring is exactly head 8 (spawn, stdin delivery, frames 0-5) plus the
  // last 56 recorded events (frames 52-99 then the settlement tail).
  const ringCodes = lifecycle.events
    .map(event => (event.detail as { itemExitCode?: number } | undefined)?.itemExitCode);
  assert.deepEqual(ringCodes.slice(0, 8), [undefined, undefined, 0, 1, 2, 3, 4, 5],
    "the head keeps spawn, stdin delivery, and the first six frames");
  assert.deepEqual(ringCodes.slice(8, 56), Array.from({ length: 48 }, (_, index) => index + 52),
    "the tail keeps the last 48 activity frames in decode order");
  assert.ok(ringCodes.slice(56).every(code => code === undefined), "the final eight entries are the settlement tail");
  const surfaces = run.stdout + run.stderr + journal;
  forbid(surfaces, LIFECYCLE_ACTIVITY_COMMAND, LIFECYCLE_ACTIVITY_OUTPUT);
});

test("decoded activity rides the lifecycle receipt and journal without content", { timeout: 30_000 }, async t => {
  const { root, spawnCli } = await stageLifecycleCli(t, "activity");
  const child = spawnCli(["--lifecycle"]);
  const run = await collectRun(child);
  assert.equal(run.code, 0, "the run completes: " + run.stderr);
  const receipt = receiptOf(run.stderr);
  const lifecycle = ((receipt.worker as Record<string, unknown>).lifecycle ?? null) as
    { events: { kind: string; detail?: Record<string, unknown> }[]; overflow: boolean } | null;
  assert.ok(lifecycle !== null, "the receipt worker object carries a lifecycle projection");
  const activity = lifecycle.events
    .filter(event => event.kind === "event" && event.detail?.eventKind === "activity")
    .map(event => event.detail);
  assert.deepEqual(activity, [
    { eventKind: "activity", itemKind: "reasoning", itemPhase: "started" },
    { eventKind: "activity", itemKind: "reasoning", itemPhase: "updated", itemStatus: "in_progress" },
    { eventKind: "activity", itemKind: "command_execution", itemPhase: "started" },
    { eventKind: "activity", itemKind: "command_execution", itemPhase: "updated", itemStatus: "in_progress" },
    { eventKind: "activity", itemKind: "command_execution", itemPhase: "completed", itemStatus: "completed", itemExitCode: 13 },
    { eventKind: "activity", itemKind: "file_change", itemPhase: "completed", itemStatus: "completed" },
    { eventKind: "activity", itemKind: "other", itemPhase: "started" },
    { eventKind: "activity", itemKind: "other", itemPhase: "completed", itemStatus: "failed" }
  ], "the sanitized activity projections match the spec exactly");
  // Only completed non-agent items report the fixed diagnostic; started/updated stay silent.
  assert.equal(run.stderr.split("\n").filter(line => line === "turnhelm: worker-activity").length, 3,
    "exactly the three completed non-agent items report worker-activity");
  assert.ok(!run.stderr.includes("tool-progress"), "the retired diagnostic category is gone");
  assert.equal(run.stdout, LIFECYCLE_CANARY_TEXT + "\n", "stdout still carries exactly the final message");
  const surfaces = run.stdout + run.stderr + JSON.stringify(receipt);
  forbid(surfaces, LIFECYCLE_ACTIVITY_REASONING, LIFECYCLE_ACTIVITY_COMMAND, LIFECYCLE_ACTIVITY_OUTPUT,
    LIFECYCLE_ACTIVITY_PATH, LIFECYCLE_ACTIVITY_MCP);
  const journal = await readFile(join(root, ".turnhelm", "lifecycle.jsonl"), "utf8");
  const journaledActivity = journal.split("\n").filter(line => line !== "")
    .map(line => JSON.parse(line) as { type?: string; pid?: number; kind?: string; detail?: Record<string, unknown> })
    .filter(entry => entry.type === "turnhelm.worker-lifecycle" && entry.pid === child.pid
      && entry.kind === "event" && entry.detail?.eventKind === "activity")
    .map(entry => JSON.stringify(entry.detail)).sort();
  assert.equal(journaledActivity.length, 8, "one journal append per decoded activity frame");
  assert.deepEqual(journaledActivity, activity.map(detail => JSON.stringify(detail)).sort(),
    "the journal carries the same sanitized projections, order-independent");
  forbid(journal, LIFECYCLE_ACTIVITY_COMMAND, LIFECYCLE_ACTIVITY_REASONING, LIFECYCLE_ACTIVITY_MCP);
});

test("without the lifecycle flag no lifecycle receipt or journal exists", { timeout: 30_000 }, async t => {
  const { root, spawnCli } = await stageLifecycleCli(t, "activity");
  const run = await collectRun(spawnCli([]));
  assert.equal(run.code, 0, "the run completes: " + run.stderr);
  const receipt = receiptOf(run.stderr);
  assert.equal((receipt.worker as Record<string, unknown>).lifecycle, undefined,
    "no lifecycle projection rides the receipt without the flag");
  assert.equal(await readFile(join(root, ".turnhelm", "lifecycle.jsonl"), "utf8").catch(() => ""), "",
    "no lifecycle journal is written without the flag");
});
