import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableFixture, prepareExecutable } from "./executable-fixture.js";

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turnhelm fixture ' space-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Entering arbitrary payload during preparation would record a task or hang.
test("fixture preparation never enters arbitrary task payload", async t => {
  const dir = await directory(t);
  const path = join(dir, "codex");
  const prepared = await executableFixture(path, `
const fs = require('node:fs');
fs.writeFileSync(__dirname + '/runs', 'entered');
process.stdin.on('data', () => fs.writeFileSync(__dirname + '/task', 'read'));
if (process.argv[2] === '--turnhelm-fixture-prepare') process.exit(17);
setInterval(() => {}, 1000);
`, "node").then(() => "prepared", () => "payload entered");
  assert.equal(prepared, "prepared");
  for (const file of ["runs", "task", "ready"]) {
    await assert.rejects(readFile(join(dir, file)), { code: "ENOENT" });
  }
  assert.equal((await stat(path + ".cjs")).mode & 0o111, 0);
  assert.equal((await readFile(path, "utf8")).includes("setInterval"), false);
});

// An env-node launcher or changed arguments/stdin would break the real records.
test("prepared Node fixture preserves argv cwd env stdin and runs exactly once", async t => {
  const dir = await directory(t);
  const path = join(dir, "codex");
  await executableFixture(path, `
const fs = require('node:fs');
let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => task += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(__dirname + '/record', JSON.stringify({ argv: process.argv.slice(2), argv1: process.argv[1], here: __dirname, pid: process.pid, cwd: process.cwd(), env: process.env, task }));
  fs.appendFileSync(__dirname + '/runs', '1');
});`, "node");
  const argv = ["space argument", "--option-like", "line\nbreak", "apostrophe'"];
  const env = { PATH: dir, FIXTURE_AUTH: "DUMMY_AUTH", PWD: "/deliberately-stale", SHLVL: "17" };
  // Native control includes Node/OS instrumentation injections without running the fixture.
  const nativeEnv = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env));"], {
    cwd: dir, env, timeout: 5000, encoding: "utf8"
  }));
  const child = spawn(path, argv, { cwd: dir, env });
  child.stdin.end("original task\n第二行");
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 0);
  const record = JSON.parse(await readFile(join(dir, "record"), "utf8"));
  assert.deepEqual(record.env, nativeEnv);
  assert.deepEqual(record.argv, argv);
  assert.equal(record.argv1, path);
  assert.equal(record.here, await realpath(dir));
  assert.equal(record.pid, child.pid);
  assert.equal(record.cwd, await realpath(dir));
  assert.equal(record.env.PATH, dir);
  assert.equal(record.env.FIXTURE_AUTH, "DUMMY_AUTH");
  assert.equal(record.env.PWD, "/deliberately-stale");
  assert.equal(record.env.SHLVL, "17");
  assert.equal(record.task, "original task\n第二行");
  assert.equal(await readFile(join(dir, "runs"), "utf8"), "1");
});

test("prepared shell fixture preserves arguments cwd and negative response", async t => {
  const dir = await directory(t);
  const path = join(dir, "git");
  await executableFixture(path, 'printf "%s\\n" "$1" "$2" "$PWD"; printf "false\\n"; exit 7\n', "shell");
  const child = spawn(path, ["space argument", "--negative"], { cwd: dir, env: { PATH: dir } });
  let stdout = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stdin.end();
  assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 7);
  assert.equal(stdout, `space argument\n--negative\n${await realpath(dir)}\nfalse\n`);
  assert.equal((await stat(path + ".sh")).mode & 0o111, 0);
});

const exited = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
};

for (const mode of ["failure", "timeout"] as const) {
  // Removing group cleanup would leave an unpiped, TERM-ignoring descendant.
  test(`fixture preparation ${mode} rejects finitely and kills its owned group`, { timeout: 20_000 }, async t => {
    const dir = await directory(t);
    const path = join(dir, "broken");
    const payload = path + ".cjs";
    await writeFile(payload, `
const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
fs.writeFileSync(__dirname + '/leader.pid', String(process.pid));
fs.writeFileSync(__dirname + '/descendant.pid', String(child.pid));
process.on('SIGTERM', () => {});
${mode === "failure" ? 'setTimeout(() => process.exit(7), 100);' : 'setInterval(() => {}, 1000);'}
`);
    const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(payload)}\n`, { mode: 0o700 });
    const ownedPids: number[] = [];
    t.after(() => {
      for (const pid of ownedPids) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    });
    const started = Date.now();
    try {
      await assert.rejects(prepareExecutable(path), mode === 'failure' ? /exited 7/ : /timed out/);
    } finally {
      // Capture both records before teardown, even if rejection fails or the helper returns early.
      const captures = await Promise.allSettled(["leader.pid", "descendant.pid"].map(async name => {
        for (;;) {
          let text: string;
          try { text = await readFile(join(dir, name), "utf8"); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (Date.now() - started >= 13_000) return;
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
          const pid = Number(text);
          assert.ok(Number.isSafeInteger(pid) && pid > 0, "invalid fixture-owned PID");
          ownedPids.push(pid);
          return;
        }
      }));
      for (const capture of captures) if (capture.status === "rejected") throw capture.reason;
    }
    assert.ok(Date.now() - started < 13_000, 'preparation must not wait for inherited pipes');
    assert.equal(await exited(Number(await readFile(join(dir, 'leader.pid'), 'utf8'))), true, 'owned leader survived');
    assert.equal(await exited(Number(await readFile(join(dir, 'descendant.pid'), 'utf8'))), true, 'owned descendant survived');
  });
}

test("fixture preparation reports spawn errors without hanging", async t => {
  await assert.rejects(prepareExecutable(join(await directory(t), 'absent')), { code: 'ENOENT' });
});

test("Node fixture rejects unsupported whitespace interpreter paths before writing", async t => {
  const dir = await directory(t);
  const path = join(dir, "codex");
  const descriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
  try {
    Object.defineProperty(process, "execPath", { ...descriptor, value: "/node path/node" });
    await assert.rejects(executableFixture(path, "throw new Error('must not run');", "node"), /whitespace.*interpreter/);
  } finally {
    Object.defineProperty(process, "execPath", descriptor);
  }
  await assert.rejects(stat(path), { code: "ENOENT" });
  await assert.rejects(stat(path + ".cjs"), { code: "ENOENT" });
});
