// Runner-owned sandboxed check launcher for custom rounds (spec §3.2(2)):
// contract and oracle checks run under the frozen sandbox policy through a
// wrapper whose single marked outcome line replaces exit-code and stderr
// inference. Everything with a failure mode here is runner-owned — the round
// input never supplies code on this path.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROFILE_IDS } from "../src/config.js";
import { validateTask } from "../src/task.js";
import { oracleSandboxPolicy } from "./live-acceptance.js";

export type CheckOutcome =
  | { status: "pass" }
  | { status: "failed" }
  | { status: "infrastructure"; reason: "spawn-error" | "signal" | "timeout" | "missing-outcome" };

// The wrapper the runner ships into every check: importing the entry IS the
// check — a thrown error is the assertion failure — and only this wrapper
// prints the marked line, exiting immediately after so no pending entry timer
// can print a forged marker behind it.
export const CHECK_WRAPPER_SOURCE = `import { pathToFileURL } from "node:url";
const [entry] = process.argv.slice(2);
try {
  await import(pathToFileURL(entry).href);
  process.stdout.write("__TURNHELM_CHECK_OUTCOME__" + JSON.stringify({ pass: true }) + "\\n");
} catch {
  process.stdout.write("__TURNHELM_CHECK_OUTCOME__" + JSON.stringify({ pass: false }) + "\\n");
}
process.exit(0);
`;

const CHECK_MARKER = "__TURNHELM_CHECK_OUTCOME__";
const STDOUT_CAP_BYTES = 1 << 20;
const TERM_GRACE_MS = 2000;

export async function runSandboxedCheck(options: {
  sandboxExecPath: string;
  runtimeDir: string;
  cwd: string;
  entryScript: string;
  allowReadSubpaths: readonly string[];
  timeoutMs: number;
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
  // dirs like /opt/homebrew/opt/llhttp) — reachable only by walking ancestors,
  // because process.execPath may already be the realpath, not the shim.
  // ponytail: ancestor depth 5 covers homebrew Cellar/<name>/<ver>/bin/node
  // and nvm versions/node/<ver>/bin/node; a deeper layout adds its prefix via
  // allowReadSubpaths. SBPL subpaths match literally, so every readable path
  // is canonicalized first — a symlinked prefix (/tmp, /var) would otherwise
  // never match its kernel-resolved form (/private/tmp, /private/var).
  const nodeReal = await realpath(process.execPath);
  const nodeClosure: string[] = [];
  for (const start of new Set([process.execPath, nodeReal])) {
    for (let path = dirname(start), depth = 0; depth < 5 && path !== dirname(path); path = dirname(path), depth++) {
      nodeClosure.push(path);
    }
  }
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
        { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutCapped = false;
      let spawnErrored = false;
      let timedOut = false;
      let resolved = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (outcome: CheckOutcome): void => {
        if (resolved) return;
        resolved = true;
        for (const timer of timers) clearTimeout(timer);
        resolve(outcome);
      };
      // An explicit outcome record is graded normally; a spawn error, death
      // signal, timeout, or any exit without a usable final marker is an
      // integrity stop. Nothing is inferred from exit code alone.
      const classify = (signal: NodeJS.Signals | null): CheckOutcome => {
        if (spawnErrored) return { status: "infrastructure", reason: "spawn-error" };
        if (timedOut) return { status: "infrastructure", reason: "timeout" };
        if (signal !== null) return { status: "infrastructure", reason: "signal" };
        // Only the final marked line counts: a forged marker printed mid-run
        // cannot outrank the wrapper's last word. A capped buffer cannot
        // prove which marker was final, so it fails closed.
        if (stdoutCapped) return { status: "infrastructure", reason: "missing-outcome" };
        const last = stdout.map(chunk => chunk.toString("utf8")).join("")
          .split("\n").filter(line => line.startsWith(CHECK_MARKER)).at(-1);
        if (last === undefined) return { status: "infrastructure", reason: "missing-outcome" };
        try {
          const parsed: unknown = JSON.parse(last.slice(CHECK_MARKER.length));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
          const record = parsed as Record<string, unknown>;
          if (Object.keys(record).length !== 1 || (record.pass !== true && record.pass !== false)) {
            throw new Error("shape");
          }
          return record.pass ? { status: "pass" } : { status: "failed" };
        } catch {
          return { status: "infrastructure", reason: "missing-outcome" };
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_CAP_BYTES) {
          stdoutCapped = true;
          return;
        }
        stdout.push(chunk);
      });
      // Stderr is drained and discarded: classification never reads it.
      child.stderr.on("data", () => {});
      child.on("error", () => {
        spawnErrored = true;
        finish({ status: "infrastructure", reason: "spawn-error" });
      });
      child.on("close", (_code, signal) => finish(classify(signal)));
      timers.push(setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        timers.push(setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS));
      }, options.timeoutMs));
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
