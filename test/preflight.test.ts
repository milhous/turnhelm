import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
printf '%s\\n' "$*" >> "$FAKE_ARG_LOG"
if [ -n "$FAKE_DELAY" ]; then sleep "$FAKE_DELAY"; fi
if [ -n "$FAKE_ENV_DUMP" ]; then env > "$FAKE_ENV_DUMP"; fi
if [ "$1" = "--version" ]; then
  if [ -n "$FAKE_VERSION_TEXT" ]; then printf '%s\\n' "$FAKE_VERSION_TEXT";
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

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBin(t: TestContext, name: string, body: string): Promise<string> {
  const dir = await tempDir(t, "turnhelm-preflight-bin-");
  const script = join(dir, name);
  await writeFile(script, body);
  await chmod(script, 0o755);
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
  assert.ok(elapsed < 10000, "cancellation must terminate the inspection before the delay ends");
});

test("inspectCodex rejects output beyond the 64 KiB cap", async (t) => {
  const bin = await fakeBin(t, "codex", CODEX_SCRIPT);
  const oversize = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ARG_LOG"
dd if=/dev/zero bs=1024 count=200 2>/dev/null
exit 0
`;
  const dir = await fakeBin(t, "codex", oversize);
  const result = await inspectCodex("/tmp", fakeEnv(dir));
  assert.equal(result.ok, false);
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
  const log = join(await tempDir(t, "turnhelm-preflight-log-"), "args");
  const result = await inspectGit("/tmp/some-root", fakeEnv(bin, { FAKE_ARG_LOG: log }));
  assert.equal(result.ok, true);
  assert.equal(result.executable, join(bin, "git"));
  const logged = await argLog(log);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].split(" "), ["-C", "/tmp/some-root", "rev-parse", "--is-inside-work-tree"]);
});

test("inspectGit reports outside-work-tree as not ok without failing hard", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const result = await inspectGit("/tmp", fakeEnv(bin, { FAKE_GIT_ANSWER: "false" }));
  assert.equal(result.ok, false);
});

test("inspectGit reports a failing rev-parse as not ok", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const result = await inspectGit("/tmp", fakeEnv(bin, { FAKE_GIT_EXIT: "128" }));
  assert.equal(result.ok, false);
});

test("inspectGit subprocess env drops classifier keys and adds no managed marker", async (t) => {
  const bin = await fakeBin(t, "git", GIT_SCRIPT);
  const dump = join(await tempDir(t, "turnhelm-preflight-dump-"), "env");
  await inspectGit("/tmp", fakeEnv(bin, { FAKE_ENV_DUMP: dump }));
  const childEnv = await readFile(dump, "utf8");
  for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV", "TURNHELM_CONFIG", "TURNHELM_MANAGED_CHILD"]) {
    assert.ok(!childEnv.includes(key + "="), key + " must not reach the Git subprocess");
  }
});
