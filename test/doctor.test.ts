import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { initProject } from "../src/init.js";
import { doctorProject } from "../src/doctor.js";
import type { ChoiceRequest, RequestSpec } from "../src/systemone.js";

const SENTINELS: NodeJS.ProcessEnv = {
  LAYA_API_KEY: "TEST_LAYA_SENTINEL",
  TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
  TURNHELM_ALLOW_HOSTED_JEV: "1"
};

const CHECK_IDS = [
  "root", "node", "codex", "git", "assets", "config",
  "backends", "credentials", "instructions", "models", "backend.laya", "backend.jev"
];

const CODEX_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'codex-cli 0.160.1\\n'; exit 0; fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  printf 'usage: codex exec\\n  --json\\n  --ephemeral\\n  --sandbox <MODE>\\n  -  read from stdin\\n'
  exit 0
fi
exit 64
`;

const GIT_SCRIPT = `#!/bin/sh
if [ "$1" = "-C" ]; then printf 'true\\n'; exit 0; fi
exit 64
`;

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBin(t: TestContext): Promise<string> {
  const dir = await tempDir(t, "turnhelm-doctor-bin-");
  for (const [name, body] of [["codex", CODEX_SCRIPT], ["git", GIT_SCRIPT]] as const) {
    const script = join(dir, name);
    await writeFile(script, body);
    await chmod(script, 0o755);
  }
  return dir;
}

async function preparedProject(t: TestContext): Promise<string> {
  const root = await tempDir(t, "turnhelm-doctor-project-");
  assert.equal((await initProject(root)).code, 0);
  return root;
}

async function snapshot(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else files.set(relative, (await readFile(join(dir, entry.name))).length);
    }
  }
  await walk(root, "");
  return files;
}

function countingRequest(): { request: ChoiceRequest; specs: RequestSpec[]; count: () => number } {
  const specs: RequestSpec[] = [];
  const request: ChoiceRequest = spec => {
    specs.push(spec);
    return Promise.resolve({ answers: { route: { type: "choice", choice: "fast" } } });
  };
  return { request, specs, count: () => specs.length };
}

function doctorEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...SENTINELS, PATH: bin, ...extra };
}

function templateConfigJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("../../assets/config.json", import.meta.url), "utf8")) as Record<string, unknown>;
}

async function writeProjectConfig(root: string, mutate?: (config: Record<string, unknown>) => void): Promise<void> {
  const config = templateConfigJson();
  mutate?.(config);
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  await writeFile(join(root, ".turnhelm", "config.json"), JSON.stringify(config));
}

test("offline doctor inspects without classifier requests and without writing", async (t) => {
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  const { request, count } = countingRequest();
  const before = await snapshot(root);
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin), request });
  assert.deepEqual(result.checks.map(check => check.id), CHECK_IDS);
  assert.equal(count(), 0, "offline doctor must make zero classifier requests");
  assert.equal(result.code, 0);
  assert.deepEqual(await snapshot(root), before, "doctor must not write any project file");
  const evidence = JSON.stringify(result.checks);
  for (const sentinel of ["TEST_LAYA_SENTINEL", "TEST_JEV_SENTINEL"]) {
    assert.ok(!evidence.includes(sentinel), "credential sentinel must never appear in evidence");
  }
});

test("missing config fails config and skips downstream checks", async (t) => {
  const root = await tempDir(t, "turnhelm-doctor-project-");
  const bin = await fakeBin(t);
  const { request, count } = countingRequest();
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin), request });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("config")?.status, "fail");
  assert.equal(byId.get("backends")?.status, "skipped");
  assert.equal(byId.get("backend.laya")?.status, "skipped");
  assert.equal(byId.get("backend.jev")?.status, "skipped");
  assert.equal(byId.get("assets")?.status, "warn");
  assert.equal(byId.get("instructions")?.status, "warn");
  assert.equal(result.code, 1);
  assert.equal(count(), 0);
});

test("malformed config fails independently and marks install inspection unverified", async (t) => {
  const root = await tempDir(t, "turnhelm-doctor-project-");
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  await writeFile(join(root, ".turnhelm", "config.json"), "{ not json");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("config")?.status, "fail");
  assert.equal(byId.get("assets")?.status, "unverified");
  assert.equal(byId.get("instructions")?.status, "unverified");
  assert.equal(byId.get("backends")?.status, "skipped");
  assert.equal(result.code, 1);
});

test("unowned skill is a failing assets check without failing instructions", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"), "user-authored skill");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("assets")?.status, "fail");
  assert.equal(byId.get("instructions")?.status, "pass");
  assert.equal(result.code, 1);
});

test("unmanaged AGENTS.md markers fail the instructions check", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, "AGENTS.md"), "<!-- turnhelm:begin v1 -->\n");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("instructions")?.status, "fail");
  assert.equal(byId.get("assets")?.status, "pass");
  assert.equal(result.code, 1);
});

test("non-Git root warns but does not fail the doctor", async (t) => {
  const root = await preparedProject(t);
  const bin = await tempDir(t, "turnhelm-doctor-bin-");
  const script = join(bin, "git");
  await writeFile(script, "#!/bin/sh\nprintf 'false\\n'\n");
  await chmod(script, 0o755);
  const codexScript = join(bin, "codex");
  await writeFile(codexScript, CODEX_SCRIPT);
  await chmod(codexScript, 0o755);
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("git")?.status, "warn");
  assert.equal(result.code, 0);
});

test("no eligible backend fails", async (t) => {
  const root = await tempDir(t, "turnhelm-doctor-project-");
  await writeProjectConfig(root, config => {
    const backends = config.backends as Record<string, unknown>;
    backends.laya = { enabled: false, url: "http://127.0.0.1:8765" };
    backends.jev = { enabled: false };
  });
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin, { TURNHELM_ALLOW_HOSTED_JEV: undefined, TYPESAFE_API_KEY: undefined }) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backends")?.status, "fail");
  assert.equal(result.code, 1);
});

test("stale model metadata is advisory and never fails the doctor", async (t) => {
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  const codexHome = await tempDir(t, "turnhelm-doctor-codexhome-");
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
    models: [{ slug: "not-a-known-model", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }] }]
  }));
  const result = await doctorProject(root, { probe: false, env: doctorEnv(bin, { CODEX_HOME: codexHome }) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.ok(["pass", "warn", "unverified"].includes(byId.get("models")?.status ?? ""));
  assert.notEqual(byId.get("models")?.status, "fail");
  assert.equal(result.code, 0);
  assert.ok(!JSON.stringify(result.checks).includes("not-a-known-model"));
});

test("probe mode requests each eligible backend exactly once and persists nothing", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: true };
  });
  const bin = await fakeBin(t);
  const { request, specs, count } = countingRequest();
  const before = await snapshot(root);
  const result = await doctorProject(root, { probe: true, env: doctorEnv(bin), request });
  assert.equal(count(), 2, "probe mode must make exactly one request per eligible backend");
  assert.deepEqual(specs.map(spec => spec.backend), ["laya", "jev"]);
  for (const spec of specs) {
    assert.ok(!spec.signal.aborted);
    assert.ok(spec.url.protocol === "http:" || spec.url.protocol === "https:");
  }
  assert.deepEqual(await snapshot(root), before, "probe mode must not persist project files");
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "pass");
  assert.equal(byId.get("backend.jev")?.status, "pass");
  assert.equal(result.code, 0);
});

test("a probe that never answers terminates on its configured budget", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    config.routingTimeoutMs = 200;
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: false };
  });
  const bin = await fakeBin(t);
  const request: ChoiceRequest = () => new Promise(() => { /* never settles, ignores signal */ });
  const started = Date.now();
  const result = await doctorProject(root, { probe: true, env: doctorEnv(bin), request });
  assert.ok(Date.now() - started < 5000, "the probe budget must terminate the wait");
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "fail");
  assert.equal(result.code, 1);
});

test("caller cancellation stops a probe without a failure", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    config.routingTimeoutMs = 5000;
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: false };
  });
  const bin = await fakeBin(t);
  const controller = new AbortController();
  const request: ChoiceRequest = spec => new Promise((_, reject) => {
    spec.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const running = doctorProject(root, { probe: true, env: doctorEnv(bin), request, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  const result = await running;
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.ok(["unverified", "skipped"].includes(byId.get("backend.laya")?.status ?? ""));
  assert.equal(result.code, 0);
});

test("an already-cancelled signal never issues probe requests", async (t) => {
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  const { request, count } = countingRequest();
  const controller = new AbortController();
  controller.abort();
  const result = await doctorProject(root, { probe: true, env: doctorEnv(bin), request, signal: controller.signal });
  assert.equal(count(), 0);
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.ok(["unverified", "skipped"].includes(byId.get("backend.laya")?.status ?? ""));
});
