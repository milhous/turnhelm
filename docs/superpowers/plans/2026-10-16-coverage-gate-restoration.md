# Coverage Gate Restoration — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Date: 2026-10-16. Branch: `spec/coverage-gate-20261016` (docs); implementation on `feat/coverage-gate-restoration` cut from it. Spec: `docs/superpowers/specs/2026-10-16-coverage-gate-restoration-design.md` (post-Astra revision; findings dispositioned in its §6). Baseline: `330ff37`.

**Goal:** Make `pnpm run test:coverage` pass deterministically again by stopping `NODE_V8_COVERAGE` instrumentation from reaching test children whose exits are unordered, without touching the frozen gate command or losing measured child coverage.

**Architecture:** One product fix — `subprocessEnvironment` (`src/codex.ts`) replaces its ineffective `delete` with an own property `NODE_V8_COVERAGE: undefined`, because Node reinserts the parent's value into any child env lacking that own property (probe-verified 2026-10-16: omit-key and spread+delete forward; own-undefined yields absent). Plus explicit `undefined` overrides at the few test spawn sites that are simultaneously disposable (cannot contribute `dist/src/**` coverage) and unordered (killed during exit or unawaited at report time). Measured children keep the variable; the empty/partial coverage JSON that crashes Node's reporter comes only from mid-write collisions.

**Tech Stack:** TypeScript (Node >=24.5.0), `node:test` + `node:assert/strict`, `node:child_process`, no new dependencies.

## Global Constraints

- Strip form is always an own property set to `undefined`; `delete` and omission are ineffective (spec §3).
- Measured children — worker-test harness spawns (import `src/codex.js`), `cli.test.ts` baseEnv children, live-acceptance/package harness entries (`live-acceptance.test.ts:106`, `:2785`, `:2840`, `:3684`, `:2384`) — keep the variable unconditionally (spec §1, §3).
- `package.json` byte-identical to baseline; `src/` diff limited to `subprocessEnvironment`; no harness behavior change beyond env hygiene at spawn boundaries (spec §2).
- Offline only — no Laya/Jev/worker execution, no live suites (spec §5).
- Conventional commits; no auto-push; merge stays with the user.

## Review Focus

Spec-implied conditions no ordinary happy-path test exercises; each pinned in the owning task:

1. Env reinsertion: a child whose `options.env` lacks the own property silently receives the parent's `NODE_V8_COVERAGE` — a regression from `undefined` back to `delete` must fail a test, not pass silently (Task 1 real-child negative).
2. Over-reach: an override applied to a measured child silently drops coverage toward the 72.93% floor — the positive control and Task 3's threshold runs catch it.
3. `undefined` vs empty string: the override value must be `undefined`; `""` forwards an empty path to the child (Task 1 asserts the child observes nothing, not `""`).
4. Residual sweep race: a passing stress series is evidence, not proof — no silent retry-until-green; a failing run stops for writer identification and re-adjudication (Task 3).
5. Scope creep under pressure: no threshold, include-filter, or script tweak to force green — Task 4's scope check rejects it.

---

### Task 1 — Real coverage boundary in `subprocessEnvironment`

**Files:**
- Modify: `src/codex.ts:39-59` (`subprocessEnvironment`)
- Test: `test/worker.test.ts:465-485` (upgrade the existing env-object pin to a real-child pair)

**Interfaces:**
- Produces: `subprocessEnvironment(env, …)` whose returned env carries `NODE_V8_COVERAGE: undefined` as an own property; all worker/fake-worker descendants cross this boundary. No signature change.

- [ ] **Step 1: Write the failing real-child test**

In `test/worker.test.ts:465-485`, keep the existing denial assertions (`LAYA_API_KEY`, `BASH_ENV`, `ENV` — plain keys with no reinsertion behavior) and replace only the `NODE_V8_COVERAGE` object assertion with a spawned-child pair (use the file's existing `node:child_process` import):

```ts
test("worker children do not inherit coverage instrumentation across the boundary", async () => {
  const sentinel = "/tmp/turnhelm-test-coverage-sentinel";
  const probe = "process.stdout.write(process.env.NODE_V8_COVERAGE ?? \"absent\")";
  const run = (env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", probe], { encoding: "utf8", env }, (error, stdout) =>
      error ? reject(error) : resolve(stdout));
  });
  // Negative: across the boundary the child observes nothing (not even "").
  assert.equal(await run(workerEnvironment({ PATH: process.env.PATH ?? "", NODE_V8_COVERAGE: sentinel }, root)), "absent");
  // Positive control: without the boundary Node forwards (and reinserts) the value.
  assert.equal(await run({ PATH: process.env.PATH ?? "", NODE_V8_COVERAGE: sentinel }), sentinel);
});
```

The positive control documents the Node behavior the negative test defends against: it fails if Node ever stops forwarding, which would make the negative test vacuous.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build && node --test dist/test/worker.test.js --test-name-pattern="coverage instrumentation"`
Expected: FAIL — the negative assertion sees the sentinel (the current `delete` does not prevent reinsertion).

- [ ] **Step 3: Implement the override**

In `subprocessEnvironment` (`src/codex.ts:53`), replace `delete copy.NODE_V8_COVERAGE;` with:

```ts
  // Node reinserts the parent's NODE_V8_COVERAGE into any child env lacking
  // this own property, so deletion is not stripping: an explicit undefined is.
  copy.NODE_V8_COVERAGE = undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/worker.test.js dist/test/cli.test.js`
Expected: PASS, including the existing worker-environment denial pins around `worker.test.ts:465-485` (LAYA_API_KEY etc.) and the CLI env tests.

- [ ] **Step 5: Commit**

```bash
git add src/codex.ts test/worker.test.ts
git commit -m "fix(codex): stop forwarding NODE_V8_COVERAGE into worker children"
```

### Task 2 — Override at disposable-and-unordered test spawn sites

**Files:**
- Modify: `test/executable-fixture.ts:14` (`prepareExecutable` spawn), `test/custom-round.ts:119-127` (sandbox env), `test/live-acceptance.test.ts` (peer spawn `:2400`, linger fixture spawn near `:875`)
- No new test file: these are env constructions; the gate exercise is Task 3

**Interfaces:**
- Consumes: Task 1's strip form (own property `undefined`).
- Produces: the audit table below, completed with verified classifications; each override is one property in an existing env object.

- [ ] **Step 1: Verify and record the audit table**

Confirm each site against the spec's criterion (disposable = cannot contribute `dist/src/**` coverage; unordered = killed during exit or unawaited at report time). Initial classifications from the spec review:

| Site | Child | Class | Action |
| --- | --- | --- | --- |
| `test/executable-fixture.ts:14` | fixture launcher script, detached group, 10 s SIGKILL timer (`killOwned`) | disposable, unordered | Override |
| `test/custom-round.ts:119-127` | sandbox-exec → node check wrapper (fixture script), constructed allowlist env | disposable, kill paths in runner | Override (also honors the comment's fresh-allowlist intent) |
| `test/live-acceptance.test.ts:2400` | `node -e` HTTP peer, `t.after` SIGKILL while it may be exiting | disposable, unordered | Override |
| `test/live-acceptance.test.ts` linger fixture (~`:875` spawn site) | `node -e` lingerer, SIGKILL backstop | disposable, unordered | Override |
| `test/live-acceptance.test.ts:106`, `:2785`, `:2840`, `:3684`, `:2384` | harness/entry children importing dist code | measured | Keep |
| `test/worker.test.ts` harness spawns | harness imports `src/codex.js` | measured | Keep |
| `test/cli.test.ts:218-227` baseEnv | CLI child (`dist/src/cli.js`) | measured | Keep |
| `test/proxy-transport.test.ts` `runNode`, `test/direct-transport.test.ts:558` | fixture scripts; 30 s execFile timeout kill paths (`killSignal: "SIGKILL"` / default SIGTERM) that fire only once the run is already failing | disposable, ordered (kill on failure only; a killed running child leaves no coverage file — spec §1 controlled check) | Keep (valid noise files only) |
| `test/package.test.ts` | entry children, awaited | measured | Keep |
| `test/runtime.test.ts:105` `runCli` | CLI child (`-e` importing the dist CLI), constructed env, awaited, no kill path | measured | Keep |
| `test/executable-fixture.test.ts:51/54` native-env probe, `:76` fixture spawn | fixture/probe scripts, awaited completion | disposable, ordered | Keep (valid noise files only) |
| `test/live-acceptance.ts:1262` `superviseCli` | entry child (harness), INT→TERM ladder | measured | Keep (accepted residual sweep race, spec §1) |
| `test/worker.test.ts:399` harness spawn, `:2204` measured CLI child | harness imports `src/codex.js` / runs `dist/src/cli.js`; 20 s timeout guard | measured | Keep |

Amend the table in the plan commit if verification changes a row; do not silently diverge.

- [ ] **Step 2: Apply the overrides**

Each site: add `NODE_V8_COVERAGE: undefined` to the env object handed to spawn. For `prepareExecutable` (currently no `env` option — full inherit) and the `:2400` peer (same), pass `env: { ...process.env, NODE_V8_COVERAGE: undefined }`. For the custom-round sandbox env and the linger fixture, add the property to the existing constructed env. No other change to those spawn calls.

- [ ] **Step 3: Run the affected suites**

Run: `pnpm run build && node --test dist/test/executable-fixture.test.js dist/test/custom-round.test.js dist/test/live-acceptance.test.js`
Expected: PASS — behavior of every fixture is unchanged (only the instrumentation key differs).

- [ ] **Step 4: Commit**

```bash
git add test/executable-fixture.ts test/custom-round.ts test/live-acceptance.test.ts
git commit -m "test: keep coverage instrumentation out of disposable fixture children"
```

### Task 3 — Stress verification of the restored gate

- [ ] **Step 1: Five consecutive stock runs**

Run `pnpm run test:coverage` five times; interleave at least one run with recorded parallel load (e.g. `pnpm run build` in a loop alongside, or the Laya service active). Record each run's all-files line/branch/function and exit code in the plan checklist. Expected per run: exit 0, ≥80/80/80, no `Could not report code coverage` warning.

- [ ] **Step 2: Failure protocol (only if a run fails)**

Do not retry silently. Re-run with the hunt pattern (ps-snapshot logger; extract the writer pid from the runner's `coverage file is empty: …/coverage-<pid>-…` line), classify the writer against Task 2's table: disposable → add its site to Task 2 and repeat Step 1; measured → the reporter's sweep race is inherent to Node's runner — record it and stop for re-adjudication of the gate design (spec §5's stress-not-proof framing).

### Task 4 — Full offline verification and scope check

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: 587/587 pass, exit 0.

- [ ] **Step 2: Scope and checks**

Run: `git diff --stat 330ff37..HEAD && git diff 330ff37..HEAD -- package.json && npm audit`
Expected: diff limited to `src/codex.ts` (one function), the four test files, and the spec/plan docs; `package.json` diff empty; audit zero vulnerabilities.

- [ ] **Step 3: Final state**

Run: `git status --short && git log --oneline 330ff37..HEAD`
Expected: clean tree, exactly the task commits plus docs commits on the branch. No push — merge stays with the user.
