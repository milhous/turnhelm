// Runner-owned sandboxed check launcher for custom rounds (spec §3.2(2)):
// contract and oracle checks run under the frozen sandbox policy through a
// wrapper that reports on a runner-provided outcome channel the checked code
// cannot print to. Everything with a failure mode here is runner-owned — the
// round input never supplies code on this path.
import { execFile, spawn } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { PROFILE_IDS } from "../src/config.js";
import { validateTask } from "../src/task.js";
import { envelopePayload, oracleSandboxPolicy, superviseCli } from "./live-acceptance.js";

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
        TZ: "UTC"
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
  root: string;
  allowedChanges: string[];
  allowedProfiles: string[];
  grading: RosterGrading;
  files: RosterFiles;
};

export type Roster = {
  version: 1;
  head: string;
  evidenceRoot: string;
  caps: { classifierRequests: number; workerExecutions: number };
  cases: RosterCase[];
};

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_BASELINE_FILES = ["dist/test/custom-round.js", "dist/test/live-acceptance.js"] as const;
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

const isDirectory = async (path: string, what: string): Promise<void> => {
  const info = await stat(path).catch(() => rosterFail(what + " " + JSON.stringify(path) + " does not exist"));
  if (!info.isDirectory()) rosterFail(what + " " + JSON.stringify(path) + " is not a directory");
};

const isRegularFile = async (path: string, what: string): Promise<void> => {
  const info = await stat(path).catch(() => rosterFail(what + " " + JSON.stringify(path) + " does not exist"));
  if (!info.isFile()) rosterFail(what + " " + JSON.stringify(path) + " is not a regular file");
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
    expectExactKeys(item, ["id", "kind", "scope", "task", "transport", "root", "allowedChanges", "allowedProfiles", "grading", "files"], "case");
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
  const baselineFiles = options?.baselineFiles ?? DEFAULT_BASELINE_FILES;
  const baseline: { path: string; sha256: string }[] = [];
  for (const relative of [...baselineFiles].sort()) {
    const bytes = await readFile(join(REPO_ROOT, relative)).catch(() => {
      throw new Error("baseline: consumed file " + relative + " is unreadable (is dist built?)");
    });
    baseline.push({ path: relative, sha256: sha256hex(bytes) });
  }
  await runPreflights(options?.sandboxExecPath ?? "/usr/bin/sandbox-exec");
  const evidenceInfo = await stat(roster.evidenceRoot);
  const cases = [];
  for (const item of roster.cases) {
    const rootInfo = await stat(item.root);
    const files: { role: string; path: string; sha256: string }[] = [];
    const addFile = async (role: string, path: string): Promise<void> => {
      files.push({ role, path, sha256: sha256hex(await readFile(path)) });
    };
    if (item.files.contract !== undefined) await addFile("contract", item.files.contract);
    if (item.files.taskFile !== undefined) await addFile("taskFile", item.files.taskFile);
    for (const hook of item.files.hooks ?? []) await addFile("hook", hook);
    files.sort((a, b) => (a.path === b.path ? (a.role < b.role ? -1 : 1) : (a.path < b.path ? -1 : 1)));
    cases.push({
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      task: item.task,
      transport: item.transport,
      root: { canonical: await realpath(item.root), dev: rootInfo.dev, ino: rootInfo.ino },
      allowedChanges: item.allowedChanges,
      allowedProfiles: item.allowedProfiles,
      grading: item.grading,
      files
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
  root: { canonical: string; dev: number; ino: number };
  grading: { mode: string; expected: unknown };
  files: { role: string; path: string; sha256: string }[];
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
const CASE_TIMEOUT_MS = 240_000;
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
        || (item.kind !== "worker-readonly" && item.kind !== "worker-write")
        || typeof item.root?.canonical !== "string"
        || !Number.isInteger(item.root?.dev) || !Number.isInteger(item.root?.ino)
        || typeof item.grading?.mode !== "string" || !Array.isArray(item.files)) return null;
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

// The gated run: approval hash, evidence-root identity, runtime and baseline
// re-verification, an exclusive-create claim, then per case identity-before-
// spend, one supervised CLI run, declarative grading, the sandboxed contract
// check for worker-write, and bounded evidence records. Exit codes (spec
// §3.3): 0 all-pass, 4 complete-with-failures, 1 structural, 130 SIGINT,
// 143 SIGTERM.
export async function executeRound(
  manifestPath: string,
  approvedSha256: string,
  options?: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; sandboxExecPath?: string; caseTimeoutMs?: number }>
): Promise<number> {
  // Signal ladder (spec §3.3): the first SIGINT stops gracefully — the owned
  // CLI child is signalled through its supervision abort path and the round
  // settles with 130 — while SIGTERM settles with 143 after the same child
  // cleanup. A caller-supplied signal feeds the same controller.
  const controller = new AbortController();
  if (options?.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
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
  }
}

async function runGatedRound(
  manifestPath: string,
  approvedSha256: string,
  options: Readonly<{ env?: NodeJS.ProcessEnv; sandboxExecPath?: string; caseTimeoutMs?: number }> | undefined,
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
  for (const file of manifest.baseline.files) {
    const fileBytes = await readFile(join(REPO_ROOT, file.path)).catch(() => null);
    if (fileBytes === null || sha256hex(fileBytes) !== file.sha256) return 1;
  }
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
  let failedCases = 0;
  for (const item of manifest.cases) {
    if (signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }
    // Identity before spend (spec §3.2(1)): canonical path plus dev/ino — the
    // check that catches same-path replacement — and every pinned case file
    // still hashes to its frozen bytes.
    let stopReason: string | null = null;
    const rootInfo = await stat(item.root.canonical).catch(() => null);
    if (rootInfo === null || rootInfo.dev !== item.root.dev || rootInfo.ino !== item.root.ino) {
      stopReason = "root-identity";
    } else if (await realpath(item.root.canonical).catch(() => "") !== item.root.canonical) {
      stopReason = "root-identity";
    } else {
      for (const file of item.files) {
        const fileBytes = await readFile(file.path).catch(() => null);
        if (fileBytes === null || sha256hex(fileBytes) !== file.sha256) {
          stopReason = "case-files";
          break;
        }
      }
      const hasRole = (role: string): boolean => item.files.some(file => file.role === role);
      if ((item.transport === "stdin-file" && !hasRole("taskFile"))
        || (item.kind === "worker-write" && !hasRole("contract"))) stopReason = "case-files";
    }
    if (stopReason !== null) {
      await appendEvidence({ phase: "stopped", caseId: item.id, reason: stopReason }).catch(() => {});
      return 1;
    }
    if (signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }
    await appendEvidence({ phase: "reserved", caseId: item.id }).catch(() => {});

    // Task transport: arg rides the CLI argv; stdin-file redirects the frozen
    // file into the CLI's stdin through an exec'ing shell (superviseCli wires
    // the child's stdin to "ignore", so the redirect must happen in-shell).
    const writeArgs = item.kind === "worker-write" ? ["--write"] : [];
    const taskFileEntry = item.files.find(file => file.role === "taskFile");
    const supervision = item.transport === "arg"
      ? { file: process.execPath, args: [CLI_PATH, "run", "--project", item.root.canonical, ...writeArgs, "--", item.task] }
      : {
          file: "/bin/sh",
          args: ["-c", ["exec", shQuote(process.execPath), shQuote(CLI_PATH), "run",
            "--project", shQuote(item.root.canonical), ...writeArgs.map(shQuote),
            "<", shQuote(taskFileEntry === undefined ? "" : taskFileEntry.path)].join(" ")]
        };
    const observation = await superviseCli(supervision.file, supervision.args,
      { env, timeoutMs: options?.caseTimeoutMs ?? CASE_TIMEOUT_MS, signal });
    if (observation.aborted || signal.aborted) {
      await appendEvidence({ phase: "stopped", caseId: null, reason: "signal" }).catch(() => {});
      return terminated() ? 143 : 130;
    }
    // Budget breaches are integrity stops (spec §3.3): grading never reads a
    // capped or truncated stream.
    if (observation.timedOut || observation.outputOverflow) {
      await appendEvidence({
        phase: "stopped", caseId: item.id, reason: observation.timedOut ? "timeout" : "output-cap"
      }).catch(() => {});
      return 1;
    }
    // A stopping failure class on the CLI's receipt (spec §3.3) ends the
    // round: auth, rate-limit, and usage-limit failures mean every remaining
    // case would spend against the same broken boundary.
    const failureClass = receiptFailureClass(observation.stderr);
    if (failureClass !== null && STOP_FAILURE_CLASSES.has(failureClass)) {
      await appendEvidence({ phase: "stopped", caseId: item.id, reason: "worker-" + failureClass }).catch(() => {});
      return 1;
    }

    const taskHash = sha256hex(item.task);
    const journal = await readCaseJournal(item.root.canonical, taskHash);
    let passed = observation.exitCode === 0 && gradeOutput(item.grading.mode, observation.stdout.toString("utf8"), item.grading.expected);

    // The worker-write contract runs inside the frozen sandbox, but only for
    // a case whose run otherwise passed — a failed run already fails the case,
    // and asserting a contract against a broken root state would only risk an
    // integrity stop masking the real failure. An infrastructure outcome in
    // the check itself is an integrity stop, an assertion failure is an
    // ordinary case failure (spec §3.2(2)).
    if (passed && item.kind === "worker-write") {
      const contractEntry = item.files.find(file => file.role === "contract");
      const runtimeDir = await mkdtemp(join(tmpdir(), "turnhelm-round-check-"));
      let contract: CheckOutcome;
      try {
        contract = await runSandboxedCheck({
          sandboxExecPath, runtimeDir, cwd: item.root.canonical,
          entryScript: contractEntry === undefined ? "" : contractEntry.path,
          allowReadSubpaths: [item.root.canonical], timeoutMs: CONTRACT_TIMEOUT_MS
        });
      } finally {
        await rm(runtimeDir, { recursive: true, force: true });
      }
      if (contract.status === "infrastructure") {
        await appendEvidence({ phase: "stopped", caseId: item.id, reason: "contract-" + contract.reason }).catch(() => {});
        return 1;
      }
      if (contract.status === "failed") passed = false;
    }

    if (!passed) failedCases += 1;
    await appendEvidence({
      phase: "case", caseId: item.id, outcome: passed ? "pass" : "failed",
      exitCode: observation.exitCode, durationMs: observation.durationMs, taskSha256: taskHash,
      backend: journal?.backend ?? null, profileId: journal?.profileId ?? null
    });
  }
  return failedCases === 0 ? 0 : 4;
}
