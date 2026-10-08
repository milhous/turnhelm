import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { executableFixture } from "./executable-fixture.js";
import { inspectCodex, inspectGit } from "../src/preflight.js";

const SENTINELS: NodeJS.ProcessEnv = {
  LAYA_API_KEY: "TEST_LAYA_SENTINEL",
  TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
  TURNHELM_ALLOW_HOSTED_JEV: "1",
  TURNHELM_CONFIG: "TEST_CONFIG_SENTINEL"
};

const GOOD_HELP = `usage: codex exec [OPTIONS] [PROMPT]

Options:
  --json           Emit JSONL events.
  --ephemeral      Do not persist session state.
  --sandbox <MODE> Set the sandbox policy.
  -                Read the prompt from stdin.
  --config <KEY=VALUE>  Override a configuration value.
`;

// Fake codex/git scripts record argv into FAKE_ARG_LOG so tests can pin that
// only `--version` / `exec --help` (and the git rev-parse form) are invoked.
const CODEX_SCRIPT = `#!/bin/sh
if [ -n "$FAKE_DELAY" ]; then /bin/sleep "$FAKE_DELAY" >/dev/null; fi
printf '%s\\n' "$*" >> "$FAKE_ARG_LOG"
if [ -n "$FAKE_ENV_DUMP" ]; then env > "$FAKE_ENV_DUMP"; fi
if [ "$1" = "--version" ]; then
  if [ -n "$FAKE_VERSION_FILE" ]; then /bin/cat "$FAKE_VERSION_FILE";
  elif [ -n "$FAKE_VERSION_TEXT" ]; then printf '%s\\n' "$FAKE_VERSION_TEXT";
  else printf 'codex-cli %s\\n' "\${FAKE_VERSION:-0.160.1}"; fi
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  if [ -n "$FAKE_HELP_FILE" ]; then cat "$FAKE_HELP_FILE"; else printf '%s' "$FAKE_HELP"; fi
  exit 0
fi
exit 64
`;

const GIT_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ARG_LOG"
if [ -n "$FAKE_ENV_DUMP" ]; then env > "$FAKE_ENV_DUMP"; fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--is-inside-work-tree" ]; then
  printf '%s\\n' "\${FAKE_GIT_ANSWER:-true}"
  exit \${FAKE_GIT_EXIT:-0}
fi
exit 64
`;

// The inspection runs with cwd = root, so the fake root must exist.
async function gitRoot(t: TestContext): Promise<string> {
  return tempDir(t, "turnhelm-preflight-root-");
}

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBin(t: TestContext, name: string, body: string): Promise<string> {
  const dir = await tempDir(t, "turnhelm-preflight-bin-");
  const script = join(dir, name);
  await executableFixture(script, body, "shell");
  return dir;
}

async function argLog(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(line => line !== "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function fakeEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...SENTINELS, PATH: bin, ...extra };
}

test("inspectCodex accepts a sufficient version with all required controls", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const log = join(await tempDir(t, "turnhelm-preflight-log-"), "args");
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_ARG_LOG: log, FAKE_HELP: GOOD_HELP }));
  assert.equal(result.ok, true);
  assert.equal(result.executable, join(bin, "codex"));
  assert.equal(result.version, "0.160.1");
  assert.deepEqual([...(result.controls ?? [])], ["--json", "--ephemeral", "--sandbox", "-"]);
  assert.deepEqual(await argLog(log), ["--version", "exec --help"]);
});

test("inspectCodex rejects 0.99.0 numerically, not lexicographically", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_VERSION: "0.99.0", FAKE_HELP: GOOD_HELP }));
  assert.equal(result.ok, false);
  assert.equal(result.version, "0.99.0");
});

test("inspectCodex accepts 0.160.1 above the floor", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_VERSION: "0.160.1", FAKE_HELP: GOOD_HELP }));
  assert.equal(result.ok, true);
});

test("inspectCodex rejects malformed version output", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_VERSION_TEXT: "codex-cli not-a-number" }));
  assert.equal(result.ok, false);
  assert.equal(result.version, undefined);
});

// E2: only well-formed `codex-cli <major>.<minor>.<patch>` evidence with safe
// numeric components may count as a version.
test("inspectCodex requires anchored codex-cli version evidence with safe numerics (E2)", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  for (const text of [
    "garbage 999.999.999",
    "codex-cli 0.160.0beta",
    "codex-cli 1e+37.160.0",
    "codex-cli 99999999999.160.0"
  ]) {
    const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_VERSION_TEXT: text, FAKE_HELP: GOOD_HELP }));
    assert.equal(result.ok, false, JSON.stringify(text) + " must not count as valid version evidence");
    assert.equal(result.version, undefined, "a rejected version must not be reported as attested");
  }
});

test("inspectCodex rejects a missing required control", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const withoutEphemeral = GOOD_HELP.split("\n").filter(line => !line.includes("--ephemeral")).join("\n");
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_HELP: withoutEphemeral }));
  assert.equal(result.ok, false);
  assert.deepEqual([...(result.controls ?? [])], ["--json", "--sandbox", "-"]);
});

test("inspectCodex never infers agents.enabled support from generic --config help", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const withConfigKey = GOOD_HELP + "  --config agents.enabled=true  Toggle agents.\n";
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_HELP: withConfigKey }));
  assert.equal(result.ok, true);
  assert.ok(!result.controls?.includes("agents.enabled"));
  assert.deepEqual([...(result.controls ?? [])], ["--json", "--ephemeral", "--sandbox", "-"]);
});

// E3: a required control must appear as an exact flag token, so unrelated
// strings that merely contain it as a prefix cannot satisfy the check.
test("inspectCodex matches exact flag tokens, not unrelated prefixes (E3)", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const hijacked = "usage: codex exec\n  - --json-disabled --ephemeral-disabled --sandbox-disabled\n";
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_HELP: hijacked }));
  assert.equal(result.ok, false);
  assert.deepEqual([...(result.controls ?? [])], ["-"]);
});

test("inspectCodex reports a missing executable without throwing", async (t) => {
  const empty = await tempDir(t, "turnhelm-preflight-empty-");
  const result = await inspectCodex("/tmp", fakeEnv(empty));
  assert.equal(result.ok, false);
  assert.equal(result.executable, undefined);
});

test("inspectCodex times out a delayed --version and keeps output sanitized", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const log = join(await tempDir(t, "turnhelm-preflight-log-"), "args");
  const started = Date.now();
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_ARG_LOG: log, FAKE_DELAY: "30" }));
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 10000, "timeout must terminate the inspection");
  assert.ok(elapsed >= 1900, "the 2s budget must elapse before giving up");
  assert.deepEqual(await argLog(log), [], "a timed-out child must be killed before reporting");
});

test("inspectCodex honors caller cancellation", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_DELAY: "30" }), controller.signal);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  // R2: the bound sits below TIMEOUT_MS so a signal-ignoring implementation
  // cannot pass via the 2s timeout path.
  assert.ok(elapsed < 1900, `cancellation must settle below the 2s budget, took ${elapsed}ms`);
});

// E1: the leader exits while a TERM-ignoring same-group descendant inherits
// the pipes, so only a group kill (with escalation) can bound the inspection.
const DESCENDANT_SCRIPT = `#!/bin/sh
trap '' TERM
printf 'codex-cli 0.160.1\\n'
/bin/sh -c 'trap "" TERM; exec /bin/sleep 30' &
printf '%s\\n' "$!" > "$FAKE_DESCENDANT_PID"
exit 0
`;

test("inspectCodex bounds a TERM-ignoring descendant that outlives the leader (E1)", async (t) => {
  const bin = await fakeBin(t, "codex", DESCENDANT_SCRIPT);
  const pidFile = join(await tempDir(t, "turnhelm-preflight-pid-"), "pid");
  const started = Date.now();
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_DESCENDANT_PID: pidFile }));
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false, "a killed inspection must not report success");
  assert.ok(elapsed < 5000, `the inspection must settle boundedly, took ${elapsed}ms`);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record the descendant pid");
  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // Probe only; the fixture-owned group must be gone.
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, "the TERM-ignoring group descendant must be killed, not left behind");
});

test("inspectCodex settles caller cancellation below the timeout despite a TERM-ignoring group (E1)", async (t) => {
  const bin = await fakeBin(t, "codex", DESCENDANT_SCRIPT);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  const started = Date.now();
  const result = await inspectCodex("/tmp", fakeEnv(bin), controller.signal);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 1900, `cancellation must settle below the 2s budget, took ${elapsed}ms`);
});

test("inspectCodex settles a non-executable spawn failure without throwing (E1)", async (t) => {
  const bin = await tempDir(t, "turnhelm-preflight-bin-");
  const script = join(bin, "codex");
  await writeFile(script, "\u007fELF-garbage-not-an-executable");
  await chmod(script, 0o755);
  const result = await inspectCodex("/tmp", fakeEnv(bin));
  assert.equal(result.ok, false);
});

// R6: the 64 KiB cap is pinned independently of the malformed-version path —
// the version line itself is valid and the padding is whitespace, so only the
// cap can reject this output (a cap-less implementation would parse the
// version, run `exec --help`, and accept).
test("inspectCodex rejects output beyond the 64 KiB cap even with valid version evidence (R6)", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const log = join(await tempDir(t, "turnhelm-preflight-log-"), "args");
  const padded = "codex-cli 0.160.1" + " ".repeat(200 * 1024);
  // Linux MAX_ARG_STRLEN (128 KiB) makes a 200 KiB env value fail execve with
  // E2BIG; pass the payload via file, mirroring the FAKE_HELP_FILE pattern.
  const versionFile = join(await tempDir(t, "turnhelm-preflight-version-"), "version");
  await writeFile(versionFile, padded + "\n");
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_ARG_LOG: log, FAKE_VERSION_FILE: versionFile, FAKE_HELP: GOOD_HELP }));
  assert.equal(result.ok, false);
  assert.deepEqual(await argLog(log), ["--version"], "overflow must stop the inspection at the version step");
});

test("inspectCodex subprocess env drops classifier keys and adds no managed marker", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const dump = join(await tempDir(t, "turnhelm-preflight-dump-"), "env");
  await inspectCodex("/tmp", fakeEnv(bin, { FAKE_ENV_DUMP: dump, FAKE_HELP: GOOD_HELP }));
  const childEnv = await readFile(dump, "utf8");
  for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV", "TURNHELM_CONFIG", "TURNHELM_MANAGED_CHILD"]) {
    assert.ok(!childEnv.includes(key + "="), key + " must not reach the Codex subprocess");
  }
});

test("inspectGit reports a Git work tree with the exact bounded invocation", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const root = await gitRoot(t);
  const log = join(await tempDir(t, "turnhelm-preflight-log-"), "args");
  const result = await inspectGit(root, fakeEnv(bin, { FAKE_ARG_LOG: log }));
  assert.equal(result.ok, true);
  assert.equal(result.executable, join(bin, "git"));
  const logged = await argLog(log);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].split(" "), ["-C", root, "rev-parse", "--is-inside-work-tree"]);
});

test("inspectGit reports outside-work-tree as not ok without failing hard", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const result = await inspectGit(await gitRoot(t), fakeEnv(bin, { FAKE_GIT_ANSWER: "false" }));
  assert.equal(result.ok, false);
});

test("inspectGit reports a failing rev-parse as not ok", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const result = await inspectGit(await gitRoot(t), fakeEnv(bin, { FAKE_GIT_EXIT: "128" }));
  assert.equal(result.ok, false);
});

test("inspectGit subprocess env drops classifier keys and adds no managed marker", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const dump = join(await tempDir(t, "turnhelm-preflight-dump-"), "env");
  await inspectGit(await gitRoot(t), fakeEnv(bin, { FAKE_ENV_DUMP: dump }));
  const childEnv = await readFile(dump, "utf8");
  for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV", "TURNHELM_CONFIG", "TURNHELM_MANAGED_CHILD"]) {
    assert.ok(!childEnv.includes(key + "="), key + " must not reach the Git subprocess");
  }
});

// E9: a relative PATH entry must be resolved against the caller's frame
// before any cwd change — otherwise a same-relative-path binary in the
// selected project runs instead of the chosen one.
const WRONG_PROJECT_SCRIPT = `#!/bin/sh
printf 'wrong-project\\n' > "$FAKE_WRONG_MARKER"
if [ "$1" = "--version" ]; then printf 'codex-cli 0.160.1\\n'; exit 0; fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  printf 'usage: codex exec\\n  --json\\n  --ephemeral\\n  --sandbox <MODE>\\n  -  read from stdin\\n'
  exit 0
fi
exit 64
`;

const WRONG_PROJECT_GIT_SCRIPT = `#!/bin/sh
printf 'wrong-project\\n' > "$FAKE_WRONG_MARKER"
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then printf 'true\\n'; exit 0; fi
exit 64
`;

test("inspectCodex resolves a relative PATH entry against the caller before cwd changes (E9)", async (t) => {
  const caller = await tempDir(t, "turnhelm-preflight-caller-");
  const project = await tempDir(t, "turnhelm-preflight-project-");
  await mkdir(join(caller, "bin"));
  await executableFixture(join(caller, "bin", "codex"), CODEX_SCRIPT, "shell");
  await mkdir(join(project, "bin"));
  await executableFixture(join(project, "bin", "codex"), WRONG_PROJECT_SCRIPT, "shell");
  const sentinel = join(project, "WRONG_PROJECT_RAN");
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(caller);
  const result = await inspectCodex(project, { ...SENTINELS, PATH: "./bin", FAKE_HELP: GOOD_HELP, FAKE_WRONG_MARKER: sentinel });
  assert.equal(result.ok, true, "the caller-resolved binary must satisfy the inspection");
  assert.equal(result.version, "0.160.1");
  assert.ok(!existsSync(sentinel), "the wrong project's binary must never run");
});

test("inspectGit resolves a relative PATH entry against the caller before cwd changes (E9)", async (t) => {
  const caller = await tempDir(t, "turnhelm-preflight-caller-");
  const project = await tempDir(t, "turnhelm-preflight-project-");
  await mkdir(join(caller, "bin"));
  await executableFixture(join(caller, "bin", "git"), GIT_SCRIPT, "shell");
  await mkdir(join(project, "bin"));
  await executableFixture(join(project, "bin", "git"), WRONG_PROJECT_GIT_SCRIPT, "shell");
  const sentinel = join(project, "WRONG_PROJECT_RAN");
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(caller);
  const result = await inspectGit(project, { ...SENTINELS, PATH: "./bin", FAKE_WRONG_MARKER: sentinel });
  assert.equal(result.ok, true);
  assert.ok(!existsSync(sentinel), "the wrong project's git must never run");
});

// E12: a same-group descendant with stdio:ignore does not hold the leader
// pipes, so leader close alone must not discharge the owned group.
const DETACHED_DESCENDANT_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  /bin/sleep 30 >/dev/null 2>&1 </dev/null &
  printf '%s\\n' "$!" > "$FAKE_DESCENDANT_PID"
  printf 'codex-cli 0.160.1\\n'
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  printf 'usage: codex exec\\n  --json\\n  --ephemeral\\n  --sandbox <MODE>\\n  -  read from stdin\\n'
  exit 0
fi
exit 64
`;

test("inspectCodex kills a same-group descendant that does not hold the leader pipes (E12)", async (t) => {
  const bin = await fakeBin(t, "codex", DETACHED_DESCENDANT_SCRIPT);
  const pidFile = join(await tempDir(t, "turnhelm-preflight-pid-"), "pid");
  const result = await inspectCodex("/tmp", fakeEnv(bin, { FAKE_DESCENDANT_PID: pidFile }));
  assert.equal(result.ok, true, "the leader itself completed its inspection");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "the fixture must record the descendant pid");
  const deadline = Date.now() + 1500;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // Probe only; the fixture-owned group must be gone.
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, "the owned descendant must not outlive the settled inspection");
});
