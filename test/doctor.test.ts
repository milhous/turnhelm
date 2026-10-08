import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { initProject } from "../src/init.js";
import { readTemplates } from "../src/assets.js";
import { doctorProject } from "../src/doctor.js";
import { PROFILE_IDS } from "../src/config.js";
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
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
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

// R7: every doctor test gets a hermetic fake CODEX_HOME so the models check
// never consults the developer's real ~/.codex cache.
async function doctorEnv(t: TestContext, bin: string, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const codexHome = await tempDir(t, "turnhelm-doctor-codexhome-");
  return { ...SENTINELS, PATH: bin, CODEX_HOME: codexHome, ...extra };
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
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin), request });
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
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin), request });
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

// D11/E13: a Turnhelm marker with an unrecognized version must fail closed —
// never classified as "absent", never masked by an adjacent legal v1 block.
test("doctor fails instructions on an unknown-version marker", async (t) => {
  const root = await tempDir(t, "turnhelm-doctor-project-");
  await writeFile(join(root, "AGENTS.md"), "<!-- turnhelm:begin v2 -->\n# prior owner\n");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("instructions")?.status, "fail");
  assert.equal(byId.get("assets")?.status, "warn");
});

test("doctor does not let a legal v1 block mask an unknown marker", async (t) => {
  const root = await tempDir(t, "turnhelm-doctor-project-");
  const { agentsBlock } = await readTemplates();
  await writeFile(join(root, "AGENTS.md"), "<!-- turnhelm:begin v2 -->\n# prior owner\n" + agentsBlock + "\n");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("instructions")?.status, "fail");
  assert.equal(byId.get("assets")?.status, "warn");
});

// E5: a corrupted config must not un-verify independently inspectable
// assets and instructions — each install finding stands on its own.
test("malformed config fails config while installed assets and instructions stay verified (E5)", async (t) => {
  const root = await preparedProject(t);
  await mkdir(join(root, ".turnhelm"), { recursive: true });
  await writeFile(join(root, ".turnhelm", "config.json"), "{ not json");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("config")?.status, "fail");
  assert.equal(byId.get("assets")?.status, "pass");
  assert.equal(byId.get("instructions")?.status, "pass");
  assert.equal(byId.get("backends")?.status, "skipped");
  assert.equal(result.code, 1);
});

// E5: a skill conflict must not un-verify the independently inspectable
// AGENTS.md managed block.
test("unowned skill is a failing assets check while instructions stay verified (E5)", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"), "user-authored skill");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("assets")?.status, "fail");
  assert.equal(byId.get("instructions")?.status, "pass");
  assert.equal(result.code, 1);
});

// E5: an AGENTS.md conflict must not un-verify the already-checked skills.
test("unmanaged AGENTS.md markers fail the instructions check while assets stay verified (E5)", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, "AGENTS.md"), "<!-- turnhelm:begin v1 -->\n");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
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
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
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
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin, { TURNHELM_ALLOW_HOSTED_JEV: undefined, TYPESAFE_API_KEY: undefined }) });
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
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin, { CODEX_HOME: codexHome }) });
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
  const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
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
  const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
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
  let probeStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { probeStarted = resolve; });
  const request: ChoiceRequest = spec => {
    probeStarted();
    return new Promise((_, reject) => {
      spec.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const running = doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request, signal: controller.signal });
  await started;
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
  const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request, signal: controller.signal });
  assert.equal(count(), 0);
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.ok(["unverified", "skipped"].includes(byId.get("backend.laya")?.status ?? ""));
});

// E6: without --probe an eligible backend stays honestly unverified — never a
// false readiness pass — and an unauthorized one is skipped.
test("offline backend checks are unverified when eligible and skipped when unauthorized (E6)", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: true };
  });
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "unverified");
  assert.equal(byId.get("backend.jev")?.status, "unverified");
  assert.equal(result.code, 0, "unverified must not fail the offline exit code");
  const scrubbed = await doctorEnv(t, bin, { TYPESAFE_API_KEY: undefined, TURNHELM_ALLOW_HOSTED_JEV: undefined });
  const unauthorized = await doctorProject(root, { probe: false, env: scrubbed });
  const byId2 = new Map(unauthorized.checks.map(check => [check.id, check]));
  assert.equal(byId2.get("backend.jev")?.status, "skipped");
  assert.equal(byId2.get("backend.laya")?.status, "unverified");
});

// E4: probes must travel the validated single-backend choice boundary — the
// real six-criteria request with instructions — and only a valid choice
// envelope may count as a pass.
test("probe sends the real six-criteria choice request and rejects invalid envelopes (E4)", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: true };
  });
  const bin = await fakeBin(t);
  const specs: RequestSpec[] = [];
  const request: ChoiceRequest = spec => {
    specs.push(spec);
    return Promise.resolve({ not_a_choice: true });
  };
  const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
  assert.equal(specs.length, 2, "still exactly one request per eligible backend");
  assert.deepEqual(specs.map(spec => spec.backend), ["laya", "jev"]);
  for (const spec of specs) {
    const body = JSON.parse(spec.body) as {
      questions: { route: { type: string; instructions: string; criteria: Record<string, string> } };
    };
    assert.equal(body.questions.route.type, "choice");
    assert.ok(body.questions.route.instructions.trim() !== "", "the choice request must carry instructions");
    assert.deepEqual(Object.keys(body.questions.route.criteria), [...PROFILE_IDS], "all six approved criteria ids are required");
  }
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "fail", "an invalid envelope must not pass");
  assert.equal(byId.get("backend.jev")?.status, "fail", "an invalid envelope must not pass");
  assert.equal(result.code, 1);
});

test("probe rejects bare, inherited, and unknown choice envelopes (E4)", async (t) => {
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  for (const reply of [
    {},
    { answers: {} },
    { answers: { route: { type: "choice", choice: "direct" } } },
    { answers: { route: { type: "choice", choice: "turbo" } } }
  ]) {
    const request: ChoiceRequest = () => Promise.resolve(reply);
    const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
    const byId = new Map(result.checks.map(check => [check.id, check]));
    assert.equal(byId.get("backend.laya")?.status, "fail", JSON.stringify(reply) + " must not pass");
    assert.equal(result.code, 1);
  }
});

// E7: a request that throws synchronously must be contained — doctorProject
// still resolves and the raw error text never reaches the evidence.
test("a synchronously throwing probe request is contained and sanitized (E7)", async (t) => {
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  const request: ChoiceRequest = () => {
    throw new Error("PRIVATE_SYNC_PROBE");
  };
  const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "fail");
  assert.equal(result.code, 1);
  const evidence = JSON.stringify(result.checks);
  assert.ok(!evidence.includes("PRIVATE_SYNC_PROBE"), "native/private error text must be sanitized away");
});

// E7: a request that resolves after its budget must not pass — the budget
// timer cannot run while a busy request blocks the event loop, so the doctor
// rechecks a monotonic deadline before settling success.
test("a probe that resolves after its budget fails instead of passing (E7)", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    config.routingTimeoutMs = 100;
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: false };
  });
  const bin = await fakeBin(t);
  const request: ChoiceRequest = async () => {
    const until = Date.now() + 150;
    while (Date.now() < until) { /* busy-wait: timers cannot run */ }
    return { answers: { route: { type: "choice", choice: "fast" } } };
  };
  const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "fail");
  assert.equal(result.code, 1);
});

// E8: a root AGENTS.override.md is an ascertainable discovery restriction; the
// semantic question of which instructions Codex discovers stays unverified.
test("a root AGENTS.override.md is reported and discovery stays unverified (E8)", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, "AGENTS.override.md"), "# user override\n");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("instructions")?.status, "unverified");
  assert.ok(byId.get("instructions")?.evidence.includes("AGENTS.override.md"), "the override must be named in the evidence");
  assert.equal(byId.get("assets")?.status, "pass", "the skills check stays independent");
  assert.equal(result.code, 0, "unverified must not fail the exit code");
});

// E8: version/help facts are not proof of runtime config-key semantics; the
// codex evidence must say so instead of claiming full support.
test("codex evidence reports unresolved config-key semantics rather than full support (E8)", async (t) => {
  const root = await preparedProject(t);
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("codex")?.status, "pass", "the CLI flag facts still pass");
  const evidence = byId.get("codex")?.evidence ?? "";
  assert.ok(evidence.includes("agents.enabled"), "unresolved agents.enabled semantics must be reported");
  assert.ok(!/supports the required controls/.test(evidence), "help output alone must not be claimed as full runtime support");
});

// E10: a missing managed block must warn, never pass — even when a sibling
// conflict stops the shared installation inspection.
test("missing managed block warns when a config conflict stops the shared inspection (E10)", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, "AGENTS.md"), "# ordinary user guidance, no managed markers\n");
  await writeFile(join(root, ".turnhelm", "config.json"), "{}");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("instructions")?.status, "warn", "a missing block must warn, never pass");
  assert.ok(!/block is installed/.test(byId.get("instructions")?.evidence ?? ""), "the evidence must not claim the block is installed");
  assert.equal(byId.get("assets")?.status, "pass", "the sibling skills check stays independently evaluated");
  assert.equal(result.code, 1, "the corrupted config still fails the doctor");
});

test("missing managed block warns under a skill conflict too (E10)", async (t) => {
  const root = await preparedProject(t);
  await writeFile(join(root, ".agents", "skills", "turnhelm-routing", "SKILL.md"), "user-authored skill");
  await writeFile(join(root, "AGENTS.md"), "# ordinary user guidance, no managed markers\n");
  const bin = await fakeBin(t);
  const result = await doctorProject(root, { probe: false, env: await doctorEnv(t, bin) });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("instructions")?.status, "warn", "a missing block must warn, never pass");
  assert.equal(byId.get("assets")?.status, "fail", "the sibling skills conflict still fails independently");
  assert.equal(result.code, 1);
});

// E11: the probe deadline is monotonic (performance.now), so neither a
// backward nor a forward wall-clock correction can swing the budget recheck.
test("probe deadline ignores a backward wall-clock correction (E11)", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    config.routingTimeoutMs = 100;
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: false };
  });
  const bin = await fakeBin(t);
  const realNow = Date.now;
  const request: ChoiceRequest = async () => {
    const until = performance.now() + 150;
    while (performance.now() < until) { /* busy-wait: timers cannot run */ }
    Date.now = () => realNow() - 1000; // clock correction before the valid reply
    return { answers: { route: { type: "choice", choice: "fast" } } };
  };
  try {
    const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
    const byId = new Map(result.checks.map(check => [check.id, check]));
    assert.equal(byId.get("backend.laya")?.status, "fail", "a backward clock correction must not satisfy the budget recheck");
    assert.equal(result.code, 1);
  } finally {
    Date.now = realNow;
  }
});

test("probe deadline ignores a forward wall-clock correction (E11)", async (t) => {
  const root = await preparedProject(t);
  await writeProjectConfig(root, config => {
    config.routingTimeoutMs = 100;
    const backends = config.backends as Record<string, unknown>;
    backends.jev = { enabled: false };
  });
  const bin = await fakeBin(t);
  const realNow = Date.now;
  const request: ChoiceRequest = async () => {
    const until = performance.now() + 10;
    while (performance.now() < until) { /* brief busy so the reply is later than start */ }
    Date.now = () => realNow() + 1000; // forward correction before the valid reply
    return { answers: { route: { type: "choice", choice: "fast" } } };
  };
  try {
    const result = await doctorProject(root, { probe: true, env: await doctorEnv(t, bin), request });
    const byId = new Map(result.checks.map(check => [check.id, check]));
    assert.equal(byId.get("backend.laya")?.status, "pass", "a forward clock correction must not fail a timely probe");
    assert.equal(result.code, 0);
  } finally {
    Date.now = realNow;
  }
});
