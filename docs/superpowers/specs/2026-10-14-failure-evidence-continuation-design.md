# Custom-Round Failure Evidence and Timeout Continuation Spec

Date: 2026-10-14. Code baseline: `ac415ba957290edc54a68a7736870dc402991c46`. Input: the 2026-10-13 routing-validation report (`/private/tmp/turnhelm-routing-validation-20261013-ac415ba-yq4aCP/REPORT.txt`, approval SHA-256 `8afea4be…a8787`), verdict PARTIAL.

> Status: drafted under the user's authorization to write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, paid calls, or publication.

## 1. Findings and decision boundary

Round facts: 45 worker starts, 45/45 requested tuple bindings honored; 38 natural business cases started → 35 pass, 2 CLI-143 fail, 1 timeout not-judged; calibration 21/24; payload 28 strict + 7 extracted; suites settled `laya` 0, `calibration-dev` 3, `calibration-holdout` 0, `business` stopped at case 38. Wherever the chain was graded it behaved correctly. The round's two structural costs are both harness properties, not product defects:

1. **Indeterminable worker failures.** Cases 06 and 14 exited 143. The CLI receipt — captured on stderr, carrying `failureClass`, `errorSha256`, `ownedShutdown`, `signal`, `lastEventAgeMs`, `progressEvents`, `usage` (`src/cli.ts:236`) — was parsed only for `failureClass` stop gating (`receiptFailureClass`, `test/custom-round.ts:735`) and the payload projection. The `case` evidence records kept `exitCode`/`durationMs` alone, so the 143 root causes are formally indeterminate (`REPORT.txt:857–873`).
2. **The timeout cascade.** Case 38 hit the frozen 240 s budget; `executeRound` treats `timedOut` as an integrity stop (`test/custom-round.ts:966`) and returns 1, leaving the manifest's remaining 8 baseline cases unexecuted; the campaign driver then halted on the non-continuable exit-1 settlement, so `dual` (2) and `jev` (1) never ran — 11 approved observations discarded, `validComparisons` 0 (`REPORT.txt:896–905`).

Neither fact licenses a production change, and neither is hereby declared product-clean. This spec changes the custom-round harness only; `src/` is untouched.

| Report finding | Disposition |
| --- | --- |
| 2× CLI-143 failures with unverified root cause; harness retained no failure receipt projection | §3 — retain the whitelisted receipt projection on every case record and on timeout stops |
| Case 38 timeout → suite stop → 8 baselines + dual 2 + jev 1 unexecuted, 0 valid comparisons | §4 — timeout becomes a graded per-case outcome; the roster continues |
| `workerUsage`/`workerProgress` `unreported` on all 27 recorded pairs | §3 — project `usage` (VH-3 whitelist) and `progressEvents` from the same receipt |
| Complete-vs-stopped distinguishable only by exit code once continuation exists | §5 — strict `completed` record for every executed manifest |
| English-heading overroute 3/3, calibration band mismatches (10/11 still passed) | No code. Predeclared-policy facts under the frozen calibration design; no band/prompt tuning |
| Hosted Jev HTTP 451; provider attestation; natural xhigh/max coverage absent | No code. External/open findings (§7) |

**Decision reversal against the 2026-10-12 evidence-continuation spec**, justified by what this round exposed: VH-2 classed timeout among the operational stops that "never reach a `verified` record — the stop is its own diagnosis." One stop destroyed 11 already-approved observations, and the stop itself retained no worker evidence, so it was not its own diagnosis. Superseded, narrowly, for the custom-round runner: a timeout is the supervisor enforcing the frozen per-case budget as designed — expected bounded behavior of the worker under test, not a harness anomaly — so it becomes an unjudged per-case outcome with a post-timeout drift gate (§4). Integrity anomalies (identity, baseline, case-files, receipt-count, tree-drift, output-cap, stop failure classes) still stop all remaining spend.

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: receipt projection + timeout outcome + continuation + usage projection + completed record; harness/test/docs only | Every future worker failure and timeout diagnosable from frozen evidence; approved coverage survives bounded worker behavior; zero production-path change | **Adopt** |
| B: keep timeout as a stop; add evidence retention only | Repeats this round's 11-observation loss on the next slow case; evidence without coverage | Reject |
| C: in-repo campaign runner over multiple manifests; resume/replay; retry of failed/timed-out cases; raising CASE_TIMEOUT_MS | Framework against an unproven need; resume and retry break one-claim/never-resume; budget changes are the explicit anti-gaming boundary | Reject |

Not maintaining backward compatibility means replacing tests that pin the old timeout-stop semantics and the case-record shape. It does not mean lowering safety thresholds, rewriting historical reports, or re-grading sealed rounds.

## 2. Scope, inheritance, and invariants

Files changed: `test/custom-round.ts`, `test/custom-round.test.ts`, the custom-round section of `README.md`, and the custom-round paragraph of the shared skill source `.agents/skills/turnhelm-routing/SKILL.md`. `test/live.integration.ts` only if its compile surface moves. Not changed: anything under `src/`, `package.json`, the roster/manifest schemas (v1 stays; evidence records gain fields), dependencies.

Inherited unchanged: hash-approved frozen manifest, exclusive-create claim, **never resumed or replayed**, reservation-before-spend, baseline drift re-verification before every case, root-identity and case-file gates, receipt-count == 1, `STOP_FAILURE_CLASSES` (auth/rate-limit/usage-limit stop all spend), signal ladder 130/143, exit 2 usage errors, `CASE_TIMEOUT_MS = 240_000` (frozen — no budget increase, per the round's anti-gaming boundary), `ORACLE_INPUT_CAP_BYTES`, the sandboxed contract check.

Exit semantics after this spec: 0 complete all-pass; 1 stopped/incomplete; 2 usage; 4 complete roster with one or more `failed` **or** `timeout` cases; 130/143 signals. A multi-manifest campaign driver continues on 0/3/4 and halts on 1/130/143 — the contract is documented, no runner is built.

## 3. Receipt projection on the case record (FE-1)

The `case` evidence record gains `workerFailure`, extracted from the same single receipt line already guaranteed by the count gate, projected to a fixed whitelist and nothing else:

```ts
type WorkerReceiptEvidence = Readonly<{
  status: string;                        // receipt worker.status literal
  code: number | null;
  durationMs: number;                    // safe integer
  progressEvents: number;                // safe integer
  ownedShutdown: boolean;
  usage: { input_tokens?: number; output_tokens?: number;
           cached_input_tokens?: number; reasoning_output_tokens?: number } | "unreported";
  failureClass?: "stream-disconnected" | "rate-limit" | "usage-limit" | "timeout" | "auth" | "overloaded" | "unknown";
  errorSha256?: string;                  // 64-hex; correlation without content
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  lastEventAgeMs?: number;               // safe integer
}>;
```

- Every field is individually type-checked; the `usage` projection is exactly VH-3's (partial snapshots kept, never zero-filled; malformed counters dropped, never thrown; absent usage, the emitted `"unreported"` literal, and zero valid counters all project to `"unreported"`). A receipt `worker` object that is not a record, or that carries any key outside the whitelist, degrades the whole projection to the literal `"unavailable"` — the same strictness as `projectWorkerFailure`'s unknown-key rejection (`test/live-acceptance.ts:920`). No raw error text, stderr bytes, or transcript ever reaches the ledger; `errorSha256` is correlation-only.
- Retained on pass and fail alike — pass-case retention is what makes spot-checks possible.
- The `timeout` and `output-cap` `stopped` records attempt the same projection (a parseable single receipt on the captured stderr → object; anything else → `"unavailable"`). This is the case-38 fix: at the budget stop, the worker's `cancelled` status, `ownedShutdown`, `lastEventAgeMs`, and `progressEvents` are frozen into evidence instead of being discarded with the process.
- **Size/privacy honesty:** the projection is bounded scalars (frozen enum, 64-hex hash, safe integers, booleans). No new file; the evidence stays inside the claimed run root's ledger. This is not secret sanitization of raw content — no raw content is retained at all.

## 4. Timeout outcome and roster continuation (FE-2)

When `observation.timedOut` is true (and the run was not aborted):

- The case is graded `outcome: "timeout"` — unjudged. No stdout oracle runs, no contract check executes (grading a half-written state would be dishonest); `taskSha256`, `backend`, `profileId`, `exitCode` (may be `null`), `durationMs`, and §3's projection are recorded as-is.
- **Post-timeout drift gate:** the settled tree is hashed after the kill. Changes outside `allowedChanges` → `stopped`/`tree-drift`, exit 1 (a worker that wrote outside its allowance while unbounded is an integrity stop, exactly as after a graded case). Changes within allowance or none → the timeout case record is appended and the roster proceeds to the next reservation.
- `outputOverflow` alone remains an integrity stop (`stopped`/`output-cap`, exit 1): a capped stream cannot be graded and says nothing honest about the worker.
- No retry of the timed-out case, no budget change, no resume: continuation spends only reservations already inside the approved manifest — the same envelope the operator signed, the same authority precedent as VH-2's oracle continuation.
- Adjudication power: for the next slow case, "worker exceeded budget mid-flight" vs "supervisor defect" vs "provider stall" becomes decidable from §3's frozen projection (`progressEvents`, `lastEventAgeMs`, `ownedShutdown`) plus the within-allowance tree delta — with no paid replay. The specific case 38 stays not-judged and unexplained; this spec makes the *class* diagnosable.

## 5. Completed record (FE-3)

After the last case of a fully executed manifest:

```json
{ "phase": "completed", "outcome": "pass" | "fail", "cases": <manifest.cases.length>, "failed": <n>, "timedOut": <n> }
```

Strict shape, unknown fields rejected; all counts safe integers; `outcome === "fail"` iff `failed + timedOut > 0`; `cases` equals the manifest's roster length; `failed`/`timedOut` exactly reconcile the run's own case records at append time. `completed` plus the exit code is a **convenience status only**: acceptance reading still reconciles unique case IDs, per-case outcomes, the counts, and the absence of a terminal `stopped` before signing anything (the VH-2 reader contract). Stopped runs append no `completed` and exit 1.

## 6. Findings deliberately kept open (no code)

- **Hosted Jev HTTP 451:** external; fail-closed behavior is correct and stays. Closes only on provider-side evidence plus a newly authorized round (work-state item `hosted-jev-http451-dependency`).
- **Band mismatches / English-heading overroute:** predeclared-policy facts under the frozen calibration design; comparative claims stay gated on its separately approved worker round.
- **Natural xhigh/max coverage and comparative pairs:** the 11 unexecuted observations were lost to the cascade this spec removes; covering them needs a future frozen roster with fresh approval. Unused caps never carry over; no profile forcing.
- **The 06/14/38 root causes:** historical, sealed, not re-run, not re-graded, not assumed fixed. §3/§4 make the next occurrence diagnosable.

Explicit non-goals: campaign-runner framework; resume/replay/retry anywhere; timeout budget changes; band/prompt/profile tuning; report/analytics or billing platform; production routing changes.

## 7. Acceptance criteria

| ID | Required evidence |
| --- | --- |
| EC-01 | `workerFailure` retained on every case record, pass and fail: exact whitelist, per-field type checks, `usage` VH-3 projection incl. `"unreported"` literals, unknown receipt-worker key → whole projection degrades to `"unavailable"`; no raw error text or stderr bytes anywhere in the ledger; pass-case retention pinned |
| EC-02 | Timeout case → `outcome:"timeout"` with no oracle/contract grading, `exitCode` may be `null`, roster continues and later cases are graded; post-timeout out-of-allowance write → `stopped`/`tree-drift` exit 1; within-allowance delta continues; `outputOverflow` still stops (exit 1); abort still settles 130/143; `CASE_TIMEOUT_MS` unchanged |
| EC-03 | Timeout and output-cap `stopped` records carry the same projection or `"unavailable"`; receipt-count ≠ 1 still stops with no projection; `STOP_FAILURE_CLASSES` still stop all spend |
| EC-04 | `completed` strict shape with reconciling safe-integer counts (`cases` = roster length; multi-failure and timeout mixes included); complete-with-failures/timeouts exits 4; all-pass exits 0; stopped/incomplete exits 1; no `completed` after a stop |
| EC-05 | One-claim/never-resume, frozen gates, baseline drift, signal ladder, prepare mode, and manifest schema v1 regressions all still green |
| EC-06 | README and shared skill custom-round paragraph state the new outcome, exit semantics, and the 0/3/4-continue vs 1/130/143-halt driver contract consistently; full offline suite green with line/branch/function coverage ≥ 80; zero diff under `src/` |
| EC-07 | Documentation honesty: nothing claims 06/14/38 are resolved or product-clean; §7 findings stay open; historical grades and seals untouched |
