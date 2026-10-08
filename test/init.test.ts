import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseProjectConfig } from "../src/config.js";
import { readTemplates } from "../src/assets.js";
import { applyInstallation, initProject, inspectInstallation } from "../src/init.js";

const execute = promisify(execFile);

type TempOptions = { agents?: string; skill?: string; symlinkedAgents?: boolean };
async function tempProject(t: TestContext, options: TempOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "turnhelm-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (options.agents !== undefined) await writeFile(join(root, "AGENTS.md"), options.agents);
  if (options.skill !== undefined) {
    const skill = join(root, ".agents", "skills", "turnhelm-routing");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), options.skill);
  }
  if (options.symlinkedAgents) await symlink(join(tmpdir(), "outside-agents"), join(root, "AGENTS.md"));
  return root;
}
async function snapshot(root: string): Promise<Record<string, string | undefined>> {
  const paths = ["AGENTS.md", ".turnhelm/config.json", ".agents/skills/turnhelm-routing/SKILL.md", ".agents/skills/turnhelm-routing/agents/openai.yaml"];
  const result: Record<string, string | undefined> = {};
  for (const relative of paths) {
    try { result[relative] = await readFile(join(root, relative), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
async function readAgents(root: string): Promise<string> { return readFile(join(root, "AGENTS.md"), "utf8"); }

// Runs a scenario in an isolated child so patches to node:fs/promises (via the
// mutable CJS builtin + syncBuiltinESMExports) never reach this suite.
async function runChild(t: TestContext, root: string, scenario: string): Promise<any> {
  const moduleUrl = new URL("../src/init.js", import.meta.url).href;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", `
    import * as init from ${JSON.stringify(moduleUrl)};
    import * as assets from ${JSON.stringify(new URL("../src/assets.js", import.meta.url).href)};
    const { createRequire } = await import("node:module");
    const mutableFs = createRequire(import.meta.url)("node:fs");
    const { syncBuiltinESMExports } = createRequire(import.meta.url)("node:module");
    const { join } = await import("node:path");
    const root = ${JSON.stringify(root)};
    const originalWrite = mutableFs.promises.writeFile;
    const originalRename = mutableFs.promises.rename;
    const originalUnlink = mutableFs.promises.unlink;
    const originalReadFile = mutableFs.promises.readFile;
    const originalLstat = mutableFs.promises.lstat;
    const originalReadSync = mutableFs.readSync;
    let writes = 0;
    let replacementIdentityChanged = false;
    let rootIdentityChanged = false;
    let cleanupArmed = false;
    let configWritten = false;
    let cleanupReadBytes = 0;
    const cleanupReads = [];
    const fsp0 = await import("node:fs/promises");
    const templates = await assets.readTemplates();
    const changes = await init.inspectInstallation(root, templates);
    const skillPath = join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md");
    const configPath = join(root, ".turnhelm", "config.json");
    const agentsPath = join(root, "AGENTS.md");
    const scenario = ${JSON.stringify(scenario)};
    if (scenario === "d3") {
      mutableFs.promises.writeFile = async function (p, data, opts) {
        const r = await originalWrite.call(this, p, data, opts);
        if (String(p).includes(".turnhelm-tmp-")) await originalWrite(agentsPath, "# Concurrent edit\\n");
        return r;
      };
    }
    if (scenario === "d6") {
      mutableFs.promises.rename = async function (from, to) {
        if (String(to) === skillPath) { const e = new Error("simulated EIO"); e.code = "EIO"; throw e; }
        return originalRename.call(this, from, to);
      };
      mutableFs.promises.unlink = async function (p) {
        if (String(p) === configPath) { const e = new Error("simulated EPERM"); e.code = "EPERM"; throw e; }
        return originalUnlink.call(this, p);
      };
    }
    if (scenario === "d5") {
      mutableFs.promises.writeFile = function (...args) {
        writes += 1;
        return originalWrite.apply(this, args);
      };
      mutableFs.promises.rename = function (...args) {
        writes += 1;
        return originalRename.apply(this, args);
      };
      await originalWrite(agentsPath, "# Team rules edited\\n\\n");
    }
    if (scenario === "d9") {
      mutableFs.promises.writeFile = function (...args) {
        writes += 1;
        return originalWrite.apply(this, args);
      };
      mutableFs.promises.rename = function (...args) {
        writes += 1;
        return originalRename.apply(this, args);
      };
      // Linux reuses the just-freed inode on rm+recreate; renaming the root
      // aside (it still exists) then recreating guarantees a distinct inode.
      const beforeRootIno = (await originalLstat(root)).ino;
      await fsp0.rename(root, root + "-user-moved");
      await fsp0.mkdir(root);
      rootIdentityChanged = (await originalLstat(root)).ino !== beforeRootIno;
    }
    if (scenario === "d8a" || scenario === "d8b" || scenario === "d10a" || scenario === "d10b") {
      mutableFs.promises.rename = async function (from, to) {
        if (String(to) === skillPath) {
          cleanupArmed = true;
          const e = new Error("simulated EIO"); e.code = "EIO"; throw e;
        }
        const r = await originalRename.call(this, from, to);
        if (String(to) === configPath) {
          configWritten = true;
          if (scenario === "d8a") {
            const bytes = await originalReadFile(to);
            // Linux reuses the just-freed inode on unlink+recreate; rename
            // over the live file guarantees a distinct identity everywhere.
            const beforeIno = (await originalLstat(to)).ino;
            const sibling = to + ".user-replacement";
            await originalWrite(sibling, bytes);
            await originalRename(sibling, to);
            replacementIdentityChanged = (await originalLstat(to)).ino !== beforeIno;
          }
          if (scenario === "d10a") {
            await originalUnlink(to);
            await fsp0.symlink(join(root, ".cleanup-sentinel"), to);
          }
          if (scenario === "d10b") {
            const handle = await fsp0.open(to, "a");
            await handle.write(Buffer.alloc(2 * 1024 * 1024, 0x78));
            await handle.close();
          }
        }
        return r;
      };
    }
    if (scenario === "d8b") {
      mutableFs.promises.lstat = async function (p) {
        if (configWritten && String(p) === configPath) { const e = new Error("simulated EIO"); e.code = "EIO"; throw e; }
        return originalLstat.call(this, p);
      };
    }
    if (scenario === "d10a" || scenario === "d10b") {
      mutableFs.promises.readFile = async function (p, opts) {
        const buf = await originalReadFile.call(this, p, opts);
        if (cleanupArmed) {
          cleanupReads.push(String(p));
          cleanupReadBytes += buf.length;
        }
        return buf;
      };
      mutableFs.readSync = function (fd, buffer, offset, length, position) {
        if (cleanupArmed) cleanupReadBytes += length;
        return originalReadSync.call(this, fd, buffer, offset, length, position);
      };
    }
    if (scenario === "d10a") await originalWrite(join(root, ".cleanup-sentinel"), "TOP SECRET SENTINEL BYTES");
    syncBuiltinESMExports();
    const result = await init.applyInstallation(root, changes);
    cleanupArmed = false;
    const fsp = await import("node:fs/promises");
    const agents = await fsp.readFile(agentsPath, "utf8").catch(e => e.code);
    const configExists = await fsp.readFile(configPath).then(() => true, e => e.code === "ENOENT" ? false : e.code);
    const skillExists = await fsp.readFile(skillPath).then(() => true, e => e.code === "ENOENT" ? false : e.code);
    if (scenario === "d9") await fsp0.rm(root + "-user-moved", { recursive: true, force: true }).catch(() => {});
    console.log(JSON.stringify({ ...result, writes, replacementIdentityChanged, rootIdentityChanged, agents, configExists, skillExists, cleanupReads, cleanupReadBytes }));
    process.exit(0);
  `], { timeout: 15000 });
  return JSON.parse(result.stdout);
}

test("dry-run plans but writes nothing", async (t) => {
  const root = await tempProject(t);
  const before = await snapshot(root);
  const result = await initProject(root, { dryRun: true });
  assert.equal(result.code, 0);
  assert.ok(result.planned.includes(".turnhelm/config.json"));
  assert.deepEqual(await snapshot(root), before);
});
test("init is idempotent and preserves unowned AGENTS bytes", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\r\n\r\n" });
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const first = await snapshot(root);
  assert.ok(first[".turnhelm/config.json"]);
  assert.ok(first[".agents/skills/turnhelm-routing/SKILL.md"]);
  assert.ok(first[".agents/skills/turnhelm-routing/agents/openai.yaml"]);
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  assert.deepEqual(await snapshot(root), first);
  assert.match(await readAgents(root), /^# Team rules\r\n\r\n/);
});
test("unowned skill is a conflict and leaves files unchanged", async (t) => {
  const root = await tempProject(t, { skill: "user-authored" });
  const before = await snapshot(root);
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1); assert.equal(result.error, "conflict");
  assert.deepEqual(await snapshot(root), before);
});
test("duplicate markers are a conflict", async (t) => {
  const root = await tempProject(t, { agents: "<!-- turnhelm:begin v1 -->\n<!-- turnhelm:end -->\n<!-- turnhelm:begin v1 -->\n<!-- turnhelm:end -->\n" });
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1); assert.equal(result.error, "conflict");
});
test("symlinked target is refused", async (t) => {
  const root = await tempProject(t, { symlinkedAgents: true });
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1); assert.equal(result.error, "conflict");
});

test("shipped templates are the canonical bundled assets", async () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const templates = await readTemplates();
  assert.ok(templates.config.equals(await readFile(join(repoRoot, "assets", "config.json"))));
  assert.ok(templates.skill.equals(await readFile(join(repoRoot, ".agents", "skills", "turnhelm-routing", "SKILL.md"))));
  assert.ok(templates.metadata.equals(await readFile(join(repoRoot, ".agents", "skills", "turnhelm-routing", "agents", "openai.yaml"))));
  const skill = templates.skill.toString();
  assert.ok(skill.includes("<!-- turnhelm-template v1 -->"));
  assert.ok(templates.metadata.toString().includes("# turnhelm-template v1"));
  assert.match(templates.agentsBlock, /^<!-- turnhelm:begin v1 -->/);
  assert.match(templates.agentsBlock, /<!-- turnhelm:end -->$/);
  assert.match(skill, /turnhelm run/);
  assert.match(skill, /frontier_max/);
  assert.doesNotMatch(skill, /pnpm (run )?build|node dist\/src/);
  assert.doesNotMatch(skill, /turnhelm (route|codex)\b/);
  parseProjectConfig(JSON.parse(templates.config.toString("utf8")));
});

test("shipped skill text matches the installed v1 contract", async () => {
  const skill = (await readTemplates()).skill.toString();
  assert.doesNotMatch(skill, /direct decision|fallback profile|hostedJev|backend:\s*auto|2000/);
  assert.match(skill, /backends\.jev\.enabled/);
  assert.match(skill, /backends\.laya\.enabled/);
  assert.match(skill, /\.turnhelm\/config\.json/);
  assert.match(skill, /routingTimeoutMs/);
  assert.match(skill, /TURNHELM_MANAGED_CHILD/);
  assert.match(skill, /8192 UTF-8 bytes/);
  assert.match(skill, /--write/);
  assert.match(skill, /stdin/);
  assert.match(skill, /turnhelm run/);
  assert.doesNotMatch(skill, /turnhelm (route|codex)\b/);
});

test("managed block names the run entry and the safety rules", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const agents = await readAgents(root);
  assert.ok(agents.startsWith("# Team rules\n\n"));
  assert.ok(agents.includes("<!-- turnhelm:begin v1 -->\n"));
  assert.ok(agents.endsWith("<!-- turnhelm:end -->\n"));
  assert.match(agents, /turnhelm run/);
  assert.match(agents, /frontier_max/);
  assert.match(agents, /self-contained/);
});

test("created files land with the exact template bytes", async (t) => {
  const root = await tempProject(t);
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const templates = await readTemplates();
  assert.ok((await readFile(join(root, ".turnhelm", "config.json"))).equals(templates.config));
  assert.ok((await readFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"))).equals(templates.skill));
  assert.ok((await readFile(join(root, ".agents", "skills", "turnhelm-routing", "agents", "openai.yaml"))).equals(templates.metadata));
});

test("observable file race is detected before replacement", async (t) => {
  const root = await tempProject(t);
  const templates = await readTemplates();
  const changes = await inspectInstallation(root, templates);
  assert.ok(changes.map(change => change.path).includes(".turnhelm/config.json"));
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  await writeFile(join(root, ".turnhelm", "config.json"), "mutated concurrently");
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
  assert.equal(await readFile(join(root, ".turnhelm", "config.json"), "utf8"), "mutated concurrently");
});

test("same-byte inode replacement is refused as a race", async (t) => {
  const root = await tempProject(t, { agents: "hello\n" });
  const templates = await readTemplates();
  const changes = await inspectInstallation(root, templates);
  // Linux reuses the just-freed inode on unlink+recreate; creating the
  // replacement while the original still exists and renaming over it
  // guarantees a distinct {dev,ino} identity on every POSIX filesystem.
  const beforeIno = (await lstat(join(root, "AGENTS.md"))).ino;
  const sibling = join(root, "AGENTS.md.user-replacement");
  await writeFile(sibling, "hello\n");
  await rename(sibling, join(root, "AGENTS.md"));
  assert.notEqual((await lstat(join(root, "AGENTS.md"))).ino, beforeIno);
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
  assert.equal(await readAgents(root), "hello\n");
});

test("existing parent identity change is refused as a race", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  await mkdir(join(root, ".agents", "skills", "turnhelm-routing", "agents"), { recursive: true });
  const templates = await readTemplates();
  const changes = await inspectInstallation(root, templates);
  // Linux reuses the just-freed inode on rm+recreate; renaming the original
  // aside (it still exists, so its inode cannot be reused) then recreating
  // guarantees a distinct {dev,ino} identity on every POSIX filesystem.
  const beforeIno = (await lstat(join(root, ".agents"))).ino;
  await rename(join(root, ".agents"), join(root, ".agents-user-moved"));
  await mkdir(join(root, ".agents", "skills", "turnhelm-routing", "agents"), { recursive: true });
  assert.notEqual((await lstat(join(root, ".agents"))).ino, beforeIno);
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
  assert.equal(await snapshotThenMissing(root), true);
});

test("existing mode and CRLF style are preserved despite umask", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\r\n\r\nBody line\r\n" });
  await chmod(join(root, "AGENTS.md"), 0o766);
  const previousUmask = process.umask(0o022);
  try {
    assert.equal((await initProject(root, { dryRun: false })).code, 0);
  } finally {
    process.umask(previousUmask);
  }
  const info = await lstat(join(root, "AGENTS.md"));
  assert.equal(info.mode & 0o777, 0o766);
  const agents = await readAgents(root);
  assert.ok(agents.startsWith("# Team rules\r\n\r\nBody line\r\n"));
  assert.ok(agents.includes("<!-- turnhelm:begin v1 -->\r\n"));
  assert.ok(agents.endsWith("<!-- turnhelm:end -->\r\n"));
  assert.doesNotMatch(agents.slice(agents.indexOf("Body line")), /(?<!\r)\n/g);
});

test("mode edit between inspection and apply is refused as a race", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  const templates = await readTemplates();
  const changes = await inspectInstallation(root, templates);
  await chmod(join(root, "AGENTS.md"), 0o600);
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
});

test("invalid existing config is a conflict", async (t) => {
  const root = await tempProject(t);
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  await writeFile(join(root, ".turnhelm", "config.json"), JSON.stringify({ version: 2 }));
  const before = await snapshot(root);
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
  assert.deepEqual(await snapshot(root), before);
});

test("differing owned skill is a conflict", async (t) => {
  const root = await tempProject(t);
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const skillPath = join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md");
  const installed = await readFile(skillPath, "utf8");
  await writeFile(skillPath, installed.replace("# Turnhelm Routing", "# Turnhelm Routing (edited)"));
  const before = await snapshot(root);
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
  assert.deepEqual(await snapshot(root), before);
});

test("unknown template version is a conflict", async (t) => {
  const root = await tempProject(t, { skill: "---\nname: turnhelm-routing\ndescription: x\n---\n\n<!-- turnhelm-template v2 -->\n\n# Turnhelm Routing\n" });
  const before = await snapshot(root);
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
  assert.deepEqual(await snapshot(root), before);
});

test("unbalanced markers are a conflict", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n<!-- turnhelm:begin v1 -->\nnever closed\n" });
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
});

test("nested markers are a conflict", async (t) => {
  const root = await tempProject(t, {
    agents: "<!-- turnhelm:begin v1 -->\nouter\n<!-- turnhelm:begin v1 -->\ninner\n<!-- turnhelm:end -->\nouter end\n<!-- turnhelm:end -->\n",
  });
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
});

test("symlinked ancestor is refused", async (t) => {
  const root = await tempProject(t);
  await rm(join(root, ".agents"), { recursive: true, force: true });
  await symlink(join(tmpdir(), "outside-agents-dir"), join(root, ".agents"));
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
  assert.equal((await lstat(join(root, ".agents"))).isSymbolicLink(), true);
});

test("symlinked skill metadata is refused", async (t) => {
  const root = await tempProject(t);
  const skill = join(root, ".agents", "skills", "turnhelm-routing");
  await mkdir(join(skill, "agents"), { recursive: true });
  await symlink(join(tmpdir(), "outside-openai.yaml"), join(skill, "agents", "openai.yaml"));
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
});

test("observable parent race is refused during apply", async (t) => {
  const root = await tempProject(t);
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  const templates = await readTemplates();
  await writeFile(join(root, ".turnhelm", "config.json"), templates.config);
  const changes = await inspectInstallation(root, templates);
  const outside = join(tmpdir(), "turnhelm-init-outside-skills");
  await mkdir(outside, { recursive: true });
  await rm(join(root, ".agents"), { recursive: true, force: true });
  await symlink(outside, join(root, ".agents"));
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
  assert.equal((await lstat(join(root, ".agents"))).isSymbolicLink(), true);
  assert.ok((await readFile(join(root, ".turnhelm", "config.json"))).equals(templates.config));
});

test("preflight detects a race on the last planned target before any write", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  const child = await runChild(t, root, "d5");
  assert.equal(child.code, 1);
  assert.equal(child.error, "race");
  assert.equal(child.writes, 0);
  assert.deepEqual(child.applied, []);
  assert.equal(child.agents, "# Team rules edited\n\n");
});

test("concurrent edit after the temp write is detected before rename", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  const child = await runChild(t, root, "d3");
  assert.equal(child.code, 1);
  assert.equal(child.error, "race");
  assert.deepEqual(child.applied, []);
  assert.equal(child.agents, "# Concurrent edit\n");
});

test("mid-apply write fault reports retained evidence truthfully", async (t) => {
  const root = await tempProject(t);
  const child = await runChild(t, root, "d6");
  assert.equal(child.code, 1);
  assert.equal(child.error, "write");
  assert.deepEqual(child.applied, [".turnhelm/config.json"]);
  assert.equal(child.configExists, true);
  assert.equal(child.skillExists, false);
});

test("partial failure reports accurately and cleans only its own unchanged files", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  const templates = await readTemplates();
  const changes = await inspectInstallation(root, templates);
  assert.equal(changes[changes.length - 1].path, "AGENTS.md");
  await rm(join(root, "AGENTS.md"));
  await mkdir(join(root, "AGENTS.md"));
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
  assert.equal((await lstat(join(root, "AGENTS.md"))).isDirectory(), true);
  assert.equal(await snapshotThenMissing(root), true);
});

async function snapshotThenMissing(root: string): Promise<boolean> {
  const paths = [".turnhelm/config.json", ".agents/skills/turnhelm-routing/SKILL.md", ".agents/skills/turnhelm-routing/agents/openai.yaml"];
  for (const relative of paths) {
    try { await readFile(join(root, relative)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    return false;
  }
  return true;
}

test("cleanup keeps a same-byte user replacement of a created file", async (t) => {
  const root = await tempProject(t);
  const child = await runChild(t, root, "d8a");
  assert.equal(child.replacementIdentityChanged, true, "fixture precondition: replacement identity changed");
  assert.equal(child.code, 1);
  assert.equal(child.error, "write");
  assert.deepEqual(child.applied, [".turnhelm/config.json"]);
  assert.equal(child.configExists, true);
  assert.equal(child.skillExists, false);
});

test("post-rename identity bookkeeping failure keeps applied evidence", async (t) => {
  const root = await tempProject(t);
  const child = await runChild(t, root, "d8b");
  assert.equal(child.code, 1);
  assert.equal(child.error, "write");
  assert.deepEqual(child.applied, [".turnhelm/config.json"]);
  assert.equal(child.configExists, true);
});

test("a replaced root at the same path is refused before any write", async (t) => {
  const root = await tempProject(t);
  const child = await runChild(t, root, "d9");
  assert.equal(child.rootIdentityChanged, true, "fixture precondition: root identity changed");
  assert.equal(child.code, 1);
  assert.equal(child.error, "race");
  assert.deepEqual(child.applied, []);
  assert.equal(child.writes, 0);
});

test("cleanup never reads a file it does not own", async (t) => {
  const root = await tempProject(t);
  const child = await runChild(t, root, "d10a");
  assert.equal(child.code, 1);
  assert.equal(child.error, "write");
  assert.deepEqual(child.applied, [".turnhelm/config.json"]);
  assert.deepEqual(child.cleanupReads, []);
  assert.equal(child.configExists, true);
});

test("cleanup reads owned files only within the per-target bound", async (t) => {
  const root = await tempProject(t);
  const child = await runChild(t, root, "d10b");
  assert.equal(child.code, 1);
  assert.equal(child.error, "write");
  assert.deepEqual(child.applied, [".turnhelm/config.json"]);
  assert.ok(child.cleanupReadBytes < 131072, "cleanup read " + child.cleanupReadBytes + " unbounded bytes");
  assert.equal(child.configExists, true);
});

test("unknown-version markers are a conflict, not a masked install", async (t) => {
  const root = await tempProject(t, { agents: "<!-- turnhelm:begin v2 -->\n# prior owner\n" });
  const before = await snapshot(root);
  const dry = await initProject(root, { dryRun: true });
  assert.equal(dry.code, 1);
  assert.equal(dry.error, "conflict");
  assert.deepEqual(dry.applied, []);
  assert.deepEqual(dry.planned, []);
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "conflict");
  assert.deepEqual(result.applied, []);
  assert.deepEqual(await snapshot(root), before);
});

test("an unknown marker outside a valid v1 block is not masked by it", async (t) => {
  const root = await tempProject(t, {
    agents: "<!-- turnhelm:begin v2 -->\n# prior owner\n" + (await readTemplates()).agentsBlock + "\n",
  });
  const before = await snapshot(root);
  const dry = await initProject(root, { dryRun: true });
  assert.equal(dry.code, 1);
  assert.equal(dry.error, "conflict");
  assert.deepEqual(dry.applied, []);
  assert.deepEqual(await snapshot(root), before);
});

test("unknown namespace markers fail closed in every shape", async (t) => {
  const block = (await readTemplates()).agentsBlock;
  for (const agents of [
    "<!-- turnhelm:begin v2 -->\n<!-- turnhelm:end v2 -->\n",
    block + "\n<!-- turnhelm:end -->\n",
    "<!-- turnhelm:end -->\n" + block,
  ]) {
    const root = await tempProject(t, { agents });
    const result = await initProject(root, { dryRun: true });
    assert.equal(result.code, 1, "expected conflict for: " + JSON.stringify(agents));
    assert.equal(result.error, "conflict");
    assert.deepEqual(result.applied, []);
  }
});

test("user prose about markers is not an owned marker", async (t) => {
  const root = await tempProject(t, { agents: "The docs mention turnhelm:begin v9 in plain text.\n" });
  const result = await initProject(root, { dryRun: true });
  assert.equal(result.code, 0);
  assert.ok(result.planned.includes("AGENTS.md"));
});

test("init refuses a missing project root without creating it", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "turnhelm-init-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const missing = join(base, "does-not-exist");
  const result = await initProject(missing, { dryRun: false });
  assert.equal(result.code, 1);
  assert.equal(result.error, "write");
  assert.equal(await lstat(missing).then(() => true, () => false), false);
});

test("stray CRLF outside the block does not invalidate an installed LF block", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n" });
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const agentsPath = join(root, "AGENTS.md");
  const installed = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, installed.replace("# Team rules\n", "# Team rules\r\n"));
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 0);
  assert.equal(result.planned.includes("AGENTS.md"), false);
});

test("empty AGENTS.md receives the block without a leading newline", async (t) => {
  const root = await tempProject(t, { agents: "" });
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  assert.ok((await readAgents(root)).startsWith("<!-- turnhelm:begin v1 -->\n"));
});

test("a large AGENTS.md still installs the managed block", async (t) => {
  const root = await tempProject(t, { agents: "# Big\n\n" + "x".repeat(70000) + "\n" });
  const result = await initProject(root, { dryRun: false });
  assert.equal(result.code, 0);
  assert.ok((await readAgents(root)).includes("<!-- turnhelm:begin v1 -->"));
  assert.ok((await readAgents(root)).includes("<!-- turnhelm:end -->"));
});
