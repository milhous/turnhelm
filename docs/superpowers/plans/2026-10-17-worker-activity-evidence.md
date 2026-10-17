# Worker Activity Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve bounded, content-free native activity observations through the existing lifecycle
and both acceptance harnesses without changing execution, grading, routing, or paid-request behavior.

**Architecture:** Add one typed activity event at the existing decoder boundary and enrich the existing
lifecycle entry for that frame. Reuse the shared strict projector, safe bounded project-file reader and
64-entry retention policy; contain optional-evidence faults at extraction boundaries. Enable existing
lifecycle capture in custom-round, with an exact regular-journal tree exemption and no new subsystem.

**Tech Stack:** TypeScript, Node >=24.5.0, pnpm 10.12.1, built-in `node:test`; existing fake classifiers,
fake Codex executables and sandbox helpers. No new dependencies. The documentation-authoring host
has Node 24.11.0 and TypeScript 7.0.2; use a supported Node runtime, not an unverified system default.

**Spec:** [Worker Activity Evidence Design](../specs/2026-10-17-worker-activity-evidence-design.md).
Read both documents before implementation. Source references below are baseline locations at
`e121891` (runtime unchanged from `499367d`); resolve symbols again if lines move.

**Status:** planning only, following the user-requested Astra review and spec revision. The plan has
not been implemented or independently reviewed. User plan review and execution-method choice are
required before product edits. Old live authorities remain closed; this plan authorizes no live calls.

## Global Constraints

- "The product default remains lifecycle-disabled."
- "Only fixed enums and validated bounded numeric scalars cross the new boundary."
- "Do not add item IDs or per-item state to correlate phases. No unique-action count is claimed."
- "Existing task/error hashes and existing final-output/oracle retention are unchanged."
- "No new automatic escalation or request is added."
- All documentation, comments, code descriptions and commit messages are English.
- Preserve exact worker task stdin/argv, terminal/sink-error precedence, deadlines, owned teardown,
  one-receipt behavior, stop order, output/schema gates and sealed grades. No backward-compatibility
  alias for the replaced diagnostic; no unrelated cleanup, credentials/proxy/service changes or pushes.
- Before execution, use the git-worktree skill to establish isolation from the documentation branch.
  Preserve user changes. Native implementation is recommended because these tasks share one contract;
  do not infer an execution-method choice from authorization for this Astra design review.

## Review Focus

1. Malformed known value before an unknown detail key must not suppress strict rejection; raw
   extraction still omits invalid optional evidence without bypassing stop gates. Pin in Task 2/3.
2. A journal leaf replaced/grown during access must not defeat the actual 1048576-byte read ceiling or
   block on a FIFO; equal timestamps do not guarantee reconstructed settle order. Pin in Task 2.
3. An empty directory masquerading as the journal, and unrelated `.turnhelm` changes, must still
   fail integrity checks; only the exact regular journal is exempt. Pin in Task 3.
4. A completed nonzero command observation is not worker failure, while a diagnostic sink error
   retains its existing output-failure behavior. Pin in Task 1.
5. The expanded 64-entry receipt must fit the existing 65536-byte line cap, and positively not-started
   workers must never gain a timeline; standard receiptless-timeout evidence still works. Pin in Task 1/2.

## Phase 0: Documentation and API Discovery (completed for planning)

One isolated `gpt-6-astra/high` review-only subagent inspected the original spec and relevant source,
tests, README/skill and official protocol page. The parent verified the findings and revised the spec.
The original review verdict was **PROBLEMS - narrowly correctable**, not approval of unimplemented
code or the revised plan. No second review, runtime test or native worker/provider test call occurred.

### Allowed existing APIs and patterns

| Source | Existing signature / copy-ready pattern |
| --- | --- |
| `src/codex-events.ts:83` | `decodeWorkerEvent(frame: Uint8Array): WorkerEvent`; reuse `frame` and privacy cases in `test/codex-events.test.ts:6,46-66` |
| `src/codex.ts:178-192,630-712` | `executeWorker(decision: TaskDecision, task: string, options): Promise<WorkerResult>`; existing `options.lifecycle?: LifecycleRecorder`, `processFrames`, `dispatch`, bounded diagnostic delivery |
| `src/lifecycle.ts:14-44` | `LIFECYCLE_CAPACITY = 64`; head 8/tail 56; `record(kind: LifecycleKind, detail?: LifecycleEvent["detail"]): void`; `snapshot(): Readonly<{ events: readonly LifecycleEvent[]; overflow: boolean }>` |
| `src/project.ts:32-56` | `readProjectFile(root: string, relative: string, max: number): Promise<Buffer \| undefined>`; descriptor-backed max+1 regular-file read, final-leaf non-following/nonblocking flags |
| `src/journal.ts:91-103`, `src/cli.ts:253-285` | `appendLifecycleEvent(root, event: { pid: number } & LifecycleEvent, diagnostic?): Promise<void>`; CLI forwards sanitized recorder/result evidence without new serialization |
| `test/live-acceptance.ts:1167,1200,1422` | `projectWorkerLifecycle(value: unknown): WorkerLifecycleEvidence \| undefined`; `readWorkerLifecycleJournal(root: string, pid: number \| null): Promise<WorkerLifecycleEvidence \| undefined>`; existing strict `decodeBounded(data: Buffer): string \| null` |
| `test/live-acceptance.ts:1448-1452` | `superviseCli(file: string, args: readonly string[], options): Promise<CliSupervision>`; existing `pid`, `cliClosed`, output caps, timeouts and cleanup; do not change signature |
| `test/custom-round.ts:880,924,940,1142-1195` | `projectWorkerReceipt(worker: unknown): WorkerReceiptEvidence \| undefined`; private `receiptWorkerObject`, `receiptCount`, `workerFailureOf`; shell stdin-file transport uses `exec`, preserving CLI pid |
| `test/worker.test.ts:131,2501,2583,2593` | `runWorker(t, scenario)`, `stageLifecycleCli(t, mode)`, `collectRun(child)`, `receiptOf(stderr)`; extend existing fake modes, not a new worker harness |
| `test/live-acceptance.test.ts:719,1042,1066,1088,1369-1515` | `startClassifierFixture`, `writeFakeCodex`, `workerEnv`, `buildRun`; existing lifecycle, receiptless-timeout and hostile-detail cases |
| `test/custom-round.test.ts:547,639-788,795` | `fakeCodexBody`, `ExecuteCaseSpec`, `scratchExecuteRound`, `readLedger`; existing both-transport and stop tests |
| `test/project.test.ts:77-104,139-170`, `test/route-journal.test.ts:31` | Safe-read boundary/race child patterns and `journalChild` safe-append fixture |

Discovery guards: official JSONL documentation does not establish the complete optional exit/status
schema. `test/codex.test.ts` pins old-export removal/module surface, not worker dispatch. No new public
package API, file-reader abstraction, lifecycle flag, config or roster schema is needed.

---

## Phase 1 / Task 1: Decode and propagate sanitized activity

**Files:** Modify `src/codex-events.ts:9-15,83-113`, `src/codex.ts:630-712`,
`src/lifecycle.ts:11-16`. Test `test/codex-events.test.ts`, `test/worker.test.ts`,
`test/lifecycle.test.ts`, `test/cli.test.ts`; verify `src/cli.ts`, `src/journal.ts` forwarding and
`test/codex.test.ts` module exports remain correct without unnecessary edits.

**Interfaces:**
- Consumes: existing native frame decoder, `executeWorker` options, recorder and CLI forwarding above.
- Produces: type-only internal-module export `WorkerActivity` with the spec's four item fields;
  `WorkerEvent` gains `Readonly<{ kind: "activity" } & WorkerActivity>`. `LifecycleEvent.detail` accepts
  those typed fields alongside existing detail fields; no extra receipt object.
- Export the existing head value as `LIFECYCLE_HEAD_KEEP = 8` from `src/lifecycle.ts`; derive private
  tail size from capacity minus head. This is an internal shared constant, not a new package surface.
- No `executeWorker`, CLI or journal signature changes; completed non-agent diagnostic becomes exactly
  `turnhelm: worker-activity\n` under the existing lossy/backpressure discipline.

- [ ] **Step 1: Add failing decoder table and worker propagation tests.** Reuse `frame`, `runWorker`
  and `stageLifecycleCli`. Pin all three phases/four kinds; invalid started/updated stays ignored;
  completed item/agent validation remains strict. Pin independent phase/status, signed safe/zero exit
  codes only on completed commands, and omission for null/string/fraction/unsafe/wrong-kind codes.
  Representative assertion (reuse the existing `frame` helper):

  ```typescript
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed", item: { type: "command_execution", status: "completed",
      exit_code: 13, command: "PRIVATE_COMMAND", aggregated_output: "PRIVATE_OUTPUT" }
  })), { kind: "activity", itemKind: "command_execution", itemPhase: "completed",
    itemStatus: "completed", itemExitCode: 13 });
  ```

  Extend one lifecycle fake mode with reasoning, command started/updated/completed and file-change
  frames containing distinct canaries. Assert receipt/journal fields match the spec; no command,
  output, path, reasoning, ID or unknown type/status canary leaks. Stderr only reports completed-item
  `worker-activity`, stdout and terminal status are unchanged. Keep existing diagnostic sink-error,
  sticky failure, cancellation and backpressure cases rather than duplicating them per item kind.
  In the flood fixture use maximally populated valid activity details and assert 64 entries, head 8,
  tail 56, overflow true, last settle, one event append per decoded frame, and the receipt JSON line's
  UTF-8 byte length `< 65536`. Without lifecycle, assert no receipt lifecycle/journal.
- [ ] **Step 2: Run RED.** `pnpm run build && node --test dist/test/codex-events.test.js dist/test/lifecycle.test.js dist/test/worker.test.js dist/test/cli.test.js`.
  New assertions must fail for missing activity/old diagnostic; unrelated failures are not a valid RED.
- [ ] **Step 3: Implement the smallest projection/dispatch change.** Define `WorkerActivity` using
  exactly the spec enums and optional safe-number field. Decode item phases without copying raw
  properties. Enrich the existing single `record("event", ...)` call, dispatch activity without terminal
  effects, and emit the renamed fixed diagnostic on completed phase only. Reuse the existing recorder
  and sinks; make no new append call, per-item map, callback layer or lifecycle-default change.
- [ ] **Step 4: Run GREEN.** Repeat Step 2 plus `node --test dist/test/codex.test.js dist/test/route-journal.test.js`.
  Expect zero failures/cancellations and all new assertions actually exercised. Review exact task
  stdin, six argv tuples, home cleanup, final-message framing and diagnostic sink-error regressions.
- [ ] **Step 5: Review and commit only Task 1 files.** Run `git diff --check` and dependency audit
  before commit; use `feat: preserve sanitized worker activity in lifecycle`. Do not change sink
  failure semantics or weaken old assertions beyond the intended diagnostic/event vocabulary change.

## Phase 2 / Task 2: Complete the shared projection and safe standard retention

**Files:** Modify `test/live-acceptance.ts:1109-1229,1277-1295,2040-2047`;
test `test/live-acceptance.test.ts:1369-1515` and `test/project.test.ts` reader regressions.
Reuse `src/project.ts` unchanged and Task 1 retention constants.

**Interfaces:**
- Consumes: Task 1 `WorkerActivity` facts and `LIFECYCLE_CAPACITY`/`LIFECYCLE_HEAD_KEEP`.
- Produces: unchanged exported signatures `projectWorkerLifecycle(value: unknown)` and
  `readWorkerLifecycleJournal(root: string, pid: number | null)` with the spec's validation/retention.
- Change private `projectLifecycleDetail(value: unknown, kind: string): WorkerLifecycleDetail | undefined`
  to enforce parent-kind/activity-field consistency; all callers must pass the validated kind.
- Strict ledger input rejects unknown keys; raw receipt extraction catches rejection and omits the
  optional timeline. Best-effort journal read/decode/projection faults return `undefined`.

- [ ] **Step 1: Add failing projection, extraction and journal tests.** Table-test valid activity,
  required enums, optional values, command-phase restrictions, no mixed process/settlement fields,
  and malformed detail dropping only detail. Test unknown-key rejection in either insertion order:

  ```typescript
  for (const detail of [
    { itemStatus: "bad", unknownKey: "PRIVATE" },
    { unknownKey: "PRIVATE", itemStatus: "bad" }
  ]) {
    assert.throws(() => projectWorkerLifecycle({
      events: [{ tMs: 0, kind: "event", detail }], overflow: false
    }));
  }
  ```

  Use distinct timestamps to assert an 80-entry projection keeps indices `0..7` and `24..79`, sets
  overflow, and is idempotent. Preserve incoming overflow true for shorter arrays. For a journal
  with equal timestamps assert only bounded, sanitized approximate chronology, not exact settle order.
  Extend existing reader tests for exact 1048576 bytes vs 1048577, invalid UTF-8, malformed JSON/detail,
  unknown key, another pid, missing/symlink/FIFO/directory leaf and growing/replaced-leaf reads. Reuse
  isolated fs-patching child patterns from `test/project.test.ts`, with a deadline to catch blocking.
  Assert `undefined` on optional fallback faults and no raw content in returned evidence.
  Extend standard fixtures to retain activity on completed pass and wrong output as well as existing
  failure/timeout tests. Test no timeline for not-started, raw projection faults cannot bypass original
  stop records, and preserve the receiptless-timeout journal crash-evidence regression.
- [ ] **Step 2: Run RED.** `pnpm run build && node --test dist/test/live-acceptance.test.js dist/test/project.test.js`.
  Expect the new retention/activity/boundary assertions to fail on existing behavior; inspect failures.
- [ ] **Step 3: Implement shared validation and safe extraction.** Prevalidate all detail keys, then
  validate values/cross-field constraints. Use Task 1 constants for first-eight/last-56 slicing and
  truthful overflow. In the journal reader replace stat/readFile with
  `readProjectFile(root, ".turnhelm/lifecycle.jsonl", 1048576)`, reuse `decodeBounded`, and contain
  read/decode/parse/projection exceptions. Use the shared projector for final journal retention;
  do not implement another whitelist or alter the existing bounded reader. Keep pid filtering and
  approximate timestamp sort. Remove the standard success-outcome filter, catch raw extraction
  rejection, and retain existing receiptless-timeout fallback separately from not-started behavior.
- [ ] **Step 4: Run GREEN.** Repeat Step 2; expect zero failures/cancellations. Verify direct strict
  ledger rejection still fails closed, while malformed optional diagnostics neither erase the original
  stop reason nor change request/reservation counts. No new source-side protocol failure is introduced.
- [ ] **Step 5: Review and commit only Task 2 files.** Diff check and dependency audit, then
  `fix: retain safe lifecycle evidence across acceptance outcomes`.

## Phase 3 / Task 3: Wire custom-round without loosening integrity gates

**Files:** Modify `test/custom-round.ts:17,323-365,1139-1195,1247-1275,1300-1360`;
test `test/custom-round.test.ts:547-788,795-860,1186-1290,1338-1385,1628-1870`.

**Interfaces:**
- Consumes: Task 2 exported `projectWorkerLifecycle`, `readWorkerLifecycleJournal` and
  `WorkerLifecycleEvidence` type; existing raw receipt reader, worker projection and supervisor pid.
- Produces: optional top-level `workerLifecycle?: WorkerLifecycleEvidence` on case records and existing
  projectable stops. Existing `WorkerReceiptEvidence`/`workerFailure` fields and exported
  `executeRound(manifestPath, approvedSha256, options?): Promise<number>` stay unchanged.
- Both CLI transports add existing `--lifecycle`; native worker argv is unchanged. Journal fallback
  runs only on the normal closed, one-receipt, executed-worker case path after early stop gates.

- [ ] **Step 1: Extend existing failing custom-round fixtures, not a new harness.** Add a small native
  activity-frame option to `fakeCodexBody`; use `scratchExecuteRound` and `readLedger` to test both
  transports, exact task delivery, schema/write flags, and unchanged actual invocation counts. For
  two successful cases (one per transport), assert:

  ```typescript
  assert.equal(code, 0);
  assert.equal(await readFile(round.invocations, "utf8"), "11");
  const cases = (await readLedger(join(round.evidenceRoot, "custom-round-evidence.jsonl")))
    .filter(row => row.phase === "case");
  assert.equal(cases.length, 2);
  for (const row of cases) {
    assert.equal(row.outcome, "pass");
    assert.ok(row.workerLifecycle !== undefined);
  }
  ```

  Pin completed wrong-output/unchanged-write failures and the existing clean timeout: lifecycle
  retained, timeout unjudged, no oracle/contract run, counts reconcile, next reservation unchanged.
  Extend existing cleanup/output-cap/stopping-class/tree/root/pre-/post-contract-oracle-identity tests
  to check receipt-projected lifecycle when attributable; malformed diagnostics must preserve their
  original stop reasons. Pin no journal fallback ahead of cleanup/output-cap/receipt/stopping-class
  gates; later tree/root/oracle stops may reuse already-collected normal-path evidence. Pin no fallback on
  zero/multiple receipt stops,
  not-started, signal, contract-infrastructure and pre-spend paths. Cover normal-path fallback for an
  executed-worker receipt lacking lifecycle and verify pid filtering for stdin shell `exec`.
  Tree cases: exact regular lifecycle journal permitted (including oversize); symlink, FIFO and empty
  directory at that exact path rejected promptly; another `.turnhelm` file changed still tree-drifts.
  Use table tests for metadata combinations; do not multiply all cases by every transport/item/status.
- [ ] **Step 2: Run RED.** `pnpm run build && node --test dist/test/custom-round.test.js`.
  Expect missing lifecycle/new-journal false drift assertions to fail; preserve existing test guards.
- [ ] **Step 3: Implement narrow wiring.** Add the CLI flag in argument and shell-stdin launch forms.
  Count/parse the receipt once at existing extraction, reuse `projectWorkerReceipt`, and safely project
  lifecycle only for a projectable executed worker. Remove `workerFailureOf` only if made unused; do
  not add a public extraction API. Reuse one computed optional lifecycle field for the existing
  case/stop append sites, including both oracle-identity branches. Keep all gate order/return codes.
  Perform fallback only after cleanup/output/receipt/stopping-class gates; never for not-started.
  In `hashTree`, check the exact lifecycle relative path before directory recursion, require an actual
  regular file, then skip byte/hash/size accounting for that leaf only. Do not exempt the directory,
  change ordinary file budgets, or add broad allowedChanges. Retain existing journal distrust limits.
- [ ] **Step 4: Run GREEN.** Repeat Step 2 plus
  `node --test dist/test/live-acceptance.test.js dist/test/worker.test.js`.
  Expect zero failures/cancellations. Reconcile written outcomes, completed counts, CLI exit codes,
  fake actual invocations and absence of later reservations after stops; do not infer them from caps.
- [ ] **Step 5: Review and commit only Task 3 files.** Diff check and dependency audit, then
  `feat: preserve bounded lifecycle evidence in custom rounds`.

## Phase 4 / Task 4: Document the current contract and verify the whole change

**Files:** Modify `README.md:334-341,510-522,560-565,638-654` and
`.agents/skills/turnhelm-routing/SKILL.md` corresponding lifecycle/acceptance passages.
Test existing `test/package.test.ts`, `test/init.test.ts`; add/update only assertions genuinely affected
by this contract. Review `test/route-journal.test.ts`, CLI and worker forwarding/privacy coverage.

**Interfaces:** Consumes Tasks 1-3's final behavior. Produces aligned English documentation and a
verified offline implementation; no new public API, fixture roster, manifest or paid diagnostic.

- [ ] **Step 1: Add failing document-contract assertions.** Pin `worker-activity`, fixed activity
  metadata/privacy limits, 64-entry bound, all-attributable-outcome retention, custom exact regular
  journal exemption and absence/overflow not meaning zero actions. Keep README/skill shared passages
  aligned. Assert neither document claims tool counts, exact file reads, journal causal ordering or
  that the five historical non-passes are fixed. Preserve existing package/install boundary assertions.
- [ ] **Step 2: Run RED.** `pnpm run build && node --test dist/test/package.test.js dist/test/init.test.js`.
  Expect new documentation assertions to fail before editing the prose.
- [ ] **Step 3: Update the English documentation to the implemented truth.** Remove obsolete
  failed-only/completed-omission and tool-progress wording where it describes the current contract,
  not historical immutable reports. Copy the spec's interpretation limits; do not add a compatibility
  alias, raw logging advice or live-retry instructions. Keep existing oracle authoring and gate rules.
- [ ] **Step 4: Run GREEN and full offline verification.** Execute in order:

  ```sh
  node --version
  pnpm --version
  pnpm exec tsc --noEmit -p tsconfig.json
  pnpm test
  pnpm test:coverage
  pnpm audit --registry=https://registry.npmjs.org --json
  git diff --check
  git diff --stat
  ```

  Require a supported Node runtime, zero test failures/cancellations, existing 80% line/branch/function
  coverage gates and no unexplained new skip. Do not freeze the old 637-test count or lower gates.
  Dependency audit must complete; investigate findings, never install/update dependencies silently.
  Inspect remaining `tool-progress` references: current runtime/docs must use the new category;
  historical reports/spec rationale may retain historical wording. Confirm no raw native object spread,
  new item-ID map, custom-round whitelist copy, extra per-frame append, request/retry path, config change or
  runtime export from `src/codex.ts`. Verify README/skill alignment explicitly, not from tests alone.
- [ ] **Step 5: Review and commit documentation/assertions.** Use
  `docs: describe bounded activity evidence and acceptance limits`. Follow the user-selected execution
  method's final independent review, resolve verified findings and rerun affected checks. Report the
  actual code/test diff, tests and residual risks; do not merge/push or declare root-cause resolution.

## Coverage and Handoff

| Spec requirement | Owner / verification |
| --- | --- |
| Section 1 evidence boundary; no causal fix claim | Task 4 prose/assertions and final report |
| Sections 2, 3.1-3.2 decoder, privacy, unchanged worker semantics | Task 1 decoder tables and worker/lifecycle CLI tests |
| Section 3.3 strict projection, bound, fallback, standard retention | Task 2, including insertion-order, safe-read and receiptless-timeout tests |
| Section 3.3 custom transports, stop priority, exact regular-leaf exemption | Task 3 existing fixture/stop tests |
| Section 3.4 privacy/performance/unknown evidence | Tasks 1-3 canaries/flood/caps; Task 4 interpretation |
| Sections 4-5 connected consumers and offline regression gates | All four phases; Task 4 complete suite/coverage/audit |
| Sections 6-7 authority and review limitations | This handoff and revised spec; no live step |

Plan self-review: existing signatures and test helpers checked against source; every spec requirement
has an owning phase. Review Focus cases have explicit tests above. No new framework/helper package,
independent parallel implementation lane or Cartesian end-to-end matrix is required. The parent
authored/self-reviewed this plan; Astra reviewed the original spec, not this plan or implementation.

Recommended execution: **Native**, sequential Tasks 1-4, because they share a small evidence contract
and closely coupled existing helpers; a fresh whole-branch review is more useful than repeated context
handoffs. This is a recommendation, not a choice on the user's behalf. Await user review/selection.

After offline implementation/review, propose a separate minimal one-variable paid diagnostic only if
needed. A fresh finite manifest and exact SHA approval remain mandatory. Do not replay the old campaign,
raise timeouts, refit policy bands or promise universal success/real API billing as part of this plan.
