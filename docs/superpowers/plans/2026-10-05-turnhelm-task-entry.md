# Turnhelm Task Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build project-scoped init/doctor/run and ordinary automatic selection of all six model/effort presets through bounded Laya-to-authorized-Jev classification.

**Architecture:** One project snapshot, one logical decision, and one Codex worker. Keep strict configuration, bounded task/HTTP/event handling, and installer/diagnostic responsibilities separate; share only concrete root, asset, and inspection helpers. No daemon, registry, persistent cache, model planner, compatibility adapter, or max gate.

**Tech Stack:** TypeScript, Node.js built-ins, Node test runner, pnpm, Codex CLI; no new runtime dependency is planned.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-05-turnhelm-task-entry-design.md`.
- Node `>=22.8.0`, pnpm `10.12.1`; initial execution support is macOS/Linux and Codex CLI `>=0.160.0` with the required controls.
- Exactly `fast`, `balanced`, `deep`, `frontier`, `frontier_xhigh`, `frontier_max`; starter bindings are respectively Luna/low, Sol/medium, Sol/high, Astra/high, Astra/xhigh, Astra/max, using `gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`.
- All six are normal candidates. No `--allow-max`, `allowMax`, profile-disable setting, silent substitution, or automatic execution retry.
- Current directory is the default project; only `--project` changes it. Only `<project>/.turnhelm/config.json` supplies Turnhelm configuration.
- Config <=64 KiB; task and classifier response <=8192 bytes; worker event <=1 MiB; classify budget default 4000 ms, integer 100..30000 ms.
- With two eligible backends Laya gets `min(1000, floor(budget/4))` ms; Jev gets the remainder. One request per eligible backend; no additional hot-path probe.
- Jev requires project enablement, `TURNHELM_ALLOW_HOSTED_JEV=1`, and nonblank `TYPESAFE_API_KEY`. Laya is HTTP loopback only; classification transport explicitly bypasses proxy agents.
- Default read-only, explicit per-run `--write`; ephemeral single worker; no bypass of client security rules or hook trust.
- Fake credentials/executables/backends only in offline tests. Never invoke real `codex exec`, `test:live`, Jev/Laya probes, or paid benefit trials during this plan's hermetic gates.
- Coverage >=80% lines/branches/functions. Preserve stdin/spawn/stream/privacy regressions even when obsolete public behavior is removed.
- `private:true` stays; no publishing or pushing without a separate request.

## Execution sequence and build discipline

Create an implementation worktree with `superpowers:using-git-worktrees` when
execution is authorized. This document is not authorization to execute it.

`tsconfig.json` compiles every source and test, including the nonexecuted live
harness. Do not hide failures with `--noCheck`, test exclusion, or legacy-format
acceptance. Tasks 1–3 add named internal project contracts alongside current
exports so old fixtures still compile. Tasks 4–5 add independently testable
onboarding. Task 6 cuts the CLI over and rewrites its fixtures; Task 7 removes
the obsolete functions and associated behavior tests. This temporary source
staging is not shipped compatibility: do not merge/publish an intermediate tree.

For each RED/GREEN checkpoint use the same focused target. After each GREEN run
`pnpm run build`, the focused tests, and `git diff --check`; inspect the diff and
run `pnpm audit --audit-level high` before a commit. Commit the test-only RED and
minimal GREEN separately. Preserve checkpoints; never stage unrelated user work.

## File ownership and stable interfaces

| Task | Owns |
| --- | --- |
| 1 | `src/config.ts`, `src/task.ts`, new `src/project.ts`, `assets/config.json`, `test/project-config.test.ts`, `test/task-input.test.ts`, `test/project.test.ts`, `test/fixtures.ts` |
| 2 | `src/systemone.ts`, `src/route.ts`, `test/task-routing.test.ts`, `test/direct-transport.test.ts` |
| 3 | `src/codex.ts`, new `src/codex-events.ts`, `test/worker.test.ts`, `test/codex-events.test.ts` |
| 4 | new `src/assets.ts`, `src/init.ts`, canonical `.agents/skills/turnhelm-routing` files, `test/init.test.ts` |
| 5 | new `src/preflight.ts`, `src/doctor.ts`, `test/preflight.test.ts`, `test/doctor.test.ts`; diagnostic use of `src/models.ts` only |
| 6 | `src/cli.ts`, `test/cli.test.ts` |
| 7 | obsolete exports/tests, `test/live.integration.ts`, `package.json`, `examples/config.json`, `README.md`, new `test/package.test.ts` and final gates |

No generic service container is needed. The final contracts are:

```ts
// src/config.ts
export type ProfileId = "fast" | "balanced" | "deep" | "frontier" | "frontier_xhigh" | "frontier_max";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type TaskProfile = Readonly<{ model: string; effort: Effort }>;
export type ProjectConfig = Readonly<{
  version: 1; routingTimeoutMs: number;
  backends: Readonly<{ laya: Readonly<{ enabled: boolean; url: string }>; jev: Readonly<{ enabled: boolean }> }>;
  profiles: Readonly<Record<ProfileId, TaskProfile>>;
}>;
export function parseProjectConfig(value: unknown): ProjectConfig;
export function readProjectConfig(root: string): Promise<ProjectConfig>;

// src/project.ts, src/task.ts
export function resolveProject(project?: string, cwd?: string): string;
export function projectPath(root: string, relative: string): string;
export function readProjectFile(root: string, relative: string, max: number): Promise<Buffer | undefined>;
export function validateTask(input: string | Uint8Array): string;
export function readTask(positional: string | undefined, stdin: NodeJS.ReadableStream & { isTTY?: boolean }, signal?: AbortSignal): Promise<string>;

// src/systemone.ts, src/route.ts
export type TaskBackend = "laya" | "jev";
export type RequestSpec = Readonly<{ backend: TaskBackend; url: URL; body: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }>;
export type ChoiceRequest = (spec: RequestSpec) => Promise<Response>;
export type TaskAttempt = Readonly<{ backend: TaskBackend; outcome: "success" | "failed" | "timeout"; durationMs: number }>;
export type TaskDecision = Readonly<{ backend: TaskBackend; profileId: ProfileId; profile: TaskProfile; attempts: readonly TaskAttempt[]; routingMs: number }>;
export function eligibleBackends(config: ProjectConfig, env: NodeJS.ProcessEnv): readonly TaskBackend[];
export function requestTaskChoice(config: ProjectConfig, task: string, backend: TaskBackend, env: NodeJS.ProcessEnv, signal: AbortSignal, request?: ChoiceRequest): Promise<ProfileId>;
export function routeTask(task: string, config: ProjectConfig, options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }): Promise<TaskDecision>;

// src/codex-events.ts, src/codex.ts
export type WorkerUsage = Readonly<{ input_tokens: number; output_tokens: number; cached_input_tokens?: number; reasoning_output_tokens?: number }>;
export type WorkerResult = Readonly<{ code: number; status: "completed" | "failed" | "cancelled"; durationMs: number; usage?: WorkerUsage; usageScope: "reported_terminal" | "unverified"; error?: "spawn" | "stdin" | "protocol" | "output" | "worker" }>;
export function buildWorkerArgs(decision: TaskDecision, root: string, write: boolean): string[];
export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function executeWorker(decision: TaskDecision, task: string, options: { executable: string; root: string; write: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal; output: NodeJS.WritableStream }): Promise<WorkerResult>;

// src/assets.ts, src/init.ts
export type Templates = Readonly<{ config: Buffer; skill: Buffer; metadata: Buffer; agentsBlock: string }>;
export type Change = Readonly<{ path: string; before?: Buffer; after: Buffer; mode: number }>;
export function readTemplates(): Promise<Templates>;
export function inspectInstallation(root: string, templates: Templates): Promise<readonly Change[]>;
export function applyInstallation(root: string, changes: readonly Change[]): Promise<readonly string[]>;
export function initProject(root: string, options: { dryRun: boolean }): Promise<{ applied: readonly string[]; planned: readonly string[] }>;

// src/preflight.ts, src/doctor.ts
export type Inspection = Readonly<{ ok: boolean; executable?: string; version?: string; controls?: readonly string[] }>;
export function inspectCodex(root: string, env: NodeJS.ProcessEnv): Promise<Inspection>;
export function inspectGit(root: string, env: NodeJS.ProcessEnv): Promise<Inspection>;
export type CheckStatus = "pass" | "warn" | "fail" | "unverified" | "skipped";
export type DoctorCheck = Readonly<{ id: string; status: CheckStatus; evidence: string; next: string }>;
export function doctorProject(root: string, options: { probe: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }): Promise<{ code: 0 | 1; checks: readonly DoctorCheck[] }>;
```

### Task 1: Add project configuration and bounded task input

**Deliverable:** strict new-format parsing and project/task primitives, usable in
unit tests without starting classifiers or Codex. Existing public exports remain
only until the final cleanup; new parsing never accepts their formats.

**Interfaces:** produces `ProjectConfig`, `TaskProfile`, `ProfileId`, `Effort`,
`parseProjectConfig`, `readProjectConfig`, `resolveProject`, `projectPath`,
`readProjectFile`, `validateTask`, `readTask` with the signatures above.

- [ ] **Step 1: Create the single starter asset and test fixture.** Copy the exact
  JSON block from the spec into `assets/config.json`. In `test/fixtures.ts`, define
  the fixture factory below; later tasks import it rather than duplicating mutable
  config or borrowing a real user's settings.

  ```ts
  import { readFileSync } from "node:fs";
  import { parseProjectConfig, type ProjectConfig } from "../src/config.js";
  export function fixtureConfig(): ProjectConfig {
    return parseProjectConfig(JSON.parse(readFileSync(new URL("../../assets/config.json", import.meta.url), "utf8")));
  }
  export function decisionResponse(choice = "fast"): Response {
    return new Response(JSON.stringify({ answers: { route: { type: "choice", choice } } }));
  }
  export const fakeEnv: NodeJS.ProcessEnv = {
    LAYA_API_KEY: "TEST_LAYA_SENTINEL", TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
    TURNHELM_ALLOW_HOSTED_JEV: "1"
  };
  ```

- [ ] **Step 2: Add executable RED cases before new implementation.** Use the
  following tests in `test/project-config.test.ts` and `test/task-input.test.ts`.
  Add imports for `node:test`, `node:assert/strict`, the fixture, and the tested
  exports; no real home or services are touched.

  ```ts
  test("six fixed profiles include ungated Astra high/xhigh/max", () => {
    const c = fixtureConfig();
    assert.deepEqual(Object.keys(c.profiles), ["fast", "balanced", "deep", "frontier", "frontier_xhigh", "frontier_max"]);
    assert.equal(c.profiles.frontier.effort, "high");
    assert.equal(c.profiles.frontier_max.effort, "max");
    assert.ok(Object.isFrozen(c.profiles.frontier_max));
  });
  test("reject legacy format, unknown max setting and missing profile", () => {
    assert.throws(() => parseProjectConfig({ backend: "laya", profiles: {} }));
    const c = JSON.parse(JSON.stringify(fixtureConfig()));
    assert.throws(() => parseProjectConfig({ ...c, allowMax: false }));
    delete c.profiles.frontier_max;
    assert.throws(() => parseProjectConfig(c));
  });
  test("task bounds use original UTF-8 bytes", () => {
    assert.equal(validateTask("x".repeat(8192)), "x".repeat(8192));
    assert.throws(() => validateTask("x".repeat(8193)));
    assert.equal(validateTask("界".repeat(2730)), "界".repeat(2730));
    assert.throws(() => validateTask("界".repeat(2731)));
    assert.throws(() => validateTask(Uint8Array.of(0xc3, 0x28)));
    assert.throws(() => validateTask("task\0text"));
    assert.throws(() => validateTask(" do the above! "));
    assert.equal(validateTask("Continue fixing cache invalidation in src/cache.ts"), "Continue fixing cache invalidation in src/cache.ts");
    assert.equal(validateTask(" \nFix one bug. 😀\n "), " \nFix one bug. 😀\n ");
  });
  test("TTY positional task never waits for EOF", async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    assert.equal(await readTask("Fix a bug", stdin), "Fix a bug");
    await assert.rejects(readTask(undefined, stdin));
    stdin.destroy();
  });
  test("nonempty pipe plus positional conflicts; empty pipe is allowed", async () => {
    await assert.rejects(readTask("Fix A", Readable.from(["Fix B"])));
    assert.equal(await readTask("Fix A", Readable.from([])), "Fix A");
  });
  ```

  Run `pnpm run build && node --test dist/test/project-config.test.js dist/test/task-input.test.js dist/test/project.test.js`.
  Expected RED: new exports are absent; existing source/tests otherwise remain
  well-typed. Missing new API references are the intended compile-time RED, not a
  reason to disable the strict build. Commit only added tests/asset as
  `test: specify project task-entry contracts`.

- [ ] **Step 3: Add the strict configuration implementation.** Add these new
  declarations to `src/config.ts` without modifying legacy declarations yet.
  `readProjectConfig` reads `.turnhelm/config.json` through Task 1's file helper.

  ```ts
  export const PROFILE_IDS = ["fast", "balanced", "deep", "frontier", "frontier_xhigh", "frontier_max"] as const;
  export type ProfileId = (typeof PROFILE_IDS)[number];
  export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
  export type TaskProfile = Readonly<{ model: string; effort: Effort }>;
  export type ProjectConfig = Readonly<{
    version: 1; routingTimeoutMs: number;
    backends: Readonly<{ laya: Readonly<{ enabled: boolean; url: string }>; jev: Readonly<{ enabled: boolean }> }>;
    profiles: Readonly<Record<ProfileId, TaskProfile>>;
  }>;
  function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project config");
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).length !== keys.length || keys.some(k => !Object.hasOwn(obj, k))) throw new Error("Invalid project config");
    return obj;
  }
  export function parseProjectConfig(value: unknown): ProjectConfig {
    const v = exactObject(value, ["version", "routingTimeoutMs", "backends", "profiles"]);
    if (v.version !== 1 || !Number.isInteger(v.routingTimeoutMs) || (v.routingTimeoutMs as number) < 100 || (v.routingTimeoutMs as number) > 30000) throw new Error("Invalid project config");
    const backends = exactObject(v.backends, ["laya", "jev"]);
    const laya = exactObject(backends.laya, ["enabled", "url"]);
    const jev = exactObject(backends.jev, ["enabled"]);
    if (typeof laya.enabled !== "boolean" || typeof jev.enabled !== "boolean" || typeof laya.url !== "string" || laya.url.length > 200 || /[\x00-\x20\x7f]/.test(laya.url)) throw new Error("Invalid project config");
    const u = new URL(laya.url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("Invalid Laya origin");
    const rawProfiles = exactObject(v.profiles, PROFILE_IDS);
    const profiles = Object.create(null) as Record<ProfileId, TaskProfile>;
    for (const id of PROFILE_IDS) {
      const p = exactObject(rawProfiles[id], ["model", "effort"]);
      if (typeof p.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(p.model) || !["low", "medium", "high", "xhigh", "max"].includes(p.effort as string)) throw new Error("Invalid profile binding");
      profiles[id] = Object.freeze({ model: p.model, effort: p.effort as Effort });
    }
    return Object.freeze({ version: 1, routingTimeoutMs: v.routingTimeoutMs as number,
      backends: Object.freeze({ laya: Object.freeze({ enabled: laya.enabled, url: u.origin }), jev: Object.freeze({ enabled: jev.enabled }) }),
      profiles: Object.freeze(profiles) });
  }
  export async function readProjectConfig(root: string): Promise<ProjectConfig> {
    const bytes = await readProjectFile(root, ".turnhelm/config.json", 64 * 1024);
    if (!bytes) throw new Error("Project config missing");
    return parseProjectConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  ```

- [ ] **Step 4: Add concrete root/file/input helpers.** In `src/project.ts` use
  `realpathSync(resolve(cwd, project ?? "."))`; verify the root is a directory.
  `projectPath` rejects absolute relative paths and any `..` component, resolves
  below that root, then `lstat`s every existing descendant. Reject symlinks and
  nondirectory parents. `readProjectFile` opens with
  `constants.O_RDONLY | constants.O_NOFOLLOW`, verifies the handle is a regular
  file, reads at most `max + 1` bytes, rejects actual excess, and closes in finally.
  Missing leaf returns undefined; other errors return fixed safe errors. Add
  directory, symlink, growth-after-stat and outside-root tests in `project.test.ts`.

  The task policy code is:

  ```ts
  const continuationOnly = /^(?:continue|go on|proceed|do the above|继续|接着做|按刚才的方案继续|按上面做)[.!。！\s]*$/iu;
  export function validateTask(input: string | Uint8Array): string {
    const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
    if (bytes.length > 8192) throw new Error("Task exceeds 8192 UTF-8 bytes");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (typeof input === "string" && text !== input) throw new Error("Invalid task Unicode");
    if (!text.trim() || text.includes("\0") || continuationOnly.test(text.trim())) throw new Error("Complete task required");
    return text;
  }
  export async function readTask(positional: string | undefined, stdin: NodeJS.ReadableStream & { isTTY?: boolean }, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (stdin.isTTY) {
      if (positional === undefined) throw new Error("Task input required");
      return validateTask(positional);
    }
    let size = 0;
    const chunks: Buffer[] = [];
    const stop = () => { if ("destroy" in stdin) (stdin as import("node:stream").Readable).destroy(); };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const chunk of stdin) {
        signal?.throwIfAborted();
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > 8192) throw new Error("Task exceeds 8192 UTF-8 bytes");
        chunks.push(b);
      }
      signal?.throwIfAborted();
      if (positional !== undefined && size > 0) throw new Error("Conflicting task input");
      return validateTask(positional ?? Buffer.concat(chunks));
    } finally { signal?.removeEventListener("abort", stop); }
  }
  ```

- [ ] **Step 5: Run the same focused target GREEN, strict full build and diff
  check.** Expect all new cases to pass and no changed legacy behavior. Audit,
  review, then commit only Task 1 files as
  `feat(config): add strict project task-entry contracts`.

### Task 2: Add bounded direct transport and local-first routing

**Deliverable:** a new `routeTask` entry with an immutable decision and no legacy
direct/fallback/metadata behavior; fake request injection keeps hosted tests offline.

**Interfaces:** consumes Task 1's `ProjectConfig`, `validateTask` and `PROFILE_IDS`;
produces `RequestSpec`, `ChoiceRequest`, `TaskBackend`, `TaskAttempt`, `TaskDecision`,
`eligibleBackends`, `requestTaskChoice`, `routeTask`. Keep old exports until Task 7,
but do not call them from the new path.

- [ ] **Step 1: Add targeted RED tests in `task-routing.test.ts`.**
  Every positive fake response uses the exact nested protocol envelope
  `{"answers":{"route":{"type":"choice","choice":"fast"}}}`; add one
  negative bare-string `answers.route` response to prove it is rejected.

  ```ts
  test("normal max can be selected with one Laya call and no worker", async () => {
    const c = fixtureConfig();
    let calls = 0;
    const d = await routeTask("Prove the coupled transaction invariants", c, { env: fakeEnv,
      request: async spec => { calls++; assert.equal(spec.backend, "laya"); return decisionResponse("frontier_max"); } });
    assert.equal(calls, 1); assert.equal(d.profile.effort, "max");
    assert.equal(d.profile, c.profiles.frontier_max);
    assert.ok(Object.isFrozen(d));
  });
  test("eligible Jev is used once after Laya failure", async () => {
    const c = parseProjectConfig({ ...fixtureConfig(), backends: { ...fixtureConfig().backends, jev: { enabled: true } } });
    const calls: string[] = [];
    const d = await routeTask("Investigate the cross-module invariant failure", c, { env: fakeEnv,
      request: async s => { calls.push(s.backend); if (s.backend === "laya") throw new Error("TEST_PRIVATE_SENTINEL"); return decisionResponse("deep"); } });
    assert.deepEqual(calls, ["laya", "jev"]); assert.equal(d.backend, "jev");
  });
  test("bare-string route is invalid and all failures stop", async () => {
    await assert.rejects(routeTask("Fix cache invalidation", fixtureConfig(), { env: fakeEnv,
      request: async () => new Response(JSON.stringify({ answers: { route: "fast" } })) }));
  });
  test("abort never tries Jev", async () => {
    const ac = new AbortController();
    const c = parseProjectConfig({ ...fixtureConfig(), backends: { ...fixtureConfig().backends, jev: { enabled: true } } });
    const calls: string[] = [];
    await assert.rejects(routeTask("Fix cache invalidation", c, { env: fakeEnv, signal: ac.signal,
      request: async s => { calls.push(s.backend); ac.abort(); throw new Error("cancelled"); } }));
    assert.deepEqual(calls, ["laya"]);
  });
  ```

  Run `pnpm run build && node --test dist/test/task-routing.test.js dist/test/direct-transport.test.js`.
  Expected RED: missing new route/request exports. Commit
  `test: specify bounded six-profile classification`.

- [ ] **Step 2: Add one explicitly direct request seam to `src/systemone.ts`.**
  Use built-in HTTP/HTTPS agents, not a new fetch/proxy framework. The request
  implementation is below; add the standard imports it uses.

  ```ts
  export async function directChoiceRequest(spec: RequestSpec): Promise<Response> {
    const secure = spec.url.protocol === "https:";
    const agent = secure
      ? new HttpsAgent({ keepAlive: false, proxyEnv: {} })
      : new HttpAgent({ keepAlive: false, proxyEnv: {} });
    return new Promise<Response>((resolve, reject) => {
      let incoming: IncomingMessage | undefined;
      const req = (secure ? httpsRequest : httpRequest)(spec.url, {
        method: "POST", agent, signal: spec.signal,
        headers: { ...spec.headers, "accept-encoding": "identity" },
        ...(secure ? { rejectUnauthorized: true } : {})
      }, res => {
        incoming = res;
        res.once("close", () => agent.destroy());
        const status = res.statusCode ?? 500;
        if (status < 200 || status > 599 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")) {
          res.destroy(); agent.destroy(); reject(new Error("Classifier unavailable")); return;
        }
        const headers = new Headers();
        if (res.headers["content-length"]) headers.set("content-length", res.headers["content-length"]);
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      });
      req.once("error", () => { incoming?.destroy(); agent.destroy(); reject(new Error("Classifier unavailable")); });
      req.end(spec.body);
    });
  }
  ```

  `http.Agent`/`https.Agent` are imported as `HttpAgent`/`HttpsAgent`, and request
  functions as `httpRequest`/`httpsRequest`; `IncomingMessage` is a type import,
  and `Readable` comes from `node:stream`. Use an explicit empty proxy environment
  on agents; older supported Node ignores the extra option and remains direct.
  Test on the package's minimum runtime and current Node rather than changing
  the floor to avoid a transport bug.

- [ ] **Step 3: Implement the exact choice request and bounded decoder.**
  Six criteria are fixed short strings matching the spec's intended distinctions;
  no user description field or model-generated summary is added. Decode only
  the nested envelope; classifier token accounting stays `unreported` because the
  used contract does not document a token-usage schema.

  ```ts
  export type TaskBackend = "laya" | "jev";
  export type RequestSpec = Readonly<{ backend: TaskBackend; url: URL; body: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }>;
  export type ChoiceRequest = (spec: RequestSpec) => Promise<Response>;
  const criteria = {
    fast: "Small localized work; clear requirements and acceptance checks",
    balanced: "Routine implementation or debugging with bounded scope",
    deep: "Difficult bounded debugging, review, and multistep reasoning",
    frontier: "Very difficult ambiguous work with interacting cross-system constraints",
    frontier_xhigh: "Demanding reasoning requiring detailed argument and verification",
    frontier_max: "Exceptional hardest problems needing maximum single-worker depth"
  };
  export function eligibleBackends(c: ProjectConfig, env: NodeJS.ProcessEnv): readonly TaskBackend[] {
    const out: TaskBackend[] = [];
    if (c.backends.laya.enabled) out.push("laya");
    if (c.backends.jev.enabled && env.TURNHELM_ALLOW_HOSTED_JEV === "1" && env.TYPESAFE_API_KEY?.trim()) out.push("jev");
    return out;
  }
  async function signalRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
    signal.throwIfAborted();
    let stop: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => { stop = () => reject(new Error("Classifier unavailable")); signal.addEventListener("abort", stop, { once: true }); });
    try { return await Promise.race([reader.read(), aborted]); }
    finally { signal.removeEventListener("abort", stop); }
  }
  async function boundedChoice(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 8192) {
      void response.body?.cancel().catch(() => {}); throw new Error("Classifier unavailable");
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(8192);
    let size = 0;
    try {
      for (;;) {
        const chunk = await signalRead(reader, signal);
        if (chunk.done) break;
        if (chunk.value.length > 8192 - size) throw new Error("Classifier unavailable");
        bytes.set(chunk.value, size); size += chunk.value.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } catch {
      void reader.cancel().catch(() => {}); throw new Error("Classifier unavailable");
    } finally { try { reader.releaseLock(); } catch {} }
  }
  export async function requestTaskChoice(c: ProjectConfig, task: string, backend: TaskBackend, env: NodeJS.ProcessEnv, signal: AbortSignal, request: ChoiceRequest = directChoiceRequest): Promise<ProfileId> {
    validateTask(task); signal.throwIfAborted();
    if (!eligibleBackends(c, env).includes(backend)) throw new Error("Backend not eligible");
    const key = backend === "laya" ? env.LAYA_API_KEY : env.TYPESAFE_API_KEY;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const body = JSON.stringify({ state: task, model: backend === "laya" ? "typed-decisions" : "jev-latest",
      questions: { route: { type: "choice", instructions: "Choose the lightest profile meeting the task's difficulty and correctness needs.", criteria } } });
    const response = await request({ backend, url: new URL("/v1/systemone", backend === "laya" ? c.backends.laya.url : "https://api.typesafe.ai"), headers, body, signal });
    const data = await boundedChoice(response, signal) as { answers?: { route?: { type?: unknown; choice?: unknown } } };
    const answer = data?.answers?.route;
    if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(c.profiles, answer.choice)) throw new Error("Invalid classifier choice");
    return answer.choice as ProfileId;
  }
  ```

- [ ] **Step 4: Add the shared-deadline route function in `src/route.ts`.**

  ```ts
  export type TaskAttempt = Readonly<{ backend: TaskBackend; outcome: "success" | "failed" | "timeout"; durationMs: number }>;
  export type TaskDecision = Readonly<{ backend: TaskBackend; profileId: ProfileId; profile: TaskProfile; attempts: readonly TaskAttempt[]; routingMs: number }>;
  export async function routeTask(task: string, c: ProjectConfig, o: { env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }): Promise<TaskDecision> {
    validateTask(task); o.signal?.throwIfAborted();
    const backends = eligibleBackends(c, o.env);
    if (!backends.length) throw new Error("No eligible classifier");
    const start = performance.now();
    const total = AbortSignal.timeout(c.routingTimeoutMs);
    const attempts: TaskAttempt[] = [];
    for (const backend of backends) {
      o.signal?.throwIfAborted();
      const remaining = c.routingTimeoutMs - (performance.now() - start);
      if (remaining < 1 || total.aborted) break;
      const budget = backend === "laya" && backends.length === 2 ? Math.min(1000, Math.floor(c.routingTimeoutMs / 4), remaining) : remaining;
      const local = AbortSignal.timeout(Math.max(1, Math.floor(budget)));
      const signal = AbortSignal.any([total, local, ...(o.signal ? [o.signal] : [])]);
      const before = performance.now();
      try {
        const profileId = await requestTaskChoice(c, task, backend, o.env, signal, o.request);
        o.signal?.throwIfAborted(); signal.throwIfAborted();
        attempts.push(Object.freeze({ backend, outcome: "success", durationMs: performance.now() - before }));
        return Object.freeze({ backend, profileId, profile: c.profiles[profileId], attempts: Object.freeze(attempts), routingMs: performance.now() - start });
      } catch {
        o.signal?.throwIfAborted();
        attempts.push(Object.freeze({ backend, outcome: signal.aborted ? "timeout" : "failed", durationMs: performance.now() - before }));
      }
    }
    throw new Error("Classification failed");
  }
  ```

- [ ] **Step 5: Expand the boundary table and run GREEN.** Test all eligibility
  combinations; each six-profile choice; null/array/missing/bare/prototype replies;
  8192/8193-byte chunks, misleading Content-Length, invalid JSON/UTF-8; deadline
  while reading; cancel rejecting/never resolving; no fallback on user abort.
  For `direct-transport.test.ts`, run two temporary loopback servers, one as a
  proxy sentinel. In an isolated Node subprocess set proxy env on, request the
  classifier fixture through `directChoiceRequest`, and assert proxy requests zero.
  Check redirect and error responses never contact a second origin. Hosted paths
  use injected `ChoiceRequest`, never the real hostname.
  Run the same focused command, strict build, audit/diff review. Commit
  `feat(router): classify six profiles with bounded direct requests`.

### Task 3: Execute one bounded Codex worker

**Deliverable:** one worker process with exact decision binding, JSONL transport, sanitized
stderr/diagnostics, terminal event success semantics, bounded cancellation, and no
classifier credentials. Keep the existing close-after-stdio and early-error races
covered while removing inherited raw stdio.

**Interfaces:** produces `WorkerUsage`, `WorkerResult`, `buildWorkerArgs`,
`workerEnvironment`, and `executeWorker` from the stable interfaces table.

- [ ] **Step 1: Write RED tests in `test/codex-events.test.ts` and migrate the
  existing child-process tests into `test/worker.test.ts`.** Use pure event lines:

  ```ts
  test("requires one successful terminal turn", () => {
    assert.deepEqual(parseWorkerEvents([
      { type: "thread.started", thread_id: "x" },
      { type: "item.completed", item: { type: "agent_message", text: "result" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }
    ]), { messages: ["result"], usage: { input_tokens: 10, output_tokens: 3 }, terminal: "completed" });
    assert.equal(parseWorkerEvents([{ type: "turn.failed" }]).terminal, "failed");
  });
  test("ignores unknown valid events and rejects oversized/malformed frames", () => {
    assert.doesNotThrow(() => parseWorkerEvents([{ type: "future.event", data: 1 }]));
    assert.throws(() => parseWorkerEvents(["{" + "x".repeat(1024 * 1024) + "}"]));
    assert.throws(() => parseWorkerEvents(["not-json"]));
  });
  test("usage snapshot is not double-counted", () => {
    const result = parseWorkerEvents([
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } },
      { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } }
    ]);
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
    assert.equal(result.usageScope, "unverified");
  });
  ```

  Add a fake executable that writes valid JSONL to stdout, sends a secret/source
  sentinel to stderr, optionally exits zero after `turn.failed`, closes its stdout
  early, ignores SIGTERM, or writes a partial UTF-8 frame. Assert no raw sentinel
  appears in the parent diagnostic output; malformed/oversized transport terminates
  the owned worker; an ignoring worker receives KILL after the one-second grace.
  Run `pnpm run build && node --test dist/test/codex-events.test.js dist/test/worker.test.js`.
  Expected RED: event module and new worker interface are absent. Commit
  `test: specify bounded worker event and cancellation contracts`.

- [ ] **Step 2: Implement `src/codex-events.ts` as a small pure decoder.**

  ```ts
  export type EventParse = Readonly<{
    messages: readonly string[];
    usage?: WorkerUsage;
    usageScope: "reported_terminal" | "unverified";
    terminal?: "completed" | "failed";
  }>;
  export function parseWorkerEvents(lines: readonly unknown[]): EventParse {
    const messages: string[] = [];
    let usage: WorkerUsage | undefined;
    let usageScope: EventParse["usageScope"] = "unverified";
    let terminal: EventParse["terminal"];
    for (const line of lines) {
      const event = typeof line === "string" ? JSON.parse(line) : line;
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("worker protocol");
      const value = event as Record<string, unknown>;
      if (value.type === "turn.failed") { terminal = "failed"; continue; }
      if (value.type === "turn.completed") {
        if (terminal === "completed") usageScope = "unverified";
        terminal = "completed";
        const raw = value.usage;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const u = raw as Record<string, unknown>;
          const valid = [u.input_tokens, u.output_tokens].every(v => Number.isSafeInteger(v) && (v as number) >= 0);
          if (valid) usage = { input_tokens: u.input_tokens as number, output_tokens: u.output_tokens as number,
            ...(Number.isSafeInteger(u.cached_input_tokens) && (u.cached_input_tokens as number) >= 0 ? { cached_input_tokens: u.cached_input_tokens as number } : {}),
            ...(Number.isSafeInteger(u.reasoning_output_tokens) && (u.reasoning_output_tokens as number) >= 0 ? { reasoning_output_tokens: u.reasoning_output_tokens as number } : {}) };
          usageScope = valid && terminal === "completed" && !usage ? "reported_terminal" : "unverified";
        }
        continue;
      }
      if (value.type === "item.completed" && value.item && typeof value.item === "object") {
        const item = value.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") messages.push(item.text);
      }
    }
    return Object.freeze({ messages: Object.freeze(messages), ...(usage ? { usage: Object.freeze(usage) } : {}), usageScope, ...(terminal ? { terminal } : {}) });
  }
  ```

  The streaming adapter splits UTF-8 bytes into newline frames before parsing,
  carries at most `1 MiB + 3` bytes for a frame, rejects invalid UTF-8 and
  nonempty truncated final frames, and ignores unknown valid event types. It
  never retains raw tool inputs, results, stderr, or the full event stream.

- [ ] **Step 3: Extend worker process arguments and environment.**

  ```ts
  export function buildWorkerArgs(d: TaskDecision, root: string, write: boolean): string[] {
    const args = ["exec", "--ephemeral", "--json", "--sandbox", write ? "workspace-write" : "read-only",
      "--config", "agents.enabled=false"];
    args.push("--model", d.profile.model, "--config", `model_reasoning_effort=${JSON.stringify(d.profile.effort)}`, "-");
    return args;
  }
  export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const copy = { ...env, TURNHELM_MANAGED_CHILD: "1" };
    for (const key of ["LAYA_API_KEY", "TYPESAFE_API_KEY", "TURNHELM_ALLOW_HOSTED_JEV", "TURNHELM_CONFIG"]) delete copy[key];
    return copy;
  }
  ```

  The worker's selected binding comes only from `TaskDecision`; do not reread
  config. Keep Codex authentication untouched. Add exact argv/environment assertions
  for read-only/write, all six efforts including max, `--ephemeral`, JSONL,
  `agents.enabled=false`, project root, no classifier secrets, and managed-child.

- [ ] **Step 4: Implement `executeWorker`.** Spawn with `shell:false`, `cwd: root`,
  stdin/stdout/stderr pipes, resolved executable, and `workerEnvironment`. Drain
  stdout/stderr concurrently. Write the task and track stdin errors. Feed stdout
  frames to `parseWorkerEvents`; on parse/output/parent-EPIPE/cancellation, destroy
  stdin and the owned process group. On SIGINT/SIGTERM abort the operation and
  return 130/143; send TERM then KILL after 1000 ms. Resolve only after `close`.
  Success requires code 0, no stdin/transport/cancellation failure, and terminal
  `turn.completed`; otherwise return a sanitized `WorkerResult`. Never log raw
  child stderr or arbitrary event error text.

- [ ] **Step 5: Run focused GREEN, then commit.** Run the same worker/event tests,
  strict build, audit, and diff check. Commit
  `feat(worker): run one bounded jsonl codex worker`.

### Task 4: Add safe assets and project-only init

**Deliverable:** package-relative canonical templates, dry-run/idempotent init, and
owned AGENTS block without global writes, package installation, service startup, or
configuration migration.

**Interfaces:** produces `Templates`, `Change`, `readTemplates`,
`inspectInstallation`, and `initProject` from the stable interfaces table.

- [ ] **Step 1: Add RED tests in `test/init.test.ts` and assets.** Put this
  complete temporary-project helper at the top of the test file, then use it in
  the cases below. It snapshots only files this operation is allowed to touch:

  ```ts
  import test, { type TestContext } from "node:test";
  import assert from "node:assert/strict";
  import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
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
    const paths = ["AGENTS.md", ".turnhelm/config.json", ".agents/skills/turnhelm-routing/SKILL.md"];
    const result: Record<string, string | undefined> = {};
    for (const relative of paths) {
      try { result[relative] = await readFile(join(root, relative), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return result;
  }
  async function readAgents(root: string): Promise<string> { return readFile(join(root, "AGENTS.md"), "utf8"); }
  ```

  Tests create a temporary unrelated project and assert:

  ```ts
  test("dry-run plans but writes nothing", async () => {
    const root = await tempProject(t);
    const before = await snapshot(root);
    const result = await initProject(root, { dryRun: true });
    assert.ok(result.planned.includes(".turnhelm/config.json"));
    assert.deepEqual(await snapshot(root), before);
  });
  test("init is idempotent and preserves unowned AGENTS bytes", async () => {
    const root = await tempProject(t, { agents: "# Team rules\r\n\r\n" });
    await initProject(root, { dryRun: false }); const first = await snapshot(root);
    await initProject(root, { dryRun: false });
    assert.deepEqual(await snapshot(root), first);
    assert.match(await readAgents(root), /^# Team rules\r\n\r\n/);
  });
  test("unowned skill is a conflict and leaves files unchanged", async () => {
    const root = await tempProject(t, { skill: "user-authored" });
    const before = await snapshot(root);
    await assert.rejects(initProject(root, { dryRun: false }), /conflict/);
    assert.deepEqual(await snapshot(root), before);
  });
  test("duplicate markers are a conflict", async () => {
    const root = await tempProject(t, { agents: "<!-- turnhelm:begin v1 -->\n<!-- turnhelm:end -->\n<!-- turnhelm:begin v1 -->\n<!-- turnhelm:end -->\n" });
    await assert.rejects(initProject(root, { dryRun: false }), /marker/);
  });
  test("symlinked target is refused", async () => {
    const root = await tempProject(t, { symlinkedAgents: true });
    await assert.rejects(initProject(root, { dryRun: false }), /symlink/);
  });
  ```

  For the race case, call `inspectInstallation(root, templates)`, mutate one
  planned file with `writeFile`, then call `applyInstallation(root, changes)` and
  assert a `changed`/`race` error with no replacement. Use `mkdtemp`, `t.after`,
  and `lstat` in these tests; do not use the real repository or home directory.

  Add `assets/config.json` from Task 1 and ship the canonical skill directory by
  adding `.agents/skills/turnhelm-routing` and its `agents/openai.yaml` to
  `package.json.files`. Replace the skill's old `route/codex` checkout fallback
  with the installed `turnhelm run` entry, six profiles, and managed-child rule.
  Add a `<!-- turnhelm-template v1 -->` ownership line to shipped skill/YAML.
  Expected RED; commit `test: specify project onboarding safety`.

- [ ] **Step 2: Implement `src/assets.ts` using module-relative URLs.** Resolve
  `new URL("../assets/config.json", import.meta.url)` and canonical skill URLs,
  read regular bounded files, and return immutable template buffers. Do not use
  `process.cwd()`, a source checkout path, or symlinks for template discovery.
  A missing template is an install error, never a reason to generate a fallback.

- [ ] **Step 3: Implement ownership-aware `inspectInstallation`.** Use
  `lstat` on every existing target parent and leaf. Plan only root-contained files:
  `.turnhelm/config.json`, `.agents/skills/turnhelm-routing/SKILL.md`, its metadata,
  and `AGENTS.md`. Existing valid config is preserved; missing config gets the
  exact template. Existing same-name skill without the template marker is a
  conflict. AGENTS uses `<!-- turnhelm:begin v1 -->` and
  `<!-- turnhelm:end -->`; duplicate/unbalanced/nested markers are conflicts.
  Preserve bytes/mode/line endings outside the block. Build a bounded changeset
  in memory; no installation journal.

- [ ] **Step 4: Implement `initProject`.** Preflight every change, re-stat and
  compare file identity/content immediately before each replacement, write same-
  directory temp files, fsync where supported, rename atomically per file, and
  report applied/planned paths. Apply skill/config before AGENTS activation. On
  failure remove only unchanged files this invocation created; never remove user
  directories or roll back an already changed user file. Treat hostile concurrent
  directory mutation as out of scope; detect observable races and refuse.

- [ ] **Step 5: Run GREEN and commit.** Run `pnpm run build && node --test dist/test/init.test.js`,
  audit and diff check. Commit `feat(init): install project routing assets safely`.

### Task 5: Add shared preflight and offline doctor

**Deliverable:** independent sanitized checks and explicitly gated synthetic probes;
doctor never runs Codex inference, login, repair, or persists readiness state.

**Interfaces:** produces `Inspection`, `inspectCodex`, `inspectGit`,
`CheckStatus`, `DoctorCheck`, and `doctorProject`.

- [ ] **Step 1: Write RED tests in `test/preflight.test.ts` and `test/doctor.test.ts`.**
  Test fake `codex --version`/`codex exec --help` output, missing executable,
  non-Git root, missing config, malformed config, unowned skill, no credentials,
  no eligible backend, stale model metadata, and init conflicts. Assert offline
  doctor never calls an injected classifier request, never starts fake Codex, and
  never includes credential sentinel values. Probe mode makes at most one fake
  request per eligible backend and does not persist files.

- [ ] **Step 2: Implement `src/preflight.ts` without shell interpretation.** Resolve
  `codex` from PATH using a safe executable lookup; invoke only bounded
  `codex --version` and `codex exec --help` with `shell:false`, drained pipes,
  timeout 2 seconds, and fixed sanitized errors. Parse version as a string and
  required controls as boolean facts (`--json`, `--ephemeral`, `--sandbox`, `-`).
  `inspectGit` invokes `git -C root rev-parse --is-inside-work-tree` with the same
  bounded subprocess pattern. Do not surface raw stderr.

- [ ] **Step 3: Implement `doctorProject`.** Run checks independently, returning
  stable IDs and statuses. Reuse config parsing, asset/installation inspection,
  preflight facts, and existing bounded `readCodexSignals` only as advisory
  evidence; never gate profile selection on that metadata. Presence of credentials
  is a sanitized pass/warn fact, not proof of authentication. Default probe=false.
  With probe=true call the injected single-backend request once per eligible
  backend using a fixed synthetic task, without failover, real Codex, or state write.

- [ ] **Step 4: Run GREEN and commit.** Run focused doctor/preflight tests, strict
  build, audit and diff check. Commit `feat(doctor): add offline project diagnostics`.

### Task 6: Replace the CLI with direct run/init/doctor

**Deliverable:** strict command parsing and the only production path from task to
classification to worker; no legacy route/codex invocation in the new CLI.

**Interfaces:** `src/cli.ts` calls `initProject`, `doctorProject`, `readTask`,
`readProjectConfig`, `routeTask`, and `executeWorker` exactly once per command.

- [ ] **Step 1: Add RED CLI characterization tests.** Replace the old fixture's
  global `config.json`, direct decision, fallback profiles and joined positional
  arguments with an initialized `.turnhelm` project and fake `ChoiceRequest`/Codex
  executable. Assert `init --dry-run`, `doctor --json`, `run`, `run --write`, and
  `--project` parsing. Include TTY positional input, empty/nonempty pipe conflict,
  invalid option/unknown command exit 2, preflight failure exit 1, worker terminal
  failure despite exit 0, sanitized stderr, and max selected with no max flag.

- [ ] **Step 2: Implement strict dispatch before config loading.** Parse command
  as one of `init`, `doctor`, `run`; parse `--project`, `--dry-run`, `--json`,
  `--probe`, and `--write` only where valid; reject duplicates and positional
  ambiguity. Resolve root before all command-specific work. `init` runs without a
  config. `doctor` reports independent checks. `run` rejects
  `TURNHELM_MANAGED_CHILD=1` before loading config/classifying, then reads task,
  configures an AbortController, checks preflight, snapshots config/executable,
  routes once, executes once, and emits the sanitized receipt.

- [ ] **Step 3: Implement stable exit/output behavior.** Exit 2 for usage/invalid
  task input; exit 1 for missing config, no backend, classification, transport,
  protocol, or setup failure; preserve nonzero worker exit; map SIGINT/SIGTERM to
  130/143. Stdout contains only agent messages for `run`, JSON for `doctor --json`,
  and no output for successful init. Stderr contains fixed diagnostics and the
  receipt, never raw backend/worker stderr, prompts, headers, response bodies, or
  credentials. Parent stdout `EPIPE` cancels the worker and exits cleanly.

- [ ] **Step 4: Run focused GREEN and commit.** Run CLI tests, strict build,
  audit/diff check. Commit `feat(cli): add direct project task entry`.

### Task 7: Remove obsolete paths, verify packed distribution, and update docs

**Deliverable:** no old global/fallback/direct runtime path remains, shipped skill
and assets work outside the checkout, and README describes only the new entry.

- [ ] **Step 1: Remove obsolete source contracts and migrate all compiled tests.**
  Delete legacy `RawConfig` materialization/global `loadConfig`, `direct` and
  fallback decisions, old 2000 UTF-16 task policy, and old `turnhelm route/codex`
  dispatch after the new path is green. Remove or rewrite obsolete assertions in
  `test/config.test.ts`, `test/route.test.ts`, `test/systemone.test.ts`,
  `test/cli.test.ts`, and `test/live.integration.ts`; retain all process-error,
  body-cancel, redirect, own-property, secret, and coverage fixtures under the new
  contracts. `tsconfig.json` must compile every remaining test.

- [ ] **Step 2: Add `test/package.test.ts` for a clean packed install.** Run
  `pnpm pack --pack-destination <temp>`, install the tarball with pnpm into an
  unrelated temporary Git project, assert package assets and the `turnhelm` bin
  resolve from the installed module, then run init dry-run/init/repeat and offline
  doctor using fake non-inference executables. Never `pnpm link`, import source
  checkout assets, start services, or contact a real backend.

- [ ] **Step 3: Update README, examples, and skill.** Document only `init`,
  `doctor`, `run`, project config, six profiles, Laya-first/authorized-Jev
  failover, exact nested classifier response, max ordinary selection, read-only
  default, explicit `--write`, and honest usage evidence. Remove route/codex,
  global config, fallback, direct, and 2000-unit guidance. Keep historical docs
  unchanged except where a current active command would otherwise be misleading.

- [ ] **Step 4: Run final gates and inspect the full diff.** Run:

  ```bash
  pnpm install --frozen-lockfile --ignore-scripts
  env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV \
    -u TURNHELM_CONFIG -u TURNHELM_MANAGED_CHILD pnpm test
  env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV \
    -u TURNHELM_CONFIG -u TURNHELM_MANAGED_CHILD pnpm run test:coverage
  pnpm audit --audit-level high
  git diff --check
  git status --short
  ```

  Confirm all new tests, packed install checks, six profiles, direct transport,
  protocol and shutdown boundaries are represented in output. Review the full
  diff for secrets, raw diagnostics, global writes, accidental old paths, and
  unrelated cleanup. Commit `refactor: replace legacy routing with project task entry`.

## Plan self-review checklist

- [ ] Every spec section maps to a task: root/config/task (1), classifier and
  transport (2), worker/events (3), init/assets (4), preflight/doctor (5), CLI
  (6), distribution/docs/benefit gates (7).
- [ ] Nested classifier envelope is exact; six profiles and ordinary automatic
  max selection are consistent in config, criteria, tests, and docs.
- [ ] No max flag/disable setting, compatibility adapter, daemon, cache, online
  catalog, plugin renderer, billing database, or auto escalation appears.
- [ ] Worker success is terminal-event based; raw stderr and arbitrary error text
  never cross the diagnostic boundary; owned cancellation is finite.
- [ ] TTY behavior, proxy-enabled Node, installer race scope, continuation phrases,
  process exit codes, and all-test TypeScript compilation are explicit.
- [ ] Every task ends in a focused test/build/diff/audit checkpoint and uses exact
  file ownership; no task depends on a hidden implementation detail.

After the user reviews and approves the updated specification and this plan, choose
either subagent-driven execution (fresh worker and review per task) or inline
execution with checkpoint commits. Do not implement from this document without that
explicit execution authorization.
