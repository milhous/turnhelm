# Terminal-Event Settlement Spec

Date: 2026-10-16. Code baseline: `595f77f75f89bb524e4c2dee10716af7ad1d3090` (main, clean). Input: the sealed single-readonly-worker diagnostic (`/Users/zhangxiao/.local/state/turnhelm/worker-single-diagnostic-20261015-ElCd4n/REPORT.md`, campaign seal `44f29c2dc563…`, verdict `PASS-SINGLE-READONLY-DIAGNOSTIC`, original 240 s timeout **not reproduced**, root cause **UNRESOLVED**). Revised after the 2026-10-16 astra review (§6: 4×P1, 3×P2, all adjudicated).

> Status: drafted under the user's authorization to write this spec, re-check it through one codex worker (`gpt-6-astra` — the single paid call this work makes, §6), update it from that review, and write an execution plan. That authorization does not extend to code implementation or publication. Constraints fixed by the user: optimize for long-term benefit, safety, and performance only; backward compatibility is explicitly not maintained.

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

Files changed: `src/codex.ts` (settlement semantics only), `test/worker.test.ts` plus the fake-codex fixture knobs it needs (`test/fixtures.ts` / `test/executable-fixture.ts` — exact sites pinned by the plan), the worker-semantics paragraph of `README.md`, and the worker paragraph of `.agents/skills/turnhelm-routing/SKILL.md` if it states exit-based settlement. `test/live-acceptance.ts`, `test/custom-round.ts`, `src/cli.ts`, `src/codex-events.ts`, routing, classifier, config: **no functional change** — in particular no receipt field, receipt whitelist, or harness projection changes (TS-7).

Inherited unchanged: the frozen `CASE_TIMEOUT_MS = 240_000` and its pin test; one-receipt == 1 discipline; never resumed/replayed; `STOP_FAILURE_CLASSES`; reservation-before-spend; signal ladder 130/143; the owned-group-only signaling rule (`signalGroup` targets only `-child.pid`); sandbox contract check; prepare mode; spawn interception; env stripping (`subprocessEnvironment`/`workerEnvironment`); backpressure discipline (accepted write ≠ flushed write; pendingWrites/drain waits); PE-1 payload classification before emission; sticky-failure irreversibility and `FAILED_EXIT_GRACE_MS`.

## 3. Design — terminal-event settlement (TS)

All changes are inside `executeWorker` unless noted. Numbered requirements are normative.

### TS-1 Decision at the terminal event, with two triggers

The completed-run predicate loses its exit-code dependency:

```ts
const completedEligible = (): boolean =>
  failure === undefined && !cancelled && inputDelivered && completionSeen && !stickyFailed;
```

`childCode === 0` is removed: the process exit code is an observation, never a completion signal. The native process's exit status after a decoded terminal event is an artifact of its own shutdown (or of our ladder), not of the work product.

**Decision** (`decided := true`, once) fires at whichever of two triggers first finds the predicate satisfied, because the two acknowledgements are independent async events and either can land first:

1. a `completed` worker event is decoded, or
2. the stdin end-callback sets `inputDelivered` (a terminal frame can be decoded before the stdin flush callback runs; without the second trigger such a run would never decide and the unbounded exit-wait would return).

A decided run is irreversible (TS-5). Both triggers are idempotent under the `decided` guard.

### TS-2 Emission at decision, before any signal

At decision, the existing settlement-time emission runs immediately and unchanged in content: classify the retained final message (PE-1), project the payload, `emitMessage` — once-only via `finalEmitted`, with the existing pendingWrites/drain-wait flush discipline. The verdict text has lived parent-side since the `message` frame was decoded; no child signal can lose it.

Ordering is normative: **the payload write is accepted by the sink before any signal is sent to the owned group** (TS-3). This keeps today's failure attribution exactly: a synchronous write throw or an async sink error on a not-yet-shutdown run still records `output` as the first transport cause and fails the run — the ladder has not started, so `recordFailure` is live. `settle()`'s existing emission branch stays as the catch-all for a run that reaches settlement `completedEligible` without ever having decided (unreachable in practice once TS-1 has both triggers; kept because it is already idempotent via `finalEmitted`).

### TS-3 Bounded forced teardown after the accepted write

Once the payload write is accepted (or there is no message to emit — zero-message completed runs go straight to the ladder), the run invokes the existing owned shutdown ladder (`beginShutdown`: SIGTERM the owned group, poll `signalGroup(0)` every `GROUP_POLL_MS = 25 ms`, SIGKILL at `TERM_GRACE_MS = 1000 ms`, then discharge) — the same ladder every failure path already uses. In the ordinary case the parent's post-terminal wait collapses from the observed 28.073 s to at most `TERM_GRACE_MS + GROUP_POLL_MS ≈ 1.0 s` plus the close event's tick.

Boundedness claims, stated exactly (no new supervision mechanism is added): TERM goes to the owned group within milliseconds of the accepted write; SIGKILL follows at the grace if the group survives; discharge does **not** confirm KILL delivery, and `closed` remains a separate gate — a pathological unkillable descendant holding the pipes retains precisely the unbounded-close exposure every ladder path already has today (bounded in the harness, not here, by its post-Term settlement grace). If the native process exits first, `closed` arrives on its own and the ladder finds the group already gone — both orders are correct and race-free (existing `shutdownDischarged` mechanism).

### TS-4 Settlement gate unchanged

`settle()` keeps its exact current gate — child `closed` **and** `shutdownDischarged` and an empty message pipeline — for every path. The only change is who starts the ladder and when: a decided run starts it at the terminal event instead of never, so the `closed` wait becomes bounded. No new settlement order, no new race: decided runs reach `closed` either voluntarily (≤ the same ms it takes today) or by the ladder (≤ ~1 s). Undecided paths (transport/protocol/spawn/stdin failure, caller abort, sticky failure) keep today's behavior, including `FAILED_EXIT_GRACE_MS`.

### TS-5 Post-decision irreversibility, scoped to native noise — sink failures keep attribution

Once decided, the outcome cannot change — mirroring the existing "a later completion cannot restore success" rule. The `decided` guard applies to **native post-terminal noise only**: a `failed` event or protocol-garbage frame after the terminal frame is ignored for the outcome (structurally, frames buffered after the terminal event are dropped, not parsed — the decode loop stops at `shutdownStarted`). `recordFailure` and the sticky-failure path gain the `decided` guard alongside their existing `finished`/`shutdownStarted` guards for native causes.

**Parent sink failures are exempt** (review P1): the `"output"` cause keeps first-cause rights until settlement — an accepted payload write holds settlement open, so its synchronous throw or asynchronous ack error is a pre-settlement transport fact, not post-terminal noise, and must still fail the run (`status: "failed"`, `error: "output"`, exit 1) exactly as today. Concretely: the output-cause failure setters assign `failure` directly when unset and the run is unfinished, bypassing the shutdown/decided no-op that would otherwise silently upgrade a broken-sink run to `completed`/exit 0.

### TS-6 Operator signals keep precedence

A caller abort arriving after decision but before settlement still yields `cancelled` and the 130/143 exit discipline — operator intent outranks an unflushed verdict. If the payload already flushed, stdout carries the answer and the exit code carries the stop; both are honest. Unchanged from today.

### TS-7 No new receipt field

`WorkerResult` and the CLI receipt gain **no** new field (review P1). The receipt is an explicit projection in `src/cli.ts`; a new `WorkerResult` member would either be silently absent from receipts or force a functional `src/cli.ts`/harness-whitelist change this spec forbids. The discrimination the evidence actually needs already exists after this spec: `status: "completed"` with `ownedShutdown: true` can only mean terminal-event settlement (before it, a completed run never ran the ladder), and `code`/`signal` record how the group actually ended.

### TS-8 Observation fields stay observations

`code` and `signal` record whatever is observed at settlement, with **no** closed enumeration (review P2): a decided run may settle with `childCode === 0` (voluntary exit before the ladder landed), a `SIGTERM` death signal from the ladder (`exitStatus` → 143), a `SIGKILL` escalation (`→ 137`) when a TERM-ignoring group needed the second rung — or any nonzero voluntary exit code, which no longer affects the completed status. `usage` was already captured from the `completed` event before decision and is frozen there (a repeated `completed` frame after decision is dropped with the rest of the post-terminal buffer); `usageScope: "unverified"` unchanged. `cli.ts` `workerExit` already maps `status === "completed"` to exit 0 without reading `code` — no CLI change.

### Safety argument

- **No new signal targets**: the ladder already signals only the owned process group; this spec only changes *when* a clean run triggers it.
- **Evidence integrity**: the verdict text is retained parent-side from decode and its write is accepted before any signal (TS-2), so teardown cannot lose it; a sink that fails before settlement still owns the failure (TS-5 exemption); route journal, receipts, and the evidence ledger are parent-written and untouched by the child's death; the native process's own session artifacts may be truncated by the kill and are never consumed as evidence (the diagnostic's sqlite lookup found zero rows for its run).
- **Fail-closed preserved**: every failure path (spawn/stdin/protocol/output/abort/sticky) still ladders and settles with its first-cause attribution; TS-5 only stops *post-terminal* noise from rewriting a delivered verdict.
- **No resource leak**: settlement still requires group-gone (ladder discharge); the CLI never exits leaving an owned live native process — the harness's `cleanup-unverified` stop remains reachable exactly as today.

### Performance statement

On the diagnostic's own timeline: case wall clock 52.3 s → ≈ 25.2 s (terminal event 24.185 s + ≤ 1.03 s ladder) — −52 %; a 12-case roster saves ≈ 5.6 min of pure exit-waiting; and the delivered-work-timed-out verdict class disappears for every consumer, harness and human alike.

## 4. Verification

Offline only; zero paid calls. New `test/worker.test.ts` cases (fake-codex fixtures, one new knob to linger after emitting the terminal event, e.g. `codex.lingerAfterCompletedMs`, plus a TERM-ignoring variant of the existing fixture):

1. Completed + linger (the diagnostic's shape): run resolves `completed`, `ownedShutdown: true`, payload byte-exact, parent wait bounded (linger knob 10 s, resolve well under it), ladder TERM observed.
2. Completed, native exits promptly (voluntary exit 0 racing the ladder): still `completed`, payload intact, both orders race-free.
3. Completed with TERM-ignoring group: SIGKILL escalation, still `completed`, `signal: "SIGKILL"` recorded (TS-8).
4. Terminal frame decoded **before** the stdin ack: decision fires from the stdin-ack trigger, ladder still starts, run `completed` (TS-1 trigger 2 — the case the review's P1 added).
5. Payload backpressure: sink blocks at emission, write accepted → no signal until acceptance, settlement holds until flush; outcome and bytes unchanged.
6. Message sink fails synchronously at emission (post-decision, pre-ladder): `failed`/`output`, exit discipline unchanged — attribution survives the new ordering (TS-2, TS-5).
7. Message sink ack errors asynchronously after the ladder started: still `failed`/`output`, never `completed`/exit 0 (TS-5's output-cause exemption — the review's P1 regression case).
8. Post-terminal garbage frame (bad UTF-8 / oversized / a second `message` or `failed` frame) after decision: dropped, run still `completed`, `finalMessage` and `usage` frozen at the terminal frame (TS-5, TS-8).
9. `failed` before any `completed`: unchanged attribution, ladder, `FAILED_EXIT_GRACE_MS` discipline.
10. Caller abort after decision, before settle: `cancelled`, signal-ladder exit semantics unchanged (TS-6).
11. Zero-message completed run: `completed`, no stdout emission, ladder + settle.
12. Receipt/e2e: one CLI-level test asserting exit 0, receipt shape unchanged (no new fields), stdout payload, when the fake worker lingers post-terminal.
13. Re-pin: existing tests asserting `childCode === 0` eligibility, voluntary-exit settlement, or last-decoded-message/usage replacement are rewritten to the new predicate and the frozen-at-terminal semantics (the authorized break), not deleted.

## 5. Non-goals

No investigation of the native runtime's internal shutdown dependency (the 28 s linger's mechanism stays unproven and — after this spec — irrelevant to correctness; a future native-side probe needs its own authorization). No change to `CASE_TIMEOUT_MS`, stop semantics, continuation, retry, routing, classifier, transports, or configuration. No new production telemetry beyond `settledBy`. No dual-mode/back-compat switch. The prior campaign stays CLOSED/PARTIAL and sealed.

## 6. Review record — 2026-10-16 astra re-check

Routed through Turnhelm (Laya/direct selected `gpt-6-astra` / `high`, profile `frontier_xhigh`, routing 728 ms; worker completed in 268.4 s; root `/Users/zhangxiao/.local/state/turnhelm/astra-review-20261016`). Verdict **PROBLEMS** → adjudicated against source, all accepted; the spec above is the revised text. Incidental corroboration: the review run's own receipt recorded `lastEventAgeMs: 26132` — the reviewer worker itself lingered 26.1 s between its terminal event and settlement, a live instance of the phenomenon this spec removes.

| # | Pri | Finding (condensed) | Disposition |
| --- | --- | --- | --- |
| 1 | P1 | TS-5 as drafted suppressed parent sink failures post-decision — a broken payload sink could report `completed`/exit 0 | Accepted — TS-5 rewritten: `decided` guard scopes native noise only; `"output"` keeps first-cause rights until settlement; test 7 pins it |
| 2 | P1 | Synchronous payload-write exception after ladder start could leave the run permanently unsettled | Accepted — TS-2 ordering restored: emission at decision, write accepted **before** any signal, so `recordFailure` is live on that path; test 6 pins it |
| 3 | P1 | Terminal frame decoded before the stdin ack had no later decision trigger — linger would return | Accepted — TS-1 gains the stdin-ack trigger (idempotent); test 4 pins it |
| 4 | P1 | `settledBy` conflicts with the no-CLI/no-harness-change scope and is unnecessary (`completed` + `ownedShutdown` already discriminate) | Accepted — TS-7 replaced by "no new receipt field"; §2 scope and tests 1/2/12 updated |
| 5 | P2 | Ladder boundedness overstated: discharge does not confirm KILL delivery; `closed` is a separate gate | Accepted — TS-3 claims narrowed exactly; no new mechanism |
| 6 | P2 | Completed runs are not limited to exit 0/SIGTERM (TERM-resistant groups, nonzero voluntary exits) | Accepted — TS-8 restated as open observation; test 3 pins escalation |
| 7 | P2 | Verification missed the intentional semantics change: post-terminal `message`/usage frames frozen at terminal instead of last-decoded-wins | Accepted — TS-8 freezing stated; tests 8 and 13 pin it |
