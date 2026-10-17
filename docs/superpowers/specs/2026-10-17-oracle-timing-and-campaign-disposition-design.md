# Oracle Timing Rule, Worker Failure-Mode Documentation, and Campaign Disposition Spec

Date: 2026-10-17. Code baseline: `5df68f68f2cc95e42c97a9785bb1edcbe92ec3ee` (main, clean). Input: the sealed
final report of the 2026-10-17 routing-validation campaign
(`/Users/zhangxiao/.local/state/turnhelm/validation-20261017-5df68f6-b3yPqC/final-report/REPORT.md`,
seal `bddf594a3a8e5abd37efa71452c9db32cef4ac88e23476368777b287dfb58bec`, verdict COMPLETE-WITH-FAILURES,
96/101 pass) and its post-observation diagnostics (`…/campaign/DIAGNOSTIC-NOTES.md`). Revised after the
2026-10-17 astra re-check (§6).

> Status: drafted under the user's authorization to write this spec, re-check it through codex
> (`gpt-6-astra` — the only paid calls this work makes, §6), update it from that review, and write an
> execution plan. That authorization does not extend to implementing the changes, running live suites,
> or publishing. Constraints fixed by the user: optimize for long-term benefit, safety, and performance
> only; backward compatibility is explicitly not maintained.

## 1. Findings and decision boundary

Across 101 settled scenarios every product mechanism held: routing, Laya→Jev fallback, dual-gate writes,
receipts, evidence journaling, managed-home boundary, teardown. The five failures are worker task-delivery
failures or authoring gaps, not product defects, and all five were caught by consumer-side gates exactly
as designed. The spec's job is to make the *systematic* lessons cheap to apply next time.

| Finding | Localization | Product change warranted |
| --- | --- | --- |
| `feature-prose`: worker refused, claiming it "can't read input.json in this read-only session"; route, payload mode, boundary, tree checks all passed | worker-side wrong refusal; retained content-free evidence cannot distinguish a hallucinated restriction from an actual read denial — but read-only denies writes, not reads, and the product docs never say so | documentation (DF-1) |
| `12-redaction`: exact completion JSON, `module.mjs` byte-identical to the placeholder | worker claimed completion without implementing; caught by the frozen write contract (primary gates) plus a static hash observation — the gates worked | documentation (DF-1); no code |
| `30-incident`, `37-capacity`: schema-valid but value-wrong outputs (empty strings, zeros/false) | output framing ≠ semantic correctness; caught by oracles. The stance ("schema conformance is the consumer's acceptance gate") is already documented; the observed modes are not named anywhere | documentation (DF-1) |
| `42-coalescing`: real frozen-contract assertion failure, but the contract imposes a same-turn synchronous-throw identity window the task text does not unambiguously require | task/oracle **timing** ambiguity. The existing roster-authoring rule (README:669–674, copied in the skill) covers ordering, ties, and direction — not *when* an effect must happen | authoring rule (OR-1) + case retirement (CD-1) |
| `calibration-dev`: heading-en selected `frontier` in 3/3 trials against its frozen band `[fast, balanced]`; heading-zh and the whole holdout split in-band | one prompt family (n=1, three repeated trials), an en/zh asymmetry in classifier selection — a genuine open alarm, not a product defect, and not evidence of any particular tier being sufficient or excessive | disposition record (CD-1); band left untouched |
| 31/50 natural business selections landed outside their predeclared bands — every one of the 31 below the band floor (per-case `expectedBand`/`selected` pairs in the sealed `report.json`); the four frozen natural business failures — including 42-coalescing, whose grade stands as a real contract-assertion failure while its cause remains timing-ambiguous — all ran at the fast tier (`gpt-6-luna`); one same-task controlled pair (`12-redaction`: natural fast failed, fixed-balanced control passed) | bands are policy hypotheses, not optimality ground truth; the report's limits forbid causal routing claims on this evidence | disposition record (CD-1); no routing change |
| `frontier_xhigh`/`frontier_max`: zero natural selections in 50 business cases (reachable only via forced rebind admissions) | observed coverage fact, not a defect | recorded (CD-1) |

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: extend the roster-authoring rule with temporal semantics and a worked call-order example | a misgraded ambiguous oracle costs a paid run and an irreparable sealed record; one sentence class closes the 42 gap the same way the ties rule closed 39-discount | **Adopt** (OR-1) |
| B: machine-checked timing-policy declaration field in the roster schema | config for prose; `prepareRound` cannot verify task-text/contract alignment anyway — the rule is for authors, not parsers | Reject |
| C: name the three observed worker failure modes and the read-only semantics in product docs | consumers writing acceptance gates should know the observed failure distribution (wrong refusal, fake completion, value-wrong-valid-shape) instead of rediscovering it per campaign | **Adopt** (DF-1) |
| D: code mitigations in `turnhelm run` (unchanged-implementation detection, output plausibility checks) | `turnhelm run` is a launcher, not an acceptance oracle; consumers gate (the 2026-10-16 RCA §3A stance, reaffirmed by this campaign); the harness already catches both modes at zero product cost | Reject |
| E: refit the heading band to include `frontier` | the band is a predeclared policy hypothesis and the evidence is one prompt family (n=1); refitting would replace the hypothesis with the classifier's current behavior and silence the alarm it exists to raise — exit 3 on a known mismatch is information, not noise. Which tier a heading edit actually needs is unmeasured and plays no part in this decision | Reject |
| F: change profile mappings, classifier weights, or band policy on this evidence | optimality unmeasured; four fast-tier failures against ~25 fast-tier passes and one controlled pair do not authorize a cost/quality tradeoff; requires a matched diagnostic with fresh authorization | Reject (recorded in CD-1 as the open question) |
| G: dated in-repo disposition note for the campaign | the open alarms currently live only in a sealed state-directory report; future roster authors and band owners need them where the code lives | **Adopt** (CD-1) |

Not maintaining backward compatibility here changes nothing in practice — the spec touches no API, config,
receipt, harness, or sealed artifact, and inventing breaks to satisfy the constraint would be the opposite
of its intent. The constraint's one real effect: doc text is rewritten to the current truth rather than
annotated around stale wording.

## 2. Scope, inheritance, and invariants

Files changed: `README.md` (roster-authoring rule paragraph; completion-not-verification boundary
paragraphs), `.agents/skills/turnhelm-routing/SKILL.md` (the same two passages, kept verbatim-aligned with
README), `docs/validation/2026-10-17-campaign-5df68f6-disposition.md` (new), plus this spec and its
execution plan. **Zero `src/` and `test/` changes.** The doc edits are not test-free: `test/package.test.ts`
(required README and skill fragments, lines 129–176) and `test/init.test.ts` (required and forbidden skill
text, lines 225–249) pin specific passages — the edits are additive sentences that touch none of the pinned
fragments, and keeping those assertions green **unmodified** is itself a check (§4). No existing assertion
compares the *new* passages across README and SKILL, so their verbatim alignment is checked explicitly at
review time (§4 item 2), not inferred from the suite.

Inherited unchanged: every product invariant — routing order and deadline split, transport policy, env
stripping, managed-home boundary and its documented residuals, payload classification, settlement and
owned-shutdown ladder, evidence journal, custom-round decision order, sealed grades, closed authorities.

## 3. Design

### OR-1 — oracle timing rule (extends the existing roster-authoring rule)

The rule paragraph (README:669–674 and its skill copy) gains, after the ties/direction sentence: any task
whose oracle verdict depends on **when** an effect must happen — a synchronous throw versus a deferred
rejection, a same-turn identity window for promises or handles, state visible before versus after
settlement, retry-after-settlement semantics — must (a) state the timing policy it judges in one explicit
sentence, (b) include one worked call-order example that exercises the ambiguous boundary (for the
42-coalescing shape: the first call's fetch throws synchronously; the example states whether the
immediately following same-key call must return the identical promise and whether rejection is deferred to
a microtask), and (c) word the task text to impose exactly that policy. The existing
retire-and-replace sentence is retained verbatim; campaign case `42-coalescing` is retired by CD-1 and any
future reuse is a v2 with the stated policy.

### DF-1 — documented worker failure modes and read-only semantics

The README boundary paragraphs (the "consumer's acceptance gate" passage and the completion-not-verification
passage) and the skill's interpreting-results paragraph gain, in the same voice: (a) one clause —
`--sandbox read-only` denies writes, not reads; read-only mode itself does not prohibit reading, though
whether any specific file is readable still depends on host permissions, and the internal cause of the
2026-10-17 feature-prose refusal is unresolved (the retained content-free evidence cannot distinguish a
mistaken worker claim from an actual read denial); (b) the three observed task-delivery failure modes
named as known, gated classes — wrong refusal, claimed completion with unchanged implementation,
schema-valid but value-wrong output. No behavior change; the docs state what the gates already do and what
this campaign actually observed.

### CD-1 — campaign disposition note

New dated note `docs/validation/2026-10-17-campaign-5df68f6-disposition.md`, in the existing dated-note
style, recording: verdict, report path and seal SHA; the five failures with their evidence-backed
categories; the open alarms and their standing instructions — heading-en→frontier ×3 against band
`[fast, balanced]` with holdout clean (do not refit on n=1; investigate classifier-side or via a matched
diagnostic); four natural task-delivery failures at the fast tier with 31/50 downward band misses (no
routing change without a matched, separately authorized diagnostic); frontier_xhigh/frontier_max zero
natural coverage; live-coverage gaps not exercised (API-key billing, direct non-proxy Jev, deliberate
credential refresh, rate/usage limits, operator cancellation); retirement of case 42-coalescing. It is an
index for future campaign authorship and supersedes nothing.

### Safety and performance statements

No code path, dependency, or data flow is touched — the risk surface is unchanged. The benefit is
procedural and stated bounded: OR-1 *reduces the risk* of authoring a new timing-ambiguous oracle (a prose
rule cannot guarantee alignment); the observed worker misbehavior classes can recur in future runs and
remain consumer-gated, as this campaign demonstrated; named failure modes and a durable disposition record
replace campaign-private tribal knowledge (DF-1, CD-1). No claim is made about future delivery or routing
quality.

## 4. Verification

Offline only; zero paid calls (the §6 review calls aside).

1. The change set is limited to the five named doc files (README, SKILL, disposition note, this spec, the
   plan); after staging, `git diff --stat main --cached` shows exactly those five (unstaged `git diff`
   alone would miss untracked additions).
2. Text checks: the timing-rule sentences present in both README and SKILL and **verbatim-identical** in
   their shared wording; the read-only clause and the three named modes likewise present in both; the
   disposition note cites the report path, seal SHA, and the do-not-refit instruction verbatim-checkably.
3. `pnpm test && pnpm build` green with the fragment-pinning tests (`package.test.ts`, `init.test.ts`)
   green **unmodified** — the edits added text without touching any pinned passage.
4. `git diff --check` clean.

What these checks do not establish: any behavioral or delivery-quality improvement — this is a
documentation change; its effect on future campaigns is not measurable offline.

## 5. Non-goals

No `src/` or `test/` change of any kind. No routing, profile-mapping, classifier-weight, band, deadline, or
cap change. No retries, escalation, confidence thresholds, or profile forcing (unchanged from the
2026-10-16 spec's non-goals). No new live campaign, probe, or spend authorized by this spec — §6's review
calls excepted per the user's instruction. No edit to sealed campaign artifacts, grades, or closed
authorities (they live outside the repo; case 42 is retired in place, never rewritten). No proxy-exit
attestation and no HOME-rooted residual closure (deferral unchanged until verified controls exist). No
harness roster-schema additions and no corpus expansion.

## 6. Review record — 2026-10-17 astra re-check

Routed through Turnhelm against a clean clone of this branch at `b9c2176` with the dossier copied in
(`ACCEPTANCE-SPEC.md`, `EVIDENCE-REPORT.md`, `DIAGNOSTIC-NOTES.md`; root
`/Users/zhangxiao/.local/state/turnhelm/astra-review-20261017`). Laya/direct selected `deep` →
`gpt-6-astra` / `high` (review config maps every profile to that tuple), routing 680 ms; worker completed
in 97.9 s, 23 progress events, `payload.mode: "strict"`. Verdict **PROBLEMS** — 5 findings (4×P2, 1×P3),
all adjudicated below; the spec above is the revised text. The review's scope judgment: docs-only is the
right scope, no source or test change is forced by the evidence, and rejects D and F stand.

| # | Pri | Finding (condensed) | Disposition |
| --- | --- | --- | --- |
| 1 | P2 | DF-1's "a worker that reports it cannot read … is mistaken" turns an unresolved refusal into a proven diagnosis; the evidence leaves the internal cause open | Accepted — DF-1(a) rewritten: read-only mode itself does not prohibit reads, host permissions still govern any specific file, and the feature-prose cause is stated as unresolved |
| 2 | P2 | Approach E's "over-provisioning on the easiest task" implies unmeasured optimality | Accepted — E's rationale now rests on hypothesis preservation and the n=1 limit; tier adequacy is explicitly not part of the decision |
| 3 | P2 | "Fell below the band floor" lacks direction evidence in the summarized report; "task-delivery failures" over-classifies the timing-ambiguous 42 case | Partially accepted — the downward direction is real and now cited to the per-case `expectedBand`/`selected` pairs in the sealed `report.json` (all 31 mismatches select below their band floor), not asserted from the summary; the four failures are re-worded as frozen grades, naming 42's ambiguity and preserving its failed grade without claiming proven worker incorrectness |
| 4 | P2 | §2 wrongly said the tests never inspect sentence text (`package.test.ts:129–176`, `init.test.ts:225–249` pin fragments); §4.3 over-claimed what green copy-tests prove; §4.1's file count wrong and misses untracked files | Accepted — §2 states the pinned-fragment reality and makes unmodified-green pinning a check; §4 adds an explicit verbatim comparison of the new README↔SKILL passages (no test compares them); §4.1 corrected to five files with the staged-diff note |
| 5 | P3 | "Only failure class a future run can inherit" + "closes it" + "nothing to establish" overstate what finite observations support | Accepted — statements bounded: OR-1 reduces authoring risk without guaranteeing alignment; worker misbehavior can recur and stays consumer-gated; §4 closing states no delivery-quality claim is measurable offline |
