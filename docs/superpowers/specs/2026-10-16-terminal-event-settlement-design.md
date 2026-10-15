# Terminal-Event Settlement Spec

Date: 2026-10-16. Code baseline: `595f77f75f89bb524e4c2dee10716af7ad1d3090` (main, clean). Input: the sealed single-readonly-worker diagnostic (`/Users/zhangxiao/.local/state/turnhelm/worker-single-diagnostic-20261015-ElCd4n/REPORT.md`, campaign seal `44f29c2dc563…`, verdict `PASS-SINGLE-READONLY-DIAGNOSTIC`, original 240 s timeout **not reproduced**, root cause **UNRESOLVED**).

> Status: drafted under the user's authorization to write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, paid worker calls, or publication. Constraints fixed by the user: optimize for long-term benefit, safety, and performance only; backward compatibility is explicitly not maintained.

## 1. Findings and decision boundary

Diagnostic facts (all parent-observed, monotonic clock):

| Fact | Value |
| --- | --- |
| Native `turn.completed` frame decoded | t = 24 185 ms |
| Native stdout/stderr EOF + exit-zero + close | t = 52 258 ms |
| Completion-to-exit gap | **28 073 ms**, exactly matching the receipt's last-event age |
| Production CLI exit | t = 52 259 ms (1 ms after native close) |
| Mid-run stderr with fixed `timeout` phrasing at t = 6 449 ms | run still completed — stderr phrasing is not a terminal signal |

Structural reading, which this spec treats as the design defect regardless of the old campaign's still-unproven root cause:

1. **The verdict is hostage to voluntary process exit.** `executeWorker` (`src/codex.ts`) retains the final message at the `message` event and knows the turn is over at the `completed` event, but `settle()` still requires `closed` — the native process's own exit. Nothing bounds the interval between the terminal event and that exit; the diagnostic measured 28 s (57 % of the run's wall clock) with a quiet stream. A quiet stream is not evidence of generation; conversely, the decoded `completed` event **is** the protocol's terminal signal.
2. **The harness budget spans that unbounded interval.** `superviseCli` (`test/live-acceptance.ts:1362`) arms one wall-clock timer (`CASE_TIMEOUT_MS = 240 000`, frozen) from CLI spawn to CLI close, and the CLI closes only after the native child closes. A deadline kill landing anywhere in the completion-to-exit window records a run whose work product was already delivered as `timedOut` — a delivered answer masquerading as a timeout. This is the leading (unproven) hypothesis for the old campaign's case-38 stop, and it is a real failure mode even if that case had a different cause.
3. **The evidence gate that blocked this fix is now satisfied.** The 2026-10-12 v030 round-1 §6 rejection ("changing supervision before that evidence exists would be guessing; evidence bar: a fresh gated live run's counters") required exactly what the sealed diagnostic delivered: a fresh gated live run localizing a 28.073 s gap between `turn.completed` and native exit with exit/EOF/close inside 1 ms.

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: terminal-event settlement in production `executeWorker` — decide the run at the decoded `completed` event, emit the payload, then force bounded teardown through the existing owned TERM→KILL ladder; harness semantics untouched | Removes the unbounded voluntary-exit interval from every consumer's critical path (CLI users and both harnesses) at once; −53 % wall clock on the observed run; kills the delivered-work-looks-timed-out failure mode at its root; zero new signals, zero budget changes | **Adopt** |
| B: harness-only early verdict (parse the CLI receipt line in `superviseCli`, stop the clock there) | Uses an evidence channel as a control channel; CLI users keep the 28 s tail; two verdict notions to keep consistent forever | Reject |
| C: split budgets (generation 240 s + separate settle budget) | Treats the symptom; the voluntary-exit dependency and the false-timeout verdict both remain; grows campaign wall clock | Reject |

Not maintaining backward compatibility means: tests that pin exit-code-based completion eligibility or voluntary-exit settlement are rewritten, and `WorkerResult.code`/`signal` semantics on completed runs change (§3). It does **not** mean raising `CASE_TIMEOUT_MS`, adding retry/regrade, relaxing acceptance, or rewriting sealed history — the diagnostic's own boundary ("no deadline/integration/proxy change solely to turn the prior campaign green") stands; this spec changes settlement semantics on independently obtained evidence, not budgets.

## 2. Scope, inheritance, and invariants

Files changed: `src/codex.ts` (settlement semantics), `src/codex-events.ts` only if the `WorkerResult` field addition requires the shared type home, `test/worker.test.ts` and the fake-codex fixture knobs (`test/fixtures.ts` / `test/executable-fixture.ts` — exact sites pinned by the plan), the worker-semantics paragraph of `README.md`, and the worker paragraph of `.agents/skills/turnhelm-routing/SKILL.md` if it states exit-based settlement. `test/live-acceptance.ts`, `test/custom-round.ts`, `src/cli.ts`, routing, classifier, config: **no functional change**.

Inherited unchanged: the frozen `CASE_TIMEOUT_MS = 240_000` and its pin test; one-receipt == 1 discipline; never resumed/replayed; `STOP_FAILURE_CLASSES`; reservation-before-spend; signal ladder 130/143; the owned-group-only signaling rule (`signalGroup` targets only `-child.pid`); sandbox contract check; prepare mode; spawn interception; env stripping (`subprocessEnvironment`/`workerEnvironment`); backpressure discipline (accepted write ≠ flushed write; pendingWrites/drain waits); PE-1 payload classification before emission; sticky-failure irreversibility and `FAILED_EXIT_GRACE_MS`.

## 3. Design — terminal-event settlement (TS)

All changes are inside `executeWorker` unless noted. Numbered requirements are normative.

### TS-1 Decision at the terminal event

Decoding a `completed` worker event **decides** the run when the run is otherwise clean. The completed-run predicate becomes:

```ts
const completedEligible = (): boolean =>
  failure === undefined && !cancelled && inputDelivered && completionSeen && !stickyFailed;
```

`childCode === 0` is removed from the predicate: after this spec the process exit code is an observation, never a completion signal. The native process's exit status after a decoded terminal event is an artifact of its own shutdown (or of our ladder), not of the work product; the diagnostic showed a completed turn followed by 28 s of quiet exit-waiting, and grading must not depend on which way that wait ends.

### TS-2 Emission stays where it is

The settlement-time emission is unchanged and stays inside `settle()`: classify the retained final message (PE-1), project the payload, `emitMessage`, once-only, with the existing pendingWrites/drain-wait flush discipline. The verdict text has lived parent-side since the `message` event was decoded, so no child signal can lose it; emitting after teardown rather than before it adds no risk and changes no ordering that exists today.

### TS-3 Bounded forced teardown replaces exit-waiting

At decision, the run invokes the existing owned shutdown ladder (`beginShutdown`: SIGTERM the owned group, poll `signalGroup(0)` every `GROUP_POLL_MS = 25 ms`, SIGKILL at `TERM_GRACE_MS = 1000 ms`) — the same ladder every failure path already uses. The ladder caps the wait for `closed` at `TERM_GRACE_MS + GROUP_POLL_MS ≈ 1.0 s` (observed voluntary wait: 28.073 s). If the native process exits first, `closed` arrives on its own and the ladder finds the group already gone — both orders are correct and race-free (existing `shutdownDischarged` mechanism).

Zero-message completed runs (terminal event, no retained final message): no emission, ladder and settle — existing semantics preserved.

### TS-4 Settlement gate unchanged

`settle()` keeps its exact current gate — child `closed` **and** `shutdownDischarged` and an empty message pipeline — for every path. The only change is who starts the ladder and when: a decided run starts it at the terminal event instead of never, so the `closed` wait becomes bounded. No new settlement order, no new race: decided runs reach `closed` either voluntarily (≤ the same ms it takes today) or by the ladder (≤ ~1 s). Undecided paths (transport/protocol/spawn/stdin failure, caller abort, sticky failure) keep today's behavior, including `FAILED_EXIT_GRACE_MS`.

### TS-5 Post-decision irreversibility (the mirror of sticky failure)

Once decided, the outcome cannot change — mirroring the existing "a later completion cannot restore success" rule: a later `failed` event, protocol garbage, or oversized frame after the terminal frame is post-terminal noise; it is ignored for the outcome (a diagnostic record, not a cause). `recordFailure` and the sticky-failure path gain a `decided` guard alongside their existing `finished`/`shutdownStarted` guards. Frames buffered after the terminal event are dropped, not parsed.

### TS-6 Operator signals keep precedence

A caller abort arriving after decision but before settlement still yields `cancelled` and the 130/143 exit discipline — operator intent outranks an unflushed verdict. If the payload already flushed, stdout carries the answer and the exit code carries the stop; both are honest. Unchanged from today.

### TS-7 Receipt honesty: `settledBy`

`WorkerResult` gains one optional discriminator:

```ts
settledBy?: "exit" | "terminal-event";
```

`"terminal-event"` on every decided run (§ TS-1–3), `"exit"` otherwise. Without it, `ownedShutdown: true` becomes ambiguous — it previously meant "failure cleanup killed the group" and after this spec also covers "completed run torn down after its terminal event", which is precisely the distinction the old campaign's evidence could not make. The receipt projection whitelists in the custom-round/live harnesses (`workerFailure`) add the field pass-through; no other receipt or evidence shape changes.

### TS-8 Observation fields stay observations

`code` and `signal` are recorded as observed at settlement. A decided run settles either with `childCode === 0` (native exited voluntarily before the ladder landed) or with a `SIGTERM` death signal from our own ladder (`exitStatus` → 143, `result.signal: "SIGTERM"`, `ownedShutdown: true`, `settledBy: "terminal-event"`). `usage` was already captured from the `completed` event before decision; `usageScope: "unverified"` unchanged. `cli.ts` `workerExit` already maps `status === "completed"` to exit 0 without reading `code` — no CLI change.

### Safety argument

- **No new signal targets**: the ladder already signals only the owned process group; this spec only changes *when* a clean run triggers it.
- **Evidence integrity**: the verdict text is retained parent-side from decode, so teardown signals cannot lose it (TS-2); route journal, receipts, and the evidence ledger are parent-written and untouched by the child's death; the native process's own session artifacts may be truncated by the kill and are never consumed as evidence (the diagnostic's sqlite lookup found zero rows for its run).
- **Fail-closed preserved**: every failure path (spawn/stdin/protocol/output/abort/sticky) still ladders and settles with its first-cause attribution; TS-5 only stops *post-terminal* noise from rewriting a delivered verdict.
- **No resource leak**: settlement still requires group-gone (ladder discharge); the CLI never exits leaving an owned live native process — the harness's `cleanup-unverified` stop remains reachable exactly as today.

### Performance statement

On the diagnostic's own timeline: case wall clock 52.3 s → ≈ 25.2 s (terminal event 24.185 s + ≤ 1.03 s ladder) — −52 %; a 12-case roster saves ≈ 5.6 min of pure exit-waiting; and the delivered-work-timed-out verdict class disappears for every consumer, harness and human alike.

## 4. Verification

Offline only; zero paid calls. New `test/worker.test.ts` cases (fake-codex fixtures, one new knob to linger after emitting the terminal event, e.g. `codex.lingerAfterCompletedMs`):

1. Completed + linger (the diagnostic's shape): run resolves `completed`, `settledBy: "terminal-event"`, `ownedShutdown: true`, payload byte-exact, parent wait bounded (linger knob 10 s, resolve well under it), ladder TERM observed.
2. Completed, native exits promptly: `settledBy` still `"terminal-event"` (decision happened before close), payload intact — both orders race-free.
3. Payload backpressure: sink blocks at emission, write accepted → settlement holds until flush; outcome and bytes unchanged (existing discipline, re-pinned under the new timing).
4. Post-terminal garbage frame (bad UTF-8 / oversized) after `completed`: ignored for the outcome, run still `completed` (TS-5).
5. `failed` before any `completed`: unchanged attribution, ladder, `FAILED_EXIT_GRACE_MS` discipline.
6. Caller abort after decision, before settle: `cancelled`, signal-ladder exit semantics unchanged (TS-6).
7. Zero-message completed run: `completed`, no stdout emission, ladder + settle (TS-3).
8. Receipt/e2e: one CLI-level test asserting exit 0, receipt `settledBy`, stdout payload, when the fake worker lingers post-terminal.
9. Re-pin: existing tests asserting `childCode === 0` eligibility or voluntary-exit settlement are rewritten to the new predicate (the authorized break), not deleted.

## 5. Non-goals

No investigation of the native runtime's internal shutdown dependency (the 28 s linger's mechanism stays unproven and — after this spec — irrelevant to correctness; a future native-side probe needs its own authorization). No change to `CASE_TIMEOUT_MS`, stop semantics, continuation, retry, routing, classifier, transports, or configuration. No new production telemetry beyond `settledBy`. No dual-mode/back-compat switch. The prior campaign stays CLOSED/PARTIAL and sealed.

## 6. Review record

Placeholder — filled after the `gpt-6-astra` re-check (§ status banner).
