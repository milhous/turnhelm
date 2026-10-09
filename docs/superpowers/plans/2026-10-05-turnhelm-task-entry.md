# Turnhelm Task Entry Implementation Plan

> Historical execution plan: the original budget examples below predate the
> 2026-10-09 Laya-share amendment. Use the current specification and README for
> the three-quarter remaining-budget policy; do not restore the one-second cap.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build project-scoped init/doctor/run and ordinary automatic selection of all six model/effort presets through bounded Laya-to-authorized-Jev classification.

**Architecture:** One project snapshot, one logical decision, and one Codex worker. Keep strict configuration, bounded task/HTTP/event handling, and installer/diagnostic responsibilities separate; share only concrete root, asset, and inspection helpers. No daemon, registry, persistent cache, model planner, compatibility adapter, or max gate.

**Tech Stack:** TypeScript, Node.js built-ins, Node test runner, pnpm, Codex CLI; no new runtime dependency is planned.

**Spec:** `docs/superpowers/specs/2026-10-05-turnhelm-task-entry-design.md`.

**Re-reviewed:** 2026-10-07 with two independent gpt-6-astra audits of the spec,
current CodeGraph call paths, API evidence, and this plan. Documentation only;
implementation and paid trials still need separate approval.

## Global Constraints

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

## Review Focus

- Pending stdin or a blocked stdout consumer: cancellation remains effective before classification and during worker output; test in Tasks 1, 3, and 6.
- Exhausted/cancelled classification: retain every initiated attempt, emit one honest receipt, launch zero workers; test in Tasks 2 and 6.
- Failure followed by completion, repeated/partial usage: never restore success, merge snapshots, or invent zero counts; test in Task 3.
- A worker leader exits before its TERM-ignoring descendant: stop the owned group, not just the leader; test in Task 3.
- Installed tarball paths, YAML markers, and concurrent init edits: assets resolve outside the checkout and user files remain untouched on conflicts; test in Tasks 4 and 7.

## Phase 0: Documentation discovery and allowed APIs

Read these sources before implementing the corresponding task. The audits found
real errors in the old copy-ready implementations; the contracts/tests below
replace them, not a second implementation transcript.

| Source | Allowed API or pattern; guard |
| --- | --- |
| CodeGraph: `src/systemone.ts:7-22,53-79` | Reuse `POST /v1/systemone`, `state`, `questions.route`, `typed-decisions` / `jev-latest`, and the nested choice envelope; remove old direct/fallback policy. |
| [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | `exec --ephemeral --json`, task stdin `-`, `agents.enabled=false`, `item.completed` agent messages, `turn.completed` usage, and `turn.failed`; do not infer undocumented failure payloads or whole-run token scope. |
| [Node HTTP/proxies](https://nodejs.org/api/http.html#built-in-proxy-support), [Node 22.8.0 HTTP](https://nodejs.org/download/release/v22.8.0/docs/api/http.html) | `http.request` / `https.request`, explicit per-request Agent, request signal, synchronous destroy cleanup. New runtimes support `proxyEnv:{}`; minimum-runtime behavior must be tested, not assumed. |
| [Node child processes](https://nodejs.org/api/child_process.html#optionsdetached), [signals](https://nodejs.org/api/process.html#processkillpid-signal) | `spawn` with `shell:false`, `cwd`, `detached:true`, pipes; owned negative PGID TERM/KILL, handling `ESRCH`; await `close`, do not `unref()`. |
| [Node TextDecoder](https://nodejs.org/api/util.html#new-textdecoderencoding-options), [file reads](https://nodejs.org/api/fs.html#fsreadfd-buffer-offset-length-position-callback) | Fatal UTF-8 decoding; `ignoreBOM:true` preserves task bytes; loop reads using actual `bytesRead` through EOF or `max+1`. |
| `tsconfig.json`, `package.json`, `test/codex.test.ts:12-28` | Compiled modules live in `dist/src`; resolve root assets with `../../`; reuse temporary fake executables and isolated PATH, never a real worker. |

Non-inference inspection confirmed local Codex **0.160.1** exposes the required
execution flags; Node **26.5.0** passed an isolated proxy-sentinel experiment.
The declared Codex **0.160.0** minimum and Node **22.8.0** transport compatibility
remain targets to verify with actual clients, not facts established by fake
help fixtures. Version/help output cannot prove a config key is honored, model
access, or usage aggregation. Record tested versions and unresolved evidence;
do not silently raise the floor or claim every newer release is compatible.

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
| 4 | new `src/assets.ts`, `src/init.ts`, canonical `.agents/skills/turnhelm-routing` files, `package.json.files`, `test/init.test.ts` |
| 5 | new `src/preflight.ts`, `src/doctor.ts`, `test/preflight.test.ts`, `test/doctor.test.ts`; diagnostic use of `src/models.ts` only |
| 6 | `src/cli.ts`, `test/cli.test.ts` |
| 7 | obsolete exports/tests, `test/live.integration.ts`, removal of obsolete `examples/config.json`, `README.md`, new `test/package.test.ts` and final gates |

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
export type ChoiceRequest = (spec: RequestSpec) => Promise<unknown>; // bounded, decoded JSON; not a Fetch Response
export type TaskAttempt = Readonly<{ backend: TaskBackend; outcome: "success" | "failed" | "timeout" | "cancelled"; durationMs: number }>;
export type TaskDecision = Readonly<{ backend: TaskBackend; profileId: ProfileId; profile: TaskProfile; attempts: readonly TaskAttempt[]; routingMs: number }>;
export type RoutingResult =
  | Readonly<{ status: "selected"; decision: TaskDecision }>
  | Readonly<{ status: "failed" | "cancelled"; attempts: readonly TaskAttempt[]; routingMs: number }>;
export function eligibleBackends(config: ProjectConfig, env: NodeJS.ProcessEnv): readonly TaskBackend[];
export function directChoiceRequest(spec: RequestSpec): Promise<unknown>;
export function requestTaskChoice(config: ProjectConfig, task: string, backend: TaskBackend, env: NodeJS.ProcessEnv, signal: AbortSignal, request?: ChoiceRequest): Promise<ProfileId>;
export function routeTask(task: string, config: ProjectConfig, options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }): Promise<RoutingResult>;

// src/codex-events.ts, src/codex.ts
export type WorkerUsage = Readonly<{ input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; reasoning_output_tokens?: number }>;
export type WorkerEvent =
  | Readonly<{ kind: "message"; text: string }>
  | Readonly<{ kind: "completed"; usage?: WorkerUsage }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "diagnostic"; category: "worker-event-error" | "tool-progress" }>
  | Readonly<{ kind: "ignored" }>;
export function decodeWorkerEvent(frame: Uint8Array): WorkerEvent;
export type WorkerResult = Readonly<{ code: number; status: "completed" | "failed" | "cancelled"; durationMs: number; usage?: WorkerUsage; usageScope: "unverified"; error?: "spawn" | "stdin" | "protocol" | "output" | "worker" }>;
export function buildWorkerArgs(decision: TaskDecision, write: boolean): string[];
export function subprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function executeWorker(decision: TaskDecision, task: string, options: { executable: string; root: string; write: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal; output: NodeJS.WritableStream }): Promise<WorkerResult>;

// src/assets.ts, src/init.ts
export type Templates = Readonly<{ config: Buffer; skill: Buffer; metadata: Buffer; agentsBlock: string }>;
export type Change = Readonly<{ path: string; before?: Buffer; beforeIdentity?: Readonly<{ dev: number; ino: number }>; after: Buffer; mode: number }>;
export type InstallationResult = Readonly<{ code: 0 | 1; applied: readonly string[]; error?: "conflict" | "race" | "write" }>;
export function readTemplates(): Promise<Templates>;
export function inspectInstallation(root: string, templates: Templates): Promise<readonly Change[]>;
export function applyInstallation(root: string, changes: readonly Change[]): Promise<InstallationResult>;
export function initProject(root: string, options: { dryRun: boolean }): Promise<InstallationResult & Readonly<{ planned: readonly string[] }>>;

// src/preflight.ts, src/doctor.ts
export type Inspection = Readonly<{ ok: boolean; executable?: string; version?: string; controls?: readonly string[] }>;
export function inspectCodex(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Inspection>;
export function inspectGit(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Inspection>;
export type CheckStatus = "pass" | "warn" | "fail" | "unverified" | "skipped";
export type DoctorCheck = Readonly<{ id: string; status: CheckStatus; evidence: string; next: string }>;
export function doctorProject(root: string, options: { probe: boolean; env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }): Promise<{ code: 0 | 1; checks: readonly DoctorCheck[] }>;
```

### Task 1: Add project configuration and bounded task input

**Deliverable:** strict new-format parsing and project/task primitives, usable
without starting classifiers or Codex. Legacy exports remain only until Task 7;
the new parser never accepts their formats.

**Files:** ownership row 1 above.
**Interfaces:** produces `ProjectConfig`, `TaskProfile`, `ProfileId`, `Effort`,
`parseProjectConfig`, `readProjectConfig`, `resolveProject`, `projectPath`,
`readProjectFile`, `validateTask`, `readTask` with the stable signatures.
**References:** spec “Project configuration and root selection” and task bounds;
Phase 0 TextDecoder/file-read APIs.

- [ ] **Step 1: Create the single starter asset and shared test data.** Copy the
  spec's exact JSON into `assets/config.json`; do not keep a second executable
  template in examples. In `test/fixtures.ts`, define:

  ```ts
  import { readFileSync } from "node:fs";
  import { parseProjectConfig, type ProjectConfig } from "../src/config.js";
  export function fixtureConfig(): ProjectConfig {
    return parseProjectConfig(JSON.parse(readFileSync(new URL("../../assets/config.json", import.meta.url), "utf8")));
  }
  export function decisionReply(choice = "fast"): unknown {
    return { answers: { route: { type: "choice", choice } } };
  }
  export const fakeEnv: NodeJS.ProcessEnv = {
    LAYA_API_KEY: "TEST_LAYA_SENTINEL", TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
    TURNHELM_ALLOW_HOSTED_JEV: "1"
  };
  ```

- [ ] **Step 2: Write RED configuration/input tests.** Add `node:test`,
  `node:assert/strict`, `PassThrough`/`Readable`, and the tested exports:

  ```ts
  test("six fixed profiles include ungated Astra high/xhigh/max", () => {
    const c = fixtureConfig();
    assert.deepEqual(Object.keys(c.profiles), ["fast", "balanced", "deep", "frontier", "frontier_xhigh", "frontier_max"]);
    assert.equal(c.profiles.frontier.effort, "high");
    assert.equal(c.profiles.frontier_xhigh.effort, "xhigh");
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
  test("task bounds preserve original UTF-8 text", () => {
    assert.equal(validateTask("x".repeat(8192)), "x".repeat(8192));
    assert.throws(() => validateTask("x".repeat(8193)));
    assert.equal(validateTask("界".repeat(2730)), "界".repeat(2730));
    assert.throws(() => validateTask("界".repeat(2731)));
    assert.throws(() => validateTask(Uint8Array.of(0xc3, 0x28)));
    assert.throws(() => validateTask("task\0text"));
    assert.throws(() => validateTask(" do the above! "));
    assert.equal(validateTask("Continue fixing cache invalidation"), "Continue fixing cache invalidation");
    assert.equal(validateTask(" \nFix one bug. 😀\n "), " \nFix one bug. 😀\n ");
    assert.equal(validateTask("\uFEFFFix the parser"), "\uFEFFFix the parser");
    assert.throws(() => validateTask("\uD800"));
  });
  test("TTY positional input never waits for EOF", async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    assert.equal(await readTask("Fix a bug", stdin), "Fix a bug");
    await assert.rejects(readTask(undefined, stdin));
    stdin.destroy();
  });
  test("nonempty pipe conflicts; empty pipe permits positional input", async () => {
    await assert.rejects(readTask("Fix A", Readable.from(["Fix B"])));
    assert.equal(await readTask("Fix A", Readable.from([])), "Fix A");
  });
  test("abort stops pending pipe input", async () => {
    const stdin = new PassThrough();
    const ac = new AbortController();
    const pending = readTask(undefined, stdin, ac.signal);
    ac.abort();
    await assert.rejects(pending);
    assert.ok(stdin.destroyed);
  });
  ```

  Add named cases for unknown fields at every schema level, versions/types,
  timeout 100/30000 endpoints and values outside them, exactly six own profile
  IDs, bounded model/effort identifiers, origins with credentials/path/query/
  fragment, all continuation-only phrases and punctuation, split multibyte
  stdin, and already-aborted input. No local Codex metadata affects config.

  In `test/project.test.ts`, assert canonical explicit roots do not walk to a
  Git ancestor; missing files return undefined; nonregular/symlinked/outside-root
  paths are refused. Read exactly 65536 bytes successfully and reject 65537,
  including growth after stat and a deliberately short-read fixture.

  Run `pnpm run build && node --test dist/test/project-config.test.js dist/test/task-input.test.js dist/test/project.test.js`.
  Expected RED: absent new exports, not unrelated compile failures. Commit only
  tests/asset as `test: specify project task-entry contracts`.

- [ ] **Step 3: Implement the strict configuration contract in `src/config.ts`.**
  Declare `PROFILE_IDS` in the exact order above. Require own keys and reject
  unknown keys at every level; require version 1, bounded integer timeout, typed
  backend settings, all six bindings, model regex `^[a-zA-Z0-9._:/-]{1,200}$`,
  and the five effort literals. Deep-freeze the snapshot and its nested values.
  Read only `.turnhelm/config.json` with the bounded file helper; no globals,
  environment config override, availability filtering, or default substitution.

- [ ] **Step 4: Implement root/file/input primitives.** Canonicalize
  `realpathSync(resolve(cwd, project ?? "."))` and require a directory.
  `projectPath` rejects absolute relative paths, `..` components, symlinked
  descendants and nondirectory existing parents. `readProjectFile` opens with
  `O_RDONLY | O_NOFOLLOW`, checks a regular handle, loops actual reads until EOF
  or `max+1`, and always closes; a single read/stat size is not enough.
  `validateTask` counts bytes before fatal decoding, preserves BOM/whitespace,
  rejects invalid string Unicode, NUL/blank/known whole continuation forms.
  `readTask` reads bounded non-TTY chunks only, checks dual-source conflict,
  destroys its owned input on abort, and removes listeners in finally. Never
  trim, join positional words, summarize, or hang on bare TTY `run`.

- [ ] **Step 5: Run the same target GREEN and strict full build.** Existing
  behavior remains unchanged until cutover. Audit/review/diff-check, then commit
  `feat(config): add strict project task-entry contracts`.

### Task 2: Add bounded direct transport and local-first routing

**Deliverable:** an immutable six-profile decision or a sanitized failed/cancelled
result retaining attempt evidence. Fake JSON injection keeps hosted tests offline.

**Files:** ownership row 2 above.
**Interfaces:** consumes Task 1's config/input types; produces `RequestSpec`,
`ChoiceRequest`, `TaskBackend`, `TaskAttempt`, `TaskDecision`, `RoutingResult`,
`eligibleBackends`, `directChoiceRequest`, `requestTaskChoice`, `routeTask`.
Keep legacy exports until Task 7, never call them from this new path.
**References:** spec “Backend eligibility and classification”; Phase 0 System One
request pattern and Node HTTP/proxy APIs.

- [ ] **Step 1: Write RED route tests in `test/task-routing.test.ts`.**

  ```ts
  test("normal max is selected by one Laya request", async () => {
    const c = fixtureConfig();
    let calls = 0;
    const r = await routeTask("Prove the coupled transaction invariants", c, {
      env: fakeEnv,
      request: async s => { calls++; assert.equal(s.backend, "laya"); return decisionReply("frontier_max"); }
    });
    assert.ok(r.status === "selected");
    assert.equal(calls, 1);
    assert.equal(r.decision.profile.effort, "max");
    assert.equal(r.decision.profile, c.profiles.frontier_max);
    assert.ok(Object.isFrozen(r.decision));
  });
  test("one authorized Jev attempt follows one Laya failure", async () => {
    const base = fixtureConfig();
    const c = parseProjectConfig({ ...base, backends: { ...base.backends, jev: { enabled: true } } });
    const calls: string[] = [];
    const r = await routeTask("Investigate cross-module invariants", c, {
      env: fakeEnv, request: async s => {
        calls.push(s.backend);
        if (s.backend === "laya") throw new Error("TEST_PRIVATE_SENTINEL");
        return decisionReply("deep");
      }
    });
    assert.ok(r.status === "selected");
    assert.deepEqual(calls, ["laya", "jev"]);
    assert.equal(r.decision.backend, "jev");
    assert.deepEqual(r.decision.attempts.map(a => a.outcome), ["failed", "success"]);
  });
  test("invalid route fails with evidence, not fallback", async () => {
    const r = await routeTask("Fix cache invalidation", fixtureConfig(), {
      env: fakeEnv, request: async () => ({ answers: { route: "fast" } })
    });
    assert.ok(r.status === "failed");
    assert.equal(r.attempts.length, 1);
    assert.equal(r.attempts[0].outcome, "failed");
    assert.ok(!("decision" in r));
  });
  test("user cancellation records the initiated request and never tries Jev", async () => {
    const ac = new AbortController();
    const base = fixtureConfig();
    const c = parseProjectConfig({ ...base, backends: { ...base.backends, jev: { enabled: true } } });
    const calls: string[] = [];
    const r = await routeTask("Fix cache invalidation", c, {
      env: fakeEnv, signal: ac.signal, request: async s => {
        calls.push(s.backend); ac.abort(); throw new Error("TEST_PRIVATE_SENTINEL");
      }
    });
    assert.ok(r.status === "cancelled");
    assert.deepEqual(calls, ["laya"]);
    assert.equal(r.attempts[0].outcome, "cancelled");
  });
  ```

  Add each sole backend, both/none, all Jev opt-in/key combinations (including
  blank key), all six choices, and own object/string checks at every envelope
  level. Arrays/null/missing/bare/unknown/`direct`/inherited choices fail.
  Local invalid tasks make zero requests; already-aborted routing records none.

  Run `pnpm run build && node --test dist/test/task-routing.test.js dist/test/direct-transport.test.js`.
  Expected RED: missing new API. Commit `test: specify bounded six-profile classification`.

- [ ] **Step 2: Implement `directChoiceRequest(spec): Promise<unknown>` in
  `src/systemone.ts`.** Use `http.request`/`https.request` and explicit
  per-operation agents constructed with `{ keepAlive:false, proxyEnv:{} }`;
  verify the extra option on the minimum runtime. Return bounded, decoded JSON directly: no Fetch `Response`,
  WebStream adapter, generic client, redirects, or global proxy state mutation.

  Reject non-2xx, bodyless 204/205, unsupported content encoding, missing/truncated
  body, invalid JSON/UTF-8, and declared/actual response sizes over 8192. Count
  actual bytes incrementally and fatal-decode once the bounded body ends. Keep
  TLS verification enabled. Request construction/header/callback exceptions,
  request/response errors or abort, and signal expiry all use one controlled
  settle path; synchronously destroy owned request/response/agent on failure.
  Never await a cancellation promise or expose its body/native error text.

- [ ] **Step 3: Implement the exact choice boundary.** The six fixed criteria are
  short shipped data describing the spec's distinctions, not model bindings or
  configurable descriptions. Copy the existing System One request shape; set
  `state` to the exact task, use `typed-decisions` for Laya and `jev-latest`
  at fixed `https://api.typesafe.ai/v1/systemone` for Jev. Ask for the lightest
  profile meeting difficulty/correctness requirements; do not classify by
  length, file count, or security/architecture keywords alone.
  Validate own object fields `answers.route`, own `type === "choice"`, and
  own string `choice` belonging to the six config IDs before returning it.
  Extra returned model/effort/commands are never authority. Classifier token
  usage is `unreported`; no documented accounting schema is assumed.

- [ ] **Step 4: Implement `routeTask(...): Promise<RoutingResult>` in `src/route.ts`.**
  Validate input before side effects, compute eligibility from config/env, and
  use a monotonic start time with one total deadline. With both backends,
  Laya gets at most `min(1000, floor(total/4))`; Jev only the remaining total.
  With one backend it gets the whole remaining budget. Pass abort signals
  through connection and body reading; clean owned timers/listeners.

  Record one attempt when its request is initiated, finish its duration/outcome
  on success/error/timeout/cancellation, and freeze returned evidence. Select
  the original frozen config binding, never reread/configure it. Return
  `selected` once; on exhaustion return `failed`; caller cancellation returns
  `cancelled` with its initiated attempt and never invokes another backend.
  No eligible backend yields failed evidence with zero attempts. Local task
  validation may reject before any attempt. No fallback, voting, race or retry.

- [ ] **Step 5: Finish transport/deadline tests and run GREEN.** Use ephemeral
  loopback HTTP/HTTPS fixtures for 8192/8193 actual bytes, misleading lengths,
  split UTF-8, malformed/truncated/204/205/304 bodies, callback errors, response
  errors, TLS rejection, delayed headers/body, total deadline, and cancellation.
  A stalled fake request must honor its supplied signal. Assert one Laya timeout
  leaves only the total remainder for Jev; final failure retains both attempts.

  In an isolated child, set proxy env plus `NODE_USE_ENV_PROXY=1`, call the
  explicit transport against a local fixture, and assert the proxy sentinel
  sees zero requests. Cover `NO_PROXY` absent/empty; redirect Location never
  receives a request. Run on Node 22.8.0 and the current supported runtime.
  Hosted routing uses injected JSON, never the real hostname. Run the same
  target, strict build, audit/diff review; commit
  `feat(router): classify six profiles with bounded direct requests`.

### Task 3: Execute one bounded Codex worker

**Deliverable:** exact decision binding, incremental JSONL, sanitized diagnostics,
irreversible failure, bounded group cancellation and credential isolation.

**Files:** ownership row 3 above.
**Interfaces:** consumes `TaskDecision`; produces `WorkerUsage`, `WorkerEvent`,
`WorkerResult`, `decodeWorkerEvent`, `buildWorkerArgs`,
`subprocessEnvironment`, `workerEnvironment`, and `executeWorker`.
**References:** spec “Run and worker boundary” / “Output and token evidence”;
Phase 0 Codex event examples and Node spawn/signals. Reuse the early spawn-error
and failed-stdin checks in `src/codex.ts:26-38`.

- [ ] **Step 1: Write RED decoder tests and preserve process regressions.**
  `decodeWorkerEvent` accepts one raw frame, not an array of historical events.
  In `test/codex-events.test.ts`, use a local
  `const frame = (e: unknown) => Buffer.from(JSON.stringify(e))`:

  ```ts
  test("decodes one completed message without a transcript", () => {
    assert.deepEqual(decodeWorkerEvent(frame({
      type: "item.completed", item: { type: "agent_message", text: "result" }
    })), { kind: "message", text: "result" });
    assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.failed" })), { kind: "failed" });
  });
  test("partial valid usage survives; invalid counters are not zero", () => {
    assert.deepEqual(decodeWorkerEvent(frame({
      type: "turn.completed", usage: { input_tokens: 10, output_tokens: -1 }
    })), { kind: "completed", usage: { input_tokens: 10 } });
    assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.completed" })), { kind: "completed" });
  });
  test("valid oversized JSON is rejected by byte limit", () => {
    const prefix = frame({ type: "future.event" });
    const exact = Buffer.concat([prefix, Buffer.alloc(1048576 - prefix.length, 0x20)]);
    assert.deepEqual(decodeWorkerEvent(exact), { kind: "ignored" });
    assert.throws(() => decodeWorkerEvent(Buffer.concat([exact, Buffer.of(0x20)])));
    assert.throws(() => decodeWorkerEvent(Uint8Array.of(0xc3, 0x28)));
    assert.throws(() => decodeWorkerEvent(Buffer.from("not-json")));
  });
  ```

  Migrate existing isolated fake-executable tests into `test/worker.test.ts`.
  Use temporary Node scripts with a shebang based on `process.execPath`, never
  native Codex. Assert exact argv/model/effort for all six profiles, root as
  spawn cwd, original task stdin, close-after-stdio, nonzero codes, missing
  executable, descriptor exhaustion, absent stdin, and failed stdin delivery.

  The fake worker must also exercise:
  - exit zero with no completion, or `turn.failed` followed by completion:
    result is failed and the owned process group is stopped;
  - one valid completion plus an `error` event: fixed diagnostic, not raw text,
    with success still possible if no terminal/transport/input failure;
  - repeated completions: usage is the latest valid snapshot, never a sum;
    input-only/output-only snapshots are retained without mixing fields;
  - valid usage followed by missing/invalid usage: retain earlier counters but
    keep accounting scope unverified;
  - stderr/tool/error sentinels: no raw source, commands, keys or arbitrary
    native errors appear in diagnostics;
  - chunks splitting LF/UTF-8, 1 MiB/oversized frames, malformed and nonempty
    truncated final frames: controlled failure and no rerun;
  - a Writable that returns false and delays drain: no unbounded message queue,
    stderr still drains, and abort/EPIPE interrupts the wait;
  - a TERM-ignoring worker and a leader exiting before a TERM-ignoring same-group
    descendant: KILL within the 1000 ms grace, even if leader stdio already closed.

  Run `pnpm run build && node --test dist/test/codex-events.test.js dist/test/worker.test.js`.
  Expected RED: missing new interfaces. Commit
  `test: specify bounded worker event and cancellation contracts`.

- [ ] **Step 2: Implement `decodeWorkerEvent(frame): WorkerEvent`.** Check raw
  bytes <=1048576 before fatal decoding/JSON parsing; require a well-formed
  event object, ignore unknown valid event types. Return only the message,
  terminal kind, fixed diagnostic category, or normalized usage fields:
  `input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`. Preserve each valid nonnegative safe integer,
  including partial snapshots; omit invalid/missing fields and empty usage.
  Do not infer an undocumented required-field schema from a documentation
  example, and never add cached/reasoning counts to overlapping totals.

  Keep cross-frame state only in `executeWorker`: observed completion,
  sticky failure, latest usable usage snapshot. Emit messages immediately,
  retain no messages/event arrays or reasoning/tool renderer. Usage scope is
  `unverified` in this release: even a single terminal snapshot is not proof
  of a whole-run total. A more precise claim requires separate client evidence,
  not another accounting mode guessed by this implementation.

- [ ] **Step 3: Implement exact worker argv and environment.**
  `buildWorkerArgs(decision, write)` returns:

  ```ts
  ["exec", "--ephemeral", "--json", "--sandbox", write ? "workspace-write" : "read-only",
   "--config", "agents.enabled=false", "--model", decision.profile.model,
   "--config", `model_reasoning_effort=${JSON.stringify(decision.profile.effort)}`, "-"]
  ```

  Root belongs only in spawn options, not an unused argv parameter.
  `subprocessEnvironment(env)` clones and deletes `LAYA_API_KEY`,
  `TYPESAFE_API_KEY`, `TURNHELM_ALLOW_HOSTED_JEV`, `TURNHELM_CONFIG`;
  `workerEnvironment(env)` additionally sets `TURNHELM_MANAGED_CHILD=1`.
  This concrete shared helper also serves Task 5's non-inference subprocesses.
  Preserve Codex authentication; do not copy auth files or consult config again.

- [ ] **Step 4: Implement `executeWorker`.** Spawn the resolved executable with
  `shell:false`, `cwd:root`, `detached:true`, all three stdio pipes and the
  worker environment; do not unref. Install error listeners before checking stdin.
  Track successful input delivery separately from exit code.

  Split stdout on LF in raw bytes, retaining at most one <=1 MiB unfinished
  frame; fatal-decode a complete frame, with no speculative UTF-8 carry allowance.
  A nonempty unfinished frame at EOF is a protocol error. Honor stdout
  `write()`/drain backpressure while independently draining and discarding raw
  stderr. Every output wait listens for cancellation/error/EPIPE and cleans up.

  On failure/cancellation stop stdin and signal only this child's owned group.
  TERM then KILL after at most 1000 ms if the group remains; handle `ESRCH`.
  Leader exit or `child.killed` is not proof descendants stopped and cannot
  cancel escalation. Settle after child `close` and the bounded group-shutdown
  obligation; remove owned timers/listeners. Parent signal exit mapping belongs
  to Task 6; the worker returns a sanitized result.

  Success requires input delivered, exit zero, a completion, and no sticky
  `turn.failed`, protocol/output/cancellation failure. No automatic rerun,
  permission escalation, workspace rollback or overall execution timeout.

- [ ] **Step 5: Run the same worker/event target GREEN.** Strict build, audit,
  and diff review; commit `feat(worker): run one bounded jsonl codex worker`.

### Task 4: Add safe assets and project-only init

**Deliverable:** package-relative canonical templates, dry-run/idempotent init, and
owned AGENTS block without global writes, package installation, service startup, or
configuration migration.

**Files:** ownership row 4 above, including `package.json.files`.
**Interfaces:** produces `Templates`, `Change`, `InstallationResult`, `readTemplates`,
`inspectInstallation`, `applyInstallation`, and `initProject`.
**References:** spec “Init and installed instructions” / “Components and distribution”;
Phase 0 `dist/src` output layout. Conflicts are not a `run` prerequisite.

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
    const paths = ["AGENTS.md", ".turnhelm/config.json", ".agents/skills/turnhelm-routing/SKILL.md", ".agents/skills/turnhelm-routing/agents/openai.yaml"];
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
  ```

  For the race case, call `inspectInstallation(root, templates)`, mutate one
  planned file with `writeFile`, then call `applyInstallation(root, changes)` and
  assert code 1/error `race`, no applied files, and no replacement. Include an
  inode replacement with identical bytes and existing mode/CRLF preservation.
  Use `mkdtemp`, `t.after`,
  and `lstat` in these tests; do not use the real repository or home directory.

  Set `package.json.files` to `dist/src`, `assets/config.json`, and
  `.agents/skills/turnhelm-routing`; the skill directory includes its YAML.
  Replace the skill's old `route/codex` checkout fallback
  with the installed `turnhelm run` entry, six profiles, and managed-child rule.
  Add `<!-- turnhelm-template v1 -->` after the skill Markdown frontmatter;
  YAML uses the valid comment `# turnhelm-template v1`, not an HTML comment.
  Add tests for invalid existing config, differing/unknown-version owned assets,
  unbalanced/nested markers, symlinked ancestors/metadata, and observable parent
  races. On partial write failure assert code 1, accurate retained `applied`
  paths, and cleanup only of unchanged files created by this operation.
  Expected RED; commit `test: specify project onboarding safety`.

- [ ] **Step 2: Implement `src/assets.ts` using module-relative URLs.** Resolve
  `new URL("../../assets/config.json", import.meta.url)` and
  `../../.agents/skills/turnhelm-routing/SKILL.md` / `agents/openai.yaml`
  relative to compiled `dist/src/assets.js`. Read bounded regular files and
  treat their buffers as private template data; do not freeze typed-array bytes. Do not use
  `process.cwd()`, a source checkout path, or symlinks for template discovery.
  A missing template is an install error, never a reason to generate a fallback.

- [ ] **Step 3: Implement ownership-aware `inspectInstallation`.** Use
  `lstat` on every existing target parent and leaf. Plan only root-contained files:
  `.turnhelm/config.json`, `.agents/skills/turnhelm-routing/SKILL.md`, its metadata,
  and `AGENTS.md`. Existing valid config is preserved; missing config gets the
  exact template. Existing same-name skill without the template marker is a
  conflict. AGENTS uses `<!-- turnhelm:begin v1 -->` and
  `<!-- turnhelm:end -->`; duplicate/unbalanced/nested markers are conflicts.
  Capture each existing file's identity and bytes before planning a replacement.
  Preserve bytes/mode/line endings outside the block. Build a bounded changeset
  in memory; no installation journal.

- [ ] **Step 4: Implement `applyInstallation` and `initProject`.** Preflight every change, re-stat and
  compare file identity/content immediately before each replacement, write same-
  directory temp files, rename atomically per file, and report applied/planned
  paths with code 0/1 and fixed error categories. Apply skill/config before AGENTS activation. On
  failure remove only unchanged files this invocation created; never remove user
  directories or roll back an already changed user file. Treat hostile concurrent
  directory mutation as out of scope; detect observable races and refuse.
  Return failures with only paths that remain applied after best-effort cleanup;
  do not throw away partial-installation evidence in a generic exception.

- [ ] **Step 5: Run GREEN and commit.** Run `pnpm run build && node --test dist/test/init.test.js`,
  audit and diff check. Commit `feat(init): install project routing assets safely`.

### Task 5: Add shared preflight and offline doctor

**Deliverable:** independent sanitized checks and explicitly gated synthetic probes;
doctor never runs Codex inference, login, repair, or persists readiness state.

**Files:** ownership row 5 above.
**Interfaces:** consumes Task 3's `subprocessEnvironment`, Task 1's config/root
helpers, and Task 4's read-only installation inspection; produces `Inspection`,
`inspectCodex`, `inspectGit`, `CheckStatus`, `DoctorCheck`, and `doctorProject`.
**References:** spec “Doctor evidence levels” and run preflight; Phase 0's
non-inference CLI evidence and explicit unresolved compatibility targets.

- [ ] **Step 1: Write RED tests in `test/preflight.test.ts` and `test/doctor.test.ts`.**
  Test fake `codex --version`/`codex exec --help` output, missing executable,
  non-Git root, missing config, malformed config, unowned skill, no credentials,
  no eligible backend, stale model metadata, and init conflicts. Assert offline
  doctor never calls an injected classifier request, never starts inference, and
  never includes credential sentinel values. Probe mode makes at most one fake
  request per eligible backend and does not persist files.
  Allow only fake `--version` / `exec --help` calls. Assert numeric comparison
  rejects `0.99.0`, accepts `0.160.1`, rejects malformed version/missing controls,
  and does not infer `agents.enabled` support from generic `--config` help.
  Delayed/oversized probes terminate on timeout or caller cancellation; neither
  Codex nor Git receives classifier-key/hosted-opt-in sentinel values.

- [ ] **Step 2: Implement `src/preflight.ts` without shell interpretation.** Resolve
  `codex` from PATH using a safe executable lookup; invoke only bounded
  `codex --version` and `codex exec --help` with `shell:false`, drained pipes,
  timeout 2 seconds, stdout/stderr limits of 64 KiB each, caller cancellation,
  and fixed sanitized errors. Compare numeric major/minor/patch against
  `0.160.0`, never lexicographic strings; require well-formed version evidence and
  required controls as boolean facts (`--json`, `--ephemeral`, `--sandbox`, `-`).
  `inspectGit` invokes `git -C root rev-parse --is-inside-work-tree` with the same
  bounded subprocess pattern. Use `subprocessEnvironment` for both, without
  adding the managed-worker marker. Do not surface raw stdout/stderr; kill and
  drain owned inspection children on abort/timeout/overflow.
  Required config-key semantics come from client-version documentation/evidence,
  not flag-name presence; report unresolved compatibility as such in doctor.

- [ ] **Step 3: Implement `doctorProject`.** Run checks independently, returning
  stable IDs and statuses. Reuse config parsing, asset/installation inspection,
  preflight facts, and existing bounded `readCodexSignals` only as advisory
  evidence; never gate profile selection on that metadata. Presence of credentials
  is a sanitized pass/warn fact, not proof of authentication. Default probe=false.
  With probe=true call the injected single-backend request once per eligible
  backend using a fixed synthetic task, without failover, real Codex, or state write.
  Give each probe its own configured budget and cancellation signal. Stable IDs
  are `root`, `node`, `codex`, `git`, `assets`, `config`, `backends`,
  `credentials`, `instructions`, `models`, `backend.laya`, `backend.jev`.
  Tests pin skipped/failed/unverified evidence independently when config is absent
  or invalid; exit 1 iff at least one check fails. No install/model-entitlement
  check is imported into the `run` hot path.

- [ ] **Step 4: Run GREEN and commit.** Run focused doctor/preflight tests, strict
  build, audit and diff check. Commit `feat(doctor): add offline project diagnostics`.

### Task 6: Replace the CLI with direct run/init/doctor

**Deliverable:** strict command parsing and the only production path from task to
classification to worker; no legacy route/codex invocation in the new CLI.

**Files:** ownership row 6 above.
**Interfaces:** dispatches each command's own helpers. `run` reads task/config
once, consumes `RoutingResult`, and calls `executeWorker` only for `selected`;
`init` uses `InstallationResult.code`, `doctor` uses its independent findings.
**References:** spec command/input/output/exit sections; stable interfaces above.

- [ ] **Step 1: Add RED CLI characterization tests.** Replace the old fixture's
  global `config.json`, direct decision, fallback profiles and joined positional
  arguments with a temporary `.turnhelm` project, ephemeral loopback classifier,
  and fake Codex executable on isolated PATH. Hosted cases remain in injected
  in-process Task 2/5 tests, never production-CLI Jev calls. Assert `init --dry-run`, `doctor --json`, `run`, `run --write`, and
  `--project` parsing. Include TTY positional input, empty/nonempty pipe conflict,
  invalid option/unknown command exit 2, preflight failure exit 1, worker terminal
  failure despite exit 0, sanitized stderr, and max selected with no max flag.
  Assert pending stdin SIGINT/SIGTERM exits 130/143 with zero classifier requests;
  recursion rejection precedes config reads; routing exhaustion/cancellation
  launches zero workers and emits one receipt retaining attempts, without a
  selection/default model. A successful run makes one classification request
  and sends that decision unchanged to one worker even if the config file changes.
  Missing skill or conflicting AGENTS block does not block otherwise valid run
  prerequisites, invoke init/doctor, or cause an automatic repair.

- [ ] **Step 2: Implement strict dispatch before config loading.** Parse command
  as one of `init`, `doctor`, `run`; parse `--project`, `--dry-run`, `--json`,
  `--probe`, and `--write` only where valid; reject duplicates and positional
  ambiguity; permit `--` before a single task beginning with an option-like token.
  Resolve root before command-specific IO. `init` runs without a
  config. `doctor` reports independent checks. `run` rejects
  `TURNHELM_MANAGED_CHILD=1` before loading config/classifying. Install parent
  SIGINT/SIGTERM handling and create the operation controller before reading
  stdin; pass its signal through input, preflight, routing, and execution.
  Snapshot config/env/resolved executable, check only run prerequisites, route
  once, and execute once only on `selected`. Remove operation listeners in finally.

- [ ] **Step 3: Implement stable exit/output behavior.** Exit 2 for usage/invalid
  task input; exit 1 for missing config, no backend, classification, transport,
  protocol, or setup failure; preserve nonzero worker exit; map SIGINT/SIGTERM to
  130/143. Stdout contains only agent messages for `run`, JSON for `doctor --json`,
  and no stdout for successful init. Stderr reports init applied/planned paths
  (including dry-run) and retained partial failures, plus fixed diagnostics and the
  receipt, never raw backend/worker stderr, prompts, headers, response bodies, or
  credentials. Parent stdout `EPIPE` cancels the worker and exits 1.
  Cancellation before classification needs only its fixed diagnostic/exit code.
  After classification starts, emit exactly one final JSON receipt when the run
  ends; failed routing has worker status `not-started` and no selection.

  Construct the receipt inline in `cli.ts`, without a framework: `type` is
  `turnhelm.receipt`; fields are `root`, `routing` (`status`, `routingMs`,
  `attempts`, `requestCounts` for laya/jev), optional `selection` (`backend`,
  `profileId`, `model`, `effort`), `worker` (`status`, optional `code`,
  `durationMs`, `usage`), `classifierUsage:"unreported"`, and
  `wholeRunUsageScope:"unverified"`. Missing usage remains explicitly unreported,
  never zero; no task text, native errors or raw event bodies enter the receipt.

- [ ] **Step 4: Run focused GREEN and commit.** Run CLI tests, strict build,
  audit/diff check. Commit `feat(cli): add direct project task entry`.

### Task 7: Remove obsolete paths, verify packed distribution, and update docs

**Deliverable:** no old global/fallback/direct runtime path remains, shipped skill
and assets work outside the checkout, and README describes only the new entry.

**Files:** ownership row 7 above.
**Interfaces:** consumes the completed CLI and bundled assets; removes obsolete
exports, without adding compatibility aliases.
**References:** spec distribution and separate functional/benefit acceptance;
Phase 0 package-relative paths and the current pnpm command help.

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
  unrelated temporary Git project using `pnpm add --offline --ignore-scripts`,
  assert package assets and the `turnhelm` bin
  resolve from the installed module, then run init dry-run/init/repeat and offline
  doctor using fake non-inference executables. Never `pnpm link`, import source
  checkout assets, start services, or contact a real backend.
  Exercise root paths containing spaces and nested projects; no parent-root
  discovery or source-checkout access is permitted.

- [ ] **Step 3: Update README and canonical skill; remove obsolete example.**
  Delete `examples/config.json` rather than maintain a second config template.
  Link `assets/config.json` from documentation. Document only `init`,
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

  Re-run transport gates on Node 22.8.0 and the current supported runtime and
  record actual tested Codex versions/controls. Fake fixtures do not establish
  native-client compatibility, entitlement, or usage aggregation. If a required
  compatibility target cannot be verified, leave that acceptance finding open;
  do not suppress tests, silently raise version floors, or claim it passed.

  Functional delivery does not authorize the separate benefit trial. Only after
  owner approval, compare all six levels with the owner's normal fixed baseline
  on identical starting workspaces, permissions and acceptance checks. Record
  failures/manual repetitions, reported execution usage, classifier request counts
  and accounting gaps. Until client scope is confirmed, report snapshots and
  unverified totals, not a saving percentage or exact whole-task token total.

## Plan self-review checklist

- [x] Every spec section maps to a task: root/config/task (1), classifier and
  transport (2), worker/events (3), init/assets (4), preflight/doctor (5), CLI
  (6), distribution/docs/benefit gates (7).
- [x] Nested classifier envelope is exact; six profiles and ordinary automatic
  max selection are consistent in config, criteria, tests, and docs.
- [x] No max flag/disable setting, compatibility adapter, daemon, cache, online
  catalog, plugin renderer, billing database, or auto escalation appears.
- [x] Worker success is terminal-event based; raw stderr and arbitrary error text
  never cross the diagnostic boundary; owned cancellation is finite.
- [x] Failed/cancelled routing retains attempts; single-event decoding never
  retains a transcript; partial usage/backpressure/group descendants have tests.
- [x] Packed `../../` asset URLs, valid YAML comments, `InstallationResult`
  partial failures and before-file identity checks agree across task interfaces.
- [x] TTY behavior, proxy-enabled Node, installer race scope, continuation phrases,
  process exit codes, and all-test TypeScript compilation are explicit.
- [x] Every task ends in a focused test/build/diff/audit checkpoint and uses exact
  file ownership; no task depends on a hidden implementation detail.

After the user reviews and approves the updated specification and this plan, choose
either subagent-driven execution (fresh worker and review per task) or inline
execution with checkpoint commits. Do not implement from this document without that
explicit execution authorization.
