# Custom-Round Failure Evidence and Timeout Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every custom-round worker failure and timeout carry bounded frozen receipt evidence (`workerFailure` projection), grade timeouts as unjudged per-case outcomes that continue the roster under a fixed decision order, and append a strict `completed` record reconciling written evidence — so the 2026-10-13 cascade (11 approved observations discarded, 2 indeterminable 143s) cannot recur.

**Architecture:** Harness-only change in `test/custom-round.ts` (receipt projector + decision ladder + timeout outcome + completed protocol) with hermetic tests in `test/custom-round.test.ts` driving `executeRound` through the existing fake-codex/scratch-roster fixtures; documentation sync in README and the shared skill source. The production CLI/router (`src/`) is untouched.

**Tech Stack:** TypeScript (strict, ESM), `node:test` via `pnpm test` (build + `node --test dist/test/*.test.js`), Node ≥ 24.

**Spec:** `docs/superpowers/specs/2026-10-14-failure-evidence-continuation-design.md` (post-astra revision; its §8 records all ten accepted review findings — the per-field projection rule, the `cliClosed` gate, the fixed decision order, and the settled-tree identity re-check are review-mandated, not optional polish).

## Global Constraints

- Zero diff under `src/`; roster/manifest schemas stay v1 (evidence records gain fields only); no new dependencies; changed files are exactly `test/custom-round.ts`, `test/custom-round.test.ts`, `README.md` (custom-round section ~439–470), `.agents/skills/turnhelm-routing/SKILL.md` (custom-round paragraph ~193), and `test/live.integration.ts` only if its compile surface moves.
- `CASE_TIMEOUT_MS` stays `240_000`; the new `caseTimeoutMs` execute option defaults to it and exists only so tests can exercise the timeout path quickly — it is a harness knob, not a manifest field.
- Invariants unchanged: one O_EXCL claim, never replayed or resumed, reservation-before-spend (a failed `reserved` append returns 1), baseline/root-identity/case-files pre-launch gates, receipt-count == 1, `STOP_FAILURE_CLASSES` = {auth, rate-limit, usage-limit} stop all spend, signal ladder 130/143, prepare mode and its exit-1 refusals.
- Decision order in `executeRound` after the CLI observation, exactly: abort → `!cliClosed` → `outputOverflow` → receipt-count ≠ 1 → stopping failure class → `timedOut` → grade. Earlier steps shadow later ones (`outputOverflow` implies `timedOut` is also set by `halt("timeout")`, `test/live-acceptance.ts:1245–1247` — overflow must be checked first).
- `workerFailure` is a per-field projection: unselected receipt keys (today `payload`) are ignored; each retained field is type-checked and dropped individually; the field is omitted entirely only when the receipt `worker` object is absent/not a record or `status` ∉ {not-started, completed, failed, cancelled}; nothing is fabricated (`not-started` receipts have no `code`/`ownedShutdown`); `usage` follows VH-3 (partial kept, never zero-filled, malformed dropped, absent/`"unreported"`-literal/zero-valid → `"unreported"`). No error text or stderr bytes reach the projection — `errorSha256` only.
- The settled-tree verification for every case (graded and timeout) re-checks the root's canonical path + dev/ino identity before trusting the content hash; mismatch → `stopped {reason:"root-identity"}`, exit 1.
- Case-record and `completed` appends are terminal on failure (best-effort `stopped {reason:"evidence-io"}` append, return 1); the old fail-open `.catch(() => {})` on the case append is retired. `completed` counts reconcile successfully written case records, `failed + timedOut ≤ cases`, `outcome:"fail"` iff `failed + timedOut > 0`, `cases` = manifest roster length. Exit 0 only via the full protocol; complete-with-failures/timeouts exits 4; stopped/incomplete exits 1.
- All docs/comments in English. Conventional Commits. No push, no branch creation, no PR without explicit user instruction.
- Gates: `pnpm test` green; `pnpm run test:coverage` green (line/branch/function ≥ 80; its `dist/src/**` include mechanically guards the zero-`src/`-diff promise).

## Review Focus

1. **Overflow masquerading as timeout** — a CLI flooding stdout past 64 KiB sets both `outputOverflow` and `timedOut`; it must stop as `output-cap` (exit 1), never grade as a timeout case. → Task 2 test (b).
2. **Abandoned CLI with `cliClosed:false`** — the supervisor may release pipes without a kill while the CLI lives; no further reservation may happen, with or without `timedOut`. → Task 2 test (c).
3. **Same-content root replacement after the worker ran** — `hashTree` proves content only; a rebuilt identical root must stop as `root-identity` on both the graded and the timeout path. → Task 2 test (d), Task 3 test (d).
4. **Receipt schema drift** — a receipt carrying keys the projection never selected (today `payload`) must still yield its usage/failure evidence. → Task 1 matrix (a).
5. **Ledger death mid-roster** — a case append that fails must stop the round (never a silently under-counted `completed`), and an aborted run must never exit 0/4. → Task 4 tests (c)/(e).

---

### Task 1: per-field `workerFailure` projection on case records (FE-1)

**Files:**
- Modify: `test/custom-round.ts` (new exported projector near `receiptWorkerPayload` ~752; the `case` append ~1053)
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Produces: `export type WorkerReceiptEvidence = Readonly<{ status: "not-started" | "completed" | "failed" | "cancelled"; code?: number; durationMs?: number; progressEvents?: number; ownedShutdown?: boolean; usage?: Partial<Record<"input_tokens" | "output_tokens" | "cached_input_tokens" | "reasoning_output_tokens", number>> | "unreported"; failureClass?: "stream-disconnected" | "rate-limit" | "usage-limit" | "timeout" | "auth" | "overloaded" | "unknown"; errorSha256?: string; signal?: "SIGINT" | "SIGTERM" | "SIGKILL"; lastEventAgeMs?: number }>` and `export function projectWorkerReceipt(worker: unknown): WorkerReceiptEvidence | undefined` (pure; the per-field rules live here, nowhere else).
- Produces: internal `workerFailureOf(stderr: Buffer): WorkerReceiptEvidence | undefined` = `receiptCount(stderr) === 1 ? projectWorkerReceipt(receiptWorkerObject(stderr)) : undefined`, where `receiptWorkerObject` reuses the line-scan of `receiptFailureClass` (~735) to return the single receipt's `worker` value. Task 2's stop records and the case append both go through it.

- [ ] **Step 1: Write the failing tests**

Unit matrix for `projectWorkerReceipt` (direct import): (a) a full worker object including a `payload` key → projection keeps every whitelisted field and ignores `payload`; (b) `not-started` shape `{status, durationMs:0, progressEvents:0, usage:"unreported"}` → `{status:"not-started", usage:"unreported"}` with no fabricated `code`/`ownedShutdown`; (c) per-field drops: non-safe-integer `code`, non-boolean `ownedShutdown`, out-of-taxonomy `failureClass`, non-64-hex `errorSha256`, out-of-set `signal`, negative `usage` counter — each dropped alone, the rest retained; (d) `usage` partial snapshot kept without zero-fill, malformed counters dropped, `"unreported"` literal and absent usage both → `"unreported"`; (e) non-record input or `status:"weird"` → `undefined`. End-to-end through `executeRound`: (f) the existing `failureMessage` fake (`scratchExecuteRound` `codex.failureMessage:"stream disconnected"`) → the `case` record's `workerFailure` has `failureClass:"stream-disconnected"`, a 64-hex `errorSha256`, and the ledger contains neither the message text nor any stderr prose; (g) a passing case → `workerFailure.status:"completed"` with `progressEvents ≥ 1`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: (a)–(g) FAIL — no projection exists.

- [ ] **Step 3: Implement**

Add the type, `projectWorkerReceipt` (per-field checks per Global Constraints), `receiptWorkerObject`, and `workerFailureOf`; attach `...(workerFailure !== undefined ? { workerFailure } : {})` at the `case` append (~1053), extracted once from `observation.stderr` after the receipt-count gate.

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/custom-round.ts test/custom-round.test.ts
git commit -m "test(round): per-field worker-failure receipt projection on case records"
```

### Task 2: fixed decision order, cleanup gate, overflow precedence, settled-tree identity (FE-2 safety half)

**Files:**
- Modify: `test/custom-round.ts` (the post-CLI block ~958–986; the settled-tree gate ~1042–1046; a small `rootIdentityMatches(item.root)` helper shared with the pre-launch check ~908–912)
- Test: `test/custom-round.test.ts` (retarget any pin that expects the old timeout-first branch)

**Interfaces:**
- Consumes: `workerFailureOf` (Task 1) for the stop-record projection.
- Produces: the ordered ladder — abort → `!observation.cliClosed` (`stopped {reason:"cleanup-unverified"}`, exit 1) → `observation.outputOverflow` (`stopped {reason:"output-cap"}`) → receipt-count (`receipt`) → stop-class (`worker-<class>`) → `timedOut` (Task 3) → grade. Stop records after the CLI ran (`cleanup-unverified`, `output-cap`, `receipt` carries none by definition, `worker-<class>`, later `tree-drift`/`root-identity`) attach `workerFailure` via `workerFailureOf`.
- Produces: `rootIdentityMatches(root: Readonly<{canonical: string; dev: number; ino: number}>): Promise<boolean>` (stat + realpath compare), called at the pre-launch gate (replacing the inline check) and at the settled-tree gate for every case.

- [ ] **Step 1: Write the failing tests**

(a) Pin: abort still settles 130/143 (existing signal tests stay green). (b) A fake CLI flooding >64 KiB stdout then sleeping, with `caseTimeoutMs` small: both `outputOverflow` and `timedOut` are set by the supervisor — the round must stop `{reason:"output-cap"}` exit 1 with no later reservation, never record a timeout case. (c) A fake CLI trapping SIGINT+SIGTERM and outliving the post-TERM grace (pipes abandoned, `cliClosed:false`): `stopped {reason:"cleanup-unverified"}`, exit 1, the next case's worker never invoked; the record carries the projection when a receipt was flushed, omitted otherwise. (d) A fake codex that, mid-run, rebuilds its own case root with byte-identical content (read all files → rm dir → recreate → rewrite) then completes with passing output: the graded path stops `{reason:"root-identity"}` exit 1 (today it passes silently — RED through behavior).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: (b) FAIL (today the timeout branch wins or the stop reason differs), (c) FAIL (no cleanup-unverified reason exists), (d) FAIL (replacement passes today). (a) passes as a preservation pin.

- [ ] **Step 3: Implement**

Reorder the post-CLI block into the fixed ladder; add the `cleanup-unverified` branch; hoist the overflow check above timeout; extract and double-call `rootIdentityMatches` (pre-launch + settled-tree); attach `workerFailure` at the post-CLI stop appends.

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/custom-round.ts test/custom-round.test.ts
git commit -m "test(round): fixed stop decision order with cleanup and identity gates"
```

### Task 3: timeout outcome and roster continuation (FE-2 continuation half)

**Files:**
- Modify: `test/custom-round.ts` (`executeRound` options type ~808 gains `caseTimeoutMs?: number`; the timeout branch replaces the `timedOut` stop ~966–971)
- Test: `test/custom-round.test.ts` (rewrite the pins of the old timeout-stop shape)

**Interfaces:**
- Consumes: the Task 2 ladder position (timeout is checked after receipt-count and stop-class) and `workerFailureOf`.
- Produces: `outcome:"timeout"` case records — fields `taskSha256`, `backend`, `profileId`, supervisor `exitCode` (may be `null`), `durationMs`, `workerFailure`; **no** oracle grading, **no** contract check, **no** `oracleInput` (nothing was judged). The case flows through the shared settled-tree gate (identity + drift) before its record is appended; within-allowance delta or none → append and continue, outside → `tree-drift` exit 1.
- Produces: `ExecuteRoundOptions.caseTimeoutMs` (test knob, default `CASE_TIMEOUT_MS`) passed to `superviseCli`.

- [ ] **Step 1: Write the failing tests**

(a) Two-case roster, case-a `codex.stallMs` 5000 with `caseTimeoutMs` 1000: case-a records `outcome:"timeout"` with `workerFailure.status:"cancelled"` (the CLI's own SIGINT shutdown receipts it), `oracleInput` absent; case-b still runs and grades pass; exit 4 (complete with a timeout case); `workerPayload` absent from case-a. (b) All-pass roster → exit 0 unchanged. (c) Timeout case whose fake codex also writes outside `allowedChanges` (reuse `extraWrite`) → `stopped {reason:"tree-drift"}` exit 1, no case-b reservation. (d) Timeout case whose fake codex rebuilds its root byte-identically → `stopped {reason:"root-identity"}` exit 1. (e) Pin: `CASE_TIMEOUT_MS` export/value still 240_000 and prepare mode never reads `caseTimeoutMs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: (a) FAIL (today: `stopped {reason:"timeout"}` exit 1, case-b unexecuted), (c)/(d) FAIL (stop happens before any timeout-case grading exists), (b)/(e) pass as pins.

- [ ] **Step 3: Implement**

Add the option with default; replace the timeout stop with the outcome branch (shared settled-tree gate, then append `{phase:"case", outcome:"timeout", ...}`); no retry, no budget change.

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/custom-round.ts test/custom-round.test.ts
git commit -m "test(round): grade timeouts as unjudged cases that continue the roster"
```

### Task 4: `completed` record, terminal appends, exit mapping (FE-3)

**Files:**
- Modify: `test/custom-round.ts` (the case append ~1048–1059; the loop tail/return ~1060–1061)
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Consumes: `outcome:"timeout"` (Task 3) and the graded outcomes.
- Produces: `writtenOutcomes: ("pass" | "failed" | "timeout")[]` — pushed only after a successful case append; the terminal append protocol — a failed case append does a best-effort `stopped {reason:"evidence-io"}` append and returns 1; after the loop, an aborted signal returns 130/143 before anything else; then `appendEvidence({phase:"completed", outcome, cases: manifest.cases.length, failed, timedOut})` (failed/timedOut counted from `writtenOutcomes`; `outcome:"fail"` iff `failed + timedOut > 0`); its failure returns 1; otherwise exit 0 iff every written outcome is `pass`, else 4.

- [ ] **Step 1: Write the failing tests**

(a) All-pass two-case roster → last ledger record `{phase:"completed", outcome:"pass", cases:2, failed:0, timedOut:0}`, exit 0. (b) Mixed roster (one `failed` via wrong output, one `timeout` via stall+knob) → `{outcome:"fail", cases:N, failed:1, timedOut:1}`, exit 4, counts reconcile the per-case records exactly. (c) Ledger killed by `chmod 0o000` after case-a's record (poll the ledger file, mirroring the existing reserved-failure test at ~1025) → exit 1, no `completed`, no case-b worker invocation. (d) The old fail-open pin (case append `.catch(() => {})` comment/behavior) is gone — asserting a dead ledger never yields 0/4. (e) Abort mid-contract of the last case (worker-write case with a stalling sandbox contract, existing technique) → 130/143, never 0/4; the post-loop abort check implements the same mapping for the after-last-append window.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: (a)/(b) FAIL (no `completed` exists), (c)/(d) FAIL (fail-open continues today), (e) passes as a pin on today's signal behavior.

- [ ] **Step 3: Implement**

Track `writtenOutcomes`; make the case append terminal (try/catch → best-effort evidence-io stop → return 1); add the post-loop abort check, the `completed` append with reconciled counts, and the 0/4 exit mapping.

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/custom-round.ts test/custom-round.test.ts
git commit -m "test(round): completed record reconciling written evidence with terminal appends"
```

### Task 5: documentation sync and full gates

**Files:**
- Modify: `README.md` (custom-round section ~439–470), `.agents/skills/turnhelm-routing/SKILL.md` (custom-round paragraph ~193)

**Interfaces:**
- Consumes: all prior tasks' semantics. Produces: documentation only.

- [ ] **Step 1: Update both paragraphs identically in substance**

State: the fixed decision order (abort, unverified cleanup, output cap, receipt count, stopping failure class, timeout); timeout as an unjudged `outcome:"timeout"` case that continues the roster after the identity+drift gate; `workerFailure` projection retention on case and post-CLI stop records (per-field whitelist, `errorSha256` correlation-only, no error text); `completed` reconciling written records; exit semantics 0/1/4/130/143 (no exit 2/3 in custom-round); the campaign-driver contract **continue only on 0/3/4, halt otherwise** with case-143 ≠ campaign-143; nothing claims the 2026-10-13 failures resolved.

- [ ] **Step 2: Verify docs consistency and run the full gates**

Run: `pnpm test && pnpm run test:coverage && git diff --stat -- src/`
Expected: full suite green; coverage ≥ 80 line/branch/function; empty `src/` diff.

- [ ] **Step 3: Commit**

```bash
git add README.md .agents/skills/turnhelm-routing/SKILL.md
git commit -m "docs(round): timeout continuation, failure evidence, and completed semantics"
```
