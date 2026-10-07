import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectPath, readProjectFile, resolveProject } from "../src/project.js";

const makeRoot = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "turnhelm-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
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
