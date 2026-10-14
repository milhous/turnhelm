# Custom-Round Failure Evidence and Timeout Continuation Spec

Date: 2026-10-14. Code baseline: `ac415ba957290edc54a68a7736870dc402991c46`. Input: the 2026-10-13 routing-validation report (`/private/tmp/turnhelm-routing-validation-20261013-ac415ba-yq4aCP/REPORT.txt`, approval SHA-256 `8afea4be…a8787`), verdict PARTIAL. Revised after the 2026-10-14 astra review (§8: 4×P1, 5×P2, 1×P3, all accepted).

> Status: drafted under the user's authorization to write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, paid calls, or publication.

## 1. Findings and decision boundary

Round facts: 45 worker starts, 45/45 requested tuple bindings honored; 38 natural business cases started → 35 pass, 2 CLI-143 fail, 1 timeout not-judged; calibration 21/24; payload 28 strict + 7 extracted; suites settled `laya` 0, `calibration-dev` 3, `calibration-holdout` 0, `business` stopped at case 38. Wherever the chain was graded it behaved correctly. The round's two structural costs are both harness properties, not product defects:

1. **Indeterminable worker failures.** Cases 06 and 14 exited 143. The CLI receipt — captured on stderr, carrying `failureClass`, `errorSha256`, `ownedShutdown`, `signal`, `lastEventAgeMs`, `progressEvents`, `usage`, `payload` (`src/cli.ts:236`) — was parsed only for `failureClass` stop gating (`receiptFailureClass`, `test/custom-round.ts:735`) and the payload projection. The `case` evidence records kept `exitCode`/`durationMs` alone, so the 143 root causes are formally indeterminate (`REPORT.txt:857–873`).
2. **The timeout cascade.** Case 38 hit the frozen 240 s budget; `executeRound` treats `timedOut` as an integrity stop (`test/custom-round.ts:966`) and returns 1, leaving the manifest's remaining 8 baseline cases unexecuted; the campaign driver then halted on the non-continuable exit-1 settlement, so `dual` (2) and `jev` (1) never ran — 11 approved observations discarded, `validComparisons` 0 (`REPORT.txt:896–905`).

Neither fact licenses a production change, and neither is hereby declared product-clean. This spec changes the custom-round harness only; `src/` is untouched.

| Report finding | Disposition |
| --- | --- |
| 2× CLI-143 failures with unverified root cause; harness retained no failure receipt projection | §3 — retain the per-field whitelisted receipt projection on case records and integrity-stop records |
| Case 38 timeout → suite stop → 8 baselines + dual 2 + jev 1 unexecuted, 0 valid comparisons | §4 — timeout becomes a graded per-case outcome under a fixed decision order; the roster continues |
| `workerUsage`/`workerProgress` `unreported` on all eight recorded comparison entries | §3 — project `usage` (VH-3 whitelist) and `progressEvents` from the same receipt |
| Complete-vs-stopped distinguishable only by exit code once continuation exists | §5 — strict `completed` record reconciling written case records |
| English-heading overroute 3/3, calibration band mismatches (10/11 still passed) | No code. Predeclared-policy facts under the frozen calibration design; no band/prompt tuning |
| Hosted Jev HTTP 451; provider attestation; natural xhigh/max coverage absent | No code. External/open findings (§6) |

**Decision reversal against the 2026-10-12 evidence-continuation spec**, justified by what this round exposed: VH-2 classed timeout among the operational stops that "never reach a `verified` record — the stop is its own diagnosis." One stop destroyed 11 already-approved observations, and the stop itself retained no worker evidence, so it was not its own diagnosis. Superseded, narrowly, for the custom-round runner only (live-acceptance's stop semantics are unchanged): a timeout is the supervisor enforcing the frozen per-case budget as designed — expected bounded behavior of the worker under test, not a harness anomaly — so, *once cleanup and identity are verified*, it becomes an unjudged per-case outcome (§4). Integrity anomalies (abort, unverified cleanup, output cap, identity, baseline, case-files, receipt-count, tree drift, stop failure classes) still stop all remaining spend.

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: receipt projection + verified-cleanup timeout outcome + continuation + usage projection + completed record; harness/test/docs only | Every future worker failure and timeout carries bounded frozen evidence; approved coverage survives bounded worker behavior; zero production-path change | **Adopt** |
| B: keep timeout as a stop; add evidence retention only | Repeats this round's 11-observation loss on the next slow case; evidence without coverage | Reject |
| C: in-repo campaign runner over multiple manifests; resume/replay; retry of failed/timed-out cases; raising CASE_TIMEOUT_MS; new production telemetry (e.g. emitting `WorkerResult.error` in the receipt) | Framework or product change against an unproven need; resume and retry break one-claim/never-resume; budget changes are the explicit anti-gaming boundary | Reject |

Not maintaining backward compatibility means replacing tests that pin the old timeout-stop semantics and the case-record shape. It does not mean lowering safety thresholds, rewriting historical reports, or re-grading sealed rounds.

## 2. Scope, inheritance, and invariants

Files changed: `test/custom-round.ts`, `test/custom-round.test.ts`, the custom-round section of `README.md`, and the custom-round paragraph of the shared skill source `.agents/skills/turnhelm-routing/SKILL.md`. `test/live.integration.ts` only if its compile surface moves. Not changed: anything under `src/`, `package.json`, the roster/manifest schemas (v1 stays; evidence records gain fields), dependencies.

Inherited unchanged: hash-approved frozen manifest, exclusive-create claim, **never resumed or replayed**, reservation-before-spend (a failed `reserved` append stops all spend), baseline drift re-verification before every case, root-identity and case-file pre-launch gates, receipt-count == 1, `STOP_FAILURE_CLASSES` (auth/rate-limit/usage-limit stop all spend), signal ladder 130/143, `CASE_TIMEOUT_MS = 240_000` (frozen — no budget increase, per the round's anti-gaming boundary), `ORACLE_INPUT_CAP_BYTES`, the sandboxed contract check, prepare mode (including its exit-1 refusals).

Exit semantics after this spec: 0 complete all-pass; 1 stopped/incomplete or usage/prepare refusal (unchanged from today — custom-round has no exit 2); 4 complete roster with one or more `failed` **or** `timeout` cases; 130/143 signals. Exit 3 belongs to calibration suites and is never emitted by custom-round. **Campaign driver contract:** continue only on 0/3/4; halt on everything else, including 1, 2, 130, 143, and any unexpected code. A per-case worker CLI exit of 143 is a graded case outcome inside a manifest, never a campaign-process 143 — the two stay distinct.

## 3. Receipt projection on case and stop records (FE-1)

Every `case` evidence record — and every integrity-stop record written after the CLI ran (`cleanup-unverified`, `output-cap`, `worker-<class>`, `tree-drift`) — gains `workerFailure`: a projection of the run's single receipt `worker` object (for stop records, when exactly one parseable receipt exists on the captured stderr; otherwise the field is omitted, never fabricated):

```ts
type WorkerReceiptEvidence = Readonly<{
  status: "not-started" | "completed" | "failed" | "cancelled";  // frozen enum
  code?: number;                        // safe integer; absent on not-started receipts
  durationMs?: number;                  // safe integer
  progressEvents?: number;              // safe integer
  ownedShutdown?: boolean;              // absent on not-started receipts, never defaulted to false
  usage?: { input_tokens?: number; output_tokens?: number;
            cached_input_tokens?: number; reasoning_output_tokens?: number } | "unreported";
  failureClass?: "stream-disconnected" | "rate-limit" | "usage-limit" | "timeout" | "auth" | "overloaded" | "unknown";
  errorSha256?: string;                 // 64-hex; correlation without content
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  lastEventAgeMs?: number;              // safe integer
}>;
```

- **Per-field projection, unselected keys ignored.** The receipt legitimately carries keys outside this table (today `payload`; tomorrow whatever the product adds) — ignoring them is the point of a projection. Each retained field is individually type-checked; a field that fails its check is dropped from the projection, never coerced and never thrown. The projection is discarded entirely (field omitted) only when the receipt `worker` object is absent or not a record, or `status` is not in the enum. This mirrors `test/live-acceptance.ts:1665–1671`, which constructs a selected projection before validating it — it does not reject extra receipt keys.
- `status: "not-started"` receipts (`src/cli.ts:213`) legitimately lack `code`, `durationMs` beyond 0, `ownedShutdown`, and the failure fields; the projection keeps exactly what is present. The supervisor-level `exitCode` on the case record (nullable on a timeout kill) stays a separate, pre-existing field — it is never merged with the worker's own `code`.
- The `usage` projection is exactly VH-3's: partial snapshots kept, never zero-filled; malformed counters dropped; absent usage, the emitted `"unreported"` literal, and zero valid counters all project to `"unreported"`.
- Retained on pass and fail alike — pass-case retention is what makes spot-checks possible.
- **Privacy/size honesty:** the projection is bounded scalars (frozen enums, 64-hex hash, safe integers, booleans) and retains no error text — `errorSha256` is correlation-only. This content-freedom claim is scoped to the new projection: the ledger's pre-existing `oracleInput` deliberately retains raw oracle-judged stdout under its own 64 KiB bound, and that stays. `progressEvents`/`lastEventAgeMs` are parent-observed, backpressure-bounded counts and ages — never liveness or stall claims (`src/codex.ts:11–14`); `ownedShutdown` is an action record, not a causation claim.

## 4. Timeout outcome and roster continuation (FE-2)

The post-CLI decision order is fixed and testable; earlier steps shadow later ones:

1. **Abort** (`observation.aborted || signal.aborted`) → `stopped {reason:"signal"}`, exit 130/143.
2. **Unverified cleanup** (`!observation.cliClosed`) → `stopped {reason:"cleanup-unverified"}`, exit 1. The supervisor may abandon still-open pipes without a kill (`test/live-acceptance.ts:1219–1228`); a possibly-live CLI means no further reservation — the same discipline as live-acceptance's `cleanup-unverified`.
3. **Output overflow** (`observation.outputOverflow`) → `stopped {reason:"output-cap"}`, exit 1. Overflow sets `timedOut` too (`halt("timeout")` at `test/live-acceptance.ts:1245–1247`), which is exactly why overflow is checked before timeout: a capped stream cannot be graded.
4. **Receipt count ≠ 1** → `stopped {reason:"receipt"}`, exit 1 (no `workerFailure` — attribution is untrustworthy).
5. **Stopping failure class** (`STOP_FAILURE_CLASSES`) → `stopped {reason:"worker-<class>"}`, exit 1.
6. **Timeout** (`observation.timedOut`) → the case is graded `outcome:"timeout"` — unjudged. No stdout oracle runs, no contract check executes (grading a half-written state would be dishonest); `taskSha256`, `backend`, `profileId`, supervisor `exitCode` (may be `null`), `durationMs`, and §3's projection are recorded as-is.
7. Otherwise the case grades as today (oracle + allowedProfiles + contract, tree re-verification, `pass`/`failed`).

For step 6, before the outcome is accepted:

- **Identity re-check:** the case root's canonical path and dev/ino must still match the frozen identity. This closes the same-content-replacement hole at the settled-tree gate — and the same re-check is applied at the (single) settled-tree verification for *every* case, graded or timeout: `hashTree` proves content only, identity is proven by `stat`, and a replaced root is an integrity stop (`stopped {reason:"root-identity"}`, exit 1) regardless of what the content hash says.
- **Drift gate:** the settled tree may differ from the frozen tree only inside `allowedChanges`; anything else → `stopped {reason:"tree-drift"}`, exit 1. Within allowance or none → the timeout case record is appended and the roster proceeds to the next reservation.
- No retry of the timed-out case, no budget change, no resume: continuation spends only reservations already inside the approved manifest — the same envelope the operator signed, the same authority precedent as VH-2's oracle continuation.
- **Adjudication power, stated honestly:** for the next slow case, the frozen projection plus the verified-cleanup/identity/drift outcomes materially narrow attribution (worker exceeded budget with N decoded events and a quiet tail vs supervisor-kill vs replacement) — bounded parent-observed evidence, not a guaranteed root cause. The specific case 38 stays not-judged and unexplained; this spec makes the *class* diagnosable.

`CASE_TIMEOUT_MS` stays 240_000.

## 5. Completed record (FE-3)

After the last case of a fully executed manifest:

```json
{ "phase": "completed", "outcome": "pass" | "fail", "cases": <manifest.cases.length>, "failed": <n>, "timedOut": <n> }
```

- Strict shape, unknown fields rejected; all counts non-negative safe integers with `failed + timedOut ≤ cases`; `outcome === "fail"` iff `failed + timedOut > 0`.
- Counts reconcile **successfully written case records**, not in-memory tallies: a `case` append that fails is now terminal (`stopped {reason:"evidence-io"}`, exit 1) — uniform with the `reserved`-append discipline; the old fail-open comment is retired. `cases` equals the manifest's roster length; a manifest whose written case records do not reconcile (impossible without an append having failed) refuses to write `completed`.
- The `completed` append itself is terminal on failure (exit 1). A signal discovered after the last append still settles 130/143 and overrides a would-be 0/4. Exit 0 requires the full protocol: every case written, all `pass`, `completed {outcome:"pass"}`, no stop; otherwise 4.
- `completed` plus the exit code is a **convenience status only**: acceptance reading still reconciles unique case IDs, per-case outcomes, the counts, and the absence of a terminal `stopped` before signing anything (the VH-2 reader contract). Stopped runs append no `completed` and exit 1.

## 6. Findings deliberately kept open (no code)

- **Hosted Jev HTTP 451:** external; fail-closed behavior is correct and stays. Closes only on provider-side evidence plus a newly authorized round (work-state item `hosted-jev-http451-dependency`).
- **Band mismatches / English-heading overroute:** predeclared-policy facts under the frozen calibration design; comparative claims stay gated on its separately approved worker round.
- **Natural xhigh/max coverage and comparative pairs:** the 11 unexecuted observations were lost to the cascade this spec removes; covering them needs a future frozen roster with fresh approval. Unused caps never carry over; no profile forcing.
- **The 06/14/38 root causes:** historical, sealed, not re-run, not re-graded, not assumed fixed. §3/§4 make the next occurrence carry decisive bounded evidence. `WorkerResult.error`'s failure stage is not emitted in today's receipt; recovering it would be a product change and is explicitly rejected (Approach C).

Explicit non-goals: campaign-runner framework; resume/replay/retry anywhere; timeout budget changes; band/prompt/profile tuning; report/analytics or billing platform; production routing or telemetry changes.

## 7. Acceptance criteria

| ID | Required evidence |
| --- | --- |
| EC-01 | `workerFailure` on every case record (pass, fail, timeout) with per-field projection: existing `payload` key ignored without losing the projection; each malformed retained field dropped, not coerced/thrown; non-record worker object or out-of-enum `status` → field omitted; `not-started` receipts project without fabricated `code`/`ownedShutdown`; `usage` VH-3 rules incl. `"unreported"`; no error text or stderr bytes in the projection; pass-case retention pinned |
| EC-02 | Decision-order regressions: overflow-with-timeout-flags set → `output-cap` stop (never a timeout case); `!cliClosed` → `cleanup-unverified` exit 1 with no further reservation, even with `timedOut` set; abort dominates all; receipt-count and stop-class gates still precede timeout handling; no later reservation after any integrity stop |
| EC-03 | Timeout case → `outcome:"timeout"` with no oracle/contract grading, nullable supervisor `exitCode` recorded, §3 projection retained, roster continues and later cases grade; post-timeout out-of-allowance write → `tree-drift` exit 1; same-content root replacement at the settled-tree gate (graded case *and* timeout case) → `root-identity` exit 1; within-allowance delta continues; `CASE_TIMEOUT_MS` unchanged |
| EC-04 | Integrity-stop records after a CLI run (`cleanup-unverified`, `output-cap`, `worker-<class>`, `tree-drift`, `root-identity`) carry the projection when exactly one parseable receipt exists; `receipt`-count stops carry none; no projection is ever fabricated |
| EC-05 | `completed` strict shape: counts reconcile written case records (multi-failure and timeout mixes included); `failed + timedOut ≤ cases`; a failed case-record or `completed` append → exit 1; late abort after the last append overrides 0/4 with 130/143; all-pass exits 0; stopped/incomplete exits 1; prepare mode and usage-refusal exits unchanged |
| EC-06 | One-claim/never-resume, frozen gates, baseline drift, signal ladder, manifest schema v1, and prepare-mode regressions all still green |
| EC-07 | README and shared skill custom-round paragraph state the new outcome, the fixed decision order, exit semantics, and the continue-only-on-0/3/4 driver contract consistently; full offline suite green with line/branch/function coverage ≥ 80; zero diff under `src/` |
| EC-08 | Documentation honesty: nothing claims 06/14/38 are resolved or product-clean; no liveness/stall/causation claims ride the projection; §6 findings stay open; historical grades and seals untouched |

## 8. Astra review record

Independent reviewer: codex `gpt-6-astra`, fresh read-only session via `codex exec --sandbox read-only`, 2026-10-14; reviewed the draft against baseline `ac415ba`, the report, the harness sources (`test/custom-round.ts`, `test/live-acceptance.ts`), the prior spec, and the receipt surface (`src/cli.ts`, `src/codex.ts`, `src/codex-events.ts`). Verdict on the draft: **PROBLEMS** (4×P1, 5×P2, 1×P3). All ten findings accepted; none rejected. Dispositions:

| Finding | Disposition |
| --- | --- |
| P1: whole-projection rejection on unknown receipt keys is invalidated by today's `payload` key — every completed case would lose its evidence; live-acceptance's analogy is a constructed projection, not extra-key rejection | Accepted; §3 rewritten to per-field projection with unselected keys ignored, per-field degradation, enum `status`, projection discarded only on non-record/absent worker or out-of-enum status; EC-01 pins the `payload` case |
| P1: supervisor may return with `cliClosed:false` and a possibly-live CLI (pipes abandoned, no kill) — continuation could overlap workers and spend | Accepted; §4 step 2: `!cliClosed` → `cleanup-unverified` stop, exit 1, no further reservation; EC-02 regression |
| P1: overflow sets both flags via `halt("timeout")` — a timeout-first branch would continue output-cap breaches; gate placement needed explicit preservation | Accepted; §4 fixed decision order (abort → cleanup → overflow → receipt-count → stop-class → timeout); EC-02 overlap regressions |
| P1: `hashTree` proves content, not identity; same-content root replacement passes the proposed gate | Accepted; §4 identity re-check at the settled-tree gate, extended uniformly to every case (the hole existed for graded cases too); EC-03 replacement regressions for both paths |
| P2: `completed` could reconcile in-memory tallies while a swallowed case-append failure loses records; no final abort check; count bounds unspecified | Accepted; §5 counts reconcile written records; case and `completed` append failures terminal; late abort overrides 0/4; `failed + timedOut ≤ cases`; EC-05 |
| P2: schema mismatches — worker `code` is numeric, `not-started` receipts omit `code`/`ownedShutdown`, `status:string` was not a frozen enum, malformed-field behavior undefined | Accepted; §3 enum statuses, optional fields per the receipt's actual shapes, no fabrication, supervisor `exitCode` kept distinct; EC-01 |
| P2: §3 required timeout `stopped` records while §4 removed ordinary timeout stops — contradictory terminal shapes | Accepted; §3 now attaches the projection to case records and the actual integrity-stop records; EC-04 rewritten; live-acceptance semantics untouched |
| P2: adjudication claims exceeded the evidence (progress/age are not liveness claims; `ownedShutdown` is action not causation; `WorkerResult.error` unrecoverable from the receipt; "no raw content at all" overstated beside `oracleInput`) | Accepted; §3/§4 reworded to bounded parent-observed evidence and narrowed attribution; content-freedom scoped to the new projection; recovering `error` rejected as product change (Approach C) |
| P2: campaign contract left exits 2/unexpected unspecified; "exit 2 inherited" was false for custom-round (usage exits 1); exit 3 is calibration-only; case-143 vs campaign-143 conflation risk | Accepted; §2: continue only on 0/3/4, halt otherwise; 3 documented as calibration-only; custom-round usage/refusal exits documented as today's 1; case-vs-campaign 143 distinction stated |
| P3: "all 27 recorded pairs" miscounted (8 comparison entries; 27 was `naturalPolicyMatches`) | Accepted; §1 corrected to "all eight recorded comparison entries" |

Residual risk (reviewer, retained): static review only; runtime safety is established only when the plan's tests land.
