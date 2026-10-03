# Phase A Boundary Hardening Implementation Plan

Status: Tasks 1–3 implementation verified (2026-10-03); controller review/integration checklist remains pending. Hermetic tests: 192/192 on exact Node 22.8.0/npm 10.8.2, Node 24.21.0, and Node 26.5.0; source lines/branches/functions: 99.26%/93.79%/100%; audit: zero vulnerabilities. No new live run.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close classifier input bypasses, establish hermetic verification, and finish the authorized Phase A integration.

**Architecture:** A pure input-policy module owns continuation and length rules. Routing converts local-only reasons into fallback; the strict classifier rejects them before network work. The raw request builder is private and classifier redirects fail closed.

**Tech Stack:** TypeScript, Node.js built-in test runner and coverage, Git.

## Global Constraints

- The classifier limit is exactly 2000 JavaScript UTF-16 code units, measured on the original task. Exactly 2000 is eligible; 2001 is not.
- Existing bilingual continuation detection remains local-only.
- Eligible tasks are sent unchanged. There is no truncation or normalization of the task transmitted to the classifier or the Codex child.
- Every classifier fetch uses `redirect: "error"`; redirects are backend failures, never alternate origins.
- Existing hosted-Jev config/environment/key gates and the single Laya-to-Jev fallback transition remain unchanged.
- Offline tests use dummy keys and restored environment/fetch state only. They must pass with real classifier credentials absent.
- Source coverage must reach at least 80% for lines, branches, and functions, using Node's built-in coverage, including CLI/child-process smoke coverage.
- Node's declared floor is `>=22.8.0`; offline CI runs Node 24, with SHA-pinned official actions, read-only contents permission, and no persisted checkout credentials.
- No paid live rerun is necessary. No production dependency, Gateway, Hook, catalog, confidence policy, retry mechanism, or native subagent integration is added.
- Preserve user work and existing commits. Work in the current feature checkout; only the controller performs integration and publication.

### Task 1: Close the classifier input boundary and isolate unit credentials

**Files:**
- Create: `src/task.ts`
- Modify: `src/route.ts`, `src/systemone.ts`
- Modify: `test/route.test.ts`, `test/systemone.test.ts`

**Interfaces:**
- Consumes: `Config`, `chooseProfile(config: Config, prompt: string): Promise<string>`, `classifyTask(prompt: string, config: Config)`.
- Produces: `localRoutingReason(prompt: string): "continuation" | "fallback" | undefined` in `src/task.ts`; existing routing and classifier signatures stay intact. `buildSystemOneRequest` is private with an explicit selected backend parameter.

- [x] **Step 1: Add and execute RED boundary regressions.**

  Mock only fetch; never contact a real backend. Add a table of `classifyTask`
  and `chooseProfile` invocations for each backend (`laya`, `jev`, `auto`) with
  both opt-ins enabled and dummy credentials. For empty, whitespace, 2001-unit,
  non-string, and bilingual continuation tasks, assert rejection and exactly
  zero fetches. The mock otherwise returns a valid `direct` decision. Include
  `continue!`, `继续。`, and an overlong continuation. Add namespace assertions
  that the raw request builder is not exported, and fetch-option assertions
  that redirects fail closed.

  Representative assertion, using current imports before changing production:

  ```ts
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "direct" } } }));
  };
  try {
    await assert.rejects(() => chooseProfile(config, "x".repeat(2001)));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
  ```

  Run `npm run build && node --test dist/test/route.test.js dist/test/systemone.test.js`.
  Capture the missing-rejection/export/redirect failures, then create a
  Conventional Commit RED checkpoint with exact evidence in its body. The
  pre-existing hermetic 18/19 failure is known, not a new regression.

- [x] **Step 2: Apply the smallest shared policy and fail-closed transport.**

  Implement the complete policy below; use its result in `resolvePhaseARoute`
  instead of the local regex/length literals. Remove redundant empty checking
  from `classifyTask`; `chooseProfile` applies the policy before any backend
  selection or try/catch and throws `task is not eligible for classification`
  for a local-only reason.

  ```ts
  const continuation = /^(继续|接着做|按刚才的方案继续|continue|go on|proceed)[.!。！\s]*$/i;

  export function localRoutingReason(prompt: string): "continuation" | "fallback" | undefined {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("task must not be empty");
    if (prompt.length > 2000) return "fallback";
    return continuation.test(prompt.trim()) ? "continuation" : undefined;
  }
  ```

  Make `buildSystemOneRequest` private and its backend parameter mandatory;
  verify model aliases through intercepted serialized fetch bodies rather
  than keeping a test-only production export. Add `redirect: "error"` to the
  fetch options. Initialize and restore dummy `TYPESAFE_API_KEY`, `LAYA_API_KEY`,
  and disabled default `TURNHELM_ALLOW_HOSTED_JEV` per unit test, allowing
  explicit test-local overrides for opt-in and missing-key cases.

- [x] **Step 3: Verify boundaries and GREEN, then commit.**

  Add exactly-2000-unit and Unicode boundary checks, unchanged original body
  assertions, normal direct/profile success, unknown/malformed responses,
  and no-fallback local-only failures. Assert zero fetches for rejected and
  fallback-local tasks, including with hosted Jev explicitly enabled. Keep
  existing configured backend fallback tests.

  Run focused tests and then
  `env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV npm test`.
  Run `npm audit --audit-level=high`, review `git diff`, and run
  `git diff --check` before the GREEN commit. Report RED/GREEN commands,
  failing/passing counts, changed files, commits, and any concerns.

### Task 2: Reconcile docs and retain offline coverage gates

**Files:**
- Modify: `package.json`, `package-lock.json` (Node engine floor metadata only)
- Modify: `src/cli.ts` (approved original-task correction only)
- Create: `test/cli.test.ts`
- Create: `.github/workflows/ci.yml`
- Modify if needed for meaningful coverage: `test/config.test.ts`, `test/codex.test.ts`, `test/route.test.ts`, `test/systemone.test.ts`
- Modify: `README.md`, `docs/superpowers/specs/2026-10-03-jev-laya-phase-a-routing-design.md`, `docs/superpowers/plans/2026-10-03-jev-laya-phase-a-routing.md`, `docs/validation/2026-10-03-jev-laya-phase-a.md`
- Update status: this plan and its matching design doc after verification.

**Interfaces:**
- Consumes: the completed Task 1 public routing/classifier APIs and policy.
- Produces: `npm run test:coverage`, dated offline evidence, accurate completed Phase A status.

- [x] **Step 1: Add hermetic CLI/child-process characterization tests.**

  Use temporary config files, a loopback HTTP test server for typed responses,
  and a temporary executable named `codex` prepended to PATH. Invoke only
  `process.execPath` plus the compiled CLI via asynchronous `execFile` with a
  finite timeout. Never invoke a real Codex executable or hosted API. Restore
  environment, close servers, and remove temporary directories with `t.after`.
  Preserve Node's coverage environment for child-process coverage.

  Cover route JSON/direct/profile, original task stdin, read-only and explicit
  workspace-write argv, removal of classifier credentials, generic errors for
  blank/unsupported commands or invalid config, and local-only long/continuation routes.
  Add focused remaining config/argv/error-path characterization tests if the
  actual source coverage requires them; do not test implementation-only mocks.

  Controller-approved original-task correction: the joined CLI task must not
  be trimmed before routing or stdin. The focused CLI RED checkpoint
  (`4f09272`) recorded 16 tests, 13 passing and three expected failures for
  padded/newline stdin and padded 2001-unit routing. Preserve `.join(" ")` and
  use `!prompt.trim()` only for usage validation. GREEN: 16/16 focused CLI tests,
  including unchanged classifier state/stdin in both sandbox modes and zero
  loopback requests for padded 2001-unit input. No other source edits.

- [x] **Step 2: Add the built-in source coverage command and verify its gate.**

  Before adding the script, `npm run test:coverage` must report the missing
  script. Add the following script and set `engines.node` to `>=22.8.0` in
  package/lock root metadata. The controller verified the official Node CLI
  source: coverage filters were added in 22.5.0; thresholds in 22.8.0.

  ```json
  "test:coverage": "npm run build && node --test --experimental-test-coverage --test-coverage-include='dist/src/**' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 dist/test/*.test.js"
  ```

  Run the coverage command with all classifier credentials/opt-in unset.
  All three source thresholds must pass; do not exclude poorly covered
  production modules or count test files to inflate coverage.

  Retain the gate for future changes with this minimal workflow (official
  action tag SHAs were verified by the controller before dispatch):

  ```yaml
  name: Offline verification
  on: [push, pull_request]
  permissions:
    contents: read
  jobs:
    verify:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
          with:
            persist-credentials: false
        - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
          with:
            node-version: 24
            cache: npm
        - run: npm ci --ignore-scripts
        - run: npm run test:coverage
        - run: npm audit --audit-level=high
  ```

- [x] **Step 3: Synchronize documentation and record offline evidence.**

  Mark the original Phase A spec implemented/validated with dated smoke
  evidence, update its migration paragraph, and mark the original plan's
  completed execution steps checked. Document strict direct-helper behavior,
  UTF-16 limit, private request builder, and redirect rejection briefly.
  Add README development commands for offline tests/coverage. Append only
  scalar offline test/audit/coverage evidence to the validation doc, keeping
  the previous live result intact and explicitly not claiming a new live run.
  Set the hardening spec/plan to verified completion once their gates pass.

- [x] **Step 4: Final task verification and commit.**

  Run hermetic `npm test`, hermetic `npm run test:coverage`,
  `npm audit --audit-level=high`, `git diff --check`, and inspect `git diff`.
  Commit only task-owned files with a Conventional Commit message, and
  report commands, exact source coverage, test count, and any concerns.

### Task 3: Close all final-review failure/resource boundaries

**Files:**
- Modify: `src/codex.ts`, `src/systemone.ts`
- Modify: `test/cli.test.ts`, `test/codex.test.ts`, `test/systemone.test.ts`
- Update current verification evidence/status: `README.md`, `docs/validation/2026-10-03-jev-laya-phase-a.md`, both current Phase A/hardening specs, and this plan.

**Interfaces:**
- Consumes: existing `runCodex(route: RouteDecision, prompt: string, write: boolean): Promise<number>` and `chooseProfile(config: Config, prompt: string): Promise<string>`.
- Produces: the same public interfaces with controlled stdin failures, bounded private response decoding, strict own-property choices, and deterministic CommonJS-safe offline Codex fixtures.

- [x] **Step 1: Reproduce all findings and commit RED tests.**

  The controller already reproduced the exact Node22.8/npm10.8.2 floor failure
  (163/168) and reviewer reproduced unhandled EPIPE with an immediate-exit fake
  Codex and a 100 KiB input. Add focused behavior regressions before production
  edits. Make the fake CLI fixture's temporary directory explicitly CommonJS
  with a local `package.json` so the existing top-level-await bug also fails on
  current Node; do not assert source-code strings instead of behavior.

  Use a finite-timeout Node child harness importing the real `runCodex`, with
  only a temporary immediate-exit shell `codex` on PATH, and a generated
  100 KiB task. Expect the nonzero child code to be returned without an
  unhandled exception; separately verify an early zero exit with failed input
  transfer returns nonzero, and a missing executable is a controlled rejection.

  Mock fetch with typed valid decision JSON padded to byte boundaries. Add
  exactly-65536 success; 65537 overflow; oversized declared Content-Length with
  no read; understated/missing header overflow; multi-chunk/multibyte UTF-8
  accounting; cancel-on-error; malformed JSON/invalid UTF-8/absent body/read
  error with generic non-leaking errors; normal direct/profile success and
  existing auto fallback behavior. For ordinary `profiles: { ...config.profiles }`,
  inherited `toString`/`constructor` responses must be rejected; legitimate
  own profile IDs remain valid. No live services, real Codex, or real keys.

  Run `npm run build && node --test dist/test/cli.test.js dist/test/codex.test.js dist/test/systemone.test.js`, capture expected failures, audit/diff-check,
  and create a Conventional Commit RED checkpoint before production edits.

- [x] **Step 2: Apply the minimal lifecycle and response-budget fixes.**

  Wrap the temporary extensionless fixture's async body in an async IIFE;
  retain its existing output/exit/signal behavior and explicit CommonJS context.
  In `runCodex`, attach stdin/process listeners before `.end(prompt)`, handle
  stdin errors without an unhandled emitter, and settle on child `close` so
  late stream errors precede completion. Preserve nonzero statuses; if input
  failed and code is zero, return 1. Spawn errors reject with a generic error.
  Keep the existing public signature and do not add execution timeouts/retries.

  In `systemone.ts`, add a private bounded-reader helper. Maximum response
  bytes are exactly `64 * 1024`. A reader fills a bounded `Uint8Array`, checks
  declared Content-Length before read and actual chunk byte totals before
  copying, decodes valid UTF-8, then parses JSON. Cancel and release on every
  failure/overflow; cancellation cleanup errors must not expose data or mask
  the primary controlled failure. No raw JSON parse exception excerpts escape.
  Retain the existing fetch timeout/redirect options and type/profile checks;
  replace `answer.choice in config.profiles` with
  `Object.hasOwn(config.profiles, answer.choice)`. No new dependency or export.

- [x] **Step 3: Verify GREEN on every declared target and reconcile evidence.**

  Rerun the same focused command, then hermetic `npm test` and
  `npm run test:coverage` on exact Node22.8.0 with its bundled npm10.8.2,
  official Node24.21.0, and native Node26.5.0. Verified tool directories are
  `.git/tools/node-v22.8.0/bin` and `.git/tools/node-v24.21.0/bin`; prepend the
  chosen directory to PATH. Node22's bundled npm avoids an unrelated native
  npm11 engine warning. All source thresholds must still pass, with every
  production module meaningfully covered. Inspect output, audit, and diff-check
  before the GREEN checkpoint.

  Update documentation with current scalar results and the response budget,
  controlled child-input semantics, and exact-minimum verification. Preserve
  original dated live evidence and earlier RED/GREEN receipts as historical
  evidence; do not fabricate a new live result or mark integration complete.
  Append all covering commands, counts/coverage, and concerns to the report.

## Controller integration checklist

- [ ] Task 1 spec/quality review accepted; Task 2 spec/quality review accepted.
- [ ] Reconcile `.git/sdd/progress.md` with completed authorized live smoke and new hardening results.
- [ ] Scan all unpublished Git history for secrets with redacted output; review final diff.
- [ ] Obtain independent whole-branch review; fix any blocking findings and re-review.
- [ ] Fetch and verify remote ancestry; normally push the reviewed feature branch and wait for offline CI to pass before fast-forwarding local main. Rerun offline verification, normally push main without force, and verify remote HEAD/CI.
