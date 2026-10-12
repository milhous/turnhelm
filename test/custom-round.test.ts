// Hermetic tests for the custom-round check launcher: the sandbox boundary is
// a path-injected fake that execs its arguments, so every classification path
// runs on every platform CI runs on. Only the darwin-gated test at the bottom
// executes a real seatbelt profile.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSandboxedCheck } from "./custom-round.js";

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
