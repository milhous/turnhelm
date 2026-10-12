# Routing criteria v2 policy-alignment experiment — sealed record

- Date: 2026-10-12
- Plan: `docs/superpowers/plans/2026-10-12-v020-hardening.md` Task 6 (WH-3)
- Spec: `docs/superpowers/specs/2026-10-12-v020-hardening-design.md` §5
- Outcome: **gates blocked — v1 criteria retained; no source change shipped.**
- Scratch campaign: `/private/tmp/turnhelm-criteria-v2-20261012-LaVm5v` (mode 700, files
  mode 600, never committed). Raw call log: `calls.jsonl` (200 lines).

## Authorization basis

Free local classifier calls only, against an owned local Laya service started with the
existing venv pattern (`LAYA_HOST=127.0.0.1 LAYA_PORT=8765 .live-laya-venv/bin/python -m
laya.serve`), health-gated (GET /health → 200) before the first classify and stopped after
the last (post-stop probe on 127.0.0.1:8765 → connection refused; shutdown confirmed in the
service log). No hosted Jev, no workers, no paid spend, no other side effects.

## Method

- The tuning set was frozen to `tuning-set.json` before any classify: 30 items — the 8
  frozen calibration stimuli (`test/fixtures/live-acceptance.json`), the 16 frozen v020
  business texts (sealed `business-roster.json` from the 2026-10-12 v020 campaign), and the
  6 variant texts (`docs/validation/2026-10-11-calibration-variants.json`), each with its
  predeclared band (heading-en-v1 carries none — gate 3 records it uncontrolled).
- The runner imported `requestTaskChoice` from the built dist for transport and reply
  validation, rewriting only `questions.route.instructions`/`criteria` in the composed body
  per draft revision. `src/` stayed v1 throughout the experiment; the working tree was never
  modified by the campaign.
- Baseline validation: a full pass with the built-in v1 constants reproduced the sealed v020
  report exactly — the same seven out-of-band items (heading-en, 05, 07, 09, 11, 12, 14).
  Runner and inference are therefore validated against sealed history.
- Determinism: inference is deterministic. Every repeated (revision, input) pair returned
  the identical choice (16 and auth-zh-v1 under the final draft, 3 trials each; decoy-en
  3 trials; the sealed v020 report's heading-en 3/3 agrees). Observed choice probabilities
  are near-uniform (winning option ≈ 0.2–0.3, margins ≈ 0.02), so single trials are exact.

## Tuning log (budget 200/200 classifies spent)

| revision | calls | intent → effect |
|---|---|---|
| src (v1) | 30 | baseline; reproduces the sealed v020 picture (7 out-of-band) |
| a | 16 | constraint-density framing → fixed heading-en, 12; broke 16, auth-zh-v1; five contracts unmoved |
| b | 12 | v1 frontier text restored → 16 back; auth-zh-v1 still down; five unmoved |
| c | 13 | "fully specified up front" deep → lifted 05/09/11/14; auth-en and 16 fell to deep |
| d | 10 | dropped "untrusted input" from deep → no recovery of the review family |
| e | 8 | discovery-vs-specified frontier → no movement |
| f | 31 | "implementation or repair" deep + review-worded frontier → all contracts deep, reviews frontier; **best draft** |
| g | 8 | "changes no files" in frontier → no change for the two stragglers |
| h | 9 | narrowed balanced + "distributed" frontier → no change for the two stragglers |
| i | 8 | v1-verbatim frontier → broad regression (07, 15, auth-en, 16) |
| j | 7 | review-vocabulary frontier → 07 regressed, stragglers unmoved |
| k | 9 | de-review-worded xhigh/max (family concentration) → 16 fixed; auth-zh-v1 deep; heading-en untested |
| l / l3 | 8 + 10 | remediation-plan frontier → auth-zh-v1 fixed; light end broke (heading-en, decoy-en) |
| m | 8 | deep without "repair" → heading-en broke; auth-zh-v1 unmoved |
| n | 4 | tenant/authorization frontier → auth-zh-v1 fixed; heading-en and decoy-en broke |
| o | 7 | f + k's xhigh/max only → heading-en and 07 broke |
| f (repeats) | 6 + 3 + 1 | determinism trials and picture completion |

Pattern: every fix for one of the two residual items flipped at least one other item; no
revision beat draft f. 4 remaining-diagnostics were raw envelope dumps (`draft-f-raw`, 2)
and the final picture completion.

## Best draft (f) — frozen verbatim, not shipped

Instructions: "Choose the lightest profile that meets the task's requirements. Judge by the
density of interacting correctness constraints and the consequences of an incorrect result,
never by prompt length, file count, or keywords such as security, architecture, or deep
analysis. Tasks that only rename, retitle, or reword text are always the lightest work."

- fast: "A mechanical edit with an immediately checkable result: renames, retitling,
  wording, config or log-line changes, small fixes with a clear expected diff."
- balanced: "Routine implementation or debugging of bounded scope with ordinary failure
  modes and few interacting rules."
- deep: "Bounded implementation or repair whose written contract stacks several interacting
  rules — ordering, cancellation, rollback and atomicity, exact-once effects — even when
  the contract is fully specified up front; every rule must hold at once and each is pinned
  by a test. Not open-ended analysis."
- frontier: "Very difficult review or analysis that changes no files, with ambiguity and
  interacting cross-system constraints, where risks and failure modes must be discovered
  and argued across several components with evidence."
- frontier_xhigh: "Demanding reasoning requiring detailed argument and verification across
  several constraints."
- frontier_max: "Exceptional problems requiring the greatest single-worker reasoning depth."

### Draft f full picture (deterministic; 3-trial marks where repeated)

- Stimuli 8/8: heading-en fast; heading-zh balanced; race-en deep; race-zh deep;
  decoy-en fast (3/3); decoy-zh fast; auth-en frontier; auth-zh frontier.
- Business 15/16: 01 fast; 02 fast; 03 deep; 04 deep; 05 deep; 06 deep; 07 deep; 08 deep;
  09 deep; 10 deep; 11 deep; 12 deep; 13 deep; 14 deep; 15 frontier;
  **16 deep (3/3) — out of band [frontier, frontier_xhigh, frontier_max]**.
- Variants: heading-en-v1 balanced (uncontrolled; v1 criteria sent it frontier);
  heading-en-v2 fast; heading-zh-v1 balanced; heading-zh-v2 balanced; decoy-en-v1 fast;
  **auth-zh-v1 balanced (3/3) — out of band [frontier, frontier_xhigh, frontier_max]**.

## Gate arithmetic (spec §5, applied to the best draft)

1. Fresh holdout 8/8 — not reached; no candidate was freezable, so no holdout was authored
   and no confirmation pass ran.
2. Business: 01, 02, 03, 04, 06, 08, 10, 13, 15 in band, **16 out of band ⇒ blocked**;
   6/6 of 05, 07, 09, 11, 12, 14 now in band (need ≥4); calibration-holdout pairs in band;
   heading-en into fast/balanced.
3. Variants: heading-en-v2, heading-zh-v1, heading-zh-v2, decoy-en-v1 in band;
   **auth-zh-v1 out of band ⇒ blocked**; heading-en-v1 recorded uncontrolled (balanced).
4. Determinism: zero divergence across every repeat — would pass.
5. Sealing: this document.

## Decision

No criteria revision satisfied the gates on the tuning set itself: the two blockers are
deterministic (3/3), each sits ~0.02 of probability from its band under every revision
tried, and each attempted fix flipped another gated item because the classifier's choice
distribution is near-uniform. The tuning budget is spent (200/200), so the one allowed
retune cannot run. A confirmation pass was not run: gate 2's business set includes 16
itself, so the best draft would fail confirmation with certainty — confirming a known
failure would spend evidence budget without a decision path. `src/systemone.ts` was never
modified (drafts lived in the runner's in-flight body rewrite), so "revert to v1" is the
status quo; v1 criteria stand. Committed artifact: this document only.
