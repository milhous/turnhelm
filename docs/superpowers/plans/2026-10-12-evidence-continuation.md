# Live-Acceptance Evidence and Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every judged worker-oracle failure diagnosable from frozen evidence (bounded `oracleInput` retention, `workerUsage` projection) and let already-approved worker rosters survive isolated task-output failures (integrity-vs-oracle split, unified `completed`, exit 4).

**Architecture:** Harness-only change in `test/live-acceptance.ts` (evidence schema + sanitizer + verdict loop + terminal protocol) with hermetic tests in `test/live-acceptance.test.ts`; documentation sync in README and the shared skill source. The production router/CLI (`src/`) is untouched.

**Tech Stack:** TypeScript (strict, ESM), `node:test` via `pnpm test` (build + `node --test dist/test/*.test.js`), Node ≥ 24.

**Spec:** `docs/superpowers/specs/2026-10-12-evidence-continuation-design.md` (post round-2 astra revision; its §8 records both review rounds' dispositions, including the round-2 deletion of `oracleInput.truncated` — a stdout cap breach stops the run before any `verified` record, so no truncation flag and no `superviseCli` overflow bit are built).

## Global Constraints

- Zero diff under `src/`; corpus fixture and manifest/corpus schemas stay v2; no new dependencies, no new files outside the four named surfaces (`test/live-acceptance.ts`, `test/live-acceptance.test.ts`, `README.md`, `.agents/skills/turnhelm-routing/SKILL.md`; `test/live.integration.ts` only if its compile surface moves).
- Inherited invariants unchanged: one O_EXCL claim, never replayed or resumed, per-suite caps, reservation durable before spend, observed-before-verdict, evidence-I/O failure stops, signals 130/143, usage errors 2, at most one attempt per eligible backend, Jev triple gate, dual lead-case `laya-first` check stays in the worker checks literal (integrity class).
- Exit codes after this plan: 0 complete pass; 1 stopped/incomplete; 2 usage; 3 calibration policy mismatch; **4 complete worker roster with ≥1 engineering failure** (new); 130/143 signals. A terminal evidence-I/O or signal failure after the worker `completed` append still exits 1/130, never 4.
- `oracleInput` is `{source, text, bytes}` (three keys); `text` UTF-8 byte length ≤ 65 536 (byte bound); it is never fabricated: absent summary → `{source:"summary-file", text:null, bytes:null}`; a refused read (symlink/non-regular/oversize) stays `verifiable:false` with no `oracleInput`.
- `workerUsage` is a projection: unknown/malformed counters are dropped, never thrown; absent usage, the emitted literal `"unreported"`, and zero valid counters all yield `"unreported"`.
- Worker `completed` counts are non-negative safe integers with unknown fields rejected; `cases` = the claimed manifest's roster length; `failed` exactly reconciles this run's fail verdicts; the calibration `completed` shape (including `cases === 12`) is unchanged and still rejected when malformed.
- All docs/comments in English. Conventional Commits. No push, no branch creation, no PR without explicit user instruction.
- Gates: `pnpm test` green (the full suite is what guards the harness); `pnpm run test:coverage` green (its include is `dist/src/**`, so it mechanically guards the zero-`src/`-diff promise; line/branch/function ≥ 80).

## Review Focus

1. **Hostile stdout content** (quotes, newlines, NUL, `}` sequences) must keep the evidence JSONL one valid JSON record per line — record injection must stay impossible. → Task 1 tests.
2. **Mid-case root identity replacement** (same pathname, new dev/ino, contents preserved) with a *passing* oracle must stop the run — the hole is that nothing grades it today. → Task 3 test (e).
3. **Refused vs absent oracle reads**: refused = `verifiable:false` integrity stop carrying no `oracleInput`; absent = null-bytes evidence on a continuable oracle failure. Conflating them either hides a tampered read or stops a continuable case. → Task 1 tests.
4. **Partial, absent, or literal-`"unreported"` usage**: never zero-filled, never invented, never thrown. → Task 2 tests.
5. **Combo failures and reconciliation**: oracle+integrity stops (integrity dominates); multi-failure rosters report `failed` exactly; terminal faults override a would-be 4. → Task 3 tests.

---

### Task 1: bounded `oracleInput` retention (VH-1)

**Files:**
- Modify: `test/live-acceptance.ts` (`SafeEvidence` verified variant + `sanitizeEvidence` verified branch ~899–911; the worker oracle block ~1520–1529; the common `verified` append ~1574–1578)
- Test: `test/live-acceptance.test.ts`

**Interfaces:**
- Produces: `OracleInputEvidence = Readonly<{ source: "stdout" | "summary-file"; text: string | null; bytes: number | null }>` as the optional `oracleInput` field on `verified` records of judged worker cases only (classifier-only cases and the `verifiable:false` catch path carry none; operational stops never reach `verified`).
- Per-case plumbing: build `oracleInput` inside the existing oracle branches (stdout branch reuses `supervision.stdout` + the already-computed `decodeBounded`; summary branch reuses the same `readProjectFile` result the oracle judged — no second read), store it in a per-case variable, and attach it at the single common `verified` append.

- [ ] **Step 1: Write the failing tests**

Extending the existing fake-codex/fixture patterns (`writeFakeCodex` modes, `buildRun`, `readEvidence`): (a) a passing stdout-json case's `verified` record carries `oracleInput` with the exact JSON text and `bytes` set; (b) a wrong-sum oracle failure retains the text; (c) a summary-file case retains the summary text; an absent `out/summary.json` (fake exits without writing it) gives `{source:"summary-file", text:null, bytes:null}` with `oracle:false`; (d) a fake that writes invalid UTF-8 bytes (`0xff…`) into `out/summary.json` gives `text:null`, `bytes` set, and the evidence line still parses — this is the reachable end-to-end invalid-UTF-8 route (the existing `bad-utf8` mode poisons Codex event frames, which production rejects before stdout; do not reuse it here); (e) hostile stdout text (embedded `"` `\n` NUL `}` sequences) keeps the evidence JSONL one valid JSON record per line; (f) sanitizer bound: multibyte summary text whose character count is below 65 536 but byte count above is rejected, and an exact 65 536-byte text is accepted; (g) a malformed-field table through `appendEvidence` (wrong `source`, non-string `text`, non-integer `bytes`, unknown keys) rejects; (h) classifier-only `verified` records carry no `oracleInput`; (i) the existing symlinked-summary regression (`symlinker`) additionally asserts its `verified` record has no `oracleInput` — refused reads never fabricate one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: (a)–(h) FAIL — no `oracleInput` exists; (i) passes trivially today and is a pin.

- [ ] **Step 3: Implement**

Add the type and optional field; build `oracleInput` in the worker branch per the Interfaces note (stdout: `bytes: supervision.stdout.length`, `text: decodeBounded(supervision.stdout)`; summary-file: the existing read, `undefined` → `bytes: null`); the `verifiable:false` catch path leaves it unset. Extend the `verified` sanitizer branch: exact three-key whitelist, type checks, `Buffer.byteLength(text, "utf8") <= 65536`.

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/live-acceptance.ts test/live-acceptance.test.ts
git commit -m "test(live): retain bounded oracle input in verified evidence"
```

### Task 2: `workerUsage` on observed records (VH-3)

**Files:**
- Modify: `test/live-acceptance.ts` (`SafeEvidence` observed variant + `sanitizeEvidence` observed branch ~888–898; worker branch — extraction moves to immediately after `receiptFrame` at ~1481, before `observation` is built at ~1484; the duplicate `worker` extraction at ~1521–1522 is removed and the `worker-completed` check reuses the moved object)
- Test: `test/live-acceptance.test.ts`

**Interfaces:**
- Produces: `observed.workerUsage: Readonly<Partial<Record<"input_tokens" | "output_tokens" | "cached_input_tokens" | "reasoning_output_tokens", number>>> | "unreported"` — projection drops unknown/malformed counters without throwing; absent usage, the literal `"unreported"`, and zero valid counters all yield `"unreported"`.
- Ordering constraint (invariant): the observed record is appended before any fallible verification read; extraction of `receiptFrame.worker` must therefore happen before `observation` is constructed, not where the checks are computed.

- [ ] **Step 1: Write the failing tests**

Fake receipts covering: full four-counter usage → all four recorded; partial snapshot → only present counters, no zeros; no `usage` field → `"unreported"`; the literal string `"unreported"` (production emits it, `src/cli.ts`) → `"unreported"`; an object with only invalid counters (negative, non-integer) → `"unreported"`; an object mixing valid and invalid counters → only the valid subset; classifier-only observed records carry no `workerUsage`; the sanitizer drops unknown/malformed counters instead of throwing (round-trip through `appendEvidence` succeeds).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: FAIL — no `workerUsage` exists.

- [ ] **Step 3: Implement**

Move the guarded `receiptFrame.worker` extraction up (right after `receiptFrame`), project its `usage` through the four-key rule (safe non-negative integers only) into the `observed` record, and reuse the moved object for the `worker-completed` check. Extend the observed sanitizer branch with the same projection.

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/live-acceptance.ts test/live-acceptance.test.ts
git commit -m "test(live): whitelisted worker usage projection on observed records"
```

### Task 3: integrity-vs-oracle split, graded `root-identity`, unified `completed`, exit 4 (VH-2)

**Files:**
- Modify: `test/live-acceptance.ts` (worker `checks` literal ~1530–1550; verdict/stop logic 1565–1584; `sanitizeEvidence` completed branch 912–936; terminal protocol 1587–1631)
- Test: `test/live-acceptance.test.ts` (rewrite tests pinning the old any-fail-stops and worker-no-completed semantics; keep the integrity-failure and calibration pins)

**Interfaces:**
- Consumes: `oracleInput` (Task 1) — the `verified(fail)` record that continues the roster carries it.
- Produces: continuation semantics (below), the worker `completed` record `{phase:"completed", outcome:"pass"|"fail", cases, failed}`, and exit code 4.

- [ ] **Step 1: Write the failing tests**

(a) Oracle-only failure (wrong sum, every other check true) mid-roster: later cases still run and get graded; final `completed` is `{outcome:"fail", cases:<roster>, failed:1}`; exit 4. (b) Same suite all-pass: `completed {outcome:"pass", failed:0}`; exit 0 only after the full terminal protocol. (c) Integrity failure (`receipt-pair` false): immediate `stopped {reason:"verdict"}`, exit 1, no `completed`, no later reservation. (d) Oracle false **plus** integrity false: integrity dominates → stop, exit 1. (e) Mid-case root replacement with a **passing** oracle (fake worker or a test-side timer swaps the root directory mid-case for a same-path copy with a new dev/ino, contents preserved — reuse the claim-alias test's dev/ino technique): `stopped {reason:"verdict"}`, `root-identity:false` in the last checks, exit 1, no next reservation. On today's code this case *passes silently* (nothing grades `rootMatches`), so it is RED through behavior, not just the new field name. (f) A two-case subset roster with **two** oracle failures: `{outcome:"fail", cases:2, failed:2}`, exit 4 — `failed` reconciles the actual count. (g) Calibration suites: existing 0/3 semantics and the twelve-case `completed` constraints unchanged. (h) Sanitizer: the worker completed shape rejects unknown fields, negative/non-safe-integer counts, `outcome:"fail"` with `failed:0`, `outcome:"pass"` with `failed>0`, and `failed > cases`; the calibration shape (including a malformed one) is still rejected by the calibration rules. (i) Terminal faults on a would-be-4 run (reuse the existing `FileHandle` mock patterns): a `completed` append that throws → exit 1 `evidence-io`; an abort discovered after the `completed` append → exit 130. Also update the existing worker close-failure pin (~line 2684): `completed` now precedes the close, so the assertion flips from "no completed record" to "completed present, still `evidence-io` exit 1".

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: (a)(b)(e)(f) FAIL against current semantics; (h) FAIL (shape unsupported); (i) FAIL for the new fault points; (c)(d)(g) already pass — they are preservation pins, keep them.

- [ ] **Step 3: Implement the split and the record**

Control flow, exactly: add `"root-identity": rootMatches === true` to the existing worker `checks` literal (`rootMatches` is already computed in scope at ~1480); declare `failedCases = 0` beside the policy counters before the case loop; keep exactly one common durable `verified` append (no second append on the continuation path). After it: verdict `pass` → proceed; verdict `fail` with every check true except `oracle` → `failedCases += 1` and proceed; any other `fail` → today's immediate `stopped {reason:"verdict"}` + exit 1. After the loop, worker suites now run the same commit protocol calibration already runs, with their own record: pre-completed abort/frozen checks → append `{phase:"completed", outcome: failedCases === 0 ? "pass" : "fail", cases: run.manifest.cases.length, failed: failedCases}` → post-completed abort/frozen checks → close → final abort → return 0 / 3 / 4 (calibration branch and its exit mapping unchanged). Generalize the completed sanitizer into two strict shapes discriminated by field shape (worker keys `outcome/cases/failed` with `outcome ∈ {pass,fail}`; calibration keys `outcome/cases/policyMatches/policyMismatches` with the existing `cases === 12` and reconciliation rules untouched).

- [ ] **Step 4: Run the focused file**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: all PASS including the rewritten and preserved pins.

- [ ] **Step 5: Commit**

```bash
git add test/live-acceptance.ts test/live-acceptance.test.ts
git commit -m "test(live): continue rosters past oracle failures, grade root identity, unified completed, exit 4"
```

### Task 4: documentation sync and full gates (EC-06/07)

**Files:**
- Modify: `README.md` (live-acceptance section), `.agents/skills/turnhelm-routing/SKILL.md` (live paragraph only — single source; `.claude/skills/turnhelm-routing` symlink untouched, YAML metadata untouched)

**Interfaces:**
- Consumes: the final semantics from Tasks 1–3.

- [ ] **Step 1: Update both doc surfaces**

State exactly: new exit 4 (complete worker roster with ≥1 engineering failure; exit 3 unchanged); oracle-only failures continue the approved roster while any integrity failure — now including `root-identity` — stops immediately; `oracleInput` retention is deliberate raw-content retention bounded to 64 KiB pre-serialization per judged case, private to the claimed run, covered by the manifest approval, **not** secret sanitization; `workerUsage` is a whitelisted projection with scope unverified. Add one reader-contract paragraph: `completed` plus the exit code is a convenience status only — acceptance reconciles unique case IDs, per-case verdicts, the counts, the absence of a terminal `stopped`, and the actual process exit before signing anything. Historical 2026-10-12 findings remain open — no resolution claim.

- [ ] **Step 2: Verify no drift and run full gates**

Run: `pnpm test` → 0 failures. Run: `pnpm run test:coverage` → green, ≥ 80 line/branch/function (include is `dist/src/**`; the harness is guarded by the full suite). Run: `git diff --stat src/` → empty across all task commits. Verify the skill symlink still resolves (`ls -l .claude/skills/turnhelm-routing`).

- [ ] **Step 3: Commit**

```bash
git add README.md .agents/skills/turnhelm-routing/SKILL.md
git commit -m "docs: live-acceptance continuation, retention, and exit-4 semantics"
```
