# Worker Stdout Machine-Output Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the all-messages stdout stream with a single final agent message, written once through the existing write accounting only when the run reaches completed-eligibility (spec §3).

**Architecture:** `executeWorker` in `src/codex.ts` retains the last decoded `message` event in a local instead of forwarding it; `settle()` gains a once-only emission phase before `finish()`; `finish()` computes status through the same shared eligibility predicate. Every other gate (pending-write accounting, drain waits, cancellation bypass, cleanup ladders, listener lifetime) is reused unchanged. Tests that pinned mid-stream forwarding are migrated per the mapping in Task 1; no runner or oracle code changes.

**Tech Stack:** TypeScript (Node ≥24, ESM), `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-worker-stdout-contract-design.md` (baseline `894b7da`, reviewed by codex gpt-6-astra — §6 records the seven accepted findings this plan implements).

## Global Constraints

- No changes under `src/codex-events.ts`, `src/cli.ts`, `src/route.ts`, `src/systemone.ts`, `src/journal.ts`, `test/live-acceptance.ts`, `test/custom-round.ts` (the runner; its test file may change), `test/codex.test.ts`; receipt/journal/stderr line shapes byte-identical (spec §2, SC-07).
- No new caps, timers, channels, or config keys; `MAX_EVENT_BYTES` (1 MiB) unchanged (spec §2, §3).
- Cancellation semantics 130/143 unchanged; no write before child close and discharged obligations (spec §3.4, SC-05).
- Failed/cancelled runs initiate no emission; mid-delivery cancellation is honestly non-transactional (spec §3.3, SC-04) — do not add rollback machinery.
- No backward compatibility: old stream pins are replaced or retired with reasons (SC-10), never shimmmed.
- Conventional Commits; docs and comments in English; coverage ≥ 80 line/branch/function via `pnpm run test:coverage` (SC-08).
- Never claim the 2026-10-12/2026-10-13 failures are re-graded or resolved (SC-09).

## Review Focus

1. **Consumer disconnect now surfaces at settlement, not mid-run** — a closed stdout sink makes the final write fail the run as `output`. Pinned by the re-based EPIPE test (Task 1, step 8c) and the CLI EPIPE test (Task 2).
2. **Cancellation between eligibility and write completion** leaves delivered bytes with a `cancelled` receipt — consumers gate on exit code + receipt, not stdout. Pinned by the re-based stalled-drain cancellation test (Task 1, step 8b).
3. **A post-completion agent message becomes the final output** — the decoder enforces no ordering; oracles see arbitrary content. Pinned by the new ordering tests (Task 1, step 4).
4. **Multi-line answers must ride one message** — a worker narrating each output line as a separate message now delivers only the last line. Pinned by the custom-round fixture join (Task 3).
5. **Zero-message completed runs have empty stdout** — downstream strict-JSON consumers see empty and fail their own grading, never a crash. Pinned by SC-02 tests (Task 1, step 3) and preserved empty-stdout CLI pins (Task 2).

---

### Task 1: Settlement-only emission in `src/codex.ts` + `test/worker.test.ts` migration

**Files:**
- Modify: `src/codex.ts` (dispatch message case ~436-440, `settle` ~207-211, `finish` ~164-201)
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkerResult` unchanged (no new fields). Internal only: `finalMessage: string | undefined`, `finalEmitted: boolean`, `completedEligible(): boolean`.

- [ ] **Step 1: Write the failing tests for the new contract**

Add to `test/worker.test.ts` (after the "one worker run binds decision..." test, ~line 621), using the existing `runWorker` harness:

```ts
test("stdout carries exactly the final agent message of a completed run", { timeout: 30_000 }, async t => {
  const { recorded, stdout, stderr } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "progress narration" } });
  emit({ type: "item.completed", item: { type: "agent_message", text: "worker result" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1 } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "worker result\n");
  forbid(stdout + stderr + JSON.stringify(recorded), "progress narration");
});

test("a completed run with zero agent messages writes nothing to stdout", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, { script: "finish(() => emit({ type: 'turn.completed' }));" });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "");
});

test("an empty-string final message writes exactly one newline", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "" } });
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "\n");
});
```

- [ ] **Step 2: Write the failing ordering tests (spec §3.1, SC-06)**

```ts
test("a message decoded after completion becomes the final message", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "before" } });
  emit({ type: "turn.completed" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "after" } });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "after\n");
});

test("a failed frame after a completion fails the run with no emission", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "answer" } });
  emit({ type: "turn.completed" });
  emit({ type: "turn.failed", message: "upstream usage limit reached" });
});
`
  });
  assert.equal(recorded.status, "failed");
  assert.equal(recorded.error, "worker");
  assert.equal(stdout, "");
});

test("a maximal agent-message frame passes through unclipped", { timeout: 30_000 }, async t => {
  const { recorded, stdout } = await runWorker(t, {
    script: `
finish(() => {
  const text = "z".repeat(1048576 - 64); // frame stays just under MAX_EVENT_BYTES
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n");
  emit({ type: "turn.completed" });
});
`
  });
  assert.equal(recorded.status, "completed");
  assert.equal(stdout, "z".repeat(1048576 - 64) + "\\n");
});
```

Also extend the two existing eventless-failure tests with `const { stdout } =` destructuring and `assert.equal(stdout, "")`: "exit zero without a completion is a worker failure" (~line 623) and "nonzero exit is a worker failure even with a completion" (~line 1283).

- [ ] **Step 3: Run to verify RED**

Run: `pnpm run build && node --test dist/test/worker.test.js`
Expected: the new tests FAIL (`stdout` sees `progress narration`/`before`+`after`/the failed-run message; the zero-message case may pass already — that is fine, it pins the contract).

- [ ] **Step 4: Implement the contract in `src/codex.ts`**

Add locals next to `stickyFailed` (~line 110): `let finalMessage: string | undefined;` and `let finalEmitted = false;`. Add the shared predicate and route `finish()`'s completed branch through it:

```ts
const completedEligible = (): boolean =>
  failure === undefined && !cancelled && inputDelivered && childCode === 0 && completionSeen && !stickyFailed;
```

In `finish()`, replace the final `else if (childCode !== 0 || !completionSeen || stickyFailed)` chain with `else if (!completedEligible()) { status = "failed"; error = "worker"; } else { status = "completed"; error = undefined; }` (the preceding branches already returned failure/cancelled/stdin cases).

In `settle()`, after the two existing early-return gates and before `finish()`:

```ts
if (!finalEmitted && finalMessage !== undefined && completedEligible()) {
  finalEmitted = true; // Set before the sink call: ack re-entry must never re-emit.
  emitMessage(finalMessage);
  return; // The accepted write must flush (or fail) before the run finishes.
}
finish();
```

In `dispatch()`, replace `case "message": emitMessage(event.text); return;` with `case "message": finalMessage = event.text; return;`.

Keep everything else — `emitMessage`, `ackWrite`, `waitForDrain`, cancellation bypass, ladders, listener rules — untouched. Keep the dispatch "failed" case's `if (closed) { settleObligation(); return; }` branch: mid-decode sink backpressure no longer exists so it is unreachable today, but it is the discharge safety net for any future decode deferral; do not remove it.

- [ ] **Step 5: Run the new tests to verify GREEN**

Run: `pnpm run build && node --test dist/test/worker.test.js`
Expected: the Step 1/2 tests PASS; several older tests now FAIL — proceed to Step 6.

- [ ] **Step 6: Migrate the affected existing tests per this mapping (SC-10)**

Preserve (must still pass unchanged): the binding test (~574), turn.failed family (~630, ~653), counters (~833), malformed frame (~884), stderr-drain (~1190, asserts `drained\n`), UTF-8 split (~1207), frame caps (~1228, ~1242, ~1254, ~1268), settles-at-close (~1297), stdin delivery (~1312), TERM-ignoring (~1418), spawn failures (~1542, ~1549), shutdown flood drain (~1609), watchdogs (~1632–1680), pending gates (~1708, ~1718).

Replace (re-base stimulus so the final write is what the sink sees):

| Test (line) | Re-base |
| --- | --- |
| settlement gap (~849) | Drop the `ackMessageDecode` sync (a mid-stream write no longer exists). New shape: `output: "blocker", drainDelayMs: 300`, script emits one message + completion then `process.exit(0)`; assert `completed`, `lastEventAgeMs > 0` (the drain gap now lands between last decode and finish), `progressEvents === 2`. Remove the `ackMessageDecode` scenario field and its harness block (~246-255). |
| cancelled mid-stream (~909) | Use `gate: "abort-ready"`; script emits message + completion + `ready()` then `setInterval`. Assert `cancelled`, `progressEvents >= 1`, `lastEventAgeMs` is a number, and `stdout === ""` (no write was initiated). |
| backpressure 20 messages (~1329) | Script: 20 messages + completion + `process.exit(0)`, `output: "blocker"`. Assert `completed`, `received === 1`, `maxPending === 1`, `recorded.emitted === "message-19\n"`; keep the stderr sentinel `forbid`. Rename to the final-write backpressure fact. |
| cancellation interrupts stalled drain (~1349) | `output: "accepted-stall"`, `gate: "abort-received"`, script emits message + completion + `process.exit(0)`. Assert `cancelled`, `received === 1`, `maxPending === 1` — this is the SC-04 mid-delivery corner. |
| EPIPE interrupts drain (~1366) | `output: "blocker"`, `gate: "epipe-received"`, script emits message + completion + `process.exit(0)`. Assertions unchanged (`failed`, `output`). |
| abort-in-write (~1381) | Script emits message + completion + `process.exit(0)` (drop the `setInterval` hold). Assertions unchanged plus `received === 1`. |
| abort-late-error (~1400) | Same re-base as ~1381. Assertions unchanged. |
| destroyed sinks (~1452) | Drop the trailing `setTimeout(() => {}, 10000)` so the child exits 0 after frames; the tail sink's first (and only) write is now the final message. Assertions unchanged (`failed`, `output`, `tailWrites === 1`, bounded). |
| late known sink close, output target (~1508) | Same re-base: child exits 0 after frames. Diag-target variant unchanged. |
| late-cancellation loop (~1591) | Message-target variant: retire (a pending message write during a protocol failure is unreachable — no emission on failure paths). Keep the diag-target variant; change the loop to `for (const target of ["diag"] as const)` and drop the message branch. |
| outer exec overflow (~1683) | Stimulus: one agent message of `'x'.repeat(700 * 1024)` + completion + `process.exit(0)`, and pass a smaller `maxBuffer` (e.g. 64 KiB) through to the harness's `execute` call for this scenario (add an `outerMaxBufferBytes` scenario field; default unchanged). Assert the same `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and group reaping — a completed run's single final message exceeding the consumer's capture cap. |

Retire (stimulus structurally gone): "a failed turn buffered past child close" (~677) — mid-decode message backpressure no longer exists, so a frame decoded after child close is unreachable; close-handler obligation discharge stays pinned by ~630/~653. Delete the test with this comment in the commit message.

- [ ] **Step 7: Run the whole worker file to verify GREEN**

Run: `pnpm run build && node --test dist/test/worker.test.js`
Expected: PASS (all tests, migrated and preserved).

- [ ] **Step 8: Commit**

```bash
git add src/codex.ts test/worker.test.ts
git commit -m "feat(worker): emit only the final agent message on stdout at completed settlement

stdout now carries at most one message, written once through the existing
pending-write accounting only when settle() finds completed-eligibility;
earlier messages are decoded, counted, and discarded. Mid-stream message
writes no longer exist: re-based sink-backpressure, cancellation, EPIPE,
and overflow tests onto the final write; retired the post-close-decode
fixture (unreachable without mid-decode backpressure).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: `test/cli.test.ts` migration

**Files:**
- Modify: `test/cli.test.ts` (~555-559, ~593-607)

**Interfaces:**
- Consumes: Task 1's contract.
- Produces: none.

- [ ] **Step 1: Update the failed-run partial-message pin**

In "a worker terminal failure fails the run despite exit zero" (~555), change `assert.equal(result.stdout, AGENT_MESSAGE + "\n")` to `assert.equal(result.stdout, "")` — the eventless failure (no completion) must initiate no write (SC-03).

- [ ] **Step 2: Update the EPIPE test's premise comment**

In "parent stdout EPIPE cancels the worker and exits 1" (~593), the comment says the CLI writes stdout "only when relaying agent messages" — reword to "only at settlement, so the destroyed parent pipe makes the final write fail" and verify the test still passes (same exit 1, same failed receipt; the EPIPE now lands at settlement instead of mid-run). Adjust nothing else.

- [ ] **Step 3: Run to verify GREEN**

Run: `pnpm run build && node --test dist/test/cli.test.js`
Expected: PASS — the completed-run pins (`result.stdout === AGENT_MESSAGE + "\n"` at ~384 and ~462) must pass unchanged; the preclassification `result.stdout === ""` pins (~273, ~285, ~292, ~312) pass unchanged.

- [ ] **Step 4: Commit**

```bash
git add test/cli.test.ts
git commit -m "test(cli): failed worker runs leave stdout empty under the final-message contract

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: `test/custom-round.test.ts` fixture re-encoding

**Files:**
- Modify: `test/custom-round.test.ts` (`fakeCodexBody` ~503; no runner code)

**Interfaces:**
- Consumes: Task 1's contract.
- Produces: none.

- [ ] **Step 1: Join output lines into one final message**

In `fakeCodexBody`'s default finish branch, replace the per-line message loop with a single frame: `process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: lines.join("\\n") } }) + "\\n")` followed by the existing `turn.completed` frame and `process.exit(0)`. Each case's whole envelope payload and footer now ride one final message (SC-10).

- [ ] **Step 2: Run to verify GREEN**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: PASS — envelope-equal cases still grade on the first payload line; the strict-whole-json footer case (~850) still fails as designed (the whole-stdout JSON now contains the trailer inside the single message — the rejection it pins); `oracleInput` retention assertions still see nonempty input.

- [ ] **Step 3: Commit**

```bash
git add test/custom-round.test.ts
git commit -m "test(custom-round): carry each case's output in one final agent message

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: Documentation surfaces

**Files:**
- Modify: `README.md` (~259-267, "Bounded child output")
- Modify: `.agents/skills/turnhelm-routing/SKILL.md` (~99, "Interpret results")

**Interfaces:**
- Consumes: Task 1's contract.
- Produces: none.

- [ ] **Step 1: Update README**

In the "Bounded child output" bullet, replace "Worker messages go to stdout; this is not a general-purpose redactor for secrets in those messages." with the new contract: stdout carries at most one worker message — the final agent message, written once when the run completes; earlier messages are decoded, counted, and discarded; a failed or cancelled run writes nothing (delivery is not transactional: a cancellation landing mid-write may leave bytes, so gate on the exit code and receipt); the final message is arbitrary content — not guaranteed JSON — and stdout is not a general-purpose redactor.

- [ ] **Step 2: Update SKILL.md**

In "Interpret results", replace "Worker output is on stdout;" with "Worker output on stdout is at most one message — the final agent message of a completed run; earlier progress messages are discarded;" and keep the rest of the paragraph (receipt, worker-failed line) unchanged. Verify `.claude/skills/turnhelm-routing` still points at `.agents` (symlink, untouched).

- [ ] **Step 3: Run the doc-adjacent tests and verify no stale claims**

Run: `grep -rn "all-messages\|every agent message\|messages are forwarded" README.md .agents/skills/turnhelm-routing/SKILL.md`
Expected: no matches. Also `pnpm run build && node --test dist/test/init.test.js` (skill-file installation checks) — PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md .agents/skills/turnhelm-routing/SKILL.md
git commit -m "docs: state the final-message-only worker stdout contract

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: Full suite, coverage, and boundary verification

**Files:**
- Verify only (no modifications expected; fix and re-run if anything fails)

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: the green-suite evidence for SC-07/SC-08.

- [ ] **Step 1: Full offline suite with coverage**

Run: `pnpm run test:coverage`
Expected: every test file PASS; line/branch/function coverage ≥ 80 under `dist/src/**`.

- [ ] **Step 2: Verify the change boundary (SC-07)**

Run: `git diff --stat 894b7da..HEAD`
Expected: exactly `src/codex.ts`, `test/worker.test.ts`, `test/cli.test.ts`, `test/custom-round.test.ts`, `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (plus the spec/plan docs committed separately). Nothing under `src/codex-events.ts`, `src/cli.ts`, `src/route.ts`, `src/systemone.ts`, `test/live-acceptance.ts`, `test/custom-round.ts`, `test/codex.test.ts`.

- [ ] **Step 3: Commit any residue**

If Steps 1-2 required fixes, commit them as `fix(worker): ...` with the same attribution line. Otherwise no commit.

---

## Execution note

The user merges branches to main themselves; implementation stops at a green suite on `fix/worker-stdout-contract` — no push, no PR, no live (`pnpm run test:live`) runs (those need separate spend authorization).
