// Test-only live acceptance harness: frozen corpus, a one-shot manifest claim,
// and an append-only evidence journal. Task 2 provides prepare/claim/append;
// executeAcceptance (Task 3) consumes them from the live entry point.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, mkdtemp, open as openFile, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomInt } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseProjectConfig, PROFILE_IDS, type ProfileId, type ProjectConfig } from "../src/config.js";
import { FAILURE_PHRASINGS, type FailureClass } from "../src/codex-events.js";
import { initProject } from "../src/init.js";
import { envelopePayload } from "../src/payload.js";
import { readProjectFile } from "../src/project.js";
import { routeTask } from "../src/route.js";
import { eligibleBackends } from "../src/systemone.js";
import { validateTask } from "../src/task.js";

export type LiveSuite = "laya" | "jev" | "dual" | "calibration-dev" | "calibration-holdout";

export type AcceptanceCaseKind = "worker-readonly" | "worker-write" | "classifier-only";

export type AcceptanceBackend = "laya" | "jev";

export type AcceptanceOracle =
  | Readonly<{ kind: "stdout-json"; expected: Readonly<{ count: number; sum: number }> }>
  | Readonly<{ kind: "summary-file"; expected: Readonly<{ count: number; sum: number }> }>
  | Readonly<{ kind: "classifier-band"; pairId: string; language: "en" | "zh"; split: "dev" | "holdout"; trial: 1 | 2 | 3; allowedProfiles: readonly ProfileId[] }>;

export type AcceptanceCase = Readonly<{
  id: string;
  kind: AcceptanceCaseKind;
  root: string;
  identity: Readonly<{ dev: number; ino: number }>;
  task: string;
  taskHash: string;
  taskBytes: number;
  config: ProjectConfig;
  inputHashes: Readonly<Record<string, string>>;
  allowedChanges: readonly string[];
  oracle: AcceptanceOracle;
  reservation: Readonly<{ worker: number; backends: readonly AcceptanceBackend[] }>;
}>;

export type AcceptanceManifest = Readonly<{
  version: 2;
  suite: LiveSuite;
  baseline: Readonly<{
    head: string;
    source: readonly Readonly<{ path: string; sha256: string }>[];
    dist: readonly Readonly<{ path: string; sha256: string }>[];
    corpus: string;
    tools: Readonly<{ node: string; execPath: string; git: string; gitPath: string }>;
  }>;
  runRoot: Readonly<{ canonical: string; dev: number; ino: number }>;
  hostSnapshot: Readonly<{ exists: boolean; sha256: string | null }>;
  caps: Readonly<{ worker: number; laya: number; jev: number }>;
  cases: readonly AcceptanceCase[];
}>;

export type StoppedReason =
  | "drift" | "output-limit" | "evidence-io" | "signal" | "timeout"
  | "worker-failure" | "verdict" | "cleanup-unverified" | "unknown";

export type OracleInputEvidence =
  Readonly<{ source: "stdout" | "summary-file"; text: string | null; bytes: number | null }>;

export type WorkerUsageEvidence =
  Readonly<Partial<Record<"input_tokens" | "output_tokens" | "cached_input_tokens" | "reasoning_output_tokens", number>>>
  | "unreported";

// The bounded failure projection: class and the action boolean only, plus the
// optional correlation hash and observed death signal. No failure text.
export type WorkerFailureEvidence = Readonly<{
  class: FailureClass;
  errorSha256?: string;
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  ownedShutdown: boolean;
}>;

// The parent-observed decoded-event projection: the count of successfully
// decoded events and, when at least one decoded, the rounded age from the last
// decode to settlement. An observation, never a liveness or stall claim.
export type WorkerProgressEvidence = Readonly<{ events: number; lastEventAgeMs?: number }>;

// Bounded transport-policy evidence (spec §7): application policy replayed
// from the CLI's routing attempts, never a networking or exit attestation.
export type AttemptTransportEvidence =
  | readonly Readonly<{ backend: "laya" | "jev"; transportMode: "direct" | "http-connect" }>[]
  | "unverified";

export type SafeEvidence =
  | Readonly<{ phase: "prepared"; suite: LiveSuite; manifestSha256: string; startedAt: string }>
  | Readonly<{ phase: "reserved"; caseId: string; worker: number; backends: readonly AcceptanceBackend[] }>
  | Readonly<{ phase: "observed"; caseId: string; backend: AcceptanceBackend | "invalid"; profileId: string; rootMatches: boolean | "unknown"; exitCode: number | null; durationMs: number; attempts: number; attemptTransports?: AttemptTransportEvidence; workerUsage?: WorkerUsageEvidence; workerFailure?: WorkerFailureEvidence; workerProgress?: WorkerProgressEvidence }>
  | Readonly<{ phase: "verified"; caseId: string; verdict: "pass" | "fail"; policy: "match" | "mismatch" | "not-applicable"; checks: Readonly<Record<string, boolean>>; oracleInput?: OracleInputEvidence }>
  | Readonly<{ phase: "completed"; outcome: "pass" | "policy-mismatch"; cases: number; policyMatches: number; policyMismatches: number }>
  | Readonly<{ phase: "completed"; outcome: "pass" | "fail"; cases: number; failed: number }>
  | Readonly<{ phase: "stopped"; caseId: string | null; reason: StoppedReason }>;

export type ClaimedRun = Readonly<{
  manifest: AcceptanceManifest;
  manifestPath: string;
  manifestSha256: string;
  evidencePath: string;
  handle: FileHandle;
}>;

const execute = promisify(execFile);
const sha256hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const canonicalConfigBytes = (config: ProjectConfig): Buffer => Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8");

// tsc copies no JSON into dist; both paths resolve from dist/test back to the repo.
const CORPUS_PATH = fileURLToPath(new URL("../../test/fixtures/live-acceptance.json", import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL("../../assets/config.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_TASK_BYTES = 8192;
const MAX_MANIFEST_BYTES = 1 << 20;

// Fixed per-suite reservation ceilings (AH-05): an approved manifest may
// reserve less than the frozen suite, never more.
const SUITE_CAPS: Readonly<Record<LiveSuite, Readonly<{ worker: number; laya: number; jev: number }>>> = {
  laya: { worker: 7, laya: 7, jev: 0 },
  jev: { worker: 1, laya: 0, jev: 1 },
  dual: { worker: 2, laya: 2, jev: 2 },
  "calibration-dev": { worker: 0, laya: 12, jev: 0 },
  "calibration-holdout": { worker: 0, laya: 12, jev: 0 }
};

// The per-case frozen file set: the worker input plus the consumer
// instruction files initProject installs (the config is frozen separately by
// its canonical bytes). The instructions steer the worker as much as the
// input does, so drifting them after approval is the same attack.
const WORKER_FROZEN_FILES = ["AGENTS.md", ".agents/skills/turnhelm-routing/SKILL.md",
  ".agents/skills/turnhelm-routing/agents/openai.yaml", "input.json"] as const;

const frozenFileHashes = async (root: string): Promise<Record<string, string>> => {
  const hashes: Record<string, string> = {};
  for (const file of WORKER_FROZEN_FILES) hashes[file] = sha256hex(await readFile(join(root, file)));
  return hashes;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

const fail = (what: string): Error => new Error("acceptance manifest is invalid: " + what);
const expectKeys = (value: Record<string, unknown>, keys: readonly string[], what: string): void => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw fail(what + " must not contain unknown field " + JSON.stringify(key));
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw fail(what + " must contain own field " + JSON.stringify(key));
  }
};
const expectString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length === 0) throw fail(what + " must be a nonempty string");
  return value;
};
const expectCount = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw fail(what + " must be a nonnegative integer");
  return value;
};

// A claimed manifest's parsed graph is frozen in memory: nothing downstream
// of the claim can mutate caps, cases, reservations, or oracle facts.
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const parseManifest = (value: unknown): AcceptanceManifest => {
  if (!isRecord(value)) throw fail("manifest must be an object");
  expectKeys(value, ["version", "suite", "baseline", "runRoot", "hostSnapshot", "caps", "cases"], "manifest");
  if (value.version !== 2) throw fail("manifest version must be 2");
  if (value.suite !== "laya" && value.suite !== "jev" && value.suite !== "dual"
    && value.suite !== "calibration-dev" && value.suite !== "calibration-holdout") {
    throw fail("manifest suite is unknown");
  }
  const suite: LiveSuite = value.suite;
  // Calibration suites are classifier-only; worker suites never accept a
  // classifier-only case — the kinds cannot mix within one frozen suite.
  const isCalibration = suite === "calibration-dev" || suite === "calibration-holdout";

  if (!isRecord(value.baseline)) throw fail("baseline must be an object");
  const baseline = value.baseline;
  expectKeys(baseline, ["head", "source", "dist", "corpus", "tools"], "baseline");
  if (!isHex(baseline.head, 40)) throw fail("baseline head must be a commit hash");
  const parseScope = (scope: unknown, what: string) => {
    if (!Array.isArray(scope) || scope.length === 0) throw fail("baseline " + what + " must be a nonempty array");
    return scope.map(entry => {
      if (!isRecord(entry)) throw fail("baseline " + what + " entry must be an object");
      expectKeys(entry, ["path", "sha256"], "baseline " + what + " entry");
      const path = expectString(entry.path, "baseline " + what + " path");
      if (path.startsWith("/") || path.split("/").includes("..")) throw fail("baseline " + what + " path must be relative to the repository");
      if (!isHex(entry.sha256, 64)) throw fail("baseline " + what + " sha256 is malformed");
      return { path, sha256: entry.sha256 as string };
    });
  };
  const source = parseScope(baseline.source, "source");
  const dist = parseScope(baseline.dist, "dist");
  if (!isHex(baseline.corpus, 64)) throw fail("baseline corpus hash is malformed");
  if (!isRecord(baseline.tools)) throw fail("baseline tools must be an object");
  const tools = baseline.tools;
  expectKeys(tools, ["node", "execPath", "git", "gitPath"], "baseline tools");
  for (const key of ["node", "execPath", "git", "gitPath"] as const) {
    if (typeof tools[key] !== "string") throw fail("baseline tools " + key + " must be a string");
  }

  if (!isRecord(value.runRoot)) throw fail("runRoot must be an object");
  const runRoot = value.runRoot;
  expectKeys(runRoot, ["canonical", "dev", "ino"], "runRoot");
  if (typeof runRoot.canonical !== "string" || !isAbsolute(runRoot.canonical)) throw fail("runRoot canonical must be an absolute path");
  const runDev = expectCount(runRoot.dev, "runRoot dev");
  const runIno = expectCount(runRoot.ino, "runRoot ino");

  if (!isRecord(value.hostSnapshot)) throw fail("hostSnapshot must be an object");
  const hostSnapshot = value.hostSnapshot;
  expectKeys(hostSnapshot, ["exists", "sha256"], "hostSnapshot");
  if (typeof hostSnapshot.exists !== "boolean") throw fail("hostSnapshot exists must be a boolean");
  if (hostSnapshot.sha256 !== null && !isHex(hostSnapshot.sha256, 64)) throw fail("hostSnapshot sha256 is malformed");
  const hostSha256: string | null = hostSnapshot.sha256;

  if (!isRecord(value.caps)) throw fail("caps must be an object");
  const capsRaw = value.caps;
  expectKeys(capsRaw, ["worker", "laya", "jev"], "caps");
  const caps = {
    worker: expectCount(capsRaw.worker, "caps worker"),
    laya: expectCount(capsRaw.laya, "caps laya"),
    jev: expectCount(capsRaw.jev, "caps jev")
  };

  if (!Array.isArray(value.cases) || value.cases.length === 0) throw fail("cases must be a nonempty array");
  const seen = new Set<string>();
  const cases = value.cases.map(raw => {
    if (!isRecord(raw)) throw fail("case must be an object");
    expectKeys(raw, ["allowedChanges", "config", "id", "identity", "inputHashes", "kind", "oracle", "reservation", "root", "task", "taskBytes", "taskHash"], "case");
    const id = expectString(raw.id, "case id");
    if (seen.has(id)) throw fail("case id " + JSON.stringify(id) + " is duplicated");
    seen.add(id);
    if (raw.kind !== "worker-readonly" && raw.kind !== "worker-write" && raw.kind !== "classifier-only") throw fail("case kind is unknown");
    const kind: AcceptanceCaseKind = raw.kind;
    // Calibration suites freeze classifier-only cases; worker suites freeze
    // worker cases. The kinds never mix within one suite (spec §4.2).
    if (isCalibration && kind !== "classifier-only") throw fail("calibration suites must not carry worker cases");
    if (!isCalibration && kind === "classifier-only") throw fail("worker suites must not carry classifier-only cases");
    const config = parseProjectConfig(raw.config);

    if (typeof raw.root !== "string") throw fail("case root must be a string");
    const root = raw.root;
    if (!isRecord(raw.identity)) throw fail("case identity must be an object");
    expectKeys(raw.identity, ["dev", "ino"], "case identity");
    const identity = { dev: expectCount(raw.identity.dev, "case identity dev"), ino: expectCount(raw.identity.ino, "case identity ino") };
    if (kind === "classifier-only") {
      if (root !== "") throw fail("classifier-only case must not claim a consumer root");
      if (identity.dev !== 0 || identity.ino !== 0) throw fail("classifier-only case must not claim an identity");
    } else if (!isAbsolute(root)) {
      throw fail("case root must be absolute for worker cases");
    } else if (!root.startsWith(runRoot.canonical + "/consumers/")) {
      throw fail("case root must live under the frozen run root consumers directory");
    }

    if (typeof raw.task !== "string") throw fail("case task must be a string");
    const task = raw.task;
    const taskBytes = Buffer.byteLength(task, "utf8");
    if (raw.taskBytes !== taskBytes) throw fail("case taskBytes must match the task text");
    if (taskBytes > MAX_TASK_BYTES) throw fail("case task exceeds the transport bound");
    if (!isHex(raw.taskHash, 64)) throw fail("case taskHash is malformed");
    if (raw.taskHash !== sha256hex(Buffer.from(task, "utf8"))) throw fail("case taskHash must match the task text");
    const taskHash: string = raw.taskHash;

    if (!isRecord(raw.inputHashes)) throw fail("case inputHashes must be an object");
    const inputHashes: Record<string, string> = {};
    if (kind === "classifier-only") {
      if (Object.keys(raw.inputHashes).length !== 0) throw fail("classifier-only case must not hash inputs");
    } else {
      const keys = Object.keys(raw.inputHashes);
      if (keys.length !== WORKER_FROZEN_FILES.length || !WORKER_FROZEN_FILES.every(file => keys.includes(file))) {
        throw fail("worker case inputHashes must cover exactly the frozen case files");
      }
      for (const file of WORKER_FROZEN_FILES) {
        if (!isHex(raw.inputHashes[file], 64)) throw fail("worker case " + file + " hash is malformed");
        inputHashes[file] = raw.inputHashes[file] as string;
      }
    }

    if (!Array.isArray(raw.allowedChanges)) throw fail("case allowedChanges must be an array");
    const wanted = kind === "worker-write" ? ["out/summary.json"] : [];
    if (raw.allowedChanges.length !== wanted.length || !raw.allowedChanges.every((entry, index) => entry === wanted[index])) {
      throw fail("case allowedChanges must equal the frozen write scope");
    }

    if (!isRecord(raw.oracle)) throw fail("case oracle must be an object");
    let oracle: AcceptanceOracle;
    if (kind === "classifier-only") {
      expectKeys(raw.oracle, ["kind", "pairId", "language", "split", "trial", "allowedProfiles"], "case oracle");
      if (raw.oracle.kind !== "classifier-band") throw fail("classifier-only case oracle must be classifier-band");
      const pairId = expectString(raw.oracle.pairId, "case oracle pairId");
      if (raw.oracle.language !== "en" && raw.oracle.language !== "zh") throw fail("case oracle language must be en or zh");
      if (raw.oracle.split !== "dev" && raw.oracle.split !== "holdout") throw fail("case oracle split must be dev or holdout");
      if (raw.oracle.split !== (suite === "calibration-dev" ? "dev" : "holdout")) throw fail("case oracle split must match the suite");
      if (raw.oracle.trial !== 1 && raw.oracle.trial !== 2 && raw.oracle.trial !== 3) throw fail("case oracle trial must be 1, 2, or 3");
      if (!Array.isArray(raw.oracle.allowedProfiles) || raw.oracle.allowedProfiles.length === 0) {
        throw fail("case oracle allowedProfiles must be a nonempty array");
      }
      const allowedProfiles: ProfileId[] = [];
      for (const profile of raw.oracle.allowedProfiles) {
        if (typeof profile !== "string" || !PROFILE_IDS.includes(profile as ProfileId)) throw fail("case oracle allowed profile is unknown");
        if (allowedProfiles.includes(profile as ProfileId)) throw fail("case oracle allowedProfiles must be unique");
        allowedProfiles.push(profile as ProfileId);
      }
      oracle = { kind: "classifier-band", pairId, language: raw.oracle.language, split: raw.oracle.split, trial: raw.oracle.trial, allowedProfiles };
    } else {
      expectKeys(raw.oracle, ["kind", "expected"], "case oracle");
      const wantedKind = kind === "worker-write" ? "summary-file" : "stdout-json";
      if (raw.oracle.kind !== wantedKind) throw fail("worker case oracle kind must be " + wantedKind);
      if (!isRecord(raw.oracle.expected)) throw fail("case oracle expected must be an object");
      expectKeys(raw.oracle.expected, ["count", "sum"], "case oracle expected");
      oracle = {
        kind: wantedKind,
        expected: {
          count: expectCount(raw.oracle.expected.count, "oracle expected count"),
          sum: expectCount(raw.oracle.expected.sum, "oracle expected sum")
        }
      };
    }

    if (!isRecord(raw.reservation)) throw fail("case reservation must be an object");
    expectKeys(raw.reservation, ["worker", "backends"], "case reservation");
    const reservedWorker = expectCount(raw.reservation.worker, "case reservation worker");
    if (reservedWorker !== (kind === "classifier-only" ? 0 : 1)) throw fail("case reservation worker must match the case kind");
    if (!Array.isArray(raw.reservation.backends) || raw.reservation.backends.length === 0) throw fail("case reservation backends must be a nonempty array");
    const backends: AcceptanceBackend[] = [];
    for (const backend of raw.reservation.backends) {
      if (backend !== "laya" && backend !== "jev") throw fail("case reservation backend is unknown");
      if (backends.includes(backend)) throw fail("case reservation backends must be unique");
      if (backend === "laya" && !config.backends.laya.enabled) throw fail("case reservation claims an ineligible laya backend");
      if (backend === "jev" && !config.backends.jev.enabled) throw fail("case reservation claims an ineligible jev backend");
      backends.push(backend);
    }
    // The reservation is the approved spend scope, so the config may not
    // enable a backend the reservation does not declare — otherwise a crafted
    // manifest could pass caps on a narrow declaration and still route the
    // suite-wide set at execution time.
    if (config.backends.laya.enabled && !backends.includes("laya")) throw fail("case reservation must cover the enabled laya backend");
    if (config.backends.jev.enabled && !backends.includes("jev")) throw fail("case reservation must cover the enabled jev backend");

    return { id, kind, root, identity, task, taskHash, taskBytes, config, inputHashes, allowedChanges: wanted, oracle, reservation: { worker: reservedWorker, backends } };
  });

  if (caps.worker !== cases.reduce((total, item) => total + item.reservation.worker, 0)
    || caps.laya !== cases.filter(item => item.reservation.backends.includes("laya")).length
    || caps.jev !== cases.filter(item => item.reservation.backends.includes("jev")).length) {
    throw fail("caps must match the case reservations");
  }
  const suiteCaps = SUITE_CAPS[suite];
  if (caps.worker > suiteCaps.worker || caps.laya > suiteCaps.laya || caps.jev > suiteCaps.jev) {
    throw fail("caps must not exceed the frozen suite caps");
  }

  return deepFreeze({
    version: 2,
    suite,
    baseline: {
      head: baseline.head as string,
      source,
      dist,
      corpus: baseline.corpus as string,
      tools: { ...tools } as AcceptanceManifest["baseline"]["tools"]
    },
    runRoot: { canonical: runRoot.canonical, dev: runDev, ino: runIno },
    hostSnapshot: { exists: hostSnapshot.exists, sha256: hostSha256 },
    caps,
    cases
  }) as AcceptanceManifest;
};

// Manifest read for the claim: O_NOFOLLOW guards only the final component so a
// directory alias resolves to the same dev/ino, unlike readProjectFile which
// refuses every symlink component.
const readManifestBytes = async (manifestPath: string): Promise<Buffer> => {
  const descriptor = await openFile(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await descriptor.stat();
    if (!info.isFile()) throw new Error("acceptance manifest is not a regular file");
    if (info.size > MAX_MANIFEST_BYTES) throw new Error("acceptance manifest exceeds " + MAX_MANIFEST_BYTES + " bytes");
    return await descriptor.readFile();
  } finally {
    await descriptor.close();
  }
};

type CalibrationTask = Readonly<{
  id: string;
  pairId: string;
  language: "en" | "zh";
  split: "dev" | "holdout";
  task: string;
  allowedProfiles: readonly ProfileId[];
}>;

type FrozenCorpus = Readonly<{
  version: 2;
  calibrationTasks: readonly CalibrationTask[];
  workerReadonlyTask: string;
  workerWriteTask: string;
  workerFixtureInput: Readonly<{ values: readonly number[] }>;
}>;

// The corpus is validated against the frozen §4.2 shape before anything is
// prepared or claimed: eight calibration tasks as four en/zh pairs (two per
// split, one language each, one shared band per pair), unique ids, transport
// legal tasks, and safe-integer worker fixture values.
const corpusFail = (what: string): Error => new Error("acceptance corpus is invalid: " + what);
const parseCorpus = (value: unknown): FrozenCorpus => {
  if (!isRecord(value)) throw corpusFail("corpus must be an object");
  const corpusKeys = ["version", "calibrationTasks", "workerReadonlyTask", "workerWriteTask", "workerFixtureInput"];
  for (const key of Object.keys(value)) {
    if (!corpusKeys.includes(key)) throw corpusFail("corpus must not contain unknown field " + JSON.stringify(key));
  }
  for (const key of corpusKeys) {
    if (!Object.hasOwn(value, key)) throw corpusFail("corpus must contain own field " + JSON.stringify(key));
  }
  if (value.version !== 2) throw corpusFail("corpus version must be 2");
  if (typeof value.workerReadonlyTask !== "string" || value.workerReadonlyTask.length === 0) {
    throw corpusFail("workerReadonlyTask must be a nonempty string");
  }
  if (typeof value.workerWriteTask !== "string" || value.workerWriteTask.length === 0) {
    throw corpusFail("workerWriteTask must be a nonempty string");
  }
  validateTask(value.workerReadonlyTask);
  validateTask(value.workerWriteTask);
  if (!isRecord(value.workerFixtureInput) || !Array.isArray(value.workerFixtureInput.values)) {
    throw corpusFail("workerFixtureInput values must be an array");
  }
  let fixtureSum = 0;
  for (const entry of value.workerFixtureInput.values) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
      throw corpusFail("workerFixtureInput values must be safe integers");
    }
    fixtureSum += entry;
    if (!Number.isSafeInteger(fixtureSum)) throw corpusFail("workerFixtureInput values must sum to a safe integer");
  }
  if (!Array.isArray(value.calibrationTasks)) throw corpusFail("calibrationTasks must be an array");
  const tasks = value.calibrationTasks.map(raw => {
    if (!isRecord(raw)) throw corpusFail("calibration task must be an object");
    const taskKeys = ["id", "pairId", "language", "split", "task", "allowedProfiles"];
    for (const key of Object.keys(raw)) {
      if (!taskKeys.includes(key)) throw corpusFail("calibration task must not contain unknown field " + JSON.stringify(key));
    }
    for (const key of taskKeys) {
      if (!Object.hasOwn(raw, key)) throw corpusFail("calibration task must contain own field " + JSON.stringify(key));
    }
    for (const key of ["id", "pairId", "task"] as const) {
      if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
        throw corpusFail("calibration task " + key + " must be a nonempty string");
      }
    }
    const id = raw.id as string;
    const pairId = raw.pairId as string;
    const task = raw.task as string;
    if (raw.language !== "en" && raw.language !== "zh") throw corpusFail("calibration task language must be en or zh");
    if (raw.split !== "dev" && raw.split !== "holdout") throw corpusFail("calibration task split must be dev or holdout");
    if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) throw corpusFail("calibration task exceeds the transport bound");
    validateTask(task);
    if (!Array.isArray(raw.allowedProfiles) || raw.allowedProfiles.length === 0) {
      throw corpusFail("calibration task allowedProfiles must be a nonempty array");
    }
    const allowedProfiles: ProfileId[] = [];
    for (const profile of raw.allowedProfiles) {
      if (typeof profile !== "string" || !PROFILE_IDS.includes(profile as ProfileId)) {
        throw corpusFail("calibration task allowed profile is unknown");
      }
      if (allowedProfiles.includes(profile as ProfileId)) throw corpusFail("calibration task allowedProfiles must be unique");
      allowedProfiles.push(profile as ProfileId);
    }
    return {
      id, pairId, language: raw.language, split: raw.split, task, allowedProfiles
    } satisfies CalibrationTask;
  });
  if (tasks.length !== 8) throw corpusFail("calibrationTasks must freeze exactly eight tasks");
  const seenIds = new Set<string>();
  for (const task of tasks) {
    if (seenIds.has(task.id)) throw corpusFail("calibration task id " + JSON.stringify(task.id) + " is duplicated");
    seenIds.add(task.id);
  }
  for (const split of ["dev", "holdout"] as const) {
    const ofSplit = tasks.filter(task => task.split === split);
    if (ofSplit.length !== 4) throw corpusFail("each split must freeze exactly four tasks");
    const pairIds = new Set(ofSplit.map(task => task.pairId));
    if (pairIds.size !== 2) throw corpusFail("each split must freeze exactly two task pairs");
    for (const pairId of pairIds) {
      const pair = ofSplit.filter(task => task.pairId === pairId);
      if (pair[0].language === pair[1].language) throw corpusFail("each pair must freeze one en and one zh task");
      if (pair[0].allowedProfiles.length !== pair[1].allowedProfiles.length
        || pair[0].allowedProfiles.some((profile, index) => profile !== pair[1].allowedProfiles[index])) {
        throw corpusFail("each pair must freeze the same allowed-profile band");
      }
    }
  }
  // Pair identity is global, not per-split: a pairId reused across splits, or a
  // pair with more or fewer than its two members anywhere in the corpus, is a
  // forgery even when every split looks well-formed on its own.
  const pairGroups = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const members = pairGroups.get(task.pairId) ?? [];
    members.push(task);
    pairGroups.set(task.pairId, members);
  }
  if (pairGroups.size !== 4) throw corpusFail("calibrationTasks must freeze exactly four distinct task pairs");
  for (const [pairId, members] of pairGroups) {
    if (members.length !== 2) throw corpusFail("pair " + JSON.stringify(pairId) + " must freeze exactly two tasks");
    if (members[0].split !== members[1].split) {
      throw corpusFail("pair " + JSON.stringify(pairId) + " must stay within one split");
    }
    if (members[0].language === members[1].language) {
      throw corpusFail("pair " + JSON.stringify(pairId) + " must freeze one en and one zh task");
    }
    if (members[0].allowedProfiles.length !== members[1].allowedProfiles.length
      || members[0].allowedProfiles.some((profile, index) => profile !== members[1].allowedProfiles[index])) {
      throw corpusFail("pair " + JSON.stringify(pairId) + " must freeze the same allowed-profile band");
    }
  }
  return deepFreeze({
    version: 2,
    calibrationTasks: tasks,
    workerReadonlyTask: value.workerReadonlyTask,
    workerWriteTask: value.workerWriteTask,
    workerFixtureInput: deepFreeze({ values: Object.freeze([...value.workerFixtureInput.values]) })
  }) as FrozenCorpus;
};

// The host project config is read through production project-path semantics
// (spec §5.1): only ENOENT counts as absent. An unreadable, linked, special,
// or oversized host refuses rather than silently reading as absent.
const readHostSnapshot = async (): Promise<Readonly<{ exists: boolean; sha256: string | null }>> => {
  const bytes = await readProjectFile(REPO_ROOT, ".turnhelm/config.json", 65536);
  return bytes === undefined ? { exists: false, sha256: null } : { exists: true, sha256: sha256hex(bytes) };
};

const verifyHostSnapshot = async (manifest: AcceptanceManifest): Promise<void> => {
  const current = await readHostSnapshot();
  if (current.exists !== manifest.hostSnapshot.exists || current.sha256 !== manifest.hostSnapshot.sha256) {
    throw new Error("acceptance host snapshot drifted from the manifest");
  }
};

const runGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const run = await execute("git", args, { cwd, encoding: "utf8", timeout: 30000 });
  return run.stdout.trim();
};

// Locate an executable by scanning PATH directly: prepare may spawn nothing
// but git, and `which` is a subprocess. The path list is a parameter so the
// execute gate can resolve against the environment it will run in.
export const findOnPath = async (name: string, pathValue: string = process.env.PATH ?? ""): Promise<string> => {
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    try {
      const info = await stat(join(dir, name));
      if (info.isFile() && (info.mode & 0o111) !== 0) return join(dir, name);
    } catch { /* absent PATH entries are skipped */ }
  }
  return "";
};

// Both helpers round-trip through parseProjectConfig so every frozen case
// config is a config production code would accept.
const withBackends = (
  config: ProjectConfig,
  laya: Readonly<{ enabled: boolean; url?: string }>,
  jev: Readonly<{ enabled: boolean }>,
  rebindFrom?: ProfileId
): ProjectConfig => parseProjectConfig({
  version: config.version,
  routingTimeoutMs: config.routingTimeoutMs,
  backends: {
    laya: { enabled: laya.enabled, url: laya.url ?? config.backends.laya.url },
    // The Jev transport is frozen policy: rebinding backends never rebuilds
    // it as direct behind the caller's selected policy.
    jev: { enabled: jev.enabled, transport: config.backends.jev.transport }
  },
  profiles: Object.fromEntries(PROFILE_IDS.map(id => [id, {
    model: config.profiles[rebindFrom ?? id].model, effort: config.profiles[rebindFrom ?? id].effort
  }]))
});

const rebindAllProfiles = (source: ProfileId, config: ProjectConfig): ProjectConfig =>
  withBackends(config, { enabled: config.backends.laya.enabled }, { enabled: config.backends.jev.enabled }, source);

// Spec §9: prepare accepts an explicit config file and the existing dual
// fallback case selector. The frozen default stays the shipped template.
export type PrepareAcceptanceOptions = Readonly<{ configPath?: string; caseId?: "dual-jev-write" }>;

const EXPLICIT_CONFIG_MAX_BYTES = 65536;

// One fixed, content-free refusal for every explicit-config failure: read,
// decode, and parse errors never forward input bytes, JSON snippets, or
// native URL/decoder messages.
const explicitConfigRefusal = (): Error =>
  new Error("prepare explicit config could not be read or validated");

// The explicit config is read through the same production-safe file semantics
// as every other config read (regular file, no symlinked final component,
// bounded bytes), resolved at dirname/basename so no general file loader is
// added; UTF-8 and JSON are fatal.
const readExplicitConfig = async (configPath: string): Promise<ProjectConfig> => {
  try {
    const bytes = await readProjectFile(dirname(configPath), basename(configPath), EXPLICIT_CONFIG_MAX_BYTES);
    if (bytes === undefined) throw new Error("absent");
    return parseProjectConfig(JSON.parse(STRICT_DECODER.decode(bytes)));
  } catch {
    throw explicitConfigRefusal();
  }
};

// Options are validated before anything is prepared: unknown fields, an
// unknown selector, or a selector outside the dual suite refuse immediately.
const parsePrepareOptions = (
  suite: LiveSuite,
  options: PrepareAcceptanceOptions | undefined
): Readonly<{ configPath?: string; caseId?: "dual-jev-write" }> => {
  if (options === undefined) return {};
  if (!isRecord(options)) throw new Error("prepare options must be an object");
  for (const key of Object.keys(options)) {
    if (key !== "configPath" && key !== "caseId") {
      throw new Error("prepare options must not contain unknown field " + JSON.stringify(key));
    }
  }
  const configPath = options.configPath;
  if (configPath !== undefined && (typeof configPath !== "string" || configPath.length === 0)) {
    throw new Error("prepare configPath must be a nonempty string");
  }
  const caseId = options.caseId;
  if (caseId !== undefined) {
    if (caseId !== "dual-jev-write") throw new Error("prepare caseId must be dual-jev-write");
    if (suite !== "dual") throw new Error("prepare caseId selects an existing dual fallback case");
  }
  return { ...(configPath !== undefined ? { configPath } : {}), ...(caseId !== undefined ? { caseId } : {}) };
};

export async function prepareAcceptance(
  suite: LiveSuite,
  options?: PrepareAcceptanceOptions
): Promise<{ manifestPath: string; sha256: string }> {
  // Options, the explicit config, and both frozen inputs are validated before
  // any run root exists: a refusal leaves nothing behind.
  const selected = parsePrepareOptions(suite, options);
  const corpusBytes = await readFile(CORPUS_PATH);
  const corpus = parseCorpus(JSON.parse(corpusBytes.toString("utf8")));
  const template = parseProjectConfig(JSON.parse((await readFile(TEMPLATE_PATH)).toString("utf8")));
  // The frozen base is the shipped template unless the caller supplied an
  // explicit v2 config; the rebinding below preserves its Jev transport.
  const base = selected.configPath !== undefined ? await readExplicitConfig(selected.configPath) : template;
  const hostSnapshot = await readHostSnapshot();

  const runRoot = await mkdtemp(join(tmpdir(), "turnhelm-live-" + suite + "-"));
  await mkdir(join(runRoot, "consumers"), { mode: 0o700 });
  const expected = {
    count: corpus.workerFixtureInput.values.length,
    sum: corpus.workerFixtureInput.values.reduce((total, value) => total + value, 0)
  };

  const makeConsumer = async (
    id: string,
    config: ProjectConfig,
    kind: "worker-readonly" | "worker-write",
    backends: readonly AcceptanceBackend[]
  ): Promise<AcceptanceCase> => {
    const root = join(runRoot, "consumers", id);
    await mkdir(root, { mode: 0o700 });
    await runGit(root, ["init"]);
    const install = await initProject(root, { dryRun: false });
    if (install.code !== 0) throw new Error("prepare could not initialize consumer " + id);
    await writeFile(join(root, ".turnhelm/config.json"), canonicalConfigBytes(config), { mode: 0o644 });
    const input = Buffer.from(JSON.stringify(corpus.workerFixtureInput), "utf8");
    await writeFile(join(root, "input.json"), input, { mode: 0o644 });
    const info = await stat(root);
    const task = kind === "worker-write" ? corpus.workerWriteTask : corpus.workerReadonlyTask;
    const taskBytes = Buffer.from(task, "utf8");
    if (taskBytes.length > MAX_TASK_BYTES) throw new Error("consumer task exceeds the transport bound");
    return {
      id,
      kind,
      root: await realpath(root),
      identity: { dev: info.dev, ino: info.ino },
      task,
      taskHash: sha256hex(taskBytes),
      taskBytes: taskBytes.length,
      config,
      inputHashes: await frozenFileHashes(root),
      allowedChanges: kind === "worker-write" ? ["out/summary.json"] : [],
      oracle: kind === "worker-write"
        ? { kind: "summary-file", expected }
        : { kind: "stdout-json", expected },
      reservation: { worker: 1, backends }
    };
  };

  const makeCalibrationCase = (entry: CalibrationTask, trial: 1 | 2 | 3, config: ProjectConfig): AcceptanceCase => {
    const taskBytes = Buffer.from(entry.task, "utf8");
    if (taskBytes.length > MAX_TASK_BYTES) throw new Error("calibration task exceeds the transport bound");
    return {
      id: `${entry.id}-trial-${trial}`,
      kind: "classifier-only",
      root: "",
      identity: { dev: 0, ino: 0 },
      task: entry.task,
      taskHash: sha256hex(taskBytes),
      taskBytes: taskBytes.length,
      config,
      inputHashes: {},
      allowedChanges: [],
      oracle: {
        kind: "classifier-band", pairId: entry.pairId, language: entry.language,
        split: entry.split, trial, allowedProfiles: [...entry.allowedProfiles]
      },
      reservation: { worker: 0, backends: ["laya"] }
    };
  };

  const layaOnly = withBackends(base, { enabled: true }, { enabled: false });
  const cases: AcceptanceCase[] = [];
  if (suite === "laya") {
    for (const [index, id] of PROFILE_IDS.entries()) {
      const pair = base.profiles[id];
      cases.push(await makeConsumer(
        `admission-${pair.model}-${pair.effort}`,
        rebindAllProfiles(id, layaOnly),
        index === PROFILE_IDS.length - 1 ? "worker-write" : "worker-readonly",
        ["laya"]
      ));
    }
    cases.push(await makeConsumer("default-natural", layaOnly, "worker-readonly", ["laya"]));
  } else if (suite === "jev") {
    cases.push(await makeConsumer(
      "jev-default-readonly",
      withBackends(base, { enabled: false }, { enabled: true }),
      "worker-readonly",
      ["jev"]
    ));
  } else if (suite === "calibration-dev" || suite === "calibration-holdout") {
    const calibrationConfig = withBackends(base, { enabled: true }, { enabled: false });
    const split = suite === "calibration-dev" ? "dev" : "holdout";
    // Trial-major roster (spec §4.2): every corpus entry of the split, once
    // per trial, in frozen table order.
    for (const trial of [1, 2, 3] as const) {
      for (const entry of corpus.calibrationTasks) {
        if (entry.split === split) cases.push(makeCalibrationCase(entry, trial, calibrationConfig));
      }
    }
  } else {
    const dualBackends = withBackends(base, { enabled: true }, { enabled: true });
    // The fixture case gets an offline-chosen high loopback port, frozen only
    // in its own config; execute binds it before any paid call. The fallback
    // case is selected before any consumer exists, so the singleton manifest
    // reserves exactly one case and never creates the lead consumer (spec §9).
    const fixtureUrl = `http://127.0.0.1:${randomInt(20000, 45000)}`;
    if (selected.caseId === undefined) {
      cases.push(await makeConsumer("dual-laya-first", dualBackends, "worker-readonly", ["laya", "jev"]));
    }
    cases.push(await makeConsumer(
      "dual-jev-write",
      withBackends(base, { enabled: true, url: fixtureUrl }, { enabled: true }),
      "worker-write",
      ["laya", "jev"]
    ));
  }

  // Caps derive from the selected reservations — the same sums the manifest
  // parser demands at claim — so a narrowed selection reserves less than the
  // suite; SUITE_CAPS stays the outer ceiling the parser enforces.
  const caps = {
    worker: cases.reduce((total, item) => total + item.reservation.worker, 0),
    laya: cases.filter(item => item.reservation.backends.includes("laya")).length,
    jev: cases.filter(item => item.reservation.backends.includes("jev")).length
  };

  const hashFile = async (path: string) => ({ path, sha256: sha256hex(await readFile(join(REPO_ROOT, path))) });
  const sourceFiles = (await readdir(join(REPO_ROOT, "src"))).filter(name => name.endsWith(".ts")).sort();
  const distFiles = (await readdir(join(REPO_ROOT, "dist/src"))).filter(name => name.endsWith(".js")).sort();
  const canonical = await realpath(runRoot);
  const runInfo = await stat(runRoot);

  const manifest: AcceptanceManifest = {
    version: 2,
    suite,
    baseline: {
      head: await runGit(REPO_ROOT, ["rev-parse", "HEAD"]),
      source: await Promise.all(sourceFiles.map(name => hashFile("src/" + name))),
      dist: await Promise.all(
        [...distFiles.map(name => "dist/src/" + name), "dist/test/live-acceptance.js", "dist/test/live.integration.js"].map(hashFile)
      ),
      corpus: sha256hex(corpusBytes),
      tools: {
        node: process.version,
        execPath: process.execPath,
        git: await runGit(REPO_ROOT, ["--version"]),
        gitPath: await findOnPath("git")
      }
    },
    runRoot: { canonical, dev: runInfo.dev, ino: runInfo.ino },
    hostSnapshot: { exists: hostSnapshot.exists, sha256: hostSnapshot.sha256 },
    caps,
    cases
  };
  const manifestPath = join(runRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return { manifestPath, sha256: sha256hex(await readFile(manifestPath)) };
}

export async function claimAcceptance(manifestPath: string, approvedSha256: string): Promise<ClaimedRun> {
  const bytes = await readManifestBytes(manifestPath);
  const manifestSha256 = sha256hex(bytes);
  if (manifestSha256 !== approvedSha256) throw new Error("acceptance manifest does not match the approved sha256");
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8")));

  // The claiming runtime must be the toolchain the manifest froze. Only
  // node/execPath are re-verified here because claim spawns nothing; git is
  // spawned at execute time (the production CLI inspects the work tree), so
  // its frozen identity is re-verified at the execute gate, against the
  // environment the cases will actually run in.
  if (process.version !== manifest.baseline.tools.node || process.execPath !== manifest.baseline.tools.execPath) {
    throw new Error("acceptance tools drifted from the manifest");
  }

  // The host project config is snapshotted at prepare so the approval pins
  // the environment it was granted in; a claim elsewhere (or against a forged
  // snapshot) must not proceed. An unreadable file counts as absent-present
  // drift — the comparison fails closed.
  await verifyHostSnapshot(manifest);

  const manifestReal = await realpath(manifestPath);
  const runRoot = dirname(manifestReal);
  if (runRoot !== manifest.runRoot.canonical) throw new Error("acceptance manifest must live in its frozen run root");
  const runInfo = await stat(runRoot);
  if (runInfo.dev !== manifest.runRoot.dev || runInfo.ino !== manifest.runRoot.ino) {
    throw new Error("acceptance run root identity changed");
  }

  if (sha256hex(await readFile(CORPUS_PATH)) !== manifest.baseline.corpus) {
    throw new Error("acceptance corpus drifted from the manifest");
  }
  for (const scope of ["source", "dist"] as const) {
    for (const entry of manifest.baseline[scope]) {
      const current = await readFile(join(REPO_ROOT, entry.path)).catch(() => null);
      if (current === null || sha256hex(current) !== entry.sha256) {
        throw new Error("acceptance baseline drifted from the manifest");
      }
    }
  }

  // The corpus bytes already match the manifest hash, so the case tasks and
  // oracle facts are pinned to what that corpus actually freezes: a crafted
  // manifest cannot widen scope with its own task text or expected pair.
  const corpus = parseCorpus(JSON.parse((await readFile(CORPUS_PATH)).toString("utf8")));
  const template = parseProjectConfig(JSON.parse((await readFile(TEMPLATE_PATH)).toString("utf8")));
  const corpusWorkerHash = new Map<AcceptanceCaseKind, string>([
    ["worker-readonly", sha256hex(Buffer.from(corpus.workerReadonlyTask, "utf8"))],
    ["worker-write", sha256hex(Buffer.from(corpus.workerWriteTask, "utf8"))]
  ]);
  const corpusFact = {
    count: corpus.workerFixtureInput.values.length,
    sum: corpus.workerFixtureInput.values.reduce((total, value) => total + value, 0)
  };

  // The calibration roster is rebuilt from the corpus exactly as prepare
  // froze it: id, task hash, full oracle metadata, and every template binding
  // must match case for case — a crafted manifest cannot swap trials, bands,
  // or configs inside an approved hash.
  const calibrationSplit = manifest.suite === "calibration-dev" ? "dev"
    : manifest.suite === "calibration-holdout" ? "holdout" : null;
  if (calibrationSplit !== null) {
    const entries = corpus.calibrationTasks.filter(entry => entry.split === calibrationSplit);
    const roster = [1, 2, 3].flatMap(trial => entries.map(entry => ({ entry, trial })));
    if (manifest.cases.length !== roster.length) {
      throw new Error("acceptance calibration roster is incomplete: " + manifest.cases.length
        + " of " + roster.length + " cases");
    }
    for (const [index, item] of manifest.cases.entries()) {
      const { entry, trial } = roster[index];
      if (item.kind !== "classifier-only") {
        throw new Error("acceptance calibration roster has a non-calibration case: " + item.id);
      }
      if (item.id !== `${entry.id}-trial-${trial}`) {
        throw new Error("acceptance case id is not the frozen roster id: " + item.id);
      }
      if (item.taskHash !== sha256hex(Buffer.from(entry.task, "utf8"))) {
        throw new Error("acceptance case task is not the frozen corpus task: " + item.id);
      }
      const oracle = item.oracle;
      if (oracle.kind !== "classifier-band"
        || oracle.pairId !== entry.pairId || oracle.language !== entry.language
        || oracle.split !== entry.split || oracle.trial !== trial
        || oracle.allowedProfiles.length !== entry.allowedProfiles.length
        || oracle.allowedProfiles.some((profile, at) => profile !== entry.allowedProfiles[at])) {
        throw new Error("acceptance case oracle is not the corpus fact: " + item.id);
      }
      if (item.config.routingTimeoutMs !== template.routingTimeoutMs) {
        throw new Error("acceptance calibration config drifted from the template: " + item.id);
      }
      if (!item.config.backends.laya.enabled || item.config.backends.jev.enabled) {
        throw new Error("acceptance calibration config must be laya-only: " + item.id);
      }
      for (const id of PROFILE_IDS) {
        if (item.config.profiles[id].model !== template.profiles[id].model
          || item.config.profiles[id].effort !== template.profiles[id].effort) {
          throw new Error("acceptance calibration profiles drifted from the template: " + item.id);
        }
      }
    }
  }
  for (const item of manifest.cases) {
    if (item.kind === "classifier-only") continue;
    if (item.taskHash !== corpusWorkerHash.get(item.kind)) {
      throw new Error("acceptance case task is not the frozen corpus task: " + item.id);
    }
    const oracle = item.oracle;
    if (oracle.kind === "classifier-band") {
      throw new Error("acceptance case oracle is not the corpus fact: " + item.id);
    }
    if (oracle.expected.count !== corpusFact.count || oracle.expected.sum !== corpusFact.sum) {
      throw new Error("acceptance case oracle is not the corpus fact: " + item.id);
    }
  }

  for (const item of manifest.cases) {
    // The same per-case freeze check execute re-runs before each case: claim
    // and execute must never disagree about which files are frozen.
    await verifyCaseFrozen(item);
  }

  const evidenceDir = join(runRoot, "evidence");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const evidencePath = join(evidenceDir, "evidence.jsonl");
  let handle: FileHandle;
  try {
    handle = await openFile(evidencePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("acceptance evidence has already been claimed for this manifest");
    }
    throw error;
  }
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error("acceptance evidence is not a regular file");
  }
  return { manifest, manifestPath: manifestReal, manifestSha256, evidencePath, handle };
}

// Evidence records are rebuilt field by field: whatever a receipt carried,
// only the bounded v1 fields below ever reach the journal. Receipt-shaped
// garbage degrades to the fixed invalid/unknown markers, never raw values.
const evidenceReject = (what: string): Error => new Error("acceptance evidence record is invalid: " + what);
const evidenceString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const evidenceCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

// Worker usage is a projection, never a promise: unknown or malformed counters
// drop instead of throwing, and an absent snapshot, the CLI's literal
// "unreported", and zero surviving counters all read as "unreported".
const USAGE_COUNTERS = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"] as const;
const projectWorkerUsage = (usage: unknown): WorkerUsageEvidence => {
  if (usage === "unreported" || typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return "unreported";
  }
  const counters: Partial<Record<(typeof USAGE_COUNTERS)[number], number>> = {};
  for (const field of USAGE_COUNTERS) {
    const value = (usage as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) counters[field] = value;
  }
  return Object.keys(counters).length === 0 ? "unreported" : counters;
};

// The projection validates against the decoder's own frozen taxonomy: every
// non-unknown class necessarily carries a phrasing (the decoder's closure test
// pins that), so the set derives from the phrasing table without a copy.
const FAILURE_CLASSES: ReadonlySet<string> = new Set([...FAILURE_PHRASINGS.map(([failureClass]) => failureClass), "unknown"]);
const FAILURE_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

// All-or-nothing on the required fields, per-field on the optional ones: a
// malformed class or ownedShutdown drops the whole projection, a malformed
// hash or signal drops only itself. Nothing throws except on an unknown key
// inside a present projection — the same strictness as oracleInput.
const projectWorkerFailure = (value: unknown): WorkerFailureEvidence | undefined => {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "class" && key !== "ownedShutdown" && key !== "errorSha256" && key !== "signal") {
      throw evidenceReject("workerFailure must not contain unknown field " + JSON.stringify(key));
    }
  }
  if (typeof value.class !== "string" || !FAILURE_CLASSES.has(value.class)) return undefined;
  if (typeof value.ownedShutdown !== "boolean") return undefined;
  const projection: { class: FailureClass; ownedShutdown: boolean; errorSha256?: string; signal?: "SIGINT" | "SIGTERM" | "SIGKILL" } = {
    class: value.class as FailureClass, ownedShutdown: value.ownedShutdown
  };
  if (typeof value.errorSha256 === "string" && SHA256_HEX.test(value.errorSha256)) projection.errorSha256 = value.errorSha256;
  if (typeof value.signal === "string" && FAILURE_SIGNALS.has(value.signal)) {
    projection.signal = value.signal as "SIGINT" | "SIGTERM" | "SIGKILL";
  }
  return projection;
};

// All-or-nothing on events, per-field on lastEventAgeMs: a malformed count
// drops the whole projection, a malformed age drops only itself. Nothing
// throws except on an unknown key inside a present projection — the same
// strictness as workerFailure.
const projectWorkerProgress = (value: unknown): WorkerProgressEvidence | undefined => {
  if (!isRecord(value)) return undefined;
  for (const key of Object.keys(value)) {
    if (key !== "events" && key !== "lastEventAgeMs") {
      throw evidenceReject("workerProgress must not contain unknown field " + JSON.stringify(key));
    }
  }
  if (typeof value.events !== "number" || !Number.isSafeInteger(value.events) || value.events < 0) return undefined;
  const projection: { events: number; lastEventAgeMs?: number } = { events: value.events };
  if (typeof value.lastEventAgeMs === "number" && Number.isSafeInteger(value.lastEventAgeMs) && value.lastEventAgeMs >= 0) {
    projection.lastEventAgeMs = value.lastEventAgeMs;
  }
  return projection;
};

// Pure, bounded transport-policy projection (spec §7), shared by both
// harnesses: at most two unique backends in a Laya-then-Jev subsequence.
// Missing, non-array, invalid-enum, duplicate, reversed, oversized, or
// backend-mode-invalid input (Laya is always direct) reads "unverified" with
// no plausible-prefix salvage; extra keys are ignored and only the enum fields
// are rebuilt, so re-projecting a projection is stable.
const ATTEMPT_BACKENDS: ReadonlySet<string> = new Set(["laya", "jev"]);
const ATTEMPT_TRANSPORT_MODES: ReadonlySet<string> = new Set(["direct", "http-connect"]);

export function projectAttemptTransports(value: unknown): AttemptTransportEvidence {
  if (!Array.isArray(value) || value.length > 2) return "unverified";
  const projected: { backend: "laya" | "jev"; transportMode: "direct" | "http-connect" }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return "unverified";
    const backend = entry.backend;
    const transportMode = entry.transportMode;
    if (typeof backend !== "string" || !ATTEMPT_BACKENDS.has(backend)) return "unverified";
    if (typeof transportMode !== "string" || !ATTEMPT_TRANSPORT_MODES.has(transportMode)) return "unverified";
    if (backend === "laya" && transportMode !== "direct") return "unverified";
    if (projected.some(prior => prior.backend === backend)) return "unverified";
    if (backend === "laya" && projected.length > 0) return "unverified";
    projected.push({ backend: backend as "laya" | "jev", transportMode: transportMode as "direct" | "http-connect" });
  }
  return projected;
}

const sanitizeEvidence = (record: SafeEvidence): SafeEvidence => {
  const raw = record as unknown as Record<string, unknown>;
  switch (raw.phase) {
    case "prepared": {
      if (raw.suite !== "laya" && raw.suite !== "jev" && raw.suite !== "dual"
        && raw.suite !== "calibration-dev" && raw.suite !== "calibration-holdout") {
        throw evidenceReject("prepared suite is unknown");
      }
      const manifestSha256 = evidenceString(raw.manifestSha256);
      const startedAt = evidenceString(raw.startedAt);
      if (manifestSha256 === null || startedAt === null) throw evidenceReject("prepared fields are malformed");
      return { phase: "prepared", suite: raw.suite, manifestSha256, startedAt };
    }
    case "reserved": {
      const backends = (Array.isArray(raw.backends) ? raw.backends : []).filter(
        (backend): backend is AcceptanceBackend => backend === "laya" || backend === "jev"
      );
      return { phase: "reserved", caseId: evidenceString(raw.caseId) ?? "", worker: evidenceCount(raw.worker), backends };
    }
    case "observed": {
      const workerFailure = raw.workerFailure === undefined ? undefined : projectWorkerFailure(raw.workerFailure);
      const workerProgress = raw.workerProgress === undefined ? undefined : projectWorkerProgress(raw.workerProgress);
      return {
        phase: "observed",
        caseId: evidenceString(raw.caseId) ?? "",
        backend: raw.backend === "laya" || raw.backend === "jev" ? raw.backend : "invalid",
        profileId: evidenceString(raw.profileId) ?? "unknown",
        rootMatches: typeof raw.rootMatches === "boolean" ? raw.rootMatches : "unknown",
        exitCode: typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode) ? raw.exitCode : null,
        durationMs: evidenceCount(raw.durationMs),
        attempts: evidenceCount(raw.attempts),
        ...(raw.attemptTransports !== undefined ? { attemptTransports: projectAttemptTransports(raw.attemptTransports) } : {}),
        ...(raw.workerUsage !== undefined ? { workerUsage: projectWorkerUsage(raw.workerUsage) } : {}),
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerProgress !== undefined ? { workerProgress } : {})
      };
    }
    case "verified": {
      const checks: Record<string, boolean> = {};
      if (isRecord(raw.checks)) {
        for (const [name, verdict] of Object.entries(raw.checks)) {
          if (typeof verdict === "boolean") checks[name] = verdict;
        }
      }
      const policy = raw.policy;
      if (policy !== "match" && policy !== "mismatch" && policy !== "not-applicable") {
        throw evidenceReject("verified policy is unknown");
      }
      // Retained oracle input is raw worker output: strict three-key shape,
      // bounded on UTF-8 bytes (a character count would let multibyte content
      // slip past) so the journal stays a bounded, replay-free record.
      let oracleInput: OracleInputEvidence | undefined;
      const input = raw.oracleInput;
      if (input !== undefined) {
        if (!isRecord(input)) throw evidenceReject("oracleInput must be a record");
        for (const key of Object.keys(input)) {
          if (key !== "source" && key !== "text" && key !== "bytes") {
            throw evidenceReject("oracleInput must not contain unknown field " + JSON.stringify(key));
          }
        }
        const { source, text, bytes } = input;
        if (source !== "stdout" && source !== "summary-file") throw evidenceReject("oracleInput source is unknown");
        if (typeof text !== "string" && text !== null) throw evidenceReject("oracleInput text is malformed");
        if (bytes !== null && (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)) {
          throw evidenceReject("oracleInput bytes is malformed");
        }
        if (text !== null && Buffer.byteLength(text, "utf8") > STDOUT_CAP_BYTES) {
          throw evidenceReject("oracleInput text exceeds the 65536-byte bound");
        }
        oracleInput = { source, text, bytes };
      }
      return {
        phase: "verified", caseId: evidenceString(raw.caseId) ?? "",
        verdict: raw.verdict === "pass" ? "pass" : "fail", policy, checks,
        ...(oracleInput !== undefined ? { oracleInput } : {})
      };
    }
    case "completed": {
      // The commit-point fact is written only by the runner itself, so its
      // shape is strict: an unknown field or an impossible count combination
      // rejects rather than degrades. The two suite families never mix — the
      // worker record reports failure counts, calibration policy counts.
      if (Object.hasOwn(raw, "failed")) {
        for (const key of Object.keys(raw)) {
          if (key !== "phase" && key !== "outcome" && key !== "cases" && key !== "failed") {
            throw evidenceReject("completed record must not contain unknown field " + JSON.stringify(key));
          }
        }
        const outcome = raw.outcome;
        if (outcome !== "pass" && outcome !== "fail") throw evidenceReject("completed outcome is unknown");
        const counts = [raw.cases, raw.failed];
        if (!counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
          throw evidenceReject("completed counts must be non-negative safe integers");
        }
        const [cases, failed] = counts as [number, number];
        if (failed > cases) throw evidenceReject("completed failures must not exceed the roster");
        if (outcome === "pass" && failed !== 0) throw evidenceReject("a completed pass must report no failures");
        if (outcome === "fail" && failed === 0) throw evidenceReject("a completed fail must report a failure");
        return { phase: "completed", outcome, cases, failed };
      }
      for (const key of Object.keys(raw)) {
        if (key !== "phase" && key !== "outcome" && key !== "cases" && key !== "policyMatches" && key !== "policyMismatches") {
          throw evidenceReject("completed record must not contain unknown field " + JSON.stringify(key));
        }
      }
      const outcome = raw.outcome;
      if (outcome !== "pass" && outcome !== "policy-mismatch") throw evidenceReject("completed outcome is unknown");
      const counts = [raw.cases, raw.policyMatches, raw.policyMismatches];
      if (!counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
        throw evidenceReject("completed counts must be non-negative safe integers");
      }
      const [cases, matches, mismatches] = counts as [number, number, number];
      if (cases !== 12 || matches + mismatches !== cases) {
        throw evidenceReject("completed counts must cover the twelve-case roster");
      }
      if (outcome === "pass" && mismatches !== 0) throw evidenceReject("a completed pass must report no mismatches");
      if (outcome === "policy-mismatch" && mismatches === 0) {
        throw evidenceReject("a completed policy-mismatch must report a mismatch");
      }
      return { phase: "completed", outcome, cases, policyMatches: matches, policyMismatches: mismatches };
    }
    case "stopped": {
      const reason = raw.reason;
      const bounded: StoppedReason = reason === "drift" || reason === "output-limit" || reason === "evidence-io"
        || reason === "signal" || reason === "timeout" || reason === "worker-failure" || reason === "verdict"
        || reason === "cleanup-unverified" || reason === "unknown"
        ? reason : "unknown";
      return { phase: "stopped", caseId: evidenceString(raw.caseId), reason: bounded };
    }
    default:
      throw evidenceReject("phase is unknown");
  }
};

// Appends serialize per claimed run: each record waits for the previous
// append+sync, so the journal stays ordered without an unbounded write queue.
const evidenceTails = new WeakMap<ClaimedRun, Promise<void>>();

export async function appendEvidence(run: ClaimedRun, record: SafeEvidence): Promise<void> {
  const line = Buffer.from(JSON.stringify(sanitizeEvidence(record)) + "\n", "utf8");
  const previous = evidenceTails.get(run) ?? Promise.resolve();
  const tail = previous.catch(() => { /* a failed append stops the run; the queue stays drainable */ }).then(async () => {
    await run.handle.appendFile(line);
    await run.handle.sync();
  });
  evidenceTails.set(run, tail);
  await tail;
}

// ---- Task 3: bounded sequential execute ----

const CLI_PATH = join(REPO_ROOT, "dist", "src", "cli.js");
const CASE_TIMEOUT_MS = 240000;
const TERM_GRACE_MS = 5000;
const STDOUT_CAP_BYTES = 65536;
const STDERR_CAP_BYTES = 1 << 20;
const LINE_CAP_BYTES = 65536;
const STRICT_DECODER = new TextDecoder("utf-8", { fatal: true });

const decodeBounded = (data: Buffer): string | null => {
  try {
    return STRICT_DECODER.decode(data);
  } catch {
    return null;
  }
};

export type CliSupervision = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: Buffer;
  stderr: Buffer;
  outputOverflow: boolean;
  timedOut: boolean;
  aborted: boolean;
  termSent: boolean;
  cliClosed: boolean;
}>;

// Spawns one owned CLI child under fixed output and time budgets. A budget
// breach halts by SIGINT to the child pid only, escalating to SIGTERM after a
// fixed grace; nothing outside the owned child is ever signalled.
export function superviseCli(
  file: string,
  args: readonly string[],
  options: Readonly<{ env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; termGraceMs?: number; postTermMs?: number }>
): Promise<CliSupervision> {
  return new Promise(resolve => {
    if (options.signal?.aborted) {
      // The operator aborted before the invocation: nothing is spawned, so
      // no spend can happen and there is nothing to clean up.
      resolve({
        exitCode: null, signal: null, durationMs: 0,
        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        outputOverflow: false, timedOut: false, aborted: true,
        termSent: false, cliClosed: false
      });
      return;
    }
    const started = performance.now();
    const child = spawn(file, args, {
      shell: false,
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const state = {
      exitCode: null as number | null,
      signal: null as NodeJS.Signals | null,
      stdout: [] as Buffer[],
      stderr: [] as Buffer[],
      outputOverflow: false,
      timedOut: false,
      aborted: false,
      termSent: false,
      cliClosed: false
    };
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLine = 0;
    let stderrLine = 0;
    let halted = false;
    let resolved = false;
    let termTimer: NodeJS.Timeout | undefined;
    let postTermTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (closed: boolean): void => {
      if (resolved) return;
      resolved = true;
      if (closed) state.cliClosed = true;
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (postTermTimer !== undefined) clearTimeout(postTermTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (onAbort !== undefined && options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: state.exitCode,
        signal: state.signal,
        durationMs: Math.round(performance.now() - started),
        stdout: Buffer.concat(state.stdout),
        stderr: Buffer.concat(state.stderr),
        outputOverflow: state.outputOverflow,
        timedOut: state.timedOut,
        aborted: state.aborted,
        termSent: state.termSent,
        cliClosed: closed
      });
    };
    const halt = (reason: "timeout" | "abort"): void => {
      if (halted || resolved) return;
      halted = true;
      if (reason === "timeout") state.timedOut = true;
      if (reason === "abort") state.aborted = true;
      child.kill("SIGINT");
      termTimer = setTimeout(() => {
        if (!resolved) {
          child.kill("SIGTERM");
          state.termSent = true;
          // A child that still does not close after TERM settles bounded with
          // cliClosed false: cleanup stays unverified instead of hanging the
          // run forever (spec §5).
          postTermTimer = setTimeout(() => {
            if (!resolved) {
              // Abandonment: this end of the pipes and the child reference are
              // released so the owning process can exit with its recorded
              // verdict even while a descendant still holds the pipe open.
              // Nothing outside the owned child is signalled.
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
              finish(false);
            }
          }, options.postTermMs ?? TERM_GRACE_MS);
        }
      }, options.termGraceMs ?? TERM_GRACE_MS);
    };
    const tap = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const total = stream === "stdout" ? stdoutBytes += chunk.length : stderrBytes += chunk.length;
      const line = stream === "stdout" ? stdoutLine += chunk.length : stderrLine += chunk.length;
      const index = chunk.lastIndexOf(0x0a);
      if (index >= 0) {
        if (stream === "stdout") stdoutLine = chunk.length - 1 - index;
        else stderrLine = chunk.length - 1 - index;
      }
      const cap = stream === "stdout" ? STDOUT_CAP_BYTES : STDERR_CAP_BYTES;
      // Bounded memory: past the cap the bytes are counted, never kept.
      if (total <= cap) state[stream].push(chunk);
      if (total > cap || line > LINE_CAP_BYTES) {
        state.outputOverflow = true;
        halt("timeout");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => tap("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => tap("stderr", chunk));
    child.on("error", () => finish(true));
    child.on("close", (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      finish(true);
    });
    timeoutTimer = setTimeout(() => halt("timeout"), options.timeoutMs ?? CASE_TIMEOUT_MS);
    if (options.signal !== undefined) {
      if (options.signal.aborted) halt("abort");
      else {
        onAbort = () => halt("abort");
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

const verifyRepoFrozen = async (manifest: AcceptanceManifest): Promise<void> => {
  if (sha256hex(await readFile(CORPUS_PATH)) !== manifest.baseline.corpus) {
    throw new Error("acceptance corpus drifted from the manifest");
  }
  for (const scope of ["source", "dist"] as const) {
    for (const entry of manifest.baseline[scope]) {
      const current = await readFile(join(REPO_ROOT, entry.path)).catch(() => null);
      if (current === null || sha256hex(current) !== entry.sha256) {
        throw new Error("acceptance baseline drifted from the manifest");
      }
    }
  }
};

const verifyCaseFrozen = async (item: AcceptanceCase): Promise<void> => {
  if (item.kind === "classifier-only") return;
  if ((await realpath(item.root)) !== item.root) throw new Error("acceptance case root mismatch: " + item.id);
  const info = await stat(item.root);
  if (info.dev !== item.identity.dev || info.ino !== item.identity.ino) {
    throw new Error("acceptance case root mismatch: " + item.id);
  }
  const config = await readProjectFile(item.root, ".turnhelm/config.json", 65536);
  if (config === undefined || !config.equals(canonicalConfigBytes(item.config))) {
    throw new Error("acceptance case file is not the frozen bytes: " + item.id);
  }
  for (const [file, expected] of Object.entries(item.inputHashes)) {
    const bytes = await readProjectFile(item.root, file, 65536);
    if (bytes === undefined || sha256hex(bytes) !== expected) {
      throw new Error("acceptance case file is not the frozen bytes: " + item.id);
    }
  }
};

// The tree check hashes the whole consumer root before and after the case:
// git status cannot see an in-place edit of an untracked file, so only a
// content comparison catches it. `.git` is excluded because running git
// mutates the index between snapshots; that leaves worker tampering inside
// `.git` as a known uncovered ceiling (bounded by the sandbox profile).
const TREE_MAX_ENTRIES = 512;
const TREE_MAX_FILE_BYTES = 1 << 20;
const hashTree = async (root: string): Promise<Map<string, string> | null> => {
  const files = new Map<string, string>();
  const walk = async (directory: string, prefix: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (prefix + entry.name === ".git") continue;
      if (files.size > TREE_MAX_ENTRIES) return false;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!(await walk(join(root, relative), relative + "/"))) return false;
      } else if (entry.isFile()) {
        // Size is checked via stat before the read: an oversize (or racing)
        // file must never be loaded whole just to be rejected. The residual
        // stat→read race matches the journal cap's, both fail closed.
        const path = join(root, relative);
        const info = await stat(path).catch(() => null);
        if (info === null || !info.isFile() || info.size > TREE_MAX_FILE_BYTES) return false;
        const bytes = await readFile(path).catch(() => null);
        if (bytes === null) return false;
        files.set(relative, sha256hex(bytes));
      } else {
        return false; // a symlink/FIFO inside the consumer tree is unexpected
      }
    }
    return true;
  };
  return (await walk(root, "")) ? files : null;
};

// Only paths the frozen write scope (and the journal) admit may differ between
// the before/after trees, in either direction: edits, creations, deletions.
const treeDiffClean = (
  before: Map<string, string> | null,
  after: Map<string, string> | null,
  allowed: readonly string[]
): boolean => {
  if (before === null || after === null) return false;
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (path === ".turnhelm/routes.jsonl") continue;
    if (before.get(path) === after.get(path)) continue;
    if (!allowed.some(scope => path === scope || path.startsWith(scope + "/"))) return false;
  }
  return true;
};

const lastJsonLine = (text: string): Record<string, unknown> | null => {
  const lines = text.split("\n").filter(candidate => candidate.trim() !== "");
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// The whole payload is parsed once: exactly the two expected own keys with
// safe-integer values. Prose, fences, a second object, extra or missing keys,
// and non-integers all fail — only legal JSON whitespace/format/order varies.
const payloadEquals = (value: unknown, expected: Readonly<{ count: number; sum: number }>): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !("count" in record) || !("sum" in record)) return false;
  return Number.isSafeInteger(record.count) && Number.isSafeInteger(record.sum)
    && record.count === expected.count && record.sum === expected.sum;
};
const jsonEquals = (raw: string | null, expected: Readonly<{ count: number; sum: number }>): boolean => {
  if (raw === null) return false;
  try {
    return payloadEquals(JSON.parse(raw) as unknown, expected);
  } catch {
    return false;
  }
};

// The envelope discipline (WH-2/VH-5) is product-owned since the structured
// payload contract: src/payload.ts is the one frozen definition, re-exported
// here so existing import sites (test/custom-round.ts included) are unchanged.
export { envelopePayload, inertTrailerLine } from "../src/payload.js";

const envelope = (text: string, expected: Readonly<{ count: number; sum: number }>): boolean => {
  const payload = envelopePayload(text);
  return payload !== null && payloadEquals(payload.value, expected);
};

// stdout oracle: the exact whole payload, or that payload plus inert prose.
const stdoutPayloadEquals = (raw: string | null, expected: Readonly<{ count: number; sum: number }>): boolean =>
  raw !== null && (jsonEquals(raw, expected) || envelope(raw, expected));

// VH-5: the sealed round's sandbox profile lifted verbatim from its freeze
// tooling, parameterized by the runtime directory and the per-case readable
// roots. No behavior of this harness consumes it; export keeps the round
// tooling and the harness on one frozen policy instead of two that drift.
export function oracleSandboxPolicy(options: { runtimeDir: string; allowReadSubpaths: readonly string[] }): string {
  const readable = [
    '(literal "/")',
    '(subpath "/System")', '(subpath "/usr")', '(subpath "/bin")', '(subpath "/sbin")', '(subpath "/Library")',
    `(subpath ${JSON.stringify(options.runtimeDir)})`,
    ...options.allowReadSubpaths.map(path => `(subpath ${JSON.stringify(path)})`),
    '(literal "/dev/null")', '(literal "/dev/random")', '(literal "/dev/urandom")'
  ].join(" ");
  return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(deny process-fork)\n(deny signal)\n`
    + `(deny file-read-data (require-not (require-any ${readable})))\n`;
}

const withoutLayaKey = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env };
  delete copy.LAYA_API_KEY;
  return copy;
};

// Spec §7: only the two known specialized live cases carry a transport policy
// check against their frozen config — the bounded projection above, nothing
// else. Unknown or mismatching evidence blocks their transport PASS through
// the ordinary verdict stop; no global gate or stop code exists.
const SPECIALIZED_TRANSPORT_CASE_IDS: ReadonlySet<string> = new Set(["jev-default-readonly", "dual-jev-write"]);

// The policy the frozen config promises per backend: Laya is always direct,
// Jev rides its frozen transport mode, both only when the config enables them.
const expectedAttemptTransports = (config: ProjectConfig): readonly Readonly<{
  backend: AcceptanceBackend; transportMode: "direct" | "http-connect";
}>[] => [
  ...(config.backends.laya.enabled ? [{ backend: "laya" as const, transportMode: "direct" as const }] : []),
  ...(config.backends.jev.enabled
    ? [{ backend: "jev" as const, transportMode: config.backends.jev.transport.mode }]
    : [])
];

export async function executeAcceptance(
  manifestPath: string,
  approvedSha256: string,
  options?: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; termGraceMs?: number; postTermMs?: number }>
): Promise<number> {
  const env = options?.env ?? process.env;
  const abort = options?.signal;

  // Suite-complete expected eligible set, checked before anything is claimed:
  // an incomplete set spends nothing.
  const bytes = await readManifestBytes(manifestPath).catch(() => null);
  if (bytes === null || sha256hex(bytes) !== approvedSha256) return 1;
  // Bounded gate failure: a malformed or invalid manifest is a plain failed
  // run — its bytes and parse errors never reach stderr.
  let preview: AcceptanceManifest;
  try {
    preview = parseManifest(JSON.parse(bytes.toString("utf8")));
  } catch {
    return 1;
  }
  // Eligibility is demanded per case over its declared reservation — the
  // approved scope — not over a suite-wide set.
  for (const item of preview.cases) {
    const eligible = eligibleBackends(item.config, env);
    if (!item.reservation.backends.every(backend => eligible.includes(backend))) return 1;
  }

  // The production CLI the cases run inspects the git work tree at execute
  // time, so git IS spawned after prepare: the frozen git identity is
  // re-verified against the environment execution will use, or a swapped git
  // on PATH would ride the approval. Nothing is claimed on mismatch.
  if (await findOnPath("git", env.PATH ?? "") !== preview.baseline.tools.gitPath) return 1;
  const gitVersion = await execute(preview.baseline.tools.gitPath, ["--version"],
    { env, encoding: "utf8", timeout: 30000 }).then(out => out.stdout.trim()).catch(() => null);
  if (gitVersion !== preview.baseline.tools.git) return 1;

  let run: ClaimedRun;
  try {
    run = await claimAcceptance(manifestPath, approvedSha256);
  } catch {
    return 1;
  }

  try {
    try {
      await appendEvidence(run, {
        phase: "prepared", suite: preview.suite, manifestSha256: run.manifestSha256, startedAt: new Date().toISOString()
      });
    } catch {
      return 1;
    }

    // Dual fixture: bind the exact frozen loopback port before the first paid
    // call. The 503 fixture is bound by dual-jev-write identity — including
    // the singleton fallback manifest — never by position or port comparison.
    // A conflict stops the run with zero paid traffic; the port is never
    // re-picked and the frozen config is never rewritten.
    let fixtureCase: AcceptanceCase | null = null;
    if (run.manifest.suite === "dual") {
      fixtureCase = run.manifest.cases.find(item => item.id === "dual-jev-write") ?? null;
    }
    let fixtureServer: net.Server | null = null;
    const fixtureConnections = new Set<net.Socket>();
    if (fixtureCase !== null) {
      const port = Number(new URL(fixtureCase.config.backends.laya.url).port);
      fixtureServer = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException): void => reject(error);
          fixtureServer!.once("error", onError);
          fixtureServer!.listen(port, "127.0.0.1", () => {
            fixtureServer!.off("error", onError);
            resolve();
          });
        });
        // Every request gets the same fixed 503; nothing about the request is kept.
        // Connections are tracked so teardown can destroy them: a client that
        // sends a body the fixture never reads parks its server-side socket
        // (unread receive data, no reader), which would otherwise leave
        // server.close()'s callback forever unfired and the round's exit code
        // unset — node then drains and exits 0 (or hangs).
        fixtureServer.on("connection", socket => {
          fixtureConnections.add(socket);
          socket.once("close", () => fixtureConnections.delete(socket));
          socket.write("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
          socket.end();
        });
      } catch {
        await appendEvidence(run, { phase: "stopped", caseId: null, reason: "drift" }).catch(() => {});
        return 1;
      }
    }

    try {
      const isCalibration = run.manifest.suite === "calibration-dev" || run.manifest.suite === "calibration-holdout";
      let policyMatches = 0;
      let policyMismatches = 0;
      let failedCases = 0;
      for (const item of run.manifest.cases) {
        if (abort?.aborted) {
          await appendEvidence(run, { phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
          return 130;
        }

        // Frozen state is re-verified before every reservation; drift stops the
        // run rather than degrading silently.
        try {
          await verifyRepoFrozen(run.manifest);
          await verifyCaseFrozen(item);
          const eligible = eligibleBackends(item.config, env);
          if (!item.reservation.backends.every(backend => eligible.includes(backend))) throw new Error("eligible set drifted");
        } catch {
          await appendEvidence(run, { phase: "stopped", caseId: item.id, reason: "drift" }).catch(() => {});
          return 1;
        }

        // A signal that landed during the frozen re-verification stops the
        // round before the reservation: nothing is approved after the
        // operator asked to stop.
        if (abort?.aborted) {
          await appendEvidence(run, { phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
          return 130;
        }

        try {
          await appendEvidence(run, {
            phase: "reserved",
            caseId: item.id,
            worker: item.kind === "classifier-only" ? 0 : 1,
            backends: item.reservation.backends
          });
        } catch {
          return 1;
        }

        const caseEnv = fixtureCase === item ? withoutLayaKey(env) : env;
        let observation: SafeEvidence;
        let checks: Record<string, boolean>;
        let policy: "match" | "mismatch" | "not-applicable" = "not-applicable";
        let band: readonly string[] | null = null;
        let selectedProfileId = "unknown";
        let oracleInput: OracleInputEvidence | undefined;
        let stopReason: StoppedReason | null = null;
        let stopExitCode = 1;

        if (item.kind === "classifier-only") {
          const startedAt = performance.now();
          const routing = await routeTask(item.task, item.config, { env: caseEnv, signal: abort });
          const durationMs = Math.round(performance.now() - startedAt);
          const selected = routing.status === "selected";
          const attemptsMade = (selected ? routing.decision.attempts : routing.attempts).length;
          const backend = selected ? routing.decision.backend : "invalid";
          const rawProfile = selected ? routing.decision.profileId : "unknown";
          const profileId = selected && Object.hasOwn(item.config.profiles, rawProfile) ? rawProfile : "unknown";
          band = item.oracle.kind === "classifier-band" ? item.oracle.allowedProfiles : null;
          selectedProfileId = profileId;
          observation = {
            phase: "observed", caseId: item.id, backend, profileId, rootMatches: "unknown",
            exitCode: null, durationMs, attempts: attemptsMade,
            // Classifier-only cases carry their own route result's attempts —
            // never a fabricated CLI receipt or worker observation.
            attemptTransports: projectAttemptTransports(selected ? routing.decision.attempts : routing.attempts)
          };
          try {
            await appendEvidence(run, observation);
          } catch {
            return 1;
          }
          if (routing.status === "cancelled") {
            // The operator's abort reached routing: stop on the signal, never
            // grade a cancelled route as a verdict failure.
            stopReason = "signal";
            stopExitCode = 130;
            checks = {};
          } else {
            checks = {
              "route-selected": selected,
              "profile-legal": profileId !== "unknown",
              "backend-eligible": selected && eligibleBackends(item.config, env).includes(routing.decision.backend),
              "attempts-made": attemptsMade >= 1
            };
          }
        } else {
          const treeBefore = await hashTree(item.root);
          // Same gate after the pre-spawn tree snapshot: a signal during the
          // snapshot stops the round without invoking the worker.
          if (abort?.aborted) {
            await appendEvidence(run, { phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
            return 130;
          }
          const supervision = await superviseCli(
            process.execPath,
            [CLI_PATH, "run", "--project", item.root,
              ...(item.kind === "worker-write" ? ["--write"] : []), "--", item.task],
            { env: caseEnv, timeoutMs: CASE_TIMEOUT_MS, signal: abort, termGraceMs: options?.termGraceMs, postTermMs: options?.postTermMs }
          );

          // A journal past the read bound is not a usable receipt: the bytes
          // are never loaded, so a rogue oversize write cannot wedge the run.
          const JOURNAL_CAP_BYTES = 1 << 20;
          const journalPath = join(item.root, ".turnhelm", "routes.jsonl");
          const journalInfo = await stat(journalPath).catch(() => null);
          const journalRaw = journalInfo !== null && journalInfo.isFile() && journalInfo.size <= JOURNAL_CAP_BYTES
            ? await readFile(journalPath).catch(() => null)
            : null;
          let journalUsable = journalRaw !== null;
          const journalLines: Record<string, unknown>[] = [];
          if (journalRaw !== null) {
            for (const line of journalRaw.toString("utf8").split("\n")) {
              if (line === "") continue;
              try {
                journalLines.push(JSON.parse(line) as Record<string, unknown>);
              } catch {
                journalUsable = false;
              }
            }
          }
          const matching = journalLines.filter(line => line.taskSha256 === item.taskHash);
          const receiptLine = journalUsable && matching.length === 1 ? matching[0] : null;
          const attempts = receiptLine !== null && Array.isArray(receiptLine.attempts) ? receiptLine.attempts.length : 0;
          const backendRaw = receiptLine?.backend;
          const backend = backendRaw === "laya" || backendRaw === "jev" ? backendRaw : "invalid";
          const profileRaw = receiptLine !== null && typeof receiptLine.profileId === "string" ? receiptLine.profileId : "";
          const profileId = Object.hasOwn(item.config.profiles, profileRaw) ? profileRaw : "unknown";
          selectedProfileId = profileId;
          const rootInfo = await stat(item.root).catch(() => null);
          const rootMatches = rootInfo !== null && rootInfo.dev === item.identity.dev && rootInfo.ino === item.identity.ino;
          const receiptFrame = lastJsonLine(decodeBounded(supervision.stderr) ?? "");
          // The receipt's worker object is extracted before the observation is
          // built: usage must be projected from the same durable observation,
          // not from a second read taken after fallible verification.
          const worker = receiptFrame !== null && typeof receiptFrame.worker === "object" && receiptFrame.worker !== null
            ? receiptFrame.worker as Record<string, unknown> : null;
          // The failure projection comes from the same durable receipt frame as
          // usage, and lands only for a failed worker whose class and boolean
          // survive validation — never fabricated, never failure text.
          const workerFailure = worker !== null && worker.status === "failed"
            ? projectWorkerFailure({
              class: worker.failureClass,
              ownedShutdown: worker.ownedShutdown,
              ...(worker.errorSha256 !== undefined ? { errorSha256: worker.errorSha256 } : {}),
              ...(worker.signal !== undefined ? { signal: worker.signal } : {})
            })
            : undefined;
          // The decoded-event projection comes from the same durable receipt
          // frame: the parent-observed count and age, projected only when the
          // count survives validation — and never for a not-started worker,
          // which decoded nothing because it never ran.
          const workerProgress = worker !== null && worker.status !== "not-started"
            ? projectWorkerProgress({
              events: worker.progressEvents,
              ...(worker.lastEventAgeMs !== undefined ? { lastEventAgeMs: worker.lastEventAgeMs } : {})
            })
            : undefined;
          const claimedRoot = receiptFrame !== null && typeof receiptFrame.root === "string" ? receiptFrame.root : null;
          const rootOk = claimedRoot !== null && await realpath(claimedRoot).catch(() => "") === item.root;
          observation = {
            phase: "observed", caseId: item.id, backend, profileId, rootMatches,
            exitCode: supervision.exitCode, durationMs: supervision.durationMs, attempts,
            // Transport policy rides the same unique CLI-written journal
            // receipt the attempts count reads; no unique receipt means
            // unverified.
            attemptTransports: projectAttemptTransports(receiptLine?.attempts),
            workerUsage: projectWorkerUsage(worker?.usage),
            ...(workerFailure !== undefined ? { workerFailure } : {}),
            ...(workerProgress !== undefined ? { workerProgress } : {})
          };

          // The observation is persisted before any fallible verification read
          // (frozen-file reads, oracle reads): a worker artifact that makes
          // verification throw must fail the case, not discard the observation.
          try {
            await appendEvidence(run, observation);
          } catch {
            return 1;
          }

          if (!supervision.cliClosed) {
            // The owned CLI child never closed: the round stops with cleanup
            // unverified (spec §5) rather than attributing an outcome.
            stopReason = "cleanup-unverified";
            stopExitCode = supervision.aborted ? 130 : 1;
            checks = {};
          } else if (supervision.outputOverflow || supervision.timedOut || supervision.aborted) {
            stopReason = supervision.outputOverflow ? "output-limit" : supervision.timedOut ? "timeout" : "signal";
            stopExitCode = stopReason === "signal" ? 130 : 1;
            checks = {};
          } else {
            try {
              const frozenPair = profileId !== "unknown" ? item.config.profiles[profileId as keyof typeof item.config.profiles] : undefined;
              let inputsUnchanged = true;
              for (const [file, expected] of Object.entries(item.inputHashes)) {
                const bytes = await readProjectFile(item.root, file, 65536);
                if (bytes === undefined || sha256hex(bytes) !== expected) inputsUnchanged = false;
              }
              const inputUnchanged = inputsUnchanged;
              const configNow = await readProjectFile(item.root, ".turnhelm/config.json", 65536);
              const configUnchanged = configNow !== undefined && configNow.equals(canonicalConfigBytes(item.config));
              const gitClean = treeDiffClean(treeBefore, await hashTree(item.root), item.allowedChanges);
              // The specialized live cases compare the receipt's projected
              // transport policy with what their frozen config promises.
              let transportPolicyOk = false;
              if (SPECIALIZED_TRANSPORT_CASE_IDS.has(item.id)) {
                const transports = observation.attemptTransports;
                const expected = expectedAttemptTransports(item.config);
                transportPolicyOk = Array.isArray(transports) && transports.length === expected.length
                  && transports.every((entry, index) =>
                    entry.backend === expected[index].backend && entry.transportMode === expected[index].transportMode);
              }
              const stdoutText = decodeBounded(supervision.stdout);
              let oracleOk = false;
              if (item.oracle.kind === "stdout-json") {
                oracleOk = stdoutPayloadEquals(stdoutText, item.oracle.expected);
                oracleInput = { source: "stdout", text: stdoutText, bytes: supervision.stdout.length };
              } else if (item.oracle.kind === "summary-file") {
                // The retained input reuses the same read the oracle judged —
                // a second read could observe different bytes.
                const summary = await readProjectFile(item.root, "out/summary.json", 65536);
                const summaryText = summary === undefined ? null : decodeBounded(summary);
                oracleOk = summaryText !== null && jsonEquals(summaryText, item.oracle.expected);
                oracleInput = {
                  source: "summary-file", text: summaryText,
                  bytes: summary === undefined ? null : summary.length
                };
              }
              checks = {
                "receipt-unique": journalUsable && receiptLine !== null,
                "receipt-selected": receiptLine?.status === "selected",
                "receipt-pair": frozenPair !== undefined
                  && receiptLine?.model === frozenPair.model && receiptLine?.effort === frozenPair.effort,
                "receipt-task": receiptLine?.taskSha256 === item.taskHash && receiptLine?.taskBytes === item.taskBytes,
                "receipt-root": rootOk,
                "root-identity": rootMatches === true,
                "exit-zero": supervision.exitCode === 0,
                "worker-completed": worker?.status === "completed",
                "input-unchanged": inputUnchanged,
                "config-unchanged": configUnchanged,
                "git-clean": gitClean,
                "attempts-made": attempts >= 1,
                // The lead dual case is a laya-first fact (spec §4): one attempt
                // that selected laya. A natural laya failure falling back to Jev
                // is not a laya-first success. The check follows the
                // dual-laya-first identity, never array position.
                ...(run.manifest.suite === "dual" && item.id === "dual-laya-first"
                  ? { "laya-first": backend === "laya" && attempts === 1 }
                  : {}),
                ...(SPECIALIZED_TRANSPORT_CASE_IDS.has(item.id)
                  ? { "transport-policy": transportPolicyOk }
                  : {}),
                ...(item.oracle.kind === "classifier-band" ? {} : { oracle: oracleOk })
              };
            } catch {
              // A verification read refused the tree (e.g. a symlink planted
              // where a frozen file must be): the observation is already on
              // disk, so the case fails as unverifiable instead of throwing
              // the round away.
              checks = { verifiable: false };
            }
          }
        }

        if (stopReason !== null) {
          await appendEvidence(run, { phase: "stopped", caseId: item.id, reason: stopReason }).catch(() => {});
          return stopExitCode;
        }
        const verdict = Object.values(checks).every(Boolean) ? "pass" : "fail";
        if (item.kind === "classifier-only") {
          // The engineering verdict is judged first and independently: only a
          // completed route can claim a band, so a legal-but-out-of-band
          // selection is a policy mismatch that continues the roster.
          policy = verdict === "pass"
            ? (band !== null && band.includes(selectedProfileId) ? "match" : "mismatch")
            : "not-applicable";
        }
        try {
          await appendEvidence(run, {
            phase: "verified", caseId: item.id, verdict, policy, checks,
            ...(oracleInput !== undefined ? { oracleInput } : {})
          });
        } catch {
          return 1;
        }
        if (isCalibration && policy === "match") policyMatches += 1;
        if (isCalibration && policy === "mismatch") policyMismatches += 1;
        if (verdict === "fail") {
          // Integrity dominates: a case whose every check is true except the
          // oracle failed on task output alone, so it is continuable — the
          // roster runs on and the commit point counts it. Any other failure
          // broke the chain and stops the run here.
          const oracleOnly = Object.entries(checks).every(([name, value]) => value || name === "oracle");
          if (oracleOnly) {
            failedCases += 1;
          } else {
            await appendEvidence(run, { phase: "stopped", caseId: item.id, reason: "verdict" }).catch(() => {});
            return 1;
          }
        }
      }

      // §5.1 terminal boundary: after the last verified record is durable,
      // every suite re-checks the operator signal and the frozen corpus,
      // source/dist, and host config before returning. Every suite reaches
      // its commit point through the same completed protocol — calibration
      // commits policy counts, worker suites commit failure counts.
      const stopTerminal = async (reason: StoppedReason, exitCode: number): Promise<number> => {
        await appendEvidence(run, { phase: "stopped", caseId: null, reason }).catch(() => {});
        return exitCode;
      };
      if (abort?.aborted) return await stopTerminal("signal", 130);
      try {
        await verifyRepoFrozen(run.manifest);
        await verifyHostSnapshot(run.manifest);
      } catch {
        return await stopTerminal("drift", 1);
      }
      const calibrationOutcome: "pass" | "policy-mismatch" = policyMismatches === 0 ? "pass" : "policy-mismatch";
      try {
        await appendEvidence(run, isCalibration
          ? {
            phase: "completed", outcome: calibrationOutcome, cases: run.manifest.cases.length,
            policyMatches, policyMismatches
          }
          : {
            phase: "completed", outcome: failedCases === 0 ? "pass" : "fail",
            cases: run.manifest.cases.length, failed: failedCases
          });
      } catch {
        return await stopTerminal("evidence-io", 1);
      }
      // The completed line may already be visible here; visibility alone is
      // never completion — only the whole protocol below commits the run.
      if (abort?.aborted) return await stopTerminal("signal", 130);
      try {
        await verifyRepoFrozen(run.manifest);
        await verifyHostSnapshot(run.manifest);
      } catch {
        return await stopTerminal("drift", 1);
      }
      try {
        await run.handle.close();
      } catch {
        return await stopTerminal("evidence-io", 1);
      }
      // The FD is closed: a stop discovered now is reported, never appended.
      if (abort?.aborted) return 130;
      if (isCalibration) return calibrationOutcome === "pass" ? 0 : 3;
      return failedCases === 0 ? 0 : 4;
    } finally {
      if (fixtureServer !== null) {
        for (const socket of fixtureConnections) socket.destroy();
        await new Promise<void>(resolve => fixtureServer!.close(() => resolve()));
      }
    }
  } finally {
    await run.handle.close().catch(() => {});
  }
}
