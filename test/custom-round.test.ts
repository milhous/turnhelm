// Hermetic tests for the custom-round check launcher: the sandbox boundary is
// a path-injected fake that execs its arguments, so every classification path
// runs on every platform CI runs on. Only the darwin-gated test at the bottom
// executes a real seatbelt profile.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareRound, runSandboxedCheck } from "./custom-round.js";

const FORGED_MARKER_LINE = "__TURNHELM_CHECK_OUTCOME__" + JSON.stringify({ pass: true });

const scratch = async (t: TestContext): Promise<{ runtimeDir: string; caseRoot: string; entries: string }> => {
  const dirs = {
    runtimeDir: await mkdtemp(join(tmpdir(), "turnhelm-check-runtime-")),
    caseRoot: await mkdtemp(join(tmpdir(), "turnhelm-check-case-")),
    entries: await mkdtemp(join(tmpdir(), "turnhelm-check-entries-"))
  };
  t.after(() => {
    for (const dir of Object.values(dirs)) rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dirs;
};

const writeFakeSandboxExec = async (t: TestContext, body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-fakesb-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "sandbox-exec");
  await writeFile(path, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
};

const writeEntry = async (directory: string, name: string, source: string): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, source, { mode: 0o644 });
  return path;
};

test("a completing entry passes and a thrown assertion fails", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "completes.mjs", "export const checked = true;\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  }), { status: "pass" });
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "asserts-false.mjs", "throw new Error(\"contract violated\");\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  }), { status: "failed" });
});

test("an entry that dies before any marker is infrastructure, never a grade", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "crashes.mjs", "process.exit(9);\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  }), { status: "infrastructure", reason: "missing-outcome" });
});

test("a missing sandbox-exec binary is a spawn error", async t => {
  const dirs = await scratch(t);
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: join(dirs.runtimeDir, "absent-sandbox-exec"),
    runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "completes.mjs", "export const checked = true;\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  }), { status: "infrastructure", reason: "spawn-error" });
});

test("a child ignoring SIGTERM past the timeout still resolves as timeout", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, "trap '' TERM\nshift 2\n/bin/echo output\nsleep 5");
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "completes.mjs", "export const checked = true;\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 300
  }), { status: "infrastructure", reason: "timeout" });
});

test("a forged marker mid-run never outranks the wrapper's final marker", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  const entry = await writeEntry(dirs.entries, "forged-then-fails.mjs",
    `console.log(${JSON.stringify(FORGED_MARKER_LINE)});\nthrow new Error("real assertion failed");\n`);
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: entry, allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  }), { status: "failed" }, "the final marker is the wrapper's pass:false, not the forged line");
});

test("the check child receives the fresh allowlist env, never the runner's", async t => {
  const dirs = await scratch(t);
  const dump = join(dirs.entries, "env-dump.txt");
  const fake = await writeFakeSandboxExec(t, `shift 2\nenv > "${dump}"\nexec "$@"`);
  const poison = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NODE_PATH: process.env.NODE_PATH,
    TURNHELM_TEST_SYNTHETIC_SECRET: process.env.TURNHELM_TEST_SYNTHETIC_SECRET
  };
  process.env.NODE_OPTIONS = "--max-old-space-size=999";
  process.env.NODE_PATH = "/synthetic/node-modules";
  process.env.TURNHELM_TEST_SYNTHETIC_SECRET = "synthetic-secret";
  t.after(() => {
    for (const [key, original] of Object.entries(poison)) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });
  const outcome = await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "completes.mjs", "export const checked = true;\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  });
  assert.deepEqual(outcome, { status: "pass" });
  const dumped = new Map((await readFile(dump, "utf8")).trim().split("\n")
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  assert.equal(dumped.get("HOME"), dirs.caseRoot);
  assert.equal(dumped.get("TMPDIR"), dirs.caseRoot);
  assert.equal(dumped.get("ZDOTDIR"), join(dirs.caseRoot, ".turnhelm"));
  assert.equal(dumped.get("LANG"), "C");
  assert.equal(dumped.get("TZ"), "UTC");
  assert.equal(dumped.get("PATH"), dirname(process.execPath) + ":/usr/bin:/bin");
  assert.ok(!dumped.has("NODE_OPTIONS"), "NODE_OPTIONS must not reach the check");
  assert.ok(!dumped.has("NODE_PATH"), "NODE_PATH must not reach the check");
  assert.ok(!dumped.has("TURNHELM_TEST_SYNTHETIC_SECRET"), "runner secrets must not reach the check");
});

test("launcher-managed profile and wrapper artifacts never outlive the check", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "completes.mjs", "export const checked = true;\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  });
  assert.deepEqual(await readdir(dirs.runtimeDir), [], "profile and wrapper temp files are deleted");
});

test("real SBPL admits allowed reads and refuses the sentinel outside them",
  { skip: process.platform !== "darwin" }, async t => {
    const dirs = await scratch(t);
    const sentinelDir = await mkdtemp(join(tmpdir(), "turnhelm-check-sentinel-"));
    t.after(() => rm(sentinelDir, { recursive: true, force: true }));
    await writeFile(join(dirs.entries, "data.json"), JSON.stringify({ ok: true }), { mode: 0o644 });
    await writeFile(join(sentinelDir, "sentinel.txt"), "SENTINEL", { mode: 0o644 });
    // A denied read leaves no honest outcome: the entry crashes without a
    // marker so the launcher grades infrastructure, never a forged grade.
    const sentinelEntry = await writeEntry(dirs.entries, "reads-sentinel.mjs",
      `import { readFileSync } from "node:fs";\n`
      + `try {\n  readFileSync(${JSON.stringify(join(sentinelDir, "sentinel.txt"))});\n`
      + `} catch {\n  process.exit(9);\n}\nthrow new Error("sentinel readable");\n`);
    const allowedEntry = await writeEntry(dirs.entries, "reads-allowed.mjs",
      `import { readFileSync } from "node:fs";\n`
      + `if (JSON.parse(readFileSync(${JSON.stringify(join(dirs.entries, "data.json"))}, "utf8")).ok !== true) {\n`
      + `  throw new Error("unexpected bytes");\n}\n`);
    assert.deepEqual(await runSandboxedCheck({
      sandboxExecPath: "/usr/bin/sandbox-exec", runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
      entryScript: allowedEntry, allowReadSubpaths: [dirs.entries], timeoutMs: 20_000
    }), { status: "pass" });
    assert.deepEqual(await runSandboxedCheck({
      sandboxExecPath: "/usr/bin/sandbox-exec", runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
      entryScript: sentinelEntry, allowReadSubpaths: [dirs.entries], timeoutMs: 20_000
    }), { status: "infrastructure", reason: "missing-outcome" });
  });

// ---------- prepareRound: roster validation and manifest freeze ----------

const sha256hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
// assert.rejects with a RegExp tests String(error), prefix "Error:" included;
// this validator pins the message itself instead.
const messageStartingWith = (prefix: string) => (error: unknown): boolean => {
  assert.ok(error instanceof Error && error.message.startsWith(prefix),
    "expected a message starting with " + JSON.stringify(prefix) + ", saw: " + String(error));
  return true;
};
const REPO_ROOT = join(import.meta.dirname, "..", "..");

// The prepare fakes: a passthrough that emulates sandbox denial for the
// sentinel preflight (the one check a real sandbox enforces and a fake must
// act out), and a liar that grades everything failed.
const PREPARE_PASSTHROUGH = 'shift 2\ncase "$*" in *sentinel*) exit 9;; *) exec "$@";; esac';
const PREPARE_ALL_FAIL = `shift 2\nprintf '%s\\n' '__TURNHELM_CHECK_OUTCOME__{"pass":false}'`;

type ScratchRoster = {
  rosterPath: string;
  evidenceRoot: string;
  roster: Record<string, unknown>;
  write: (variant: (roster: Record<string, unknown>) => void) => string;
};

const scratchRoster = async (t: TestContext): Promise<ScratchRoster> => {
  const base = await mkdtemp(join(tmpdir(), "turnhelm-round-"));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const evidenceRoot = join(base, "evidence");
  const rootA = join(base, "case-a");
  const rootB = join(base, "case-b");
  await mkdir(evidenceRoot);
  await mkdir(rootA);
  await mkdir(rootB);
  const taskText = "Sum the ledger rows and print the JSON result.";
  const taskFile = join(base, "task-b.txt");
  await writeFile(taskFile, taskText);
  const contract = join(base, "contract-b.mjs");
  await writeFile(contract, "import assert from \"node:assert/strict\";\nassert.equal(1 + 1, 2);\n");
  const roster = {
    version: 1,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim(),
    evidenceRoot,
    caps: { classifierRequests: 4, workerExecutions: 4 },
    cases: [
      {
        id: "case-a", kind: "worker-readonly", scope: "readonly sum", task: taskText,
        transport: "arg", root: rootA, allowedChanges: [], allowedProfiles: ["fast", "balanced"],
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, files: {}
      },
      {
        id: "case-b", kind: "worker-write", scope: "write envelope", task: taskText,
        transport: "stdin-file", root: rootB, allowedChanges: ["ledger.json"], allowedProfiles: ["deep"],
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        files: { contract, taskFile }
      }
    ]
  };
  const write = (variant: (value: Record<string, unknown>) => void): string => {
    const copy = structuredClone(roster) as Record<string, unknown>;
    variant(copy);
    const path = join(base, "roster-" + randomBytes(4).toString("hex") + ".json");
    writeFileSync(path, JSON.stringify(copy));
    return path;
  };
  return {
    rosterPath: write(() => {}),
    evidenceRoot,
    roster: roster as Record<string, unknown>,
    write
  };
};

test("a valid roster freezes a manifest with the exact baseline and zero spend", async t => {
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const result = await prepareRound(scratch.rosterPath, { sandboxExecPath: fake });
  const manifestPath = join(scratch.evidenceRoot, "custom-round-manifest.json");
  assert.equal(result.manifestPath, manifestPath);
  const bytes = await readFile(manifestPath);
  assert.equal(sha256hex(bytes), result.approvalSha256, "the approval hash is the manifest bytes' hash");
  const manifest = JSON.parse(bytes.toString()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(),
    ["baseline", "caps", "cases", "evidenceRoot", "head", "kind", "runtime", "spend", "version"]);
  assert.equal(manifest.kind, "custom-round");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.head, scratch.roster.head);
  assert.deepEqual(manifest.baseline, {
    files: [
      { path: "dist/test/custom-round.js", sha256: sha256hex(await readFile(join(REPO_ROOT, "dist/test/custom-round.js"))) },
      { path: "dist/test/live-acceptance.js", sha256: sha256hex(await readFile(join(REPO_ROOT, "dist/test/live-acceptance.js"))) }
    ]
  }, "the consumed-file baseline hashes exactly the runner and shared-primitive modules");
  assert.deepEqual(manifest.runtime, {
    node: process.version, execPath: await realpath(process.execPath)
  });
  assert.deepEqual(manifest.spend, { classifierRequests: 0, workerExecutions: 0 },
    "prepare spends nothing: zero classifier requests and zero worker executions");
  assert.deepEqual(manifest.caps, scratch.roster.caps);
  const evidence = manifest.evidenceRoot as { canonical: string; dev: number; ino: number };
  assert.equal(evidence.canonical, await realpath(scratch.evidenceRoot));
  assert.ok(Number.isInteger(evidence.dev) && evidence.dev > 0);
  assert.ok(Number.isInteger(evidence.ino) && evidence.ino > 0);
  const cases = manifest.cases as Record<string, unknown>[];
  assert.equal(cases.length, 2);
  for (const item of cases) {
    assert.deepEqual(Object.keys(item).sort(),
      ["allowedChanges", "allowedProfiles", "files", "grading", "id", "kind", "root", "scope", "task", "transport"]);
    const root = item.root as { canonical: string; dev: number; ino: number };
    assert.ok(Number.isInteger(root.ino) && root.ino > 0, "the case root is pinned by dev/ino identity");
  }
  assert.deepEqual((cases[1].files as { role: string; sha256: string }[]).map(f => f.role).sort(),
    ["contract", "taskFile"]);
  const contract = (scratch.roster.cases as Record<string, unknown>[])[1];
  const files = contract.files as { contract: string; taskFile: string };
  const manifestFiles = cases[1].files as { role: string; path: string; sha256: string }[];
  for (const role of ["contract", "taskFile"] as const) {
    const entry = manifestFiles.find(f => f.role === role);
    assert.equal(entry?.sha256, sha256hex(await readFile(files[role])), role + " bytes are hashed into the manifest");
  }
  const approval = await readFile(join(scratch.evidenceRoot, "custom-round-approval.txt"), "utf8");
  assert.ok(approval.includes(result.approvalSha256), "the approval request carries the hash a human approves");
  assert.ok(approval.includes(manifestPath));
});

test("an invalid roster is refused with no manifest written", async t => {
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const variants: readonly [string, (roster: Record<string, unknown>) => void][] = [
    ["unknown top-level key", roster => { (roster as Record<string, unknown>).extra = 1; }],
    ["oversize task", roster => {
      (roster as { cases: { task: string }[] }).cases[0].task = "x".repeat(9000);
    }],
    ["blank task", roster => {
      (roster as { cases: { task: string }[] }).cases[0].task = "   ";
    }],
    ["missing consumer root", roster => {
      (roster as { cases: { root: string }[] }).cases[0].root = join(scratch.evidenceRoot, "absent");
    }]
  ];
  for (const [what, mutate] of variants) {
    const path = scratch.write(mutate);
    await assert.rejects(prepareRound(path, { sandboxExecPath: fake }), messageStartingWith("roster: "), what);
  }
  assert.deepEqual(await readdir(scratch.evidenceRoot), [], "no refusal path leaves manifest artifacts");
});

test("a preflight whose reference machinery misgrades is refused, not silently frozen", async t => {
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_ALL_FAIL);
  await assert.rejects(prepareRound(scratch.rosterPath, { sandboxExecPath: fake }),
    messageStartingWith("preflight: reference"), "a sandbox that grades the known-good fixture failed is broken");
  assert.deepEqual(await readdir(scratch.evidenceRoot), []);
});

test("a preflight infrastructure failure is not a roster validation error", async t => {
  const scratch = await scratchRoster(t);
  await assert.rejects(
    prepareRound(scratch.rosterPath, { sandboxExecPath: join(scratch.evidenceRoot, "absent-sandbox-exec") }),
    (error: Error) => {
      assert.match(error.message, /^preflight: infrastructure/);
      assert.doesNotMatch(error.message, /^roster: /);
      return true;
    }
  );
});

test("a moved HEAD or an unreadable consumed file is a baseline refusal", async t => {
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const movedHead = scratch.write(roster => { roster.head = "a".repeat(40); });
  await assert.rejects(prepareRound(movedHead, { sandboxExecPath: fake }), messageStartingWith("baseline: "), "HEAD moved past the roster");
  await assert.rejects(
    prepareRound(scratch.rosterPath, {
      sandboxExecPath: fake,
      baselineFiles: ["dist/test/live-acceptance.js", "dist/test/absent-consumed.js"]
    }),
    messageStartingWith("baseline: "), "a consumed baseline file is unreadable"
  );
  assert.deepEqual(await readdir(scratch.evidenceRoot), []);
});
