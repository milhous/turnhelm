import { executableFixture } from "./executable-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

// Real packed-distribution verification, fully offline: pack the tarball,
// install it with pnpm into an unrelated temporary Git project, and exercise
// the installed module — assets, bin, init dry-run/init/repeat, and a plain
// offline doctor — with a fake non-inference Codex executable. Never pnpm
// link, never import source-checkout assets, never start services, never
// contact a real backend, never run inference.

// Child environments never carry credentials or Turnhelm state.
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["TYPESAFE_API_KEY", "LAYA_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV",
    "TURNHELM_CONFIG", "TURNHELM_MANAGED_CHILD"]) {
    delete env[key];
  }
  return env;
};

// The only executable named "codex" on the child PATH is this fixture; it
// answers the bounded preflight queries and can never run a task.
const CODEX_SCRIPT = `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("codex-cli 0.160.2"); process.exit(0); }
if (argv[0] === "exec" && argv[1] === "--help") {
  console.log("Usage: codex exec [OPTIONS] [TASK]");
  console.log("  --json       emit JSONL events");
  console.log("  --ephemeral  discard session state");
  console.log("  --sandbox <MODE>");
  console.log("  -            read the task from stdin");
  process.exit(0);
}
console.error("fixture codex never runs tasks");
process.exit(1);
`;

const PLANNED = [
  ".turnhelm/config.json",
  ".agents/skills/turnhelm-routing/SKILL.md",
  ".agents/skills/turnhelm-routing/agents/openai.yaml",
  "AGENTS.md"
];

const FORBIDDEN_PREFIXES = ["src/", "test/", "examples/", "docs/", "dist/test/", ".superpowers/"];

test("the packed distribution installs offline and serves the project entry end to end",
  { timeout: 300_000 }, async t => {
    const scratch = await mkdtemp(join(tmpdir(), "turnhelm-package-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const packDir = join(scratch, "pack destination");
    await mkdir(packDir);

    // 1. Pack the real tarball from the current build output.
    const packed = await execute("pnpm", ["pack", "--pack-destination", packDir],
      { cwd: packageRoot, env: childEnv() });
    const tarballName = packed.stdout.split("\n").map(line => line.trim())
      .find(line => /(^|\/)turnhelm-[^/]*\.tgz$/.test(line));
    assert.ok(tarballName, "pnpm pack must print the tarball name");
    const tarball = tarballName.startsWith("/")
      ? tarballName
      : join(packDir, tarballName);

    // 2. The tarball ships exactly the whitelist surfaces: compiled CLI,
    //    canonical config asset, and the shared skill; no source, private
    //    dev files, or old examples.
    const listed = (await execute("tar", ["-tzf", tarball])).stdout.split("\n").map(p => p.trim());
    for (const required of [
      "package/dist/src/cli.js",
      "package/assets/config.json",
      "package/.agents/skills/turnhelm-routing/SKILL.md",
      "package/.agents/skills/turnhelm-routing/agents/openai.yaml",
      "package/package.json"
    ]) {
      assert.ok(listed.includes(required), "tarball must contain " + required);
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      assert.equal(listed.some(path => path.startsWith("package/" + prefix)), false,
        "tarball must not ship " + prefix);
    }
    const readme = (await execute("tar", ["-xOzf", tarball, "package/README.md"])).stdout;
    for (const retired of ["turnhelm route", "turnhelm codex", "profileMode", "fallbackProfile",
      "examples/config.json", "2000 UTF-16"]) {
      assert.ok(!readme.includes(retired), "packed README must not advertise retired path: " + retired);
    }
    for (const fragment of ["Node.js `>=24.0.0`", "Node 22.8 support has been dropped", "`24.x >=24.5.0`"]) {
      assert.ok(readme.includes(fragment), "packed README must state the current Node requirement: " + fragment);
    }

    // 3. Install offline into an unrelated temporary Git project whose root
    //    path contains spaces; no registry access is possible.
    const consumer = join(scratch, "consumer project");
    await mkdir(consumer);
    await execute("git", ["init", "-q"], { cwd: consumer, env: childEnv() });
    await writeFile(join(consumer, "package.json"),
      JSON.stringify({ name: "unrelated-consumer", version: "1.0.0", private: true }, undefined, 2) + "\n");
    await execute("pnpm", ["add", "--offline", "--ignore-scripts", tarball],
      { cwd: consumer, env: childEnv() });
    const installed = join(consumer, "node_modules", "turnhelm");

    // 4. Assets and the bin resolve from the INSTALLED module only.
    const configAsset = JSON.parse(await readFile(join(installed, "assets", "config.json"), "utf8"));
    assert.equal(configAsset.version, 1);
    assert.deepEqual(Object.keys(configAsset.profiles).sort(),
      ["balanced", "deep", "fast", "frontier", "frontier_max", "frontier_xhigh"]);
    const installedPackage = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as { engines: { node: string } };
    assert.equal(installedPackage.engines.node, ">=24.0.0",
      "the installed package must declare the Node 24 floor");
    const installedSkill = await readFile(join(installed, ".agents", "skills", "turnhelm-routing", "SKILL.md"), "utf8");
    for (const fragment of ["Node >=24.0.0", "22.8 support dropped", "24.x >=24.5.0"]) {
      assert.ok(installedSkill.includes(fragment), "packed skill must state the current Node requirement: " + fragment);
    }
    assert.equal((await readdir(join(installed, "dist", "src"))).includes("cli.js"), true);
    const bin = join(consumer, "node_modules", ".bin", "turnhelm");
    await readFile(bin); // pnpm created the bin link.

    // 5. Nested project space: init dry-run, init, repeat — all through the
    //    installed bin.
    const nested = join(consumer, "nested space", "app");
    await mkdir(nested, { recursive: true });
    const dryRun = await execute(bin, ["init", "--dry-run", "--project", nested], { env: childEnv() });
    for (const path of PLANNED) {
      assert.ok(dryRun.stderr.includes("planned " + path), "dry-run must plan " + path);
    }
    for (const relative of PLANNED) {
      await assert.rejects(() => readFile(join(nested, relative)), "dry-run must not write " + relative);
    }
    const applied = await execute(bin, ["init", "--project", nested], { env: childEnv() });
    for (const path of PLANNED) {
      assert.ok(applied.stderr.includes("applied " + path), "init must apply " + path);
    }
    await readFile(join(nested, ".turnhelm", "config.json"), "utf8");
    const repeat = await execute(bin, ["init", "--project", nested], { env: childEnv() });
    assert.ok(!repeat.stderr.includes("applied "),
      "a repeated init must apply nothing");
    const repeatDry = await execute(bin, ["init", "--dry-run", "--project", nested], { env: childEnv() });
    assert.ok(repeatDry.stderr.includes("nothing to install"),
      "a repeated dry-run must report an already-initialized project");

    // 6. Offline doctor through the installed bin, with the fake Codex first
    //    on PATH and nothing else reachable but the real toolchain.
    const fakeBin = join(scratch, "fake bin");
    await mkdir(fakeBin);
    const codexPath = join(fakeBin, "codex");
    await executableFixture(codexPath, CODEX_SCRIPT, "node");
    const doctorEnv = { ...childEnv(), PATH: fakeBin + ":" + process.env.PATH };
    const doctor = await execute(bin, ["doctor", "--json", "--project", nested],
      { env: doctorEnv, timeout: 60_000 });
    const result = JSON.parse(doctor.stdout) as { code: number; checks: { id: string; status: string }[] };
    const status = new Map(result.checks.map(check => [check.id, check.status]));
    for (const id of ["root", "node", "codex", "git", "config"]) {
      assert.ok(status.has(id), "doctor must report the " + id + " check");
    }
    assert.equal(status.get("root"), "pass");
    assert.equal(status.get("node"), "pass", "the installed doctor must pass the node check on the actual runtime");
    assert.equal(status.get("codex"), "pass");
    assert.equal(status.get("config"), "pass");
    assert.equal(result.code, 0);
  });
