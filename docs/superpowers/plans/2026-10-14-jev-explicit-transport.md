# Explicit Jev Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one explicit, fail-closed Jev transport boundary through production routing and probes, with strict configuration v2, owned CONNECT cleanup, bounded policy evidence, and a reachable offline preparation path for separately approved hosted acceptance.

**Architecture:** Reuse the existing System One protocol/decoder and native scoped Agents; share runtime and transport validation instead of creating a network framework. Extend the standard live harness with validated configuration input and selection of its existing fallback case; retain ordinary custom-round grading and privacy boundaries.

**Tech Stack:** Strict TypeScript/ESM, Node >=24.5.0 (actual local verification on 24.11.0), node:http/https/net, node:test, pnpm 10.12.1; no new runtime dependencies.

**Spec:** [Explicit Jev Transport and Configuration v2](../specs/2026-10-14-jev-explicit-transport-design.md), incorporating all four verified Astra findings.

## Global Constraints

- Baseline HEAD is `e07bd54fcfc2fc0ffc1da865b1045e2c40c50e2d`; current review/spec/plan work is documents only. This plan must be reviewed and an execution method chosen before implementation.
- All documents, code, comments, test names, and commit descriptions are English.
- Configuration version 2 only; Jev transport is required even when disabled. Preserve six profiles/criteria, routingTimeoutMs 100–30000, default 10000, Laya-first three-quarter allocation, and one attempt per eligible backend.
- Node floor 24.5.0; proxyUrl <=256 characters; numeric loopback HTTP only, explicit decimal port 1–65535, no leading zeroes/userinfo/path/query/fragment/encoding; retain explicit :80.
- Hosted gates remain enabled + TURNHELM_ALLOW_HOSTED_JEV=1 + nonblank TYPESAFE_API_KEY. Default remains disabled/direct. Laya stays direct; fixed HTTPS Jev target and rejectUnauthorized true.
- No environment/system proxy inheritance, retries, redirects, direct fallback, CA overrides, pools/caches, discovery, policy tuning, auth/Clash changes, extra dependencies, or historical regrading/replay.
- Response cap 8192 bytes; configuration input cap 65536 bytes. Policy evidence <=2 unique backend entries; unknown metadata never changes ordinary custom-round outcomes/continuation/stops.
- No real classifier/worker/probe/service or original credentials during implementation tests. Dependency advisory audit is allowed; it is not a model request. Missing tools/dependencies stop for owner action, not automatic installation.
- Work in an isolated `feat/jev-explicit-transport` worktree using the worktree skill; preserve current uncommitted documents/user work. Transfer only these reviewed spec/plan artifacts after checking their hashes; never clean or reset the parent tree.
- Intermediate checkpoints are not release candidates. Until Task 2 supplies proxy transport, Task 1 must refuse enabled proxy Jev before dialing; never accept a proxy policy and silently execute the old direct path.
- Local checkpoints require explicit commit authority plus audit/diff review. Without it, leave changes reviewable. Push/PR/merge/tag/release and live preparation/execution require their own authority.

## Review Focus

1. Explicit :80 and IPv6 canonicalization must not erase the selected proxy; Task 1 pins both without binding privileged port 80.
2. TLS-disable environment or global proxy flags must not override the explicit policy; Task 2 uses activated controls and checks no Origin auth before successful verification.
3. A callback socket may arrive after settlement, or before the returned socket is tracked; Task 2 pins both orders, deduplication, peer close, and timely process exit.
4. Explicit prepare input may be a symlink/FIFO/oversized/invalid UTF-8 file; Task 4 rejects it before run-root creation, without requests or hangs.
5. A complete worker or ordinary timeout can carry missing/forged mode metadata; Task 3 records unverified without a new stop, while Task 4's specialized live cases cannot sign transport PASS.

## Verification Environment

Use the already installed local toolchain in the execution worktree:

```sh
export PATH24="/Users/zhangxiao/.nvm/versions/node/v24.11.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
env -i HOME="$HOME" PATH="$PATH24" node --version
env -i HOME="$HOME" PATH="$PATH24" pnpm --version
```

Expected: Node v24.11.0 and pnpm 10.12.1. On another machine, select an already-installed supported runtime, record its actual executable/version, and replace this local path explicitly; do not download tools through this plan.

Every command below runs in the isolated execution worktree with this minimal environment. Builds replace only that worktree's dist. Do not run these commands against sealed roots. RED is the expected new behavioral assertion failure, not unrelated compilation/runtime/fixture failure; keep preservation tests green.

## Task 1: Strict v2 configuration, shared runtime, and atomic fixture migration

**Files:**
- Create: `src/runtime.ts`, `test/runtime.test.ts`.
- Modify: `src/config.ts`, `src/cli.ts` main, `src/doctor.ts` Node guard, `src/systemone.ts` runtime/intermediate proxy guard, `assets/config.json`, `package.json` engines.
- Modify: `README.md` and `.agents/skills/turnhelm-routing/SKILL.md` runtime-requirement copy only; `test/package.test.ts` packed config/engine/runtime-copy assertions. Migrate these together so the packed-distribution test is GREEN at this checkpoint, not deferred to Task 5.
- Modify configuration constructors: `test/fixtures.ts`, `test/project-config.test.ts`, `test/config.test.ts`, `test/cli.test.ts`, `test/doctor.test.ts`, `test/task-routing.test.ts`, `test/route.test.ts`, `test/systemone.test.ts`, `test/custom-round.test.ts` caseConfig, `test/live-acceptance.test.ts` buildRun, `test/worker.test.ts` the ProjectConfig-backed CLI fixture, and `test/live-acceptance.ts` withBackends.
- Test: `test/init.test.ts`; change `src/init.ts` only for an actionable fixed conflict message. Do not change unrelated roster/template version literals.

**Interfaces:**
- Produces exported `JevTransport` and `parseJevTransport(value:unknown):JevTransport` in config.ts; `ProjectConfig.version:2` and required backends.jev.transport.
- Produces `MIN_NODE_VERSION:readonly [24,5,0]` and `isSupportedNode(version:string = process.versions.node):boolean` in runtime.ts.
- Retains `parseProjectConfig(value:unknown):ProjectConfig` and `readProjectConfig(root:string):Promise<ProjectConfig>`.

- [ ] **Step 1: Add failing configuration/runtime/installation assertions.** Use names `requires explicit v2 Jev transport`, `retains default proxy ports`, `rejects malformed proxy policy without echoing input`, `unsupported runtime performs no work`, and `init preserves v1 conflicts without writes`.

```ts
assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://127.0.0.1:80/" }),
  { mode: "http-connect", proxyUrl: "http://127.0.0.1:80" });
assert.deepEqual(parseJevTransport({ mode: "http-connect", proxyUrl: "http://[::1]:7890/" }),
  { mode: "http-connect", proxyUrl: "http://[::1]:7890" });
assert.equal(isSupportedNode("24.4.1"), false);
assert.equal(isSupportedNode("24.5.0"), true);
```

Also assert v1/missing/null/extra/inherited-required fields, bad disabled transport, DNS/aliases/credentials/empty @/whitespace/encoding/query/path/fragment/non-HTTP/port0/65536/leading-zero ports reject; successful objects are frozen. Version-injected CLI/library/transport tests observe zero tools/Agent/request/writes. Snapshot all existing init target bytes/inodes before v1 refusal. In the existing packed-distribution test, require installed config version 2, engines >=24.5.0, explicit disabled/direct Jev, and matching new README/skill runtime copy; retain package exclusions and installed-bin checks.

- [ ] **Step 2: Verify RED.** Run `env -i HOME="$HOME" PATH="$PATH24" pnpm run build` and then `node --test dist/test/project-config.test.js dist/test/runtime.test.js dist/test/init.test.js` under the same environment. Initially missing exports/types may produce compile RED; after declaring signatures, require behavioral RED for v2/port/runtime rules before bodies.
- [ ] **Step 3: Implement the small parser/runtime boundary and migrate constructors.** Use the existing own-key/deep-freeze conventions and fixed errors. CLI checks runtime before dispatch/input/tools/writes; library doctor refuses probing on unsupported runtime; current transport checks before Agent creation. Keep a temporary typed zero-dial refusal for enabled http-connect Jev until Task 2 replaces the direct implementation. Preserve transport in withBackends now; update test/config.test.ts's export-surface assertion for the one added parser.
- [ ] **Step 4: Verify GREEN and migration completeness.** Run `env -i HOME="$HOME" PATH="$PATH24" pnpm test`. Expected: all offline tests including package.test pass, no real provider/native worker, no remaining v1 ProjectConfig constructors except explicit refusal fixtures. The existing package fixture may pack/install this built artifact offline in its owned temporary consumer; no registry access or new tool/dependency installation. Configuration/roster/managed-template version numbers remain distinct.
- [ ] **Step 5: Review/checkpoint.** With commit authority, run `pnpm audit --audit-level high` under the minimal environment and `git diff --check`, inspect the scoped diff, then checkpoint as `feat(config)!: require explicit v2 Jev transport and Node 24.5`. Otherwise retain an uncommitted checkpoint. No publication.

## Task 2: Shared fail-closed request chain and owned proxy Agent

**Files:**
- Modify: `src/systemone.ts`, `src/route.ts`, `src/doctor.ts`, `src/cli.ts` doctor integration.
- Create: `test/proxy-transport.test.ts`.
- Modify: `test/direct-transport.test.ts`, `test/task-routing.test.ts`, `test/doctor.test.ts`, `test/cli.test.ts`, `test/route-journal.test.ts`, and `test/systemone.test.ts` where old exports/seams are pinned.

**Interfaces:**
- Consumes Task 1 parser/runtime/config.
- Produces `RequestSpec` with required `transport:JevTransport`, exported `choiceRequest(spec:RequestSpec):Promise<unknown>`; removes directChoiceRequest without an alias.
- Retains `requestTaskChoice(config:ProjectConfig,task:string,backend:TaskBackend,env:NodeJS.ProcessEnv,signal:AbortSignal,request:ChoiceRequest = choiceRequest):Promise<TaskChoice>` and `ChoiceRequest=(spec:RequestSpec)=>Promise<unknown>`.
- Internal runProbe accepts `request:ChoiceRequest|undefined`, preserving the existing caller signal/deadline race; no separate default direct selection in callers.

- [ ] **Step 1: Add failing network and entry integration tests.** Name the boundary matrix `invalid backend target and policy never dial`; assert fixed typed failures and zero Agent/request/socket for Jev HTTP/non-official target, Laya HTTPS/proxy, userinfo/query/fragment, and malformed proxyUrl passed directly. Add `default route and probe honor frozen transport` and `protocol eligibility precedes injected requests`: every absent hosted condition yields request count 0, while eligible default probes work without seams.

For owned-loopback proxy fixtures, assert one CONNECT, no Origin Authorization/body in CONNECT, valid typed choice, fixed Jev target, and direct Laya unaffected. Negative fixtures cover 407/dead port/disconnect, CONNECT/TLS/response stalls, pre-abort, synchronous create/request throws, competing response/abort, callback-before-return and post-settlement sockets, duplicate socket delivery and unexpected second construction. Assert failure/settlement counts, peer close and child exit; no fallback/tripwire origin hits. Test an activated default-agent proxy control, uppercase/lowercase environment keys and NO_PROXY=*.

- [ ] **Step 2: Verify RED.** Run `env -i HOME="$HOME" PATH="$PATH24" pnpm run build` then the focused `direct-transport`, `proxy-transport`, `task-routing`, `doctor`, and `cli` built test files with `node --test`. Missing new signatures are initial compile RED only; obtain behavioral RED for proxy traversal, lower-boundary refusal and eligibility/default-probe behavior.
- [ ] **Step 3: Implement one network function and wire all callers.** Validate runtime/spec/transport/pre-abort before creating Agents. Reuse the existing bounded decoder/fixed failure projection; select the exact Agent settings from spec section 6. Use public createConnection ownership for pending and callback sockets, one construction, late-socket destruction, and one idempotent finish. Centralize protocol eligibility and policy construction; remove Task 1's temporary proxy refusal only when this shared default supports the policy. Pass optional seams through route/probe and remove the CLI's forced direct injection.

Keep HTTPS origin status separate from CONNECT errors. No private Agent pool access, alternate decoder, TLS bypass, auth settings, generic registry, or new dependency.

- [ ] **Step 4: Verify TLS, response regressions, and cleanup sensitivity.** Adapt former Laya-HTTPS fixtures to valid Jev specs before isolated network remapping; never weaken the target validator just to keep a fixture. Guard instrumented destinations to owned host/ports. Negative TLS runs have no test CA and include NODE_TLS_REJECT_UNAUTHORIZED=0; positive TLS uses an isolated synthetic trusted certificate for the required hostname, without a product CA option. Preserve 8192/8193-byte, 401/451/3xx/204/205/compression/truncation/UTF-8/JSON/choice and secret-canary assertions. In an isolated copy, remove only pending-socket ownership: cleanup assertion must fail; restore and require GREEN. Run the focused files and `pnpm test` under the minimal environment, expecting zero failures/no real requests or workers.
- [ ] **Step 5: Review/checkpoint.** Audit/diff-check with commit authority, then `feat(transport): share explicit Jev routing and own CONNECT sockets`. Review every default caller and ensure old exports/temporary guard are gone. No publication.

## Task 3: Bounded policy evidence without ordinary-round stop expansion

**Files:**
- Modify: `src/systemone.ts` TaskAttempt, `src/route.ts` settlement records, `src/doctor.ts` fixed evidence copy.
- Modify: `test/live-acceptance.ts` shared projection/SafeEvidence/sanitizer, `test/custom-round.ts` case evidence only.
- Test/update fixtures: `test/task-routing.test.ts`, `test/route-journal.test.ts`, `test/cli.test.ts`, `test/doctor.test.ts`, `test/worker.test.ts` TaskDecision fixtures, `test/live-acceptance.test.ts`, `test/custom-round.test.ts`.

**Interfaces:**
- Produces required `TaskAttempt.transportMode:"direct"|"http-connect"` on every outcome.
- Produces exported `AttemptTransportEvidence` from spec section 7 and `projectAttemptTransports(value:unknown):AttemptTransportEvidence` on the existing shared live-acceptance surface.
- observed/case records carry `attemptTransports:AttemptTransportEvidence`; raw/projected arrays use the same transportMode field so sanitizer revalidation is idempotent.

- [ ] **Step 1: Add failing projection and outcome tests.** Name tests `transport evidence is bounded and idempotent`, `unknown mode does not stop ordinary rounds`, and `all attempt outcomes preserve policy`.

```ts
const raw = [{ backend: "jev", transportMode: "http-connect", proxyUrl: "SECRET-URL" }];
const projected = projectAttemptTransports(raw);
assert.deepEqual(projected, [{ backend: "jev", transportMode: "http-connect" }]);
assert.deepEqual(projectAttemptTransports(projected), projected);
assert.equal(projectAttemptTransports([{ backend: "laya", transportMode: "http-connect" }]), "unverified");
```

Cover missing/non-array/invalid enum/duplicate/reversed/>2 elements without prefix salvage, ignored extra-key canaries, empty attempts and no unique receipt. For ordinary custom-round pass/failed/timeout, inject malformed/missing mode while retaining valid existing receipts/output/tree: original outcomes, continuation count and stopping gates must remain unchanged. Classifier-only uses its own route result, without fabricated CLI evidence.

- [ ] **Step 2: Verify RED.** Build and run `task-routing`, `route-journal`, `cli`, `doctor`, `live-acceptance`, `custom-round` test files under the minimal environment. Expected new metadata/projection assertions fail; preservation tests do not become stop tests.
- [ ] **Step 3: Implement bounded projection and mode records.** Derive policy from frozen config, retain through every settle branch, and use existing receipt/journal attempts. Project once from the unique frame; revalidate the limited schema at evidence writing. Keep unknown as unverified and omit all unselected content. Add fixed doctor policy text without URL. Do not alter ordinary custom-round grading, journal gate, timeout branch, or STOP_FAILURE_CLASSES.
- [ ] **Step 4: Verify GREEN.** Run focused files and full offline suite. Inspect projected ledger/receipt/journal test artifacts for sentinel absence and equality; verify actual worker-launch counts in fake fixtures, not only reservation counts. Expected unchanged ordinary continuation/exit protocol with the new bounded field.
- [ ] **Step 5: Review/checkpoint.** Audit/diff-check with commit authority, then `feat(evidence): record bounded classifier transport policy`. Reject any patch that moves ordinary stop order or promotes policy to actual-exit attestation.

## Task 4: Reachable proxy preparation and singleton standard-live acceptance

**Files:**
- Modify: `test/live-acceptance.ts` prepareAcceptance/withBackends/caps/fixture identification/specialized checks.
- Modify: `test/live.integration.ts` strict prepare flags.
- Test: `test/live-acceptance.test.ts` existing argument/buildRun/prepare/execute fixtures and `test/custom-round.test.ts` dynamic baseline coverage.

**Interfaces:**
- Produces `PrepareAcceptanceOptions=Readonly<{configPath?:string;caseId?:"dual-jev-write"}>` and `prepareAcceptance(suite:LiveSuite,options?:PrepareAcceptanceOptions):Promise<{manifestPath:string;sha256:string}>`.
- Entry grammar is exactly the spec's prepare options; execute remains manifest + approve SHA, without prepare options.
- Retains outer manifest versions/SUITE_CAPS/claim/parser equality. Default dual has both existing cases; fallback-only has one existing case and caps `{worker:1,laya:1,jev:1}`.

- [ ] **Step 1: Add failing offline preparation/entry assertions.** `explicit prepare config is frozen before approval` verifies caller file -> parsed v2 -> exact consumer policy and manifest, while shipped defaults stay direct. Reject >65536 bytes/bad UTF-8/JSON/v1/bad URL/symlink/FIFO before any run root or network. Resolve the explicit file path, reuse safe readProjectFile at dirname/basename, and use fatal TextDecoder; do not add a general file loader. Assert a malformed JSON/URL canary never appears in stderr: wrap input read/decode/parse errors in a fixed diagnostic rather than forwarding native message snippets.

`fallback-only prepare reserves exactly one existing case` asserts ID/kind/allowedChanges, one consumer, `{worker:1,laya:1,jev:1}`, no lead case, and unchanged default dual. Entry tests reject unknown/duplicate/missing options, case selector on non-dual, and options on execute; keep the existing single forwarding separator contract.

- [ ] **Step 2: Add failing owned-fixture execution assertions.** `singleton fallback binds its frozen 503 fixture` runs a fake native worker and synthetic-key owned TLS proxy/origin, never real hosted access. Assert Laya503 then Jev success, two attempts, one fake worker, no laya-first requirement; port conflict yields zero origin calls/worker starts and no port rewrite. Full dual applies the lead check only to its known ID. Specialized Jev/fallback cases with unverified/mismatching policy fail the existing verdict gate; ordinary cases remain unaffected. Drift of config/port/runtime.js refuses before spend; inspect dynamic baseline inclusion rather than add a closure engine.
- [ ] **Step 3: Verify RED.** Build and run `dist/test/live-acceptance.test.js` and `dist/test/custom-round.test.js` under the minimal environment. The new explicit input/singleton and identity-based assertions must fail for the current template-only/position-based implementation, not because fixture TLS or the native fake cannot start.
- [ ] **Step 4: Implement the narrow extension and verify GREEN.** Validate options/config before run-root creation; select the known fallback case before consumer creation; sum reservations; bind/check by case identity; add the specialized policy check from Task 3's projection. Preserve ordinary continuation, suite ceilings, full-dual defaults, port-conflict refusal, custom-round credential scrubbing, and dynamic baseline discovery. Run focused and full offline tests, expecting zero real model activity.
- [ ] **Step 5: Review/checkpoint.** Audit/diff-check with commit authority, then `test(live): prepare explicit transport and singleton fallback manifests`. Confirm no new suite/campaign driver, hosted custom-round execution, arbitrary filters, or relaxed hash/identity gates.

## Task 5: Documentation, full engineering verification, and gated handoff

**Files:**
- Modify: `README.md`, `.agents/skills/turnhelm-routing/SKILL.md`, and `test/package.test.ts` documentation assertions when the remaining copy changes; keep Task 1's packed version/engine/runtime checks. Preserve managed-template version unless its separate contract changes (not required here).
- Verification-only: package engines, runtime/transport/config/harness files and all tests from Tasks 1–4.

**Interfaces:**
- Consumes all preceding interfaces; produces one consistent documented v2 contract and engineering verification record. Does not produce live-execution authority or claim JT-AC-10 passed.

- [ ] **Step 1: Update English documentation.** Include v2 default/direct/proxy examples, literal URL/floor/refusal rules, manual owner reconciliation rather than auto-migration, hosted/write consent, shared default probe, TLS/CONNECT cleanup/no fallback, policy-not-exit evidence and unknown-mode ordinary-round behavior. Show the reachable prepare forms:

```sh
node dist/test/live.integration.js --prepare jev --config ./acceptance-config.json
node dist/test/live.integration.js --prepare dual --config ./acceptance-config.json --case dual-jev-write
```

These are future offline preparation examples, not commands to run now or authorization to supply credentials. Each creates a separate fresh-SHA singleton. Document manual readonly-success-before-write gating and no extra probe/worker/retry. Do not rewrite historical specs/seals or imply two successful cases fix band/optimality/billing findings.

- [ ] **Step 2: Run final engineering gates.** Under the minimal Node 24 environment run `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm run test:coverage`, `pnpm audit --audit-level high`, and `git diff --check`. Expected: exit0, all offline tests pass, line/branch/function >=80%, no high advisory, no real model/worker. Run local link/fence/JSON/schema-copy checks; inspect git diff and confirm no raw credentials/env/native messages in changes or retained fixture artifacts. Record actual runtime/test counts/coverage and limits, not copied historic results. CI verification requires separately authorized publication, not an automatic push.
- [ ] **Step 3: Check spec coverage and whole-branch review.** Map every JT-AC row to implemented tests/evidence; JT-AC-10 remains pending separately authorized live work. Verify temporary refusal/old aliases/duplicate parsers are absent, native Agent cleanup sensitivity still passes, and only policy metadata—not actual exit—is claimed. Use a fresh security-appropriate reviewer under the user-approved execution method; resolve substantive findings before release.
- [ ] **Step 4: Checkpoint documentation if authorized.** Audit and inspect the diff first; use `docs: document explicit Jev transport and gated acceptance`. Do not push, merge, release, change host config, prepare real consumer roots, or execute models automatically.
- [ ] **Step 5: Deliver the engineering result and stop at the live gate.** Report files/tests/remaining risks. Request separate preparation scope only when engineering review passes; no claim that historical PARTIAL or provider refusal policy is resolved.

## Subsequent Live Gate — Not an Executable Task in This Plan

JT-AC-10 needs separate approval/preparation material after engineering completion:

- Freeze an owner-reviewed v2 proxy configuration, actual runtime/HEAD/built baseline, tasks/allowances/deadlines, and two independent manifests: readonly Jev then singleton dual-jev-write. Total caps classifiers3/workers2/Jev2/controlled Laya1, real Laya inference0.
- Review/freeze a pure observational native launcher plus real executable identity. Forward args/stdin unchanged; project only canonical root/model/effort from actual native requested --model/model_reasoning_effort; associate unique root/task hash/receipt/journal. Recording failure refuses launch. Do not copy the old wrapper's forced-login/auth-unset behavior or record full argv/env/task/keys. No collector framework or authority inherited from old artifacts.
- Approve each fresh exact SHA and immediate hosted/write boundary separately. Execute no extra doctor/probe. Only readonly exit0, complete records, specialized policy and native-request evidence permit the second execution; otherwise close all remaining second authority.
- Close/seal each result without retry/resume/regrading. Native requested argv is not provider-internal attestation; missing observation remains unverified. Current 451 cause/actual exit/invoices/optimal routing and independent policy findings remain open.

## Coverage and Plan Self-Review

| Spec criteria | Owner |
| --- | --- |
| JT-AC-01 / runtime and init portions of 02/08 | Task 1 |
| JT-AC-03/04/05/06 | Task 2 |
| JT-AC-07 and ordinary-round preservation | Task 3 |
| Preparation/identity/caps/baseline portions of JT-AC-08; specialized policy gate | Task 4 |
| JT-AC-09 and documentation consistency | Task 5 |
| JT-AC-10 | Subsequent independently approved live gate, not current implementation spend |

Self-review checks: every shipped requirement has an owner; shared names/types are consistent; all five Review Focus cases have owning tests; config migration is atomic without an interim silent-direct proxy path; packed asset/engine/runtime-copy assertions migrate in Task 1, not after its promised GREEN; projection is idempotent; default full dual and ordinary-round continuation remain; no framework/dependency/permission expansion. Task bodies are implementation decisions and test assertions, not a transcript of the entire program.

Execution remains unselected. Recommended: **subagent-driven, sequential tasks with independent task and whole-branch reviews**, because TLS/socket ownership and preparation/evidence boundaries deserve separate gates. Native execution with one independent final review is the smaller-context alternative. Review this plan and select the execution method before any implementation.
