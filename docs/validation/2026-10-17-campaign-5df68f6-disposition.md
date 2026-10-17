# 2026-10-17 Routing-Validation Campaign Disposition

Sealed record of what the 2026-10-17 finite validation campaign established,
what remains open, and the standing instructions that follow. The campaign's
grades and authorities are closed; this note changes none of them.

## Verdict

- Verdict: **COMPLETE-WITH-FAILURES** — 101/101 settled, 96 pass, 5 failed,
  0 unjudged timeouts; 3 calibration policy mismatches (separate from
  engineering failures).
- Code baseline: `5df68f68f2cc95e42c97a9785bb1edcbe92ec3ee` (main, clean).
- Report: `/Users/zhangxiao/.local/state/turnhelm/validation-20261017-5df68f6-b3yPqC/final-report/REPORT.md`,
  seal SHA-256 `bddf594a3a8e5abd37efa71452c9db32cef4ac88e23476368777b287dfb58bec`;
  post-observation diagnostics under `…/campaign/DIAGNOSTIC-NOTES.md`.
- Every product mechanism held across all eight stages (routing, Laya→Jev
  fallback, dual-gate writes, receipts, evidence journaling, worker
  instruction boundary, teardown).

## Failures (all caught by consumer-side gates; grades stand)

| Case | Evidence-backed category |
| --- | --- |
| feature-capture/feature-prose | task-output-mismatch — worker claimed it cannot read `input.json` in a read-only session; internal cause unresolved |
| business/12-redaction | claimed-completion-with-unchanged-implementation — completion JSON exact, `module.mjs` byte-identical to the placeholder |
| business/30-incident | task-output-mismatch — empty `firstFailure`/`cause` instead of the frozen database/connection-pool-exhausted facts |
| business/37-capacity | task-output-mismatch — zeroed capacities and `safe:false` instead of the frozen 60/60/true |
| business/42-coalescing | code-contract-assertion-failure — real frozen-contract failure with a task/oracle timing ambiguity: the contract imposes a same-turn synchronous-throw identity window the task text does not unambiguously require |

## Open alarms and standing instructions

- **heading-en calibration alarm.** `calibration-dev` heading-en selected
  `frontier` in 3/3 trials against its frozen band `[fast, balanced]`;
  heading-zh and the entire holdout split are in-band. This is one prompt
  family (n=1, three repeated trials), not three independent observations.
  **Do not refit the band on this evidence** — the band is a predeclared
  policy hypothesis and refitting would silence the alarm it exists to raise.
  Disposition: investigate classifier-side (Laya typed-decisions en/zh
  asymmetry) or via a matched diagnostic with fresh authorization. Exit 3 on
  a known mismatch is information, not noise.
- **Band-coverage and fast-tier question.** 31/50 natural business selections
  landed outside their predeclared bands — every one below its band floor
  (per-case `expectedBand`/`selected` pairs in the sealed `report.json`) —
  and the four frozen natural business failures all ran at the fast tier
  (`gpt-6-luna`/low), including 42-coalescing whose cause is timing-ambiguous.
  One same-task controlled pair exists (`12-redaction`: natural fast failed,
  fixed-balanced control passed). Bands are hypotheses, not optimality ground
  truth; **no profile-mapping, classifier-weight, or band change without a
  matched, separately authorized diagnostic.**
- **Top-tier natural coverage gap.** `frontier_xhigh` and `frontier_max`
  received zero natural selections across 50 natural business cases; both
  were exercised only via forced rebind admissions (all six passed). An
  observed coverage fact, not a defect.

## Retirements

- Campaign case `42-coalescing` is **retired**. Any future roster reuses it
  only as a v2 that states its synchronous-throw/same-turn timing policy and
  carries a worked call-order example, per the roster-authoring rule in
  README and the routing skill. Sealed oracles and grades are never edited
  after the fact.

## Live-coverage gaps (not exercised by this campaign)

Native API-key authentication/billing, direct non-proxy Jev transport,
deliberate live credential refresh, rate/usage-limit responses, and operator
cancellation were not exercised. Offline boundary tests are not live paid
evidence. Any of these needs a fresh, separately authorized campaign.
