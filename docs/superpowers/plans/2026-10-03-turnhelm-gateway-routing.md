# Turnhelm Gateway Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the historical Phase A/Hook experiment with a process-scoped
loopback gateway that routes eligible native Codex root and subagent threads
through local Laya, with explicitly opted-in Jev fallback, while leaving the
Codex CLI/TUI and orchestration untouched.

**Architecture:** `turnhelm codex` performs a real protocol preflight, starts a
single ephemeral loopback gateway, and launches the stock Codex binary as a
child with a provider override and the `turnhelm/auto` sentinel. The gateway
routes only the first eligible request for each thread, stores only the
allowlisted model/effort pair in bounded memory, and streams the provider
response unchanged. Any unsupported protocol causes a stock, unrouted Codex
launch; no Hook or compatibility shim is added.

**Tech Stack:** Node.js 22+, TypeScript, `node:http`, `node:child_process`,
built-in `fetch`, `node:test`, the real TypeSafe Jev endpoint, and a real local
`laya[serve]` process. No runtime dependency is added without a measured
protocol requirement.

## Global Constraints

- Do not modify, fork, patch, or dynamically load Codex CLI/TUI code.
- Do not install or implement a Codex Hook, PTY shim, App Server client, MCP
  router, plugin, or public Turnhelm HTTP API.
- Do not write or mutate `~/.codex/config.toml`, Codex profiles,
  `auth.json`, or model catalogs. Codex's own normal session writes are not
  Turnhelm-managed configuration.
- The gateway binds only to `127.0.0.1` on an ephemeral port and requires a
  random per-session bearer token from the Codex child.
- Turnhelm never stores, prints, or makes routing decisions from Codex auth;
  provider authorization is forwarded opaquely and excluded from logs.
- `TYPESAFE_API_KEY` and `LAYA_API_KEY` exist only in the gateway environment,
  never in the Codex child environment.
- Use the current Codex model catalog only through an allowlisted configuration
  validated by a real smoke; never pass arbitrary classifier output upstream.
- A non-sentinel model or explicit effort is immutable. Spawn count, roles,
  task text, parallelism, fork behavior, sandbox, approvals, and permissions
  are never changed.
- Laya is the local default. Jev is disabled unless both configuration and
  `TURNHELM_ALLOW_HOSTED_JEV=1` opt in; only bounded root-user task text may
  reach Jev. Subagent tasks and tool/continuation data remain local-only.
- Do not run Laya and Jev in parallel in the production hot path. Do not add
  retries, persistent caches, queues, dashboards, or a general provider layer.
- Unknown Codex protocol/version/field shapes fail preflight and launch stock
  Codex without the sentinel. Never guess a field path.
- Do not preserve the old Phase A/Hook public contract. Delete it after the
  gateway promotion gates pass.
- Never substitute fake Jev or Laya services for live backend validation.
- Before each commit, run `git diff --check`; run `npm audit --audit-level=high`
  once package metadata exists.

---

### Task 1: Prove the native ingress contract before writing the gateway

**Files:**
- Create: `docs/validation/2026-10-03-gateway-protocol-probe.md`
- Create: `/tmp/turnhelm-codex-probe/` files only during the probe; remove them
  before committing
- Inspect only: `codex --help`, `codex --version`, the current user launch
  environment, and the installed Codex runtime

**Interfaces:**
- Produces a sanitized `ProtocolAdmission` record containing the Codex
  version, child-only provider override mechanism, upstream endpoint source,
  sentinel acceptance, model path, optional effort path, thread-id source,
  request-class source, and streaming behavior.
- The record contains field names and value types only; it never contains
  prompt text, request bodies, response bodies, auth headers, or credentials.

- [ ] **Step 1: Record the current runtime and preserve a clean baseline.**

  Run:

  ```bash
  codex --version
  codex --help > /tmp/turnhelm-codex-help.txt
  git status --short --branch
  ```

  Expected: the installed version is recorded, `codex --help` exits 0, and the
  repository is clean before the probe. Do not edit `~/.codex`.

- [ ] **Step 2: Start a loopback capture endpoint with a random token.**

  Use a temporary Node script outside the repository. It must bind to
  `127.0.0.1`, require an unguessable bearer token, record only JSON key/type
  paths and request header names, then forward the request to the explicitly
  derived existing upstream as an opaque streamed response. The script must
  reject and discard request values after recording their types. Do not print
  the request body. This is a real upstream relay for one read-only smoke, not
  a fake model service.

- [ ] **Step 3: Run a stock TUI child-only provider probe.**

  Launch the real Codex TUI in a disposable directory with the provider
  override and model-sentinel environment mechanism exposed by the installed
  release. Use one read-only task and the existing signed-in account. Verify
  from filesystem snapshots that Turnhelm's probe did not change
  `~/.codex/config.toml`, profiles, `auth.json`, or model catalogs.

  The probe must establish all of these facts:

  1. the stock TUI accepts the child-only provider endpoint;
  2. the virtual model sentinel reaches the local endpoint;
  3. the real upstream endpoint can be derived without reading Codex auth;
  4. a stable thread id is present;
  5. a stable human/subagent request-class marker is present;
  6. the model field and reasoning-effort field paths are stable;
  7. a streamed response is accepted by the stock TUI.

- [ ] **Step 4: Exercise one native subagent without capturing values.**

  In the same disposable project, request exactly one read-only native
  subagent using the currently available Codex model. Record only whether the
  child request has an independent thread id and which sanitized headers/types
  identify it. Do not install a Hook and do not attempt to rewrite the hosted
  `collab_tool_call` item.

- [ ] **Step 5: Write the admission report and make the stop decision.**

  Write the sanitized facts to
  `docs/validation/2026-10-03-gateway-protocol-probe.md`, then remove every
  temporary probe file. If any of the seven facts or the independent child
  thread id is missing, record `blocked` and stop this plan: do not implement a
  gateway fallback, model catalog patch, Hook, or second provider. If all facts
  are present, record the exact field paths needed by Tasks 3–5.

- [ ] **Step 6: Verify the probe left no workspace changes.**

  Run:

  ```bash
  git diff --check
  git status --short
  ```

  Expected: only the sanitized validation report is new. Commit:

  ```bash
  git add docs/validation/2026-10-03-gateway-protocol-probe.md
  git commit -m "test(protocol): admit current codex gateway shape"
  ```

---

### Task 2: Replace the configuration and pure routing policy

**Files:**
- Modify: `src/config.ts`
- Create: `src/types.ts`
- Create: `src/policy.ts`
- Replace: `test/config.test.ts`
- Create: `test/policy.test.ts`
- Replace: `examples/config.json`

**Interfaces:**
- `Profile = { description: string; model: string; effort: string }`.
- `Config = { version: 2; baseline: Profile; profiles: Record<string, Profile>; layaUrl: string; maxTaskChars: number; hostedJev: { enabled: boolean } }`.
- `parseConfig(value: unknown): Config` and `loadConfig(path?: string): Config`.
- `RequestClass = "human" | "subagent" | "continuation" | "auxiliary" | "unknown"`.
- `NormalizedRequest = { model: string; effort?: string; threadId?: string; requestClass: RequestClass; taskText?: string; sentinel: boolean }`.
- `ThreadState = { route?: RouteSelection; createdAt: number; protocolVersion: string }`.
- `RouteSource = "laya" | "jev" | "baseline"`.
- `RouteSelection = { source: RouteSource; profileId?: string; profile: Profile }`.
- `classifyRequest(input: NormalizedRequest, state: ThreadState, config: Config): RouteEligibility`.
- `RouteEligibility` is one of `{ kind: "passthrough" }`, `{ kind: "baseline"; reason: string }`, or `{ kind: "classify"; taskText: string; allowHostedJev: boolean }`.

- [ ] **Step 1: Replace the config tests with the new strict contract.**

  Use this fixture and assertions in `test/config.test.ts`:

  ```ts
  import test from "node:test";
  import assert from "node:assert/strict";
  import { parseConfig } from "../src/config.js";

  const base = {
    version: 2,
    baseline: { description: "Normal session", model: "gpt-6.1-sol", effort: "high" },
    profiles: {
      fast: { description: "Small localized edits", model: "gpt-6-luna", effort: "low" },
      deep: { description: "Complex debugging and review", model: "gpt-6.1-sol", effort: "high" }
    },
    layaUrl: "http://127.0.0.1:8765",
    maxTaskChars: 2000,
    hostedJev: { enabled: false }
  };

  test("accepts the versioned local-first config", () => {
    const config = parseConfig(base);
    assert.equal(config.version, 2);
    assert.equal(config.profiles.fast.model, "gpt-6-luna");
  });

  test("rejects old backend/fallback fields and unknown fields", () => {
    assert.throws(() => parseConfig({ ...base, backend: "laya" }), /unknown|backend/);
    assert.throws(() => parseConfig({ ...base, fallbackProfile: "deep" }), /unknown|fallback/);
  });

  test("rejects public Laya URLs and invalid limits", () => {
    assert.throws(() => parseConfig({ ...base, layaUrl: "http://0.0.0.0:8765" }), /loopback/);
    assert.throws(() => parseConfig({ ...base, maxTaskChars: 0 }), /maxTaskChars/);
    assert.throws(() => parseConfig({ ...base, maxTaskChars: 2001 }), /maxTaskChars/);
  });

  test("rejects malformed profiles and unsupported effort strings", () => {
    assert.throws(() => parseConfig({ ...base, profiles: { "bad-id": base.profiles.fast } }), /profile/);
    assert.throws(() => parseConfig({ ...base, profiles: { fast: { ...base.profiles.fast, effort: "not-valid" } } }), /effort/);
    assert.throws(() => parseConfig({ ...base, baseline: { ...base.baseline, model: "" } }), /model/);
  });
  ```

- [ ] **Step 2: Run the red config tests.**

  Run:

  ```bash
  npm test -- --test-name-pattern='versioned local-first|old backend|public Laya|malformed profiles'
  ```

  Expected: failure because the old parser still requires `backend` and
  `fallbackProfile`.

- [ ] **Step 3: Implement strict version-2 parsing.**

  Implement `parseConfig` with own-property checks, reject unknown keys,
  require exactly `version`, `baseline`, `profiles`, `layaUrl`,
  `maxTaskChars`, and `hostedJev`, require one to four profile entries, allow
  only loopback HTTP for `layaUrl`, and validate every model/effort token with
  the existing safe-token rules. Do not read any secret from the config file.

- [ ] **Step 4: Write pure policy tests before implementing policy.**

  Add tests that assert: non-sentinel input is passthrough; a sentinel
  continuation/background request is baseline; a first human request with
  bounded text is classify; a first subagent request is classify but has
  `allowHostedJev === false`; a root request has hosted opt-in only when both
  `hostedJev.enabled` and `TURNHELM_ALLOW_HOSTED_JEV === "1"` are true; and a
  second request on the same thread is passthrough to the sticky route.

- [ ] **Step 5: Implement the pure policy.**

  Keep it free of HTTP, filesystem, and process calls. It must inspect only the
  normalized request, the in-memory thread state, configuration, and the
  explicit hosted-Jev environment flag. It must never parse a transcript or
  infer a route from repository contents.

- [ ] **Step 6: Verify and commit the config/policy boundary.**

  Run:

  ```bash
  npm test
  npm audit --audit-level=high
  git diff --check
  ```

  Expected: all pure tests pass and no high-severity npm finding is reported.
  Commit:

  ```bash
  git add src/config.ts src/policy.ts test/config.test.ts test/policy.test.ts examples/config.json
  git commit -m "refactor(config): define gateway routing policy"
  ```

---

### Task 3: Implement the local-first Jev/Laya decision client

**Files:**
- Replace: `src/systemone.ts`
- Replace: `test/systemone.test.ts`
- Replace: `test/live.integration.ts`

**Interfaces:**
- `Decision = { source: "laya" | "jev" | "baseline"; profile: Profile }`.
- `buildSystemOneRequest(config: Config, prompt: string, model: "typed-decisions" | "jev-latest"): Record<string, unknown>`.
- `chooseRoute(config: Config, prompt: string, allowHostedJev: boolean): Promise<Decision>`.
- `chooseHostedJev(config: Config, prompt: string): Promise<Decision>` for the
  explicit live Jev integration test and diagnostics command.

- [ ] **Step 1: Write parser and request-builder tests.**

  Assert that Laya uses `model: "typed-decisions"`, Jev uses
  `model: "jev-latest"`, the choice criteria contain `direct` and exactly the
  configured profile ids, malformed answers are rejected, and no response
  value is included in thrown errors.

- [ ] **Step 2: Run the red System One tests.**

  Run:

  ```bash
  npm test -- --test-name-pattern='System One|typed-decisions|jev-latest'
  ```

  Expected: failure because the existing client still selects one mutually
  exclusive backend and does not implement local-first fallback.

- [ ] **Step 3: Implement one typed choice request.**

  Send the existing `/v1/systemone` contract with a four-second timeout. Use
  the loopback Laya URL for the first call. If Laya fails and
  `allowHostedJev` is true, call the fixed TypeSafe endpoint once. If both
  calls fail or return an unknown profile, return the configured baseline
  decision. Never retry and never send the full Codex request.

- [ ] **Step 4: Replace the live test with real services only.**

  Keep the six labelled English/Chinese cases and 24 calls per backend. Call
  `chooseRoute` for the Laya run and `chooseHostedJev` for the Jev run; assert
  `source === "laya"` and `source === "jev"` respectively. Print p50/p95 and
  selected profile ids; never print prompts, bodies, headers, or keys. A
  missing service fails the test instead of substituting a fixture.

- [ ] **Step 5: Verify and commit the decision client.**

  Provision the already-approved local Laya service, set
  `TYPESAFE_API_KEY` without printing it, and run:

  ```bash
  npm test
  npm run test:live
  npm audit --audit-level=high
  git diff --check
  ```

  Commit:

  ```bash
  git add src/systemone.ts test/systemone.test.ts test/live.integration.ts
  git commit -m "feat(router): use local laya with explicit jev fallback"
  ```

---

### Task 4: Add the version-pinned request normalizer and rewriter

**Files:**
- Create: `src/protocol.ts`
- Create: `test/protocol.test.ts`
- Modify: `docs/validation/2026-10-03-gateway-protocol-probe.md` only to record
  the sanitized admitted paths

**Interfaces:**
- `ProtocolShape = { modelPath: readonly string[]; effortPath?: readonly string[]; threadIdHeader: string; requestClassHeader: string; taskPath: readonly string[]; upstreamBaseUrl: string }`.
- `inspectRequest(body: unknown, headers: Headers, shape: ProtocolShape): NormalizedRequest | { kind: "passthrough" } | { kind: "malformed-sentinel" }`.
- `rewriteRequest(body: unknown, request: NormalizedRequest, model: string, effort?: string, shape: ProtocolShape): Record<string, unknown>`.

- [ ] **Step 1: Write pure protocol tests from the admitted shape.**

  Use only sanitized in-memory request objects. Test: normalizing a human
  request; normalizing a subagent with an independent thread id; rejecting a
  missing thread id; passing through a non-sentinel model; preserving an
  explicit effort; rewriting only model and effort paths; preserving nested
  tools and all unrelated keys; and rejecting a malformed sentinel without
  returning it to the upstream.

- [ ] **Step 2: Run the red protocol tests.**

  Run:

  ```bash
  npm test -- --test-name-pattern='protocol|sentinel|thread|rewrite'
  ```

  Expected: failure because no protocol normalizer exists.

- [ ] **Step 3: Implement path-safe normalization.**

  Read only the paths recorded by Task 1. Validate strings, maximum task
  length, request-class values, and header token equality. Treat all other
  requests as passthrough. Never walk arbitrary JSON looking for a prompt and
  never use a cache key or transcript hash as a thread id.

- [ ] **Step 4: Implement exact rewriting.**

  Clone the request, set only the admitted model path and, when admitted and
  absent from the original, the effort path. Preserve an explicit effort.
  Reject invalid profile values before this function is called. Do not alter
  headers, tool schemas, streaming flags, conversation ids, or message text.

- [ ] **Step 5: Verify and commit the protocol boundary.**

  Run `npm test && git diff --check`, then commit:

  ```bash
  git add src/protocol.ts test/protocol.test.ts docs/validation/2026-10-03-gateway-protocol-probe.md
  git commit -m "feat(protocol): pin codex gateway request shape"
  ```

---

### Task 5: Implement the minimal loopback pass-through gateway

**Files:**
- Create: `src/gateway.ts`
- Create: `test/gateway.test.ts`

**Interfaces:**
- `GatewayOptions = { config: Config; shape: ProtocolShape; classify: (text: string, allowHostedJev: boolean) => Promise<Decision>; upstream: URL; token: string }`.
- `GatewayHandle = { url: URL; token: string; close(): Promise<void> }`.
- `startGateway(options: GatewayOptions): Promise<GatewayHandle>`.
- `serveRequest(request: IncomingMessage, response: ServerResponse, options: GatewayOptions): Promise<void>`.

- [ ] **Step 1: Write gateway tests with a local upstream stub.**

  The stub is a transport test, not a Jev/Laya substitute. Assert:

  - only loopback binds are accepted;
  - requests without the random bearer token are rejected;
  - non-sentinel requests and explicit model/effort requests are forwarded
    unchanged;
  - an eligible sentinel request calls the injected classifier once and
    rewrites only the admitted fields;
  - a second request on the same thread reuses the route without another
    classifier call;
  - classifier failure uses the baseline pair;
  - malformed sentinel input is not sent upstream;
  - response headers and streamed chunks are passed through; and
  - request bodies, auth values, and classifier text never reach diagnostics.

- [ ] **Step 2: Run the red gateway tests.**

  Run:

  ```bash
  npm test -- --test-name-pattern='gateway|pass-through|stream|baseline'
  ```

  Expected: failure because `src/gateway.ts` does not exist.

- [ ] **Step 3: Implement one HTTP server with bounded body handling.**

  Use `node:http`. Bind explicitly to `127.0.0.1` and port `0`; reject bodies
  larger than the configured request limit before JSON parsing. Require the
  random bearer token on every request. Keep route state in a bounded in-memory
  map with a six-hour TTL and 1,024-entry maximum; store only profile id,
  model, effort, timestamp, and protocol version.

- [ ] **Step 4: Implement request routing and response streaming.**

  Normalize with `inspectRequest`, apply the pure policy, call the injected
  decision client only for an eligible first request, then use
  `rewriteRequest`. Forward the original authorization header and all
  non-routing headers opaquely. Pipe the upstream response without buffering
  or rewriting SSE chunks. Use the baseline pair for a valid sentinel when a
  classifier fails.

- [ ] **Step 5: Implement safe shutdown.**

  Close the listener and destroy active connections on `close()`. Do not write
  logs or temporary files. Expose only status, route source, model, effort,
  request class, status code, and elapsed milliseconds to an injected
  diagnostic sink; the default sink is silent.

- [ ] **Step 6: Verify and commit the gateway.**

  Run:

  ```bash
  npm test
  git diff --check
  ```

  Commit:

  ```bash
  git add src/gateway.ts test/gateway.test.ts
  git commit -m "feat(gateway): add loopback codex pass-through"
  ```

---

### Task 6: Replace the Phase A CLI with the stock-TUI launcher

**Files:**
- Create: `src/launcher.ts`
- Replace: `src/cli.ts`
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Delete: `src/codex.ts`
- Delete: the `turnhelm-hook` binary entry and any Hook entrypoint if present
- Create: `test/launcher.test.ts`

**Interfaces:**
- `ChildLaunch = { command: string; args: string[]; env: NodeJS.ProcessEnv; gateway: GatewayHandle }`.
- `buildChildEnvironment(base: NodeJS.ProcessEnv, gateway: { url: URL; token: string; sentinel: string }): NodeJS.ProcessEnv`.
- `runInteractiveCodex(args: string[], config: Config): Promise<number>`.

- [ ] **Step 1: Write launcher isolation tests.**

  Assert that the child environment removes `TYPESAFE_API_KEY`, `LAYA_API_KEY`,
  `TURNHELM_CONFIG`, and `TURNHELM_ALLOW_HOSTED_JEV`, adds only the admitted
  provider endpoint/token/sentinel variables, leaves unrelated Codex
  environment values intact, and forwards arbitrary Codex arguments without
  shell interpolation.

- [ ] **Step 2: Run the red launcher tests.**

  Run:

  ```bash
  npm test -- --test-name-pattern='launcher|child environment|arguments'
  ```

  Expected: failure because the current CLI only starts `codex exec` and has no
  interactive gateway launcher.

- [ ] **Step 3: Implement the launcher lifecycle.**

  Load the strict config, read the admitted protocol shape from the preflight
  result, start one gateway, construct a child-only environment, and spawn
  `codex` with `shell: false`, inherited stdio, and the original argument list.
  Forward `SIGINT`, `SIGTERM`, and child exit status. If preflight or gateway
  health fails, spawn plain `codex` with the original environment minus only
  Turnhelm classifier variables.

- [ ] **Step 4: Replace CLI commands.**

  Support exactly:

  ```text
  turnhelm codex [codex arguments...]
  turnhelm route --text "bounded task" [--hosted-jev]
  ```

  `codex` enters the interactive launcher. `route` is a diagnostics command
  that uses the same local-first policy but never starts Codex. Remove prompt
  concatenation, `--write`, `codex exec`, Phase A fallback handling, and the
  Hook command. Errors must be concise and must not include backend or request
  bodies.

- [ ] **Step 5: Update package metadata and run the unit suite.**

  Keep one `turnhelm` bin, remove `turnhelm-hook`, and keep `build`, `test`,
  and `test:live`. Run:

  ```bash
  npm test
  npm audit --audit-level=high
  git diff --check
  ```

  Commit:

  ```bash
  git add src/cli.ts src/launcher.ts test/launcher.test.ts package.json tsconfig.json .gitignore
  git rm src/codex.ts
  git commit -m "feat(cli): launch native codex through gateway"
  ```

---

### Task 7: Run real native-TUI and orchestration promotion gates

**Files:**
- Create: `docs/validation/2026-10-03-gateway-routing.md`
- Modify only if necessary: `src/launcher.ts`, `src/gateway.ts`,
  `src/protocol.ts`, and their focused tests

**Interfaces:**
- Produces a sanitized promotion report containing Codex version, route
  source, effective provider model/effort evidence, latency, topology counts,
  and pass/fail results. It never stores prompts, request bodies, outputs,
  auth, or classifier responses.

- [ ] **Step 1: Run the no-routing baseline.**

  In a disposable read-only repository, run stock Codex with the current
  available model and record only session success, child count, role names,
  parallelism, and effective model/effort evidence. Use no Hook and no
  Turnhelm gateway.

- [ ] **Step 2: Run the routed root-thread smoke.**

  Run `turnhelm codex` with a no-edit prompt, a small localized task, and a
  complex review task. Confirm the TUI remains native, the gateway receives
  only the expected first request, Laya latency meets the budget, and the
  provider response proves the selected model/effort.

- [ ] **Step 3: Run the seven orchestration cases.**

  Compare routed and baseline sessions for: no delegation; one subagent; two
  explicitly parallel subagents; explicit child model/effort; custom agent
  role; classifier unavailable; and a tool continuation. Verify identical
  child count, task text, role, ordering, parallelism, approvals, sandbox,
  parent behavior, and continuation behavior. Only eligible sentinel model or
  effort may differ.

- [ ] **Step 4: Verify hosted Jev isolation.**

  Keep hosted Jev disabled for all private/subagent cases. Run one explicitly
  opted-in root-user case with `TURNHELM_ALLOW_HOSTED_JEV=1`, confirm the
  bounded task request is the only hosted payload, and verify no raw prompt,
  code, tool output, auth, or classifier response appears in logs or files.

- [ ] **Step 5: Measure performance.**

  Warm the gateway and record at least 30 pass-through, 24 Laya, and 24
  explicitly opted-in Jev calls. Require p95 <= 10 ms no-route overhead,
  p95 <= 100 ms warm Laya, and p95 <= 750 ms Jev. Record warm-up separately;
  do not hide outliers.

- [ ] **Step 6: Decide promotion without compatibility workarounds.**

  If any protocol, security, performance, or topology case fails, record the
  exact failure and do not add a Hook, retry, catalog patch, or second
  provider. If all pass, commit the sanitized report:

  ```bash
  git add docs/validation/2026-10-03-gateway-routing.md
  git commit -m "test(validation): promote native gateway routing"
  ```

---

### Task 8: Remove superseded implementation and align documentation

**Files:**
- Delete: `test/codex.test.ts`, `test/route.test.ts` when their Phase A
  assertions are no longer applicable
- Modify: `README.md`, `examples/config.json`, `package.json`, and the focused
  test files
- Keep: `src/systemone.ts`, `src/policy.ts`, `src/protocol.ts`,
  `src/gateway.ts`, `src/launcher.ts`, `src/config.ts`, and the diagnostics
  command
- Keep as historical records: the superseded design/plan and the original
  Hook validation report

**Interfaces:**
- The repository exposes only the new version-2 config, `turnhelm codex`, and
  `turnhelm route --text` contract.
- No Hook binary, Phase A `codex exec` path, old config fields, or legacy tests
  remain.

- [ ] **Step 1: Write documentation assertions before editing README.**

  Add a documentation review checklist to the validation report requiring the
  README to state: native Codex is unmodified; routing requires the launcher;
  plain `codex` is unaffected; Laya is local-first; Jev is explicit opt-in;
  credentials are environment-only; and unsupported protocol versions run
  stock Codex.

- [ ] **Step 2: Remove superseded source and tests.**

  Delete only the Phase A execution helper, Hook binary references, and tests
  that assert the old config/`codex exec` contract. Do not remove the shared
  typed-decision or gateway tests.

- [ ] **Step 3: Rewrite README and the example config.**

  Document the version-2 config, local Laya startup, explicit Jev opt-in,
  `turnhelm codex`, the stock `codex` escape hatch, protocol preflight, and
  the security/performance limits. Do not document Hook installation or
  backwards-compatible migration.

- [ ] **Step 4: Run final verification.**

  Run:

  ```bash
  npm test
  npm run build
  npm audit --audit-level=high
  git diff --check
  git status --short --branch
  ```

  Expected: the unit suite, build, and audit pass; the worktree contains only
  the intended gateway implementation, tests, docs, and validation records.

- [ ] **Step 5: Commit the deliberate replacement.**

  ```bash
  git add README.md examples/config.json package.json test src
  git commit -m "refactor: replace phase a and hook routing with gateway"
  ```

## Plan self-review

- The first task is a real protocol go/no-go gate; no gateway code is built on
  an unverified sentinel, upstream, thread-id, or effort shape.
- Laya/Jev are isolated behind one typed-decision client; the hot path has no
  ensemble, retry, queue, database, daemon, or transcript parser.
- Explicit model/effort and all native orchestration controls are preserved.
- Hosted data is root-task-only and requires two independent opt-ins; all
  subagent/tool/continuation data stays local.
- Every gateway rewrite has pure tests, transport tests, live backend tests,
  and native TUI promotion tests.
- The plan intentionally deletes the previous Phase A/Hook contract rather
  than adding a migration layer.
