# Terminal-Event Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `executeWorker` decides a clean run at the decoded `completed` event, emits its payload, then forces bounded teardown through the existing owned TERM→KILL ladder — instead of waiting unboundedly for the native process to exit (observed 28.073 s linger).

**Architecture:** All semantics live inside `executeWorker` (`src/codex.ts`): a `decided` flag set at the terminal event (or the stdin ack, whichever completes the eligibility predicate first), the existing settlement-time emission moved to that decision point (before any signal), the existing `beginShutdown` ladder started once the payload write is accepted, and post-decision native noise excluded from failure attribution while parent sink failures keep it. Settlement gates (`settle()`) are untouched.

**Tech Stack:** TypeScript (Node ≥24.5, strict), `node:test` via `pnpm test`, existing scenario-table fake-codex harness in `test/worker.test.ts`.

**Spec:** `docs/superpowers/specs/2026-10-16-terminal-event-settlement-design.md` — the plan argues from it; read both.

## Global Constraints

- No functional change outside `src/codex.ts`: `src/cli.ts`, `src/codex-events.ts`, `test/live-acceptance.ts`, `test/custom-round.ts` untouched (spec §2, TS-7 — no new receipt or `WorkerResult` field).
- `CASE_TIMEOUT_MS` stays `240_000` and its pin test stays green (spec §1, §5).
- `TERM_GRACE_MS = 1000`, `GROUP_POLL_MS = 25`, `FAILED_EXIT_GRACE_MS = 5000` unchanged (spec §2).
- Zero paid calls; all tests offline with fake codex (spec §4).
- Every changed line traces to the spec; comments match the file's existing dense comment style; docs and comments in English.
- Conventional Commits; do not merge to main (user merges personally).

## Review Focus

1. **Sink failure after decision** — parent stdout EPIPE/errors mid-emission must yield `status:"failed"`, `error:"output"` (exit 1), never `completed`/exit 0 → pinned in Task 4.
2. **Terminal frame decoded before the stdin ack** — decision must still fire (stdin-ack trigger), no return of the unbounded wait → pinned in Task 3.
3. **TERM-ignoring group after the terminal event** — SIGKILL escalation, run still `completed`, `signal:"SIGKILL"` → pinned in Task 3.
4. **Post-terminal `message`/`failed`/usage frames** — dropped; `finalMessage`/`usage` frozen at the terminal frame, not last-decoded-wins → pinned in Task 3.
5. **Operator SIGINT inside the post-decision window** — `cancelled`, 130/143 discipline, operator outranks the delivered verdict → pinned in Task 5.

---

### Task 1: Fake-codex post-terminal linger knob and the core RED tests

**Files:**
- Modify: `test/worker.test.ts` (scenario table + fake-codex generator, the `codex` shim built per scenario near lines 78–120 and 330–390)
- Test: `test/worker.test.ts`

**Interfaces:**
- Produces: scenario field `postCompletedLingerMs?: number` — the fake worker emits its `completed` frame (and any scripted message/usage frames before it), then sleeps exactly this many ms, then exits 0. Distinct from existing `lingerMs` (which delays inside the harness wrapper after settlement).

- [ ] **Step 1: Add `postCompletedLingerMs` to the scenario type and the fake generator**

In the fake codex shim generator, after the frame sequence the scenario scripts, insert `await sleep(scenario.postCompletedLingerMs)` before process exit when the field is set. One knob, no others.

- [ ] **Step 2: Write the failing test — completed run with a 10 s post-terminal linger**

Name: `terminal-event settlement bounds the completed run's wait`. Scenario: normal message frame + `completed` frame, `postCompletedLingerMs: 10_000`. Assert on the result file: `status === "completed"`, `ownedShutdown === true`, `durationMs < 5_000` (ladder-bounded, not linger-bounded — generous bound covers CI jitter; today it exceeds 10 s), `code` is `0` or `143`, payload bytes on the captured sink exactly the classified emission, and exactly one SIGTERM observed against the owned group (reuse the existing kill-tracking helper).

- [ ] **Step 3: Write the failing test — completed run, native exits promptly**

Name: `terminal-event settlement is race-free against voluntary exit`. Same frames, no linger knob. Assert `status === "completed"`, `ownedShutdown === true` (the decision precedes close; the ladder still discharges), payload intact.

- [ ] **Step 4: Run both to verify RED**

Run: `pnpm test test/worker.test.ts --test-name-pattern "terminal-event settlement"`
Expected: both FAIL — today the first waits the full 10 s and reports `ownedShutdown === false`, `durationMs > 10_000`.

- [ ] **Step 5: Commit**

```bash
git add test/worker.test.ts
git commit -m "test: pin terminal-event settlement behavior (RED)"
```

### Task 2: Core implementation in `executeWorker`

**Files:**
- Modify: `src/codex.ts:114-176` (state + predicate), `src/codex.ts:224-242` (`settle`), `src/codex.ts:266-306` (guards), `src/codex.ts:467-506` (`dispatch`), `src/codex.ts:540` (stdin ack)
- Test: `test/worker.test.ts` (Task 1's tests)

**Interfaces:**
- Consumes: `postCompletedLingerMs` scenarios from Task 1.
- Produces: internal `let decided = false;` flag; `completedEligible()` without the `childCode === 0` term. No signature changes; `executeWorker`'s external contract is unchanged.

- [ ] **Step 1: Change the predicate (spec TS-1)**

`completedEligible` becomes `failure === undefined && !cancelled && inputDelivered && completionSeen && !stickyFailed` — delete the `childCode === 0` term and the comment sentence that cites it.

- [ ] **Step 2: Add the decision routine (spec TS-1/TS-2/TS-3)**

Add `decided` state and one routine, e.g. `const tryDecide = (): void => { ... }` — body determined by the spec's ordering: if `decided || shutdownStarted || finished` return; if `!completedEligible()` return; set `decided = true`; then run the existing emission step (the exact classify/project/`emitMessage` block currently inside `settle()`, still guarded once-only by `finalEmitted`, PE-1 order kept); then, if the write was accepted or there is no message to emit, `beginShutdown()`. Refactor `settle()`'s emission branch to call the same shared block — the branch remains as the never-decided catch-all (spec TS-2). Keep `finalMessage`/`payloadProjection` capture before the sink call.

- [ ] **Step 3: Wire the two triggers (spec TS-1)**

Call `tryDecide()` at the end of the `completed` case in `dispatch` (after `completionSeen = true` and the usage capture), and inside the stdin end callback at `src/codex.ts:540` after `inputDelivered = true` (the terminal-frame-before-ack ordering).

- [ ] **Step 4: Scope post-decision guards (spec TS-5)**

`recordFailure` and the `stickyFailed` path in `dispatch` gain `decided` to their existing guard conjunctions — for native causes only. For the `"output"` cause, keep attribution live until settlement: in `failSink` and the `ackWrite`/`emitMessage`/`writeDiagLine` error paths, set `failure` directly when it is unset and `!finished` (a short helper, e.g. `recordOutputFailure`), instead of routing through the guarded `recordFailure`. Preserve every existing comment about first-cause-wins; add one comment stating the exemption (an accepted write holds settlement open, so its failure is pre-settlement).

- [ ] **Step 5: Run Task 1's tests to verify GREEN**

Run: `pnpm test test/worker.test.ts --test-name-pattern "terminal-event settlement"`
Expected: PASS.

- [ ] **Step 6: Run the full worker suite**

Run: `pnpm test test/worker.test.ts`
Expected: failures only in tests pinning the old semantics (exit-code eligibility, voluntary-exit settlement, last-decoded-message/usage replacement) — enumerate them; Task 5 re-pins. No hangs, no process leaks (`owned.pid` cleanup asserted by the suite).

- [ ] **Step 7: Commit**

```bash
git commit -am "feat: settle clean worker runs at the terminal event with bounded owned teardown"
```

### Task 3: Adversarial pins — triggers, escalation, freezing

**Files:**
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: Task 2's semantics; `postCompletedLingerMs` knob.

- [ ] **Step 1: Pin the stdin-ack trigger (Review Focus 2)**

Name: `terminal frame before stdin ack still decides`. Fake emits `completed` immediately while stdin bytes are still flushing (fake reads nothing before emitting; the harness's `inputDelivered` callback lands after the frame). Use `postCompletedLingerMs: 8_000`; assert `completed`, `ownedShutdown`, `durationMs < 5_000`. If the shim's timing cannot force the ordering, gate the frame emission on a marker file the harness writes after one macrotask — keep it deterministic, never sleep-raced.

- [ ] **Step 2: Pin SIGKILL escalation (Review Focus 3)**

Name: `TERM-ignoring group escalates and still completes`. Fake traps SIGTERM (existing fixture has a signal-trapping mode; extend it to cover the post-terminal sleep) with `postCompletedLingerMs: 10_000`. Assert `completed`, `ownedShutdown`, `signal === "SIGKILL"` or `code === 137`, `durationMs < 5_000`.

- [ ] **Step 3: Pin post-terminal frame freezing (Review Focus 4)**

Name: `post-terminal frames are dropped and the terminal snapshot is final`. Fake emits message A, `completed` (with usage snapshot U1), then — after a short delay but before exit — message B, a second `completed` carrying usage U2, and a malformed frame. Assert `completed`, emitted payload derived from message A only, result `usage` equals U1 (or absent iff U1 absent), no `failureClass`.

- [ ] **Step 4: Pin the zero-message completed run**

Name: `zero-message terminal event completes without emission`. Fake emits only `completed` with `postCompletedLingerMs: 6_000`. Assert `completed`, zero bytes emitted, `ownedShutdown`, bounded duration.

- [ ] **Step 5: Pin payload backpressure under the new ordering (spec §4 item 5)**

Name: `blocked sink at emission still flushes exactly once`. Sink blocks (`gate`-style blocked writable, existing machinery) when the emission lands; fake lingers 8 s. Assert the run settles only after the drain, bytes on the sink are exactly the classified emission, `completed`, and no second emission ever occurs.

- [ ] **Step 6: Run; fix within `src/codex.ts` if any pin is RED**

Run: `pnpm test test/worker.test.ts --test-name-pattern "terminal frame|TERM-ignoring|post-terminal|zero-message|blocked sink"`
Expected: PASS (these pin Task 2; a RED pin is an implementation bug to fix here, not a test to weaken).

- [ ] **Step 7: Commit**

```bash
git commit -am "test: pin terminal-event triggers, KILL escalation, and terminal snapshot freezing"
```

### Task 4: Sink-failure attribution pins

**Files:**
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: Task 2's `recordOutputFailure` behavior.

- [ ] **Step 1: Pin synchronous write failure at emission (Review Focus 1)**

Name: `sink throws at emission after decision`. Gate on the existing sink-error machinery (reuse the `gate: "epipe-received"` pattern): destroy/throw on the output sink the moment the fake's `completed` frame arrives. Assert `status === "failed"`, `error === "output"` — never `completed`.

- [ ] **Step 2: Pin asynchronous ack failure after the ladder started (Review Focus 1)**

Name: `late payload ack error fails the decided run`. Accepted write flushes with an error after `beginShutdown` has run (fake lingers slightly; sink errors via stored callback — the `storedCb`/`PRIVATE_LATE_ACK` mechanism). Assert `failed`/`output`, not `completed`/exit-0.

- [ ] **Step 3: Run**

Run: `pnpm test test/worker.test.ts --test-name-pattern "sink throws|late payload ack"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -am "test: pin output-cause attribution across decision and ladder"
```

### Task 5: Abort precedence pin and legacy re-pins

**Files:**
- Modify: `test/worker.test.ts` (existing tests enumerated in Task 2 Step 6)

**Interfaces:**
- Consumes: Task 2 semantics.

- [ ] **Step 1: Pin abort-after-decision (Review Focus 5)**

Name: `operator abort in the post-decision window cancels`. Abort the controller during the post-terminal ladder (fake lingers 8 s; abort at ~300 ms). Assert `status === "cancelled"` and the existing signal-exit projection — operator intent outranks the delivered verdict (spec TS-6).

- [ ] **Step 2: Re-pin the old-semantics tests**

For each failure enumerated in Task 2 Step 6, rewrite the assertion to the new semantics (spec §4 item 13): `childCode === 0` eligibility → predicate without it; voluntary-exit settlement → ladder-bounded; last-decoded-message/usage-replacement → terminal-frozen. Do not delete tests; change what they pin, keeping their names descriptive of the new truth.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: PASS across `test/` (worker, cli, codex-events, harness suites — `CASE_TIMEOUT_MS` pin included).

- [ ] **Step 4: Commit**

```bash
git commit -am "test: re-pin settlement semantics for terminal-event decision"
```

### Task 6: End-to-end receipt, docs, final verification

**Files:**
- Test: `test/worker.test.ts` (CLI-level case) or `test/cli.test.ts` where the existing CLI e2e pattern lives
- Modify: `README.md` (worker-semantics paragraph), `.agents/skills/turnhelm-routing/SKILL.md` (worker paragraph, only if it states exit-based settlement)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: CLI-level e2e pin (spec §4 item 12)**

One test: run the CLI against a lingering fake worker (`postCompletedLingerMs`); assert exit code 0, stdout carries the classified payload, stderr receipt shape is byte-compatible with today's (no new keys — assert the exact key set), receipt `worker.ownedShutdown === true`.

- [ ] **Step 2: Update the two doc paragraphs**

State the new truth in each: a clean run settles at the decoded terminal event; the owned ladder then bounds teardown (TERM at once, KILL at 1 s); exit code after a completed turn is an observation (`ownedShutdown` + `signal` in the receipt), not a completion signal. One short paragraph each; delete any sentence claiming the run waits for process exit.

- [ ] **Step 3: Full verification**

Run: `pnpm test && pnpm build` (use the repo's actual scripts from `package.json`; if typecheck is separate, run it too).
Expected: all PASS, build clean, `git diff --check` clean.

- [ ] **Step 4: Commit**

```bash
git commit -am "docs: terminal-event settlement semantics in README and routing skill"
```
