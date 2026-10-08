import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { projectPath, readProjectFile, resolveProject } from "../src/project.js";

const execute = promisify(execFile);

const makeRoot = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "turnhelm-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

// The child patches node:fs.readSync (synced into the compiled module's ESM
// bindings), so patched-binding effects never reach this suite's process.
const runReadChild = async (root: string, file: string, script: string, max = 65536) => {
  const moduleUrl = new URL("../src/project.js", import.meta.url).href;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", `
    import { readProjectFile } from ${JSON.stringify(moduleUrl)};
    const { createRequire } = await import("node:module");
    const mutableFs = createRequire(import.meta.url)("node:fs");
    const { syncBuiltinESMExports } = createRequire(import.meta.url)("node:module");
    const original = mutableFs.readSync;
    const calls = [];
    const target = ${JSON.stringify(join(root, file))};
    mutableFs.readSync = function (fd, buffer, offset, length, position) {
      calls.push(length);
      ${script}
    };
    syncBuiltinESMExports();
    try {
      const content = await readProjectFile(${JSON.stringify(root)}, ${JSON.stringify(file)}, ${JSON.stringify(max)});
      console.log(JSON.stringify({ ok: true, content: content.toString(), calls }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message, calls }));
    } finally {
      mutableFs.readSync = original;
      syncBuiltinESMExports();
    }
  `], { timeout: 10000 });
  return JSON.parse(result.stdout);
};

test("explicit roots resolve canonically and never walk to a Git ancestor", async t => {
  const root = await makeRoot(t);
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "sub", "deep"), { recursive: true });
  assert.equal(resolveProject(undefined, join(root, "sub", "deep")), realpathSync(join(root, "sub", "deep")));
  assert.equal(resolveProject("sub", root), realpathSync(join(root, "sub")));
  assert.notEqual(resolveProject(undefined, join(root, "sub")), root);
});

test("resolveProject refuses missing and non-directory targets", async t => {
  const root = await makeRoot(t);
  await writeFile(join(root, "file"), "x");
  assert.throws(() => resolveProject("missing", root));
  assert.throws(() => resolveProject("file", root));
});

test("projectPath refuses absolute, upward, symlinked and nondirectory parents", async t => {
  const root = await makeRoot(t);
  assert.equal(projectPath(root, join("a", "b.txt")), join(root, "a", "b.txt"));
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "f.txt"), "x");
  await symlink(join(root, "dir"), join(root, "link"));
  assert.throws(() => projectPath(root, "/etc/passwd"));
  assert.throws(() => projectPath(root, "../outside"));
  assert.throws(() => projectPath(root, join("link", "f.txt")));
  assert.throws(() => projectPath(root, join("dir", "f.txt", "child")));
});

test("readProjectFile returns undefined for missing files and refuses nonregular paths", async t => {
  const root = await makeRoot(t);
  await mkdir(join(root, ".turnhelm"));
  assert.equal(await readProjectFile(root, join(".turnhelm", "absent.json"), 65536), undefined);
  await mkdir(join(root, "folder"));
  await assert.rejects(readProjectFile(root, "folder", 65536));
  await writeFile(join(root, "plain"), "x");
  await symlink(join(root, "plain"), join(root, "alias"));
  await assert.rejects(readProjectFile(root, "alias", 65536));
  await assert.rejects(readProjectFile(root, "../escape", 65536));
});

test("readProjectFile reads exactly 65536 bytes and rejects 65537", async t => {
  const root = await makeRoot(t);
  await writeFile(join(root, "ok.bin"), Buffer.alloc(65536, 7));
  const ok = await readProjectFile(root, "ok.bin", 65536);
  assert.ok(ok);
  assert.equal(ok.length, 65536);
  assert.ok(ok.equals(Buffer.alloc(65536, 7)));
  await writeFile(join(root, "big.bin"), Buffer.alloc(65537, 7));
  await assert.rejects(readProjectFile(root, "big.bin", 65536));
});

test("readProjectFile honors small maxima at the boundary", async t => {
  const root = await makeRoot(t);
  await writeFile(join(root, "small.bin"), "0123456789");
  assert.equal((await readProjectFile(root, "small.bin", 10))?.toString(), "0123456789");
  await assert.rejects(readProjectFile(root, "small.bin", 9));
});

test("readProjectFile loops short reads across chunk boundaries", async t => {
  const root = await makeRoot(t);
  const content = Buffer.alloc(10000, 3);
  await writeFile(join(root, "chunked.bin"), content);
  const read = await readProjectFile(root, "chunked.bin", 65536);
  assert.ok(read);
  assert.ok(read.equals(content));
});

test("readProjectFile reads all bytes of a file that grew after an earlier read", async t => {
  const root = await makeRoot(t);
  const file = join(root, "growing.bin");
  await writeFile(file, Buffer.alloc(1000, 1));
  assert.equal((await readProjectFile(root, "growing.bin", 65536))?.length, 1000);
  await appendFile(file, Buffer.alloc(500, 2));
  const grown = await readProjectFile(root, "growing.bin", 65536);
  assert.ok(grown);
  assert.equal(grown.length, 1500);
  assert.ok(grown.equals(Buffer.concat([Buffer.alloc(1000, 1), Buffer.alloc(500, 2)])));
});

test("assembles full content across real non-EOF short reads", async t => {
  const root = await makeRoot(t);
  await writeFile(join(root, "short.bin"), "0123456789");
  const payload = await runReadChild(root, "short.bin",
    "return original(fd, buffer, offset, Math.min(length, 3), position);");
  assert.equal(payload.ok, true, payload.message);
  assert.equal(payload.content, "0123456789");
  assert.ok(payload.calls.length >= 4, JSON.stringify(payload.calls));
  assert.ok(payload.calls.every((length: number) => length <= 4096), JSON.stringify(payload.calls));
});

test("caps every read to the remaining max+1 budget", async t => {
  const root = await makeRoot(t);
  await writeFile(join(root, "big.bin"), Buffer.alloc(10000, 1));
  const payload = await runReadChild(root, "big.bin",
    "return original(fd, buffer, offset, length, position);", 9);
  assert.equal(payload.ok, false);
  assert.match(payload.message, /exceeds 9 bytes/);
  assert.ok(payload.calls.length > 0);
  assert.ok(payload.calls.every((length: number) => length <= 10), JSON.stringify(payload.calls));
});

test("reads bytes appended between read calls inside one read sequence", async t => {
  const root = await makeRoot(t);
  await writeFile(join(root, "growing.bin"), "AAAA");
  const payload = await runReadChild(root, "growing.bin", `
    const read = original(fd, buffer, offset, length, position);
    if (calls.length === 1) mutableFs.appendFileSync(target, "BBBB");
    return read;
  `);
  assert.equal(payload.ok, true, payload.message);
  assert.equal(payload.content, "AAAABBBB");
  assert.deepEqual(payload.calls.length, 3);
});

test("readProjectFile rejects a FIFO promptly instead of blocking in open", { timeout: 20000 }, async t => {
  const root = await makeRoot(t);
  await execute("mkfifo", [join(root, "config")]);
  const moduleUrl = new URL("../src/project.js", import.meta.url).href;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", `
    import { readProjectFile } from ${JSON.stringify(moduleUrl)};
    try {
      await readProjectFile(${JSON.stringify(root)}, "config", 65536);
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: error.message }));
    }
  `], { timeout: 5000 });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.message, /regular file/);
});
