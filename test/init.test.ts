import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectConfig } from "../src/config.js";
import { readTemplates } from "../src/assets.js";
import { applyInstallation, initProject, inspectInstallation } from "../src/init.js";

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
  const templates = readTemplates();
  assert.ok(templates.config.equals(await readFile(join(repoRoot, "assets", "config.json"))));
  assert.ok(templates.skillMd.equals(await readFile(join(repoRoot, ".agents", "skills", "turnhelm-routing", "SKILL.md"))));
  assert.ok(templates.skillYaml.equals(await readFile(join(repoRoot, ".agents", "skills", "turnhelm-routing", "agents", "openai.yaml"))));
  const skill = templates.skillMd.toString();
  assert.ok(skill.includes("<!-- turnhelm-template v1 -->"));
  assert.ok(templates.skillYaml.toString().includes("# turnhelm-template v1"));
  assert.match(skill, /turnhelm run/);
  assert.match(skill, /frontier_max/);
  assert.doesNotMatch(skill, /pnpm (run )?build|node dist\/src/);
  assert.doesNotMatch(skill, /turnhelm (route|codex)\b/);
  parseProjectConfig(JSON.parse(templates.config.toString("utf8")));
});

test("managed block names the run entry and the safety rules", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const agents = await readAgents(root);
  assert.ok(agents.startsWith("<!-- turnhelm:begin v1 -->\n"));
  assert.ok(agents.endsWith("<!-- turnhelm:end -->\n"));
  assert.match(agents, /turnhelm run/);
  assert.match(agents, /frontier_max/);
  assert.match(agents, /self-contained/);
});

test("created files land with the exact template bytes", async (t) => {
  const root = await tempProject(t);
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const templates = readTemplates();
  assert.ok((await readFile(join(root, ".turnhelm", "config.json"))).equals(templates.config));
  assert.ok((await readFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"))).equals(templates.skillMd));
  assert.ok((await readFile(join(root, ".agents", "skills", "turnhelm-routing", "agents", "openai.yaml"))).equals(templates.skillYaml));
});

test("observable file race is detected before replacement", async (t) => {
  const root = await tempProject(t);
  const templates = readTemplates();
  const { changes, planned } = await inspectInstallation(root, templates);
  assert.ok(planned.includes(".turnhelm/config.json"));
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  await writeFile(join(root, ".turnhelm", "config.json"), "mutated concurrently");
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 1);
  assert.equal(result.error, "race");
  assert.deepEqual(result.applied, []);
  assert.equal(await readFile(join(root, ".turnhelm", "config.json"), "utf8"), "mutated concurrently");
});

test("inode replacement with identical bytes still applies", async (t) => {
  const root = await tempProject(t, { agents: "hello\n" });
  const templates = readTemplates();
  const { changes } = await inspectInstallation(root, templates);
  const before = await lstat(join(root, "AGENTS.md"));
  await unlink(join(root, "AGENTS.md"));
  await writeFile(join(root, "AGENTS.md"), "hello\n");
  assert.notEqual((await lstat(join(root, "AGENTS.md"))).ino, before.ino);
  const result = await applyInstallation(root, changes);
  assert.equal(result.code, 0);
  assert.ok(result.applied.includes("AGENTS.md"));
  const agents = await readAgents(root);
  assert.ok(agents.startsWith("hello\n"));
  assert.ok(agents.includes("<!-- turnhelm:begin v1 -->"));
});

test("existing mode and CRLF style are preserved", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\r\n\r\nBody line\r\n" });
  await chmodAgents(root, 0o640);
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const info = await lstat(join(root, "AGENTS.md"));
  assert.equal(info.mode & 0o777, 0o640);
  const agents = await readAgents(root);
  assert.ok(agents.startsWith("# Team rules\r\n\r\nBody line\r\n"));
  assert.ok(agents.includes("<!-- turnhelm:begin v1 -->\r\n"));
  assert.ok(agents.endsWith("<!-- turnhelm:end -->\r\n"));
  assert.doesNotMatch(agents.slice(agents.indexOf("Body line")), /(?<!\r)\n/g);
});

async function chmodAgents(root: string, mode: number): Promise<void> {
  await chmod(join(root, "AGENTS.md"), mode);
}

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
  const templates = readTemplates();
  await writeFile(join(root, ".turnhelm", "config.json"), templates.config);
  const { changes } = await inspectInstallation(root, templates);
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

test("partial failure reports accurately and cleans only its own unchanged files", async (t) => {
  const root = await tempProject(t, { agents: "# Team rules\n\n" });
  const templates = readTemplates();
  const { changes } = await inspectInstallation(root, templates);
  assert.equal(changes[changes.length - 1].relative, "AGENTS.md");
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
