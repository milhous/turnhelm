import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseProjectConfig } from "../src/config.js";
import { readProjectFile } from "../src/project.js";
import {
  appendEvidence, claimAcceptance, executeAcceptance, findOnPath, prepareAcceptance, superviseCli,
  type AcceptanceManifest, type ClaimedRun, type SafeEvidence
} from "./live-acceptance.js";


const execute = promisify(execFile);
const sha256hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// tsc copies no JSON into dist; both paths resolve from dist/test back to the repo.
const CORPUS_PATH = fileURLToPath(new URL("../../test/fixtures/live-acceptance.json", import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL("../../assets/config.json", import.meta.url));

// Preload trap (CJS): every classifier transport on this codebase goes through
// node:http/node:https exports or global fetch; every subprocess goes through
// child_process. Counting and refusing them inside the child proves prepare
// is offline, whatever code path it would take.
const PREPARE_TRAP_PRELOAD = `const state = { httpCalls: 0, fetchCalls: 0, spawned: [] };
for (const name of ["node:http", "node:https"]) {
  const mod = require(name);
  for (const api of ["request", "get"]) {
    mod[api] = function () {
      state.httpCalls++;
      throw new Error("prepare made a network call via " + name + "." + api);
    };
  }
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = function () {
    state.fetchCalls++;
    throw new Error("prepare made a network call via fetch");
  };
}
const cp = require("node:child_process");
const customPromisify = require("node:util").promisify.custom;
for (const api of ["spawn", "execFile", "exec"]) {
  const original = cp[api];
  const wrapped = function (file, ...rest) {
    state.spawned.push(String(file));
    return original.apply(this, [file, ...rest]);
  };
  const originalCustom = original[customPromisify];
  if (typeof originalCustom === "function") {
    // Keep the wrapper promisify-compatible so trapped code sees {stdout, stderr}.
    const wrappedCustom = function (file, ...rest) {
      state.spawned.push(String(file));
      return originalCustom.apply(this, [file, ...rest]);
    };
    wrappedCustom[customPromisify] = wrappedCustom;
    wrapped[customPromisify] = wrappedCustom;
  }
  cp[api] = wrapped;
}
require("node:module").syncBuiltinESMExports();
globalThis.__TURNHELM_PREPARE_TRAP = state;
`;

const PREPARE_CHILD = `const trap = globalThis.__TURNHELM_PREPARE_TRAP;
const mod = await import(process.argv[2]);
const results = {};
for (const suite of ["laya", "jev", "dual", "calibration-dev", "calibration-holdout"]) {
  results[suite] = await mod.prepareAcceptance(suite);
}
process.stdout.write("PREPARE_RESULT " + JSON.stringify({
  results,
  httpCalls: trap.httpCalls,
  fetchCalls: trap.fetchCalls,
  spawned: trap.spawned
}) + "\\n");
`;

type PrepareOutcome = {
  results: Record<"laya" | "jev" | "dual" | "calibration-dev" | "calibration-holdout",
    { manifestPath: string; sha256: string }>;
  httpCalls: number;
  fetchCalls: number;
  spawned: string[];
};

const runPreparesOffline = async (t: TestContext): Promise<PrepareOutcome> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-accept-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "prepare-trap.cjs");
  const childScript = join(directory, "prepare-child.mjs");
  await writeFile(preload, PREPARE_TRAP_PRELOAD);
  await writeFile(childScript, PREPARE_CHILD);
  const harness = pathToFileURL(fileURLToPath(new URL("./live-acceptance.js", import.meta.url))).href;
  const run = await execute(process.execPath, ["--require", preload, childScript, harness],
    { encoding: "utf8", timeout: 120000 }).catch((failure: { stdout?: string; stderr?: string }) => {
    assert.fail(`prepare child failed: ${String(failure.stderr)} ${String(failure.stdout)}`);
  });
  const line = String(run.stdout).split("\n").find(candidate => candidate.startsWith("PREPARE_RESULT "));
  assert.ok(line, "the prepare child must print one PREPARE_RESULT line");
  return JSON.parse(line.slice("PREPARE_RESULT ".length)) as PrepareOutcome;
};

const loadManifest = async (manifestPath: string): Promise<AcceptanceManifest> =>
  JSON.parse(await readFile(manifestPath, "utf8")) as AcceptanceManifest;

const pair = (profile: { model: string; effort: string }) => `${profile.model}/${profile.effort}`;

const prepareJev = async (t: TestContext) => {
  const prepared = await prepareAcceptance("jev");
  t.after(() => rm(dirname(prepared.manifestPath), { recursive: true, force: true }));
  return prepared;
};

// Spec §4.3 frozen verbatim: the calibration corpus the v2 suites must
// prepare — eight tasks, two splits, exactly one en/zh pair per pairId,
// fixed allowed-profile bands.
const SPEC_CALIBRATION: Readonly<Record<"dev" | "holdout", readonly {
  id: string;
  pairId: string;
  language: "en" | "zh";
  split: "dev" | "holdout";
  task: string;
  allowedProfiles: readonly string[];
}[]>> = {
  dev: [
    { id: "heading-en", pairId: "heading", language: "en", split: "dev",
      task: "Rename the README heading to Turnhelm; change only that line.",
      allowedProfiles: ["fast", "balanced"] },
    { id: "heading-zh", pairId: "heading", language: "zh", split: "dev",
      task: "把 README 的标题改成 Turnhelm，只改这一行。",
      allowedProfiles: ["fast", "balanced"] },
    { id: "race-en", pairId: "race", language: "en", split: "dev",
      task: "Investigate a worker/database race: an enqueued job sometimes runs before the creating transaction commits and reads missing data. Trace the transaction, enqueue, and worker-read ordering; fix the cause and add a deterministic regression test. Limit changes to this flow; preserve successful-job behavior.",
      allowedProfiles: ["deep", "frontier", "frontier_xhigh"] },
    { id: "race-zh", pairId: "race", language: "zh", split: "dev",
      task: "排查 worker 与数据库的竞态：入队任务有时在创建它的事务提交前执行，读不到数据。追踪事务、入队和 worker 读取的顺序，修复根因并添加确定性回归测试。只改这一条流程，保持成功任务的行为不变。",
      allowedProfiles: ["deep", "frontier", "frontier_xhigh"] }
  ],
  holdout: [
    { id: "decoy-en", pairId: "decoy", language: "en", split: "holdout",
      task: 'In README, rename the heading "Security architecture" to "Security"; change only that heading line, with no code or behavior changes.',
      allowedProfiles: ["fast", "balanced"] },
    { id: "decoy-zh", pairId: "decoy", language: "zh", split: "holdout",
      task: "在 README 中把标题“Security architecture”改成“Security”；只改这行标题，不修改代码或行为。",
      allowedProfiles: ["fast", "balanced"] },
    { id: "auth-en", pairId: "auth", language: "en", split: "holdout",
      task: "Review tenant isolation and token revocation across an API gateway, session store, and asynchronous workers. Analyze concurrent token rotation, revocation during store outages, and sensitive data leakage in telemetry; provide evidence, attack timelines, trade-offs, and a minimal remediation and regression-test plan. Do not change files.",
      allowedProfiles: ["frontier", "frontier_xhigh", "frontier_max"] },
    { id: "auth-zh", pairId: "auth", language: "zh", split: "holdout",
      task: "审查 API 网关、会话存储和异步 worker 之间的租户隔离与令牌撤销。分析并发令牌轮换、存储故障期间撤销以及遥测中的敏感数据泄漏，给出证据、攻击时序、权衡和最小修复与回归测试计划。不要修改文件。",
      allowedProfiles: ["frontier", "frontier_xhigh", "frontier_max"] }
  ]
};

const CALIBRATION_SUITES = ["calibration-dev", "calibration-holdout"] as const;

test("aliases match but replaced or unsafe roots fail", async t => {
  // A directory alias resolves to the same dev/ino and must claim cleanly.
  const direct = await prepareJev(t);
  const runRoot = dirname(direct.manifestPath);
  const aliasDir = join(dirname(runRoot), "claim-alias");
  await symlink(runRoot, aliasDir);
  t.after(() => rm(aliasDir, { force: true }));
  const claimed = await claimAcceptance(join(aliasDir, "manifest.json"), direct.sha256);
  assert.equal(claimed.manifestSha256, direct.sha256);
  const evidenceInfo = await stat(claimed.evidencePath);
  assert.ok(evidenceInfo.isFile());
  assert.equal(evidenceInfo.size, 0, "the claim itself writes no evidence");
  assert.equal(evidenceInfo.mode & 0o777, 0o600);
  await claimed.handle.close();

  // A symlink standing in for the manifest itself is refused.
  const linked = await prepareJev(t);
  const fakeManifest = join(dirname(linked.manifestPath), "alias-manifest.json");
  await symlink("manifest.json", fakeManifest);
  await assert.rejects(() => claimAcceptance(fakeManifest, linked.sha256));

  // A manifest relocated out of its frozen run root never claims.
  const moved = await prepareJev(t);
  const elsewhere = await mkdtemp(join(tmpdir(), "turnhelm-claim-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await copyFile(moved.manifestPath, join(elsewhere, "manifest.json"));
  await assert.rejects(() => claimAcceptance(join(elsewhere, "manifest.json"), moved.sha256), /run root/);

  // A replaced consumer root (same path, new inode) fails identity. On
  // filesystems that recycle the freed inode immediately (ext4/overlayfs, as
  // in CI), identity still matches and the frozen-bytes check rejects instead
  // — either way a replaced root never claims.
  const replaced = await prepareJev(t);
  const replacedRoot = (await loadManifest(replaced.manifestPath)).cases[0].root;
  await rm(replacedRoot, { recursive: true, force: true });
  await mkdir(replacedRoot);
  await assert.rejects(() => claimAcceptance(replaced.manifestPath, replaced.sha256), /case root|frozen bytes/);

  // Symlinked and FIFO case files are unsafe even with identical bytes.
  const unsafe = await prepareJev(t);
  const unsafeRoot = (await loadManifest(unsafe.manifestPath)).cases[0].root;
  const configPath = join(unsafeRoot, ".turnhelm/config.json");
  const sameBytes = await readFile(configPath);
  await rm(configPath);
  await writeFile(join(unsafeRoot, "config.copy"), sameBytes);
  await symlink("config.copy", configPath);
  await assert.rejects(() => claimAcceptance(unsafe.manifestPath, unsafe.sha256), /symbolic link/);
  await rm(configPath);
  await rm(join(unsafeRoot, "config.copy"));
  await execute("mkfifo", [configPath]);
  await assert.rejects(() => claimAcceptance(unsafe.manifestPath, unsafe.sha256), /not a regular file/);

  // Drifted case bytes fail even when still legal configurations.
  const drifted = await prepareJev(t);
  const driftedRoot = (await loadManifest(drifted.manifestPath)).cases[0].root;
  await writeFile(join(driftedRoot, "input.json"), JSON.stringify({ values: [1] }));
  await assert.rejects(() => claimAcceptance(drifted.manifestPath, drifted.sha256), /frozen bytes/);
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as { workerFixtureInput: { values: number[] } };
  await writeFile(join(driftedRoot, "input.json"), JSON.stringify(corpus.workerFixtureInput));
  const legalConfig = JSON.parse(await readFile(join(driftedRoot, ".turnhelm/config.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(driftedRoot, ".turnhelm/config.json"), JSON.stringify({ ...legalConfig, routingTimeoutMs: 20000 }, null, 2) + "\n");
  await assert.rejects(() => claimAcceptance(drifted.manifestPath, drifted.sha256), /frozen bytes/);
});

test("only one concurrent execute can claim", async t => {
  const prepared = await prepareJev(t);
  const attempts = await Promise.allSettled([
    claimAcceptance(prepared.manifestPath, prepared.sha256),
    claimAcceptance(prepared.manifestPath, prepared.sha256)
  ]);
  const winners = attempts.filter(attempt => attempt.status === "fulfilled") as PromiseFulfilledResult<ClaimedRun>[];
  const losers = attempts.filter(attempt => attempt.status === "rejected") as PromiseRejectedResult[];
  assert.equal(winners.length, 1, "exactly one claim wins");
  assert.equal(losers.length, 1);
  assert.match(String(losers[0].reason), /already been claimed/);
  await stat(winners[0].value.evidencePath);
  await winners[0].value.handle.close();
});

test("empty or truncated evidence is never replayed", async t => {
  const prepared = await prepareJev(t);
  const evidenceDir = join(dirname(prepared.manifestPath), "evidence");
  await mkdir(evidenceDir, { mode: 0o700 });
  const evidencePath = join(evidenceDir, "evidence.jsonl");
  const variants = [
    "",
    '{"phase":"prep',
    JSON.stringify({ phase: "prepared", suite: "jev", manifestSha256: prepared.sha256, startedAt: "2026-10-11T00:00:00.000Z" }) + "\n"
      + JSON.stringify({ phase: "stopped", caseId: null, reason: "signal" }) + "\n"
  ];
  for (const variant of variants) {
    await writeFile(evidencePath, variant, { mode: 0o600 });
    await assert.rejects(() => claimAcceptance(prepared.manifestPath, prepared.sha256), /already been claimed/);
    assert.equal(await readFile(evidencePath, "utf8"), variant, "a failed claim never touches existing evidence");
  }
});

test("claimed manifests are immutable in memory", async t => {
  const prepared = await prepareJev(t);
  const run = await claimAcceptance(prepared.manifestPath, prepared.sha256);
  t.after(() => run.handle.close());
  const item = run.manifest.cases[0];
  const oracle = item.oracle as Extract<typeof item.oracle, { kind: "stdout-json" }>;
  for (const frozen of [run.manifest, run.manifest.caps, run.manifest.baseline, run.manifest.baseline.tools,
    run.manifest.cases, item, item.identity, item.reservation, item.reservation.backends,
    item.inputHashes, item.allowedChanges, item.oracle, oracle.expected]) {
    assert.ok(Object.isFrozen(frozen), "every parsed manifest object is frozen after claim");
  }
});

test("tool drift between prepare and claim rejects", async t => {
  const classifier = await startClassifierFixture(t);
  const run = await buildRun(t, "laya", classifier.url, [{ id: "tool-drift", kind: "worker-readonly" }]);
  const recraft = async (mutate: (tools: Record<string, unknown>) => void): Promise<string> => {
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8")) as Record<string, unknown>;
    const tools = (manifest.baseline as Record<string, unknown>).tools as Record<string, unknown>;
    mutate(tools);
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(run.manifestPath, bytes);
    return sha256hex(Buffer.from(bytes, "utf8"));
  };
  const driftedNode = await recraft(tools => { tools.node = "v0.0.0-not-this-runtime"; });
  await assert.rejects(() => claimAcceptance(run.manifestPath, driftedNode), /tools drifted/);
  const driftedExec = await recraft(tools => { tools.execPath = "/nonexistent/node"; });
  await assert.rejects(() => claimAcceptance(run.manifestPath, driftedExec), /tools drifted/);
});

test("drift rejects before requests", async t => {
  const requests: string[] = [];
  t.mock.method(http, "request", () => { requests.push("http"); throw new Error("claim must not make requests"); });
  t.mock.method(https, "request", () => { requests.push("https"); throw new Error("claim must not make requests"); });
  t.mock.method(globalThis, "fetch", () => { requests.push("fetch"); throw new Error("claim must not make requests"); });
  const prepared = await prepareJev(t);
  // Corpus and baseline drift share the same compared-hash code path exercised
  // here through the manifest bytes; tampering repo-owned baseline files in a
  // test would risk a dirty tree for no extra coverage.
  const tampered = JSON.parse(await readFile(prepared.manifestPath, "utf8")) as { caps: { worker: number } };
  tampered.caps.worker = 99;
  await writeFile(prepared.manifestPath, JSON.stringify(tampered, null, 2) + "\n");
  await assert.rejects(() => claimAcceptance(prepared.manifestPath, prepared.sha256), /approved sha256/);
  assert.deepEqual(requests, []);
});

test("reservation sync precedes a call", async t => {
  const prepared = await prepareJev(t);
  const run = await claimAcceptance(prepared.manifestPath, prepared.sha256);
  t.after(() => run.handle.close());

  // A call may begin only once the starting state (the prepared record pins
  // the manifest, whose host snapshot is frozen) and the reservation are
  // durable — the discipline Task 3's execute follows.
  let calls = 0;
  const events: string[] = [];
  const originalWrite = run.handle.appendFile.bind(run.handle);
  const originalSync = run.handle.sync.bind(run.handle);
  t.mock.method(run.handle, "appendFile", async (data: Buffer) => { events.push("write"); return originalWrite(data); });
  t.mock.method(run.handle, "sync", async () => { events.push("sync"); return originalSync(); });

  await appendEvidence(run, { phase: "prepared", suite: "jev", manifestSha256: run.manifestSha256, startedAt: new Date().toISOString() });
  await appendEvidence(run, { phase: "reserved", caseId: "jev-default-readonly", worker: 1, backends: ["jev"] });
  calls += 1;
  assert.equal(calls, 1);
  assert.deepEqual(events, ["write", "sync", "write", "sync"],
    "every phase appends and syncs before the next append");

  const lines = (await readFile(run.evidencePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].phase, "prepared");
  assert.equal(lines[0].manifestSha256, run.manifestSha256);
  assert.equal(lines[1].phase, "reserved");

  // Appends serialize: concurrent submissions land in submission order.
  events.length = 0;
  await Promise.all([
    appendEvidence(run, { phase: "observed", caseId: "jev-default-readonly", backend: "jev", profileId: "default", rootMatches: true, exitCode: 0, durationMs: 5, attempts: 1 }),
    appendEvidence(run, { phase: "verified", caseId: "jev-default-readonly", verdict: "pass", policy: "not-applicable", checks: {} })
  ]);
  assert.deepEqual(events, ["write", "sync", "write", "sync"]);

  // fs error injection: a failing sync stops the run before any call.
  t.mock.method(run.handle, "sync", async () => { throw new Error("injected sync failure"); });
  try {
    await appendEvidence(run, { phase: "stopped", caseId: null, reason: "signal" });
    calls += 1;
  } catch { /* the run stops instead */ }
  assert.equal(calls, 1, "a failed sync never admits a call");
});

test("safe observation survives a failing oracle", async t => {
  const prepared = await prepareJev(t);
  const run = await claimAcceptance(prepared.manifestPath, prepared.sha256);
  t.after(() => run.handle.close());

  await appendEvidence(run, { phase: "prepared", suite: "jev", manifestSha256: run.manifestSha256, startedAt: new Date().toISOString() });
  await appendEvidence(run, { phase: "reserved", caseId: "jev-default-readonly", worker: 1, backends: ["jev"] });
  await appendEvidence(run, { phase: "observed", caseId: "jev-default-readonly", backend: "jev", profileId: "default", rootMatches: true, exitCode: 0, durationMs: 42, attempts: 1 });
  await appendEvidence(run, { phase: "verified", caseId: "jev-default-readonly", verdict: "fail", policy: "not-applicable", checks: { "stdout-shape": false } });
  await appendEvidence(run, { phase: "stopped", caseId: "jev-default-readonly", reason: "verdict" });

  const lines = (await readFile(run.evidencePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.phase), ["prepared", "reserved", "observed", "verified", "stopped"]);
  const observed = lines[2];
  assert.deepEqual(Object.keys(observed).sort(),
    ["attempts", "backend", "caseId", "durationMs", "exitCode", "phase", "profileId", "rootMatches"]);
  assert.equal(observed.backend, "jev");
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.durationMs, 42, "the observation survives the failing verdict untouched");
  assert.deepEqual(Object.keys(lines[3]).sort(), ["caseId", "checks", "phase", "policy", "verdict"]);
  assert.deepEqual(lines[3].checks, { "stdout-shape": false });
  // The journal stays append-only with its claim-time permissions.
  assert.equal((await stat(run.evidencePath)).mode & 0o777, 0o600);
});

test("unknown receipt fields never reach evidence", async t => {
  const prepared = await prepareJev(t);
  const run = await claimAcceptance(prepared.manifestPath, prepared.sha256);
  t.after(() => run.handle.close());

  await appendEvidence(run, {
    phase: "observed",
    caseId: "jev-default-readonly",
    backend: "gpt-worker-x",
    profileId: 42,
    rootMatches: "maybe",
    exitCode: 1.5,
    durationMs: -3,
    attempts: "two",
    stdout: "SECRETS",
    model: "gpt-6",
    root: "/etc/passwd",
    path: "/etc/shadow",
    canary: "hunter2",
    env: { LAYA_API_KEY: "v" }
  } as unknown as SafeEvidence);
  await appendEvidence(run, {
    phase: "verified", caseId: "jev-default-readonly", verdict: "excellent", policy: "not-applicable", checks: { shape: "yes", count: true }
  } as unknown as SafeEvidence);
  await appendEvidence(run, { phase: "stopped", caseId: 7, reason: "meteor" } as unknown as SafeEvidence);

  const raw = await readFile(run.evidencePath, "utf8");
  for (const secret of ["SECRETS", "gpt-6", "/etc/passwd", "/etc/shadow", "hunter2", "stdout", "canary", "LAYA_API_KEY"]) {
    assert.ok(!raw.includes(secret), secret + " must never reach the evidence journal");
  }
  const [observed, verified, stopped] = raw.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(Object.keys(observed).sort(),
    ["attempts", "backend", "caseId", "durationMs", "exitCode", "phase", "profileId", "rootMatches"]);
  assert.equal(observed.backend, "invalid", "an unknown backend degrades to the bounded invalid marker");
  assert.equal(observed.profileId, "unknown");
  assert.equal(observed.rootMatches, "unknown");
  assert.equal(observed.exitCode, null);
  assert.equal(observed.durationMs, 0);
  assert.equal(observed.attempts, 0);
  assert.deepEqual(Object.keys(verified).sort(), ["caseId", "checks", "phase", "policy", "verdict"]);
  assert.equal(verified.verdict, "fail", "an unrecognized verdict degrades to fail");
  assert.deepEqual(verified.checks, { count: true }, "non-boolean checks are dropped");
  assert.deepEqual(Object.keys(stopped).sort(), ["caseId", "phase", "reason"]);
  assert.equal(stopped.caseId, null);
  assert.equal(stopped.reason, "unknown");
});

test("prepare is offline and freezes independent consumers", async t => {
  assert.equal(typeof prepareAcceptance, "function");
  const outcome = await runPreparesOffline(t);
  assert.equal(outcome.httpCalls, 0, "prepare must not make classifier or probe requests");
  assert.equal(outcome.fetchCalls, 0, "prepare must not make fetch requests");
  assert.ok(outcome.spawned.every(file => basename(file) === "git"),
    "prepare may only spawn git, saw " + JSON.stringify(outcome.spawned));
  const roots = Object.values(outcome.results).map(result => dirname(result.manifestPath));
  t.after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
  for (const [suite, result] of Object.entries(outcome.results)) {
    assert.equal(result.sha256, sha256hex(await readFile(result.manifestPath)),
      suite + " manifest sha256 must cover the exact manifest bytes");
  }

  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as {
    workerReadonlyTask: string;
    workerWriteTask: string;
    workerFixtureInput: { values: number[] };
  };
  const template = parseProjectConfig(JSON.parse(await readFile(TEMPLATE_PATH, "utf8")));

  const laya = await loadManifest(outcome.results.laya.manifestPath);
  assert.deepEqual(Object.keys(laya).sort(), ["baseline", "caps", "cases", "hostSnapshot", "runRoot", "suite", "version"]);
  assert.equal(laya.version, 2);
  assert.equal(laya.suite, "laya");
  assert.deepEqual(laya.caps, { worker: 7, laya: 7, jev: 0 });
  assert.equal(laya.cases.length, 7);
  const kinds = laya.cases.map(item => item.kind);
  assert.equal(kinds.filter(kind => kind === "worker-readonly").length, 6);
  assert.equal(kinds.filter(kind => kind === "worker-write").length, 1);

  // Every CLI case is an independent consumer root under the private run root.
  const cliCases = laya.cases;
  assert.equal(cliCases.length, 7);
  assert.equal(new Set(cliCases.map(item => item.root)).size, 7, "the seven CLI roots must differ");
  const runRoot = await realpath(dirname(outcome.results.laya.manifestPath));
  assert.equal(laya.runRoot.canonical, runRoot);
  const runRootStat = await stat(runRoot);
  assert.equal(laya.runRoot.dev, runRootStat.dev);
  assert.equal(laya.runRoot.ino, runRootStat.ino);
  for (const item of cliCases) {
    assert.ok(item.root.startsWith(runRoot + sep + "consumers" + sep),
      item.id + " must live in its own consumers directory");
    const rootStat = await stat(item.root);
    assert.equal(item.identity.dev, rootStat.dev, item.id + " identity dev");
    assert.equal(item.identity.ino, rootStat.ino, item.id + " identity ino");
    assert.ok((await stat(join(item.root, ".git"))).isDirectory(), item.id + " is a git repository");
    const onDisk = JSON.parse(await readFile(join(item.root, ".turnhelm/config.json"), "utf8"));
    assert.deepEqual(onDisk, item.config, item.id + " config on disk equals the frozen case config");
    await assert.rejects(() => stat(join(item.root, ".turnhelm/routes.jsonl")), { code: "ENOENT" },
      item.id + " must have no journal before execute");
    if (item.kind === "classifier-only") assert.fail("unreachable");
    if (item.kind === "worker-readonly" || item.kind === "worker-write") {
      const input = await readFile(join(item.root, "input.json"));
      assert.deepEqual(JSON.parse(input.toString("utf8")), corpus.workerFixtureInput);
      // The frozen set covers the input and every installed instruction file.
      const frozenCaseFiles = ["AGENTS.md", ".agents/skills/turnhelm-routing/SKILL.md",
        ".agents/skills/turnhelm-routing/agents/openai.yaml", "input.json"] as const;
      const expectedHashes: Record<string, string> = {};
      for (const file of frozenCaseFiles) expectedHashes[file] = sha256hex(await readFile(join(item.root, file)));
      assert.deepEqual(item.inputHashes, expectedHashes);
      assert.equal(item.allowedChanges.length, item.kind === "worker-write" ? 1 : 0);
      if (item.kind === "worker-write") assert.deepEqual(item.allowedChanges, ["out/summary.json"]);
    }
  }

  // Strict per-case keys, task bounds, and hashes for every case.
  for (const item of laya.cases) {
    assert.deepEqual(Object.keys(item).sort(),
      ["allowedChanges", "config", "id", "identity", "inputHashes", "kind", "oracle", "reservation", "root", "task", "taskBytes", "taskHash"]);
    assert.ok(item.taskBytes <= 8192, item.id + " task fits the transport bound");
    const taskBytes = Buffer.from(item.task, "utf8");
    assert.equal(item.taskBytes, taskBytes.length);
    assert.equal(item.taskHash, sha256hex(taskBytes));
    parseProjectConfig(item.config);
    assert.equal(item.config.backends.laya.enabled, true, "laya suite enables laya");
    assert.equal(item.config.backends.jev.enabled, false, "laya suite configures no jev");
  }
  assert.ok(cliCases.some(item => item.kind === "worker-readonly" && item.task === corpus.workerReadonlyTask));
  assert.ok(cliCases.some(item => item.kind === "worker-write" && item.task === corpus.workerWriteTask));

  // Six admission cases bind all six profile IDs to each legal template pair.
  const templatePairs = new Set(Object.values(template.profiles).map(profile => pair(profile)));
  assert.equal(templatePairs.size, 6);
  const admission = laya.cases.filter(item => item.id.startsWith("admission-"));
  assert.equal(admission.length, 6);
  const admissionPairs = new Set<string>();
  for (const item of admission) {
    const pairs = new Set(Object.values(item.config.profiles).map(profile => pair(profile)));
    assert.equal(pairs.size, 1, item.id + " binds all six IDs to one pair");
    const only = [...pairs][0];
    assert.ok(templatePairs.has(only), item.id + " pair comes from the current template");
    admissionPairs.add(only);
  }
  assert.deepEqual([...admissionPairs].sort(), [...templatePairs].sort(), "all six template combos are covered");
  // The default case keeps the six original natural bindings.
  const natural = laya.cases.find(item => item.id.startsWith("default-"));
  assert.ok(natural);
  for (const [id, profile] of Object.entries(template.profiles)) {
    assert.equal(natural.config.profiles[id as keyof typeof natural.config.profiles].model, profile.model);
    assert.equal(natural.config.profiles[id as keyof typeof natural.config.profiles].effort, profile.effort);
  }
  assert.deepEqual(natural.reservation, { worker: 1, backends: ["laya"] });

  // Baseline and host snapshot completeness.
  assert.deepEqual(Object.keys(laya.baseline).sort(), ["corpus", "dist", "head", "source", "tools"]);
  assert.match(laya.baseline.head, /^[0-9a-f]{40}$/);
  assert.equal(laya.baseline.corpus, sha256hex(await readFile(CORPUS_PATH)));
  for (const [scope, mustContain] of [["source", "systemone.ts"], ["dist", "systemone.js"]] as const) {
    const entries = laya.baseline[scope];
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ["path", "sha256"]);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    }
    assert.ok(entries.some(entry => entry.path.includes(mustContain)), scope + " hashes the executed files");
  }
  assert.ok(laya.baseline.dist.some(entry => entry.path === "dist/test/live.integration.js"),
    "the dist baseline pins the executed live entry itself");
  assert.deepEqual(Object.keys(laya.baseline.tools).sort(), ["execPath", "git", "gitPath", "node"]);
  assert.match(laya.baseline.tools.node, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(laya.hostSnapshot).sort(), ["exists", "sha256"]);
  // Prepare claims no evidence slot.
  await assert.rejects(() => stat(join(runRoot, "evidence", "evidence.jsonl")), { code: "ENOENT" },
    "prepare must not create or claim the evidence journal");

  // The jev suite is one default-binding read-only consumer on jev only.
  const jev = await loadManifest(outcome.results.jev.manifestPath);
  assert.equal(jev.suite, "jev");
  assert.deepEqual(jev.caps, { worker: 1, laya: 0, jev: 1 });
  assert.equal(jev.cases.length, 1);
  const jevCase = jev.cases[0];
  assert.equal(jevCase.kind, "worker-readonly");
  assert.equal(jevCase.task, corpus.workerReadonlyTask);
  assert.equal(jevCase.config.backends.laya.enabled, false);
  assert.equal(jevCase.config.backends.jev.enabled, true);
  assert.deepEqual(jevCase.reservation, { worker: 1, backends: ["jev"] });

  // The dual suite keeps natural bindings: one Laya-first case and one fixture
  // case whose laya origin is a distinct frozen loopback port.
  const dual = await loadManifest(outcome.results.dual.manifestPath);
  assert.equal(dual.suite, "dual");
  assert.deepEqual(dual.caps, { worker: 2, laya: 2, jev: 2 });
  assert.equal(dual.cases.length, 2);
  const [first, second] = dual.cases;
  assert.equal(first.kind, "worker-readonly");
  assert.equal(second.kind, "worker-write");
  assert.equal(first.config.backends.laya.enabled, true);
  assert.equal(first.config.backends.jev.enabled, true);
  assert.equal(second.config.backends.laya.enabled, true);
  assert.equal(second.config.backends.jev.enabled, true);
  assert.match(second.config.backends.laya.url, /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
  assert.notEqual(second.config.backends.laya.url, template.backends.laya.url,
    "the fixture case must not point at the template port");
  assert.notEqual(second.config.backends.laya.url, first.config.backends.laya.url);

  // Each calibration suite freezes the spec §4.3 roster: twelve
  // classifier-only cases in trial-major table order, no workers, no Jev,
  // and the default template bindings untouched.
  for (const [suite, split] of [["calibration-dev", "dev"], ["calibration-holdout", "holdout"]] as const) {
    const manifest = await loadManifest(outcome.results[suite].manifestPath);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.suite, suite);
    assert.deepEqual(manifest.caps, { worker: 0, laya: 12, jev: 0 });
    assert.equal(manifest.cases.length, 12);
    assert.deepEqual(manifest.cases.map(item => item.id), [1, 2, 3].flatMap(n =>
      SPEC_CALIBRATION[split].map(entry => `${entry.id}-trial-${n}`)));
    const suiteRoot = await realpath(dirname(outcome.results[suite].manifestPath));
    assert.deepEqual(await readdir(join(suiteRoot, "consumers")), [],
      suite + " prepares zero worker consumers");
    await assert.rejects(() => stat(join(suiteRoot, "evidence", "evidence.jsonl")), { code: "ENOENT" },
      suite + " claims no evidence slot");
    for (const [index, item] of manifest.cases.entries()) {
      const expected = SPEC_CALIBRATION[split][index % 4];
      const trial = Math.floor(index / 4) + 1;
      assert.equal(item.kind, "classifier-only", item.id + " is a routing-only case");
      assert.equal(item.task, expected.task, item.id + " task is frozen in the corpus");
      assert.deepEqual(item.oracle, { kind: "classifier-band", pairId: expected.pairId,
        language: expected.language, split: expected.split, trial,
        allowedProfiles: [...expected.allowedProfiles] });
      assert.deepEqual(item.reservation, { worker: 0, backends: ["laya"] });
      assert.deepEqual(item.inputHashes, {});
      assert.equal(item.config.routingTimeoutMs, template.routingTimeoutMs,
        item.id + " keeps the template routing timeout");
      assert.equal(item.config.backends.laya.enabled, true);
      assert.equal(item.config.backends.jev.enabled, false, item.id + " never enables Jev");
      assert.match(item.config.backends.laya.url, /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/,
        item.id + " Laya origin stays a legal loopback");
      for (const [id, profile] of Object.entries(item.config.profiles)) {
        assert.equal(profile.model, template.profiles[id as keyof typeof template.profiles].model,
          item.id + " keeps the default template binding for " + id);
        assert.equal(profile.effort, template.profiles[id as keyof typeof template.profiles].effort);
      }
    }
  }
});

// ---- Task 3: offline execute over crafted manifests ----
// The classifier fixture is an owned local HTTP server; the worker is a fake
// codex executable first on PATH. Nothing here dials a real backend.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY_PATH = join(REPO_ROOT, "dist", "test", "live.integration.js");

const choiceBody = (profileId: string): string => JSON.stringify({
  answers: { route: { type: "choice", choice: profileId, confidence: 0.9 } },
  usage: { truncated: false, state_tokens_dropped: 0 }
});

const startClassifierFixture = async (t: TestContext, onRequest?: (count: number) => void) => {
  const state = { requests: 0 };
  const scripted: string[] = [];
  const server = http.createServer((req, res) => {
    state.requests += 1;
    onRequest?.(state.requests);
    req.resume();
    const next = scripted.shift();
    if (next === "hang") return; // the caller's budget is the only way out
    res.writeHead(200, { "content-type": "application/json" });
    res.end(next ?? choiceBody("fast"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state, scripted };
};

// Modes: ok-readonly, ok-write, write-readonly (writes despite read-only sandbox),
// fail, hang, wrong-output, no-output, oversize, mutate-input.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("codex-cli 0.160.0\\n"); process.exit(0); }
if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write("usage: codex exec --json --ephemeral --sandbox read-only -\\n");
  process.exit(0);
}
let task = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { task += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.TURNHELM_TEST_WORKER || "ok-readonly";
  const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
  const answer = JSON.stringify({ count: 4, sum: 17 });
  if (mode === "fail") process.exit(3);
  if (mode === "hang") { setInterval(() => {}, 3600); return; }
  if (mode === "wrong-output") {
    emit({ type: "item.completed", item: { type: "agent_message", text: "hello" } });
    emit({ type: "turn.completed" });
    process.exit(0);
  }
  if (mode === "no-output") { emit({ type: "turn.completed" }); process.exit(0); }
  if (mode === "bad-utf8") {
    process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd, 0x0a]));
    emit({ type: "turn.completed" });
    process.exit(0);
  }
  if (mode === "oversize") {
    // Exit only after the oversized frame has flushed: an early exit truncates
    // the pipe and turns this into an unrelated protocol failure.
    const big = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(70000) } }) + "\\n";
    const done = JSON.stringify({ type: "turn.completed" }) + "\\n";
    process.stdout.write(big, () => process.stdout.write(done, () => process.exit(0)));
    return;
  }
  // RR01 payloads: the agent message (or summary file) carries a whole
  // payload that is not exactly one {count,sum} object.
  const variants = {
    "answer-preamble": "Here is the result:\\n" + answer,
    "answer-suffix": answer + "\\nDone.",
    "answer-fence": "\`\`\`json\\n" + answer + "\\n\`\`\`",
    "answer-twice": answer + "\\n" + answer,
    "answer-extra-key": '{"count":4,"sum":17,"note":"extra"}',
    "answer-missing-sum": '{"count":4}',
    "answer-array": "[4, 17]",
    "answer-null": "null",
    "answer-wrong-numbers": '{"count":5,"sum":18}',
    "answer-loose": '{\\n  "sum": 17,\\n  "count": 4\\n}',
    "summary-preamble": "Done:\\n" + answer,
    "summary-suffix": answer + "\\nDone.",
    "summary-fence": "\`\`\`json\\n" + answer + "\\n\`\`\`",
    "summary-twice": answer + "\\n" + answer,
    "summary-extra-key": '{"count":4,"sum":17,"note":"extra"}',
    "summary-missing-sum": '{"count":4}',
    "summary-array": "[4, 17]",
    "summary-null": "null",
    "summary-wrong-numbers": '{"count":5,"sum":18}',
    "summary-loose": '{\\n  "sum": 17,\\n  "count": 4\\n}'
  };
  const variant = variants[mode];
  if (variant !== undefined) {
    if (mode.startsWith("answer-")) {
      emit({ type: "item.completed", item: { type: "agent_message", text: variant } });
    } else {
      fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), "out", "summary.json"), variant);
      emit({ type: "item.completed", item: { type: "agent_message", text: answer } });
    }
    emit({ type: "turn.completed" });
    process.exit(0);
  }
  if (mode === "mutate-input") {
    fs.writeFileSync(path.join(process.cwd(), "input.json"), JSON.stringify({ values: [1] }));
  }
  if (mode === "edit-agents") {
    fs.appendFileSync(path.join(process.cwd(), "AGENTS.md"), "\\n# tampered\\n");
  }
  if (mode === "spawn-linger") {
    // A descendant in its own process group that inherits stdout: the CLI can
    // exit, but the supervision pipe never closes. It self-exits so no test
    // process waits on it forever.
    require("node:child_process").spawn(process.execPath,
      ["-e", "setInterval(() => {}, 3600); setTimeout(() => process.exit(0), 4000)"], {
      detached: true, stdio: ["ignore", "inherit", "inherit"]
    }).unref();
  }
  if (mode === "symlink-summary") {
    fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "out", "summary.real"), answer);
    fs.symlinkSync("summary.real", path.join(process.cwd(), "out", "summary.json"));
  }
  if (mode === "linger-forever") {
    // A descendant in its own process group that inherits stdout and never
    // exits; it writes its pid (outside the consumer tree) so the test can
    // reap it afterwards.
    const pidFile = process.env.TURNHELM_LINGER_PID_FILE || path.join(process.cwd(), "linger.pid");
    require("node:child_process").spawn(process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 3600);",
        pidFile], {
      detached: true, stdio: ["ignore", "inherit", "inherit"]
    }).unref();
  }
  if (mode === "ok-write" || mode === "write-readonly") {
    fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), "out", "summary.json"), answer);
  }
  emit({ type: "item.completed", item: { type: "agent_message", text: answer } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
});
`;

const writeFakeCodex = async (t: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-fakeworker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "codex"), FAKE_CODEX);
  await chmod(join(directory, "codex"), 0o755);
  return directory;
};

type CraftedCase = {
  id: string;
  kind: "worker-readonly" | "worker-write";
  journalSeed?: readonly string[];
  fixtureUrl?: string;
  reservation?: readonly ("laya" | "jev")[];
  jevEnabled?: boolean;
};

const readEvidence = async (runRoot: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(runRoot, "evidence", "evidence.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

const workerEnv = (fakeBin: string, mode: string): NodeJS.ProcessEnv => ({
  PATH: fakeBin + ":" + (process.env.PATH ?? ""),
  TURNHELM_TEST_WORKER: mode
});

// A hand-built manifest that passes claim's strict parser and file checks while
// pointing every laya case at the owned classifier fixture.
const buildRun = async (
  t: TestContext,
  suite: "laya" | "jev" | "dual",
  layaUrl: string,
  cases: readonly CraftedCase[]
): Promise<{ manifestPath: string; sha256: string; runRoot: string }> => {
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as {
    workerReadonlyTask: string;
    workerWriteTask: string;
    workerFixtureInput: unknown;
  };
  const template = JSON.parse(await readFile(TEMPLATE_PATH, "utf8")) as { profiles: Record<string, unknown> };
  const runRoot = await mkdtemp(join(tmpdir(), "turnhelm-exec-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  await mkdir(join(runRoot, "consumers"), { mode: 0o700 });
  const manifestCases: unknown[] = [];
  const backendsFor = (entry: CraftedCase): readonly ("laya" | "jev")[] =>
    entry.reservation ?? (suite === "jev" ? ["jev"] : suite === "dual" ? ["laya", "jev"] : ["laya"]);
  for (const entry of cases) {
    const config = parseProjectConfig({
      version: 1,
      routingTimeoutMs: 1000,
      backends: {
        laya: { enabled: suite !== "jev", url: entry.fixtureUrl ?? layaUrl },
        jev: { enabled: entry.jevEnabled ?? suite !== "laya" }
      },
      profiles: template.profiles
    });
    const task = entry.kind === "worker-write" ? corpus.workerWriteTask : corpus.workerReadonlyTask;
    const taskBytes = Buffer.from(task, "utf8");
    const root = join(runRoot, "consumers", entry.id);
    await mkdir(root, { mode: 0o700 });
    await execute("git", ["init"], { cwd: root });
    await mkdir(join(root, ".turnhelm"), { mode: 0o700 });
    await writeFile(join(root, ".turnhelm", "config.json"), Buffer.from(JSON.stringify(config, null, 2) + "\n"), { mode: 0o644 });
    const input = Buffer.from(JSON.stringify(corpus.workerFixtureInput), "utf8");
    await writeFile(join(root, "input.json"), input, { mode: 0o644 });
    await writeFile(join(root, "AGENTS.md"), "# consumer instructions\n", { mode: 0o644 });
    await mkdir(join(root, ".agents", "skills", "turnhelm-routing", "agents"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"), "# turnhelm routing\n", { mode: 0o644 });
    await writeFile(join(root, ".agents", "skills", "turnhelm-routing", "agents", "openai.yaml"),
      "model: gpt-6-luna\n", { mode: 0o644 });
    if (entry.journalSeed?.length) {
      await writeFile(join(root, ".turnhelm", "routes.jsonl"), entry.journalSeed.join("\n") + "\n", { mode: 0o644 });
    }
    const info = await stat(root);
    manifestCases.push({
      id: entry.id, kind: entry.kind, root: await realpath(root),
      identity: { dev: info.dev, ino: info.ino },
      task, taskHash: sha256hex(taskBytes), taskBytes: taskBytes.length,
      config,
      inputHashes: {
        "AGENTS.md": sha256hex(await readFile(join(root, "AGENTS.md"))),
        ".agents/skills/turnhelm-routing/SKILL.md": sha256hex(await readFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"))),
        ".agents/skills/turnhelm-routing/agents/openai.yaml": sha256hex(await readFile(join(root, ".agents", "skills", "turnhelm-routing", "agents", "openai.yaml"))),
        "input.json": sha256hex(input)
      },
      allowedChanges: entry.kind === "worker-write" ? ["out/summary.json"] : [],
      oracle: entry.kind === "worker-write"
        ? { kind: "summary-file", expected: { count: 4, sum: 17 } }
        : { kind: "stdout-json", expected: { count: 4, sum: 17 } },
      reservation: { worker: 1, backends: backendsFor(entry) }
    });
  }
  const hashRepoFile = async (relative: string) => ({ path: relative, sha256: sha256hex(await readFile(join(REPO_ROOT, relative))) });
  const srcFiles = (await readdir(join(REPO_ROOT, "src"))).filter(name => name.endsWith(".ts")).sort();
  const distFiles = (await readdir(join(REPO_ROOT, "dist", "src"))).filter(name => name.endsWith(".js")).sort();
  const runInfo = await stat(runRoot);
  // The crafted manifest snapshots the host config through the same production
  // project-path semantics prepare uses: only ENOENT reads as absent, and an
  // unreadable or otherwise refused host stops here instead of masking as absent.
  const hostBytes = await readProjectFile(REPO_ROOT, ".turnhelm/config.json", 65536);
  const manifest = {
    version: 2,
    suite,
    baseline: {
      head: (await execute("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout.trim(),
      source: await Promise.all(srcFiles.map(name => hashRepoFile("src/" + name))),
      dist: await Promise.all([...distFiles.map(name => "dist/src/" + name), "dist/test/live-acceptance.js"].map(hashRepoFile)),
      corpus: sha256hex(await readFile(CORPUS_PATH)),
      tools: {
        node: process.version, execPath: process.execPath,
        git: (await execute("git", ["--version"], { encoding: "utf8" })).stdout.trim(),
        gitPath: await findOnPath("git")
      }
    },
    runRoot: { canonical: await realpath(runRoot), dev: runInfo.dev, ino: runInfo.ino },
    hostSnapshot: hostBytes === undefined
      ? { exists: false, sha256: null }
      : { exists: true, sha256: sha256hex(hostBytes) },
    caps: {
      worker: cases.length,
      laya: cases.filter(entry => backendsFor(entry).includes("laya")).length,
      jev: cases.filter(entry => backendsFor(entry).includes("jev")).length
    },
    cases: manifestCases
  };
  const manifestPath = join(runRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return { manifestPath, sha256: sha256hex(await readFile(manifestPath)), runRoot };
};

test("entry refuses absent approval and unknown args", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "turnhelm-entry-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const minimal: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  const runEntry = (args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise(resolve => {
      execFile(process.execPath, [ENTRY_PATH, ...args], { cwd: scratch, env: minimal, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = error !== null && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error === null ? 0 : null;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
    });
  const variants: readonly string[][] = [
    [],
    ["--prepare"],
    ["--prepare", "bogus"],
    ["--prepare", "laya", "extra"],
    ["--execute", join(scratch, "manifest.json")],
    ["--approve", "0".repeat(64)],
    ["--execute", join(scratch, "manifest.json"), "--approve", "zz"],
    ["--execute", join(scratch, "manifest.json"), "--approve", "0".repeat(64), "--extra"],
    ["--", "--prepare", "laya", "--", "x"]
  ];
  for (const args of variants) {
    const run = await runEntry(args);
    assert.equal(run.code, 2, JSON.stringify(args) + " must exit 2");
    assert.match(run.stderr, /usage/, "usage text for " + JSON.stringify(args));
  }
  // Exactly one forwarding separator is tolerated.
  assert.equal((await runEntry(["--", "--prepare", "bogus"])).code, 2);
  // A valid prepare prints the manifest path and its hash and nothing else.
  const okRun = await runEntry(["--prepare", "jev"]);
  assert.equal(okRun.code, 0);
  const lines = okRun.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^manifest \//);
  assert.match(lines[1], /^sha256 [0-9a-f]{64}$/);
  const prepared = lines[0].slice("manifest ".length);
  await stat(prepared);
  t.after(() => rm(dirname(prepared), { recursive: true, force: true }));
});

test("a malformed manifest fails bounded without leaking manifest bytes", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "turnhelm-leak-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const malformed = join(scratch, "manifest.json");
  const bytes = Buffer.from('{"version":1,"suite":"jev"}CANARYTOKEN123', "utf8");
  await writeFile(malformed, bytes, { mode: 0o600 });
  const run = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    execFile(process.execPath, [ENTRY_PATH, "--execute", malformed, "--approve", sha256hex(bytes)],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
      (error, _stdout, stderr) => {
        const code = error !== null && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error === null ? 0 : null;
        resolve({ code, stderr: String(stderr) });
      });
  });
  assert.equal(run.code, 1, "an unparseable manifest is a failed run");
  assert.equal(run.stderr, "", "no error text reaches stderr: the failure stays bounded");
  assert.ok(!run.stderr.includes("CANARYTOKEN123"));
});

test("suite counts are reserved before each attempt", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // The dual gate: without the hosted-jev environment gates the expected
  // eligible set is incomplete, so nothing is claimed and nothing is called.
  const dual = await buildRun(t, "dual", classifier.url, [
    { id: "dual-one", kind: "worker-readonly" },
    { id: "dual-two", kind: "worker-write" }
  ]);
  const gated = await executeAcceptance(dual.manifestPath, dual.sha256, { env: workerEnv(fakeBin, "ok-readonly") });
  assert.equal(gated, 1, "an incomplete eligible set stops before claiming");
  await assert.rejects(() => stat(join(dual.runRoot, "evidence", "evidence.jsonl")), { code: "ENOENT" });
  assert.equal(classifier.state.requests, 0, "the gate makes zero calls");

  // A reservation that synced survives a missing receipt as bounded markers.
  const broken = await buildRun(t, "laya", classifier.url, [{ id: "no-receipt", kind: "worker-readonly" }]);
  await mkdir(join(broken.runRoot, "consumers", "no-receipt", ".turnhelm", "routes.jsonl"));
  const missing = await executeAcceptance(broken.manifestPath, broken.sha256, { env: workerEnv(fakeBin, "ok-readonly") });
  assert.equal(missing, 1);
  const missingEvidence = await readEvidence(broken.runRoot);
  assert.deepEqual(missingEvidence.map(line => line.phase), ["prepared", "reserved", "observed", "verified", "stopped"]);
  assert.equal(missingEvidence[1].caseId, "no-receipt");
  assert.equal(missingEvidence[2].backend, "invalid", "a missing receipt degrades to bounded markers");
  assert.equal(missingEvidence[2].profileId, "unknown");
  assert.equal(missingEvidence[3].verdict, "fail");
  assert.equal(((missingEvidence[3].checks ?? {}) as Record<string, unknown>)["receipt-unique"], false);

  // Reservations precede observations case by case and stay within the caps.
  const counted = await buildRun(t, "laya", classifier.url, [
    { id: "case-one", kind: "worker-readonly" },
    { id: "case-two", kind: "worker-readonly" }
  ]);
  const before = classifier.state.requests;
  const code = await executeAcceptance(counted.manifestPath, counted.sha256, { env: workerEnv(fakeBin, "ok-readonly") });
  assert.equal(code, 0);
  assert.equal(classifier.state.requests - before, 2, "one classify per case and no more");
  const log = await readEvidence(counted.runRoot);
  for (const id of ["case-one", "case-two"]) {
    const reserved = log.findIndex(line => line.phase === "reserved" && line.caseId === id);
    const observed = log.findIndex(line => line.phase === "observed" && line.caseId === id);
    assert.ok(reserved >= 0 && observed > reserved, id + " reserves before its attempt");
    assert.equal(log[reserved].worker, 1);
    assert.deepEqual(log[reserved].backends, ["laya"]);
  }
});

test("first real failure stops remaining cases", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const run = await buildRun(t, "laya", classifier.url, [
    { id: "fails-first", kind: "worker-readonly" },
    { id: "never-runs", kind: "worker-readonly" }
  ]);
  const code = await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, "fail") });
  assert.equal(code, 1);
  const evidence = await readEvidence(run.runRoot);
  assert.deepEqual(evidence.filter(line => line.phase === "reserved").map(line => line.caseId), ["fails-first"],
    "no reservation is made after the first failure");
  const stopped = evidence.at(-1);
  assert.equal(stopped?.phase, "stopped");
  assert.equal(stopped?.reason, "verdict");
  assert.equal(stopped?.caseId, "fails-first");
  assert.equal(classifier.state.requests, 1, "exactly one classify call");
  await assert.rejects(() => stat(join(run.runRoot, "consumers", "never-runs", ".turnhelm", "routes.jsonl")), { code: "ENOENT" });
});

test("duplicate receipt after observation cannot pass", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as { workerReadonlyTask: string };
  const taskBytes = Buffer.from(corpus.workerReadonlyTask, "utf8");
  const seedLine = JSON.stringify({
    type: "turnhelm.route", ts: "2026-10-11T00:00:00.000Z",
    taskSha256: sha256hex(taskBytes), taskBytes: taskBytes.length, status: "selected",
    routingMs: 5, attempts: [{ backend: "laya", outcome: "success", durationMs: 5 }],
    backend: "laya", profileId: "fast", model: "gpt-6-luna", effort: "low"
  });
  const run = await buildRun(t, "laya", classifier.url, [{ id: "replayed", kind: "worker-readonly", journalSeed: [seedLine] }]);
  const code = await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, "ok-readonly") });
  assert.equal(code, 1, "a replayed task hash can never verify");
  const evidence = await readEvidence(run.runRoot);
  assert.deepEqual(evidence.map(line => line.phase), ["prepared", "reserved", "observed", "verified", "stopped"]);
  assert.equal(evidence[2].backend, "invalid", "a duplicated receipt degrades the observation");
  assert.equal(evidence[2].profileId, "unknown");
  assert.equal(evidence[3].verdict, "fail");
  assert.equal(((evidence[3].checks ?? {}) as Record<string, unknown>)["receipt-unique"], false);
  assert.equal(evidence[4].reason, "verdict");
  // The journal keeps both lines; the evidence never carries the task text.
  const journal = await readFile(join(run.runRoot, "consumers", "replayed", ".turnhelm", "routes.jsonl"), "utf8");
  assert.equal(journal.trim().split("\n").length, 2, "the replay attempt did append one new line");
  assert.ok(!(await readFile(join(run.runRoot, "evidence", "evidence.jsonl"), "utf8")).includes(corpus.workerReadonlyTask));
});

test("malformed missing oversized and invalid utf8 outputs are finite", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  for (const mode of ["wrong-output", "no-output", "oversize", "bad-utf8"] as const) {
    const run = await buildRun(t, "laya", classifier.url, [{ id: "finite-" + mode, kind: "worker-readonly" }]);
    const code = await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, mode) });
    assert.equal(code, 1, mode + " must fail the run");
    const evidence = await readEvidence(run.runRoot);
    const raw = await readFile(join(run.runRoot, "evidence", "evidence.jsonl"));
    assert.ok(raw.length < 8192, mode + " evidence stays finite");
    if (mode === "oversize") {
      assert.deepEqual(evidence.map(line => line.phase), ["prepared", "reserved", "observed", "stopped"],
        "an oversized output cancels the case before any verdict");
      assert.equal(evidence[3].reason, "output-limit");
      assert.equal(evidence[2].backend, "laya", "the bounded observation still lands first");
    } else {
      assert.deepEqual(evidence.map(line => line.phase), ["prepared", "reserved", "observed", "verified", "stopped"]);
      assert.equal(evidence[3].verdict, "fail", mode + " fails verification");
      assert.equal(evidence[4].reason, "verdict");
    }
    assert.equal(evidence.at(-1)?.caseId, "finite-" + mode);
  }
});

test("worker and calibration cases have different pass criteria", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  // A failing worker oracle fails the run on the worker fact alone.
  const workerBad = await buildRun(t, "laya", classifier.url, [{ id: "worker-bad", kind: "worker-readonly" }]);
  assert.equal(await executeAcceptance(workerBad.manifestPath, workerBad.sha256,
    { env: workerEnv(fakeBin, "wrong-output") }), 1);
  const workerVerified = (await readEvidence(workerBad.runRoot)).find(line => line.phase === "verified");
  assert.ok(workerVerified);
  assert.equal(workerVerified.verdict, "fail");
  assert.equal((workerVerified.checks as Record<string, unknown>)["oracle"], false,
    "the worker failure is caught by the stdout oracle");

  // A full calibration roster whose every selection stays inside its frozen
  // band passes on routing facts alone: no receipts, no worker artifacts.
  for (const profile of [1, 2, 3].flatMap(() => ["fast", "balanced", "deep", "frontier"])) {
    classifier.scripted.push(choiceBody(profile));
  }
  const calibration = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(calibration.manifestPath, calibration.sha256,
    { env: workerEnv(fakeBin, "ok-readonly") }), 0);
  const calibrationVerified = (await readEvidence(calibration.runRoot)).filter(line => line.phase === "verified");
  assert.equal(calibrationVerified.length, 12);
  for (const record of calibrationVerified) {
    assert.equal(record.verdict, "pass");
    assert.deepEqual(record.checks, {
      "route-selected": true, "profile-legal": true, "backend-eligible": true, "attempts-made": true
    }, "calibration checks never mention receipts or workers");
  }

  // An illegal classifier choice fails calibration on selection facts alone.
  classifier.scripted.push(JSON.stringify({
    answers: { route: { type: "choice", choice: "turbo", confidence: 0.9 } },
    usage: { truncated: false, state_tokens_dropped: 0 }
  }));
  const illegal = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(illegal.manifestPath, illegal.sha256,
    { env: workerEnv(fakeBin, "ok-readonly") }), 1);
  const illegalEvidence = await readEvidence(illegal.runRoot);
  assert.deepEqual(illegalEvidence.map(line => line.phase),
    ["prepared", "reserved", "observed", "verified", "stopped"]);
  assert.equal(illegalEvidence[2].backend, "invalid");
  assert.equal(illegalEvidence[2].profileId, "unknown");
  assert.equal(illegalEvidence[3].verdict, "fail");
  assert.equal((illegalEvidence[3].checks as Record<string, unknown>)["route-selected"], false);
  assert.equal(illegalEvidence[4].reason, "verdict");
});

test("read and synthetic write require independent facts", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // A synthetic write passes only through its own independent fact: the file.
  const ok = await buildRun(t, "laya", classifier.url, [{ id: "writer", kind: "worker-write" }]);
  assert.equal(await executeAcceptance(ok.manifestPath, ok.sha256, { env: workerEnv(fakeBin, "ok-write") }), 0);
  const okVerified = (await readEvidence(ok.runRoot)).find(line => line.phase === "verified");
  assert.ok(okVerified);
  assert.equal(okVerified.verdict, "pass");
  assert.equal((okVerified.checks as Record<string, unknown>)["oracle"], true);
  const summary = JSON.parse(await readFile(join(ok.runRoot, "consumers", "writer", "out", "summary.json"), "utf8"));
  assert.deepEqual(summary, { count: 4, sum: 17 });

  // Writing under a read-only sandbox is caught by the tree diff, not the exit code.
  const rogue = await buildRun(t, "laya", classifier.url, [{ id: "rogue-writer", kind: "worker-readonly" }]);
  assert.equal(await executeAcceptance(rogue.manifestPath, rogue.sha256, { env: workerEnv(fakeBin, "write-readonly") }), 1);
  const rogueVerified = (await readEvidence(rogue.runRoot)).find(line => line.phase === "verified");
  assert.ok(rogueVerified);
  assert.equal(rogueVerified.verdict, "fail");
  assert.equal((rogueVerified.checks as Record<string, unknown>)["exit-zero"], true, "the exit code alone proves nothing");
  assert.equal((rogueVerified.checks as Record<string, unknown>)["oracle"], true, "the answer itself was correct");
  assert.equal((rogueVerified.checks as Record<string, unknown>)["git-clean"], false, "the tree diff catches the write");

  // Mutating the frozen input fails the hash check even with a clean exit.
  const mutated = await buildRun(t, "laya", classifier.url, [{ id: "mutator", kind: "worker-readonly" }]);
  assert.equal(await executeAcceptance(mutated.manifestPath, mutated.sha256, { env: workerEnv(fakeBin, "mutate-input") }), 1);
  const mutatedVerified = (await readEvidence(mutated.runRoot)).find(line => line.phase === "verified");
  assert.ok(mutatedVerified);
  assert.equal(mutatedVerified.verdict, "fail");
  assert.equal((mutatedVerified.checks as Record<string, unknown>)["input-unchanged"], false);
  assert.equal((mutatedVerified.checks as Record<string, unknown>)["git-clean"], false,
    "the hash sweep catches even an in-place edit of an untracked file");
});

test("RR01 whole payload and exact keys", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const runOf = async (mode: string, kind: "worker-readonly" | "worker-write", id: string) => {
    const run = await buildRun(t, "laya", classifier.url, [{ id, kind }]);
    const code = await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, mode) });
    return { code, run };
  };

  // The failing first case ends the run: the second case is never classified.
  const first = await buildRun(t, "laya", classifier.url, [
    { id: "chatty", kind: "worker-readonly" },
    { id: "never-classified", kind: "worker-readonly" }
  ]);
  const codeWithPreamble = await executeAcceptance(first.manifestPath, first.sha256,
    { env: workerEnv(fakeBin, "answer-preamble") });
  assert.equal(codeWithPreamble, 1, "prose before the JSON object fails the whole payload");
  assert.equal(classifier.state.requests, 1, "the failing first case is the only classify call");
  const evidence = await readEvidence(first.runRoot);
  assert.ok(evidence.findIndex(x => x.phase === "observed") < evidence.findIndex(x => x.phase === "verified"),
    "the observation is durable before the verdict");
  assert.equal(evidence.at(-1)?.reason, "verdict");
  assert.equal(evidence.at(-1)?.caseId, "chatty");

  // Every other malformed stdout payload fails on the oracle check itself.
  for (const mode of ["answer-suffix", "answer-fence", "answer-twice", "answer-missing-sum",
    "answer-array", "answer-null", "answer-wrong-numbers"] as const) {
    const { code, run } = await runOf(mode, "worker-readonly", "ro-" + mode);
    assert.equal(code, 1, mode + " must fail the whole-payload oracle");
    const verified = (await readEvidence(run.runRoot)).find(line => line.phase === "verified");
    assert.equal((verified?.checks as Record<string, unknown> | undefined)?.["oracle"], false, mode);
  }
  const extraKeyReadonly = await runOf("answer-extra-key", "worker-readonly", "ro-extra-key");
  const codeWithExtraKeyReadonly = extraKeyReadonly.code;
  assert.equal(codeWithExtraKeyReadonly, 1, "an extra key in stdout fails even with both facts right");
  assert.equal(((await readEvidence(extraKeyReadonly.run.runRoot)).find(line => line.phase === "verified")
    ?.checks as Record<string, unknown> | undefined)?.["oracle"], false, "the exact-keys oracle catches it");

  // The write oracle judges the summary file by the same whole-payload rule.
  for (const mode of ["summary-preamble", "summary-suffix", "summary-fence", "summary-twice",
    "summary-missing-sum", "summary-array", "summary-null", "summary-wrong-numbers"] as const) {
    const { code, run } = await runOf(mode, "worker-write", "wr-" + mode);
    assert.equal(code, 1, mode + " must fail the summary-file oracle");
    const verified = (await readEvidence(run.runRoot)).find(line => line.phase === "verified");
    assert.equal((verified?.checks as Record<string, unknown> | undefined)?.["oracle"], false, mode);
  }
  const extraKeyWrite = await runOf("summary-extra-key", "worker-write", "wr-extra-key");
  const codeWithExtraKeyWrite = extraKeyWrite.code;
  assert.equal(codeWithExtraKeyWrite, 1, "an extra key in the summary file fails even with both facts right");

  // Legal JSON whitespace, indentation, and reordered keys pass on both paths.
  const looseReadonly = await runOf("answer-loose", "worker-readonly", "ro-loose");
  const codeWithWhitespaceAndReorderedKeys = looseReadonly.code;
  assert.equal(codeWithWhitespaceAndReorderedKeys, 0, "legal formatting differences still pass");
  assert.equal(((await readEvidence(looseReadonly.run.runRoot)).find(line => line.phase === "verified")
    ?.checks as Record<string, unknown> | undefined)?.["oracle"], true);
  const looseWrite = await runOf("summary-loose", "worker-write", "wr-loose");
  assert.equal(looseWrite.code, 0);
});

test("in-place edits of untracked files fail the tree check", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // Appending to AGENTS.md in place changes no porcelain line: the untracked
  // entry reads the same before and after. Only a content hash sees it.
  const run = await buildRun(t, "laya", classifier.url, [{ id: "tamperer", kind: "worker-readonly" }]);
  assert.equal(await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, "edit-agents") }), 1);
  const verified = (await readEvidence(run.runRoot)).find(line => line.phase === "verified");
  assert.ok(verified);
  assert.equal(verified.verdict, "fail");
  assert.equal((verified.checks as Record<string, unknown>)["exit-zero"], true, "the exit code alone proves nothing");
  assert.equal((verified.checks as Record<string, unknown>)["oracle"], true, "the answer itself was correct");
  assert.equal((verified.checks as Record<string, unknown>)["git-clean"], false,
    "the tree check must catch an in-place edit git status cannot see");
});

test("signal timeout or evidence failure stops spending", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // An evidence journal that cannot be made durable stops the run before any
  // call is made or reserved.
  const broken = await buildRun(t, "laya", classifier.url, [
    { id: "never-called", kind: "worker-readonly" },
    { id: "also-never", kind: "worker-readonly" }
  ]);
  // @types/node declares FileHandle as an interface, so the prototype is taken
  // from a live handle: mocking it breaks sync for every handle in-process.
  const probeDirectory = await mkdtemp(join(tmpdir(), "turnhelm-probe-"));
  t.after(() => rm(probeDirectory, { recursive: true, force: true }));
  const probe = await open(join(probeDirectory, "probe"), "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const failingSync = t.mock.method(fileHandlePrototype, "sync", async () => {
    throw new Error("injected evidence failure");
  });
  assert.equal(await executeAcceptance(broken.manifestPath, broken.sha256, { env: workerEnv(fakeBin, "ok-readonly") }), 1);
  failingSync.mock.restore();
  assert.equal(classifier.state.requests, 0, "nothing is spent when evidence cannot sync");
  const durable = await readFile(join(broken.runRoot, "evidence", "evidence.jsonl"), "utf8").catch(() => "");
  assert.ok(!durable.includes("reserved"), "no reservation was ever made durable");

  // An interrupted entry child stops spending and exits 130 with a signal stop.
  const hanging = await buildRun(t, "laya", classifier.url, [
    { id: "hang-one", kind: "worker-readonly" },
    { id: "hang-two", kind: "worker-readonly" }
  ]);
  const entry = spawn(process.execPath,
    [ENTRY_PATH, "--execute", hanging.manifestPath, "--approve", hanging.sha256],
    { env: workerEnv(fakeBin, "hang"), stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<number>(resolve => {
    entry.on("close", (code, signal) => resolve(code !== null ? code : signal === "SIGTERM" ? 143 : 130));
  });
  await new Promise(resolve => setTimeout(resolve, 900));
  entry.kill("SIGINT");
  assert.equal(await exited, 130);
  const evidence = await readEvidence(hanging.runRoot);
  assert.equal(evidence.at(-1)?.reason, "signal");
  assert.deepEqual(evidence.filter(line => line.phase === "reserved").map(line => line.caseId), ["hang-one"],
    "no reservation follows the interrupt");
});

test("cli close does not prove descendant cleanup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-owned-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  const scriptPath = join(directory, "ignore-int.mjs");
  await writeFile(scriptPath, 'process.on("SIGINT", () => {});\nsetInterval(() => {}, 1000);\n');

  // A child that ignores SIGINT closes only when the owned TERM lands after
  // the grace; the supervisor never signals anything but this child.
  const stubborn = await superviseCli(process.execPath, [scriptPath], { env, timeoutMs: 150, termGraceMs: 150 });
  assert.ok(stubborn.timedOut, "the budget expired");
  assert.ok(stubborn.termSent, "TERM was sent to the owned child after the grace");
  assert.ok(stubborn.cliClosed, "close is a fact about the owned child, not the group");
  assert.equal(stubborn.signal, "SIGTERM");

  // A healthy child closes on its own; no TERM is ever sent.
  const healthy = await superviseCli(process.execPath, ["-e", "process.exit(0)"], { env, timeoutMs: 5000, termGraceMs: 150 });
  assert.equal(healthy.termSent, false);
  assert.equal(healthy.exitCode, 0);
  assert.ok(healthy.cliClosed);
});

test("live entry cutover keeps the entry out of the offline glob", async t => {
  const scripts = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(scripts.scripts["test:live"], "pnpm run build && node dist/test/live.integration.js");
  assert.ok(scripts.scripts.test.includes("dist/test/*.test.js"), "the offline suite globs the test files");
  assert.ok(!scripts.scripts.test.includes("live.integration"), "the live entry never runs offline");

  // Whatever pnpm does with a forwarding separator, the entry grammar holds.
  const scratch = await mkdtemp(join(tmpdir(), "turnhelm-pnpm-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await writeFile(join(scratch, "package.json"), JSON.stringify({ name: "probe", private: true, scripts: { probe: "node probe.js" } }));
  await writeFile(join(scratch, "probe.js"), 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  const run = await execute("pnpm", ["run", "probe", "--", "--prepare", "laya"], { cwd: scratch, encoding: "utf8" });
  // pnpm prints a script banner before the probe's own output.
  const forwarded = JSON.parse(String(run.stdout).trimEnd().split("\n").at(-1) ?? "") as string[];
  assert.ok(forwarded[0] === "--prepare" || (forwarded[0] === "--" && forwarded[1] === "--prepare"),
    "pnpm strips or keeps one separator; both are legal entry grammar: " + JSON.stringify(forwarded));
});

test("a child that never closes settles bounded with cleanup unverified", async t => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-wedge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  const scriptPath = join(directory, "ignore-both.mjs");
  // The child outlives the supervision on purpose, but self-exits so the
  // test runner never waits on it.
  await writeFile(scriptPath, [
    'process.on("SIGINT", () => {});',
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
    "setTimeout(() => process.exit(0), 4000);"
  ].join("\n") + "\n");

  const wedged = await superviseCli(process.execPath, [scriptPath],
    { env, timeoutMs: 150, termGraceMs: 150, postTermMs: 150 });
  assert.ok(wedged.timedOut, "the budget expired");
  assert.ok(wedged.termSent, "TERM was sent to the owned child after the grace");
  assert.equal(wedged.cliClosed, false, "no close was ever observed");
  assert.equal(wedged.exitCode, null, "an abandoned child has no exit fact");
});

test("an already-aborted signal never spawns the child", async t => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-spawncheck-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "spawned");
  const scriptPath = join(directory, "marker.js");
  await writeFile(scriptPath, "require(\"node:fs\").writeFileSync(" + JSON.stringify(marker) + ", \"1\");\n");
  const controller = new AbortController();
  controller.abort();

  const result = await superviseCli(process.execPath, [scriptPath],
    { env: { PATH: process.env.PATH ?? "" }, signal: controller.signal, timeoutMs: 5000 });
  assert.equal(result.aborted, true, "the stop is attributed to the operator's signal");
  assert.equal(result.cliClosed, false, "no child ever ran to close");
  await assert.rejects(() => stat(marker), { code: "ENOENT" },
    "no child may be spawned after the operator aborted");
});

test("a lingering descendant stops the round as cleanup-unverified", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const controller = new AbortController();
  const run = await buildRun(t, "laya", classifier.url, [
    { id: "linger-one", kind: "worker-readonly" },
    { id: "linger-two", kind: "worker-readonly" }
  ]);
  const stopping = executeAcceptance(run.manifestPath, run.sha256,
    { env: workerEnv(fakeBin, "spawn-linger"), signal: controller.signal, termGraceMs: 400, postTermMs: 400 });
  await new Promise(resolve => setTimeout(resolve, 700));
  controller.abort();
  assert.equal(await stopping, 130, "the operator's signal intent stands");
  const evidence = await readEvidence(run.runRoot);
  assert.equal(evidence.at(-1)?.phase, "stopped");
  assert.equal(evidence.at(-1)?.reason, "cleanup-unverified");
  assert.equal(evidence.at(-1)?.caseId, "linger-one");
  assert.equal(evidence.filter(line => line.phase === "reserved").length, 1,
    "no further case is reserved after the unverified cleanup");
});

test("a second interrupt re-raises the default disposition", { timeout: 8000 }, async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const run = await buildRun(t, "laya", classifier.url, [{ id: "linger-entry", kind: "worker-readonly" }]);
  const entry = spawn(process.execPath,
    [ENTRY_PATH, "--execute", run.manifestPath, "--approve", run.sha256],
    { env: workerEnv(fakeBin, "spawn-linger"), stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => entry.kill("SIGKILL"));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    entry.on("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise(resolve => setTimeout(resolve, 700));
  entry.kill("SIGINT");
  await new Promise(resolve => setTimeout(resolve, 350));
  entry.kill("SIGINT");
  const outcome = await closed;
  assert.equal(outcome.signal, "SIGINT",
    "the second interrupt terminates the entry by signal instead of being swallowed");
});

test("an abandoned round still exits with the operator's signal code", { timeout: 25000 }, async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const run = await buildRun(t, "laya", classifier.url, [{ id: "linger-forever", kind: "worker-readonly" }]);
  const pidFile = join(run.runRoot, "linger.pid");
  const entry = spawn(process.execPath,
    [ENTRY_PATH, "--execute", run.manifestPath, "--approve", run.sha256],
    {
      env: { ...workerEnv(fakeBin, "linger-forever"), TURNHELM_LINGER_PID_FILE: pidFile },
      stdio: ["ignore", "ignore", "pipe"]
    });
  t.after(() => entry.kill("SIGKILL"));
  // The descendant never exits on its own; reap it by the pid it dropped.
  t.after(async () => {
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    entry.on("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise(resolve => setTimeout(resolve, 700));
  entry.kill("SIGINT");
  const outcome = await Promise.race([
    closed,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 16000))
  ]);
  assert.notEqual(outcome, null,
    "the entry exits bounded even while a descendant holds the pipe open forever");
  assert.equal(outcome?.code, 130, "the operator's signal intent stands in the exit code");
});

test("dual fixture port conflict stops before any paid call", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // The frozen fixture port is held by something else: binding must fail and
  // stop the round before the first case, let alone a paid call.
  const blocker = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const blockedPort = (blocker.address() as AddressInfo).port;

  const run = await buildRun(t, "dual", classifier.url, [
    { id: "lead", kind: "worker-readonly" },
    { id: "fixture", kind: "worker-write", fixtureUrl: `http://127.0.0.1:${blockedPort}` }
  ]);
  const code = await executeAcceptance(run.manifestPath, run.sha256, {
    env: {
      ...workerEnv(fakeBin, "ok-readonly"),
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TYPESAFE_API_KEY: "fixture-only"
    }
  });
  assert.equal(code, 1, "a fixture port conflict fails the run");
  assert.equal(classifier.state.requests, 0, "zero classifier calls on a port conflict");
  const evidence = await readEvidence(run.runRoot);
  assert.deepEqual(evidence.map(line => line.phase), ["prepared", "stopped"]);
  assert.equal(evidence[1].reason, "drift");
  assert.equal(evidence[1].caseId, null);
  assert.equal(evidence.some(line => line.phase === "reserved" || line.phase === "observed"), false,
    "no case ever ran");
});

test("a dead-peer fixture client cannot wedge the fail-stop exit", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // A free port for the 503 fixture, reserved then released.
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const fixturePort = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));

  // The lead case fails its worker verdict against the classifier fixture, so
  // the round stops before the fixture case ever runs: zero hosted dials, the
  // fixture server is still bound and torn down on the fail-stop path.
  const run = await buildRun(t, "dual", classifier.url, [
    { id: "lead", kind: "worker-readonly" },
    { id: "fixture", kind: "worker-write", fixtureUrl: `http://127.0.0.1:${fixturePort}` }
  ]);
  const entry = spawn(process.execPath, [ENTRY_PATH, "--execute", run.manifestPath, "--approve", run.sha256], {
    env: {
      ...workerEnv(fakeBin, "fail"),
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TYPESAFE_API_KEY: "fixture-only"
    },
    stdio: "ignore"
  });
  t.after(() => { entry.kill("SIGKILL"); });

  // A separate process plays the CLI's client shape: a POST with a body the
  // fixture never reads, then the process dies. The unread request bytes park
  // the fixture's server-side socket forever, which must not stop the round
  // from exiting with its verdict.
  const peer = spawn(process.execPath, ["-e", `
    const http = require("node:http");
    const poll = () => {
      const req = http.request({ host: "127.0.0.1", port: ${fixturePort}, method: "POST", path: "/v1/systemone" }, res => {
        res.resume();
        res.on("end", () => setTimeout(() => process.exit(0), 100));
      });
      req.on("error", () => setTimeout(poll, 25));
      req.end(JSON.stringify({ state: "x", questions: {} }));
    };
    poll();
  `], { stdio: "ignore" });
  t.after(() => { peer.kill("SIGKILL"); });

  const code = await new Promise<number | null>(resolve => {
    const bound = setTimeout(() => resolve(null), 15_000);
    entry.once("exit", exitCode => { clearTimeout(bound); resolve(exitCode); });
  });
  assert.notEqual(code, null, "teardown wedged: the fail-stop round must still exit, not hang or drain silently");
  assert.equal(code, 1, "a fail verdict still exits 1");
});

test("aborting a calibration route stops the round as a signal", async t => {
  const classifier = await startClassifierFixture(t);
  classifier.scripted.push("hang");
  const fakeBin = await writeFakeCodex(t);
  const run = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  const controller = new AbortController();
  const stopping = executeAcceptance(run.manifestPath, run.sha256,
    { env: workerEnv(fakeBin, "ok-readonly"), signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 300));
  controller.abort();
  assert.equal(await stopping, 130, "the operator's signal intent stands for routing too");
  const evidence = await readEvidence(run.runRoot);
  assert.deepEqual(evidence.map(line => line.phase), ["prepared", "reserved", "observed", "stopped"],
    "an aborted route is observed, then stops — never graded");
  assert.equal(evidence.at(-1)?.reason, "signal");
  assert.equal(evidence.at(-1)?.caseId, "heading-en-trial-1");
});

test("an oversized journal is not a usable receipt", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const filler = JSON.stringify({ pad: "x".repeat(2048) });
  const run = await buildRun(t, "laya", classifier.url, [{
    id: "fat-journal", kind: "worker-readonly",
    journalSeed: Array.from({ length: 600 }, () => filler)
  }]);
  const code = await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, "ok-readonly") });
  assert.equal(code, 1, "a journal past the read bound fails the case");
  const verified = (await readEvidence(run.runRoot)).find(line => line.phase === "verified");
  assert.ok(verified);
  assert.equal((verified.checks as Record<string, unknown>)["receipt-unique"], false,
    "the oversized journal degrades to an unusable receipt instead of being trusted");
});

test("a verification error cannot discard the observation", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // The worker plants the artifact as a symlink: the oracle read refuses it
  // (production project-path semantics) and that refusal must not throw the
  // completed observation away — the case fails as unverifiable instead.
  const run = await buildRun(t, "laya", classifier.url, [{ id: "symlinker", kind: "worker-write" }]);
  const code = await executeAcceptance(run.manifestPath, run.sha256, { env: workerEnv(fakeBin, "symlink-summary") });
  assert.equal(code, 1);
  const evidence = await readEvidence(run.runRoot);
  assert.ok(evidence.some(line => line.phase === "observed" && line.caseId === "symlinker"),
    "the observation is persisted before any fallible verification read");
  const verified = evidence.find(line => line.phase === "verified");
  assert.ok(verified);
  assert.equal((verified.checks as Record<string, unknown>)["verifiable"], false);
  assert.equal(evidence.at(-1)?.phase, "stopped");
});

test("crafted manifests cannot widen scope beyond the frozen suite", async t => {
  const classifier = await startClassifierFixture(t);

  // Rewrite a crafted manifest and hand back the sha of the new bytes.
  const recraft = async (run: { manifestPath: string }, mutate: (manifest: Record<string, unknown>) => void): Promise<string> => {
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8")) as Record<string, unknown>;
    mutate(manifest);
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(run.manifestPath, bytes);
    return sha256hex(Buffer.from(bytes, "utf8"));
  };

  // Caps that stay internally consistent with the reservations but exceed the
  // frozen suite ceiling (jev: one worker, one jev call) must be refused.
  const inflated = await buildRun(t, "jev", classifier.url, [
    { id: "jev-one", kind: "worker-readonly" },
    { id: "jev-two", kind: "worker-readonly" }
  ]);
  await assert.rejects(() => claimAcceptance(inflated.manifestPath, inflated.sha256), /suite caps/);

  // A correctly hashed task outside the frozen corpus must be refused.
  const offCorpus = await buildRun(t, "laya", classifier.url, [{ id: "rogue-task", kind: "worker-readonly" }]);
  const offCorpusSha = await recraft(offCorpus, manifest => {
    const item = (manifest.cases as Record<string, unknown>[])[0];
    item.task = "arbitrary attacker-chosen task text";
    item.taskBytes = Buffer.byteLength(item.task as string, "utf8");
    item.taskHash = sha256hex(Buffer.from(item.task as string, "utf8"));
  });
  await assert.rejects(() => claimAcceptance(offCorpus.manifestPath, offCorpusSha), /frozen corpus task/);

  // A worker root outside the frozen run root's consumers directory must be
  // refused at parse, before any file identity check.
  const outside = await realpath(await mkdtemp(join(tmpdir(), "turnhelm-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideSha = await recraft(inflated, manifest => {
    const item = (manifest.cases as Record<string, unknown>[])[0];
    item.root = outside;
  });
  await assert.rejects(() => claimAcceptance(inflated.manifestPath, outsideSha), /consumers/);

  // An oracle expected pair that is not the corpus fact must be refused.
  const badOracle = await buildRun(t, "laya", classifier.url, [{ id: "soft-oracle", kind: "worker-readonly" }]);
  const badOracleSha = await recraft(badOracle, manifest => {
    ((manifest.cases as Record<string, unknown>[])[0].oracle as Record<string, unknown>).expected = { count: 0, sum: 0 };
  });
  await assert.rejects(() => claimAcceptance(badOracle.manifestPath, badOracleSha), /corpus fact/);
});

test("declared reservations bound what execution reserves", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);

  // A crafted dual manifest whose cases declare narrower reservations than
  // their configs enable is refused: caps approve the declared scope and
  // execution must never be able to widen it past that approval.
  const split = await buildRun(t, "dual", classifier.url, [
    { id: "split-1", kind: "worker-readonly", reservation: ["laya"] },
    { id: "split-2", kind: "worker-readonly", reservation: ["jev"] }
  ]);
  await assert.rejects(() => claimAcceptance(split.manifestPath, split.sha256), /must cover/);

  // A manifest whose reservations match its configs executes within the
  // declared scope: every reserved record carries the case's own backends,
  // not the suite-wide set — and the run needs no hosted key at all.
  const narrow = await buildRun(t, "dual", classifier.url, [
    { id: "narrow-1", kind: "worker-readonly", reservation: ["laya"], jevEnabled: false },
    { id: "narrow-2", kind: "worker-readonly", reservation: ["laya"], jevEnabled: false }
  ]);
  assert.equal(await executeAcceptance(narrow.manifestPath, narrow.sha256, { env: workerEnv(fakeBin, "ok-readonly") }), 0);
  const reserved = (await readEvidence(narrow.runRoot)).filter(line => line.phase === "reserved");
  assert.deepEqual(reserved.map(line => line.backends), [["laya"], ["laya"]],
    "each case reserves exactly its declared backends");
});

test("a swapped git identity stops the round before anything is claimed", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  // The production CLI inspects the git work tree at run time, so git is
  // spawned after prepare: a swapped git on PATH would ride the approval
  // unless the frozen identity is re-verified at the execute gate.
  const run = await buildRun(t, "laya", classifier.url, [{ id: "git-pinned", kind: "worker-readonly" }]);
  const manifest = JSON.parse(await readFile(run.manifestPath, "utf8")) as Record<string, unknown>;
  ((manifest.baseline as Record<string, unknown>).tools as Record<string, unknown>).git = "git version 0.0.0-swapped";
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(run.manifestPath, bytes);
  const sha = sha256hex(Buffer.from(bytes, "utf8"));
  assert.equal(await executeAcceptance(run.manifestPath, sha, { env: workerEnv(fakeBin, "ok-readonly") }), 1,
    "a swapped git identity fails the run");
  assert.equal(classifier.state.requests, 0, "the gate makes zero calls");
  await assert.rejects(() => stat(join(run.runRoot, "evidence", "evidence.jsonl")), { code: "ENOENT" },
    "nothing is claimed when the git identity drifted");
});

test("host snapshot drift between prepare and claim rejects", async t => {
  const classifier = await startClassifierFixture(t);
  // The manifest records the host project config state at prepare; a claim in
  // a drifted environment (or against a forged snapshot) must not proceed.
  const run = await buildRun(t, "laya", classifier.url, [{ id: "host-pinned", kind: "worker-readonly" }]);
  const crafted = JSON.parse(await readFile(run.manifestPath, "utf8")) as { hostSnapshot: unknown };
  const hostReality = await readProjectFile(REPO_ROOT, ".turnhelm/config.json", 65536);
  assert.deepEqual(crafted.hostSnapshot, hostReality === undefined
    ? { exists: false, sha256: null }
    : { exists: true, sha256: sha256hex(hostReality) },
    "crafted manifests snapshot the real host config state, not a hardcoded one");
  const manifest = JSON.parse(await readFile(run.manifestPath, "utf8")) as Record<string, unknown>;
  manifest.hostSnapshot = { exists: true, sha256: "0".repeat(64) };
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(run.manifestPath, bytes);
  await assert.rejects(() => claimAcceptance(run.manifestPath, sha256hex(Buffer.from(bytes, "utf8"))), /host snapshot/);
});

test("host snapshot present state pins through a redirect child", async t => {
  // The drift test above pins the absent state on this host. The present
  // state is pinned by re-running that same test in a child whose redirect
  // preload serves an owned fixture at the host-config path: the checkout is
  // never written, and buildRun's derivation, the consistency pin, and the
  // forged-snapshot rejection all execute against a present host end to end.
  const presentDirectory = await mkdtemp(join(tmpdir(), "turnhelm-host-present-"));
  t.after(() => rm(presentDirectory, { recursive: true, force: true }));
  const presentHost = join(presentDirectory, "host.json");
  await writeFile(presentHost, "{\"version\":1}\n", { mode: 0o600 });
  const preload = join(presentDirectory, "redirect-preload.cjs");
  await writeFile(preload, REDIRECT_PRELOAD);
  await execute(process.execPath,
    ["--test", "--test-name-pattern",
      "^host snapshot drift between prepare and claim rejects$",
      fileURLToPath(import.meta.url)],
    {
      encoding: "utf8", timeout: 120000,
      env: {
        PATH: process.env.PATH ?? "",
        TURNHELM_TEST_REDIRECTS: JSON.stringify({ read: { [HOST_PATH]: { to: presentHost } } }),
        // NODE_OPTIONS carries the redirect preload into the test-file child.
        NODE_OPTIONS: "--require " + preload
      }
    });
});

test("consumer instruction files are frozen with the case", async t => {
  const classifier = await startClassifierFixture(t);

  // AGENTS.md and the installed skill files steer the worker exactly like
  // input.json does: instruction drift after approval must fail claim, not
  // ride along into execution.
  const run = await buildRun(t, "laya", classifier.url, [{ id: "instructed", kind: "worker-readonly" }]);
  const root = join(run.runRoot, "consumers", "instructed");
  await writeFile(join(root, "AGENTS.md"), "# swapped instructions\n");
  await assert.rejects(() => claimAcceptance(run.manifestPath, run.sha256), /frozen bytes/,
    "a swapped AGENTS.md must not claim");
  await writeFile(join(root, "AGENTS.md"), "# consumer instructions\n");
  await writeFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"), "# swapped skill\n");
  await assert.rejects(() => claimAcceptance(run.manifestPath, run.sha256), /frozen bytes/,
    "a swapped skill file must not claim");
});

test("dual first case must be a genuine laya-first selection", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const dualEnv: NodeJS.ProcessEnv = {
    ...workerEnv(fakeBin, "ok-readonly"),
    TURNHELM_ALLOW_HOSTED_JEV: "1",
    TYPESAFE_API_KEY: "fixture-only"
  };

  // Both dual cases share the fixture port, so no 503 fixture case exists and
  // the run completes fully offline through the classifier fixture on laya.
  const run = await buildRun(t, "dual", classifier.url, [
    { id: "lead", kind: "worker-readonly" },
    { id: "second", kind: "worker-readonly" }
  ]);
  assert.equal(await executeAcceptance(run.manifestPath, run.sha256, { env: dualEnv }), 0);
  const leadVerified = (await readEvidence(run.runRoot)).find(line => line.phase === "verified" && line.caseId === "lead");
  assert.ok(leadVerified);
  assert.equal((leadVerified.checks as Record<string, unknown>)["laya-first"], true,
    "the lead dual case passes only when laya alone was attempted and selected");

  // A lead receipt that does not show exactly one laya selection fails the
  // lead fact offline: a seeded duplicate receipt degrades the observation
  // without ever routing a laya failure into the real hosted jev fallback.
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as { workerReadonlyTask: string };
  const taskBytes = Buffer.from(corpus.workerReadonlyTask, "utf8");
  const seedLine = JSON.stringify({
    type: "turnhelm.route", ts: "2026-10-11T00:00:00.000Z",
    taskSha256: sha256hex(taskBytes), taskBytes: taskBytes.length, status: "selected",
    routingMs: 5, attempts: [{ backend: "laya", outcome: "success", durationMs: 5 }],
    backend: "laya", profileId: "fast", model: "gpt-6-luna", effort: "low"
  });
  const bad = await buildRun(t, "dual", classifier.url, [{ id: "lead-bad", kind: "worker-readonly", journalSeed: [seedLine] }]);
  assert.equal(await executeAcceptance(bad.manifestPath, bad.sha256, { env: dualEnv }), 1);
  const badVerified = (await readEvidence(bad.runRoot)).find(line => line.phase === "verified" && line.caseId === "lead-bad");
  assert.ok(badVerified);
  assert.equal((badVerified.checks as Record<string, unknown>)["laya-first"], false,
    "a lead case that never made a valid laya selection is not laya-first");

  // The offline suite never attempts the hosted jev backend: any jev attempt
  // in a routing journal means the real api.typesafe.ai origin was dialed.
  // (The transport cannot be intercepted — systemone destructures the
  // node:https request binding at import time — so the journal is the
  // authoritative offline proof.)
  for (const [root, ids] of [[run.runRoot, ["lead", "second"]], [bad.runRoot, ["lead-bad"]]] as const) {
    for (const id of ids) {
      const journal = await readFile(join(root, "consumers", id, ".turnhelm", "routes.jsonl"), "utf8");
      assert.ok(!journal.includes("\"backend\":\"jev\""),
        `case ${id} must not attempt the hosted jev backend from the offline suite`);
    }
  }
});

// ---- Task 2: v2 fixed calibration and reliable completion (RR02/RR05) ----

const HOST_PATH = join(REPO_ROOT, ".turnhelm", "config.json");

// Child preload (CJS): redirects exact-path fs reads to owned fixtures and
// delegates everything else. The harness binds fs names at ESM evaluation,
// so patching the CJS exports before the load (plus syncBuiltinESMExports)
// intercepts even destructured imports; in-process mocks cannot.
const REDIRECT_PRELOAD = `const fs = require("node:fs");
const fsp = require("node:fs/promises");
const spec = JSON.parse(process.env.TURNHELM_TEST_REDIRECTS ?? "{}");
const originalReadFile = fsp.readFile;
const originalOpenSync = fs.openSync;
const redirect = (path) => {
  const entry = spec.read[String(path)];
  if (entry === undefined) return null;
  if (entry.watch !== undefined) {
    try {
      if (fs.readFileSync(entry.watch, "utf8").includes(entry.marker)) return entry.after;
    } catch { /* the watch file does not exist yet */ }
    return entry.before;
  }
  return entry.to;
};
fsp.readFile = function (path, ...rest) {
  const target = redirect(path);
  return target === null ? originalReadFile.call(this, path, ...rest)
    : originalReadFile.call(this, target, ...rest);
};
fs.openSync = function (path, ...rest) {
  const target = redirect(path);
  return originalOpenSync.call(this, target === null ? path : target, ...rest);
};
// Optional: write the watch marker the moment the completed evidence record
// is appended, so the post-completed terminal recheck reads drifted bytes.
// FileHandle is not reachable from CJS, so the instance's own appendFile is
// wrapped from the fsPromises.open call that created it.
const flipOn = process.env.TURNHELM_TEST_FLIP_ON_COMPLETED;
if (flipOn !== undefined) {
  const originalOpenHandle = fsp.open;
  fsp.open = function (...args) {
    return originalOpenHandle.apply(this, args).then(handle => {
      if (handle !== null && typeof handle === "object" && typeof handle.appendFile === "function") {
        const boundAppend = handle.appendFile.bind(handle);
        let flipped = false;
        Object.defineProperty(handle, "appendFile", {
          configurable: true,
          writable: true,
          value: function (data, ...rest) {
            if (!flipped && String(data).includes('"phase":"completed"')) {
              flipped = true;
              try { fs.writeFileSync(flipOn, "flip"); } catch { /* the test dir owns it */ }
            }
            return boundAppend(data, ...rest);
          }
        });
      }
      return handle;
    });
  };
}
// Children under this preload (prepare probes, drift probes) may dial the
// owned classifier fixture over plain http, but nothing they do has a
// legitimate https or fetch transport — both refuse, loudly.
const trappedHttps = require("node:https");
for (const api of ["request", "get"]) {
  trappedHttps[api] = function () {
    throw new Error("redirect-preload child made an https call via node:https." + api);
  };
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = function () {
    throw new Error("redirect-preload child made a fetch call");
  };
}
require("node:module").syncBuiltinESMExports();
`;

const PREPARE_PROBE_CHILD = `try {
  const mod = await import(process.argv[2]);
  const prepared = await mod.prepareAcceptance(process.argv[3]);
  process.stdout.write("PROBE_OK " + prepared.manifestPath + "\\n");
} catch (error) {
  process.stdout.write("PROBE_FAIL " + String(error && error.message ? error.message : error).split("\\n")[0] + "\\n");
}
`;

const runPrepareProbe = async (
  t: TestContext,
  redirects: Readonly<Record<string, unknown>>,
  suite: string
): Promise<{ ok: boolean; line: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "redirect-preload.cjs");
  const childScript = join(directory, "prepare-probe.mjs");
  await writeFile(preload, REDIRECT_PRELOAD);
  await writeFile(childScript, PREPARE_PROBE_CHILD);
  const harness = pathToFileURL(fileURLToPath(new URL("./live-acceptance.js", import.meta.url))).href;
  const run = await execute(process.execPath,
    ["--require", preload, childScript, harness, suite],
    {
      encoding: "utf8", timeout: 120000,
      env: { ...process.env, TURNHELM_TEST_REDIRECTS: JSON.stringify(redirects) }
    }).catch((failure: { stdout?: string; stderr?: string }) => failure);
  const text = String(run.stdout ?? "");
  const line = text.split("\n").find(candidate =>
    candidate.startsWith("PROBE_OK ") || candidate.startsWith("PROBE_FAIL "));
  assert.ok(line !== undefined,
    "the probe child must report: " + String((run as { stderr?: string }).stderr ?? ""));
  return { ok: line.startsWith("PROBE_OK"), line };
};

test("the redirect preload traps https and fetch but leaves plain http alone", async t => {
  // Prepare probes and drift children run under REDIRECT_PRELOAD; they may
  // dial the owned classifier fixture over plain http, but nothing they do has
  // a legitimate https or fetch transport — those must refuse, loudly.
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-rptrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "redirect-preload.cjs");
  const childScript = join(directory, "trap-probe.mjs");
  await writeFile(preload, REDIRECT_PRELOAD);
  await writeFile(childScript, `
    const http = await import("node:http");
    const https = await import("node:https");
    const hits = { count: 0 };
    const server = http.createServer((req, res) => {
      hits.count += 1;
      req.resume();
      res.writeHead(200);
      res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const outcome = { httpsMessage: null, fetchMessage: null, httpOk: false };
    try {
      const req = https.request({ host: "127.0.0.1", port, path: "/x", method: "GET" });
      req.on("error", () => {});
      req.end();
    } catch (error) {
      outcome.httpsMessage = String(error && error.message);
    }
    try {
      await fetch("http://127.0.0.1:" + port + "/y");
    } catch (error) {
      outcome.fetchMessage = String(error && error.message);
    }
    outcome.httpOk = await new Promise(resolve => {
      http.get({ host: "127.0.0.1", port, path: "/z" }, res => {
        res.resume();
        res.on("end", () => resolve(true));
      }).on("error", () => resolve(false));
    });
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
    process.stdout.write("TRAP_RESULT " + JSON.stringify({ ...outcome, serverHits: hits.count }) + "\\n");
  `);
  const run = await execute(process.execPath, ["--require", preload, childScript],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, TURNHELM_TEST_REDIRECTS: '{"read":{}}' } });
  const line = String(run.stdout).split("\n").find(candidate => candidate.startsWith("TRAP_RESULT "));
  assert.ok(line, "the trap probe must report");
  const result = JSON.parse(line.slice("TRAP_RESULT ".length)) as {
    httpsMessage: string | null; fetchMessage: string | null; httpOk: boolean; serverHits: number;
  };
  assert.match(String(result.httpsMessage), /https call/, "https is trapped inside redirect-preload children");
  assert.match(String(result.fetchMessage), /fetch call/, "fetch is trapped inside redirect-preload children");
  assert.equal(result.httpOk, true, "plain http (the owned classifier fixture) still works");
  assert.equal(result.serverHits, 1, "only the http control ever reaches the server");
});

// A v2 corpus shaped exactly as the spec requires, with the worker parts the
// worker suites still use; mutations build the malformed variants.
const buildCorpusVariant = async (mutate: (corpus: Record<string, unknown>) => void): Promise<string> => {
  const current = JSON.parse(await readFile(CORPUS_PATH, "utf8")) as Record<string, unknown>;
  const corpus: Record<string, unknown> = {
    version: 2,
    calibrationTasks: [...SPEC_CALIBRATION.dev, ...SPEC_CALIBRATION.holdout].map(entry => ({
      id: entry.id, pairId: entry.pairId, language: entry.language,
      split: entry.split, task: entry.task, allowedProfiles: [...entry.allowedProfiles]
    })),
    workerReadonlyTask: current.workerReadonlyTask,
    workerWriteTask: current.workerWriteTask,
    workerFixtureInput: current.workerFixtureInput
  };
  mutate(corpus);
  return JSON.stringify(corpus, null, 2) + "\n";
};

// Prepare a calibration manifest, then point only its Laya URL at the owned
// fixture and re-hash: profiles, roster, and bands stay frozen.
const buildCalibrationRun = async (
  t: TestContext,
  suite: "calibration-dev" | "calibration-holdout",
  layaUrl: string
): Promise<{ manifestPath: string; sha256: string; runRoot: string }> => {
  const prepared = await prepareAcceptance(suite);
  const runRoot = dirname(prepared.manifestPath);
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8"));
  for (const item of manifest.cases) item.config.backends.laya.url = layaUrl;
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(prepared.manifestPath, bytes, { mode: 0o600 });
  return { manifestPath: prepared.manifestPath, sha256: sha256hex(Buffer.from(bytes, "utf8")), runRoot };
};

test("RR02 calibration forgery refuses before calls", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const fixtureEnv = workerEnv(fakeBin, "ok-readonly");

  // Real prepared manifests freeze the spec §4.2/§4.3 roster offline.
  const devPrepared = await prepareAcceptance("calibration-dev");
  t.after(() => rm(dirname(devPrepared.manifestPath), { recursive: true, force: true }));
  const holdoutPrepared = await prepareAcceptance("calibration-holdout");
  t.after(() => rm(dirname(holdoutPrepared.manifestPath), { recursive: true, force: true }));
  const devOriginal = JSON.parse(await readFile(devPrepared.manifestPath, "utf8"));
  const holdoutOriginal = JSON.parse(await readFile(holdoutPrepared.manifestPath, "utf8"));

  assert.deepEqual(devOriginal.caps, { worker: 0, laya: 12, jev: 0 });
  assert.equal(devOriginal.cases.length, 12);
  assert.deepEqual(devOriginal.cases.map((item: { id: string }) => item.id), [1, 2, 3].flatMap(n =>
    ["heading-en", "heading-zh", "race-en", "race-zh"].map(id => `${id}-trial-${n}`)));
  assert.deepEqual(holdoutOriginal.cases.map((item: { id: string }) => item.id), [1, 2, 3].flatMap(n =>
    ["decoy-en", "decoy-zh", "auth-en", "auth-zh"].map(id => `${id}-trial-${n}`)));
  for (const [manifest, split] of [[devOriginal, "dev"], [holdoutOriginal, "holdout"]] as const) {
    for (const [index, item] of (manifest.cases as Record<string, unknown>[]).entries()) {
      const expected = SPEC_CALIBRATION[split][index % 4];
      const trial = Math.floor(index / 4) + 1;
      assert.equal(item.kind, "classifier-only");
      assert.equal(item.task, expected.task);
      assert.equal(item.taskHash, sha256hex(Buffer.from(expected.task, "utf8")));
      assert.deepEqual(item.oracle, { kind: "classifier-band", pairId: expected.pairId,
        language: expected.language, split: expected.split, trial,
        allowedProfiles: [...expected.allowedProfiles] });
      assert.deepEqual(item.reservation, { worker: 0, backends: ["laya"] });
    }
  }
  assert.deepEqual(await readdir(join(dirname(devPrepared.manifestPath), "consumers")), [],
    "calibration prepares zero worker consumers");
  await assert.rejects(() => stat(join(dirname(devPrepared.manifestPath), "evidence", "evidence.jsonl")),
    { code: "ENOENT" }, "prepare claims no evidence slot");

  // Every forgery below is rewritten and re-hashed, so the approved SHA is
  // correct for the tampered bytes: only the grammar/claim binding may refuse.
  // Each entry also names the exact claim gate that must refuse it, so a
  // deleted check cannot hide behind a neighboring gate's rejection.
  const casesOf = (manifest: Record<string, unknown>) => manifest.cases as Record<string, unknown>[];
  const firstCase = (manifest: Record<string, unknown>) => casesOf(manifest)[0];
  const oracleOf = (manifest: Record<string, unknown>) => firstCase(manifest).oracle as Record<string, unknown>;
  const configOf = (manifest: Record<string, unknown>) => firstCase(manifest).config as {
    profiles: Record<string, { model: string; effort: string }>;
    backends: { jev: { enabled: boolean } };
    routingTimeoutMs: number;
  };
  const layaPrepared = await prepareAcceptance("laya");
  t.after(() => rm(dirname(layaPrepared.manifestPath), { recursive: true, force: true }));
  const layaOriginal = JSON.parse(await readFile(layaPrepared.manifestPath, "utf8"));

  const forgeries: readonly (readonly [string, (manifest: Record<string, unknown>) => void, RegExp])[] = [
    ["v1-manifest", m => { m.version = 1; }, /manifest version must be 2/],
    ["unknown-manifest-key", m => { m.extra = 1; }, /unknown field "extra"/],
    ["unknown-oracle-key", m => { oracleOf(m).band = ["fast"]; }, /unknown field "band"/],
    ["wrong-language", m => { oracleOf(m).language = "fr"; }, /language must be en or zh/],
    ["wrong-trial", m => { oracleOf(m).trial = 4; }, /trial must be 1, 2, or 3/],
    ["duplicate-band-profile", m => { oracleOf(m).allowedProfiles = ["fast", "fast"]; }, /allowedProfiles must be unique/],
    ["empty-band", m => { oracleOf(m).allowedProfiles = []; }, /allowedProfiles must be a nonempty array/],
    ["cross-split-case", m => { casesOf(m)[0] = structuredClone(holdoutOriginal.cases[0]); }, /split must match the suite/],
    ["wrong-case-id", m => { firstCase(m).id = "heading-en-trial-9"; }, /not the frozen roster id/],
    ["wrong-task", m => {
      const item = firstCase(m);
      item.task = "tampered classifier task text";
      item.taskBytes = Buffer.byteLength(item.task as string, "utf8");
      item.taskHash = sha256hex(Buffer.from(item.task as string, "utf8"));
    }, /not the frozen corpus task/],
    ["wrong-pair-id", m => { oracleOf(m).pairId = "race"; }, /not the corpus fact/],
    ["band-swap", m => { oracleOf(m).allowedProfiles = ["deep", "frontier", "frontier_xhigh"]; }, /not the corpus fact/],
    ["deleted-trial", m => { casesOf(m).pop(); (m.caps as Record<string, number>).laya = 11; }, /calibration roster is incomplete/],
    ["duplicated-trial", m => { casesOf(m).push(structuredClone(casesOf(m)[0])); }, /is duplicated/],
    ["reordered-trial", m => {
      const all = casesOf(m);
      [all[0], all[4]] = [all[4], all[0]];
    }, /not the frozen roster id/],
    ["rebound-profiles", m => { configOf(m).profiles.fast = { ...configOf(m).profiles.balanced }; }, /profiles drifted from the template/],
    ["changed-timeout", m => { configOf(m).routingTimeoutMs = 20000; }, /config drifted from the template/],
    ["jev-enabled", m => { configOf(m).backends.jev.enabled = true; }, /must cover the enabled jev backend/],
    ["worker-case-in-calibration", m => {
      casesOf(m)[0] = structuredClone(layaOriginal.cases[0]);
      m.caps = { worker: 1, laya: 12, jev: 0 };
    }, /must not carry worker cases/],
    ["underreported-caps", m => { (m.caps as Record<string, number>).laya = 11; }, /caps must match the case reservations/]
  ];
  for (const [name, mutate, gate] of forgeries) {
    const manifest = structuredClone(devOriginal);
    mutate(manifest);
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(devPrepared.manifestPath, bytes, { mode: 0o600 });
    const sha = sha256hex(Buffer.from(bytes, "utf8"));
    await assert.rejects(() => claimAcceptance(devPrepared.manifestPath, sha), gate,
      name + " must be refused by its named claim gate");
    assert.equal(await executeAcceptance(devPrepared.manifestPath, sha, { env: fixtureEnv }), 1,
      name + " is refused before the first classifier call");
    assert.equal(classifier.state.requests, 0, name + " makes zero classifier requests");
    await assert.rejects(() => stat(join(dirname(devPrepared.manifestPath), "evidence", "evidence.jsonl")),
      { code: "ENOENT" }, name + " never claims evidence");
  }
  await writeFile(devPrepared.manifestPath, JSON.stringify(devOriginal, null, 2) + "\n", { mode: 0o600 });

  // Malformed corpora refuse prepare inside an isolated child: only the exact
  // corpus path is redirected to an owned fixture; every other read delegates.
  const variantDirectory = await mkdtemp(join(tmpdir(), "turnhelm-corpus-"));
  t.after(() => rm(variantDirectory, { recursive: true, force: true }));
  const validCorpusPath = join(variantDirectory, "valid.json");
  await writeFile(validCorpusPath, await buildCorpusVariant(() => {}));
  const control = await runPrepareProbe(t, { read: { [CORPUS_PATH]: { to: validCorpusPath } } }, "calibration-dev");
  assert.ok(control.ok, "a valid spec §4.3 corpus prepares: the redirect itself must not fail prepare");
  t.after(() => rm(dirname(control.line.slice("PROBE_OK ".length).trim()), { recursive: true, force: true }));

  const corpusVariants: readonly (readonly [string, (corpus: Record<string, unknown>) => void])[] = [
    ["v1-corpus", c => {
      c.version = 1;
      delete c.calibrationTasks;
      c.classifierOnlyTasks = [];
    }],
    ["unknown-corpus-key", c => { c.extra = 1; }],
    ["missing-task", c => { c.calibrationTasks = (c.calibrationTasks as unknown[]).slice(0, 7); }],
    ["same-language-pair", c => {
      (c.calibrationTasks as Record<string, unknown>[])[1].language = "en";
    }],
    ["duplicate-task-id", c => {
      (c.calibrationTasks as Record<string, unknown>[])[4].id = "heading-en";
    }],
    ["bad-band-profile", c => {
      (c.calibrationTasks as Record<string, unknown>[])[0].allowedProfiles = ["fast", "turbo"];
    }],
    ["blank-task", c => {
      (c.calibrationTasks as Record<string, unknown>[])[0].task = "   ";
    }],
    ["cross-split-pair-id", c => {
      for (const task of c.calibrationTasks as Record<string, unknown>[]) {
        if (task.pairId === "decoy") task.pairId = "heading";
        if (task.pairId === "auth") task.pairId = "race";
      }
    }],
    ["three-member-pair", c => {
      (c.calibrationTasks as Record<string, unknown>[])[1].pairId = "race";
    }],
    ["blank-worker-task", c => { c.workerReadonlyTask = "   "; }],
    ["nul-worker-task", c => { c.workerWriteTask = "sum the values\0"; }],
    ["continuation-worker-task", c => { c.workerReadonlyTask = "continue"; }],
    ["oversize-worker-task", c => { c.workerWriteTask = "x".repeat(9000); }]
  ];
  for (const [name, mutate] of corpusVariants) {
    const path = join(variantDirectory, name + ".json");
    await writeFile(path, await buildCorpusVariant(mutate));
    const probe = await runPrepareProbe(t, { read: { [CORPUS_PATH]: { to: path } } }, "calibration-dev");
    assert.ok(!probe.ok, "a " + name + " corpus must refuse prepare");
  }

  // Host config contract: ENOENT is the only absent state; unreadable,
  // symlink, FIFO, and oversize hosts all refuse prepare.
  const hostDirectory = await mkdtemp(join(tmpdir(), "turnhelm-host-"));
  t.after(() => rm(hostDirectory, { recursive: true, force: true }));
  const hostBytes = Buffer.from("{\"version\":1}\n", "utf8");
  const hostRegular = join(hostDirectory, "host.json");
  await writeFile(hostRegular, hostBytes, { mode: 0o600 });
  const absent = await runPrepareProbe(t,
    { read: { [HOST_PATH]: { to: join(hostDirectory, "absent.json") } } }, "calibration-dev");
  assert.ok(absent.ok, "an absent host config is a recorded state, not an error");
  const absentManifest = JSON.parse(
    await readFile(absent.line.slice("PROBE_OK ".length).trim(), "utf8")) as { hostSnapshot: unknown };
  assert.deepEqual(absentManifest.hostSnapshot, { exists: false, sha256: null });
  t.after(() => rm(dirname(absent.line.slice("PROBE_OK ".length).trim()), { recursive: true, force: true }));
  const present = await runPrepareProbe(t, { read: { [HOST_PATH]: { to: hostRegular } } }, "calibration-dev");
  assert.ok(present.ok, "a readable host config is snapshotted, not refused");
  const presentManifest = JSON.parse(
    await readFile(present.line.slice("PROBE_OK ".length).trim(), "utf8")) as { hostSnapshot: unknown };
  assert.deepEqual(presentManifest.hostSnapshot, { exists: true, sha256: sha256hex(hostBytes) });
  t.after(() => rm(dirname(present.line.slice("PROBE_OK ".length).trim()), { recursive: true, force: true }));

  const hostLocked = join(hostDirectory, "locked.json");
  await writeFile(hostLocked, hostBytes, { mode: 0o600 });
  await chmod(hostLocked, 0o000);
  const hostLink = join(hostDirectory, "link.json");
  await symlink(hostRegular, hostLink);
  const hostFifo = join(hostDirectory, "fifo.json");
  await execute("mkfifo", [hostFifo]);
  const hostHuge = join(hostDirectory, "huge.json");
  await writeFile(hostHuge, Buffer.alloc(65537, 0x20));
  for (const [name, path] of [["unreadable", hostLocked], ["symlink", hostLink],
    ["fifo", hostFifo], ["oversize", hostHuge]] as const) {
    const probe = await runPrepareProbe(t, { read: { [HOST_PATH]: { to: path } } }, "calibration-dev");
    assert.ok(!probe.ok, "a " + name + " host config must refuse prepare");
  }
});

// Child preload: count and refuse every HTTPS/fetch transport while plain
// HTTP (the Laya fixture) stays untouched.
const HTTPS_TRAP_PRELOAD = `const state = { httpsCalls: 0, fetchCalls: 0 };
const https = require("node:https");
for (const api of ["request", "get"]) {
  https[api] = function () {
    state.httpsCalls++;
    throw new Error("calibration made an https call via " + api);
  };
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = function () {
    state.fetchCalls++;
    throw new Error("calibration made a fetch call");
  };
}
require("node:module").syncBuiltinESMExports();
globalThis.__TURNHELM_HTTPS_TRAP = state;
`;

const CALIBRATION_EXEC_CHILD = `const trap = globalThis.__TURNHELM_HTTPS_TRAP;
const mod = await import(process.argv[2]);
const code = await mod.executeAcceptance(process.argv[3], process.argv[4], { env: process.env });
process.stdout.write("CALIB_RESULT " + JSON.stringify({
  code, httpsCalls: trap.httpsCalls, fetchCalls: trap.fetchCalls
}) + "\\n");
`;

test("RR03 calibration is local classifier only", async t => {
  const classifier = await startClassifierFixture(t);
  // Every scripted answer stays inside its frozen band: fast/balanced for
  // the heading pair, deep/frontier for the race pair, once per trial.
  for (const profile of [1, 2, 3].flatMap(() => ["fast", "balanced", "deep", "frontier"])) {
    classifier.scripted.push(choiceBody(profile));
  }

  // A spy worker records every invocation; the run must never spawn one.
  const spyDirectory = await mkdtemp(join(tmpdir(), "turnhelm-spy-"));
  t.after(() => rm(spyDirectory, { recursive: true, force: true }));
  const spyLog = join(spyDirectory, "codex.log");
  await writeFile(join(spyDirectory, "codex"),
    "#!/usr/bin/env node\n"
    + 'require("node:fs").appendFileSync(process.env.TURNHELM_CODEX_SPY, JSON.stringify(process.argv) + "\\n");\n'
    + "process.exit(42);\n");
  await chmod(join(spyDirectory, "codex"), 0o755);

  const run = await buildCalibrationRun(t, "calibration-dev", classifier.url);

  // The child carries fabricated hosted gates/keys as canaries; any HTTPS or
  // fetch attempt is refused and counted. Laya rides plain HTTP to the owned
  // fixture, so node:http stays untouched.
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-calibexec-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "https-trap.cjs");
  const childScript = join(directory, "calibration-exec.mjs");
  await writeFile(preload, HTTPS_TRAP_PRELOAD);
  await writeFile(childScript, CALIBRATION_EXEC_CHILD);
  const harness = pathToFileURL(fileURLToPath(new URL("./live-acceptance.js", import.meta.url))).href;
  const executed = await execute(process.execPath,
    ["--require", preload, childScript, harness, run.manifestPath, run.sha256],
    {
      encoding: "utf8", timeout: 180000,
      env: {
        PATH: spyDirectory + ":" + (process.env.PATH ?? ""),
        TURNHELM_CODEX_SPY: spyLog,
        TURNHELM_ALLOW_HOSTED_JEV: "1",
        TYPESAFE_API_KEY: "canary-not-a-real-key"
      }
    });
  const resultLine = String(executed.stdout).split("\n").find(candidate => candidate.startsWith("CALIB_RESULT "));
  assert.ok(resultLine, "the calibration child must print one CALIB_RESULT line");
  const outcome = JSON.parse(resultLine.slice("CALIB_RESULT ".length)) as {
    code: number; httpsCalls: number; fetchCalls: number;
  };
  assert.equal(outcome.code, 0);
  assert.equal(outcome.httpsCalls, 0, "calibration never dials https, even with hosted gates set");
  assert.equal(outcome.fetchCalls, 0, "calibration never fetches");
  assert.equal(classifier.state.requests, 12, "exactly twelve Laya classify calls, nothing more");
  await assert.rejects(() => stat(spyLog), { code: "ENOENT" }, "no worker was ever invoked");
  const evidence = await readEvidence(run.runRoot);
  assert.equal(evidence.filter(line => line.phase === "reserved").length, 12);
  for (const record of evidence.filter(line => line.phase === "reserved")) {
    assert.equal(record.worker, 0);
    assert.deepEqual(record.backends, ["laya"]);
  }
  assert.deepEqual(evidence.filter(line => line.phase === "verified").map(line => line.verdict),
    Array.from({ length: 12 }, () => "pass"));
  assert.equal(evidence.some(line => line.phase === "stopped"), false, "the full roster completes cleanly");

  // The real entry prepares both calibration suites with the fixed grammar.
  for (const suite of CALIBRATION_SUITES) {
    const entryRun = await new Promise<{ code: number | null; stdout: string }>(resolve => {
      execFile(process.execPath, [ENTRY_PATH, "--prepare", suite],
        { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", cwd: REPO_ROOT },
        (error, stdout) => {
          const code = error !== null && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error === null ? 0 : null;
          resolve({ code, stdout: String(stdout) });
        });
    });
    assert.equal(entryRun.code, 0, suite + " prepares through the real entry");
    const lines = entryRun.stdout.trim().split("\n");
    assert.equal(lines.length, 2, suite + " entry prepare prints exactly two lines");
    assert.match(lines[0], /^manifest \//);
    assert.match(lines[1], /^sha256 [0-9a-f]{64}$/);
    t.after(() => rm(dirname(lines[0].slice("manifest ".length)), { recursive: true, force: true }));
  }

  // Worker suites never accept calibration cases, even re-hashed and with
  // internally consistent caps.
  const layaPrepared = await prepareAcceptance("laya");
  t.after(() => rm(dirname(layaPrepared.manifestPath), { recursive: true, force: true }));
  const layaManifest = JSON.parse(await readFile(layaPrepared.manifestPath, "utf8"));
  const expected = SPEC_CALIBRATION.dev[0];
  layaManifest.cases[layaManifest.cases.length - 1] = {
    id: "heading-en-trial-1",
    kind: "classifier-only",
    root: "",
    identity: { dev: 0, ino: 0 },
    task: expected.task,
    taskHash: sha256hex(Buffer.from(expected.task, "utf8")),
    taskBytes: Buffer.byteLength(expected.task, "utf8"),
    config: structuredClone(layaManifest.cases[0].config),
    inputHashes: {},
    allowedChanges: [],
    oracle: { kind: "classifier-band", pairId: expected.pairId, language: expected.language,
      split: expected.split, trial: 1, allowedProfiles: [...expected.allowedProfiles] },
    reservation: { worker: 0, backends: ["laya"] }
  };
  const capOf = (key: "worker" | "laya" | "jev"): number => key === "worker"
    ? layaManifest.cases.reduce(
      (total: number, item: { reservation: { worker: number } }) => total + item.reservation.worker, 0)
    : layaManifest.cases.filter(
      (item: { reservation: { backends: string[] } }) => item.reservation.backends.includes(key)).length;
  layaManifest.caps = { worker: capOf("worker"), laya: capOf("laya"), jev: capOf("jev") };
  const layaBytes = JSON.stringify(layaManifest, null, 2) + "\n";
  await writeFile(layaPrepared.manifestPath, layaBytes, { mode: 0o600 });
  assert.equal(await executeAcceptance(layaPrepared.manifestPath, sha256hex(Buffer.from(layaBytes, "utf8")),
    { env: workerEnv(spyDirectory, "ok-readonly") }), 1,
    "worker suites never accept classifier-only calibration cases");
  assert.equal(classifier.state.requests, 12, "the rejected worker-suite forgery adds no requests");

  // The holdout suite carries the same ceiling: a full in-band roster makes
  // exactly twelve classify calls and completes with the pass fact.
  const holdoutBefore = classifier.state.requests;
  classifier.scripted.length = 0;
  classifier.scripted.push(
    ...[1, 2, 3].flatMap(() => [
      choiceBody("fast"), choiceBody("balanced"), choiceBody("frontier"), choiceBody("frontier_xhigh")
    ])
  );
  const holdout = await buildCalibrationRun(t, "calibration-holdout", classifier.url);
  assert.equal(await executeAcceptance(holdout.manifestPath, holdout.sha256,
    { env: workerEnv(spyDirectory, "ok-readonly") }), 0);
  assert.equal(classifier.state.requests - holdoutBefore, 12,
    "the holdout roster is capped at twelve classify calls");
  const holdoutEvidence = await readEvidence(holdout.runRoot);
  assert.equal(holdoutEvidence.filter(line => line.phase === "verified").length, 12);
  assert.deepEqual(holdoutEvidence.at(-1),
    { phase: "completed", outcome: "pass", cases: 12, policyMatches: 12, policyMismatches: 0 });
});

test("RR04 protocol and policy are independent", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const env = workerEnv(fakeBin, "ok-readonly");

  // A full in-band roster: every verified record is an engineering pass AND a
  // policy match, the completed fact reports pass, and the run exits 0.
  for (const profile of [1, 2, 3].flatMap(() => ["fast", "balanced", "deep", "frontier"])) {
    classifier.scripted.push(choiceBody(profile));
  }
  const allMatch = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(allMatch.manifestPath, allMatch.sha256, { env }), 0);
  const allEvidence = await readEvidence(allMatch.runRoot);
  const allVerified = allEvidence.filter(line => line.phase === "verified");
  assert.equal(allVerified.length, 12);
  for (const record of allVerified) {
    assert.equal(record.verdict, "pass");
    assert.equal(record.policy, "match", "an engineering pass inside the band is a policy match");
  }
  assert.deepEqual(allEvidence.at(-1), {
    phase: "completed", outcome: "pass", cases: 12, policyMatches: 12, policyMismatches: 0
  }, "a full in-band roster appends the completed fact");
  assert.equal(classifier.state.requests, 12);

  // One legal-but-out-of-band choice: the engineering verdict still passes on
  // routing facts, the policy mismatch is recorded, the roster CONTINUES to all
  // twelve calls, and the completed fact reports the split — exit 3, not 1.
  const before = classifier.state.requests;
  classifier.scripted.push(
    choiceBody("deep"), // heading-en band [fast, balanced]: legal profile, out of band
    choiceBody("balanced"), choiceBody("deep"), choiceBody("frontier"),
    ...[2, 3].flatMap(() => [choiceBody("fast"), choiceBody("balanced"), choiceBody("deep"), choiceBody("frontier")])
  );
  const mismatch = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(mismatch.manifestPath, mismatch.sha256, { env }), 3,
    "a complete roster with one legal band mismatch exits 3");
  assert.equal(classifier.state.requests - before, 12,
    "the mismatch continues the roster, it is not a failure retry");
  const mismatchEvidence = await readEvidence(mismatch.runRoot);
  assert.equal(mismatchEvidence.filter(line => line.phase === "verified").length, 12);
  const mismatched = mismatchEvidence.find(line => line.phase === "verified" && line.policy === "mismatch");
  assert.ok(mismatched, "the out-of-band case is verified with policy mismatch");
  assert.equal(mismatched.verdict, "pass", "the engineering verdict is independent of the band");
  assert.equal(mismatched.caseId, "heading-en-trial-1");
  assert.deepEqual(mismatchEvidence.at(-1), {
    phase: "completed", outcome: "policy-mismatch", cases: 12, policyMatches: 11, policyMismatches: 1
  });
  assert.ok(!mismatchEvidence.some(line => line.phase === "stopped"),
    "a policy mismatch never writes a stop");

  // An invalid classifier response is an engineering failure: policy is
  // not-applicable and the round stops at once — never graded as a mismatch.
  classifier.scripted.push(JSON.stringify({
    answers: { route: { type: "choice", choice: "turbo", confidence: 0.9 } },
    usage: { truncated: false, state_tokens_dropped: 0 }
  }));
  const broken = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  const brokenBefore = classifier.state.requests;
  assert.equal(await executeAcceptance(broken.manifestPath, broken.sha256, { env }), 1);
  assert.equal(classifier.state.requests - brokenBefore, 1, "an invalid response stops the first case");
  const brokenEvidence = await readEvidence(broken.runRoot);
  const brokenVerified = brokenEvidence.find(line => line.phase === "verified");
  assert.ok(brokenVerified);
  assert.equal(brokenVerified.verdict, "fail");
  assert.equal(brokenVerified.policy, "not-applicable",
    "an engineering failure never claims policy correctness");
  assert.ok(!brokenEvidence.some(line => line.phase === "completed"));
  assert.equal(brokenEvidence.at(-1)?.reason, "verdict");

  // Worker records are always policy not-applicable, a worker oracle failure
  // still stops at the first case, and worker suites never gain completed.
  const workerRun = await buildRun(t, "laya", classifier.url, [
    { id: "worker-one", kind: "worker-readonly" },
    { id: "worker-two", kind: "worker-readonly" }
  ]);
  assert.equal(await executeAcceptance(workerRun.manifestPath, workerRun.sha256,
    { env: workerEnv(fakeBin, "wrong-output") }), 1);
  const workerEvidence = await readEvidence(workerRun.runRoot);
  const workerVerified = workerEvidence.find(line => line.phase === "verified");
  assert.ok(workerVerified);
  assert.equal(workerVerified.policy, "not-applicable",
    "a worker case has no band to judge and never claims policy");
  assert.deepEqual(workerEvidence.filter(line => line.phase === "reserved").map(line => line.caseId),
    ["worker-one"], "the worker failure still stops at the first case");
  assert.ok(!workerEvidence.some(line => line.phase === "completed"));

  // The journal gate rejects illegal policy/outcome/counter shapes and keeps
  // raw canary fields off disk; a legal completed record round-trips exactly.
  const prepared = await prepareJev(t);
  const run = await claimAcceptance(prepared.manifestPath, prepared.sha256);
  t.after(() => run.handle.close().catch(() => {}));
  await assert.rejects(() => appendEvidence(run, {
    phase: "verified", caseId: "x", verdict: "pass", policy: "maybe", checks: {}
  } as unknown as SafeEvidence), /invalid/);
  await assert.rejects(() => appendEvidence(run, {
    phase: "completed", outcome: "excellent", cases: 12, policyMatches: 12, policyMismatches: 0
  } as unknown as SafeEvidence), /invalid/);
  await assert.rejects(() => appendEvidence(run, {
    phase: "completed", outcome: "pass", cases: 11, policyMatches: 11, policyMismatches: 0
  } as unknown as SafeEvidence), /invalid/);
  await assert.rejects(() => appendEvidence(run, {
    phase: "completed", outcome: "pass", cases: 12, policyMatches: 11, policyMismatches: 0
  } as unknown as SafeEvidence), /invalid/);
  await assert.rejects(() => appendEvidence(run, {
    phase: "completed", outcome: "pass", cases: 12, policyMatches: -1, policyMismatches: 1
  } as unknown as SafeEvidence), /invalid/);
  await assert.rejects(() => appendEvidence(run, {
    phase: "completed", outcome: "policy-mismatch", cases: 12, policyMatches: 12, policyMismatches: 0
  } as unknown as SafeEvidence), /invalid/);
  await assert.rejects(() => appendEvidence(run, {
    phase: "completed", outcome: "pass", cases: 12, policyMatches: 12, policyMismatches: 0,
    canary: "raw-response"
  } as unknown as SafeEvidence), /invalid/);
  await appendEvidence(run, {
    phase: "completed", outcome: "policy-mismatch", cases: 12, policyMatches: 11, policyMismatches: 1
  } as unknown as SafeEvidence);
  const raw = await readFile(run.evidencePath, "utf8");
  assert.ok(!raw.includes("canary"), "raw content never lands on disk");
  assert.deepEqual(JSON.parse(raw.trim().split("\n").at(-1) ?? ""),
    { phase: "completed", outcome: "policy-mismatch", cases: 12, policyMatches: 11, policyMismatches: 1 });
});

// A calibration child that prepares and executes under a stateful read
// redirect: the marker flips the redirected path after the 12th classify, so
// the terminal boundary recheck sees drifted bytes on a full roster.
const CALIBRATION_DRIFT_CHILD = `const fsp = await import("node:fs/promises");
const path = await import("node:path");
const { createHash } = await import("node:crypto");
const mod = await import(process.argv[2]);
const prepared = await mod.prepareAcceptance(process.argv[3]);
const manifest = JSON.parse(await fsp.readFile(prepared.manifestPath, "utf8"));
for (const item of manifest.cases) item.config.backends.laya.url = process.env.TURNHELM_FIXTURE_URL;
const bytes = JSON.stringify(manifest, null, 2) + "\\n";
await fsp.writeFile(prepared.manifestPath, bytes);
const sha256 = createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
const code = await mod.executeAcceptance(prepared.manifestPath, sha256, { env: process.env });
process.stdout.write("DRIFT_RESULT " + JSON.stringify({
  code, runRoot: path.dirname(prepared.manifestPath)
}) + "\\n");
`;

test("RR05 terminal boundary is fail closed", async t => {
  const classifier = await startClassifierFixture(t);
  const fakeBin = await writeFakeCodex(t);
  const env = workerEnv(fakeBin, "ok-readonly");
  const inBand = (target: { scripted: string[] }) => {
    // An aborted sub-run leaves unconsumed answers behind; realign so every
    // sub-run's first case gets the band-correct answer.
    target.scripted.length = 0;
    for (const profile of [1, 2, 3].flatMap(() => ["fast", "balanced", "deep", "frontier"])) {
      target.scripted.push(choiceBody(profile));
    }
  };

  const probeDirectory = await mkdtemp(join(tmpdir(), "turnhelm-terminal-"));
  t.after(() => rm(probeDirectory, { recursive: true, force: true }));
  const probe = await open(join(probeDirectory, "probe"), "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    appendFile: (this: FileHandle, data: Buffer) => Promise<void>;
    sync: (this: FileHandle) => Promise<void>;
    close: (this: FileHandle) => Promise<void>;
  };
  await probe.close();
  const originalAppend = fileHandlePrototype.appendFile;
  const originalSync = fileHandlePrototype.sync;

  // A protocol failure on the second case stops the round there: exactly the
  // two classified cases are spent and no completed fact ever exists.
  inBand(classifier);
  const failingObserved = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      if (data.includes('"phase":"observed"') && data.includes('"caseId":"heading-zh-trial-1"')) {
        throw new Error("injected protocol failure");
      }
      return originalAppend.call(this, data);
    });
  const protocolFailure = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  const protocolFailureCode = await executeAcceptance(protocolFailure.manifestPath, protocolFailure.sha256, { env });
  failingObserved.mock.restore();
  assert.equal(protocolFailureCode, 1);
  assert.equal(classifier.state.requests, 2, "failure lands on the second case, not the last");
  const protocolEvidence = await readEvidence(protocolFailure.runRoot);
  assert.ok(!protocolEvidence.some(line => line.phase === "completed"));
  assert.equal(protocolEvidence.filter(line => line.phase === "verified").length, 1);

  // The completed append succeeds but its sync fails: the completed line may
  // already be visible, yet the run is not complete.
  inBand(classifier);
  let completedAppended = false;
  const appending = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      if (data.includes('"phase":"completed"')) completedAppended = true;
      return originalAppend.call(this, data);
    });
  const failingSync = t.mock.method(fileHandlePrototype, "sync", async function (this: FileHandle) {
    if (completedAppended) throw new Error("injected terminal sync failure");
    return originalSync.call(this);
  });
  const ioFailure = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  const terminalIoFailureCode = await executeAcceptance(ioFailure.manifestPath, ioFailure.sha256, { env });
  appending.mock.restore();
  failingSync.mock.restore();
  assert.equal(terminalIoFailureCode, 1, "a completed line that never synced durably is not a completion");
  const ioEvidence = await readEvidence(ioFailure.runRoot);
  assert.ok(ioEvidence.some(line => line.phase === "completed"), "the completed line may be visible");
  assert.equal(ioEvidence.at(-1)?.phase, "stopped", "the terminal boundary still writes its stop");
  assert.equal(ioEvidence.at(-1)?.reason, "evidence-io");

  // The operator aborts while the completed record is appended: even with the
  // line durable, the post-completed recheck stops the round as a signal.
  inBand(classifier);
  const controller = new AbortController();
  const aborting = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      const result = originalAppend.call(this, data);
      if (data.includes('"phase":"completed"')) controller.abort();
      return result;
    });
  const aborted = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  const terminalAbortCode = await executeAcceptance(aborted.manifestPath, aborted.sha256,
    { env, signal: controller.signal });
  aborting.mock.restore();
  assert.equal(terminalAbortCode, 130);
  const abortEvidence = await readEvidence(aborted.runRoot);
  assert.ok(abortEvidence.some(line => line.phase === "completed"),
    "the completed line may already be visible");
  assert.equal(abortEvidence.at(-1)?.phase, "stopped");
  assert.equal(abortEvidence.at(-1)?.reason, "signal");

  // The completed append itself fails: the eleven durable verified records
  // and the whole completed roster before it still add up to evidence-io, and
  // no completed line ever lands.
  inBand(classifier);
  const failingCompletedAppend = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      if (data.includes('"phase":"completed"')) throw new Error("injected completed append failure");
      return originalAppend.call(this, data);
    });
  const appendFailure = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(appendFailure.manifestPath, appendFailure.sha256, { env }), 1,
    "a completed record that never appended is not a completion");
  failingCompletedAppend.mock.restore();
  const appendFailureEvidence = await readEvidence(appendFailure.runRoot);
  assert.ok(!appendFailureEvidence.some(line => line.phase === "completed"),
    "the completed line never landed");
  assert.equal(appendFailureEvidence.filter(line => line.phase === "verified").length, 12);
  assert.equal(appendFailureEvidence.at(-1)?.reason, "evidence-io");

  // The operator aborts while the twelfth verified record is appended: the
  // post-loop abort check stops the round before any completed fact exists.
  inBand(classifier);
  const verifiedController = new AbortController();
  let verifiedAppends = 0;
  const abortingVerified = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      const result = originalAppend.call(this, data);
      if (data.includes('"phase":"verified"')) {
        verifiedAppends += 1;
        if (verifiedAppends === 12) verifiedController.abort();
      }
      return result;
    });
  const lastVerified = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(lastVerified.manifestPath, lastVerified.sha256,
    { env, signal: verifiedController.signal }), 130,
    "an abort discovered after the last verified case is a signal stop");
  abortingVerified.mock.restore();
  const lastVerifiedEvidence = await readEvidence(lastVerified.runRoot);
  assert.equal(lastVerifiedEvidence.filter(line => line.phase === "verified").length, 12);
  assert.ok(!lastVerifiedEvidence.some(line => line.phase === "completed"),
    "no completed fact is written after the abort");
  assert.equal(lastVerifiedEvidence.at(-1)?.reason, "signal");

  // The evidence FD fails to close after a durable completed record: a close
  // failure is not a completion either. FileHandle attaches close as an own
  // constructor property that prototype accessors cannot intercept, so the
  // instance's close is wrapped from the first append, where the evidence
  // handle is the receiver.
  inBand(classifier);
  let completedWritten = false;
  let closeWrapped = false;
  const tracking = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      const result = originalAppend.call(this, data);
      if (!closeWrapped) {
        closeWrapped = true;
        const descriptor = Object.getOwnPropertyDescriptor(this, "close");
        if (descriptor !== undefined) {
          const originalCloseFn = descriptor.value as () => Promise<void>;
          Object.defineProperty(this, "close", {
            configurable: true,
            writable: true,
            value: async (): Promise<void> => {
              if (completedWritten) throw new Error("injected close failure");
              return originalCloseFn();
            }
          });
        }
      }
      if (data.includes('"phase":"completed"')) completedWritten = true;
      return result;
    });
  const closeFailure = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(closeFailure.manifestPath, closeFailure.sha256, { env }), 1,
    "a failed evidence close is not a completion");
  tracking.mock.restore();
  const closeEvidence = await readEvidence(closeFailure.runRoot);
  assert.equal(closeEvidence.at(-1)?.reason, "evidence-io");

  // Worker suites reach 0 only through the same terminal tail: a failed
  // evidence close is not a pass even without a completed record.
  inBand(classifier);
  let workerCloseWrapped = false;
  const workerTracking = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      const result = originalAppend.call(this, data);
      if (!workerCloseWrapped) {
        workerCloseWrapped = true;
        const descriptor = Object.getOwnPropertyDescriptor(this, "close");
        if (descriptor !== undefined) {
          Object.defineProperty(this, "close", {
            configurable: true,
            writable: true,
            value: async (): Promise<void> => { throw new Error("injected worker close failure"); }
          });
        }
      }
      return result;
    });
  const workerClose = await buildRun(t, "laya", classifier.url, [{ id: "close-gate", kind: "worker-readonly" }]);
  assert.equal(await executeAcceptance(workerClose.manifestPath, workerClose.sha256, { env }), 1,
    "a worker run whose evidence close fails is not a pass");
  workerTracking.mock.restore();
  const workerCloseEvidence = await readEvidence(workerClose.runRoot);
  assert.equal(workerCloseEvidence.at(-1)?.reason, "evidence-io");
  assert.ok(!workerCloseEvidence.some(line => line.phase === "completed"));

  // An abort discovered after the worker close is carried by the exit code
  // alone: the FD is closed, no stop record can be appended.
  const workerController = new AbortController();
  let abortCloseWrapped = false;
  const abortTracking = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      const result = originalAppend.call(this, data);
      if (!abortCloseWrapped) {
        abortCloseWrapped = true;
        const descriptor = Object.getOwnPropertyDescriptor(this, "close");
        if (descriptor !== undefined) {
          const originalCloseFn = descriptor.value as () => Promise<void>;
          Object.defineProperty(this, "close", {
            configurable: true,
            writable: true,
            value: async (): Promise<void> => { await originalCloseFn(); workerController.abort(); }
          });
        }
      }
      return result;
    });
  const workerAborted = await buildRun(t, "laya", classifier.url, [{ id: "abort-gate", kind: "worker-readonly" }]);
  assert.equal(await executeAcceptance(workerAborted.manifestPath, workerAborted.sha256,
    { env, signal: workerController.signal }), 130,
    "an operator abort landing at the closed FD still sets the signal exit code");
  abortTracking.mock.restore();
  const workerAbortEvidence = await readEvidence(workerAborted.runRoot);
  assert.ok(!workerAbortEvidence.some(line => line.phase === "stopped"),
    "after the close no stop record can be appended");

  // The same closed-FD abort boundary holds for calibration: the exit code
  // alone carries the operator's signal after the close, stop-less, even with
  // the completed record already durable.
  inBand(classifier);
  const calibController = new AbortController();
  let calibCloseWrapped = false;
  const calibAbortTracking = t.mock.method(fileHandlePrototype, "appendFile",
    async function (this: FileHandle, data: Buffer) {
      const result = originalAppend.call(this, data);
      if (!calibCloseWrapped) {
        calibCloseWrapped = true;
        const descriptor = Object.getOwnPropertyDescriptor(this, "close");
        if (descriptor !== undefined) {
          const originalCloseFn = descriptor.value as () => Promise<void>;
          Object.defineProperty(this, "close", {
            configurable: true,
            writable: true,
            value: async (): Promise<void> => { await originalCloseFn(); calibController.abort(); }
          });
        }
      }
      return result;
    });
  const calibAborted = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await executeAcceptance(calibAborted.manifestPath, calibAborted.sha256,
    { env, signal: calibController.signal }), 130,
    "an operator abort landing at the closed FD still sets the signal exit code");
  calibAbortTracking.mock.restore();
  const calibAbortEvidence = await readEvidence(calibAborted.runRoot);
  assert.equal(calibAbortEvidence.at(-1)?.phase, "completed");
  assert.ok(!calibAbortEvidence.some(line => line.phase === "stopped"),
    "after the close no stop record can be appended");

  // Late host-config and frozen-corpus drift, flipped on the 12th classify, are
  // caught by the terminal recheck: no completed fact, a drift stop, exit 1.
  let driftRuns = 0;
  const driftChild = async (path: string, before: string, after: string,
    flipAt: "request-12" | "completed" = "request-12"): Promise<{
    code: number; runRoot: string; requests: number;
  }> => {
    driftRuns += 1;
    const markerFile = join(probeDirectory, `marker-${driftRuns}`);
    const requests = { count: 0 };
    const driftClassifier = await startClassifierFixture(t, count => {
      requests.count = count;
      if (flipAt === "request-12" && count === 12) writeFileSync(markerFile, "flip");
    });
    inBand(driftClassifier);
    const directory = await mkdtemp(join(tmpdir(), "turnhelm-driftchild-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const preload = join(directory, "redirect.cjs");
    const childScript = join(directory, "drift-child.mjs");
    await writeFile(preload, REDIRECT_PRELOAD);
    await writeFile(childScript, CALIBRATION_DRIFT_CHILD);
    const harness = pathToFileURL(fileURLToPath(new URL("./live-acceptance.js", import.meta.url))).href;
    const run = await execute(process.execPath,
      ["--require", preload, childScript, harness, "calibration-dev"],
      {
        encoding: "utf8", timeout: 120000,
        env: {
          ...process.env,
          TURNHELM_TEST_REDIRECTS: JSON.stringify({
            read: { [path]: { watch: markerFile, marker: "flip", before, after } }
          }),
          TURNHELM_FIXTURE_URL: driftClassifier.url,
          ...(flipAt === "completed" ? { TURNHELM_TEST_FLIP_ON_COMPLETED: markerFile } : {})
        }
      });
    const line = String(run.stdout).split("\n").find(candidate => candidate.startsWith("DRIFT_RESULT "));
    assert.ok(line, "the drift child must report: " + String(run.stderr ?? ""));
    const result = JSON.parse(line.slice("DRIFT_RESULT ".length)) as { code: number; runRoot: string };
    t.after(() => rm(result.runRoot, { recursive: true, force: true }));
    return { ...result, requests: requests.count };
  };

  const hostA = join(probeDirectory, "host-a.json");
  const hostB = join(probeDirectory, "host-b.json");
  await writeFile(hostA, "{\"version\":1}\n");
  await writeFile(hostB, "{\"version\":2}\n");
  const hostDrift = await driftChild(HOST_PATH, hostA, hostB);
  assert.equal(hostDrift.code, 1, "a host config that changed after the last verified case is not a completion");
  assert.equal(hostDrift.requests, 12, "the flip lands only after the final classify");
  const hostEvidence = await readEvidence(hostDrift.runRoot);
  assert.equal(hostEvidence.filter(line => line.phase === "verified").length, 12);
  assert.ok(!hostEvidence.some(line => line.phase === "completed"),
    "drift before the commit point suppresses completed");
  assert.equal(hostEvidence.at(-1)?.reason, "drift");

  const corpusBefore = join(probeDirectory, "corpus-before.json");
  const corpusAfter = join(probeDirectory, "corpus-after.json");
  const corpusText = await readFile(CORPUS_PATH, "utf8");
  await writeFile(corpusBefore, corpusText);
  await writeFile(corpusAfter, corpusText + "\n");
  const corpusDrift = await driftChild(CORPUS_PATH, corpusBefore, corpusAfter);
  assert.equal(corpusDrift.code, 1, "frozen corpus bytes drifting after approval is not a completion");
  assert.ok(!(await readEvidence(corpusDrift.runRoot)).some(line => line.phase === "completed"));

  // Source and dist entries share the same frozen compare loop; a drifted
  // source file after the last verified case is equally not a completion.
  const sourcePath = join(REPO_ROOT, "src", "systemone.ts");
  const sourceText = await readFile(sourcePath, "utf8");
  const sourceBefore = join(probeDirectory, "source-before.ts");
  const sourceAfter = join(probeDirectory, "source-after.ts");
  await writeFile(sourceBefore, sourceText);
  await writeFile(sourceAfter, sourceText + "\n");
  const sourceDrift = await driftChild(sourcePath, sourceBefore, sourceAfter);
  assert.equal(sourceDrift.code, 1, "a drifted source file is not a completion");
  assert.ok(!(await readEvidence(sourceDrift.runRoot)).some(line => line.phase === "completed"));
  assert.equal((await readEvidence(sourceDrift.runRoot)).at(-1)?.reason, "drift");

  // A drift that lands only while the completed record is appended is caught
  // by the second terminal recheck: the completed line may already be visible,
  // yet the round is a drift stop, exit 1 — never 0 or 3.
  const postCompletedDrift = await driftChild(HOST_PATH, hostA, hostB, "completed");
  assert.equal(postCompletedDrift.code, 1,
    "a host config that drifts at the completed append is not a completion");
  assert.equal(postCompletedDrift.requests, 12);
  const postCompletedEvidence = await readEvidence(postCompletedDrift.runRoot);
  assert.equal(postCompletedEvidence.filter(line => line.phase === "verified").length, 12);
  assert.ok(postCompletedEvidence.some(line => line.phase === "completed"),
    "the completed line may already be visible");
  assert.equal(postCompletedEvidence.at(-1)?.reason, "drift");

  // The real entry maps the two-dimensional outcomes onto exit codes; only
  // completed plus its matching exit code reads as finished.
  const runEntryCode = (args: readonly string[]): Promise<number | null> =>
    new Promise(resolve => {
      execFile(process.execPath, [ENTRY_PATH, ...args],
        { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
        error => {
          const code = error !== null && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error === null ? 0 : null;
          resolve(code);
        });
    });

  inBand(classifier);
  const entryPass = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await runEntryCode(["--execute", entryPass.manifestPath, "--approve", entryPass.sha256]), 0);
  const passEvidence = await readEvidence(entryPass.runRoot);
  assert.equal(passEvidence.at(-1)?.phase, "completed");
  assert.equal(passEvidence.at(-1)?.outcome, "pass");
  assert.ok(!passEvidence.some(line => line.phase === "stopped"));

  classifier.scripted.push(
    choiceBody("deep"),
    choiceBody("balanced"), choiceBody("deep"), choiceBody("frontier"),
    ...[2, 3].flatMap(() => [choiceBody("fast"), choiceBody("balanced"), choiceBody("deep"), choiceBody("frontier")])
  );
  const entryMismatch = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await runEntryCode(["--execute", entryMismatch.manifestPath, "--approve", entryMismatch.sha256]), 3,
    "a complete policy-mismatch roster exits 3 through the real entry");
  assert.equal((await readEvidence(entryMismatch.runRoot)).at(-1)?.outcome, "policy-mismatch");

  classifier.scripted.push(JSON.stringify({
    answers: { route: { type: "choice", choice: "turbo", confidence: 0.9 } },
    usage: { truncated: false, state_tokens_dropped: 0 }
  }));
  const entryFailure = await buildCalibrationRun(t, "calibration-dev", classifier.url);
  assert.equal(await runEntryCode(["--execute", entryFailure.manifestPath, "--approve", entryFailure.sha256]), 1);

  const signalEntry = async (signal: "SIGINT" | "SIGTERM"): Promise<number | null> => {
    // Kill only once the fixture has actually received the first classify
    // request (whose scripted answer hangs): the signal then lands mid-wait
    // deterministically, not after a guessed delay. The readiness wait races
    // child exit and a deadline so an early-exited or wedged child fails the
    // assertions promptly instead of parking the test forever.
    let requestLanded: () => void = () => {};
    const classified = new Promise<void>(resolve => { requestLanded = resolve; });
    const hangClassifier = await startClassifierFixture(t, count => {
      if (count === 1) requestLanded();
    });
    hangClassifier.scripted.push("hang");
    const run = await buildCalibrationRun(t, "calibration-dev", hangClassifier.url);
    const child = spawn(process.execPath,
      [ENTRY_PATH, "--execute", run.manifestPath, "--approve", run.sha256],
      { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe"] });
    t.after(() => { child.kill("SIGKILL"); });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    const stall = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("signal entry child neither classified nor exited within 30s")), 30_000);
      timer.unref();
    });
    await Promise.race([
      classified,
      exited.then(code => {
        throw new Error("signal entry child exited before the first classify request (code " + code + ")");
      }),
      stall
    ]);
    child.kill(signal);
    return await exited;
  };
  assert.equal(await signalEntry("SIGINT"), 130, "SIGINT maps to 130 through the real entry");
  assert.equal(await signalEntry("SIGTERM"), 143, "SIGTERM maps to 143 through the real entry");
});

