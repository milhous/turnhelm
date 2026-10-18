// Runner-owned sandboxed check launcher for custom rounds (spec §3.2(2)):
// contract and oracle checks run under the frozen sandbox policy through a
// wrapper that reports on a runner-provided outcome channel the checked code
// cannot print to. Everything with a failure mode here is runner-owned — the
// round input never supplies code on this path.
import { execFile, spawn } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { PROFILE_IDS } from "../src/config.js";
import { validateOutputSchema } from "../src/output-schema.js";
import { validateTask } from "../src/task.js";
import {
  envelopePayload, oracleSandboxPolicy, projectAttemptTransports, projectWorkerLifecycle,
  readWorkerLifecycleJournal, superviseCli, type WorkerLifecycleEvidence
} from "./live-acceptance.js";

export type CheckOutcome =
  | { status: "pass" }
  | { status: "failed" }
  | { status: "infrastructure"; reason: "spawn-error" | "signal" | "timeout" | "missing-outcome" | "entry-load" | "aborted" };

// The wrapper the runner ships into every check: importing the entry IS the
// check — a thrown error is the assertion failure — and only this wrapper
// writes the outcome, through fd 3: a pipe the runner owns and the entry has
// no ordinary way to print to, so a forged marker on stdout can never
// masquerade as the wrapper's record (spec §3.2(2): a runner-provided outcome
// path, not stdout inference). A module that fails to even load — syntax
// error or unresolved import — is broken machinery rather than a failed
// assertion, so it records a load error the launcher grades infrastructure.
// Contracts are runner-authored trusted code; an entry deliberately throwing
// a SyntaxError instance to pose as a parse failure is out of scope.
export const CHECK_WRAPPER_SOURCE = `import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [entry] = process.argv.slice(2);
let record;
try {
  await import(pathToFileURL(entry).href);
  record = { pass: true };
} catch (error) {
  const load = error instanceof SyntaxError
    || (typeof error?.code === "string" && error.code.startsWith("ERR_MODULE_"));
  record = load ? { pass: false, load: true } : { pass: false };
}
writeSync(3, "__TURNHELM_CHECK_OUTCOME__" + JSON.stringify(record) + "\\n");
process.exit(0);
`;

const CHECK_MARKER = "__TURNHELM_CHECK_OUTCOME__";
const OUTCOME_CAP_BYTES = 8192;
const TERM_GRACE_MS = 2000;
const SETTLEMENT_GRACE_MS = 1000;

// The node read closure must never climb out of the node installation
// prefix: a blind ancestor walk from a home-resident node (~/.nvm,
// ~/Downloads) would hand the sandbox every credential under the user's home
// directory. Climbing therefore stops at the first ancestor whose name is
// not an installation-layout name — bin/lib/libexec/Cellar/versions/
// node-*/v24.5.0/homebrew/local and friends — so an nvm node grants only
// inside ~/.nvm, a downloaded tarball only its own extracted tree, and a
// homebrew node the brew layout root. ponytail: an exotic prefix with
// non-layout names (volta's ~/.volta) adds itself via allowReadSubpaths.
const INSTALL_LAYOUT_NAMES = new Set(["bin", "sbin", "lib", "lib64", "libexec", "share",
  "include", "etc", "common", "doc", "docs", "man", "Cellar", "versions", "node_modules",
  "local", "homebrew", "opt"]);
const isInstallLayoutName = (name: string): boolean =>
  INSTALL_LAYOUT_NAMES.has(name) || /^v?\d+(\.\d+)*$/.test(name) || name.startsWith("node");

export const nodeReadClosure = (start: string): string[] => {
  const granted: string[] = [];
  for (let path = dirname(start), depth = 0; depth < 5 && path !== dirname(path); path = dirname(path), depth++) {
    if (depth > 0 && !isInstallLayoutName(basename(path))) break;
    granted.push(path);
  }
  return granted;
};

export async function runSandboxedCheck(options: {
  sandboxExecPath: string;
  runtimeDir: string;
  cwd: string;
  entryScript: string;
  allowReadSubpaths: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CheckOutcome> {
  const nonce = randomBytes(12).toString("hex");
  const profilePath = join(options.runtimeDir, `check-profile-${nonce}.sb`);
  const wrapperPath = join(options.runtimeDir, `check-wrapper-${nonce}.mjs`);
  // Policy bytes exist only for this invocation: generated in memory, written
  // to a launcher-managed temp file, deleted in the finally below — nothing
  // persists to go stale and no byte-equality tautology is possible. The
  // child's cwd and the node installation are readable by construction: node
  // cannot even boot without its cwd (the v0.3.0 EPERM uv_cwd crash shape),
  // and a package-manager node's dyld closure spans its whole install prefix
  // (homebrew resolves into a Cellar tree whose dylibs live in sibling formula
  // dirs like /opt/homebrew/opt/llhttp). SBPL subpaths match literally, so
  // every readable path is canonicalized first — a symlinked prefix (/tmp,
  // /var) would otherwise never match its kernel-resolved form
  // (/private/tmp, /private/var).
  const nodeReal = await realpath(process.execPath);
  const nodeClosure: string[] = [];
  for (const start of new Set([process.execPath, nodeReal])) nodeClosure.push(...nodeReadClosure(start));
  await writeFile(profilePath, oracleSandboxPolicy({
    runtimeDir: await realpath(options.runtimeDir),
    allowReadSubpaths: await Promise.all([...new Set([
      options.cwd,
      ...nodeClosure,
      ...options.allowReadSubpaths
    ])].map(path => realpath(path)))
  }), { mode: 0o600 });
  await writeFile(wrapperPath, CHECK_WRAPPER_SOURCE, { mode: 0o600 });
  try {
    return await new Promise<CheckOutcome>(resolve => {
      // The sealed round's fresh allowlist env (business-run.mjs contract()):
      // the check's credential boundary is what this env carries, not what
      // the sandbox hides.
      const env = {
        PATH: dirname(process.execPath) + ":/usr/bin:/bin",
        HOME: options.cwd,
        ZDOTDIR: join(options.cwd, ".turnhelm"),
        TMPDIR: options.cwd,
        LANG: "C",
        TZ: "UTC",
        // A fresh allowlist means fresh here too: without this own property
        // Node reinserts the parent's coverage instrumentation into the
        // sandboxed check, whose kill paths can leave a truncated file.
        NODE_V8_COVERAGE: undefined
      };
      const child = spawn(options.sandboxExecPath,
        ["-f", profilePath, process.execPath, wrapperPath, options.entryScript],
        { cwd: options.cwd, env, stdio: ["ignore", "ignore", "ignore", "pipe"] });
      const outcome = child.stdio[3] as Readable | null;
      let outcomeBytes = 0;
      let outcomeLine = "";
      let spawnErrored = false;
      let timedOut = false;
      let aborted = false;
      let resolved = false;
      const onAbort = (): void => {
        aborted = true;
        killLater();
        finish({ status: "infrastructure", reason: "aborted" });
      };
      const finish = (result: CheckOutcome): void => {
        if (resolved) return;
        resolved = true;
        options.signal?.removeEventListener("abort", onAbort);
        outcome?.destroy();
        resolve(result);
      };
      // The kill ladder is deliberately never cancelled by finish: a child
      // that already settled its outcome still gets its TERM→KILL cleanup.
      const killLater = (): void => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS).unref();
      };
      // An explicit outcome record is graded normally; a spawn error, abort,
      // death signal, timeout, or any close without a usable record is an
      // integrity stop. Nothing is inferred from exit code alone.
      const classifyRecord = (line: string): CheckOutcome => {
        if (!line.startsWith(CHECK_MARKER)) return { status: "infrastructure", reason: "missing-outcome" };
        try {
          const parsed: unknown = JSON.parse(line.slice(CHECK_MARKER.length));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
          const record = parsed as Record<string, unknown>;
          const keys = Object.keys(record).sort();
          if (keys.length === 1 && keys[0] === "pass" && (record.pass === true || record.pass === false)) {
            return record.pass ? { status: "pass" } : { status: "failed" };
          }
          if (keys.length === 2 && keys[0] === "load" && keys[1] === "pass"
            && record.load === true && record.pass === false) {
            return { status: "infrastructure", reason: "entry-load" };
          }
          throw new Error("shape");
        } catch {
          return { status: "infrastructure", reason: "missing-outcome" };
        }
      };
      outcome?.on("data", (chunk: Buffer) => {
        outcomeBytes += chunk.length;
        // A capped record cannot be parsed honestly, so it fails closed.
        if (outcomeBytes > OUTCOME_CAP_BYTES) {
          finish({ status: "infrastructure", reason: "missing-outcome" });
          killLater();
          return;
        }
        outcomeLine += chunk.toString("utf8");
        const newline = outcomeLine.indexOf("\n");
        if (newline >= 0) finish(classifyRecord(outcomeLine.slice(0, newline)));
      });
      outcome?.on("error", () => {});
      child.on("error", () => {
        spawnErrored = true;
        finish({ status: "infrastructure", reason: "spawn-error" });
      });
      child.on("close", (_code, signal) => {
        if (resolved) return;
        if (spawnErrored) return finish({ status: "infrastructure", reason: "spawn-error" });
        if (aborted) return finish({ status: "infrastructure", reason: "aborted" });
        if (timedOut) return finish({ status: "infrastructure", reason: "timeout" });
        if (signal !== null) return finish({ status: "infrastructure", reason: "signal" });
        finish({ status: "infrastructure", reason: "missing-outcome" });
      });
      setTimeout(() => {
        timedOut = true;
        killLater();
      }, options.timeoutMs).unref();
      // Bounded settlement: a descendant inheriting fd 3 can hold the pipe
      // open past every kill, so the check settles by wall clock, not close.
      setTimeout(() => {
        if (resolved) return;
        finish(aborted
          ? { status: "infrastructure", reason: "aborted" }
          : { status: "infrastructure", reason: timedOut ? "timeout" : "missing-outcome" });
      }, options.timeoutMs + TERM_GRACE_MS + SETTLEMENT_GRACE_MS).unref();
      if (options.signal !== undefined) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  } finally {
    await rm(profilePath, { force: true });
    await rm(wrapperPath, { force: true });
  }
}

// ---------- roster validation and manifest freeze (spec §3.1, §3.4) ----------

// The round input is data only: a JSON roster. No module is imported from it
// and nothing executable is trusted from it — every referenced file is data
// hashed into the manifest and consumed inside the sandbox or as task text.
export type RosterGrading =
  | { mode: "strict-equal"; expected: unknown }
  | { mode: "envelope-equal"; expected: unknown }
  | { mode: "strict-whole-json"; expected: unknown };

export type RosterFiles = { contract?: string; taskFile?: string; hooks?: string[] };

export type RosterCase = {
  id: string;
  kind: "worker-readonly" | "worker-write";
  scope: string;
  task: string;
  transport: "arg" | "stdin-file";
  deadlineMs: number;
  root: string;
  allowedChanges: string[];
  allowedProfiles: string[];
  grading: RosterGrading;
  files: RosterFiles;
  outputSchema?: string;
};

export type Roster = {
  version: 1;
  head: string;
  evidenceRoot: string;
  caps: { classifierRequests: number; workerExecutions: number };
  cases: RosterCase[];
};

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_ROSTER_BYTES = 1 << 20;
const GRADING_MODES = new Set(["strict-equal", "envelope-equal", "strict-whole-json"]);
const PROFILE_SET = new Set<string>(PROFILE_IDS);

const sha256hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const runGit = promisify(execFile);

function rosterFail(reason: string): never {
  throw new Error("roster: " + reason);
}

const expectExactKeys = (value: object, keys: readonly string[], what: string): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    rosterFail(what + " keys must be exactly " + JSON.stringify(expected) + ", saw " + JSON.stringify(actual));
  }
};

const isHex = (value: string, length: number): boolean => new RegExp(`^[0-9a-f]{${length}}$`).test(value);

// The baseline hashes everything execution consumes (spec 3.4), not just the
// harness modules around it: every file built under dist/src plus the runner
// and shared-primitive test modules.
const defaultBaselineFiles = async (): Promise<string[]> => {
  const files: string[] = ["dist/test/custom-round.js", "dist/test/live-acceptance.js"];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(REPO_ROOT, relative), { withFileTypes: true })) {
      const child = relative + "/" + entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk("dist/src");
  return files;
};

const isDirectory = async (path: string, what: string): Promise<void> => {
  const info = await stat(path).catch(() => rosterFail(what + " " + JSON.stringify(path) + " does not exist"));
  if (!info.isDirectory()) rosterFail(what + " " + JSON.stringify(path) + " is not a directory");
};

const isRegularFile = async (path: string, what: string): Promise<void> => {
  const info = await stat(path).catch(() => rosterFail(what + " " + JSON.stringify(path) + " does not exist"));
  if (!info.isFile()) rosterFail(what + " " + JSON.stringify(path) + " is not a regular file");
};

// ---------- consumer-tree freeze (spec 3.1, 3.4) ----------
// The sealed round froze each case's whole consumer tree; live-acceptance.ts
// carries the same discipline but the spec's change boundary freezes that
// file with its tree hash unexported, so this bounded copy is a deliberate
// re-implementation, not drift. Symlinks, FIFOs, oversize files, and oversize
// trees refuse the freeze rather than hashing partially.
const TREE_MAX_ENTRIES = 512;
const TREE_MAX_FILE_BYTES = 1 << 20;
const JOURNAL_RELATIVE = ".turnhelm/routes.jsonl";
// EV-2: the CLI-owned lifecycle journal is the one file besides the routing
// journal the executed CLI may grow — and it may grow past the tree's own
// file budget, because its size is bounded by the reader's cap, not by the
// freeze. Only the exact regular-file leaf is exempt: symlink, FIFO, and
// directory at that path stay refusals, and every other .turnhelm file is
// still ordinary drift.
const LIFECYCLE_JOURNAL_RELATIVE = ".turnhelm/lifecycle.jsonl";

const hashTree = async (root: string): Promise<Map<string, string> | null> => {
  const files = new Map<string, string>();
  const walk = async (relative: string): Promise<boolean> => {
    const entries = await readdir(relative === "" ? root : join(root, relative), { withFileTypes: true })
      .catch(() => null);
    if (entries === null) return false;
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const childRelative = relative === "" ? entry.name : relative + "/" + entry.name;
      const info = await lstat(join(root, childRelative)).catch(() => null);
      if (info === null) return false;
      if (childRelative === LIFECYCLE_JOURNAL_RELATIVE) {
        if (!info.isFile()) return false;
        continue;
      }
      if (info.isDirectory()) {
        if (!(await walk(childRelative))) return false;
      } else {
        if (!info.isFile() || info.size > TREE_MAX_FILE_BYTES || files.size >= TREE_MAX_ENTRIES) return false;
        const bytes = await readFile(join(root, childRelative)).catch(() => null);
        if (bytes === null) return false;
        files.set(childRelative, sha256hex(bytes));
      }
    }
    return true;
  };
  return (await walk("")) ? files : null;
};

// An allowed change is the case's declared allowedChanges plus the routing
// journal the CLI itself appends; anything else that appears, changes, or
// disappears in the consumer tree is drift. Returns the first violating
// relative path, or null when the tree stayed within its allowance.
const treeChangedOutside = (
  before: Map<string, string>,
  after: Map<string, string>,
  allowed: readonly string[]
): string | null => {
  const isAllowed = (path: string): boolean =>
    path === JOURNAL_RELATIVE || allowed.some(prefix => path === prefix || path.startsWith(prefix + "/"));
  for (const [path, digest] of after) {
    if (before.get(path) !== digest && !isAllowed(path)) return path;
  }
  for (const path of before.keys()) {
    if (!after.has(path) && !isAllowed(path)) return path;
  }
  return null;
};

const validateRoster = async (rosterPath: string): Promise<Roster> => {
  const text = await readFile(rosterPath, "utf8")
    .catch((): string => rosterFail("roster file " + JSON.stringify(rosterPath) + " is unreadable"));
  if (Buffer.byteLength(text) > MAX_ROSTER_BYTES) rosterFail("roster exceeds 1 MiB");
  const parseJson = (source: string, what: string): unknown => {
    try {
      return JSON.parse(source);
    } catch {
      rosterFail(what + " is not valid JSON");
    }
  };
  const parsed = parseJson(text, "roster");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) rosterFail("roster must be a JSON object");
  const roster = parsed as Record<string, unknown>;
  expectExactKeys(roster, ["version", "head", "evidenceRoot", "caps", "cases"], "roster");
  if (roster.version !== 1) rosterFail("roster version must be 1");
  const head = roster.head;
  if (typeof head !== "string" || !isHex(head, 40)) rosterFail("roster head must be a 40-hex commit");
  const evidenceRoot = roster.evidenceRoot;
  if (typeof evidenceRoot !== "string" || evidenceRoot === "") rosterFail("roster evidenceRoot must be a nonempty string");
  await isDirectory(evidenceRoot, "roster evidenceRoot");
  const caps = roster.caps;
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) rosterFail("roster caps must be an object");
  expectExactKeys(caps, ["classifierRequests", "workerExecutions"], "roster caps");
  const capsRecord = caps as Record<string, unknown>;
  for (const key of ["classifierRequests", "workerExecutions"] as const) {
    const value = capsRecord[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      rosterFail("roster caps." + key + " must be a nonnegative integer");
    }
  }
  const rawCases = roster.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) rosterFail("roster cases must be a nonempty array");
  const seenIds = new Set<string>();
  for (const raw of rawCases) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) rosterFail("every roster case must be an object");
    const item = raw as Record<string, unknown>;
    // outputSchema is the one optional case key: a case either carries it or
    // omits it, and anything beyond the base set is still refused.
    const caseKeys = ["id", "kind", "scope", "task", "transport", "deadlineMs", "root", "allowedChanges", "allowedProfiles", "grading", "files"];
    if (item.outputSchema !== undefined) caseKeys.push("outputSchema");
    expectExactKeys(item, caseKeys, "case");
    const id = item.id;
    if (typeof id !== "string" || id === "") rosterFail("case id must be a nonempty string");
    if (seenIds.has(id)) rosterFail("case id " + JSON.stringify(id) + " appears more than once");
    seenIds.add(id);
    const where = "case " + JSON.stringify(id);
    const kind = item.kind;
    if (kind !== "worker-readonly" && kind !== "worker-write") rosterFail(where + " kind must be worker-readonly or worker-write");
    const scope = item.scope;
    if (typeof scope !== "string" || scope.trim() === "") rosterFail(where + " scope must be a nonempty string");
    const task = item.task;
    if (typeof task !== "string") rosterFail(where + " task must be a string");
    try {
      validateTask(task);
    } catch (error) {
      rosterFail(where + " task rejected: " + (error as Error).message);
    }
    const transport = item.transport;
    if (transport !== "arg" && transport !== "stdin-file") rosterFail(where + " transport must be arg or stdin-file");
    // DL-1: the case owns its deadline — a bounded wall-clock budget frozen
    // with the manifest, never an execute-time knob.
    const deadlineMs = item.deadlineMs;
    if (typeof deadlineMs !== "number" || !Number.isInteger(deadlineMs)
      || deadlineMs < 5000 || deadlineMs > 3_600_000) {
      rosterFail(where + " deadlineMs must be an integer between 5000 and 3600000");
    }
    const root = item.root;
    if (typeof root !== "string" || root === "") rosterFail(where + " root must be a nonempty string");
    await isDirectory(root, where + " root");
    const allowedChanges = item.allowedChanges;
    if (!Array.isArray(allowedChanges) || allowedChanges.some(v => typeof v !== "string")) {
      rosterFail(where + " allowedChanges must be an array of strings");
    }
    const allowedProfiles = item.allowedProfiles;
    if (!Array.isArray(allowedProfiles) || allowedProfiles.length === 0
      || allowedProfiles.some(v => typeof v !== "string" || !PROFILE_SET.has(v))) {
      rosterFail(where + " allowedProfiles must be a nonempty subset of the six profile ids");
    }
    const grading = item.grading;
    if (typeof grading !== "object" || grading === null || Array.isArray(grading)) rosterFail(where + " grading must be an object");
    expectExactKeys(grading, ["mode", "expected"], where + " grading");
    const mode = (grading as Record<string, unknown>).mode;
    if (typeof mode !== "string" || !GRADING_MODES.has(mode)) {
      rosterFail(where + " grading mode must be strict-equal, envelope-equal, or strict-whole-json");
    }
    const files = item.files;
    if (typeof files !== "object" || files === null || Array.isArray(files)) rosterFail(where + " files must be an object");
    const filesRecord = files as Record<string, unknown>;
    for (const key of Object.keys(filesRecord)) {
      if (key !== "contract" && key !== "taskFile" && key !== "hooks") {
        rosterFail(where + " files key " + JSON.stringify(key) + " is not one of contract/taskFile/hooks");
      }
    }
    const hooks = filesRecord.hooks;
    if (hooks !== undefined && (!Array.isArray(hooks) || hooks.some(v => typeof v !== "string"))) {
      rosterFail(where + " files.hooks must be an array of strings");
    }
    const contract = filesRecord.contract;
    const taskFile = filesRecord.taskFile;
    // Cross-field rules: the transport and kind decide which files may exist,
    // and the task file's bytes must be exactly the case's task text.
    if (kind === "worker-write" && typeof contract !== "string") {
      rosterFail(where + " kind worker-write requires files.contract");
    }
    if (kind === "worker-readonly" && contract !== undefined) {
      rosterFail(where + " kind worker-readonly must not carry files.contract");
    }
    if (transport === "stdin-file" && typeof taskFile !== "string") {
      rosterFail(where + " transport stdin-file requires files.taskFile");
    }
    if (transport === "arg" && taskFile !== undefined) {
      rosterFail(where + " transport arg must not carry files.taskFile");
    }
    if (typeof taskFile === "string") {
      await isRegularFile(taskFile, where + " files.taskFile");
      if (await readFile(taskFile, "utf8") !== task) rosterFail(where + " files.taskFile bytes must equal the case task text");
    }
    if (typeof contract === "string") await isRegularFile(contract, where + " files.contract");
    for (const hook of (hooks as string[] | undefined) ?? []) await isRegularFile(hook, where + " files.hooks entry");
    if (item.outputSchema !== undefined && typeof item.outputSchema !== "string") {
      rosterFail(where + " outputSchema must be a string");
    }
  }
  return roster as unknown as Roster;
};

// The local preflights the sealed freeze ran, now runner-owned: the known-good
// fixture must grade pass, the known-broken one failed (machinery that grades
// everything identically is broken), and the sentinel outside the allowlist
// must die without an outcome — a sandbox that leaks the read would instead
// surface as a readable-sentinel assertion failure.
const runPreflights = async (sandboxExecPath: string): Promise<void> => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "turnhelm-preflight-"));
  const sentinelDir = await mkdtemp(join(tmpdir(), "turnhelm-preflight-sentinel-"));
  try {
    const entries = join(runtimeDir, "entries");
    await mkdir(entries);
    const green = join(entries, "green.mjs");
    const red = join(entries, "red.mjs");
    const sentinelEntry = join(entries, "reads-sentinel.mjs");
    await writeFile(green, "export const green = true;\n");
    await writeFile(red, "throw new Error(\"preflight red fixture\");\n");
    const sentinel = join(sentinelDir, "sentinel.txt");
    await writeFile(sentinel, "SENTINEL\n");
    await writeFile(sentinelEntry, "import { readFileSync } from \"node:fs\";\n"
      + "try {\n  readFileSync(" + JSON.stringify(sentinel) + ");\n"
      + "} catch {\n  process.exit(9);\n}\nthrow new Error(\"sentinel readable\");\n");
    const run = (entryScript: string, allowReadSubpaths: readonly string[]) =>
      runSandboxedCheck({ sandboxExecPath, runtimeDir, cwd: runtimeDir, entryScript, allowReadSubpaths, timeoutMs: 20_000 });
    const preflightFail = (what: string, outcome: CheckOutcome): never => {
      throw new Error("preflight: " + (outcome.status === "infrastructure" ? "infrastructure" : "reference")
        + " " + what + " (" + JSON.stringify(outcome) + ")");
    };
    const greenOutcome = await run(green, [entries]);
    if (greenOutcome.status !== "pass") preflightFail("known-good fixture did not grade pass", greenOutcome);
    const redOutcome = await run(red, [entries]);
    if (redOutcome.status !== "failed") preflightFail("known-broken fixture did not grade failed", redOutcome);
    const sentinelOutcome = await run(sentinelEntry, []);
    if (sentinelOutcome.status !== "infrastructure" || sentinelOutcome.reason !== "missing-outcome") {
      preflightFail("sentinel isolation not enforced", sentinelOutcome);
    }
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(sentinelDir, { recursive: true, force: true });
  }
};

// Freezes the round: validate the data-only roster, verify the pinned HEAD and
// the consumed-file baseline, run local sandboxed preflights, then emit the
// manifest (carrying no profile text) and its human approval request. Prepare
// spawns no classifier and no worker — the manifest's spend block is the
// zero-spend assertion surface.
export async function prepareRound(
  rosterPath: string,
  options?: { sandboxExecPath?: string; baselineFiles?: readonly string[] }
): Promise<{ manifestPath: string; approvalSha256: string }> {
  const roster = await validateRoster(rosterPath);
  let head: string;
  try {
    head = (await runGit("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
  } catch {
    throw new Error("baseline: repo HEAD is not resolvable from " + REPO_ROOT);
  }
  if (head !== roster.head) {
    throw new Error("baseline: repo HEAD " + head + " does not match the roster's pinned head " + roster.head);
  }
  const baselineFiles = options?.baselineFiles ?? await defaultBaselineFiles();
  if (baselineFiles.length === 0) {
    throw new Error("baseline: the consumed-file baseline must not be empty");
  }
  const baseline: { path: string; sha256: string }[] = [];
  for (const relative of [...baselineFiles].sort()) {
    const bytes = await readFile(join(REPO_ROOT, relative)).catch(() => {
      throw new Error("baseline: consumed file " + relative + " is unreadable (is dist built?)");
    });
    baseline.push({ path: relative, sha256: sha256hex(bytes) });
  }
  const sandboxExecPath = options?.sandboxExecPath ?? "/usr/bin/sandbox-exec";
  await runPreflights(sandboxExecPath);
  const evidenceInfo = await stat(roster.evidenceRoot);
  const cases = [];
  for (const item of roster.cases) {
    // SC-1: the schema is validated with the same input-boundary check the CLI
    // runs, so a roster whose schema the CLI would refuse never freezes — no
    // manifest, no spend. Fixed wording only; schema content never reaches it.
    if (item.outputSchema !== undefined) {
      const schema = validateOutputSchema(item.outputSchema);
      if ("error" in schema) rosterFail("case " + JSON.stringify(item.id) + " outputSchema " + schema.error);
    }
    const rootInfo = await stat(item.root);
    const tree = await hashTree(item.root);
    if (tree === null) {
      rosterFail("case " + JSON.stringify(item.id)
        + " root tree cannot be frozen (oversize, unreadable, or non-regular file)");
    }
    const files: { role: string; path: string; sha256: string; dev: number; ino: number }[] = [];
    const addFile = async (role: string, path: string): Promise<void> => {
      const info = await stat(path);
      files.push({ role, path, sha256: sha256hex(await readFile(path)), dev: info.dev, ino: info.ino });
    };
    if (item.files.contract !== undefined) await addFile("contract", item.files.contract);
    if (item.files.taskFile !== undefined) await addFile("taskFile", item.files.taskFile);
    for (const hook of item.files.hooks ?? []) await addFile("hook", hook);
    files.sort((a, b) => (a.path === b.path ? (a.role < b.role ? -1 : 1) : (a.path < b.path ? -1 : 1)));
    // Preflight the final roster's own contracts (spec 3.1): a contract the
    // machinery cannot even load refuses the freeze. A contract that loads
    // and fails its assertion is acceptable — on the pristine root a
    // post-run contract legitimately fails before the worker has run.
    if (item.files.contract !== undefined) {
      const runtimeDir = await mkdtemp(join(tmpdir(), "turnhelm-contract-preflight-"));
      try {
        const outcome = await runSandboxedCheck({
          sandboxExecPath, runtimeDir, cwd: await realpath(item.root),
          entryScript: item.files.contract,
          allowReadSubpaths: [item.root, dirname(item.files.contract)], timeoutMs: 20_000
        });
        if (outcome.status === "infrastructure") {
          throw new Error("preflight: contract " + JSON.stringify(item.id) + " " + outcome.reason);
        }
      } finally {
        await rm(runtimeDir, { recursive: true, force: true });
      }
    }
    let outputSchema: { path: string; sha256: string; dev: number; ino: number } | undefined;
    if (item.outputSchema !== undefined) {
      const schemaInfo = await stat(item.outputSchema);
      outputSchema = { path: item.outputSchema, sha256: sha256hex(await readFile(item.outputSchema)),
        dev: schemaInfo.dev, ino: schemaInfo.ino };
    }
    cases.push({
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      task: item.task,
      transport: item.transport,
      deadlineMs: item.deadlineMs,
      root: { canonical: await realpath(item.root), dev: rootInfo.dev, ino: rootInfo.ino },
      allowedChanges: item.allowedChanges,
      allowedProfiles: item.allowedProfiles,
      grading: item.grading,
      tree: Object.fromEntries(tree),
      files,
      outputSchema
    });
  }
  const manifest = {
    version: 1,
    kind: "custom-round" as const,
    head,
    baseline: { files: baseline },
    runtime: { node: process.version, execPath: await realpath(process.execPath) },
    evidenceRoot: { canonical: await realpath(roster.evidenceRoot), dev: evidenceInfo.dev, ino: evidenceInfo.ino },
    caps: roster.caps,
    spend: { classifierRequests: 0, workerExecutions: 0 },
    cases
  };
  const manifestPath = join(roster.evidenceRoot, "custom-round-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  const approvalSha256 = sha256hex(await readFile(manifestPath));
  await writeFile(join(roster.evidenceRoot, "custom-round-approval.txt"),
    "custom-round execute <manifest> <sha256>\nmanifest: " + manifestPath + "\nsha256: " + approvalSha256 + "\n",
    { mode: 0o600 });
  return { manifestPath, approvalSha256 };
}

// ---------- gated execute (spec §3.2(1), §3.3, §3.4, §3.5) ----------

type RoundCase = {
  id: string;
  kind: "worker-readonly" | "worker-write";
  task: string;
  transport: "arg" | "stdin-file";
  deadlineMs: number;
  root: { canonical: string; dev: number; ino: number };
  allowedChanges: string[];
  allowedProfiles: string[];
  grading: { mode: string; expected: unknown };
  tree: Record<string, string>;
  files: { role: string; path: string; sha256: string; dev: number; ino: number }[];
  outputSchema?: { path: string; sha256: string; dev: number; ino: number };
};

type RoundManifest = {
  version: number;
  kind: string;
  head: string;
  baseline: { files: { path: string; sha256: string }[] };
  runtime: { node: string; execPath: string };
  evidenceRoot: { canonical: string; dev: number; ino: number };
  caps: { classifierRequests: number; workerExecutions: number };
  cases: RoundCase[];
};

const CLI_PATH = join(REPO_ROOT, "dist", "src", "cli.js");
// DL-1: the default case deadline a roster may freeze when it wants the
// standard budget; every case carries its own explicit deadlineMs either way.
export const DEFAULT_CASE_DEADLINE_MS = 240_000;
const CONTRACT_TIMEOUT_MS = 20_000;
const JOURNAL_CAP_BYTES = 1 << 20;
const SCRUBBED_ENV_KEYS = ["TURNHELM_ALLOW_HOSTED_JEV", "TYPESAFE_API_KEY", "LAYA_API_KEY", "OPENAI_API_KEY",
  "BASH_ENV", "ENV", "TURNHELM_CONFIG"] as const;

const shQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

// The manifest is the runner's own hash-approved artifact, so the parse gate
// is a bounded shape check, not a second roster validation.
const parseRoundManifest = (bytes: Buffer): RoundManifest | null => {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as RoundManifest;
    if (value.version !== 1 || value.kind !== "custom-round" || !Array.isArray(value.cases)) return null;
    if (typeof value.head !== "string" || !Array.isArray(value.baseline?.files)) return null;
    if (typeof value.runtime?.node !== "string" || typeof value.runtime?.execPath !== "string") return null;
    if (typeof value.evidenceRoot?.canonical !== "string"
      || !Number.isInteger(value.evidenceRoot?.dev) || !Number.isInteger(value.evidenceRoot?.ino)) return null;
    if (!Number.isInteger(value.caps?.classifierRequests) || !Number.isInteger(value.caps?.workerExecutions)
      || value.caps.classifierRequests < 0 || value.caps.workerExecutions < 0) return null;
    for (const item of value.cases) {
      if (typeof item?.id !== "string" || typeof item?.task !== "string"
        || (item.transport !== "arg" && item.transport !== "stdin-file")
        || typeof item.deadlineMs !== "number" || !Number.isInteger(item.deadlineMs)
        || item.deadlineMs < 5000 || item.deadlineMs > 3_600_000
        || (item.kind !== "worker-readonly" && item.kind !== "worker-write")
        || typeof item.root?.canonical !== "string"
        || !Number.isInteger(item.root?.dev) || !Number.isInteger(item.root?.ino)
        || typeof item.grading?.mode !== "string" || !Array.isArray(item.files)
        || !item.files.every((file: { path?: unknown; sha256?: unknown; dev?: unknown; ino?: unknown }) =>
          typeof file?.path === "string" && typeof file?.sha256 === "string"
          && Number.isInteger(file?.dev) && Number.isInteger(file?.ino))
        || !Array.isArray(item.allowedChanges) || item.allowedChanges.some(v => typeof v !== "string")
        || !Array.isArray(item.allowedProfiles) || item.allowedProfiles.length === 0
        || item.allowedProfiles.some(v => typeof v !== "string")
        || typeof item.tree !== "object" || item.tree === null || Array.isArray(item.tree)
        || !Object.values(item.tree).every(v => typeof v === "string")
        || (item.outputSchema !== undefined
          && (typeof item.outputSchema?.path !== "string" || typeof item.outputSchema?.sha256 !== "string"
            || !Number.isInteger(item.outputSchema?.dev) || !Number.isInteger(item.outputSchema?.ino)))) return null;
    }
    return value;
  } catch {
    return null;
  }
};

const jsonDeepEquals = (actual: unknown, expected: unknown): boolean => {
  try {
    deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
};

// Spec §3.2(3): envelope-equal reads the first-line payload with inert trailer
// lines; both strict modes parse the whole stdout and deep-compare. The two
// strict names freeze the v0.3.0 primitive and the strict-only contract
// separately — no observable distinction between them is specified.
const gradeOutput = (mode: string, stdout: string, expected: unknown): boolean => {
  if (mode === "envelope-equal") {
    const payload = envelopePayload(stdout);
    return payload !== null && jsonDeepEquals(payload.value, expected);
  }
  try {
    return jsonDeepEquals(JSON.parse(stdout), expected);
  } catch {
    return false;
  }
};

// The case journal is evidence, never a gate: a missing or malformed journal
// degrades to null and the case still grades on its captured output.
const readCaseJournal = async (root: string, taskHash: string): Promise<Record<string, unknown> | null> => {
  const text = await readFile(join(root, ".turnhelm", "routes.jsonl"), "utf8").catch(() => null);
  if (text === null || Buffer.byteLength(text) > JOURNAL_CAP_BYTES) return null;
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.taskSha256 === taskHash) return parsed;
    } catch { /* a malformed line is skipped, never fatal */ }
  }
  return null;
};

// Spec §3.5: the CLI child gets the runner's env minus the sealed denylist —
// a scrub, not the fresh allowlist the sandboxed checks receive.
const scrubbedCliEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...base };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
};

// Spec §3.3: auth, rate-limit, and usage-limit worker failures stop all
// remaining spend. The CLI's receipt is the only sanctioned attribution
// surface — the frozen class, never raw error text.
const STOP_FAILURE_CLASSES = new Set(["auth", "rate-limit", "usage-limit"]);

const receiptFailureClass = (stderr: Buffer): string | null => {
  for (const line of stderr.toString("utf8").split("\n")) {
    if (!line.includes("turnhelm.receipt")) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; worker?: { failureClass?: unknown } };
      if (parsed.type !== "turnhelm.receipt") continue;
      if (typeof parsed.worker?.failureClass === "string") return parsed.worker.failureClass;
    } catch { /* not a receipt line */ }
  }
  return null;
};

// PE-1 (§3.6): the bounded payload projection off the CLI receipt — mode and,
// when extracted, trailerBytes. Content-free: no trailer bytes, hashes, or
// value shapes; degraded to absent when the receipt carries no projection.
const WORKER_PAYLOAD_MODES = new Set(["strict", "extracted", "conflict", "unstructured"]);

const receiptWorkerPayload = (stderr: Buffer): { mode: string; trailerBytes?: number } | null => {
  for (const line of stderr.toString("utf8").split("\n")) {
    if (!line.includes("turnhelm.receipt")) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; worker?: { payload?: unknown } };
      if (parsed.type !== "turnhelm.receipt") continue;
      const payload = parsed.worker?.payload;
      if (payload === null || typeof payload !== "object") return null;
      const mode = (payload as { mode?: unknown }).mode;
      if (typeof mode !== "string" || !WORKER_PAYLOAD_MODES.has(mode)) return null;
      const trailerBytes = (payload as { trailerBytes?: unknown }).trailerBytes;
      if (trailerBytes === undefined) return { mode };
      return typeof trailerBytes === "number" && Number.isInteger(trailerBytes) && trailerBytes >= 1
        ? { mode, trailerBytes }
        : { mode };
    } catch { /* not a receipt line */ }
  }
  return null;
};

// Spec §3.5: exactly one receipt per classified run. Zero receipts (a CLI
// that died before classification) or several means the run's own attribution
// is broken, so grading never proceeds on captured stdout alone.
const receiptCount = (stderr: Buffer): number => {
  let count = 0;
  for (const line of stderr.toString("utf8").split("\n")) {
    if (!line.includes("turnhelm.receipt")) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown };
      if (parsed.type === "turnhelm.receipt") count += 1;
    } catch { /* not a receipt line */ }
  }
  return count;
};

// FE-1 (§3): the per-field worker projection off the CLI receipt. The receipt
// legitimately carries keys outside this table (today `payload`); a projection
// that passed them through would not be a projection. Each retained field is
// individually type-checked and dropped alone on failure — never coerced,
// never thrown — and the whole projection is omitted only when the worker
// object is absent/not a record or `status` is outside the frozen enum.
// Bounded scalars only: no error text or stderr bytes reach the ledger
// (errorSha256 is correlation-only), and usage follows VH-3 — partial
// snapshots kept without zero-fill, malformed counters dropped, absent usage,
// the emitted "unreported" literal, and zero surviving counters all project
// to "unreported".
export type WorkerReceiptEvidence = Readonly<{
  status: "not-started" | "completed" | "failed" | "cancelled";
  code?: number;
  durationMs?: number;
  progressEvents?: number;
  ownedShutdown?: boolean;
  usage?: Partial<Record<"input_tokens" | "output_tokens" | "cached_input_tokens" | "reasoning_output_tokens", number>> | "unreported";
  failureClass?: "stream-disconnected" | "rate-limit" | "usage-limit" | "timeout" | "auth" | "overloaded" | "unknown";
  errorSha256?: string;
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  lastEventAgeMs?: number;
}>;

const WORKER_STATUSES = new Set(["not-started", "completed", "failed", "cancelled"]);
const WORKER_FAILURE_CLASSES = new Set([
  "stream-disconnected", "rate-limit", "usage-limit", "timeout", "auth", "overloaded", "unknown"
]);
const WORKER_SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const USAGE_COUNTERS = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"] as const;

const workerUsageEvidence = (usage: unknown): Exclude<WorkerReceiptEvidence["usage"], undefined> => {
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

export function projectWorkerReceipt(worker: unknown): WorkerReceiptEvidence | undefined {
  if (typeof worker !== "object" || worker === null || Array.isArray(worker)) return undefined;
  const record = worker as Record<string, unknown>;
  if (typeof record.status !== "string" || !WORKER_STATUSES.has(record.status)) return undefined;
  const projection: {
    status: WorkerReceiptEvidence["status"];
    code?: number;
    durationMs?: number;
    progressEvents?: number;
    ownedShutdown?: boolean;
    usage: Exclude<WorkerReceiptEvidence["usage"], undefined>;
    failureClass?: NonNullable<WorkerReceiptEvidence["failureClass"]>;
    errorSha256?: string;
    signal?: NonNullable<WorkerReceiptEvidence["signal"]>;
    lastEventAgeMs?: number;
  } = { status: record.status as WorkerReceiptEvidence["status"], usage: workerUsageEvidence(record.usage) };
  const { code, durationMs, progressEvents, ownedShutdown, failureClass, errorSha256, signal, lastEventAgeMs } = record;
  // Zeros are observations, not placeholders: a run that decoded no frames
  // keeps its progressEvents: 0 — distinguishable from an absent count, the
  // distinction spec §4's adjudication leans on.
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) projection.code = code;
  if (typeof durationMs === "number" && Number.isSafeInteger(durationMs) && durationMs >= 0) {
    projection.durationMs = durationMs;
  }
  if (typeof progressEvents === "number" && Number.isSafeInteger(progressEvents) && progressEvents >= 0) {
    projection.progressEvents = progressEvents;
  }
  if (typeof ownedShutdown === "boolean") projection.ownedShutdown = ownedShutdown;
  if (typeof failureClass === "string" && WORKER_FAILURE_CLASSES.has(failureClass)) {
    projection.failureClass = failureClass as WorkerReceiptEvidence["failureClass"];
  }
  if (typeof errorSha256 === "string" && SHA256_HEX.test(errorSha256)) projection.errorSha256 = errorSha256;
  if (typeof signal === "string" && WORKER_SIGNALS.has(signal)) {
    projection.signal = signal as WorkerReceiptEvidence["signal"];
  }
  if (typeof lastEventAgeMs === "number" && Number.isSafeInteger(lastEventAgeMs) && lastEventAgeMs >= 0) {
    projection.lastEventAgeMs = lastEventAgeMs;
  }
  return projection;
}

// The single receipt's `worker` value, through the same line-scan discipline
// as receiptFailureClass: the first parseable receipt line wins, anything
// else degrades to undefined.
const receiptWorkerObject = (stderr: Buffer): unknown => {
  for (const line of stderr.toString("utf8").split("\n")) {
    if (!line.includes("turnhelm.receipt")) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; worker?: unknown };
      if (parsed.type !== "turnhelm.receipt") continue;
      return parsed.worker;
    } catch { /* not a receipt line */ }
  }
  return undefined;
};

// The ledger carries journal values only through a fixed whitelist: a forged
// or malformed journal line degrades to null instead of reaching the evidence
// record. Backend ids mirror config v1's two backends.
const BACKEND_IDS = new Set(["laya", "jev"]);
const journalString = (value: unknown, allowed: ReadonlySet<string>): string | null =>
  typeof value === "string" && allowed.has(value) ? value : null;

// The same bounded oracle-input retention the live harness froze (64 KiB of
// UTF-8): each judged case keeps the bytes its grading consumed.
const ORACLE_INPUT_CAP_BYTES = 1 << 16;

// The gated run: approval hash, evidence-root identity, runtime and baseline
// re-verification, an exclusive-create claim, then per case identity-before-
// spend, one supervised CLI run, declarative grading, the sandboxed contract
// check for worker-write, and bounded evidence records. Exit codes (spec
// §3.3): 0 all-pass, 4 complete-with-failures, 1 structural, 130 SIGINT,
// 143 SIGTERM.
export async function executeRound(
  manifestPath: string,
  approvedSha256: string,
  options?: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; sandboxExecPath?: string }>
): Promise<number> {
  // Signal ladder (spec §3.3): the first SIGINT stops gracefully — the owned
  // CLI child is signalled through its supervision abort path and the round
  // settles with 130 — while SIGTERM settles with 143 after the same child
  // cleanup. A caller-supplied signal feeds the same controller.
  const controller = new AbortController();
  const relayAbort = (): void => { controller.abort(); };
  if (options?.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", relayAbort, { once: true });
  }
  let terminated = false;
  const onInterrupt = (): void => { controller.abort(); };
  const onTerminate = (): void => { terminated = true; controller.abort(); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const signal = controller.signal;
  try {
    return await runGatedRound(manifestPath, approvedSha256, options, signal, () => terminated);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    options?.signal?.removeEventListener("abort", relayAbort);
  }
}

const baselineDrifted = async (manifest: RoundManifest): Promise<boolean> => {
  for (const file of manifest.baseline.files) {
    const fileBytes = await readFile(join(REPO_ROOT, file.path)).catch(() => null);
    if (fileBytes === null || sha256hex(fileBytes) !== file.sha256) return true;
  }
  return false;
};

// Identity before spend (spec §3.2(1)): canonical path plus dev/ino — the
// check that catches same-path replacement. One shared gate serves both the
// pre-launch check and the settled-tree verification (spec §4): hashTree
// proves content only, so a root rebuilt with byte-identical content is
// still a replacement.
const rootIdentityMatches = async (
  root: Readonly<{ canonical: string; dev: number; ino: number }>
): Promise<boolean> => {
  const info = await stat(root.canonical).catch(() => null);
  return info !== null && info.dev === root.dev && info.ino === root.ino
    && await realpath(root.canonical).catch(() => "") === root.canonical;
};

// OR-1 (spec §3.3): a roster-referenced oracle file is its filesystem
// identity, not its pathname or bytes — dev/ino beside the frozen hash, so a
// same-path byte-identical replacement never passes once identity is frozen.
const fileIdentityMatches = async (
  frozen: Readonly<{ path: string; sha256: string; dev: number; ino: number }>
): Promise<boolean> => {
  const info = await stat(frozen.path).catch(() => null);
  if (info === null || info.dev !== frozen.dev || info.ino !== frozen.ino) return false;
  const bytes = await readFile(frozen.path).catch(() => null);
  return bytes !== null && sha256hex(bytes) === frozen.sha256;
};

async function runGatedRound(
  manifestPath: string,
  approvedSha256: string,
  options: Readonly<{ env?: NodeJS.ProcessEnv; sandboxExecPath?: string }> | undefined,
  signal: AbortSignal,
  terminated: () => boolean
): Promise<number> {
  const bytes = await readFile(manifestPath).catch(() => null);
  if (bytes === null || sha256hex(bytes) !== approvedSha256) return 1;
  const manifest = parseRoundManifest(bytes);
  if (manifest === null) return 1;
  // The caps froze with the manifest: planned spend above them is refused
  // before any identity work, claim, or launch (spec §3.3, §3.6).
  if (manifest.cases.length > manifest.caps.workerExecutions
    || manifest.cases.length > manifest.caps.classifierRequests) return 1;
  // Relocated manifest: the exclusive-create claim only holds at the frozen
  // evidence root, so the manifest directory's own dev/ino identity is the
  // gate — a byte-identical copy elsewhere never reaches the claim.
  const manifestDir = dirname(manifestPath);
  const dirInfo = await stat(manifestDir).catch(() => null);
  if (dirInfo === null || dirInfo.dev !== manifest.evidenceRoot.dev || dirInfo.ino !== manifest.evidenceRoot.ino
    || await realpath(manifestDir).catch(() => "") !== manifest.evidenceRoot.canonical) return 1;
  if (process.version !== manifest.runtime.node || await realpath(process.execPath) !== manifest.runtime.execPath) return 1;
  let head: string;
  try {
    head = (await runGit("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).stdout.trim();
  } catch {
    return 1;
  }
  if (head !== manifest.head) return 1;
  if (await baselineDrifted(manifest)) return 1;
  const ledgerPath = join(manifestDir, "custom-round-evidence.jsonl");
  const appendEvidence = async (record: Record<string, unknown>): Promise<void> => {
    await appendFile(ledgerPath, JSON.stringify(record) + "\n");
  };
  const claim = await open(ledgerPath, "wx", 0o600).catch(() => null);
  if (claim === null) return 1;
  await claim.close();
  try {
    await appendEvidence({ phase: "prepared", head, startedAt: new Date().toISOString() });
  } catch {
    return 1;
  }

  const env = scrubbedCliEnv(options?.env ?? process.env);
  const sandboxExecPath = options?.sandboxExecPath ?? "/usr/bin/sandbox-exec";
  // Written outcomes (spec §5): an outcome counts only once its case record
  // is on the ledger, so the completed record and the exit code reconcile
  // what was actually written, never what was planned.
  const writtenOutcomes: ("pass" | "failed" | "timeout")[] = [];
  for (const item of manifest.cases) {
    if (signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }
    // The consumed baseline re-verifies before every reservation: executed
    // code swapped mid-round is drift even when the running case booted first.
    if (await baselineDrifted(manifest)) {
      await appendEvidence({ phase: "stopped", caseId: item.id, reason: "baseline" }).catch(() => {});
      return 1;
    }
    // Identity before spend (spec §3.2(1)): canonical path plus dev/ino — the
    // check that catches same-path replacement — every pinned case file still
    // hashes to its frozen bytes, and the consumer tree still matches its
    // frozen snapshot (only the routing journal is exempt, and nothing may
    // have changed yet: the worker that legitimately writes runs only after
    // this gate).
    const frozenTree = new Map(Object.entries(item.tree));
    let stopReason: string | null = null;
    if (!(await rootIdentityMatches(item.root))) {
      stopReason = "root-identity";
    } else {
      for (const file of item.files) {
        const info = await stat(file.path).catch(() => null);
        if (info === null) {
          stopReason = "case-files";
          break;
        }
        const fileBytes = await readFile(file.path).catch(() => null);
        if (fileBytes === null || sha256hex(fileBytes) !== file.sha256) {
          stopReason = "case-files";
          break;
        }
        if (info.dev !== file.dev || info.ino !== file.ino) {
          stopReason = "oracle-identity";
          break;
        }
      }
      const hasRole = (role: string): boolean => item.files.some(file => file.role === role);
      if ((item.transport === "stdin-file" && !hasRole("taskFile"))
        || (item.kind === "worker-write" && !hasRole("contract"))) stopReason = "case-files";
      if (stopReason === null && item.outputSchema !== undefined) {
        const schema = item.outputSchema;
        const info = await stat(schema.path).catch(() => null);
        const schemaBytes = info === null ? null : await readFile(schema.path).catch(() => null);
        if (info === null || schemaBytes === null || sha256hex(schemaBytes) !== schema.sha256) stopReason = "case-files";
        else if (info.dev !== schema.dev || info.ino !== schema.ino) stopReason = "oracle-identity";
      }
      const launchTree = await hashTree(item.root.canonical);
      if (launchTree === null || treeChangedOutside(frozenTree, launchTree, []) !== null) {
        stopReason = "case-files";
      }
    }
    if (stopReason !== null) {
      await appendEvidence({ phase: "stopped", caseId: item.id, reason: stopReason }).catch(() => {});
      return 1;
    }
    if (signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }
    // The reserved record is the spend gate's own evidence: if it cannot be
    // written, no further case may launch (spec §3.3).
    try {
      await appendEvidence({ phase: "reserved", caseId: item.id });
    } catch {
      return 1;
    }

    // Task transport: arg rides the CLI argv; stdin-file redirects the frozen
    // file into the CLI's stdin through an exec'ing shell (superviseCli wires
    // the child's stdin to "ignore", so the redirect must happen in-shell).
    const writeArgs = item.kind === "worker-write" ? ["--write"] : [];
    // SC-1: the schema rides the CLI flag from its frozen path; the CLI's own
    // input boundary re-validates and stages the bytes into the managed home.
    const schemaArgs = item.outputSchema === undefined ? [] : ["--output-schema", item.outputSchema.path];
    const taskFileEntry = item.files.find(file => file.role === "taskFile");
    const supervision = item.transport === "arg"
      ? { file: process.execPath, args: [CLI_PATH, "run", "--project", item.root.canonical, "--lifecycle", ...writeArgs, ...schemaArgs, "--", item.task] }
      : {
          file: "/bin/sh",
          args: ["-c", ["exec", shQuote(process.execPath), shQuote(CLI_PATH), "run",
            "--project", shQuote(item.root.canonical), "--lifecycle", ...writeArgs.map(shQuote), ...schemaArgs.map(shQuote),
            "<", shQuote(taskFileEntry === undefined ? "" : taskFileEntry.path)].join(" ")]
        };
    // DL-1: each case runs under its own frozen deadline — monotonic clock
    // from CLI spawn to supervision settlement; the cleanup grace stays a
    // separate budget execution can never extend.
    const observation = await superviseCli(supervision.file, supervision.args,
      { env, timeoutMs: item.deadlineMs, signal });
    if (observation.aborted || signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }
    // The projections for every stop this case can record, computed once from
    // the lone receipt: the failure attribution, and — only for a worker that
    // actually executed — the bounded lifecycle timeline the receipt carries.
    const workerObject = receiptCount(observation.stderr) === 1 ? receiptWorkerObject(observation.stderr) : undefined;
    const workerFailure = workerObject === undefined ? undefined : projectWorkerReceipt(workerObject);
    let workerLifecycle: WorkerLifecycleEvidence | undefined;
    if (workerFailure !== undefined && workerFailure.status !== "not-started") {
      try {
        workerLifecycle = projectWorkerLifecycle((workerObject as { lifecycle?: unknown } | undefined)?.lifecycle);
      } catch {
        workerLifecycle = undefined;
      }
    }
    // Unverified cleanup (spec §4): the supervisor may release the pipes
    // without a kill while the CLI still lives; a possibly-live CLI means no
    // further reservation may ever happen.
    if (!observation.cliClosed) {
      await appendEvidence({
        phase: "stopped", caseId: item.id, reason: "cleanup-unverified",
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
      }).catch(() => {});
      return 1;
    }
    // Budget breaches are integrity stops (spec §3.3): grading never reads a
    // capped or truncated stream. Overflow also raises the timeout flag, so
    // it is decided first — a capped stream must never pose as a timeout.
    if (observation.outputOverflow) {
      await appendEvidence({
        phase: "stopped", caseId: item.id, reason: "output-cap",
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
      }).catch(() => {});
      return 1;
    }
    // Exactly one receipt (spec §3.5): a run that receipted zero or several
    // times has no trustworthy attribution, so its stdout is never graded and
    // the stop record carries no projection by definition.
    if (receiptCount(observation.stderr) !== 1) {
      await appendEvidence({ phase: "stopped", caseId: item.id, reason: "receipt" }).catch(() => {});
      return 1;
    }
    // A stopping failure class on the CLI's receipt (spec §3.3) ends the
    // round: auth, rate-limit, and usage-limit failures mean every remaining
    // case would spend against the same broken boundary.
    const failureClass = receiptFailureClass(observation.stderr);
    if (failureClass !== null && STOP_FAILURE_CLASSES.has(failureClass)) {
      await appendEvidence({
        phase: "stopped", caseId: item.id, reason: "worker-" + failureClass,
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
      }).catch(() => {});
      return 1;
    }
    // EV-2: the normal-path journal fallback — only past cleanup, output-cap,
    // receipt, and stop-class gates, and only for a worker that executed. A
    // receipt that lost its timeline (or never carried one) explains itself
    // from the journal the CLI appended, filtered to the supervised pid.
    if (workerLifecycle === undefined && workerFailure !== undefined && workerFailure.status !== "not-started") {
      workerLifecycle = await readWorkerLifecycleJournal(item.root.canonical, observation.pid);
    }
    const taskHash = sha256hex(item.task);
    const journal = await readCaseJournal(item.root.canonical, taskHash);
    const backend = journalString(journal?.backend, BACKEND_IDS);
    const profileId = journalString(journal?.profileId, PROFILE_SET);
    // Transport policy is evidence, never a gate: the same bounded shared
    // projection as the live harness, off the journal's CLI-written attempts.
    const attemptTransports = projectAttemptTransports(journal?.attempts);
    // A wall-clock timeout is an unjudged case outcome, not a stop (spec
    // §3.3): it sits below the receipt and stop-class gates so their evidence
    // is still collected, and nothing may be graded off a half-written state,
    // so a timed-out case never reaches grading or the contract check — the
    // timeout record below replaces the graded one after the settled-tree gate.
    let passed = !observation.timedOut
      && observation.exitCode === 0
      && gradeOutput(item.grading.mode, observation.stdout.toString("utf8"), item.grading.expected);
    // A legal profile outside the case's declared allowance is an engineering
    // failure of the case (spec §3.6): the selection ran, so it is recorded,
    // but the case fails without stopping the roster.
    if (passed && profileId !== null && !item.allowedProfiles.includes(profileId)) passed = false;

    // The worker-write contract runs inside the frozen sandbox, but only for
    // a case whose run otherwise passed — a failed run already fails the case,
    // and asserting a contract against a broken root state would only risk an
    // integrity stop masking the real failure. An infrastructure outcome in
    // the check itself is an integrity stop, an assertion failure is an
    // ordinary case failure (spec §3.2(2)).
    if (passed && item.kind === "worker-write") {
      const contractEntry = item.files.find(file => file.role === "contract");
      // OR-1: identity brackets the sandboxed check over every consumed input
      // the round froze — contract, task file, and hooks alike. Each must be
      // the same filesystem object when the check starts and again before its
      // outcome is accepted; a rebind in that window spends trust in an
      // oracle the round never froze.
      const oracleFilesMatch = async (): Promise<boolean> => {
        for (const file of item.files) {
          if (!(await fileIdentityMatches(file))) return false;
        }
        return true;
      };
      if (contractEntry === undefined || !(await oracleFilesMatch())) {
        await appendEvidence({
          phase: "stopped", caseId: item.id, reason: "oracle-identity",
          ...(workerFailure !== undefined ? { workerFailure } : {}),
          ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
        }).catch(() => {});
        return 1;
      }
      const runtimeDir = await mkdtemp(join(tmpdir(), "turnhelm-round-check-"));
      let contract: CheckOutcome;
      try {
        contract = await runSandboxedCheck({
          sandboxExecPath, runtimeDir, cwd: item.root.canonical,
          entryScript: contractEntry === undefined ? "" : contractEntry.path,
          // The contract file itself is consumed from wherever the roster
          // froze it, which may sit outside the consumer root — the read
          // grant matches the prepare-time preflight (F4's external-contract
          // load path).
          allowReadSubpaths: [item.root.canonical, ...contractEntry === undefined ? [] : [dirname(contractEntry.path)]],
          timeoutMs: CONTRACT_TIMEOUT_MS, signal
        });
      } finally {
        await rm(runtimeDir, { recursive: true, force: true });
      }
      if (!(await oracleFilesMatch())) {
        await appendEvidence({
          phase: "stopped", caseId: item.id, reason: "oracle-identity",
          ...(workerFailure !== undefined ? { workerFailure } : {}),
          ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
        }).catch(() => {});
        return 1;
      }
      // A signal that lands mid-contract settles the round through the signal
      // ladder, never as a contract infrastructure stop.
      if (contract.status === "infrastructure" && contract.reason === "aborted") {
        await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
        return terminated() ? 143 : 130;
      }
      if (contract.status === "infrastructure") {
        await appendEvidence({ phase: "stopped", caseId: item.id, reason: "contract-" + contract.reason }).catch(() => {});
        return 1;
      }
      if (contract.status === "failed") passed = false;
    }
    if (signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }

    // Integrity over semantics (spec §3.3): every completed case re-verifies
    // its consumer tree before the outcome counts — pass or fail — so a worker
    // that wrote outside its allowance stops the round even when its output
    // graded fine. Identity re-checks at the same gate (spec §4): hashTree
    // proves content only, so a root rebuilt with byte-identical content is
    // still a replacement. An unfreezable tree (new symlink, oversize) is
    // drift.
    if (!(await rootIdentityMatches(item.root))) {
      await appendEvidence({
        phase: "stopped", caseId: item.id, reason: "root-identity",
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
      }).catch(() => {});
      return 1;
    }
    const settledTree = await hashTree(item.root.canonical);
    if (settledTree === null || treeChangedOutside(frozenTree, settledTree, item.allowedChanges) !== null) {
      await appendEvidence({
        phase: "stopped", caseId: item.id, reason: "tree-drift",
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
      }).catch(() => {});
      return 1;
    }

    // The timeout outcome: the case spent its reservation and its tree settled
    // within the gate, so it is recorded unjudged — the supervisor's exit code
    // and duration, the journal attribution, the cancelled worker's projection,
    // and no oracle input (nothing was judged) — and the roster continues. The
    // case counts as non-pass in the exit tally.
    if (observation.timedOut) {
      try {
        await appendEvidence({
          phase: "case", caseId: item.id, outcome: "timeout",
          exitCode: observation.exitCode, durationMs: observation.durationMs, taskSha256: taskHash,
          backend, profileId, attemptTransports,
          ...(workerFailure !== undefined ? { workerFailure } : {}),
          ...(workerLifecycle !== undefined ? { workerLifecycle } : {})
        });
      } catch {
        await appendEvidence({ phase: "stopped", caseId: item.id, reason: "evidence-io" }).catch(() => {});
        return 1;
      }
      writtenOutcomes.push("timeout");
      continue;
    }
    const workerPayload = receiptWorkerPayload(observation.stderr);
    // The case record is terminal (spec §5): a ledger that cannot take it has
    // lost the run's evidence, so the round stops instead of recording the
    // outcome on faith.
    try {
      await appendEvidence({
        phase: "case", caseId: item.id, outcome: passed ? "pass" : "failed",
        exitCode: observation.exitCode, durationMs: observation.durationMs, taskSha256: taskHash,
        backend, profileId, attemptTransports,
        ...(workerPayload !== null ? { workerPayload } : {}),
        ...(workerFailure !== undefined ? { workerFailure } : {}),
        ...(workerLifecycle !== undefined ? { workerLifecycle } : {}),
        oracleInput: observation.stdout.subarray(0, ORACLE_INPUT_CAP_BYTES).toString("utf8")
      });
    } catch {
      await appendEvidence({ phase: "stopped", caseId: item.id, reason: "evidence-io" }).catch(() => {});
      return 1;
    }
    writtenOutcomes.push(passed ? "pass" : "failed");
  }
  // A signal discovered after the last append still settles through the
  // signal ladder (spec §5), never as a would-be 0/4.
  if (signal.aborted) {
    await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
    return terminated() ? 143 : 130;
  }
  // The completed record reconciles what was actually written: its counts
  // come from writtenOutcomes, so a stopped run (which returns above) never
  // appends one, and failed + timedOut never exceed the written cases.
  const failed = writtenOutcomes.filter(outcome => outcome === "failed").length;
  const timedOut = writtenOutcomes.filter(outcome => outcome === "timeout").length;
  try {
    await appendEvidence({
      phase: "completed", outcome: failed + timedOut > 0 ? "fail" : "pass",
      cases: manifest.cases.length, failed, timedOut
    });
  } catch {
    return 1;
  }
  return writtenOutcomes.length === manifest.cases.length && writtenOutcomes.every(outcome => outcome === "pass")
    ? 0
    : 4;
}

// ---------- command entry (spec §3.1): prepare and execute modes ----------

// Only act when invoked as the main module; a test importing this file must
// never trip the dispatcher.
const invokedAsMain = async (): Promise<boolean> => {
  if (process.argv[1] === undefined) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

const runEntry = async (argv: readonly string[]): Promise<number> => {
  const usage = "usage: custom-round prepare <roster.json> | execute <manifest.json> <sha256>";
  if (argv[0] === "prepare" && argv.length === 2) {
    try {
      const { manifestPath, approvalSha256 } = await prepareRound(argv[1]);
      process.stdout.write("manifest: " + manifestPath + "\nsha256: " + approvalSha256 + "\n");
      return 0;
    } catch (error) {
      process.stderr.write("prepare refused: " + (error as Error).message + "\n");
      return 1;
    }
  }
  if (argv[0] === "execute" && argv.length === 3) {
    return executeRound(argv[1], argv[2]);
  }
  process.stderr.write(usage + "\n");
  return 1;
};

if (await invokedAsMain()) process.exitCode = await runEntry(process.argv.slice(2));
