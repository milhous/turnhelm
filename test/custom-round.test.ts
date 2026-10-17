// Hermetic tests for the custom-round check launcher: the sandbox boundary is
// a path-injected fake that execs its arguments, so every classification path
// runs on every platform CI runs on. Only the darwin-gated test at the bottom
// executes a real seatbelt profile.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { CASE_TIMEOUT_MS, executeRound, nodeReadClosure, prepareRound, projectWorkerReceipt, runSandboxedCheck } from "./custom-round.js";
import { executableFixture } from "./executable-fixture.js";

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

test("a forged marker followed by an exit is infrastructure, never a pass", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  const entry = await writeEntry(dirs.entries, "forged-then-exits.mjs",
    `console.log(${JSON.stringify(FORGED_MARKER_LINE)});\nprocess.exit(9);\n`);
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: entry, allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
  }), { status: "infrastructure", reason: "missing-outcome" },
  "stdout is not an outcome channel: an entry that dies before the wrapper settles has no grade");
});

test("a contract that cannot load is infrastructure, not a failed assertion", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  const syntaxError = await writeEntry(dirs.entries, "syntax-error.mjs", "const (\n");
  const missingModule = await writeEntry(dirs.entries, "missing-module.mjs", "import \"./absent.mjs\";\n");
  for (const [what, entry] of [["a syntax error", syntaxError], ["an unresolved import", missingModule]] as const) {
    assert.deepEqual(await runSandboxedCheck({
      sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
      entryScript: entry, allowReadSubpaths: [dirs.entries], timeoutMs: 10_000
    }), { status: "infrastructure", reason: "entry-load" },
    what + " means the contract never ran — broken machinery, not a failed check");
  }
});

test("settlement stays bounded even when a descendant holds the outcome pipe open", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, "trap '' TERM\nshift 2\n/bin/echo output\nsleep 5");
  const startedAt = Date.now();
  assert.deepEqual(await runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: await writeEntry(dirs.entries, "completes.mjs", "export const checked = true;\n"),
    allowReadSubpaths: [dirs.entries], timeoutMs: 300
  }), { status: "infrastructure", reason: "timeout" });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 4500, "SIGKILL plus a bounded grace settles the check, saw " + elapsed + "ms");
});

test("the node read closure never climbs out of the installation prefix", async () => {
  const nvm = nodeReadClosure("/Users/alice/.nvm/versions/node/v24.5.0/bin/node");
  assert.ok(nvm.length > 0 && nvm.every(path => path.startsWith("/Users/alice/.nvm/")),
    "an nvm node grants only inside ~/.nvm, never the home directory: " + JSON.stringify(nvm));
  const downloaded = nodeReadClosure("/Users/alice/Downloads/node-v24/bin/node");
  assert.ok(downloaded.every(path => path.startsWith("/Users/alice/Downloads/node-v24")),
    "a home-downloaded node grants only its own extracted tree: " + JSON.stringify(downloaded));
  const cellar = nodeReadClosure("/opt/homebrew/Cellar/node/24.5.0/bin/node");
  assert.ok(cellar.some(path => path.endsWith("/Cellar")) && !cellar.includes("/opt"),
    "a homebrew node's dyld closure stays inside the brew layout: " + JSON.stringify(cellar));
  assert.ok(nodeReadClosure("/usr/local/bin/node").includes("/usr/local"),
    "the conventional /usr/local prefix is still granted in full");
});

test("an aborted signal settles the check as aborted without waiting out its timeout", async t => {
  const dirs = await scratch(t);
  const fake = await writeFakeSandboxExec(t, 'shift 2\nexec "$@"');
  // A bare never-settling top-level await lets node's loop drain and exit 13
  // (unsettled TLA); a live interval keeps the check genuinely open so the
  // abort — not an early close — is what settles it.
  const entry = await writeEntry(dirs.entries, "stalls.mjs", "setInterval(() => {}, 60_000);\nawait new Promise(() => {});\n");
  const controller = new AbortController();
  const pending = runSandboxedCheck({
    sandboxExecPath: fake, runtimeDir: dirs.runtimeDir, cwd: dirs.caseRoot,
    entryScript: entry, allowReadSubpaths: [dirs.entries], timeoutMs: 20_000, signal: controller.signal
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  controller.abort();
  const abortedAt = Date.now();
  assert.deepEqual(await pending, { status: "infrastructure", reason: "aborted" });
  assert.ok(Date.now() - abortedAt < 2000, "an aborted check settles now, not at its own timeout");
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
const PREPARE_ALL_FAIL = `shift 2\nprintf '%s\\n' '__TURNHELM_CHECK_OUTCOME__{"pass":false}' >&3`;

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
  await mkdir(join(rootA, ".turnhelm"), { recursive: true });
  await mkdir(rootB);
  await writeFile(join(rootA, ".turnhelm", "config.json"), "{}\n");
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
  const baselineFiles = manifest.baseline as { files: { path: string; sha256: string }[] };
  const baselinePaths = baselineFiles.files.map(file => file.path);
  assert.ok(baselinePaths.includes("dist/test/custom-round.js") && baselinePaths.includes("dist/test/live-acceptance.js"),
    "the runner and shared-primitive modules stay in the baseline");
  assert.ok(baselinePaths.includes("dist/src/cli.js") && baselinePaths.includes("dist/src/task.js"),
    "the executed code itself is baseline-hashed, not just the harness around it");
  assert.ok(baselinePaths.includes("dist/src/runtime.js"),
    "the runtime floor module stays in the dynamically enumerated baseline");
  assert.ok(baselinePaths.every(path => path.startsWith("dist/")), "the baseline covers only built consumed code");
  for (const file of baselineFiles.files) {
    assert.equal(file.sha256, sha256hex(await readFile(join(REPO_ROOT, file.path))), file.path + " hashes its live bytes");
  }
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
      ["allowedChanges", "allowedProfiles", "files", "grading", "id", "kind", "root", "scope", "task", "transport", "tree"]);
    const root = item.root as { canonical: string; dev: number; ino: number };
    assert.ok(Number.isInteger(root.ino) && root.ino > 0, "the case root is pinned by dev/ino identity");
  }
  assert.deepEqual(cases[0].tree,
    { ".turnhelm/config.json": sha256hex(await readFile(join((scratch.roster.cases as { root: string }[])[0].root, ".turnhelm", "config.json"))) },
    "the consumer tree is snapshotted file-by-file into the manifest");
  assert.deepEqual(cases[1].tree, {}, "an empty consumer root freezes an empty tree");
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

test("a baseline override that hashes nothing is refused", async t => {
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  await assert.rejects(
    prepareRound(scratch.rosterPath, { sandboxExecPath: fake, baselineFiles: [] }),
    messageStartingWith("baseline: "), "an empty baseline silently approves any later code state"
  );
  assert.deepEqual(await readdir(scratch.evidenceRoot), []);
});

test("a roster contract that cannot load is refused at prepare, not frozen", async t => {
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  await writeFile(join((scratch.roster.cases as { files: { contract: string } }[])[1].files.contract), "const (\n");
  await assert.rejects(prepareRound(scratch.rosterPath, { sandboxExecPath: fake }),
    messageStartingWith("preflight: contract "),
    "a manifest must never approve a contract the machinery cannot even load");
  assert.deepEqual(await readdir(scratch.evidenceRoot), [], "the refusal leaves no manifest artifacts");
});

// ---------- executeRound: gated execute (spec §3.2(1), §3.4, §3.5) ----------

// The hermetic execute fakes: one local classifier fixture answering a fixed
// balanced choice, one fake codex that records its own env, counts its real
// executions (the preflight --version probe exits before the counter), and
// prints each line of the case root's codex-output.txt as an agent message,
// and one fake git that dumps the CLI child's own environment — the direct
// observation of the runner's scrubbed constructor — before answering the
// work-tree probe.
// The fake worker's exit path varies per scenario: the default prints the case
// root's codex-output.txt lines and completes, a failureMessage emits one
// turn.failed frame and exits 9 (the CLI classifies and receipts it), a
// stallMs holds the FIRST execution's turn open so a signal or timeout test
// can land mid-case (a roster's later cases run the fake unstalled), and a
// rebuildRoot swaps the case root for a byte-identical rebuild mid-run.
const fakeCodexBody = (options: Readonly<{ failureMessage?: string; stallMs?: number; extraWrite?: string; rebuildRoot?: boolean }> = {}): string => `
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("codex-cli 0.160.2\\n"); process.exit(0); }
if (argv[0] === "exec" && argv[1] === "--help") { process.stdout.write("--json\\n--ephemeral\\n--sandbox <MODE>\\n-\\n--ignore-user-config\\n--ignore-rules\\n--output-schema <FILE>\\n"); process.exit(0); }
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "worker-env.json"), JSON.stringify({
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  LAYA_API_KEY: Object.hasOwn(process.env, "LAYA_API_KEY"),
  TYPESAFE_API_KEY: Object.hasOwn(process.env, "TYPESAFE_API_KEY"),
  OPENAI_API_KEY: Object.hasOwn(process.env, "OPENAI_API_KEY"),
  TURNHELM_ALLOW_HOSTED_JEV: Object.hasOwn(process.env, "TURNHELM_ALLOW_HOSTED_JEV"),
  TURNHELM_CONFIG: Object.hasOwn(process.env, "TURNHELM_CONFIG"),
  BASH_ENV: Object.hasOwn(process.env, "BASH_ENV"),
  ENV: Object.hasOwn(process.env, "ENV")
}));
let task = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { task += chunk; });
process.stdin.on("end", () => {
  const firstRun = !fs.existsSync(path.join(__dirname, "invocations"));
  fs.appendFileSync(path.join(__dirname, "invocations"), "1");
  fs.writeFileSync(path.join(process.cwd(), "worker-task.txt"), task);
` + (options.extraWrite !== undefined
    ? `  fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(options.extraWrite)}), "unauthorized outside allowedChanges\\n");\n`
    : "") + (options.rebuildRoot === true
    ? `  // Swap the case root for a byte-identical rebuild: the staging directory
  // is allocated while the original still exists, so the replacement inode
  // can never be a recycle of the original — content survives, identity does
  // not.
  {
    const root = process.cwd();
    const files = [];
    const walk = rel => {
      for (const entry of fs.readdirSync(rel === "" ? root : path.join(root, rel), { withFileTypes: true })) {
        const child = rel === "" ? entry.name : rel + "/" + entry.name;
        if (entry.isDirectory()) walk(child);
        else files.push([child, fs.readFileSync(path.join(root, child))]);
      }
    };
    walk("");
    const staging = path.join(path.dirname(root), "rebuild-staging");
    fs.mkdirSync(staging, { recursive: true });
    for (const [rel, bytes] of files) {
      fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
      fs.writeFileSync(path.join(staging, rel), bytes);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(staging, root);
  }
`
    : "") + `  const finish = () => {
` + (options.failureMessage !== undefined
    ? `    process.stdout.write(JSON.stringify({ type: "turn.failed", message: ${JSON.stringify(options.failureMessage)} }) + "\\n");\n    process.exit(9);`
    : `    const lines = fs.readFileSync(path.join(process.cwd(), "codex-output.txt"), "utf8").split("\\n").filter(Boolean);\n    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: lines.join("\\n") } }) + "\\n");\n    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }) + "\\n");\n    process.exit(0);`)
  + `
  };
` + (options.stallMs !== undefined
    ? `  if (firstRun) setTimeout(finish, ${options.stallMs}); else finish();`
    : "  finish();") + `
});
`;

const caseConfig = (port: number): string => JSON.stringify({
  version: 2,
  routingTimeoutMs: 4000,
  backends: { laya: { enabled: true, url: `http://127.0.0.1:${port}` }, jev: { enabled: false, transport: { mode: "direct" } } },
  profiles: {
    fast: { model: "gpt-6-luna", effort: "low" },
    balanced: { model: "gpt-6.1-sol", effort: "medium" },
    deep: { model: "gpt-6.1-sol", effort: "high" },
    frontier: { model: "gpt-6-astra", effort: "high" },
    frontier_xhigh: { model: "gpt-6-astra", effort: "xhigh" },
    frontier_max: { model: "gpt-6-astra", effort: "max" }
  }
}, null, 2) + "\n";

type ExecuteCaseSpec = {
  id: string;
  kind: "worker-readonly" | "worker-write";
  transport: "arg" | "stdin-file";
  grading: Record<string, unknown>;
  outputLines: readonly string[];
  contractSource?: string;
  allowedChanges?: readonly string[];
};

const scratchExecuteRound = async (
  t: TestContext,
  specs: readonly ExecuteCaseSpec[],
  envExtra: Record<string, string> = {},
  options?: Readonly<{
    caps?: { classifierRequests: number; workerExecutions: number };
    choice?: string;
    codex?: Readonly<{ failureMessage?: string; stallMs?: number; extraWrite?: string; rebuildRoot?: boolean }>;
    poisonJournal?: boolean;
    journalAttempts?: unknown;
    baselineFiles?: readonly string[];
  }>
): Promise<{
  base: string;
  evidenceRoot: string;
  manifestPath: string;
  approvalSha256: string;
  roots: string[];
  taskFile: string;
  invocations: string;
  gitEnv: string;
  workerEnv: string;
  env: NodeJS.ProcessEnv;
  classifierRequests: () => number;
}> => {
  const base = await mkdtemp(join(tmpdir(), "turnhelm-exec-"));
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));
  const evidenceRoot = join(base, "evidence");
  await mkdir(evidenceRoot);
  let classifierRequests = 0;
  const server = createServer((request, response) => {
    classifierRequests += 1;
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ answers: { route: { type: "choice", choice: options?.choice ?? "balanced" } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  });
  const port = (server.address() as AddressInfo).port;
  const bin = join(base, "bin");
  await mkdir(bin);
  // WB-2: rounds run through the real CLI, which refuses without a worker
  // credential source; stage one beside the fake codex.
  await mkdir(join(base, "codex-home"));
  await writeFile(join(base, "codex-home", "auth.json"), '{"token":"fixture"}');
  const invocations = join(bin, "invocations");
  const gitEnv = join(base, "git-env.txt");
  const workerEnv = join(bin, "worker-env.json");
  await executableFixture(join(bin, "codex"), fakeCodexBody(options?.codex), "node");
  await executableFixture(join(bin, "git"),
    `/usr/bin/env > '${gitEnv}'\nif [ "$1" = "-C" ]; then echo true; exit 0; fi\nexit 64\n`, "shell");
  const taskText = "Sum the ledger rows and print the JSON result.";
  const taskFile = join(base, "task.txt");
  await writeFile(taskFile, taskText);
  const roots: string[] = [];
  const cases = [];
  for (const spec of specs) {
    const root = join(base, spec.id);
    roots.push(root);
    await mkdir(join(root, ".turnhelm"), { recursive: true });
    await writeFile(join(root, ".turnhelm", "config.json"), caseConfig(port));
    await writeFile(join(root, "codex-output.txt"), spec.outputLines.join("\n") + "\n");
    if (options?.poisonJournal === true) {
      // A forged journal line carrying the real task hash, with an object
      // backend and an unknown profile: whatever reads it must whitelist.
      await writeFile(join(root, ".turnhelm", "routes.jsonl"),
        JSON.stringify({ taskSha256: sha256hex(taskText), backend: { evil: 1 }, profileId: "not-a-profile" }) + "\n");
    }
    if (options?.journalAttempts !== undefined) {
      // A seeded first journal line whose attribution stays valid but whose
      // routing attempts carry the injected transport mode: only the mode is
      // hostile, so the receipt, output, and tree all stay valid.
      await writeFile(join(root, ".turnhelm", "routes.jsonl"),
        JSON.stringify({ taskSha256: sha256hex(taskText), backend: "laya", profileId: "balanced",
          attempts: options.journalAttempts }) + "\n");
    }
    const contract = join(base, spec.id + "-contract.mjs");
    await writeFile(contract,
      spec.contractSource ?? "import assert from \"node:assert/strict\";\nassert.equal(1 + 1, 2);\n");
    cases.push({
      id: spec.id, kind: spec.kind, scope: spec.id + " scope", task: taskText,
      transport: spec.transport, root,
      allowedChanges: spec.allowedChanges ?? [...(spec.kind === "worker-write" ? ["ledger.json"] : []), "worker-task.txt"],
      allowedProfiles: ["fast", "balanced"],
      grading: spec.grading,
      files: spec.kind === "worker-write"
        ? (spec.transport === "stdin-file" ? { contract, taskFile } : { contract })
        : (spec.transport === "stdin-file" ? { taskFile } : {})
    });
  }
  const rosterPath = join(base, "roster.json");
  writeFileSync(rosterPath, JSON.stringify({
    version: 1,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).toString().trim(),
    evidenceRoot,
    caps: options?.caps ?? { classifierRequests: 8, workerExecutions: 8 },
    cases
  }));
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const prepared = await prepareRound(rosterPath,
    { sandboxExecPath: fake, ...(options?.baselineFiles !== undefined ? { baselineFiles: options.baselineFiles } : {}) });
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    CODEX_HOME: join(base, "codex-home"),
    LAYA_API_KEY: "TEST_LAYA_SENTINEL",
    ...envExtra
  };
  return {
    base, evidenceRoot, manifestPath: prepared.manifestPath, approvalSha256: prepared.approvalSha256,
    roots, taskFile, invocations, gitEnv, workerEnv, env, classifierRequests: () => classifierRequests
  };
};

const readLedger = async (path: string): Promise<Record<string, unknown>[]> =>
  (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

const envLines = async (path: string): Promise<Map<string, string>> => new Map(
  (await readFile(path, "utf8")).trim().split("\n")
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));

test("execute runs both transports, grades both cases, and exits zero with an evidence ledger",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-write", transport: "stdin-file",
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}', "trailer: inert footer"]
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 0, "an all-pass round exits zero");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]).sort(),
      [["case-a", "pass"], ["case-b", "pass"]], "both cases are graded pass in the ledger");
    const caseRecords = ledger.filter(r => r.phase === "case");
    assert.ok(caseRecords.every(r => typeof r.oracleInput === "string" && r.oracleInput.length > 0),
      "each case record retains the bounded oracle input it was graded on");
    assert.deepEqual(caseRecords.map(r => [r.backend, r.profileId]).sort(),
      [["laya", "balanced"], ["laya", "balanced"]], "journal values surface only through the whitelist");
    assert.deepEqual(ledger.find(r => r.phase === "case" && r.caseId === "case-a")?.workerPayload,
      { mode: "strict" }, "a one-value message projects strict");
    assert.deepEqual(ledger.find(r => r.phase === "case" && r.caseId === "case-b")?.workerPayload,
      { mode: "extracted", trailerBytes: "trailer: inert footer".length });
    assert.ok(!ledger.some(r => r.phase === "stopped"), "no stop record on the happy path");
    assert.equal(await readFile(round.invocations, "utf8"), "11", "exactly one worker execution per case");
    for (const root of round.roots) {
      await readFile(join(root, ".turnhelm", "routes.jsonl"), "utf8");
      assert.equal(await readFile(join(root, "worker-task.txt"), "utf8"),
        "Sum the ledger rows and print the JSON result.", "the task text reaches the worker via " + root);
    }
  });

test("a same-path replaced root is refused at the identity gate before any launch",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    // Allocate the replacement's inode before freeing the original: ext4
    // recycles a just-freed directory inode, so rm+mkdir can reproduce the
    // same dev/ino and the identity gate correctly sees no replacement.
    const replacement = join(round.base, "replacement-root");
    await mkdir(replacement);
    await rm(round.roots[0], { recursive: true, force: true });
    await rename(replacement, round.roots[0]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 1, "a replaced root is a structural refusal");
    await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "zero worker invocations");
    await assert.rejects(readFile(join(round.roots[0], ".turnhelm", "routes.jsonl")), { code: "ENOENT" },
      "zero journals written");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: "case-a", reason: "root-identity" });
  });

test("a copied manifest outside the evidence root is refused without a claim",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    const elsewhere = join(round.base, "elsewhere");
    await mkdir(elsewhere);
    const copyPath = join(elsewhere, "custom-round-manifest.json");
    await copyFile(round.manifestPath, copyPath);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(copyPath, round.approvalSha256, { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 1, "a relocated manifest never reaches the claim");
    assert.deepEqual(await readdir(elsewhere), ["custom-round-manifest.json"], "no ledger is created next to the copy");
    await assert.rejects(readFile(join(round.evidenceRoot, "custom-round-evidence.jsonl")), { code: "ENOENT" },
      "the canonical evidence root is never claimed by a relocated copy");
    await assert.rejects(readFile(round.invocations), { code: "ENOENT" });
  });

test("a second execute of a claimed manifest cannot claim again",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    assert.equal(await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake }), 0);
    assert.equal(await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake }), 1, "the exclusive-create ledger refuses the replay");
    assert.equal(await readFile(round.invocations, "utf8"), "1", "the replay launches nothing");
  });

test("a task file mutated after prepare is a hash refusal before any launch",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "stdin-file",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    await writeFile(round.taskFile, "Mutated task text that was never approved.");
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 1, "a mutated transport file is a structural refusal");
    await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "zero worker invocations");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: "case-a", reason: "case-files" });
  });

test("a same-path replaced root with identical bytes is still refused, with zero spend", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ]);
  const root = round.roots[0];
  const snapshot: [string, Buffer][] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const child = relative === "" ? entry.name : relative + "/" + entry.name;
      if (entry.isDirectory()) await walk(child);
      else snapshot.push([child, await readFile(join(root, child))]);
    }
  };
  await walk("");
  // The replacement inode must be allocated while the original still exists
  // (ext4 recycles a just-freed directory inode into an immediate mkdir,
  // which would defeat the dev/ino identity check): restore its bytes into a
  // sibling first, then swap it in with one rename.
  const replacement = join(dirname(root), "replacement-root");
  await mkdir(replacement);
  for (const [relative, bytes] of snapshot) {
    await mkdir(dirname(join(replacement, relative)), { recursive: true });
    await writeFile(join(replacement, relative), bytes);
  }
  await rm(root, { recursive: true, force: true });
  await rename(replacement, root);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const code = await executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  assert.equal(code, 1, "identical bytes in a new inode are still a structural refusal");
  await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "zero worker invocations");
  assert.equal(round.classifierRequests(), 0, "the identity gate fires before any classifier spend");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: "case-a", reason: "root-identity" });
});

// Baseline-drift fixtures pin the approved baseline to a scratch file in a
// private temp dir: mutating a real dist file would race every parallel test
// file whose sealed rounds hash dist.
test("a baseline file mutated after prepare is a baseline refusal before any launch", { timeout: 90_000 }, async t => {
  const consumed = await mkdtemp(join(tmpdir(), "turnhelm-consumed-"));
  t.after(() => rm(consumed, { recursive: true, force: true }).catch(() => {}));
  const target = join(consumed, "consumed-code.js");
  await writeFile(target, "original consumed bytes\n");
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { baselineFiles: [relative(REPO_ROOT, target)] });
  await writeFile(target, "mutated consumed bytes\n");
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const code = await executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  assert.equal(code, 1, "mutated consumed code never reaches the claim");
  await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "zero worker invocations");
  assert.equal(round.classifierRequests(), 0, "zero classifier spend");
});

test("a baseline file mutated between cases stops the round at the next reservation",
  { timeout: 90_000 }, async t => {
    const consumed = await mkdtemp(join(tmpdir(), "turnhelm-consumed-"));
    t.after(() => rm(consumed, { recursive: true, force: true }).catch(() => {}));
    const target = join(consumed, "consumed-code.js");
    await writeFile(target, "original consumed bytes\n");
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 1500 }, baselineFiles: [relative(REPO_ROOT, target)] });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const pending = executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    // Mutate while case-a's stalled worker holds the round open: case-a may
    // finish, but case-b's reservation must re-verify the consumed baseline.
    await waitForFile(round.invocations);
    await writeFile(target, "mutated consumed bytes\n");
    assert.equal(await pending, 1, "baseline drift mid-round stops all remaining spend");
    assert.equal(await readFile(round.invocations, "utf8"), "1", "the second case never launches");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: "case-b", reason: "baseline" });
  });

test("an envelope-shaped output extracts to its payload line for strict grading",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-envelope", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-whole-json", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}', "trailer: inert footer"]
      },
      {
        id: "case-conflict", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-whole-json", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}', '{"count":9,"sum":9}']
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 4, "the conflicting second answer fails its case");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]).sort(),
      [["case-conflict", "failed"], ["case-envelope", "pass"]],
      "an inert trailer extracts to the payload line; a second structured answer stays verbatim and fails");
    const envelope = ledger.find(r => r.phase === "case" && r.caseId === "case-envelope");
    assert.deepEqual(envelope?.workerPayload, { mode: "extracted", trailerBytes: "trailer: inert footer".length },
      "the observed record carries the bounded payload projection off the receipt");
    const conflict = ledger.find(r => r.phase === "case" && r.caseId === "case-conflict");
    assert.deepEqual(conflict?.workerPayload, { mode: "conflict" });
    assert.equal(JSON.stringify(ledger).includes("trailer: inert footer"), false,
      "the trailer text is retained nowhere — not even the observed record");
    assert.equal(await readFile(round.invocations, "utf8"), "11", "both cases ran; grading is the discriminator");
  });

test("the CLI child env is scrubbed before it reaches the CLI and again the worker",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {
      TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
      OPENAI_API_KEY: "TEST_OPENAI_SENTINEL",
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TURNHELM_CONFIG: "/synthetic/turnhelm.json",
      BASH_ENV: "/tmp/host-bashenv",
      ENV: "/tmp/host-shenv"
    });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 0);
    const cli = await envLines(round.gitEnv);
    for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV",
      "TURNHELM_CONFIG", "BASH_ENV", "ENV"]) {
      assert.ok(!cli.has(key), "the CLI child env must not carry " + key);
    }
    assert.equal(cli.get("PATH"), round.env.PATH, "the scrubbed env is the runner's env minus the denylist, not a fresh allowlist");
    const worker = JSON.parse(await readFile(round.workerEnv, "utf8")) as Record<string, unknown>;
    for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV",
      "TURNHELM_CONFIG", "BASH_ENV", "ENV"]) {
      assert.equal(worker[key], false, "the worker env must not carry " + key);
    }
    assert.equal(worker.PATH, round.env.PATH);
  });

// ---------- workerFailure projection (spec §3): the receipt worker, field by field ----------

// The full-taxonomy fixture: every whitelisted field valid, plus the
// unselected `payload` key the real receipt legitimately carries.
const FULL_WORKER = {
  status: "failed",
  code: 9,
  durationMs: 4321,
  progressEvents: 7,
  ownedShutdown: false,
  usage: { input_tokens: 120, output_tokens: 34, cached_input_tokens: 0, reasoning_output_tokens: 56 },
  failureClass: "stream-disconnected",
  errorSha256: "a".repeat(64),
  signal: "SIGTERM",
  lastEventAgeMs: 42,
  payload: { mode: "strict" }
};

const FULL_PROJECTION = {
  status: "failed",
  code: 9,
  durationMs: 4321,
  progressEvents: 7,
  ownedShutdown: false,
  usage: { input_tokens: 120, output_tokens: 34, cached_input_tokens: 0, reasoning_output_tokens: 56 },
  failureClass: "stream-disconnected",
  errorSha256: "a".repeat(64),
  signal: "SIGTERM",
  lastEventAgeMs: 42
};

test("a full worker object projects every whitelisted field and ignores unselected receipt keys", () => {
  assert.deepEqual(projectWorkerReceipt(FULL_WORKER), FULL_PROJECTION,
    "the projection is exactly the whitelist — the payload key never reaches it");
});

test("a not-started worker projects exactly what it legitimately carries", () => {
  assert.deepEqual(projectWorkerReceipt({ status: "not-started", durationMs: 0, progressEvents: 0, usage: "unreported" }),
    { status: "not-started", durationMs: 0, progressEvents: 0, usage: "unreported" },
    "the zero duration and event count are real observations; no code or ownedShutdown is fabricated");
  assert.deepEqual(
    projectWorkerReceipt({ status: "completed", code: 0, durationMs: 0, progressEvents: 0, ownedShutdown: false, usage: "unreported" }),
    { status: "completed", code: 0, durationMs: 0, progressEvents: 0, ownedShutdown: false, usage: "unreported" },
    "a completed run that decoded zero frames keeps its zero — distinguishable from an absent count");
});

test("a malformed field drops alone; the rest of the projection survives", () => {
  const without = (field: string): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...FULL_PROJECTION };
    delete rest[field];
    return rest;
  };
  assert.deepEqual(projectWorkerReceipt({ ...FULL_WORKER, code: 2.5 }), without("code"),
    "a non-safe-integer code drops alone");
  assert.deepEqual(projectWorkerReceipt({ ...FULL_WORKER, ownedShutdown: "yes" }), without("ownedShutdown"),
    "a non-boolean ownedShutdown drops alone");
  assert.deepEqual(projectWorkerReceipt({ ...FULL_WORKER, failureClass: "kaboom" }), without("failureClass"),
    "an out-of-taxonomy failureClass drops alone");
  assert.deepEqual(projectWorkerReceipt({ ...FULL_WORKER, errorSha256: "not-a-hash" }), without("errorSha256"),
    "a non-64-hex errorSha256 drops alone");
  assert.deepEqual(projectWorkerReceipt({ ...FULL_WORKER, signal: "SIGHUP" }), without("signal"),
    "an out-of-set signal drops alone");
  assert.deepEqual(
    projectWorkerReceipt({ ...FULL_WORKER, usage: { input_tokens: -3, output_tokens: 8 } }),
    { ...FULL_PROJECTION, usage: { output_tokens: 8 } },
    "a negative usage counter drops alone, inside its snapshot and out");
});

test("usage projects per VH-3: partial kept, malformed dropped, absent or empty reads unreported", () => {
  assert.deepEqual(projectWorkerReceipt({ status: "completed", usage: { input_tokens: 5 } })?.usage,
    { input_tokens: 5 }, "a partial snapshot is kept without zero-fill");
  assert.deepEqual(
    projectWorkerReceipt({ status: "completed", usage: { input_tokens: 3, output_tokens: "many", reasoning_output_tokens: -1 } })?.usage,
    { input_tokens: 3 }, "malformed counters drop while valid ones survive");
  assert.deepEqual(projectWorkerReceipt({ status: "completed", usage: { cached_input_tokens: 2.5 } })?.usage,
    "unreported", "zero surviving counters read unreported");
  assert.deepEqual(projectWorkerReceipt({ status: "completed", usage: "unreported" })?.usage,
    "unreported", "the emitted unreported literal passes through");
  assert.deepEqual(projectWorkerReceipt({ status: "completed" })?.usage,
    "unreported", "absent usage is never fabricated as counters");
});

test("a non-record worker or an out-of-enum status yields no projection at all", () => {
  assert.equal(projectWorkerReceipt(undefined), undefined);
  assert.equal(projectWorkerReceipt(null), undefined);
  assert.equal(projectWorkerReceipt("failed"), undefined);
  assert.equal(projectWorkerReceipt([]), undefined);
  assert.equal(projectWorkerReceipt({ status: "weird", code: 0 }), undefined);
});

test("a failed worker case carries the frozen failure projection, never the failure text",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
        outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { failureMessage: "stream disconnected" } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 4, "a non-stopping failure class fails its case without stopping the roster");
    const ledgerPath = join(round.evidenceRoot, "custom-round-evidence.jsonl");
    const ledger = await readLedger(ledgerPath);
    const caseRecord = ledger.find(r => r.phase === "case" && r.caseId === "case-a");
    const workerFailure = caseRecord?.workerFailure as Record<string, unknown> | undefined;
    assert.deepEqual(workerFailure?.failureClass, "stream-disconnected");
    assert.deepEqual(workerFailure?.errorSha256, sha256hex("stream disconnected"),
      "the hash correlates the exact failure bytes");
    const raw = await readFile(ledgerPath, "utf8");
    assert.equal(raw.includes("stream disconnected"), false,
      "the failure message text reaches no ledger byte");
    assert.equal(raw.includes("turnhelm.receipt"), false,
      "no stderr receipt bytes reach the ledger");
  });

test("a passing case retains the worker projection for spot-checks",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 0, "the passing round is unchanged by the projection");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const caseRecord = ledger.find(r => r.phase === "case" && r.caseId === "case-a");
    const workerFailure = caseRecord?.workerFailure as Record<string, unknown> | undefined;
    assert.equal(workerFailure?.status, "completed", "retention on pass is what makes spot-checks possible");
    assert.ok(typeof workerFailure?.progressEvents === "number" && workerFailure.progressEvents >= 1,
      "the parent-observed event count projects");
  });

// ---------- command entry modes (spec §3.1): prepare and execute ----------

const runEntry = (args: readonly string[]): { code: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync(process.execPath,
      [join(REPO_ROOT, "dist", "test", "custom-round.js"), ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

test("the command entry prints usage and exits 1 with no subcommand", async () => {
  const result = runEntry([]);
  assert.equal(result.code, 1, "an argument-less invocation is a usage error, not a silent success");
  assert.ok(result.stderr.includes("usage:"), "the usage line names both entry modes");
  assert.equal(result.stdout, "");
});

test("prepare mode refuses an unreadable roster with the reason on stderr", async () => {
  const result = runEntry(["prepare", join(tmpdir(), "turnhelm-absent-roster.json")]);
  assert.equal(result.code, 1, "a refused prepare exits 1");
  assert.ok(result.stderr.includes("prepare refused:"), "the refusal carries the validation error");
});

test("execute mode exits with the round code for a mismatched approval hash", async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ]);
  const result = runEntry(["execute", round.manifestPath, "0".repeat(64)]);
  assert.equal(result.code, 1, "a wrong sha256 is the structural refusal, surfaced through the entry mode");
});

test("prepare mode prints the manifest path and approval hash", { skip: process.platform !== "darwin" }, async t => {
  const scratch = await scratchRoster(t);
  const result = runEntry(["prepare", scratch.rosterPath]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("manifest: " + join(scratch.evidenceRoot, "custom-round-manifest.json")),
    "stdout names the frozen manifest");
  assert.ok(/sha256: [0-9a-f]{64}/.test(result.stdout), "stdout carries the approval hash");
});

test("a worker writing outside its allowedChanges stops the round", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    },
    {
      id: "case-b", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { codex: { extraWrite: "evil.txt" } });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const code = await executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  assert.equal(code, 1, "an undeclared tree change is an integrity stop, even when the case's output graded fine");
  assert.equal(await readFile(round.invocations, "utf8"), "1", "the second case never launches");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  const stop = ledger.at(-1);
  assert.equal(stop?.phase, "stopped");
  assert.equal(stop?.caseId, "case-a");
  assert.equal(stop?.reason, "tree-drift");
  assert.equal((stop?.workerFailure as Record<string, unknown> | undefined)?.status, "completed",
    "a post-CLI stop record carries the projection of its lone receipt");
});

test("a CLI run that receipts nothing is an integrity stop", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ]);
  // A PATH without the fake git: the CLI's own preflight fails before
  // classification, so the run emits no receipt at all.
  const gitlessBin = join(round.base, "bin-nogit");
  await mkdir(gitlessBin);
  await copyFile(join(round.base, "bin", "codex"), join(gitlessBin, "codex"));
  await chmod(join(gitlessBin, "codex"), 0o755);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const code = await executeRound(round.manifestPath, round.approvalSha256,
    { env: { ...round.env, PATH: gitlessBin }, sandboxExecPath: fake });
  assert.equal(code, 1, "a case without exactly one receipt never grades on stdout alone");
  await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "the worker never runs");
  assert.equal(round.classifierRequests(), 0, "the failure precedes classification");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: "case-a", reason: "receipt" });
});

test("a selection outside the case's allowed profiles fails the case", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { choice: "frontier" });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const code = await executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  assert.equal(code, 4, "an out-of-profile selection is an engineering failure of the case, not a stop");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  const record = ledger.find(r => r.phase === "case");
  assert.equal(record?.outcome, "failed");
  assert.equal(record?.profileId, "frontier", "the selection is recorded even as it fails the case");
});

test("a reserved-record append failure stops before the next spend", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    },
    {
      id: "case-b", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { codex: { stallMs: 1500 } });
  const ledgerPath = join(round.evidenceRoot, "custom-round-evidence.jsonl");
  t.after(async () => { await chmod(ledgerPath, 0o600).catch(() => {}); });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const pending = executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  // Wait until case-a's worker is mid-run (its 1.5s stall guarantees the
  // window), then kill the ledger: case-a's own appends may still land, but
  // case-b's reserved record must not.
  await waitForFile(round.invocations);
  await chmod(ledgerPath, 0o000);
  assert.equal(await pending, 1, "a reserved record that cannot be written stops all remaining spend");
  assert.equal(await readFile(round.invocations, "utf8"), "1", "only the already-running case executed");
});

test("journal values outside the whitelist degrade to null", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { poisonJournal: true });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const code = await executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  assert.equal(code, 0, "a poisoned journal line never fails the case by itself");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  const record = ledger.find(r => r.phase === "case");
  assert.equal(record?.backend, null, "an object backend never reaches the ledger");
  assert.equal(record?.profileId, null, "an unknown profile id never reaches the ledger");
  assert.equal(record?.attemptTransports, "unverified", "absent routing attempts degrade to unverified");
});

test("unknown mode does not stop ordinary rounds", { timeout: 240_000 }, async t => {
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const passing = (id: string): ExecuteCaseSpec => ({
    id, kind: "worker-readonly", transport: "arg",
    grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
  });

  // The clean baseline: both cases pass, both workers actually launch, and the
  // case records carry the CLI's own laya-direct transport policy.
  const clean = await scratchExecuteRound(t, [passing("case-a"), passing("case-b")]);
  assert.equal(await executeRound(clean.manifestPath, clean.approvalSha256,
    { env: clean.env, sandboxExecPath: fake }), 0);
  const cleanCases = (await readLedger(join(clean.evidenceRoot, "custom-round-evidence.jsonl")))
    .filter(r => r.phase === "case");
  assert.deepEqual(cleanCases.map(r => [r.caseId, r.outcome]), [["case-a", "pass"], ["case-b", "pass"]]);
  assert.deepEqual(cleanCases.map(r => r.attemptTransports),
    [[{ backend: "laya", transportMode: "direct" }], [{ backend: "laya", transportMode: "direct" }]],
    "a clean round projects the frozen laya-direct policy on every case record");
  assert.equal(await readFile(clean.invocations, "utf8"), "11", "both workers actually launch");

  // A malformed or missing transport mode is evidence, never a gate: the
  // outcomes, worker launches, continuation, and exit code all stay unchanged.
  for (const [name, attempts] of [
    ["malformed mode", [{ backend: "laya", transportMode: "socks5", outcome: "success", durationMs: 5 }]],
    ["missing mode", [{ backend: "laya", outcome: "success", durationMs: 5 }]]
  ] as const) {
    const poisoned = await scratchExecuteRound(t, [passing("case-a"), passing("case-b")],
      {}, { journalAttempts: attempts });
    assert.equal(await executeRound(poisoned.manifestPath, poisoned.approvalSha256,
      { env: poisoned.env, sandboxExecPath: fake }), 0, name + " keeps the pass round at zero");
    const ledger = await readLedger(join(poisoned.evidenceRoot, "custom-round-evidence.jsonl"));
    const cases = ledger.filter(r => r.phase === "case");
    assert.deepEqual(cases.map(r => [r.caseId, r.outcome]), [["case-a", "pass"], ["case-b", "pass"]],
      name + " preserves outcomes and continuation");
    assert.ok(cases.every(r => r.attemptTransports === "unverified"),
      name + " degrades to unverified on every case record");
    assert.ok(!ledger.some(r => r.phase === "stopped"), name + " never stops the roster");
    assert.equal(await readFile(poisoned.invocations, "utf8"), "11", name + " still launches both workers");
  }

  // A failed case keeps the same protocol: the failure is graded exactly as
  // without the field, and the roster runs on to a completed failure (exit 4).
  const failed = await scratchExecuteRound(t, [
    { ...passing("case-a"), outputLines: ['{"count":9,"sum":9}'] },
    passing("case-b")
  ], {}, { journalAttempts: [{ backend: "laya", transportMode: "socks5" }] });
  assert.equal(await executeRound(failed.manifestPath, failed.approvalSha256,
    { env: failed.env, sandboxExecPath: fake }), 4, "the failed round keeps its completed-failure exit");
  const failedLedger = await readLedger(join(failed.evidenceRoot, "custom-round-evidence.jsonl"));
  assert.deepEqual(failedLedger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]),
    [["case-a", "failed"], ["case-b", "pass"]], "the failed outcome and continuation are unchanged");
  assert.ok(!failedLedger.some(r => r.phase === "stopped"), "an ordinary failure never becomes a stop");

  // A timeout outcome is unjudged, continuable evidence: the same shape holds.
  const timedOut = await scratchExecuteRound(t, [passing("case-a"), passing("case-b")],
    {}, { journalAttempts: [{ backend: "laya" }], codex: { stallMs: 8000 } });
  assert.equal(await executeRound(timedOut.manifestPath, timedOut.approvalSha256,
    { env: timedOut.env, sandboxExecPath: fake, caseTimeoutMs: 1000 }), 4,
    "the timed-out round still completes the roster");
  const timeoutLedger = await readLedger(join(timedOut.evidenceRoot, "custom-round-evidence.jsonl"));
  const timeoutCases = timeoutLedger.filter(r => r.phase === "case");
  assert.deepEqual(timeoutCases.map(r => [r.caseId, r.outcome]),
    [["case-a", "timeout"], ["case-b", "pass"]], "the timeout outcome and continuation are unchanged");
  assert.equal(timeoutCases.every(r => r.attemptTransports === "unverified"), true,
    "the timeout record degrades to unverified like the graded one");
  assert.ok(!timeoutLedger.some(r => r.phase === "stopped"), "a timeout never becomes a stop");
  assert.equal(await readFile(timedOut.invocations, "utf8"), "11", "both workers actually launch");
});

test("refused executions leave no abort listeners behind", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ]);
  const elsewhere = join(round.base, "elsewhere");
  await mkdir(elsewhere);
  const copyPath = join(elsewhere, "custom-round-manifest.json");
  await copyFile(round.manifestPath, copyPath);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const external = new AbortController();
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await executeRound(copyPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake, signal: external.signal }), 1);
  }
  assert.equal(getEventListeners(external.signal, "abort").length, 0,
    "each refused execution removes the abort relay it registered");
});


const waitForFile = async (path: string): Promise<void> => {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("timed out waiting for " + path);
};

test("an ordinary contract failure fails its case and the roster continues",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-write", transport: "stdin-file",
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}'],
        contractSource: "throw new Error(\"contract violated\");\n"
      },
      {
        id: "case-b", kind: "worker-write", transport: "stdin-file",
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}']
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 4, "a complete round with one failed case exits four");
    assert.equal(await readFile(round.invocations, "utf8"), "11",
      "an ordinary assertion failure never stops the roster");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]),
      [["case-a", "failed"], ["case-b", "pass"]]);
    assert.ok(!ledger.some(r => r.phase === "stopped"));
  });

test("a contract-check infrastructure failure stops the round before the next spend",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-write", transport: "stdin-file",
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}']
      },
      {
        id: "case-b", kind: "worker-write", transport: "stdin-file",
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}']
      }
    ]);
    const broken = await writeFakeSandboxExec(t, "shift 2\nexit 9");
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: broken });
    assert.equal(code, 1, "an infrastructure failure is an integrity stop");
    assert.equal(await readFile(round.invocations, "utf8"), "1",
      "case one ran; case two never launches");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.at(-1),
      { phase: "stopped", caseId: "case-a", reason: "contract-missing-outcome" });
  });

test("an auth-class worker failure stops the round",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
        outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
        outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { failureMessage: "invalid api key rejected" } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 1, "auth-class failures stop all remaining spend");
    assert.equal(await readFile(round.invocations, "utf8"), "1", "the second case never launches");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const stop = ledger.at(-1);
    assert.equal(stop?.phase, "stopped");
    assert.equal(stop?.caseId, "case-a");
    assert.equal(stop?.reason, "worker-auth");
    assert.equal((stop?.workerFailure as Record<string, unknown> | undefined)?.failureClass, "auth",
      "the stop record carries the projection, never the failure text");
  });

// ---------- FE-2 (spec §4): fixed decision order, cleanup gate, settled-tree identity ----------

test("an abort mid-case settles 130 and reserves nothing later", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    },
    {
      id: "case-b", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { codex: { stallMs: 30_000 } });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const pending = executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  await waitForFile(round.invocations);
  process.kill(process.pid, "SIGINT");
  assert.equal(await pending, 130, "the abort rung stays first: SIGINT settles the graceful code");
  assert.equal(await readFile(round.invocations, "utf8"), "1", "an aborted round never reserves a later case");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: null, reason: "signal" });
});

test("an overflowing CLI run stops as output-cap even though the timeout flag is set too",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    // The require script floods the CLI's stdout past the supervisor's 64 KiB
    // cap before the CLI's own logic starts: halt("timeout") sets both
    // outputOverflow and timedOut, so the round must decide on the capped
    // stream — never on the timeout flag the cap also set.
    const flood = join(round.base, "stdout-flood.cjs");
    await writeFile(flood, 'if (process.argv[1] && process.argv[1].includes("cli.js")) '
      + 'process.stdout.write("x".repeat(70000));\n');
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: { ...round.env, NODE_OPTIONS: "--require " + flood }, sandboxExecPath: fake });
    assert.equal(code, 1, "a capped stream is an integrity stop");
    await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "no worker runs past the cap");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const stop = ledger.at(-1);
    assert.equal(stop?.phase, "stopped");
    assert.equal(stop?.caseId, "case-a");
    assert.equal(stop?.reason, "output-cap", "overflow outranks the timeout flag it also set");
    assert.ok(!ledger.some(r => r.phase === "case"), "a capped stream never grades, as a case or a timeout");
  });

test("a CLI outliving the post-TERM grace stops the round as cleanup-unverified",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 30_000 } });
    // The require script holds the CLI's event loop open with SIGINT and
    // SIGTERM ignored, then floods stdout once the worker has started: the
    // supervisor halts, its INT → TERM ladder cannot close the child, and it
    // abandons the pipes with cliClosed false — a possibly-live CLI. The
    // self-exit timer bounds the orphan the abandonment leaves behind.
    const trap = join(round.base, "trap-signals.cjs");
    await writeFile(trap,
      'if (process.argv[1] && process.argv[1].includes("cli.js")) {\n'
      + '  const fs = require("node:fs");\n'
      + '  process.on("SIGINT", () => {});\n'
      + '  process.on("SIGTERM", () => {});\n'
      + '  setInterval(() => {}, 60000);\n'
      + '  setTimeout(() => process.exit(0), 20000);\n'
      + `  const flood = () => {\n`
      + `    if (fs.existsSync(${JSON.stringify(round.invocations)})) process.stdout.write("x".repeat(70000));\n`
      + '    else setTimeout(flood, 25);\n'
      + '  };\n'
      + '  flood();\n'
      + '}\n');
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const startedAt = Date.now();
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: { ...round.env, NODE_OPTIONS: "--require " + trap }, sandboxExecPath: fake });
    assert.equal(code, 1, "unverified cleanup is an integrity stop");
    assert.ok(Date.now() - startedAt >= 10_000,
      "the supervisor ran its INT → TERM → abandon ladder before settling");
    assert.equal(await readFile(round.invocations, "utf8"), "1",
      "the overflowing case's worker ran; the next case's never does");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const stop = ledger.at(-1);
    assert.equal(stop?.phase, "stopped");
    assert.equal(stop?.caseId, "case-a");
    assert.equal(stop?.reason, "cleanup-unverified",
      "an abandoned, possibly-live CLI outranks the overflow that halted it");
    const projection = stop?.workerFailure as Record<string, unknown> | undefined;
    assert.equal(projection?.status, "cancelled", "the flushed receipt's projection rides the stop record");
    assert.equal(projection?.ownedShutdown, true);
  });

test("a worker rebuilding its own case root byte-identically stops the settled-tree gate",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { rebuildRoot: true } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 1, "a rebuilt root is a replacement even when every byte matches");
    assert.equal(await readFile(round.invocations, "utf8"), "1",
      "the worker ran and passed; the stop is at the settled-tree identity gate");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const stop = ledger.at(-1);
    assert.equal(stop?.phase, "stopped");
    assert.equal(stop?.caseId, "case-a");
    assert.equal(stop?.reason, "root-identity", "hash equality never proves identity");
    assert.equal((stop?.workerFailure as Record<string, unknown> | undefined)?.status, "completed",
      "the lone receipt's projection rides the stop record");
    assert.ok(!ledger.some(r => r.phase === "case"), "a replaced root never grades");
  });

// ---------- FE-2 continuation: the timeout outcome and roster continuation ----------

test("a timed-out case records an unjudged timeout outcome and the roster continues",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 8000 } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake, caseTimeoutMs: 1000 });
    assert.equal(code, 4, "a complete round with a timed-out case exits four, not one");
    assert.equal(await readFile(round.invocations, "utf8"), "11",
      "a timeout is an outcome, not a stop: case-b still runs");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const record = ledger.find(r => r.phase === "case" && r.caseId === "case-a");
    assert.equal(record?.outcome, "timeout");
    assert.equal(record?.exitCode, 130, "the CLI's own SIGINT shutdown settles the exit code");
    assert.ok(typeof record?.durationMs === "number" && record.durationMs >= 1000,
      "the supervisor's wall-clock budget is the duration floor");
    assert.equal(record?.taskSha256, sha256hex("Sum the ledger rows and print the JSON result."));
    assert.deepEqual([record?.backend, record?.profileId], ["laya", "balanced"],
      "journal attribution is read exactly as the graded path reads it");
    const workerFailure = record?.workerFailure as Record<string, unknown> | undefined;
    assert.equal(workerFailure?.status, "cancelled", "the CLI's owned shutdown receipts the cancelled worker");
    assert.equal(workerFailure?.ownedShutdown, true);
    assert.ok(!Object.hasOwn(record ?? {}, "oracleInput"), "nothing was judged, so no oracle input is retained");
    assert.ok(!Object.hasOwn(record ?? {}, "workerPayload"), "a cancelled worker carries no payload projection");
    assert.deepEqual(ledger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]).sort(),
      [["case-a", "timeout"], ["case-b", "pass"]], "case-b still grades pass");
    assert.ok(!ledger.some(r => r.phase === "stopped"), "no stop record on a timeout-outcome round");
  });

test("an all-pass round with the case timeout knob present still exits zero",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake, caseTimeoutMs: 30_000 });
    assert.equal(code, 0, "a knob comfortably above the fast cases never fires");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]).sort(),
      [["case-a", "pass"], ["case-b", "pass"]]);
  });

test("a timed-out case that wrote outside its allowance stops as tree-drift",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 8000, extraWrite: "evil.txt" } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake, caseTimeoutMs: 1000 });
    assert.equal(code, 1, "the settled-tree gate outranks the timeout outcome");
    assert.equal(await readFile(round.invocations, "utf8"), "1", "a drift stop reserves no further case");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const stop = ledger.at(-1);
    assert.equal(stop?.phase, "stopped");
    assert.equal(stop?.caseId, "case-a");
    assert.equal(stop?.reason, "tree-drift");
    assert.equal((stop?.workerFailure as Record<string, unknown> | undefined)?.status, "cancelled",
      "the cancelled receipt's projection rides the stop record");
    assert.ok(!ledger.some(r => r.phase === "case"), "a drifted timeout case never records an outcome");
  });

test("a timed-out case that rebuilt its root byte-identically stops as root-identity",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 8000, rebuildRoot: true } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake, caseTimeoutMs: 1000 });
    assert.equal(code, 1, "identity is checked before any hash at the shared gate");
    assert.equal(await readFile(round.invocations, "utf8"), "1", "an identity stop reserves no further case");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    const stop = ledger.at(-1);
    assert.equal(stop?.phase, "stopped");
    assert.equal(stop?.caseId, "case-a");
    assert.equal(stop?.reason, "root-identity", "hash equality never proves identity, timeout or not");
    assert.equal((stop?.workerFailure as Record<string, unknown> | undefined)?.status, "cancelled",
      "the cancelled receipt's projection rides the stop record");
    assert.ok(!ledger.some(r => r.phase === "case"), "a replaced root never records an outcome");
  });

test("the case timeout knob pins the frozen default and never reaches prepare", async t => {
  assert.equal(CASE_TIMEOUT_MS, 240_000, "the production case budget is unchanged");
  const scratch = await scratchRoster(t);
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const prepared = await prepareRound(scratch.rosterPath, { sandboxExecPath: fake });
  const raw = await readFile(prepared.manifestPath, "utf8");
  assert.equal(raw.includes("caseTimeoutMs"), false,
    "prepare mode never reads or freezes the execute-time knob");
});

test("a roster exceeding its declared caps is refused before any spend",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
        outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
        outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { caps: { classifierRequests: 1, workerExecutions: 1 } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 1, "planned spend above the frozen caps is refused");
    await assert.rejects(readFile(round.invocations), { code: "ENOENT" }, "zero worker invocations");
    await assert.rejects(readFile(join(round.evidenceRoot, "custom-round-evidence.jsonl")), { code: "ENOENT" },
      "a refused roster never claims the ledger");
  });

test("SIGINT during a case closes gracefully with exit 130", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
      outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { codex: { stallMs: 30_000 } });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const pending = executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  await waitForFile(round.invocations);
  process.kill(process.pid, "SIGINT");
  assert.equal(await pending, 130, "SIGINT maps to the graceful-stop exit code");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  assert.equal(ledger.at(-1)?.phase, "stopped", "the signal stop is recorded");
});

test("SIGTERM during a case exits 143", { timeout: 90_000 }, async t => {
  const round = await scratchExecuteRound(t, [
    {
      id: "case-a", kind: "worker-readonly", transport: "arg",
      grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } },
      outputLines: ['{"count":3,"sum":6}']
    }
  ], {}, { codex: { stallMs: 30_000 } });
  const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
  const pending = executeRound(round.manifestPath, round.approvalSha256,
    { env: round.env, sandboxExecPath: fake });
  await waitForFile(round.invocations);
  process.kill(process.pid, "SIGTERM");
  assert.equal(await pending, 143, "SIGTERM maps to the immediate-stop exit code");
  const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
  assert.equal(ledger.at(-1)?.phase, "stopped", "the signal stop is recorded");
});

test("SIGTERM during the contract check exits 143 without waiting out the contract timeout",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-write", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}'],
        // Settles instantly on the pristine root (the prepare preflight must
        // approve it) but stalls once the worker has run, so the signal lands
        // mid-contract at execute time.
        contractSource: "import { existsSync, writeFileSync } from \"node:fs\";\n"
          + "if (existsSync(\"worker-task.txt\")) {\n"
          + "  writeFileSync(\"contract-started\", \"1\");\n"
          + "  setInterval(() => {}, 60_000);\n"
          + "  await new Promise(() => {});\n"
          + "}\n",
        allowedChanges: ["ledger.json", "worker-task.txt", "contract-started"]
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const pending = executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    await waitForFile(join(round.roots[0], "contract-started"));
    const signalledAt = Date.now();
    process.kill(process.pid, "SIGTERM");
    assert.equal(await pending, 143, "the contract check honours the round's abort, not its own 20s timeout");
    assert.ok(Date.now() - signalledAt < 15_000, "settled by the signal, not the contract timeout");
  });

// ---------- FE-3 (spec §5): the completed record and terminal evidence appends ----------

// Poll the ledger itself: the reserved record of a case proves its spend has
// started while the worker is still inside the stall window.
const waitForLedgerRecord = async (
  path: string,
  matches: (record: Record<string, unknown>) => boolean
): Promise<void> => {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    const records = await readFile(path, "utf8")
      .then(text => text.trim().split("\n").filter(Boolean))
      .then(lines => lines.flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      }))
      .catch(() => []);
    if (records.some(matches)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("timed out waiting for a ledger record of " + path);
};

test("an all-pass round appends a reconciled completed record and exits zero",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-write", transport: "stdin-file",
        grading: { mode: "envelope-equal", expected: { count: 1, sum: 2 } },
        outputLines: ['{"count":1,"sum":2}', "trailer: inert footer"]
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    assert.equal(code, 0, "a fully written all-pass round exits zero");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.at(-1),
      { phase: "completed", outcome: "pass", cases: 2, failed: 0, timedOut: 0 },
      "the completed record is the terminal evidence, reconciling zero failures");
  });

test("a mixed round reconciles written outcomes into the completed record",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 7 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 8000 } });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const code = await executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake, caseTimeoutMs: 1000 });
    assert.equal(code, 4, "a complete round with failures exits four");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.deepEqual(ledger.filter(r => r.phase === "case").map(r => [r.caseId, r.outcome]),
      [["case-a", "timeout"], ["case-b", "failed"]],
      "one case times out unjudged, one fails the oracle");
    assert.deepEqual(ledger.at(-1),
      { phase: "completed", outcome: "fail", cases: 2, failed: 1, timedOut: 1 },
      "the completed counts reconcile the written case records exactly");
  });

test("a ledger that dies mid-case stops at one with no completed and no later spend",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      },
      {
        id: "case-b", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 1500 } });
    const ledgerPath = join(round.evidenceRoot, "custom-round-evidence.jsonl");
    t.after(async () => { await chmod(ledgerPath, 0o600).catch(() => {}); });
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const pending = executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    // Case-a's reserved record proves its spend started inside the stall
    // window; killing the ledger there makes case-a's own case record the
    // append that cannot be written.
    await waitForLedgerRecord(ledgerPath, r => r.phase === "reserved" && r.caseId === "case-a");
    await chmod(ledgerPath, 0o000);
    assert.equal(await pending, 1, "a case record that cannot be written stops the round");
    assert.equal(await readFile(round.invocations, "utf8"), "1", "case-b's worker is never invoked");
    await chmod(ledgerPath, 0o600);
    const ledger = await readLedger(ledgerPath);
    assert.ok(!ledger.some(r => r.phase === "completed"), "a stopped round appends no completed record");
    assert.deepEqual(ledger.at(-1), { phase: "reserved", caseId: "case-a" },
      "the best-effort evidence-io stop could not land on the dead ledger either");
  });

test("a dead ledger fails the terminal case append instead of failing open",
  { timeout: 90_000 }, async t => {
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    // Graded variant: a swallowed append on a sole passing case must not
    // surface as a clean all-pass exit.
    const graded = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 1500 } });
    const gradedLedgerPath = join(graded.evidenceRoot, "custom-round-evidence.jsonl");
    t.after(async () => { await chmod(gradedLedgerPath, 0o600).catch(() => {}); });
    const gradedRun = executeRound(graded.manifestPath, graded.approvalSha256,
      { env: graded.env, sandboxExecPath: fake });
    await waitForLedgerRecord(gradedLedgerPath, r => r.phase === "reserved" && r.caseId === "case-a");
    await chmod(gradedLedgerPath, 0o000);
    assert.equal(await gradedRun, 1, "a graded case whose record cannot be written never exits zero");
    await chmod(gradedLedgerPath, 0o600);
    const gradedLedger = await readLedger(gradedLedgerPath);
    assert.ok(!gradedLedger.some(r => r.phase === "completed"),
      "no completed record without a written case record");

    // Timeout variant: an unwritten timeout outcome must not be tallied into
    // a complete-with-failures exit either.
    const stalled = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-readonly", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}']
      }
    ], {}, { codex: { stallMs: 8000 } });
    const stalledLedgerPath = join(stalled.evidenceRoot, "custom-round-evidence.jsonl");
    t.after(async () => { await chmod(stalledLedgerPath, 0o600).catch(() => {}); });
    const stalledRun = executeRound(stalled.manifestPath, stalled.approvalSha256,
      { env: stalled.env, sandboxExecPath: fake, caseTimeoutMs: 1000 });
    await waitForLedgerRecord(stalledLedgerPath, r => r.phase === "reserved" && r.caseId === "case-a");
    await chmod(stalledLedgerPath, 0o000);
    assert.equal(await stalledRun, 1, "a timed-out case whose record cannot be written never exits four");
    await chmod(stalledLedgerPath, 0o600);
    assert.ok(!(await readLedger(stalledLedgerPath)).some(r => r.phase === "completed"),
      "no completed record without a written timeout record");
  });

test("an abort mid-contract of the last case never completes and never exits 0/4",
  { timeout: 90_000 }, async t => {
    const round = await scratchExecuteRound(t, [
      {
        id: "case-a", kind: "worker-write", transport: "arg",
        grading: { mode: "strict-equal", expected: { count: 3, sum: 6 } }, outputLines: ['{"count":3,"sum":6}'],
        // Settles instantly on the pristine root (the prepare preflight must
        // approve it) but stalls once the worker has run, so the signal lands
        // mid-contract at execute time.
        contractSource: "import { existsSync, writeFileSync } from \"node:fs\";\n"
          + "if (existsSync(\"worker-task.txt\")) {\n"
          + "  writeFileSync(\"contract-started\", \"1\");\n"
          + "  setInterval(() => {}, 60_000);\n"
          + "  await new Promise(() => {});\n"
          + "}\n",
        allowedChanges: ["ledger.json", "worker-task.txt", "contract-started"]
      }
    ]);
    const fake = await writeFakeSandboxExec(t, PREPARE_PASSTHROUGH);
    const pending = executeRound(round.manifestPath, round.approvalSha256,
      { env: round.env, sandboxExecPath: fake });
    await waitForFile(join(round.roots[0], "contract-started"));
    process.kill(process.pid, "SIGTERM");
    assert.equal(await pending, 143, "an aborted round never exits 0/4");
    const ledger = await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl"));
    assert.ok(!ledger.some(r => r.phase === "completed"), "a signalled round appends no completed record");
    assert.deepEqual(ledger.at(-1), { phase: "stopped", caseId: null, reason: "signal" });
  });
