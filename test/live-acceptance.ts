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
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseProjectConfig, PROFILE_IDS, type ProfileId, type ProjectConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { readProjectFile } from "../src/project.js";
import { routeTask } from "../src/route.js";
import { eligibleBackends } from "../src/systemone.js";

export type LiveSuite = "laya" | "jev" | "dual";

export type AcceptanceCaseKind = "worker-readonly" | "worker-write" | "classifier-only";

export type AcceptanceBackend = "laya" | "jev";

export type AcceptanceOracle =
  | Readonly<{ kind: "stdout-json"; expected: Readonly<{ count: number; sum: number }> }>
  | Readonly<{ kind: "summary-file"; expected: Readonly<{ count: number; sum: number }> }>
  | Readonly<{ kind: "classifier-valid" }>;

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
  version: 1;
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

export type SafeEvidence =
  | Readonly<{ phase: "prepared"; suite: LiveSuite; manifestSha256: string; startedAt: string }>
  | Readonly<{ phase: "reserved"; caseId: string; worker: number; backends: readonly AcceptanceBackend[] }>
  | Readonly<{ phase: "observed"; caseId: string; backend: AcceptanceBackend | "invalid"; profileId: string; rootMatches: boolean | "unknown"; exitCode: number | null; durationMs: number; attempts: number }>
  | Readonly<{ phase: "verified"; caseId: string; verdict: "pass" | "fail"; checks: Readonly<Record<string, boolean>> }>
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
  laya: { worker: 7, laya: 11, jev: 0 },
  jev: { worker: 1, laya: 0, jev: 1 },
  dual: { worker: 2, laya: 2, jev: 2 }
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

const parseManifest = (value: unknown): AcceptanceManifest => {
  if (!isRecord(value)) throw fail("manifest must be an object");
  expectKeys(value, ["version", "suite", "baseline", "runRoot", "hostSnapshot", "caps", "cases"], "manifest");
  if (value.version !== 1) throw fail("manifest version must be 1");
  if (value.suite !== "laya" && value.suite !== "jev" && value.suite !== "dual") throw fail("manifest suite is unknown");
  const suite: LiveSuite = value.suite;

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
      if (keys.length !== 1 || !keys.includes("input.json")) throw fail("worker case inputHashes must cover exactly input.json");
      if (!isHex(raw.inputHashes["input.json"], 64)) throw fail("worker case input.json hash is malformed");
      inputHashes["input.json"] = raw.inputHashes["input.json"] as string;
    }

    if (!Array.isArray(raw.allowedChanges)) throw fail("case allowedChanges must be an array");
    const wanted = kind === "worker-write" ? ["out/summary.json"] : [];
    if (raw.allowedChanges.length !== wanted.length || !raw.allowedChanges.every((entry, index) => entry === wanted[index])) {
      throw fail("case allowedChanges must equal the frozen write scope");
    }

    if (!isRecord(raw.oracle)) throw fail("case oracle must be an object");
    let oracle: AcceptanceOracle;
    if (kind === "classifier-only") {
      expectKeys(raw.oracle, ["kind"], "case oracle");
      if (raw.oracle.kind !== "classifier-valid") throw fail("classifier-only case oracle must be classifier-valid");
      oracle = { kind: "classifier-valid" };
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

  return Object.freeze({
    version: 1,
    suite,
    baseline: Object.freeze({
      head: baseline.head as string,
      source: Object.freeze(source),
      dist: Object.freeze(dist),
      corpus: baseline.corpus as string,
      tools: Object.freeze({ ...tools } as AcceptanceManifest["baseline"]["tools"])
    }),
    runRoot: Object.freeze({ canonical: runRoot.canonical, dev: runDev, ino: runIno }),
    hostSnapshot: Object.freeze({ exists: hostSnapshot.exists, sha256: hostSha256 }),
    caps,
    cases: Object.freeze(cases)
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

type FrozenCorpus = {
  classifierOnlyTasks: readonly { id: string; task: string }[];
  workerReadonlyTask: string;
  workerWriteTask: string;
  workerFixtureInput: Readonly<{ values: readonly number[] }>;
};

const runGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const run = await execute("git", args, { cwd, encoding: "utf8", timeout: 30000 });
  return run.stdout.trim();
};

// Locate an executable by scanning PATH directly: prepare may spawn nothing
// but git, and `which` is a subprocess.
const findOnPath = async (name: string): Promise<string> => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
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
    jev: { enabled: jev.enabled }
  },
  profiles: Object.fromEntries(PROFILE_IDS.map(id => [id, {
    model: config.profiles[rebindFrom ?? id].model, effort: config.profiles[rebindFrom ?? id].effort
  }]))
});

const rebindAllProfiles = (source: ProfileId, config: ProjectConfig): ProjectConfig =>
  withBackends(config, { enabled: config.backends.laya.enabled }, { enabled: config.backends.jev.enabled }, source);

export async function prepareAcceptance(suite: LiveSuite): Promise<{ manifestPath: string; sha256: string }> {
  const corpusBytes = await readFile(CORPUS_PATH);
  const corpus = JSON.parse(corpusBytes.toString("utf8")) as FrozenCorpus;
  const template = parseProjectConfig(JSON.parse((await readFile(TEMPLATE_PATH)).toString("utf8")));

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
      inputHashes: { "input.json": sha256hex(input) },
      allowedChanges: kind === "worker-write" ? ["out/summary.json"] : [],
      oracle: kind === "worker-write"
        ? { kind: "summary-file", expected }
        : { kind: "stdout-json", expected },
      reservation: { worker: 1, backends }
    };
  };

  const makeClassifierOnly = (id: string, task: string, config: ProjectConfig): AcceptanceCase => {
    const taskBytes = Buffer.from(task, "utf8");
    if (taskBytes.length > MAX_TASK_BYTES) throw new Error("classifier task exceeds the transport bound");
    return {
      id,
      kind: "classifier-only",
      root: "",
      identity: { dev: 0, ino: 0 },
      task,
      taskHash: sha256hex(taskBytes),
      taskBytes: taskBytes.length,
      config,
      inputHashes: {},
      allowedChanges: [],
      oracle: { kind: "classifier-valid" },
      reservation: { worker: 0, backends: [suite === "jev" ? "jev" : "laya"] }
    };
  };

  const layaOnly = withBackends(template, { enabled: true }, { enabled: false });
  const cases: AcceptanceCase[] = [];
  if (suite === "laya") {
    for (const [index, id] of PROFILE_IDS.entries()) {
      const pair = template.profiles[id];
      cases.push(await makeConsumer(
        `admission-${pair.model}-${pair.effort}`,
        rebindAllProfiles(id, layaOnly),
        index === PROFILE_IDS.length - 1 ? "worker-write" : "worker-readonly",
        ["laya"]
      ));
    }
    cases.push(await makeConsumer("default-natural", layaOnly, "worker-readonly", ["laya"]));
    for (const entry of corpus.classifierOnlyTasks) cases.push(makeClassifierOnly(entry.id, entry.task, layaOnly));
  } else if (suite === "jev") {
    cases.push(await makeConsumer(
      "jev-default-readonly",
      withBackends(template, { enabled: false }, { enabled: true }),
      "worker-readonly",
      ["jev"]
    ));
  } else {
    const dualBackends = withBackends(template, { enabled: true }, { enabled: true });
    // The fixture case gets an offline-chosen high loopback port, frozen only
    // in its own config; execute binds it before any paid call.
    const fixtureUrl = `http://127.0.0.1:${randomInt(20000, 45000)}`;
    cases.push(await makeConsumer("dual-laya-first", dualBackends, "worker-readonly", ["laya", "jev"]));
    cases.push(await makeConsumer(
      "dual-jev-write",
      withBackends(template, { enabled: true, url: fixtureUrl }, { enabled: true }),
      "worker-write",
      ["laya", "jev"]
    ));
  }

  const caps = SUITE_CAPS[suite];

  const hashFile = async (path: string) => ({ path, sha256: sha256hex(await readFile(join(REPO_ROOT, path))) });
  const sourceFiles = (await readdir(join(REPO_ROOT, "src"))).filter(name => name.endsWith(".ts")).sort();
  const distFiles = (await readdir(join(REPO_ROOT, "dist/src"))).filter(name => name.endsWith(".js")).sort();
  let hostSha256: string | null = null;
  let hostExists = false;
  try {
    const host = await readFile(join(REPO_ROOT, ".turnhelm", "config.json"));
    hostExists = true;
    hostSha256 = sha256hex(host);
  } catch { /* an absent host config is recorded as such */ }
  const canonical = await realpath(runRoot);
  const runInfo = await stat(runRoot);

  const manifest: AcceptanceManifest = {
    version: 1,
    suite,
    baseline: {
      head: await runGit(REPO_ROOT, ["rev-parse", "HEAD"]),
      source: await Promise.all(sourceFiles.map(name => hashFile("src/" + name))),
      dist: await Promise.all([...distFiles.map(name => "dist/src/" + name), "dist/test/live-acceptance.js"].map(hashFile)),
      corpus: sha256hex(corpusBytes),
      tools: {
        node: process.version,
        execPath: process.execPath,
        git: await runGit(REPO_ROOT, ["--version"]),
        gitPath: await findOnPath("git")
      }
    },
    runRoot: { canonical, dev: runInfo.dev, ino: runInfo.ino },
    hostSnapshot: { exists: hostExists, sha256: hostSha256 },
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
  const corpus = JSON.parse((await readFile(CORPUS_PATH)).toString("utf8")) as FrozenCorpus;
  const corpusWorkerHash = new Map<AcceptanceCaseKind, string>([
    ["worker-readonly", sha256hex(Buffer.from(corpus.workerReadonlyTask, "utf8"))],
    ["worker-write", sha256hex(Buffer.from(corpus.workerWriteTask, "utf8"))]
  ]);
  const corpusFact = {
    count: corpus.workerFixtureInput.values.length,
    sum: corpus.workerFixtureInput.values.reduce((total, value) => total + value, 0)
  };
  const classifierTaskHashes = new Set(corpus.classifierOnlyTasks.map(entry => sha256hex(Buffer.from(entry.task, "utf8"))));
  for (const item of manifest.cases) {
    if (item.kind === "classifier-only") {
      if (!classifierTaskHashes.has(item.taskHash)) {
        throw new Error("acceptance case task is not the frozen corpus task: " + item.id);
      }
      continue;
    }
    if (item.taskHash !== corpusWorkerHash.get(item.kind)) {
      throw new Error("acceptance case task is not the frozen corpus task: " + item.id);
    }
    const oracle = item.oracle;
    if (oracle.kind === "classifier-valid") {
      throw new Error("acceptance case oracle is not the corpus fact: " + item.id);
    }
    if (oracle.expected.count !== corpusFact.count || oracle.expected.sum !== corpusFact.sum) {
      throw new Error("acceptance case oracle is not the corpus fact: " + item.id);
    }
  }

  for (const item of manifest.cases) {
    if (item.kind === "classifier-only") continue;
    if (await realpath(item.root) !== item.root) throw new Error("acceptance case root mismatch: " + item.id);
    const info = await stat(item.root);
    if (info.dev !== item.identity.dev || info.ino !== item.identity.ino) {
      throw new Error("acceptance case root mismatch: " + item.id);
    }
    const config = await readProjectFile(item.root, ".turnhelm/config.json", 65536);
    if (config === undefined || !config.equals(canonicalConfigBytes(item.config))) {
      throw new Error("acceptance case file is not the frozen bytes: " + item.id);
    }
    const input = await readProjectFile(item.root, "input.json", 65536);
    if (input === undefined || sha256hex(input) !== item.inputHashes["input.json"]) {
      throw new Error("acceptance case file is not the frozen bytes: " + item.id);
    }
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

const sanitizeEvidence = (record: SafeEvidence): SafeEvidence => {
  const raw = record as unknown as Record<string, unknown>;
  switch (raw.phase) {
    case "prepared": {
      if (raw.suite !== "laya" && raw.suite !== "jev" && raw.suite !== "dual") throw evidenceReject("prepared suite is unknown");
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
    case "observed":
      return {
        phase: "observed",
        caseId: evidenceString(raw.caseId) ?? "",
        backend: raw.backend === "laya" || raw.backend === "jev" ? raw.backend : "invalid",
        profileId: evidenceString(raw.profileId) ?? "unknown",
        rootMatches: typeof raw.rootMatches === "boolean" ? raw.rootMatches : "unknown",
        exitCode: typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode) ? raw.exitCode : null,
        durationMs: evidenceCount(raw.durationMs),
        attempts: evidenceCount(raw.attempts)
      };
    case "verified": {
      const checks: Record<string, boolean> = {};
      if (isRecord(raw.checks)) {
        for (const [name, verdict] of Object.entries(raw.checks)) {
          if (typeof verdict === "boolean") checks[name] = verdict;
        }
      }
      return { phase: "verified", caseId: evidenceString(raw.caseId) ?? "", verdict: raw.verdict === "pass" ? "pass" : "fail", checks };
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
            if (!resolved) finish(false);
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
  const input = await readProjectFile(item.root, "input.json", 65536);
  if (input === undefined || sha256hex(input) !== item.inputHashes["input.json"]) {
    throw new Error("acceptance case file is not the frozen bytes: " + item.id);
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
        const bytes = await readFile(join(root, relative)).catch(() => null);
        if (bytes === null || bytes.length > TREE_MAX_FILE_BYTES) return false;
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

const jsonEquals = (raw: string | null, expected: Readonly<{ count: number; sum: number }>): boolean => {
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return record.count === expected.count && record.sum === expected.sum;
  } catch {
    return false;
  }
};

const withoutLayaKey = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env };
  delete copy.LAYA_API_KEY;
  return copy;
};

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
  const preview = parseManifest(JSON.parse(bytes.toString("utf8")));
  const wanted: readonly AcceptanceBackend[] =
    preview.suite === "laya" ? ["laya"] : preview.suite === "jev" ? ["jev"] : ["laya", "jev"];
  for (const item of preview.cases) {
    const eligible = eligibleBackends(item.config, env);
    if (!wanted.every(backend => eligible.includes(backend))) return 1;
  }

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
    // call. A conflict stops the run with zero paid traffic; the port is never
    // re-picked and the frozen config is never rewritten.
    let fixtureCase: AcceptanceCase | null = null;
    if (run.manifest.suite === "dual" && run.manifest.cases.length > 1) {
      const primary = new URL(run.manifest.cases[0].config.backends.laya.url);
      for (const item of run.manifest.cases) {
        const url = new URL(item.config.backends.laya.url);
        if (url.hostname === "127.0.0.1" && url.port !== primary.port) {
          fixtureCase = item;
          break;
        }
      }
    }
    let fixtureServer: net.Server | null = null;
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
        fixtureServer.on("connection", socket => {
          socket.write("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
          socket.end();
        });
      } catch {
        await appendEvidence(run, { phase: "stopped", caseId: null, reason: "drift" }).catch(() => {});
        return 1;
      }
    }

    try {
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
          if (!wanted.every(backend => eligible.includes(backend))) throw new Error("eligible set drifted");
        } catch {
          await appendEvidence(run, { phase: "stopped", caseId: item.id, reason: "drift" }).catch(() => {});
          return 1;
        }

        try {
          await appendEvidence(run, {
            phase: "reserved",
            caseId: item.id,
            worker: item.kind === "classifier-only" ? 0 : 1,
            backends: wanted
          });
        } catch {
          return 1;
        }

        const caseEnv = fixtureCase === item ? withoutLayaKey(env) : env;
        let observation: SafeEvidence;
        let checks: Record<string, boolean>;
        let stopReason: StoppedReason | null = null;
        let stopExitCode = 1;

        if (item.kind === "classifier-only") {
          const startedAt = performance.now();
          const routing = await routeTask(item.task, item.config, { env: caseEnv });
          const durationMs = Math.round(performance.now() - startedAt);
          const selected = routing.status === "selected";
          const attemptsMade = (selected ? routing.decision.attempts : routing.attempts).length;
          const backend = selected ? routing.decision.backend : "invalid";
          const rawProfile = selected ? routing.decision.profileId : "unknown";
          const profileId = selected && Object.hasOwn(item.config.profiles, rawProfile) ? rawProfile : "unknown";
          observation = {
            phase: "observed", caseId: item.id, backend, profileId, rootMatches: "unknown",
            exitCode: null, durationMs, attempts: attemptsMade
          };
          checks = {
            "route-selected": selected,
            "profile-legal": profileId !== "unknown",
            "backend-eligible": selected && eligibleBackends(item.config, env).includes(routing.decision.backend),
            "attempts-made": attemptsMade >= 1
          };
        } else {
          const treeBefore = await hashTree(item.root);
          const supervision = await superviseCli(
            process.execPath,
            [CLI_PATH, "run", "--project", item.root,
              ...(item.kind === "worker-write" ? ["--write"] : []), "--", item.task],
            { env: caseEnv, timeoutMs: CASE_TIMEOUT_MS, signal: abort, termGraceMs: options?.termGraceMs, postTermMs: options?.postTermMs }
          );

          const journalRaw = await readFile(join(item.root, ".turnhelm", "routes.jsonl")).catch(() => null);
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
          const rootInfo = await stat(item.root).catch(() => null);
          const rootMatches = rootInfo !== null && rootInfo.dev === item.identity.dev && rootInfo.ino === item.identity.ino;
          const receiptFrame = lastJsonLine(decodeBounded(supervision.stderr) ?? "");
          const claimedRoot = receiptFrame !== null && typeof receiptFrame.root === "string" ? receiptFrame.root : null;
          const rootOk = claimedRoot !== null && await realpath(claimedRoot).catch(() => "") === item.root;
          observation = {
            phase: "observed", caseId: item.id, backend, profileId, rootMatches,
            exitCode: supervision.exitCode, durationMs: supervision.durationMs, attempts
          };

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
            const frozenPair = profileId !== "unknown" ? item.config.profiles[profileId as keyof typeof item.config.profiles] : undefined;
            const inputNow = await readProjectFile(item.root, "input.json", 65536);
            const inputUnchanged = inputNow !== undefined && sha256hex(inputNow) === item.inputHashes["input.json"];
            const configNow = await readProjectFile(item.root, ".turnhelm/config.json", 65536);
            const configUnchanged = configNow !== undefined && configNow.equals(canonicalConfigBytes(item.config));
            const gitClean = treeDiffClean(treeBefore, await hashTree(item.root), item.allowedChanges);
            const stdoutText = decodeBounded(supervision.stdout);
            const worker = receiptFrame !== null && typeof receiptFrame.worker === "object" && receiptFrame.worker !== null
              ? receiptFrame.worker as Record<string, unknown> : null;
            let oracleOk = false;
            if (item.oracle.kind === "stdout-json") {
              const lines = (stdoutText ?? "").trimEnd().split("\n");
              oracleOk = jsonEquals(lines.at(-1) ?? null, item.oracle.expected);
            } else if (item.oracle.kind === "summary-file") {
              const summary = await readProjectFile(item.root, "out/summary.json", 65536);
              oracleOk = summary !== undefined && jsonEquals(decodeBounded(summary), item.oracle.expected);
            }
            checks = {
              "receipt-unique": journalUsable && receiptLine !== null,
              "receipt-selected": receiptLine?.status === "selected",
              "receipt-pair": frozenPair !== undefined
                && receiptLine?.model === frozenPair.model && receiptLine?.effort === frozenPair.effort,
              "receipt-task": receiptLine?.taskSha256 === item.taskHash && receiptLine?.taskBytes === item.taskBytes,
              "receipt-root": rootOk,
              "exit-zero": supervision.exitCode === 0,
              "worker-completed": worker?.status === "completed",
              "input-unchanged": inputUnchanged,
              "config-unchanged": configUnchanged,
              "git-clean": gitClean,
              "attempts-made": attempts >= 1,
              // The lead dual case is a laya-first fact (spec §4): one attempt
              // that selected laya. A natural laya failure falling back to Jev
              // is not a laya-first success.
              ...(run.manifest.suite === "dual" && item === run.manifest.cases[0]
                ? { "laya-first": backend === "laya" && attempts === 1 }
                : {}),
              ...(item.oracle.kind === "classifier-valid" ? {} : { oracle: oracleOk })
            };
          }
        }

        try {
          await appendEvidence(run, observation);
        } catch {
          return 1;
        }
        if (stopReason !== null) {
          await appendEvidence(run, { phase: "stopped", caseId: item.id, reason: stopReason }).catch(() => {});
          return stopExitCode;
        }
        const verdict = Object.values(checks).every(Boolean) ? "pass" : "fail";
        try {
          await appendEvidence(run, { phase: "verified", caseId: item.id, verdict, checks });
        } catch {
          return 1;
        }
        if (verdict === "fail") {
          await appendEvidence(run, { phase: "stopped", caseId: item.id, reason: "verdict" }).catch(() => {});
          return 1;
        }
      }
      return 0;
    } finally {
      if (fixtureServer !== null) {
        (fixtureServer as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>(resolve => fixtureServer!.close(() => resolve()));
      }
    }
  } finally {
    await run.handle.close().catch(() => {});
  }
}
